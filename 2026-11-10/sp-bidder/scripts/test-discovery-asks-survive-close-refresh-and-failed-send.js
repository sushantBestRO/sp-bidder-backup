'use strict';
/**
 * Discovery keeps retrying a price ask and a reminder that WhatsApp did not deliver.
 *
 *   1. A request whose ask was skipped (session down) is re-asked on the tick where its close also
 *      moved out. The close refresh re-reads the request first, and the re-ask must follow on that
 *      fresh read.
 *   2. A reminder that WhatsApp did not deliver is not marked sent, so the next tick tries again.
 *
 * Nothing pinned either (mutation critique, PR-1).
 *
 *   node scripts/test-discovery-asks-survive-close-refresh-and-failed-send.js
 */
const assert = require('assert');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

function stubNotifier() {
  const n = { deliver: false, asks: [], reminders: [] };
  n.requestPrice = async (r) => { n.asks.push(r.loadId); return { delivered: n.deliver }; };
  n.remindApproaching = async (r) => { n.reminders.push(r.loadId); return { delivered: n.deliver }; };
  n.alert = async () => ({ delivered: true });
  return n;
}

(async () => {
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 3 });
    const load = { id: 'L1', companyName: 'Acme', lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 3_600_000,
      softClose: true, closeModelKnown: true, equipment: '32ft', units: 1 };
    const adapter = {
      listAuctions: async () => [{ ...load }],
      capabilities: () => ({ closeModel: 'soft', extensionCeiling: null, extensionIncrementMs: 300_000 }),
    };
    const notifier = stubNotifier();
    const disco = new DiscoveryPoller({ adapter, requests, notifier, log: () => {},
      config: { allowlist: { shippers: ['Acme'], hardCloseOnly: false }, priceDeadlineLeadMs: 90_000 } });

    await disco.tick();
    assert.strictEqual((await requests.getByLoad('L1')).notified, false, 'the first ask was marked delivered while the session was down');

    load.closesAt += 120_000;
    notifier.deliver = true;
    await disco.tick();
    const req = await requests.getByLoad('L1');
    assert.strictEqual(req.load.liveClosesAt, load.closesAt, `the close refresh did not land: ${JSON.stringify(req.load)}`);
    assert.deepStrictEqual(notifier.asks, ['L1', 'L1'], `asks sent: ${JSON.stringify(notifier.asks)}`);
    assert.strictEqual(req.notified, true, 'the re-ask on the refreshed request was not marked delivered');
    ok(1, 'a skipped ask is re-sent on the tick its close moves out');
  }

  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 3 });
    const load = { id: 'L2', companyName: 'Acme', lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 3_600_000,
      softClose: false, closeModelKnown: true, equipment: '32ft', units: 1 };
    const adapter = { listAuctions: async () => [{ ...load }] };
    const notifier = stubNotifier();
    notifier.deliver = true;
    const disco = new DiscoveryPoller({ adapter, requests, notifier, log: () => {},
      config: { allowlist: { shippers: ['Acme'], hardCloseOnly: true }, priceDeadlineLeadMs: 90_000, reminderLeadMs: 120_000 } });

    await disco.tick();
    const created = await requests.getByLoad('L2');
    assert.strictEqual(created.notified, true);
    await store.patchDoc('priceRequests', created.id, { deadlineAt: Date.now() + 60_000, notifiedAt: Date.now() - 3_600_000 });

    notifier.deliver = false;
    await disco.tick();
    assert.deepStrictEqual(notifier.reminders, ['L2'], `reminders sent: ${JSON.stringify(notifier.reminders)}`);
    assert.ok(!(await requests.getByLoad('L2')).reminderSentAt, 'an undelivered reminder was marked sent');
    ok(2, 'an undelivered reminder is not marked sent');

    notifier.deliver = true;
    await disco.tick();
    assert.deepStrictEqual(notifier.reminders, ['L2', 'L2'], `reminders sent: ${JSON.stringify(notifier.reminders)}`);
    assert.ok((await requests.getByLoad('L2')).reminderSentAt, 'the delivered retry was not marked sent');
    ok(3, 'the next tick retries it and marks it once delivered');
  }

  console.log(`\n${pass}/3 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
