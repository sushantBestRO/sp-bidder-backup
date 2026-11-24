'use strict';
/**
 * @requires-summary-line
 * The raise-refused stand-down reaches the desk on WhatsApp (coordinator follow-up of 26 Sep, under the
 * price-page gate: a no-bid outcome is loud). bid_price_raise_refused is a desk notice routed like the
 * other stand-down notices, to the customer's group, once per load per round.
 *
 *   node scripts/test-raise-refused-desk-notice.js
 */
const H = require('./lib/walk-harness');
const { toNotification, notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

const EXPECTED = 4;
const GROUP = '120363222222222222@g.us';
const ID = '260925SQRC';
const GC_RAISE = "You've increased the quote price. Please add a remark explaining the change to continue";

const evt = (over) => Object.assign({ type: 'alert', level: 'warn', kind: 'bid_price_raise_refused', auctionId: ID,
  lane: { origin: 'Degam', destination: 'Madhav Solar' }, companyName: 'Waaree Energies', branchName: null,
  price: 25_070, amountCap: null, floor: 24_242, standingBid: null, landedBids: 0, standingQuote: 24_000, round: 0 }, over);

function rig() {
  const sends = [];
  const transport = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sends.push({ to: String(body.to_number), message: body.message || '' });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `m${sends.length}` } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const recipients = [{ name: 'Waaree group', phone: GROUP, alerts: ['desk_notice', 'error'], scope: { shippers: ['Waaree'] } }];
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => recipients, healthProvider: async () => true });
  return { notifier, sends, toGroup: () => sends.filter((s) => s.to === GROUP) };
}

(async () => {
  console.log('raise-refused stand-down: desk notice on WhatsApp');

  await H.check('it is a desk notice keyed once per load per round', async () => {
    const a = toNotification(evt());
    const b = toNotification(evt({ round: 1 }));
    if (!a || a.kind !== 'desk_notice') return `routed as ${a && a.kind}, expected desk_notice`;
    if (a.dedupeKey !== `${ID}_notice_bid_price_raise_refused_r0` || b.dedupeKey !== `${ID}_notice_bid_price_raise_refused_r1`) {
      return `keys ${a.dedupeKey} / ${b && b.dedupeKey}`;
    }
    return a.data.shipper === 'Waaree Energies' ? null : `scope shipper ${a.data.shipper}`;
  });

  await H.check('delivered to the customer group on WhatsApp: names the load and the standing quote; a repeat in the same round is not re-sent, the next round is', async () => {
    const r = rig();
    await notifyEngineEvent(r.notifier, evt());
    await notifyEngineEvent(r.notifier, evt());
    const bad = [];
    const first = r.toGroup();
    if (first.length !== 1) bad.push(`${first.length} messages to the group for one round, expected 1`);
    else {
      if (!first[0].message.includes(ID)) bad.push('the message does not name the load');
      const want = ['📌 *Not bidding - Waaree Energies: our lowest price (₹24,242) is above the quote already on our login (₹24,000). Check it on the portal.*',
        `🆔 *OA No* - ${ID}`, '📍 Degam -> Madhav Solar'].join('\n');
      if (first[0].message.trim() !== want) bad.push(`owner-approved terse wording (26 Sep) expected ${JSON.stringify(want)}, got ${JSON.stringify(first[0].message)}`);
    }
    await notifyEngineEvent(r.notifier, evt({ round: 1 }));
    if (r.toGroup().length !== 2) bad.push(`${r.toGroup().length} messages after a new round, expected 2`);
    return bad.join('; ') || null;
  });

  await H.check('the SuperProcure cap form names our lowest price and the cap (owner-approved terse form)', async () => {
    const r = rig();
    await notifyEngineEvent(r.notifier, evt({ amountCap: 51_650, standingQuote: 51_651, floor: 69_095, lane: { origin: 'Alwar', destination: 'Pune' } }));
    const m = r.toGroup()[0];
    const want = ['📌 *Not bidding - Waaree Energies: our lowest price (₹69,095) is above the portal\'s limit (₹51,650). Check it on the portal.*',
      `🆔 *OA No* - ${ID}`, '📍 Alwar -> Pune'].join('\n');
    return m && m.message.trim() === want ? null : `owner-approved terse wording expected ${JSON.stringify(want)}, got ${JSON.stringify(m && m.message)}`;
  });

  await H.check('the engine emits the notice once per round with its round, across a stand-down that a new round re-derives (walk off and on)', async () => {
    const bad = [];
    const script = async (x) => {
      x.ctrl.rank = 3;
      x.ctrl.refuse.push({ status: 422, reason: GC_RAISE, text: GC_RAISE, standingPrice: 50_000 });
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await x.at(cd, { rank: 3 });
      await x.extend(300_000, 200_000, { rank: 3 });
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await x.at(cd, { rank: 3 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 },
      gc: { roundPolicy: { finalAfterExtensions: null } } }, H.walkCfg('gc'), script);
    for (const [side, x] of [['walk off', off], ['walk on', on]]) {
      const ev = x.events.filter((e) => e.type === 'alert' && e.kind === 'bid_price_raise_refused');
      const rounds = ev.map((e) => e.round);
      if (JSON.stringify(rounds) !== JSON.stringify([0, 1])) bad.push(`${side}: notices for rounds ${JSON.stringify(rounds)}, expected [0,1]`);
    }
    return bad.join('; ') || null;
  });

  H.finish('raise-refused desk notice', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
