'use strict';

// Behavior-preserving migration + the GOLDEN equivalence test: on migrated data, the derived
// targets / routing / margins must match the LIVE legacy code (real matchesAllowlist,
// scopeMatches, resolveBand) for every sample load x alert kind. This is the proof that turning
// the model on does not change what bids, who is alerted, or at what margin.

const assert = require('assert');
const { createStore } = require('../src/store');
const { migrateLegacyModel } = require('../src/model/migrate');
const { CustomerStore } = require('../src/model/customerStore');
const { PersonStore } = require('../src/model/personStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const { resolveTargets, resolveMargin } = require('../src/model/resolve');
const { toRecipientRows } = require('../src/model/project');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { scopeMatches } = require('../src/notify/notifier');
const { resolveBand } = require('../src/pricing/marginResolver');
const { ALERT_KINDS } = require('../src/admin/configStore');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };
// use the REAL discovery filter for both legacy and derived allowlists
const matchesAllowlist = (load, allowlist) => new DiscoveryPoller({ config: { allowlist } }).matchesAllowlist(load);

const legacyAllowlist = { shippers: ['Syngenta', 'Havells'], lanes: [], hardCloseOnly: true };
const marginProfiles = [
  { platformKey: 'sp', customerKey: 'syngenta-india-pvt-ltd', customerLabel: 'Syngenta India Pvt Ltd', marginsPct: [10, 8, 6], minMarginPct: 6, enabled: true },
  { platformKey: 'sp', customerKey: 'rallis', customerLabel: 'Rallis', marginsPct: [12, 9, 7], minMarginPct: 7, enabled: true },
];
const recipients = [
  { name: 'Sameer', phone: '+919594963428', alerts: ['won', 'lost'], scope: { origins: [], shippers: ['Syngenta'] } },
  { name: 'Central', phone: '+919999999999', alerts: ['error'], scope: { origins: [], shippers: [] } },        // empty scope = all loads
  { name: 'Noida', phone: '+919999444060', alerts: ['won'], scope: { origins: ['Noida'], shippers: [] } },     // origin-only
];
const defaults = { marginsPct: [5, 4, 3], minMarginPct: 3 };

const loads = [
  { companyName: 'Syngenta India Ltd', lane: { origin: 'Bhiwandi', destination: 'Pune' }, softClose: false, closeModelKnown: true },
  { companyName: 'Havells India Ltd', lane: { origin: 'Alwar', destination: 'Jaipur' }, softClose: false, closeModelKnown: true },
  { companyName: 'Rallis India Limited', lane: { origin: 'Noida', destination: 'Kota' }, softClose: false, closeModelKnown: true },
  { companyName: 'Unknown Shipper', lane: { origin: 'Noida', destination: 'X' }, softClose: false, closeModelKnown: true },
  { companyName: 'Syngenta India Ltd', lane: { origin: 'Noida', destination: 'Y' }, softClose: true, closeModelKnown: true }, // soft-close: out of hard scope
];

(async () => {
  const store = createStore({ backend: 'memory' });
  await store.putDoc('config', 'current', { allowlist: legacyAllowlist, recipients, marginsPct: defaults.marginsPct, minMarginPct: defaults.minMarginPct });
  for (const p of marginProfiles) await store.putDoc('marginProfiles', `${p.platformKey}:${p.customerKey}`, p);

  const res = await migrateLegacyModel({ store });
  ok(res.ran === true, 'migration ran on seeded legacy data');
  ok((await migrateLegacyModel({ store })).ran === false, 'migration is idempotent (no-op once the model is populated)');
  ok((await store.listDocs('marginProfiles')).length === 2, 'legacy marginProfiles retained (not deleted this release)');
  ok(Array.isArray((await store.getDoc('config', 'current')).recipients), 'legacy config.recipients retained');

  const customers = await new CustomerStore({ store }).list();
  const people = await new PersonStore({ store }).list();
  const assignments = await new AssignmentStore({ store }).list();
  ok(people.length === 3, 'every recipient became a person');

  // ---- GOLDEN: bidding targets ----
  const derived = resolveTargets({ account: { accountId: 'primary' }, customers, people, assignments, fallbackAllowlist: legacyAllowlist });
  for (const load of loads) {
    const legacyOk = matchesAllowlist(load, legacyAllowlist);
    const derivedOk = matchesAllowlist(load, derived);
    ok(legacyOk === derivedOk, `targets parity: "${load.companyName}"${load.softClose ? ' (soft)' : ''} legacy=${legacyOk} derived=${derivedOk}`);
  }

  // ---- GOLDEN: alert routing ----
  const rows = toRecipientRows(customers, people, assignments);
  let routingChecks = 0;
  for (const load of loads) {
    const data = { origin: load.lane.origin, shipper: load.companyName };
    for (const kind of ALERT_KINDS) {
      const legacySet = recipients.filter((r) => r.alerts.includes(kind) && scopeMatches(r.scope, data)).map((r) => r.phone).sort();
      const derivedSet = rows.filter((r) => r.alerts.includes(kind) && scopeMatches(r.scope, data)).map((r) => r.phone).sort();
      assert.deepStrictEqual(derivedSet, legacySet, `routing mismatch: "${load.companyName}" kind=${kind}`);
      routingChecks += 1;
    }
  }
  ok(routingChecks === loads.length * ALERT_KINDS.length, `routing parity holds for every load x kind (${routingChecks} checks)`);

  // ---- GOLDEN: margins ----
  for (const load of loads) {
    const legacy = resolveBand({ platformKey: 'sp', companyName: load.companyName, profiles: marginProfiles, defaults });
    const der = resolveMargin({ platformKey: 'sp', companyName: load.companyName, customers, assignments, defaults });
    ok(JSON.stringify(legacy.marginsPct) === JSON.stringify(der.marginsPct) && legacy.minMarginPct === der.minMarginPct,
      `margin parity: "${load.companyName}" -> [${der.marginsPct}] floor ${der.minMarginPct}`);
  }

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
