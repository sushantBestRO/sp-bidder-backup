'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: timing and steps (rulings 27, 28, 34, 36; owner decisions of 26 Sep:
 * no early bids, maxWalkWindowMs, even spread when fewer steps fit than prices below ours).
 *
 * The walk starts at close - steps x stepTime - safety, where steps = min(bids left, band prices
 * below ours, what maxWalkWindowMs holds), steps down one band price per outranked read, stops at
 * rank 1 and never offers the minimum margin. When fewer steps fit than prices below ours, the steps
 * are spread evenly and the last one is always the lowest band price. The SuperProcure hard-close
 * establish at ~25 s is gone. Every check also runs the same script with the walk off and pins the
 * shipped decisions.
 *
 * Band: cost 87,400, margins 15.3 / 10.8 / 4.5, minimum 3 -> prices 100,772 / 96,839 / 91,333; the
 * minimum (90,022) is a guard only. Safety = the frame's clockErrorMs 200 + safetyMarginMs 500.
 *
 *   node scripts/test-walk-timing-steps.js
 */
const H = require('./lib/walk-harness');

const EXPECTED = 18;
const [P0, P1, P2] = [100_772, 96_839, 91_333];
const GUARD = 90_022;
const walk2k = H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 });
const walk3k = H.walkCfg('sp', { stepTimeMs: 3_000, safetyMarginMs: 500 });

const GOLDEN = {
  hardOutranked: ['100772@25000', '96839@24000'],
  hardTwoBids: ['100772@25000', '91333@2400'],
  standingMiddle: ['91333@2400'],
  hardRank1: ['100772@25000'],
  defendHold: ['100772@25000', '96839@9500', '91333@2400'],
  tooLate: ['100772@25000', '96839@9500', '91333@2400'],
  lateFinal: ['96839@3700', '91333@2400'],
  noEstablish: ['100772@25000'],
  firstTop: ['100772@25000'],
  manyBids: ['120000@25000', '119000@24000', '118000@16000', '117000@13200', '102000@2400'],
  spread3: ['100772@25000', '91333@2400'],
};

const firstWriteAt = (r) => (r.writes.length ? r.writes[0].cd : null);

(async () => {
  console.log('T9 walk - timing and steps');

  await H.check('1 start-formula: 3 bids, 3 prices, stepTime 2,000, safety 700 -> nothing above 6,700, the top price at the first tick at or under it', async () => {
    const script = async (r) => {
      for (const cd of [40_000, 25_000, 24_000, 10_000, 6_800]) await r.at(cd, { rank: r.writes.length ? 2 : null });
      await r.at(6_700, { rank: null });
    };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    const early = on.writes.filter((w) => w.cd > 6_700);
    if (early.length) bad.push(`walk on sent ${on.trace()} - ${early.length} bid(s) above the 6,700 start`);
    else if (!(on.writes.length === 1 && on.writes[0].price === P0 && on.writes[0].cd === 6_700)) {
      bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected exactly the top price ${P0} at 6,700`);
    }
    const ctl = H.offMatches('hardOutranked', off.trace(), GOLDEN.hardOutranked);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('2 steps-min-bids: 2 bids, 3 prices -> start = close - 2 x stepTime - safety (4,700), first step skips the top (D-A)', async () => {
    const script = async (r) => {
      for (const cd of [25_000, 24_000, 10_000, 4_800, 4_700]) await r.at(cd, { rank: r.writes.length ? 2 : null });
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair({ sp: { revisionLimit: 2 } }, walk2k, script);
    const bad = [];
    if (firstWriteAt(on) !== 4_700 || on.writes[0].price !== P1) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected the middle price ${P1} first at 4,700`);
    const ctl = H.offMatches('hardTwoBids', off.trace(), GOLDEN.hardTwoBids);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('3 steps-min-prices: standing at the middle price, 3 bids, stepTime 3,000 -> steps 1, start = close - stepTime - safety (3,700)', async () => {
    const script = async (r) => {
      r.seedStanding(1, 2);
      for (const cd of [25_000, 10_000, 3_800, 3_700]) await r.at(cd, { rank: 2 });
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair({}, walk3k, script);
    const bad = [];
    if (!(on.writes.length === 1 && on.writes[0].price === P2 && on.writes[0].cd === 3_700)) {
      bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected exactly the lowest ${P2} at 3,700`);
    }
    const ctl = H.offMatches('standingMiddle', off.trace(), GOLDEN.standingMiddle);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('4 stop-at-L1: the first step lands and the next read is rank 1 -> no further bid through the close', async () => {
    const script = async (r) => {
      for (const cd of [25_000, 6_700]) await r.at(cd, { rank: null });
      for (const cd of [6_000, 4_000, 2_400, 1_000, 200]) await r.at(cd, { rank: 1 });
    };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    if (!H.same(on.trace(), ['100772@6700'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only 100772@6700`);
    const ctl = H.offMatches('hardRank1', off.trace(), GOLDEN.hardRank1);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('5 undercut-after-hold: rank 1 held on the middle price, rank 2 at stepTime + safety + 1 (3,701) -> the next band price goes', async () => {
    const script = async (r) => {
      await r.at(25_000, { rank: null });
      await r.at(9_700, { rank: null });
      await r.at(9_500, { rank: 2 });
      for (const cd of [8_000, 6_000, 4_500]) await r.at(cd, { rank: 1 });
      await r.at(3_701, { rank: 2 });
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair({}, walk3k, script);
    const bad = [];
    if (!H.same(on.trace(), ['100772@9700', '96839@9500', '91333@3701'])) {
      bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected 100772@9700, 96839@9500 then the defence 91333@3701`);
    }
    const ctl = H.offMatches('defendHold', off.trace(), GOLDEN.defendHold);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  // Corrected 26 Sep (engine review S2): an outranked load with an attempt left is never left with
  // nothing - the lowest goes best effort, and the timing-miss event still marks the load.
  await H.check('6 undercut-too-late: rank 2 seen below safety + landMs (3,100 < 3,700) -> the lowest goes best effort, and a timing-miss event marks the load', async () => {
    const script = async (r) => {
      await r.at(25_000, { rank: null });
      await r.at(9_700, { rank: null });
      await r.at(9_500, { rank: 2 });
      for (const cd of [8_000, 6_000, 4_500, 3_300]) await r.at(cd, { rank: 1 });
      await r.at(3_100, { rank: 2 });
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair({}, walk3k, script);
    const bad = [];
    if (!H.same(on.trace(), ['100772@9700', '96839@9500', '91333@3100'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected the lowest 91333 at 3,100 after 96839@9500`);
    const miss = on.events.filter((e) => e.type === 'walk_timing_miss');
    if (miss.length !== 1 || miss[0].remainingMs !== 3_100) bad.push(`walk on emitted ${miss.length} walk_timing_miss events (${JSON.stringify(miss)}), expected one at 3,100`);
    if (on.logs.info.some((l) => /too late/i.test(l.m))) bad.push('the timing miss is still only an info log line');
    const ctl = H.offMatches('tooLate', off.trace(), GOLDEN.tooLate);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('7 last-step-lands-only: stepTime 3,000, landMs 2,500; rank 2 at safety + landMs < 3,400 < safety + stepTime -> the lowest price goes (D-B)', async () => {
    const script = async (r) => {
      await r.at(25_000, { rank: null });
      await r.at(9_200, { rank: null });
      await r.at(9_000, { rank: 2 });
      for (const cd of [8_000, 6_000, 4_500]) await r.at(cd, { rank: 1 });
      await r.at(3_400, { rank: 2 });
    };
    const { on } = await H.pair({}, H.walkCfg('sp', { stepTimeMs: 3_000, landMs: 2_500, safetyMarginMs: 500 }), script);
    if (H.same(on.trace(), ['100772@9200', '96839@9000', '91333@3400'])) return null;
    return `walk on sent ${JSON.stringify(on.trace())}, expected 100772@9200 (start = 2 x 3,000 + 2,500 + 700), 96839@9000, then the lowest 91333 at 3,400`;
  });

  await H.check('8 fewer-steps-fit-skips-top: first read at stepTime + safety (3,700), standing at the top, 2 prices below -> the LOWEST goes (D-A)', async () => {
    const script = async (r) => {
      r.seedStanding(0, 2);
      await r.at(3_700, { rank: 2 });
      await r.at(2_400, { rank: 2 });
    };
    const { off, on } = await H.pair({}, walk3k, script);
    const bad = [];
    if (!H.same(on.trace(), ['91333@3700'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected only the lowest 91333 at 3,700`);
    // The fit, not a rule about the top: the same load read at 2 x stepTime + safety sends the middle.
    const two = H.load({ walk: walk3k });
    two.seedStanding(0, 2);
    await two.at(6_700, { rank: 2 });
    if (!H.same(two.trace(), ['96839@6700'])) bad.push(`with two steps fitting (6,700) walk on sent ${JSON.stringify(two.trace())}, expected the middle 96839`);
    two.done();
    const ctl = H.offMatches('lateFinal', off.trace(), GOLDEN.lateFinal);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('9 minimum-never-a-step: band [15.3, 10.8, 4.5] minimum 3 -> no walk price at or below the minimum (ruling 27)', async () => {
    const r = H.load({ walk: walk2k });
    for (let cd = 8_000; cd >= 200; cd -= 100) await r.at(cd, { rank: r.writes.length ? 2 : null });
    r.done();
    const bad = [];
    const prices = r.writes.map((w) => w.price);
    if (!prices.length) bad.push('walk on sent nothing while outranked through the window');
    else if (r.writes[0].cd !== 6_700) bad.push(`walk on sent its first price at ${r.writes[0].cd}, expected the walk's start 6,700`);
    if (prices.some((p) => p <= GUARD)) bad.push(`walk on sent ${prices} - a price at or below the minimum ${GUARD}`);
    if (prices.some((p) => ![P0, P1, P2].includes(p))) bad.push(`walk on sent ${prices} - a price that is not a band price`);
    if (prices.length && prices[prices.length - 1] !== P2) bad.push(`the last walk price was ${prices[prices.length - 1]}, expected the lowest band price ${P2}`);
    return bad.join('; ') || null;
  });

  await H.check('10 hard-close-no-establish: SP hard at 25,000 (the old establish mark) -> no bid (ruling 36)', async () => {
    const script = async (r) => { for (const cd of [40_000, 25_000, 20_000, 12_000]) await r.at(cd, { rank: null }); };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    if (on.writes.length) bad.push(`walk on sent ${JSON.stringify(on.trace())} before its start`);
    const ctl = H.offMatches('noEstablish', off.trace(), GOLDEN.noEstablish);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('11 hard-close-first-step-top: SP hard at the start -> ladder[0], then it holds at rank 1', async () => {
    const script = async (r) => {
      await r.at(25_000, { rank: null });
      await r.at(6_700, { rank: null });
      for (const cd of [5_000, 3_000, 2_400, 500]) await r.at(cd, { rank: 1 });
    };
    const { off, on } = await H.pair({}, walk2k, script);
    const bad = [];
    if (!H.same(on.trace(), ['100772@6700'])) bad.push(`walk on sent ${JSON.stringify(on.trace())}, expected ladder[0] 100772 at 6,700 and nothing after`);
    const ctl = H.offMatches('firstTop', off.trace(), GOLDEN.firstTop);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  // A 19-price ladder: margins 20 down to 2, minimum 1, cost 100,000 -> 120,000 ... 102,000.
  const BAND19 = { cost: 100_000, marginsPct: Array.from({ length: 19 }, (_, i) => 20 - i), minMarginPct: 1 };

  await H.check('pin maxWalkWindowMs: 5 bids, 19 prices, stepTime 2,500, safety 700 -> steps = floor((15,000 - 700) / 2,500) = 5, start 13,200; with 8,000 -> 2 steps, start 5,700', async () => {
    const bad = [];
    for (const [max, start] of [[15_000, 13_200], [8_000, 5_700]]) {
      const w = H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500, maxWalkWindowMs: max });
      const r = H.load({ walk: w, band: BAND19, sp: { revisionLimit: 5 } });
      await r.at(25_000, { rank: null });
      for (let cd = max + 5_000; cd >= start; cd -= 100) {
        await r.at(cd, { rank: null });
        if (r.writes.length) break;
      }
      r.done();
      if (firstWriteAt(r) !== start) bad.push(`maxWalkWindowMs ${max}: first bid ${JSON.stringify(r.trace())}, expected the walk to start at ${start}`);
      if (r.writes.some((wr) => wr.cd > max)) bad.push(`maxWalkWindowMs ${max}: a bid went out earlier than close - ${max}`);
    }
    const script = async (r) => {
      for (const cd of [30_000, 25_000, 24_000, 16_000, 13_200, 10_000, 8_000, 5_000, 2_400]) await r.at(cd, { rank: r.writes.length ? 2 : null });
    };
    const off = H.load({ walk: H.WALK_OFF, band: BAND19, sp: { revisionLimit: 5 } });
    await script(off);
    off.done();
    const ctl = H.offMatches('manyBids', off.trace(), GOLDEN.manyBids);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('pin even spread: 19 prices, 5 steps, rank never visible -> every 4th price, the last at the lowest (indices 3, 7, 11, 15, 18)', async () => {
    const w = H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500 });
    const r = H.load({ walk: w, band: BAND19, sp: { revisionLimit: 5 } });
    for (let cd = 14_000; cd >= 200; cd -= 100) await r.at(cd, { rank: null });
    r.done();
    const idx = r.writes.map((wr) => r.ladder.indexOf(wr.price));
    if (H.same(idx, [3, 7, 11, 15, 18])) return null;
    return `walk on sent ladder indices ${JSON.stringify(idx)} (${JSON.stringify(r.trace())}), expected [3,7,11,15,18]`;
  });

  await H.check('pin even spread equals D-A on a 3-price band: 2 bids -> middle then lowest; 1 bid -> the lowest', async () => {
    const bad = [];
    const two = H.load({ walk: walk2k, sp: { revisionLimit: 2 } });
    for (let cd = 5_000; cd >= 200; cd -= 100) await two.at(cd, { rank: null });
    two.done();
    if (!H.same(two.writes.map((wr) => wr.price), [P1, P2])) bad.push(`2 bids: walk on sent ${JSON.stringify(two.trace())}, expected [${P1}, ${P2}]`);
    const one = H.load({ walk: walk2k, sp: { revisionLimit: 1 } });
    for (let cd = 5_000; cd >= 200; cd -= 100) await one.at(cd, { rank: null });
    one.done();
    if (!H.same(one.writes.map((wr) => wr.price), [P2])) bad.push(`1 bid: walk on sent ${JSON.stringify(one.trace())}, expected [${P2}]`);
    const off = H.load({ walk: H.WALK_OFF, sp: { revisionLimit: 2 } });
    for (const cd of [25_000, 24_000, 10_000, 2_400]) await off.at(cd, { rank: off.writes.length ? 2 : null });
    off.done();
    const ctl = H.offMatches('spread3', off.trace(), GOLDEN.spread3);
    return bad.concat(ctl ? [ctl] : []).join('; ') || null;
  });

  await H.check('pin the land term (plan B): stepTime 600, landMs 1,200, safety 700, 3 prices -> the walk starts at 3,100 (2 x 600 + 1,200 + 700), not 2,500', async () => {
    const r = H.load({ walk: H.walkCfg('sp', { stepTimeMs: 600, landMs: 1_200, safetyMarginMs: 500 }) });
    for (let cd = 5_000; cd >= 1_000; cd -= 100) { await r.at(cd, { rank: null }); if (r.writes.length) break; }
    r.done();
    return firstWriteAt(r) === 3_100 && r.writes[0].price === P0 ? null
      : `walk on sent ${JSON.stringify(r.trace())}, expected the top price at 3,100`;
  });

  await H.check('pin: a walk step never waits on the 200 ms poll - with the next deadline 130 ms away the next tick is aimed at it (<= +20 ms)', async () => {
    const r = H.load({ walk: H.walkCfg('sp', { stepTimeMs: 2_500, safetyMarginMs: 500 }) });
    await r.at(20_000, { rank: null });
    const delayToStart = r.eng._cadence(8_330, r.m);
    await r.at(8_200, { rank: null });
    // After the first step (rank never visible): the next deadline is 5,700; a tick 130 ms before it.
    const delayToDeadline = r.eng._cadence(5_830, r.m);
    r.done();
    if (!H.same(r.trace(), ['100772@8200'])) return `HARNESS: walk on sent ${JSON.stringify(r.trace())}, expected 100772@8200`;
    const bad = [];
    if (!(delayToStart >= 130 && delayToStart <= 150)) bad.push(`cadence 130 ms before the 8,200 start returned ${delayToStart} ms`);
    if (!(delayToDeadline >= 130 && delayToDeadline <= 150)) bad.push(`cadence 130 ms before the 5,700 step deadline returned ${delayToDeadline} ms`);
    return bad.join('; ') || null;
  });

  await H.check('pin fire guards vs a long walk: 19 prices, 19 bids, maxBidsPerMin 20 with its decisive-shot reservation -> every step goes, ending on the lowest', async () => {
    const band19 = { cost: 100_000, marginsPct: Array.from({ length: 19 }, (_, i) => 20 - i), minMarginPct: 1 };
    const r = H.load({ band: band19, company: 'Shriji Polymers', config: { maxBidsPerMin: 20, floorSnipeReservedSlots: 4 },
      sp: { closeModel: 'soft', extendMs: 180_000, extendCount: 0, triggerWindowMs: 100_000, revisionLimit: 19 },
      walk: H.walkCfg('sp', { stepTimeMs: 500, landMs: 500, safetyMarginMs: 0 }) });
    for (let cd = 15_000; cd >= 200; cd -= 100) await r.at(cd, { rank: r.writes.length ? 2 : null });
    r.done();
    const idx = r.writes.map((w) => r.ladder.indexOf(w.price));
    if (idx.length === 19 && idx[18] === 18 && idx.every((v, i) => v === i)) return null;
    return `walk on sent ${idx.length} bids (ladder indices ${JSON.stringify(idx)}), expected all 19 in order ending on the lowest`;
  });

  await H.check('pin: an undercut too late to answer marks the closed record as a timing miss', async () => {
    const { BidLogger } = require('../src/logging/bidLogger');
    const { MemoryStore } = require('../src/store/memoryStore');
    const store = new MemoryStore();
    const logger = new BidLogger({ store, log: () => {} });
    const r = H.load({ walk: walk3k });
    for (const e of r.events.filter((x) => x.type === 'armed')) await logger.handle(e);
    await r.at(9_700, { rank: null });
    await r.at(9_500, { rank: 1 });
    await r.at(3_100, { rank: 2 });
    for (const e of r.events.filter((x) => x.type !== 'armed')) await logger.handle(e);
    r.done();
    const rec = await logger.getRecord(r.m.auctionId);
    if (rec && rec.walkTimingMiss && rec.walkTimingMiss.remainingMs === 3_100) return null;
    return `the closed record carries walkTimingMiss ${JSON.stringify(rec && rec.walkTimingMiss)}, expected remainingMs 3,100`;
  });

  H.finish('T9 walk timing and steps', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
