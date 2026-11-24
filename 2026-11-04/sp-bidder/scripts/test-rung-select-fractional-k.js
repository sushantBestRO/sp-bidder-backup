'use strict';
/**
 * QUARANTINED - RED against the current impl. Do NOT move this into scripts/ (it would fail the
 * `npm test` money-path gate). Kept here as an executable record of a live finding.
 *
 * FINDING: pricing.selectRung does not sanitize a FRACTIONAL live rank `k`. Rank arrives from the
 * platform and is expected to be a positive integer, but the contract sanitizes only jumpPerRival,
 * never k. A junk/fractional k (e.g. 2.5 off a malformed socket frame) flows straight through:
 *
 *     jump   = Math.max(0, k - 1) * jpr = 1.5
 *     target = i + jump                 = 1.5
 *     // the skip-walk only increments on rungFired() (integer membership), so 1.5 never rounds
 *     return target                     = 1.5   <-- a FRACTIONAL ladder index
 *
 * Why it matters (real money): the returned index feeds `ladder[idx]`. ladder[1.5] === undefined,
 * so the downstream bid amount is undefined -> either a throw at payload build or, worse, a bid at
 * a garbage/mis-derived price. This breaks the global money invariant every other rung-select test
 * asserts: the returned index must be null or an INTEGER in [0, last].
 *
 * Observed (node v22, this worktree):
 *     selectRung({ i:0, k:2.5, last:5, phase:'defend' }) === 1.5
 *     selectRung({ i:0, k:2.5, last:5, phase:'snipe'  }) === 1.5
 *
 * This test asserts the invariant that SHOULD hold (integer index) and therefore FAILS today. It
 * turns green only once selectRung sanitizes k to an integer (e.g. Math.trunc/Math.round/reject),
 * at which point move it into scripts/ alongside test-rung-select-edges.js.
 *
 *   node docs/tests/quarantine/test-rung-select-edges-fractional-k.js   (expected: FAIL until fixed)
 */
const assert = require('assert');
const { selectRung } = require('../src/engine/pricing');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS  ' + name); passed += 1; }
  catch (e) { console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); failed += 1; }
}

function assertIntegerRung(got, last, label) {
  // The money invariant: a rung index must be null or an integer in [0, last].
  assert.ok(
    got === null || (Number.isInteger(got) && got >= 0 && got <= last),
    label + ': returned index must be null or an INTEGER in [0,' + last + '], got ' + JSON.stringify(got));
}

test('should return an integer rung (or null) when defending on a fractional junk rank k=2.5', () => {
  // Arrange
  const args = { i: 0, k: 2.5, last: 5, firedRungs: new Set(), phase: 'defend' };
  // Act
  const got = selectRung(args);
  // Assert
  // catches: unsanitized fractional k -> fractional ladder index (undefined price with real money)
  assertIntegerRung(got, 5, 'k=2.5 defend');
});

test('should return an integer rung (or null) when sniping on a fractional junk rank k=2.5', () => {
  // Arrange
  const args = { i: 0, k: 2.5, last: 5, firedRungs: new Set(), phase: 'snipe' };
  // Act
  const got = selectRung(args);
  // Assert
  // catches: unsanitized fractional k -> fractional ladder index (undefined price with real money)
  assertIntegerRung(got, 5, 'k=2.5 snipe');
});

console.log('\n' + passed + '/' + (passed + failed) + ' checks passed');
process.exit(failed ? 1 : 0);
