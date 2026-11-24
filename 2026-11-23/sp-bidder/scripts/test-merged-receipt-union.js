'use strict';
/**
 * The union assertion no single branch's suite can carry: one closed record holding BOTH
 * fix/bid-time-margin's bid-time cost snapshot and feat/gc-bid-timestamps' close/countdown capture,
 * rendered as one WON receipt. Neither branch's fixtures set the other's fields, so without this
 * nothing in the tree would notice a future change re-separating the two features.
 */
const assert = require('assert');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { canonical } = require('../src/web/exportModel');

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok  ' + m); passed += 1; };

// Local-time constructors, not UTC strings: fmtDMY/fmtClock read getHours(), so a UTC literal would
// make the expected strings depend on the runner's timezone.
const CLOSE = new Date(2026, 8, 8, 17, 59, 0, 0).getTime(); // 08-09-2026 05:59 PM, the portal's close
const BID_TS = CLOSE - 2000;                                // our snipe, 2s out
// The finalize instant, 190s late - the divergence the shared close resolver exists for. It must
// land in a DIFFERENT MINUTE from the close, or fmtDMY renders the two identically and the
// assertion below stops discriminating.
const FINALIZE = CLOSE + 190000;                            // 08-09-2026 06:02 PM

const rec = {
  auctionId: '260908LD2Z',
  status: 'closed', won: true, finalRank: 1, units: 1,
  cost: 38000,                 // desk corrected the cost AFTER the bid had landed
  minMarginPct: 1.8,
  lastBidPrice: 31610,
  ourBids: [{
    price: 31610, rungIndex: 0, ts: BID_TS,
    bidTimeCost: 29000, bidTimeMinMarginPct: 1,   // fix/bid-time-margin
    closesInMs: 2000, believedCloseAt: CLOSE,     // feat/gc-bid-timestamps
  }],
  closedAt: FINALIZE,          // the local finalize instant, NOT the reported close
  finalCloseAt: CLOSE,         // the portal's own close
};

const d = Object.assign({ oaNo: rec.auctionId, shipper: 'Havells', origin: 'Alwar', dest: 'Pune',
  landedBids: 1 }, outcomeEnrichment(rec));
const body = renderMessage(templateFor('won', d), d);
const lines = body.split('\n');

// --- the bid-time cost anchor must survive ---
ok(d.marketRate === '29,000', 'the margin is anchored on the bid-time cost, not the corrected one');
ok(body.includes('🏆 *Won Rate* - ₹31,610 (+9.00%)'), 'and the receipt renders +9.00%, not -16.82%');
ok(!body.includes('-16.82%'), 'the corrected-cost anchor never reaches the rendered margin');
// Owner's 2026-09-16 ruling: the below-cost fact is LINE 2, above the route, ahead of every field.
ok(lines[1] === '⚠️ *Cost increased to* ₹38,000 - ₹6,390 above the won amount. Please check on portal.',
  'the below-cost fact is line 2 of the receipt - it outranks the route');
ok(lines[2] === 'Alwar → Pune', 'and the route sits below it, on line 3');
ok(!body.includes('Squeeze the vendor'), 'the bid-lower nag stays suppressed on a below-cost win');

// --- the close/countdown capture must survive, on the same message ---
ok(d.closeTime === '08-09-2026 05:59 PM', 'the close is the PORTAL close, not the finalize instant');
ok(d.lastBidTime === '05:58 pm', 'our last bid time is carried');
ok(d.lastBidLeadMs === 2000, 'and the gap, because the bid countdown and the close agree');
ok(body.includes('*Bid Close Time* - 08-09-2026 05:59 PM')
  && body.includes('*Our last bid* - 05:58 pm (2s before close)'),
  'the receipt renders close, bid time and gap');

// --- and the two client-facing surfaces still agree on the close (r1 obligation O5) ---
const row = canonical({ loadId: rec.auctionId, load: {} }, rec);
ok(row.auctionCloseAt === CLOSE,
  'the export resolves the same close as the receipt, not the finalize instant');

// run-tests.js grades by exit status alone; the sentinel is what makes that exit code mean "every
// check ran", rather than "nothing threw before the first early return".
const EXPECTED_CHECKS = 11;
if (passed !== EXPECTED_CHECKS) {
  console.error(`COMPLETION SENTINEL FAILED: ran ${passed} of ${EXPECTED_CHECKS} checks`);
  process.exit(1);
}
console.log('\n' + passed + ' union checks passed');
