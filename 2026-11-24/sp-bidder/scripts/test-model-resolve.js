'use strict';

// The pure derivation layer: matchCustomer, resolveTargets (union of base + assigned aliases;
// empty base = fail closed, matches nothing), resolveMargin
// (bid > assignment override > customer > default), and toRecipientRows (one row per person).

const assert = require('assert');
const { matchCustomer, resolveTargets, resolveMargin } = require('../src/model/resolve');
const { toRecipientRows } = require('../src/model/project');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m);

const customers = [
  { customerId: 'syngenta', label: 'Syngenta India Pvt Ltd', aliases: ['Syngenta India Pvt Ltd', 'Syngenta'], margin: { marginsPct: [10, 8, 6], minMarginPct: 6 }, enabled: true },
  { customerId: 'havells', label: 'Havells India Ltd', aliases: ['Havells India Ltd', 'Havells'], margin: null, enabled: true },
  { customerId: 'rallis', label: 'Rallis India Limited', aliases: ['Rallis'], margin: { marginsPct: [12, 9, 7], minMarginPct: 7 }, enabled: true },
];
const people = [
  { personId: 'p1', name: 'Sameer', phone: '+919594963428', accountId: 'ahmedabad', alertPrefs: ['won', 'lost'], alertAll: false, originScope: [], enabled: true },
  { personId: 'p2', name: 'Subham', phone: '+918929569065', accountId: 'ahmedabad', alertPrefs: 'all', alertAll: false, originScope: [], enabled: true },
  { personId: 'p3', name: 'Central', phone: '+919999999999', accountId: 'ahmedabad', alertPrefs: ['error'], alertAll: true, originScope: [], enabled: true },
];
const assignments = [
  { assignmentId: 'p1::syngenta', personId: 'p1', customerId: 'syngenta', lanes: null, marginOverride: { marginsPct: [11, 9, 7], minMarginPct: 7 }, alertKinds: null, enabled: true },
  { assignmentId: 'p2::havells', personId: 'p2', customerId: 'havells', lanes: null, marginOverride: { marginsPct: [9, 7, 5], minMarginPct: 5 }, alertKinds: ['won'], enabled: true },
];
const defaults = { marginsPct: [5, 4, 3], minMarginPct: 3 };

(async () => {
  // matchCustomer
  ok(matchCustomer('Syngenta India Ltd', customers).customerId === 'syngenta', 'matchCustomer: "Syngenta India Ltd" -> syngenta (alias tokenMatch)');
  ok(matchCustomer('Havells India Ltd', customers).customerId === 'havells', 'matchCustomer: exact -> havells');
  ok(matchCustomer('Unknown Shipper', customers) === null, 'matchCustomer: no match -> null');

  // resolveTargets: union of fallback + assigned-customer aliases; scoped to people on the account
  const t = resolveTargets({ account: { accountId: 'ahmedabad' }, customers, people, assignments, fallbackAllowlist: { shippers: ['Tata'], lanes: ['Pune'], hardCloseOnly: true } });
  ok(t.shippers.includes('Tata'), 'resolveTargets keeps the fallback shippers (never narrows)');
  ok(t.shippers.includes('Syngenta') && t.shippers.includes('Havells'), 'resolveTargets adds assigned-customer aliases');
  ok(!t.shippers.includes('Rallis'), 'resolveTargets excludes an unassigned customer');
  eq(t.lanes, ['Pune'], 'resolveTargets passes lanes through from the fallback');
  ok(t.hardCloseOnly === true, 'resolveTargets passes hardCloseOnly through unchanged');
  eq(resolveTargets({ account: { accountId: 'other' }, customers, people, assignments, fallbackAllowlist: { shippers: [], lanes: [], hardCloseOnly: false } }).shippers, [], 'empty base + no assignments on this account -> bids NOTHING (fail closed, empty shippers)');
  // fail-closed: an EMPTY base ("bid nothing") is no longer match-all. The assigned customers ARE
  // the positive targets, so they're unioned in even on an empty base - empty base + assignments
  // bids EXACTLY the assigned customers (agrees with discovery.matchesAllowlist's empty = nothing).
  eq(resolveTargets({ account: { accountId: 'ahmedabad' }, customers, people, assignments, fallbackAllowlist: { shippers: [], lanes: [], hardCloseOnly: true } }).shippers, ['Syngenta India Pvt Ltd', 'Syngenta', 'Havells India Ltd', 'Havells'], 'resolveTargets: empty base + assignments -> the assigned customers (fail-closed, not match-all)');
  ok(resolveTargets({ account: { accountId: 'ahmedabad' }, customers, people, assignments, fallbackAllowlist: { shippers: [], hardCloseOnly: true } }).hardCloseOnly === true, 'resolveTargets: empty base still passes hardCloseOnly through');

  // resolveMargin
  eq(resolveMargin({ platformKey: 'sp', companyName: 'Syngenta India Ltd', customers, assignments, defaults }).marginsPct, [11, 9, 7], 'resolveMargin: assignment override beats the customer margin');
  ok(resolveMargin({ platformKey: 'sp', companyName: 'Syngenta India Ltd', customers, assignments, defaults }).source.indexOf('assignment:') === 0, 'resolveMargin: source flags the assignment override');
  eq(resolveMargin({ platformKey: 'sp', companyName: 'Rallis India Limited', customers, assignments, defaults }).marginsPct, [12, 9, 7], 'resolveMargin: customer margin when no override');
  eq(resolveMargin({ platformKey: 'sp', companyName: 'Havells India Ltd', customers, assignments, defaults }).marginsPct, [9, 7, 5], 'resolveMargin: assignment override applies even when its customer has no base margin');
  ok(resolveMargin({ platformKey: 'sp', companyName: 'Havells India Ltd', customers, assignments, defaults }).source.indexOf('assignment:') === 0, 'resolveMargin: source flags the assignment override on a margin-null customer');
  eq(resolveMargin({ platformKey: 'sp', companyName: 'Nobody Ltd', customers, assignments, defaults }).marginsPct, [5, 4, 3], 'resolveMargin: no customer -> default');

  // toRecipientRows
  const rows = toRecipientRows(customers, people, assignments);
  const byPhone = Object.fromEntries(rows.map((r) => [r.phone, r]));
  eq(byPhone['+919594963428'].scope.shippers, ['Syngenta India Pvt Ltd', 'Syngenta'], 'row: assigned person scope = customer aliases');
  eq(byPhone['+919594963428'].alerts, ['won', 'lost'], 'row: alerts = prefs when assignment alertKinds is null');
  eq(byPhone['+918929569065'].alerts, ['won'], 'row: alerts = assignment alertKinds override');
  eq(byPhone['+919999999999'].scope.shippers, [], 'row: alertAll person -> empty shippers (= all loads)');

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
