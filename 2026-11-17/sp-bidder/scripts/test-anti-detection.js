'use strict';
/**
 * Offline check for gap A5: anti-detection guards (capped at "plausible human").
 * No token, no network.
 *   A. cadence jitter spreads the far/mid poll but leaves the snipe window crisp.
 *   B. bids/min cap halts a runaway re-firing loop (soft guard under the kill-switch).
 *   C. bidDifference honored: a step that doesn't clear minDecrement is skipped;
 *      the floor still fires.
 *   D. establish (first-bid) jitter fires the opening bid earlier than openAtMs, is
 *      rolled once per auction (stable), and collapses to openAtMs when off / jitter 0.
 *   E. read-time re-clamp: a stored minInterFireMs above the hard cap is clamped at engine
 *      ingest, so a value valid under an OLD cap can't delay the floor snipe until a re-save.
 *
 *   node scripts/test-anti-detection.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildBandLadder } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const tmp = (tag) => path.join(os.tmpdir(), `a5-${tag}-${process.pid}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- A. cadence jitter (deterministic via injected rand) ----
{
  const f = tmp('jit');
  const adapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }) };
  const eng = new BidEngine(adapter, new DurableScheduler(f), { rand: () => 0.5 }); // jitter = floor(0.5*250)=125
  assert.strictEqual(eng._cadence(70_000), 30_000 + 125, 'far cadence jittered');
  assert.strictEqual(eng._cadence(30_000), 1_000 + 125, 'mid cadence jittered');
  assert.strictEqual(eng._cadence(5_000), 200, 'snipe window NOT jittered (stays crisp)');
  const eng0 = new BidEngine(adapter, new DurableScheduler(f), { rand: () => 0 });
  assert.strictEqual(eng0._cadence(70_000), 30_000, 'rand=0 -> no jitter');
  try { fs.unlinkSync(f); } catch (_) {}
  ok('cadence jitter on far/mid, snipe window crisp');
}

// ---- D. establish (first-bid) jitter (deterministic via injected rand) ----
{
  const f = tmp('open');
  const adapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }) };
  const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15_000, openJitterMs: 6_000 }, rand: () => 0.5 });
  const mon = {}; // minimal fake monitor; _establishThreshold only reads _openAtFrac + cfg
  assert.strictEqual(eng._establishThreshold(mon), 18_000, 'establish fires earlier: openAtMs + floor(0.5*6000)');
  assert.strictEqual(eng._establishThreshold(mon), 18_000, 'rolled once per auction -> stable across ticks');
  // openJitterMs 0 -> exactly openAtMs (today's deterministic behaviour)
  const engFixed = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15_000, openJitterMs: 0 } });
  assert.strictEqual(engFixed._establishThreshold({}), 15_000, 'jitter 0 -> exactly openAtMs');
  // human-like OFF forces the establish mark back to fixed openAtMs
  eng.setAntiDetection({ enabled: false });
  assert.strictEqual(eng._establishThreshold({}), 15_000, 'human-like OFF -> fixed establish mark');
  try { fs.unlinkSync(f); } catch (_) {}
  ok('establish jitter fires earlier, rolled once, collapses to openAtMs when off');
}

// ---- E. read-time re-clamp of a stale over-cap minInterFireMs (F3) ----
// configStore rejects-at-write, but a value persisted under the OLD 1000ms cap survives
// configStore.get() un-re-validated and reaches the engine via setAntiDetection at boot. The
// engine re-clamps it to the same AD_LIMITS bound so it can't delay/skip the last-chance floor
// shot until the operator happens to re-save Settings.
{
  const { AD_LIMITS } = require('../src/admin/configStore');
  const f = tmp('clamp');
  const adapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }) };
  const eng = new BidEngine(adapter, new DurableScheduler(f), {});
  eng.setAntiDetection({ minInterFireMs: 500 }); // valid under the old 1000ms cap, above today's 150ms
  assert.strictEqual(AD_LIMITS.minInterFireMs.max, 150, 'ceiling is the single source of truth (configStore AD_LIMITS)');
  assert.strictEqual(eng.cfg.minInterFireMs, AD_LIMITS.minInterFireMs.max, 'stored 500 clamped to the 150ms ceiling at engine read');
  eng.setAntiDetection({ minInterFireMs: 120 }); // within the cap -> passes through untouched
  assert.strictEqual(eng.cfg.minInterFireMs, 120, 'a value within the cap is left unchanged');
  try { fs.unlinkSync(f); } catch (_) {}
  ok('read-time re-clamp: a stale over-cap minInterFireMs is capped at engine ingest');
}

// price-visible runaway adapter: standing price keeps dropping so the engine wants
// to re-bid EVERY tick -> exercises the bids/min cap.
function runawayAdapter() {
  let standing = 60_000;
  return {
    placed: [],
    capabilities: () => ({ standingPriceVisible: true, minDecrement: 100, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      standing -= 200; // someone keeps undercutting -> a fresh decision every tick
      return { ok: true, status: 'live', myRank: 2, totalBidders: 5, standingL1Price: standing,
        closesInMs: 8_000, revisionsLeft: null, closeModel: 'hard', measuredRttMs: 30 };
    },
    async placeBid(id, price) { this.placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
  };
}

// hard-close adapter that holds us at rank 2 (forces escalation through the ladder)
function neverWinAdapter(closesAt) {
  return {
    placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: 2, totalBidders: 3,
        standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: 3,
        closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) { this.placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 40 }; },
  };
}

(async () => {
  // ---- B. bids/min cap halts a runaway ----
  {
    const f = tmp('cap'); const adapter = runawayAdapter();
    const events = [];
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { maxBidsPerMin: 3 }, live: true, onEvent: (e) => events.push(e) });
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 60_000 }, { marketRate: 70_000, costFloor: 40_000 });
    await sleep(2_000);
    eng.kill();
    assert.strictEqual(adapter.placed.length, 3, 'stopped at the bids/min cap (3), not unbounded');
    assert.ok(events.some((e) => e.kind === 'bids_per_min_cap'), 'emitted the rate-cap alert');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('bids/min cap halts a runaway re-firing loop');
  }

  // ---- C. bidDifference honored: a sub-decrement middle rung is RE-SPACED, not silently skipped ----
  {
    const f = tmp('decr'); const closesAt = Date.now() + 6_000;
    const adapter = neverWinAdapter(closesAt);
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true });
    // ladder with a sub-minDecrement gap between HIGH and MEDIUM (10 < 100)
    const ladder = buildBandLadder({ cost: 10_000, marginsPct: [12.6, 12.5, 6.3] }).ladder; // [11260, 11250, 10630]
    assert.strictEqual(ladder[0] - ladder[1], 10, 'fixture: HIGH-MED gap is 10 (< minDecrement 100)');
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt }, { cost: 10_000, marginsPct: [12.6, 12.5, 6.3] });
    // This case used to assert [HIGH, floor] - the MED rung silently never bid, and nothing anywhere
    // said so. That silence is the defect the plan-time derivation removes: rather than arm a price
    // the platform would refuse and discard it every tick, the middle rung is placed at the latest
    // legal price under HIGH, so the desk gets the three attempts it asked for. The two anchors the
    // desk authorised - its top margin and its operating price - still never move.
    assert.deepStrictEqual(eng.monitors.get('1').ladder, [11_260, 11_160, 10_630],
      'the middle rung is re-spaced down to clear the 100 minimum; the anchors are untouched');
    await sleep(7_500);
    assert.deepStrictEqual(adapter.placed, [11_260, 11_160, 10_630], 'all three prices reach the wire');
    for (let i = 1; i < adapter.placed.length; i++) {
      assert.ok(adapter.placed[i - 1] - adapter.placed[i] >= 100,
        `placed step ${adapter.placed[i - 1]} -> ${adapter.placed[i]} clears the 100 minimum`);
    }
    try { fs.unlinkSync(f); } catch (_) {}
    ok('bidDifference honored: a sub-decrement middle rung is re-spaced so it can fire, not dropped in silence');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
