'use strict';

// coverage.js - which customers actually go unbid when an account dies, derived from WHERE LOADS
// HAVE ACTUALLY SURFACED (closedBids + priceRequests), never from person.accountId (a provisioning
// record that goes stale silently). The Durian case is the reason this module exists at all: its
// group person is still registered on `sameer-ambdaskar`, but its loads moved to `master` on
// 2026-08-05 and have bid there ever since - deriving from registration would report Durian as
// affected when it is bidding perfectly well.

const assert = require('assert');
const { customersCarriedBy, affectedCustomers, DEFAULT_WINDOW_MS } = require('../src/model/coverage');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass += 1; console.log('  ok  ' + m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m);

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1787900000000; // fixed instant, arbitrary but stable across runs

const customers = [
  { customerId: 'durian', label: 'Durian', aliases: ['Durian', 'Durian Industries'], enabled: true },
  { customerId: 'kingspan', label: 'Kingspan', aliases: ['Kingspan', 'Kingspan Insulated Panels'], enabled: true },
  { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta', 'Syngenta India'], enabled: true },
];

const acc = (id) => ({ accountId: id, label: id });

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. THE DURIAN CASE: registered on a dead account, but its loads bid on a live one. NOT affected.
  // ---------------------------------------------------------------------------------------------
  {
    const closedBids = [
      // pre-migration: sameer-ambdaskar (about to die) carried Durian, inside the window
      { account: acc('sameer-ambdaskar'), shipper: 'Durian Industries', armedAt: NOW - 10 * DAY },
      // post-migration (2026-08-05 in the real story): master (live) carries it now
      { account: acc('master'), shipper: 'Durian Industries', armedAt: NOW - 2 * DAY },
    ];
    const carriedByDead = customersCarriedBy('sameer-ambdaskar', { closedBids, priceRequests: [], customers, now: NOW });
    eq([...carriedByDead], ['durian'], 'customersCarriedBy: the dead account still shows as a recent Durian carrier (its old rows are in-window)');

    const affected = affectedCustomers({
      deadAccountIds: ['sameer-ambdaskar'], liveAccountIds: ['master'],
      closedBids, priceRequests: [], customers, now: NOW,
    });
    eq(affected, [], 'Durian is NOT reported affected - master still carries it live');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. A GENUINELY AFFECTED CUSTOMER: its only recent carrier is the dead account.
  // ---------------------------------------------------------------------------------------------
  {
    const closedBids = [
      { account: acc('rallis'), shipper: 'Kingspan', armedAt: NOW - 5 * DAY },
    ];
    const affected = affectedCustomers({
      deadAccountIds: ['rallis'], liveAccountIds: ['master'],
      closedBids, priceRequests: [], customers, now: NOW,
    });
    eq(affected, ['Kingspan'], 'Kingspan IS reported affected - no live account has carried it recently');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. AN ACCOUNT THAT NEVER CARRIED ANYTHING: empty list, not an error.
  // ---------------------------------------------------------------------------------------------
  {
    const closedBids = [
      { account: acc('rallis'), shipper: 'Kingspan', armedAt: NOW - 5 * DAY },
      { account: acc('master'), shipper: 'Durian Industries', armedAt: NOW - 2 * DAY },
    ];
    const carried = customersCarriedBy('ludhiana', { closedBids, priceRequests: [], customers, now: NOW });
    eq([...carried], [], 'customersCarriedBy: an account with zero rows carries nothing');
    const affected = affectedCustomers({
      deadAccountIds: ['ludhiana'], liveAccountIds: ['master', 'rallis'],
      closedBids, priceRequests: [], customers, now: NOW,
    });
    eq(affected, [], 'a dead account that never carried any customer affects nobody');
  }

  // ---------------------------------------------------------------------------------------------
  // 4. A CUSTOMER CARRIED BY TWO ACCOUNTS, ONLY ONE DEAD (via priceRequests.customer.customerId,
  //    not shipper matching, so the two data sources both get exercised across this suite).
  // ---------------------------------------------------------------------------------------------
  {
    const priceRequests = [
      { account: acc('rallis'), customer: { customerId: 'syngenta' }, createdAt: NOW - 3 * DAY },
      { account: acc('master'), customer: { customerId: 'syngenta' }, createdAt: NOW - 1 * DAY },
    ];
    const affected = affectedCustomers({
      deadAccountIds: ['rallis'], liveAccountIds: ['master'],
      closedBids: [], priceRequests, customers, now: NOW,
    });
    eq(affected, [], 'Syngenta is still carried by the live account too, so it is not affected');
  }

  // ---------------------------------------------------------------------------------------------
  // 5. EMPTY / MISSING INPUT never throws and never invents an affected customer.
  // ---------------------------------------------------------------------------------------------
  {
    eq(affectedCustomers(), [], 'affectedCustomers() with no argument at all returns []');
    eq(affectedCustomers({}), [], 'affectedCustomers({}) returns []');
    eq(affectedCustomers({ deadAccountIds: [], liveAccountIds: ['master'], closedBids: [], priceRequests: [], customers }), [],
      'no dead accounts at all -> []');
    eq(affectedCustomers({ deadAccountIds: ['rallis'], liveAccountIds: null, closedBids: null, priceRequests: null, customers: null }), [],
      'null collections degrade to [] rather than throwing');
    eq([...customersCarriedBy(null, {})], [], 'customersCarriedBy(null, ...) returns an empty set, not a throw');
    eq([...customersCarriedBy('rallis', {})], [], 'customersCarriedBy with no priceRequests/closedBids at all returns empty');
  }

  // ---------------------------------------------------------------------------------------------
  // 6. WINDOWING: a carry outside windowMs does not count as recent.
  // ---------------------------------------------------------------------------------------------
  {
    const closedBids = [
      { account: acc('rallis'), shipper: 'Kingspan', armedAt: NOW - (DEFAULT_WINDOW_MS + 5 * DAY) },
    ];
    const carried = customersCarriedBy('rallis', { closedBids, priceRequests: [], customers, now: NOW });
    eq([...carried], [], 'a carry older than the default window does not count as recent');

    // ...and a caller-supplied narrower window can exclude a carry the default window would keep.
    const carriedNarrow = customersCarriedBy('rallis',
      { closedBids: [{ account: acc('rallis'), shipper: 'Kingspan', armedAt: NOW - 5 * DAY }], priceRequests: [], customers, now: NOW, windowMs: 3 * DAY });
    eq([...carriedNarrow], [], 'a caller-supplied windowMs is honoured, not just the default');
  }

  // ---------------------------------------------------------------------------------------------
  // 7. closedAt FALLBACK when armedAt is missing.
  // ---------------------------------------------------------------------------------------------
  {
    const closedBids = [
      { account: acc('rallis'), shipper: 'Kingspan', armedAt: null, closedAt: NOW - 1 * DAY },
    ];
    const carried = customersCarriedBy('rallis', { closedBids, priceRequests: [], customers, now: NOW });
    eq([...carried], ['kingspan'], 'closedAt is used when armedAt is missing');
  }

  // ---------------------------------------------------------------------------------------------
  // 8. RENDERING: the two live templates say the right thing for empty and non-empty lists.
  // ---------------------------------------------------------------------------------------------
  {
    const emptyBody = renderMessage('account_auth_dead', { accountLabel: 'Ludhiana', affectedCustomers: [] });
    ok(/no customers are affected/i.test(emptyBody), 'account_auth_dead: empty list reads as reassurance');
    ok(!/undefined|NaN|\{\{/.test(emptyBody), 'account_auth_dead: nothing unresolved reaches the desk');

    const namedBody = renderMessage('account_auth_dead', { accountLabel: 'Rallis', affectedCustomers: ['Kingspan', 'Syngenta'] });
    ok(/Kingspan/.test(namedBody) && /Syngenta/.test(namedBody), 'account_auth_dead: names the affected customers');
    ok(/close with no bid/i.test(namedBody), 'account_auth_dead: states the consequence, not just the names');

    const expiredEmpty = renderMessage('account_auth_expired', { accountLabel: 'Ludhiana', affectedCustomers: [] });
    ok(/no customers are affected/i.test(expiredEmpty), 'account_auth_expired: same reassurance wording on the sibling template');

    const expiredNamed = renderMessage('account_auth_expired', { accountLabel: 'Rallis', affectedCustomers: ['Kingspan'] });
    ok(/Kingspan/.test(expiredNamed), 'account_auth_expired: names the affected customer too');

    // no affectedCustomers key at all (a pre-fix persisted event, a hand-rolled stub) must degrade
    // to the same reassurance line, not to a blank or an unresolved placeholder.
    const noKey = renderMessage('account_auth_dead', { accountLabel: 'Ludhiana' });
    ok(/no customers are affected/i.test(noKey), 'a payload with no affectedCustomers key at all still renders cleanly');
  }

  console.log(`\n${pass} passed, 0 failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
