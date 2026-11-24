'use strict';
/**
 * Offline tests for the group standard: scripts/lib/group-directory.js, scripts/provision-group.js,
 * and the group-admin wire they ride on (whatsapp.js createGroup/setGroupConfig/addParticipant/
 * promoteAdmin/listPhones). No live Maytapi - a real WhatsAppClient is built over a fake transport
 * whose board MUTATES as ops land, so read-back verification is exercised for real.
 */

const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');
const { StaffRoster } = require('../src/model/staffRoster');
const { PersonStore } = require('../src/model/personStore');
const { CustomerStore } = require('../src/model/customerStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const G = require('./lib/group-directory');
const {
  runProvision, formatReport, parseArgs, groupMatchesLabel,
  remediationMissingCustomer, remediationMissingRoster, manualFollowUps,
} = require('./provision-group');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const BOT = '918882034647';
const FALLBACK = G.FALLBACK_NUMBER;      // 919594964196
const SUYASHH = '919594937777';
const SUSHANT = '919594963468';
const CREATOR_PHONE = '128023';

// ---- a fake Maytapi whose group board changes as writes land ----
function fakeMaytapi({ groups = [], phones = null, failOn = {}, hardErrorOn = {} } = {}) {
  const state = {
    groups: groups.map((g) => JSON.parse(JSON.stringify(g))),
    phones: phones || [
      { id: CREATOR_PHONE, number: BOT, status: 'active' },
      { id: G.FALLBACK_PHONE_ID, number: FALLBACK, status: 'active' },
    ],
    calls: [],
    nextId: 120363499999999001,
  };
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const transport = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    state.calls.push({ url, method: opts.method || 'GET', body });
    if (url.endsWith('/listPhones')) return json({ success: true, data: state.phones });
    if (url.endsWith('/getGroups')) return json({ success: true, data: state.groups });
    if (url.endsWith('/createGroup')) {
      if (failOn.create) return json({ success: false, message: 'create rejected' });
      const id = `${state.nextId++}@g.us`;
      state.groups.push({
        id,
        name: body.name,
        participants: [`${BOT}@c.us`, ...(body.numbers || []).map((n) => `${n}@c.us`)],
        admins: [`${BOT}@c.us`],
        // The birth config lands only when the fake is told it does - the real API's behaviour here
        // is unverified, which is the whole reason the runner re-reads and remediates.
        config: failOn.birthConfig ? { edit: 'all', send: 'all', membersCanAddMembers: true } : (body.config || null),
      });
      return json({ success: true, data: { id } });
    }
    const target = body && body.conversation_id
      ? state.groups.find((g) => g.id.toLowerCase() === String(body.conversation_id).toLowerCase())
      : null;
    if (url.endsWith('/group/add')) {
      if (failOn.add) return json({ success: false, message: 'add rejected' });
      // hardErrorOn.add = the Durian case: HTTP 500 on a write that fully landed.
      if (target) for (const n of body.numbers || []) if (!target.participants.includes(`${n}@c.us`)) target.participants.push(`${n}@c.us`);
      if (hardErrorOn.add) return json({ success: false, message: 'unknown error' }, 500);
      return json({ success: true });
    }
    if (url.endsWith('/group/promote')) {
      if (failOn.promote) return json({ success: false, message: 'promote rejected' });
      if (target && !target.admins.includes(body.number)) target.admins.push(body.number);
      return json({ success: true });
    }
    if (url.endsWith('/group/config')) {
      if (failOn.config) return json({ success: false, message: 'config rejected' });
      if (target) {
        const incoming = Object.assign({}, body.config);
        // config.name is applied as the group's SUBJECT, not stored as a settings field.
        if (incoming.name != null) { target.name = incoming.name; delete incoming.name; }
        target.config = Object.assign({}, target.config, incoming);
      }
      return json({ success: true });
    }
    return json({ success: false, message: `unhandled ${url}` }, 404);
  };
  return { state, transport };
}

const client = (transport) => new WhatsAppClient({
  token: 't', productId: 'p', phoneId: CREATOR_PHONE, enabled: true, transport, log: () => {},
});

async function fixtureStores({ customers = [{ label: 'Syngenta', aliases: ['SYNGENTA INDIA'] }], roster = [FALLBACK, SUYASHH, SUSHANT], people = [], assignments = [] } = {}) {
  const store = new MemoryStore();
  const customerStore = new CustomerStore({ store });
  const personStore = new PersonStore({ store });
  const assignmentStore = new AssignmentStore({ store, people: personStore, customers: customerStore });
  const staffRoster = new StaffRoster({ store });
  for (const c of customers) await customerStore.upsert(c);
  await staffRoster.replace(roster.map((n) => `+${n}`));
  for (const p of people) await personStore.upsert(p);
  for (const a of assignments) await assignmentStore.upsert(a);
  return { store, customerStore, personStore, assignmentStore, staffRoster };
}

// A live-shape group: ornament-prefixed subject, legacy (no portal token), locked, bot-only admin.
function liveGroup({ id = '120363411347757347@g.us', label = 'Tata Consumer', portalToken = false, participants = null, admins = null, lock = true, description = null } = {}) {
  const name = portalToken ? G.waGroupSubject(label, G.PORTAL_SP) : `${G.TRUCK} ${G.GROUP_NAME_PREFIX} ${G.MIDDOT} ${label}`;
  const cfg = { edit: 'all', send: 'all', disappear: false, membersCanAddMembers: !lock, approveNewMembers: false };
  if (description != null) cfg.description = description;
  return {
    id,
    name,
    participants: participants || [`${BOT}@c.us`, `${SUYASHH}@c.us`],
    admins: admins || [`${BOT}@c.us`],
    config: cfg,
  };
}

// A sleep spy: records every interval instead of waiting.
function spySleep() {
  const calls = [];
  const fn = async (ms) => { calls.push(ms); };
  fn.calls = calls;
  return fn;
}

(async () => {
  // ================= group-directory =================
  {
    ok(G.canonicalGroupName('Syngenta') === `BRL Bids ${G.MIDDOT} SP ${G.MIDDOT} Syngenta`, 'canonical store name carries the SP token');
    ok(G.waGroupSubject('Syngenta').startsWith(G.TRUCK), 'the WhatsApp subject keeps the truck ornament');

    const p1 = G.parseGroupName(`${G.TRUCK} BRL Bids ${G.MIDDOT} SP ${G.MIDDOT} Havells`);
    ok(p1.portal === 'SP' && p1.portalExplicit === true && p1.customer === 'Havells', 'an explicit SP token parses out, customer intact');

    const p2 = G.parseGroupName(`${G.TRUCK} BRL Bids ${G.MIDDOT} Havells`);
    ok(p2.prefixOk && p2.portal === null && p2.portalExplicit === false && p2.customer === 'Havells', 'a legacy subject parses with no token');
    ok(G.portalOf(`${G.TRUCK} BRL Bids ${G.MIDDOT} Havells`) === 'SP', 'a legacy group resolves to SP so it keeps working un-renamed');
    ok(G.portalOf(`BRL Bids ${G.MIDDOT} GC ${G.MIDDOT} Havells`) === 'GC', 'a GC token resolves to GoComet');
    ok(G.portalOf('Family group') === null, 'a non-desk group has no portal');

    // The false-positive the structural parse exists to prevent.
    const p3 = G.parseGroupName(`BRL Bids ${G.MIDDOT} SPML India`);
    ok(p3.portalExplicit === false && p3.customer === 'SPML India', 'a customer starting with "SP" is not read as the SP token');

    // Branch groups must not collide with their parent.
    ok(groupMatchesLabel(liveGroup({ label: 'Havells Alwar' }), 'Havells Alwar', 'SP') === true, 'a branch group matches its own label');
    ok(groupMatchesLabel(liveGroup({ label: 'Havells Alwar' }), 'Havells', 'SP') === false, 'a branch group does NOT match the parent customer label');
    ok(groupMatchesLabel(liveGroup({ label: 'Havells', portalToken: true }), 'Havells', 'GC') === false, 'the same customer on another portal is a different group');

    ok(G.isBrlBidsGroup(`${G.TRUCK} BRL Bids ${G.MIDDOT} KEI`), 'prefix test survives a leading emoji');
    ok(!G.isBrlBidsGroup('BRL Bidder - group send test'), 'the sandbox subject fails the prefix by one character');

    ok(!!G.excludedReason('120363429139853197@g.us'), 'the stale duplicate Alwar group is excluded by JID');
    ok(!!G.excludedReason('120363410291368425'), 'a sandbox group is excluded by bare digits too');
    ok(!G.excludedReason('120363411347757347@g.us'), 'a real customer group is not excluded');

    ok(G.canonicalPhoneKey('919356252711@c.us') === '9356252711', 'country code is recognised, not sliced');
    ok(G.canonicalPhoneKey('84739218374@lid') === null, 'an @lid row is opaque, never reduced to a number');
    ok(G.matchState([`${BOT}@c.us`], G.canonicalPhoneKey(BOT)) === 'present', 'matchState finds a present number');
    ok(G.matchState([`${BOT}@c.us`], G.canonicalPhoneKey(FALLBACK)) === 'absent', 'all rows reconciled and no match = absent');
    ok(G.matchState(['84739218374@lid'], G.canonicalPhoneKey(FALLBACK)) === 'indeterminate', 'an opaque row makes the answer indeterminate');

    ok(G.mergeLockConfig({ edit: 'admins', send: 'all', membersCanAddMembers: true }).edit === 'admins',
      'mergeLockConfig preserves fields it is not there to change (full-replace safety)');
    ok(G.mergeLockConfig({ membersCanAddMembers: true }).membersCanAddMembers === false, 'mergeLockConfig forces the lock');
    ok(!('description' in G.mergeLockConfig({ description: 'x', membersCanAddMembers: true })), 'mergeLockConfig never echoes a description back into a write');

    ok(G.nameConformsTo(`${G.TRUCK} BRL Bids . SP . Syngenta`, 'Syngenta', 'SP'), 'conformance is structural, not punctuation-exact');
    ok(!G.nameConformsTo(`${G.TRUCK} BRL Bids ${G.MIDDOT} Syngenta`, 'Syngenta', 'SP'), 'a missing portal token is name drift');
    ok(/^[\x20-\x7E]*$/.test(G.asciiLabel(G.waGroupSubject('Syngenta'))), 'asciiLabel output is printable ASCII');
    ok(G.hasDescription({ config: { description: '  ' } }) === false, 'a whitespace description reads as absent');
    ok(G.hasDescription({ config: null }) === null, 'an unreadable config is not evidence of an empty description');
  }

  // ================= whatsapp wire =================
  {
    const { state, transport } = fakeMaytapi();
    const wa = client(transport);

    const created = await wa.createGroup('X', [FALLBACK], { config: G.DESIRED_GROUP_CONFIG });
    ok(created.ok && /@g\.us$/.test(created.id), 'createGroup returns the new group JID');
    const createCall = state.calls.find((c) => c.url.endsWith('/createGroup'));
    ok(createCall.body.numbers[0] === FALLBACK && createCall.body.config.membersCanAddMembers === false,
      'createGroup posts the fallback as a member and the lock in the birth config');

    ok((await wa.createGroup('', [FALLBACK])).ok === false, 'createGroup refuses an empty name');
    ok((await wa.createGroup('X', [])).ok === false, 'createGroup refuses an empty member list');

    const desc = await wa.setGroupConfig(created.id, { membersCanAddMembers: false, description: 'anything' });
    ok(desc.ok === false && /description cannot be set/i.test(desc.error), 'setGroupConfig REFUSES a description write rather than let it fail silently');
    ok(!state.calls.some((c) => c.body && c.body.config && 'description' in c.body.config), 'no description ever reached the wire');

    const cfg = await wa.setGroupConfig(created.id, G.mergeLockConfig({ membersCanAddMembers: true }));
    ok(cfg.ok, 'setGroupConfig posts a full config block');
    ok((await wa.setGroupConfig('919356252711', {})).ok === false, 'setGroupConfig refuses a non-group id');
    ok((await wa.addParticipant('919356252711', SUYASHH)).ok === false, 'addParticipant refuses a non-group id');
    ok((await wa.promoteAdmin(created.id, '120363411347757347@g.us')).ok === false, 'promoteAdmin refuses a group JID as the participant');

    const promoted = await wa.promoteAdmin(created.id, FALLBACK);
    const promoteCall = state.calls.find((c) => c.url.endsWith('/group/promote'));
    ok(promoted.ok && promoteCall.body.number === `${FALLBACK}@c.us`, 'promoteAdmin addresses the participant as <msisdn>@c.us');

    const bad = fakeMaytapi({ failOn: { create: true } });
    ok((await client(bad.transport).createGroup('X', [FALLBACK])).ok === false, 'a Maytapi success:false is a failure, not a silent ok');

    const phones = await wa.listPhones();
    ok(Array.isArray(phones) && phones.length === 2, 'listPhones returns the raw board');
    let threw = false;
    try { await client(async () => ({ ok: false, status: 500 })).listPhones(); } catch (_) { threw = true; }
    ok(threw, 'listPhones is fail-CLOSED (throws) so a runner stops on an unreadable board');
  }

  // ================= provisioner: refusals =================
  {
    const { transport } = fakeMaytapi();
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'nope', apply: true });
    ok(rep.refused && rep.reason === 'missing-customer', 'REFUSES when no customer record matches');
    ok(/global\s+spray/i.test(rep.remediation), 'the remediation explains the empty-scope global spray');
    ok(/onboard-w4-customers/.test(rep.remediation), 'the remediation names the script that seeds a customer');
  }
  {
    const { transport } = fakeMaytapi({ phones: [{ id: CREATOR_PHONE, number: null, status: 'qr-screen' }, { id: G.FALLBACK_PHONE_ID, number: FALLBACK, status: 'active' }] });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', apply: true });
    ok(rep.refused && /creator phone .* is qr-screen/.test(rep.reason), 'REFUSES when the creator sender is logged out');
  }
  {
    const { transport } = fakeMaytapi({ phones: [{ id: CREATOR_PHONE, number: BOT, status: 'active' }, { id: G.FALLBACK_PHONE_ID, number: FALLBACK, status: 'idle' }] });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', apply: true });
    ok(rep.refused && /must not be born with one administrator/.test(rep.reason), 'REFUSES when the fallback phone is down (no single-admin births)');
  }
  {
    const { transport, state } = fakeMaytapi();
    const s = await fixtureStores({ roster: [FALLBACK] });
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH], apply: true });
    ok(rep.refused && rep.reason === 'missing-roster', 'REFUSES when a human member is not on the staff allowlist');
    ok(rep.remediation.includes(`+${SUYASHH}`), 'the remediation names the off-roster number');
    ok(!state.calls.some((c) => c.method === 'POST'), 'a refusal performs ZERO writes');
  }
  {
    // Fully provisioned + registered -> nothing to do.
    const g = liveGroup({ id: '120363400000000001@g.us', label: 'Syngenta', portalToken: true, lock: true, admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] });
    const { transport } = fakeMaytapi({ groups: [g] });
    const pid = `g${g.id.replace(/\D/g, '')}`;
    const s = await fixtureStores({
      people: [{ personId: pid, name: G.canonicalGroupName('Syngenta'), phone: g.id, accountId: 'primary', alertPrefs: 'all', alertAll: false }],
      assignments: [{ personId: pid, customerId: 'syngenta' }],
    });
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', apply: true });
    ok(rep.refused && /already provisioned/.test(rep.reason), 'REFUSES a fully provisioned group (idempotent no-op)');
  }

  // ================= provisioner: dry run =================
  {
    const { transport, state } = fakeMaytapi();
    const s = await fixtureStores();
    const sleep = spySleep();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH, SUSHANT], sleep });
    ok(!rep.refused && rep.plannedOps.join(',') === 'create,promote,add,add', 'dry run plans create + promote + one add per member');
    ok(!state.calls.some((c) => c.method === 'POST'), 'dry run performs ZERO writes');
    ok(sleep.calls.length === 0, 'dry run sleeps ZERO times');
    ok(rep.subject.includes('SP'), 'the planned subject carries the portal token');
    ok(rep.registered === null, 'dry run registers nothing');
  }

  // ================= provisioner: happy path =================
  {
    const { transport, state } = fakeMaytapi();
    const s = await fixtureStores();
    const sleep = spySleep();
    const rep = await runProvision({
      wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH],
      branchScope: ['Alwar Cable (1350)'], apply: true, sleep, minIntervalMs: 60000,
    });
    ok(!rep.aborted && !rep.capped, 'happy path completes');
    ok(rep.opsApplied === 3, 'three mutating ops: create, promote, add');
    ok(rep.results.every((r) => r.verified !== false), 'every op read-back-verified');

    const created = state.groups[0];
    ok(created.config.membersCanAddMembers === false, 'the group is born locked');
    ok(created.admins.includes(`${FALLBACK}@c.us`), 'the fallback is an admin, so the group has two controlled administrators');
    ok(created.participants.includes(`${SUYASHH}@c.us`), 'the human member was added');

    // Rate limiting: a >=60s gap before every mutating op after the first, and never before the first.
    ok(sleep.calls.filter((ms) => ms === 60000).length === 2, 'a 60s interval precedes each mutating op after the first');

    // Health-checked before EVERY op, not once per run.
    ok(state.calls.filter((c) => c.url.endsWith('/listPhones')).length >= 4, 'the sender is re-checked before every op');

    // Registration, in referential order, with the right shape.
    ok(rep.registered && rep.registered.personId === `g${created.id.replace(/\D/g, '')}`, 'the group registered as a person');
    const person = await s.personStore.get(rep.registered.personId);
    ok(person.name === G.canonicalGroupName('Syngenta') && !person.name.includes(G.TRUCK), 'the store name is the canonical label without the ornament');
    ok(person.alertPrefs === 'all' && person.alertAll === false, 'the group takes every alert kind but is not an every-load recipient');
    ok(person.phone === created.id.toLowerCase(), 'the person phone is the group JID, un-stripped');
    ok(person.branchScope[0] === 'Alwar Cable (1350)', 'branchScope carried onto the record');
    const asg = await s.assignmentStore.get(`${rep.registered.personId}::syngenta`);
    ok(!!asg, 'the assignment scopes the group to its customer');
  }

  // ================= provisioner: a complete but UNREGISTERED group needs zero sender ops =================
  {
    const g = liveGroup({
      id: '120363400000000008@g.us', label: 'Syngenta', portalToken: true, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const { transport, state } = fakeMaytapi({ groups: [g] });
    const s = await fixtureStores();

    const dry = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta' });
    ok(dry.plannedOps.length === 0 && dry.registrationPlanned === true, 'a complete unregistered group plans zero ops but flags the routing write');
    ok(/UNREGISTERED/.test(formatReport(dry)), 'the dry run SAYS it will write routing records, rather than reporting nothing to do');

    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep() });
    ok(rep.opsApplied === 0 && !!rep.registered, 'apply repairs the routing with zero sender ops');
    ok(!state.calls.some((c) => c.method === 'POST'), 'no group mutation was issued for a registration-only repair');
  }

  // ================= provisioner: birth config did not land =================
  {
    const { transport, state } = fakeMaytapi({ failOn: { birthConfig: true } });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep() });
    ok(rep.plannedOps.includes('config'), 'a lock op is appended when the birth config did not land');
    ok(state.groups[0].config.membersCanAddMembers === false, 'the group ends up locked anyway');
    ok(rep.warnings.some((w) => /birth config did not land/.test(w)), 'the un-landed birth config is surfaced, not swallowed');
  }

  // ================= provisioner: adopt a half-provisioned group =================
  {
    const g = liveGroup({ id: '120363400000000002@g.us', label: 'Syngenta', portalToken: true, lock: false, participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] });
    const { transport, state } = fakeMaytapi({ groups: [g] });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH], apply: true, sleep: spySleep() });
    ok(!rep.plannedOps.includes('create'), 'an existing group is ADOPTED, never re-created');
    ok(rep.adopted && rep.groupId === g.id, 'the report names the adopted group');
    ok(rep.plannedOps.join(',') === 'promote,config,add', 'only the missing steps are planned');
    ok(state.groups[0].config.membersCanAddMembers === false && state.groups[0].admins.includes(`${FALLBACK}@c.us`), 'adoption finishes the lock and the second admin');
    ok(!!rep.registered, 'a completed adoption registers');
  }

  // ================= provisioner: renaming a legacy group to the standard =================
  {
    // A legacy group: already locked and dual-admin, but no portal token in the subject.
    const legacy = liveGroup({
      id: '120363400000000006@g.us', label: 'Syngenta', portalToken: false, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const s = await fixtureStores();

    // Default: legacy naming is left alone.
    const noRename = fakeMaytapi({ groups: [legacy] });
    const repOff = await runProvision({ wa: client(noRename.transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep() });
    ok(!repOff.plannedOps.includes('config'), 'a legacy name is NOT renamed by default');
    ok(noRename.state.groups[0].name === legacy.name, 'the subject is untouched without --rename');

    // With --rename: one config op carries it, and the read-back checks the new subject.
    const withRename = fakeMaytapi({ groups: [legacy] });
    const repOn = await runProvision({ wa: client(withRename.transport), ...s, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep() });
    ok(repOn.plannedOps.join(',') === 'config', 'rename is the only op needed on an otherwise-complete legacy group');
    ok(repOn.results[0].verified === true, 'the rename read-back confirms the new subject');
    ok(withRename.state.groups[0].name === G.waGroupSubject('Syngenta', 'SP'), 'the group now carries the canonical subject');
    ok(G.portalOf(withRename.state.groups[0]) === 'SP' && G.parseGroupName(withRename.state.groups[0].name).portalExplicit, 'the portal token is now explicit');

    // A lock AND a rename ride ONE op - group/config is a full replace, and sender ops are scarce.
    const both = fakeMaytapi({ groups: [liveGroup({ id: '120363400000000007@g.us', label: 'Syngenta', portalToken: false, lock: false, admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] })] });
    const repBoth = await runProvision({ wa: client(both.transport), ...s, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep() });
    ok(repBoth.plannedOps.filter((o) => o === 'config').length === 1, 'a lock and a rename cost ONE sender op, not two');
    ok(both.state.groups[0].config.membersCanAddMembers === false && both.state.groups[0].name === G.waGroupSubject('Syngenta', 'SP'), 'both changes landed in that single op');
    ok(both.state.calls.filter((c) => c.url.endsWith('/group/config')).length === 1, 'only one group/config call was made');
  }

  // ================= provisioner: the duplicate-group warning =================
  {
    const existingParent = liveGroup({ id: '120363400000000003@g.us', label: 'Syngenta' });
    const { transport } = fakeMaytapi({ groups: [existingParent] });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', label: 'Syngenta North', apply: false });
    ok(rep.warnings.some((w) => /already serves this customer/.test(w)), 'an existing group for the same customer is WARNED before a second is created');
    ok(!rep.refused, 'the warning does not block a legitimate branch group');
  }

  // ================= provisioner: the Durian case (HTTP 500 on a write that landed) =================
  {
    const g = liveGroup({ id: '120363400000000004@g.us', label: 'Syngenta', portalToken: true, lock: true, admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] });
    const { transport, state } = fakeMaytapi({ groups: [g], hardErrorOn: { add: true } });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH], apply: true, sleep: spySleep() });
    ok(!rep.aborted, 'a hard API error on a write that actually landed does NOT abort - the read-back decides');
    ok(state.groups[0].participants.includes(`${SUYASHH}@c.us`), 'the member is in the group');
    ok(!!rep.registered, 'the run still completes and registers');
  }

  // ================= provisioner: batch cap =================
  {
    const { transport } = fakeMaytapi();
    const s = await fixtureStores({ roster: [FALLBACK, SUYASHH, SUSHANT] });
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH, SUSHANT], apply: true, maxOps: 2, sleep: spySleep() });
    ok(rep.capped && rep.opsApplied === 2, 'the run stops at the batch cap');
    ok(/Re-run the same command/.test(rep.abortReason), 'the cap message tells the operator to re-run');
    ok(rep.registered === null, 'a capped run registers NOTHING - group-only routing must not point at an incomplete group');
    ok(rep.warnings.some((w) => /registration SKIPPED/.test(w)), 'the skipped registration is stated');
  }

  // ================= provisioner: the sender drops mid-run =================
  {
    const { transport, state } = fakeMaytapi();
    const s = await fixtureStores();
    let seen = 0;
    const flaky = async (url, opts) => {
      if (url.endsWith('/listPhones')) {
        seen += 1;
        // Healthy for preflight + the first op's check, then logged out.
        if (seen > 2) return { ok: true, status: 200, json: async () => ({ success: true, data: [{ id: CREATOR_PHONE, number: null, status: 'qr-screen' }, { id: G.FALLBACK_PHONE_ID, number: FALLBACK, status: 'active' }] }) };
      }
      return transport(url, opts);
    };
    const rep = await runProvision({ wa: client(flaky), ...s, customerRef: 'syngenta', members: [SUYASHH], apply: true, sleep: spySleep() });
    ok(rep.aborted && /left 'active' mid-run/.test(rep.abortReason), 'a mid-run logout aborts before the next op');
    ok(rep.opsApplied === 1, 'only the op issued while the sender was healthy went out');
    ok(rep.registered === null, 'an aborted run registers nothing');
    ok(state.groups.length === 1, 'the group it did create is left for the re-run to adopt');
  }

  // ================= provisioner: a genuine failed write aborts =================
  {
    const g = liveGroup({ id: '120363400000000005@g.us', label: 'Syngenta', portalToken: true, lock: true, participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] });
    const { transport } = fakeMaytapi({ groups: [g], failOn: { promote: true } });
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep() });
    ok(rep.aborted && /read-back does not confirm/.test(rep.abortReason), 'an unconfirmed op aborts the run');
    ok(rep.registered === null, 'nothing is registered after an abort');
  }

  // ================= CLI + report =================
  {
    const a = parseArgs(['--customer=havells', '--label=Havells Alwar', '--portal=gc', '--members=919000000001,919000000002', '--branch-scope=Alwar Cable (1350)', '--max-ops=3', '--apply', '--rename']);
    ok(a.customer === 'havells' && a.label === 'Havells Alwar' && a.portal === 'GC', 'CLI parses customer, label and portal');
    ok(a.members.length === 2 && a.branchScope[0] === 'Alwar Cable (1350)' && a.maxOps === 3 && a.apply === true, 'CLI parses members, branch scope, cap and --apply');
    ok(a.rename === true && parseArgs([]).rename === false, 'rename is opt-in, OFF by default');
    ok(parseArgs([]).apply === false, 'apply is OFF by default');

    const { transport } = fakeMaytapi();
    const s = await fixtureStores();
    const rep = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta' });
    const out = formatReport(rep);
    ok(/DRY RUN \(no writes\)/.test(out), 'the report states dry-run mode');
    ok(/MANUAL, and deliberately NOT done here/.test(out), 'the report lists the manual follow-ups');
    ok(/DESCRIPTION/.test(out) && /ALLOWLIST/.test(out), 'the manual list names the description and the allowlist');
    ok(/^[\x20-\x7E\n]*$/.test(out), 'the whole rendered report is printable ASCII');

    const rejected = await runProvision({ wa: client(transport), ...s, customerRef: 'syngenta', portal: 'XX' });
    ok(rejected.refused && /unknown portal/.test(rejected.reason), 'an unknown portal is refused');
  }

  // ================= static strings are ASCII-only =================
  {
    const asciiOnly = (s) => /^[\x20-\x7E\n]*$/.test(s);
    ok(asciiOnly(remediationMissingCustomer('x')), 'missing-customer remediation is ASCII-only');
    ok(asciiOnly(remediationMissingRoster([SUYASHH])), 'missing-roster remediation is ASCII-only');
    ok(asciiOnly(manualFollowUps('BRL Bids - SP - Syngenta')), 'manual follow-ups are ASCII-only');
  }

  // ========= provisioner: re-registering an EXISTING group must not delete its scope =========
  // personStore.upsert REPLACES, and the registration body omits originScope entirely while
  // defaulting branchScope to [] and accountId to 'primary'. So renaming an already-registered
  // group silently deleted routing state: Havells Alwar's branch limit (an empty scope matches
  // EVERY load, so the branch desk would start receiving the whole customer), the three Waaree
  // plant desks' originScope, and the accountId of the 14 legacy groups not on 'primary'.
  {
    const legacy = liveGroup({
      id: '120363400000000031@g.us', label: 'Syngenta', portalToken: false, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const pid = `g${legacy.id.replace(/\D/g, '')}`;
    const prior = {
      personId: pid,
      name: `${G.GROUP_NAME_PREFIX} ${G.MIDDOT} Syngenta`,
      phone: legacy.id,
      accountId: 'master',
      alertPrefs: ['price_needed', 'won'],
      alertAll: false,
      originScope: ['chikhli', 'navsari'],
      branchScope: ['Alwar Cable (1350)', 'Alwar Wire (1351)'],
      // A desk an operator deliberately parked via the console's Active/Disabled switch, and a
      // field provision-group.js has never once referenced (it is Team-page-only) - the two shapes
      // the review named as omitted from the old hand-enumerated body.
      enabled: false,
      email: 'ops@havells.example',
    };
    const s = await fixtureStores({ people: [prior], assignments: [{ personId: pid, customerId: 'syngenta' }] });

    // Seeded by a raw store write, not personStore.upsert(), because upsert (correctly) only ever
    // writes fields its own schema declares. This proves the fix preserves a field NEITHER this
    // script NOR personStore's schema was ever taught about - not just the current 9-field list.
    await s.store.putDoc('people', pid, Object.assign({}, await s.personStore.get(pid), { futureFlag: 'kept-me' }));

    const wa1 = fakeMaytapi({ groups: [legacy] });
    const rep = await runProvision({
      wa: client(wa1.transport), ...s, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep(),
    });
    ok(!rep.aborted, 'the rename completes on an already-registered group');
    ok(wa1.state.groups[0].name === G.waGroupSubject('Syngenta', 'SP'), 'the subject was renamed');

    const after = await s.personStore.get(pid);
    ok(after.name === G.canonicalGroupName('Syngenta'), 'the stored name follows the rename - that IS the point of the run');
    ok(JSON.stringify(after.originScope) === JSON.stringify(['chikhli', 'navsari']),
      `originScope survives a rename (got ${JSON.stringify(after.originScope)})`);
    ok(JSON.stringify(after.branchScope) === JSON.stringify(['Alwar Cable (1350)', 'Alwar Wire (1351)']),
      `branchScope survives a rename (got ${JSON.stringify(after.branchScope)})`);
    ok(after.accountId === 'master', `accountId survives a rename (got ${after.accountId})`);
    ok(JSON.stringify(after.alertPrefs) === JSON.stringify(['price_needed', 'won']),
      `alertPrefs survive a rename (got ${JSON.stringify(after.alertPrefs)})`);
    ok(after.enabled === false, `a disabled desk stays disabled across a rename (got ${after.enabled})`);
    ok(after.email === 'ops@havells.example', `email survives a rename (got ${after.email})`);
    ok(after.futureFlag === 'kept-me', 'a field this schema never declared survives a rename too');

    // An EXPLICIT flag still wins - preserving must not make the record unwritable.
    const wa2 = fakeMaytapi({ groups: [liveGroup({ id: legacy.id, label: 'Syngenta', portalToken: false, lock: true, admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] })] });
    await runProvision({
      wa: client(wa2.transport), ...s, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep(),
      label: 'Syngenta', accountId: 'primary', branchScope: ['Neemrana (1420)'],
    });
    const after2 = await s.personStore.get(pid);
    ok(after2.accountId === 'primary', 'an explicit --account overrides the stored value');
    ok(JSON.stringify(after2.branchScope) === JSON.stringify(['Neemrana (1420)']), 'an explicit --branch-scope overrides the stored value');
    ok(JSON.stringify(after2.originScope) === JSON.stringify(['chikhli', 'navsari']), 'originScope has no flag and is always preserved');

    // A genuinely NEW group still gets the documented defaults.
    const fresh = liveGroup({
      id: '120363400000000032@g.us', label: 'Syngenta', portalToken: false, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const s2 = await fixtureStores();
    const wa3 = fakeMaytapi({ groups: [fresh] });
    const rep3 = await runProvision({ wa: client(wa3.transport), ...s2, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep() });
    const newRec = await s2.personStore.get(rep3.registered.personId);
    ok(newRec.accountId === 'primary', 'an unregistered group still defaults to the primary account');
    ok(newRec.alertPrefs === 'all' && newRec.alertAll === false, 'an unregistered group still takes the documented alert defaults');
    ok(JSON.stringify(newRec.branchScope) === '[]', 'an unregistered group still defaults to an empty branchScope');
    // PersonStore normalizes an absent originScope to [] rather than leaving it off, which is
    // precisely why the old body wiped rather than merely omitted.
    ok(JSON.stringify(newRec.originScope) === '[]', 'an unregistered group gets an empty originScope, not an invented one');
  }

  // ========= provisioner: a rename must not touch the assignment's margin override, lanes, alertKinds or enabled =========
  // assignmentStore.upsert sat one line below the personStore fix, still replacing wholesale:
  // lanes/marginOverride/alertKinds reset to null and enabled reset to true whenever the caller
  // (this script always) omits them. The margin override is the money-path half of the defect -
  // resolve.js reads it ahead of the customer's own band - and a disabled assignment re-enabling
  // silently is the exact live risk called out for the 12 currently-paused desk pairings.
  {
    const legacy = liveGroup({
      id: '120363400000000041@g.us', label: 'Syngenta', portalToken: false, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const pid = `g${legacy.id.replace(/\D/g, '')}`;
    const s = await fixtureStores({
      people: [{ personId: pid, name: `${G.GROUP_NAME_PREFIX} ${G.MIDDOT} Syngenta`, phone: legacy.id }],
      assignments: [{
        personId: pid, customerId: 'syngenta',
        marginOverride: { marginsPct: [9, 7, 5], minMarginPct: 5 },
        lanes: ['Mumbai-Pune'],
        alertKinds: ['price_needed', 'won'],
        enabled: false,
      }],
    });

    const wa1 = fakeMaytapi({ groups: [legacy] });
    const rep = await runProvision({
      wa: client(wa1.transport), ...s, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep(),
    });
    ok(!rep.aborted, 'the rename completes on an already-assigned, deliberately-disabled pairing');

    const asg = await s.assignmentStore.get(`${pid}::syngenta`);
    ok(asg.enabled === false, `a disabled assignment stays disabled across a rename (got ${asg.enabled})`);
    ok(JSON.stringify(asg.marginOverride) === JSON.stringify({ marginsPct: [9, 7, 5], minMarginPct: 5 }),
      `the margin override survives a rename (got ${JSON.stringify(asg.marginOverride)})`);
    ok(JSON.stringify(asg.lanes) === JSON.stringify(['Mumbai-Pune']), `lanes survive a rename (got ${JSON.stringify(asg.lanes)})`);
    ok(JSON.stringify(asg.alertKinds) === JSON.stringify(['price_needed', 'won']), `alertKinds survive a rename (got ${JSON.stringify(asg.alertKinds)})`);

    // Preserving must not make the record unwritable - an explicit input still wins either direction.
    const reenabled = await s.assignmentStore.upsert({ personId: pid, customerId: 'syngenta', enabled: true });
    ok(reenabled.enabled === true, 'an explicit enabled:true still writes through');
  }

  // ========= provisioner: an already-complete, already-registered group can still be scope-repaired =========
  // The "nothing to do" refusal fired on ANY apply run with an empty op plan and alreadyRegistered,
  // so the script's own documented repair command (re-run with a corrected --branch-scope) could
  // never reach the write that would fix a group already wiped by the pre-fix bug.
  {
    const g = liveGroup({
      id: '120363400000000042@g.us', label: 'Syngenta', portalToken: true, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const pid = `g${g.id.replace(/\D/g, '')}`;
    const s = await fixtureStores({
      people: [{ personId: pid, name: G.canonicalGroupName('Syngenta'), phone: g.id, branchScope: ['Alwar Cable (1350)'] }],
      assignments: [{ personId: pid, customerId: 'syngenta' }],
    });

    const { transport, state } = fakeMaytapi({ groups: [g] });
    const rep = await runProvision({
      wa: client(transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep(),
      label: 'Syngenta', branchScope: ['Neemrana (1420)'],
    });
    ok(!rep.refused, 'a corrected --branch-scope on an already-complete, already-registered group is NOT refused as "nothing to do"');
    ok(rep.plannedOps.length === 0, 'the repair costs zero sender ops');
    ok(!state.calls.some((c) => c.method === 'POST'), 'no group mutation was issued for a scope-only repair');
    ok(!!rep.registered, 'the repair registers the corrected scope');

    const after = await s.personStore.get(pid);
    ok(JSON.stringify(after.branchScope) === JSON.stringify(['Neemrana (1420)']),
      `the corrected branchScope was actually written (got ${JSON.stringify(after.branchScope)})`);

    // A re-run carrying the SAME (now-current) scope has genuinely nothing to do.
    const repNoop = await runProvision({
      wa: client(fakeMaytapi({ groups: [g] }).transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep(),
      branchScope: ['Neemrana (1420)'],
    });
    ok(repNoop.refused, 'a re-run with the scope already matching the stored record is still refused as nothing to do');
  }

  // ========= provisioner: --origin-scope closes the latent trap (no CLI workaround existed before) =========
  {
    ok(parseArgs(['--customer=waaree', '--origin-scope=Chikhli,Navsari', '--apply']).originScope.join(',') === 'Chikhli,Navsari',
      'CLI parses --origin-scope');

    const fresh = liveGroup({
      id: '120363400000000043@g.us', label: 'Syngenta', portalToken: false, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const s = await fixtureStores();
    const { transport } = fakeMaytapi({ groups: [fresh] });
    const rep = await runProvision({
      wa: client(transport), ...s, customerRef: 'syngenta', rename: true, apply: true, sleep: spySleep(),
      originScope: ['Chikhli'],
    });
    const rec = await s.personStore.get(rep.registered.personId);
    ok(JSON.stringify(rec.originScope) === JSON.stringify(['Chikhli']),
      'an explicit --origin-scope is written on registration - the pre-fix script had no such flag at all');
  }

  // ========= provisioner: a scope repair must name its target group =========
  // Without --label the target falls back to the customer's MAIN group, so a branch scope meant for
  // "Havells Alwar" would narrow the main Havells desk to one branch, exit 0.
  {
    const havellsCustomers = [{ label: 'Havells' }];
    const complete = { admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`] };
    const main = liveGroup({ id: '120363400000000051@g.us', label: 'Havells', portalToken: true, lock: true, ...complete });
    const alwar = liveGroup({ id: '120363400000000052@g.us', label: 'Havells Alwar', portalToken: true, lock: true, ...complete });
    const mainPid = `g${main.id.replace(/\D/g, '')}`;
    const alwarPid = `g${alwar.id.replace(/\D/g, '')}`;
    const seed = () => fixtureStores({
      customers: havellsCustomers,
      people: [
        { personId: mainPid, name: G.canonicalGroupName('Havells'), phone: main.id, branchScope: [] },
        { personId: alwarPid, name: G.canonicalGroupName('Havells Alwar'), phone: alwar.id, branchScope: ['Alwar Cable (1350)', 'Alwar Wire (1351)'] },
      ],
      assignments: [{ personId: mainPid, customerId: 'havells' }, { personId: alwarPid, customerId: 'havells' }],
    });

    const s = await seed();
    const rep = await runProvision({
      wa: client(fakeMaytapi({ groups: [main, alwar] }).transport), ...s, customerRef: 'havells', apply: true, sleep: spySleep(),
      branchScope: ['Alwar Cable (1350)'],
    });
    ok(rep.refused, 'a narrowing repair with no --label against a customer with a branch sibling is refused');
    ok(/--label/.test(rep.reason || ''), `the refusal tells the operator to pass --label (got ${rep.reason})`);
    ok(JSON.stringify((await s.personStore.get(mainPid)).branchScope) === '[]', 'the main Havells desk keeps its empty (every-branch) scope');

    const s2 = await seed();
    const rep2 = await runProvision({
      wa: client(fakeMaytapi({ groups: [main, alwar] }).transport), ...s2, customerRef: 'havells', apply: true, sleep: spySleep(),
      label: 'Havells Alwar', branchScope: ['Alwar Cable (1350)'],
    });
    ok(!rep2.refused && !!rep2.registered, 'the same repair with --label naming the branch group goes through');
    ok(JSON.stringify((await s2.personStore.get(alwarPid)).branchScope) === JSON.stringify(['Alwar Cable (1350)']), 'the labelled repair writes the branch group');
    ok(JSON.stringify((await s2.personStore.get(mainPid)).branchScope) === '[]', 'the labelled repair leaves the main group alone');

    // A label-less account fix still needs --label once the customer has a second group.
    const s3 = await seed();
    const rep3 = await runProvision({
      wa: client(fakeMaytapi({ groups: [main, alwar] }).transport), ...s3, customerRef: 'havells', apply: false,
      accountId: 'primary-2',
    });
    ok(rep3.refused && /--label/.test(rep3.reason || ''), 'a label-less repair on a customer with a sibling group is refused even when nothing narrows');

    // A stored person with no assignment is not "registered", but registration would still overwrite it.
    const s3b = await seed();
    await s3b.assignmentStore.remove(`${mainPid}::havells`);
    const rep3b = await runProvision({
      wa: client(fakeMaytapi({ groups: [main, alwar] }).transport), ...s3b, customerRef: 'havells', apply: true, sleep: spySleep(),
      branchScope: ['Alwar Cable (1350)'],
    });
    ok(rep3b.refused && /--label/.test(rep3b.reason || ''), 'a label-less narrowing is refused when the person record exists but its assignment does not');
    ok(JSON.stringify((await s3b.personStore.get(mainPid)).branchScope) === '[]', 'that refused run left the main record untouched');

    // Narrowing a lone group also needs --label: an empty scope matches every load.
    const lone = liveGroup({ id: '120363400000000053@g.us', label: 'Syngenta', portalToken: true, lock: true, ...complete });
    const lonePid = `g${lone.id.replace(/\D/g, '')}`;
    const s4 = await fixtureStores({
      people: [{ personId: lonePid, name: G.canonicalGroupName('Syngenta'), phone: lone.id, branchScope: [], accountId: 'primary' }],
      assignments: [{ personId: lonePid, customerId: 'syngenta' }],
    });
    const rep4 = await runProvision({
      wa: client(fakeMaytapi({ groups: [lone] }).transport), ...s4, customerRef: 'syngenta', apply: true, sleep: spySleep(),
      branchScope: ['Neemrana (1420)'],
    });
    ok(rep4.refused && /--label/.test(rep4.reason || ''), 'narrowing an empty scope with no --label is refused even with no sibling group');
    ok(JSON.stringify((await s4.personStore.get(lonePid)).branchScope) === '[]', 'the refused narrowing wrote nothing');

    // The dry run shows the stored value next to the value about to replace it.
    const rep5 = await runProvision({
      wa: client(fakeMaytapi({ groups: [lone] }).transport), ...s4, customerRef: 'syngenta', apply: false,
      label: 'Syngenta', branchScope: ['Neemrana (1420)'], accountId: 'master',
    });
    const text5 = formatReport(rep5);
    ok(!rep5.refused, 'a labelled narrowing dry run is not refused');
    ok(/accountId\s*:\s*primary -> master/.test(text5), `the dry run prints the stored and new accountId (got:\n${text5})`);
    ok(text5.includes('branchScope: [] -> ["Neemrana (1420)"]'), 'the dry run prints the stored and new branchScope');

    // First registration counts too: a main group with no person record yet (a capped or aborted
    // first run) must not be registered to a sibling's scope just because --label was left off.
    const seedUnregistered = () => fixtureStores({
      customers: havellsCustomers,
      people: [{ personId: alwarPid, name: G.canonicalGroupName('Havells Alwar'), phone: alwar.id, branchScope: ['Alwar Cable (1350)', 'Alwar Wire (1351)'] }],
      assignments: [{ personId: alwarPid, customerId: 'havells' }],
    });
    const s6 = await seedUnregistered();
    const wa6 = fakeMaytapi({ groups: [main, alwar] });
    const rep6 = await runProvision({
      wa: client(wa6.transport), ...s6, customerRef: 'havells', apply: true, sleep: spySleep(),
      branchScope: ['Alwar Cable (1350)'],
    });
    ok(rep6.refused && /--label/.test(rep6.reason || ''), `first registration of an unrecorded main group with a scope and no --label is refused when a sibling exists (got ${rep6.reason})`);
    ok(!wa6.state.calls.some((c) => c.method === 'POST'), 'that refusal made zero sender ops');
    ok(!(await s6.personStore.get(mainPid)), 'that refusal wrote no person record for the main group');
    ok(!(await s6.assignmentStore.get(`${mainPid}::havells`)), 'that refusal wrote no assignment for the main group');
    ok(formatReport(rep6).includes('branchScope: [] -> ["Alwar Cable (1350)"]'), `the refusal prints an empty stored value (got:\n${formatReport(rep6)})`);
    const rep6b = await runProvision({
      wa: client(fakeMaytapi({ groups: [main, alwar] }).transport), ...(await seedUnregistered()), customerRef: 'havells', apply: false,
      accountId: 'primary-2',
    });
    ok(rep6b.refused && /accountId\s*:\s*\(none\) -> primary-2/.test(formatReport(rep6b)), `a first-registration --account with no --label is refused and shows no stored account (got:\n${formatReport(rep6b)})`);

    const s7 = await seedUnregistered();
    const rep7 = await runProvision({
      wa: client(fakeMaytapi({ groups: [main, alwar] }).transport), ...s7, customerRef: 'havells', apply: true, sleep: spySleep(),
      label: 'Havells', branchScope: ['Alwar Cable (1350)'],
    });
    ok(!rep7.refused && !!rep7.registered, 'the same first registration with --label naming the group goes through');

    // No main group at all yet: the refusal must still read cleanly, with nothing created.
    const s8 = await seedUnregistered();
    const wa8 = fakeMaytapi({ groups: [alwar] });
    const rep8 = await runProvision({
      wa: client(wa8.transport), ...s8, customerRef: 'havells', apply: true, sleep: spySleep(),
      branchScope: ['Alwar Cable (1350)'],
    });
    ok(rep8.refused && /--label/.test(rep8.reason || '') && !/undefined|null/.test(rep8.reason || ''), `creating the main group with a scope and no --label is refused with a clean reason (got ${rep8.reason})`);
    ok(!wa8.state.calls.some((c) => c.method === 'POST'), 'that refusal created nothing');
  }

  // ========= provisioner: --account is checked against the known accounts, and --account= means not given =========
  {
    const g = liveGroup({
      id: '120363400000000054@g.us', label: 'Syngenta', portalToken: true, lock: true,
      admins: [`${BOT}@c.us`, `${FALLBACK}@c.us`], participants: [`${BOT}@c.us`, `${FALLBACK}@c.us`],
    });
    const pid = `g${g.id.replace(/\D/g, '')}`;
    const s = await fixtureStores({
      people: [{ personId: pid, name: G.canonicalGroupName('Syngenta'), phone: g.id, accountId: 'primary' }],
      assignments: [{ personId: pid, customerId: 'syngenta' }],
    });
    s.personStore = new PersonStore({ store: s.store, accountsProvider: async () => [{ accountId: 'master' }] });

    const dry = await runProvision({ wa: client(fakeMaytapi({ groups: [g] }).transport), ...s, customerRef: 'syngenta', apply: false, accountId: 'mastr' });
    ok(dry.refused && /mastr/.test(dry.reason || ''), `a typo'd --account is refused in the dry run (got ${dry.reason})`);
    const live = await runProvision({ wa: client(fakeMaytapi({ groups: [g] }).transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep(), accountId: 'mastr' });
    ok(live.refused, "a typo'd --account is refused on --apply");
    ok((await s.personStore.get(pid)).accountId === 'primary', "the typo'd account was never written");

    const good = await runProvision({ wa: client(fakeMaytapi({ groups: [g] }).transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep(), accountId: 'master' });
    ok(!good.refused && (await s.personStore.get(pid)).accountId === 'master', 'a known --account still repairs the record');

    ok(parseArgs(['--customer=x', '--account=']).accountId === null, 'an empty --account= parses as not given');
    const blank = await runProvision({ wa: client(fakeMaytapi({ groups: [g] }).transport), ...s, customerRef: 'syngenta', apply: true, sleep: spySleep(), accountId: '' });
    ok(blank.refused && !blank.scopeRepair, 'an empty account is not reported as a repair');
  }

  // The runner grades by exit status only, so a file that returns early is a silent green. Assert the
  // suite actually ran to completion.
  ok(pass > 70, `the whole suite ran (${pass} assertions)`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
