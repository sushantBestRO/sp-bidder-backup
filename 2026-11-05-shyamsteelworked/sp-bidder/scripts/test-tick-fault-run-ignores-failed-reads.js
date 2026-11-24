'use strict';
/**
 * A FAILED PLATFORM READ DOES NOT END A RUN OF TICK FAULTS.
 *
 * Regression target: the tick-fault hand-off ruling - a contained tick fault keeps the load watched
 * and alerts once per run of faults; the third fault in a run hands the load to the desk.
 *   sibling: scripts/test-tick-fault-handoff.js (three faults back to back, and a healthy tick resets)
 *
 * bidEngine.js  _runTick:  await this._tick(monitor); monitor._tickFaults = 0;
 *
 * _tick resolves normally on a FAILED read: the !state.ok branch reschedules and returns. A GoComet
 * 429 cooldown and a SuperProcure read that is not yet answering both come back ok:false. So on a
 * portal that is failing reads, fault / failed read / fault / failed read / fault reset the count
 * after every fault: it never reached 3, the load was never handed to the desk, and each fault
 * opened a new run with its own faultSince and dedupe key, so the desk got a fresh "still watching"
 * error every time.
 *
 * Pinned: a tick whose read failed neither counts as a fault nor ends the run; only a tick whose read
 * succeeded does (check 2 keeps that reset). Check 3 is the control: failed reads alone raise no
 * tick fault and hand nothing off.
 *
 * Fault site: _checkDelisted, stubbed on the instance after arm() (arm() calls it itself). It is the
 * first call in _tick and sits outside every try block, so a stubbed throw is a throw past _tick's
 * handlers and happens before the read.
 *
 * Offline and deterministic: fake adapter, temp-file scheduler under os.tmpdir(), rand pinned, no
 * network, no sleeps. setTimeout/clearTimeout are faked so each planted tick is fired by hand.
 * startsAt is well in the past, so every failed read is an ordinary failure, not the pre-open gap.
 *
 *   node scripts/test-tick-fault-run-ignores-failed-reads.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-run-reads-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
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
};

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

const LIVE_STATE = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
const FAILED_READ = { ok: false, error: 'read failed' };
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const mkLoad = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: Date.now() - 10 * 60_000, closesAt: Date.now() + LIVE_STATE.closesInMs,
});

// plan: one entry per tick. 'F' = throw past _tick's handlers, 'X' = the read fails, 'R' = a good read.
function armWithPlan(id, plan) {
  pending.clear();
  const events = [];
  const h = { id, events, ticks: 0, failedReads: 0, goodReads: 0 };
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      if (plan[h.ticks - 1] === 'X') { h.failedReads += 1; return FAILED_READ; }
      h.goodReads += 1;
      return LIVE_STATE;
    },
    placeBid: async () => ({ accepted: true, myRank: 1 }),
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  h.eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
  });
  const mon = h.eng.arm(mkLoad(id), INPUTS);
  setup(mon && pending.size === 1, `arm() must plant exactly one tick timer for ${id}`);
  const original = h.eng._checkDelisted.bind(h.eng);
  h.eng._checkDelisted = (m) => {
    h.ticks += 1;
    if (plan[h.ticks - 1] === 'F') throw new Error(`injected tick fault #${h.ticks}`);
    return original(m);
  };
  return h;
}

const ofKind = (h, kind) => h.events.filter((e) => e.type === 'alert' && e.auctionId === h.id && e.kind === kind);
const watched = (h) => h.eng.monitors.has(h.id) && !h.eng.monitors.get(h.id).finalized;

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

  await check(1, 'fault, failed read, fault, failed read, fault: handed to the desk, one fault alert', async () => {
    const h = armWithPlan('RUN-alternating', ['F', 'X', 'F', 'X', 'F']);
    for (let i = 0; i < 5; i++) await step();
    setup(h.ticks === 5, `all five planned ticks must run (${h.ticks} ran)`);
    setup(h.failedReads === 2 && h.goodReads === 0, 'ticks 2 and 4 must be failed reads and nothing else read');
    const handoffs = ofKind(h, 'tick_fault_handoff');
    assert.strictEqual(handoffs.length, 1,
      `the third fault in the run must hand the load to the desk (got ${handoffs.length} hand-off(s)). `
      + '_runTick reset the fault count whenever _tick resolved, and _tick resolves normally on a failed '
      + 'read, so each failed read between faults ended the run and the count never reached 3');
    assert.ok(!h.eng.monitors.has(h.id), 'after the hand-off the load is no longer in engine.monitors');
    const faults = ofKind(h, 'tick_fault');
    assert.strictEqual(faults.length, 1,
      `one run of faults alerts once (got ${faults.length} tick_fault alerts): a failed read must not open `
      + 'a new run with a new faultSince and dedupe key');
  });

  await check(2, 'fault, fault, good read, fault, fault: the good read resets the run, still watched', async () => {
    const h = armWithPlan('RUN-reset', ['F', 'F', 'R', 'F', 'F']);
    for (let i = 0; i < 5; i++) await step();
    setup(h.ticks === 5, `all five planned ticks must run (${h.ticks} ran)`);
    setup(h.goodReads === 1, 'tick 3 must be a good read');
    assert.strictEqual(ofKind(h, 'tick_fault_handoff').length, 0,
      'a tick whose read succeeded ends the run, so two more faults must not hand the load off');
    assert.ok(watched(h) && pending.size === 1, 'the load is still watched with its next tick planted');
    h.eng.kill('done');
  });

  await check(3, 'control: failed reads alone raise no tick fault and hand nothing off', async () => {
    const h = armWithPlan('RUN-control', ['X', 'X', 'X', 'X']);
    for (let i = 0; i < 4; i++) await step();
    setup(h.ticks === 4 && h.failedReads === 4, 'four ticks, each a failed read');
    assert.strictEqual(ofKind(h, 'tick_fault').length, 0, 'a failed read is not a tick fault');
    assert.strictEqual(ofKind(h, 'tick_fault_handoff').length, 0, 'and hands nothing off');
    assert.ok(watched(h) && pending.size === 1, 'the load is still watched with its next tick planted');
    h.eng.kill('done');
  });

  realTimers();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/3 passed) - a failed platform read `
      + 'must neither count as a tick fault nor end a run of them');
    process.exit(1);
  }
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS ${pass}/${EXPECTED} checks passed`);
})().catch((e) => { realTimers(); cleanup(); console.error(e); process.exit(1); });
