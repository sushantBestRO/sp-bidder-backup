'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: uncertainty (W11, W12, D-C; rulings 38 and 39).
 *
 * A round the tracker cannot call is walked like a final one when we are outranked, with the steps
 * that still fit the time left and the last at the lowest band price; at rank 1 it holds with no desk
 * notice. A countdown frozen at zero after the believed close (UNCERTAIN_AFTER_CLOSE) sends nothing
 * until the tracker says the load is live again, and a reopened load is walked as its new round. After
 * a step whose rank never arrives, the walk treats us as outranked at the next step's deadline.
 *
 * SuperProcure soft close, allowlisted: an unknown extension count reads UNCERTAIN. Band cost 87,400,
 * margins 15.3 / 10.8 / 4.5, minimum 3 -> 100,772 / 96,839 / 91,333.
 *
 *   node scripts/test-walk-uncertain.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 4;
const [P0, P1, P2] = [100_772, 96_839, 91_333];
const LIVE = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };
const soft = (extendCount) => ({ company: 'Havells India', softClose: LIVE,
  sp: { closeModel: 'soft', extendMs: 180_000, extendCount, triggerWindowMs: 100_000, revisionLimit: 3 } });
const walk2k = H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 });
const walk25 = H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500 });

const GOLDEN = {
  uncertainOutranked: ['100772@60000', '91333@2400'],
  uncertainRank1: ['96839@30000'],
  frozen: ['96839@-1000', '91333@-3500'],
  rankUnknown: ['100772@10000', '91333@2500'],
};

(async () => {
  console.log('T9 walk - uncertainty');

  await H.check('23 uncertain-outranked-walks-what-fits: UNCERTAIN, outranked, time for 2 steps, 3 prices below -> 2 steps, the last at the lowest', async () => {
    let v = null;
    const script = async (r) => {
      await r.at(60_000, { rank: null });
      v = r.eng.roundVerdict(r.m);
      for (const cd of [4_700, 4_000, 3_500, 2_900, 2_400]) await r.at(cd, { rank: null });
    };
    const { off, on } = await H.pair(soft(null), walk2k, script);
    const bad = [];
    if (!v || v.verdict !== 'UNCERTAIN') bad.push(`HARNESS: verdict ${v && v.verdict}, expected UNCERTAIN`);
    if (!H.same(on.trace(), [`${P1}@4700`, `${P2}@2900`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ${P1} at 4,700 then ${P2} at its deadline 2,900 (ruling 38 + D-A)`);
    const ctl = H.offMatches('uncertainOutranked', off.trace(), GOLDEN.uncertainOutranked);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('24 uncertain-rank1-holds-silently: UNCERTAIN, outranked before the window, rank 1 through it -> no bid and no desk notice (ruling 39)', async () => {
    let alertsInWindow = [];
    const script = async (r) => {
      r.seedStanding(0, 2);
      await r.at(30_000, { rank: 2 });
      const mark = r.events.length;
      for (let cd = 10_000; cd >= 200; cd -= 200) await r.at(cd, { rank: 1 });
      alertsInWindow = r.events.slice(mark).filter((e) => e.type === 'alert');
    };
    const { off, on } = await H.pair(soft(null), walk2k, script);
    const bad = [];
    if (on.writes.length) bad.push(`walk on sent ${JSON.stringify(on.trace())} while leading an UNCERTAIN round`);
    if (alertsInWindow.length) bad.push(`walk on raised ${alertsInWindow.map((e) => e.kind).join(', ')} while holding rank 1`);
    const ctl = H.offMatches('uncertainRank1', off.trace(), GOLDEN.uncertainRank1);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('25 frozen-zero-no-bid: UNCERTAIN_AFTER_CLOSE -> no bid; the reopened load is walked as its new round', async () => {
    let frozen = null;
    const script = async (r) => {
      r.seedStanding(0, 2);
      for (const cd of [10_000, 3_000, 0]) await r.at(cd, { rank: 1 });
      for (const cd of [-1_000, -3_500, -5_000]) await r.at(cd, { rank: 2 });
      frozen = r.eng.roundVerdict(r.m);
      await r.extend(180_000, 170_000, { rank: 2 });
      for (const cd of [7_000, 6_000, 5_000]) await r.at(cd, { rank: 2 });
    };
    const { off, on } = await H.pair(soft(3), walk2k, script);
    const bad = [];
    if (!frozen || frozen.verdict !== 'UNCERTAIN_AFTER_CLOSE') bad.push(`HARNESS: frozen verdict ${frozen && frozen.verdict}, expected UNCERTAIN_AFTER_CLOSE`);
    if (!H.same(on.trace(), [`${P1}@6000`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected nothing while frozen and the new round's probe ${P1} at 6,000`);
    const ctl = H.offMatches('frozen', off.trace(), GOLDEN.frozen);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('26 rank-unknown-steps-at-deadline: a step placed, rank null until the next step\'s latest start -> it steps (D-C); 8,200 / 5,700 / 3,400', async () => {
    const script = async (r) => { for (let cd = 10_000; cd >= 2_000; cd -= 100) await r.at(cd, { rank: null }); };
    const { off, on } = await H.pair({}, walk25, script);
    const bad = [];
    if (!H.same(on.trace(), [`${P0}@8200`, `${P1}@5700`, `${P2}@3400`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ${P0}@8200, ${P1}@5700, ${P2}@3400`);
    const ctl = H.offMatches('rankUnknown', off.trace(), GOLDEN.rankUnknown);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  H.finish('T9 walk uncertainty', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
