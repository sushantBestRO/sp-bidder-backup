'use strict';
/**
 * WRITE-FAULT ALERTS, COUNTED WHERE THE DESK RECEIVES THEM.
 *
 * Every engine event is routed through a real Notifier (MemoryStore, fake WhatsApp transport), and
 * the checks count error messages actually delivered to the desk - not engine events.
 *   1. A disk that alternates fail/ok on one load, with the notifier's dedupe store failing too,
 *      delivers at most one bid_record_failed message per re-alert window; after the window, one more.
 *   2. A second fault on a load, after the window, is delivered even though the first alert's dedupe
 *      mark persisted.
 *   3. Guard: a first alert dropped because the sender was down is delivered by the next failure
 *      once the window has elapsed.
 *   4. W1-1 V3-F01, ruling 59: a fault dropped at delivery is re-offered INSIDE the same window, once
 *      writeFailReofferMs has passed - it does not have to wait for the whole window to elapse.
 *   5. Flood guard: a disk that keeps failing every re-offer interval inside one window still delivers
 *      only once, even when the notifier's own persisted mark cannot land either.
 *
 *   node scripts/test-write-fault-alert-episode-delivery.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier, DEDUPE_COLLECTION } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'write-fault-episode-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

const WINDOW_MS = 10 * 60 * 1000;
const REMAINING_MS = 114 * 60 * 1000;
const DESK = '+919000000001';
const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const liveState = () => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: null, revisionLimit: 20,
  closeModel: 'hard', measuredRttMs: 50, minDecrement: 100,
});
const META = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });
const PRICING = { cost: 29_000, marginsPct: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], minMarginPct: 1 };
const CONFIG = { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, writeFailRealertMs: WINDOW_MS };
const CAPS = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
  revisionLimit: 20, closeModel: 'hard' });

function mkScheduler() {
  const file = path.join(DATA_DIR, `episode-intents-${process.pid}-${seq++}.json`);
  const s = new DurableScheduler(file);
  const realPersist = s._persist.bind(s);
  s.faulting = false;
  s.faultHits = 0;
  s._persist = () => {
    if (s.faulting) {
      s.faultHits++;
      const e = new Error(`EACCES: permission denied, open '${file}.tmp'`);
      e.code = 'EACCES';
      throw e;
    }
    return realPersist();
  };
  return s;
}

function mkStore(dedupeWritesFail) {
  const store = new MemoryStore();
  if (!dedupeWritesFail) return store;
  const fail = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const put = store.putDoc.bind(store);
  const remove = store.removeDoc.bind(store);
  store.putDoc = async (c, id, v) => { if (c === DEDUPE_COLLECTION) throw fail(); return put(c, id, v); };
  store.removeDoc = async (c, id) => { if (c === DEDUPE_COLLECTION) throw fail(); return remove(c, id); };
  return store;
}

function mkDesk(dedupeWritesFail) {
  const delivered = [];
  const transport = async (url, opts) => {
    if (/listPhones/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient(Object.assign({ enabled: true, transport }, CREDS));
  const realSend = wa.sendText.bind(wa);
  wa.sendText = async (to, message, o = {}) => {
    const res = await realSend(to, message, o);
    if (res && res.ok) delivered.push({ to, kind: o.kind, message });
    return res;
  };
  const desk = { senderUp: true, delivered };
  desk.notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: mkStore(dedupeWritesFail),
    recipientsProvider: async () => [{ name: 'Desk', phone: DESK, alerts: ['error'] }],
    healthProvider: async () => desk.senderUp });
  desk.errorsToDesk = () => delivered.filter((d) => d.kind === 'error' && String(d.to).replace(/\D/g, '') === DESK.replace(/\D/g, '')).length;
  return desk;
}

// Each step is one bid at clock offset `atMs`; `disk` is 'fail' or 'ok' for that bid's write;
// `senderUp` (default true) is the WhatsApp sender's health while that step's events are delivered.
async function run(steps, { dedupeWritesFail = false } = {}) {
  const id = 'EPISODE-1';
  const scheduler = mkScheduler();
  const desk = mkDesk(dedupeWritesFail);
  const events = [];
  let routed = 0;
  const perStep = [];
  let writeFailOffers = 0;
  let i = 0;
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}), getAuctionState: async () => liveState(),
    placeBid: async () => {
      scheduler.faulting = steps[i++].disk === 'fail';
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 30 };
    },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new BidEngine(adapter, scheduler, { config: CONFIG, live: true, onEvent: (e) => events.push(e), log });
  const m = engine.arm(META(id), PRICING);
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  const realNow = Date.now;
  const t0 = realNow();
  let escaped = null;
  try {
    for (const step of steps) {
      Date.now = () => t0 + step.atMs;
      desk.senderUp = step.senderUp !== false;
      try { await engine._maybeBid(m, liveState()); } catch (e) { escaped = escaped || e; }
      while (routed < events.length) {
        const e = events[routed++];
        if (e.type === 'alert' && e.kind === 'bid_record_failed' && e.auctionId === id) writeFailOffers++;
        await notifyEngineEvent(desk.notifier, e);
      }
      perStep.push(desk.errorsToDesk());
    }
  } finally {
    Date.now = realNow;
  }
  scheduler.faulting = false;
  engine.kill('done');
  return { calls: i, faultHits: scheduler.faultHits, escaped, writeFailOffers, perStep, delivered: desk.errorsToDesk() };
}

function sanity(r, bids, faults) {
  assert.strictEqual(r.escaped, null, `harness: an exception escaped the engine: ${r.escaped && r.escaped.message}`);
  assert.strictEqual(r.calls, bids, `harness: expected ${bids} bids placed, got ${r.calls}`);
  assert.strictEqual(r.faultHits, faults, `harness: expected ${faults} failed writes, got ${r.faultHits}`);
  assert.ok(r.writeFailOffers >= 1, 'harness: the engine never raised bid_record_failed');
}

const checks = [
  ['1. flapping disk + failing notifier store: one message per window per load, one more after it', async () => {
    const flap = [];
    for (let k = 0; k < 7; k++) flap.push({ disk: k % 2 === 0 ? 'fail' : 'ok', atMs: k * 1_000 });
    const inWindow = await run(flap, { dedupeWritesFail: true });
    sanity(inWindow, 7, 4);
    assert.strictEqual(inWindow.delivered, 1,
      `a disk alternating fail/ok inside one window delivered ${inWindow.delivered} bid_record_failed messages to the desk, expected 1`);
    const after = await run(flap.concat([{ disk: 'fail', atMs: WINDOW_MS + 1_000 }]), { dedupeWritesFail: true });
    sanity(after, 8, 5);
    assert.strictEqual(after.delivered, 2,
      `a further failure after the window brought the total to ${after.delivered} delivered messages, expected 2`);
  }],
  ['2. healthy store: a second fault after the window is delivered despite the persisted first mark', async () => {
    const r = await run([
      { disk: 'fail', atMs: 0 },
      { disk: 'ok', atMs: 1_000 },
      { disk: 'fail', atMs: WINDOW_MS + 1_000 },
    ]);
    sanity(r, 3, 2);
    assert.strictEqual(r.writeFailOffers, 2, `harness: expected the engine to raise 2 alerts, got ${r.writeFailOffers}`);
    assert.strictEqual(r.delivered, 2,
      `fail, recover, fail after the window delivered ${r.delivered} message(s) to the desk: the second episode was lost, expected 2`);
  }],
  ['3. guard: an alert dropped while the sender was down is delivered by the next failure after the window', async () => {
    const r = await run([
      { disk: 'fail', atMs: 0, senderUp: false },
      { disk: 'fail', atMs: WINDOW_MS },
    ]);
    sanity(r, 2, 2);
    assert.strictEqual(r.writeFailOffers, 2, `harness: expected 2 delivery attempts, got ${r.writeFailOffers}`);
    assert.strictEqual(r.perStep[0], 0, `harness: the first alert reached the desk with the sender down (${r.perStep[0]})`);
    assert.strictEqual(r.delivered, 1,
      `a first alert dropped at delivery was followed by ${r.delivered} delivered message(s), expected 1`);
  }],
  ['4. named re-pin target: a fault dropped at delivery is re-offered inside the window, not after it', async () => {
    const r = await run([
      { disk: 'fail', atMs: 0, senderUp: false },
      { disk: 'ok', atMs: 60_000 },
      { disk: 'fail', atMs: 240_000, senderUp: true },
    ]);
    sanity(r, 3, 2);
    assert.strictEqual(r.perStep[0], 0, `harness: the first alert reached the desk with the sender down (${r.perStep[0]})`);
    assert.strictEqual(r.delivered, 1,
      `a write fault dropped at delivery (sender down), followed by a second fault 240s later inside the same `
      + `10-minute window, delivered ${r.delivered} message(s) to the desk, expected 1 - a load that closes `
      + 'inside the window must still get a delivered write-fault alert');
  }],
  ['5. flood guard: a fault that keeps re-offering every interval inside one window still delivers once', async () => {
    const flap = [];
    for (let k = 0; k < 9; k++) flap.push({ disk: k % 2 === 0 ? 'fail' : 'ok', atMs: k * 70_000 });
    const r = await run(flap, { dedupeWritesFail: true });
    sanity(r, 9, 5);
    assert.ok(r.writeFailOffers >= 2, `harness: spaced 70s apart, the engine must re-offer more than once, got ${r.writeFailOffers}`);
    assert.strictEqual(r.delivered, 1,
      `a fault re-offered every 70s across a 560s span (the same window) delivered ${r.delivered} message(s) `
      + 'to the desk, expected 1 - the notifier\'s in-process mark must absorb every re-offer after the one that lands, '
      + 'even though the persisted mark cannot');
  }],
];

(async () => {
  console.log('\nWrite-fault alerts as delivered to the desk through the notifier\n');
  let failed = 0;
  for (const [name, fn] of checks) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`);
    }
  }
  console.log(failed ? `\nFAIL - ${failed} of ${checks.length} checks failed` : `\nPASS - ${checks.length} checks`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('\nFAIL -', (e && e.stack) || e);
  process.exit(1);
});
