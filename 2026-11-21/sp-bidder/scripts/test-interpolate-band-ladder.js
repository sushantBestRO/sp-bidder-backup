'use strict';
/**
 * Anchor-preserving rung interpolation (pricing.interpolateBandLadder) - the pricing half of Layer 3.
 * It builds buildBandLadder first (exact anchors + floor), then INSERTS fine rungs strictly between
 * adjacent anchors, then drops the tightest inserted rungs until every adjacent pair clears the
 * platform's minimum decrement. It must NEVER move an anchor (the bug buildMarginLadder has, which
 * shifts the middle anchor ~Rs 81 on the live band).
 *
 * Reference load: cost 18000 on the live 12.6 / 7.2 / 2.7 band -> anchors [20268, 19296, 18486].
 *
 *   node scripts/test-interpolate-band-ladder.js
 */
const assert = require('assert');
const { buildBandLadder, interpolateBandLadder } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const COST = 18000;
const MARGINS = [12.6, 7.2, 2.7];
const MIN = 2.7;
const ANCHORS = [20268, 19296, 18486]; // what buildBandLadder pins for this load
const FLOOR = 18486;

const minGap = (l) => { let g = Infinity; for (let x = 1; x < l.length; x++) g = Math.min(g, l[x - 1] - l[x]); return g; };
const descending = (l) => l.every((p, x) => x === 0 || p < l[x - 1]);

// buildBandLadder is the anchor source of truth.
{
  const band = buildBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN });
  assert.deepStrictEqual(band.ladder, ANCHORS, 'reference band is [20268, 19296, 18486]');
  ok('reference band ladder is 20268 / 19296 / 18486 (the anchors interpolation must preserve)');
}

// 1. rungs=6, narrow decrement: a fully expanded, deterministic ladder. Pins the proportional split
//    (972 vs 810 wide gap -> 2 inserts in the top gap, 1 in the bottom; leftover to the widest gap).
{
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: 100 });
  assert.deepStrictEqual(ladder, [20268, 19944, 19620, 19296, 18891, 18486],
    'six rungs inserted proportionally to gap width, leftover to the widest gap');
  ok('rungs=6 / minDec=100 builds [20268, 19944, 19620, 19296, 18891, 18486]');

  for (const a of ANCHORS) assert.ok(ladder.includes(a), `anchor ${a} preserved exactly`);
  ok('every configured-margin anchor (20268, 19296, 18486) is present, unmoved');

  assert.strictEqual(ladder[ladder.length - 1], FLOOR, 'floor is the last rung');
  ok('the floor 18486 is still the last rung');

  assert.ok(descending(ladder), 'strictly descending');
  assert.ok(minGap(ladder) >= 100, `no adjacent pair below minDecrement 100 (tightest ${minGap(ladder)})`);
  ok('strictly descending and no adjacent pair below the minimum decrement');

  assert.ok(ladder.length > ANCHORS.length && ladder.length <= 6, 'count grew toward the target');
  ok('rung count grew from 3 toward the requested 6');
}

// 2. A wider decrement drops some inserted rungs but never an anchor. minDec=400 keeps the 405 inserts,
//    drops the 324 ones -> exactly one inserted rung survives, above the floor.
{
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: 400 });
  assert.deepStrictEqual(ladder, [20268, 19296, 18891, 18486],
    'the sub-400 inserts are dropped, the 405-gap insert survives, anchors intact');
  for (const a of ANCHORS) assert.ok(ladder.includes(a), `anchor ${a} preserved under the wider decrement`);
  assert.strictEqual(ladder[ladder.length - 1], FLOOR, 'floor still last');
  assert.ok(minGap(ladder) >= 400, `no adjacent pair below 400 (tightest ${minGap(ladder)})`);
  assert.ok(descending(ladder), 'strictly descending');
  ok('a wider decrement (400) drops only inserted rungs; anchors + floor survive, all gaps >= 400');
}

// 3. A decrement so wide no insert can survive collapses back to exactly the anchor band.
{
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: 500 });
  assert.deepStrictEqual(ladder, ANCHORS, 'every inserted rung is under 500, so the ladder collapses to the anchors');
  ok('a decrement wider than every possible insert collapses back to the plain anchor band');
}

// 4. rungs <= anchor count returns the plain buildBandLadder result, byte-for-byte.
{
  const band = buildBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN });
  for (const rungs of [3, 2, 1]) {
    const got = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs, minDecrement: 100 });
    assert.deepStrictEqual(got.ladder, band.ladder, `rungs=${rungs} (<= 3 anchors) returns the plain band ladder`);
    assert.deepStrictEqual(got, band, `rungs=${rungs} returns the full buildBandLadder object unchanged`);
  }
  ok('rungs <= anchor count returns buildBandLadder byte-identical (no interpolation)');
}

// 5. A non-finite / missing target is treated as "do not interpolate".
{
  const band = buildBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN });
  for (const bad of [undefined, null, NaN]) {
    const got = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: bad, minDecrement: 100 });
    assert.deepStrictEqual(got.ladder, band.ladder, `rungs=${String(bad)} returns the plain band`);
  }
  ok('a non-finite rung target returns the plain band (never NaN rungs)');
}

// 6. A finer target with a 4-margin band: all four desk margins stay biddable after interpolation.
{
  const margins4 = [12.6, 10, 7.2, 2.7];
  const anchors4 = buildBandLadder({ cost: COST, marginsPct: margins4, minMarginPct: MIN }).ladder;
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: margins4, minMarginPct: MIN, rungs: 8, minDecrement: 100 });
  for (const a of anchors4) assert.ok(ladder.includes(a), `4-band anchor ${a} preserved`);
  assert.strictEqual(ladder[ladder.length - 1], anchors4[anchors4.length - 1], 'floor still last on the 4-band');
  assert.ok(descending(ladder) && minGap(ladder) >= 100, 'strictly descending, clears 100');
  assert.ok(ladder.length > anchors4.length && ladder.length <= 8, 'count grew toward 8');
  ok('a 4-margin band interpolated to 8 keeps all four anchors + floor, gaps clear the decrement');
}

console.log(`\n${pass}/11 checks passed`);
process.exit(0);
