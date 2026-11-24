'use strict';
/**
 * Rank-driven rung selection (pricing.selectRung) - HOSTILE-INPUT / EDGE-CASE hardening pass.
 *
 * Companion to scripts/test-rung-select.js, which pins the spec's two worked bands and the
 * happy-path rank branches. This file attacks only the edge surface that file does NOT cover:
 *   - jumpPerRival sanitization (NaN / 0 / negative / Infinity all collapse to 1)
 *   - junk ranks (k=0 platform garbage; k huge)
 *   - clamp boundaries (defend never spends the floor mid-auction; snipe may)
 *   - degenerate ladders (1-rung, 2-rung) and the last<3 coarse-floor guard done properly
 *   - the fired-rung skip walk at both ends (exhaust-below-floor hold; never step past the floor)
 *   - Set-vs-array firedRungs parity on the SNIPE path (the existing file only checks defend)
 *
 * GLOBAL MONEY INVARIANT asserted on every case: the returned index is null (hold) or an INTEGER
 * in [0, last]. A fractional or out-of-range index would index the ladder with undefined and place
 * a below-floor / undefined-price bid with real money. (The k=2.5 fractional-rank case that breaks
 * this invariant is quarantined at docs/tests/quarantine/test-rung-select-edges-fractional-k.js -
 * see that file's header; it is a live finding against the current impl, not a passing test.)
 *
 *   node scripts/test-rung-select-edges.js
 */
const assert = require('assert');
const { selectRung } = require('../src/engine/pricing');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed += 1; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); failed += 1; }
}

// Global money invariant: null, or an integer rung index within the ladder [0, last]. An
// out-of-range or non-integer index is a below-floor / undefined-price bid hazard.
function assertValidRung(got, last, label) {
  assert.ok(
    got === null || (Number.isInteger(got) && got >= 0 && got <= last),
    label + ': returned index must be null or an integer in [0,' + last + '], got ' + JSON.stringify(got));
}

// Ladder floor-index (last = ladder.length - 1) fixtures.
const BAND3 = 2; // coarse 3-rung ladder [top, mid, floor]  -> snipe collapses to floor
const BAND6 = 5; // fine 6-rung ladder                       -> snipe keeps the highest winner
const BAND8 = 7; // 8-rung ladder, used for the k-huge clamp boundaries (spec says last=7)
const RUNG1 = 0; // degenerate single-rung ladder [floor]
const RUNG2 = 1; // degenerate two-rung ladder [top, floor]  (< 3 -> coarse guard)

// -------------------------------------------------------------------------------------------------
// 1-4  jumpPerRival sanitization: any non-finite-or-not->0 knob must collapse to 1 (jump = k-1).
//      All four use defend BAND6 i=0 k=3; the correct sanitized answer is rung 2 (jump=(3-1)*1=2).
// -------------------------------------------------------------------------------------------------

test('should treat jumpPerRival=NaN as 1 (jump=2) when defending', () => {
  // Arrange
  const args = { i: 0, k: 3, last: BAND6, firedRungs: new Set(), phase: 'defend', jumpPerRival: NaN };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'jpr=NaN');
  // expected 2: NaN fails Number.isFinite -> jpr=1 -> jump=(3-1)*1=2 -> target 0+2=2
  // catches: Number.isFinite gate dropped (NaN knob -> NaN jump -> NaN/undefined index)
  assert.strictEqual(got, 2, 'jumpPerRival=NaN must sanitize to 1 -> rung 2');
});

test('should treat jumpPerRival=0 as 1 when defending', () => {
  // Arrange
  const args = { i: 0, k: 3, last: BAND6, firedRungs: new Set(), phase: 'defend', jumpPerRival: 0 };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'jpr=0');
  // expected 2: 0 is finite but not > 0 -> jpr=1 -> jump=2
  // catches: comparator flip `jumpPerRival > 0` -> `>= 0` (0 knob would zero the jump -> hold)
  assert.strictEqual(got, 2, 'jumpPerRival=0 must sanitize to 1 -> rung 2');
});

test('should treat jumpPerRival=-2 as 1 when defending', () => {
  // Arrange
  const args = { i: 0, k: 3, last: BAND6, firedRungs: new Set(), phase: 'defend', jumpPerRival: -2 };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'jpr=-2');
  // expected 2: -2 is finite but not > 0 -> jpr=1 -> jump=2
  // catches: dropped `> 0` guard (a negative knob would make jump negative -> negative index)
  assert.strictEqual(got, 2, 'negative jumpPerRival must sanitize to 1 -> rung 2');
});

test('should treat jumpPerRival=Infinity as 1 when defending', () => {
  // Arrange
  const args = { i: 0, k: 3, last: BAND6, firedRungs: new Set(), phase: 'defend', jumpPerRival: Infinity };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'jpr=Inf');
  // expected 2: Infinity fails Number.isFinite -> jpr=1 -> jump=2 (NOT the clamp-to-floor rung 4)
  // catches: Number.isFinite gate replaced by a bare `> 0` (Infinity>0 -> jump=Infinity -> rung 4)
  assert.strictEqual(got, 2, 'jumpPerRival=Infinity must sanitize to 1 -> rung 2');
});

// -------------------------------------------------------------------------------------------------
// 5  k=0 platform-junk rank: jump = max(0, k-1) = 0, so target = i. Defend holds, snipe fires floor.
// -------------------------------------------------------------------------------------------------

test('should hold (null) when defending on junk rank k=0', () => {
  // Arrange
  const args = { i: 0, k: 0, last: BAND6, firedRungs: new Set(), phase: 'defend' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'k=0 defend');
  // expected null: jump=max(0,-1)=0 -> target=i=0 -> target<=i -> hold
  // catches: Math.max(0,k-1) identity collapse to abs(k-1) (would jump 1 -> return rung 1, not hold)
  assert.strictEqual(got, null, 'k=0 defend must hold, never a spurious step');
});

test('should fire the floor when sniping on junk rank k=0', () => {
  // Arrange
  const args = { i: 0, k: 0, last: BAND6, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'k=0 snipe');
  // expected 5 (floor): jump=0 -> target=i=0 -> target<=i -> return last=5
  // catches: Math.max(0,k-1) identity collapse (abs would step to rung 1 instead of the sure floor)
  assert.strictEqual(got, 5, 'k=0 snipe must fall back to the floor rung');
});

// -------------------------------------------------------------------------------------------------
// 6  k huge (k=50) on an 8-rung ladder (last=7): defend clamps to last-1=6, snipe clamps to last=7.
// -------------------------------------------------------------------------------------------------

test('should clamp a huge-rank defend to last-1 (never the floor mid-auction)', () => {
  // Arrange
  const args = { i: 0, k: 50, last: BAND8, firedRungs: new Set(), phase: 'defend' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND8, 'k=50 defend');
  // expected 6: jump=49 -> target=49 -> clamp min(49, last-1=6)=6 (floor rung 7 stays reserved)
  // catches: off-by-one in the defend clamp `min(target, last-1)` -> `min(target, last)` (would spend floor 7)
  assert.strictEqual(got, 6, 'huge-rank defend must clamp to last-1, not the floor');
});

test('should clamp a huge-rank snipe to the floor last (never above it)', () => {
  // Arrange
  const args = { i: 0, k: 50, last: BAND8, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND8, 'k=50 snipe');
  // expected 7 (floor): jump=49 -> target=49 -> clamp min(49, last=7)=7
  // catches: snipe clamp `min(target, last)` -> `min(target, last-1)` (would stop at 6, never fire floor)
  assert.strictEqual(got, 7, 'huge-rank snipe must clamp to the floor rung last');
});

// -------------------------------------------------------------------------------------------------
// 8  firedRungs Set-vs-array parity on the SNIPE path (existing file only checks defend parity).
// -------------------------------------------------------------------------------------------------

test('should skip a fired rung on snipe when firedRungs is a plain array', () => {
  // Arrange
  const args = { i: 2, k: 2, last: BAND6, firedRungs: [3], phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'snipe array-fired');
  // expected 4: jump=1 -> target=3 -> rung 3 fired -> walk to rung 4 (unfired, < floor 5)
  // catches: rungFired array branch broken (Array.isArray/.includes) -> rung 3 not skipped -> returns 3
  assert.strictEqual(got, 4, 'array firedRungs must skip the fired snipe rung to rung 4');
});

test('should return identical snipe rung whether firedRungs is a Set or an array', () => {
  // Arrange
  const base = { i: 2, k: 2, last: BAND6, phase: 'snipe' };
  // Act
  const asSet = selectRung(Object.assign({}, base, { firedRungs: new Set([3]) }));
  // Assert
  const asArr = selectRung(Object.assign({}, base, { firedRungs: [3] }));
  assertValidRung(asSet, BAND6, 'snipe Set-fired');
  // catches: divergence between the Set (.has) and array (.includes) branches of rungFired on snipe
  assert.strictEqual(asSet, asArr, 'Set and array firedRungs must agree on the snipe path');
  assert.strictEqual(asSet, 4, 'both firedRungs forms must land on rung 4');
});

// -------------------------------------------------------------------------------------------------
// 9  Defend standing on last-1: the only rung left below is the floor, which defend never spends.
// -------------------------------------------------------------------------------------------------

test('should hold when defending already on last-1 (nowhere to go but the floor)', () => {
  // Arrange
  const args = { i: 4, k: 3, last: BAND6, firedRungs: new Set(), phase: 'defend' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'defend at last-1');
  // expected null: jump=2 -> target=6 -> clamp to last-1=4 -> target(4) <= i(4) -> hold
  // catches: comparator flip `target <= i` -> `target < i` (would re-fire the current rung 4)
  assert.strictEqual(got, null, 'defend on last-1 must hold, not re-fire the current rung');
});

// -------------------------------------------------------------------------------------------------
// 10 Snipe already on the floor with a huge rank AND the floor already fired: idempotent, returns
//    the floor, no out-of-bounds from the huge jump and no skip past the floor.
// -------------------------------------------------------------------------------------------------

test('should return the floor idempotently when sniping already on the floor (huge k, floor fired)', () => {
  // Arrange
  const args = { i: 5, k: 99, last: BAND6, firedRungs: new Set([5]), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'snipe at floor');
  // expected 5: jump=98 -> target=103 -> clamp min(103,last=5)=5 -> target(5) <= i(5) -> return last=5
  // catches: dropped snipe clamp min(target,last) (target 103 would leak out of bounds)
  assert.strictEqual(got, 5, 'snipe on the floor must stay on the floor, never above it');
});

// -------------------------------------------------------------------------------------------------
// 11 Single-rung ladder (last=0, [floor] only): defend holds, snipe fires the floor, no crash.
// -------------------------------------------------------------------------------------------------

test('should hold when defending on a single-rung ladder (last=0)', () => {
  // Arrange
  const args = { i: 0, k: 3, last: RUNG1, firedRungs: new Set(), phase: 'defend' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, RUNG1, 'defend last0');
  // expected null: defend clamp min(target, last-1=-1) -> target(-1) <= i(0) -> hold (never a negative index)
  // catches: defend clamp last-1 mishandled on a degenerate ladder (negative index leak)
  assert.strictEqual(got, null, 'single-rung defend must hold, never a negative index');
});

test('should fire rung 0 when sniping on a single-rung ladder (last=0)', () => {
  // Arrange
  const args = { i: 0, k: 3, last: RUNG1, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, RUNG1, 'snipe last0');
  // expected 0: last<3 coarse guard -> return last=0 (the only rung)
  // catches: last<3 guard removed on a degenerate ladder (undefined/negative index)
  assert.strictEqual(got, 0, 'single-rung snipe must fire the only rung, index 0');
});

test('should fire rung 0 when sniping a single-rung ladder with unknown rank k=null', () => {
  // Arrange
  const args = { i: 0, k: null, last: RUNG1, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, RUNG1, 'knull snipe last0');
  // expected 0: k==null snipe -> return last=0 (the floor is the last-shot fallback)
  // catches: k==null snipe branch returning null instead of last on a degenerate ladder
  assert.strictEqual(got, 0, 'k=null snipe must fall back to the floor rung 0');
});

// -------------------------------------------------------------------------------------------------
// 12 Two-rung ladder (last=1, < 3) coarse guard; plus a 3-rung case that genuinely DISCRIMINATES the
//    guard (a non-floor snipe target that the guard must divert to the floor).
// -------------------------------------------------------------------------------------------------

test('should always fire the floor when sniping a two-rung coarse ladder (last=1)', () => {
  // Arrange
  const args = { i: 0, k: 2, last: RUNG2, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, RUNG2, 'snipe last1');
  // expected 1 (floor): last<3 coarse guard -> return last=1
  // catches: coarse guard comparator so far off it lets a two-rung ladder step somewhere other than floor
  assert.strictEqual(got, 1, 'two-rung snipe must collapse to the floor rung 1');
});

test('should divert a non-floor snipe target to the floor on a coarse 3-rung ladder (last=2)', () => {
  // Arrange  (BAND3, i=0, k=2: rank would point at rung 1, a NON-floor rung)
  const args = { i: 0, k: 2, last: BAND3, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND3, 'coarse-guard discriminator');
  // expected 2 (floor): last<3 (2<3) guard fires FIRST -> floor. WITHOUT the guard, target=min(0+1,2)=1
  // would return rung 1. This row is what actually pins the last<3 guard.
  // catches: `last < 3` guard removed/weakened (would return the non-floor rung 1 instead of floor 2)
  assert.strictEqual(got, 2, 'coarse-ladder snipe must divert a non-floor target to the floor');
});

// -------------------------------------------------------------------------------------------------
// 13 Defend where every rung between i+1 and last-1 is already fired: the skip walk exhausts up to
//    the floor and holds (defend never spends the floor).
// -------------------------------------------------------------------------------------------------

test('should hold when a defend skip-walk exhausts all rungs above the floor', () => {
  // Arrange  (from rung 1, k=3, rungs 2/3/4 all fired -> nothing unfired below the floor)
  const args = { i: 1, k: 3, last: BAND6, firedRungs: new Set([2, 3, 4]), phase: 'defend' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'defend exhaust');
  // expected null: jump=2 -> target=3 (fired) -> 4 (fired) -> 5 -> target>=last -> hold
  // catches: while->if (single skip would return fired rung 4); `target >= last` -> `>` (would spend floor 5)
  assert.strictEqual(got, null, 'defend must hold when every rung above the floor is fired');
});

// -------------------------------------------------------------------------------------------------
// 14 Snipe with every rung from the target down to AND including the floor fired: the walk must stop
//    AT the floor (last) and return it, never step past it out of bounds.
// -------------------------------------------------------------------------------------------------

test('should stop at the floor when a snipe skip-walk hits an all-fired tail including the floor', () => {
  // Arrange
  const args = { i: 2, k: 2, last: BAND6, firedRungs: new Set([3, 4, 5]), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'snipe fired tail');
  // expected 5 (floor): jump=1 -> target=3 (fired) -> 4 (fired) -> loop stops at target==last=5 and returns 5
  // catches: skip-walk loop bound `while (target < last)` -> `<= last` (would step to 6, OUT OF BOUNDS)
  assert.strictEqual(got, 5, 'snipe skip-walk must stop at the floor, never index past last');
});

// -------------------------------------------------------------------------------------------------
// 15 k=null snipe with the floor already in firedRungs: the blind-window branch returns the floor
//    unconditionally, without consulting firedRungs.
// -------------------------------------------------------------------------------------------------

test('should fire the floor on a k=null snipe even when the floor is already fired', () => {
  // Arrange
  const args = { i: 0, k: null, last: BAND6, firedRungs: new Set([5]), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  assertValidRung(got, BAND6, 'knull snipe fired-floor');
  // expected 5 (floor): k==null snipe -> return last=5 before any fired-rung logic runs
  // catches: k==null snipe branch flipped to null, or made to consult firedRungs and hold
  assert.strictEqual(got, 5, 'k=null snipe must return the floor regardless of firedRungs');
});

console.log('\n' + passed + '/' + (passed + failed) + ' checks passed');
process.exit(failed ? 1 : 0);
