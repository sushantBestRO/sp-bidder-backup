'use strict';

// Model stores: validation (reuses validateMargins + the +91 normalizer + a secret canary),
// referential integrity (assignment -> existing person/customer; person -> existing account),
// and idempotent upsert by natural key.

const assert = require('assert');
const { createStore } = require('../src/store');
const { CustomerStore, validateCustomer } = require('../src/model/customerStore');
const { PersonStore, validatePerson } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { normalizePhoneIN } = require('../src/model/normalizePhone');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };
const rejects = (fn, m) => { let t = null; try { fn(); } catch (e) { t = e.code; } ok(t === 'BAD_INPUT', m); };
const rejectsA = async (fn, m) => { let t = null; try { await fn(); } catch (e) { t = e.code; } ok(t === 'BAD_INPUT', m); };

(async () => {
  // phone normalization
  ok(normalizePhoneIN('9594963428') === '+919594963428', 'normalizePhoneIN adds +91');
  ok(normalizePhoneIN('+91 95949 63428') === '+919594963428', 'normalizePhoneIN strips +91 + spaces');
  rejects(() => normalizePhoneIN('12345'), 'normalizePhoneIN rejects a short number');
  rejects(() => normalizePhoneIN('1594963428'), 'normalizePhoneIN rejects a non-6-9 start');

  // customer validation
  const c = validateCustomer({ label: 'Syngenta India Pvt Ltd', aliases: ['Syngenta'], margin: { marginsPct: [10, 8, 6], minMarginPct: 6 } });
  ok(c.customerId === 'syngenta-india-pvt-ltd', 'customerId slugged from label');
  ok(c.aliases.length === 2 && c.aliases.includes('Syngenta India Pvt Ltd') && c.aliases.includes('Syngenta'), 'aliases include the label + dedupe');
  ok(c.margin.marginsPct.length === 3, 'customer margin validated via validateMargins');
  rejects(() => validateCustomer({ label: 'X', margin: { marginsPct: [], minMarginPct: 0 } }), 'bad margin band rejected (shared validateMargins)');
  rejects(() => validateCustomer({ label: 'aaaaaaaa.bbbbbbbb.cccccccc' }), 'JWT-like label rejected (secret canary)');
  rejects(() => validateCustomer({ label: '' }), 'customer needs a label');

  // person validation + referential account check
  ok(validatePerson({ name: 'Sameer', phone: '9594963428' }).personId === 'p919594963428', 'personId is phone-derived (no same-name collision)');
  ok(validatePerson({ name: 'X', phone: '9594963428', alertPrefs: ['won', 'lost', 'bogus'] }).alertPrefs.length === 2, 'alertPrefs filtered to ALERT_KINDS');
  ok(validatePerson({ name: 'X', phone: '9594963428', alertPrefs: 'all' }).alertPrefs === 'all', "alertPrefs 'all' preserved");
  rejects(() => validatePerson({ name: 'X', phone: '123' }), 'person rejects a bad phone');

  // stores round-trip + referential + idempotency
  const store = createStore({ backend: 'memory' });
  const customers = new CustomerStore({ store });
  const people = new PersonStore({ store, accountsProvider: async () => [{ accountId: 'ahmedabad' }] });
  const assignments = new AssignmentStore({ store, people, customers });

  await rejectsA(() => people.upsert({ name: 'Ghost', phone: '9594963400', accountId: 'nope' }), 'person rejects an unknown accountId (referential)');
  const cust = await customers.upsert({ label: 'Syngenta', margin: { marginsPct: [10, 8, 6], minMarginPct: 6 } });
  const per = await people.upsert({ name: 'Sameer', phone: '9594963428', accountId: 'ahmedabad' });
  const asn = await assignments.upsert({ personId: per.personId, customerId: cust.customerId });
  ok(asn.assignmentId === `${per.personId}::${cust.customerId}`, 'assignmentId is person::customer (natural key)');
  await assignments.upsert({ personId: per.personId, customerId: cust.customerId });
  ok((await assignments.list()).length === 1, 'assignment upsert is idempotent (one per pair)');
  await rejectsA(() => assignments.upsert({ personId: 'ghost', customerId: cust.customerId }), 'assignment rejects an unknown person (referential)');
  await rejectsA(() => assignments.upsert({ personId: per.personId, customerId: 'ghost' }), 'assignment rejects an unknown customer (referential)');
  ok((await customers.get(cust.customerId)).label === 'Syngenta', 'customer persists + reads back');
  ok((await assignments.remove(asn.assignmentId)) === true, 'assignment removes');

  // A phone-only re-save (no personId) merges into the stored record instead of replacing it.
  await people.upsert({ name: 'Desk', phone: '9594963411', accountId: 'ahmedabad', branchScope: ['Alwar Cable (1350)'], email: 'desk@example.com', enabled: false });
  const resaved = await people.upsert({ name: 'Desk renamed', phone: '+91 95949 63411' });
  ok(resaved.personId === 'p919594963411', 'a phone-only re-save lands on the phone-derived record');
  ok(resaved.name === 'Desk renamed', 'a phone-only re-save still writes the field it sent');
  ok(resaved.accountId === 'ahmedabad', `a phone-only re-save keeps accountId (got ${resaved.accountId})`);
  ok(JSON.stringify(resaved.branchScope) === JSON.stringify(['Alwar Cable (1350)']), `a phone-only re-save keeps branchScope (got ${JSON.stringify(resaved.branchScope)})`);
  ok(resaved.email === 'desk@example.com' && resaved.enabled === false, 'a phone-only re-save keeps email and enabled');
  ok((await people.upsert({ name: 'Desk renamed', phone: '9594963411', email: null })).email === null, 'an explicit null still clears on a phone-only write');

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
