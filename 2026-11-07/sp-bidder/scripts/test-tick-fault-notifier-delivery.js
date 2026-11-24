'use strict';
/**
 * TICK-FAULT DELIVERY - the tick-fault alert and the three-fault hand-off reach the right people, once
 * per episode, through the real notifier.
 *
 * Regression target: owner ruling OQ-1 (2026-09-24), fixed in a72dc89.
 *   sibling: scripts/test-tick-fault-handoff.js (the engine side and the pure toNotification mapping)
 *
 * The sibling stops at toNotification, but the ruling is only kept if a message actually arrives, and
 * that depends on keys and routing it cannot see:
 *   - engineAlerts  tick_fault          dedupeKey `<id>_error_tick_fault_<faultSince>`
 *   - engineAlerts  tick_fault_handoff  dedupeKey `<id>_notice_tick_fault_handoff_<faultSince>`
 *   - notifyEngineEvent mirrors the hand-off to ops as an 'error' with dedupeKey `<noticeKey>_ops` and
 *     no scope keys, so it reaches the unscoped ops DM and not the customer group;
 *   - Notifier drops any dedupeKey it has already sent (persisted notifSent mark + in-flight set), and
 *     a scoped group that matches a message becomes its only channel.
 * A key without faultSince swallows every later episode or hand-off on the same load; a mirror that
 * reuses the notice key is dropped as a duplicate; a mirror that carries the scope keys lands in the
 * customer group and suppresses the ops DM.
 *
 * Chain under test: real BidEngine events -> notifyEngineEvent -> real Notifier over a MemoryStore ->
 * real WhatsAppClient over a capturing transport. The customer group subscribes to BOTH desk_notice and
 * error, the only configuration where a scope leak on the ops mirror is observable.
 *
 * WHAT MUST NOT MOVE:
 *   - a healthy tick ends an episode; the next fault alerts ops again (check 1);
 *   - the hand-off reaches the customer group once and ops once, on separate keys (checks 2, 3);
 *   - a re-armed load that faults out again is handed off again (check 4);
 *   - a healthy monitor sends nothing (check 5, control).
 *
 * Offline and deterministic: fake adapter that refuses every write, temp-file scheduler under
 * os.tmpdir(), no network, no sleeps. Engine timers are faked and fired by hand. Date.now is frozen
 * and advanced per step because faultSince has millisecond resolution: two episodes in one ms would
 * share a key.
 *
 *   node scripts/test-tick-fault-notifier-delivery.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `tick-fault-notifier-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
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
const ID = '26100001';
const LIVE_STATE = { ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
const INPUTS = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const mkLoad = () => ({
  id: ID, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Bhiwandi', status: 'live', softClose: false,
  startsAt: now - 1000, closesAt: now + LIVE_STATE.closesInMs,
});

// plan: one entry per tick, 'F' = throw past _tick's try blocks, anything else = a normal tick.
function mkRig() {
  pending.clear();
  const sends = [];
  const transport = async (url, opts) => {
    sends.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const recipients = [
    { name: 'Waaree group', phone: GROUP, alerts: ['desk_notice', 'error'], scope: { shippers: ['Waaree'] } },
    { name: 'Ops', phone: OPS, alerts: ['error'] },
  ];
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => recipients, healthProvider: async () => true });

  const events = [];
  const adapter = {
    writeEnabled: true, reads: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => { adapter.reads += 1; return Object.assign({}, LIVE_STATE, { closesAtMs: now + LIVE_STATE.closesInMs }); },
    placeBid: async () => ({ accepted: false, reason: 'test refuses every write' }),
  };
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    live: true, onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
  });

  const rig = { eng, adapter, events, sends, plan: [], ticks: 0, faults: 0, routed: 0 };
  const original = eng._checkDelisted.bind(eng);
  eng._checkDelisted = (m) => {
    rig.ticks += 1;
    if (rig.plan.shift() === 'F') { rig.faults += 1; throw new Error(`injected tick fault #${rig.faults}`); }
    return original(m);
  };
  rig.route = async () => { while (rig.routed < events.length) await notifyEngineEvent(notifier, events[rig.routed++]); };
  // arm() itself calls _checkDelisted, so the plan must be empty here and the count restarts after.
  rig.arm = async () => {
    setup(rig.plan.length === 0, 'arm() would consume a planned tick fault');
    const mon = eng.arm(mkLoad(), INPUTS);
    rig.ticks = 0;
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
  rig.toGroup = () => sends.filter((s) => String(s.to_number) === GROUP);
  rig.toOps = () => sends.filter((s) => String(s.to_number).includes('9000000001'));
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
  const r = mkRig();
  await r.arm();

  await check(1, 'a fault, a healthy tick, then a later fault: ops is alerted for BOTH episodes', async () => {
    r.plan.push('F', 'OK');
    await r.step();
    await r.step();
    setup(r.faults === 1 && r.ticks === 2, `episode 1 must be one fault then one healthy tick (faults=${r.faults}, ticks=${r.ticks})`);
    setup(r.adapter.reads === 1, 'the healthy tick must read the platform');
    r.plan.push('F', 'F', 'F');
    await r.step(60_000);
    setup(r.faults === 2, 'the first tick of episode 2 must reach the injected fault');
    assert.strictEqual(r.toOps().length, 2,
      `ops received ${r.toOps().length} tick-fault message(s) across two fault episodes on load ${ID}; `
      + 'expected 2. Either the engine alerted only the monitor\'s first episode, or the tick_fault '
      + 'dedupeKey dropped faultSince so the notifier swallowed episode 2 as a duplicate of episode 1');
    assert.strictEqual(r.toGroup().length, 0, 'a contained fault is not a customer-group message');
  });

  await check(2, 'three consecutive faults: the customer group receives the hand-off once, naming the load', async () => {
    const opsBefore = r.toOps().length;
    r.opsBeforeHandoff = opsBefore;
    await r.step();
    await r.step();
    setup(r.faults === 4 && r.handoffs().length === 1, `the engine must emit one hand-off after three consecutive faults (faults=${r.faults}, hand-offs=${r.handoffs().length})`);
    assert.strictEqual(r.toGroup().length, 1,
      `the customer group received ${r.toGroup().length} message(s) for one hand-off; expected exactly 1. `
      + 'A second message is the ops error mirror carrying the shipper scope keys, so the scoped group '
      + 'matched it');
    assert.ok((r.toGroup()[0].message || '').includes(ID), `the hand-off in the group names load ${ID}`);
  });

  await check(3, 'the hand-off is mirrored to ops on the error channel, and the mirror names the load', async () => {
    const mirrors = r.toOps().slice(r.opsBeforeHandoff);
    assert.strictEqual(mirrors.length, 1,
      `ops received ${mirrors.length} message(s) for the hand-off; expected the 1 error mirror. Missing = the `
      + 'mirror is disabled, reuses the desk notice dedupeKey (dropped as already sent), or carries scope '
      + 'keys (routed to the scoped group, which suppresses the ops DM)');
    assert.ok((mirrors[0].message || '').includes(ID), `the ops mirror names load ${ID}`);
  });

  await check(4, 'a re-priced load that faults out again is handed to the group a second time', async () => {
    await r.arm();
    r.plan.push('F', 'F', 'F');
    await r.step(120_000);
    await r.step();
    await r.step();
    setup(r.handoffs().length === 2, `the re-armed load must be handed off again (hand-offs=${r.handoffs().length})`);
    assert.strictEqual(r.toGroup().length, 2,
      `the customer group received ${r.toGroup().length} hand-off message(s) across two hand-offs on load ${ID}; `
      + 'expected 2. Fewer = the hand-off notice key dropped faultSince, so the second was swallowed as a '
      + 'duplicate; more = the ops mirror reached the group (check 2)');
    assert.ok((r.toGroup()[1].message || '').includes(ID), `the second hand-off names load ${ID}`);
  });

  r.eng.kill('done');

  await check(5, 'control: a healthy monitor sends nothing to either recipient', async () => {
    const c = mkRig();
    await c.arm();
    await c.step();
    await c.step();
    await c.step();
    setup(c.ticks === 3 && c.faults === 0 && c.adapter.reads === 3, `the control monitor must tick healthily 3 times (ticks=${c.ticks}, reads=${c.adapter.reads})`);
    assert.deepStrictEqual(c.sends.map((s) => s.to_number), [], 'a healthy monitor sends no message');
    c.eng.kill('done');
  });

  pending.clear();
  realClock();
  cleanup();
  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/5 passed) - tick-fault delivery through the notifier is broken`);
    process.exit(1);
  }
  const EXPECTED = 5;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { realClock(); cleanup(); console.error(e); process.exit(1); });
