'use strict';
/**
 * W1-5 V1-F02: THE FAILOVER `others` LOOP MUST MATCH THE HEALTHY PATH'S GROUP-TAKES-IT PARITY.
 *
 * Regression target: `_failoverDeliver`'s individual-DM loop (the `others` tier) runs unconditionally
 * once channel groups have been tried, while the healthy path (`_whatsapp`) only reaches its own
 * `others` delivery when `channelGroups.length === 0 || groupSent === 0` - i.e. only a price ask, or
 * a case where no scoped group actually took the message. Under a down sender, an unscoped recipient
 * subscribed to BOTH desk_notice and error therefore gets the desk_notice failover DM (redundant -
 * their group already got it via a sibling) AND the separate ops-mirror error failover DM: two
 * messages for one event, against one when the sender is healthy.
 *
 * Fix: the `others` tier in `_failoverDeliver` runs only when `kind === 'price_needed'` (price asks
 * keep their existing behaviour - money on the table, never hold back a fallback) or no channel group
 * was actually delivered. This never drops a message the healthy path would have sent; it only
 * removes a DM the healthy path would also have skipped.
 *
 * Modelled on scripts/test-tick-fault-handoff-sender-down.js's rig (must stay green, unmodified).
 *
 *   node scripts/test-failover-others-parity.js
 */
const assert = require('assert');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

const PRIMARY = '128023';
const SIBLING = '136151';
const GROUP = '120363222222222222@g.us';
const PERSON = '919000000009';
const ID = '26100003';
const FAULT_SINCE = 1_790_000_000_000;

const handoffEvt = () => ({
  type: 'alert', level: 'error', kind: 'tick_fault_handoff', auctionId: ID,
  faultSince: FAULT_SINCE, consecutiveFaults: 3, landedBids: 0, standingBidPrice: null, myRank: 2,
  closesAt: FAULT_SINCE + 600_000,
  detail: `Load ${ID}: 3 checks in a row failed on our side, so we stopped bidding this load and asked the desk to bid it by hand.`,
  lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies',
  branchName: null, laneCells: null,
});

function mkRig({ healthy }) {
  const sends = [];
  const transport = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sends.push({ via: PRIMARY, to: String(body.to_number) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `p${sends.length}` } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: PRIMARY });
  const sibling = {
    phoneId: SIBLING, enabled: () => true, sessionHealthy: async () => true,
    sendText: async (to) => { sends.push({ via: SIBLING, to: String(to) }); return { ok: true, messageId: `s${sends.length}` }; },
  };
  const senderFleet = { pickForGroup: async (jid) => (jid === GROUP ? sibling : null), pickForDm: async () => sibling };
  // ONE unscoped person subscribed to BOTH the desk notice and the error class - exactly the
  // dossier's shape (a real assignments row with alerts:['desk_notice','error'] and no scope).
  const recipients = [
    { name: 'Waaree group', phone: GROUP, alerts: ['desk_notice', 'error'], scope: { shippers: ['Waaree'] } },
    { name: 'Ops person', phone: PERSON, alerts: ['desk_notice', 'error'] },
  ];
  const store = new MemoryStore();
  const notifier = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
    recipientsProvider: async () => recipients,
    healthProvider: async () => healthy,
    senderFleet,
  });
  return { notifier, sends, toPerson: () => sends.filter((s) => s.to === PERSON) };
}

(async () => {
  console.log('\nFailover DM parity with the healthy group-takes-it path\n');

  const healthyRig = mkRig({ healthy: true });
  await notifyEngineEvent(healthyRig.notifier, handoffEvt());
  const healthyCount = healthyRig.toPerson().length;
  assert.strictEqual(healthyCount, 1,
    `harness: with the sender healthy the unscoped person must get exactly 1 message (the ops mirror only), got ${healthyCount}`);
  ok(1, 'harness: with a healthy sender, the unscoped desk_notice+error subscriber gets exactly 1 message');

  const downRig = mkRig({ healthy: false });
  await notifyEngineEvent(downRig.notifier, handoffEvt());
  const downCount = downRig.toPerson().length;
  assert.strictEqual(downCount, healthyCount,
    `with the sender down, the unscoped desk_notice+error subscriber got ${downCount} message(s) for one hand-off, `
    + `expected ${healthyCount} (parity with the healthy path) - the failover others loop must not also DM this `
    + 'person on the desk_notice call once the Waaree group already took it via a sibling');
  ok(2, 'with the sender down, the failover others loop matches the healthy path: exactly one message, not two');

  console.log(`\nPASS - ${pass} checks`);
})().catch((e) => {
  console.error('\nFAIL -', (e && e.stack) || e);
  process.exit(1);
});
