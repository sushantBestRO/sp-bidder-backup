'use strict';
/**
 * D030: the export's realized margin must anchor on the BID-TIME cost (the cost that actually
 * authorised the placed bid), never the request's CURRENT (possibly since-corrected) cost - the
 * same anchor the outcome receipt and the per-customer EOD already use (G-CC11). A load whose cost
 * was corrected upward after the bid landed must not read a negative "arithmetically correct but
 * meaningless" margin on this surface while the receipt shows a genuine win.
 *
 * Regression target: D030. exportModel.js's canonical() computed `cost` from the request's CURRENT
 * price.cost and fed it straight into realizedMarginPct (exportModel.js:137-138, 204 at the time
 * this was written), disagreeing with engineAlerts/eodReport's bid-time anchor.
 *
 * @requires-summary-line
 *   node scripts/test-d030-export-realized-margin-bid-time-cost.js
 */
const assert = require('assert');
const { canonical } = require('../src/web/exportModel');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

(async () => {
  // The bid was placed at cost 10,000 (bidTimeCost on the landed bid). The desk later corrected
  // the request's current cost UP to 12,000 - a genuine +10% win must not read as an -8.3% loss.
  const req = { loadId: 'L1', price: { cost: 12000 } };
  const closed = {
    auctionId: 'L1', status: 'closed', cost: 12000, lastBidPrice: 11000,
    ourBids: [{ price: 11000, bidTimeCost: 10000, bidTimeMinMarginPct: 5 }],
  };
  const row = canonical(req, closed);
  ok(row.realizedMargin === 10, `realizedMargin must be computed against the BID-TIME cost (10000), got ${row.realizedMargin}`);
  ok(row.cost === 12000, 'the displayed Cost column stays the current/request cost (unchanged behaviour)');

  // Control: a legacy row with no bidTimeCost snapshot and no withdrawn-correction falls back to
  // the doc-level cost, exactly as resolveBidTimeCost's own fallback order says.
  const legacyClosed = { auctionId: 'L2', status: 'closed', cost: 9000, lastBidPrice: 9500, ourBids: [{ price: 9500 }] };
  const legacyRow = canonical({ loadId: 'L2', price: { cost: 9000 } }, legacyClosed);
  ok(legacyRow.realizedMargin === 5.6, `control: a legacy row with no snapshot falls back to doc cost, got ${legacyRow.realizedMargin}`);

  // Control: a funnel-only row (never bid, no closed doc) takes the same path it always did -
  // marginCost is null (no closed doc to read a bid-time snapshot from), so the row falls back to
  // the pre-existing (unchanged) cost/lastBid arithmetic rather than throwing.
  const noClosedRow = canonical({ loadId: 'L3', price: { cost: 5000 } }, null);
  ok(noClosedRow.cost === 5000, 'control: a row with no closed doc is unaffected by the bid-time-cost anchor');

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
