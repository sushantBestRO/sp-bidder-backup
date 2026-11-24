'use strict';
/**
 * Ceiling price is a STRING on live SuperProcure loads ("90000.00" on Shriji, "300000.00" on Havells -
 * v4 full-board capture 2026-07-17, finding 5). A `<` / `>` clamp against a raw string does a
 * LEXICOGRAPHIC compare when both operands are strings ("90000.00" < "300000.00" is TRUE as strings,
 * FALSE as numbers). plausibleCeiling parses + bound-checks it to a real number (or null, fail-closed)
 * at the map boundary so every downstream reader works with a number. Shriji is the R1 rollout target,
 * so its exact "90000.00" shape is the first live ceiling the code meets - pin it end to end.
 *
 *   node scripts/test-ceiling-plausibility.js
 */
const assert = require('assert');
const { plausibleCeiling, deriveLoadRules } = require('../src/model/loadRules');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// A. plausibleCeiling parses the real string shapes to numbers and fails closed on the rest.
{
  // the R1 landmine: Shriji's string ceiling must PARSE to the number 90000, not stay a string.
  const shriji = plausibleCeiling('90000.00');
  assert.strictEqual(shriji, 90000, 'Shriji "90000.00" (string) -> 90000 (number)');
  assert.strictEqual(typeof shriji, 'number', 'result is a number, not a string');
  assert.strictEqual(plausibleCeiling('300000.00'), 300000, 'Havells "300000.00" (string) -> 300000');

  // the whole point: numeric ordering, not lexicographic. As STRINGS "90000.00" < "300000.00" is true;
  // as parsed numbers 90000 < 300000 is also true - but "90000.00" < "3000.00" flips between the two.
  assert.ok(plausibleCeiling('90000.00') > plausibleCeiling('3000.00'),
    '90000 > 3000 numerically (a raw string compare "90000.00" > "3000.00" would be FALSE)');

  // already-numeric passes through unchanged (the golden-test / mock shape).
  assert.strictEqual(plausibleCeiling(120000), 120000, 'a numeric ceiling passes through unchanged');

  // fail closed: absent / empty / garbage / non-positive / overflow sentinel -> null ("no known ceiling").
  for (const bad of [null, undefined, '', 'n/a', 'abc', 0, '0', -1, '-1', NaN, 1e9 + 1]) {
    assert.strictEqual(plausibleCeiling(bad), null, `fail-closed: ${JSON.stringify(bad)} -> null`);
  }
  ok('plausibleCeiling parses the live string shapes to numbers and fails closed on absent/garbage/sentinel');
}

// B. the parse is wired at BOTH map-boundary sites (deriveLoadRules + realAdapter._mapLoad) - Shriji end to end.
{
  const shrijiRaw = { id: 23200001, companyName: 'Shriji Polymers', biddingCloseTime: new Date(Date.now() + 600000).toISOString(),
    branchAuctionExtendTime: '00:03:00', ceilingPrice: '90000.00', branchAuctionRemainingTime: 200 };

  const rules = deriveLoadRules(shrijiRaw);
  assert.strictEqual(rules.ceilingPrice, 90000, 'deriveLoadRules parses Shriji ceiling to 90000');
  assert.strictEqual(typeof rules.ceilingPrice, 'number', 'LoadRules.ceilingPrice is a number a clamp can compare');

  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
  const mapped = a._mapLoad(shrijiRaw);
  assert.strictEqual(mapped.ceiling, 90000, '_mapLoad surfaces Shriji ceiling as the number 90000');
  assert.strictEqual(typeof mapped.ceiling, 'number', '_mapLoad ceiling is a number, not the raw "90000.00" string');

  // a load with no ceiling (the common case, 430 loads board-wide) surfaces null, not a broken value.
  const noCeil = a._mapLoad({ id: 2, biddingCloseTime: new Date(Date.now() + 600000).toISOString(),
    branchAuctionExtendTime: '00:00:00', ceilingPrice: null });
  assert.strictEqual(noCeil.ceiling, null, 'no ceiling -> null at the map boundary');
  assert.strictEqual(deriveLoadRules({ id: 2, ceilingPrice: null }).ceilingPrice, null, 'no ceiling -> null in LoadRules');
  ok('ceiling is parsed+bounded at both map-boundary sites - Shriji "90000.00" -> 90000, absent -> null');
}

console.log(`\n${pass}/2 checks passed`);
process.exit(0);
