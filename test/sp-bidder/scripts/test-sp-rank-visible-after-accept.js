'use strict';
/**
 * SUPERPROCURE: THE RANK OUR BID PRODUCED IS READ AS SOON AS THE SOCKET SHOWS IT, NOT A WHOLE POLL LATER.
 *
 * Regression target: after every accepted bid the engine goes blind until its next scheduled tick.
 * Box logs, 16-24 Sep 2026 (v2.14.2): improved rank visible p50 1,199 ms / p90 2,061 ms after the
 * accept in the hot hard-close window. The closed-bids write that stalled the thread for ~1 s is
 * gone (86f9309, pinned by test-bid-record-does-not-stall-tick.js), but the engine still waits out a
 * full pollHotMs (200 ms) after the tick that fired before it reads again. On SuperProcure that read
 * is a lookup in the socket's own cache, so the wait is dead time: the frame showing our bid is
 * already there, and the walk cannot take its next step until a tick reads it.
 *
 * Pinned, on a fake clock (virtual Date.now and setTimeout; nothing sleeps):
 *   1. SuperProcure shape (state carries myAmount and says it is push-fed): for socket frames that
 *      show our own amount 0, 30 and 120 ms after the accept, the rank_visible stamp lands within
 *      FOLLOW_SLACK_MS of the frame.
 *   2. The tick that sees the frame runs the ordinary decision path: a load outranked on that frame
 *      steps down on it, with no second tick needed.
 *   3. A frame that never shows our amount pulls no tick forward: the same writes go out at the same
 *      times as on a state that is not push-fed, where nothing follows.
 *   4. A state that is not push-fed (GoComet, mock) gets no extra reads after an accept.
 *   5. The extra reads after an accept stop by rankSettleMs even when our amount never appears.
 *
 * Offline: fake adapter, real BidEngine, real DurableScheduler on a temp file.
 *
 *   node scripts/test-sp-rank-visible-after-accept.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 5;
let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) {
    if (/^harness:/.test(e.message)) throw e;
    fail++; console.log('  FAIL ' + name + ': ' + e.message);
  }
}

const WRITE_MS = 150;
const FOLLOW_SLACK_MS = 50;
const FRAMES_MS = [0, 30, 120];
const CLOSE_IN_MS = 9_000;
const OPEN_AT_MS = 8_000;
const COST = 100_000;
const BAND = [9, 5, 1];

const REAL_NOW = Date.now;
const REAL_SET = global.setTimeout;
const REAL_CLEAR = global.clearTimeout;
let vnow = REAL_NOW();
const timers = new Map();
let tseq = 0;
function fakeSetTimeout(fn, ms, ...args) {
  const id = ++tseq;
  timers.set(id, { id, at: vnow + Math.max(0, Number(ms) || 0), fn, args });
  return { _fakeId: id, unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
}
function fakeClearTimeout(h) { if (h && h._fakeId != null) timers.delete(h._fakeId); }
Date.now = () => vnow;
global.setTimeout = fakeSetTimeout;
global.clearTimeout = fakeClearTimeout;
const yieldReal = () => new Promise((r) => setImmediate(r));

async function runUntil(endAt) {
  for (let steps = 0; steps < 200_000; steps++) {
    for (let i = 0; i < 4; i++) await yieldReal();
    let next = null;
    for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
    if (!next || next.at > endAt) { vnow = Math.max(vnow, endAt); return; }
    timers.delete(next.id);
    vnow = Math.max(vnow, next.at);
    next.fn(...next.args);
  }
  throw new Error('harness: fake timer loop did not settle');
}

const CLEAN = [];
let fseq = 0;
process.on('exit', () => {
  Date.now = REAL_NOW; global.setTimeout = REAL_SET; global.clearTimeout = REAL_CLEAR;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});
const tmp = () => {
  const f = path.join(os.tmpdir(), `sp-rank-follow-${process.pid}-${fseq++}.json`);
  CLEAN.push(f, f + '.tmp');
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// One hard-close load in its hot window. The first write lands WRITE_MS after it is sent; the socket
// frame carrying our own amount arrives frameMs after that (never, when frameMs is null). Before the
// frame the load reads outranked at the amount it had; on the frame it reads `rankOnFrame` at our
// new price. `pushFed` and `hasMyAmount` choose the SuperProcure or the GoComet state shape.
async function run({ frameMs, pushFed = true, hasMyAmount = true, rankOnFrame = 1, horizonMs = 2_500 }) {
  const id = `SPF${fseq}`;
  const closeAt = vnow + CLOSE_IN_MS;
  const reads = [];
  const writes = [];
  const events = [];
  let frameAt = null;
  let shown = null;
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 10, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      reads.push(vnow);
      if (frameAt != null && vnow >= frameAt) shown = { rank: rankOnFrame, amount: writes[writes.length - 1].price };
      const s = { ok: true, status: 'live', myRank: shown ? shown.rank : 2, totalBidders: 4, standingL1Price: null,
        closesInMs: closeAt - vnow, revisionsLeft: null, revisionLimit: 10, closeModel: 'hard', measuredRttMs: 40,
        minDecrement: 100 };
      if (hasMyAmount) s.myAmount = shown ? shown.amount : null;
      if (pushFed) s.pushFed = true;
      return s;
    },
    placeBid: async (_id, price) => {
      const w = { price, sentAt: vnow };
      writes.push(w);
      await new Promise((r) => setTimeout(r, WRITE_MS));
      w.landedAt = vnow;
      if (writes.length === 1 && frameMs != null) frameAt = vnow + frameMs;
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: WRITE_MS };
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: OPEN_AT_MS, openJitterMs: 0, cadenceJitterMs: 0, minInterFireMs: 150 },
    onEvent: (e) => events.push(Object.assign({ at: vnow }, e)),
    log: quiet,
  });
  const start = vnow;
  engine.arm({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: '32 ft MXL', units: 1,
    companyName: 'Havells India Ltd', closesAt: closeAt, startsAt: vnow - 1_000, status: 'live', softClose: false },
  { cost: COST, marginsPct: BAND, minMarginPct: 1 });
  await runUntil(start + horizonMs);
  engine.kill('test done');
  await runUntil(vnow + 100);
  const first = writes[0];
  if (!first || first.landedAt == null) throw new Error(`harness: no write landed for frame ${frameMs}`);
  const placed = events.filter((e) => e.type === 'bid_placed');
  const visible = events.find((e) => e.type === 'rank_visible');
  return {
    first, writes, reads, frameAt,
    writeLandedAt: placed[0] && placed[0].writeLandedAt,
    rankVisibleAt: visible ? visible.rankVisibleAt : null,
    readsAfterLanding: reads.filter((t) => t > first.landedAt),
  };
}

(async () => {
  const cfg = new BidEngine(adapterStub(), new DurableScheduler(tmp()), { log: quiet }).cfg;

  await check('1. SuperProcure shape: rank_visible lands within 50ms of the frame that shows our own amount', async () => {
    const lags = [];
    const late = [];
    for (const frameMs of FRAMES_MS) {
      const r = await run({ frameMs });
      if (r.writeLandedAt !== r.first.landedAt) throw new Error(`harness: bid_placed.writeLandedAt is not the landing instant (frame ${frameMs})`);
      if (r.rankVisibleAt == null) throw new Error(`frame ${frameMs}ms: the rank our bid produced never became visible`);
      const sinceFrame = r.rankVisibleAt - r.frameAt;
      lags.push(`${frameMs}ms frame -> visible ${r.rankVisibleAt - r.writeLandedAt}ms after landing`);
      if (!(sinceFrame >= 0 && sinceFrame <= FOLLOW_SLACK_MS)) late.push(`frame ${frameMs}ms: ${sinceFrame}ms after the frame`);
    }
    console.log(`       decision -> land ${WRITE_MS}ms; ${lags.join('; ')}`);
    assert.deepStrictEqual(late, [], `rank_visible came more than ${FOLLOW_SLACK_MS}ms after the frame: ${late.join('; ')}`);
  });

  await check('2. the tick that reads the frame runs the ordinary decision and steps down on an outranked frame', async () => {
    const r = await run({ frameMs: 30, rankOnFrame: 3 });
    const second = r.writes[1];
    assert.ok(second, 'the load was outranked on the frame and nothing else went out');
    assert.ok(second.price < r.first.price, 'the second write is not a step down');
    assert.ok(second.sentAt - r.frameAt <= FOLLOW_SLACK_MS,
      `the step-down on the outranked frame went out ${second.sentAt - r.frameAt}ms after the frame, over ${FOLLOW_SLACK_MS}ms`);
  });

  const followed = await run({ frameMs: null });
  const plain = await run({ frameMs: null, pushFed: false });
  const since = (r, t) => t - r.first.landedAt;

  await check('3. a frame that never shows our amount pulls no tick forward: the same writes at the same times as with no following', async () => {
    const shape = (r) => r.writes.map((w) => [w.price, since(r, w.sentAt)]);
    assert.deepStrictEqual(shape(followed), shape(plain),
      `push-fed ${JSON.stringify(shape(followed))} against not push-fed ${JSON.stringify(shape(plain))}`);
  });

  await check('4. a state that is not push-fed gets no extra read after an accept', async () => {
    const r = await run({ frameMs: 30, pushFed: false, hasMyAmount: false });
    const early = r.readsAfterLanding.filter((t) => since(r, t) < cfg.pollHotMs);
    assert.deepStrictEqual(early.map((t) => since(r, t)), [],
      `read before the regular ${cfg.pollHotMs}ms tick (ms after landing)`);
  });

  await check('5. the extra reads after an accept stop by rankSettleMs when our amount never appears', async () => {
    const regular = new Set(plain.readsAfterLanding.map((t) => since(plain, t)));
    const extra = followed.readsAfterLanding.filter((t) => !regular.has(since(followed, t)));
    const sinceLatestLanding = (t) => t - Math.max(...followed.writes.filter((w) => w.landedAt <= t).map((w) => w.landedAt));
    const past = extra.map(sinceLatestLanding).filter((d) => d > cfg.rankSettleMs);
    assert.deepStrictEqual(past, [], `extra reads more than rankSettleMs (${cfg.rankSettleMs}ms) after the landing before them`);
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-sp-rank-visible-after-accept:', e && e.message); process.exit(1); });

function adapterStub() {
  return { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }) };
}
