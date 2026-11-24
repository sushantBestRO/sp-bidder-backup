'use strict';
/**
 * One close sends the desk one result receipt, across a restart that re-arms it (T2 D6 residual; round-
 * tracker spec s5.2; ruling 18).
 *
 * THE DEFECT. _finalize's durable close write fails (a disk fault). The receipt still goes out (W1-1),
 * but the intent stays active with won:null, so a restart inside rehydrateGraceMs of the close re-arms
 * the dead auction: a second monitor, a second finalize, a second receipt for one close. The notifier's
 * sent marks live in the same data directory as the intents (notifSent in the store), so a fault that
 * fails the close write can fail the mark too, and nothing on disk says a receipt went out.
 *
 *   1  the close write alone fails (the receipt's mark lands) and the process restarts 10 s after the
 *      close; the second finalize reads a different rank. The receipt is keyed on the close
 *      (auctionId:finalCloseAt:rounds), not on won/lost, so the second one is not sent.
 *
 * Not pinned: the disk down at the close and back before the restart. The receipt's mark failed with
 * the close write, so only retrying the close write until it lands would stop the re-arm, and that
 * retry is not built here (a timer after a failed close write is what test-tick-fault-after-finalize.js
 * check 1 forbids).
 * Counted as receipts DELIVERED through a real Notifier and WhatsAppClient over a capturing transport,
 * not as engine events: the second finalize is still raised, and what must not happen is a second
 * message. Disk down through the restart itself still sends a second receipt, loud rather than silent
 * (spec s5.2 item 3); not pinned here.
 *
 * Real BidEngine, real DurableScheduler on a temp file whose writes fail on demand, a MemoryStore whose
 * writes fail on demand (the notifier's marks), a hard-close load. Date.now is a virtual clock; timers
 * of 30 s or more are captured, shorter ones run as usual and the engine's own poll timers are cleared
 * after every tick, so nothing runs that the test did not drive.
 *
 *   node scripts/test-result-receipt-once-per-close.js
 */
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

const EXPECTED_CHECKS = 1;
const REAL_NOW = Date.now;
const REAL_SET = global.setTimeout;
const clock = { now: REAL_NOW() };
Date.now = () => clock.now;
const captured = [];
global.setTimeout = (fn, ms, ...args) => {
  if (Number(ms) >= 30_000) {
    captured.push({ fn, args });
    return { unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
  }
  return REAL_SET(fn, ms, ...args);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-once-'));
process.on('exit', () => {
  Date.now = REAL_NOW;
  global.setTimeout = REAL_SET;
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}
});
let seq = 0;

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const CONFIG = { openAtMs: 2 * 60 * 60 * 1000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 };
const PRICING = { cost: 29_000, marginsPct: [9, 5, 1] };
const DESK = '+919000000009';

function faultingScheduler(file, disk) {
  const s = new DurableScheduler(file);
  const real = s._persist.bind(s);
  s._persist = () => {
    if (disk.intents) throw Object.assign(new Error(`EACCES: permission denied, open '${file}.tmp'`), { code: 'EACCES' });
    return real();
  };
  return s;
}

function faultingStore(disk) {
  const store = new MemoryStore();
  const put = store.putDoc.bind(store);
  store.putDoc = async (...a) => {
    if (disk.store) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return put(...a);
  };
  return store;
}

function desk(store, delivered) {
  const transport = async (url) => {
    if (/listPhones/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const realSend = wa.sendText.bind(wa);
  wa.sendText = async (to, message, o = {}) => {
    const res = await realSend(to, message, o);
    if (res && res.ok && (o.kind === 'won' || o.kind === 'lost')) delivered.push({ to, kind: o.kind });
    return res;
  };
  return new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
    recipientsProvider: async () => [{ name: 'Desk', phone: DESK, alerts: ['won', 'lost'] }] });
}

function adapter(load) {
  return {
    writeEnabled: true,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'closed', myRank: load.rank, totalBidders: 3, standingL1Price: null,
      closesInMs: 0, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 }),
    placeBid: async () => ({ accepted: true, myRank: load.rank }),
  };
}

function process_(load, notifier) {
  const events = [];
  const eng = new BidEngine(adapter(load), faultingScheduler(load.file, load.disk), {
    config: CONFIG, log: quiet, onEvent: (e) => events.push(e) });
  return { eng, events, notifier };
}

function clearTimers(eng) {
  for (const m of eng.monitors.values()) { if (m.timer) { clearTimeout(m.timer); m.timer = null; } }
}

async function tickAll(proc) {
  for (const m of [...proc.eng.monitors.values()]) {
    await proc.eng._tick(m);
    clearTimers(proc.eng);
  }
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  while (proc.routed < proc.events.length) await notifyEngineEvent(proc.notifier, proc.events[proc.routed++]);
}

async function run({ rankAfterRestart, downAtClose, restartAfterMs }) {
  const load = { id: `D6-${seq++}`, file: path.join(DIR, `intents-${seq}.json`), rank: 1,
    disk: { intents: false, store: false } };
  const store = faultingStore(load.disk);
  const delivered = [];
  const t0 = REAL_NOW();
  clock.now = t0;
  const p1 = process_(load, desk(store, delivered));
  p1.routed = 0;
  p1.eng.arm({ id: load.id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Waaree Energies', closesAt: t0 + 1_000, startsAt: t0 - 1_000, status: 'live', softClose: false }, PRICING);
  clearTimers(p1.eng);

  clock.now = t0 + 2_000;
  Object.assign(load.disk, downAtClose);
  await tickAll(p1);
  const first = p1.events.filter((e) => e.type === 'auction_result').length;
  if (first !== 1) throw new Error(`HARNESS: process 1 raised ${first} auction_result, expected 1`);
  const closeFailed = p1.events.some((e) => e.type === 'alert' && e.kind === 'close_record_failed');
  if (!closeFailed) throw new Error('HARNESS: the close write did not fail in process 1');
  load.disk.intents = false;
  load.disk.store = false;

  clock.now = t0 + 2_000 + restartAfterMs;
  p1.eng.kill('restart');
  load.rank = rankAfterRestart;
  const p2 = process_(load, desk(store, delivered));
  p2.routed = 0;
  await p2.eng.rehydrate();
  clearTimers(p2.eng);
  const rearmed = p2.eng.monitors.has(load.id);
  await tickAll(p2);
  p2.eng.kill('done');
  captured.splice(0);
  return { delivered, rearmed, second: p2.events.filter((e) => e.type === 'auction_result').length };
}

const results = [];
async function check(name, kind, fn) {
  let failure = null;
  try { await fn(); } catch (e) { failure = (e && e.message) || String(e); }
  results.push({ name, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${name} [${kind}]`);
  if (failure) console.log(`        ${failure.split('\n')[0]}`);
}

(async () => {
  const title = 'One close, one result receipt across a restart (T2 D6 residual, spec s5.2)';
  console.log(`${title}\n`);

  await check('1 close write fails, restart 10 s later, the second finalize reads another rank -> no second receipt', 'red', async () => {
    const r = await run({ rankAfterRestart: 2, downAtClose: { intents: true }, restartAfterMs: 10_000 });
    if (!r.rearmed) throw new Error('HARNESS: the restart did not re-arm the load, so the scenario never reached a second finalize');
    assert.strictEqual(r.delivered.length, 1,
      `the desk received ${r.delivered.length} result receipts (${r.delivered.map((d) => d.kind).join(', ')}) for one close: `
      + 'the receipt is deduped on won/lost, so a re-armed finalize that reads another rank sends a second one');
  });

  const failed = results.filter((r) => r.failure);
  if (results.length !== EXPECTED_CHECKS || failed.length) {
    console.log(`\nFAIL - ${results.length - failed.length}/${EXPECTED_CHECKS} checks passed (${results.length} ran): ${title}`);
    process.exitCode = 1;
  } else console.log(`\nPASS - ${EXPECTED_CHECKS} checks: ${title}`);
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
