'use strict';
/**
 * THE TICK-FAULT HAND-OFF - a contained tick fault keeps the load watched; three in a row hand it
 * to the desk.
 *
 * Regression target: owner ruling OQ-1 (2026-09-24), cluster W1-5 (T7 E2 / T7 E10 + the T2 D6 seam).
 *   docs/bug-hunts/2026-09-20_bid-command-WAVE-EXECUTION-PLAN.md section 9 ruling 9, row W1-5
 *   docs/bug-hunts/2026-09-20_wave1-red-board.md "Decisions waiting on Sid" (OQ-1)
 *   sibling: scripts/test-tick-seam-contains-escapes.js (the seam contains ONE throw and alerts once)
 *
 * bidEngine.js  _schedule:  monitor.timer = setTimeout(() => this._tick(monitor), delayMs);
 *
 * _tick is async and that promise is dropped. A throw from any region of _tick outside its two try
 * blocks rejects it, the rejection leaves the engine, and because the throw happened before the
 * tail's own _schedule call, NO NEXT TICK IS PLANTED. The monitor stays in engine.monitors and the
 * intent stays active on disk, so the console shows the load as watched while nothing polls it - a
 * zombie, and the desk is never told.
 *
 * The ruling this file pins, as owner-stated:
 *   - one contained fault: the load KEEPS being watched (the next tick really runs) and the desk is
 *     alerted ONCE;
 *   - three CONSECUTIVE contained faults on one monitor: the load stops being watched and the desk is
 *     told to bid it by hand;
 *   - both messages must reach the desk. A log line alone is a defect (the price-page gate).
 *
 * Fault site: _checkDelisted, stubbed on the instance. It is the first call in _tick after the
 * finalized/killed guard and sits outside every try block, so a stubbed throw there is a throw past
 * _tick's try blocks, and the stub's call count is exactly "ticks that ran".
 *
 * NO ALERT KIND IS PINNED BY NAME, and no copy is pinned (the desk copy is written later and shown to
 * the owner). What is pinned is ROUTING: every alert counted here is one engineAlerts.toNotification
 * turns into an 'error' or 'desk_notice' message, and the hand-off kind must be a member of
 * ERROR_KINDS or DESK_NOTICE_KINDS. The hand-off must also carry a notifier dedupe key different from
 * the first fault alert's, because the notifier drops a repeated key: re-emitting tick_error for the
 * hand-off would be swallowed as a duplicate of the first alert and reach nobody.
 *
 * WHAT MUST NOT MOVE:
 *   - one contained fault leaves the durable intent armed (the sibling's check 4 pins the same thing);
 *   - the counter is CONSECUTIVE: a successful tick in between resets it (check 4);
 *   - a healthy monitor ticks, places its one establishing bid and raises nothing (check 5, control).
 *
 * Offline and deterministic: fake adapter, temp-file scheduler under os.tmpdir(), rand pinned, no
 * network, no sleeps. setTimeout/clearTimeout are faked while the engine runs so each tick is fired by
 * hand, whatever retry delay the fix picks; settling uses setImmediate turns only.
 *
 *   node scripts/test-tick-fault-handoff.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp scheduler store), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification, ERROR_KINDS, DESK_NOTICE_KINDS } = require('../src/notify/engineAlerts');

let pass = 0;
const failures = [];
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-handoff-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
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

const rejections = [];
process.on('unhandledRejection', (reason) => rejections.push(reason));

const LIVE_STATE = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const mkLoad = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: Date.now() - 1000, closesAt: Date.now() + LIVE_STATE.closesInMs,
});

function mkEngine() {
  const events = [];
  const adapter = {
    writeEnabled: true, placed: [], reads: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => { adapter.reads += 1; return LIVE_STATE; },
    placeBid: async (id, price) => { adapter.placed.push(price); return { accepted: true, myRank: 1 }; },
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
  });
  return { eng, adapter, events };
}

// plan: one entry per tick, 'F' = throw past _tick's try blocks, anything else = a normal tick.
function armWithFaults(id, plan) {
  pending.clear();
  const h = mkEngine();
  const mon = h.eng.arm(mkLoad(id), INPUTS);
  setup(mon && pending.size === 1, `arm() must plant exactly one tick timer for ${id}`);
  setup(h.eng.scheduler.get(id).status === 'armed', `the ${id} intent must be armed on disk`);
  const original = h.eng._checkDelisted.bind(h.eng);
  h.ticks = 0;
  h.eng._checkDelisted = (m) => {
    h.ticks += 1;
    if (plan[h.ticks - 1] === 'F') throw new Error(`injected tick fault #${h.ticks}`);
    return original(m);
  };
  h.id = id;
  h.mon = mon;
  return h;
}

const deskAlerts = (events, id) => events.filter((e) => {
  if (e.type !== 'alert' || e.auctionId !== id) return false;
  const n = toNotification(e);
  return !!n && (n.kind === 'error' || n.kind === 'desk_notice');
});
const watched = (h) => h.eng.monitors.has(h.id) && !h.eng.monitors.get(h.id).finalized;
const intentActive = (h) => h.eng.scheduler.activeIntents().some((i) => i.auctionId === h.id);
const escaped = () => (rejections.length
  ? ` [${rejections.length} unhandled rejection(s) escaped the tick timer, first: ${rejections[0] && rejections[0].message}]`
  : '');

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

  // ------------------------------------------- 1. one contained fault: still watched, alerted once
  await check(1, 'one contained fault: the load keeps being watched, the intent stays armed, the desk is alerted once', async () => {
    const h = armWithFaults('HANDOFF-one', ['F']);
    await step();
    setup(h.ticks === 1, 'the first tick must reach the injected fault');
    const planted = pending.size;
    assert.ok(planted >= 1 && watched(h),
      'after a contained tick fault the load must stay watched with its next tick planted. _schedule\'s '
      + 'setTimeout(() => this._tick(monitor)) drops the rejected promise, and the throw happened before '
      + `_tick's tail reschedule, so ${planted} timer(s) are pending while the monitor is still listed as `
      + `watched - a zombie nothing polls${escaped()}`);
    assert.strictEqual(h.eng.scheduler.get(h.id).status, 'armed', 'the durable intent stays armed after one fault');
    assert.strictEqual(deskAlerts(h.events, h.id).length, 1,
      'exactly one desk-routable alert (engineAlerts error or desk_notice) for this load after one fault');
    await step();
    assert.strictEqual(h.ticks, 2, 'firing the planted timer must run the next tick');
    assert.strictEqual(h.adapter.reads, 1, 'and that tick reads the platform - it is a real tick, not a no-op');
    assert.ok(watched(h) && intentActive(h), 'a healthy tick after the fault leaves the load watched');
    assert.strictEqual(deskAlerts(h.events, h.id).length, 1, 'the healthy tick raises nothing further');
    h.eng.kill('done');
  });

  // ------------------------------------------- 2 + 3. consecutive faults on one monitor
  const h3 = armWithFaults('HANDOFF-three', ['F', 'F', 'F']);
  let firstAlert = null;

  await check(2, 'two consecutive faults: still watched, still exactly one desk alert', async () => {
    await step();
    setup(h3.ticks === 1, 'the first tick must reach the injected fault');
    await step();
    assert.strictEqual(h3.ticks, 2,
      `the second tick never ran (${h3.ticks} tick(s)): the first fault escaped the seam and planted no `
      + `next tick${escaped()}`);
    assert.ok(watched(h3) && intentActive(h3) && pending.size >= 1,
      'after two consecutive faults the load is still watched with a tick planted');
    const alerts = deskAlerts(h3.events, h3.id);
    assert.strictEqual(alerts.length, 1, `the desk is alerted once, not per fault (got ${alerts.length})`);
    firstAlert = alerts[0];
  });

  await check(3, 'three consecutive faults: retired, no further tick, intent inactive, routed hand-off notice', async () => {
    await step();
    assert.strictEqual(h3.ticks, 3,
      `the third tick never ran (${h3.ticks} tick(s)): the fault escaped the seam and planted no next tick${escaped()}`);
    const alerts = deskAlerts(h3.events, h3.id);
    const first = firstAlert || alerts[0];
    const handoff = alerts.filter((e) => e !== first);
    assert.strictEqual(handoff.length, 1,
      `the third consecutive fault must emit exactly one desk-routable hand-off notice (got ${handoff.length}); `
      + 'a log line alone does not reach the desk');
    const kind = handoff[0].kind;
    assert.ok(ERROR_KINDS.has(kind) || DESK_NOTICE_KINDS.has(kind),
      `the hand-off kind ${JSON.stringify(kind)} must be registered in engineAlerts ERROR_KINDS or `
      + 'DESK_NOTICE_KINDS, or it routes nowhere');
    assert.notStrictEqual(toNotification(handoff[0]).dedupeKey, toNotification(first).dedupeKey,
      'the hand-off must not share the first alert\'s notifier dedupe key, or the notifier swallows it');
    assert.ok(!watched(h3), 'after three consecutive faults the monitor is retired');
    assert.ok(!intentActive(h3),
      'and the durable intent drops out of activeIntents(), so a restart does not re-arm a load the desk is bidding by hand');
    const ticksAtHandoff = h3.ticks;
    await step();
    await step();
    assert.strictEqual(h3.ticks, ticksAtHandoff, 'no further tick runs after the hand-off');
    assert.strictEqual(h3.adapter.reads, 0, 'and the platform is never read again for this load');
    h3.eng.kill('done');
  });

  // ------------------------------------------- 4. the counter is CONSECUTIVE
  await check(4, 'fault, fault, healthy tick, fault, fault: still watched, no hand-off', async () => {
    const h = armWithFaults('HANDOFF-reset', ['F', 'F', 'OK', 'F', 'F']);
    for (let i = 0; i < 5; i++) await step();
    assert.strictEqual(h.ticks, 5,
      `only ${h.ticks} of 5 ticks ran: a fault escaped the seam and planted no next tick${escaped()}`);
    assert.strictEqual(h.adapter.reads, 1, 'the third tick was a real, healthy tick');
    assert.ok(watched(h) && intentActive(h),
      'a healthy tick resets the count, so two more faults must not retire the load');
    const alerts = deskAlerts(h.events, h.id);
    assert.ok(alerts.length >= 1, 'the desk was alerted for the faults');
    assert.ok(alerts.every((e) => e.kind === alerts[0].kind),
      `no hand-off kind may be emitted, only fault alerts (kinds seen: ${JSON.stringify(alerts.map((e) => e.kind))})`);
    await step();
    assert.strictEqual(h.ticks, 6, 'and the load is still polled: the next tick runs');
    h.eng.kill('done');
  });

  // ------------------------------------------- 5. CONTROL: a monitor with no fault
  await check(5, 'control: a healthy monitor ticks, places its one establishing bid, raises nothing', async () => {
    const h = armWithFaults('HANDOFF-control', []);
    await step();
    assert.strictEqual(h.ticks, 1, 'the tick ran');
    assert.strictEqual(h.adapter.reads, 1, 'it read the platform');
    assert.strictEqual(h.adapter.placed.length, 1, 'it placed its one establishing bid');
    assert.ok(watched(h) && intentActive(h) && pending.size === 1, 'and rescheduled itself');
    assert.deepStrictEqual(deskAlerts(h.events, h.id), [], 'a healthy tick raises no desk alert');
    h.eng.kill('done');
  });

  realTimers();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/5 passed)`);
    process.exit(1);
  }
  const EXPECTED = 5;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { realTimers(); cleanup(); console.error(e); process.exit(1); });
