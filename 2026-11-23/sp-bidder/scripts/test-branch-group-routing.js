'use strict';
/**
 * BRANCH-level WhatsApp group routing, end to end and offline.
 *
 * Today a group routes on CUSTOMER (shipper) only. This proves the OPTIONAL branch dimension: a
 * group can carry scope.branches (e.g. Havells' Alwar branch) so that branch's loads split off to a
 * SEPARATE group, while every other Havells load continues to the general Havells group UNCHANGED.
 *
 * The chain proven is the same one the customer-group feature uses, plus the new branch filter:
 *
 *   Person.branchScope -> toRecipientRows -> scope.branches -> scopeMatches -> applyBranchPrecedence
 *
 * What must hold:
 *  - an Alwar Havells load reaches the Alwar group ONLY (never the general Havells group, no
 *    double-send);
 *  - a non-Alwar Havells load reaches the general Havells group ONLY (never the Alwar group);
 *  - a customer with no branch filter routes exactly as before (backward-compatible);
 *  - branch matching keys on SP's numeric branch id and never over-matches a different same-town
 *    branch ("Alwar Steel (1400)" is not the Alwar Cable branch).
 */

const assert = require('assert');
const { branchKey, branchMatches, applyBranchPrecedence } = require('../src/notify/branchRouting');
const { validatePerson } = require('../src/model/personStore');
const { toRecipientRows } = require('../src/model/project');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier, scopeMatches } = require('../src/notify/notifier');
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

// real-format group ids (the Alwar group JID is operator config in production - a placeholder here)
const HAVELLS_GROUP = '120363111111111111@g.us';        // the existing general Havells group
const HAVELLS_ALWAR_GROUP = '120363222222222222@g.us';  // the NEW branch-split group
const SYNGENTA_GROUP = '120363333333333333@g.us';

const ALWAR_LABEL = 'Alwar Cable (1350)';   // the RAW SP branch label the portal shows

(async () => {
  // ---- branchKey: SP's numeric branch id is the strong, unique key ----
  ok(branchKey('Alwar Cable (1350)') === 'id:1350', 'branchKey extracts the parenthesized SP branch id');
  ok(branchKey('  ALWAR CABLE (1350)  ') === 'id:1350', 'branchKey is case/whitespace-insensitive and still keys on the id');
  ok(branchKey('1350') === 'id:1350', 'branchKey treats a bare numeric string as a branch id');
  ok(branchKey('Alwar Steel (1400)') === 'id:1400', 'a DIFFERENT same-town branch keys to its OWN id');
  ok(branchKey('Alwar Cable') === 'name:alwar cable', 'with no id present branchKey falls back to a normalized name');
  ok(branchKey('') === null && branchKey(null) === null && branchKey(undefined) === null, 'an empty/absent label has no key (never matches)');

  // ---- branchMatches: pins ONE branch, never a family of same-town branches ----
  ok(branchMatches('Alwar Cable (1350)', 'Alwar Cable (1350)'), 'exact label matches');
  ok(branchMatches('1350', 'Alwar Cable (1350)'), 'a bare-id filter matches the full SP label (same id)');
  ok(branchMatches('Alwar Cable (1350)', '  alwar cable (1350) '), 'casing/whitespace variants match');
  ok(!branchMatches('Alwar Cable (1350)', 'Alwar Steel (1400)'), 'NO over-match: a different Alwar branch (id 1400) is not the Alwar Cable branch (id 1350)');
  ok(!branchMatches('Alwar Cable (1350)', ''), 'a load with no branch never matches a branch filter');
  ok(!branchMatches('Alwar Cable (1350)', 'Alwar Cable'), 'an id-keyed filter does not match a label that lost its id (fail closed, not loose)');

  // ---- scopeMatches: the branch dimension is ANDed with shipper, and empty = unchanged ----
  {
    const genScope = { shippers: ['Havells'], branches: [] };
    const alwarScope = { shippers: ['Havells'], branches: [ALWAR_LABEL] };
    const alwarLoad = { shipper: 'Havells', branch: ALWAR_LABEL };
    const otherLoad = { shipper: 'Havells', branch: 'Alwar Steel (1400)' };
    ok(scopeMatches(genScope, alwarLoad) && scopeMatches(genScope, otherLoad), 'a branch-LESS group matches every branch of its shipper (unchanged)');
    ok(scopeMatches(alwarScope, alwarLoad), 'a branch-scoped group matches its own branch');
    ok(!scopeMatches(alwarScope, otherLoad), 'a branch-scoped group does NOT match a different branch of the same shipper');
    ok(!scopeMatches(alwarScope, { shipper: 'Syngenta', branch: ALWAR_LABEL }), 'a branch-scoped group still requires the shipper to match too (branch is ANDed, not OR)');
    ok(scopeMatches({ origins: [], shippers: [], branches: [] }, { shipper: 'Anyone' }), 'an all-empty scope still matches everything (central-desk semantic preserved)');
  }

  // ---- applyBranchPrecedence: the branch group WINS; deterministic; backward-compatible ----
  {
    const general = { name: 'Havells general', phone: HAVELLS_GROUP, scope: { shippers: ['Havells'], branches: [] } };
    const alwar = { name: 'Havells Alwar', phone: HAVELLS_ALWAR_GROUP, scope: { shippers: ['Havells'], branches: [ALWAR_LABEL] } };
    const syn = { name: 'Syngenta', phone: SYNGENTA_GROUP, scope: { shippers: ['Syngenta'], branches: [] } };

    const won = applyBranchPrecedence([general, alwar]);
    ok(won.length === 1 && won[0] === alwar, 'the branch-scoped group supersedes the same customer general group (Alwar load -> Alwar group only)');

    const noBranch = applyBranchPrecedence([general, syn]);
    ok(noBranch.length === 2 && noBranch[0] === general && noBranch[1] === syn, 'with no branch-scoped group the input is returned UNCHANGED (backward-compatible)');

    const crossCustomer = applyBranchPrecedence([alwar, syn]);
    ok(crossCustomer.length === 2 && crossCustomer.includes(syn), 'a branch-scoped group does NOT supersede a DIFFERENT customer general group (Syngenta kept)');

    // determinism: same input -> same output, every run
    const a = applyBranchPrecedence([general, alwar, syn]);
    const b = applyBranchPrecedence([general, alwar, syn]);
    ok(JSON.stringify(a.map((g) => g.phone)) === JSON.stringify(b.map((g) => g.phone)) && !a.includes(general),
      'precedence is deterministic and drops the superseded general group');
  }

  // ---- toRecipientRows: a group carries its branchScope through into scope.branches ----
  const customers = [
    { customerId: 'havells', label: 'Havells', aliases: ['Havells'] },
    { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta'] },
  ];
  const people = [
    { personId: 'g120363111111111111', name: 'BRL Bids - Havells', phone: HAVELLS_GROUP, alertPrefs: 'all', enabled: true },
    { personId: 'g120363222222222222', name: 'BRL Bids - Havells Alwar', phone: HAVELLS_ALWAR_GROUP, alertPrefs: 'all', enabled: true, branchScope: [ALWAR_LABEL] },
    { personId: 'g120363333333333333', name: 'BRL Bids - Syngenta', phone: SYNGENTA_GROUP, alertPrefs: 'all', enabled: true },
  ];
  const assignments = [
    { assignmentId: 'a1', personId: 'g120363111111111111', customerId: 'havells', enabled: true },
    { assignmentId: 'a2', personId: 'g120363222222222222', customerId: 'havells', enabled: true },  // Alwar group -> Havells
    { assignmentId: 'a3', personId: 'g120363333333333333', customerId: 'syngenta', enabled: true },
  ];
  {
    const rows = toRecipientRows(customers, people, assignments);
    const alwarRow = rows.find((r) => r.phone === HAVELLS_ALWAR_GROUP);
    const genRow = rows.find((r) => r.phone === HAVELLS_GROUP);
    ok(alwarRow && alwarRow.scope.branches.length === 1 && alwarRow.scope.branches[0] === ALWAR_LABEL, 'the Alwar group row carries scope.branches from branchScope');
    ok(alwarRow.scope.shippers.includes('Havells'), 'the Alwar group still inherits its Havells shipper scope from the assignment');
    ok(genRow && (genRow.scope.branches || []).length === 0, 'the general Havells group carries NO branch filter (matches every Havells branch)');
  }

  // ---- END TO END: an Alwar Havells load reaches the Alwar group ONLY (no double-send) ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });
    await n.requestPrice({ id: 'rqA', loadId: 'LA', load: { lane: { origin: 'Alwar', destination: 'Pune' }, companyName: 'Havells', branchName: ALWAR_LABEL, closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number);
    ok(targets.length === 1, 'an Alwar Havells load produces exactly ONE send (no double-send)');
    ok(targets[0] === HAVELLS_ALWAR_GROUP, 'that send goes to the Havells-Alwar group JID');
    ok(!targets.includes(HAVELLS_GROUP), 'the general Havells group gets NOTHING for an Alwar load (the split works)');
  }

  // ---- END TO END: a NON-Alwar Havells load reaches the general Havells group ONLY ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });
    // a DIFFERENT Havells branch, same town name - must NOT leak into the Alwar group
    await n.requestPrice({ id: 'rqB', loadId: 'LB', load: { lane: { origin: 'Bhiwadi', destination: 'Delhi' }, companyName: 'Havells', branchName: 'Alwar Steel (1400)', closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number);
    ok(targets.length === 1 && targets[0] === HAVELLS_GROUP, 'a non-Alwar Havells load goes to the general Havells group only');
    ok(!targets.includes(HAVELLS_ALWAR_GROUP), 'a different Havells branch never leaks into the Alwar group (no over-match on the "Alwar" town)');
  }

  // ---- BACKWARD-COMPAT: a customer with NO branch filter routes exactly as before ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });
    await n.requestPrice({ id: 'rqC', loadId: 'LC', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', branchName: 'Whatever (9999)', closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number);
    ok(targets.length === 1 && targets[0] === SYNGENTA_GROUP, 'a no-branch customer (Syngenta) reaches its single group unchanged, regardless of the load branch');
  }

  // ---- a Havells load with NO branch label falls to the general Havells group (never Alwar) ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => toRecipientRows(customers, people, assignments),
    });
    await n.requestPrice({ id: 'rqD', loadId: 'LD', load: { lane: { origin: 'X', destination: 'Y' }, companyName: 'Havells', closesAt: 1751000000000 } });
    const targets = tr.calls.map((c) => c.body.to_number);
    ok(targets.length === 1 && targets[0] === HAVELLS_GROUP, 'a Havells load with no branch label reaches the general group, never the branch group');
  }

  // ---- config schema: validatePerson persists branchScope (the operator-set filter) ----
  {
    const g = validatePerson({ name: 'BRL Bids - Havells Alwar', phone: HAVELLS_ALWAR_GROUP, accountId: 'primary', alertPrefs: 'all', branchScope: [' Alwar Cable (1350) ', ''] });
    ok(Array.isArray(g.branchScope) && g.branchScope.length === 1 && g.branchScope[0] === 'Alwar Cable (1350)', 'validatePerson trims + keeps branchScope, dropping blanks');
    const p = validatePerson({ name: 'A person', phone: '+919356252711', accountId: 'primary', alertPrefs: 'all' });
    ok(Array.isArray(p.branchScope) && p.branchScope.length === 0, 'a recipient with no branchScope defaults to [] (routing unchanged)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
