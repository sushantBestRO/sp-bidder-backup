'use strict';

/**
 * Safex Chemicals - the onboarding posture, pinned.
 *
 * Safex is the one Week-3 customer whose BID MECHANIC is unresolved: whether it posts timed
 * auctions at all, or open-board postings with no close (the Cords Cable / Ashirvad class). Every
 * reading on disk is n=1 and they contradict each other - see the SAFEX block in
 * scripts/onboard-w3-customers.js for the full evidence. This file exists so that posture cannot
 * quietly regress into a claim, because the failure mode is not a crash: it is a customer put in
 * front of the client on the wrong mechanic, or a paste that enrols it for real money.
 *
 * What it pins, in order of how much it matters:
 *   1. NO GUESSED FACT. Safex seeds closeModel:null and therefore NO rules block, carries no
 *      margin, and does not carry the withdrawn 'soft'/'2m'/softCloseOptIn:true seed.
 *   2. NOT ALLOWLIST-READY, machine-checkably: it carries open gates including 'auction_mechanic'.
 *   3. THE RECORD SURFACES NOTHING. Proven through resolveTargets - the real gate - rather than
 *      asserted: a seeded Safex record with no ENABLED assignment contributes zero targets, and the
 *      same fixture WITH an enabled assignment does contribute one. That second half is what makes
 *      the first half meaningful (it proves the probe can detect the thing it is claiming is absent)
 *      and it is the exact path that put ION Exchange live by accident on 2026-07-27.
 *   4. THE ENGINE STAYS FAIL-CLOSED on a Safex-shaped load whose close model is unverified, and the
 *      year-2100 placeholder still maps to closesAt:null (which is what makes it undiscoverable).
 *   5. THE PASTE LANDMINE STAYS DEFUSED: .env.example's example SP_SOFT_CLOSE_SHIPPERS line must
 *      not contain Safex. It used to. Pasting that line is the fastest way to enrol Safex by hand.
 *   6. THE TWO EVIDENCE TRAPS are pinned as executable arithmetic, not prose, so a future reader
 *      cannot re-derive "15-minute window == real auction" from the v4 capture.
 *
 *   node scripts/test-safex-onboarding.js
 */

const assert = require('assert');
const os = require('os');
const fs = require('fs'); // allowed: test harness (fixture + source read), not app state
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'onboard-w3-customers.js');
const ENV_EXAMPLE = path.join(__dirname, '..', '.env.example');
const { W3_CUSTOMERS, buildCustomerRecord } = require('./onboard-w3-customers');
const { validateCustomer, slugifyLabel } = require('../src/model/customerStore');
const { assertCustomerRulesValid } = require('../src/model/rulesConfig');
const { resolveTargets, matchCustomer } = require('../src/model/resolve');
const { softAdmitted } = require('../src/discovery/discovery');
const { tokenMatch } = require('../src/util/tokenMatch');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0, fail = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const bad = (m) => { console.error('  FAIL - ' + m); fail++; };
const check = (cond, m) => { if (cond) return true; bad(m); return false; };

const SLUG = 'safex-chemicals';
const SAFEX = W3_CUSTOMERS.find((d) => slugifyLabel(d.label) === SLUG);
// SuperProcure's shared "this load never had an auction" sentinel, and the start value that rides
// with it. Both verbatim from the live captures.
const PLACEHOLDER_CLOSE = '2100-05-24T19:53:25.000Z';
const PLACEHOLDER_START = '2100-05-24T19:38:25.000Z';

// ---- 1. the definition exists and asserts NO close model ----
{
  if (check(SAFEX, 'Safex Chemicals must still be defined in W3_CUSTOMERS')) {
    check(SAFEX.label === 'Safex Chemicals', `label wrong: ${SAFEX.label}`);
    check(Array.isArray(SAFEX.aliases) && !SAFEX.aliases.includes('Safex'),
      'the bare "Safex" token must NOT come back - it matches Safexpress (see section 10)');
    check(SAFEX.closeModel === null, `closeModel must be null (unverified), got ${JSON.stringify(SAFEX.closeModel)}`);
    check(SAFEX.softCloseOptIn === false, 'softCloseOptIn must be false while the close model is unverified');
    check(SAFEX.extendSummary == null, 'extendSummary must be null - the withdrawn "2m" was a single-observation guess');
    check(SAFEX.auctionMechanic === 'unresolved', `auctionMechanic must be 'unresolved', got ${JSON.stringify(SAFEX.auctionMechanic)}`);
  }
  ok('Safex is defined and declares NO close model (the withdrawn soft/2m seed does not come back)');
}

// ---- 2. the built + persisted-shape record carries no rules block and no margin ----
{
  const rec = buildCustomerRecord(SAFEX);
  check(rec.rules === undefined, `buildCustomerRecord must emit NO rules key, got ${JSON.stringify(rec.rules)}`);
  const doc = validateCustomer(rec);
  check(doc.rules == null, `validated doc must carry no rules block, got ${JSON.stringify(doc.rules)}`);
  check(doc.margin == null, 'no margin may be seeded - the per-customer floor is Suyashh to set');
  check(doc.customerId === SLUG, `customerId must be ${SLUG}, got ${doc.customerId}`);
  check(doc.aliases.includes('Safex Chemicals'), 'the label must persist as a match token');
  check(!doc.aliases.includes('Safex'), 'the bare token must not survive into the persisted doc');
  assert.strictEqual(assertCustomerRulesValid([{ customerId: SLUG, rules: doc.rules }]), true,
    'the boot gate must accept a Safex record with no rules block');
  ok('the built record carries no rules block and no margin, and the boot gate accepts it');
}

// ---- 3. machine-checkable: Safex is NOT allowlist-ready ----
// Same predicate shape as scripts/test-w4-onboarding.js's isAllowlistReady. A customer is safe to
// turn on only with a VERIFIED close model, no PMT exposure, and no open gate. Safex must fail it,
// and must fail it specifically on the mechanic gate, not merely on the soft-close one.
{
  const isAllowlistReady = (def) => def.closeModel === 'hard' && def.pmtExposure === 'none' && !(def.gates || []).length;
  check(!isAllowlistReady(SAFEX), 'Safex must NOT read as allowlist-ready');
  const gates = SAFEX.gates || [];
  check(gates.length > 0, 'Safex must carry at least one open gate');
  check(gates.includes('auction_mechanic'), `gates must name the unresolved bid mechanic, got ${gates.join(', ')}`);
  check(gates.includes('close_model'), `gates must name the unverified close model, got ${gates.join(', ')}`);
  check(gates.includes('group'), `gates must name the missing WhatsApp group / desk assignment, got ${gates.join(', ')}`);
  ok('Safex is machine-checkably NOT allowlist-ready, and names the bid mechanic as an open gate');
}

// ---- 4. THE ONE THAT MATTERS: the seeded record surfaces nothing through resolveTargets ----
// resolveTargets - not the allowlist - is the real gate: it unions the aliases of every customer
// with an ENABLED assignment via an ENABLED person on the account into that account's effective
// bidding targets, with no allowlist edit at all. Both halves are asserted, because a probe that
// only shows "absent" cannot distinguish a working guard from a broken fixture.
{
  const customer = validateCustomer(buildCustomerRecord(SAFEX));
  const account = { accountId: 'master' };
  const person = { personId: 'p-gurdeep', accountId: 'master', enabled: true };
  const base = { shippers: [], lanes: [], hardCloseOnly: true };

  const noAssignment = resolveTargets({ account, customers: [customer], people: [person], assignments: [], fallbackAllowlist: base });
  check(!noAssignment.shippers.some((s) => /safex/i.test(s)),
    `a seeded Safex record with NO assignment must contribute zero targets, got [${noAssignment.shippers.join(', ')}]`);

  const disabled = resolveTargets({
    account, customers: [customer], people: [person], fallbackAllowlist: base,
    assignments: [{ personId: 'p-gurdeep', customerId: SLUG, enabled: false }],
  });
  check(!disabled.shippers.some((s) => /safex/i.test(s)),
    `a DISABLED Safex assignment must contribute zero targets, got [${disabled.shippers.join(', ')}]`);

  // the positive control - proves this probe can see the thing it says is absent
  const enabled = resolveTargets({
    account, customers: [customer], people: [person], fallbackAllowlist: base,
    assignments: [{ personId: 'p-gurdeep', customerId: SLUG, enabled: true }],
  });
  check(enabled.shippers.some((s) => /safex/i.test(s)),
    'positive control: an ENABLED assignment MUST surface Safex - if this fails the probe is blind');
  ok('the seeded record surfaces nothing via resolveTargets with no/disabled assignment (and the enabled positive control fires)');
}

// ---- 5. the engine stays fail-closed on Safex-shaped loads ----
{
  const sc = { enabled: true, shippers: ['Safex'], mode: 'shadow', reserve: 1 };
  // unverified close model -> refused even though the shipper token matches and the flag is on
  check(softAdmitted(sc, { companyName: 'Safex Chemicals India Ltd.', softClose: true, closeModelKnown: false }) === false,
    'an unverified-close-model Safex load must NOT be soft-admitted');
  // and with Safex absent from the opt-in list (today's shipped posture) it is refused regardless
  check(softAdmitted({ ...sc, shippers: ['Havells'] }, { companyName: 'Safex Chemicals India Ltd.', softClose: true, closeModelKnown: true }) === false,
    'a Safex load must NOT be soft-admitted while Safex is off the soft-close opt-in list');
  ok('softAdmitted refuses a Safex load on an unverified close model, and while Safex is off the opt-in list');
}

// ---- 6. the year-2100 placeholder still maps to closesAt:null (why board loads never surface) ----
{
  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
  const mapped = a._mapLoad({
    id: 23171760, companyName: 'Safex Chemicals India Ltd.', biddingOn: 1,
    biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE,
    branchAuctionExtendTime: '00:02:00', branchExtendAuction: 0,
  });
  check(mapped.closesAt == null, `a year-2100 placeholder close must map to closesAt null, got ${mapped.closesAt}`);
  // discovery.js drops every closesAt==null load BEFORE the allowlist check, so this is also the
  // reason a board-class Safex load can never reach the desk even if Safex were allowlisted.
  ok('the year-2100 placeholder maps to closesAt:null, so a board-class Safex load is undiscoverable by construction');
}

// ---- 7. the two evidence traps, pinned as arithmetic so prose cannot drift ----
{
  // Trap 1: the v4 capture's windowMin of 15 for Safex is the PLACEHOLDER PAIR'S OWN delta, not a
  // real 15-minute bidding window. Anyone citing it as proof of a timed auction is reading noise.
  const windowMin = (new Date(PLACEHOLDER_CLOSE) - new Date(PLACEHOLDER_START)) / 60000;
  check(windowMin === 15, `the placeholder pair must still compute windowMin 15 (got ${windowMin}) - this is why windowMin==15 proves nothing`);
  // Trap 2: branchAuctionExtendTime is a BRANCH SETTING. Ashirvad - the confirmed board customer -
  // carries a non-zero one on 38 loads, so a non-zero extend time is not evidence an auction runs.
  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
  const boardLoad = a._mapLoad({
    id: 1, companyName: 'Ashirvad Pipes Pvt Ltd', biddingOn: 1,
    biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE, branchAuctionExtendTime: '00:01:00',
  });
  check(boardLoad.softClose === true && boardLoad.closesAt == null,
    'a board-class load can read softClose true (branch setting) while having NO close time at all - the trap, pinned');
  ok('both evidence traps are pinned: placeholder windowMin==15, and a non-zero extend time coexists with no close time');
}

// ---- 8. .env.example must not hand the operator a paste that enrols Safex ----
{
  const env = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  // Deliberately broad: ANY line that names one of the two enrolment vars is a candidate paste,
  // whether it is written as `SP_..._SHIPPERS=a,b` or as prose ("append to SP_ALLOWLIST_SHIPPERS
  // above: ...,X"). The narrow `VAR=` form would have missed the second shape entirely.
  const enrolmentLines = env.split('\n')
    .filter((l) => /SP_SOFT_CLOSE_SHIPPERS|SP_ALLOWLIST_SHIPPERS/.test(l))
    .filter((l) => /[=:]/.test(l) && /,|=\s*\S/.test(l)); // carries an actual token list
  check(enrolmentLines.length > 0, 'expected at least one SP_SOFT_CLOSE_SHIPPERS / SP_ALLOWLIST_SHIPPERS token-list line to check');
  for (const line of enrolmentLines) {
    check(!/safex/i.test(line), `.env.example hands the operator a paste that enrols Safex: ${line.trim()}`);
  }
  check(/SAFEX CHEMICALS - HELD/.test(env), '.env.example must carry the explicit Safex HELD block');
  ok('.env.example carries the Safex HELD block and no example allowlist/soft-close line contains Safex');
}

// ---- 9. --apply persists Safex identity-only and creates no routing artifact ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-safex-'));
  const res = spawnSync(process.execPath, [SCRIPT, '--apply', `--data-dir=${dir}`], { encoding: 'utf8' });
  check(res.status === 0, `apply exit ${res.status}: ${res.stderr}`);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'customers.json'), 'utf8'))[SLUG];
  if (check(doc, 'apply must persist safex-chemicals')) {
    check(doc.rules == null, `persisted Safex must carry NO rules block, got ${JSON.stringify(doc.rules)}`);
    check(doc.margin == null, 'persisted Safex must carry no margin');
    check(doc.enabled === true, 'persisted Safex should be enabled (identity is live; routing is what is withheld)');
  }
  for (const forbidden of ['accounts.json', 'config.json', 'staffRoster.json', 'people.json', 'assignments.json']) {
    check(!fs.existsSync(path.join(dir, forbidden)), `apply must NOT create ${forbidden}`);
  }
  ok('--apply persists Safex identity-only (no rules, no margin) and creates no allowlist/roster/assignment artifact');
}

// ---- 10. the alias cannot silently join a live customer's margin-matching pool ----
{
  const seeded = [validateCustomer(buildCustomerRecord(SAFEX))];
  for (const companyName of ['Havells India Ltd', 'KEI Industries Limited', 'Syngenta India Limited',
    'Cords Cable Industries Ltd', 'Ashirvad Pipes Pvt Ltd', 'SIKA India']) {
    check(!matchCustomer(companyName, seeded), `Safex alias collides with live shipper "${companyName}"`);
  }

  // THE SAFEXPRESS COLLISION - why the bare 'Safex' alias was dropped 2026-08-02.
  // tokenMatch anchors the LEFT boundary only, so a bare 'Safex' matches 'Safexpress': a
  // transporter, not a shipper. No Safexpress load has ever been seen on BRL's board, so this
  // never fired - but the cost is asymmetric. A miss costs one unsurfaced load the desk notices;
  // a false positive puts a real bid on another company's freight. First: prove the matcher
  // really is one-sided, so the next reader does not have to take the comment on faith.
  check(tokenMatch('Safexpress Pvt Ltd', 'Safex'), 'precondition: a bare "Safex" token DOES match Safexpress (left-anchored only)');
  check(!tokenMatch('Safexpress Pvt Ltd', 'Safex Chemicals'), 'precondition: the full label does NOT match Safexpress');
  for (const companyName of ['Safexpress Pvt Ltd', 'SAFEXPRESS PRIVATE LIMITED', 'M/s Safexpress']) {
    check(!matchCustomer(companyName, seeded), `the seeded Safex record must NOT match transporter "${companyName}"`);
  }

  check(!!matchCustomer('Safex Chemicals India Ltd.', seeded), 'positive control: the real Safex companyName must match the seeded record');
  ok('the Safex alias matches its own companyName, collides with no known-live shipper, and no longer matches Safexpress');
}

// ---- completion sentinel ----
// The runner (scripts/run-tests.js) grades by EXIT CODE ONLY, so a file that returns early - or
// whose async tail never runs - is a silent green zero-assertion pass. Assert the exact number of
// groups that actually completed, so "the file ran" and "the file checked what it claims" cannot
// diverge. Update this number deliberately when adding a group; never to make a red run go green.
const EXPECTED_CHECKS = 10;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0 && pass !== EXPECTED_CHECKS) {
  console.error(`  FAIL - completion sentinel: ${pass} check groups ran, expected ${EXPECTED_CHECKS} (a group returned early or was skipped)`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
