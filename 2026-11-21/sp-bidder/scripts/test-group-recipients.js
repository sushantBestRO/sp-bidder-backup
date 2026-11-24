'use strict';
/**
 * Per-customer WhatsApp GROUPS as alert recipients, end to end and offline.
 *
 * A group is modelled as a Person whose `phone` is a group JID ('<digits>@g.us'), assigned to
 * one customer. Nothing else in the model changes - so what has to be proven is that the group
 * survives EVERY layer that was written assuming a 10-digit mobile:
 *
 *   normalizeRecipient -> PersonStore.validatePerson -> toRecipientRows -> Notifier -> WhatsAppClient
 *
 * The hazard throughout is silent misdelivery, not a crash: a group JID that gets digit-stripped
 * anywhere along that chain becomes a well-formed phone number, and the alert is delivered to a
 * stranger. Several assertions below exist only to prove a JID was NOT quietly turned into digits.
 *
 * Also pinned: normalizePhoneIN stays STRICT. An SP account's contact person cannot be a group
 * chat, so that path must keep rejecting a JID even though the recipient path now accepts one.
 */

const assert = require('assert');
const { normalizePhoneIN, normalizeRecipient, isGroupJid, recipientId } = require('../src/model/normalizePhone');
const { validatePerson } = require('../src/model/personStore');
const { toRecipientRows } = require('../src/model/project');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

const SYNGENTA_GROUP = '120363428871199271@g.us';   // the real group ids created 2026-07-14
const DURIAN_GROUP = '120363411426913433@g.us';

(async () => {
  // ---- the canonical rule: a recipient is a mobile OR a group; nothing else ----
  ok(normalizeRecipient(SYNGENTA_GROUP) === SYNGENTA_GROUP, 'normalizeRecipient passes a group JID through verbatim');
  ok(normalizeRecipient('  ' + SYNGENTA_GROUP.toUpperCase() + ' ') === SYNGENTA_GROUP, 'normalizeRecipient trims + lowercases a pasted JID');
  ok(normalizeRecipient('+91 93562 52711') === '+919356252711', 'normalizeRecipient still normalizes a mobile exactly as before');
  ok(normalizeRecipient(SYNGENTA_GROUP) !== '120363428871199271', 'REGRESSION: a group JID is never reduced to bare digits (that would deliver to a stranger)');
  assert.throws(() => normalizeRecipient('12345@g.us.evil'), /group id/, 'a near-miss group id is rejected loudly');
  assert.throws(() => normalizeRecipient('919356252711@s.whatsapp.net'), /group id/, 'an INDIVIDUAL jid is rejected (it is not a group, and must not be digit-stripped into a number)');
  assert.throws(() => normalizeRecipient('nonsense'), /mobile/, 'garbage is still rejected');
  ok(true, 'normalizeRecipient rejects near-miss JIDs, individual JIDs and garbage');

  // ---- normalizePhoneIN stays strict: an ACCOUNT CONTACT can never be a group chat ----
  assert.throws(() => normalizePhoneIN(SYNGENTA_GROUP), /mobile/, 'normalizePhoneIN rejects a group JID');
  ok(true, 'normalizePhoneIN stays mobile-only (the account-contact path cannot be pointed at a group)');
  ok(normalizePhoneIN('+919356252711') === '+919356252711', 'normalizePhoneIN is otherwise unchanged');

  // ---- ids: groups and people cannot collide ----
  ok(recipientId(SYNGENTA_GROUP) === 'g120363428871199271', 'a group gets a g-prefixed id');
  ok(recipientId('+919356252711') === 'p919356252711', 'a person keeps their p-prefixed id');
  ok(isGroupJid(SYNGENTA_GROUP) && !isGroupJid('+919356252711'), 'isGroupJid distinguishes the two');

  // ---- PersonStore: a group validates as a recipient, and keeps its JID ----
  {
    const g = validatePerson({ name: 'BRL Bids - Syngenta', phone: SYNGENTA_GROUP, accountId: 'primary', alertPrefs: 'all' });
    ok(g.phone === SYNGENTA_GROUP, 'validatePerson stores the group JID intact as the phone');
    ok(g.personId === 'g120363428871199271', 'validatePerson derives a g-prefixed personId for a group');
    const p = validatePerson({ name: 'Sid', phone: '+91 93562 52711', accountId: 'primary', alertPrefs: 'all' });
    ok(p.phone === '+919356252711' && p.personId === 'p919356252711', 'validatePerson is unchanged for a real person');
    assert.throws(() => validatePerson({ name: 'Bad', phone: '12345' }), /mobile/, 'validatePerson still rejects a bad number');
    ok(true, 'validatePerson still rejects an invalid recipient');
  }

  // ---- toRecipientRows: the group becomes a normal recipient row, scoped to its customer ----
  const customers = [
    { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'] },
    { customerId: 'durian', label: 'Durian', aliases: ['Durian'] },
  ];
  const people = [
    { personId: 'g120363428871199271', name: 'BRL Bids - Syngenta', phone: SYNGENTA_GROUP, alertPrefs: 'all', enabled: true },
    { personId: 'g120363411426913433', name: 'BRL Bids - Durian', phone: DURIAN_GROUP, alertPrefs: 'all', enabled: true },
  ];
  const assignments = [
    { assignmentId: 'a1', personId: 'g120363428871199271', customerId: 'syngenta', enabled: true },
    { assignmentId: 'a2', personId: 'g120363411426913433', customerId: 'durian', enabled: true },
  ];
  {
    const rows = toRecipientRows(customers, people, assignments);
    const syn = rows.find((r) => r.phone === SYNGENTA_GROUP);
    ok(!!syn, 'toRecipientRows emits a row for the group');
    ok(syn.phone === SYNGENTA_GROUP, 'the row carries the JID, not digits');
    ok(syn.scope.shippers.includes('Syngenta') && !syn.scope.shippers.includes('Durian'),
      "the group's assignment scopes it to ITS customer only");
    ok(syn.alerts.length > 0, 'the group inherits its alert kinds');
  }

  // ---- Notifier end-to-end: the right group gets the alert, the wrong one gets nothing ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });

    await n.requestPrice({ id: 'rq1', loadId: 'L1', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: 1751000000000 } });
    ok(tr.calls.length === 1, 'a Syngenta load alerts exactly ONE recipient (its group)');
    ok(tr.calls[0].body.to_number === SYNGENTA_GROUP, 'the alert goes to the Syngenta group JID, intact');
    ok(tr.calls[0].body.to_number !== '120363428871199271', 'REGRESSION: the notifier never sends a digit-stripped group id');
    ok(/Syngenta/.test(tr.calls[0].body.message), 'the group message carries the load detail');

    const before = tr.calls.length;
    await n.requestPrice({ id: 'rq2', loadId: 'L2', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Durian', closesAt: 1751000000000 } });
    ok(tr.calls.length - before === 1, 'a Durian load alerts exactly one recipient');
    ok(tr.calls[tr.calls.length - 1].body.to_number === DURIAN_GROUP, 'the Durian load goes to the DURIAN group, never the Syngenta one (no cross-customer leak)');

    // an unassigned customer's load reaches neither group - the whole point of per-customer groups
    const before2 = tr.calls.length;
    await n.requestPrice({ id: 'rq3', loadId: 'L3', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Havells', closesAt: 1751000000000 } });
    ok(tr.calls.length - before2 === 0, 'a load for an UNASSIGNED customer reaches no group at all (no spam)');
  }

  // ---- REGRESSION (review r1, security/logic/gaps): the country-code truncation bug ----
  // normalizePhoneIN used to do .replace(/^\+91/,'') - literal '+' REQUIRED - then .slice(0, 10).
  // So a plain '919356252711' (no plus: the exact shape Maytapi uses, and what you get pasting a
  // WhatsApp contact) kept its '91', lost its last two digits, and returned '+919193562527' - a
  // different, valid, dialable number. The price-capture link would go to a stranger, with a 200
  // and a success:true. These pin the recognise-and-remove rule that replaced it.
  {
    ok(normalizePhoneIN('919356252711') === '+919356252711', 'a country-coded number WITHOUT a plus keeps its real digits (was +919193562527 - a stranger)');
    ok(normalizePhoneIN('+919356252711') === '+919356252711', 'the plus-prefixed form is unchanged');
    ok(normalizePhoneIN('9356252711') === '+919356252711', 'a bare 10-digit number is unchanged');
    ok(normalizePhoneIN('+91 93562 52711') === '+919356252711', 'spaces and punctuation are still tolerated');
    ok(normalizePhoneIN('00919356252711') === '+919356252711', 'the 0091 dial-out prefix is recognised');
    ok(normalizeRecipient('919594963428') === '+919594963428', "the same fix applies through normalizeRecipient (Sameer's number, as pasted)");
    // an 11-digit near-miss must be REJECTED, never truncated into a plausible number
    assert.throws(() => normalizePhoneIN('91935625271'), /mobile/, 'an 11-digit number is rejected, not silently truncated into a valid one');
    ok(true, 'a malformed number is rejected rather than truncated into someone else\'s');
  }

  // ---- REGRESSION (review r1): an UNASSIGNED group must be sent nothing, not everything ----
  // project.js computed `restricted = !alertAll && mine.length > 0`, so a group with zero
  // assignments was NOT restricted -> empty shipper scope -> matched EVERY load. Disabling a
  // group's only assignment (the natural "stop sending here") would have widened it from one
  // customer to all of them, spraying every shipper's pricing into that one group.
  {
    const orphan = [{ personId: 'g120363428871199271', name: 'BRL Bids - Syngenta', phone: SYNGENTA_GROUP, alertPrefs: 'all', enabled: true }];
    const rows = toRecipientRows(customers, orphan, []); // no assignments at all
    ok(rows.length === 0, 'a group with NO assignment produces no recipient row at all (fails closed)');

    const disabled = toRecipientRows(customers, orphan, [{ assignmentId: 'a1', personId: 'g120363428871199271', customerId: 'syngenta', enabled: false }]);
    ok(disabled.length === 0, 'disabling a group\'s only assignment silences it - it does NOT widen it to every customer');

    // a human central desk keeps the legacy "no assignment = every load" semantic
    const human = [{ personId: 'p919356252711', name: 'Sid', phone: '+919356252711', alertPrefs: 'all', enabled: true }];
    const humanRows = toRecipientRows(customers, human, []);
    ok(humanRows.length === 1 && humanRows[0].scope.shippers.length === 0, 'an unassigned PERSON still means "every load" (legacy central-desk semantic preserved)');

    // ...and a group can still be opted in to every load, but only EXPLICITLY
    const allLoads = [{ personId: 'g120363428871199271', name: 'All loads group', phone: SYNGENTA_GROUP, alertPrefs: 'all', alertAll: true, enabled: true }];
    ok(toRecipientRows(customers, allLoads, []).length === 1, 'a group CAN see every load, but only via an explicit alertAll opt-in');
  }

  // ---- S1008: an assignment whose customer record is gone is no assignment ----
  // The enabled assignment kept the group "restricted", but the missing customer contributed no
  // aliases, so the row carried an empty shipper scope - which scopeMatches reads as every load.
  {
    const group = [{ personId: 'g120363428871199271', name: 'BRL Bids - Adama', phone: SYNGENTA_GROUP, alertPrefs: 'all', enabled: true }];
    const orphanOnly = toRecipientRows(customers, group, [{ assignmentId: 'a1', personId: 'g120363428871199271', customerId: 'adama', enabled: true }]);
    ok(orphanOnly.length === 0, 'a group whose only enabled assignment points at a missing customer is sent nothing');

    const mixed = toRecipientRows(customers, group, [
      { assignmentId: 'a1', personId: 'g120363428871199271', customerId: 'adama', enabled: true, alertKinds: ['won', 'lost', 'price_needed', 'bid_live', 'outbid', 'error'] },
      { assignmentId: 'a2', personId: 'g120363428871199271', customerId: 'syngenta', enabled: true, alertKinds: ['price_needed'] },
    ]);
    ok(mixed.length === 1 && JSON.stringify(mixed[0].scope.shippers) === '["Syngenta"]', 'a group with one live and one orphaned assignment is scoped to the live customer only');
    ok(mixed.length === 1 && JSON.stringify(mixed[0].alerts) === '["price_needed"]', 'an orphaned assignment contributes no alert kinds either');

    const human = [{ personId: 'p919356252711', name: 'Sid', phone: '+919356252711', alertPrefs: 'all', enabled: true }];
    const humanRows = toRecipientRows(customers, human, [{ assignmentId: 'a3', personId: 'p919356252711', customerId: 'adama', enabled: true }]);
    ok(humanRows.length === 1 && humanRows[0].scope.shippers.length === 0, 'a PERSON whose only assignment is orphaned keeps the legacy every-load semantic');
  }

  // ---- GROUP-ROUTING: a grouped customer sends to the GROUP ONLY, never the individuals ----
  // The point of per-customer groups: kill the DM blast. When a load's customer has a group among
  // the matched recipients, the group is the sole channel and every individual DM is suppressed -
  // including "every load" (alertAll) people who would otherwise match every customer. This is
  // what makes "turn off DMs for grouped customers" true without editing anyone's alertAll.
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    // an every-load person (alertAll) + a scoped person, alongside the Syngenta group
    const withPeople = people.concat([
      { personId: 'p919356252711', name: 'Sid (every load)', phone: '+919356252711', alertPrefs: 'all', alertAll: true, enabled: true },
      { personId: 'p919090707777', name: 'Pavan (scoped)', phone: '+919090707777', alertPrefs: 'all', enabled: true },
    ]);
    const asg = assignments.concat([{ assignmentId: 'a3', personId: 'p919090707777', customerId: 'syngenta', enabled: true }]);
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, withPeople, asg),
    });
    await n.requestPrice({ id: 'rq4', loadId: 'L4', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number);
    ok(targets.length === 1 && targets[0] === SYNGENTA_GROUP,
      'a GROUPED customer (Syngenta) sends to the group ONLY - the every-load person AND the scoped person are both suppressed');
    ok(!targets.includes('919356252711') && !targets.includes('919090707777'),
      'no individual DM goes out for a grouped customer, not even an alertAll every-load person');
  }

  // ---- a NON-grouped customer is untouched: its individuals still get DMs ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    // Havells has no group; an every-load person should still be DMed for it
    const custs = customers.concat([{ customerId: 'havells', label: 'Havells', aliases: ['Havells'] }]);
    const withPeople = people.concat([{ personId: 'p919356252711', name: 'Sid (every load)', phone: '+919356252711', alertPrefs: 'all', alertAll: true, enabled: true }]);
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(custs, withPeople, assignments),
    });
    await n.requestPrice({ id: 'rq5', loadId: 'L5', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Havells', closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number);
    ok(targets.length === 1 && targets[0] === '919356252711',
      'a NON-grouped customer (Havells) still DMs its every-load individual - group-routing does not blackout ungrouped customers');
    ok(!targets.some((t) => /@g\.us/.test(t)), 'no group is dragged into an ungrouped customer');
  }

  // ---- an EVERY-LOAD group (empty scope) is NOT a global mute -------------------------------
  // Only a SCOPED group is a customer's channel. An alertAll group matches every load (empty
  // scope), but must NOT suppress every customer's individual DMs - it is just an extra recipient.
  // Regression for the r1 logic/gaps finding that the suppression claim was false for such a group.
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const allLoadsGroup = '120363999999999999@g.us';
    const ppl = [
      { personId: recipientId(allLoadsGroup), name: 'All-loads group', phone: allLoadsGroup, alertPrefs: 'all', alertAll: true, enabled: true },
      { personId: 'p919356252711', name: 'Sid', phone: '+919356252711', alertPrefs: 'all', alertAll: true, enabled: true },
    ];
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, ppl, []),
    });
    await n.requestPrice({ id: 'rq6', loadId: 'L6', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Havells', closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number).sort();
    ok(targets.length === 2 && targets.includes(allLoadsGroup) && targets.includes('919356252711'),
      'an every-load group does NOT suppress individuals - it and the DM person both get the alert (no global mute)');
  }

  // ---- FALLBACK: if the group send FAILS, the individuals get the alert (no silent blackout) --
  // group-only routing removes the DM backstop, so a group that reaches nobody (bot removed /
  // group deleted -> send fails) must NOT swallow the alert. When every group send fails we fall
  // through to the individual DMs. Regression for the r1 gaps blackout finding.
  {
    // a transport that FAILS any send to a group JID, succeeds for individuals
    const calls = [];
    const tr = async (url, opts) => {
      const body = JSON.parse(opts.body); calls.push(body);
      if (/@g\.us/.test(body.to_number)) return { ok: true, status: 200, json: async () => ({ success: false, message: 'not a participant' }) };
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid' } }) };
    };
    tr.calls = calls;
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const ppl = people.concat([{ personId: 'p919090707777', name: 'Pavan', phone: '+919090707777', alertPrefs: 'all', enabled: true }]);
    const asg = assignments.concat([{ assignmentId: 'a9', personId: 'p919090707777', customerId: 'syngenta', enabled: true }]);
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, ppl, asg),
    });
    await n.requestPrice({ id: 'rq7', loadId: 'L7', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: 1751000000000 } });
    const attempted = calls.map((c) => c.to_number);
    ok(attempted.includes(SYNGENTA_GROUP), 'the group is attempted first');
    ok(attempted.includes('919090707777'), 'the group send FAILING falls back to the individual DM - the customer is not silently blacked out');
  }

  // ---- group-ONLY customer with a dead group + NO individual fallback -> loud "reached NOBODY" -
  // The residual r2 gaps case: if a customer's ONLY recipient is a scoped group and it is dead,
  // there is by definition no one to deliver to. That must not be SILENT - it emits a distinct
  // reached-NOBODY error (and marks nothing sent, so it is never recorded as delivered).
  {
    const logs = [];
    const calls = [];
    const tr = async (url, opts) => {
      const body = JSON.parse(opts.body); calls.push(body.to_number);
      return { ok: true, status: 200, json: async () => ({ success: false, message: 'not a participant' }) }; // group is dead
    };
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const store = new MemoryStore();
    const onlyGroup = [{ personId: recipientId(SYNGENTA_GROUP), name: 'BRL Bids - Syngenta', phone: SYNGENTA_GROUP, alertPrefs: 'all', enabled: true }];
    const asg = [{ assignmentId: 'a1', personId: recipientId(SYNGENTA_GROUP), customerId: 'syngenta', enabled: true }];
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: (m) => logs.push(String(m)), wa, store,
      recipientsProvider: async () => toRecipientRows(customers, onlyGroup, asg),
    });
    await n.requestPrice({ id: 'rq8', loadId: 'L8', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', closesAt: 1751000000000 } });
    ok(calls.length === 1 && calls[0] === SYNGENTA_GROUP, 'only the group is attempted - no phantom individual is invented');
    ok(logs.some((l) => /reached NOBODY/.test(l)), 'a dead group with no individual fallback emits a distinct "reached NOBODY" error - not silent');
    ok((await store.getDoc('notifSent', 'rq8_price_needed')) == null || (await store.getDoc('notifSent', 'L8_price_needed')) == null,
      'nothing is marked sent when the alert reached nobody (so it is never falsely recorded as delivered)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
