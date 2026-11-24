'use strict';
/**
 * A SUBMIT THAT MAY HAVE LANDED, ON A DISK THAT WILL NOT TAKE THE WRITE - booked, contained, loud.
 *
 * Regression target: the uncertain-outcome handler in BidEngine._maybeBid - the catch reached when
 * adapter.placeBid throws on the submit leg. It assumes the write may have committed (fail-closed),
 * books it as a landed bid, spends the revision, and then persists that booking with
 * `scheduler.update(... everBid, landedBids, revisionsLeft ...)`. That persist was unwrapped.
 *
 * DurableScheduler.update rolls memory back and rethrows whatever _persist() throws, and the atomic
 * write underneath is fs.writeFileSync + fs.renameSync. A disk fault is not a one-shot event: a full
 * disk, a revoked permission or a read-only remount is still there two statements later. So the
 * handler's own write threw, the exception escaped _maybeBid as a rejected promise, and _tick's
 * catch-all rendered an EACCES as a generic tick_error. Nothing said the one actionable fact - that
 * the durable record of a possibly-committed bid could not be written. The same escape is reached
 * from an accepted bid whose own write fails first and falls into this handler.
 *
 * Past the price page nothing may fail silently, so containing the failure is not enough on its
 * own: it has to reach the desk's error channel, with no filesystem path in it, because that
 * channel reaches the client's Director.
 *
 * WHAT MUST NOT MOVE:
 *   - with a healthy disk, a submit-leg transport failure still books fail-closed: one landed bid,
 *     one revision spent, the intent records it, one bid_submit_error warning, and nothing on the
 *     error channel (check 1 - the in-file control).
 *   - under the disk fault the uncertain outcome is still booked on the board (check 3).
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on a temp file,
 * no network, no sleeps. The fault is a synchronous EACCES from the scheduler's own persist on
 * every write after arm, so update()'s real rollback-then-rethrow runs.
 *
 *   node scripts/test-uncertain-outcome-persist-fault-contained.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `uncertain-persist-fault-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
process.on('exit', cleanup);

const AUCTION = 'UPF1';
const REMAINING_MS = 114 * 60 * 1000;

// realAdapter's shape: SuperProcure exposes no live revisionsLeft, so the read-back cannot
// disprove the write and the handler books it as landed.
const liveState = () => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3,
  closeModel: 'hard', measuredRttMs: 50, minDecrement: 100,
});

function mkAdapter(outcome) {
  const wire = [];
  return {
    wire,
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    placeBid: async (_id, price) => {
      wire.push(price);
      // Submit-leg shape: no `placed` field, so the bytes may have reached the portal.
      if (outcome === 'network') throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
}

function mkScheduler(file) {
  const s = new DurableScheduler(file);
  const realPersist = s._persist.bind(s);
  s.faulting = false;
  s.faultsFired = 0;
  s._persist = () => {
    if (s.faulting) {
      s.faultsFired++;
      const e = new Error(`EACCES: permission denied, open '${file}.tmp'`);
      e.code = 'EACCES';
      e.errno = -13;
      e.syscall = 'open';
      e.path = `${file}.tmp`;
      throw e;
    }
    return realPersist();
  };
  return s;
}

async function run({ outcome, fault }) {
  const file = tmp();
  const adapter = mkAdapter(outcome);
  const scheduler = mkScheduler(file);
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const events = [];
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: silent,
  });
  const m = engine.arm({
    id: AUCTION, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
    status: 'live', softClose: false,
  }, { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  const revBefore = m.revisionsLeft;
  scheduler.faulting = fault;

  let escaped = null;
  try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = e; }

  // Snapshot before kill(): kill emits its own error-class alert, which is not this path's.
  const seen = events.slice();
  scheduler.faulting = false;
  const intent = Object.assign({}, scheduler.get(AUCTION));
  engine.kill('done');

  const errorChannel = seen.filter((e) => { const n = toNotification(e); return !!n && n.kind === 'error'; });
  return {
    file, escaped, revBefore, faultsFired: scheduler.faultsFired,
    wireWrites: adapter.wire.length,
    landedBids: m.landedBids, revAfter: m.revisionsLeft, bidInProgress: m.bidInProgress, intent,
    submitErrors: seen.filter((e) => e.type === 'alert' && e.kind === 'bid_submit_error'),
    errorChannel,
    kinds: seen.map((e) => (e.type === 'alert' ? `alert:${e.kind}` : e.type)),
  };
}

(async () => {
  const c = await run({ outcome: 'network', fault: false });
  assert.strictEqual(c.escaped, null, `control: _maybeBid threw: ${c.escaped && c.escaped.message}`);
  assert.strictEqual(c.revBefore, 3, 'control precondition: the load starts with 3 revisions');
  assert.strictEqual(c.wireWrites, 1, 'control: exactly one write on the wire');
  assert.strictEqual(c.landedBids, 1, 'control: an unfalsifiable transport failure is booked as landed');
  assert.strictEqual(c.revAfter, 2, 'control: the booked bid spends one revision');
  assert.strictEqual(c.intent.landedBids, 1, 'control: the intent records the booked bid');
  assert.strictEqual(c.submitErrors.length, 1, 'control: one bid_submit_error');
  assert.strictEqual(c.submitErrors[0].level, 'warn', 'control: bid_submit_error is a warning');
  assert.deepStrictEqual(c.errorChannel.map((e) => e.kind), [],
    'control: a healthy-disk transport failure puts nothing on the error channel');
  ok(1, 'control: healthy disk - transport failure booked fail-closed, persisted, error channel quiet');

  const f = await run({ outcome: 'network', fault: true });
  assert.strictEqual(f.revBefore, 3, 'fault precondition: the load starts with 3 revisions');
  assert.strictEqual(f.wireWrites, 1, `fault precondition: exactly one write on the wire, got ${f.wireWrites}`);
  assert.ok(f.faultsFired >= 1, 'harness: the sustained EACCES never fired');
  const trace = `\n    events: ${f.kinds.join(', ')}`;

  assert.ok(f.escaped === null,
    `_maybeBid rejected with ${f.escaped && f.escaped.code}: the uncertain-outcome handler's own `
    + 'persist of the booked bid threw on the unwritable disk and the error escaped _maybeBid' + trace);
  ok(2, 'the handler\'s persist failure is contained inside _maybeBid');

  assert.strictEqual(f.landedBids, 1,
    `the possibly-committed bid was booked as ${f.landedBids} landed bids (expected 1)` + trace);
  assert.strictEqual(f.revAfter, 2, `revisionsLeft ${f.revAfter} after the booked bid (expected 2)`);
  assert.strictEqual(f.bidInProgress, false, 'bidInProgress left set after _maybeBid returned');
  ok(3, 'the uncertain outcome is still booked on the board under the disk fault');

  assert.ok(f.errorChannel.length >= 1,
    'the uncertain-outcome persist failure never reached the desk error channel - a silent '
    + 'failure past the price page' + trace);
  // toNotification falls back to the kind name when an event carries no detail, so a bare alert
  // would reach the desk reading "tick_error" against no load.
  const actionable = f.errorChannel.filter((e) => {
    const detail = toNotification(e).data.detail;
    return e.auctionId === AUCTION && typeof detail === 'string' && detail.trim() !== '' && detail !== e.kind;
  });
  assert.ok(actionable.length >= 1,
    `no error-channel event names load ${AUCTION} with a detail of its own - the desk is told only `
    + `${JSON.stringify(f.errorChannel.map((e) => ({ kind: e.kind, auctionId: e.auctionId, detail: toNotification(e).data.detail })))}`);
  const leaks = [f.file, path.basename(f.file), os.tmpdir()];
  for (const e of f.errorChannel) {
    const detail = String(toNotification(e).data.detail || '');
    for (const p of leaks) {
      assert.ok(!detail.includes(p), `error-channel detail carries a filesystem path: ${JSON.stringify(detail)}`);
    }
  }
  ok(4, 'the persist failure reaches the desk error channel, naming the load, with no filesystem path in it');

  const a = await run({ outcome: 'accept', fault: true });
  assert.strictEqual(a.wireWrites, 1, `accepted precondition: exactly one write on the wire, got ${a.wireWrites}`);
  assert.ok(a.faultsFired >= 1, 'harness: the sustained EACCES never fired on the accepted path');
  assert.ok(a.escaped === null,
    `_maybeBid rejected with ${a.escaped && a.escaped.code} on an ACCEPTED bid under a sustained disk `
    + 'fault: the fault reached the uncertain-outcome handler and its own persist escaped'
    + `\n    events: ${a.kinds.join(', ')}`);
  ok(5, 'an accepted bid under a sustained disk fault does not escape _maybeBid');

  console.log(`\nPASS - ${pass} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
