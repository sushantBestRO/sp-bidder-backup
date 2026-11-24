'use strict';

/**
 * scripts/onboard-w3-customers.js - the Week-3 customer-onboarding config, pinned.
 *
 * Two things are tested, and the second matters most:
 *   1. THE DATA IS CORRECT + VALID. Exactly the six committed W3 customers (SIKA, ION, Cords,
 *      Dynamic, Epack, Safex) with the right close-model facts, and every built record passes
 *      CustomerStore.validateCustomer + the boot gate assertCustomerRulesValid (so a real-money
 *      console can boot on them).
 *   2. THE SCRIPT IS FLAG-SAFE. It writes ONLY the customers collection - never the allowlist,
 *      accounts, staffRoster, people, or assignments - and imports no notifier / WhatsApp client.
 *      This is asserted two ways: statically (the source references no forbidden write path) and
 *      dynamically (after a real --apply against a throwaway data dir, ONLY customers.json exists;
 *      no accounts/config/staffRoster/people/assignments file was created). That filesystem proof
 *      is the guarantee that merging + applying this config cannot, on its own, surface a load or
 *      send a message anywhere.
 *
 *   node scripts/test-w3-onboarding.js
 */

const assert = require('assert');
const os = require('os');
const fs = require('fs'); // allowed: test harness (fixture files + source read), not app state
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'onboard-w3-customers.js');
const { W3_CUSTOMERS, buildCustomerRecord } = require('./onboard-w3-customers');
const { validateCustomer, slugifyLabel } = require('../src/model/customerStore');
const { assertCustomerRulesValid } = require('../src/model/rulesConfig');

let pass = 0, fail = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const bad = (m) => { console.error('  FAIL - ' + m); fail++; };
const check = (cond, m) => { if (cond) return true; bad(m); return false; };

const EXPECTED = {
  'sika-india': { label: 'SIKA India', closeModel: 'hard', softCloseOptIn: false, aliases: ['SIKA'], pmtExposure: 'none' },
  'ion-exchange': { label: 'ION Exchange', closeModel: 'hard', softCloseOptIn: false, aliases: [], pmtExposure: 'none' },
  'cords-cable': { label: 'Cords Cable', closeModel: 'soft', softCloseOptIn: true, aliases: [], pmtExposure: 'partial' },
  'dynamic-cables': { label: 'Dynamic Cables', closeModel: 'soft', softCloseOptIn: true, aliases: [], pmtExposure: 'none' },
  'epack-prefab': { label: 'Epack Prefab', closeModel: 'soft', softCloseOptIn: true, aliases: ['Epack'], pmtExposure: 'none' },
  // closeModel:null == the UNVERIFIED customer (Safex): no rules block. Its BID MECHANIC (auction vs
  // open board) is unresolved at n=1 in both directions, so a declared close model would be a guess.
  'safex-chemicals': { label: 'Safex Chemicals', closeModel: null, softCloseOptIn: false, aliases: ['Safex'], pmtExposure: 'none', gates: ['auction_mechanic', 'close_model', 'soft_close', 'group'] },
};

function runScript(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });
}

// ---- 1. exactly the six committed customers, keyed by the slug the store will mint ----
{
  const bySlug = {};
  for (const def of W3_CUSTOMERS) bySlug[slugifyLabel(def.label)] = def;
  check(W3_CUSTOMERS.length === 6, `expected 6 W3 customers, got ${W3_CUSTOMERS.length}`);
  const gotSlugs = Object.keys(bySlug).sort();
  const wantSlugs = Object.keys(EXPECTED).sort();
  check(JSON.stringify(gotSlugs) === JSON.stringify(wantSlugs), `slug set mismatch: got ${gotSlugs} want ${wantSlugs}`);
  ok('the definitions are exactly the six committed W3 customers (SIKA, ION, Cords, Dynamic, Epack, Safex)');
}

// ---- 2. each customer's captured close-model facts are right ----
{
  const bySlug = {};
  for (const def of W3_CUSTOMERS) bySlug[slugifyLabel(def.label)] = def;
  for (const [slug, want] of Object.entries(EXPECTED)) {
    const def = bySlug[slug];
    if (!check(def, `missing definition ${slug}`)) continue;
    check(def.label === want.label, `${slug}: label "${def.label}" != "${want.label}"`);
    check(def.closeModel === want.closeModel, `${slug}: closeModel ${def.closeModel} != ${want.closeModel}`);
    check(def.softCloseOptIn === want.softCloseOptIn, `${slug}: softCloseOptIn ${def.softCloseOptIn} != ${want.softCloseOptIn}`);
    check(def.pricingMode === 'flat', `${slug}: pricingMode must be 'flat' (only buildable mode), got ${def.pricingMode}`);
    check(def.unit === 'MT', `${slug}: unit must be 'MT' (none is a KG branch), got ${def.unit}`);
    // hard + UNVERIFIED customers carry no extend window; soft customers carry a reported one
    if (def.closeModel === 'soft') check(typeof def.extendSummary === 'string' && def.extendSummary.length > 0, `${slug}: a soft customer must record a reported extend window`);
    else check(def.extendSummary == null, `${slug}: a hard/unverified customer must have no extendSummary`);
    // softCloseOptIn must agree with closeModel (neither a hard nor an unverified customer is soft-opted-in)
    check(def.softCloseOptIn === (def.closeModel === 'soft'), `${slug}: softCloseOptIn must track closeModel==soft`);
  }
  ok('every customer records the right close model (SIKA/ION hard; Cords/Dynamic/Epack soft; Safex UNVERIFIED) with matching softCloseOptIn');
}

// ---- 2b. PMT exposure is pinned, and NO allowlist-now (hard-close) customer carries PMT ----
// The runtime PMT classifier is dormant (loadRules hardcodes flat), so a PMT-carrying customer must
// never be presented as bid-ready. Cords is the only one with a PMT tail; it is soft-gated anyway,
// and every hard-close customer (the "allowlist now" set) must be PMT-clean.
{
  const bySlug = {};
  for (const def of W3_CUSTOMERS) bySlug[slugifyLabel(def.label)] = def;
  const VALID = ['none', 'partial', 'full'];
  for (const [slug, want] of Object.entries(EXPECTED)) {
    const def = bySlug[slug];
    if (!check(def, `missing definition ${slug}`)) continue;
    check(VALID.includes(def.pmtExposure), `${slug}: pmtExposure '${def.pmtExposure}' not one of ${VALID}`);
    check(def.pmtExposure === want.pmtExposure, `${slug}: pmtExposure ${def.pmtExposure} != ${want.pmtExposure}`);
    // safety invariant: a hard-close customer is the "allowlist now" set - it must carry no PMT.
    if (def.closeModel === 'hard') check(def.pmtExposure === 'none', `${slug}: a hard-close (allowlist-now) customer must have pmtExposure 'none', got ${def.pmtExposure}`);
    // any PMT-exposed customer must NOT be hard (i.e. must be soft/PMT-gated off the allowlist-now path).
    if (def.pmtExposure !== 'none') check(def.closeModel !== 'hard', `${slug}: a PMT-exposed customer must not be on the hard-close allowlist-now path`);
  }
  check(bySlug['cords-cable'].pmtExposure === 'partial', 'Cords Cable must record its PMT tail (pmtExposure partial)');
  ok('PMT exposure is pinned (only Cords partial); every hard-close allowlist-now customer is PMT-clean');
}

// ---- 3. every built record validates at write AND at the boot gate (fail-closed data) ----
{
  const built = W3_CUSTOMERS.map(buildCustomerRecord);
  const docs = built.map((r) => validateCustomer(r)); // throws on any invalid customer/rules block
  for (const doc of docs) {
    check(doc.enabled === true, `${doc.customerId}: expected enabled true`);
    check(!('margin' in doc) || doc.margin == null, `${doc.customerId}: no margin should be seeded (Suyashh sets the floor)`);
    // A VERIFIED customer must carry a rules block; an UNVERIFIED one (Safex) must carry NONE -
    // seeding a guessed closeModel is the specific failure this asserts against.
    const wantClose = (EXPECTED[doc.customerId] || {}).closeModel;
    if (wantClose == null) check(doc.rules == null, `${doc.customerId}: an unverified close model must seed NO rules block, got ${JSON.stringify(doc.rules)}`);
    else check(doc.rules && doc.rules.closeModel === wantClose, `${doc.customerId}: rules.closeModel must be ${wantClose}`);
    check(doc.aliases.includes(doc.label), `${doc.customerId}: label must be an alias (companyName match token)`);
  }
  assert.strictEqual(assertCustomerRulesValid(docs), true, 'boot gate accepts every built rules block');
  ok('buildCustomerRecord -> validateCustomer + assertCustomerRulesValid all pass; no margin is seeded; Safex seeds no rules block');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-w3-dry-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-w3-apply-'));
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
    if (want.closeModel == null) {
      check(doc.rules == null, `${slug}: persisted doc must carry NO rules block (close model unverified), got ${JSON.stringify(doc.rules)}`);
    } else {
      check(doc.rules && doc.rules.closeModel === want.closeModel, `${slug}: persisted rules.closeModel wrong`);
      check(doc.rules && doc.rules.softCloseOptIn === want.softCloseOptIn, `${slug}: persisted softCloseOptIn wrong`);
    }
    check(doc.enabled === true, `${slug}: persisted enabled should be true`);
    check(!doc.margin, `${slug}: persisted doc must carry no margin`);
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
  ok('--apply seeds only customers.json (correct rules, no margin), creates no allowlist/accounts/roster/routing file, and is idempotent');
}

// ---- 7. hardening: no seeded alias resolves against a known-live shipper name (silent
// margin-matching-pool join guard, review finding 3) ----
// matchCustomer's tie-break favours the LONGER alias, and every enabled customer (seeded ones
// included - buildCustomerRecord hardcodes enabled:true) is in the margin-matching pool from the
// moment of --apply, independent of the allowlist. Today's safety is "the chosen labels happen not
// to token-match any live shipper name," not a structural guard - pin the known-live roster names
// the review's own collision probe checked, so a future edit to this batch's aliases can't quietly
// reintroduce one.
{
  const { matchCustomer } = require('../src/model/resolve');
  const KNOWN_LIVE_COMPANY_NAMES = [
    'Havells India Ltd', 'KEI Industries Limited', 'Syngenta India Limited', 'Renewsys India Pvt Ltd',
    'Borosil Renewables Ltd', 'Durian Industries', 'Tata Consumer Products', 'ADAMA India Pvt Ltd',
    'Ashirvad Pipes Pvt Ltd',
  ];
  const seeded = W3_CUSTOMERS.map((def) => validateCustomer(buildCustomerRecord(def)));
  for (const companyName of KNOWN_LIVE_COMPANY_NAMES) {
    const hit = matchCustomer(companyName, seeded);
    check(!hit, `seeded W3 alias collides with live shipper "${companyName}" -> matched ${hit && hit.customerId}`);
  }
  ok('no W3 seeded alias resolves against a known-live shipper name (matchCustomer collision guard)');
}

// ---- 8. read-modify-write: --apply on an ALREADY-CONFIGURED customer preserves margin / auction /
// previousIds / createdAt instead of blind-replacing them (review finding 1) ----
let preserveCheckPromise = Promise.resolve();
{
  const { CustomerStore } = require('../src/model/customerStore');
  const { createStore } = require('../src/store');

  async function runPreserveCheck() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-w3-preserve-'));
    const preStore = createStore({ dataDir: dir, logDir: path.join(dir, 'logs'), backend: 'file' });
    const preCustomers = new CustomerStore({ store: preStore });
    const PRE_MARGIN = { marginsPct: [5, 8, 12], minMarginPct: 3 };
    const PRE_AUCTION = { attemptsAllowed: 4, closeModel: 'soft' };
    const PRE_PREVIOUS_IDS = ['epack-old-slug'];
    const PRE_CREATED_AT = 1710000000000;
    // Simulate an operator-configured Epack Prefab record (margin set via the console, a prior
    // rename recorded in previousIds) BEFORE this onboarding script has ever touched the box -
    // the exact shape the review reproduced the destructive-replace bug against.
    await preCustomers.upsert({
      label: 'Epack Prefab',
      aliases: ['Epack'],
      margin: PRE_MARGIN,
      auction: PRE_AUCTION,
      previousIds: PRE_PREVIOUS_IDS,
      createdAt: PRE_CREATED_AT,
      updatedBy: 'console:suyashh-set-floor',
    });

    const res = runScript(['--apply', `--data-dir=${dir}`]);
    check(res.status === 0, `preserve-check apply exit ${res.status}: ${res.stderr}`);

    const after = JSON.parse(fs.readFileSync(path.join(dir, 'customers.json'), 'utf8'));
    const epack = after['epack-prefab'];
    if (check(epack, 'epack-prefab must still exist after --apply')) {
      check(JSON.stringify(epack.margin) === JSON.stringify(PRE_MARGIN), `epack margin was dropped/changed: ${JSON.stringify(epack.margin)}`);
      check(JSON.stringify(epack.auction) === JSON.stringify(PRE_AUCTION), `epack auction was dropped/changed: ${JSON.stringify(epack.auction)}`);
      check(JSON.stringify(epack.previousIds) === JSON.stringify(PRE_PREVIOUS_IDS), `epack previousIds was dropped/changed: ${JSON.stringify(epack.previousIds)}`);
      check(epack.createdAt === PRE_CREATED_AT, `epack createdAt was dropped/changed: ${epack.createdAt}`);
      // and the run still refreshed the fields THIS script owns
      check(epack.rules && epack.rules.closeModel === 'soft', 'epack rules.closeModel should still be refreshed to soft');
      check(epack.updatedBy !== 'console:suyashh-set-floor', 'epack updatedBy should reflect this run, not the stale console value');
    }
    ok('--apply on an already-configured customer (Epack) preserves margin/auction/previousIds/createdAt (read-modify-write, not a blind replace)');
  }

  preserveCheckPromise = runPreserveCheck();
}

preserveCheckPromise.then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error('test-w3-onboarding crashed:', (e && e.stack) || e);
  process.exit(1);
});
