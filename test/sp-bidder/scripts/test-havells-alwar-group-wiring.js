'use strict';
/**
 * PRODUCTION WIRING PROOF - Havells Alwar branch group (the concrete instance of PR #71's
 * branch-level routing, offline and deterministic).
 *
 * PR #71 (scripts/test-branch-group-routing.js) proves the branch-routing MECHANISM with
 * placeholder JIDs, deliberately keeping no JID in the routing code ("the group JID is operator
 * config"). This test pins the REAL production wiring for the one branch the director asked for -
 * Havells' Alwar branch - so the exact recipient row + assignment that will be applied to the box
 * are committed alongside PR #71 and proven to route correctly with the REAL values:
 *
 *   - the new WhatsApp group "BRL Bids . Havells Alwar", JID 120363412728296902@g.us, created live
 *     via Maytapi on 2026-07-24 (bot + Sid admins, membersCanAddMembers:false lockdown), carries
 *     branchScope ["Alwar Cable (1350)"] - SP's real Havells-Alwar branch label (id 1350);
 *   - the existing general group "BRL Bids . Havells", JID 120363431523383103@g.us, carries NO
 *     branch scope, so it keeps every other Havells branch.
 *
 * What must hold, with the real values:
 *   - a Havells load on the Alwar Cable (1350) branch reaches the Alwar group ONLY (never the
 *     general Havells group, no double-send);
 *   - a Havells load on a DIFFERENT branch (Tumkur Cable (1355), a real sibling Havells branch)
 *     reaches the general Havells group ONLY (never the Alwar group);
 *   - a Havells load with no branch label reaches the general Havells group ONLY.
 *
 * The JIDs live here as an operator/wiring reference and a routing proof, NOT in src/ - the
 * routing code path stays JID-free, exactly as PR #71 intends.
 *
 * NOTE - runtime data (data/people.json, data/assignments.json) is gitignored and deploy-excluded;
 * it is on-box operator config, never committed. The two rows this test pins are applied to the box
 * ATOMICALLY WITH the PR #71 deploy (not before): the live box runs branch-unaware code until then,
 * where an Alwar assignment would double-send every Havells load to this near-empty group.
 *
 *   node scripts/test-havells-alwar-group-wiring.js
 */

const assert = require('assert');
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

// ---- the REAL production values ----
const HAVELLS_GENERAL_JID = '120363431523383103@g.us'; // existing "BRL Bids . Havells"
const HAVELLS_ALWAR_JID = '120363412728296902@g.us';   // NEW "BRL Bids . Havells Alwar" (created 2026-07-24)
const ALWAR_BRANCH = 'Alwar Cable (1350)';             // SP's real Havells-Alwar branch label (id 1350)
const OTHER_BRANCH = 'Tumkur Cable (1355)';            // a real DIFFERENT Havells branch (id 1355)

// the havells customer exactly as it is on the box (customers.json): both aliases
const customers = [
  { customerId: 'havells', label: 'Havells', aliases: ['Havells', 'Havells India Ltd.'] },
];

// the two group recipients, built through the REAL validator so branchScope is proven to survive
// the PR #71 person schema (an unknown field on old code would be dropped).
const generalGroup = validatePerson({
  personId: 'g120363431523383103', name: 'BRL Bids · Havells', phone: HAVELLS_GENERAL_JID,
  accountId: 'master', alertPrefs: 'all', alertAll: false, enabled: true,
});
const alwarGroup = validatePerson({
  personId: 'g120363412728296902', name: 'BRL Bids · Havells Alwar', phone: HAVELLS_ALWAR_JID,
  accountId: 'master', alertPrefs: 'all', alertAll: false, enabled: true,
  branchScope: [ALWAR_BRANCH],
});
const people = [generalGroup, alwarGroup];

// both groups assigned to the havells customer (assignments.json rows)
const assignments = [
  { assignmentId: 'g120363431523383103::havells', personId: 'g120363431523383103', customerId: 'havells', enabled: true },
  { assignmentId: 'g120363412728296902::havells', personId: 'g120363412728296902', customerId: 'havells', enabled: true },
];

async function sendTargetsFor(load) {
  const tr = mockTransport();
  const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
  const n = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => toRecipientRows(customers, people, assignments),
  });
  await n.requestPrice({ id: 'rq_' + Math.random().toString(36).slice(2), loadId: load.loadId, load: load.snap });
  return tr.calls.map((c) => c.body.to_number);
}

(async () => {
  // the branchScope survived validation (the schema half of the wiring)
  ok(Array.isArray(alwarGroup.branchScope) && alwarGroup.branchScope.length === 1 && alwarGroup.branchScope[0] === ALWAR_BRANCH,
    'the Alwar group recipient carries branchScope ["Alwar Cable (1350)"] through validatePerson');
  ok((generalGroup.branchScope || []).length === 0, 'the general Havells group carries no branchScope');

  // toRecipientRows projects the wiring the notifier reads
  const rows = toRecipientRows(customers, people, assignments);
  const alwarRow = rows.find((r) => r.phone === HAVELLS_ALWAR_JID);
  const genRow = rows.find((r) => r.phone === HAVELLS_GENERAL_JID);
  ok(alwarRow && alwarRow.scope.branches.length === 1 && alwarRow.scope.branches[0] === ALWAR_BRANCH,
    'the Alwar row exposes scope.branches ["Alwar Cable (1350)"]');
  ok(alwarRow && alwarRow.scope.shippers.includes('Havells') && alwarRow.scope.shippers.includes('Havells India Ltd.'),
    'the Alwar row inherits both Havells aliases from the assignment');
  ok(genRow && (genRow.scope.branches || []).length === 0, 'the general Havells row has no branch filter');

  // END TO END: an Alwar Havells load -> the Alwar group ONLY
  {
    const targets = await sendTargetsFor({
      loadId: 'HAV-ALWAR-1',
      snap: { lane: { origin: 'Alwar', destination: 'Pune' }, companyName: 'Havells India Ltd.', branchName: ALWAR_BRANCH, closesAt: 1751000000000 },
    });
    ok(targets.length === 1, 'Alwar load: exactly one send (no double-send)');
    ok(targets[0] === HAVELLS_ALWAR_JID, 'Alwar load: the send goes to the Havells-Alwar group JID');
    ok(!targets.includes(HAVELLS_GENERAL_JID), 'Alwar load: the general Havells group gets nothing');
  }

  // END TO END: a DIFFERENT Havells branch -> the general group ONLY
  {
    const targets = await sendTargetsFor({
      loadId: 'HAV-TUMKUR-1',
      snap: { lane: { origin: 'Tumkur', destination: 'Chennai' }, companyName: 'Havells India Ltd.', branchName: OTHER_BRANCH, closesAt: 1751000000000 },
    });
    ok(targets.length === 1, 'non-Alwar Havells load: exactly one send');
    ok(targets[0] === HAVELLS_GENERAL_JID, 'non-Alwar Havells load: the send goes to the general Havells group');
    ok(!targets.includes(HAVELLS_ALWAR_JID), 'non-Alwar Havells load: the Alwar group gets nothing (no over-match on the town name)');
  }

  // END TO END: a Havells load with NO branch label -> the general group ONLY
  {
    const targets = await sendTargetsFor({
      loadId: 'HAV-NOBRANCH-1',
      snap: { lane: { origin: 'Neemrana', destination: 'Delhi' }, companyName: 'Havells India Ltd.', branchName: '', closesAt: 1751000000000 },
    });
    ok(targets.length === 1 && targets[0] === HAVELLS_GENERAL_JID, 'branch-less Havells load: general group only');
    ok(!targets.includes(HAVELLS_ALWAR_JID), 'branch-less Havells load: never the Alwar group');
  }

  console.log(`\ntest-havells-alwar-group-wiring: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test-havells-alwar-group-wiring crashed:', e && e.message); process.exit(1); });
