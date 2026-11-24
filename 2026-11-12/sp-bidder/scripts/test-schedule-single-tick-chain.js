'use strict';
/**
 * ONE MONITOR, ONE TICK CHAIN - the timer handle _schedule throws away.
 *
 * Regression target: BH-ASYNC-3 (bug hunt T7, exhibit E2). Verified 3/3 and re-verified
 * independently as CONFIRMED-INDEPENDENT - docs/bug-hunts/2026-09-16_bidcmd-T7-verify-async3.md
 * and docs/bug-hunts/2026-09-16_bidcmd-T7-reverify-blocking.md, section "E2 - BH-ASYNC-3".
 *
 * _schedule (bidEngine.js:2441 on this tip) assigns monitor.timer without clearing the handle it
 * is replacing. resume() (1014) re-schedules EVERY non-finalized monitor at delay 0,
 * unconditionally - it never asks whether a tick is already in flight for that monitor. So a
 * kill() and a resume() that both land while a monitor is parked on its platform read leave that
 * monitor with TWO tick chains, and every tick re-arms itself as its last statement (2926), so
 * both chains survive forever. The doubling is a steady state, not a one-off overlap.
 *
 * That is two independent _maybeBid chains on one load, doubling the poll rate on a live auction
 * and putting two writers on one monitor object across the same await points - and the guards that
 * would stop a double fire (bidInProgress, bidTimes, firedRungs) are all per-MONITOR, so they are
 * blind to each other. Worse, the orphan is unreachable: stop() (6993) and _retireUnreadable can
 * only clear monitor.timer, i.e. the most recently assigned handle. kill()'s docstring promises it
 * "halts every monitor's timer"; a chain no handle points at is not halted by anything.
 *
 * TWO FIXES, NOT ONE - this file discriminates them on purpose. The documented repair
 * (`if (monitor.timer) clearTimeout(monitor.timer);` before the assignment in _schedule) closes
 * checks 3-6; check 7 - the second read started while a tick is already in flight, measured before
 * any read resolves - still fails under that repair and additionally needs a reentrancy latch on
 * _tick.
 *
 * WHAT MUST NOT MOVE - checks 1 and 2 run FIRST, and both pass today, so a zero-bid or zero-chain
 * result below is a real finding and not a dead harness:
 *   - check 1: an ordinary tick on a hard-close load inside the establish mark still places exactly
 *     one bid.
 *   - check 2: resume() still RESTARTS a monitor kill() stopped. Deleting the re-schedule loop at
 *     bidEngine.js:1014 turns every other check here green while leaving every monitor killed on a
 *     merely-pending timer dead forever after a resume - the kill/resume path on live money, and
 *     the fail direction CLAUDE.local.md safety invariant 3 exists for.
 *   - check 6: stop() still leaves nothing running. A cure that trades an orphaned chain for a load
 *     that keeps polling after the desk stopped it is not a cure.
 *
 * Offline and deterministic. getAuctionState PARKS on a hand-resolved promise, so the number of
 * CONCURRENTLY PARKED READS for one monitor IS the number of live tick chains - no rate is
 * measured and no wall-clock window is assumed. Cadence is pinned to 0 ms so the LOOP, not the
 * clock, advances the chains, and the loop is advanced by alternating macrotask/check-phase turns.
 * No sleeps, no network, no RNG on the asserted path.
 *
 *   node scripts/test-schedule-single-tick-chain.js
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
const tmp = () => {
  const f = path.join(os.tmpdir(), `tick-chain-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// Alternate a macrotask (setTimeout 0 - the phase _schedule's timers land in) and a check-phase
// tick. Every pass is a full loop turn, so all ALREADY-READY work runs. Not a sleep: if the code
// under test arms nothing, the loop still completes in microseconds.
async function drain(turns = 12) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

// getAuctionState parks. Resolving by hand is what pins the exact await point inside _tick.
function parkingAdapter(ctrl) {
  ctrl.reads = [];
  ctrl.bids = [];
  return {
    capabilities: () => ({
      standingPriceVisible: false, minDecrement: 100, revisionLimit: 3,
      closeModel: ctrl.closeModel || 'hard',
    }),
    ensureSession: async () => ({}),
    getAuctionState() {
      const d = deferred();
      ctrl.reads.push(d);
      return d.promise;
    },
    async placeBid(auctionId, price, opts) {
      ctrl.bids.push({ auctionId, price, opts });
      return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 5 };
    },
  };
}

const liveState = (ctrl) => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: ctrl.closesInMs, closesAtMs: Date.now() + ctrl.closesInMs,
  revisionLimit: 3, revisionsLeft: null, minDecrement: 100,
  closeModel: ctrl.closeModel || 'hard', extendMs: null, measuredRttMs: 40,
  triggerWindowMs: null,
});

// Resolve every currently-parked read, then let the loop settle. What is parked AFTER this call is
// the next generation of chains.
async function releaseReads(ctrl, turns = 8) {
  const pending = ctrl.reads.splice(0, ctrl.reads.length);
  const state = liveState(ctrl);
  for (const d of pending) d.resolve(state);
  await drain(turns);
}

function newEngine(ctrl, extraCfg = {}) {
  const eng = new BidEngine(parkingAdapter(ctrl), new DurableScheduler(tmp()), {
    config: Object.assign({
      openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
      cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
      pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
      farThresholdMs: 120_000, hotThresholdMs: 20_000,
      minInterFireMs: 0, startGraceMs: 0,
    }, extraCfg),
    rand: () => 0,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return eng;
}

// Pinned to 0 ms so the loop, not the clock, advances the chains.
const ZERO_CADENCE = {
  pollFarMs: 0, pollMidMs: 0, pollHotMs: 0, cadenceJitterMs: 0, farThresholdMs: 120_000,
};

const armMeta = (ms) => ({
  id: '1', lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT',
  units: 1, companyName: 'ACME', closesAt: Date.now() + ms, startsAt: Date.now() - 1000,
});
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

// Stand the engine down, then drain whatever is parked so the process can exit.
const retire = (eng, ctrl) => {
  eng.kill('done');
  const state = liveState(ctrl);
  for (const d of ctrl.reads.splice(0, ctrl.reads.length)) d.resolve(state);
};

(async () => {
  // ------------------------------------------------------- 1. CONTROL: the fire path is reachable
  {
    // Promoted from the hunt's in-file control. No kill, no resume, one ordinary tick on a
    // hard-close load 30s out - inside the 60s establish mark - places exactly one bid. This runs
    // before every mechanism check so a zero count below can never be read as a dead harness.
    const ctrl = { closesInMs: 30_000, closeModel: 'hard' };
    const eng = newEngine(ctrl);
    eng.arm(armMeta(30_000), INPUTS);
    await drain(4);
    assert.strictEqual(ctrl.reads.length, 1, 'setup: the armed monitor must park exactly one read');
    await releaseReads(ctrl);
    assert.strictEqual(ctrl.bids.length, 1,
      `an ordinary tick inside the establish mark must place exactly one bid; it placed ${ctrl.bids.length}`);
    retire(eng, ctrl);
    ok('CONTROL - an ordinary tick still places exactly one bid (the harness reaches the fire path)');
  }

  // ------------------------------------------------------- 2. resume() restarts a killed monitor
  {
    // The other direction of the same seam, on its own engine so it can never affect what fails
    // below. Cadence left at the far default (30s) and the parked read RESOLVED first, so at kill()
    // time there is no continuation in flight and the PENDING TIMER is the only thing holding the
    // monitor alive - which is exactly what kill() clears. resume() has to put it back.
    const c = { closesInMs: 300_000, closeModel: 'hard' };
    const e0 = newEngine(c);
    e0.arm(armMeta(300_000), INPUTS);
    await drain(4);
    assert.strictEqual(c.reads.length, 1, 'setup: one parked read after arm');
    await releaseReads(c);
    assert.strictEqual(c.reads.length, 0,
      'setup: the read resolved and the next tick is 30s out, so nothing is in flight');
    e0.kill('operator');
    e0.resume();
    await drain(6);
    assert.strictEqual(c.reads.length, 1,
      `resume() must restart a monitor that kill() stopped; ${c.reads.length} reads are in flight `
      + '- a monitor killed on a pending timer would never tick again');
    retire(e0, c);
    ok('resume() restarts a monitor kill() stopped on a pending timer (the fail direction)');
  }

  // The kill/resume-across-a-parked-read engine. Checks 3, 4 and 5 measure the same monitor at
  // successive release/re-arm cycles: 300s out on a hard close is the far bucket, well above the
  // establish mark, so no bid ever fires and this is about scheduling alone.
  const ctrl = { closesInMs: 300_000, closeModel: 'hard' };
  const eng = newEngine(ctrl, ZERO_CADENCE);
  const monitor = eng.arm(armMeta(300_000), INPUTS);
  await drain(4);
  assert.strictEqual(ctrl.reads.length, 1, 'setup: one chain, one parked read after arm');

  // The panic button and the recovery, both landing while that read is still in flight.
  eng.kill('operator');
  eng.resume();
  await drain(6);
  console.log('  parked reads right after kill()+resume() :', ctrl.reads.length);

  // ------------------------------------------------------- 3. THE DEFECT: one full cycle
  {
    // Each parked continuation re-arms itself at bidEngine.js:2926, and _schedule never clears the
    // handle it overwrites, so both chains come back.
    await releaseReads(ctrl);
    const cycle1 = ctrl.reads.length;
    console.log('  live chains after one full cycle         :', cycle1);
    assert.strictEqual(cycle1, 1,
      `one monitor must have exactly one live tick chain; it has ${cycle1} (steady state after `
      + 'kill()+resume() landed inside an in-flight platform read)');
    ok('a kill()+resume() across a parked read leaves ONE live tick chain after one cycle');
  }

  // ------------------------------------------------------- 4. it is a steady state, not an overlap
  {
    await releaseReads(ctrl);
    const cycle2 = ctrl.reads.length;
    await releaseReads(ctrl);
    const cycle3 = ctrl.reads.length;
    console.log('  live chains after cycles 2 and 3         :', cycle2, cycle3);
    assert.deepStrictEqual([cycle2, cycle3], [1, 1],
      `the chain count must not grow or persist above one; cycles 2 and 3 show ${cycle2} and ${cycle3} `
      + '- every tick re-arms itself, so a doubling here is permanent, not a one-off overlap');
    ok('cycles 2 and 3 still show one chain - the doubling would be a steady state, not a blip');
  }

  // ------------------------------------------------------- 5. nothing is running unreachably
  {
    // monitor.timer is ONE handle, and it is the only thing stop() and _retireUnreadable can clear.
    // Any chain beyond that count is running with no handle pointing at it, so no cleanup path -
    // including kill(), which promises to halt every monitor's timer - can ever stop it.
    const liveChains = ctrl.reads.length;
    assert.ok(monitor.timer != null,
      'setup: the monitor holds a timer handle, so the tracked count below is 1 and not 0');
    const trackedHandles = monitor.timer ? 1 : 0;
    assert.strictEqual(liveChains, trackedHandles,
      `every live tick chain must be reachable by cleanup: ${liveChains} chains against `
      + `${trackedHandles} engine-tracked handle(s) (stop() and _retireUnreadable clear only `
      + 'monitor.timer, the most recently assigned one)');
    ok('the live chain count equals the handle count the engine tracks - no orphan beyond cleanup');
    retire(eng, ctrl);
  }

  // ------------------------------------------------------- 6. stop() still ends everything
  {
    // The fail direction. Whatever the repair does to _schedule, a stopped load must leave nothing
    // running - including the continuations already parked inside the platform read.
    const c = { closesInMs: 300_000, closeModel: 'hard' };
    const e2 = newEngine(c, ZERO_CADENCE);
    e2.arm(armMeta(300_000), INPUTS);
    await drain(4);
    assert.strictEqual(c.reads.length, 1, 'setup: one parked read after arm');
    e2.kill('operator');
    e2.resume();
    await drain(6);
    e2.stop('1');
    await releaseReads(c);
    assert.strictEqual(c.reads.length, 0,
      `stop() must leave zero live tick chains; ${c.reads.length} survived the stop and re-armed `
      + 'after the parked reads resolved');
    retire(e2, c);
    ok('stop() after a kill()+resume() across a parked read leaves no chain running');
  }

  // ------------------------------------------------------- 7. the residual: the initial overlap
  {
    // Measured at the suspension point, BEFORE any read is resolved, so this is the second chain
    // being STARTED while a tick is already in flight - not the permanent doubling checks 2-4 pin.
    // The clearTimeout repair does not close this one: at resume() the parked chain's handle has
    // already fired, so clearing it is a no-op. This needs a reentrancy latch on _tick.
    const c = { closesInMs: 300_000, closeModel: 'hard' };
    const e3 = newEngine(c, ZERO_CADENCE);
    e3.arm(armMeta(300_000), INPUTS);
    await drain(4);
    assert.strictEqual(c.reads.length, 1, 'setup: one parked read after arm');
    e3.kill('operator');
    e3.resume();
    await drain(6);
    assert.strictEqual(c.reads.length, 1,
      `resume() must not start a tick while one is already in flight for that monitor; `
      + `${c.reads.length} reads are parked for one load (resume() re-schedules every non-finalized `
      + 'monitor at delay 0 unconditionally)');
    retire(e3, c);
    ok('resume() starts no second tick chain while a tick is already parked on its platform read');
  }

  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns
  // early exits 0 and reads as a green zero-assertion run. Pinning the count is what makes
  // truncation fail.
  const EXPECTED = 7;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  cleanup();
  const isAssertion = e && e.code === 'ERR_ASSERTION';
  console.error('\nFAILED: ' + ((e && e.message) || e));
  if (!isAssertion) console.error((e && e.stack) || e);
  console.error('  mechanism: _schedule (bidEngine.js:2441) assigns monitor.timer without clearing');
  console.error('  the handle it replaces, and resume() (1014) re-schedules every non-finalized');
  console.error('  monitor at delay 0 - so a kill()+resume() across an in-flight read leaves one');
  console.error('  monitor with two self-re-arming tick chains (2926) and one tracked handle.');
  process.exit(1);
});
