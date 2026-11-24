'use strict';
/**
 * A result record without the new timing and attempts stamps renders exactly as it does today.
 *
 * Positive pin for PR-T6 (BC-30 / BC-31 / BC-33, timing-D s.4-5): it must PASS on the unfixed tree
 * and stay green after the fix. In-flight auctions armed before the deploy, and every record already
 * on disk, carry none of the facts PR-T6 adds - no `decidedAt` on any bid, and no `attemptsAllowed`,
 * `extensionsAfterLastBid`, `postedCloseAt` or `finalCloseUnknown` on the result. Their receipts must
 * not change and must not gain an invented line: no attempts count with no allowance to count
 * against, no gap re-derived without a decision time, no "posted" close nobody recorded.
 *
 * Each case goes through the real BidLogger, notifyEngineEvent, templateFor and renderMessage, and
 * the whole text is compared byte-for-byte with what the base tree (d3bf803) rendered:
 *   1-2. SP hard lost, the bid's believedCloseAt equal to finalCloseAt: the old "Ns before close"
 *        lead shows (full lost, lost_short).
 *   3-4. GoComet lost extended after our last bid: the old guard drops the lead and shows the bid
 *        clock alone (full lost, lost_short).
 *   5.   SP hard won.
 *   6-7. no_bid and no_bid_short with a recorded ceiling_below_floor refusal and landedBids 0.
 *
 *   node scripts/test-receipt-legacy-record-unchanged.js
 */
const assert = require('assert');
const { istAt, closeAndRender } = require('./lib/result-receipt-harness');

function legacyBid({ price, rungIndex, ts, closesInMs, believedCloseAt, cost, closeModel, rank }) {
  return {
    type: 'bid_placed', price, rungIndex, ts, closesInMs, believedCloseAt, latencyMs: 600,
    cost, minMarginPct: 3, closeModel, socketRank: rank, extendsObserved: 0,
  };
}

const HAVELLS_CLOSE = istAt(2026, 9, 12, 17, 0, 0);
const havellsLost = {
  auctionId: '25439427', platformKey: null,
  armed: {
    ts: istAt(2026, 9, 12, 16, 20, 0), cost: 30000, floor: 30900, minMarginPct: 3, marginsPct: [8, 5, 3],
    ladder: [32400, 31500, 30900], companyName: 'Havells India Ltd',
    lane: { origin: 'Alwar', destination: 'Nagpur' }, equipment: '32 SXL (7 MT)', units: 1,
  },
  events: [
    legacyBid({ price: 32400, rungIndex: 0, ts: istAt(2026, 9, 12, 16, 58, 0), closesInMs: 120500, believedCloseAt: HAVELLS_CLOSE, cost: 30000, closeModel: 'hard', rank: 3 }),
    legacyBid({ price: 31500, rungIndex: 1, ts: istAt(2026, 9, 12, 16, 59, 32), closesInMs: 28400, believedCloseAt: HAVELLS_CLOSE, cost: 30000, closeModel: 'hard', rank: 2 }),
  ],
  result: {
    ts: HAVELLS_CLOSE + 3000, won: false, finalRank: 2, closeModel: 'hard', finalCloseAt: HAVELLS_CLOSE, landedBids: 2,
    companyName: 'Havells India Ltd', lane: { origin: 'Alwar', destination: 'Nagpur' }, equipment: '32 SXL (7 MT)', units: 1,
  },
};

const WAAREE_POSTED = istAt(2026, 9, 16, 21, 30, 0);
const WAAREE_FINAL = istAt(2026, 9, 16, 21, 39, 58);
const waareeLane = {
  origin: 'Survey No. 12, GIDC Degam, Chikhli, Gujarat 396530',
  destination: 'MIDC Akola, Maharashtra 444001',
};
const waareeExtended = {
  auctionId: '2609163001', platformKey: 'gocomet',
  armed: {
    ts: istAt(2026, 9, 16, 20, 50, 0), cost: 65000, floor: 66950, minMarginPct: 3, marginsPct: [8, 5.5, 3],
    ladder: [70200, 68575, 66950], companyName: 'Waaree Energies Ltd.', lane: waareeLane, equipment: '40 ft, 25 T', units: 1,
  },
  events: [
    legacyBid({ price: 70200, rungIndex: 0, ts: istAt(2026, 9, 16, 21, 20, 4), closesInMs: 600000, believedCloseAt: WAAREE_POSTED, cost: 65000, closeModel: 'soft', rank: 3 }),
    legacyBid({ price: 68575, rungIndex: 1, ts: istAt(2026, 9, 16, 21, 29, 50), closesInMs: 15000, believedCloseAt: WAAREE_POSTED, cost: 65000, closeModel: 'soft', rank: 2 }),
  ],
  result: {
    ts: WAAREE_FINAL + 302000, won: false, finalRank: 2, closeModel: 'soft', finalCloseAt: WAAREE_FINAL, landedBids: 2,
    companyName: 'Waaree Energies Ltd.', lane: waareeLane, laneCells: { from: 'Degam 396530', to: 'Akola 444001' },
    equipment: '40 ft, 25 T', units: 1, shipperRef: 'ENT-2026-005101-3260099310',
  },
};

const DURIAN_CLOSE = istAt(2026, 9, 15, 12, 20, 0);
const durianWon = {
  auctionId: '25612240', platformKey: null,
  armed: {
    ts: istAt(2026, 9, 15, 11, 40, 0), cost: 88000, floor: 90640, minMarginPct: 3, marginsPct: [9, 7.2, 3],
    ladder: [95920, 94300, 90640], companyName: 'Durian Industries Ltd',
    lane: { origin: 'Palghar', destination: 'Todapur' }, equipment: '32 MXL (9.1 - 15 MT)', units: 1,
  },
  events: [
    legacyBid({ price: 95920, rungIndex: 0, ts: istAt(2026, 9, 15, 12, 18, 20, 500), closesInMs: 100000, believedCloseAt: DURIAN_CLOSE, cost: 88000, closeModel: 'hard', rank: 2 }),
    legacyBid({ price: 94300, rungIndex: 1, ts: istAt(2026, 9, 15, 12, 19, 33, 600), closesInMs: 27000, believedCloseAt: DURIAN_CLOSE, cost: 88000, closeModel: 'hard', rank: 1 }),
  ],
  result: {
    ts: DURIAN_CLOSE + 3000, won: true, finalRank: 1, closeModel: 'hard', finalCloseAt: DURIAN_CLOSE, landedBids: 2,
    companyName: 'Durian Industries Ltd', lane: { origin: 'Palghar', destination: 'Todapur' }, equipment: '32 MXL (9.1 - 15 MT)', units: 1,
  },
};

const SYNGENTA_CLOSE = istAt(2026, 9, 14, 16, 0, 0);
const syngentaNoBid = {
  auctionId: '25590011', platformKey: null,
  armed: {
    ts: istAt(2026, 9, 14, 15, 20, 0), cost: 42000, floor: 43260, minMarginPct: 3, marginsPct: [8, 5, 3],
    ladder: [45360, 44100, 43260], companyName: 'Syngenta India Ltd',
    lane: { origin: 'Goa', destination: 'Pune' }, equipment: '32 SXL (7 MT)', units: 1,
  },
  events: [],
  result: {
    ts: SYNGENTA_CLOSE + 3000, won: false, finalRank: null, closeModel: 'hard', finalCloseAt: SYNGENTA_CLOSE, landedBids: 0,
    noBidReason: 'ceiling_below_floor', noBidCeiling: 41000,
    companyName: 'Syngenta India Ltd', lane: { origin: 'Goa', destination: 'Pune' }, equipment: '32 SXL (7 MT)', units: 1,
  },
};

// Captured by rendering each case on the base tree (d3bf803).
const EXPECTED = {
  'lost:25439427':
    '\ud83d\udd34 *LOST - Havells India Ltd*\n'
    + 'Alwar \u2192 Nagpur\n'
    + '\n'
    + '\ud83c\udd94 *OA No* - 25439427\n'
    + '\ud83d\ude9b *Vehicle Type* - 1 x 32 SXL (7 MT)\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b930,000\n'
    + '\ud83e\uddee *Our Bid* - \u20b931,500 (+5.00%)\n'
    + '\ud83c\udfc5 *Our Final Ranking* - 2\n'
    + '\u23f0 *Bid Close Time* - 12-09-2026 05:00 PM\n'
    + '\u23f1 *Our last bid* - 04:59 pm (28s before close)\n'
    + '\n'
    + '\ud83d\udcc9 _A sharper rate on this lane wins the next one._',
  'lost_short:25439427':
    '\ud83d\udd34 *LOST - Havells India Ltd*\n'
    + 'Alwar \u2192 Nagpur\n'
    + '\ud83d\ude9b 1 x 32 SXL (7 MT)\n'
    + '\ud83c\udfc5 *Our Final Ranking* - 2\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b930,000\n'
    + '\ud83e\uddee *Our Bid* - \u20b931,500 (+5.00%)\n'
    + '\u23f1 *Last bid* - 04:59 pm, 28s before close\n'
    + '\n'
    + '\ud83d\udcc9 _A sharper rate on this lane wins the next one._',
  'lost:2609163001':
    '\ud83d\udd34 *LOST - Waaree Energies Ltd.*\n'
    + 'Degam 396530 \u2192 Akola 444001\n'
    + '\n'
    + '\ud83c\udd94 *OA No* - 2609163001\n'
    + '\ud83d\ude9b *Vehicle Type* - 1 x 40 ft, 25 T\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b965,000\n'
    + '\ud83e\uddee *Our Bid* - \u20b968,575 (+5.50%)\n'
    + '\ud83c\udfc5 *Our Final Ranking* - 2\n'
    + '\u23f0 *Bid Close Time* - 16-09-2026 09:39 PM\n'
    + '\u23f1 *Our last bid* - 09:29 pm\n'
    + '\n'
    + '\ud83d\udcc9 _A sharper rate on this lane wins the next one._',
  'lost_short:2609163001':
    '\ud83d\udd34 *LOST - Waaree Energies Ltd.*\n'
    + 'Degam 396530 \u2192 Akola 444001\n'
    + '\ud83d\udd16 *OA* - ENT-2026-005101-3260099310\n'
    + '\ud83d\ude9b 1 x 40 ft, 25 T\n'
    + '\ud83c\udfc5 *Our Final Ranking* - 2\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b965,000\n'
    + '\ud83e\uddee *Our Bid* - \u20b968,575 (+5.50%)\n'
    + '\u23f1 *Last bid* - 09:29 pm\n'
    + '\n'
    + '\ud83d\udcc9 _A sharper rate on this lane wins the next one._',
  'won:25612240':
    '\ud83c\udf89 *WON - Durian Industries Ltd*\n'
    + 'Palghar \u2192 Todapur\n'
    + '\n'
    + '\ud83c\udd94 *OA No* - 25612240\n'
    + '\ud83d\ude9b *Vehicle Type* - 1 x 32 MXL (9.1 - 15 MT)\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b988,000\n'
    + '\ud83c\udfc6 *Won Rate* - \u20b994,300 (+7.16%)\n'
    + '\u23f0 *Bid Close Time* - 15-09-2026 12:20 PM\n'
    + '\u23f1 *Our last bid* - 12:19 pm (27s before close)\n'
    + '\n'
    + '\ud83c\udfc5 *Our Final Ranking* - 1. Complete the allotment on SuperProcure.',
  'no_bid:25590011':
    '\u26a0\ufe0f *NO BID PLACED - Syngenta India Ltd*\n'
    + 'Goa \u2192 Pune\n'
    + '\n'
    + 'Dear Manager,\n'
    + '\n'
    + 'Please note for the given \ud83c\udd94 *OA No* - 25590011\n'
    + '\ud83d\udccd *From* - Goa\n'
    + '\ud83c\udfaf *To* - Pune\n'
    + '\ud83d\ude9b *Vehicle Type* - 1 x 32 SXL (7 MT)\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b942,000\n'
    + '\u23f0 *Bid Close Time* - 14-09-2026 04:00 PM\n'
    + '\n'
    + '\ud83d\udccc _No bid placed - the customer\'s price ceiling (\u20b941,000) was below our cost (\u20b942,000), so any bid would have been at a loss._',
  'no_bid_short:25590011':
    '\u26a0\ufe0f *NO BID PLACED - Syngenta India Ltd*\n'
    + 'Goa \u2192 Pune\n'
    + '\ud83d\udcb0 *Your Rate* - \u20b942,000\n'
    + '\n'
    + '\ud83d\udccc _No bid placed - the customer\'s price ceiling (\u20b941,000) was below our cost (\u20b942,000), so any bid would have been at a loss._',
};

const CHECKS = [
  ['SP hard lost, believed close = final close', havellsLost, 'full', 'lost'],
  ['SP hard lost, believed close = final close', havellsLost, 'short', 'lost_short'],
  ['GoComet lost, extended after our last bid', waareeExtended, 'full', 'lost'],
  ['GoComet lost, extended after our last bid', waareeExtended, 'short', 'lost_short'],
  ['SP hard won', durianWon, 'full', 'won'],
  ['no-bid, ceiling below floor', syngentaNoBid, 'full', 'no_bid'],
  ['no-bid, ceiling below floor', syngentaNoBid, 'short', 'no_bid_short'],
];

(async () => {
  const cache = new Map();
  const failures = [];
  let n = 0;
  for (const [name, c, variant, template] of CHECKS) {
    n++;
    if (!cache.has(c)) cache.set(c, await closeAndRender(c));
    const v = cache.get(c)[variant];
    if (v.template !== template || String(v.data.oaNo) !== c.auctionId) {
      throw new Error(`HARNESS: check ${n}: ${name} ${variant}: template ${v.template} (want ${template}), oaNo ${v.data.oaNo}`);
    }
    try {
      assert.strictEqual(v.text, EXPECTED[`${template}:${c.auctionId}`]);
    } catch (_) {
      failures.push(`check ${n}: ${template} for ${name} (${c.auctionId}) no longer renders byte-identically to the base tree`);
    }
  }
  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`FAIL ${failures.length} of ${n} checks - a record without the PR-T6 stamps changed its receipt`);
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => {
  const msg = String(e && e.message);
  console.log(msg.startsWith('HARNESS:') ? msg : (e && e.stack) || e);
  process.exit(1);
});
