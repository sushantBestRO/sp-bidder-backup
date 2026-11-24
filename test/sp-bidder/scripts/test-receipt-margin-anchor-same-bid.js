'use strict';
/**
 * T6 D1 + T6 INV-9: the close receipt measures its margin against the cost that priced the bid it
 * names, and never prints a rupee figure off a cost that is not a number.
 *
 * D1. ourBids is appended in ARRIVAL order while lastBidPrice keeps the LOWEST landed price. A write
 * that resolves after a re-price retired its monitor (bidEngine._recordLandedAfterRetire) banks the
 * retired epoch's dearer price and cost LAST, so ourBids[last] and lastBidPrice describe different
 * epochs. The receipt took the cost off ourBids[last] and the price off lastBidPrice, and a +9.00%
 * win rendered -2.28% with "stands Rs 660 below your rate". The EOD day margin reads the same
 * resolver, so it agreed with the wrong number.
 *
 * INV-9. The doc-cost fallback had no finite guard, so a non-numeric stored cost reached the
 * receipt as "Your Rate - Rs NaN" (and 0 / negative costs as "Rs 0" / "Rs -1").
 *
 *   node scripts/test-receipt-margin-anchor-same-bid.js
 */
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { resolveBidTimeCost, bidTimeBand } = require('../src/notify/bidTimeCost');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const T0 = 1_757_000_000_000;
const ID = 'LD2Z';
const LANE = { origin: 'Palghar', destination: 'Jaipur' };
const A_COST = 29_000, A_OPENING = 31_610;
const D_COST = 26_000, D_OPENING = 28_340;

const armed = (ts, cost, ladder) => ({
  type: 'armed', auctionId: ID, ts, lane: LANE, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', cost, ladder, floor: ladder[ladder.length - 1],
  marginsPct: [9, 5, 1], minMarginPct: 1,
});

const wonBody = (rec) => {
  const d = Object.assign({ oaNo: rec.auctionId, shipperName: 'Waaree Energies', landedBids: 1 },
    outcomeEnrichment(rec));
  return { d, body: renderMessage(templateFor('won', d), d) };
};

(async () => {
  console.log('\n1. a dearer write from a retired epoch banks after the successor\'s cheaper one');
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await logger.handle(armed(T0, A_COST, [31_610, 30_450, 29_290]));
    await logger.handle(armed(T0 + 163_000, D_COST, [28_340, 27_300, 26_260]));
    await logger.handle({ type: 'bid_placed', auctionId: ID, ts: T0 + 164_000,
      price: D_OPENING, rungIndex: 0, socketRank: 2, cost: D_COST, minMarginPct: 1,
      closesInMs: 6_800_000, believedCloseAt: T0 + 6_964_000 });
    await logger.handle({ type: 'bid_placed', auctionId: ID, ts: T0 + 164_500,
      price: A_OPENING, rungIndex: null, establishing: false, socketRank: null,
      cost: A_COST, minMarginPct: 1, closesInMs: null });
    await logger.handle({ type: 'auction_result', auctionId: ID, ts: T0 + 6_964_000,
      won: true, finalRank: 1, closeModel: 'hard' });
    const rec = await store.getDoc('closedBids', ID);

    const band = bidTimeBand(rec);
    console.log(`  record: ourBids ${JSON.stringify(rec.ourBids.map((b) => b.price))}, lastBidPrice ${rec.lastBidPrice}, `
      + `anchor cost ${band && band.cost}`);
    ok(rec.lastBidPrice === D_OPENING && rec.ourBids[rec.ourBids.length - 1].price === A_OPENING,
      'fixture: lastBidPrice is the successor\'s 28,340 while the retired 31,610 sits last in ourBids');

    const { d, body } = wonBody(rec);
    ok(d.marketRate === '26,000',
      `the receipt anchors on 26,000, the cost that priced the 28,340 it reports (got ${d.marketRate})`);
    ok(d.marginPct === '9.00', `and reports the +9.00% that bid was placed at (got ${d.marginPct})`);
    ok(d.belowRateBy === undefined, `and claims no shortfall on a bid placed above its own cost (got ${d.belowRateBy})`);
    ok(body.includes('₹28,340 (+9.00%)') && !/below your rate/.test(body) && !/-2\.28/.test(body),
      'the rendered Won Rate line says +9.00% with no "below your rate" line');
    ok(resolveBidTimeCost(rec) === D_COST,
      `the day summary resolves the same 26,000 anchor for this load (got ${resolveBidTimeCost(rec)})`);
  }

  console.log('\n2. an in-order ladder still anchors on its last, lowest bid');
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await logger.handle(armed(T0, A_COST, [31_610, 30_450, 29_290]));
    await logger.handle({ type: 'bid_placed', auctionId: ID, ts: T0 + 1_000, price: 31_610, rungIndex: 0,
      cost: A_COST, minMarginPct: 1 });
    await logger.handle(armed(T0 + 2_000, D_COST, [28_340, 27_300, 26_260]));
    await logger.handle({ type: 'bid_placed', auctionId: ID, ts: T0 + 3_000, price: 27_300, rungIndex: 1,
      cost: D_COST, minMarginPct: 1 });
    await logger.handle({ type: 'auction_result', auctionId: ID, ts: T0 + 9_000, won: true, finalRank: 1, closeModel: 'hard' });
    const rec = await store.getDoc('closedBids', ID);
    const { d } = wonBody(rec);
    ok(d.marketRate === '26,000' && d.marginPct === '5.00',
      `the standing 27,300 is measured against its own 26,000 (got ${d.marketRate} / ${d.marginPct})`);
  }

  console.log('\n3. a doc cost that is not a positive number never reaches a rupee figure');
  for (const cost of ['1,20,000', 'abc', 0, -1]) {
    const rec = { auctionId: '23423905', won: true, cost, lastBidPrice: 132_000,
      ourBids: [{ price: 132_000 }], lane: { origin: 'Bhiwandi', destination: 'Chennai' },
      equipment: '32ft SXL', units: 1, finalRank: 1 };
    const resolved = resolveBidTimeCost(rec);
    const { d, body } = wonBody(rec);
    ok(resolved === null, `cost ${JSON.stringify(cost)}: no margin anchor (got ${resolved})`);
    ok(!/NaN/.test(body) && !/Your Rate\* - ₹(0|-)/.test(body) && d.marginPct === undefined,
      `cost ${JSON.stringify(cost)}: the won receipt prints no Your Rate figure and no margin off it`);
  }

  const EXPECTED_CHECKS = 15;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (pass + fail !== EXPECTED_CHECKS) {
    console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
    process.exit(1);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL -', e && e.stack || e); process.exit(1); });
