'use strict';
/**
 * The export carries one row per closed load saying where our last bid stood and why the load ended,
 * and the every-bid sheet no longer carries the four per-bid close columns it replaces.
 *
 * Regression target: owner ruling 29 (24 Sep 2026, loss-cause tag), export half. Headers, the
 * retired columns and the result words come from scripts/fixtures/result-receipt-copy.js.
 *
 * HAND-WORKED FACTS (gap to the actual close = closesInMs - (ts - decidedAt) + (final close - the
 * close in force at the bid)):
 *   L1 GoComet 2609173132: 376.4 - 3.6 + 601 = 973.8 s. 67,340 = 65,000 x 1.036, the lowest band
 *      margin. Held rank 1 after it, finished 2, not in the final seconds.
 *   L2 SP hard 25631177 won: 2.4 - 0.3 = 2.1 s, no extension, in the final seconds.
 *   L3 Havells 25702437: refused "already ended" 5 min 36 s before the published close, no bid.
 *   L4 a record persisted before ruling 29: none of the new facts, so nothing is stated for them.
 *
 * WHAT MUST NOT MOVE (green on the base too): the bids sheet keeps Load Id and Bid Time.
 *
 *   node scripts/test-last-bid-sheet.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const { EXPORT_HEADERS, RETIRED_BID_COLUMNS, LAST_BID_HEADERS, RESULT_WORDS } = require('./fixtures/result-receipt-copy');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const model = require('../src/web/exportModel');

const { istAt, closeThroughLogger } = h;

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const failures = [];
let n = 0;
const check = (mech, ok, msg) => { n += 1; if (!ok) failures.push(`FAIL ${n} [${mech}] ${msg}`); };
const harness = (ok, msg) => assert.ok(ok, `HARNESS: ${msg}`);

const L1_TS = istAt(2026, 9, 17, 21, 28, 45);
const L1 = {
  auctionId: '2609173132', platformKey: 'gocomet',
  armed: { companyName: 'Waaree Energies Ltd.', lane: { origin: 'Degam', destination: 'Akola' }, cost: 65000, marginsPct: [9, 7.2, 3.6],
    minMarginPct: 2, ladder: [70850, 69680, 67340, 66300], floor: 66300 },
  events: [{ type: 'bid_placed', price: 67340, rungIndex: 2, ts: L1_TS, decidedAt: L1_TS - 3600, closesInMs: 376400,
    believedCloseAt: istAt(2026, 9, 17, 21, 34, 58), cost: 65000, minMarginPct: 2, closeModel: 'soft', socketRank: 1 }],
  result: {
    won: false, finalRank: 2, closeModel: 'soft', landedBids: 1, attemptsAllowed: 3, extensionsAfterLastBid: 2,
    postedCloseAt: istAt(2026, 9, 17, 21, 30, 0), finalCloseAt: istAt(2026, 9, 17, 21, 44, 59), finalCloseUnknown: false,
    lastBidBeforeTriggerWindow: true, leadAfterLastBid: true, lastBidInFinalSeconds: false, ts: istAt(2026, 9, 17, 21, 50, 4),
  },
};

const L2_CLOSE = istAt(2026, 9, 21, 15, 10, 0);
const L2_TS = L2_CLOSE - 2100;
const L2 = {
  auctionId: '25631177', platformKey: null,
  armed: { companyName: 'Havells India Ltd', lane: { origin: 'Alwar', destination: 'Pune' }, cost: 50000, marginsPct: [10, 6.3],
    minMarginPct: 5, ladder: [55000, 53150], floor: 52500 },
  events: [{ type: 'bid_placed', price: 53150, rungIndex: 1, ts: L2_TS, decidedAt: L2_TS - 300, closesInMs: 2400,
    believedCloseAt: L2_CLOSE, cost: 50000, minMarginPct: 5, closeModel: 'hard' }],
  result: {
    won: true, finalRank: 1, closeModel: 'hard', landedBids: 1, attemptsAllowed: null, extensionsAfterLastBid: 0,
    postedCloseAt: L2_CLOSE, finalCloseAt: L2_CLOSE, finalCloseUnknown: false, lastBidBeforeTriggerWindow: false,
    leadAfterLastBid: true, lastBidInFinalSeconds: true, ts: L2_CLOSE + 4000,
  },
};

const L3_CLOSE = istAt(2026, 9, 23, 10, 45, 0);
const L3 = {
  auctionId: '25702437', platformKey: null,
  armed: { companyName: 'Havells India Ltd', lane: { origin: 'Alwar', destination: 'Pune' }, cost: 24500, marginsPct: [12.6, 7.2, 5],
    minMarginPct: 5, ladder: [27587, 26926, 26264, 25725], floor: 25725 },
  events: [{ type: 'bid_rejected', price: 27587, rungIndex: 0, ts: istAt(2026, 9, 23, 10, 39, 24, 655), status: 400, reason: 'http_400',
    body: 'Auction has already ended for this load' }],
  result: {
    won: false, finalRank: null, closeModel: 'soft', landedBids: 0, noBidReason: 'submission_window_closed', attemptsAllowed: 30,
    postedCloseAt: L3_CLOSE, finalCloseAt: L3_CLOSE, extensionsAfterLastBid: null, finalCloseUnknown: false,
    lastBidBeforeTriggerWindow: null, leadAfterLastBid: null, lastBidInFinalSeconds: null, ts: istAt(2026, 9, 23, 10, 42, 27, 583),
  },
};

const L4_TS = istAt(2026, 8, 20, 14, 59, 50);
const L4 = {
  auctionId: '24811002', platformKey: null,
  armed: { companyName: 'Havells India Ltd', lane: { origin: 'Alwar', destination: 'Pune' }, cost: 40000 },
  events: [{ type: 'bid_placed', price: 43000, rungIndex: 0, ts: L4_TS }],
  result: { won: false, finalRank: 3, closeModel: 'hard', finalCloseAt: istAt(2026, 8, 20, 15, 0, 0), ts: istAt(2026, 8, 20, 15, 0, 5) },
};

async function exportFor(spec, { legacy = false } = {}) {
  const c = await closeThroughLogger(spec);
  if (legacy) {
    delete c.record.resultReason;
    await c.store.putDoc('closedBids', spec.auctionId, c.record);
  }
  const requests = new PriceRequestStore({ store: c.store, marginsPct: [10], minMarginPct: 5 });
  const datasets = await model.buildDatasets({ requests, bidLogger: c.logger });
  const bids = model.VIEWS.bids.project(datasets[model.VIEWS.bids.dataset]);
  const v = model.VIEWS.lastbid;
  const lastbid = v ? v.project(datasets[v.dataset]) : null;
  return { record: c.record, bids, lastbid, outcomesRows: datasets.outcomes.length };
}

const cellOf = (view, row, name) => {
  const i = view.headers.indexOf(name);
  return i === -1 ? undefined : row[i];
};

async function main() {
  const e1 = await exportFor(L1);
  const e2 = await exportFor(L2);
  const e3 = await exportFor(L3);
  const e4 = await exportFor(L4, { legacy: true });

  for (const [name, e, spec, landed] of [['L1', e1, L1, 1], ['L2', e2, L2, 1], ['L3', e3, L3, 0], ['L4', e4, L4, 1]]) {
    harness(e.outcomesRows === 1, `${name}: outcomes dataset has ${e.outcomesRows} rows, want 1`);
    harness((e.record.ourBids || []).length === landed, `${name}: record kept ${(e.record.ourBids || []).length} bids, want ${landed}`);
    harness(e.record.won === spec.result.won && e.record.status === 'closed', `${name}: record did not close as won=${spec.result.won}`);
    harness(e.bids.headers.includes('Load Id') && e.bids.headers.includes(EXPORT_HEADERS.bidTime), `${name}: bids sheet lost Load Id / Bid Time`);
  }
  harness(e4.record.resultReason === undefined && e4.record.leadAfterLastBid === undefined, 'L4 is not a pre-ruling-29 record');

  for (const col of RETIRED_BID_COLUMNS) {
    check('retired bid columns', !e1.bids.headers.includes(col), `bids sheet still has "${col}" (headers: ${e1.bids.headers.join(' | ')})`);
  }

  check('last-bid view', !!e1.lastbid, 'exportModel.VIEWS.lastbid does not exist');
  if (e1.lastbid) {
    const v = e1.lastbid;
    check('last-bid headers', JSON.stringify(v.headers) === JSON.stringify(LAST_BID_HEADERS),
      `headers ${JSON.stringify(v.headers)}, want ${JSON.stringify(LAST_BID_HEADERS)}`);
    for (const col of ['Our last bid', 'Last bid, secs before close']) {
      check('last-bid numeric columns', (v.numericColumns || []).includes(v.headers.indexOf(col)),
        `"${col}" (index ${v.headers.indexOf(col)}) not in numericColumns ${JSON.stringify(v.numericColumns)}`);
    }

    const rowOf = (e, id) => {
      const rows = e.lastbid.rows.filter((r) => String(cellOf(e.lastbid, r, 'OA')) === id);
      check('last-bid rows', rows.length === 1, `${rows.length} rows for OA ${id}, want 1`);
      return rows[0] || [];
    };
    const expect = (name, e, row, col, want) => {
      const got = cellOf(e.lastbid, row, col);
      check('last-bid cells', got === want, `${name} "${col}" = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };

    const r1 = rowOf(e1, L1.auctionId);
    const s1 = cellOf(e1.lastbid, r1, 'Last bid, secs before close');
    expect('L1', e1, r1, 'Our last bid', 67340);
    check('last-bid cells', typeof s1 === 'number' && Math.abs(s1 - 973.8) <= 0.05,
      `L1 "Last bid, secs before close" = ${JSON.stringify(s1)}, want 973.8`);
    expect('L1', e1, r1, 'Bid in final seconds?', 'No (held rank 1)');
    expect('L1', e1, r1, 'At lowest margin?', 'Yes');
    expect('L1', e1, r1, 'Undercut after our bid?', 'Yes');
    expect('L1', e1, r1, 'Result', RESULT_WORDS.lost_on_price);

    const r2 = rowOf(e2, L2.auctionId);
    const s2 = cellOf(e2.lastbid, r2, 'Last bid, secs before close');
    check('last-bid cells', typeof s2 === 'number' && Math.abs(s2 - 2.1) <= 0.05,
      `L2 "Last bid, secs before close" = ${JSON.stringify(s2)}, want 2.1`);
    expect('L2', e2, r2, 'Bid in final seconds?', 'Yes');
    expect('L2', e2, r2, 'Undercut after our bid?', 'No');
    expect('L2', e2, r2, 'Result', RESULT_WORDS.won);

    const r3 = rowOf(e3, L3.auctionId);
    for (const col of ['Our last bid', 'Last bid, secs before close', 'Bid in final seconds?', 'At lowest margin?', 'Undercut after our bid?']) {
      expect('L3', e3, r3, col, '');
    }
    expect('L3', e3, r3, 'Result', RESULT_WORDS.no_bid_portal_closed_early);

    const r4 = rowOf(e4, L4.auctionId);
    for (const col of ['Last bid, secs before close', 'Bid in final seconds?', 'At lowest margin?', 'Undercut after our bid?', 'Result']) {
      expect('L4 legacy', e4, r4, col, '');
    }
    expect('L4 legacy', e4, r4, 'Our last bid', 43000);
  }

  if (failures.length) {
    for (const f of failures) console.log(ascii(f));
    console.log(`FAILED ${failures.length} of ${n} checks - ruling 29: no per-load last-bid sheet, and the every-bid sheet still carries `
      + 'the four per-bid close columns');
    process.exit(1);
  }
  console.log(`PASS ${n} checks`);
}

main().catch((e) => { console.log(ascii(e && e.stack ? e.stack : e)); process.exit(1); });
