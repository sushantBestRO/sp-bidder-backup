'use strict';
/**
 * Adversarial edge + hostile-input hardening for pricing.interpolateBandLadder.
 *
 * Companion to scripts/test-interpolate-band-ladder.js (which pins the happy paths: proportional
 * insert counts, the min-decrement drop pass, anchor pinning). This file does NOT re-cover those.
 * It attacks the edges that price real live-money bids, where a wrong price is money lost:
 *   - null / undefined / zero / NaN / negative decrement + rung targets
 *   - zero-width margin gaps, non-monotonic desk-typo margin order
 *   - a decrement wider than the whole band span (collapse-to-anchors)
 *   - rounding integrity: every price integral, and NO adjacent gap re-created below the decrement
 *     AFTER rounding + drops (SuperProcure rejects sub-decrement revisions - this is the killer)
 *   - a negative operating margin (must clamp to true cost, never a below-cost bid)
 *   - proportional allocation, floor/anchor never dropped, bounded growth under huge rung targets
 *
 * Global invariant asserted on every case: strictly descending, no NaN/undefined, floor last,
 * anchors present exactly.
 *
 * Golden values were captured from the real implementation and then hand-verified against the
 * contract (cost x (1 + margin/100), rounded; inserts evenly spaced strictly between anchors),
 * so each pin is a checked expectation, not a re-implementation.
 *
 *   node scripts/test-interpolate-edges.js
 */
const assert = require('assert');
const { buildBandLadder, interpolateBandLadder } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// --- shared derivations (hand-checked, not read back from the impl) ---
const COST = 18000;
const MARGINS = [12.6, 7.2, 2.7];      // live band
const MIN = 2.7;
const ANCHORS = [20268, 19296, 18486]; // round(18000*1.126), round(18000*1.072), round(18000*1.027)
const FLOOR = 18486;

// --- invariant helpers (kept dumb; the interesting logic lives under test) ---
const minGap = (l) => { let g = Infinity; for (let x = 1; x < l.length; x++) g = Math.min(g, l[x - 1] - l[x]); return g; };
const descending = (l) => l.every((p, x) => x === 0 || p < l[x - 1]);
const allInteger = (l) => l.every((p) => Number.isInteger(p));
const noBad = (l) => l.length > 0 && l.every((p) => typeof p === 'number' && Number.isFinite(p));
const noDup = (l) => new Set(l).size === l.length;
const insertsBetween = (l, hi, lo) => l.filter((p) => p < hi && p > lo).length;

// =====================================================================================
// Behaviors 3 + 4: a null / undefined / zero decrement means "no meaningful decrement".
// The default threshold folds in strict-descending dedup (=1) so the ladder still fully
// expands to the requested rungs with no anchor-preserving drops.
// =====================================================================================
{
  // Arrange
  const FULL = [20268, 19944, 19620, 19296, 18891, 18486]; // rungs=6 fully expanded, nothing dropped
  for (const dec of [null, undefined, 0]) {
    // Act
    const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: dec });
    // Assert
    // catches: default-threshold constant replaced (1 -> large) would collapse this back to 3 anchors;
    //          and dropping the Number.isFinite guard -> threshold undefined -> `gap >= undefined` NaN
    //          -> every pair treated as violating -> collapse. Either way this deepEqual fails.
    assert.deepStrictEqual(ladder, FULL, `minDecrement=${String(dec)} must fully expand (no drops)`);
    assert.ok(descending(ladder), `minDecrement=${String(dec)} must stay strictly descending`);
  }
  ok('should fully expand with no drops when minDecrement is null, undefined, or 0 (default threshold)');
}

// =====================================================================================
// Behavior 5: two adjacent margins equal (desk enters 7.2 twice). Must never emit a
// duplicate price or a NaN, and never crash.
// =====================================================================================
{
  // Arrange
  const dupMargins = [10, 7.2, 7.2, MIN]; // 7.2 collapses at the band level -> anchors [19800, 19296, 18486]
  const dupAnchors = [19800, 19296, 18486];
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: dupMargins, minMarginPct: MIN, rungs: 6, minDecrement: 100 });
  // Assert
  // catches: dropped dedup -> a repeated 19296 anchor would appear (noDup fails); a NaN insert (noBad fails)
  assert.deepStrictEqual(ladder, [19800, 19548, 19296, 19026, 18756, 18486], 'equal margins must not produce duplicate or NaN prices');
  assert.ok(noDup(ladder), 'no duplicate prices despite two equal margins');
  assert.ok(noBad(ladder), 'no NaN/undefined price despite a zero-width margin');
  assert.strictEqual(ladder[ladder.length - 1], 18486, 'floor still last with a duplicated margin');
  for (const a of dupAnchors) assert.ok(ladder.includes(a), `anchor ${a} present with duplicated margin`);
  ok('should never emit a duplicate or NaN price when two margins are equal');
}

// =====================================================================================
// Behavior 6: minDecrement wider than the WHOLE band span. Every insert is under it and
// gets dropped; the ladder collapses to exactly the anchors (an anchor-anchor gap under
// the decrement is left in place - the desk's own margins are too close, not ours to hide).
// =====================================================================================
{
  // Arrange
  const narrow = [7.5, 7.2, 7.0]; // anchors [19350, 19296, 19260]; whole span is only 90 wide
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: narrow, minMarginPct: 7.0, rungs: 6, minDecrement: 1000 });
  // Assert
  // catches: removal of the anchor-anchor "leave alone" skip -> it would drop anchors (incl. the floor)
  //          and length would fall below 3 / lose the floor.
  assert.deepStrictEqual(ladder, [19350, 19296, 19260], 'a span-wide decrement collapses to the anchors only');
  assert.strictEqual(ladder.length, 3, 'every inserted rung dropped, anchors survive - exactly 3 rungs');
  assert.strictEqual(ladder[ladder.length - 1], 19260, 'floor survives as last even though its 36-gap is under the 1000 decrement');
  assert.ok(descending(ladder), 'collapsed ladder still strictly descending');
  ok('should collapse to anchors-only (floor kept) when the decrement exceeds the whole span');
}

// =====================================================================================
// Behavior 7a: rounding integrity with repeating decimals - every price integral, and
// gaps clear the decrement AFTER rounding (no drops needed here).
// =====================================================================================
{
  // Arrange
  const RCOST = 18333; // round(18333*1.126)=20643, *1.072=19653, *1.027=18828
  // Act
  const { ladder } = interpolateBandLadder({ cost: RCOST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: 300 });
  // Assert
  // catches: Math.round dropped on inserts -> fractional prices (allInteger fails, e.g. 19240.5);
  //          min-dec pass reading pre-rounding gaps -> a sub-300 gap could survive (minGap fails).
  assert.deepStrictEqual(ladder, [20643, 20313, 19983, 19653, 19241, 18828], 'repeating-decimal cost rounds to a clean integer ladder');
  assert.ok(allInteger(ladder), 'every price is an integer (rounding contract)');
  assert.ok(minGap(ladder) >= 300, `every rounded gap clears the 300 decrement (tightest ${minGap(ladder)})`);
  assert.ok(descending(ladder), 'strictly descending after rounding');
  ok('should keep prices integral and gaps >= decrement after rounding a repeating-decimal cost');
}

// =====================================================================================
// Behavior 7b: the killer edge - rounding + a forced drop pass. Some inserts violate the
// decrement and are dropped; the SURVIVING ladder must still have every adjacent gap >=
// the decrement (rounding must not re-create a sub-decrement gap that SuperProcure rejects).
// =====================================================================================
{
  // Arrange
  const RCOST = 18333;
  // Act
  const { ladder } = interpolateBandLadder({ cost: RCOST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 8, minDecrement: 260 });
  // Assert
  // catches: drop pass stopping early / dropping the wrong endpoint -> a sub-260 gap survives (minGap fails);
  //          off-by-one leaving one too many inserts (length + minGap both diagnostic).
  assert.deepStrictEqual(ladder, [20643, 20148, 19653, 19378, 19103, 18828], 'sub-260 inserts dropped, survivors all clear 260');
  assert.ok(minGap(ladder) >= 260, `no adjacent gap under 260 after rounding + drops (tightest ${minGap(ladder)})`);
  assert.ok(ladder.length < 8, 'the drop pass actually fired (fewer than the requested 8 rungs)');
  assert.ok(allInteger(ladder), 'survivors are integral');
  for (const a of [20643, 19653, 18828]) assert.ok(ladder.includes(a), `anchor ${a} kept through the drop pass`);
  assert.strictEqual(ladder[ladder.length - 1], 18828, 'floor last after the drop pass');
  ok('should never leave a sub-decrement gap after rounding + drops (SP-reject guard)');
}

// =====================================================================================
// Behavior 8: proportional allocation - the wider rupee gap receives more inserted rungs.
// =====================================================================================
{
  // Arrange
  const wideNarrow = [20, 8, 6]; // anchors [21600, 19440, 19080]; top gap 2160 wide, bottom gap 360 narrow
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: wideNarrow, minMarginPct: 6, rungs: 10, minDecrement: null });
  // Assert
  // catches: proportional split inverted / width mis-weighted -> the narrow gap would get >= the wide one.
  const top = insertsBetween(ladder, 21600, 19440);
  const bottom = insertsBetween(ladder, 19440, 19080);
  assert.strictEqual(top, 6, 'the 2160-wide top gap receives 6 inserts');
  assert.strictEqual(bottom, 1, 'the 360-narrow bottom gap receives 1 insert');
  assert.ok(top > bottom, `wider rupee gap must get strictly more inserts (${top} vs ${bottom})`);
  assert.strictEqual(ladder[ladder.length - 1], 19080, 'floor last on the proportional split');
  assert.ok(descending(ladder), 'proportional ladder strictly descending');
  ok('should allocate more inserted rungs to the wider rupee gap');
}

// =====================================================================================
// Behavior 9: the floor is never dropped, even under an aggressive decrement that drops
// every insert. Floor == the exact minMarginPct price and stays last.
// =====================================================================================
{
  // Arrange
  const band = buildBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN });
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: 100000 });
  // Assert
  // catches: anchor/floor protection removed -> the floor (an anchor) could be spliced out.
  assert.strictEqual(ladder[ladder.length - 1], FLOOR, 'floor is the last rung under an aggressive decrement');
  assert.strictEqual(ladder[ladder.length - 1], band.floor, 'last rung equals buildBandLadder.floor exactly');
  assert.strictEqual(ladder.filter((p) => p === FLOOR).length, 1, 'the floor appears exactly once');
  ok('should keep the floor as the exact, last rung when an aggressive decrement drops all inserts');
}

// =====================================================================================
// Behavior 10: the anchors are never dropped in the same aggressive scenario - every
// configured margin stays biddable.
// =====================================================================================
{
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 6, minDecrement: 100000 });
  // Assert
  // catches: anchor-anchor drop (removing the both-anchor skip) -> an anchor vanishes; length != 3.
  assert.deepStrictEqual(ladder, ANCHORS, 'collapses to exactly the three anchors, none dropped');
  for (const a of ANCHORS) assert.strictEqual(ladder.filter((p) => p === a).length, 1, `anchor ${a} present exactly once`);
  ok('should preserve every anchor exactly when an aggressive decrement drops all inserts');
}

// =====================================================================================
// Behavior 11: a huge rung target (40) on a normal band - length capped at 40, valid, instant.
// =====================================================================================
{
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 40, minDecrement: 1 });
  // Assert
  // catches: off-by-one in the total insert count / leftover distribution (length 39 or 41).
  assert.strictEqual(ladder.length, 40, 'exactly 40 rungs produced for a 40-target on a wide-enough band');
  assert.ok(ladder.length <= 40, 'never exceeds the requested rung count');
  assert.ok(descending(ladder) && noBad(ladder) && noDup(ladder), 'valid: descending, no NaN, no duplicate');
  assert.deepStrictEqual([ladder[0], ladder[ladder.length - 1]], [20268, FLOOR], 'opening anchor and floor pinned at 40 rungs');
  for (const a of ANCHORS) assert.ok(ladder.includes(a), `anchor ${a} preserved at 40 rungs`);
  ok('should produce a valid ladder of exactly 40 rungs for a rungs=40 target');
}

// =====================================================================================
// Behavior 11 (outside-taxonomy): growth is bounded by the integer span, not the request.
// The band spans 20268..18486 = 1782, so at most 1783 distinct integer prices exist; a
// 2000-target must dedup down to 1783, never balloon or emit duplicates.
// =====================================================================================
{
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs: 2000, minDecrement: 1 });
  // Assert
  // catches: dedup/strict-descending fold removed -> duplicates or a length up at the 2000 request.
  assert.strictEqual(ladder.length, 1783, 'length capped at the integer span (20268-18486 = 1782 gaps -> 1783 rungs)');
  assert.ok(ladder.length < 2000, 'never grows to the requested 2000 when the span cannot hold them');
  assert.ok(noDup(ladder), 'no duplicate prices even when the target exceeds the span');
  assert.ok(descending(ladder), 'strictly descending even when the target exceeds the span');
  ok('should cap growth at the integer span (no duplicates) when rungs exceeds what the band can hold');
}

// =====================================================================================
// Behavior 12: non-monotonic desk-typo margin order [5, 9, 3]. buildBandLadder normalises
// to descending, so the ladder must open at the MAX margin and never emit an ascending or
// duplicate pair.
// =====================================================================================
{
  // Arrange
  const typoOrder = [5, 9, 3]; // sorted desc -> 9/5/3 -> anchors [19620, 18900, 18540]
  // Act
  const { ladder, opening } = interpolateBandLadder({ cost: COST, marginsPct: typoOrder, minMarginPct: 3, rungs: 5, minDecrement: 100 });
  // Assert
  // catches: sort-direction flip (b-a -> a-b) -> the band would open at the 3% margin and ascend.
  assert.strictEqual(opening, 19620, 'opens at the MAX margin (9% -> round(18000*1.09)=19620), proving descending normalisation');
  assert.deepStrictEqual(ladder, [19620, 19380, 19140, 18900, 18540], 'unsorted margins still yield a clean descending ladder');
  assert.ok(descending(ladder), 'strictly descending despite unsorted input margins');
  assert.ok(noDup(ladder), 'no duplicate pair from unsorted input margins');
  assert.strictEqual(ladder[ladder.length - 1], 18540, 'floor last on the normalised band');
  ok('should normalise unsorted margins to a strictly descending ladder (no ascending/duplicate pair)');
}

// =====================================================================================
// Behavior 13: a negative operating margin (desk enters -2). The operating floor must
// clamp UP to true cost - a bid must never land below cost. Pin: floor == cost, not 17640.
// =====================================================================================
{
  // Act
  const { ladder, floor, trueCost } = interpolateBandLadder({ cost: COST, marginsPct: [...MARGINS, -2], minMarginPct: -2, rungs: 6, minDecrement: 100 });
  // Assert
  // catches: the Math.max(trueCost, marginFloor) clamp collapsed to marginFloor -> floor 17640 (below
  //          cost, a guaranteed-loss bid). This is the money-critical mutant.
  assert.strictEqual(floor, 18000, 'operating floor clamps UP to true cost, not the -2% below-cost value (17640)');
  assert.strictEqual(trueCost, 18000, 'true cost reported as 18000');
  assert.strictEqual(Math.min.apply(null, ladder), 18000, 'no rung is below true cost');
  assert.deepStrictEqual(ladder, [20268, 19782, 19296, 18891, 18486, 18000], 'ladder pinned with the cost-clamped floor last');
  assert.ok(descending(ladder), 'strictly descending with a clamped floor');
  ok('should clamp the floor to true cost (never below cost) when the operating margin is negative');
}

// =====================================================================================
// Behavior 14: garbage rung targets (0, negative) fall back to the plain band, byte-for-byte.
// (NaN is already covered by test-interpolate-band-ladder.js #5.)
// =====================================================================================
{
  // Arrange
  const band = buildBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN });
  for (const rungs of [0, -5]) {
    // Act
    const got = interpolateBandLadder({ cost: COST, marginsPct: MARGINS, minMarginPct: MIN, rungs, minDecrement: 100 });
    // Assert
    // catches: the `want <= n` guard removed -> a 0/negative target flows into the split with negative
    //          `extra` and produces garbage instead of the plain band.
    assert.deepStrictEqual(got, band, `rungs=${rungs} returns the plain buildBandLadder object unchanged`);
  }
  ok('should fall back to the plain band (byte-identical) when rungs is 0 or negative');
}

// =====================================================================================
// Behavior 2: rungs below the anchor count on a 4-anchor band - anchors are never dropped;
// the result is at least the full anchor set.
// =====================================================================================
{
  // Arrange
  const margins4 = [12.6, 10, 7.2, 2.7]; // anchors [20268, 19800, 19296, 18486]
  const anchors4 = [20268, 19800, 19296, 18486];
  // Act
  const { ladder } = interpolateBandLadder({ cost: COST, marginsPct: margins4, minMarginPct: MIN, rungs: 2, minDecrement: 100 });
  // Assert
  // catches: guard letting a sub-anchor target interpolate with negative `extra` -> anchors lost / crash.
  assert.deepStrictEqual(ladder, anchors4, 'rungs=2 (< 4 anchors) keeps the full 4-anchor set unchanged');
  assert.strictEqual(ladder.length, 4, 'no anchor dropped when the target is below the anchor count');
  ok('should never drop anchors when rungs is below the anchor count (4-anchor band)');
}

// =====================================================================================
// Contract edge (outside-taxonomy): a collapsed single-rung band (every configured margin
// sits at or below the operating floor) has no gaps to fill. A large rung target must return
// the plain band byte-for-byte and must NOT crash (the n < 2 guard).
// =====================================================================================
{
  // Arrange
  const collapse = [3, 2]; // every tier <= operatingFloor (minMarginPct 10) -> band collapses to [19800]
  const band = buildBandLadder({ cost: COST, marginsPct: collapse, minMarginPct: 10 });
  // Act
  const got = interpolateBandLadder({ cost: COST, marginsPct: collapse, minMarginPct: 10, rungs: 6, minDecrement: 100 });
  // Assert
  // catches: the `n < 2` guard removed -> gap loop is empty, totalWidth 0, leftover distribution
  //          indexes an undefined widest-gap entry -> TypeError. Must instead return the band.
  assert.deepStrictEqual(got.ladder, [19800], 'a single-rung collapsed band stays a single rung');
  assert.deepStrictEqual(got, band, 'single-rung band returns buildBandLadder byte-identical (no crash)');
  ok('should return the plain band without crashing when the band collapses to a single rung');
}

console.log(`\n${pass} checks passed`);
process.exit(0);
