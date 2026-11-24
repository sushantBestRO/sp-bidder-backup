'use strict';
/**
 * TICK-FAULT HAND-OFF WHILE THE SENDER IS DOWN - the one message telling the desk to bid a live load
 * by hand is delivered by the price ask's failover chain, not dropped.
 *
 * Regression target: review finding on fix/timer-lifecycle-orphans (blocking), against fca118e.
 *   sibling: scripts/test-tick-fault-notifier-delivery.js (the same hand-off with a healthy sender)
 *   sibling: scripts/test-price-ask-failover.js (the failover chain itself, for price_needed)
 *
 * While the WhatsApp sender is confirmed down, notifier HEALTH_POLICY drops desk_notice and error,
 * because the load's no-bid receipt at close repeats them. The tick-fault hand-off stops the load and
 * writes no receipt, so under a down sender both its messages - the desk_notice to the customer group
 * and the ops mirror sent as 'error' - were discarded and nothing ever re-sent them.
 *
 * Chain under test: an engine-shaped tick_fault_handoff event -> engineAlerts.notifyEngineEvent ->
 * real Notifier over a MemoryStore, healthProvider reporting the primary DOWN, a stub sender fleet, and
 * stub owner and email channels.
 *
 * WHAT MUST NOT MOVE:
 *   - the hand-off reaches the customer group once via a sibling in that group, marked sent (check 1);
 *   - with no sibling it steps down to the desk owner, then to email, in hand-off wording (check 2);
 *   - the ops mirror reaches the unscoped ops DM (check 3);
 *   - a notice delivered by a sibling records no ask thread for the load (check 4);
 *   - any other desk_notice still drops while the sender is down (check 5, control);
 *   - price_needed fails over exactly as before (check 6, control).
 *
 * Offline and deterministic: MemoryStore, capturing transport, no network, no waits.
 *
 *   node scripts/test-tick-fault-handoff-sender-down.js
 */
const assert = require('assert');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier, DEDUPE_COLLECTION } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { getAskFor } = require('../src/notify/askThread');
const { MemoryStore } = require('../src/store');

let pass = 0;
const failures = [];

class SetupError extends Error {}
const setup = (cond, msg) => { if (!cond) throw new SetupError('SETUP: ' + msg); };

const PRIMARY = '128023';
const SIBLING = '136151';
const GROUP = '120363222222222222@g.us';
const OPS = '919000000001';
const OWNER = { personId: 'p1', name: 'Desk Owner', phone: '919000000002' };
const ID = '26100001';
const FAULT_SINCE = 1_790_000_000_000;
const HANDOFF_KEY = `${ID}_notice_tick_fault_handoff_${FAULT_SINCE}`;

const handoffEvt = () => ({
  type: 'alert', level: 'error', kind: 'tick_fault_handoff', auctionId: ID,
  faultSince: FAULT_SINCE, consecutiveFaults: 3, landedBids: 0, standingBidPrice: null, myRank: 2,
  closesAt: FAULT_SINCE + 600_000,
  detail: `Load ${ID}: 3 checks in a row failed on our side, so we stopped bidding this load and asked the desk to bid it by hand.`,
  lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies',
  branchName: null, laneCells: null,
});

const lastResortEvt = () => ({
  type: 'alert', level: 'warn', kind: 'last_resort_floor_fired', auctionId: ID,
  remainingMs: 1_500, myRank: 1, landedBids: 1, floor: 29_300,
  detail: 'every soft-close defend path held on the final tick with the floor rung unspent - sent 29300 rather than forfeiting the load',
  lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies', branchName: null,
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
    { name: 'Ops', phone: OPS, alerts: ['error'] },
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
  await notifyEngineEvent(main.notifier, handoffEvt());
  setup(main.to(PRIMARY).length === 0 && main.sends.every((s) => s.via !== PRIMARY),
    'nothing may be posted on the primary while it probes down');

  await check(1, 'sender down, a sibling is in the customer group: the group gets the hand-off once, marked sent', async () => {
    const toGroup = main.to(GROUP);
    assert.strictEqual(toGroup.length, 1,
      `the customer group received ${toGroup.length} hand-off message(s) with the sender down; expected 1 via the `
      + 'sibling. 0 = the desk_notice was dropped at the health gate (HEALTH_POLICY desk_notice:drop) instead of '
      + 'taking the failover chain, so the desk is never told to bid the stopped load by hand');
    assert.strictEqual(toGroup[0].via, SIBLING, 'the group hand-off goes out on the sibling in that group');
    assert.ok(toGroup[0].message.includes(ID), `the group hand-off names load ${ID}`);
    assert.ok(await main.store.getDoc(DEDUPE_COLLECTION, HANDOFF_KEY),
      `the failover delivery marks ${HANDOFF_KEY} sent, so recovery does not re-send it`);
    assert.strictEqual(main.to(OWNER.phone).length, 0, 'a group reached by a sibling does not also DM the owner');
    assert.strictEqual(main.emails.length, 0, 'a group reached by a sibling does not also email');
  });

  await check(2, 'no sibling in the group: the owner DM carries the notice; with no owner, email fires without PRICE NEEDED', async () => {
    const own = mkRig({ siblingInGroup: false, owners: [OWNER] });
    await notifyEngineEvent(own.notifier, handoffEvt());
    const dm = own.to(OWNER.phone);
    assert.strictEqual(dm.length, 1,
      `the desk owner received ${dm.length} DM(s) for the hand-off with no sibling in the group; expected 1. `
      + '0 = the hand-off never entered the failover chain under a down sender');
    assert.ok(dm[0].message.includes(ID), `the owner DM names load ${ID}`);
    assert.ok(!/\bask\b/i.test(dm[0].message), `the owner DM for a hand-off must not call it an ask:\n${dm[0].message}`);
    assert.strictEqual(own.to(GROUP).length, 0, 'nothing is posted into a group no live sender is verified in');

    const mail = mkRig({ siblingInGroup: false, owners: [] });
    await notifyEngineEvent(mail.notifier, handoffEvt());
    assert.strictEqual(mail.emails.length, 1,
      `${mail.emails.length} email(s) for a hand-off with no sibling and no owner; expected 1 (the last-resort tier)`);
    assert.ok(!/PRICE NEEDED/.test(mail.emails[0].subject || ''),
      `the hand-off email subject must not say PRICE NEEDED: "${mail.emails[0].subject}"`);
  });

  await check(3, 'sender down: the ops mirror reaches the unscoped ops DM', async () => {
    const toOps = main.to(OPS);
    assert.strictEqual(toOps.length, 1,
      `ops received ${toOps.length} hand-off mirror(s) with the sender down; expected 1 via a healthy DM sibling. `
      + '0 = the error mirror was dropped at the health gate (HEALTH_POLICY error:drop)');
    assert.strictEqual(toOps[0].via, SIBLING, 'the ops mirror goes out on the healthy sibling');
    assert.ok(toOps[0].message.includes(ID), `the ops mirror names load ${ID}`);
  });

  await check(4, 'a sibling-delivered hand-off records no ask thread for the load', async () => {
    assert.strictEqual(main.to(GROUP).length, 1, 'no sibling group delivery happened (check 1), so there is nothing to inspect');
    const thread = await getAskFor(main.store, ID, GROUP);
    assert.strictEqual(thread, null,
      `an ask anchor was recorded for load ${ID} in ${GROUP} off the hand-off notice; the price ask's thread must `
      + 'stay untouched (recordAsk is for price_needed only)');
  });

  await check(5, 'control: another desk_notice still drops while the sender is down', async () => {
    const up = mkRig({ healthy: true });
    await notifyEngineEvent(up.notifier, lastResortEvt());
    setup(up.to(GROUP).length === 1, 'last_resort_floor_fired must reach the group when the sender is healthy');
    const down = mkRig({ owners: [OWNER] });
    await notifyEngineEvent(down.notifier, lastResortEvt());
    assert.deepStrictEqual(down.sends.map((s) => `${s.via}->${s.to}`), [],
      'last_resort_floor_fired under a down sender must still be dropped, on every route');
    assert.strictEqual(down.emails.length, 0, 'and must not be emailed');
  });

  await check(6, 'control: price_needed under a down sender still fails over to a PRICE NEEDED email', async () => {
    const r = mkRig({ siblingInGroup: false, owners: [] });
    const res = await r.notifier.requestPrice({ id: 'rq1', loadId: 'Lrq1',
      load: { lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree Energies', closesAt: FAULT_SINCE + 600_000 } });
    assert.strictEqual(r.emails.length, 1, `price_needed with no sibling and no owner sent ${r.emails.length} email(s); expected 1`);
    assert.ok(/PRICE NEEDED/.test(r.emails[0].subject || ''), `the price ask email subject says PRICE NEEDED: "${r.emails[0].subject}"`);
    assert.ok(res && res.delivered === true, 'an emailed ask counts as delivered');
  });

  if (failures.length) {
    console.error(`\nFAILED checks: ${failures.join(', ')} (${pass}/6 passed) - the tick-fault hand-off is not delivered `
      + 'while the WhatsApp sender is down (desk_notice/error drop instead of failover)');
    process.exit(1);
  }
  const EXPECTED = 6;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
