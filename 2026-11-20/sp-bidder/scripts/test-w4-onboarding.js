'use strict';

/**
 * scripts/onboard-w4-customers.js - the Week-4 customer-onboarding config, pinned.
 *
 * Two things are tested, and the second matters most:
 *   1. THE DATA IS CORRECT + VALID. Exactly the eight committed W4 customers (Goodluck, Payal,
 *      Rajratan, Mahindra, Transrail, Vishal, Premier, Shriji) with the right close-model facts,
 *      and every built record passes CustomerStore.validateCustomer + the boot gate
 *      assertCustomerRulesValid (so a real-money console can boot on them). Mahindra Agri's close
 *      model is UNVERIFIED and so is seeded WITHOUT a rules block.
 *   2. THE SCRIPT IS FLAG-SAFE, AND NO GATED CUSTOMER IS PRESENTED ALLOWLIST-READY. It writes ONLY
 *      the customers collection - never the allowlist, accounts, staffRoster, people, or assignments
 *      - and imports no notifier / WhatsApp client (asserted statically AND by a real --apply against
 *      a throwaway dir: ONLY customers.json is created). AND every W4 customer carries at least one
 *      OPEN gate, so none is "allowlist-ready": the PMT cohort is double-gated (pmt + soft_close) with
 *      per_tonne proven absent from SUPPORTED_MECHANICS (so a PMT load fails closed even if allowlisted);
 *      the soft-close cohort gates on soft_close; Mahindra gates on branch_mapping. That is the guarantee
 *      that merging + applying this config cannot, on its own, surface a load, send a message, or place a
 *      PMT bid on the wrong basis.
 *
 *   node scripts/test-w4-onboarding.js
 */

const assert = require('assert');
const os = require('os');
const fs = require('fs'); // allowed: test harness (fixture files + source read), not app state
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'onboard-w4-customers.js');
const { W4_CUSTOMERS, buildCustomerRecord } = require('./onboard-w4-customers');
const { validateCustomer, slugifyLabel } = require('../src/model/customerStore');
const { assertCustomerRulesValid } = require('../src/model/rulesConfig');
const { SUPPORTED_MECHANICS } = require('../src/model/rulesConstants');

let pass = 0, fail = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const bad = (m) => { console.error('  FAIL - ' + m); fail++; };
const check = (cond, m) => { if (cond) return true; bad(m); return false; };
const arrEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// closeModel:null == the UNVERIFIED customer (Mahindra): no rules block, mapping to confirm first.
const EXPECTED = {
  'goodluck-india':     { label: 'Goodluck India',     closeModel: 'soft', softCloseOptIn: true,  aliases: ['Goodluck'],  pmtExposure: 'full', gates: ['pmt', 'soft_close'] },
  'payal-polyplast':    { label: 'Payal Polyplast',    closeModel: 'soft', softCloseOptIn: true,  aliases: ['Payal'],     pmtExposure: 'none', gates: ['soft_close'] },
  'rajratan-wire':      { label: 'Rajratan Wire',      closeModel: 'soft', softCloseOptIn: true,  aliases: ['Rajratan'],  pmtExposure: 'full', gates: ['pmt', 'soft_close'] },
  'mahindra-agri':      { label: 'Mahindra Agri',      closeModel: null,   softCloseOptIn: false, aliases: [],            pmtExposure: 'none', gates: ['branch_mapping'], mappingStatus: 'unverified' },
  'transrail-lighting': { label: 'Transrail Lighting', closeModel: 'soft', softCloseOptIn: true,  aliases: ['Transrail'], pmtExposure: 'full', gates: ['pmt', 'soft_close'] },
  'vishal-pipes':       { label: 'Vishal Pipes',       closeModel: 'soft', softCloseOptIn: true,  aliases: ['Vishal'],    pmtExposure: 'full', gates: ['pmt', 'soft_close'] },
  'premier-polyfilm':   { label: 'Premier Polyfilm',   closeModel: 'soft', softCloseOptIn: true,  aliases: ['Premier'],   pmtExposure: 'full', gates: ['pmt', 'soft_close'] },
  'shriji-polymers':    { label: 'Shriji Polymers',    closeModel: 'soft', softCloseOptIn: true,  aliases: ['Shriji'],    pmtExposure: 'none', gates: ['soft_close', 'notes_schedule'] },
};
const PMT_SET = ['goodluck-india', 'rajratan-wire', 'transrail-lighting', 'vishal-pipes', 'premier-polyfilm'];

// The machine-checkable "safe to turn on NOW" predicate. A customer is allowlist-ready only with a
// hard close model, no PMT exposure, verified mapping, and NO open gate. Every W4 customer must FAIL this.
function isAllowlistReady(def) {
  return def.closeModel === 'hard'
    && def.pmtExposure === 'none'
    && def.mappingStatus !== 'unverified'
    && (def.gates || []).length === 0;
}

function runScript(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });
}

// ---- 1. exactly the eight committed customers, keyed by the slug the store will mint ----
{
  const bySlug = {};
  for (const def of W4_CUSTOMERS) bySlug[slugifyLabel(def.label)] = def;
  check(W4_CUSTOMERS.length === 8, `expected 8 W4 customers, got ${W4_CUSTOMERS.length}`);
  const gotSlugs = Object.keys(bySlug).sort();
  const wantSlugs = Object.keys(EXPECTED).sort();
  check(JSON.stringify(gotSlugs) === JSON.stringify(wantSlugs), `slug set mismatch: got ${gotSlugs} want ${wantSlugs}`);
  ok('the definitions are exactly the eight committed W4 customers (Goodluck, Payal, Rajratan, Mahindra, Transrail, Vishal, Premier, Shriji)');
}

// ---- 2. each customer's captured close-model facts are right ----
{
  const bySlug = {};
  for (const def of W4_CUSTOMERS) bySlug[slugifyLabel(def.label)] = def;
  for (const [slug, want] of Object.entries(EXPECTED)) {
    const def = bySlug[slug];
    if (!check(def, `missing definition ${slug}`)) continue;
    check(def.label === want.label, `${slug}: label "${def.label}" != "${want.label}"`);
    check(def.closeModel === want.closeModel, `${slug}: closeModel ${def.closeModel} != ${want.closeModel}`);
    check(def.softCloseOptIn === want.softCloseOptIn, `${slug}: softCloseOptIn ${def.softCloseOptIn} != ${want.softCloseOptIn}`);
    check(def.pricingMode === 'flat', `${slug}: pricingMode must be 'flat' (only buildable mode; PMT recorded via pmtExposure), got ${def.pricingMode}`);
    check(def.unit === 'MT', `${slug}: unit must be 'MT' (none is a KG branch), got ${def.unit}`);
    // softCloseOptIn must agree with closeModel (a hard/unverified customer is never soft-opted-in)
    check(def.softCloseOptIn === (def.closeModel === 'soft'), `${slug}: softCloseOptIn must track closeModel==soft`);
    if (def.closeModel === 'soft') {
      check(typeof def.extendSummary === 'string' && def.extendSummary.length > 0, `${slug}: a soft customer must record a reported extend window`);
    } else {
      // the UNVERIFIED customer: no close model, no extend window, mapping flagged
      check(def.closeModel === null, `${slug}: a non-soft W4 customer must be closeModel null (UNVERIFIED), got ${def.closeModel}`);
      check(def.extendSummary == null, `${slug}: an unverified customer must have no extendSummary`);
      check(def.mappingStatus === 'unverified', `${slug}: an unverified (no-close-model) customer must be marked mappingStatus 'unverified'`);
    }
  }
  ok('every customer records the right close model (7 soft + Mahindra unverified) with matching softCloseOptIn');
}

// ---- 2b. PMT exposure pinned + NO customer is presented allowlist-ready while its gates are open ----
// The runtime PMT classifier/write is dormant/unbuilt, so a PMT-carrying customer must never be
// bid-ready. In W4 the entire cohort is gated: every customer must carry >=1 open gate, and each PMT
// customer must be DOUBLE-gated (pmt + soft_close) and never hard-close.
{
  const bySlug = {};
  for (const def of W4_CUSTOMERS) bySlug[slugifyLabel(def.label)] = def;
  const VALID = ['none', 'partial', 'full'];
  for (const [slug, want] of Object.entries(EXPECTED)) {
    const def = bySlug[slug];
    if (!check(def, `missing definition ${slug}`)) continue;
    check(VALID.includes(def.pmtExposure), `${slug}: pmtExposure '${def.pmtExposure}' not one of ${VALID}`);
    check(def.pmtExposure === want.pmtExposure, `${slug}: pmtExposure ${def.pmtExposure} != ${want.pmtExposure}`);
    check(arrEq(def.gates || [], want.gates), `${slug}: gates [${(def.gates || []).join(',')}] != [${want.gates.join(',')}]`);
    // no W4 customer is hard-close (the whole cohort is soft / PMT / mapping-gated).
    check(def.closeModel !== 'hard', `${slug}: no W4 customer is hard-close, got ${def.closeModel}`);
    // every customer carries at least one OPEN gate -> none is allowlist-ready.
    check((def.gates || []).length >= 1, `${slug}: every W4 customer must carry >=1 open gate (not allowlist-ready)`);
    check(!isAllowlistReady(def), `${slug}: must NOT be allowlist-ready while gates are open`);
    // 'pmt' in gates IFF the customer carries PMT exposure.
    check(((def.gates || []).includes('pmt')) === (def.pmtExposure !== 'none'), `${slug}: 'pmt' gate must match pmtExposure`);
    if (def.pmtExposure !== 'none') {
      // a PMT customer is DOUBLE-gated: pmt + soft_close, soft close model, and per_tonne mechanic named.
      check(def.closeModel === 'soft', `${slug}: a PMT customer must be soft-close (double-gated), got ${def.closeModel}`);
      check((def.gates || []).includes('soft_close'), `${slug}: a PMT customer must ALSO carry the soft_close gate`);
      check((def.mechanics || []).includes('per_tonne'), `${slug}: a PMT customer must name the per_tonne mechanic`);
    }
  }
  check(arrEq(W4_CUSTOMERS.filter((d) => d.pmtExposure !== 'none').map((d) => slugifyLabel(d.label)), PMT_SET),
    `the PMT set must be exactly ${PMT_SET.join(', ')}`);
  check(W4_CUSTOMERS.every((d) => !isAllowlistReady(d)), 'NO W4 customer may be presented allowlist-ready');
  ok('PMT exposure pinned (Goodluck/Rajratan/Transrail/Vishal/Premier full; rest none); every customer is gated, PMT ones double-gated, none allowlist-ready');
}

// ---- 2c. the fail-closed code invariant that makes seeding a PMT customer safe regardless of flags ----
// per_tonne is deliberately absent from SUPPORTED_MECHANICS: even if an operator allowlisted a PMT
// customer today, its per-tonne loads would be REFUSED (fail closed), never bid on a wrong (flat) basis.
{
  check(Array.isArray(SUPPORTED_MECHANICS), 'SUPPORTED_MECHANICS must be an array');
  check(!SUPPORTED_MECHANICS.includes('per_tonne'), `per_tonne must NOT be in SUPPORTED_MECHANICS (it is unbuilt / fails closed); got [${SUPPORTED_MECHANICS.join(', ')}]`);
  ok('per_tonne is absent from SUPPORTED_MECHANICS - a PMT load fails closed even if its customer were allowlisted');
}

// ---- 2d. Mahindra Agri is the UNVERIFIED customer: mapping flagged, NO rules block ----
{
  const mahindra = W4_CUSTOMERS.find((d) => slugifyLabel(d.label) === 'mahindra-agri');
  if (check(mahindra, 'mahindra-agri definition present')) {
    check(mahindra.mappingStatus === 'unverified', 'Mahindra mappingStatus must be unverified');
    check(mahindra.closeModel === null, 'Mahindra closeModel must be null (never observed)');
    check(arrEq(mahindra.gates || [], ['branch_mapping']), 'Mahindra must gate on branch_mapping only');
    const rec = buildCustomerRecord(mahindra);
    check(!('rules' in rec), 'buildCustomerRecord(Mahindra) must emit NO rules block (close model unverified)');
    const doc = validateCustomer(rec); // must still validate as a rules-less customer
    check(!('rules' in doc), 'a validated Mahindra doc carries no rules block');
    check(doc.aliases.includes('Mahindra Agri'), 'Mahindra label must be an alias');
  }
  ok('Mahindra Agri is seeded identity-only (no rules block), mapping marked unverified, gated on branch_mapping');
}

// ---- 3. every built record validates at write AND at the boot gate (fail-closed data) ----
{
  const built = W4_CUSTOMERS.map(buildCustomerRecord);
  const docs = built.map((r) => validateCustomer(r)); // throws on any invalid customer/rules block
  for (const doc of docs) {
    check(doc.enabled === true, `${doc.customerId}: expected enabled true`);
    check(!('margin' in doc) || doc.margin == null, `${doc.customerId}: no margin should be seeded (Suyashh sets the floor)`);
    check(doc.aliases.includes(doc.label), `${doc.customerId}: label must be an alias (companyName match token)`);
    if ('rules' in doc && doc.rules) {
      check(['hard', 'soft'].includes(doc.rules.closeModel), `${doc.customerId}: rules.closeModel must be a valid close model`);
    }
  }
  // exactly one customer (Mahindra) has no rules block; the other seven do.
  check(docs.filter((d) => !('rules' in d) || !d.rules).length === 1, 'exactly one W4 customer (Mahindra) is seeded with no rules block');
  assert.strictEqual(assertCustomerRulesValid(docs), true, 'boot gate accepts every built rules block');
  ok('buildCustomerRecord -> validateCustomer + assertCustomerRulesValid all pass; no margin is seeded; Mahindra rules-less');
}

// ---- 4. STATIC flag-safety: the source touches no forbidden write path / send path ----
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // Strip block + line comments so the prose (which necessarily NAMES the allowlist / WhatsApp /
  // groups to explain what it avoids) can never trip these code-only guards.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const forbidden = [
    [/require\(\s*['"][^'"]*notify/i, 'imports the notifier / WhatsApp path'],
    [/require\(\s*['"][^'"]*whatsapp/i, 'imports the Maytapi WhatsApp client'],
    [/require\(\s*['"][^'"]*auth\/accounts/i, 'imports the accounts store'],
    [/require\(\s*['"][^'"]*staffRoster/i, 'imports the staffRoster'],
    [/\.putDoc\s*\(/, 'writes the store directly (must go only through CustomerStore.upsert)'],
    [/sendText|createGroup|_deliverGroup/i, 'references a WhatsApp send/group call'],
    [/SP_ALLOWLIST|SP_SOFT_CLOSE_SHIPPERS\s*=/, 'assigns an allowlist / soft-close env value'],
  ];
  for (const [re, why] of forbidden) check(!re.test(code), `source ${why} (matched ${re})`);
  ok('script source references no allowlist write, no accounts/roster write, and no WhatsApp send/group call');
}

// ---- 5. DRY-RUN (default) writes NOTHING ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-w4-dry-'));
  const res = runScript([`--data-dir=${dir}`]);
  check(res.status === 0, `dry-run exit ${res.status}: ${res.stderr}`);
  check(/DRY-RUN/.test(res.stdout), 'dry-run banner not printed');
  check(!fs.existsSync(path.join(dir, 'customers.json')), 'dry-run must not write customers.json');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  check(files.length === 0, `dry-run wrote files: ${files.join(', ')}`);
  ok('dry-run (the default) prints the plan and writes nothing');
}

// ---- 6. --apply seeds ONLY customers.json, with the right rules, and NOTHING else ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-w4-apply-'));
  const res = runScript(['--apply', `--data-dir=${dir}`]);
  check(res.status === 0, `apply exit ${res.status}: ${res.stderr}`);

  const custPath = path.join(dir, 'customers.json');
  check(fs.existsSync(custPath), 'apply must write customers.json');
  const customers = JSON.parse(fs.readFileSync(custPath, 'utf8'));
  const ids = Object.keys(customers).sort();
  check(JSON.stringify(ids) === JSON.stringify(Object.keys(EXPECTED).sort()), `apply wrote wrong customer set: ${ids}`);
  for (const [slug, want] of Object.entries(EXPECTED)) {
    const doc = customers[slug];
    if (!check(doc, `apply missing ${slug}`)) continue;
    check(doc.label === want.label, `${slug}: persisted label wrong`);
    check(doc.enabled === true, `${slug}: persisted enabled should be true`);
    check(!doc.margin, `${slug}: persisted doc must carry no margin`);
    if (want.closeModel == null) {
      check(!('rules' in doc) || !doc.rules, `${slug}: unverified customer must persist with NO rules block`);
    } else {
      check(doc.rules && doc.rules.closeModel === want.closeModel, `${slug}: persisted rules.closeModel wrong`);
      check(doc.rules && doc.rules.softCloseOptIn === want.softCloseOptIn, `${slug}: persisted softCloseOptIn wrong`);
      check(doc.rules && doc.rules.pricingMode === 'flat', `${slug}: persisted pricingMode must be flat`);
    }
  }

  // THE flag-safety proof: no allowlist / accounts / roster / routing artifact was created.
  for (const forbidden of ['accounts.json', 'config.json', 'staffRoster.json', 'people.json', 'assignments.json']) {
    check(!fs.existsSync(path.join(dir, forbidden)), `apply must NOT create ${forbidden} (would risk surfacing loads / routing sends)`);
  }
  // idempotent: a second apply re-upserts the same set with no error and no new customer keys.
  const res2 = runScript(['--apply', `--data-dir=${dir}`]);
  check(res2.status === 0, `second apply exit ${res2.status}: ${res2.stderr}`);
  const after = Object.keys(JSON.parse(fs.readFileSync(custPath, 'utf8'))).sort();
  check(JSON.stringify(after) === JSON.stringify(ids), 'second apply changed the customer key set (not idempotent)');
  ok('--apply seeds only customers.json (correct rules, Mahindra rules-less, no margin), creates no allowlist/accounts/roster/routing file, and is idempotent');
}

// ---- 7. hardening: no seeded alias resolves against a known-live shipper name (silent
// margin-matching-pool join guard, review finding 3) ----
// matchCustomer's tie-break favours the LONGER alias, and every enabled customer (seeded ones
// included - buildCustomerRecord hardcodes enabled:true) is in the margin-matching pool from the
// moment of --apply, independent of the allowlist and independent of the open gates above. Today's
// safety is "the chosen labels happen not to token-match any live shipper name," not a structural
// guard - pin the known-live roster names the review's own collision probe checked, so a future
// edit to this batch's aliases can't quietly reintroduce one.
{
  const { matchCustomer } = require('../src/model/resolve');
  const KNOWN_LIVE_COMPANY_NAMES = [
    'Havells India Ltd', 'KEI Industries Limited', 'Syngenta India Limited', 'Renewsys India Pvt Ltd',
    'Borosil Renewables Ltd', 'Durian Industries', 'Tata Consumer Products', 'ADAMA India Pvt Ltd',
    'Ashirvad Pipes Pvt Ltd',
  ];
  const seeded = W4_CUSTOMERS.map((def) => validateCustomer(buildCustomerRecord(def)));
  for (const companyName of KNOWN_LIVE_COMPANY_NAMES) {
    const hit = matchCustomer(companyName, seeded);
    check(!hit, `seeded W4 alias collides with live shipper "${companyName}" -> matched ${hit && hit.customerId}`);
  }
  ok('no W4 seeded alias resolves against a known-live shipper name (matchCustomer collision guard)');
}

// ---- 8. read-modify-write: --apply on an ALREADY-CONFIGURED customer preserves margin / auction /
// previousIds / createdAt instead of blind-replacing them (review finding 1). Both Payal Polyplast
// and Shriji Polymers show "GROUP EXISTS + configured" in the rollout scope (s2b) - the shape most
// likely to already carry an operator-set margin - so both are exercised here. ----
let preserveCheckPromise = Promise.resolve();
{
  const { CustomerStore } = require('../src/model/customerStore');
  const { createStore } = require('../src/store');

  async function preseedAndCheck(dir, preCustomers, { label, aliases, slugId, closeModel }) {
    const PRE_MARGIN = { marginsPct: [4, 7, 10], minMarginPct: 2.5 };
    const PRE_AUCTION = { attemptsAllowed: 3, closeModel: 'soft' };
    const PRE_PREVIOUS_IDS = [`${slugId}-old-slug`];
    const PRE_CREATED_AT = 1705000000000;
    // Simulate an operator-configured record (margin set via the console, a prior rename recorded
    // in previousIds) BEFORE this onboarding script has ever touched the box - the exact shape the
    // review reproduced the destructive-replace bug against (payal-polyplast).
    await preCustomers.upsert({
      label, aliases, margin: PRE_MARGIN, auction: PRE_AUCTION, previousIds: PRE_PREVIOUS_IDS,
      createdAt: PRE_CREATED_AT, updatedBy: 'console:suyashh-set-floor',
    });

    const res = runScript(['--apply', `--data-dir=${dir}`]);
    check(res.status === 0, `preserve-check apply exit ${res.status}: ${res.stderr}`);

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'customers.json'), 'utf8'));
    const doc = after[slugId];
    if (check(doc, `${slugId} must still exist after --apply`)) {
      check(JSON.stringify(doc.margin) === JSON.stringify(PRE_MARGIN), `${slugId} margin was dropped/changed: ${JSON.stringify(doc.margin)}`);
      check(JSON.stringify(doc.auction) === JSON.stringify(PRE_AUCTION), `${slugId} auction was dropped/changed: ${JSON.stringify(doc.auction)}`);
      check(JSON.stringify(doc.previousIds) === JSON.stringify(PRE_PREVIOUS_IDS), `${slugId} previousIds was dropped/changed: ${JSON.stringify(doc.previousIds)}`);
      check(doc.createdAt === PRE_CREATED_AT, `${slugId} createdAt was dropped/changed: ${doc.createdAt}`);
      // and the run still refreshed the fields THIS script owns
      check(doc.rules && doc.rules.closeModel === closeModel, `${slugId} rules.closeModel should still be refreshed to ${closeModel}`);
      check(doc.updatedBy !== 'console:suyashh-set-floor', `${slugId} updatedBy should reflect this run, not the stale console value`);
    }
  }

  async function runPreserveCheck() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-w4-preserve-'));
    const preStore = createStore({ dataDir: dir, logDir: path.join(dir, 'logs'), backend: 'file' });
    const preCustomers = new CustomerStore({ store: preStore });
    await preseedAndCheck(dir, preCustomers, { label: 'Payal Polyplast', aliases: ['Payal'], slugId: 'payal-polyplast', closeModel: 'soft' });
    await preseedAndCheck(dir, preCustomers, { label: 'Shriji Polymers', aliases: ['Shriji'], slugId: 'shriji-polymers', closeModel: 'soft' });
    ok('--apply on already-configured customers (Payal Polyplast, Shriji Polymers) preserves margin/auction/previousIds/createdAt (read-modify-write, not a blind replace)');
  }

  preserveCheckPromise = runPreserveCheck();
}

preserveCheckPromise.then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('test-w4-onboarding crashed:', (e && e.stack) || e);
  process.exit(1);
});
