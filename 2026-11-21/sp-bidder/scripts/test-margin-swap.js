'use strict';

// The MARGIN read-swap: PriceRequestStore.resolveInherited now derives the band from the unified
// model (customers + assignments via resolveMargin) instead of the legacy marginProfiles. This locks
//  1) the actual method is byte-equivalent to the legacy profiles path on migrated data,
//  2) an assignment-level marginOverride layers on top of the customer band,
//  3) the /api/margin-profiles compat shim's core invariant: a margin edit PRESERVES a customer's
//     aliases (never narrows the match set), and clearing a margin keeps the customer (targeting
//     and routing survive) while reverting to the default band.
// The cost-floor invariant is unaffected and stays covered by test-operating-floor.js.

const assert = require('assert');
const { createStore } = require('../src/store');
const { migrateLegacyModel } = require('../src/model/migrate');
const { CustomerStore } = require('../src/model/customerStore');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MarginProfileStore } = require('../src/pricing/marginProfiles');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };

const defaults = { marginsPct: [5, 4, 3], minMarginPct: 3 };
const marginProfiles = [
  { platformKey: 'sp', customerKey: 'syngenta', customerLabel: 'Syngenta', marginsPct: [10, 8, 6], minMarginPct: 6, enabled: true },
  { platformKey: 'sp', customerKey: 'rallis', customerLabel: 'Rallis', marginsPct: [12, 9, 7], minMarginPct: 7, enabled: true },
];
const loads = [
  { id: 'A', companyName: 'Syngenta India Ltd', closesAt: 0 },
  { id: 'B', companyName: 'Rallis India Limited', closesAt: 0 },
  { id: 'C', companyName: 'Unknown Shipper', closesAt: 0 },
];

(async () => {
  // ---- 1) method-level parity: legacy profiles path == model path on migrated data ----
  const legacyStore = createStore({ backend: 'memory' });
  const profiles = new MarginProfileStore({ store: legacyStore });
  for (const p of marginProfiles) await profiles.upsert({ platformKey: p.platformKey, customer: p.customerLabel, marginsPct: p.marginsPct, minMarginPct: p.minMarginPct });
  const legacyReq = new PriceRequestStore({ store: legacyStore, marginsPct: defaults.marginsPct, minMarginPct: defaults.minMarginPct, profiles, platformKey: 'sp' });

  const modelStore = createStore({ backend: 'memory' });
  for (const p of marginProfiles) await modelStore.putDoc('marginProfiles', `${p.platformKey}:${p.customerKey}`, p);
  await migrateLegacyModel({ store: modelStore });
  const customers = new CustomerStore({ store: modelStore });
  const people = new PersonStore({ store: modelStore, accountsProvider: () => [] });
  const assignments = new AssignmentStore({ store: modelStore, people, customers });
  const modelReq = new PriceRequestStore({ store: modelStore, marginsPct: defaults.marginsPct, minMarginPct: defaults.minMarginPct, customersProvider: customers, assignmentsProvider: assignments, platformKey: 'sp' });

  for (const load of loads) {
    const a = await legacyReq.resolveInherited(load);
    const b = await modelReq.resolveInherited(load);
    ok(JSON.stringify(a.marginsPct) === JSON.stringify(b.marginsPct) && a.minMarginPct === b.minMarginPct,
      `resolveInherited parity "${load.companyName}": legacy [${a.marginsPct}]/${a.minMarginPct} == model [${b.marginsPct}]/${b.minMarginPct}`);
  }
  // createForLoad (the live path) snapshots the derived band
  const req = await modelReq.createForLoad({ id: 'L-syn', companyName: 'Syngenta India Ltd', closesAt: Date.now() + 600000 });
  ok(JSON.stringify(req.marginsPct) === JSON.stringify([10, 8, 6]) && req.minMarginPct === 6, 'createForLoad snapshots the model-derived customer band');
  ok(req.marginSource === 'customer:syngenta', `marginSource carries the model customerId, got ${req.marginSource}`);

  // ---- 2) an assignment marginOverride layers over the customer band ----
  const syn = (await customers.list()).find((c) => /syngenta/i.test(c.label));
  ok(!!syn, 'migrated syngenta customer exists');
  const aid = `p-test::${syn.customerId}`;
  await modelStore.putDoc('assignments', aid, { assignmentId: aid, personId: 'p-test', customerId: syn.customerId, lanes: null, marginOverride: { marginsPct: [20, 15, 10], minMarginPct: 10 }, alertKinds: null, enabled: true, updatedAt: 2 });
  const ov = await modelReq.resolveInherited({ id: 'A', companyName: 'Syngenta India Ltd', closesAt: 0 });
  ok(JSON.stringify(ov.marginsPct) === JSON.stringify([20, 15, 10]) && ov.minMarginPct === 10, 'assignment marginOverride layers over the customer band');
  ok(String(ov.source).indexOf('assignment:') === 0, `override source is assignment-tagged, got ${ov.source}`);

  // ---- 3) compat-shim invariant: a margin edit preserves aliases; clearing keeps the customer ----
  const cs = new CustomerStore({ store: createStore({ backend: 'memory' }) });
  const seeded = await cs.upsert({ label: 'Tata Steel', aliases: ['Tata Steel', 'Tata Steel Ltd', 'TSL'], margin: { marginsPct: [10], minMarginPct: 5 } });
  // the shim's POST spreads the existing customer and overwrites only the margin band
  await cs.upsert({ ...seeded, margin: { marginsPct: [8], minMarginPct: 4 }, updatedBy: 'op' });
  const afterEdit = await cs.get('tata-steel');
  ok(JSON.stringify(afterEdit.aliases) === JSON.stringify(seeded.aliases), 'margin edit preserves the customer aliases (no match narrowing)');
  ok(JSON.stringify(afterEdit.margin.marginsPct) === JSON.stringify([8]) && afterEdit.margin.minMarginPct === 4, 'margin edit updates the band');
  // the shim's delete clears the margin (null) but keeps the customer + aliases
  await cs.upsert({ ...afterEdit, margin: null, updatedBy: 'op' });
  const cleared = await cs.get('tata-steel');
  ok(cleared.margin === null, 'clearing a margin profile sets margin=null (reverts to the default band)');
  ok(JSON.stringify(cleared.aliases) === JSON.stringify(seeded.aliases), 'clearing the margin keeps the customer + aliases (targeting/routing survive)');

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
