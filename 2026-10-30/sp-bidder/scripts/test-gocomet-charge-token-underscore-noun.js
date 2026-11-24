'use strict';
/**
 * chargeMatchToken's noun strip does not cross an underscore.
 *
 * Regression target: merged-cargo-type review, Finding 9 (src/platform/gocometCargo.js:227).
 *
 * chargeMatchToken is the join between a desk-facing descriptor ("1 x 20FT CONTAINER 15 TONS",
 * space-separated) and the freight-charge KEY the bid is actually written onto
 * ("20ft_container_15_tons", underscore-separated). Both sides are supposed to reduce to the same
 * token so a per-truck-type rate can be routed to the right line. The noun strip
 * (`\b(?:TRUCKS?|VEHICLES?|CONTAINERS?)\b`) ran before separators were collapsed, and `\b` never
 * fires across an underscore (underscore is a word character), so the noun survived on the
 * underscore side and was dropped on the space side - two different tokens for the same truck type.
 * routing then either mismatches silently (fail-closed COST_TYPE_UNMATCHED - no money lost, but a
 * per-type rate the desk typed cannot be applied) or, on a load where BOTH sides happen to carry
 * the noun, mismatches invisibly.
 *
 * WHAT MUST NOT MOVE: the CONTROL fixtures below already produce matching tokens today, because
 * real GoComet charge keys never carry a TRUCK/VEHICLE/CONTAINER noun (Finding 9's own 21-key
 * corpus). The fix must not change what those already-working pairs reduce to.
 *
 *   node scripts/test-gocomet-charge-token-underscore-noun.js
 */
const assert = require('assert');
const { chargeMatchToken } = require('../src/platform/gocometCargo');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// 1. MECHANISM: the exact reproduction from Finding 9 - a descriptor and its underscore-encoded
//    charge key must reduce to the SAME token. This is the failing assertion pre-fix.
{
  const space = chargeMatchToken('1 x 20FT CONTAINER 15 TONS');
  const underscore = chargeMatchToken('20ft_container_15_tons');
  assert.strictEqual(underscore, space,
    `underscore-separated key must reduce to the same token as its space-separated descriptor `
    + `(space="${space}", underscore="${underscore}") - the noun strip must fire on both encodings`);
  ok('underscore- and space-separated forms of the same truck type reduce to one token');
}

// 2. MECHANISM, second pair from Finding 9 - a bare noun with no dimensions/tonnage.
{
  const space = chargeMatchToken('2 x 22FT Truck');
  const underscore = chargeMatchToken('22ft_truck');
  assert.strictEqual(underscore, space,
    `underscore form must match space form (space="${space}", underscore="${underscore}")`);
  ok('a bare noun ("Truck") is stripped identically on both encodings');
}

// 3. Exact value pin, both sides - so a future change cannot make them match by both drifting to
//    something new instead of by fixing the mechanism.
{
  assert.strictEqual(chargeMatchToken('1 x 20FT CONTAINER 15 TONS'), '20ft15tons',
    'space-separated token is pinned to the exact value the review reproduced');
  assert.strictEqual(chargeMatchToken('20ft_container_15_tons'), '20ft15tons',
    'underscore-separated token must reduce to the SAME exact value, not merely "some" match');
  ok('both encodings pin to the exact token "20ft15tons"');
}

// 4. CONTROL: a pair that ALREADY matches today (no noun in either form, real GoComet shapes -
//    a charge key never actually carries the noun) must keep matching after the fix.
{
  const KEY_40FT = "freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8.8')_25_tons";
  const desc = "5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck";
  const fromKey = chargeMatchToken(KEY_40FT.replace(/^freight_charges_custom_charge_?/, ''));
  const fromDesc = chargeMatchToken(desc);
  assert.strictEqual(fromKey, fromDesc,
    `a real captured charge key and its descriptor already agree (key="${fromKey}", desc="${fromDesc}") `
    + `- the fix must not disturb this`);
  assert.strictEqual(fromKey, "40ftlxwxh40x8x8825tons", 'and the shared value itself is unchanged by the fix');
  ok('a real, already-matching charge-key/descriptor pair keeps matching (control)');
}

const EXPECTED = 4;
assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
console.log(`\n${pass}/${EXPECTED} checks passed`);
