'use strict';
/**
 * GOCOMET: EVERY ACCEPTED BID RECORDS WHEN IT LANDED AGAINST THE CLOSE WE DERIVED.
 *
 * Regression target: 2026-09-26, Waaree 260925NP9V. The bid landed at 11:20:00.04 IST, 2.04 s after
 * our derived close of 11:19:58.000, and GoComet accepted it, so the derived close was at least that
 * early. Nothing recorded the gap, so there is no sample to test the whole-second snap for a bias.
 *
 * Pinned (real BidEngine, fake GoComet-shaped adapter, virtual Date.now):
 *   1. an accepted bid landing 2,000 ms after the believed close carries landedVsCloseMs 2000 on
 *      bid_placed, on the server's clock (serverOffsetMs applied), with the deciding read's closeSnapped
 *      and submitStartVsCloseMs, when its submit was sent. The portal accepted the bid somewhere
 *      between the two, so only a submit SENT after the derived close proves the close early.
 *   2. auction_result carries latestAcceptedVsCloseMs, the latest of the load's accepted landings.
 *   3. the closed record keeps both (BidLogger over a memory store).
 *   4. the real adapter publishes closeSnapped on its state: true for an integer countdown with a stamp.
 *
 *   node scripts/test-gocomet-landing-vs-derived-close.js
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
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

const REAL_NOW = Date.now;
let vnow = Math.ceil(REAL_NOW() / 1000) * 1000;
Date.now = () => vnow;
const file = path.join(os.tmpdir(), `gc-landing-${process.pid}.json`);
process.on('exit', () => { Date.now = REAL_NOW; for (const f of [file, `${file}.tmp`]) { try { fs.unlinkSync(f); } catch (_) {} } });
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const OFFSET = 250;
const CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3, closeModel: 'soft',
  reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 };

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  const closeServer = vnow + 3_600_000;
  const events = [];
  let rank = 3;
  const frame = () => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: closeServer,
    closesInMs: closeServer - (vnow + OFFSET), serverOffsetMs: OFFSET, closeSnapped: true, extendMs: 300_000,
    extendCount: null, extensionCeiling: null, myRank: rank, totalBidders: null, standingL1Price: null, revisionsLeft: 3,
    revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 });
  const adapter = {
    capabilities: () => ({ ...CAPS }),
    ensureSession: async () => ({}),
    getAuctionState: async () => frame(),
    placeBid: async () => {
      const submitStartedAt = closeServer - OFFSET - 1_500;
      vnow = closeServer - OFFSET + 2_000;
      rank = 1;
      return { accepted: true, status: 200, myRank: 1, revisionsLeft: null, bidClosingInMs: null, latencyMs: 4_578, submitStartedAt };
    },
    readSettledOutcome: async () => ({ settled: true, rank: 1 }),
  };
  const engine = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0, finalizeDebounceMs: 0 },
    softClose: { enabled: false, shippers: [], mode: 'live' }, rand: () => 0.5, log: quiet, onEvent: (e) => events.push(e),
  });
  const m = engine.arm({ id: '260925NP9V', lane: { origin: 'Degam', destination: 'Surat' }, equipment: '40 ft', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd', closesAt: closeServer, status: 'live', platformKey: 'gocomet',
    rules: { revisionLimit: 3, minDecrement: 500 } }, { cost: 36_000, marginsPct: [9, 7.2, 1.8, 1] });
  const clear = () => { if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
  clear();
  vnow = closeServer - OFFSET - 60_000; await engine._tick(m); clear();
  vnow = closeServer - OFFSET - 5_000; await engine._tick(m); clear();
  for (let i = 0; i < 6 && !m.finalized; i += 1) { vnow += 400_000; await engine._tick(m); clear(); }
  engine.kill('done');
  const placed = events.filter((e) => e.type === 'bid_placed');
  const result = events.find((e) => e.type === 'auction_result');

  await check('1. an accepted bid landing 2 s after the believed close carries landedVsCloseMs 2000', async () => {
    assert.strictEqual(placed.length, 1, `HARNESS: ${placed.length} bids placed`);
    assert.strictEqual(placed[0].landedVsCloseMs, 2_000, `landedVsCloseMs ${placed[0].landedVsCloseMs}`);
    assert.strictEqual(placed[0].closeSnapped, true, `closeSnapped ${placed[0].closeSnapped}`);
    assert.strictEqual(placed[0].submitStartVsCloseMs, -1_500, `submitStartVsCloseMs ${placed[0].submitStartVsCloseMs}`);
  });
  await check('2. auction_result carries the latest accepted landing against the close', async () => {
    assert.ok(result, 'HARNESS: never finalized');
    assert.strictEqual(result.latestAcceptedVsCloseMs, 2_000, `latestAcceptedVsCloseMs ${result.latestAcceptedVsCloseMs}`);
  });
  await check('3. the closed record keeps both', async () => {
    const store = new MemoryStore();
    const logger = new BidLogger({ store });
    for (const e of events) await logger.handle(e);
    const rec = await store.getDoc('closedBids', '260925NP9V');
    assert.strictEqual(rec.ourBids[0].landedVsCloseMs, 2_000, `ourBids[0].landedVsCloseMs ${rec.ourBids[0].landedVsCloseMs}`);
    assert.strictEqual(rec.ourBids[0].closeSnapped, true, `ourBids[0].closeSnapped ${rec.ourBids[0].closeSnapped}`);
    assert.strictEqual(rec.ourBids[0].submitStartVsCloseMs, -1_500, `ourBids[0].submitStartVsCloseMs ${rec.ourBids[0].submitStartVsCloseMs}`);
    assert.strictEqual(rec.latestAcceptedVsCloseMs, 2_000, `latestAcceptedVsCloseMs ${rec.latestAcceptedVsCloseMs}`);
  });
  await check('4. the real adapter publishes closeSnapped on its state', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `${b64({ alg: 'ES256' })}.${b64({ exp: Math.floor(vnow / 1000) + 86400, user_id: 'u1' })}.sig`;
    const mk = (data) => new GoCometAdapter({ token, sleep: async () => {}, now: () => vnow, log: quiet,
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data }) }) });
    const base = { vendor_rank: 2, revisions_left: 3, total_revisions: 0 };
    const snapped = await mk({ ...base, bid_closing_in: 30, current_server_time: new Date(vnow).toISOString() }).getAuctionState('K');
    const unsnapped = await mk({ ...base, bid_closing_in: 30 }).getAuctionState('K');
    assert.strictEqual(snapped.closeSnapped, true, `snapped read: ${snapped.closeSnapped}`);
    assert.strictEqual(unsnapped.closeSnapped, false, `stampless read: ${unsnapped.closeSnapped}`);
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 4, `expected 4 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-gocomet-landing-vs-derived-close:', e && e.stack); process.exit(1); });
