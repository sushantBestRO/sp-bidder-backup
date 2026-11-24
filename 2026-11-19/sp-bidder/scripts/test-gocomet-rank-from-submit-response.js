'use strict';
/**
 * GOCOMET: THE RANK OUR BID PRODUCED IS TAKEN FROM THE SUBMIT RESPONSE, AT LANDING.
 *
 * Regression target: GoComet's accepted submit returns the saved quote, and its quote_rank is our
 * rank on the price we just wrote (gocometAdapter maps it to myRank). The engine already copies it
 * onto the monitor, but rank_visible waited for the next rank-bearing bidding-data read - one GET on
 * a 1-per-second budget shared with autopilot, up to 5 s away outside the final seconds. Taking the
 * response costs no read and no slot, so the 429 cooldown and the read budget are untouched.
 *
 * Pinned (virtual Date.now, fake adapters, real BidEngine and DurableScheduler):
 *   1. GoComet shape (no myAmount): an accept whose response carries a rank stamps rank_visible at
 *      writeLandedAt, with that rank, and no read is issued for it.
 *   2. An accept whose response carries no rank still waits for a read (unchanged).
 *   3. SuperProcure shape (myAmount published): a response rank is not taken as visible; only the
 *      socket read showing our own amount stamps it (unchanged).
 *
 *   node scripts/test-gocomet-rank-from-submit-response.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;
const CLEAN = [];
process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + e.message); }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const FAR_MS = 30 * 60 * 1000;
let seq = 0;

function setup({ hasMyAmount, responseRank }) {
  const reads = [];
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      reads.push(vnow);
      const s = { ok: true, status: 'live', myRank: 2, totalBidders: null, standingL1Price: null, closesInMs: FAR_MS,
        revisionsLeft: 3, revisionLimit: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 };
      if (hasMyAmount) s.myAmount = null;
      return s;
    },
    placeBid: async () => { vnow += 1_100; return { accepted: true, myRank: responseRank, revisionsLeft: 2, latencyMs: 1_100 }; },
  };
  const f = path.join(os.tmpdir(), `gc-rank-response-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 2 * 60 * 60 * 1000, minInterFireMs: 0 },
    onEvent: (e) => events.push(e),
    log: quiet,
  });
  const m = engine.arm({ id: `GCR${seq}`, lane: { origin: 'Chikhli', destination: 'Noida' }, equipment: '32 ft MXL', units: 1,
    companyName: 'Waaree Energies Ltd.', closesAt: vnow + FAR_MS, startsAt: vnow - 1_000, status: 'live', softClose: false },
  { cost: 50_000, marginsPct: [9, 5, 1], minMarginPct: 1 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return { engine, m, adapter, reads, events };
}

async function landOne(s) {
  const state = await s.adapter.getAuctionState(s.m.auctionId);
  s.reads.length = 0;
  await s.engine._maybeBid(s.m, state);
  const placed = s.events.filter((e) => e.type === 'bid_placed');
  if (placed.length !== 1) throw new Error(`harness: expected one landed bid, saw ${placed.length}`);
  return placed[0];
}

(async () => {
  await check('1. GoComet shape: a ranked submit response stamps rank_visible at landing, with no read', async () => {
    const s = setup({ hasMyAmount: false, responseRank: 1 });
    const placed = await landOne(s);
    const v = s.events.find((e) => e.type === 'rank_visible');
    assert.ok(v, 'no rank_visible at landing although the submit response carried our rank');
    assert.strictEqual(v.rankVisibleAt, placed.writeLandedAt, `rank_visible ${v.rankVisibleAt - placed.writeLandedAt}ms after landing`);
    assert.strictEqual(v.decidedAt, placed.decidedAt, 'rank_visible does not match the bid it belongs to');
    assert.deepStrictEqual(s.reads, [], `${s.reads.length} read(s) were issued for it`);
    assert.strictEqual(s.m._pendingRankStamp, null, 'the marker is still waiting for a read');
    s.engine.kill('done');
  });

  await check('2. a submit response with no rank still waits for a read', async () => {
    const s = setup({ hasMyAmount: false, responseRank: null });
    await landOne(s);
    assert.strictEqual(s.events.find((e) => e.type === 'rank_visible'), undefined, 'stamped with no rank to stamp');
    vnow += 1_000;
    s.engine._maybeStampRankVisible(s.m, { myRank: 3 });
    assert.ok(s.events.find((e) => e.type === 'rank_visible'), 'the next ranked read no longer stamps it');
    s.engine.kill('done');
  });

  await check('3. SuperProcure shape: a response rank is not taken; the socket amount still decides', async () => {
    const s = setup({ hasMyAmount: true, responseRank: 1 });
    const placed = await landOne(s);
    assert.strictEqual(s.events.find((e) => e.type === 'rank_visible'), undefined, 'a response rank was taken on a platform that publishes our own amount');
    vnow += 40;
    s.engine._maybeStampRankVisible(s.m, { myRank: 1, myAmount: placed.price });
    assert.ok(s.events.find((e) => e.type === 'rank_visible'), 'the socket read showing our amount no longer stamps it');
    s.engine.kill('done');
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 3, `expected 3 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-gocomet-rank-from-submit-response:', e && e.message); process.exit(1); });
