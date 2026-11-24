'use strict';
/**
 * THE WRITE GATE AND THE POST-READ RE-CHECK - the halves of the T2 D4 = T7 E1 fix that
 * scripts/test-bid-after-stop-gate.js does not reach.
 *
 * Regression target: T2 D4 = T7 E1 (a stop, re-price, retire or kill landing while _tick is parked on
 * adapter.getAuctionState still bids and still writes state onto a finalized monitor).
 *
 * That file pins the `monitor.finalized` half of _tick's post-read re-check on a read that SUCCEEDS.
 * Three edges of the same fix stay open without this file:
 *   - _maybeBid's pre-write gate, `if (this.killed || monitor.finalized) return;`, both halves. _tick
 *     re-checks first, so no _tick-driven path reaches it; it is the last line before adapter.placeBid
 *     for any other caller. Checks 1-3 call _maybeBid directly, the convention
 *     test-auth-fail-closed, test-auth-reversibility, test-auth-scenarios and test-budget-aware-retry
 *     already use.
 *   - the `this.killed` half of _tick's re-check. A kill landing during the read must leave the
 *     monitor as it was and emit nothing after the kill's own alert (checks 4-5).
 *   - WHERE the re-check sits. Above the failed-read branch, a stop landing during a read that FAILS
 *     must not count a failure, start the outage clock, re-auth the session or alert for a stopped
 *     load (checks 6-7); above the min-decrement recording line, a late healthy read must not record
 *     the platform's decrement onto the stopped monitor either (check 8).
 *
 * The fake adapter deliberately declares no `writeEnabled`. The real adapters throw from placeBid
 * when kill() lowers that backstop, which would stop the write in checks 2 and 4 whether or not the
 * engine gate held. Here only the engine can refuse the write.
 *
 * WHAT MUST NOT MOVE: a direct _maybeBid on a live monitor still places exactly one bid at the opening
 * rung (check 3); a healthy read on a live monitor still records rank, phase and decrement (check 5);
 * a failed auth read on a live monitor still counts, re-auths and alerts (check 7). Each is the
 * control that keeps its neighbour from passing because the path is dead in this harness.
 *
 * Offline and deterministic: every platform read is a promise this file resolves by hand. No sleeps,
 * no network, no RNG on the asserted path.
 *
 *   node scripts/test-write-gate-finalized-monitor.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `write-gate-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function drain(turns = 12) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

function mkEngine(ctrl) {
  ctrl.reads = [];
  ctrl.bids = [];
  ctrl.sessions = 0;
  const events = [];
  const adapter = {
    capabilities: () => ({
      standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard',
    }),
    ensureSession: async () => { ctrl.sessions++; return {}; },
    getAuctionState: () => { const d = deferred(); ctrl.reads.push(d); return d.promise; },
    placeBid: async (auctionId, price) => {
      ctrl.bids.push({ auctionId, price });
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 5 };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: {
      openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
      cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
      pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
      farThresholdMs: 120_000, hotThresholdMs: 20_000,
      minInterFireMs: 0, startGraceMs: 0,
    },
    rand: () => 0,
    onEvent: (e) => events.push(e),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  eng._events = events;
  return eng;
}

const CLOSES_IN = 30_000;
const liveState = (over = {}) => Object.assign({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: CLOSES_IN, closesAtMs: Date.now() + CLOSES_IN,
  revisionLimit: 3, revisionsLeft: null, minDecrement: 100,
  closeModel: 'hard', extendMs: null, measuredRttMs: 40, triggerWindowMs: null,
}, over);
const AUTH_FAIL = { ok: false, error: 'x', authError: true };

const armMeta = (id) => ({
  id, lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
  units: 1, companyName: 'ACME', branchName: 'Bhiwandi',
  closesAt: Date.now() + CLOSES_IN, startsAt: Date.now() - 1000,
});
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

const prices = (ctrl) => ctrl.bids.map((b) => b.price);
const bidEvents = (eng) => eng._events.filter((e) => e.type === 'bid_placed').map((e) => e.price);
const kinds = (evs) => evs.map((e) => e.kind || e.type);

async function armParked(ctrl, id) {
  const eng = mkEngine(ctrl);
  const monitor = eng.arm(armMeta(id), INPUTS);
  await drain(4);
  assert.strictEqual(ctrl.reads.length, 1, 'setup: exactly one tick must be parked on the platform read');
  assert.strictEqual(ctrl.bids.length, 0, 'setup: nothing on the wire yet');
  return { eng, monitor };
}

(async () => {
  // ---- 1. the write gate refuses a stopped monitor
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w1');
    eng.stop('w1');
    assert.strictEqual(monitor.finalized, true, 'setup: stop() finalized the monitor');

    // Act
    await eng._maybeBid(monitor, liveState());

    // Assert
    assert.deepStrictEqual(prices(ctrl), [],
      '_maybeBid must refuse a finalized monitor at its pre-write gate - a stopped load reached '
      + `adapter.placeBid with ${JSON.stringify(prices(ctrl))}, so the gate is not checking monitor.finalized`);
    assert.deepStrictEqual(bidEvents(eng), [], 'and must not emit bid_placed for a stopped load');
    assert.notStrictEqual(monitor.everBid, true, 'and must not mark the stopped monitor as having bid');
    const intent = eng.scheduler.get('w1');
    assert.ok(!intent || intent.everBid !== true,
      'and must not book everBid onto the durable intent of a load the desk stopped');
    eng.kill('done');
    ok('write gate: a direct _maybeBid on a STOPPED monitor puts nothing on the wire and books nothing');
  }

  // ---- 2. the write gate refuses a killed engine
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w2');
    eng.kill('operator');
    assert.strictEqual(monitor.finalized, false, 'setup: kill() does not finalize, so only the killed half can refuse');

    // Act
    await eng._maybeBid(monitor, liveState());

    // Assert
    assert.deepStrictEqual(prices(ctrl), [],
      '_maybeBid must refuse to write on a killed engine - adapter.placeBid received '
      + `${JSON.stringify(prices(ctrl))} after kill(), so the gate is not checking this.killed`);
    assert.deepStrictEqual(bidEvents(eng), [], 'and must not emit bid_placed from a killed engine');
    ok('write gate: a direct _maybeBid on a KILLED engine puts nothing on the wire');
  }

  // ---- 3. CONTROL for 1-2: the same direct call on a live monitor fires
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w3');

    // Act
    await eng._maybeBid(monitor, liveState());

    // Assert
    assert.deepStrictEqual(prices(ctrl), [monitor.ladder[0]],
      `a direct _maybeBid on a live monitor must place exactly one bid at the opening rung - got ${JSON.stringify(prices(ctrl))}`);
    assert.deepStrictEqual(bidEvents(eng), [monitor.ladder[0]], 'and emit bid_placed for it');
    eng.kill('done');
    ok('CONTROL: the same direct _maybeBid on a live monitor places exactly one bid at the opening rung');
  }

  // ---- 4. a kill landing during the read leaves the monitor untouched
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w4');
    const status0 = monitor.status;
    const rank0 = monitor.myRank;
    const n = eng._events.length;

    // Act
    eng.kill('operator');
    ctrl.reads[0].resolve(liveState());
    await drain();

    // Assert
    assert.strictEqual(monitor.status, status0,
      `a kill landing during the platform read must leave the monitor's status alone - the parked tick `
      + `resumed on a killed engine and wrote ${JSON.stringify(monitor.status)} over ${JSON.stringify(status0)}`);
    assert.strictEqual(monitor.myRank, rank0, 'and must not write the late read\'s rank onto it');
    assert.deepStrictEqual(kinds(eng._events.slice(n)), ['killed'],
      'nothing may be emitted after the kill\'s own alert - the parked tick on a killed engine emitted '
      + JSON.stringify(kinds(eng._events.slice(n))));
    assert.deepStrictEqual(prices(ctrl), [], 'and nothing reaches the wire');
    ok('a kill landing during the platform read leaves the monitor untouched and emits nothing after it');
  }

  // ---- 5. CONTROL for 4 and 8: the same healthy read on a live monitor writes
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w5');
    const status0 = monitor.status;

    // Act
    ctrl.reads[0].resolve(liveState({ minDecrement: 1500 }));
    await drain();

    // Assert
    assert.notStrictEqual(monitor.status, status0,
      `a healthy read on a live monitor must move its phase off ${JSON.stringify(status0)} - check 4 means nothing otherwise`);
    assert.notStrictEqual(monitor.myRank, null, 'and record a rank');
    assert.strictEqual(monitor.lastMinDecrement, 1500, 'and record the platform\'s per-load decrement');
    eng.kill('done');
    ok('CONTROL: the same healthy read on a live monitor writes phase, rank and decrement');
  }

  // ---- 6. a stop landing during a read that FAILS does nothing
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w6');
    const sessions0 = ctrl.sessions;
    const failSince0 = monitor._firstReadFailAt;
    const n = eng._events.length;

    // Act
    eng.stop('w6');
    ctrl.reads[0].resolve(AUTH_FAIL);
    await drain();

    // Assert
    assert.strictEqual(ctrl.sessions, sessions0,
      'a stop landing during a failed auth read must not re-auth the platform session for the stopped load - '
      + `adapter.ensureSession ran ${ctrl.sessions - sessions0} time(s), so the post-read re-check sits below the failed-read branch`);
    assert.deepStrictEqual(kinds(eng._events.slice(n)), [],
      `and must not alert for a stopped load - emitted ${JSON.stringify(kinds(eng._events.slice(n)))}`);
    assert.strictEqual(monitor.consecutiveReadFails, 0, 'and must not count a read failure on it');
    assert.strictEqual(monitor._firstReadFailAt, failSince0, 'and must not start the outage clock on it');
    eng.kill('done');
    ok('a stop landing during a failed read counts nothing, re-auths nothing and alerts nothing');
  }

  // ---- 7. CONTROL for 6: the same failed read on a live monitor acts
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w7');
    const sessions0 = ctrl.sessions;
    const n = eng._events.length;

    // Act
    ctrl.reads[0].resolve(AUTH_FAIL);
    await drain();

    // Assert
    assert.strictEqual(ctrl.sessions, sessions0 + 1, 'a failed auth read on a live monitor must re-auth once - check 6 means nothing otherwise');
    assert.ok(kinds(eng._events.slice(n)).includes('auth_error_mid_auction'), 'and alert auth_error_mid_auction');
    assert.strictEqual(monitor.consecutiveReadFails, 1, 'and count the failure');
    assert.strictEqual(typeof monitor._firstReadFailAt, 'number', 'and start the outage clock');
    eng.kill('done');
    ok('CONTROL: the same failed auth read on a live monitor re-auths, alerts and counts');
  }

  // ---- 8. a late healthy read records nothing onto a stopped monitor
  {
    // Arrange
    const ctrl = {};
    const { eng, monitor } = await armParked(ctrl, 'w8');
    const dec0 = monitor.lastMinDecrement;

    // Act
    eng.stop('w8');
    ctrl.reads[0].resolve(liveState({ minDecrement: 1500 }));
    await drain();

    // Assert
    assert.strictEqual(monitor.lastMinDecrement, dec0,
      'a late read must not record the platform\'s decrement onto a stopped monitor - lastMinDecrement became '
      + `${JSON.stringify(monitor.lastMinDecrement)}, so the post-read re-check sits below the recording line`);
    eng.kill('done');
    ok('a late healthy read records nothing onto a stopped monitor');
  }

  cleanup();
  const EXPECTED = 8;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
