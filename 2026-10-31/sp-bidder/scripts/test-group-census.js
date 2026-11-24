'use strict';
/**
 * Offline tests for scripts/group-census.js - the generated group list that replaces hand-copied
 * counts. Read-only by construction, so the strongest test is that a full run over a live-shaped
 * board issues no writes and still classifies every drift the audits found by hand.
 */

const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');
const { StaffRoster } = require('../src/model/staffRoster');
const { PersonStore } = require('../src/model/personStore');
const { CustomerStore } = require('../src/model/customerStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const G = require('./lib/group-directory');
const { runCensus, formatCensus } = require('./group-census');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const BOT = '918882034647';
const FALLBACK = G.FALLBACK_NUMBER;
const SUYASHH = '919594937777';
const OUTSIDER = '919999689877';
const PHONE = '128023';

function group({ id, label, portalToken = false, participants, admins, lock = true, description = null, config = undefined }) {
  const name = portalToken ? G.waGroupSubject(label) : `${G.TRUCK} ${G.GROUP_NAME_PREFIX} ${G.MIDDOT} ${label}`;
  let cfg = config;
  if (cfg === undefined) {
    cfg = { edit: 'all', send: 'all', disappear: false, membersCanAddMembers: !lock, approveNewMembers: false };
    if (description != null) cfg.description = description;
  }
  return { id, name, participants: participants || [`${BOT}@c.us`], admins: admins || [`${BOT}@c.us`], config: cfg };
}

function fakeTransport(groups, { calls = [] } = {}) {
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  return {
    calls,
    transport: async (url, opts = {}) => {
      calls.push({ url, method: (opts && opts.method) || 'GET' });
      if (url.endsWith('/listPhones')) return json({ success: true, data: [{ id: PHONE, number: BOT, status: 'active' }] });
      if (url.endsWith('/getGroups')) return json({ success: true, data: groups });
      return json({ success: false, message: 'unexpected' });
    },
  };
}

(async () => {
  // A board carrying one of every drift the July audits found by hand.
  const GROUPS = [
    // clean: token, locked, dual-admin, described, registered, on-roster
    group({ id: '120363400000000010@g.us', label: 'Syngenta', portalToken: true, lock: true, description: 'desk channel', admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`, `${SUYASHH}@c.us`] }),
    // legacy name, single controlled admin, no description
    group({ id: '120363400000000011@g.us', label: 'Borosil', lock: true, participants: [`${BOT}@c.us`, `${SUYASHH}@c.us`] }),
    // open-add + an off-roster participant
    group({ id: '120363400000000012@g.us', label: 'Durian', lock: false, admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${OUTSIDER}@c.us`] }),
    // live but unregistered (no people.json row)
    group({ id: '120363400000000013@g.us', label: 'Cords Cable', lock: true, admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`] }),
    // config unreadable -> lock and description must read '?' not 'N'
    group({ id: '120363400000000014@g.us', label: 'KEI', admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], config: null }),
    // excluded by JID: the stale duplicate Alwar group
    group({ id: '120363429139853197@g.us', label: 'Havells Alwar', lock: false }),
    // excluded by JID: a sandbox group adversarially renamed onto the live prefix
    group({ id: '120363410291368425@g.us', label: 'send test', lock: false }),
    // not a desk group at all
    { id: '120363499999999999@g.us', name: 'Family', participants: [], admins: [], config: null },
  ];

  const store = new MemoryStore();
  const customerStore = new CustomerStore({ store });
  const personStore = new PersonStore({ store });
  const assignmentStore = new AssignmentStore({ store, people: personStore, customers: customerStore });
  const staffRoster = new StaffRoster({ store });

  for (const c of [{ label: 'Syngenta' }, { label: 'Borosil' }, { label: 'Durian' }, { label: 'KEI' }, { label: 'Havells' }]) await customerStore.upsert(c);
  await staffRoster.replace([`+${FALLBACK}`, `+${SUYASHH}`]);

  const reg = async (jid, label, customerId, extra = {}) => {
    const pid = `g${jid.replace(/\D/g, '')}`;
    await personStore.upsert(Object.assign({ personId: pid, name: G.canonicalGroupName(label), phone: jid, accountId: 'primary', alertPrefs: 'all', alertAll: false }, extra));
    if (customerId) await assignmentStore.upsert({ personId: pid, customerId });
    return pid;
  };
  await reg('120363400000000010@g.us', 'Syngenta', 'syngenta');
  await reg('120363400000000011@g.us', 'Borosil', 'borosil');
  await reg('120363400000000012@g.us', 'Durian', 'durian');
  await reg('120363400000000014@g.us', 'KEI', 'kei');
  // Registered but assigned to no customer -> empty scope, matches every load.
  await reg('120363400000000015@g.us', 'Havells', null);

  const { transport, calls } = fakeTransport(GROUPS);
  const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: PHONE, enabled: true, transport, log: () => {} });
  const census = await runCensus({ wa, personStore, customerStore, assignmentStore, staffRoster });

  // ---- read-only ----
  ok(!calls.some((c) => c.method === 'POST'), 'the census issues ZERO writes');
  ok(typeof require('./group-census').runCensus === 'function' && !('apply' in require('./group-census')), 'there is no apply path to invoke');

  // ---- scoping ----
  ok(census.totals.live === 5, 'counts the desk groups only (non-desk and excluded are not live groups)');
  ok(!census.groups.some((g) => g.name === 'Family'), 'a non-desk group is not in the census');
  ok(census.excluded.length === 2, 'both excluded JIDs are reported separately');
  ok(census.excluded.some((e) => /STALE DUPLICATE/.test(e.reason)), 'the duplicate Alwar group is named with its reason');
  ok(census.excluded.some((e) => /sandbox/.test(e.reason)), 'a sandbox group renamed onto the live prefix is still excluded by JID');

  // ---- per-group classification ----
  const byName = (frag) => census.groups.find((g) => g.name.includes(frag));
  const syn = byName('Syngenta');
  ok(syn.lock === true && syn.fallbackAdmin === 'present' && syn.description === true && syn.registered && syn.nameConforms === true,
    'the clean group reads clean on every axis');
  ok(syn.portalExplicit === true && syn.portal === 'SP', 'an explicit token is reported as explicit');

  const bor = byName('Borosil');
  ok(bor.portal === 'SP' && bor.portalExplicit === false, 'a legacy group resolves to SP but is flagged as tokenless');
  ok(bor.fallbackAdmin === 'absent' && bor.description === false && bor.nameConforms === false, 'legacy drift is caught: single admin, no description, name off-standard');

  const dur = byName('Durian');
  ok(dur.lock === false && dur.offRoster === 1, 'an open-add group with an off-roster participant is caught');

  const kei = byName('KEI');
  ok(kei.lock === null && kei.description === null, 'an unreadable config reports unknown, never a false "compliant" or "empty"');

  ok(byName('Cords Cable').registered === false, 'a live group with no people.json row reads unregistered');

  // ---- issue lists ----
  const i = census.issues;
  ok(i.singleAdmin.length === 1 && /Borosil/.test(i.singleAdmin[0]), 'singleAdmin lists only the group missing the fallback');
  ok(i.openAdd.some((n) => /Durian/.test(n)) && i.openAdd.some((n) => /KEI/.test(n)), 'openAdd includes both a known-open group and an unreadable one');
  ok(i.unregistered.some((n) => /Cords/.test(n)), 'unregistered is listed');
  ok(i.offRoster.some((n) => /Durian \(1\)/.test(n)), 'offRoster carries the count');
  ok(i.noCustomer.length === 0, 'a group registered to no customer is only flagged when it is LIVE');
  ok(i.missingFromLive.some((n) => /120363400000000015/.test(n)), 'a registered group absent from the live read is surfaced - a name-driven runner would skip it');
  ok(i.legacyPortal.length === 4, 'every tokenless group is listed as legacy-SP');
  ok(i.nameDrift.length >= 1, 'name drift is reported');

  // ---- totals ----
  ok(census.totals.registered === 4 && census.totals.dualAdmin === 4 && census.totals.locked === 3,
    'totals are computed from the live read, not from a document');
  ok(census.totals.byPortal.SP === 5, 'the portal breakdown counts legacy groups as SP');
  ok(census.totals.excluded === 2, 'excluded groups are counted apart from live ones');

  // ---- rendering ----
  const out = formatCensus(census);
  ok(/^[\x20-\x7E\n]*$/.test(out), 'the rendered census is printable ASCII (no mangled group names on a cp1252 console)');
  ok(/live desk groups: 5/.test(out), 'the header states the live count');
  ok(/ISSUES/.test(out) && /ONE controlled administrator/.test(out), 'the issue sections are labelled in plain English');
  ok(/portal\* = no token/.test(out), 'the legend explains the legacy marker');

  const clean = await runCensus({
    wa: new WhatsAppClient({ token: 't', productId: 'p', phoneId: PHONE, enabled: true, transport: fakeTransport([GROUPS[0]]).transport, log: () => {} }),
    personStore: { list: async () => [{ personId: 'g120363400000000010', name: 'x', phone: '120363400000000010@g.us', enabled: true, branchScope: [] }] },
    customerStore, assignmentStore, staffRoster,
  });
  ok(/No issues found/.test(formatCensus(clean)), 'a clean board renders no issue sections');

  ok(pass > 25, `the whole suite ran (${pass} assertions)`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
