'use strict';
/**
 * Every result receipt states how many of the load's attempts were used.
 *
 * Regression target: BC-30 (attempts missing from results), timing-D mechanism M9
 * (the 2026-09-24 result-alert timing diagnosis). Plan test
 * "test-receipt-attempts-every-result" under PR-T6.
 *
 * THE DEFECT. PR #225 (9123dbb, 16 Sep 2026) removed the "Bid attempts" line from won and lost;
 * lost_short, no_bid and no_bid_short never had one. So the desk cannot check the branch's
 * attempt rule (3 per load on Durian, 10 on Transrail) from any result. The owner ruled attempts
 * back on all five templates as "{used} of {allowed} used", plus ", {n} refused by the portal" when
 * the portal refused any. used = the result's landedBids, allowed = auction_result.attemptsAllowed,
 * refused = the record's rejectedBids.
 *
 * Every case carries a complete new-shape result (decidedAt on each landed bid, attemptsAllowed,
 * extensionsAfterLastBid, postedCloseAt, finalCloseUnknown) so the line is judged on a realistic
 * payload. The attempts line is the only thing asserted; wording comes from the copy fixture.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   - a 3-landed load never reads "2 of 3 used";
 *   - a no-bid close with no refusal never claims "refused by the portal".
 *
 *   node scripts/test-receipt-attempts-every-result.js
 */
const { istAt, closeAndRender, hasLine } = require('./lib/result-receipt-harness');
const copy = require('./fixtures/result-receipt-copy');

function placed({ price, rungIndex, decidedAt, closesInMs, acceptMs, believedCloseAt, cost, closeModel, rank }) {
  return {
    type: 'bid_placed', price, rungIndex, decidedAt, closesInMs, believedCloseAt,
    ts: decidedAt + acceptMs, latencyMs: acceptMs, cost, minMarginPct: 3, closeModel,
    socketRank: rank, extendsObserved: 0,
  };
}

function refused({ price, rungIndex, ts, believedCloseAt, body }) {
  return { type: 'bid_rejected', price, rungIndex, ts, status: 400, reason: 'amount_cap', body, believedCloseAt, closeModel: 'hard' };
}

const DURIAN_CLOSE = istAt(2026, 9, 24, 12, 20, 0);
const durianWon = {
  name: 'SP hard won, Durian 25747721',
  auctionId: '25747721', platformKey: null, landed: 2, allowed: 3, refused: 0,
  full: 'won', short: 'won',
  armed: {
    ts: istAt(2026, 9, 24, 11, 40, 0), cost: 88000, floor: 90640, minMarginPct: 3, marginsPct: [9, 7.2, 3],
    ladder: [95920, 94300, 90640], companyName: 'Durian Industries Ltd',
    lane: { origin: 'Palghar', destination: 'Todapur' }, equipment: '32 MXL (9.1 - 15 MT)', units: 1,
  },
  events: [
    placed({ price: 95920, rungIndex: 0, decidedAt: istAt(2026, 9, 24, 12, 18, 20), closesInMs: 100000, acceptMs: 500, believedCloseAt: DURIAN_CLOSE, cost: 88000, closeModel: 'hard', rank: 2 }),
    placed({ price: 94300, rungIndex: 1, decidedAt: istAt(2026, 9, 24, 12, 19, 33), closesInMs: 27000, acceptMs: 600, believedCloseAt: DURIAN_CLOSE, cost: 88000, closeModel: 'hard', rank: 1 }),
  ],
  result: {
    ts: DURIAN_CLOSE + 3000, won: true, finalRank: 1, closeModel: 'hard', finalCloseAt: DURIAN_CLOSE,
    landedBids: 2, attemptsAllowed: 3, extensionsAfterLastBid: 0, postedCloseAt: DURIAN_CLOSE, finalCloseUnknown: false,
    companyName: 'Durian Industries Ltd', lane: { origin: 'Palghar', destination: 'Todapur' },
    equipment: '32 MXL (9.1 - 15 MT)', units: 1,
  },
};

// Posted 09:30 pm, extended once before our last bid (close in force 09:34:59) and twice after it.
const WAAREE_POSTED = istAt(2026, 9, 17, 21, 30, 0);
const WAAREE_AT_BID = istAt(2026, 9, 17, 21, 34, 59);
const WAAREE_FINAL = istAt(2026, 9, 17, 21, 44, 57);
const waareeLane = {
  origin: 'Survey No. 12, GIDC Degam, Chikhli, Gujarat 396530',
  destination: 'MIDC Akola, Maharashtra 444001',
};
const waareeLost = {
  name: 'GoComet lost, Waaree 2609173132',
  auctionId: '2609173132', platformKey: 'gocomet', landed: 3, allowed: 3, refused: 0,
  full: 'lost', short: 'lost_short',
  armed: {
    ts: istAt(2026, 9, 17, 20, 50, 0), cost: 65000, floor: 66950, minMarginPct: 3, marginsPct: [8, 5.5, 3.6],
    ladder: [70200, 68575, 67340], companyName: 'Waaree Energies Ltd.', lane: waareeLane,
    equipment: '40 ft, 25 T', units: 1,
  },
  events: [
    placed({ price: 70200, rungIndex: 0, decidedAt: istAt(2026, 9, 17, 21, 20, 0), closesInMs: 600000, acceptMs: 4200, believedCloseAt: WAAREE_POSTED, cost: 65000, closeModel: 'soft', rank: 3 }),
    placed({ price: 68575, rungIndex: 1, decidedAt: istAt(2026, 9, 17, 21, 26, 0), closesInMs: 240000, acceptMs: 3100, believedCloseAt: WAAREE_POSTED, cost: 65000, closeModel: 'soft', rank: 2 }),
    placed({ price: 67340, rungIndex: 2, decidedAt: istAt(2026, 9, 17, 21, 28, 40), closesInMs: 379000, acceptMs: 5000, believedCloseAt: WAAREE_AT_BID, cost: 65000, closeModel: 'soft', rank: 2 }),
  ],
  result: {
    ts: WAAREE_FINAL + 302000, won: false, finalRank: 2, closeModel: 'soft', finalCloseAt: WAAREE_FINAL,
    landedBids: 3, attemptsAllowed: 3, extensionsAfterLastBid: 2, postedCloseAt: WAAREE_POSTED, finalCloseUnknown: false,
    companyName: 'Waaree Energies Ltd.', lane: waareeLane, laneCells: { from: 'Degam 396530', to: 'Akola 444001' },
    equipment: '40 ft, 25 T', units: 1, shipperRef: 'ENT-2026-005232-3260104622',
  },
};

// Posted 03:10 pm; last bid 2.2 s before it at landing, then three 2-minute extensions.
const TRANSRAIL_POSTED = istAt(2026, 9, 21, 15, 10, 0);
const TRANSRAIL_FINAL = istAt(2026, 9, 21, 15, 16, 0);
const transrailLost = {
  name: 'SP soft lost, Transrail 25625834',
  auctionId: '25625834', platformKey: null, landed: 3, allowed: 10, refused: 0,
  full: 'lost', short: 'lost_short',
  armed: {
    ts: istAt(2026, 9, 21, 14, 30, 0), cost: 2450, floor: 2523, minMarginPct: 3, marginsPct: [8, 6, 4],
    ladder: [2646, 2597, 2548], companyName: 'Transrail Lighting Limited',
    lane: { origin: 'Umred', destination: 'Shergarh' }, equipment: 'Any Vehicle', units: 200,
  },
  events: [
    placed({ price: 2646, rungIndex: 0, decidedAt: istAt(2026, 9, 21, 15, 8, 0), closesInMs: 120000, acceptMs: 700, believedCloseAt: TRANSRAIL_POSTED, cost: 2450, closeModel: 'soft', rank: 8 }),
    placed({ price: 2597, rungIndex: 1, decidedAt: istAt(2026, 9, 21, 15, 9, 30), closesInMs: 30000, acceptMs: 650, believedCloseAt: TRANSRAIL_POSTED, cost: 2450, closeModel: 'soft', rank: 7 }),
    placed({ price: 2548, rungIndex: 2, decidedAt: istAt(2026, 9, 21, 15, 9, 57), closesInMs: 3000, acceptMs: 800, believedCloseAt: TRANSRAIL_POSTED, cost: 2450, closeModel: 'soft', rank: 6 }),
  ],
  result: {
    ts: TRANSRAIL_FINAL + 123000, won: false, finalRank: 6, closeModel: 'soft', finalCloseAt: TRANSRAIL_FINAL,
    landedBids: 3, attemptsAllowed: 10, extensionsAfterLastBid: 3, postedCloseAt: TRANSRAIL_POSTED, finalCloseUnknown: false,
    companyName: 'Transrail Lighting Limited', lane: { origin: 'Umred', destination: 'Shergarh' },
    equipment: 'Any Vehicle', units: 200,
  },
};

const SYNGENTA_CLOSE = istAt(2026, 9, 23, 16, 0, 0);
const syngentaArmed = {
  ts: istAt(2026, 9, 23, 15, 20, 0), cost: 42000, floor: 43260, minMarginPct: 3, marginsPct: [8, 5, 3],
  ladder: [45360, 44100, 43260], companyName: 'Syngenta India Ltd',
  lane: { origin: 'Goa', destination: 'Pune' }, equipment: '32 SXL (7 MT)', units: 1,
};
const syngentaResult = {
  ts: SYNGENTA_CLOSE + 3000, won: false, finalRank: null, closeModel: 'hard', finalCloseAt: SYNGENTA_CLOSE,
  landedBids: 0, attemptsAllowed: 3, extensionsAfterLastBid: null, postedCloseAt: SYNGENTA_CLOSE, finalCloseUnknown: false,
  companyName: 'Syngenta India Ltd', lane: { origin: 'Goa', destination: 'Pune' }, equipment: '32 SXL (7 MT)', units: 1,
};
const noBidClean = {
  name: 'SP hard no_bid, ceiling below floor, nothing refused',
  auctionId: '25760011', platformKey: null, landed: 0, allowed: 3, refused: 0,
  full: 'no_bid', short: 'no_bid_short',
  armed: syngentaArmed,
  events: [],
  result: { ...syngentaResult, noBidReason: 'ceiling_below_floor', noBidCeiling: 41000, noBidFloor: 43260 },
};
const noBidRefused = {
  name: 'SP hard no_bid, two attempts refused by the portal',
  auctionId: '25760012', platformKey: null, landed: 0, allowed: 3, refused: 2,
  full: 'no_bid', short: 'no_bid_short',
  armed: syngentaArmed,
  events: [
    refused({ price: 45360, rungIndex: 0, ts: istAt(2026, 9, 23, 15, 58, 20, 400), believedCloseAt: SYNGENTA_CLOSE, body: 'Amount should be less than or equal to 41000' }),
    refused({ price: 44100, rungIndex: 1, ts: istAt(2026, 9, 23, 15, 59, 40, 300), believedCloseAt: SYNGENTA_CLOSE, body: 'Amount should be less than or equal to 41000' }),
  ],
  result: { ...syngentaResult, noBidReason: 'refused_price_bound', noBidBound: 1 },
};

const CASES = [durianWon, waareeLost, transrailLost, noBidClean, noBidRefused];

(async () => {
  const rendered = [];
  let n = 0;

  // ---- controls: the pipeline rendered the right receipt for the right load -------------------
  for (const c of CASES) {
    const r = await closeAndRender({ auctionId: c.auctionId, platformKey: c.platformKey, armed: c.armed, events: c.events, result: c.result });
    const bids = c.events.filter((e) => e.type === 'bid_placed').length;
    const rejections = c.events.filter((e) => e.type === 'bid_rejected').length;
    const recBids = (r.record.ourBids || []).length;
    const recRejected = (r.record.rejectedBids || []).length;
    if (r.record.status !== 'closed' || recBids !== bids || recRejected !== rejections) {
      throw new Error(`HARNESS: check ${n + 1}: ${c.name}: record status ${r.record.status}, ourBids ${recBids}/${bids}, rejectedBids ${recRejected}/${rejections}`);
    }
    for (const [variant, want] of [['full', c.full], ['short', c.short]]) {
      const v = r[variant];
      if (v.template !== want || String(v.data.oaNo) !== c.auctionId || Number(v.data.landedBids) !== c.landed) {
        throw new Error(`HARNESS: check ${n + 1}: ${c.name} ${variant}: template ${v.template} (want ${want}), oaNo ${v.data.oaNo}, landedBids ${v.data.landedBids} (want ${c.landed})`);
      }
    }
    rendered.push({ c, r });
    n++;
  }
  console.log(`ok controls: ${n} receipts rendered through BidLogger -> notifyEngineEvent -> templateFor`);

  const failures = [];
  const check = (cond, msg) => { n++; if (!cond) failures.push(`check ${n}: ${msg}`); };

  // ---- mechanism (BC-30 / M9): the attempts line on every template -----------------------------
  for (const { c, r } of rendered) {
    const spec = copy.attempts(c.landed, c.allowed, c.refused);
    const variants = c.full === c.short ? [['full', r.full]] : [['full', r.full], ['short', r.short]];
    for (const [, v] of variants) {
      check(hasLine(v.text, spec),
        `BC-30 M9: ${v.template} receipt for ${c.name} has no "${spec.label} ... ${spec.value}" line `
        + `(landedBids ${c.landed}, attemptsAllowed ${c.allowed}, refused ${c.refused})`);
    }
  }

  // ---- negative controls: no wrong count, no invented refusal ----------------------------------
  const wrongCount = copy.attempts(2, 3).value;
  for (const v of [rendered[1].r.full, rendered[1].r.short]) {
    check(!v.text.includes(wrongCount),
      `BC-30 over-eager: ${v.template} for ${waareeLost.name} (3 landed) reads "${wrongCount}"`);
  }
  for (const v of [rendered[3].r.full, rendered[3].r.short]) {
    check(!v.text.includes('refused by the portal'),
      `BC-30 over-eager: ${v.template} for ${noBidClean.name} claims a refused attempt with none on the record`);
  }

  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`FAIL ${failures.length} of ${n} checks - BC-30 M9: result receipts carry no attempts line`);
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => {
  const msg = String(e && e.message);
  console.log(msg.startsWith('HARNESS:') ? msg : (e && e.stack) || e);
  process.exit(1);
});
