'use strict';
/**
 * Pins C082 (fix/ops-alerting-divergences).
 *
 * alertChannel.js's siblingTier (the heartbeat/director_eod reroute when the primary sender is
 * down) picked "the FIRST other active phone with a real number" off the whole Maytapi product's
 * listPhones - any active slot, including a number never meant for this app. It must instead be
 * restricted to the CONFIGURED fleet (maytapi.fleetPhoneIds), same list senderFleet.js draws its
 * price-ask failover candidates from, and unconfigured (the default) means no candidate at all.
 *
 * @requires-summary-line
 *   node scripts/test-c082-alertchannel-fleet-only.js
 */
const assert = require('assert');
const { createFallbackAlert } = require('../src/notify/alertChannel');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const PHONES = [
  { id: '1', status: 'active', number: '919000000001' }, // the down sender itself
  { id: '2', status: 'active', number: '919000000002' }, // unrelated active phone on the product, NOT in the fleet
  { id: '3', status: 'active', number: '919000000003' }, // the configured fleet sibling
];

function fakeTransport(sent) {
  return async (url, init) => {
    sent.push({ url, init });
    if (url.endsWith('/listPhones')) {
      return { ok: true, json: async () => ({ data: PHONES }) };
    }
    if (url.includes('/sendMessage')) {
      return { ok: true, json: async () => ({ success: true, data: { msgId: 'm1' } }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

(async () => {
  // ---- unconfigured fleet (the default): no candidate, even though active phones exist ----
  {
    const sent = [];
    const fallbackAlert = createFallbackAlert({
      maytapi: { endpoint: 'https://x.invalid', productId: 'p', token: 't', senderPhoneId: '1' }, // no fleetPhoneIds
      brevo: {}, // no email config either, so ok must be false and we can see the sibling tier's own verdict
      transport: fakeTransport(sent),
    });
    const result = await fallbackAlert({ subject: 's', body: 'b', to: '919999999999', kind: 'test' });
    assert.strictEqual(result.sibling, false, 'C082: with no fleet configured, the sibling tier never fires (no arbitrary product phone)');
    assert.ok(!sent.some((s) => s.url.includes('/sendMessage')), 'no sendMessage call was made at all - never reached an unconfigured sibling');
    ok('an unconfigured fleet yields no sibling candidate, even when the product has active phones');
  }

  // ---- configured fleet: only a listed id is eligible, never the unrelated active phone (id 2) ----
  {
    const sent = [];
    const fallbackAlert = createFallbackAlert({
      maytapi: { endpoint: 'https://x.invalid', productId: 'p', token: 't', senderPhoneId: '1', fleetPhoneIds: ['3'] },
      brevo: {},
      transport: fakeTransport(sent),
    });
    const result = await fallbackAlert({ subject: 's', body: 'b', to: '919999999999', kind: 'test' });
    assert.strictEqual(result.sibling, true, 'C082: a configured fleet phone IS picked when active');
    const sendCall = sent.find((s) => s.url.includes('/sendMessage'));
    assert.ok(sendCall, 'a sendMessage call was made');
    assert.ok(sendCall.url.includes('/p/3/sendMessage'), `sendMessage went out via the configured fleet id 3, got: ${sendCall.url}`);
    assert.ok(!sendCall.url.includes('/p/2/sendMessage'), 'never picked the unrelated active phone (id 2) that is not in the fleet');
    ok('a configured fleet phone is picked, and the unrelated active product phone is never chosen');
  }

  // ---- the down sender itself is excluded even if it were (hypothetically) listed in the fleet ----
  {
    const sent = [];
    const fallbackAlert = createFallbackAlert({
      maytapi: { endpoint: 'https://x.invalid', productId: 'p', token: 't', senderPhoneId: '1', fleetPhoneIds: ['1', '3'] },
      brevo: {},
      transport: fakeTransport(sent),
    });
    await fallbackAlert({ subject: 's', body: 'b', to: '919999999999', kind: 'test' });
    const sendCall = sent.find((s) => s.url.includes('/sendMessage'));
    assert.ok(sendCall && sendCall.url.includes('/p/3/sendMessage'), 'the down sender (id 1) is skipped even when listed in the fleet; id 3 is used instead');
    ok('the down sender is still excluded from the fleet pick (safety invariant preserved)');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
