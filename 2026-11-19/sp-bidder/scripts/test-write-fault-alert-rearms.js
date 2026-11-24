'use strict';
/**
 * THE ONCE-PER-LOAD WRITE-FAULT ALERT RE-ARMS AFTER A RE-ALERT WINDOW, RECOVERED OR NOT.
 *
 * Regression target: the persist-failure alert (bid_record_failed) is sent once per load while one
 * fault lasts, because the notifier's dedupe mark cannot land on a failing disk (see
 * scripts/test-write-fault-alert-once-per-load.js). A permanent once-per-load guard would lose two
 * things:
 *   - a second, separate fault on the same load after its writes had recovered would send nothing;
 *   - an alert the notifier dropped at delivery (sender session down) would never be retried,
 *     because the notifier drops error alerts without marking them and nothing else re-sends them.
 * So the passage of the re-alert window (cfg.writeFailRealertMs) re-arms the alert, whether the
 * fault persisted or the load's writes recovered in between. A recovery alone does not: on a disk
 * that alternates fail/ok it would re-alert on every failed write (see
 * scripts/test-write-fault-alert-episode-delivery.js).
 *
 * WHAT MUST NOT MOVE:
 *   - inside one continuous fault and inside the window, the load is alerted once.
 *   - every failed write is still logged.
 *
 * Named re-pin (T5, ruling 32): this is a 3-bid hard close on a 4-price band, and it keeps its third bid
 * for the lowest band price in the final window. A third bid far from close is no longer sent, so in
 * the runs that need three bids (checks 2 and 3) a tick 25 s from close holds, and the third bid's tick
 * reads a countdown inside the final window, still at the same clock offset after the re-alert window.
 *
 *   node scripts/test-write-fault-alert-rearms.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification, notifyEngineEvent } = require('../src/notify/engineAlerts');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'write-fault-rearm-'));
process.on('exit', () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

const WINDOW_MS = 10 * 60 * 1000;
const REMAINING_MS = 114 * 60 * 1000;
// named re-pin: T5, ruling 32 - a step may give the countdown its tick reads (leftMs); REMAINING_MS otherwise.
const FINAL_WINDOW_LEFT_MS = 1_000; // inside CONFIG.floorWindowMs
const liveState = (closesInMs = REMAINING_MS) => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs, revisionsLeft: null, revisionLimit: 3,
  closeModel: 'hard', measuredRttMs: 50, minDecrement: 100,
});
const META = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', closesAt: Date.now() + REMAINING_MS, startsAt: Date.now() - 1_000,
  status: 'live', softClose: false });
const PRICING = { cost: 29_000, marginsPct: [9, 7, 5, 1], minMarginPct: 1 };
const CONFIG = { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, writeFailRealertMs: WINDOW_MS };
const CAPS = () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
  revisionLimit: 3, closeModel: 'hard' });

function mkScheduler() {
  const file = path.join(DATA_DIR, `rearm-intents-${process.pid}-${seq++}.json`);
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

const bidAlerts = (events, id) => events.filter((e) => {
  const n = toNotification(e);
  return !!n && n.kind === 'error' && e.auctionId === id && e.kind === 'bid_record_failed';
}).length;

const DESK = '+919000000001';
// A real Notifier + WhatsAppClient over a capturing transport, so `run()` can report how many
// bid_record_failed alerts actually REACHED the desk, not just how many the engine raised. named
// re-pin: W1-1 V3-F01, ruling 59 - check 1 below now asserts on this rather than on raw engine
// events, because ruling 59's fix can raise a second engine event inside one window (a re-offer of
// the SAME episode) without that being a second message the desk receives.
function mkDesk() {
  const delivered = [];
  const transport = async (url) => {
    if (/listPhones/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const realSend = wa.sendText.bind(wa);
  wa.sendText = async (to, message, o = {}) => {
    const res = await realSend(to, message, o);
    if (res && res.ok) delivered.push({ to, kind: o.kind });
    return res;
  };
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => [{ name: 'Desk', phone: DESK, alerts: ['error'] }] });
  return { notifier, delivered };
}

// Each step is one bid: `disk` is 'fail' or 'ok' for that bid's write, `outcome` is 'accept' or
// 'network', and `atMs` is the clock offset the bid runs at. named re-pin: T5, ruling 32 - a `hold`
// step is a tick that must send nothing, and `placed` counts the bids each step's tick sent.
async function run(steps) {
  const id = 'REARM-1';
  const scheduler = mkScheduler();
  const desk = mkDesk();
  const events = [];
  let routed = 0;
  let writeFailLogs = 0;
  let i = 0;
  const bids = steps.filter((st) => !st.hold); // named re-pin: T5, ruling 32
  const adapter = {
    writeEnabled: true, capabilities: CAPS,
    ensureSession: async () => ({}), getAuctionState: async () => liveState(),
    placeBid: async () => {
      const step = bids[i++];
      scheduler.faulting = step.disk === 'fail';
      if (step.outcome === 'network') throw Object.assign(new Error('socket hang up'), { code: 'NETWORK' });
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 30 };
    },
  };
  const log = {
    debug() {}, info() {}, warn() {},
    error(msg) { if (msg === 'a durable write for this load failed') writeFailLogs++; },
  };
  const engine = new BidEngine(adapter, scheduler, { config: CONFIG, live: true, onEvent: (e) => events.push(e), log });
  const m = engine.arm(META(id), PRICING);
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  const realNow = Date.now;
  const t0 = realNow();
  let escaped = null;
  const placed = []; // named re-pin: T5, ruling 32
  try {
    for (const step of steps) {
      Date.now = () => t0 + step.atMs;
      const before = i;
      try { await engine._maybeBid(m, liveState(step.leftMs)); } catch (e) { escaped = escaped || e; }
      placed.push(i - before);
      while (routed < events.length) await notifyEngineEvent(desk.notifier, events[routed++]);
    }
  } finally {
    Date.now = realNow;
  }
  const out = { calls: i, placed, faultHits: scheduler.faultHits, escaped, alerts: bidAlerts(events, id),
    delivered: desk.delivered.length, writeFailLogs };
  scheduler.faulting = false;
  engine.kill('done');
  return out;
}

(async () => {
  console.log('\nThe write-fault alert re-arms after the re-alert window\n');

  // named re-pin: W1-1 V3-F01, ruling 59. Before ruling 59 this asserted `within.alerts === 1` (raw
  // engine events). Ruling 59's fix re-offers the SAME episode once writeFailReofferMs has passed
  // inside the window - here the second step lands 599,999 ms after the first, well past that
  // interval - so the engine now correctly raises a SECOND event for the one continuous fault. That
  // is not a second message: the notifier's dedupe mark on the shared episode key absorbs the
  // re-offer once the first has delivered, so what must stay pinned at 1 is what the desk actually
  // RECEIVES, through a real Notifier - not the count of engine events, which the fix deliberately
  // changes. Proven red with ruling 59's engine change reverted (`within.delivered` reads 1 raw event
  // and 1 delivered message either way there - the flip is on `within.alerts`, not `within.delivered`,
  // and TESTED via test-write-fault-alert-episode-delivery.js checks 4-5, whose scenario cannot be
  // expressed on `.alerts` at all) and green at this file's tip.
  const within = await run([
    { disk: 'fail', outcome: 'accept', atMs: 0 },
    { disk: 'fail', outcome: 'accept', atMs: WINDOW_MS - 1 },
  ]);
  assert.strictEqual(within.escaped, null, `a failed write escaped: ${within.escaped && within.escaped.message}`);
  assert.strictEqual(within.calls, 2, `harness: expected 2 bids, got ${within.calls}`);
  assert.strictEqual(within.faultHits, 2, `harness: expected 2 failed writes, got ${within.faultHits}`);
  assert.strictEqual(within.alerts, 2,
    `one continuous fault inside the window, spaced past the re-offer interval, must raise a re-offer of the `
    + `same episode: raw engine alerts were ${within.alerts}, expected 2`);
  assert.strictEqual(within.delivered, 1,
    `one continuous fault inside the window sent ${within.delivered} message(s) to the desk, expected 1 - the `
    + 're-offer must be absorbed by the notifier\'s dedupe mark on the shared episode key');
  assert.strictEqual(within.writeFailLogs, 2, `each failed write must be logged: ${within.writeFailLogs} for 2`);
  ok(1, 'named re-pin: W1-1 V3-F01, ruling 59 - one continuous fault inside the window re-offers once, delivered once, every failure logged');

  const recovered = await run([
    { disk: 'fail', outcome: 'accept', atMs: 0 },
    { disk: 'ok', outcome: 'accept', atMs: 1_000 },
    { hold: true, atMs: WINDOW_MS - 24_000, leftMs: 25_000 }, // named re-pin: T5, ruling 32
    { disk: 'fail', outcome: 'accept', atMs: WINDOW_MS, leftMs: FINAL_WINDOW_LEFT_MS }, // named re-pin: T5, ruling 32
  ]);
  assert.deepStrictEqual(recovered.placed, [1, 1, 0, 1],
    'named re-pin: T5, ruling 32 - this 3-bid hard close must keep its third bid for the final window: '
    + `bids sent per tick ${JSON.stringify(recovered.placed)}, expected [1,1,0,1] (the tick 25 s out holds)`);
  assert.strictEqual(recovered.escaped, null, `a failed write escaped: ${recovered.escaped && recovered.escaped.message}`);
  assert.strictEqual(recovered.calls, 3, `harness: expected 3 bids, got ${recovered.calls}`);
  assert.strictEqual(recovered.faultHits, 2, `harness: expected 2 failed writes, got ${recovered.faultHits}`);
  assert.strictEqual(recovered.alerts, 2,
    `fail, recover, fail after the window on one load sent ${recovered.alerts} alert(s): a second fault must be reported, expected 2`);
  ok(2, 'accepted path: a fault after a recovery and after the window alerts again');

  const recoveredHandler = await run([
    { disk: 'fail', outcome: 'network', atMs: 0 },
    { disk: 'ok', outcome: 'network', atMs: 1_000 },
    { hold: true, atMs: WINDOW_MS - 24_000, leftMs: 25_000 }, // named re-pin: T5, ruling 32
    { disk: 'fail', outcome: 'network', atMs: WINDOW_MS, leftMs: FINAL_WINDOW_LEFT_MS }, // named re-pin: T5, ruling 32
  ]);
  assert.deepStrictEqual(recoveredHandler.placed, [1, 1, 0, 1],
    'named re-pin: T5, ruling 32 - this 3-bid hard close must keep its third bid for the final window: '
    + `bids sent per tick ${JSON.stringify(recoveredHandler.placed)}, expected [1,1,0,1] (the tick 25 s out holds)`);
  assert.strictEqual(recoveredHandler.escaped, null,
    `a failed write escaped: ${recoveredHandler.escaped && recoveredHandler.escaped.message}`);
  assert.strictEqual(recoveredHandler.faultHits, 2, `harness: expected 2 failed writes, got ${recoveredHandler.faultHits}`);
  assert.strictEqual(recoveredHandler.alerts, 2,
    `uncertain-outcome handler: fail, recover, fail after the window sent ${recoveredHandler.alerts} alert(s), expected 2`);
  ok(3, 'uncertain-outcome handler: a fault after a recovery and after the window alerts again');

  const outlasted = await run([
    { disk: 'fail', outcome: 'accept', atMs: 0 },
    { disk: 'fail', outcome: 'accept', atMs: WINDOW_MS },
  ]);
  assert.strictEqual(outlasted.escaped, null, `a failed write escaped: ${outlasted.escaped && outlasted.escaped.message}`);
  assert.strictEqual(outlasted.faultHits, 2, `harness: expected 2 failed writes, got ${outlasted.faultHits}`);
  assert.strictEqual(outlasted.alerts, 2,
    `a fault that outlasts the re-alert window sent ${outlasted.alerts} alert(s): a first alert dropped at delivery would never be retried, expected 2`);
  ok(4, 'a fault that outlasts the re-alert window alerts again');

  console.log(`\nPASS - ${pass} checks`);
})().catch((e) => {
  console.error('\nFAIL -', e.message);
  process.exit(1);
});
