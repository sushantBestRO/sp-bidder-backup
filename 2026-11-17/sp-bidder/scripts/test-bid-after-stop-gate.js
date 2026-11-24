'use strict';
/**
 * THE STOP GATE - a retirement that lands while _tick is parked on the platform read.
 *
 * Regression target: T2 D4 = T7 E1 (BH-ASYNC-1 + BH-ASYNC-4 + T2 BH-ASYNC-2), bug hunt 2026-09-16.
 *   (dispositions: T7 row E1, T2 row D4)
 *
 * `_tick` reads `monitor.finalized` once, on entry, then suspends on
 * `await this.adapter.getAuctionState(...)`. Nothing between that read and `await this._maybeBid(...)`
 * looks at it again, and `_maybeBid`'s own pre-write gate is `if (this.killed) return;` with
 * `finalized` absent - the only `monitor.finalized` re-check sits AFTER `adapter.placeBid` has
 * already used the wire. So everything an operator does during the read is invisible to the
 * continuation that resumes after it, and three ordinary routes land there: the stop button
 * (server.js POST /api/auctions/:loadId/stop), /api/bot/stop, and `reArmWithNewBand`, which is
 * `stop()` then `armFromRequest()` in the same turn - a re-price whose parked tick then fires the
 * OLD superseded ladder price after the new monitor is armed on the new band.
 *
 * The rule is already written down in this file's own neighbour, the scheduled-wake path: "Nothing
 * captured before the await may be reused after it." `_tick` is the path that does not obey it, and
 * CLAUDE.local safety item 3 says no bid may fire once the stop control has been used.
 *
 * Two symptoms, one window, and neither repair site covers both:
 *   - the wire write (checks 1 and 2) - a real bid at the pre-stop ladder price, a revision spent
 *     off the shared per-load cap, a `bid_placed` event for a load the desk just stopped;
 *   - the console resurrection (check 3) - `_retireUnreadable` leaves the monitor in `this.monitors`
 *     and `snapshot()` keeps reporting it, so a load the engine has permanently given up on
 *     (closedWhileDown booked, the error-level `unreadable_past_close_retired` alert already sent)
 *     redisplays as an actively monitored auction with a healthy countdown.
 *
 * WHAT MUST NOT MOVE:
 *   - an ordinary tick on a hard-close load inside the establish mark still places exactly one bid
 *     (check 4). A gate that also stops the normal fire path is not a fix.
 *   - the re-price assertion is about the OLD ladder's price reaching the wire, NOT about the new
 *     monitor re-firing its establishing rung - scripts/test-stop-rearm-edge.js Group 6 accepts that
 *     a sub-second stop/re-arm can do exactly that.
 *
 * Offline and deterministic: fake adapter whose getAuctionState returns a promise this file resolves
 * BY HAND, which pins the exact suspension point with no timing assumption. No sleeps, no network,
 * no RNG on the asserted path; the loop is drained by alternating a macrotask and a check-phase tick.
 *
 *   node scripts/test-bid-after-stop-gate.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `bid-after-stop-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Every loop turn is a macrotask plus a check-phase tick, so all ALREADY-READY work runs. Not a
// sleep: with nothing pending this completes in microseconds.
async function drain(turns = 12) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

function mkEngine(ctrl, extraCfg = {}) {
  ctrl.reads = [];
  ctrl.bids = [];
  const events = [];
  const adapter = {
    capabilities: () => ({
      standingPriceVisible: false, minDecrement: 100, revisionLimit: 3,
      closeModel: ctrl.closeModel || 'hard',
    }),
    ensureSession: async () => ({}),
    // PARKS. The test owns the moment this resolves; that is the whole instrument.
    getAuctionState: () => { const d = deferred(); ctrl.reads.push(d); return d.promise; },
    placeBid: async (auctionId, price) => {
      ctrl.bids.push({ auctionId, price });
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 5 };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({
      openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
      cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
      pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
      farThresholdMs: 120_000, hotThresholdMs: 20_000,
      minInterFireMs: 0, startGraceMs: 0,
    }, extraCfg),
    rand: () => 0,
    onEvent: (e) => events.push(e),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  eng._events = events;
  return eng;
}

const liveState = (ctrl, over = {}) => Object.assign({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: ctrl.closesInMs, closesAtMs: Date.now() + ctrl.closesInMs,
  revisionLimit: 3, revisionsLeft: null, minDecrement: 100,
  closeModel: ctrl.closeModel || 'hard', extendMs: null, measuredRttMs: 40,
  triggerWindowMs: null,
}, over);

const armMeta = (id, msToClose) => ({
  id, lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
  units: 1, companyName: 'ACME', branchName: 'Bhiwandi',
  closesAt: Date.now() + msToClose, startsAt: Date.now() - 1000,
});
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

const release = async (d, state, turns = 12) => { d.resolve(state); await drain(turns); };
const prices = (ctrl) => ctrl.bids.map((b) => b.price);
const bidEvents = (eng) => eng._events.filter((e) => e.type === 'bid_placed').map((e) => e.price);

(async () => {
  // ---- 1. an operator stop landing inside the read reaches the wire anyway
  {
    // Exactly POST /api/auctions/:loadId/stop: engine.stop(loadId), then the durable intent.
    const ctrl = { closesInMs: 30_000, closeModel: 'hard' };
    const eng = mkEngine(ctrl);
    const monitor = eng.arm(armMeta('1', 30_000), INPUTS);
    await drain(4);
    assert.strictEqual(ctrl.reads.length, 1, 'setup: exactly one tick must be parked on the platform read');
    assert.strictEqual(ctrl.bids.length, 0, 'setup: nothing on the wire yet');

    eng.stop('1');
    if (eng.scheduler.get('1')) eng.scheduler.update('1', { status: 'stopped' });
    assert.strictEqual(monitor.finalized, true, 'setup: stop() finalized the monitor');
    assert.strictEqual(eng.monitors.has('1'), false, 'setup: stop() removed it from the live map');
    assert.strictEqual(eng.scheduler.get('1').status, 'stopped', 'setup: the durable intent says stopped');

    await release(ctrl.reads[0], liveState(ctrl));

    assert.deepStrictEqual(prices(ctrl), [],
      'a load the operator stopped must not reach adapter.placeBid - the tick parked on the platform '
      + `read resumed past the retirement and put ${JSON.stringify(prices(ctrl))} on the wire at the `
      + 'pre-stop ladder price');
    assert.strictEqual(monitor.landedBids, 0, 'and must not book a landed bid off that write');
    assert.deepStrictEqual(bidEvents(eng), [], 'and must not emit bid_placed for a load the desk just stopped');
    assert.strictEqual(monitor.finalized, true, 'the stop stands: the monitor is still finalized');
    assert.strictEqual(eng.monitors.has('1'), false, 'and still out of this.monitors');
    eng.kill('done');
    ok('a stop landing during the platform read puts NOTHING on the wire');
  }

  // ---- 2. the re-price shape: stop() then arm() on a new band, same turn
  {
    // reArmWithNewBand (server.js) is stop() + armFromRequest() with no await between them, so the
    // OLD monitor's parked tick resumes after the NEW monitor is already armed on the new ladder.
    const ctrl = { closesInMs: 30_000, closeModel: 'hard' };
    const eng = mkEngine(ctrl);
    const oldMonitor = eng.arm(armMeta('2', 30_000), INPUTS);
    await drain(4);
    assert.strictEqual(ctrl.reads.length, 1, 'setup: the old monitor is parked on its read');
    const oldRead = ctrl.reads[0];
    const OLD_OPENING = oldMonitor.ladder[0];

    eng.stop('2');
    const newMonitor = eng.arm(armMeta('2', 30_000), { cost: 41_000, marginsPct: [12.6, 7.2, 6.3] });
    await drain(4);
    assert.ok(!newMonitor.ladder.includes(OLD_OPENING),
      'setup: the two ladders must be disjoint or the assertion below cannot tell them apart');
    assert.strictEqual(oldMonitor.finalized, true, 'setup: the re-price finalized the old monitor');
    assert.strictEqual(eng.monitors.get('2'), newMonitor, 'setup: the new monitor is the live one');

    // The new monitor's own read answers first; the old chain answers LAST, which is the interleaving
    // the defect needs and the only one this check is about.
    const others = ctrl.reads.filter((d) => d !== oldRead);
    ctrl.reads.length = 0;
    for (const d of others) d.resolve(liveState(ctrl));
    await drain();
    await release(oldRead, liveState(ctrl));

    assert.ok(!prices(ctrl).includes(OLD_OPENING),
      `a re-price must never fire the SUPERSEDED ladder - ${OLD_OPENING} is the old band's opening `
      + `rung and the wire carries ${JSON.stringify(prices(ctrl))}; the old monitor's parked tick `
      + 'resumed and bid it after the new monitor was armed on the new band');
    eng.kill('done');
    ok('a re-price never fires the superseded ladder price from the parked pre-stop tick');
  }

  // ---- 3. a late continuation resurrects a permanently retired load on the console
  {
    // Two tick chains on one monitor, manufactured by calling _tick directly while chain A is parked
    // (the T2 reproducer's shape) rather than through kill()+resume() - that second door is E2's own
    // defect and is about to be removed, and this check must not depend on it.
    const ctrl = { closesInMs: 300_000, closeModel: 'hard' };
    const eng = mkEngine(ctrl, {
      pollFarMs: 0, pollMidMs: 0, pollHotMs: 0, unreadableRetireMs: 7_200_000,
    });
    const EIGHT_HOURS = 8 * 3_600_000;
    const monitor = eng.arm(armMeta('3', -EIGHT_HOURS), INPUTS);
    await drain(4);
    assert.strictEqual(ctrl.reads.length, 1, 'setup: chain A parked on its read');
    const chainA = ctrl.reads[0];

    const chainB = eng._tick(monitor);
    chainB.catch(() => {});
    await drain(2);
    assert.strictEqual(ctrl.reads.length, 2, 'setup: a second chain is parked on its own read');

    // Chain B's read fails on a load 8h past its close - past unreadableRetireMs, so it retires.
    await release(ctrl.reads[1], { ok: false, error: 'portal timeout' });
    assert.strictEqual(monitor.finalized, true, 'setup: chain B retired the load as unreadable');
    assert.strictEqual(monitor.status, 'closed', 'setup: the retirement wrote the lifecycle status');
    assert.strictEqual(eng.monitors.has('3'), true,
      'setup: _retireUnreadable leaves the monitor in this.monitors (unlike stop()), so snapshot() reports it');
    const failingSince = monitor._firstReadFailAt;
    assert.ok(failingSince != null, 'setup: the outage clock is running');

    // Chain A's read finally answers, healthily. This is the late continuation.
    await release(chainA, liveState(ctrl, { closesInMs: 300_000, myRank: 2 }));

    assert.strictEqual(monitor.status, 'closed',
      'a permanently retired load must keep its lifecycle status - the late continuation wrote '
      + `${JSON.stringify(monitor.status)}, so /api/state shows a load the engine has given up on as an `
      + `actively monitored auction with a ${monitor.closesInMs} ms countdown`);
    const snap = eng.snapshot().find((s) => s.auctionId === '3');
    assert.ok(snap, 'the monitor is still reported by snapshot()');
    assert.strictEqual(snap.status, 'closed', 'and the operator console reads the retired status, not a poll phase');
    assert.strictEqual(monitor._firstReadFailAt, failingSince,
      'and the outage clock is not reset on a monitor that will never read again');
    eng.kill('done');
    ok('a late continuation leaves a retired load retired on the console');
  }

  // ---- 4. CONTROL: the ordinary establish bid still fires
  {
    const ctrl = { closesInMs: 30_000, closeModel: 'hard' };
    const eng = mkEngine(ctrl);
    const monitor = eng.arm(armMeta('4', 30_000), INPUTS);
    await drain(4);
    assert.strictEqual(ctrl.reads.length, 1, 'setup: one tick parked on the read');
    await release(ctrl.reads[0], liveState(ctrl));

    assert.strictEqual(ctrl.bids.length, 1,
      `an undisturbed tick inside the establish mark must place exactly one bid - got ${JSON.stringify(prices(ctrl))}`);
    assert.strictEqual(ctrl.bids[0].price, monitor.ladder[0], 'at the opening rung of its own ladder');
    assert.strictEqual(monitor.finalized, false, 'and the load stays live');
    eng.kill('done');
    ok('CONTROL: an ordinary tick with no stop and no retire still places exactly one bid');
  }

  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades by EXIT CODE alone, so a file that returns early exits 0
  // and reads as a green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { cleanup(); console.error(e); process.exit(1); });
