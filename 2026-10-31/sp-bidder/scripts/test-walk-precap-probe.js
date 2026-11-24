'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: rounds before the final one (W5, rulings 40 and 48; owner decision of 26 Sep:
 * before the final round the only bid allowed is the probe middle price when outranked).
 *
 * In a round the tracker reads NOT_FINAL, the walk sends at most ONE middle price, only when
 * outranked, at the probe lead (SuperProcure 6 s, GoComet 12 s), never the lowest, latched on the
 * tracker's roundId so a restart inside the round cannot send a second. At rank 1 it sends nothing.
 * When the probe shows the round is final (SuperProcure: no close move by the end of the observe span;
 * GoComet: the submit response shows no extension), the walk runs the final round in what time is
 * left. Every check also pins the walk-off decisions.
 *
 * SuperProcure soft close: published extension count 3, 180 s increment, 100 s trigger window. Band
 * cost 87,400, margins 15.3 / 12.9 / 10.8 / 4.5, minimum 3 -> 100,772 / 98,675 / 96,839 / 91,333.
 *
 *   node scripts/test-walk-precap-probe.js
 */
const H = require('./lib/walk-harness');
const roundTracker = require('../src/engine/roundTracker');

const EXPECTED = 9;
const BAND4 = { cost: 87_400, marginsPct: [15.3, 12.9, 10.8, 4.5], minMarginPct: 3 };
const [P0, P1, P2, P3] = [100_772, 98_675, 96_839, 91_333];
const LIVE = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };
const SOFT = { closeModel: 'soft', extendMs: 180_000, extendCount: 3, triggerWindowMs: 100_000, revisionLimit: 5 };
const allowlisted = (sp = {}) => ({ band: BAND4, company: 'Havells India', softClose: LIVE, sp: Object.assign({}, SOFT, sp) });
const walkSp = H.walkCfg('sp', { stepTimeMs: 2_000, landMs: 2_500, safetyMarginMs: 500 });
const GC_BAND = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };

const GOLDEN = {
  precapLive: ['98675@30000', '96839@6000'],
  precapOff: ['100772@150000', '98675@60000', '96839@7000'],
  rank1: ['98675@30000'],
  restart: ['96839@6000'],
  newRound: ['98675@6000', '96839@60000', '94086@6000'],
  noMove: ['98675@6000', '96839@2400'],
  oneBidLeft: ['91333@2400'],
  gcNoMove: ['54500@12000', '50900@5000'],
};

(async () => {
  console.log('T9 walk - pre-final rounds and the probe');

  await H.check('12 precap-one-middle: SP soft NOT_FINAL, outranked -> exactly one middle price at the 6 s probe lead, never the lowest', async () => {
    const script = async (r) => {
      r.seedStanding(0, 4);
      for (const cd of [150_000, 30_000, 7_000, 6_000, 5_800]) await r.at(cd, { rank: 2 });
      await r.extend(180_000, 183_000, { rank: 2 });
    };
    const { off, on } = await H.pair(allowlisted(), walkSp, script);
    const bad = [];
    if (!H.same(on.trace(), ['98675@6000'])) bad.push(`allowlisted, walk on sent ${JSON.stringify(on.trace())}, expected exactly the middle ${P1} at 6,000`);
    let ctl = H.offMatches('precapLive', off.trace(), GOLDEN.precapLive);
    if (ctl) bad.push(ctl);
    // Not on the allowlist, no bid yet: no establish, one probe at the next non-lowest price.
    const scriptOff = async (r) => {
      for (const cd of [200_000, 150_000, 60_000, 7_000, 6_000, 5_800]) await r.at(cd, { rank: r.writes.length ? 2 : null });
    };
    const o = await H.pair({ band: BAND4, company: 'Shriji Polymers', sp: SOFT }, walkSp, scriptOff);
    if (!H.same(o.on.trace(), ['100772@6000'])) bad.push(`not allowlisted, walk on sent ${JSON.stringify(o.on.trace())}, expected exactly ${P0} at 6,000`);
    if (o.on.writes.some((w) => w.price === P3)) bad.push('a pre-final round sent the lowest price');
    ctl = H.offMatches('precapOff', o.off.trace(), GOLDEN.precapOff);
    if (ctl) bad.push(ctl);
    return bad.join('; ') || null;
  });

  await H.check('13 precap-rank1-nothing: NOT_FINAL, outranked early but rank 1 at the probe lead -> no bid in that round', async () => {
    const script = async (r) => {
      r.seedStanding(0, 4);
      await r.at(150_000, { rank: 1 });
      await r.at(30_000, { rank: 2 });
      for (const cd of [7_000, 6_000, 4_000, 2_400, 1_000]) await r.at(cd, { rank: 1 });
    };
    const { off, on } = await H.pair(allowlisted(), walkSp, script);
    const bad = [];
    if (on.writes.length) bad.push(`walk on sent ${JSON.stringify(on.trace())} in a pre-final round it ended at rank 1`);
    const ctl = H.offMatches('rank1', off.trace(), GOLDEN.rank1);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('14 precap-latch-survives-restart: middle price landed in round r, restart, same roundId -> no second middle price', async () => {
    const tid = (r) => roundTracker.verdict(r.m._round, Date.now(), { closeModel: r.m.closeModel }).roundId;
    const script = async (r) => {
      r.seedStanding(0, 4);
      await r.at(6_000, { rank: 2 });
      const before = tid(r);
      await r.restart();
      const after = tid(r);
      if (before !== after) throw new Error(`HARNESS: roundId moved across the restart (${before} -> ${after})`);
      for (const cd of [5_500, 5_000, 4_500]) await r.at(cd, { rank: 2 });
    };
    // Not on the allowlist, and a 5 s trigger window: the 6 s probe lands outside it, so no probe is
    // pending and the round stays NOT_FINAL after the restart.
    const { off, on } = await H.pair({ band: BAND4, company: 'Shriji Polymers', sp: Object.assign({}, SOFT, { triggerWindowMs: 5_000 }) },
      walkSp, script);
    const bad = [];
    if (!H.same(on.trace(), ['98675@6000'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only the one middle price ${P1} at 6,000`);
    const ctl = H.offMatches('restart', off.trace(), GOLDEN.restart);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('15 precap-new-round-new-shot: the probe moved the close (new roundId), still outranked -> one middle price in the new round', async () => {
    const script = async (r) => {
      r.seedStanding(0, 4);
      await r.at(6_000, { rank: 2 });
      await r.extend(180_000, 180_000, { rank: 2 });
      for (const cd of [60_000, 7_000, 6_000, 5_000]) await r.at(cd, { rank: 2 });
    };
    const { off, on } = await H.pair(allowlisted(), walkSp, script);
    const bad = [];
    if (!H.same(on.trace(), ['98675@6000', '96839@6000'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ${P1} then ${P2}, each at its round's 6,000`);
    const ctl = H.offMatches('newRound', off.trace(), GOLDEN.newRound);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('16 probe-no-move-becomes-final: probe pending, then FINAL HIGH probe_no_move -> the walk runs in the time left (D-A: the lowest)', async () => {
    let verdictAtFinal = null;
    const script = async (r) => {
      r.seedStanding(0, 4);
      await r.at(6_000, { rank: 2 });
      await r.at(5_000, { rank: 2 });
      await r.at(3_400, { rank: 2 });
      verdictAtFinal = r.eng.roundVerdict(r.m);
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair(allowlisted(), walkSp, script);
    const bad = [];
    if (!H.same(on.trace(), ['98675@6000', '91333@3400'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected the probe ${P1} at 6,000 and the lowest ${P3} at 3,400`);
    if (!verdictAtFinal || verdictAtFinal.verdict !== 'FINAL' || verdictAtFinal.reason !== 'probe_no_move') {
      bad.push(`HARNESS: the verdict at 3,400 was ${JSON.stringify(verdictAtFinal && { v: verdictAtFinal.verdict, r: verdictAtFinal.reason })}, expected FINAL probe_no_move`);
    }
    const ctl = H.offMatches('noMove', off.trace(), GOLDEN.noMove);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('17 gc-submit-no-move: GoComet probe accepted with no extension (FINAL gc_submit_no_move) -> the walk runs the final round in the same round', async () => {
    const script = async (r) => {
      for (const cd of [60_000, 19_500, 13_000]) await r.at(cd, { rank: null });
      await r.at(12_000, { rank: null });
      await r.at(7_000, { rank: 2 });
      await r.at(5_000, { rank: 2 });
    };
    const { off, on } = await H.pair({ platform: 'gc', band: GC_BAND }, H.walkCfg('gc'), script);
    const bad = [];
    const L = on.ladder;
    if (!H.same(on.trace(), [`${L[0]}@12000`, `${L[2]}@7000`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected the probe ${L[0]} at 12,000 then the lowest ${L[2]} at 7,000`);
    const ctl = H.offMatches('gcNoMove', off.trace(), GOLDEN.gcNoMove);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('pin: SP pre-final round with one bid left -> no middle probe; outranked at the end, the lowest goes at the last-step deadline (3,400), never forfeited', async () => {
    const script = async (r) => {
      r.seedStanding(0, 1);
      for (const cd of [7_000, 6_000, 5_000, 4_000, 3_500, 3_400, 2_400, 1_000]) await r.at(cd, { rank: 2 });
    };
    const { off, on } = await H.pair(allowlisted(), walkSp, script);
    const bad = [];
    if (!H.same(on.trace(), [`${P3}@3400`])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only the lowest ${P3} at 3,400`);
    const ctl = H.offMatches('oneBidLeft', off.trace(), GOLDEN.oneBidLeft);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('pin: no bid of any kind before the probe lead in a pre-final round (owner: no early bids)', async () => {
    const r = H.load(Object.assign(allowlisted(), { walk: walkSp }));
    for (const cd of [400_000, 250_000, 150_000, 140_000, 101_500, 90_000, 30_000, 10_000, 6_100]) await r.at(cd, { rank: null });
    r.done();
    return r.writes.length ? `walk on sent ${JSON.stringify(r.trace())} before the 6 s probe lead` : null;
  });

  await H.check('pin the shipped probe leads (owner, 26 Sep): SuperProcure 4,000, GoComet 9,000 - the probe fires at the new lead, not before', async () => {
    const bad = [];
    const sp = H.load(Object.assign(allowlisted(), { walk: H.walkCfg('sp', { probeLeadMs: undefined }) }));
    sp.seedStanding(0, 4);
    for (const cd of [7_000, 6_000, 4_100, 4_000, 3_800]) await sp.at(cd, { rank: 2 });
    sp.done();
    if (!H.same(sp.trace(), ['98675@4000'])) bad.push(`SuperProcure: walk on sent ${JSON.stringify(sp.trace())}, expected the probe 98675 at 4,000`);
    const gc = H.load({ platform: 'gc', band: GC_BAND, walk: H.walkCfg('gc', { probeLeadMs: undefined }) });
    for (const cd of [12_000, 10_000, 9_100, 9_000]) await gc.at(cd, { rank: null });
    gc.done();
    if (!H.same(gc.trace(), [`${gc.ladder[0]}@9000`])) bad.push(`GoComet: walk on sent ${JSON.stringify(gc.trace())}, expected the probe ${gc.ladder[0]} at 9,000`);
    return bad.join('; ') || null;
  });

  H.finish('T9 walk pre-final rounds and the probe', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
