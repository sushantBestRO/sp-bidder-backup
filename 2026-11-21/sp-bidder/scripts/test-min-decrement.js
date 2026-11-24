'use strict';
/**
 * Regression: the engine must honor the PER-LOAD minimum decrement (SuperProcure's "Bid
 * Difference", seen live as both 100 and 1500), not a hardcoded 100. On a 1500-decrement load a
 * step only ~800 below our last bid would clear a wrong 100 guard, fire, get rejected, and the
 * reject branch consumes the rung - marching the ladder down early and giving away margin.
 *
 *   node scripts/test-min-decrement.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const os = require('os');
const path = require('path');
const fs = require('fs');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // 1. getAuctionState surfaces the per-load Bid Difference from loadMeta
  {
    const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
    a.account = { carrierId: 2667, branchIds: [1], serverTimeOffsetMs: 0 };
    // prime loadMeta as listAuctions would (loadBidDifference 1500)
    a.loadMeta.set('99', { id: '99', closesAt: Date.now() + 60000, revisionLimit: 3, minDecrement: 1500, softClose: false });
    const st = await a.getAuctionState('99');
    assert.strictEqual(st.minDecrement, 1500, 'per-load minDecrement surfaced (was omitted before)');
    ok('getAuctionState surfaces the per-load Bid Difference (1500), not a static 100');
  }

  // 2. the engine's step guard uses state.minDecrement: a step within the per-load decrement of
  //    our last bid is NOT fired (so it can't be rejected + consume the rung)
  {
    const f = path.join(os.tmpdir(), `mindec-${process.pid}.json`);
    const placed = [];
    // ladder rungs ~800 apart; per-load decrement 1500 -> a step is un-fireable until it clears 1500
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        return { ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
          closesInMs: 8000, revisionLimit: 3, revisionsLeft: null, minDecrement: 1500, closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15000, floorWindowMs: 2500, minInterFireMs: 0 }, live: true, rand: () => 0 });
    const m = eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 8000 },
      { cost: 40000, marginsPct: [8, 7.5, 6] }); // rungs ~ [43200, 43000, 42400] -> gaps < 1500
    // establish rung 0
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    const afterEstablish = placed.length;
    // next tick: a step to rung 1 sits < 1500 below rung 0 -> must be skipped, not fired+rejected
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    eng.kill();
    // whatever was placed, no two consecutive placed prices may sit within the per-load decrement
    for (let i = 1; i < placed.length; i++) {
      const gap = placed[i - 1] - placed[i];
      assert.ok(gap <= 0 || gap >= 1500, `no step violates the per-load 1500 decrement (gap ${gap} between ${placed[i-1]} and ${placed[i]})`);
    }
    ok('engine skips a step that would violate the per-load decrement (no fired-then-rejected rung)');
    try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log(`\n${pass}/2 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
