'use strict';
/**
 * GOCOMET: THE NEXT DECISION AFTER AN ACCEPTED SUBMIT RUNS ON THE SUBMIT RESPONSE, NOT A NEW READ.
 *
 * Regression target (latency map row 2): GoComet's accepted submit carries quote_rank and
 * bid_closing_in, which is everything the next decision needs. The engine instead waited for the hot
 * cadence and a bidding-data GET on a 1-per-second budget shared with autopilot before deciding again.
 *
 * Pinned (a fixed virtual Date.now, fake adapter mirroring gocometAdapter's published shape, real BidEngine and
 * DurableScheduler). The load: final round (three extensions observed, default cap 3), rung 0
 * standing, two attempts left. At 7,000 ms outranked it takes its middle shot, and the submit takes
 * 2,300 ms, so it lands inside the buzzer.
 *   1. the accepted middle shot, response rank 2, schedules the next tick at once (delay 0).
 *   2. that tick decides with zero getAuctionState calls, on the response's rank and close.
 *   3. it is the same decision a read at the same instant produces: the same bids at the same
 *      countdowns, the same rank, close and round verdict (the feature off is the read path).
 *   4. a response without a rank falls back to a normal read: exactly one.
 *   5. a response state older than 1,500 ms is not used: the tick reads.
 *
 *   node scripts/test-gocomet-response-state-saves-read.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 5;
const GC_STEP_MS = 299_000;
const SUBMIT_MS = 2_300;
const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };

const REAL_NOW = Date.now;
// Fixed, never read off the real clock: check 3 compares two loads' absolute closes, and a real second
// boundary falling between building them put those closes a second apart.
const T0 = Date.UTC(2026, 8, 28, 10, 0, 0);
let vnow = T0;
Date.now = () => vnow;
const CLEAN = [];
const ENGINES = [];
process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill('exit'); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let seq = 0;

async function finalRoundLoad({ responseRank = 2, responseState = true } = {}) {
  const file = path.join(os.tmpdir(), `gc-response-state-${process.pid}-${seq++}.json`);
  CLEAN.push(file, `${file}.tmp`);
  const ctrl = { close: null, rank: null, revisionsLeft: 2, responseRank };
  const reads = [];
  const bids = [];
  const frame = () => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: ctrl.close,
    closesInMs: ctrl.close - Date.now(), serverOffsetMs: 0, extendMs: 300_000, extendCount: null,
    extensionCeiling: null, minCloseJumpMs: 30_000, myRank: ctrl.rank, totalBidders: null, standingL1Price: null,
    revisionsLeft: ctrl.revisionsLeft, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 });
  const adapter = {
    capabilities: () => ({ ...GOCOMET_CAPS }),
    ensureSession: async () => ({}),
    async getAuctionState() { reads.push(Date.now()); return frame(); },
    async placeBid(auctionId, price) {
      bids.push({ price, closesInMs: ctrl.close - Date.now() });
      vnow += SUBMIT_MS;
      ctrl.revisionsLeft -= 1;
      if (ctrl.responseRank != null) ctrl.rank = ctrl.responseRank;
      return { accepted: true, status: 200, myRank: ctrl.responseRank, revisionsLeft: null,
        bidClosingInMs: Math.round((ctrl.close - Date.now()) / 1000) * 1000, latencyMs: SUBMIT_MS };
    },
  };
  const posted = T0 + 3_600_000;
  ctrl.close = posted;
  vnow = posted - 600_000;
  const config = { openAtMs: 25_000, floorWindowMs: 2_500, softOpenAtMs: 150_000, softOpenJitterMs: 0,
    openJitterMs: 0, cadenceJitterMs: 0, minInterFireMs: 0 };
  if (!responseState) config.responseStateMaxAgeMs = null;
  const opts = { config, softClose: { enabled: false, shippers: [], mode: 'live' }, rand: () => 0, log: quiet,
    onEvent: () => {} };
  const meta = { id: `GCRS${seq}`, lane: { origin: 'Chikhli', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd', closesAt: posted, platformKey: 'gocomet',
    rules: { revisionLimit: 3, minDecrement: 500 } };
  const first = new BidEngine(adapter, new DurableScheduler(file), opts);
  ENGINES.push(first);
  const ladder = first.arm(meta, { cost: 50_000, marginsPct: [9, 7.2, 1.8, 1] }).ladder.slice();
  first.kill('test: restart');
  first.scheduler.update(meta.id, { status: 'bidding', firedRungs: [0], landedBids: 1, everBid: true,
    landedBidPrice: ladder[0], revisionsLeft: 2 });
  const eng = new BidEngine(adapter, new DurableScheduler(file), opts);
  ENGINES.push(eng);
  await eng.rehydrate();
  const m = eng.monitors.get(meta.id);
  if (!m) throw new Error('HARNESS: rehydrate() did not re-arm the load');
  const delays = [];
  const schedule = eng._schedule.bind(eng);
  eng._schedule = (mon, d) => { delays.push(d); return schedule(mon, d); };
  const clear = () => { if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
  clear();
  const tick = async () => { await eng._tick(m); clear(); };
  for (let i = 0; i < 3; i++) {
    vnow = ctrl.close;
    ctrl.close += GC_STEP_MS;
    ctrl.rank = 1;
    await tick();
  }
  if (m.believedCloseAt !== ctrl.close || m.extendsObserved !== 3) {
    throw new Error(`HARNESS: the extensions did not reach the engine (R ${m.extendsObserved}, close ${m.believedCloseAt} vs ${ctrl.close})`);
  }
  if (bids.length) throw new Error(`HARNESS: bid between rounds: ${JSON.stringify(bids)}`);
  return { eng, m, ctrl, ladder, reads, bids, delays, tick };
}

// The middle shot at 7,000 ms outranked; returns the load with the reads and schedules since it landed.
async function middleShot(opts) {
  const r = await finalRoundLoad(opts);
  vnow = r.ctrl.close - 7_000;
  r.ctrl.rank = 3;
  await r.tick();
  if (r.bids.length !== 1 || r.bids[0].price !== r.ladder[1]) {
    throw new Error(`HARNESS: expected the middle shot at rung 1, placed ${JSON.stringify(r.bids)}`);
  }
  return r;
}

function outcome(r, fromBid) {
  const v = r.eng.roundVerdict(r.m);
  return { bids: r.bids.slice(fromBid), myRank: r.m.myRank, believedCloseAt: r.m.believedCloseAt,
    extendsObserved: r.m.extendsObserved, revisionsLeft: r.m.revisionsLeft, verdict: v.verdict, reason: v.reason };
}

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  await check('1. an accepted submit with a rank schedules the next tick at once', async () => {
    const r = await middleShot();
    const last = r.delays[r.delays.length - 1];
    assert.strictEqual(last, 0, `the next tick was scheduled ${last} ms after the landing, not at once`);
  });

  await check('2. that tick decides with zero getAuctionState calls, on the response rank and close', async () => {
    const r = await middleShot();
    const readsBefore = r.reads.length;
    vnow += 5;
    await r.tick();
    const extra = r.reads.length - readsBefore;
    assert.strictEqual(extra, 0, `${extra} getAuctionState call(s) for the decision after an accepted, ranked submit`);
    assert.strictEqual(r.m.myRank, 2, `the tick decided on rank ${r.m.myRank}, not the response's 2`);
    assert.strictEqual(r.bids.length, 2, `expected the floor on that tick, placed ${JSON.stringify(r.bids.slice(1))}`);
  });

  await check('3. the same decision a read at the same instant produces', async () => {
    const on = await middleShot();
    const off = await middleShot({ responseState: false });
    vnow = on.ctrl.close - 7_000 + SUBMIT_MS + 5;
    await on.tick();
    vnow = off.ctrl.close - 7_000 + SUBMIT_MS + 5;
    await off.tick();
    assert.deepStrictEqual(outcome(on, 1), outcome(off, 1), 'the response state decided differently from a read');
    assert.strictEqual(on.bids[1].price, on.ladder[on.ladder.length - 1], 'the buzzer decision was not the floor');
  });

  await check('4. a response without a rank falls back to one normal read', async () => {
    const r = await middleShot({ responseRank: null });
    const readsBefore = r.reads.length;
    vnow += 5;
    await r.tick();
    assert.strictEqual(r.reads.length - readsBefore, 1, 'a rankless response did not fall back to exactly one read');
  });

  await check('5. a response state older than 1,500 ms is not used', async () => {
    const r = await middleShot();
    const readsBefore = r.reads.length;
    vnow += 1_600;
    await r.tick();
    assert.strictEqual(r.reads.length - readsBefore, 1, 'a stale response state was decided on without a read');
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-gocomet-response-state-saves-read:', e && e.message); process.exit(1); });
