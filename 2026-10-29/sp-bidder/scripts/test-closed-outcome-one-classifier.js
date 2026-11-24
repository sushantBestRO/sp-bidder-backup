'use strict';
/**
 * One closed auction, one outcome: the console roll-up, the export status and the customer EOD
 * buckets must give the same class to the same closed-bids record.
 *
 * Regression target: R3-2 = T6 D3 (BH-LOGIC-4, BH-STATE-2), plus the NEW-3 / BC-33b row shape (a
 * win credited on the shared login with no bid of ours on the board).
 *
 * THE DEFECT. Three classifiers read the same closedBids records and disagree:
 *   - bidLogger.summarizeClosed (GET /api/closed-bids, the console win rate) counts won by the
 *     `won` flag alone and derives lost = total - won - noBid, reading neither closedWhileDown nor
 *     finalRank;
 *   - exportModel.deriveStatus goes zero-bids first, then won, then closed_unknown
 *     (closedWhileDown and no finalRank), then lost;
 *   - eodReport.collectCustomerDay skips a bid-less record and buckets the rest won / closedUnknown
 *     / lostDecided with the export's predicates.
 * So an auction nobody watched finish is a LOSS on the console and "result not seen" everywhere
 * else, and a win with no bid of ours is a bot WIN on the console and a no-bid everywhere else.
 * Both errors move the win rate the client judges the bidder by.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   1. control: a fought win, a fought loss and a zero-bid close class the same on all three;
 *   4. the export's own answers for the two disputed rows (closed_unknown, no_bid) and the EOD's
 *      agreement with them - the repair brings the roll-up to the export's rule, not the reverse;
 *   5. directorEod.deriveStatus, a fourth mirror of the same rule, agrees on every row.
 * Check 6 is the consequence the client sees: on a book of 2 won, 1 lost, 1 unseen, 1 no-bid and
 * 1 won-with-no-bid the export's win rate is 2 of 3 = 67; the console reports 3 of 5 = 60.
 *
 * Records are built by the real BidLogger on a memory store from engine-shaped events.
 *
 *   node scripts/test-closed-outcome-one-classifier.js
 */
const assert = require('assert');
const { BidLogger, summarizeClosed } = require('../src/logging/bidLogger');
const { deriveStatus } = require('../src/web/exportModel');
const { collectCustomerDay } = require('../src/notify/eodReport');
const directorEod = require('../src/notify/directorEod');
const { MemoryStore } = require('../src/store');

const EXPECTED_CHECKS = 6;
const T0 = Date.UTC(2026, 8, 20, 4, 0, 0);
const WIN_START = T0 - 3_600_000;
const WIN_END = T0 + 12 * 3_600_000;
const SHIPPER = 'Waaree Energies Ltd.';
const LANE = { origin: 'Degam', destination: 'Satara' };

const ROWS = {
  W1: { expect: 'won', events: [
    { type: 'bid_placed', ts: T0 + 1000, price: 70850, rungIndex: 0, rank: 1 },
    { type: 'auction_result', ts: T0 + 9000, won: true, finalRank: 1, closeModel: 'soft' }] },
  W2: { expect: 'won', events: [
    { type: 'bid_placed', ts: T0 + 1000, price: 50900, rungIndex: 0, rank: 1 },
    { type: 'auction_result', ts: T0 + 9000, won: true, finalRank: 1, closeModel: 'soft' }] },
  L1: { expect: 'lost', events: [
    { type: 'bid_placed', ts: T0 + 1000, price: 88000, rungIndex: 0, rank: 3 },
    { type: 'auction_result', ts: T0 + 9000, won: false, finalRank: 4, closeModel: 'soft' }] },
  N1: { expect: 'no_bid', events: [
    { type: 'auction_result', ts: T0 + 9000, won: false, finalRank: null, closeModel: 'soft' }] },
  U1: { expect: 'closed_unknown', events: [
    { type: 'bid_placed', ts: T0 + 1000, price: 85000, rungIndex: 0, rank: 1 },
    { type: 'closed_while_down', ts: T0 + 9000, won: null, finalRank: null }] },
  H1: { expect: 'no_bid', events: [
    { type: 'bid_rejected', ts: T0 + 1000, price: 16900, rungIndex: 0, status: 400, reason: 'price_raise_refused',
      body: 'Amount should be less than or equal to 16400' },
    { type: 'auction_result', ts: T0 + 9000, won: true, finalRank: 1, closeModel: 'hard', landedBids: 0 }] },
};

async function buildRecords() {
  const store = new MemoryStore();
  const logger = new BidLogger({ store, log: () => {} });
  for (const [id, row] of Object.entries(ROWS)) {
    await logger.handle({ type: 'armed', auctionId: id, ts: T0, lane: LANE, equipment: '32 SXL', units: 1,
      companyName: SHIPPER, cost: 60000, marginsPct: [8, 6, 5], minMarginPct: 5, ladder: [64800, 63600, 63000],
      floor: 63000 });
    for (const e of row.events) await logger.handle({ auctionId: id, ...e });
  }
  const recs = {};
  for (const id of Object.keys(ROWS)) {
    const r = await store.getDoc('closedBids', id);
    if (!r || r.status !== 'closed') throw new Error(`HARNESS: ${id} did not close through the logger (${JSON.stringify(r)})`);
    recs[id] = r;
  }
  if (!(recs.U1.closedWhileDown === true && recs.U1.finalRank == null && recs.U1.ourBids.length === 1)) {
    throw new Error(`HARNESS: U1 is not the unseen-close shape: ${JSON.stringify(recs.U1)}`);
  }
  if (!(recs.H1.won === true && recs.H1.ourBids.length === 0)) {
    throw new Error(`HARNESS: H1 is not the won-with-no-bid shape: ${JSON.stringify(recs.H1)}`);
  }
  return recs;
}

function rollupClass(rec) {
  const s = summarizeClosed([rec]);
  if (s.total !== 1) return `total=${s.total}`;
  if (s.won === 1) return 'won';
  if (s.lost === 1) return 'lost';
  if (s.noBid === 1) return 'no_bid';
  return 'closed_unknown';
}

async function eodClass(id, rec) {
  const store = new MemoryStore();
  await store.putDoc('closedBids', id, rec);
  const req = { loadId: id, createdAt: T0, capturedAt: T0 + 60_000, status: 'closed',
    load: { companyName: SHIPPER, lane: LANE, closesAt: T0 + 8000 } };
  const day = await collectCustomerDay({ requests: { listAll: async () => [req] }, store, aliases: [SHIPPER],
    windowStart: WIN_START, windowEnd: WIN_END, now: WIN_END - 1 });
  const moved = [];
  if (day.won) moved.push('won');
  if (day.lostDecided) moved.push('lost');
  if (day.closedUnknown) moved.push('closed_unknown');
  if (day.stillLive) moved.push('still_live');
  if (moved.length > 1) return moved.join('+');
  if (moved.length === 1) return moved[0];
  return day.participated === 0 && day.inquiries === 1 ? 'no_bid' : `unbucketed(participated=${day.participated})`;
}

function directorClass(rec) {
  return directorEod.deriveStatus('closed', { numBids: (rec.ourBids || []).length, won: rec.won,
    closedWhileDown: rec.closedWhileDown, finalRank: rec.finalRank });
}

async function classify(recs) {
  const out = {};
  for (const [id, rec] of Object.entries(recs)) {
    out[id] = { rollup: rollupClass(rec), export: deriveStatus(null, rec), eod: await eodClass(id, rec),
      director: directorClass(rec) };
  }
  return out;
}

const results = [];
function check(n, name, kind, fn) {
  let failure = null;
  try { failure = fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

const disagreement = (id, c) => (c.rollup === c.export && c.export === c.eod ? null
  : `${id}: roll-up=${c.rollup} export=${c.export} eod=${c.eod}`);

async function main() {
  const recs = await buildRecords();
  const cls = await classify(recs);

  check(1, 'control_won_lost_nobid_agree', 'control', () => {
    const bad = ['W1', 'W2', 'L1', 'N1'].map((id) => disagreement(id, cls[id]) || (cls[id].export !== ROWS[id].expect
      ? `${id}: export=${cls[id].export}, expected ${ROWS[id].expect}` : null)).filter(Boolean);
    return bad.length ? `HARNESS DEAD - the undisputed rows disagree: ${bad.join('; ')}` : null;
  });

  check(2, 'unseen_close_is_not_a_loss_on_the_rollup', 'mechanism', () => {
    const d = disagreement('U1', cls.U1);
    return d ? `${d} - summarizeClosed reads neither closedWhileDown nor finalRank, so an auction nobody `
      + 'watched finish is charged to lost' : null;
  });

  check(3, 'win_with_no_bid_of_ours_is_not_a_bot_win_on_the_rollup', 'mechanism', () => {
    const d = disagreement('H1', cls.H1);
    return d ? `${d} - summarizeClosed counts won by the flag before the zero-bid rule, so a win with no `
      + 'landed bid is credited to the bidder' : null;
  });

  check(4, 'export_and_eod_answers_for_disputed_rows_hold', 'positive pin', () => {
    const bad = ['U1', 'H1'].filter((id) => cls[id].export !== ROWS[id].expect || cls[id].eod !== ROWS[id].expect)
      .map((id) => `${id}: export=${cls[id].export} eod=${cls[id].eod}, expected ${ROWS[id].expect}`);
    return bad.length ? `the export/EOD rule moved: ${bad.join('; ')}` : null;
  });

  check(5, 'director_eod_mirror_agrees', 'positive pin', () => {
    const bad = Object.entries(cls).filter(([, c]) => c.director !== c.export)
      .map(([id, c]) => `${id}: director=${c.director} export=${c.export}`);
    return bad.length ? `directorEod mirror moved: ${bad.join('; ')}` : null;
  });

  check(6, 'console_win_rate_matches_the_export_on_the_book', 'mechanism', () => {
    const byExport = Object.values(cls).reduce((a, c) => { a[c.export] = (a[c.export] || 0) + 1; return a; }, {});
    const decided = (byExport.won || 0) + (byExport.lost || 0);
    const truth = Math.round(((byExport.won || 0) / decided) * 100);
    const s = summarizeClosed(Object.values(recs));
    assert.strictEqual(truth, 67, `HARNESS: export truth on this book is ${truth}, expected 67`);
    return s.winRate === truth && s.won === byExport.won && s.lost === byExport.lost && s.noBid === byExport.no_bid ? null
      : `console roll-up on the book {won:${s.won}, lost:${s.lost}, noBid:${s.noBid}, winRate:${s.winRate}} vs export `
        + `{won:${byExport.won}, lost:${byExport.lost}, noBid:${byExport.no_bid}, winRate:${truth}} - the win rate the `
        + 'client reads is derived by a second rule';
  });

  const failed = results.filter((r) => r.failure);
  if (results.length !== EXPECTED_CHECKS) {
    console.log(`FAIL - ran ${results.length} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  if (failed.length) {
    console.log(`FAIL ${failed.length} of ${results.length} checks - R3-2 / T6 D3: three classifiers give three `
      + 'answers for one closed auction (roll-up lost-by-subtraction and won-by-flag)');
    process.exit(1);
  }
  console.log(`PASS ${results.length}/${EXPECTED_CHECKS} checks - one closed auction, one class on every surface`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
