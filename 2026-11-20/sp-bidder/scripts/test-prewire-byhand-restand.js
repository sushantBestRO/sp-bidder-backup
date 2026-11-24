'use strict';
/**
 * W1-8 F2: A RE-PRICED LOAD THAT STANDS DOWN AGAIN MUST TELL THE DESK AGAIN.
 *
 * Regression target: the by-hand desk notice for a pre-wire stand-down (bidEngine's COST_TYPE_UNMATCHED
 * arm and the placed:false repeat-code arm) is keyed only on the load id (engineAlerts.js
 * `_by_hand`), with no notion of WHICH stand-down it names. A desk re-price rebuilds the monitor
 * (stop + arm) and re-learns the same refusal, but the notifier's dedupe mark from the first
 * stand-down still carries the identical key, so the second by-hand notice is silently swallowed -
 * the desk is never told the corrected rate also cannot be sent.
 *
 * Both by-hand engine events happen either way; the fix is entirely on the delivered side, so every
 * check here counts messages through a REAL Notifier, never raw engine events.
 *
 *   node scripts/test-prewire-byhand-restand.js
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
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prewire-restand-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

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
const PRICING = { cost: 29_000, marginsPct: [9, 7, 5, 1], minMarginPct: 1 };
const CONFIG = { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0 };
const CAPS = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
  revisionLimit: 20, closeModel: 'hard' });

function mkDesk() {
  const delivered = [];
  const transport = async (url) => {
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
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(),
    recipientsProvider: async () => [{ name: 'Desk', phone: DESK, alerts: ['desk_notice'] }] });
  const byHandDelivered = () => delivered.filter((d) => d.kind === 'desk_notice').length;
  return { notifier, byHandDelivered };
}

function mkEngine(code) {
  let calls = 0;
  const events = [];
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}), getAuctionState: async () => liveState(),
    placeBid: async () => {
      calls++;
      const e = new Error(`refused: ${code}`); e.code = code; e.placed = false;
      throw e;
    },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const engine = new BidEngine(adapter, new DurableScheduler(path.join(DATA_DIR, `intents-${process.pid}-${seq++}.json`)),
    { config: CONFIG, live: true, onEvent: (e) => events.push(e), log });
  return { engine, events, calls: () => calls };
}

const byHandEvents = (events, id) => events.filter((e) =>
  e.type === 'alert' && e.kind === 'bid_not_sent' && e.byHand === true && e.auctionId === id);

async function run(code) {
  const id = `RESTAND-${code}`;
  const { engine, events, calls } = mkEngine(code);
  const desk = mkDesk();
  const realNow = Date.now;
  const t0 = realNow();
  try {
    Date.now = () => t0;
    let m = engine.arm(META(id), PRICING);
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    await engine._maybeBid(m, liveState());
    const callsAfterFirst = calls();
    // Control: within ONE monitor the latch stops any further attempt - drive two more ticks.
    await engine._maybeBid(m, liveState());
    await engine._maybeBid(m, liveState());
    const controlHeld = calls() === callsAfterFirst;

    for (const e of byHandEvents(events, id).slice(0)) await notifyEngineEvent(desk.notifier, e);
    const deliveredAfterFirst = desk.byHandDelivered();

    // Re-price: the desk corrects the rate, which stops the live monitor and re-arms from the new
    // band - exactly server.js's reArmWithNewBand (stop, then arm). The refusal repeats.
    Date.now = () => t0 + 5_000;
    engine.stop(id);
    m = engine.arm(META(id), PRICING);
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    await engine._maybeBid(m, liveState());

    const routed = byHandEvents(events, id);
    for (const e of routed.slice(1)) await notifyEngineEvent(desk.notifier, e);

    return { engineEvents: routed.length, delivered: desk.byHandDelivered(), deliveredAfterFirst, controlHeld };
  } finally {
    Date.now = realNow;
    engine.kill('done');
  }
}

(async () => {
  console.log('\nA re-priced load that stands down again tells the desk again\n');

  const costType = await run('COST_TYPE_UNMATCHED');
  assert.strictEqual(costType.deliveredAfterFirst, 1, `harness: the first stand-down must reach the desk, got ${costType.deliveredAfterFirst}`);
  assert.ok(costType.controlHeld, 'harness: the latch must stop any further attempt within one monitor');
  assert.strictEqual(costType.engineEvents, 2, `harness: expected 2 by-hand engine events, got ${costType.engineEvents}`);
  assert.strictEqual(costType.delivered, 2,
    `COST_TYPE_UNMATCHED: a re-priced load stood down twice, but the desk received ${costType.delivered} by-hand message(s), expected 2`);
  ok(1, 'COST_TYPE_UNMATCHED: a re-price that repeats the refusal tells the desk a second time');

  const placedFalse = await run('NO_QUOTE');
  assert.strictEqual(placedFalse.deliveredAfterFirst, 1, `harness: the first stand-down must reach the desk, got ${placedFalse.deliveredAfterFirst}`);
  assert.ok(placedFalse.controlHeld, 'harness: the latch must stop any further attempt within one monitor');
  assert.strictEqual(placedFalse.engineEvents, 2, `harness: expected 2 by-hand engine events, got ${placedFalse.engineEvents}`);
  assert.strictEqual(placedFalse.delivered, 2,
    `placed:false repeat code: a re-priced load stood down twice, but the desk received ${placedFalse.delivered} by-hand message(s), expected 2`);
  ok(2, 'placed:false repeat code (NO_QUOTE): a re-price that repeats the refusal tells the desk a second time');

  console.log(`\nPASS - ${pass} checks`);
})().catch((e) => {
  console.error('\nFAIL -', (e && e.stack) || e);
  process.exit(1);
});
