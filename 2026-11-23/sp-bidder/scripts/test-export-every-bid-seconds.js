'use strict';
/**
 * The every-bid export states each bid's time to the second, the close in force when it was placed,
 * the final close, and the gap in seconds to both.
 *
 * Regression target: BC-40 (export needs seconds and the close); timing diagnosis 2026-09-24
 * (timing-D) section 4, the export half of M3/M5/M8.
 *
 * THE DEFECT. exportModel.bidsView prints Bid Time through csv.istDateTime, which is "YYYY-MM-DD
 * HH:MM", so a bid 2.1 s before a hard close and one 59 s before it read the same. The sheet has no
 * close at all: nothing says which close a bid was racing, what the auction finally closed at, or how
 * far ahead of either the bid landed. The desk cannot reconcile a lost load against the portal from
 * this file.
 *
 * HAND-WORKED FACTS (contract: landing gap = closesInMs - (ts - decidedAt); gap to final = landing
 * gap + (finalCloseAt - that bid's believedCloseAt)):
 *   X1 GoComet 2609173132: 376.4 - 3.6 = 372.8 s to the close in force (21:34:58);
 *      + (21:44:59 - 21:34:58 = 601 s) = 973.8 s to the final close (21:44:59).
 *   X2 SP hard: 2.4 - 0.3 = 2.1 s; believed close = final close, so 2.1 s to both.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   - every pre-existing column of the bids sheet keeps its value for X1 (Bid Time excepted: it
 *     gains seconds).
 *   - the Outcomes sheet's auction close for X1 reads 21:44, through reportedCloseAt like the
 *     receipt.
 *
 * Columns are located by header name, never by position. Header names come from
 * scripts/fixtures/result-receipt-copy.js EXPORT_HEADERS. A legacy bid without decidedAt is
 * deliberately not pinned here.
 *
 *   node scripts/test-export-every-bid-seconds.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const { EXPORT_HEADERS, RETIRED_BID_COLUMNS } = require('./fixtures/result-receipt-copy');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const model = require('../src/web/exportModel');

const { istAt, closeThroughLogger, renderResult } = h;

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');

const failures = [];
let checkNo = 0;
function check(mechanism, desc, ok) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${mechanism}] ${desc}`);
}

function harness(cond, msg) {
  assert.ok(cond, `HARNESS: ${msg}`);
}

const X1_ID = '2609173132';
const X1_TS = istAt(2026, 9, 17, 21, 28, 45, 0);
const X1_IN_FORCE = istAt(2026, 9, 17, 21, 34, 58);
const X1_FINAL = istAt(2026, 9, 17, 21, 44, 59);
const x1 = {
  auctionId: X1_ID, platformKey: 'gocomet',
  armed: { companyName: 'Waaree Energies Ltd.', lane: { origin: 'Degam', destination: 'Akola' }, cost: 48000 },
  events: [{
    type: 'bid_placed', price: 50000, rungIndex: 2, ts: X1_TS, decidedAt: X1_TS - 3600, closesInMs: 376400,
    believedCloseAt: X1_IN_FORCE, latencyMs: 3600, socketRank: 2, extendsObserved: 0, engineRevisionsLeft: 1,
    cost: 48000, closeModel: 'soft',
  }],
  result: {
    won: false, finalRank: 2, closeModel: 'soft', companyName: 'Waaree Energies Ltd.',
    lane: { origin: 'Degam', destination: 'Akola' },
    postedCloseAt: istAt(2026, 9, 17, 21, 30, 0), finalCloseAt: X1_FINAL, extensionsAfterLastBid: 2,
    attemptsAllowed: 3, landedBids: 1, ts: istAt(2026, 9, 17, 21, 50, 4),
  },
};

const X2_ID = '25631177';
const X2_CLOSE = istAt(2026, 9, 21, 15, 10, 0);
const X2_TS = X2_CLOSE - 2100;
const x2 = {
  auctionId: X2_ID, platformKey: null,
  armed: { companyName: 'Havells India Ltd', lane: { origin: 'Alwar', destination: 'Pune' }, cost: 50000 },
  events: [{
    type: 'bid_placed', price: 53150, rungIndex: 1, ts: X2_TS, decidedAt: X2_TS - 300, closesInMs: 2400,
    believedCloseAt: X2_CLOSE, latencyMs: 300, cost: 50000, closeModel: 'hard',
  }],
  result: {
    won: true, finalRank: 1, closeModel: 'hard', companyName: 'Havells India Ltd',
    lane: { origin: 'Alwar', destination: 'Pune' },
    postedCloseAt: X2_CLOSE, finalCloseAt: X2_CLOSE, extensionsAfterLastBid: 0,
    attemptsAllowed: null, landedBids: 1, ts: X2_CLOSE + 4000,
  },
};

async function exportFor(closedCase) {
  const requests = new PriceRequestStore({ store: closedCase.store, marginsPct: [10], minMarginPct: 5 });
  const datasets = await model.buildDatasets({ requests, bidLogger: closedCase.logger });
  return {
    bids: model.VIEWS.bids.project(datasets[model.VIEWS.bids.dataset]),
    outcomes: model.VIEWS.outcomes.project(datasets[model.VIEWS.outcomes.dataset]),
  };
}

const hasCol = (view, name) => view.headers.indexOf(name) !== -1;
const cellOf = (view, row, name) => {
  const i = view.headers.indexOf(name);
  return i === -1 ? undefined : row[i];
};
const rowFor = (view, loadId) => view.rows.filter((r) => String(cellOf(view, r, 'Load Id')) === loadId);

async function main() {
  const c1 = await closeThroughLogger(x1);
  const c2 = await closeThroughLogger(x2);
  const e1 = await exportFor(c1);
  const e2 = await exportFor(c2);
  const receipt1 = await renderResult({ record: c1.record, resultEvent: c1.resultEvent, platformKey: 'gocomet' });

  // Controls: the pipeline carried the right facts to the export and the receipt.
  for (const [name, c, ts, finalAt] of [['X1', c1, X1_TS, X1_FINAL], ['X2', c2, X2_TS, X2_CLOSE]]) {
    const b = c.record.ourBids;
    harness(Array.isArray(b) && b.length === 1 && b[0].ts === ts, `${name}: the record did not keep our one bid`);
    harness(b[0].closesInMs != null && b[0].believedCloseAt != null, `${name}: the record dropped closesInMs/believedCloseAt`);
    harness(c.record.finalCloseAt === finalAt, `${name}: the record did not keep finalCloseAt`);
  }
  for (const [name, e, id] of [['X1', e1, X1_ID], ['X2', e2, X2_ID]]) {
    harness(hasCol(e.bids, 'Load Id') && hasCol(e.bids, EXPORT_HEADERS.bidTime), `${name}: bids sheet lost its Load Id / Bid Time headers`);
    harness(rowFor(e.bids, id).length === 1, `${name}: bids sheet has ${rowFor(e.bids, id).length} rows for load ${id}, want 1`);
    harness(rowFor(e.outcomes, id).length === 1, `${name}: outcomes sheet has no row for load ${id}`);
  }
  harness(receipt1.kind === 'lost' && receipt1.text.includes(X1_ID), `X1: receipt routed as ${receipt1.kind} or does not name ${X1_ID}`);

  const b1 = e1.bids;
  const r1 = rowFor(b1, X1_ID)[0];

  // Mechanism checks (red on base).
  check('BC-40 columns', `bids sheet has a "${EXPORT_HEADERS.bidTime}" column (headers: ${b1.headers.join(' | ')})`, hasCol(b1, EXPORT_HEADERS.bidTime));
  for (const name of RETIRED_BID_COLUMNS) {
    check('ruling 29 columns', `bids sheet no longer has a "${name}" column (headers: ${b1.headers.join(' | ')})`, !hasCol(b1, name));
  }

  const X1_WANT = [
    [EXPORT_HEADERS.bidTime, '2026-09-17 21:28:45'],
  ];
  for (const [name, want] of X1_WANT) {
    const got = cellOf(b1, r1, name);
    check('BC-40 seconds', `X1 "${name}" = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`, got === want);
  }
  // Guards (green on base, must stay green).
  const X1_OLD = {
    'Load Id': X1_ID, Platform: 'gocomet', Customer: 'Waaree Energies Ltd.', Branch: '',
    Origin: 'Degam', Destination: 'Akola', 'Bid #': 1, 'Rung Index': 2, Price: 50000, 'Rank (socket)': 2,
    'Latency(ms)': 3600, 'Extends Observed': 0, 'Revisions Left': 1,
  };
  for (const [name, want] of Object.entries(X1_OLD)) {
    const got = cellOf(b1, r1, name);
    check('guard: pre-existing bids columns', `X1 "${name}" = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`, got === want);
  }
  const o1 = e1.outcomes;
  const or1 = rowFor(o1, X1_ID)[0];
  check('guard: outcomes close via reportedCloseAt', `X1 outcomes Auction Date/Time = ${cellOf(o1, or1, 'Auction Date')} ${cellOf(o1, or1, 'Auction Time')}, want 2026-09-17 21:44`,
    cellOf(o1, or1, 'Auction Date') === '2026-09-17' && cellOf(o1, or1, 'Auction Time') === '21:44');

  if (failures.length) {
    for (const f of failures) console.log(ascii(f));
    console.log(`FAILED ${failures.length} of ${checkNo} checks - BC-40: the every-bid export has no seconds, no close at bid, no final close and no gap to either`);
    process.exit(1);
  }
  console.log(`PASS ${checkNo} checks`);
}

main().catch((e) => {
  console.log(ascii(e && e.stack ? e.stack : e));
  process.exit(1);
});
