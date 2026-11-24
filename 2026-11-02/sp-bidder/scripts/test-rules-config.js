'use strict';
/**
 * SCHEMA-VALIDATED per-customer rules config (Module 2 foundation, audit fix #3).
 *
 * Per-customer policy (pricingMode, unit, closeModel, softCloseOptIn) is CONFIG DATA validated by a
 * JSON Schema (ajv), not scattered `if (customer === ...)` conditionals. It FAILS CLOSED: an invalid
 * block is refused at write time (CustomerStore) and at boot (assertCustomerRulesValid), so a real-
 * money console never starts on a policy it can't parse. A typo'd key is rejected, not ignored.
 *
 *   node scripts/test-rules-config.js
 */
const assert = require('assert');
const { validateCustomerRules, assertCustomerRulesValid } = require('../src/model/rulesConfig');
const { validateCustomer } = require('../src/model/customerStore');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const throwsBadInput = (fn) => { let e = null; try { fn(); } catch (x) { e = x; } return e && e.code === 'BAD_INPUT' ? e : null; };

(async () => {
  // ---- 1. the validator: accept a well-formed block, reject bad enum / typo key / wrong type ----
  {
    assert.strictEqual(validateCustomerRules(null), null, 'null rules is valid (the norm today)');
    assert.strictEqual(validateCustomerRules(undefined), null, 'undefined rules is valid');
    const good = { pricingMode: 'flat', unit: 'MT', closeModel: 'hard', softCloseOptIn: true };
    assert.deepStrictEqual(validateCustomerRules(good), good, 'a well-formed rules block passes through unchanged');

    assert.ok(throwsBadInput(() => validateCustomerRules({ pricingMode: 'bogus' })), 'a value outside the pricingMode enum is rejected');
    assert.ok(throwsBadInput(() => validateCustomerRules({ unit: 'lbs' })), 'a unit outside the enum is rejected');
    assert.ok(throwsBadInput(() => validateCustomerRules({ closeModel: 'sudden' })), 'a closeModel outside the enum is rejected');
    assert.ok(throwsBadInput(() => validateCustomerRules({ softCloseOptIn: 'yes' })), 'a wrong-typed field is rejected');
    assert.ok(throwsBadInput(() => validateCustomerRules({ pricingMdoe: 'flat' })), 'a TYPO key is rejected (additionalProperties:false), not silently ignored');
    assert.ok(throwsBadInput(() => validateCustomerRules([])), 'a non-object rules block is rejected');
    ok('validateCustomerRules: accepts a well-formed block; rejects bad enum, wrong type, and typo keys');
  }

  // ---- 2. the boot gate: refuse boot on any invalid customer rules; no-op on today's data ----
  {
    assert.strictEqual(assertCustomerRulesValid([]), true, 'no customers -> passes');
    assert.strictEqual(assertCustomerRulesValid([{ customerId: 'a', label: 'A' }, { customerId: 'b', label: 'B' }]), true,
      'customers with NO rules block -> passes (inert on today\'s data)');
    assert.strictEqual(assertCustomerRulesValid([{ customerId: 'a', rules: { pricingMode: 'flat' } }]), true,
      'a valid rules block -> passes');
    assert.ok(throwsBadInput(() => assertCustomerRulesValid([{ customerId: 'ok', rules: { pricingMode: 'flat' } }, { customerId: 'bad', rules: { pricingMode: 'nope' } }])),
      'one invalid customer rules block stops the boot gate (fail closed)');
    ok('assertCustomerRulesValid refuses boot on an invalid rules block; no-op on customers without one');
  }

  // ---- 3. CustomerStore integration: rules validated at write, omitted when absent ----
  {
    const withRules = validateCustomer({ label: 'Syngenta', rules: { pricingMode: 'flat', unit: 'MT' } });
    assert.deepStrictEqual(withRules.rules, { pricingMode: 'flat', unit: 'MT' }, 'a valid rules block is kept on the customer doc');

    const noRules = validateCustomer({ label: 'Durian' });
    assert.ok(!('rules' in noRules), 'a customer with no rules block gets NO rules key (existing docs unchanged / byte-identical)');

    assert.ok(throwsBadInput(() => validateCustomer({ label: 'X', rules: { closeModel: 'whenever' } })),
      'CustomerStore rejects a customer whose rules block is invalid');
    ok('CustomerStore.validateCustomer validates rules at write and omits the key when absent');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
