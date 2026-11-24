'use strict';
/**
 * W1-8 F4: A BY-HAND bid_not_sent NOTICE MUST REACH THE DESK EVEN WHILE THE WHATSAPP SENDER IS DOWN.
 *
 * Regression target: engineAlerts.DELIVER_WHEN_SENDER_DOWN names only 'tick_fault_handoff', so a
 * by-hand bid_not_sent (the pre-wire stand-down notice - see W1-8 F2) drops under HEALTH_POLICY's
 * desk_notice:'drop' while the sender is down. tick_fault_handoff takes the failover route for the
 * exact reason a by-hand stand-down shares: the load has stopped bidding and there is no later
 * close receipt to repeat the fact - a dropped notice here is gone for good, not merely late.
 *
 * Modelled directly on scripts/test-tick-fault-handoff-sender-down.js's rig (must stay green,
 * unmodified) - a by-hand notice should be delivered by the exact same failover chain, in the exact
 * same order (sibling in group -> owner DM -> email).
 *
 *   node scripts/test-bidnotsent-byhand-sender-down.js
 */
const assert = require('assert');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier, DEDUPE_COLLECTION } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

let pass = 0;
const failures = [];

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const PRIMARY = '128023';
const SIBLING = '136151';
const GROUP = '120363222222222222@g.us';
const OWNER = { personId: 'p1', name: 'Desk Owner', phone: '919000000002' };
const ID = '26100002';
const STAND_DOWN_AT = 1_790_000_000_000;
const BYHAND_KEY = `${ID}_notice_bid_not_sent_by_hand_${STAND_DOWN_AT}`;

const byHandEvt = () => ({
  type: 'alert', level: 'warn', kind: 'bid_not_sent', byHand: true, standDownAt: STAND_DOWN_AT,
  auctionId: ID, lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies',
  branchName: null, price: 41_420, landedBids: 0,
  detail: 'a bid was stopped before it was sent and would be stopped again on every try, so the load was handed to the desk',
});

// A retry notice (byHand:false) on the same rate-limit cooldown class - must NOT gain a failover
// route from this fix: the load keeps retrying, so a dropped retry notice is not the desk's last
// word on the load the way a by-hand stand-down is.
const retryEvt = () => ({
  type: 'alert', level: 'warn', kind: 'bid_not_sent', byHand: false, rateLimitEpisode: STAND_DOWN_AT,
  auctionId: ID, lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies',
  branchName: null, price: 41_420, landedBids: 0,
  detail: 'a bid was stopped before it was sent, so nothing was placed on the portal',
});

function mkRig({ healthy = false, siblingInGroup = true, owners = [], withEmail = true } = {}) {
  const sends = [];
  const emails = [];
  const transport = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sends.push({ via: PRIMARY, to: String(body.to_number), message: body.message || '' });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `p${sends.length}` } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: PRIMARY });
  const sibling = {
    phoneId: SIBLING, enabled: () => true, sessionHealthy: async () => true,
    sendText: async (to, message) => {
      sends.push({ via: SIBLING, to: String(to), message: message || '' });
      return { ok: true, messageId: `s${sends.length}` };
    },
  };
  const senderFleet = {
    pickForGroup: async (jid) => (siblingInGroup && jid === GROUP ? sibling : null),
    pickForDm: async () => sibling,
  };
  const recipients = [
    { name: 'Waaree group', phone: GROUP, alerts: ['desk_notice', 'error', 'price_needed'], scope: { shippers: ['Waaree'] } },
  ];
  const store = new MemoryStore();
  const notifier = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
    recipientsProvider: async () => recipients,
    healthProvider: async () => healthy,
    senderFleet,
    ownersProvider: async () => owners,
    fallbackAlert: withEmail ? async (a) => { emails.push(a); return { ok: true }; } : null,
  });
  return {
    notifier, store, sends, emails,
    to: (who) => sends.filter((s) => s.to === who),
  };
}

async function check(n, name, fn) {
  try {
    await fn();
    console.log(`  ok  ${n}. ${name}`);
    pass += 1;
  } catch (e) {
    if (e instanceof SetupError) throw e;
    console.log(`  FAIL ${n}. ${name}\n       ${e.message}`);
    failures.push(n);
  }
}

(async () => {
  const main = mkRig({ owners: [OWNER] });
  await notifyEngineEvent(main.notifier, byHandEvt());
  setup(main.to(PRIMARY).length === 0 && main.sends.every((s) => s.via !== PRIMARY),
    'nothing may be posted on the primary while it probes down');

  await check(1, 'sender down, a sibling is in the customer group: the group gets the by-hand notice once, marked sent', async () => {
    const toGroup = main.to(GROUP);
    assert.strictEqual(toGroup.length, 1,
      `the customer group received ${toGroup.length} by-hand message(s) with the sender down; expected 1 via the `
      + 'sibling. 0 = the desk_notice was dropped at the health gate (HEALTH_POLICY desk_notice:drop) instead of '
      + 'taking the failover chain, so the desk is never told the stood-down load needs bidding by hand');
    assert.strictEqual(toGroup[0].via, SIBLING, 'the by-hand notice goes out on the sibling in that group');
    assert.ok(toGroup[0].message.includes(ID), `the by-hand notice names load ${ID}`);
    assert.ok(await main.store.getDoc(DEDUPE_COLLECTION, BYHAND_KEY),
      `the failover delivery marks ${BYHAND_KEY} sent, so recovery does not re-send it`);
  });

  await check(2, 'no sibling in the group: the owner DM carries the notice; with no owner, email fires', async () => {
    const own = mkRig({ siblingInGroup: false, owners: [OWNER] });
    await notifyEngineEvent(own.notifier, byHandEvt());
    const dm = own.to(OWNER.phone);
    assert.strictEqual(dm.length, 1,
      `the desk owner received ${dm.length} DM(s) for the by-hand notice with no sibling in the group; expected 1. `
      + '0 = the notice never entered the failover chain under a down sender');
    assert.ok(dm[0].message.includes(ID), `the owner DM names load ${ID}`);
    assert.strictEqual(own.to(GROUP).length, 0, 'nothing is posted into a group no live sender is verified in');

    const mail = mkRig({ siblingInGroup: false, owners: [] });
    await notifyEngineEvent(mail.notifier, byHandEvt());
    assert.strictEqual(mail.emails.length, 1,
      `${mail.emails.length} email(s) for a by-hand notice with no sibling and no owner; expected 1 (the last-resort tier)`);
  });

  await check(3, 'control: the non-byHand retry notice still drops while the sender is down - this fix does not widen its failover', async () => {
    const down = mkRig({ owners: [OWNER] });
    await notifyEngineEvent(down.notifier, retryEvt());
    assert.deepStrictEqual(down.sends.map((s) => `${s.via}->${s.to}`), [],
      'a retry notice (byHand:false) under a down sender must still be dropped, on every route');
    assert.strictEqual(down.emails.length, 0, 'and must not be emailed');

    const up = mkRig({ healthy: true });
    await notifyEngineEvent(up.notifier, retryEvt());
    setup(up.to(GROUP).length === 1, 'the retry notice must still reach the group when the sender is healthy');
  });

  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/3 passed) - the by-hand bid_not_sent notice is not `
      + 'delivered while the WhatsApp sender is down');
    process.exit(1);
  }
  const EXPECTED = 3;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
