'use strict';
/**
 * A FIRST-TIME GROUP REGISTRATION WRITES ITS ASSIGNMENT ENABLED, ARMING LIVE BIDDING INSTANTLY.
 * (CW-24, remaining half - #216 already fixed the existing-record preserve.)
 *
 * scripts/provision-group.js's first-time-registration branch (`if (!priorPerson) { ... }`) calls
 * assignmentStore.upsert({ personId, customerId }) with no `enabled` field at all, so a brand-new
 * GROUP's assignment falls through AssignmentStore's default (`existing ? ... : true`) and is armed
 * for live bidding the instant it is registered, with nobody having explicitly enabled it.
 *
 * SCOPED TO THE GROUP PATH ONLY. The very same bare-upsert shape is also what the console's
 * "assign this person to this customer" action sends (dashboard/src/pages/Assignments.tsx `assign()`
 * -> POST /api/assignments -> assignmentStore.upsert(req.body)) for an ordinary staff person, where
 * disabling-by-default would silently drop that desk from delivery instead. So the fix belongs in
 * provision-group.js's own first-time branch, not in AssignmentStore's shared default - check 4
 * below pins that AssignmentStore's own default is untouched.
 *
 *   1. a genuine first-time GROUP registration (via runProvision on a brand-new group) writes its
 *      assignment enabled:false
 *   2. regression guard (#216): re-registering an existing DISABLED assignment via the same bare
 *      { personId, customerId } shape stays disabled
 *   3. regression guard (#216): re-registering an existing ENABLED assignment via the same bare
 *      shape stays enabled
 *   4. control: a console-style bare upsert with NO prior record (no group involved) still writes
 *      enabled:true - proves the fix is scoped to provision-group.js, not AssignmentStore itself
 *
 * Offline and deterministic: a fake Maytapi transport (same shape as test-group-provisioner.js),
 * MemoryStore, no network, no timers.
 *
 *   node scripts/test-provision-group-first-registration-defaults-disabled.js
 */
const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');
const { StaffRoster } = require('../src/model/staffRoster');
const { PersonStore } = require('../src/model/personStore');
const { CustomerStore } = require('../src/model/customerStore');
const { AssignmentStore } = require('../src/model/assignmentStore');
const G = require('./lib/group-directory');
const { runProvision } = require('./provision-group');

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label}: ${e.message}`); console.error(`  FAIL ${checks}. ${label}: ${e.message}`); }
}

const BOT = '918882034647';
const FALLBACK = G.FALLBACK_NUMBER;
const SUYASHH = '919594937777';
const CREATOR_PHONE = '128023';

function fakeMaytapi({ groups = [] } = {}) {
  const state = {
    groups: groups.map((g) => JSON.parse(JSON.stringify(g))),
    phones: [
      { id: CREATOR_PHONE, number: BOT, status: 'active' },
      { id: G.FALLBACK_PHONE_ID, number: FALLBACK, status: 'active' },
    ],
    nextId: 120363499998888001,
  };
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const transport = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (url.endsWith('/listPhones')) return json({ success: true, data: state.phones });
    if (url.endsWith('/getGroups')) return json({ success: true, data: state.groups });
    if (url.endsWith('/createGroup')) {
      const id = `${state.nextId++}@g.us`;
      state.groups.push({
        id, name: body.name,
        participants: [`${BOT}@c.us`, ...(body.numbers || []).map((n) => `${n}@c.us`)],
        admins: [`${BOT}@c.us`], config: body.config || null,
      });
      return json({ success: true, data: { id } });
    }
    const target = body && body.conversation_id
      ? state.groups.find((g) => g.id.toLowerCase() === String(body.conversation_id).toLowerCase())
      : null;
    if (url.endsWith('/group/add')) {
      if (target) for (const n of body.numbers || []) if (!target.participants.includes(`${n}@c.us`)) target.participants.push(`${n}@c.us`);
      return json({ success: true });
    }
    if (url.endsWith('/group/promote')) {
      if (target && !target.admins.includes(body.number)) target.admins.push(body.number);
      return json({ success: true });
    }
    if (url.endsWith('/group/config')) {
      if (target) target.config = Object.assign({}, target.config, body.config);
      return json({ success: true });
    }
    return json({ success: false, message: `unhandled ${url}` }, 404);
  };
  return { state, transport };
}
const client = (transport) => new WhatsAppClient({ token: 't', productId: 'p', phoneId: CREATOR_PHONE, enabled: true, transport, log: () => {} });
const spySleep = () => async () => {};

async function fixtureStores({ people = [], assignments = [] } = {}) {
  const store = new MemoryStore();
  const customerStore = new CustomerStore({ store });
  const personStore = new PersonStore({ store });
  const assignmentStore = new AssignmentStore({ store, people: personStore, customers: customerStore });
  const staffRoster = new StaffRoster({ store });
  await customerStore.upsert({ label: 'Syngenta', aliases: ['SYNGENTA INDIA'] });
  await staffRoster.replace([FALLBACK, SUYASHH].map((n) => `+${n}`));
  for (const p of people) await personStore.upsert(p);
  for (const a of assignments) await assignmentStore.upsert(a);
  return { store, customerStore, personStore, assignmentStore, staffRoster };
}

(async () => {
  console.log('\n-- a genuine first-time GROUP registration, via provision-group.js');
  await check('runProvision on a brand-new group writes its assignment enabled:false', async () => {
    const s = await fixtureStores();
    const { transport } = fakeMaytapi();
    const rep = await runProvision({
      wa: client(transport), ...s, customerRef: 'syngenta', members: [SUYASHH], apply: true, sleep: spySleep(),
    });
    assert.ok(!rep.aborted && !rep.refused, `provisioning must not abort/refuse: ${rep.reason || rep.abortReason}`);
    assert.ok(rep.registered, 'runProvision must register a brand-new, complete group');
    const asg = await s.assignmentStore.get(`${rep.registered.personId}::${rep.registered.customerId}`);
    assert.strictEqual(asg.enabled, false, `expected enabled:false on a first-time group registration, got ${asg.enabled}`);
  });

  console.log('\n-- regression guard (#216): an existing assignment survives the same bare-upsert shape');
  await check('re-registering an existing DISABLED assignment (bare shape) preserves disabled', async () => {
    const pid = 'gTestGroup1';
    const s = await fixtureStores({ people: [{ personId: pid, name: 'Group One', phone: '120363400000000099@g.us' }] });
    await s.assignmentStore.upsert({ personId: pid, customerId: 'syngenta', enabled: false });
    const saved = await s.assignmentStore.upsert({ personId: pid, customerId: 'syngenta' });
    assert.strictEqual(saved.enabled, false, `expected a disabled desk to stay disabled, got ${saved.enabled}`);
  });
  await check('re-registering an existing ENABLED assignment (bare shape) preserves enabled', async () => {
    const pid = 'gTestGroup2';
    const s = await fixtureStores({ people: [{ personId: pid, name: 'Group Two', phone: '120363400000000098@g.us' }] });
    await s.assignmentStore.upsert({ personId: pid, customerId: 'syngenta', enabled: true });
    const saved = await s.assignmentStore.upsert({ personId: pid, customerId: 'syngenta' });
    assert.strictEqual(saved.enabled, true, `expected an enabled desk to stay enabled, got ${saved.enabled}`);
  });

  console.log('\n-- control: AssignmentStore\'s own default is untouched (console assign() flow)');
  await check('a bare upsert with no prior record and no group involved still writes enabled:true', async () => {
    const s = await fixtureStores({ people: [{ personId: 'p-console-staff', name: 'Desk Staffer', phone: '9000000001' }] });
    const saved = await s.assignmentStore.upsert({ personId: 'p-console-staff', customerId: 'syngenta' });
    assert.strictEqual(saved.enabled, true, `a console-style assign() must still default enabled:true, got ${saved.enabled}`);
  });

  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - CW-24 (first-time group registration arms live bidding with nobody having enabled it):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a first-time GROUP registration writes disabled, every other assignment path is untouched`);
})().catch((e) => { console.error('FAIL (setup):', e && e.stack); process.exit(1); });
