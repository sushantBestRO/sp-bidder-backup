'use strict';
/**
 * H1 - a recorded cost correction anchors the close receipt, on a row that carries no bid-time
 * snapshot.
 *
 * Two branches independently solved "price the receipt off the cost that priced the bid".
 * fix/bid-time-margin (664af10) read `costCorrection.from` off the closed-bids doc; #222 stamped a
 * per-bid `bidTimeCost` snapshot and read that. The merge took #222's file wholesale, so the writer
 * at bidLogger.js:72 survived with no reader - and every record whose last bid predates the
 * snapshot (it arrived in dc7097d) fell back to the doc-level cost, which after an upward
 * correction is a number no bid was ever placed at. A +9.00% win rendered as -16.82% and the
 * owner's cost-increase escalation did not fire at all.
 *
 * The two sources are not alternatives: the snapshot is per-bid and exact, the correction record is
 * what the older rows have instead. This pins the fallback order snapshot -> withdrawn cost -> doc
 * cost, and that both populations reach the SAME line-2 escalation.
 *
 *   node scripts/test-costcorrection-receipt-anchor.js
 */
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

const T0 = 1788869161610;
const COST = 29000;          // what the desk entered, and what priced the bid
const BID = 31610;           // cost x 1.09
const CORRECTED = 38000;     // the desk's upward correction, after the bid had landed
const GAP = CORRECTED - BID; // 6,390 - what the win comes in under the corrected cost
const ALERT = `⚠️ *Cost increased to* ₹38,000 - ₹6,390 above the won amount. Please check on portal.`;

const armed = {
  type: 'armed', auctionId: 'H1REC', lane: { origin: 'Alwar', destination: 'Pune' },
  equipment: '32ft', units: 1, companyName: 'Havells', platformKey: 'superprocure',
  marginsPct: [9, 7.2, 1.8], minMarginPct: 1,
};

// The real logger, the real events. `snapshot` false omits `cost` from bid_placed, which is exactly
// how every row written before dc7097d looks: bidTimeCost lands null and bidTimeBand returns null.
async function record({ snapshot, corrections = [[COST, CORRECTED]], won = true, reprice = null }) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store });
  await logger.handle(Object.assign({}, armed, { ts: T0, cost: COST, ladder: [BID, 30450, 29290], floor: 29290 }));
  const bid = { type: 'bid_placed', auctionId: 'H1REC', ts: T0 + 52000, price: BID, rungIndex: 0, rank: null, socketRank: 1 };
  if (snapshot) { bid.cost = COST; bid.minMarginPct = 1; }
  await logger.handle(bid);
  for (const [from, to, resumed] of corrections) {
    await logger.noteCostCorrection('H1REC', { from, to, standingBidPrice: BID, resumed: !!resumed });
    await logger.handle(Object.assign({}, armed, { ts: T0 + 163000, cost: to, ladder: [to * 1.09, to * 1.05, to], floor: to }));
  }
  // The OTHER way a hold ends: an ordinary re-price supersedes it. retireHold clears the hold on the
  // request, the engine re-arms at the new cost and bids again, and no route clears costCorrection.
  if (reprice) {
    await logger.handle(Object.assign({}, armed, { ts: T0 + 200000, cost: reprice.cost,
      ladder: [Math.round(reprice.cost * 1.09), Math.round(reprice.cost * 1.05), reprice.bid], floor: reprice.bid }));
    await logger.handle({ type: 'bid_placed', auctionId: 'H1REC', ts: T0 + 240000, price: reprice.bid, rungIndex: 2, rank: null, socketRank: 1 });
  }
  await logger.handle({ type: 'auction_result', auctionId: 'H1REC', ts: T0 + 7933000, won, finalRank: won ? 1 : 4, closeModel: 'soft' });
  return store.getDoc('closedBids', 'H1REC');
}

const receipt = (rec, kind) => {
  const d = Object.assign({ oaNo: rec.auctionId, shipper: 'Havells', origin: 'Alwar', dest: 'Pune',
    finalRank: rec.finalRank, landedBids: 1 }, outcomeEnrichment(rec));
  return { d, body: renderMessage(templateFor(kind || 'won', d), d) };
};

(async () => {
  console.log('\n1. the failing population - a won load with a recorded correction and NO bid-time snapshot');
  {
    const rec = await record({ snapshot: false });
    ok(rec.cost === CORRECTED && rec.lastBidPrice === BID && rec.ourBids.length === 1,
      'the fixture is the production shape: doc cost 38,000, landed bid 31,610');
    ok(rec.ourBids[0].bidTimeCost == null,
      'and its only bid carries no bid-time cost snapshot - the pre-dc7097d shape');
    ok(rec.costCorrection && rec.costCorrection.from === COST && rec.costCorrection.to === CORRECTED,
      'while the desk\'s correction IS on the record, carried through the re-arm that followed it');

    const { d, body } = receipt(rec);
    ok(d.marketRate === '29,000',
      `the margin anchors on the withdrawn cost, the one that priced the bid (got ${d.marketRate})`);
    ok(d.marginPct === '9.00', `so the win reports the margin it was placed at, +9.00% (got ${d.marginPct})`);
    ok(d.belowRateBy === undefined,
      'and claims no shortfall against a cost the bid was never measured against');
    ok(d.costCorrectedTo === '38,000' && d.belowCostBy === '6,390',
      `with the win's factual position against the corrected cost in rupees (got ${d.costCorrectedTo} / ${d.belowCostBy})`);
    ok(d.rateChangedFrom === '29,000' && d.rateChangedTo === '38,000',
      `and the informational trail naming both figures (got ${d.rateChangedFrom} -> ${d.rateChangedTo})`);
    ok(body.split('\n')[1] === ALERT,
      `THE ESCALATION FIRES: line 2 of the receipt is the cost-increase headline (got: ${body.split('\n')[1]})`);
    ok(body.includes('🏆 *Won Rate* - ₹31,610 (+9.00%)'),
      'and the Won Rate line renders +9.00%, not -16.82%');
    ok(!body.includes('-16.82%'), 'the corrected-cost anchor never reaches the rendered margin');
    ok(!/below your rate/.test(body),
      'nor the "stands below your rate" line, which on this row would state a loss on a profitable win');
  }

  console.log('\n2. the snapshot-bearing twin renders identically - the snapshot still wins, it is not replaced');
  {
    const rec = await record({ snapshot: true });
    ok(rec.ourBids[0].bidTimeCost === COST, 'this one DOES carry the per-bid snapshot');
    const { d, body } = receipt(rec);
    ok(d.marketRate === '29,000' && d.marginPct === '9.00', 'same anchor, same margin');
    ok(d.minMarginPct === 1,
      `and the floor still comes from the snapshot's own epoch, not the doc's (got ${d.minMarginPct})`);
    ok(body.split('\n')[1] === ALERT, 'and the same line-2 escalation as the pre-snapshot row');
  }

  console.log('\n3. a resume withdraws the anchor - the restored cost is the one that prices the bid again');
  {
    const rec = await record({ snapshot: false, corrections: [[COST, CORRECTED], [CORRECTED, COST, true]] });
    ok(rec.costCorrection == null, 'the live override is retired by the resume');
    ok(rec.costCorrections.length === 2, 'while the append-only trail keeps both moves');
    const { d, body } = receipt(rec);
    ok(d.marketRate === '29,000' && d.marginPct === '9.00',
      'the receipt prices off the restored cost, which is rec.cost again');
    ok(d.costCorrectedTo === undefined && !body.includes('Cost increased to'),
      'and escalates nothing - there is no correction standing to escalate');
  }

  console.log('\n4. repeat corrections with no resume in between anchor on the FIRST withdrawn cost');
  {
    // No bid can land between two corrections - the load is held throughout - so the cost that
    // priced the standing bid is the one the first correction withdrew, not the second's `from`.
    const rec = await record({ snapshot: false, corrections: [[COST, CORRECTED], [CORRECTED, 42000]] });
    ok(rec.cost === 42000 && rec.costCorrection.from === CORRECTED,
      'the live override names only the latest move');
    const { d } = receipt(rec);
    ok(d.marketRate === '29,000',
      `but the anchor walks back to the cost that actually priced the bid (got ${d.marketRate})`);
    ok(d.marginPct === '9.00', 'so a second correction cannot restate the margin either');
    ok(d.costCorrectedTo === '42,000' && d.belowCostBy === '10,390',
      `while the position is stated against where the cost now stands (got ${d.costCorrectedTo} / ${d.belowCostBy})`);
  }

  console.log('\n5. a hold retired by an ordinary re-price cannot anchor the bid that comes after it');
  {
    // 29,000 -> 38,000 held the load; the desk then re-priced to 25,000, which retireHold cleared the
    // hold for while leaving the override standing. The engine re-armed and bid 25,250 - +1.00% over
    // the cost that priced it - and the withdrawn 29,000 rendered that win as a -12.93% loss with a
    // squeeze-the-vendor instruction attached.
    const rec = await record({ snapshot: false, reprice: { cost: 25000, bid: 25250 } });
    ok(rec.costCorrection && rec.costCorrection.from === COST && rec.lastBidPrice === 25250,
      'the fixture is the production shape: the superseded override still on the record, under a newer bid');
    const { d, body } = receipt(rec);
    ok(d.marketRate === '25,000',
      `the anchor is the cost that priced the standing bid, not the one the hold withdrew (got ${d.marketRate})`);
    ok(d.marginPct === '1.00', `so a bid placed at +1.00% reports +1.00% (got ${d.marginPct})`);
    ok(d.belowRateBy === undefined && !/below your rate/.test(body),
      'and the win states no shortfall against a rate it was never priced against');
    ok(!body.includes('-12.93%'), 'the withdrawn cost never reaches the rendered margin');
    ok(d.costCorrectedTo === undefined && !body.includes('Cost increased to'),
      'nor escalates a correction the desk has already re-priced past');
  }

  console.log('\n6. what must NOT change');
  {
    // A row with no snapshot and no correction record cannot evidence either, and keeps the
    // doc-cost rendering it has always had - including a genuinely negative margin.
    const legacy = outcomeEnrichment({ auctionId: 'L1', cost: CORRECTED, lastBidPrice: BID, won: true,
      finalRank: 1, status: 'closed', closedAt: T0, ourBids: [{ price: BID, rungIndex: 0, ts: T0 }] });
    ok(legacy.marketRate === '38,000' && legacy.marginPct === '-16.82',
      `a row with no evidence of a correction renders off the doc cost, unchanged (got ${legacy.marketRate} / ${legacy.marginPct})`);
    ok(legacy.belowRateBy === String(GAP.toLocaleString('en-IN')) || legacy.belowRateBy === '6,390',
      'and keeps the rupee-position line that is the only signal it can carry');
    ok(legacy.costCorrectedTo === undefined, 'it claims no correction it cannot evidence');

    // A LOSS commits nothing, so it escalates nothing - the correction still rides as information.
    const lost = await record({ snapshot: false, won: false });
    const { d, body } = receipt(lost, 'lost');
    ok(d.costCorrectedTo === undefined && d.belowCostBy === undefined,
      'a loss carries no position against the corrected cost');
    ok(!body.includes('Cost increased to'), 'and escalates nothing');
    ok(d.rateChangedFrom === '29,000' && d.rateChangedTo === '38,000',
      'but the rate still moved, and the trail still says so');

    // A DOWNWARD correction on a pre-snapshot row: the margin is unaffected, and nothing may print
    // a cost increase that did not happen.
    const down = await record({ snapshot: false, corrections: [[COST, 24000]] });
    const dn = receipt(down);
    ok(dn.d.marketRate === '29,000' && dn.d.marginPct === '9.00',
      'a downward correction still reports the bid-time margin');
    ok(dn.d.costCorrectedTo === undefined && !dn.body.includes('Cost increased to'),
      'and no cost-increase headline on a cost that came down');
    ok(!/₹-/.test(dn.body), 'no rupee figure renders with a leading minus');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
