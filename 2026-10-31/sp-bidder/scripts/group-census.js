'use strict';
/**
 * group-census - the live state of every bidding-desk WhatsApp group, in one read-only command.
 *
 *   node scripts/group-census.js            # the table + the issue lists
 *   node scripts/group-census.js --json     # same data, machine-readable
 *
 * WHY: the group count has been wrong in every document that quoted it. Open loop A13 and the
 * 2026-07-27 audit both say 11 live groups; it is 16, and the op count that hung off that figure was
 * wrong by ten. Nothing generated the list, so each doc hand-copied the last one. This is the
 * generator - if a number about groups appears in a doc, it should come from here.
 *
 * Read-only by construction: getGroups + the local stores. No writes, no --apply, no message.
 */

const path = require('path');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const {
  PORTAL_SP, FALLBACK_NUMBER,
  isBrlBidsGroup, parseGroupName, portalOf, nameConformsTo,
  excludedReason, canonicalPhoneKey, matchState, hasDescription, asciiLabel,
} = require('./lib/group-directory');

const { isGroupJid } = require('../src/model/normalizePhone');

/**
 * Build the census. Injected deps only, so it is testable offline.
 * -> { groups: [...], excluded: [...], issues: {...}, totals: {...} }
 */
async function runCensus({ wa, personStore, customerStore, assignmentStore, staffRoster, fallbackNumber = FALLBACK_NUMBER } = {}) {
  const selfNumber = await wa.selfNumber();
  const selfKey = canonicalPhoneKey(selfNumber);
  const fallbackKey = canonicalPhoneKey(fallbackNumber);

  const live = await wa.getGroups();
  const people = ((await personStore.list()) || []).filter((p) => p && isGroupJid(p.phone));
  const customers = (await customerStore.list()) || [];
  const assignments = (await assignmentStore.list()) || [];
  const roster = new Set(((await staffRoster.list()) || []).map(canonicalPhoneKey).filter(Boolean));

  const byJid = new Map();
  for (const p of people) byJid.set(String(p.phone).toLowerCase(), p);
  const customerById = new Map(customers.map((c) => [c.customerId, c]));
  const assignmentsByPerson = new Map();
  for (const a of assignments) {
    if (!a || a.enabled === false) continue;
    if (!assignmentsByPerson.has(a.personId)) assignmentsByPerson.set(a.personId, []);
    assignmentsByPerson.get(a.personId).push(a.customerId);
  }

  const deskNamed = (live || []).filter((g) => g && g.id && isBrlBidsGroup(g.name));
  const excluded = deskNamed
    .filter((g) => excludedReason(g.id))
    .map((g) => ({ jid: g.id, name: asciiLabel(g.name), n: (g.participants || []).length, reason: excludedReason(g.id) }));

  const groups = [];
  for (const g of deskNamed) {
    if (excludedReason(g.id)) continue;
    const jid = String(g.id).toLowerCase();
    const person = byJid.get(jid) || null;
    const custIds = person ? (assignmentsByPerson.get(person.personId) || []) : [];
    const custLabels = custIds.map((id) => (customerById.get(id) || {}).label || id);
    const parsed = parseGroupName(g.name);
    // Conformance is judged against the customer the group is REGISTERED to when we know it, else
    // against the label parsed out of its own subject (which can only fail on the portal token).
    const conformanceLabel = custLabels.length === 1 ? custLabels[0] : parsed.customer;
    const cfg = g.config;
    const participants = g.participants || [];
    groups.push({
      jid,
      name: asciiLabel(g.name),
      portal: portalOf(g) || PORTAL_SP,
      portalExplicit: parsed.portalExplicit,
      n: participants.length,
      lock: (!cfg || typeof cfg.membersCanAddMembers !== 'boolean') ? null : cfg.membersCanAddMembers === false,
      primaryAdmin: selfKey ? matchState(g.admins || [], selfKey) : 'indeterminate',
      fallbackAdmin: matchState(g.admins || [], fallbackKey),
      description: hasDescription(g),
      registered: !!person,
      personId: person ? person.personId : null,
      customers: custLabels,
      branchScope: person && Array.isArray(person.branchScope) ? person.branchScope : [],
      nameConforms: conformanceLabel ? nameConformsTo(g.name, conformanceLabel, portalOf(g) || PORTAL_SP) : null,
      offRoster: participants.filter((p) => {
        const k = canonicalPhoneKey(p);
        return k != null && k !== selfKey && !roster.has(k);
      }).length,
      opaqueRows: participants.filter((p) => canonicalPhoneKey(p) == null).length,
    });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));

  // A registered group the live read did not return: the bot is not in it, or its subject stopped
  // matching the prefix. Either way a name-driven runner would silently skip it.
  const liveJids = new Set(groups.map((g) => g.jid));
  const missingFromLive = people
    .filter((p) => p.enabled !== false && !liveJids.has(String(p.phone).toLowerCase()) && !excludedReason(p.phone))
    // asciiLabel the store name too - it carries the canonical middle dot, and this is the one place
    // a name reaches the report from people.json rather than from the live subject.
    .map((p) => ({ personId: p.personId, name: p.name ? asciiLabel(p.name) : null, jid: String(p.phone).toLowerCase() }));

  // Two groups serving one customer - legitimate for a branch split, the duplicate-Alwar signature
  // otherwise. Reported, never judged.
  const perCustomer = new Map();
  for (const g of groups) {
    for (const c of g.customers) {
      if (!perCustomer.has(c)) perCustomer.set(c, []);
      perCustomer.get(c).push(g.name);
    }
  }

  const issues = {
    singleAdmin: groups.filter((g) => g.fallbackAdmin !== 'present').map((g) => g.name),
    openAdd: groups.filter((g) => g.lock !== true).map((g) => g.name),
    noDescription: groups.filter((g) => g.description === false).map((g) => g.name),
    unregistered: groups.filter((g) => !g.registered).map((g) => g.name),
    noCustomer: groups.filter((g) => g.registered && !g.customers.length).map((g) => g.name),
    nameDrift: groups.filter((g) => g.nameConforms === false).map((g) => g.name),
    legacyPortal: groups.filter((g) => !g.portalExplicit).map((g) => g.name),
    offRoster: groups.filter((g) => g.offRoster > 0).map((g) => `${g.name} (${g.offRoster})`),
    missingFromLive: missingFromLive.map((m) => `${m.name || m.personId} (${m.jid})`),
    multiGroupCustomers: [...perCustomer.entries()].filter(([, v]) => v.length > 1).map(([c, v]) => `${c}: ${v.join(', ')}`),
  };

  return {
    groups,
    excluded,
    issues,
    totals: {
      live: groups.length,
      excluded: excluded.length,
      registered: groups.filter((g) => g.registered).length,
      locked: groups.filter((g) => g.lock === true).length,
      dualAdmin: groups.filter((g) => g.fallbackAdmin === 'present').length,
      withDescription: groups.filter((g) => g.description === true).length,
      byPortal: groups.reduce((acc, g) => { acc[g.portal] = (acc[g.portal] || 0) + 1; return acc; }, {}),
    },
  };
}

const tri = (v) => (v === true ? 'Y' : v === false ? 'N' : '?');
const pad = (s, w) => String(s == null ? '' : s).slice(0, w).padEnd(w);

function formatCensus(census) {
  const bar = '='.repeat(100);
  const lines = [bar, 'BRL bidding-desk WhatsApp group census (live read, read-only)', bar];
  const t = census.totals;
  lines.push(`live desk groups: ${t.live}   registered: ${t.registered}   locked: ${t.locked}   dual-admin: ${t.dualAdmin}   with description: ${t.withDescription}`);
  lines.push(`by portal: ${Object.entries(t.byPortal).map(([k, v]) => `${k}=${v}`).join('  ') || 'none'}   excluded by JID: ${t.excluded}`);
  lines.push('');
  lines.push(`${pad('group', 34)} ${pad('portal', 6)} ${pad('n', 3)} ${pad('lock', 4)} ${pad('adm1', 4)} ${pad('adm2', 4)} ${pad('desc', 4)} ${pad('reg', 3)} ${pad('name', 4)} off`);
  lines.push('-'.repeat(100));
  for (const g of census.groups) {
    lines.push([
      pad(g.name, 34),
      pad(g.portal + (g.portalExplicit ? '' : '*'), 6),
      pad(g.n, 3),
      pad(tri(g.lock), 4),
      pad(g.primaryAdmin === 'present' ? 'Y' : g.primaryAdmin === 'absent' ? 'N' : '?', 4),
      pad(g.fallbackAdmin === 'present' ? 'Y' : g.fallbackAdmin === 'absent' ? 'N' : '?', 4),
      pad(tri(g.description), 4),
      pad(g.registered ? 'Y' : 'N', 3),
      pad(tri(g.nameConforms), 4),
      g.offRoster || 0,
    ].join(' '));
  }
  lines.push('-'.repeat(100));
  lines.push('portal* = no token in the subject (legacy, resolved to SP).  adm1/adm2 = primary sender / fallback.');
  lines.push('off = participants not on staffRoster (excludes the bot). ? = the provider did not return the field.');

  if (census.excluded.length) {
    lines.push('');
    lines.push('EXCLUDED by JID (never touched by any runner):');
    for (const e of census.excluded) lines.push(`  ${pad(e.name, 40)} ${e.jid}  n=${e.n}  - ${e.reason}`);
  }

  const labels = {
    missingFromLive: 'REGISTERED but not in the live read (a name-driven runner would SKIP these)',
    singleAdmin: 'ONE controlled administrator (the fallback is not an admin)',
    openAdd: 'NOT locked to admin-only adds',
    unregistered: 'live but NOT registered in people.json (carries no routing)',
    noCustomer: 'registered but assigned to NO customer (empty scope = matches every load)',
    noDescription: 'empty description (needs a human in the WhatsApp app)',
    nameDrift: 'name does not match the standard for its customer + portal',
    legacyPortal: 'no portal token in the subject (legacy-SP; fine, but scope runners by portalOf)',
    offRoster: 'participants not on the staff allowlist',
    multiGroupCustomers: 'customers served by more than one group (branch split, or a duplicate)',
  };
  const order = ['missingFromLive', 'singleAdmin', 'openAdd', 'unregistered', 'noCustomer', 'offRoster', 'noDescription', 'nameDrift', 'multiGroupCustomers', 'legacyPortal'];
  const found = order.filter((k) => (census.issues[k] || []).length);
  lines.push('');
  if (!found.length) {
    lines.push('No issues found.');
  } else {
    lines.push('ISSUES');
    for (const k of found) {
      lines.push(`  ${labels[k]} (${census.issues[k].length}):`);
      for (const v of census.issues[k]) lines.push(`      - ${v}`);
    }
  }
  lines.push(bar);
  return lines.join('\n');
}

async function main() {
  const asJson = process.argv.slice(2).includes('--json');
  const dataDirArg = process.argv.slice(2).find((a) => a.startsWith('--data-dir='));
  const config = require('../src/config');
  const { FileStore } = require('../src/store');
  const { StaffRoster } = require('../src/model/staffRoster');
  const { PersonStore } = require('../src/model/personStore');
  const { CustomerStore } = require('../src/model/customerStore');
  const { AssignmentStore } = require('../src/model/assignmentStore');

  const dataDir = (dataDirArg && dataDirArg.slice('--data-dir='.length)) || (config && config.dataDir) || path.join(__dirname, '..', 'data');
  const wa = new WhatsAppClient(Object.assign({}, config && config.whatsapp, { enabled: true, log: () => {} }));
  if (!wa.enabled()) {
    process.stderr.write('group-census: WhatsApp is not configured (need SP_MAYTAPI_TOKEN / _PRODUCT_ID / _PHONE_ID).\n');
    process.exit(2);
    return;
  }
  const store = new FileStore({ dataDir });
  const personStore = new PersonStore({ store });
  const customerStore = new CustomerStore({ store });
  const census = await runCensus({
    wa,
    personStore,
    customerStore,
    assignmentStore: new AssignmentStore({ store, people: personStore, customers: customerStore }),
    staffRoster: new StaffRoster({ store }),
  });
  process.stdout.write((asJson ? JSON.stringify(census, null, 2) : formatCensus(census)) + '\n');
}

module.exports = { runCensus, formatCensus };

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`group-census fatal: ${e && e.message}\n`); process.exit(1); });
}
