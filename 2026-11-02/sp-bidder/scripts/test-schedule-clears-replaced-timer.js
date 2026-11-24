'use strict';
/**
 * ONE MONITOR, ONE PLANNED TICK - _schedule must clear the handle it replaces.
 *
 * Regression target: T7 E2 (BH-ASYNC-3), the clearTimeout half. test-schedule-single-tick-chain.js
 * pins the latch half; this file pins the other real ordering, which the latch cannot see.
 *
 * kill() lands while a monitor's tick is parked on its platform read, then resume() re-plans every
 * live monitor at delay 0. If the parked read settles AFTER resume() but BEFORE that 0 ms timer gets
 * a timers phase, the old tick finishes and re-plans its own far-cadence timer while resume()'s 0 ms
 * timer is still pending. Without `if (monitor.timer) clearTimeout(monitor.timer)` in _schedule both
 * survive: the 0 ms tick runs (nothing is in flight, so the latch lets it through) and re-plans, then
 * the 30 s tick runs and re-plans. Two chains that never overlap in time, so the latch never refuses
 * either, and only one of them is monitor.timer - the one stop() and kill() can reach.
 *
 * WHAT MUST NOT MOVE - check 1 runs first: an ordinary monitor with no kill/resume keeps exactly one
 * planned tick per fire, so a count of one below is measured by a live harness.
 *
 * Offline and deterministic. setTimeout/clearTimeout are replaced with a ledger, so no timer fires
 * unless the test fires it and no wall-clock time passes. getAuctionState parks on a hand-resolved
 * promise; the loop is advanced by setImmediate turns only. No network, no RNG on the asserted path.
 *
 *   node scripts/test-schedule-clears-replaced-timer.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const pending = new Set();
global.setTimeout = (fn, ms, ...args) => {
  const h = { fn, ms, args, unref() { return h; }, ref() { return h; }, hasRef() { return false; } };
  pending.add(h);
  return h;
};
global.clearTimeout = (h) => { if (pending.has(h)) pending.delete(h); else realClearTimeout(h); };

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `clears-replaced-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => {
  pending.clear();
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
};

const liveState = () => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 300_000, closesAtMs: Date.now() + 300_000, revisionLimit: 3, revisionsLeft: null,
  minDecrement: 100, closeModel: 'hard', extendMs: null, measuredRttMs: 40, triggerWindowMs: null,
});

function newEngine(reads) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState() { return new Promise((resolve) => { reads.push(resolve); }); },
    async placeBid() { return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 5 }; },
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: {
      openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
      cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
      pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
      farThresholdMs: 120_000, hotThresholdMs: 20_000, minInterFireMs: 0, startGraceMs: 0,
    },
    rand: () => 0,
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

// 300s out on a hard close is the far bucket, above the establish mark: no bid fires, scheduling only.
const armMeta = () => ({
  id: '1', lane: { origin: 'MUMBAI', destination: 'DELHI' }, equipment: '32FT', units: 1,
  companyName: 'ACME', closesAt: Date.now() + 300_000, startsAt: Date.now() - 1000,
});
const INPUTS = { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] };

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const plannedMs = () => [...pending].map((h) => h.ms).sort((a, b) => a - b);

async function fire(h) {
  pending.delete(h);
  h.fn(...h.args);
  await settle();
}

// Fire the soonest planned timer, then resolve every read it starts. Returns [reads, handles left].
async function fireEarliest(reads) {
  assert.ok(pending.size > 0, 'the monitor has no planned tick left - its chain died');
  await fire([...pending].sort((a, b) => a.ms - b.ms)[0]);
  let n = 0;
  while (reads.length) { reads.shift()(liveState()); n += 1; await settle(); }
  return [n, pending.size];
}

(async () => {
  // ------------------------------------------------------- 1. CONTROL: an ordinary chain
  {
    const reads = [];
    const eng = newEngine(reads);
    const mon = eng.arm(armMeta(), INPUTS);
    assert.deepStrictEqual(plannedMs(), [0], 'setup: arm plants one 0 ms tick');
    const perFire = [];
    for (let c = 0; c < 4; c++) perFire.push(await fireEarliest(reads));
    assert.deepStrictEqual(perFire, [[1, 1], [1, 1], [1, 1], [1, 1]],
      `an ordinary monitor must do one read and hold one planned tick per fire; got ${JSON.stringify(perFire)}`);
    assert.ok(pending.has(mon.timer), 'the ordinary monitor\'s one planned tick is monitor.timer');
    eng.kill('done');
    assert.strictEqual(pending.size, 0, 'setup: kill() leaves the control engine nothing planned');
    ok('CONTROL - an ordinary monitor holds one planned tick per fire (the ledger counts handles)');
  }

  const reads = [];
  const eng = newEngine(reads);
  const mon = eng.arm(armMeta(), INPUTS);
  assert.strictEqual(pending.size, 1, 'setup: arm plants one tick');
  await fire([...pending][0]);
  assert.strictEqual(reads.length, 1, 'setup: the arm tick is parked on its platform read');
  eng.kill('operator');
  eng.resume();
  assert.deepStrictEqual(plannedMs(), [0], 'setup: resume() planted its 0 ms tick');

  // ------------------------------------------------------- 2. THE DEFECT: early settle
  {
    // The parked read settles before any timer fires, so the old tick re-plans at 30s while
    // resume()'s 0 ms handle is still pending. _schedule must clear the handle it replaces.
    reads.shift()(liveState());
    await settle();
    const planned = plannedMs();
    console.log('  planned ticks after the parked read settled :', planned);
    assert.deepStrictEqual(planned, [30_000],
      `one monitor must hold exactly one planned tick; it holds ${planned.length} (${planned.join(', ')} ms) `
      + '- _schedule replaced monitor.timer without clearing resume()\'s 0 ms tick');
    assert.ok(pending.has(mon.timer), 'the one planned tick is monitor.timer, the handle stop()/kill() clear');
    ok('a read settling between resume() and its 0 ms tick leaves ONE planned tick, and it is monitor.timer');
  }

  // ------------------------------------------------------- 3. steady state: one chain
  {
    const perFire = [];
    for (let c = 0; c < 4; c++) perFire.push(await fireEarliest(reads));
    console.log('  per fire [reads, planned ticks]            :', JSON.stringify(perFire));
    assert.deepStrictEqual(perFire, [[1, 1], [1, 1], [1, 1], [1, 1]],
      `every fire must be one read leaving one planned tick; got ${JSON.stringify(perFire)} `
      + '- a second self-re-arming chain survived the kill()+resume()');
    assert.ok(pending.has(mon.timer), 'the one planned tick left is monitor.timer');
    ok('four fires later the monitor still runs one chain, reachable through monitor.timer');
  }

  eng.kill('done');
  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns
  // early exits 0 and reads as a green zero-assertion run.
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  cleanup();
  const isAssertion = e && e.code === 'ERR_ASSERTION';
  console.error('\nFAILED: ' + ((e && e.message) || e));
  if (!isAssertion) console.error((e && e.stack) || e);
  console.error('  mechanism: _schedule must clearTimeout(monitor.timer) before planting the next tick.');
  console.error('  When a parked read settles after resume() but before resume()\'s 0 ms tick fires, the');
  console.error('  old tick re-plans while that 0 ms handle is still pending; without the clear both run as');
  console.error('  two non-overlapping chains the reentrancy latch never sees, and only one is monitor.timer.');
  process.exit(1);
});
