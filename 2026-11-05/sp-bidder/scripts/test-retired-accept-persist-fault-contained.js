'use strict';
/**
 * A BID THAT LANDS AFTER ITS MONITOR WAS RETIRED, ON A DISK THAT WILL NOT TAKE THE WRITE - contained,
 * reported once, loud on the desk.
 *
 * Regression target: BidEngine._recordLandedAfterRetire, the banker for a write that resolves after
 * stop() has retired its monitor (a re-price landing while the old write is still on the wire). Its
 * durable write (`scheduler.update(... everBid, landedBids, landedBidPrice, revisionsLeft ...)`) is
 * unwrapped and sits BEFORE the bid_placed emit. It is reached through two doors in _maybeBid:
 *
 *   A. placeBid resolves ACCEPTED on a retired monitor. The banker runs inside the try{} whose catch
 *      is the uncertain-outcome handler, so a disk fault there is read as "the submit failed": the
 *      desk gets a bid_submit_error for a bid the portal took, the handler routes it back into the
 *      same banker, and that second write fails the same way.
 *   B. placeBid THROWS on the submit leg and the handler, unable to disprove the write, banks it
 *      through its retire branch - the same unwrapped write, now inside the catch itself.
 *
 * DurableScheduler.update rolls memory back and rethrows whatever _persist() throws. A disk fault
 * (EACCES / ENOSPC / EROFS) is still there on the next write, so on both doors the exception escapes
 * _maybeBid as a rejected promise, no bid_placed ever goes out - and bid_placed is the only thing
 * that writes the bid into the business's own bid history - and nothing on the desk's error channel
 * says which load's durable record failed. Past the price page nothing may fail silently, so a
 * swallowed catch is not a fix either: the failure has to reach the error channel, naming the load,
 * with no filesystem path in it, because that channel reaches the client's Director.
 *
 * WHAT MUST NOT MOVE (check 1 - the in-file control): with a healthy disk, both doors bank the bid
 * once - one bid_placed, the intent records one landed bid - door A raises no bid_submit_error, door
 * B raises exactly its one transport-failure warning, and nothing reaches the error channel.
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on a temp file, no
 * network, no sleeps. The monitor is retired with engine.stop() while the write is on the wire, and
 * from that moment every durable write fails with a synchronous EACCES from the scheduler's own
 * persist, so update()'s real rollback-then-rethrow runs.
 *
 *   node scripts/test-retired-accept-persist-fault-contained.js
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
  const f = path.join(os.tmpdir(), `retired-accept-persist-fault-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
process.on('exit', cleanup);

const AUCTION = 'RAF1';
const REMAINING_MS = 114 * 60 * 1000;

// realAdapter's shape: SuperProcure exposes no live revisionsLeft, so door B's read-back cannot
// disprove the write and the handler banks it.
const liveState = () => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 3,
  closeModel: 'hard', measuredRttMs: 50, minDecrement: 100,
});

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

async function run({ door, fault }) {
  const file = tmp();
  const scheduler = mkScheduler(file);
  const wire = [];
  let engine = null;
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    placeBid: async (_id, price) => {
      wire.push(price);
      // The re-price window: stop() retires the monitor while this write is on the wire.
      engine.stop(AUCTION);
      scheduler.faulting = fault;
      if (door === 'B') throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 30 };
    },
  };
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const events = [];
  engine = new BidEngine(adapter, scheduler, {
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

  let escaped = null;
  try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = e; }

  // Snapshot before kill(): kill emits its own error-class alert, which is not this path's.
  const seen = events.slice();
  scheduler.faulting = false;
  const intent = Object.assign({}, scheduler.get(AUCTION));
  engine.kill('done');

  const errorChannel = seen.filter((e) => { const n = toNotification(e); return !!n && n.kind === 'error'; });
  return {
    file, escaped, faultsFired: scheduler.faultsFired, wireWrites: wire.length,
    retired: m.finalized === true && !engine.monitors.has(AUCTION),
    intent,
    bidPlaced: seen.filter((e) => e.type === 'bid_placed').length,
    submitErrors: seen.filter((e) => e.type === 'alert' && e.kind === 'bid_submit_error'),
    errorChannel,
    kinds: seen.map((e) => (e.type === 'alert' ? `alert:${e.kind}` : e.type)),
  };
}

function assertDeskAlert(r, n, label) {
  const trace = `\n    events: ${r.kinds.join(', ')}`;
  assert.ok(r.errorChannel.length >= 1,
    `${label}: the retired-load persist failure never reached the desk error channel - a silent `
    + 'failure past the price page' + trace);
  // toNotification falls back to the kind name when an event carries no detail, so a bare alert
  // would reach the desk reading its own kind against no load.
  const described = r.errorChannel.filter((e) => {
    const detail = toNotification(e).data.detail;
    return e.auctionId === AUCTION && typeof detail === 'string' && detail.trim() !== '' && detail !== e.kind;
  });
  assert.ok(described.length >= 1,
    `${label}: no error-channel event names load ${AUCTION} with a detail of its own - the desk is told only `
    + JSON.stringify(r.errorChannel.map((e) => ({ kind: e.kind, auctionId: e.auctionId, detail: toNotification(e).data.detail }))));
  const leaks = [r.file, path.basename(r.file), os.tmpdir()];
  for (const e of r.errorChannel) {
    const detail = String(toNotification(e).data.detail || '');
    for (const p of leaks) {
      assert.ok(!detail.includes(p), `${label}: error-channel detail carries a filesystem path: ${JSON.stringify(detail)}`);
    }
  }
  ok(n, `${label}: the persist failure reaches the desk error channel, names the load, carries no filesystem path`);
}

(async () => {
  const ca = await run({ door: 'A', fault: false });
  const cb = await run({ door: 'B', fault: false });
  for (const [c, label, warns] of [[ca, 'control A (accepted)', 0], [cb, 'control B (transport throw)', 1]]) {
    assert.strictEqual(c.escaped, null, `${label}: _maybeBid threw: ${c.escaped && c.escaped.message}`);
    assert.ok(c.retired, `${label} precondition: the monitor was not retired mid-write`);
    assert.strictEqual(c.wireWrites, 1, `${label}: exactly one write on the wire`);
    assert.strictEqual(c.bidPlaced, 1, `${label}: the banked bid is reported once as bid_placed`);
    assert.strictEqual(c.intent.landedBids, 1, `${label}: the intent records one landed bid`);
    assert.strictEqual(c.submitErrors.length, warns, `${label}: ${warns} bid_submit_error expected`);
    for (const w of c.submitErrors) assert.strictEqual(w.level, 'warn', `${label}: bid_submit_error is a warning`);
    assert.deepStrictEqual(c.errorChannel.map((e) => e.kind), [],
      `${label}: a healthy retired-load bank puts nothing on the error channel`);
  }
  ok(1, 'control: healthy disk - both doors bank the retired-load bid once, error channel quiet');

  const doors = [
    { door: 'A', label: 'door A (accepted while retired)', control: ca, first: 2 },
    { door: 'B', label: 'door B (handler retire branch)', control: cb, first: 6 },
  ];
  for (const { door, label, control, first } of doors) {
    const f = await run({ door, fault: true });
    assert.ok(f.retired, `${label} precondition: the monitor was not retired mid-write`);
    assert.strictEqual(f.wireWrites, 1, `${label} precondition: exactly one write on the wire, got ${f.wireWrites}`);
    assert.ok(f.faultsFired >= 1, `harness: the sustained EACCES never fired on ${label}`);
    const trace = `\n    events: ${f.kinds.join(', ')}`;

    assert.ok(f.escaped === null,
      `${label}: _maybeBid rejected with ${f.escaped && f.escaped.code}: _recordLandedAfterRetire's durable `
      + 'write threw on the unwritable disk and the error escaped _maybeBid' + trace);
    ok(first, `${label}: the retired-load persist failure does not escape _maybeBid`);

    assert.strictEqual(f.submitErrors.length, control.submitErrors.length,
      `${label}: ${f.submitErrors.length} bid_submit_error(s) where the healthy disk raises `
      + `${control.submitErrors.length} - the retired-load disk fault was reported to the desk as a failed submit` + trace);
    ok(first + 1, `${label}: no false bid_submit_error beyond what the healthy run raises`);

    assert.strictEqual(f.bidPlaced, 1,
      `${label}: the banked bid produced ${f.bidPlaced} bid_placed events (healthy disk: 1) - the bid is `
      + 'missing from the business record' + trace);
    assert.ok(f.intent.landedBids == null || f.intent.landedBids <= 1,
      `${label}: the durable intent records ${f.intent.landedBids} landed bids for one wire write`);
    ok(first + 2, `${label}: the bid is recorded exactly once`);

    assertDeskAlert(f, first + 3, label);
  }

  console.log(`\nPASS - ${pass} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
