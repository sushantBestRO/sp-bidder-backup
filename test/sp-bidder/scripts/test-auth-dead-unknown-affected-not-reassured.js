'use strict';
/**
 * A logged-out alert whose affected-customer lookup failed does not tell the desk nothing is going unbid.
 *
 * The alert names the customers that cannot bid, and an empty list reads "No customers are affected -
 * nothing is going unbid because of this." A lookup that failed also produced an empty list, so an outage
 * whose impact nobody could work out went out as reassurance. An unknown impact must say so. Price-page
 * gate, bucket 2: a runtime failure is loud, never a quiet all-clear.
 *
 *   node scripts/test-auth-dead-unknown-affected-not-reassured.js
 */
const assert = require('assert');
const { raiseAuthDead } = require('../src/notify/authAlert');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };
const REASSURANCE = 'No customers are affected';

(async () => {
  const sent = [];
  const notifier = { alert: async (kind, payload) => { sent.push(payload); } };
  raiseAuthDead(notifier, { accountId: 'acct-1', accountLabel: 'Pune login', since: 1, affectedCustomers: null });
  const payload = sent[0];
  assert.ok(payload, 'no alert was raised');
  for (const kind of ['account_auth_dead', 'account_auth_expired']) {
    const text = renderMessage(kind, payload);
    assert.ok(!text.includes(REASSURANCE), `${kind} reassured the desk on an unknown impact:\n${text}`);
    assert.ok(/could not work out which customers/i.test(text), `${kind} does not say the impact is unknown:\n${text}`);
  }
  ok(1, 'a failed lookup is reported as an unknown impact, not as no impact');

  sent.length = 0;
  raiseAuthDead(notifier, { accountId: 'acct-1', since: 2, affectedCustomers: [] });
  assert.ok(renderMessage('account_auth_dead', sent[0]).includes(REASSURANCE), 'a checked, empty impact lost its reassurance');
  raiseAuthDead(notifier, { accountId: 'acct-1', since: 3, affectedCustomers: ['Havells India Ltd.'] });
  assert.ok(renderMessage('account_auth_dead', sent[1]).includes('This affects Havells India Ltd.'), 'a named impact lost its names');
  ok(2, 'a checked impact still reads as before: none, or the named customers');

  console.log(`\n${pass}/2 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
