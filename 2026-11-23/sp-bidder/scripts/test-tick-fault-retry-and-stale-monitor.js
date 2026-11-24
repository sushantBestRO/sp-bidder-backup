'use strict';
/**
 * THE TICK-FAULT RETRY - after a contained tick fault the next check lands at the cadence the load's
 * closeness calls for, and a monitor the desk has already replaced cannot hand the load off.
 *
 * Regression target: owner ruling OQ-1 (2026-09-24), cluster W1-5, fix a72dc89.
 *   sibling: scripts/test-tick-fault-handoff.js (one fault keeps the load watched, three hand it off).
 *   The sibling's fake timers fire every handle whatever its delay, so it never sees WHEN the retry
 *   lands. This file records the delay.
 *
 * bidEngine.js  _tickFaulted:
 *   if (monitor._tickFaults >= TICK_FAULT_HANDOFF_AT && !monitor.finalized) { hand off; return; }
 *   let retryMs = this.cfg.pollHotMs;
 *   if (ms > this.cfg.farThresholdMs) retryMs = this.cfg.pollFarMs;
 *   else if (ms > this.cfg.hotThresholdMs) retryMs = this.cfg.pollMidMs;
 *
 * What is pinned:
 *   - a load 5 s from close that faults once is re-checked at pollHotMs. A retry planted at
 *     pollFarMs lands after the close, so "the load keeps being watched" would mean nothing (check 1);
 *   - a load 5 min from close re-checks at pollFarMs - the bucket follows closeness (check 2);
 *   - a monitor with two faults parks its third read, the desk re-prices (stop + arm builds a NEW
 *     monitor under the same id), and the stale read then faults a third time. That stale monitor is
 *     finalized; without the finalized guard its hand-off would stop the NEW monitor, write the intent
 *     'stopped' and tell the desk to bid by hand a load we are bidding (check 3);
 *   - control: the re-priced monitor keeps its one tick chain and ticks healthily (check 4).
 *
 * Named re-pin (W1-2): _tick now re-checks the monitor right after its platform read, so the parked
 * stale read of check 3 returns there and never reaches the tail fault. Check 3 keeps that route and
 * pins it, and reaches the same guard through the await the re-check does not cover: a second load's
 * stale monitor, whose checks fault after auth-failed reads, is parked on the session re-check when
 * the desk re-prices, and faults a third time when that await resumes.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler under os.tmpdir(), rand pinned, no
 * network, no sleeps. setTimeout/clearTimeout are faked and record the delay of every handle.
 *
 *   node scripts/test-tick-fault-retry-and-stale-monitor.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp scheduler store), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const failures = [];
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-retry-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const pending = new Set();
const fakeTimers = () => {
  global.setTimeout = (fn, ms, ...args) => {
    const h = { fn, ms, args, unref() { return h; }, ref() { return h; }, hasRef() { return false; } };
    pending.add(h);
    return h;
  };
  global.clearTimeout = (h) => { if (pending.has(h)) pending.delete(h); else realClearTimeout(h); };
};
const realTimers = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
const step = async () => {
  const due = [...pending];
  pending.clear();
  for (const h of due) h.fn(...h.args);
  await settle();
  return due.length;
};
const pendingMs = () => [...pending].map((h) => h.ms);

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const CAPS = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
  revisionLimit: 3, closeModel: 'hard' });
const liveState = (closesInMs) => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3,
  standingL1Price: null, closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50,
  minDecrement: 100 });
const mkLoad = (id, closesInMs) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: Date.now() - 1000, closesAt: Date.now() + closesInMs,
});

const RETRY_CFG = { openAtMs: 1_000, floorWindowMs: 500, minInterFireMs: 0, finalizeDebounceMs: 0,
  pollFarMs: 30_000, pollMidMs: 1_000, pollHotMs: 200, farThresholdMs: 60_000, hotThresholdMs: 10_000,
  cadenceJitterMs: 0 };

async function retryDelaysAfterOneFault(id, closesInMs) {
  pending.clear();
  const state = liveState(closesInMs);
  const eng = new BidEngine({
    writeEnabled: true, capabilities: CAPS, ensureSession: async () => ({}),
    getAuctionState: async () => state,
    placeBid: async () => ({ accepted: false, reason: 'refused' }),
  }, new DurableScheduler(tmp()), { config: RETRY_CFG, live: true, onEvent: () => {}, log: quiet, rand: () => 0 });
  const mon = eng.arm(mkLoad(id, closesInMs), INPUTS);
  setup(mon && pending.size === 1, `arm() must plant exactly one tick timer for ${id}`);
  // Installed after arm(): arm() calls _checkDelisted itself and would consume the fault.
  const original = eng._checkDelisted.bind(eng);
  let faultNext = false;
  let injected = 0;
  eng._checkDelisted = (m) => {
    if (faultNext) { faultNext = false; injected += 1; throw new Error(`injected tick fault on ${id}`); }
    return original(m);
  };
  await step();
  setup(mon.closesInMs === closesInMs, `the healthy tick must record closesInMs ${closesInMs} (got ${mon.closesInMs})`);
  faultNext = true;
  await step();
  setup(injected === 1, `the second tick must reach the injected fault on ${id}`);
  setup(mon._tickFaults === 1, `exactly one contained fault on ${id} (got ${mon._tickFaults})`);
  const ms = pendingMs();
  eng.kill('done');
  pending.clear();
  return ms;
}

async function check(n, name, fn) {
  const before = rejections.length;
  try {
    await fn();
    assert.strictEqual(rejections.length, before,
      `a rejection escaped the tick timer during check ${n}: ${rejections[before] && rejections[before].message}`);
    console.log(`  ok  ${n}. ${name}`);
    pass += 1;
  } catch (e) {
    if (e instanceof SetupError) throw e;
    console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
    failures.push(n);
  }
}

(async () => {
  fakeTimers();

  await check(1, 'a load 5 s from close that faults once is re-checked at pollHotMs', async () => {
    // Arrange + Act
    const ms = await retryDelaysAfterOneFault('RETRY-hot', 5_000);
    // Assert
    assert.deepStrictEqual(ms, [RETRY_CFG.pollHotMs],
      `after a contained fault 5 s before close the retry must be planted at pollHotMs `
      + `(${RETRY_CFG.pollHotMs} ms); _tickFaulted planted ${JSON.stringify(ms)} - a retry at pollFarMs `
      + `(${RETRY_CFG.pollFarMs} ms) lands after the load has closed`);
  });

  await check(2, 'a load 5 min from close that faults once is re-checked at pollFarMs', async () => {
    const ms = await retryDelaysAfterOneFault('RETRY-far', 300_000);
    assert.deepStrictEqual(ms, [RETRY_CFG.pollFarMs],
      `after a contained fault 5 min before close the retry must be planted at pollFarMs `
      + `(${RETRY_CFG.pollFarMs} ms); _tickFaulted planted ${JSON.stringify(ms)} - the retry bucket must `
      + 'follow the load\'s closeness');
  });

  // ------------------------------------------- 3 + 4. a stale monitor after a re-price
  pending.clear();
  const ID = 'STALE-reprice';
  const LIVE = liveState(600_000);
  let park = false;
  const parked = [];
  const events = [];
  const adapter = {
    writeEnabled: true, reads: 0, capabilities: CAPS, ensureSession: async () => ({}),
    getAuctionState: () => {
      adapter.reads += 1;
      return park ? new Promise((r) => parked.push(r)) : Promise.resolve(LIVE);
    },
    placeBid: async () => ({ accepted: false, reason: 'refused' }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
  });
  const stale = eng.arm(mkLoad(ID, 600_000), INPUTS);
  setup(stale && pending.size === 1, 'arm() must plant exactly one tick timer for the stale monitor');
  // _cadence runs at the tick's tail, after the platform read, so the third fault can come from a
  // tick that was parked on its read while the desk re-priced.
  const origCadence = eng._cadence.bind(eng);
  let staleFaults = 0;
  eng._cadence = (ms, m) => {
    if (m === stale) { staleFaults += 1; throw new Error('injected tail fault on the stale monitor'); }
    return origCadence(ms, m);
  };
  await step();
  await step();
  setup(staleFaults === 2 && stale._tickFaults === 2, `two consecutive tail faults on the stale monitor (got ${stale._tickFaults})`);
  park = true;
  await step();
  setup(parked.length === 1, 'the stale monitor\'s third tick must be parked on its platform read');
  park = false;
  eng.stop(ID);
  const fresh = eng.arm(mkLoad(ID, 600_000), INPUTS);
  setup(fresh && fresh !== stale && stale.finalized, 'the re-price must build a new monitor and finalize the old one');

  await check(3, 'a stale monitor faulting a third time after a re-price does not hand the re-priced load off', async () => {
    // Act
    parked.shift()(LIVE);
    await settle();
    assert.strictEqual(staleFaults, 2,
      'named re-pin: W1-2, post-await re-check - the stale read parked across the re-price must return at '
      + `the re-check after the read, before the tail (tail faults: ${staleFaults}, expected 2)`);
    // Assert
    const handoffs = events.filter((e) => e.kind === 'tick_fault_handoff');
    assert.strictEqual(handoffs.length, 0,
      `the stale monitor (finalized by the re-price) emitted ${handoffs.length} tick_fault_handoff: its `
      + 'hand-off must be guarded by !monitor.finalized, or it tells the desk to bid by hand a load we are bidding');
    assert.ok(eng.monitors.get(ID) === fresh && !fresh.finalized,
      'the re-priced monitor must still be the one watching the load, not stopped by the stale hand-off');
    assert.notStrictEqual(eng.scheduler.get(ID).status, 'stopped',
      'the durable intent must not be written \'stopped\' by the stale monitor');

    // named re-pin: W1-2, post-await re-check - the same third fault through the await the re-check does
    // not cover: a stale monitor parked on the session re-check an auth-failed read makes.
    const ID2 = 'STALE-reprice-auth';
    const AUTH_FAILED = { ok: false, authError: true, error: 'session expired' };
    const baseRead = adapter.getAuctionState;
    const baseSession = adapter.ensureSession;
    let parkSession = false;
    const sessionParked = [];
    adapter.getAuctionState = (id) => (id === ID2 ? Promise.resolve(AUTH_FAILED) : baseRead(id));
    adapter.ensureSession = () => (parkSession ? new Promise((r) => sessionParked.push(r)) : Promise.resolve({}));
    const staleB = eng.arm(mkLoad(ID2, 600_000), INPUTS);
    const origBound = eng._unreadablePastBound.bind(eng);
    let staleBFaults = 0;
    eng._unreadablePastBound = (m) => {
      if (m === staleB) { staleBFaults += 1; throw new Error('injected post-session fault on the stale monitor'); }
      return origBound(m);
    };
    await step();
    await step();
    setup(staleBFaults === 2 && staleB._tickFaults === 2,
      `two consecutive post-session faults on the second stale monitor (got ${staleB._tickFaults})`);
    parkSession = true;
    await step();
    setup(sessionParked.length === 1, 'the second stale monitor\'s third tick must be parked on its session re-check');
    parkSession = false;
    eng.stop(ID2);
    const freshB = eng.arm(mkLoad(ID2, 600_000), INPUTS);
    setup(freshB && freshB !== staleB && staleB.finalized, 'the re-price must build a new monitor and finalize the old one');
    sessionParked.shift()({});
    await settle();
    setup(staleBFaults === 3, 'the parked session re-check must resume into a third fault on the stale monitor');
    const handoffsB = events.filter((e) => e.kind === 'tick_fault_handoff');
    assert.strictEqual(handoffsB.length, 0,
      `${ID2}: the stale monitor (finalized by the re-price) emitted ${handoffsB.length} tick_fault_handoff: its `
      + 'hand-off must be guarded by !monitor.finalized, or it tells the desk to bid by hand a load we are bidding');
    assert.ok(eng.monitors.get(ID2) === freshB && !freshB.finalized,
      `${ID2}: the re-priced monitor must still be the one watching the load, not stopped by the stale hand-off`);
    assert.notStrictEqual(eng.scheduler.get(ID2).status, 'stopped',
      `${ID2}: the durable intent must not be written 'stopped' by the stale monitor`);
    // Leave check 4 the first load's one tick chain.
    eng.stop(ID2);
    eng._unreadablePastBound = origBound;
    adapter.getAuctionState = baseRead;
    adapter.ensureSession = baseSession;
  });

  await check(4, 'control: the re-priced monitor keeps its one tick chain and ticks healthily', async () => {
    assert.strictEqual(pending.size, 1, `exactly one tick timer is planted for the load (got ${pending.size})`);
    const readsBefore = adapter.reads;
    await step();
    assert.strictEqual(adapter.reads, readsBefore + 1, 'the re-priced monitor\'s tick read the platform');
    assert.strictEqual(fresh._tickFaults || 0, 0, 'and did not fault');
    assert.ok(eng.monitors.get(ID) === fresh && !fresh.finalized && pending.size === 1,
      'and rescheduled itself, one chain');
  });
  eng.kill('done');

  realTimers();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/4 passed)`);
    process.exit(1);
  }
  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS ${pass}/${EXPECTED} checks passed`);
})().catch((e) => { realTimers(); cleanup(); console.error(e); process.exit(1); });
