'use strict';

/**
 * onboard-w4-customers - seed the Week-4 customer-onboarding config for the SuperProcure
 * bidder as CONFIG DATA ONLY, and do it FLAG-SAFE. Same shape and safety wall as
 * scripts/onboard-w3-customers.js; only the cohort and its gates differ.
 *
 *   node scripts/onboard-w4-customers.js                       # DRY-RUN (default): print the plan, write NOTHING
 *   node scripts/onboard-w4-customers.js --apply               # upsert the customer records into the store
 *   node scripts/onboard-w4-customers.js --apply --data-dir=./data
 *   node scripts/onboard-w4-customers.js --list                # print the definitions and exit (no store touched)
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS DOES (the whole of it): upserts one Customer record per Week-4 customer into the
 * store's `customers` collection - identity (label + aliases the load's companyName is matched
 * on) plus a schema-validated, INERT per-customer `rules` block (pricingMode / unit / closeModel
 * / softCloseOptIn) that records each customer's captured close-model fact. One customer
 * (Mahindra Agri) has an UNVERIFIED close model and so is seeded WITHOUT a rules block. That is all.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO - the flag-safety wall (identical to W3):
 *   - It NEVER edits the allowlist. Discovery surfaces a load only when its companyName matches
 *     `config.allowlist.shippers` (the account's effective allowlist, or the global one) -
 *     src/discovery/discovery.js matchesAllowlist reads the ALLOWLIST, never the customers
 *     collection. So creating a Customer record surfaces ZERO loads: no dashboard worklist entry,
 *     no price-ask, nothing. A customer's loads begin surfacing only when an operator adds its
 *     token to the allowlist on the box (SP_ALLOWLIST_SHIPPERS / the account allowlist), and -
 *     for a soft-close customer - also to SP_SOFT_CLOSE_SHIPPERS after soft-close go-live. Those
 *     are separate, deliberate on-box steps, documented in .env.example. This script performs none.
 *   - It NEVER creates or touches a WhatsApp group, never registers a person/assignment, never
 *     writes the staffRoster, and never imports the notifier or the Maytapi client. Nothing here
 *     can send a message anywhere. (WhatsApp groups for the ungrouped W4 customers cannot be
 *     created yet - the sender is down - and nothing in this file depends on them.)
 *   - It NEVER touches the accounts collection, tokens, margins, or any engine/pricing knob.
 *
 * Because the live allowlist + customer/people/roster data all live in the box's gitignored
 * `data/` dir (never in git), MERGING this PR changes zero runtime behavior on its own. An
 * operator must (1) deliberately run this with --apply on the box to seed the records, and then,
 * separately, (2) edit the allowlist to actually surface a customer's loads. Two hands on the
 * wheel, by construction.
 *
 * Lineage: the ADAMA new-customer runbook (KNOWLEDGE.md, proven 2026-07-17) expressed as a
 * repeatable, reviewable, dry-run-default ops script - same shape as scripts/onboard-w3-customers.js
 * and scripts/add-account.js.
 *
 * ---------------------------------------------------------------------------------------------
 * THE DATA. Facts are the delivery-lead rollout recon
 * (automated-bidding/_research/2026-07-25_sp-customer-rollout-scope.md s2, s4) and the committed-
 * milestones reconciliation (..._committed-milestones-reconciliation.md s4 W4/M4 cohort). Committed
 * batch (Grid B M4, due 08-Aug): Goodluck, Payal Polyplast, Rajratan, Mahindra, Transrail, Vishal
 * Pipes, Premier Polyfilm, Shriji Polymers. RAJRATAN and MAHINDRA are UNASSIGNED - Suyashh's Jul-16
 * priority-list additions, NOT inside the paid-15 M2 bundle (scope-creep flag, reconciliation s2.3);
 * they are seeded here as identity + gates only. No customer in this batch is hard-close: the entire
 * W4 cohort is soft-close and/or PMT and/or mapping-gated, so NONE is on the "allowlist now" path.
 *
 * `registration` is the SuperProcure registration/account the master-umbrella bids AS for this
 * customer (carrier routing L1, proven live) - operator reference for WHICH account's allowlist to
 * add the token to; it is NOT a companyName match token and is NOT persisted on the record.
 *
 * `closeModel` / `softCloseOptIn` are the customer-LEVEL close-model summary (90d on-box census
 * 2026-07-14 + v4 open-board capture 2026-07-17). The AUTHORITY for any single load is its own
 * `branchAuctionExtendTime` (realAdapter.js), read PER BRANCH at the supervised first bid.
 * `extendSummary` is the reported per-branch extend window (informational; there is no extend-minutes
 * field in the rules schema). MAHINDRA AGRI has NEVER been seen on a bot-reachable account, so its
 * close model is genuinely UNKNOWN: it carries closeModel:null and gets NO rules block (a guessed
 * close model would be worse than none). Its mapping is unverified - verify master's mapped-vs-invited
 * Mahindra branches BEFORE any config.
 *
 * `pricingMode` is 'flat' (FTL) for every rules-bearing record - the only buildable mode today
 * (per_tonne/PMT is unbuilt and fails closed, rulesConstants.SUPPORTED_MECHANICS). This mirrors W3
 * exactly: even a PMT-carrying customer is recorded with pricingMode 'flat' (the buildable-mode
 * declaration) and its PMT exposure is captured in the SEPARATE `pmtExposure` field, not by declaring
 * per_tonne on the customer record. The runtime PMT protection is LOAD-level (branchQuoteType ->
 * pricingMode per_tonne in deriveLoadRules, the in-flight PMT guard fix/pmt-per-tonne-bidding), never
 * the customer rules block. `unit` is 'MT' for all (no W4 customer is a KG branch; KG = Ashirvad + Tata).
 *
 * `pmtExposure` records whether a customer carries per-tonne (PMT) loads, per the 90d census Quote
 * classification (branchQuoteType). This MATTERS because of a live runtime gap: until the PMT-
 * classification guard lands, loadRules.deriveLoadRules hardcodes pricingMode 'flat' for every real
 * load, so a PMT load would be bid as FLAT (a wrong-basis bid); and even once the guard lands, the
 * per-tonne WRITE wire is uncaptured (per_tonne is deliberately absent from SUPPORTED_MECHANICS), so
 * a PMT load fails CLOSED (refused), never bid. Five W4 customers carry full PMT exposure - GOODLUCK,
 * RAJRATAN, TRANSRAIL, VISHAL PIPES, PREMIER POLYFILM. Each is DOUBLE-gated: it MUST NOT be allowlisted
 * until BOTH (a) the PMT per-tonne mechanic ships (per_tonne joins SUPPORTED_MECHANICS with a wire
 * branch) AND (b) soft-close go-live. Seeding their records here is still safe (a record surfaces no
 * loads); the gate is on the allowlist step, stated in .env.example, this script's output, and the
 * test's flag-safety invariant. PAYAL and SHRIJI are FTL soft-close (soft-close-gated only; Shriji also
 * needs its L7 NOTES-field schedule built). MAHINDRA is mapping-gated (no engine mechanic).
 *
 * No `margin` is seeded: per-customer margin floors (L12) are an OPEN question for Suyashh. Until he
 * sets one, a record with no margin resolves to the global default band (config.marginsPct /
 * minMarginPct) - the existing, floor-safe behavior. A guessed margin would be worse than none.
 */

const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { CustomerStore, slugifyLabel, COLLECTION: CUSTOMERS_COLLECTION } = require('../src/model/customerStore');
const { assertCustomerRulesValid } = require('../src/model/rulesConfig');
const { SUPPORTED_MECHANICS } = require('../src/model/rulesConstants');

const BY = 'scripts/onboard-w4-customers.js';

// The Week-4 onboarding definitions. Editing THIS array is the whole config surface.
// `gates` is the set of OPEN blockers that keep a customer OFF the allowlist right now: 'pmt' (the
// unbuilt per-tonne mechanic), 'soft_close' (soft-close go-live), 'notes_schedule' (Shriji L7 edge),
// 'branch_mapping' (SuperProcure must map/verify the customer's branches). A non-empty gates list is
// the machine-checkable statement "not allowlist-ready" - the test enforces every W4 customer has one.
const W4_CUSTOMERS = Object.freeze([
  {
    label: 'Goodluck India',
    aliases: ['Goodluck'],
    registration: '2667 / master',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '1m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 2,
    pmtExposure: 'full',
    gates: ['pmt', 'soft_close'],
    committed: 'Grid B M4 (08-Aug); in paid-15',
    mechanics: ['per_tonne', 'soft_close'],
    notes: 'PMT + soft-close 1m. The proven PMT-lie load 23122869 (loadShipmentType reads FTL, the branch quotes per-tonne). DOUBLE-GATED: do NOT allowlist until the PMT per-tonne mechanic ships (per_tonne is absent from SUPPORTED_MECHANICS - a PMT load fails closed / would be mis-bid as flat before the guard) AND soft-close go-live. Tiny volume.',
  },
  {
    label: 'Payal Polyplast',
    aliases: ['Payal'],
    registration: '2667 / master',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '2m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 10,
    pmtExposure: 'none',
    gates: ['soft_close'],
    committed: 'Grid B M4 (08-Aug); in paid-15',
    mechanics: ['soft_close'],
    notes: 'FTL, soft-close 2m only. Group EXISTS but its owner (Virendra) is not yet in the Payal group. Gated on soft-close go-live.',
  },
  {
    label: 'Rajratan Wire',
    aliases: ['Rajratan'],
    registration: '2667 / master',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '1m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 18,
    pmtExposure: 'full',
    gates: ['pmt', 'soft_close'],
    committed: 'Grid B M4 (08-Aug); UNASSIGNED - not in paid-15 (scope-creep flag)',
    mechanics: ['per_tonne', 'soft_close'],
    notes: 'PMT + soft-close 1m (per-load bid cap 2). Largest reachable uncovered pool: 18 loads/90d census but ~327 open at the Jul-17 board (~69% of the open board). The reason to prioritise the PMT build, but DOUBLE-GATED (PMT + soft) so it cannot lead despite the volume. NOT in the paid 15 (Suyashh Jul-16 priority-list addition) - flag before promising it live.',
  },
  {
    label: 'Mahindra Agri',
    aliases: [],
    registration: 'unmapped - not visible on any bot-reachable account',
    closeModel: null,
    softCloseOptIn: false,
    extendSummary: null,
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 635,
    pmtExposure: 'none',
    mappingStatus: 'unverified',
    gates: ['branch_mapping'],
    committed: 'Grid B M4 (08-Aug); UNASSIGNED - not in paid-15 (scope-creep flag)',
    mechanics: ['branch_mapping'],
    notes: 'MAPPING STATUS UNVERIFIED. master getHeader lists Mahindra Agri branches WITH bid permission yet ZERO loads have ever been seen - looks like an invited-but-not-mapped gap, not dormancy, but this is UNCONFIRMED. Close model is therefore UNKNOWN (never observed) so NO rules block is seeded - guessing a closeModel would be worse than none. Verify master mapped-vs-invited Mahindra branches (the missing-branch audit) BEFORE any config or allowlist step. No engine mechanic needed. NOT in the paid 15.',
  },
  {
    label: 'Transrail Lighting',
    aliases: ['Transrail'],
    registration: '2667 / master',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '2m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 139,
    pmtExposure: 'full',
    gates: ['pmt', 'soft_close'],
    committed: 'Grid B M4 (08-Aug); in paid-15',
    mechanics: ['per_tonne', 'soft_close'],
    notes: 'PMT + soft-close 2m. DOUBLE-GATED: PMT per-tonne mechanic + soft-close go-live. Highest-volume PMT customer in the W4 batch.',
  },
  {
    label: 'Vishal Pipes',
    aliases: ['Vishal'],
    registration: '5667 via master umbrella',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '2m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 87,
    pmtExposure: 'full',
    gates: ['pmt', 'soft_close'],
    committed: 'Grid B M4 (08-Aug); in paid-15',
    mechanics: ['carrier', 'per_tonne', 'soft_close'],
    notes: 'PMT + soft-close 2m; reachable via 5667 master umbrella (carrier routing L1 proven on prod, not a build gate). The captured PMT wire shape (load 23195633: branchQuoteType/rateType PMT, loadShipmentType lies FTL) is Vishal Pipes. DOUBLE-GATED: PMT per-tonne mechanic + soft-close go-live.',
  },
  {
    label: 'Premier Polyfilm',
    aliases: ['Premier'],
    registration: '5667 via master umbrella',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '2m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 40,
    pmtExposure: 'full',
    gates: ['pmt', 'soft_close'],
    committed: 'Grid B M4 (08-Aug); in paid-15',
    mechanics: ['carrier', 'per_tonne', 'soft_close'],
    notes: 'PMT + soft-close 2m; reachable via 5667 master umbrella (carrier routing L1 proven on prod). DOUBLE-GATED: PMT per-tonne mechanic + soft-close go-live.',
  },
  {
    label: 'Shriji Polymers',
    aliases: ['Shriji'],
    registration: '2667 / master',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '3m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 3,
    pmtExposure: 'none',
    gates: ['soft_close', 'notes_schedule'],
    committed: 'Grid B M4 (08-Aug); in paid-15',
    mechanics: ['soft_close', 'ceiling', 'scheduled_notes'],
    notes: 'FTL, soft-close 3m. Carries a price CEILING ("90000.00", L5 - on prod) and its auction time lives in the free-text NOTES field (the L7 scheduled-window edge, UNBUILT). Gated on soft-close go-live AND the Shriji NOTES-schedule build; no known desk owner. Group exists.',
  },
]);

/**
 * Build the CustomerStore.upsert() input for one definition. Pure - no store, no side effect - so a
 * test can assert the exact record shape and validate it. The record carries ONLY identity + (for a
 * VERIFIED close model) the inert rules block; never an allowlist entry, a group, a person, or a
 * margin (see header). A customer whose close model is UNVERIFIED (Mahindra) is seeded with NO rules
 * block - valid by the schema (a customer with no rules block is the norm today), and honest.
 */
function buildCustomerRecord(def) {
  const rec = {
    label: def.label,
    aliases: def.aliases || [],
    enabled: true,
    updatedBy: BY,
  };
  if (def.closeModel != null) {
    rec.rules = {
      pricingMode: def.pricingMode,
      unit: def.unit,
      closeModel: def.closeModel,
      softCloseOptIn: def.softCloseOptIn,
    };
  }
  return rec;
}

/**
 * Read-modify-write guard (review 2026-07-25, finding 1: `--apply` silently destroys margin,
 * auction, previousIds and createdAt on an existing customer). CustomerStore.upsert ->
 * validateCustomer CONSTRUCTS A FRESH DOC from its input rather than merging into the stored one,
 * so any field this script has no opinion on (margin, auction, previousIds, createdAt) is simply
 * ABSENT from buildCustomerRecord's output and a bare --apply on an ALREADY-CONFIGURED customer
 * (Payal Polyplast and Shriji Polymers both show "GROUP EXISTS + configured" in rollout scope s2b -
 * the shape most likely to already carry an operator-set margin) would blow them away with no diff,
 * no warning, no prompt.
 *
 * Fix: before every upsert, read the CURRENT stored doc and carry its owned-elsewhere fields
 * forward onto the fresh record this script built. Identity + rules (label/aliases/rules/enabled)
 * always come from the fresh build - that IS this script's job, seeding the captured close-model
 * facts. A customer this script has never seen (existing == null) is unaffected; the fresh record
 * passes through untouched. Identical to scripts/onboard-w3-customers.js's preserveExisting.
 */
function preserveExisting(freshRecord, existing) {
  if (!existing) return freshRecord;
  const merged = { ...freshRecord };
  if (existing.margin != null) merged.margin = existing.margin;
  if (existing.auction != null) merged.auction = existing.auction;
  if (Array.isArray(existing.previousIds) && existing.previousIds.length) merged.previousIds = existing.previousIds;
  if (existing.createdAt != null) merged.createdAt = existing.createdAt;
  return merged;
}

function parseArgs(argv) {
  const out = { apply: false, list: false, dataDir: null };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length);
    else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  return out;
}

function printSafetyBanner() {
  console.log('\nSAFETY (why nothing can fire from this):');
  console.log('  - The allowlist is NOT touched. Discovery surfaces a load only when its companyName');
  console.log('    matches config.allowlist.shippers - never the customers collection. So these records');
  console.log('    surface ZERO loads and trigger ZERO price-asks until an operator adds each token to the');
  console.log('    allowlist on the box (see .env.example). No WhatsApp group, person, roster, or margin is');
  console.log('    written; the notifier/Maytapi client is never imported. Nothing here can send anywhere.');
  console.log(`  - The per-tonne (PMT) write wire is genuinely unbuilt: SUPPORTED_MECHANICS = [${SUPPORTED_MECHANICS.join(', ')}]`);
  console.log('    has no per_tonne, so even if a PMT customer were allowlisted its PMT loads fail CLOSED.');
}

function printRemaining() {
  console.log('\nStill needed per customer before a supervised first bid (NOT done by this script):');
  console.log('  - PMT cohort (Goodluck, Rajratan, Transrail, Vishal, Premier): DOUBLE-GATED. Do NOT');
  console.log('    allowlist until (a) the PMT per-tonne mechanic ships (per_tonne joins SUPPORTED_MECHANICS');
  console.log('    with a wire branch; feat/pmt-per-tonne-bidding, in flight) AND (b) soft-close go-live.');
  console.log('  - Soft-close cohort (all except Mahindra): wait on soft-close go-live, then add to');
  console.log('    SP_SOFT_CLOSE_SHIPPERS with SP_SOFT_CLOSE_ENABLED=1 (mode stays shadow until graduated).');
  console.log('  - Shriji: also needs the L7 NOTES-field schedule build (auction time is free-text NOTES).');
  console.log('  - Mahindra Agri: mapping UNVERIFIED - confirm master mapped-vs-invited branches with');
  console.log('    SuperProcure before any config; close model is unknown (no rules block seeded).');
  console.log('  - WhatsApp group: create + populate (BLOCKED - sender 128023 is logged out). Payal and');
  console.log('    Shriji groups exist; the rest are ungrouped.');
  console.log('  - Desk owner + roster numbers + per-customer margin floor (L12): Suyashh/Sushant to set.');
  console.log('  - Supervised first bid: watch one live auction end-to-end before trusting the customer.');
  console.log('  - Rajratan + Mahindra are NOT in the paid-15 bundle (scope-creep) - flag before live.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/onboard-w4-customers.js [--apply] [--list] [--data-dir=<dir>]');
    console.log('  default is DRY-RUN (prints the plan, writes nothing). --apply upserts the records.');
    return;
  }

  // Fail-closed pre-check: build + validate every rules block up front (same assertion the boot gate
  // runs, src/model/rulesConfig.js). A bad enum/typo here refuses the whole run rather than writing a
  // customer the real-money console could not boot on. Mahindra has no rules block; the guard skips it.
  const records = W4_CUSTOMERS.map(buildCustomerRecord);
  assertCustomerRulesValid(records.map((r) => ({ customerId: slugifyLabel(r.label), rules: r.rules })));

  if (args.list) {
    for (const def of W4_CUSTOMERS) {
      const closeLine = def.closeModel == null
        ? 'UNVERIFIED (never seen; no rules block seeded)'
        : `${def.closeModel}${def.extendSummary ? ` (extend ${def.extendSummary}, reported; per-branch UNVERIFIED in-repo)` : ''}`;
      console.log(`${slugifyLabel(def.label)}  (${def.label})`);
      console.log(`  registration : ${def.registration}`);
      console.log(`  close model  : ${closeLine}`);
      console.log(`  softCloseOptIn: ${def.softCloseOptIn}   pricingMode: ${def.pricingMode}   unit: ${def.unit}   vol/90d: ${def.volume90d}`);
      console.log(`  PMT exposure : ${def.pmtExposure}${def.pmtExposure !== 'none' ? '  <-- do NOT allowlist until the PMT per-tonne mechanic ships' : ''}`);
      if (def.mappingStatus) console.log(`  mapping      : ${def.mappingStatus.toUpperCase()}`);
      console.log(`  open gates   : ${(def.gates || []).join(', ') || '(none)'}`);
      console.log(`  committed    : ${def.committed}`);
      console.log(`  mechanics    : ${def.mechanics.join(', ')}`);
      console.log(`  notes        : ${def.notes}`);
    }
    return;
  }

  const dataDir = path.resolve(args.dataDir || process.env.SP_DATA_DIR || config.dataDir);
  console.log(`onboard-w4-customers: ${W4_CUSTOMERS.length} customer(s)`);
  console.log(`data dir : ${dataDir}`);
  console.log(`mode     : ${args.apply ? 'APPLY' : 'DRY-RUN (no writes; pass --apply to execute)'}\n`);

  const store = createStore({ dataDir, logDir: path.join(dataDir, 'logs'), backend: config.storeBackend });
  const customers = new CustomerStore({ store, log: (m) => console.log(m) });

  for (let i = 0; i < W4_CUSTOMERS.length; i++) {
    const def = W4_CUSTOMERS[i];
    const rec = records[i];
    const customerId = slugifyLabel(def.label);
    const existing = await store.getDoc(CUSTOMERS_COLLECTION, customerId).catch(() => null);
    const verb = existing ? 'update' : 'create';
    const toApply = preserveExisting(rec, existing);
    const preserved = existing && (existing.margin != null || existing.auction != null
      || (Array.isArray(existing.previousIds) && existing.previousIds.length) || existing.createdAt != null);
    const rulesStr = rec.rules ? JSON.stringify(rec.rules) : '(none - close model unverified)';
    console.log(`[${verb}] ${customerId}  label="${rec.label}"  aliases=[${(rec.aliases || []).join(', ')}]  rules=${rulesStr}`);
    if (preserved) console.log('         read-modify-write: preserving existing margin/auction/previousIds/createdAt (not a blind replace)');
    if (args.apply) {
      const saved = await customers.upsert(toApply);
      console.log(`         saved (customerId ${saved.customerId}).`);
    }
  }

  if (!args.apply) console.log('\ndry-run complete - nothing written. Re-run with --apply to seed the records.');
  else console.log(`\napply complete: ${W4_CUSTOMERS.length} customer record(s) upserted to ${dataDir}.`);

  printSafetyBanner();
  printRemaining();
}

module.exports = { W4_CUSTOMERS, buildCustomerRecord, preserveExisting };

if (require.main === module) {
  main().catch((e) => { console.error('onboard-w4-customers failed:', (e && e.stack) || e); process.exit(1); });
}
