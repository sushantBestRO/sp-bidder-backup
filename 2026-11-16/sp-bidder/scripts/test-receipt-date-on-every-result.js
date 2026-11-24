'use strict';
/**
 * Every result receipt states the close to the second, with its date, and that close is the
 * PORTAL's close, never the instant this process finalized the auction.
 *
 * Regression target: BC-31 and the owner ruling "every result carries a date"; timing diagnosis
 * 2026-09-24 (timing-D) mechanisms M4 and M5. Plan test "test-receipt-date-on-every-result" under
 * PR-T6.
 *
 * THE DEFECT.
 *   M5 - the full templates print the close as DD-MM-YYYY hh:mm (fmtDMY, no seconds), and the two
 *        group replies print no close and no date at all (lost_short, no_bid_short via
 *        shortBidTimingLine). Receipts get forwarded the next day: a 23 Sep evening loss read on
 *        24 Sep carried no date.
 *   M4 - reportedCloseAt (src/util/reportedClose.js) refuses the portal close whenever it predates
 *        our last bid's `ts`, and falls back to closedAt, the finalize instant. `ts` is this
 *        machine's clock at accept; on GoComet the accept can come back after the close by our
 *        clock, so the win prints the finalize instant (about 5 min late) as the close.
 *
 * CASES.
 *   D1 SuperProcure hard close, Durian 25747721 shape, 24 Sep 2026, posted = final = 12:20:00.
 *      won (2 landed, last landed 27.0 - 0.6 = 26.4 s before close), lost + lost_short (2 landed),
 *      no_bid + no_bid_short (0 landed). All five must carry "12:20:00 pm, 24 Sep 2026" on the
 *      Closed line.
 *   D2 GoComet win, 260921CFQV shape, 21 Sep 2026: final close 13:47:00; last bid decided at
 *      13:46:57.100 on a 2.9 s countdown, accepted at 13:47:01.300 by our clock, so it landed
 *      2.9 - 4.2 = -1.3 s, i.e. after the close in force. Finalize at 13:52:04. The close must read
 *      "01:47:00 pm, 21 Sep 2026".
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   - D1: posted equals final, so no "(posted ...)" suffix anywhere.
 *   - D2: no gap is rendered as a negative number. How a landing after the close is worded is an
 *     open copy question and is deliberately not pinned here.
 *
 * Wording comes from scripts/fixtures/result-receipt-copy.js; this file owns only the facts.
 * Offline and deterministic: real BidLogger on a memory store, real notifyEngineEvent and renderer
 * (scripts/lib/result-receipt-harness.js), TZ pinned to IST.
 *
 *   node scripts/test-receipt-date-on-every-result.js
 */
const { istAt, closeAndRender, findLine, hasLine } = require('./lib/result-receipt-harness');
const copy = require('./fixtures/result-receipt-copy');

const MARK = '\u0001';
const POSTED_MARK = (() => {
  const withPosted = copy.closed('A', MARK).value;
  return withPosted.slice(copy.closed('A').value.length, withPosted.indexOf(MARK));
})();
const NEGATIVE_GAP = [/[-−]\s?\d+(\.\d+)?\s?s\b/, /[-−]\d+ min/];
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');

function placed({ price, rungIndex, decidedAt, closesInMs, acceptMs, believedCloseAt, cost, closeModel, rank }) {
  return {
    type: 'bid_placed', price, rungIndex, decidedAt, closesInMs, believedCloseAt,
    ts: decidedAt + acceptMs, latencyMs: acceptMs, cost, minMarginPct: 3, closeModel,
    socketRank: rank, extendsObserved: 0,
  };
}

const DURIAN_CLOSE = istAt(2026, 9, 24, 12, 20, 0);
const durianLoad = {
  companyName: 'Durian Industries Ltd', lane: { origin: 'Palghar', destination: 'Todapur' },
  equipment: '32 MXL (9.1 - 15 MT)', units: 1,
};
const durianArmed = {
  ts: istAt(2026, 9, 24, 11, 40, 0), cost: 88000, floor: 90640, minMarginPct: 3, marginsPct: [9, 7.2, 3],
  ladder: [95920, 94300, 90640], ...durianLoad,
};
const durianBids = [
  placed({ price: 95920, rungIndex: 0, decidedAt: istAt(2026, 9, 24, 12, 18, 20), closesInMs: 100000, acceptMs: 500, believedCloseAt: DURIAN_CLOSE, cost: 88000, closeModel: 'hard', rank: 2 }),
  placed({ price: 94300, rungIndex: 1, decidedAt: istAt(2026, 9, 24, 12, 19, 33), closesInMs: 27000, acceptMs: 600, believedCloseAt: DURIAN_CLOSE, cost: 88000, closeModel: 'hard', rank: 1 }),
];
const durianResult = {
  ts: DURIAN_CLOSE + 3000, closeModel: 'hard', finalCloseAt: DURIAN_CLOSE, postedCloseAt: DURIAN_CLOSE,
  attemptsAllowed: 3, finalCloseUnknown: false, ...durianLoad,
};
const D1_CLOSED = copy.closed(copy.clock(12, 20, 0));
const D1_DATE = copy.date(24, 9, 2026);

const D1_CASES = [
  {
    name: 'D1 SP hard won, Durian 25747721', variants: ['won'], landed: 2,
    events: durianBids,
    result: { ...durianResult, won: true, finalRank: 1, landedBids: 2, extensionsAfterLastBid: 0 },
  },
  {
    name: 'D1 SP hard lost, Durian 25747721', variants: ['lost', 'lost_short'], landed: 2,
    events: durianBids,
    result: { ...durianResult, won: false, finalRank: 2, landedBids: 2, extensionsAfterLastBid: 0 },
  },
  {
    name: 'D1 SP hard no_bid, Durian 25747721', variants: ['no_bid', 'no_bid_short'], landed: 0,
    events: [],
    result: {
      ...durianResult, won: false, finalRank: null, landedBids: 0, extensionsAfterLastBid: null,
      noBidReason: 'ceiling_below_floor', noBidCeiling: 89000, noBidFloor: 90640,
    },
  },
];

const GC_CLOSE = istAt(2026, 9, 21, 13, 47, 0);
const GC_FINALIZE = istAt(2026, 9, 21, 13, 52, 4);
const gcLoad = {
  companyName: 'Waaree Energies Ltd.',
  lane: { origin: 'Survey No. 12, GIDC Degam, Chikhli, Gujarat 396530', destination: 'MIDC Akola, Maharashtra 444001' },
  laneCells: { from: 'Degam 396530', to: 'Akola 444001' },
  equipment: '40 ft, 25 T', units: 1,
};
const D2 = {
  name: 'D2 GoComet won, 260921CFQV (last accept 1.3 s after the close by our clock)',
  auctionId: '260921CFQV', platformKey: 'gocomet',
  armed: {
    ts: istAt(2026, 9, 21, 13, 0, 0), cost: 65000, floor: 66950, minMarginPct: 3, marginsPct: [8, 5.5, 3.6],
    ladder: [70200, 68575, 67340], ...gcLoad,
  },
  events: [
    placed({ price: 70200, rungIndex: 0, decidedAt: istAt(2026, 9, 21, 13, 40, 0), closesInMs: 420000, acceptMs: 4000, believedCloseAt: GC_CLOSE, cost: 65000, closeModel: 'soft', rank: 3 }),
    placed({ price: 68575, rungIndex: 1, decidedAt: istAt(2026, 9, 21, 13, 45, 0), closesInMs: 120000, acceptMs: 3500, believedCloseAt: GC_CLOSE, cost: 65000, closeModel: 'soft', rank: 2 }),
    placed({ price: 67340, rungIndex: 2, decidedAt: istAt(2026, 9, 21, 13, 46, 57, 100), closesInMs: 2900, acceptMs: 4200, believedCloseAt: GC_CLOSE, cost: 65000, closeModel: 'soft', rank: 1 }),
  ],
  result: {
    ts: GC_FINALIZE, won: true, finalRank: 1, closeModel: 'soft', finalCloseAt: GC_CLOSE, postedCloseAt: GC_CLOSE,
    landedBids: 3, attemptsAllowed: 3, extensionsAfterLastBid: 0, finalCloseUnknown: false, ...gcLoad,
  },
};
const D2_CLOSED = copy.closed(copy.clock(13, 47, 0));
const D2_FINALIZE_HHMM = copy.clock(13, 52).slice(0, 5);

(async () => {
  let n = 0;
  const rendered = [];

  // ---- controls: the pipeline rendered the right receipt for the right load -------------------
  for (const c of D1_CASES) {
    const r = await closeAndRender({ auctionId: '25747721', platformKey: null, armed: durianArmed, events: c.events, result: c.result });
    n++;
    const bids = c.events.length;
    if (r.record.status !== 'closed' || (r.record.ourBids || []).length !== bids || r.record.finalCloseAt !== DURIAN_CLOSE) {
      throw new Error(`HARNESS: check ${n}: ${c.name}: record status ${r.record.status}, ourBids ${(r.record.ourBids || []).length}/${bids}, finalCloseAt ${r.record.finalCloseAt}`);
    }
    const got = c.variants.length === 1 ? [r.full] : [r.full, r.short];
    got.forEach((v, i) => {
      if (v.template !== c.variants[i] || String(v.data.oaNo) !== '25747721' || Number(v.data.landedBids) !== c.landed) {
        throw new Error(`HARNESS: check ${n}: ${c.name}: template ${v.template} (want ${c.variants[i]}), oaNo ${v.data.oaNo}, landedBids ${v.data.landedBids}`);
      }
      rendered.push({ c, v });
    });
  }
  const d2 = await closeAndRender(D2);
  n++;
  if (d2.full.template !== 'won' || String(d2.full.data.oaNo) !== D2.auctionId || d2.full.data.platformKey !== 'gocomet'
    || (d2.record.ourBids || []).length !== 3 || d2.record.finalCloseAt !== GC_CLOSE || d2.record.closedAt !== GC_FINALIZE) {
    throw new Error(`HARNESS: check ${n}: ${D2.name}: template ${d2.full.template}, oaNo ${d2.full.data.oaNo}, platform ${d2.full.data.platformKey}, `
      + `ourBids ${(d2.record.ourBids || []).length}/3, finalCloseAt ${d2.record.finalCloseAt}, closedAt ${d2.record.closedAt}`);
  }
  console.log(`ok controls: ${n} closes rendered (${rendered.length + 1} receipts) through BidLogger -> notifyEngineEvent -> templateFor`);

  const failures = [];
  const check = (cond, msg) => { n++; if (!cond) failures.push(`check ${n}: ${msg}`); };
  const closeLine = (text) => ascii(String(text).split('\n').filter((l) => /clos/i.test(l)).join(' | ') || '(no close line)');

  // ---- mechanism M5: the close to the second, with its date, on all five templates -------------
  for (const { c, v } of rendered) {
    check(hasLine(v.text, D1_CLOSED) && !(findLine(v.text, D1_CLOSED) || '').includes(D1_DATE),
      `BC-31 M5: ${v.template} receipt for ${c.name} has no "${D1_CLOSED.label} ... ${D1_CLOSED.value}" line without a date (owner: date not required); got: ${closeLine(v.text)}`);
  }

  // ---- mechanism M4: the win's close is the portal's, not the finalize instant -----------------
  check(hasLine(d2.full.text, D2_CLOSED),
    `BC-31 M4: won receipt for ${D2.name} has no "${D2_CLOSED.label} ... ${D2_CLOSED.value}" line; got: ${closeLine(d2.full.text)}`);
  check(!d2.full.text.includes(D2_FINALIZE_HHMM),
    `BC-31 M4: won receipt for ${D2.name} prints the finalize instant ${D2_FINALIZE_HHMM} as the close; got: ${closeLine(d2.full.text)}`);

  // ---- negative controls: no invented posted close, no negative gap ---------------------------
  for (const { c, v } of rendered) {
    const line = findLine(v.text, D1_CLOSED);
    check(!v.text.includes(POSTED_MARK),
      `BC-31 over-eager: ${v.template} for ${c.name} carries a "${POSTED_MARK.trim()}" suffix although posted equals final; got: ${ascii(line || closeLine(v.text))}`);
  }
  const negHit = NEGATIVE_GAP.map((re) => d2.full.text.match(re)).find(Boolean);
  check(!negHit,
    `BC-31 over-eager: won receipt for ${D2.name} renders a negative gap "${negHit && ascii(negHit[0])}"`);

  if (failures.length) {
    for (const f of failures) console.log(`FAIL ${f}`);
    console.log(`FAIL ${failures.length} of ${n} checks - BC-31 M4/M5: result receipts do not carry the portal close with seconds and date`);
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
})().catch((e) => {
  const msg = String(e && e.message);
  console.log(msg.startsWith('HARNESS:') ? msg : (e && e.stack) || e);
  process.exit(1);
});
