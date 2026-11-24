'use strict';
/**
 * provision-group - bring ONE customer's bidding-desk WhatsApp group into existence and into the
 * routing config, as one supervised, idempotent, dry-run-default command.
 *
 *   node scripts/provision-group.js --customer=syngenta                    # DRY RUN, writes nothing
 *   node scripts/provision-group.js --customer=syngenta --members=919...,918...  --apply
 *   node scripts/provision-group.js --customer=havells --label="Havells Alwar" \
 *        --branch-scope="Alwar Cable (1350)" --apply
 *   node scripts/provision-group.js --customer=waaree --label="Waaree" --portal=GC \
 *        --origin-scope="chikhli,valsad,nandigram,umbergaon,yelahanka,jio world,ahmedabad international airport,cuddalore,neelmangala,navsari,sachin"
 *        # a scope flag REPLACES the stored list: pass the whole list, and --label for the exact group
 *   node scripts/provision-group.js --customer=havells --rename --apply   # adopt + rename to standard
 *
 * WHY: creation was the one step of the runbook with no tool. Config seeding has been a reviewed
 * dry-run script since W3; the group birth itself was hand-rolled curl, and it cost a duplicate
 * Havells Alwar group on 2026-07-25 because nothing checked whether the group already existed. This
 * encodes the KNOWLEDGE.md runbook plus everything learned after it: born locked, two controlled
 * administrators from birth, roster-before-membership, no API description write, batch-capped so the
 * sender survives the run.
 *
 * ORDER (each mutating op health-checked, rate-limited and read-back-verified):
 *   0 preflight  customer record exists; both controlled phones active; fallback AND every human
 *                member on staffRoster; no existing group for this label+portal
 *   1 create     born with config.membersCanAddMembers:false, fallback as its first member
 *   2 promote    fallback to admin
 *   3 lock       only if the read-back says the birth config did not land
 *   4 add        each human member, one op each
 *   5 register   customer -> person -> assignment, in referential order, ONLY once the member set is
 *                complete (group-only routing into an empty group reaches nobody)
 *   6 report     the manual steps it deliberately cannot do
 *
 * ADOPTS a half-provisioned group rather than refusing it: the plan is recomputed from live state
 * every run, so a batch-capped or aborted run is resumed by re-running the same command. It refuses
 * only when there is nothing left to do.
 *
 * NEVER: removes, demotes, renames, writes a description, sends a message into any group, or touches
 * the allowlist. A customer's loads start surfacing when an operator adds its token to the allowlist
 * on the box - a separate, deliberate step this script does not perform.
 *
 * MANDATORY: read the dry-run before --apply. Check the resolved subject, the member list, the
 * "existing groups for this customer" warnings, and that preflight found both phones active. No test
 * can stand in for that - it verifies the shape of live data.
 */

const path = require('path');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const {
  PORTAL_SP, KNOWN_PORTALS, FALLBACK_NUMBER, FALLBACK_PHONE_ID,
  DESIRED_GROUP_CONFIG, mergeLockConfig,
  isBrlBidsGroup, parseGroupName, portalOf, canonicalGroupName, waGroupSubject, nameConformsTo,
  excludedReason, canonicalPhoneKey, matchState, asciiLabel,
} = require('./lib/group-directory');

// >=60s between mutating ops. NOT lowerable from the CLI (tests inject it). The 2026-07-28 run proves
// this interval alone does NOT prevent a logout - it is a floor, not a guarantee, which is why
// MAX_OPS_PER_RUN exists too.
const MIN_INTERVAL_MS = 60000;
// Stop after this many mutating ops and tell the operator to re-run. The sender dropped after 10 ops
// in ~16 minutes at 1 op/min, so cumulative volume per session is the real risk, not the rate.
const MAX_OPS_PER_RUN = 6;
// Maytapi group state is eventually consistent: a read taken right after a write that landed can miss
// it. Re-read before believing a non-confirming result. Read-only, never re-issues the write.
const READ_BACK_SETTLE_MS = 3000;
const READ_BACK_ATTEMPTS = 3;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Does this live group belong to this customer label + portal? Exact match on the parsed customer
// segment, so "Havells Alwar" never collides with "Havells" - they are legitimately separate groups.
function groupMatchesLabel(group, label, portal) {
  const parsed = parseGroupName(group && group.name);
  if (!parsed.prefixOk || !parsed.customer) return false;
  if (portalOf(group) !== portal) return false;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(parsed.customer) === norm(label);
}

function remediationMissingCustomer(customerRef) {
  return [
    `REFUSED: no customer record matches '${customerRef}'.`,
    '',
    'A group with no customer record projects an EMPTY shipper scope, which the notifier reads as an',
    'every-load group: it matches every customer and suppresses nothing. That is a silent global',
    'spray of one customer\'s cost and margin into another customer\'s group.',
    '',
    '  Remediation (config only, dry-run default, do this FIRST):',
    '    1. Seed the customer via scripts/onboard-w4-customers.js (or the console Customers page),',
    '       with the aliases the load companyName is matched on.',
    '    2. Re-run this provisioner in dry-run to confirm the gate passes.',
    '',
    'This script does not create customer records - identity and routing are separate steps.',
  ].join('\n');
}

function remediationMissingRoster(numbers) {
  return [
    `REFUSED: ${numbers.length} number(s) are NOT on the staff allowlist (data/staffRoster.json):`,
    ...numbers.map((n) => `    +${String(n).replace(/\D/g, '')}`),
    '',
    'Roster before membership. These groups carry per-load cost, bid and margin, so the daily 08:00',
    'membership audit flags every participant it cannot find on the roster - adding someone first',
    'means the group goes live clean instead of alarming on its own members.',
    '',
    '  Remediation: add each number to data/staffRoster.json -> allowlist.numbers, then re-run.',
    '',
    'This script does not edit the roster (a deliberate, separate config edit).',
  ].join('\n');
}

function manualFollowUps(subjectAscii) {
  return [
    'MANUAL, and deliberately NOT done here:',
    `  1. DESCRIPTION for "${subjectAscii}" - a human must paste it in the WhatsApp app (group name ->`,
    '     edit description). Maytapi answers success:true and discards a description write, so there',
    '     is no API path; use the approved desk wording, and have a native reader check the Hindi.',
    '  2. ALLOWLIST - the customer surfaces no loads until its token is added on the box',
    '     (SP_ALLOWLIST_SHIPPERS / the account allowlist, plus SP_SOFT_CLOSE_SHIPPERS for a',
    '     soft-close customer). Two hands on the wheel, by design.',
    '  3. VERIFY - run scripts/group-census.js and confirm this group reads locked, dual-admin,',
    '     registered, and name-conformant.',
  ].join('\n');
}

/**
 * Core runner. Pure of CLI/process concerns so it is directly testable: inject `wa`, the stores, a
 * `sleep` and a `now`. Returns a structured report; never prints, never calls process.exit.
 */
async function runProvision({
  wa,
  staffRoster,
  customerStore,
  personStore,
  assignmentStore,
  customerRef,
  label = null,
  portal = PORTAL_SP,
  members = [],
  // null means "not specified on this run". personStore.upsert now preserves any field this run
  // does not mention (merge-by-default against the stored record), so passing null here just means
  // "don't override" rather than "wipe" - but branchScope/accountId/originScope stay explicit CLI
  // knobs because an operator narrowing a desk (or fixing a wrong accountId) needs a way to say so.
  branchScope = null,
  accountId = null,
  // Legacy origin/plant filter (Waaree's three plant desks use this). Until this flag existed there
  // was no way to SET it from the CLI at all - only to inherit whatever the live record already
  // carried - which was the latent half of the 2026-08-31 defect: any future rename of a
  // never-yet-registered Waaree-shaped group had no workaround.
  originScope = null,
  apply = false,
  // Rename an adopted legacy group to the canonical subject. OFF by default and deliberately not a
  // sweep: routing is by JID, so a rename buys human legibility only, and it costs one op on a sender
  // that logs out under group-op volume. Worth spending when a customer gets its SECOND portal group
  // and the desk would otherwise have to guess which group a rate belongs in.
  rename = false,
  fallbackNumber = FALLBACK_NUMBER,
  fallbackPhoneId = FALLBACK_PHONE_ID,
  minIntervalMs = MIN_INTERVAL_MS,
  maxOps = MAX_OPS_PER_RUN,
  readBackSettleMs = READ_BACK_SETTLE_MS,
  readBackAttempts = READ_BACK_ATTEMPTS,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {},
} = {}) {
  const started = now();
  const report = {
    apply, customerRef, portal, accountId: accountId || null,
    label: null, subject: null, storeName: null, registrationPlanned: false,
    refused: false, reason: null, remediation: null,
    aborted: false, abortReason: null, capped: false,
    warnings: [], preflight: {}, plannedOps: [], results: [],
    groupId: null, groupName: null, adopted: false, registered: null,
    scopeRepair: false, scopeChanges: [],
    opsApplied: 0, elapsedMs: 0,
  };
  const done = () => { report.elapsedMs = now() - started; return report; };

  if (!KNOWN_PORTALS.includes(String(portal).toUpperCase())) {
    report.refused = true;
    report.reason = `unknown portal '${portal}' - expected one of ${KNOWN_PORTALS.join(', ')}`;
    return done();
  }
  report.portal = String(portal).toUpperCase();

  // ---- (0) customer record ----
  let customer = null;
  try {
    customer = await customerStore.getByAnyId(customerRef);
    if (!customer) {
      const all = (await customerStore.list()) || [];
      const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
      customer = all.find((c) => c && (norm(c.label) === norm(customerRef)
        || (Array.isArray(c.aliases) && c.aliases.some((a) => norm(a) === norm(customerRef))))) || null;
    }
  } catch (e) {
    report.refused = true;
    report.reason = `preflight: could not read customers (${e && e.message}) - NO-GO`;
    return done();
  }
  if (!customer) {
    report.refused = true;
    report.reason = 'missing-customer';
    report.remediation = remediationMissingCustomer(customerRef);
    return done();
  }
  report.preflight.customerId = customer.customerId;
  report.label = String(label || customer.label).trim();
  report.subject = waGroupSubject(report.label, report.portal);
  report.storeName = canonicalGroupName(report.label, report.portal);

  // ---- (0) --account names a real account ----
  // Checked here as well as in personStore.upsert: the upsert runs after the group ops, where a
  // rejection only becomes a warning on an exit-0 run.
  if (accountId) {
    let known;
    try { known = await personStore._accountIds(); }
    catch (e) {
      report.refused = true;
      report.reason = `preflight: could not read accounts (${e && e.message}) - NO-GO`;
      return done();
    }
    if (known && !known.has(accountId)) {
      report.refused = true;
      report.reason = `unknown account '${accountId}' - known accounts: ${[...known].join(', ')}. NO-GO`;
      return done();
    }
  }

  // ---- (0) both controlled phones active ----
  let phones;
  try { phones = await wa.listPhones(); }
  catch (e) {
    report.refused = true;
    report.reason = `preflight: could not read listPhones (${e && e.message}) - cannot verify sender state. NO-GO`;
    return done();
  }
  const creatorId = String(wa.phoneId);
  const creator = phones.find((p) => String(p.id) === creatorId);
  const fb = phones.find((p) => String(p.id) === String(fallbackPhoneId));
  const creatorStatus = creator ? WhatsAppClient.statusOf(creator) : 'not-found';
  const fallbackStatus = fb ? WhatsAppClient.statusOf(fb) : 'not-found';
  report.preflight.creatorPhoneId = creatorId;
  report.preflight.creatorStatus = creatorStatus;
  report.preflight.fallbackPhoneId = String(fallbackPhoneId);
  report.preflight.fallbackStatus = fallbackStatus;
  if (creatorStatus !== 'active') {
    report.refused = true;
    report.reason = `preflight: creator phone ${creatorId} is ${creatorStatus}, not active - re-link it (QR scan) before provisioning. NO-GO`;
    return done();
  }
  if (fallbackStatus !== 'active') {
    report.refused = true;
    report.reason = `preflight: fallback phone ${fallbackPhoneId} is ${fallbackStatus}, not active - a group must not be born with one administrator. NO-GO`;
    return done();
  }

  // ---- (0) roster before membership: fallback + every human member ----
  let roster;
  try { roster = (await staffRoster.list()) || []; }
  catch (e) {
    report.refused = true;
    report.reason = `preflight: could not read staffRoster (${e && e.message}) - NO-GO`;
    return done();
  }
  const rosterKeys = new Set(roster.map(canonicalPhoneKey).filter(Boolean));
  const humanMembers = (Array.isArray(members) ? members : [members])
    .map((m) => String(m == null ? '' : m).trim()).filter(Boolean);
  const offRoster = [fallbackNumber, ...humanMembers]
    .filter((n) => !rosterKeys.has(canonicalPhoneKey(n)));
  report.preflight.rosterSize = rosterKeys.size;
  report.preflight.membersRequested = humanMembers.length;
  if (offRoster.length) {
    report.refused = true;
    report.reason = 'missing-roster';
    report.remediation = remediationMissingRoster(offRoster);
    return done();
  }

  // ---- (0) does a group already exist for this label + portal? ----
  let allGroups;
  try { allGroups = await wa.getGroups(); }
  catch (e) {
    report.refused = true;
    report.reason = `preflight: could not read getGroups (${e && e.message}) - cannot rule out a duplicate. NO-GO`;
    return done();
  }
  const deskGroups = (allGroups || []).filter((g) => g && g.id && isBrlBidsGroup(g.name) && !excludedReason(g.id));
  const existing = deskGroups.find((g) => groupMatchesLabel(g, report.label, report.portal)) || null;

  // Every other group already serving this customer - the operator's cue that they may be about to
  // create a second one (how the Alwar duplicate happened). Warn, never block: a branch group
  // legitimately sits alongside its parent.
  const siblings = [];
  for (const g of deskGroups) {
    if (existing && g.id === existing.id) continue;
    const parsed = parseGroupName(g.name);
    const cust = parsed.customer ? parsed.customer.toLowerCase() : '';
    const aliases = [customer.label, ...(customer.aliases || [])].map((a) => String(a).toLowerCase());
    if (aliases.some((a) => cust.startsWith(a))) {
      siblings.push(g);
      report.warnings.push(`"${asciiLabel(g.name)}" (${g.id}) already serves this customer - confirm you mean a SEPARATE group before --apply.`);
    }
  }

  const fallbackKey = canonicalPhoneKey(fallbackNumber);
  let currentGroup = existing;
  report.adopted = !!existing;
  if (existing) {
    report.groupId = existing.id;
    report.groupName = asciiLabel(existing.name);
    report.warnings.push(`adopting the existing group "${asciiLabel(existing.name)}" (${existing.id}) and finishing whatever it is missing - nothing is re-created.`);
  }

  // ---- (1) plan ----
  const plan = [];
  if (!currentGroup) {
    plan.push({ op: 'create', detail: asciiLabel(report.subject) });
  }
  if (currentGroup) {
    if (matchState(currentGroup.admins || [], fallbackKey) !== 'present') plan.push({ op: 'promote', detail: `fallback +${fallbackNumber}` });
    // group/config is one full-replace call, so a lock and a rename ride the SAME op rather than
    // spending two of the sender's ops on one endpoint.
    const cfg = currentGroup.config;
    const needsLock = !cfg || cfg.membersCanAddMembers !== false;
    const needsRename = rename && !nameConformsTo(currentGroup.name, report.label, report.portal);
    if (needsLock || needsRename) {
      plan.push({ op: 'config', detail: [needsLock ? 'lock' : null, needsRename ? 'rename' : null].filter(Boolean).join('+') });
    }
    for (const m of humanMembers) {
      if (matchState(currentGroup.participants || [], canonicalPhoneKey(m)) !== 'present') plan.push({ op: 'add', detail: `+${m}` });
    }
  } else {
    // A group that does not exist yet needs the promote plus every member; the lock is planned only
    // after the birth config is read back, since it may already have landed.
    plan.push({ op: 'promote', detail: `fallback +${fallbackNumber}` });
    for (const m of humanMembers) plan.push({ op: 'add', detail: `+${m}` });
  }
  report.plannedOps = plan.map((p) => p.op);

  // Registration state is independent of the ops: an adopted group may already be registered.
  const personId = currentGroup ? `g${String(currentGroup.id).replace(/\D/g, '')}` : null;
  let alreadyRegistered = false;
  let priorPerson = null;
  // Read apart from alreadyRegistered (which also requires priorPerson): CW-24 needs to know
  // specifically whether THIS customer pairing's assignment already existed, so a genuinely
  // first-time registration can be written disabled without disturbing a preserve-unless-explicit
  // re-registration (#216).
  let priorAssignment = null;
  if (personId) {
    try {
      priorPerson = await personStore.get(personId);
      priorAssignment = await assignmentStore.get(`${personId}::${customer.customerId}`);
      alreadyRegistered = !!priorPerson && !!priorAssignment;
    } catch (_) { alreadyRegistered = false; }
  }
  report.preflight.alreadyRegistered = alreadyRegistered;
  // Registration is a local store write, not a sender op, so it never appears in the op plan - but a
  // dry run that stays silent about it would understate what --apply does. A group that already
  // exists and is complete but carries no routing is repaired by registration ALONE, with zero ops.
  report.registrationPlanned = !alreadyRegistered;

  // An explicit scope flag that disagrees with what is already stored is real repair work, even
  // when the group itself needs zero sender ops - otherwise the documented repair command
  // (re-run with a corrected --branch-scope/--account/--origin-scope) can never reach the write
  // that would fix an already-registered group, because the "nothing to do" refusal below fires
  // first (2026-09-18 review, finding 4).
  const sameList = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());
  const lc = (s) => String(s).trim().toLowerCase();
  // An empty scope matches every load, so a new non-empty list narrows it; so does dropping any
  // entry the stored list had.
  const narrows = (stored, requested) => requested.length > 0
    && (!stored.length || stored.some((s) => !requested.map(lc).includes(lc(s))));
  // A first registration is a change from an empty record. It narrows nothing, since the group has
  // no routing yet, but it still needs --label once the customer has another group.
  const changes = [];
  const prior = priorPerson || {};
  if (accountId && accountId !== prior.accountId) {
    changes.push({ field: 'accountId', stored: prior.accountId, requested: accountId, narrows: false });
  }
  for (const [field, requested] of [['branchScope', branchScope], ['originScope', originScope]]) {
    const stored = prior[field] || [];
    if (requested && !sameList(requested, stored)) changes.push({ field, stored, requested, narrows: !!priorPerson && narrows(stored, requested) });
  }
  report.scopeChanges = changes;
  report.scopeRepair = alreadyRegistered && changes.length > 0;
  if (report.scopeRepair) report.registrationPlanned = true;

  // Without --label the target is the customer's main group, whichever group the operator meant.
  if (changes.length && !(label && String(label).trim())) {
    const narrowed = changes.filter((c) => c.narrows).map((c) => c.field);
    if (narrowed.length || siblings.length) {
      const why = [
        narrowed.length ? `it narrows ${narrowed.join(' and ')}` : null,
        siblings.length ? `this customer has ${siblings.length} other group(s): ${siblings.map((g) => `"${asciiLabel(g.name)}"`).join(', ')}` : null,
      ].filter(Boolean).join('; ');
      report.refused = true;
      const target = currentGroup
        ? `rewrite "${asciiLabel(currentGroup.name)}" (${currentGroup.id})`
        : `create "${asciiLabel(report.subject)}"`;
      report.reason = `routing change without --label: ${why}. With no --label it would ${target}.`
        + ' Re-run with --label naming the exact group to repair.';
      return done();
    }
  }

  if (!plan.length && alreadyRegistered && !report.scopeRepair) {
    report.refused = true;
    report.reason = `nothing to do: "${asciiLabel(currentGroup.name)}" (${currentGroup.id}) is already provisioned, locked, dual-admin and registered.`;
    return done();
  }

  if (!apply) return done();

  // ---- (2) apply ----
  const readBack = async (jid) => {
    let last = null;
    for (let i = 1; i <= Math.max(1, readBackAttempts); i += 1) {
      if (i > 1 && readBackSettleMs > 0) await sleep(readBackSettleMs);
      try {
        const fresh = await wa.getGroups();
        const hit = (fresh || []).find((x) => x && String(x.id).toLowerCase() === String(jid).toLowerCase());
        if (hit) { last = hit; return { group: hit, attempts: i }; }
        last = null;
      } catch (_) { /* transient - retry */ }
    }
    return { group: last, attempts: Math.max(1, readBackAttempts) };
  };

  // The sender is health-checked before EVERY op, not once per run: it dropped mid-sequence on
  // 2026-07-28 and the ops after that point were issued into a dead session.
  const senderStillUp = async () => {
    try {
      const list = await wa.listPhones();
      const me = list.find((p) => String(p.id) === creatorId);
      return me ? WhatsAppClient.statusOf(me) === 'active' : false;
    } catch (_) { return false; }
  };

  let mutating = 0;
  for (const step of plan) {
    if (mutating >= maxOps) {
      report.capped = true;
      report.abortReason = `batch cap reached (${maxOps} ops). Re-run the same command to continue - the plan recomputes from live state.`;
      break;
    }
    if (mutating > 0) await sleep(minIntervalMs);
    if (!(await senderStillUp())) {
      report.aborted = true;
      report.abortReason = `creator phone ${creatorId} left 'active' mid-run - stopping before op '${step.op}'. Re-link, then re-run.`;
      break;
    }
    mutating += 1;
    log(`[provision-group] ${step.op} ${step.detail}`);

    if (step.op === 'create') {
      const res = await wa.createGroup(report.subject, [fallbackNumber], { config: Object.assign({}, DESIRED_GROUP_CONFIG) });
      if (!res.ok) {
        report.results.push({ op: 'create', ok: false, error: res.error });
        report.aborted = true;
        report.abortReason = `create failed (${res.error}) - nothing else attempted`;
        break;
      }
      report.groupId = res.id;
      const rb = await readBack(res.id);
      currentGroup = rb.group;
      const bornLocked = !!(currentGroup && currentGroup.config && currentGroup.config.membersCanAddMembers === false);
      report.results.push({ op: 'create', ok: true, verified: !!currentGroup, attempts: rb.attempts, groupId: res.id, bornLocked });
      if (!currentGroup) {
        report.aborted = true;
        report.abortReason = `created ${res.id} but could not read it back - do NOT re-run blind, check the census first`;
        break;
      }
      // The birth config is not trusted. If it did not land, a lock op is appended now.
      if (!bornLocked) {
        report.warnings.push('the birth config did not land (group is open-add) - a lock op was appended.');
        plan.push({ op: 'config', detail: 'lock' });
        report.plannedOps.push('config');
      }
      continue;
    }

    if (!report.groupId || !currentGroup) {
      report.aborted = true;
      report.abortReason = `no group to operate on for '${step.op}' - aborting`;
      break;
    }

    let res;
    if (step.op === 'promote') {
      res = await wa.promoteAdmin(report.groupId, fallbackNumber);
    } else if (step.op === 'config') {
      const wire = mergeLockConfig(currentGroup.config);
      if (step.detail.includes('rename')) wire.name = report.subject;
      res = await wa.setGroupConfig(report.groupId, wire);
    } else {
      res = await wa.addParticipant(report.groupId, step.detail.replace(/^\+/, ''));
    }

    // A hard error is NOT proof the write failed - group/add returned HTTP 500 on Durian while fully
    // landing. Read back either way and let the read decide.
    const rb = await readBack(report.groupId);
    if (rb.group) currentGroup = rb.group;

    let verified = null;
    if (step.op === 'promote') {
      verified = matchState(currentGroup.admins || [], fallbackKey) === 'present';
    } else if (step.op === 'config') {
      // Verify every reason the op was planned for, not just one of them.
      const locked = !!(currentGroup.config && currentGroup.config.membersCanAddMembers === false);
      const renamed = !step.detail.includes('rename') || nameConformsTo(currentGroup.name, report.label, report.portal);
      verified = locked && renamed;
    } else {
      verified = matchState(currentGroup.participants || [], canonicalPhoneKey(step.detail.replace(/^\+/, ''))) === 'present';
    }

    report.results.push({ op: step.op, ok: !!(res && res.ok), verified, attempts: rb.attempts, error: (res && res.ok) ? null : (res && res.error) || 'op failed' });

    if (!verified) {
      const indet = step.op === 'add'
        && matchState(currentGroup.participants || [], canonicalPhoneKey(step.detail.replace(/^\+/, ''))) === 'indeterminate';
      if (indet) {
        report.warnings.push(`${step.op} ${step.detail} could not be confirmed by number (an opaque @lid row may be it) - not treated as a failure; re-run is idempotent.`);
      } else {
        report.aborted = true;
        report.abortReason = `${step.op} ${step.detail}: read-back does not confirm it after ${rb.attempts} attempt(s) - aborting`;
        break;
      }
    }
  }
  report.opsApplied = mutating;

  // ---- (3) register, only when the group is whole ----
  // Humans before routing: registering a group whose member set is still incomplete points group-only
  // routing at a group nobody reads, and the customer's DM recipients are suppressed the moment it is
  // registered. So an aborted or capped run registers nothing.
  const membersComplete = currentGroup
    && humanMembers.every((m) => matchState(currentGroup.participants || [], canonicalPhoneKey(m)) !== 'absent');
  if (!report.aborted && !report.capped && report.groupId && membersComplete) {
    try {
      const pid = `g${String(report.groupId).replace(/\D/g, '')}`;
      // personStore.upsert now preserves every field this run does not mention (merge-by-default
      // against the stored record - see personStore.js), so the body below only needs to state what
      // THIS run actually knows: the name/phone every registration carries, plus whichever of
      // accountId/branchScope/originScope the operator explicitly passed. Everything else - alerts,
      // enabled, email, and any field this script has never heard of - rides through untouched.
      // priorPerson was already read above (it drives the scopeRepair check) - a group created
      // earlier in THIS run has no prior record either way, so reusing it here is exact, not stale.
      const body = { personId: pid, name: report.storeName, phone: report.groupId };
      if (accountId) body.accountId = accountId;
      if (branchScope) body.branchScope = branchScope;
      if (originScope) body.originScope = originScope;
      if (!priorPerson) {
        // A group starts subscribed to every alert kind and un-scoped - unlike a staff Person, who
        // defaults to none. That is this script's own business default for a FIRST registration,
        // not personStore's generic one, so it only applies when there is nothing to preserve.
        if (body.alertPrefs === undefined) body.alertPrefs = 'all';
        if (body.alertAll === undefined) body.alertAll = false;
        if (body.branchScope === undefined) body.branchScope = [];
      }
      const personDoc = await personStore.upsert(body);
      // CW-24: a first-time registration (no prior assignment for this exact pairing) is written
      // DISABLED - a brand-new group must not be armed for live bidding before a human turns it on.
      // A re-registration (priorAssignment exists) omits `enabled` entirely, so AssignmentStore's own
      // preserve-unless-explicit rule (#216) carries the stored value through unchanged.
      const assignmentBody = { personId: pid, customerId: customer.customerId };
      if (!priorAssignment) assignmentBody.enabled = false;
      await assignmentStore.upsert(assignmentBody);
      report.registered = { personId: pid, customerId: customer.customerId, branchScope: personDoc.branchScope };
    } catch (e) {
      report.warnings.push(`group is provisioned but registration FAILED (${e && e.message}) - it carries no routing until this is fixed; re-run to retry.`);
    }
  } else if (report.groupId && !alreadyRegistered) {
    report.warnings.push('registration SKIPPED - the group is not complete yet. Re-run to finish, then it registers.');
  }

  return done();
}

// ---- report ----
function formatReport(report) {
  const bar = '='.repeat(72);
  const lines = [bar];
  lines.push(`provision-group  [${report.apply ? 'APPLY (LIVE)' : 'DRY RUN (no writes)'}]`);
  lines.push(`customer: ${report.customerRef}  portal: ${report.portal}`);
  if (report.subject) lines.push(`subject : ${asciiLabel(report.subject)}`);
  lines.push(bar);

  const pf = report.preflight || {};
  lines.push('Preflight:');
  if (pf.customerId) lines.push(`  customer record: ${pf.customerId}`);
  if (pf.creatorPhoneId) lines.push(`  creator phone ${pf.creatorPhoneId}: ${pf.creatorStatus}`);
  if (pf.fallbackPhoneId) lines.push(`  fallback phone ${pf.fallbackPhoneId}: ${pf.fallbackStatus}`);
  if (pf.rosterSize != null) lines.push(`  staff allowlist: ${pf.rosterSize} number(s); members requested: ${pf.membersRequested}`);
  if (pf.alreadyRegistered != null) lines.push(`  already registered in people.json: ${pf.alreadyRegistered ? 'Y' : 'N'}`);
  if (report.groupId) lines.push(`  group: ${report.groupId}${report.adopted ? ' (adopted, existing)' : ' (created this run)'}`);

  if ((report.scopeChanges || []).length) {
    lines.push('');
    lines.push(`Routing record changes for "${report.groupName || asciiLabel(report.subject)}" (stored -> new):`);
    for (const c of report.scopeChanges) {
      const show = (v) => (Array.isArray(v) ? JSON.stringify(v) : (v == null ? '(none)' : String(v)));
      lines.push(`  ${c.field.padEnd(11)}: ${show(c.stored)} -> ${show(c.requested)}${c.narrows ? '   NARROWS: loads the stored scope matched stop reaching this group' : ''}`);
    }
  }

  if (report.refused) {
    lines.push('');
    lines.push(report.remediation || `REFUSED: ${report.reason}`);
    lines.push(bar);
    return lines.join('\n');
  }

  lines.push('');
  if (!report.plannedOps.length) {
    if (report.scopeRepair) {
      lines.push('No group ops needed - the group exists, is complete, and is already registered. An'
        + '\n  explicit scope flag does not match the stored record, so this run REWRITES the routing'
        + '\n  records only (people + assignments). Zero sender ops.');
    } else if (report.registrationPlanned) {
      lines.push('No group ops needed - the group exists and is complete. It is UNREGISTERED, so this run writes'
        + '\n  the routing records only (people + assignments). Zero sender ops.');
    } else {
      lines.push('No group ops needed.');
    }
  } else if (!report.apply) {
    lines.push(`Planned ops (${report.plannedOps.length}):`);
    for (const op of report.plannedOps) lines.push(`  [plan] ${op}`);
  } else {
    lines.push('Ops:');
    for (const r of report.results) {
      const v = r.verified === null ? 'n/a' : (r.verified ? 'verified' : 'NOT verified');
      const tries = r.attempts > 1 ? ` after ${r.attempts} attempts` : '';
      lines.push(`  [${r.ok ? 'sent' : 'FAILED'}] ${r.op}: read-back ${v}${tries}${r.error ? ` [${r.error}]` : ''}`);
    }
  }

  if (report.registered) {
    const bs = (report.registered.branchScope || []).length ? ` branchScope=${JSON.stringify(report.registered.branchScope)}` : '';
    lines.push('');
    lines.push(`Registered: person ${report.registered.personId} -> customer ${report.registered.customerId}${bs}`);
  }

  if (report.warnings.length) {
    lines.push('');
    lines.push('WARNINGS (read before --apply):');
    for (const w of report.warnings) lines.push(`  ! ${w}`);
  }

  lines.push('');
  if (report.aborted) lines.push(`ABORTED: ${report.abortReason}`);
  else if (report.capped) lines.push(`STOPPED EARLY: ${report.abortReason}`);
  else if (report.apply) lines.push(`Done. ${report.opsApplied} op(s) applied.`);
  else lines.push(`DRY RUN. ${report.plannedOps.length} op(s) planned (cap ${MAX_OPS_PER_RUN}/run)`
    + `${report.registrationPlanned ? ' + routing records to write' : ''}. Re-run with --apply and supervise it.`);
  lines.push(`elapsed: ${Math.round(report.elapsedMs / 1000)}s`);
  lines.push('');
  lines.push(manualFollowUps(asciiLabel(report.subject || '')));
  lines.push(bar);
  return lines.join('\n');
}

// ---- CLI ----
function parseArgs(argv) {
  const args = {
    apply: false, rename: false, customer: null, label: null, portal: PORTAL_SP,
    members: [], branchScope: null, accountId: null, originScope: null, dataDir: null, maxOps: MAX_OPS_PER_RUN,
  };
  const val = (a, k) => a.slice(`--${k}=`.length);
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a === '--rename') args.rename = true;
    else if (a.startsWith('--customer=')) args.customer = val(a, 'customer');
    else if (a.startsWith('--label=')) args.label = val(a, 'label');
    else if (a.startsWith('--portal=')) args.portal = val(a, 'portal').toUpperCase();
    else if (a.startsWith('--members=')) args.members = val(a, 'members').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--branch-scope=')) args.branchScope = val(a, 'branch-scope').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--origin-scope=')) args.originScope = val(a, 'origin-scope').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith('--account=')) args.accountId = val(a, 'account').trim() || null;
    else if (a.startsWith('--data-dir=')) args.dataDir = val(a, 'data-dir');
    else if (a.startsWith('--max-ops=')) args.maxOps = Math.max(1, parseInt(val(a, 'max-ops'), 10) || MAX_OPS_PER_RUN);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.customer) {
    process.stderr.write('provision-group: --customer=<customerId|label> is required.\n');
    process.exit(2);
    return;
  }
  const config = require('../src/config');
  const { FileStore } = require('../src/store');
  const { StaffRoster } = require('../src/model/staffRoster');
  const { PersonStore } = require('../src/model/personStore');
  const { CustomerStore } = require('../src/model/customerStore');
  const { AssignmentStore } = require('../src/model/assignmentStore');
  const { loadAccounts } = require('../src/auth/accounts');

  const dataDir = args.dataDir || (config && config.dataDir) || path.join(__dirname, '..', 'data');
  const wa = new WhatsAppClient(Object.assign({}, config && config.whatsapp, { enabled: true, log: () => {} }));
  if (!wa.enabled()) {
    process.stderr.write('provision-group: WhatsApp is not configured (need SP_MAYTAPI_TOKEN / _PRODUCT_ID / _PHONE_ID).\n');
    process.exit(2);
    return;
  }
  const store = new FileStore({ dataDir });
  const customerStore = new CustomerStore({ store });
  const personStore = new PersonStore({ store, accountsProvider: () => loadAccounts(store) });
  const report = await runProvision({
    wa,
    staffRoster: new StaffRoster({ store }),
    customerStore,
    personStore,
    assignmentStore: new AssignmentStore({ store, people: personStore, customers: customerStore }),
    customerRef: args.customer,
    label: args.label,
    portal: args.portal,
    members: args.members,
    branchScope: args.branchScope,
    accountId: args.accountId,
    originScope: args.originScope,
    apply: args.apply,
    rename: args.rename,
    maxOps: args.maxOps,
  });
  process.stdout.write(formatReport(report) + '\n');
  process.exit(report.refused || report.aborted ? 1 : 0);
}

module.exports = {
  runProvision, formatReport, parseArgs, groupMatchesLabel,
  remediationMissingCustomer, remediationMissingRoster, manualFollowUps,
  MIN_INTERVAL_MS, MAX_OPS_PER_RUN, READ_BACK_SETTLE_MS, READ_BACK_ATTEMPTS,
};

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`provision-group fatal: ${e && e.message}\n`); process.exit(1); });
}
