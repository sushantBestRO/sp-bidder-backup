'use strict';
/**
 * @requires-summary-line
 * The refused-price hold's desk notice says "Not bidding ... Bid it by hand", so it goes out only when
 * it is true: the held price is the last one the engine would send this round (coordinator follow-up
 * on ca69f2f, 26 Sep). A hold with a lower price still sendable stays silent; a hold at the last price
 * notices once per load per round, and the next round re-arms it. The record and the close receipt
 * are unchanged.
 *
 * A hold away from the floor is reached after a restart: the refused price and its count are restored
 * from the durable refusal state (bidEngine _refusalStateOf / arm), while the in-memory bank of the
 * refused rung is not, so the rung is decided again and held. The checks seed that restored state.
 *
 *   node scripts/test-refused-hold-notice-only-at-stop.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 5;
const BAND_GC = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };
const KINDS = ['refusal_unrecognised', 'refused_price_bound'];
const SP_TICKS = [25_000, 9_700, 9_500, 6_000, 4_000, 3_000, 2_400, 1_200];
const GC_TICKS = [60_000, 19_500, 13_500, 12_000, 9_000, 7_500, 6_500, 5_000, 3_000];

// A refusal restored as held: `price` refused `count` times, recognised or not.
function seedRefused(r, price, unrecognised) {
  r.m._refusedPrice = price;
  r.m._refusedPriceVcq = null;
  r.m._refusedPriceCount = 3;
  r.m._refusedPriceUnrecognised = unrecognised;
  r.m._refusedPriceBody = 'Something went wrong, please try again';
}
const holdNotices = (r) => r.events.filter((e) => e.type === 'alert' && KINDS.includes(e.kind));

(async () => {
  console.log('refused-price hold: the desk notice only at a real stop');

  await H.check('SP: a hold above the floor, then the floor lands - no hold notice (both kinds, walk off and on)', async () => {
    const bad = [];
    for (const unrecognised of [true, false]) {
      const { off, on } = await H.pair({ sp: { revisionLimit: 3 } }, H.walkCfg('sp', { stepTimeMs: 2_500 }), async (r) => {
        seedRefused(r, r.ladder[0], unrecognised);
        for (const cd of SP_TICKS) await r.at(cd, { rank: 2 });
      });
      for (const [side, r] of [['walk off', off], ['walk on', on]]) {
        const lowest = r.ladder[r.ladder.length - 1];
        if (!r.writes.some((w) => w.price === lowest && !w.refused)) bad.push(`${side} ${unrecognised ? 'unrecognised' : 'bound'}: HARNESS: the floor did not land (${JSON.stringify(r.trace())})`);
        if (holdNotices(r).length) bad.push(`${side} ${unrecognised ? 'unrecognised' : 'bound'}: ${holdNotices(r).length} hold notice(s) with lower prices still to send`);
      }
    }
    return bad.join('; ') || null;
  });

  await H.check('SP: a hold at the floor with nothing lower - exactly one hold notice (both kinds, walk off and on)', async () => {
    const bad = [];
    for (const unrecognised of [true, false]) {
      const { off, on } = await H.pair({ sp: { revisionLimit: 3 } }, H.walkCfg('sp', { stepTimeMs: 2_500 }), async (r) => {
        r.seedStanding(1, 2);
        seedRefused(r, r.ladder[r.ladder.length - 1], unrecognised);
        for (const cd of SP_TICKS) await r.at(cd, { rank: 2 });
      });
      const want = unrecognised ? 'refusal_unrecognised' : 'refused_price_bound';
      for (const [side, r] of [['walk off', off], ['walk on', on]]) {
        const n = holdNotices(r);
        if (n.length !== 1 || n[0].kind !== want) bad.push(`${side} ${want}: ${JSON.stringify(n.map((e) => e.kind))} (${JSON.stringify(r.trace())}), expected one ${want}`);
      }
    }
    return bad.join('; ') || null;
  });

  await H.check('GoComet: a hold at the middle price, then the floor lands - no hold notice (both kinds, walk off and on)', async () => {
    const bad = [];
    for (const unrecognised of [true, false]) {
      const { off, on } = await H.pair({ platform: 'gc', band: BAND_GC, gc: FINAL_NOW }, H.walkCfg('gc'), async (r) => {
        r.seedStanding(0, 3);
        seedRefused(r, 53_600, unrecognised);
        for (const cd of GC_TICKS) await r.at(cd, { rank: 2 });
      });
      for (const [side, r] of [['walk off', off], ['walk on', on]]) {
        if (!r.writes.some((w) => w.price === 50_900 && !w.refused)) bad.push(`${side}: HARNESS: the floor did not land (${JSON.stringify(r.trace())})`);
        if (holdNotices(r).length) bad.push(`${side} ${unrecognised ? 'unrecognised' : 'bound'}: ${holdNotices(r).length} hold notice(s) with the floor still to send`);
      }
    }
    return bad.join('; ') || null;
  });

  await H.check('GoComet: a hold at the floor notices once per round, and the next round re-arms it (both kinds, walk off and on)', async () => {
    const bad = [];
    for (const unrecognised of [true, false]) {
      const { off, on } = await H.pair({ platform: 'gc', band: BAND_GC, gc: FINAL_NOW }, H.walkCfg('gc'), async (r) => {
        r.seedStanding(0, 1);
        seedRefused(r, 50_900, unrecognised);
        for (const cd of GC_TICKS) await r.at(cd, { rank: 2 });
        await r.extend(300_000, 200_000, { rank: 2 });
        for (const cd of GC_TICKS) await r.at(cd, { rank: 2 });
      });
      for (const [side, r] of [['walk off', off], ['walk on', on]]) {
        const rounds = holdNotices(r).map((e) => e.round);
        if (JSON.stringify(rounds) !== '[0,1]') bad.push(`${side} ${unrecognised ? 'unrecognised' : 'bound'}: notices for rounds ${JSON.stringify(rounds)} (${JSON.stringify(r.trace())}), expected [0,1]`);
      }
    }
    return bad.join('; ') || null;
  });

  await H.check('the hold is still recorded for the close receipt when no notice goes out (the record is unchanged)', async () => {
    const r = H.load({ sp: { revisionLimit: 3 }, walk: H.WALK_OFF });
    seedRefused(r, r.ladder[0], true);
    await r.at(25_000, { rank: 2 });
    r.done();
    return r.m.noBid && r.m.noBid.reason === 'refusal_unrecognised' ? null : `record ${JSON.stringify(r.m.noBid)}`;
  });

  H.finish('refused-price hold notice only at a real stop', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
