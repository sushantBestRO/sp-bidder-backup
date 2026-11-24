'use strict';
/**
 * @requires-summary-line
 * Regression scan of f78ba5d (26 Sep) on the refused-price hold's desk notice.
 *
 * A  a bid of ours standing at rank 1: no desk notice (telling the desk to bid by hand would have it
 *    undercut our own L1 on the shared login). Standing but not rank 1, or rank unknown: the variant
 *    "Our bid stands - ..." line. No bid standing: the approved "Not bidding" line, unchanged.
 * B  the notifier key carries the held price: a second hold at a new price in the same round (after a
 *    desk re-price) is not dropped; the same price held twice in a round is sent once.
 * C  the portal's words are shown only when they are plain text: HTML, JSON or a bare http_<status>
 *    drop the parenthesis.
 * D  after a restart restores a refused mid-ladder price, holding it marks that rung spent as a live
 *    refusal does, so the next lower rung still goes out (walk off) instead of only the floor.
 *
 *   node scripts/test-refused-hold-standing-bid.js
 */
const H = require('./lib/walk-harness');
const { toNotification, notifyEngineEvent } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');

const EXPECTED = 8;
const KINDS = ['refusal_unrecognised', 'refused_price_bound'];
const BAND_GC = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };
const GROUP = '120363222222222222@g.us';
const ID = '25831999';

function seedRefused(r, price, unrecognised) {
  r.m._refusedPrice = price;
  r.m._refusedPriceVcq = null;
  r.m._refusedPriceCount = 3;
  r.m._refusedPriceUnrecognised = unrecognised;
  r.m._refusedPriceBody = 'Quote could not be updated';
}
const holds = (r) => r.events.filter((e) => e.type === 'alert' && KINDS.includes(e.kind));

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
  return { notifier, toGroup: () => sends.filter((s) => s.to === GROUP) };
}
const evt = (kind, over) => Object.assign({ type: 'alert', level: 'warn', kind, auctionId: ID,
  lane: { origin: 'Tumkuru', destination: 'Hyderabad' }, companyName: 'Havells India', branchName: null,
  price: 27_925, round: 0, refusal: 'Quote could not be updated', landedBids: 0, myRank: null }, over);
const headline = async (e) => {
  const r = rig();
  await notifyEngineEvent(r.notifier, e);
  const m = r.toGroup()[0];
  return m ? m.message.split('\n')[0] : null;
};

(async () => {
  console.log('refused-price hold: standing bid, notifier key, plain words, restored mid-ladder rung');

  await H.check('A: our bid standing at rank 1 - a refused floor hold sends no hold notice (GoComet pre-emptive floor at L1, SP floor at L1; both kinds)', async () => {
    const bad = [];
    for (const unrecognised of [true, false]) {
      const gc = H.load({ platform: 'gc', band: BAND_GC, walk: H.walkCfg('gc'), gc: Object.assign({ preEmptiveFloorAtRankOne: true }, FINAL_NOW) });
      gc.seedStanding(0, 2);
      seedRefused(gc, 50_900, unrecognised);
      for (const cd of [19_500, 12_000, 7_500, 7_000, 6_500, 5_000, 3_000]) await gc.at(cd, { rank: 1 });
      gc.done();
      if (!(gc.m.noBid)) bad.push(`GC ${unrecognised}: HARNESS: no hold happened`);
      if (holds(gc).length) bad.push(`GC ${unrecognised ? 'unrecognised' : 'bound'}: ${holds(gc).length} hold notice(s) with our bid at rank 1`);
      const sp = H.load({ sp: { revisionLimit: 3 }, walk: H.WALK_OFF });
      sp.seedStanding(1, 2);
      seedRefused(sp, sp.ladder[sp.ladder.length - 1], unrecognised);
      for (const cd of [25_000, 9_700, 9_500, 6_000, 4_000, 3_000, 2_400, 1_200]) await sp.at(cd, { rank: 1 });
      sp.done();
      if (holds(sp).length) bad.push(`SP ${unrecognised ? 'unrecognised' : 'bound'}: ${holds(sp).length} hold notice(s) with our bid at rank 1`);
    }
    return bad.join('; ') || null;
  });

  await H.check('A: the hold notice carries landedBids and myRank (standing at L3, SP and GoComet)', async () => {
    const bad = [];
    const sp = H.load({ sp: { revisionLimit: 3 }, walk: H.WALK_OFF });
    sp.seedStanding(1, 2);
    seedRefused(sp, sp.ladder[sp.ladder.length - 1], false);
    for (const cd of [25_000, 9_700, 9_500, 6_000, 4_000, 3_000, 2_400, 1_200]) await sp.at(cd, { rank: 3 });
    sp.done();
    const gc = H.load({ platform: 'gc', band: BAND_GC, walk: H.WALK_OFF, gc: FINAL_NOW });
    gc.seedStanding(0, 1);
    seedRefused(gc, 50_900, true);
    for (const cd of [19_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await gc.at(cd, { rank: 3 });
    gc.done();
    for (const [name, r] of [['SP', sp], ['GC', gc]]) {
      const e = holds(r)[0];
      if (!e) { bad.push(`${name}: no hold notice`); continue; }
      if (!(e.landedBids > 0 && e.myRank === 3)) bad.push(`${name}: landedBids ${e.landedBids}, myRank ${e.myRank}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('A: rendered headlines - standing at L3 and at an unknown rank get the variant; no bid gets the approved line (both kinds)', async () => {
    const bad = [];
    const variant = 'Our bid stands - Havells India: the portal refused our lower price (Quote could not be updated). Bid it by hand if you want it.';
    const notBidding = 'Not bidding - Havells India: the portal refused our bid (Quote could not be updated). Bid it by hand if you want it.';
    for (const k of KINDS) {
      for (const [label, over, want] of [['L3', { landedBids: 1, myRank: 3 }, variant], ['rank unknown', { landedBids: 1, myRank: null }, variant],
        ['no bid', { landedBids: 0, myRank: null }, notBidding]]) {
        const got = await headline(evt(k, over));
        if (got !== `📌 *${want}*`) bad.push(`${k} ${label}: ${JSON.stringify(got)}`);
      }
    }
    return bad.join('; ') || null;
  });

  await H.check('B: the key carries the held price - a second hold at a new price in the same round is sent, the same price twice is sent once', async () => {
    const bad = [];
    for (const k of KINDS) {
      const r = rig();
      await notifyEngineEvent(r.notifier, evt(k, { price: 50_900 }));
      await notifyEngineEvent(r.notifier, evt(k, { price: 50_900 }));
      await notifyEngineEvent(r.notifier, evt(k, { price: 48_000 }));
      if (r.toGroup().length !== 2) bad.push(`${k}: ${r.toGroup().length} messages, expected 2`);
      const key = toNotification(evt(k, { price: 50_900 })).dedupeKey;
      if (!key.includes('50900')) bad.push(`${k}: key ${key} has no price`);
    }
    return bad.join('; ') || null;
  });

  await H.check('C: HTML, JSON and a bare http_400 drop the parenthesis; plain words are kept', async () => {
    const bad = [];
    const plain = 'Not bidding - Havells India: the portal refused our bid. Bid it by hand if you want it.';
    for (const refusal of ['<html><body>502 Bad Gateway</body></html>', '{"error":"bad request"}', '[1,2]', 'http_400', '   ']) {
      const got = await headline(evt('refusal_unrecognised', { refusal }));
      if (got !== `📌 *${plain}*`) bad.push(`${JSON.stringify(refusal)} -> ${JSON.stringify(got)}`);
    }
    const kept = await headline(evt('refused_price_bound', { refusal: 'Quote could not be updated' }));
    if (!kept || !kept.includes('(Quote could not be updated)')) bad.push(`plain text dropped: ${kept}`);
    return bad.join('; ') || null;
  });

  await H.check('D: SP walk off - a restored refused top rung held at establish, the next lower rung (96,839) still goes out before the floor', async () => {
    const r = H.load({ sp: { revisionLimit: 10 }, walk: H.WALK_OFF });
    seedRefused(r, r.ladder[0], false);
    for (let cd = 30_000; cd >= 200; cd -= 200) await r.at(cd, { rank: 2 });
    r.done();
    const i = r.writes.findIndex((w) => w.price === r.ladder[1]);
    const f = r.writes.findIndex((w) => w.price === r.ladder[r.ladder.length - 1]);
    return i >= 0 && (f < 0 || i < f) ? null : `the lower rung never went ahead of the floor: ${JSON.stringify(r.trace())}`;
  });

  await H.check('D: GoComet walk off - a restored refused middle price held in the middle band, the next lower price (51,800) still goes out', async () => {
    const r = H.load({ platform: 'gc', band: { cost: 50_000, marginsPct: [9, 7.2, 3.6, 1.8], minMarginPct: 1 }, walk: H.WALK_OFF, gc: FINAL_NOW });
    r.seedStanding(0, 3);
    seedRefused(r, r.ladder[1], false);
    for (let cd = 30_000; cd >= 200; cd -= 500) await r.at(cd, { rank: 2 });
    r.done();
    return r.writes.some((w) => w.price === r.ladder[2]) ? null : `51,800 never went: ${JSON.stringify(r.trace())}`;
  });

  await H.check('D control: walk on already reaches the lower prices from the same restored state (unchanged)', async () => {
    const r = H.load({ sp: { revisionLimit: 10 }, walk: H.walkCfg('sp', { stepTimeMs: 2_500 }) });
    seedRefused(r, r.ladder[0], false);
    for (let cd = 30_000; cd >= 200; cd -= 200) await r.at(cd, { rank: 2 });
    r.done();
    return r.writes.some((w) => w.price === r.ladder[1]) ? null : `walk on: ${JSON.stringify(r.trace())}`;
  });

  H.finish('refused-hold regression scan fixes', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
