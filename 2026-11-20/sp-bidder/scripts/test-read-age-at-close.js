'use strict';
/**
 * EVERY CLOSE RECORDS HOW OLD OUR LAST LIVE READ WAS, AND A PRICED LOAD WHOSE LAST READ WAS OVER 3 S
 * BEFORE CLOSE RAISES A LOUD OPS ALERT.
 *
 * Regression target: 2026-09-25, Waaree 260925RP1C. The load's last read before close was 12.2 s
 * out; nothing recorded it and nothing said so, so a timing loss read as an ordinary no-bid. The
 * price-page gate forbids a silent timing loss. One implementation in the engine, so both portals
 * get it.
 *
 * Pinned (real BidEngine, fake adapters, virtual Date.now):
 *   1. GoComet shape: last live read 5 s before close -> auction_result carries
 *      lastReadBeforeCloseMs 5000, and one stale_read_at_close alert (level error) names the load.
 *   2. SuperProcure shape: the same.
 *   3. last live read 1 s before close -> the metric is recorded, no alert.
 *   4. the closed record keeps the metric (BidLogger over a memory store) and so does the append-only
 *      bids stream.
 *   5. the alert is a notifier error kind, so it reaches the ops channel, not only the event ring.
 *   6. a GoComet state built from our own submit response is not a portal read: it does not reset the
 *      age (review of 9b2dd20, non-blocking 6).
 *
 *   node scripts/test-read-age-at-close.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { MemoryStore } = require('../src/store/memoryStore');
const { BidLogger } = require('../src/logging/bidLogger');

const REAL_NOW = Date.now;
let vnow = Math.ceil(REAL_NOW() / 1000) * 1000;
Date.now = () => vnow;
const CLEAN = [];
process.on('exit', () => { Date.now = REAL_NOW; for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let seq = 0;

const GC_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3, closeModel: 'soft',
  reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure' };

async function closeAfterLastRead({ gc, lastReadBeforeCloseMs, responseStateAtMs = null }) {
  const file = path.join(os.tmpdir(), `read-age-${process.pid}-${seq += 1}.json`);
  CLEAN.push(file, `${file}.tmp`);
  const close = vnow + 3_600_000;
  const events = [];
  const frame = () => {
    const left = Math.max(0, close - vnow);
    return gc
      ? { ok: true, status: left > 0 ? 'live' : 'closed', closeModel: 'soft', closesAtMs: close, closesInMs: left, serverOffsetMs: 0,
        extendMs: 300_000, extendCount: null, extensionCeiling: null, myRank: 1, totalBidders: null, standingL1Price: null,
        revisionsLeft: 3, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 }
      : { ok: true, status: left > 0 ? 'live' : 'closed', closeModel: 'hard', closesAtMs: close, closesInMs: left, myRank: 1,
        totalBidders: 3, standingL1Price: null, revisionsLeft: null, revisionLimit: null, minDecrement: 100, measuredRttMs: 20,
        myAmount: null, pushFed: true };
  };
  const adapter = {
    capabilities: () => ({ ...(gc ? GC_CAPS : SP_CAPS) }),
    ensureSession: async () => ({}),
    getAuctionState: async () => frame(),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
    readSettledOutcome: gc ? async () => ({ settled: true, rank: 1 }) : undefined,
  };
  if (!gc) delete adapter.readSettledOutcome;
  const engine = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0, finalizeDebounceMs: 0 },
    softClose: { enabled: false, shippers: [], mode: 'live' }, rand: () => 0.5, log: quiet,
    onEvent: (e) => events.push(e),
  });
  const id = `RA${seq}`;
  const m = engine.arm({ id, lane: { origin: 'Degam', destination: 'Surat' }, equipment: '40 ft', units: 1, quoteType: 'FTL',
    companyName: 'Waaree Energies Ltd', closesAt: close, status: 'live', platformKey: gc ? 'gocomet' : 'superprocure',
    rules: { revisionLimit: 3, minDecrement: 500 } }, { cost: 36_000, marginsPct: [9, 7.2, 1.8, 1] });
  const clear = () => { if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
  clear();
  vnow = close - 60_000; await engine._tick(m); clear();
  vnow = close - lastReadBeforeCloseMs; await engine._tick(m); clear();
  if (responseStateAtMs != null) {
    vnow = close - responseStateAtMs;
    m._responseState = { state: { ...frame(), myRank: 2 }, at: vnow };
    await engine._tick(m); clear();
  }
  vnow = close + 1_000; await engine._tick(m); clear();
  for (let i = 0; i < 5 && !m.finalized; i += 1) { vnow += 400_000; await engine._tick(m); clear(); }
  engine.kill('done');
  const result = events.find((e) => e.type === 'auction_result');
  const alerts = events.filter((e) => e.type === 'alert' && e.kind === 'stale_read_at_close');
  return { id, events, result, alerts };
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  let gcStale = null;
  await check('1. GoComet: a last read 5 s before close is recorded and alerted', async () => {
    gcStale = await closeAfterLastRead({ gc: true, lastReadBeforeCloseMs: 5_000 });
    assert.ok(gcStale.result, 'HARNESS: the load never finalized');
    assert.strictEqual(gcStale.result.lastReadBeforeCloseMs, 5_000, `lastReadBeforeCloseMs ${gcStale.result.lastReadBeforeCloseMs}`);
    assert.strictEqual(gcStale.alerts.length, 1, `${gcStale.alerts.length} stale_read_at_close alerts`);
    assert.strictEqual(gcStale.alerts[0].level, 'error');
    assert.strictEqual(gcStale.alerts[0].auctionId, gcStale.id);
    assert.strictEqual(gcStale.alerts[0].lastReadBeforeCloseMs, 5_000);
    // Owner-approved wording, 26 Sep (copy packet, final-window-latency).
    assert.strictEqual(gcStale.alerts[0].detail, 'Stale read: last look was 5 s before close. Check the result on the portal.');
  });

  await check('2. SuperProcure: the same', async () => {
    const r = await closeAfterLastRead({ gc: false, lastReadBeforeCloseMs: 5_000 });
    assert.ok(r.result, 'HARNESS: the load never finalized');
    assert.strictEqual(r.result.lastReadBeforeCloseMs, 5_000, `lastReadBeforeCloseMs ${r.result.lastReadBeforeCloseMs}`);
    assert.strictEqual(r.alerts.length, 1, `${r.alerts.length} stale_read_at_close alerts`);
  });

  await check('3. a last read 1 s before close is recorded, with no alert', async () => {
    for (const gc of [true, false]) {
      const r = await closeAfterLastRead({ gc, lastReadBeforeCloseMs: 1_000 });
      assert.strictEqual(r.result.lastReadBeforeCloseMs, 1_000, `${gc ? 'GoComet' : 'SuperProcure'}: ${r.result.lastReadBeforeCloseMs}`);
      assert.strictEqual(r.alerts.length, 0, `${gc ? 'GoComet' : 'SuperProcure'}: alerted on a fresh read`);
    }
  });

  await check('4. the closed record and the bids stream keep the metric', async () => {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    for (const e of gcStale.events) await logger.handle(e);
    const rec = await store.getDoc('closedBids', gcStale.id);
    assert.strictEqual(rec && rec.lastReadBeforeCloseMs, 5_000, `closed record: ${rec && rec.lastReadBeforeCloseMs}`);
    const stream = await store.readEvents('bids');
    const row = stream.find((x) => x.kind === 'auction_result' && x.auctionId === gcStale.id);
    assert.strictEqual(row && row.lastReadBeforeCloseMs, 5_000, `bids stream: ${row && row.lastReadBeforeCloseMs}`);
  });

  await check('5. the alert is a notifier error kind', async () => {
    const { toNotification } = require('../src/notify/engineAlerts');
    const n = toNotification(gcStale.alerts[0]);
    assert.ok(n && n.kind === 'error', `the alert maps to ${JSON.stringify(n && n.kind)}, not the ops error channel`);
  });

  await check('6. a GoComet state built from a submit response is not counted as a live read', async () => {
    const r = await closeAfterLastRead({ gc: true, lastReadBeforeCloseMs: 5_000, responseStateAtMs: 1_000 });
    assert.strictEqual(r.result.lastReadBeforeCloseMs, 5_000, `lastReadBeforeCloseMs ${r.result.lastReadBeforeCloseMs}`);
    assert.strictEqual(r.alerts.length, 1, `${r.alerts.length} stale_read_at_close alerts`);
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 6, `expected 6 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-read-age-at-close:', e && e.stack); process.exit(1); });
