'use strict';
/**
 * Regression: the cost floor is the ONE money invariant - the engine must never bid below the
 * operator's true cost. Guards:
 *   1. a zero/negative minMarginPct (env typo like SP_MIN_MARGIN_PCT=-5, or a stale config doc
 *      that bypasses the dashboard-save validation) must NOT pull the operating floor below cost.
 *   2. a non-finite cost (a pasted "1e999" -> Infinity) must be rejected, not armed as an
 *      absurd [Infinity] ladder with an inert floor invariant.
 *   3. capture() must refuse to mark a request 'armed' unless a bid plan actually builds, so a
 *      broken margin band never leaves a load falsely-armed with no engine monitor behind it.
 *
 *   node scripts/test-cost-floor-guard.js
 */
const assert = require('assert');
const { buildBandLadder } = require('../src/engine/pricing');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store/memoryStore');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // 1. negative minMarginPct clamps to true cost (never a guaranteed-loss floor)
  {
    const cost = 100000;
    const plan = buildBandLadder({ cost, marginsPct: [12.6, 7.2, 6.3], minMarginPct: -5 });
    assert.ok(plan.floor >= cost, `floor ${plan.floor} must be >= true cost ${cost} despite minMarginPct -5`);
    assert.ok(plan.ladder.every((p) => p >= cost), 'every rung stays at or above true cost');
    ok('negative minMarginPct clamps the operating floor to true cost (no sub-cost bid)');
  }

  // 1b. zero minMarginPct -> the guard sits at cost; the floor is the band bottom, never below cost
  {
    const plan = buildBandLadder({ cost: 50000, marginsPct: [10, 6], minMarginPct: 0 });
    assert.strictEqual(plan.floor, 53000, 'zero margin leaves the floor at the band bottom');
    assert.ok(plan.ladder.every((p) => p >= 50000), 'every rung stays at or above true cost');
    ok('zero minMarginPct floors at the band bottom, never below true cost');
  }

  // 2. non-finite cost is rejected
  {
    assert.throws(() => buildBandLadder({ cost: Infinity, marginsPct: [12.6, 6.3] }), /finite/,
      'Infinity cost must throw, not build an [Infinity] ladder');
    assert.throws(() => buildBandLadder({ cost: NaN, marginsPct: [12.6, 6.3] }), /finite/);
    ok('non-finite cost (Infinity/NaN) is rejected at ladder build');
  }

  // 3. capture() refuses to arm on a non-buildable band (no false-armed state)
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [NaN, NaN], minMarginPct: NaN }); // env-typo band
    const load = { id: '22365292', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: Date.now() + 600000, softClose: false };
    const req = await requests.createForLoad(load);
    await assert.rejects(() => requests.capture(req.id, { cost: 50000 }), /not buildable|finite/,
      'capture must reject a bad band instead of falsely arming');
    const after = await requests.getByToken(req.id);
    assert.strictEqual(after.status, 'awaiting_price', 'request stays open (NOT falsely "armed") when the plan cannot build');
    ok('capture refuses to mark armed when no bid plan builds (no silent missed auction)');
  }

  // 3b. non-finite captured cost is rejected too
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    const load = { id: '2', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: Date.now() + 600000, softClose: false };
    const req = await requests.createForLoad(load);
    await assert.rejects(() => requests.capture(req.id, { cost: '1e999' }), /finite/, 'Infinity cost rejected at capture');
    ok('capture rejects a non-finite cost');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
