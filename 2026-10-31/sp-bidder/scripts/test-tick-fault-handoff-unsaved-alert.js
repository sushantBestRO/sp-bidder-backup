'use strict';
/**
 * TICK-FAULT HAND-OFF UNSAVED - when the three-fault hand-off cannot be saved, ops is told, every time,
 * through the real notifier.
 *
 * Regression target: review finding on the tick-fault hand-off (branch fix/timer-lifecycle-orphans,
 * head fca118e).
 *   sibling: scripts/test-tick-fault-notifier-delivery.js (the hand-off and tick-fault delivery)
 *
 * _handTickFaultToDesk stops the monitor and saves the intent as 'stopped'. If that save throws, the
 * intent stays active on disk and a restart re-arms a load the desk is now bidding by hand, so ops gets
 * a "could not save" warning. That warning rode on kind tick_error, whose notifier dedupeKey
 * `<id>_error_tick_error` is per load and permanent (persisted notifSent mark) and is shared with the
 * generic tick_error catch in _maybeBid. Any earlier tick_error on the load, or an earlier unsaved
 * hand-off, swallowed the warning as a duplicate.
 *
 * Chain under test: real BidEngine events -> notifyEngineEvent -> real Notifier over a MemoryStore ->
 * real WhatsAppClient over a capturing transport. Ops is an unscoped DM subscribed to 'error'; the
 * customer group subscribes to desk_notice only.
 *
 * WHAT MUST NOT MOVE:
 *   - a load that already alerted a tick_error still warns ops when its hand-off cannot be saved, and
 *     the hand-off itself still reaches the group (check 1);
 *   - a re-armed load that faults out again with the save still failing warns ops again (check 2);
 *   - a hand-off that saves sends no warning (check 3, control).
 *
 * Offline and deterministic: fake adapter that refuses every write, temp-file scheduler under
 * os.tmpdir() whose 'stopped' save is made to throw, no network, no sleeps. Engine timers are faked
 * and fired by hand; Date.now is frozen and advanced per step so the two fault runs start in
 * different milliseconds.
 *
 *   node scripts/test-tick-fault-handoff-unsaved-alert.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp scheduler store), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

let pass = 0;
const failures = [];
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-unsaved-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const realDateNow = Date.now;
let now = 1_790_000_000_000;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const pending = new Set();
const fakeClock = () => {
  Date.now = () => now;
  global.setTimeout = (fn, ms, ...args) => {
    const h = { fn, ms, args, unref() { return h; }, ref() { return h; }, hasRef() { return false; } };
    pending.add(h);
    return h;
  };
  global.clearTimeout = (h) => { if (pending.has(h)) pending.delete(h); else realClearTimeout(h); };
};
const realClock = () => { Date.now = realDateNow; global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

const GROUP = '120363222222222222@g.us';
const OPS = '+919000000001';
const ID = '26100002';
const WARNING = 'could not save';
const LIVE_STATE = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const mkLoad = () => ({
  id: ID, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: now - 1000, closesAt: now + LIVE_STATE.closesInMs,
});

function mkRig({ failStoppedSave }) {
  pending.clear();
  const sends = [];
  const transport = async (url, opts) => {
    sends.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const recipients = [
    { name: 'Waaree group', phone: GROUP, alerts: ['desk_notice'], scope: { shippers: ['Waaree'] } },
    { name: 'Ops', phone: OPS, alerts: ['error'] },
  ];
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => recipients, healthProvider: async () => true });

  const scheduler = new DurableScheduler(tmp());
  const update = scheduler.update.bind(scheduler);
  let stoppedSaveAttempts = 0;
  scheduler.update = (id, patch) => {
    if (patch && patch.status === 'stopped') {
      stoppedSaveAttempts += 1;
      if (failStoppedSave) throw new Error('injected: disk full while saving the hand-off');
    }
    return update(id, patch);
  };

  const events = [];
  const adapter = {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => Object.assign({}, LIVE_STATE, { closesAtMs: now + LIVE_STATE.closesInMs }),
    placeBid: async () => ({ accepted: false, reason: 'test refuses every write' }),
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
  });

  const rig = { eng, events, sends, plan: [], faults: 0, routed: 0, saves: () => stoppedSaveAttempts };
  const original = eng._checkDelisted.bind(eng);
  eng._checkDelisted = (m) => {
    if (rig.plan.shift() === 'F') { rig.faults += 1; throw new Error(`injected tick fault #${rig.faults}`); }
    return original(m);
  };
  rig.route = async () => { while (rig.routed < events.length) await notifyEngineEvent(notifier, events[rig.routed++]); };
  // arm() itself calls _checkDelisted, so the plan must be empty here.
  rig.arm = async () => {
    setup(rig.plan.length === 0, 'arm() would consume a planned tick fault');
    const mon = eng.arm(mkLoad(), INPUTS);
    setup(mon && pending.size === 1, `arm() must plant exactly one tick timer for ${ID}`);
    await rig.route();
  };
  rig.step = async (advanceMs = 1_000) => {
    now += advanceMs;
    const due = [...pending];
    pending.clear();
    for (const h of due) h.fn(...h.args);
    await settle();
    await rig.route();
  };
  rig.faultOut = async (advanceMs) => {
    rig.plan.push('F', 'F', 'F');
    await rig.step(advanceMs);
    await rig.step();
    await rig.step();
  };
  rig.toGroup = () => sends.filter((s) => String(s.to_number) === GROUP);
  rig.warnings = () => sends.filter((s) => String(s.to_number).includes('9000000001')
    && (s.message || '').includes(WARNING));
  rig.handoffs = () => events.filter((e) => e.kind === 'tick_fault_handoff');
  return rig;
}

async function check(n, name, fn) {
  try {
    await fn();
    console.log(`  ok  ${n}. ${name}`);
    pass += 1;
  } catch (e) {
    if (e instanceof SetupError) throw e;
    console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
    failures.push(n);
  }
}

(async () => {
  fakeClock();
  const r = mkRig({ failStoppedSave: true });
  await r.arm();

  await check(1, 'a load that already alerted a tick_error still warns ops when its hand-off cannot be saved', async () => {
    // The exact event _maybeBid's generic catch emits.
    r.eng.emit({ type: 'alert', level: 'error', kind: 'tick_error', auctionId: ID, detail: 'injected bid-path fault' });
    await r.route();
    const opsBefore = r.sends.filter((s) => String(s.to_number).includes('9000000001')).length;
    setup(opsBefore === 1, `the earlier tick_error must have reached ops (ops messages=${opsBefore})`);
    await r.faultOut(1_000);
    setup(r.faults === 3 && r.handoffs().length === 1 && r.saves() === 1,
      `three faults must hand off once and attempt the 'stopped' save once (faults=${r.faults}, hand-offs=${r.handoffs().length}, saves=${r.saves()})`);
    assert.strictEqual(r.warnings().length, 1,
      `ops received ${r.warnings().length} "${WARNING}" warning(s) for an unsaved hand-off on load ${ID}; `
      + 'expected 1. The warning shares its dedupeKey with the earlier tick_error on this load, so the '
      + 'notifier dropped it as already sent');
    assert.ok((r.warnings()[0].message || '').includes(ID), `the warning names load ${ID}`);
    assert.strictEqual(r.toGroup().length, 1, 'the hand-off still reaches the customer group');
  });

  await check(2, 'a re-armed load that faults out again with the save still failing warns ops a second time', async () => {
    const warnedBefore = r.warnings().length;
    await r.arm();
    await r.faultOut(120_000);
    setup(r.handoffs().length === 2 && r.saves() === 2,
      `the re-armed load must be handed off again with the save failing (hand-offs=${r.handoffs().length}, saves=${r.saves()})`);
    const added = r.warnings().length - warnedBefore;
    assert.strictEqual(added, 1,
      `ops received ${added} "${WARNING}" warning(s) for the second unsaved hand-off on load ${ID}; `
      + 'expected 1. The warning dedupeKey is per load, not per fault run, so the notifier dropped it as '
      + 'already sent');
    assert.strictEqual(r.toGroup().length, 2, 'the second hand-off reaches the customer group');
  });

  r.eng.kill('done');

  await check(3, 'control: a hand-off that saves sends no warning', async () => {
    const c = mkRig({ failStoppedSave: false });
    await c.arm();
    await c.faultOut(1_000);
    setup(c.handoffs().length === 1 && c.saves() === 1,
      `the control load must be handed off with one 'stopped' save (hand-offs=${c.handoffs().length}, saves=${c.saves()})`);
    assert.strictEqual(c.warnings().length, 0, 'a saved hand-off sends no "could not save" warning');
    assert.strictEqual(c.toGroup().length, 1, 'the saved hand-off reaches the customer group');
    c.eng.kill('done');
  });

  pending.clear();
  realClock();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/3 passed) - the unsaved-hand-off warning is deduped away by the notifier`);
    process.exit(1);
  }
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { realClock(); cleanup(); console.error(e); process.exit(1); });
