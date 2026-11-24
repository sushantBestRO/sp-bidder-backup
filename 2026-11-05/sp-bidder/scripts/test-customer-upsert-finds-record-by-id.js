'use strict';
/**
 * A customer upsert finds its stored record by customerId, not by its label's slug.
 *
 * A band stored below its own minimum is accepted again only when it is re-saved unchanged, and the
 * store judges "unchanged" against the record it looks up. A customer keyed differently from its
 * label's slug (renamed, or keyed explicitly) must be looked up by that key, or re-saving its band
 * untouched, say while editing its aliases, is refused. Nothing pinned the lookup (mutation
 * critique, PR-1).
 *
 *   node scripts/test-customer-upsert-finds-record-by-id.js
 */
const assert = require('assert');
const { MemoryStore } = require('../src/store');
const { CustomerStore, COLLECTION } = require('../src/model/customerStore');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

(async () => {
  const store = new MemoryStore();
  const customers = new CustomerStore({ store, log: () => {} });
  const band = { marginsPct: [8, 5, 2], minMarginPct: 3 };
  await store.putDoc(COLLECTION, 'havells', {
    customerId: 'havells', label: 'Havells India Ltd', aliases: ['Havells India Ltd'], margin: band, enabled: true,
  });

  const doc = await customers.upsert({
    customerId: 'havells', label: 'Havells India Ltd', aliases: ['HAVELLS INDIA LIMITED'], margin: band,
  });
  assert.strictEqual(doc.customerId, 'havells');
  assert.deepStrictEqual(doc.margin, band, `the stored band came back as ${JSON.stringify(doc.margin)}`);
  ok(1, 'an unchanged stored band is re-saved on a customer keyed differently from its label');

  let refused = null;
  try {
    await customers.upsert({ customerId: 'havells', label: 'Havells India Ltd', margin: { marginsPct: [8, 5, 1], minMarginPct: 3 } });
  } catch (e) { refused = e; }
  assert.ok(refused && refused.code === 'BAD_INPUT', 'a changed band below its minimum was accepted');
  ok(2, 'a changed band below its minimum is still refused');

  console.log(`\n${pass}/2 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
