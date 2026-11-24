'use strict';
/**
 * @requires-summary-line
 * GoComet "You've increased the quote price" (HTTP 422) on a shared vendor login - live 260925SQRC,
 * 26 Sep 2026. Another writer on the same login held a lower quote; the refusal made the engine stand
 * down for the rest of the auction, a full extension round included, and its floor (24,242 x 2) was
 * never tried. Final rank 5.
 *
 * Owner ruling of 26 Sep (in line with W6, a refused step re-derives the next valid price): the next
 * price must be BELOW the standing quote. The standing quote is read from the refusal (the adapter's
 * write read the quote document just before the PUT). The engine continues with the next band price
 * below it, down to the lowest band price, within the attempts left; it stands down - with the
 * existing stand-down notice - only when no band price below the standing quote remains. A new round
 * (an observed extension) clears the stand-down latch. Walk on and walk off.
 *
 * Band: cost 50,000, margins 9 / 7.2 / 1.8, minimum 1 -> 54,500 / 53,600 / 50,900. The other
 * writer's standing quote is 53,000: below both upper prices, above the floor - the SQRC shape.
 *
 *   node scripts/test-gc-raise-refused-continues-below.js
 */
const H = require('./lib/walk-harness');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

const EXPECTED = 6;
const GC_RAISE = "You've increased the quote price. Please add a remark explaining the change to continue";
const BAND = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const FLOOR = 50_900;
const STANDING = 53_000;
const walkGc = H.walkCfg('gc');
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };
const UNCAPPED = { roundPolicy: { finalAfterExtensions: null } };
const raise = (standingPrice) => Object.assign({ status: 422, reason: GC_RAISE, text: GC_RAISE },
  standingPrice !== undefined ? { standingPrice } : {});

const afterRefusal = (r) => {
  const i = r.writes.findIndex((w) => w.refused);
  return i < 0 ? [] : r.writes.slice(i + 1);
};

(async () => {
  console.log('GoComet raise refusal on a shared login: continue below the standing quote');

  await H.check('SQRC, time permits: raise refused at the first price -> the floor goes in the SAME round, nothing at or above the standing quote (walk off and on)', async () => {
    const bad = [];
    const script = async (r) => {
      r.ctrl.rank = 3;
      r.ctrl.refuse.push(raise(STANDING));
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 3 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: BAND, gc: FINAL_NOW }, walkGc, script);
    for (const [side, r] of [['walk off', off], ['walk on', on]]) {
      const refused = r.writes.filter((w) => w.refused);
      if (refused.length !== 1) { bad.push(`${side}: ${refused.length} refused writes (${JSON.stringify(r.trace())}); the script refuses exactly one`); continue; }
      const later = afterRefusal(r);
      const high = later.filter((w) => w.price >= STANDING);
      if (high.length) bad.push(`${side}: after the refusal it sent ${JSON.stringify(high.map((w) => w.price))} at or above the standing ${STANDING}`);
      if (!later.some((w) => w.price === FLOOR)) bad.push(`${side}: the floor ${FLOOR} never went in the same round (${JSON.stringify(r.trace())})`);
      if (r.m.priceRaiseRefused) bad.push(`${side}: stood down although the floor ${FLOOR} is below the standing ${STANDING}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('SQRC, no time left in the round: raise refused at the buzzer -> the floor goes in the NEXT round (walk off and on)', async () => {
    const bad = [];
    const script = async (r) => {
      r.ctrl.rank = 3;
      r.ctrl.refuse.push(raise(STANDING));
      for (const cd of [60_000, 19_500, 13_500, 7_500, 6_500]) await r.at(cd, { rank: 3 });
      // The refusal came back with the round spent: nothing further fits before this close.
      r.ctrl.refuse.length = 0;
      await r.extend(300_000, 200_000, { rank: 3 });
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 3 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: BAND, gc: UNCAPPED }, walkGc, script);
    for (const [side, r] of [['walk off', off], ['walk on', on]]) {
      const refused = r.writes.filter((w) => w.refused);
      if (refused.length !== 1) { bad.push(`${side}: ${refused.length} refused writes (${JSON.stringify(r.trace())}); the script refuses exactly one`); continue; }
      const later = afterRefusal(r);
      if (later.some((w) => w.price >= STANDING)) bad.push(`${side}: after the refusal it sent a price at or above the standing ${STANDING}: ${JSON.stringify(r.trace())}`);
      if (!later.some((w) => w.price === FLOOR)) bad.push(`${side}: the floor ${FLOOR} never went, in this round or the next (${JSON.stringify(r.trace())})`);
    }
    return bad.join('; ') || null;
  });

  await H.check('stand down only when no band price is below the standing quote: the stand-down notice once per round, no lower write, and a new round does not re-send a bid', async () => {
    const bad = [];
    const script = async (r) => {
      r.ctrl.rank = 3;
      r.ctrl.refuse.push(raise(FLOOR - 400));
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 3 });
      await r.extend(300_000, 200_000, { rank: 3 });
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 3 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: BAND, gc: UNCAPPED }, walkGc, script);
    for (const [side, r] of [['walk off', off], ['walk on', on]]) {
      if (r.writes.length !== 1) bad.push(`${side}: ${r.writes.length} writes (${JSON.stringify(r.trace())}); expected only the one refused`);
      if (!r.m.priceRaiseRefused) bad.push(`${side}: not stood down with no band price below the standing ${FLOOR - 400}`);
      const alerts = r.events.filter((e) => e.type === 'alert' && e.kind === 'bid_price_raise_refused');
      if (alerts.length !== 2) bad.push(`${side}: ${alerts.length} bid_price_raise_refused notices over two rounds; expected one per round`);
      if (!(r.m.noBid && r.m.noBid.reason === 'price_raise_refused')) bad.push(`${side}: the refusal is not on the record (${JSON.stringify(r.m.noBid)})`);
    }
    return bad.join('; ') || null;
  });

  await H.check('a new round clears the latch: a stood-down load (restored latch, standing quote not known) bids again after an observed extension (walk off and on)', async () => {
    const bad = [];
    const script = async (r) => {
      r.ctrl.rank = 3;
      await r.at(60_000, { rank: 3 });
      r.m.priceRaiseRefused = true;
      for (const cd of [19_500, 7_500, 6_500, 3_000]) await r.at(cd, { rank: 3 });
      r.ctrl.wroteBeforeRound = r.writes.length;
      await r.extend(300_000, 200_000, { rank: 3 });
      for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 3 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: BAND, gc: UNCAPPED }, walkGc, script);
    for (const [side, r] of [['walk off', off], ['walk on', on]]) {
      if (r.ctrl.wroteBeforeRound !== 0) bad.push(`${side}: the latched round sent ${JSON.stringify(r.trace())}`);
      if (r.m.priceRaiseRefused) bad.push(`${side}: the latch survived an observed extension`);
      if (!(r.writes.length > 0)) bad.push(`${side}: nothing sent in the new round after the latch cleared`);
    }
    return bad.join('; ') || null;
  });

  await H.check('standing quote unknown (the refusal carries no number): the next price is below the refused one, never at or above it (walk off)', async () => {
    const bad = [];
    const r = H.load({ platform: 'gc', band: BAND, gc: FINAL_NOW, walk: H.WALK_OFF });
    r.ctrl.rank = 3;
    r.ctrl.refuse.push(raise());
    for (const cd of [60_000, 19_500, 13_500, 12_000, 7_500, 6_500, 5_000, 3_000]) await r.at(cd, { rank: 3 });
    r.done();
    const first = r.writes.find((w) => w.refused);
    if (!first) return `no refused write (${JSON.stringify(r.trace())})`;
    const later = afterRefusal(r);
    if (later.some((w) => w.price >= first.price)) bad.push(`after a refusal at ${first.price} it sent ${JSON.stringify(r.trace())}`);
    if (!later.some((w) => w.price === FLOOR)) bad.push(`the floor never went (${JSON.stringify(r.trace())})`);
    return bad.join('; ') || null;
  });

  await H.check('adapter: a GoComet raise refusal carries the standing per-unit quote it read before the PUT; a blank quote carries none', async () => {
    const bad = [];
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;
    const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    const quoteDoc = (price) => ({ id: 'Q1',
      charges_list: { '11_freight_charges': { freight_charges_custom_charge_40ft: { units: 2, unit_name: 'TRUCK', price } } },
      total_charges: { total: { units: 2.0, quote_units: 2.0, unit_name: 'TRUCK', total: price * 2 } } });
    for (const [standing, want] of [[24_900, 24_900], [0, null]]) {
      let t = 1_000_000;
      const fetchImpl = async (url, init) => {
        if (url.includes('/bidding-data')) return resp(200, { data: { bid_closing_in: 600, vendor_rank: 3, revisions_left: 6, total_revisions: 0 } });
        if (init.method === 'GET' && url.includes('/quotes')) return resp(200, [quoteDoc(standing)]);
        if (init.method === 'PUT') return resp(422, { message: GC_RAISE });
        return resp(404, {});
      };
      const a = new GoCometAdapter({ token, bidEnabled: true, fetchImpl, now: () => t,
        sleep: async (ms) => { await new Promise((res) => setImmediate(res)); t += ms; },
        minGetIntervalMs: 5000, globalMinGetIntervalMs: 1000, snipeBudgetMs: 4500 });
      await a.login();
      const res = await a.placeBid('SQRC-ADAPTER', 25_070, { floor: 24_242 });
      if (res.accepted) { bad.push('HARNESS: the 422 was accepted'); continue; }
      if ((res.standingPrice == null ? null : res.standingPrice) !== want) bad.push(`quote standing at ${standing}: standingPrice ${res.standingPrice}, expected ${want}`);
    }
    return bad.join('; ') || null;
  });

  H.finish('GoComet raise refusal continues below the standing quote', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
