'use strict';
/**
 * THE TICK-FAULT RETRY READS THE CLOSE, NOT THE LAST READING - after a contained tick fault the next
 * check is planted by the time actually left to the load's close, so a run of faults hands the load
 * to the desk while the desk can still bid it.
 *
 * Regression target: review finding on fix/timer-lifecycle-orphans (head fca118e), the retry cadence
 * of _tickFaulted.
 *   sibling: scripts/test-tick-fault-retry-and-stale-monitor.js (the retry bucket follows closeness).
 *   The sibling faults the tick right after a healthy one, so its last reading is still current. This
 *   file lets the clock run on between the last good read and the fault.
 *
 * bidEngine.js  _tickFaulted (before):
 *   const ms = monitor.closesInMs;
 * monitor.closesInMs is refreshed only by a tick that gets past the platform read. A fault thrown
 * earlier - _checkDelisted is the tick's first call - leaves it as old as the last good tick, so a
 * load last read 75 s from close keeps retrying at pollFarMs: faults at T-45 s, T-15 s, T+15 s, and
 * the "bid it by hand" hand-off lands after the close.
 *
 * What is pinned:
 *   - last good read 75 s from close, fault 40 s later: the retry is pollMidMs (35 s left), not
 *     pollFarMs (check 1);
 *   - a run of faults from T-45 s, each planted timer fired after its own delay: the third fault's
 *     hand-off happens before the load closes (check 2);
 *   - control: with no close known at all, the last reading (5 min) still decides - pollFarMs (check 3).
 *
 * Offline and deterministic: fake adapter, temp-file scheduler under os.tmpdir(), rand pinned, no
 * network, no sleeps. setTimeout/clearTimeout are faked and record each delay; Date.now is frozen and
 * advanced by hand. Both are restored at the end.
 *
 *   node scripts/test-tick-fault-retry-uses-close-time.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-close-time-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const realNow = Date.now;
let clock = realNow();
const freezeClock = () => { Date.now = () => clock; };
const advance = (ms) => { clock += ms; };

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
const restore = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; Date.now = realNow; };

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
const mkLoad = (id, closesAt) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: Date.now() - 1000, closesAt,
});

const CFG = { openAtMs: 1_000, floorWindowMs: 500, minInterFireMs: 0, finalizeDebounceMs: 0,
  pollFarMs: 30_000, pollMidMs: 1_000, pollHotMs: 200, farThresholdMs: 60_000, hotThresholdMs: 10_000,
  cadenceJitterMs: 0 };

// Arms a load, runs one healthy tick that reads `readingMs` to close, then makes every later
// _checkDelisted throw while `faulting` is set. Installed after arm(): arm() calls _checkDelisted itself.
function armWithOneGoodRead(id, closesAt, readingMs) {
  pending.clear();
  const events = [];
  const eng = new BidEngine({
    writeEnabled: true, capabilities: CAPS, ensureSession: async () => ({}),
    getAuctionState: async () => liveState(readingMs),
    placeBid: async () => ({ accepted: false, reason: 'refused' }),
  }, new DurableScheduler(tmp()), {
    config: CFG, live: true, onEvent: (e) => events.push({ ...e, at: Date.now() }), log: quiet, rand: () => 0,
  });
  const mon = eng.arm(mkLoad(id, closesAt), INPUTS);
  setup(mon && pending.size === 1, `arm() must plant exactly one tick timer for ${id}`);
  const ctl = { eng, mon, events, faulting: false, faults: [] };
  const original = eng._checkDelisted.bind(eng);
  eng._checkDelisted = (m) => {
    if (ctl.faulting) { ctl.faults.push(Date.now()); throw new Error(`injected tick fault on ${id}`); }
    return original(m);
  };
  return ctl;
}

async function goodTick(ctl, readingMs) {
  await step();
  setup(ctl.mon.closesInMs === readingMs,
    `the healthy tick must record closesInMs ${readingMs} (got ${ctl.mon.closesInMs})`);
  setup(pending.size === 1, `the healthy tick must plant exactly one next tick (got ${pending.size})`);
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
  freezeClock();
  fakeTimers();

  await check(1, 'a fault 35 s before close, 40 s after a far reading, is re-checked at pollMidMs', async () => {
    // Arrange
    const closesAt = Date.now() + 75_000;
    const ctl = armWithOneGoodRead('CLOSE-mid', closesAt, 75_000);
    await goodTick(ctl, 75_000);
    advance(40_000);
    // Act
    ctl.faulting = true;
    await step();
    setup(ctl.faults.length === 1 && ctl.mon._tickFaults === 1, `exactly one contained fault (got ${ctl.mon._tickFaults})`);
    const ms = pendingMs();
    ctl.eng.kill('done');
    pending.clear();
    // Assert
    assert.deepStrictEqual(ms, [CFG.pollMidMs],
      `a fault ${closesAt - ctl.faults[0]} ms before close must be retried at pollMidMs (${CFG.pollMidMs} ms); `
      + `_tickFaulted planted ${JSON.stringify(ms)} - it sized the retry off monitor.closesInMs, the 75 s `
      + 'reading of the last good tick, instead of the time left to believedCloseAt / meta.closesAt');
  });

  await check(2, 'a run of faults from T-45 s hands the load to the desk before it closes', async () => {
    // Arrange
    const closesAt = Date.now() + 75_000;
    const ctl = armWithOneGoodRead('CLOSE-handoff', closesAt, 75_000);
    await goodTick(ctl, 75_000);
    advance(30_000);
    ctl.faulting = true;
    // Act
    await step();
    for (let i = 0; i < 10 && pending.size && !ctl.events.some((e) => e.kind === 'tick_fault_handoff'); i++) {
      setup(pending.size === 1, `one retry timer per fault (got ${pending.size})`);
      advance([...pending][0].ms);
      await step();
    }
    ctl.eng.kill('done');
    pending.clear();
    // Assert
    const handoff = ctl.events.find((e) => e.kind === 'tick_fault_handoff');
    setup(handoff, `the third fault must hand the load off (faults ${ctl.faults.length})`);
    const faultsToClose = ctl.faults.map((t) => `T${t - closesAt >= 0 ? '+' : ''}${(t - closesAt) / 1000}s`);
    assert.ok(handoff.at < closesAt,
      `the desk hand-off came at T+${(handoff.at - closesAt) / 1000}s, after the load closed (faults at `
      + `${faultsToClose.join(', ')}): each retry was sized off the stale 75 s monitor.closesInMs, so the `
      + 'run kept the pollFarMs stride all the way past the close');
  });

  await check(3, 'control: with no close known, the last reading decides the retry (pollFarMs)', async () => {
    // Arrange
    const ctl = armWithOneGoodRead('CLOSE-unknown', null, 300_000);
    setup(ctl.mon.believedCloseAt == null && ctl.mon.meta.closesAt == null, 'the monitor must carry no close time');
    await goodTick(ctl, 300_000);
    advance(40_000);
    // Act
    ctl.faulting = true;
    await step();
    setup(ctl.faults.length === 1 && ctl.mon._tickFaults === 1, `exactly one contained fault (got ${ctl.mon._tickFaults})`);
    const ms = pendingMs();
    ctl.eng.kill('done');
    pending.clear();
    // Assert
    assert.deepStrictEqual(ms, [CFG.pollFarMs],
      `with no close known the retry must fall back to the last reading (300 s) and plant pollFarMs `
      + `(${CFG.pollFarMs} ms); _tickFaulted planted ${JSON.stringify(ms)}`);
  });

  restore();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/3 passed) - _tickFaulted sizes the retry off `
      + 'monitor.closesInMs, which a fault before the platform read leaves stale, instead of the known close');
    process.exit(1);
  }
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS ${pass}/${EXPECTED} checks passed`);
})().catch((e) => { restore(); cleanup(); console.error(e); process.exit(1); });
