'use strict';
/**
 * @requires-summary-line
 * The refused-price hold reaches the desk LIVE on WhatsApp (verification judgement of 29d9ffb, 26 Sep).
 * When the engine stops sending a price because the portal refused it - refusal_unrecognised (wording
 * no classifier knows) or refused_price_bound (a known wall) - the customer's group is told so they
 * can bid by hand, once per load per round, in the owner-approved terse pattern: one line naming the
 * portal's refusal cut short, then the OA No and route lines.
 *
 *   node scripts/test-refused-hold-desk-notice.js
 */
const H = require('./lib/walk-harness');
const { toNotification, notifyEngineEvent, ERROR_KINDS } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

const EXPECTED = 5;
const GROUP = '120363222222222222@g.us';
const ID = '25831999';
const KINDS = ['refusal_unrecognised', 'refused_price_bound'];

const evt = (kind, over) => Object.assign({ type: 'alert', level: kind === 'refusal_unrecognised' ? 'error' : 'warn', kind, auctionId: ID,
  lane: { origin: 'Tumkuru', destination: 'Hyderabad' }, companyName: 'Havells India', branchName: null,
  price: 27_925, refusals: 1, bound: 1, attemptBudget: 3, round: 0, refusal: 'Something went wrong, please try again' }, over);

function rig() {
  const sends = [];
  const transport = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    sends.push({ to: String(body.to_number), message: body.message || '' });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `m${sends.length}` } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const recipients = [{ name: 'Havells group', phone: GROUP, alerts: ['desk_notice', 'error'], scope: { shippers: ['Havells'] } }];
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => recipients, healthProvider: async () => true });
  return { notifier, sends, toGroup: () => sends.filter((s) => s.to === GROUP) };
}

const expected = (reason) => ['📌 *Not bidding - Havells India: the portal refused our bid (' + reason + '). Bid it by hand if you want it.*',
  `🆔 *OA No* - ${ID}`, '📍 Tumkuru -> Hyderabad'].join('\n');

(async () => {
  console.log('refused-price hold: live desk notice on WhatsApp');

  await H.check('both kinds are desk notices (not errors), keyed once per load per round', async () => {
    const bad = [];
    for (const k of KINDS) {
      if (ERROR_KINDS.has(k)) bad.push(`${k} is still an error kind`);
      const a = toNotification(evt(k));
      const b = toNotification(evt(k, { round: 1 }));
      if (!a || a.kind !== 'desk_notice') { bad.push(`${k} routed as ${a && a.kind}`); continue; }
      // The held price joins the key (regression scan of f78ba5d, B).
      if (a.dedupeKey !== `${ID}_notice_${k}_r0_27925` || b.dedupeKey !== `${ID}_notice_${k}_r1_27925`) bad.push(`${k} keys ${a.dedupeKey} / ${b.dedupeKey}`);
    }
    return bad.join('; ') || null;
  });

  for (const k of KINDS) {
    await H.check(`${k}: delivered to the customer group in the terse form; a repeat in the same round is not re-sent, the next round is`, async () => {
      const r = rig();
      await notifyEngineEvent(r.notifier, evt(k));
      await notifyEngineEvent(r.notifier, evt(k));
      const bad = [];
      const got = r.toGroup();
      if (got.length !== 1) bad.push(`${got.length} messages for one round, expected 1`);
      else if (got[0].message.trim() !== expected('Something went wrong, please try again')) bad.push(`expected ${JSON.stringify(expected('Something went wrong, please try again'))}, got ${JSON.stringify(got[0].message)}`);
      await notifyEngineEvent(r.notifier, evt(k, { round: 1 }));
      if (r.toGroup().length !== 2) bad.push(`${r.toGroup().length} messages after a new round, expected 2`);
      return bad.join('; ') || null;
    });
  }

  await H.check('the portal\'s reason is cut short: a long refusal is trimmed to 60 characters ending in "..."', async () => {
    const r = rig();
    const long = 'Validation failed: the quote could not be submitted because   the enquiry configuration changed while you were editing it';
    await notifyEngineEvent(r.notifier, evt('refusal_unrecognised', { refusal: long }));
    const m = r.toGroup()[0];
    const inner = m && /refused our bid \((.*)\)\. Bid it by hand/.exec(m.message);
    if (!inner) return `message ${m && m.message}`;
    return inner[1].length <= 60 && inner[1].endsWith('...') && !/\s{2}/.test(inner[1]) ? null : `reason shown as "${inner[1]}" (${inner[1].length} chars)`;
  });

  await H.check('the engine emits the hold notice once per round with its round and the portal\'s words (GoComet, a refusal no classifier knows)', async () => {
    const TRANSIENT = { status: 400, reason: 'Something went wrong, please try again', text: 'Something went wrong, please try again' };
    const x = H.load({ platform: 'gc', band: { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 }, walk: H.WALK_OFF,
      gc: { roundPolicy: { finalAfterExtensions: null } } });
    x.seedStanding(0, 3);
    for (let i = 0; i < 20; i++) x.ctrl.refuse.push(TRANSIENT);
    for (const cd of [60_000, 19_500, 7_500, 6_500, 6_000, 5_500, 5_000, 3_000]) await x.at(cd, { rank: 2 });
    await x.extend(300_000, 200_000, { rank: 2 });
    for (const cd of [60_000, 19_500, 7_500, 6_500, 6_000, 5_500, 5_000, 3_000]) await x.at(cd, { rank: 2 });
    x.done();
    const ev = x.events.filter((e) => e.type === 'alert' && KINDS.includes(e.kind));
    const bad = [];
    if (JSON.stringify(ev.map((e) => e.round)) !== '[0,1]') bad.push(`hold notices for rounds ${JSON.stringify(ev.map((e) => e.round))} (${JSON.stringify(x.trace())}), expected [0,1]`);
    if (ev.length && ev[0].refusal !== 'Something went wrong, please try again') bad.push(`refusal text ${JSON.stringify(ev[0].refusal)}`);
    return bad.join('; ') || null;
  });

  H.finish('refused-price hold desk notice', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
