'use strict';
/**
 * AN ACCEPTED BID WHOSE DISK WRITE FAILS - booked once, reported as placed, loud on the desk.
 *
 * Regression target: the accepted branch of BidEngine._maybeBid. Its durable write
 * (`scheduler.update(... status: 'bidding', landedBids ...)`) was unwrapped, and it sits inside
 * the try{} whose catch is the uncertain-outcome handler - the one written for "adapter.placeBid
 * threw", a TRANSPORT failure where the write may or may not have committed.
 *
 * DurableScheduler.update rethrows whatever _persist() throws, and the atomic write underneath is
 * fs.writeFileSync + fs.renameSync - synchronous throwers on EACCES / ENOSPC / EPERM / EROFS. So a
 * disk fault AFTER the portal accepted the bid was handed to a handler whose premise is "the submit
 * failed". On SuperProcure that handler cannot falsify `landed` (getAuctionState carries no live
 * revisionsLeft), so it re-applied the same bookkeeping: one wire write became two landed bids and
 * two spent revisions, the desk was told the submit failed on a bid the portal took, no bid_placed
 * ever went out, and - when the fault is transient - the phantom second bid reached the durable
 * intent that a restart rehydrates.
 *
 * The sibling writes on the rejected path are already wrapped on the principle that telemetry must
 * never be able to rewrite a money outcome. A swallowed persist failure is not acceptable either:
 * past the price page nothing may fail silently, so the failure has to reach the desk's error
 * channel - with no filesystem path in it, because that channel reaches the client's Director.
 *
 * WHAT MUST NOT MOVE:
 *   - with a healthy disk, one accepted bid is still one landed bid, one revision, one bid_placed,
 *     and no error-channel notification at all (check 1 - the in-file control).
 *   - still exactly one write on the wire (check 7).
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on a temp file,
 * no network, no sleeps. The fault is a synchronous EACCES from the scheduler's own persist, fired
 * once on the write carrying `status: 'bidding'`, so later writes succeed.
 *
 *   node scripts/test-accepted-bid-persist-fault-books-once.js
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
  const f = path.join(os.tmpdir(), `accepted-persist-fault-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
process.on('exit', cleanup);

const AUCTION = 'APF1';
const REMAINING_MS = 114 * 60 * 1000;

// realAdapter's shape: SuperProcure exposes no live revisionsLeft; revisionLimit is the static cap.
const liveState = () => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3,
  closeModel: 'hard', measuredRttMs: 50, minDecrement: 100,
});

function mkAdapter() {
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
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
}

// The fault lives in the scheduler's own persist, so update()'s real rollback-then-rethrow runs.
// It is aimed by CONTENT (the write carrying status 'bidding'), never by call count.
function mkScheduler(file, { fault }) {
  const s = new DurableScheduler(file);
  const realUpdate = s.update.bind(s);
  const realPersist = s._persist.bind(s);
  let aimed = false;
  s.faultsFired = 0;
  s.update = (id, patch) => {
    aimed = fault && s.faultsFired === 0 && !!patch && patch.status === 'bidding';
    try { return realUpdate(id, patch); } finally { aimed = false; }
  };
  s._persist = () => {
    if (aimed) {
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

async function run({ fault }) {
  const file = tmp();
  const adapter = mkAdapter();
  const scheduler = mkScheduler(file, { fault });
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

  let escaped = null;
  try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = e; }

  // Snapshot before kill(): kill emits its own error-class alert, which is not this path's.
  const seen = events.slice();
  const intent = Object.assign({}, scheduler.get(AUCTION));
  engine.kill('done');

  const alerts = (k) => seen.filter((e) => e.type === 'alert' && e.kind === k);
  const errorChannel = seen.filter((e) => { const n = toNotification(e); return !!n && n.kind === 'error'; });
  return {
    file, escaped, revBefore, faultsFired: scheduler.faultsFired,
    wireWrites: adapter.wire.length,
    landedBids: m.landedBids, revAfter: m.revisionsLeft, intent,
    bidPlaced: seen.filter((e) => e.type === 'bid_placed').length,
    submitErrors: alerts('bid_submit_error').length,
    errorChannel,
    kinds: seen.map((e) => (e.type === 'alert' ? `alert:${e.kind}` : e.type)),
  };
}

(async () => {
  const c = await run({ fault: false });
  assert.strictEqual(c.escaped, null, `control: _maybeBid threw: ${c.escaped && c.escaped.message}`);
  assert.strictEqual(c.revBefore, 3, 'control precondition: the load starts with 3 revisions');
  assert.strictEqual(c.wireWrites, 1, 'control: exactly one write on the wire');
  assert.strictEqual(c.landedBids, 1, 'control: one accepted bid is one landed bid');
  assert.strictEqual(c.revAfter, 2, 'control: one accepted bid spends one revision');
  assert.strictEqual(c.bidPlaced, 1, 'control: exactly one bid_placed');
  assert.strictEqual(c.submitErrors, 0, 'control: no bid_submit_error');
  assert.strictEqual(c.intent.landedBids, 1, 'control: the intent records one landed bid');
  assert.deepStrictEqual(c.errorChannel.map((e) => e.kind), [],
    'control: a healthy accepted bid puts nothing on the error channel');
  ok(1, 'control: healthy disk - one landed bid, one revision, one bid_placed, error channel quiet');

  const f = await run({ fault: true });
  assert.strictEqual(f.faultsFired, 1,
    'harness: the EACCES must fire exactly once, on the accepted-path write carrying status bidding');
  assert.strictEqual(f.revBefore, 3, 'fault precondition: the load starts with 3 revisions');
  const trace = `\n    events: ${f.kinds.join(', ')}`;

  assert.strictEqual(f.landedBids, 1,
    `one accepted wire write was booked as ${f.landedBids} landed bids: the accepted-path disk write `
    + 'threw into the uncertain-outcome handler, which re-applied the same accepted bid' + trace);
  ok(2, 'a disk fault on the accepted-path write books the accepted bid once');

  assert.strictEqual(f.revAfter, 2,
    `one accepted bid spent ${f.revBefore - f.revAfter} revisions (revisionsLeft ${f.revAfter}, expected 2)` + trace);
  ok(3, 'one accepted bid spends one revision');

  assert.ok(f.intent.landedBids == null || f.intent.landedBids <= 1,
    `the durable intent records ${f.intent.landedBids} landed bids for one wire write`);
  assert.ok(f.intent.revisionsLeft == null || f.intent.revisionsLeft >= 2,
    `the durable intent records revisionsLeft ${f.intent.revisionsLeft}, below the 2 one bid leaves`);
  ok(4, 'the durable intent is not double-booked');

  assert.strictEqual(f.bidPlaced, 1,
    `a bid the portal ACCEPTED produced ${f.bidPlaced} bid_placed events (expected 1)` + trace);
  ok(5, 'the accepted bid is reported as placed');

  assert.strictEqual(f.submitErrors, 0,
    'the desk was told the submit failed (bid_submit_error) on a bid the portal accepted' + trace);
  ok(6, 'no false submit-error for an accepted bid');

  assert.strictEqual(f.escaped, null, `_maybeBid rejected: ${f.escaped && f.escaped.message}`);
  assert.strictEqual(f.wireWrites, 1, `expected exactly one write on the wire, got ${f.wireWrites}`);
  ok(7, 'the persist failure does not escape _maybeBid, and exactly one write went on the wire');

  assert.ok(f.errorChannel.length >= 1,
    'the accepted-path persist failure never reached the desk error channel - a silent failure '
    + 'past the price page' + trace);
  // A bare kind-only alert renders as the kind name under a 'global' key: nobody can tell which
  // load it is about or what happened.
  const described = f.errorChannel.filter((e) => {
    const detail = toNotification(e).data.detail;
    return e.auctionId === AUCTION && typeof detail === 'string' && detail.trim() !== '' && detail !== e.kind;
  });
  assert.ok(described.length >= 1,
    'the error-channel alert must name this load (auctionId) and carry a detail other than its bare kind: '
    + JSON.stringify(f.errorChannel.map((e) => ({ kind: e.kind, auctionId: e.auctionId, detail: toNotification(e).data.detail }))));
  const leaks = [f.file, path.basename(f.file), os.tmpdir()];
  for (const e of f.errorChannel) {
    const detail = String(toNotification(e).data.detail || '');
    for (const p of leaks) {
      assert.ok(!detail.includes(p), `error-channel detail carries a filesystem path: ${JSON.stringify(detail)}`);
    }
  }
  ok(8, 'the persist failure reaches the desk error channel, names the load, says what happened, carries no filesystem path');

  console.log(`\nPASS - ${pass} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
