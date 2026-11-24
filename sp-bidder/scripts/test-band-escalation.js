'use strict';
/**
 * Offline check for gap A2: the GoComet margin-band model on the SP engine.
 * No token, no network. Verifies:
 *   1. buildBandLadder maps explicit tiers (12.6/7.2/6.3%) straight to prices.
 *   2. bidEngine, armed with { cost, marginsPct }, escalates HIGH -> MED -> LOW
 *      through a hard close when held off rank 1, never bidding below the floor.
 *   3. The durable intent persists the band so a restart rebuilds the same ladder.
 *
 *   node scripts/test-band-escalation.js
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

// ---- 1) band ladder math ----
{
  const cost = 50_000;
  const { ladder, floor, opening } = buildBandLadder({ cost, marginsPct: [12.6, 7.2, 6.3] });
  assert.deepStrictEqual(ladder, [
    Math.round(cost * 1.126), // 56300 HIGH
    Math.round(cost * 1.072), // 53600 MEDIUM
    Math.round(cost * 1.063), // 53150 LOW
  ], 'three explicit tiers, descending');
  assert.strictEqual(opening, ladder[0], 'opening = HIGH');
  assert.strictEqual(floor, ladder[2], 'floor = LOW');
  // unordered input is normalised to descending
  assert.deepStrictEqual(buildBandLadder({ cost, marginsPct: [6.3, 12.6, 7.2] }).ladder, ladder, 'order-independent');
  ok('buildBandLadder: explicit 12.6/7.2/6.3 tiers, floor = lowest');
}

// ---- fake hard-close adapter that NEVER lets us reach rank 1 (forces full escalation) ----
function neverWinAdapter(closesAt) {
  let revs = 3;
  return {
    placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return {
        ok: true, status: Date.now() >= closesAt ? 'closed' : 'live',
        myRank: 2, totalBidders: 3, standingL1Price: null,
        closesInMs: Math.max(0, closesAt - Date.now()),
        revisionsLeft: revs, closeModel: 'hard', measuredRttMs: 50,
      };
    },
    async placeBid(id, price) {
      this.placed.push(price);
      revs = Math.max(0, revs - 1);
      return { accepted: true, myRank: 2, revisionsLeft: revs, latencyMs: 60 };
    },
  };
}

(async () => {
  // ---- 2) engine escalation HIGH -> MED -> LOW ----
  {
    const intents = path.join(os.tmpdir(), 'a2-esc-' + process.pid + '.json');
    const adapter = neverWinAdapter(Date.now() + 6_000);
    const scheduler = new DurableScheduler(intents);
    const engine = new BidEngine(adapter, scheduler, { config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true });
    const band = buildBandLadder({ cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }).ladder;

    engine.arm(
      { id: '7', lane: { origin: 'PUN', destination: 'BLR' }, equipment: '32ft', units: 1, closesAt: Date.now() + 6_000 },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 7_500));

    const placed = adapter.placed;
    console.log('    placed:', placed.join(' -> '), '| band:', band.join(' / '));
    assert.deepStrictEqual(placed, band, 'fired exactly HIGH, MEDIUM, LOW in order');
    assert.ok(placed.every((p) => p >= band[band.length - 1]), 'no bid below the floor (LOW)');
    const isDesc = placed.every((p, i) => i === 0 || p < placed[i - 1]);
    assert.ok(isDesc, 'strictly descending escalation');
    try { fs.unlinkSync(intents); } catch (_) {}
    ok('bidEngine escalates HIGH -> MED -> LOW off { cost, marginsPct }, floor held');
  }

  // ---- 3) durable band survives a restart (rehydrate rebuilds the same ladder) ----
  {
    const intents = path.join(os.tmpdir(), 'a2-rehy-' + process.pid + '.json');
    const far = Date.now() + 3_600_000; // far future so rehydrate re-arms it
    const band = buildBandLadder({ cost: 80_000, marginsPct: [12.6, 7.2, 6.3] }).ladder;

    // session 1: arm, then "crash" (just drop the engine; intent is on disk)
    {
      const sch = new DurableScheduler(intents);
      const eng = new BidEngine(neverWinAdapter(far), sch, {});
      const m = eng.arm({ id: '9', lane: { origin: 'X', destination: 'Y' }, units: 1, closesAt: far },
        { cost: 80_000, marginsPct: [12.6, 7.2, 6.3] });
      eng.stop('9'); // stop the timer; intent stays persisted
      const it = sch.get('9');
      assert.strictEqual(it.cost, 80_000, 'intent persisted cost');
      assert.deepStrictEqual(it.marginsPct, [12.6, 7.2, 6.3], 'intent persisted marginsPct');
    }
    // session 2: fresh scheduler reads the file; rehydrate rebuilds the band ladder
    {
      const sch2 = new DurableScheduler(intents);
      const eng2 = new BidEngine(neverWinAdapter(far), sch2, {});
      await eng2.rehydrate();
      const m = eng2.snapshot().find((x) => x.auctionId === '9');
      assert.ok(m, 'rehydrated the armed auction');
      assert.deepStrictEqual(m.ladder, band, 'rebuilt the identical band ladder after restart');
      eng2.stop('9');
    }
    try { fs.unlinkSync(intents); } catch (_) {}
    ok('durable band: rehydrate rebuilds the 12.6/7.2/6.3 ladder after a restart');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
