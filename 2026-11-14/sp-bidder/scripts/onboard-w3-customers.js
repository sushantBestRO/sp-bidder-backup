'use strict';

/**
 * onboard-w3-customers - seed the Week-3 customer-onboarding config for the SuperProcure
 * bidder as CONFIG DATA ONLY, and do it FLAG-SAFE.
 *
 *   node scripts/onboard-w3-customers.js                       # DRY-RUN (default): print the plan, write NOTHING
 *   node scripts/onboard-w3-customers.js --apply               # upsert the customer records into the store
 *   node scripts/onboard-w3-customers.js --apply --data-dir=./data
 *   node scripts/onboard-w3-customers.js --list                # print the definitions and exit (no store touched)
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS DOES (the whole of it): upserts one Customer record per Week-3 customer into the
 * store's `customers` collection - identity (label + aliases the load's companyName is matched
 * on) plus a schema-validated, INERT per-customer `rules` block (pricingMode / unit / closeModel
 * / softCloseOptIn) that records each customer's captured close-model fact. That is all.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO - the flag-safety wall:
 *   - It NEVER edits the allowlist. Discovery surfaces a load only when its companyName matches
 *     `config.allowlist.shippers` (the account's effective allowlist, or the global one) -
 *     src/discovery/discovery.js matchesAllowlist reads the ALLOWLIST, never the customers
 *     collection. So creating a Customer record surfaces ZERO loads: no dashboard worklist entry,
 *     no price-ask, nothing. A customer's loads begin surfacing only when an operator adds its
 *     token to the allowlist on the box (SP_ALLOWLIST_SHIPPERS / the account allowlist), and -
 *     for a soft-close customer - also to SP_SOFT_CLOSE_SHIPPERS after soft-close go-live. Those
 *     are separate, deliberate on-box steps, documented in .env.example. This script performs
 *     none of them.
 *   - It NEVER creates or touches a WhatsApp group, never registers a person/assignment, never
 *     writes the staffRoster, and never imports the notifier or the Maytapi client. Nothing here
 *     can send a message anywhere. (WhatsApp groups for these customers cannot be created yet -
 *     the sender is down - and nothing in this file depends on them.)
 *   - It NEVER touches the accounts collection, tokens, margins, or any engine/pricing knob.
 *
 * Because the live allowlist + customer/people/roster data all live in the box's gitignored
 * `data/` dir (never in git), MERGING this PR changes zero runtime behavior on its own. An
 * operator must (1) deliberately run this with --apply on the box to seed the records, and then,
 * separately, (2) edit the allowlist to actually surface a customer's loads. Two hands on the
 * wheel, by construction.
 *
 * Lineage: this is the ADAMA new-customer runbook (KNOWLEDGE.md, proven 2026-07-17) expressed as
 * a repeatable, reviewable, dry-run-default ops script - the same shape as scripts/add-account.js
 * (data edit via the store seam, dry-run first, prints operator next-steps) and
 * scripts/migrate-customer-slugs.js (dry-run default, --data-dir override, all-or-nothing).
 *
 * ---------------------------------------------------------------------------------------------
 * THE DATA. Facts are the delivery-lead rollout recon
 * (automated-bidding/_research/2026-07-25_sp-customer-rollout-scope.md s2, s4) and the committed-
 * milestones reconciliation (..._committed-milestones-reconciliation.md). Committed batch (Grid B
 * M3, due 01-Aug): Cords, Dynamic, Epack, ION, Safex. SIKA is pulled forward (Grid B M2), config-
 * ready, transit-only. KEI is already live (not seeded here). Rallis is login-gated (not here).
 *
 * `registration` is the SuperProcure registration/account the master-umbrella bids AS for this
 * customer (carrier routing L1, proven live) - operator reference for WHICH account's allowlist to
 * add the token to; it is NOT a companyName match token and is NOT persisted on the record.
 *
 * `closeModel` / `softCloseOptIn` are the customer-LEVEL close-model summary from the 90d on-box
 * census (2026-07-14) + the v4 open-board capture (2026-07-17). The AUTHORITY for any single load
 * is its own `branchAuctionExtendTime` (realAdapter.js), read PER BRANCH at the supervised first
 * bid. `extendSummary` is the reported per-branch extend window (informational; there is no extend-
 * minutes field in the rules schema). Per-BRANCH branchAuctionExtendTime is NOT present in this
 * repo's own data stores for any of these six customers - it is verified at step 6 of the runbook
 * (read it off a real load), NOT guessed here. A customer whose close model is genuinely UNVERIFIED
 * carries closeModel:null and gets NO rules block (SAFEX, below - the Mahindra Agri shape from W4).
 *
 * ---------------------------------------------------------------------------------------------
 * SAFEX - READ THIS BEFORE CALLING IT ONBOARDED, DELIVERED, OR A RATE-BOARD CUSTOMER.
 *
 * Safex is the one W3 customer whose BID MECHANIC is unresolved, and that outranks every other
 * gate: if it posts no timed auctions there is nothing for a close-timed snipe ladder to race, and
 * it belongs in the separate open-board scope of work alongside Cords Cable, not in this cohort.
 *
 * The state of the evidence, honestly: EVERY reading is n=1, and they point in OPPOSITE directions.
 *   FOR "open board" - the 2026-07-28 flow-gap pass saw ONE Safex load in 45 days and it carried
 *     the shared year-2100 placeholder close time. docs/SP_DELIVERY_STATUS.md 3.1 folds Safex in
 *     with Cords on that basis. But the Cords call is n=96 (96/96 placeholder, ever_live false) and
 *     the Safex call is n=1 by ANALOGY - the delivery doc's "Safex is the same" implies a shared
 *     evidence base that does not exist.
 *   AGAINST it - two independent 2026-07-13 records show a REAL timed Safex auction. (i) The census
 *     snapshot records statuses ["live"] + closeModels ["hard"]. Be precise about what that proves:
 *     _mapLoad reaches 'live' only via biddingOn===1 AND a boundedParse'd, already-elapsed
 *     startsAt, so it proves SuperProcure actually OPENED a bidding window on that load - it does
 *     not by itself prove the close was real (a real start with a placeholder close would also read
 *     'live'). But the placeholder is a PAIR (start 19:38:25, close 19:53:25, both year-2100), so a
 *     board-class load cannot produce a bounded start either: it falls to 'scheduled', never
 *     'live'. In that same snapshot Ashirvad's 51 loads all read 'unscheduled', so the placeholder
 *     rejection was working that day. Read the Havells rows in that snapshot as the CAVEAT rather
 *     than corroboration: all 3 also read 'unscheduled', and Havells is a confirmed auction
 *     customer - 'unscheduled' is simply the resting state between windows. That is exactly why
 *     'unscheduled' at n=1 is weak evidence for a board and 'live' at n=1 is strong evidence for an
 *     auction: the two readings are not symmetric. (ii) Load 23107518 closes the
 *     remaining gap on the CLOSE side: it produced a price request that was refused 50s past its
 *     deadlineAt with the close 37s later, and discovery drops every closesAt==null load BEFORE
 *     creating a price request while deadlineAt is derived as closesAt minus the lead - so that
 *     load provably carried a real, bounded close. Note this is a written incident analysis, not a
 *     retained payload (priceRequests.json is pruned to 2026-07-21), so treat it as strong
 *     secondary evidence rather than a capture.
 *   Also note Ashirvad, the precedent class, is 64 real / 251 placeholder - "open board customer"
 *     does NOT mean "never posts a timed auction", so the analogy proves less than it appears to.
 *
 * Two traps for whoever revisits this. (1) Do NOT cite the v4 capture's windowMin of 15 for Safex
 * as proof of a real 15-minute window: the placeholder pair (2100-05-24T19:38:25 -> 19:53:25) is
 * itself exactly 15.0 minutes, so a placeholder load computes windowMin 15. (2) Do NOT cite
 * branchAuctionExtendTime 00:02:00 as proof an auction runs - it is a BRANCH SETTING present on
 * board postings too (Ashirvad carries 00:01:00 on 38 loads).
 *
 * So Safex is seeded IDENTITY ONLY - closeModel:null, no rules block, no margin, four open gates -
 * and it must NOT be allowlisted or claimed as delivered. Settling it needs one artifact: a Safex
 * load payload with biddingOn===1 AND a biddingCloseTime inside boundedParse's +/-30d, or an SP
 * History-tab sweep scoped to Safex across BOTH named branches (Keshwana/Rajasthan 1081 and
 * Ludhiana/Punjab 1033 - the two sweeps disagree, and close model is per-BRANCH, so it may run both).
 *
 * `pricingMode` is 'flat' (FTL) for all six - the only buildable mode today (per_tonne/PMT is
 * unbuilt and fails closed, rulesConstants.SUPPORTED_MECHANICS). `unit` is 'MT' for all six (none
 * is a KG-configured branch; the KG branches are Ashirvad + Tata).
 *
 * `pmtExposure` records whether a customer carries per-tonne (PMT) loads on any branch, per the
 * 90d census Quote classification (branchQuoteType). This MATTERS because of a live runtime gap:
 * loadRules.deriveLoadRules HARDCODES pricingMode:'flat' for every real load (loadRules.js:68) and
 * does not yet classify branchQuoteType into per_tonne, so assertRulesSupported's per_tonne refusal
 * is DORMANT - a PMT load would today be bid as FLAT (a wrong-basis bid), and the ONLY thing
 * stopping that is that no PMT customer is allowlisted. Of these six, only CORDS CABLE carries a
 * PMT tail ("FTL (+PMT part)", census + rollout scope s2d/s7). Cords therefore MUST NOT be
 * allowlisted until BOTH (a) the PMT-classification guard fix lands (wiring branchQuoteType ->
 * pricingMode 'per_tonne' so the fail-closed refusal actually trips) AND (b) soft-close go-live.
 * Seeding Cords' record here is still safe (a record surfaces no loads); the gate is on the
 * allowlist step, and it is stated in .env.example and this script's output. The other five are
 * FTL per the census (Safex's FTL read rests on the same n=1-2 sample as everything else about it -
 * see the SAFEX block above, and treat it as unconfirmed); none is cleared to bid PMT.
 *
 * No `margin` is seeded: per-customer margin floors (L12) are an OPEN question for Suyashh. Until
 * he sets one, a record with no margin resolves to the global default band (config.marginsPct /
 * minMarginPct) - the existing, floor-safe behavior. A guessed margin would be worse than none.
 */

const path = require('path');
const config = require('../src/config');
const { createStore } = require('../src/store');
const { CustomerStore, slugifyLabel, COLLECTION: CUSTOMERS_COLLECTION } = require('../src/model/customerStore');
const { assertCustomerRulesValid } = require('../src/model/rulesConfig');

const BY = 'scripts/onboard-w3-customers.js';

// The Week-3 onboarding definitions. Editing THIS array is the whole config surface.
const W3_CUSTOMERS = Object.freeze([
  {
    label: 'SIKA India',
    aliases: ['SIKA'],
    registration: '2667 / master',
    closeModel: 'hard',
    softCloseOptIn: false,
    extendSummary: null,
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 129,
    pmtExposure: 'none',
    committed: 'Grid B M2 (25-Jul) - pulled forward; config-ready',
    mechanics: ['transit_time'],
    notes: 'Hard-close, transit-only - the easiest onboard (master account, one mechanic, transit proven live: null->400, "3"->201).',
  },
  {
    label: 'ION Exchange',
    aliases: [],
    registration: '85486 via master umbrella',
    closeModel: 'hard',
    softCloseOptIn: false,
    extendSummary: null,
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 9,
    pmtExposure: 'none',
    committed: 'Grid B M3 (01-Aug)',
    mechanics: ['carrier'],
    notes: 'Hard-close, carrier-routing only - trivial once carrier routing is confirmed on 85486; tiny volume, a low-cost verification datapoint.',
  },
  {
    label: 'Cords Cable',
    aliases: [],
    registration: '5963 via master umbrella',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '15m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 85,
    pmtExposure: 'partial',
    committed: 'Grid B M3 (01-Aug)',
    mechanics: ['carrier', 'transit_time', 'soft_close'],
    notes: 'Soft-close 15m (longest extend on the board). CARRIES A PMT TAIL ("FTL (+PMT part)", census). Do NOT allowlist until (a) the PMT-classification guard fix lands (branchQuoteType -> pricingMode per_tonne; the runtime guard is dormant today, loadRules.js:68) AND (b) soft-close go-live. Only the FTL slice is bid-safe.',
  },
  {
    label: 'Dynamic Cables',
    aliases: [],
    registration: '37391 via master umbrella',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '5m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 157,
    pmtExposure: 'none',
    committed: 'Grid B M3 (01-Aug)',
    mechanics: ['carrier', 'transit_time', 'soft_close'],
    notes: 'Soft-close 5m; highest soft-close FTL volume in the W3 batch.',
  },
  {
    label: 'Epack Prefab',
    aliases: ['Epack'],
    registration: '17360 via master umbrella',
    closeModel: 'soft',
    softCloseOptIn: true,
    extendSummary: '3m',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 92,
    pmtExposure: 'none',
    committed: 'Grid B M3 (01-Aug)',
    mechanics: ['carrier', 'soft_close'],
    notes: 'Soft-close 3m. Desk owner weakly indicated as Rajbir/Delhi (UNCONFIRMED - open question for Suyashh).',
  },
  {
    label: 'Safex Chemicals',
    // NO bare 'Safex' token. tokenMatch (src/util/tokenMatch.js) anchors the LEFT boundary only -
    // it checks h[i-1] and never h[i + token.length] - so 'Safex' also matches 'Safexpress', a
    // large Indian transporter. That is a live-money false positive on another company's freight.
    // The label alone is the safe token: validateCustomer seeds it as an alias, and the only
    // companyName ever observed for this customer is 'Safex Chemicals India Ltd.', which
    // 'Safex Chemicals' matches at index 0. So dropping the short form costs no real match.
    // Pinned by scripts/test-safex-onboarding.js section 10.
    aliases: [],
    registration: '5963 / 21764',
    // CLOSE MODEL DELIBERATELY UNVERIFIED (see the SAFEX block in the header). closeModel:null makes
    // buildCustomerRecord seed NO rules block - the Mahindra Agri shape from W4. The 'soft' + '2m'
    // this entry used to carry was a SINGLE-OBSERVATION guess dressed as a fact, and the project's
    // own bar refuses it: _research/2026-07-27_close-model-real-data.md scores Safex
    // "DO NOT ADD - INSUFFICIENT-DATA ... n=1 ... The seeded `soft 2m` is a guess dressed as a fact."
    // Withdrawing it is the point of this entry, not an oversight.
    closeModel: null,
    softCloseOptIn: false,
    extendSummary: null,
    // What WAS actually observed, kept as an informational fact rather than a declared close model.
    observedExtend: '00:02:00 on ONE branch (Keshwana, Rajasthan / 1081), n=1',
    // Whether Safex posts TIMED AUCTIONS at all is unresolved - the gate that outranks close model.
    auctionMechanic: 'unresolved',
    pricingMode: 'flat',
    unit: 'MT',
    volume90d: 2,
    pmtExposure: 'none',
    gates: ['auction_mechanic', 'close_model', 'soft_close', 'group'],
    committed: 'Grid B M3 (01-Aug); in paid-15 - NOT deliverable as a bidding customer on today\'s evidence',
    mechanics: ['carrier'],
    notes: 'AUCTION-vs-OPEN-BOARD UNRESOLVED, and that gate outranks every other one. docs/SP_DELIVERY_STATUS.md 3.1 classes Safex with Cords Cable as "not an auction customer", but that call rests on n=1 (the 45-day flow-gap pass saw ONE Safex load, carrying the year-2100 placeholder) and was reached by analogy to Cords, whose own evidence is strong (96/96 placeholder, ever_live false). TWO independent records from 2026-07-13 contradict it. (a) census snapshot _research/data/recon-census/snapshots/2026-07-13T13-33-58-091Z.json records Safex total 1, live 1, statuses ["live"], closeModels ["hard"] - and realAdapter._mapLoad can only reach status "live" through the biddingOn===1 branch with a real, already-elapsed startsAt, which a year-2100 placeholder can never satisfy; in that SAME snapshot Ashirvad 51 loads all read "unscheduled", proving placeholder-rejection was working that day. census-union.json carries ever_live:true for Safex, and of 21 censused companies only Ashirvad and Cords are ever_live:false. (b) load 23107518 (2026-07-13) produced a price request whose POST was refused 50s past deadlineAt with the close 37s later - discovery drops every closesAt==null load BEFORE creating a price request, so it provably carried a real, bounded close time. The Jul-28 pass could not have seen either (priceRequests.json is pruned to 2026-07-21). DO NOT cite the v4 capture windowMin of 15 as evidence of a real window: the placeholder pair (2100-05-24T19:38:25 -> 19:53:25) is itself exactly 15.0 minutes, so a placeholder load computes windowMin 15. Both live readings say HARD, matching the Jun-22 desk survey ("15 min FIXED (hard)") and KNOWLEDGE.md, and contradicting the withdrawn soft-2m seed. Branch identity is also unsettled - two sweeps name Keshwana/Rajasthan (1081) and Ludhiana/Punjab (1033) at n=1 each, and close model is per-BRANCH, so Safex may legitimately run both. Everything here is n=1 in each direction. Settling it needs an SP History-tab pull scoped to Safex across both branches. Until then: identity only, no rules block, no allowlist.',
  },
]);

/**
 * Build the CustomerStore.upsert() input for one definition. Pure - no store, no side effect - so
 * a test can assert the exact record shape and validate it. The record carries ONLY identity +
 * the inert rules block; never an allowlist entry, a group, a person, or a margin (see header).
 */
function buildCustomerRecord(def) {
  const rec = {
    label: def.label,
    aliases: def.aliases || [],
    enabled: true,
    updatedBy: BY,
  };
  // A customer whose close model is UNVERIFIED (Safex) is seeded with NO rules block - valid by the
  // schema (a customer with no rules block is the norm today), and honest. Identical to
  // scripts/onboard-w4-customers.js's handling of Mahindra Agri. The block is inert either way
  // (nothing in src/ reads customer.rules.closeModel or .softCloseOptIn - soft-close admission reads
  // config.softClose.shippers, and bidEngine's meta.rules is per-LOAD LoadRules, not this), so
  // dropping it changes zero runtime behaviour; what it changes is what the record CLAIMS.
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
 * (e.g. Epack Prefab, rollout scope s2c "CONFIGURED, NO GROUP" - the shape most likely to already
 * carry an operator-set margin) would blow them away with no diff, no warning, no prompt.
 *
 * Fix: before every upsert, read the CURRENT stored doc and carry its owned-elsewhere fields
 * forward onto the fresh record this script built. Identity + rules (label/aliases/rules/enabled)
 * always come from the fresh build - that IS this script's job, seeding the captured close-model
 * facts. A customer this script has never seen (existing == null) is unaffected; the fresh record
 * passes through untouched.
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
}

function printRemaining() {
  console.log('\nStill needed per customer before a supervised first bid (NOT done by this script):');
  console.log('  - WhatsApp group: create + populate (BLOCKED - sender 128023 is logged out).');
  console.log('  - Desk owner + roster numbers: UNKNOWN - Suyashh/Sushant to name (per-customer).');
  console.log('  - Register the group person + assignment once the group exists, so alerts route to it.');
  console.log('  - Per-customer margin floor (L12): Suyashh to dictate.');
  console.log('  - Soft-close customers (Cords/Dynamic/Epack): wait on soft-close go-live, then add');
  console.log('    to SP_SOFT_CLOSE_SHIPPERS with SP_SOFT_CLOSE_ENABLED=1 (mode stays shadow until graduated).');
  console.log('  - SAFEX is NOT on any allowlist path and must not be claimed as delivered. Its BID MECHANIC');
  console.log('    is unresolved (auction vs open board), every reading is n=1, and the two 2026-07-13 records');
  console.log('    contradict the 2026-07-28 open-board call. It is seeded identity-only with NO rules block.');
  console.log('    To settle it: one Safex load with biddingOn===1 AND a biddingCloseTime inside +/-30d, or an');
  console.log('    SP History-tab sweep across BOTH branches (Keshwana/Rajasthan 1081, Ludhiana/Punjab 1033).');
  console.log('  - PMT: CORDS CABLE carries a PMT tail. The runtime PMT classifier is dormant');
  console.log('    (loadRules.js hardcodes flat), so a PMT load would today be bid as flat. Do NOT allowlist');
  console.log('    Cords until the PMT-classification guard fix lands AND soft-close go-live. The other five');
  console.log('    are FTL per the census (Safex\'s FTL read is n=1-2 and unconfirmed, like the rest of it).');
  console.log('  - Supervised first bid: watch one live auction end-to-end before trusting the customer.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/onboard-w3-customers.js [--apply] [--list] [--data-dir=<dir>]');
    console.log('  default is DRY-RUN (prints the plan, writes nothing). --apply upserts the records.');
    return;
  }

  // Fail-closed pre-check: build + validate every rules block up front (same assertion the boot
  // gate runs, src/model/rulesConfig.js). A bad enum/typo here refuses the whole run rather than
  // writing a customer the real-money console could not boot on.
  const records = W3_CUSTOMERS.map(buildCustomerRecord);
  assertCustomerRulesValid(records.map((r) => ({ customerId: slugifyLabel(r.label), rules: r.rules })));

  if (args.list) {
    for (const def of W3_CUSTOMERS) {
      const closeLine = def.closeModel == null
        ? 'UNVERIFIED (no rules block seeded)'
        : `${def.closeModel}${def.extendSummary ? ` (extend ${def.extendSummary}, reported; per-branch UNVERIFIED in-repo)` : ''}`;
      console.log(`${slugifyLabel(def.label)}  (${def.label})`);
      console.log(`  registration : ${def.registration}`);
      console.log(`  close model  : ${closeLine}`);
      if (def.observedExtend) console.log(`  observed ext : ${def.observedExtend}  (a BRANCH SETTING - not evidence a timed auction runs)`);
      if (def.auctionMechanic) console.log(`  bid mechanic : ${def.auctionMechanic.toUpperCase()}  <-- auction vs open board is unresolved; outranks every other gate`);
      console.log(`  softCloseOptIn: ${def.softCloseOptIn}   pricingMode: ${def.pricingMode}   unit: ${def.unit}   vol/90d: ${def.volume90d}`);
      console.log(`  PMT exposure : ${def.pmtExposure}${def.pmtExposure !== 'none' ? '  <-- do NOT allowlist until the PMT-classification guard fix lands' : ''}`);
      if (def.gates && def.gates.length) console.log(`  open gates   : ${def.gates.join(', ')}  <-- NOT allowlist-ready`);
      console.log(`  committed    : ${def.committed}`);
      console.log(`  mechanics    : ${def.mechanics.join(', ')}`);
      console.log(`  notes        : ${def.notes}`);
    }
    return;
  }

  const dataDir = path.resolve(args.dataDir || process.env.SP_DATA_DIR || config.dataDir);
  console.log(`onboard-w3-customers: ${W3_CUSTOMERS.length} customer(s)`);
  console.log(`data dir : ${dataDir}`);
  console.log(`mode     : ${args.apply ? 'APPLY' : 'DRY-RUN (no writes; pass --apply to execute)'}\n`);

  const store = createStore({ dataDir, logDir: path.join(dataDir, 'logs'), backend: config.storeBackend });
  const customers = new CustomerStore({ store, log: (m) => console.log(m) });

  for (let i = 0; i < W3_CUSTOMERS.length; i++) {
    const def = W3_CUSTOMERS[i];
    const rec = records[i];
    const customerId = slugifyLabel(def.label);
    const existing = await store.getDoc(CUSTOMERS_COLLECTION, customerId).catch(() => null);
    const verb = existing ? 'update' : 'create';
    const toApply = preserveExisting(rec, existing);
    const preserved = existing && (existing.margin != null || existing.auction != null
      || (Array.isArray(existing.previousIds) && existing.previousIds.length) || existing.createdAt != null);
    console.log(`[${verb}] ${customerId}  label="${rec.label}"  aliases=[${(rec.aliases || []).join(', ')}]  rules=${JSON.stringify(rec.rules)}`);
    if (preserved) console.log('         read-modify-write: preserving existing margin/auction/previousIds/createdAt (not a blind replace)');
    if (args.apply) {
      const saved = await customers.upsert(toApply);
      console.log(`         saved (customerId ${saved.customerId}).`);
    }
  }

  if (!args.apply) console.log('\ndry-run complete - nothing written. Re-run with --apply to seed the records.');
  else console.log(`\napply complete: ${W3_CUSTOMERS.length} customer record(s) upserted to ${dataDir}.`);

  printSafetyBanner();
  printRemaining();
}

module.exports = { W3_CUSTOMERS, buildCustomerRecord, preserveExisting };

if (require.main === module) {
  main().catch((e) => { console.error('onboard-w3-customers failed:', (e && e.stack) || e); process.exit(1); });
}
