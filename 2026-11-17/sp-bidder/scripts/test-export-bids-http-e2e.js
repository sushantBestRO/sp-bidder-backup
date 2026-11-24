'use strict';
/**
 * BC-40 through the actual download: hits GET /api/export/bids and GET /api/export/outcomes over
 * real HTTP, on a real Express server, and reads the real CSV bytes those routes send.
 *
 * test-export-every-bid-seconds.js pins the same defect (seconds on the bids sheet's Bid Time,
 * the real close on the outcomes sheet's Auction Date/Time) but stops at exportModel.VIEWS.*
 * .project() - it never calls the route handler, never goes through query parsing or
 * src/web/csv.js's toCsv serialization. The tracker's own 28 Sep evidence says no bid-log export
 * has been downloaded since the 26 Sep release, so this exact button-click path has not been
 * proven live or in a test: this file is that proof, end to end through the one thing a real
 * click actually returns - the CSV bytes.
 *
 * The auction is an extended GoComet load: postedCloseAt and finalCloseAt differ, so the outcomes
 * assertion only passes if the route serves reportedCloseAt's real close, not the discovery-time
 * belief.
 *
 *   node scripts/test-export-bids-http-e2e.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-export-http-'));

const http = require('http');
const { istAt } = require('./lib/result-receipt-harness');
const { istDate, istTime, istDateTimeSecs } = require('../src/web/csv');
const { app, bidLogger } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  PASS - ${m}`); } else { fail++; console.log(`  FAIL - ${m}`); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function get(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    }).on('error', reject);
  });
}

// Minimal RFC-4180 parse: the values this test writes never need a quoted field, so a
// straight split is faithful to what csv.js actually emitted for this case.
function parseCsv(text) {
  const lines = text.split('\r\n').filter((l) => l.length);
  return lines.map((l) => l.split(','));
}

function rowByLoadId(table, loadId) {
  const [header, ...rows] = table;
  const idCol = header.indexOf('Load Id');
  const row = rows.find((r) => r[idCol] === loadId);
  return row ? Object.fromEntries(header.map((h, i) => [h, row[i]])) : null;
}

const AUCTION_ID = 'HTTP-BC40-2609201115';
const BID_TS = istAt(2026, 9, 20, 11, 15, 37);
const IN_FORCE_CLOSE = istAt(2026, 9, 20, 11, 20, 0);
const POSTED_CLOSE = istAt(2026, 9, 20, 11, 20, 0);
const FINAL_CLOSE = istAt(2026, 9, 20, 11, 35, 12); // extended 15+ min past the posted close

(async () => {
  await bidLogger.handle({
    type: 'armed', auctionId: AUCTION_ID, platformKey: 'gocomet',
    companyName: 'Waaree Energies Ltd.', lane: { origin: 'Degam', destination: 'Akola' }, cost: 48000,
  });
  await bidLogger.handle({
    type: 'bid_placed', auctionId: AUCTION_ID, price: 50000, rungIndex: 2, ts: BID_TS,
    decidedAt: BID_TS - 3600, closesInMs: IN_FORCE_CLOSE - BID_TS, believedCloseAt: IN_FORCE_CLOSE,
    latencyMs: 3600, socketRank: 2, extendsObserved: 2, engineRevisionsLeft: 1, cost: 48000, closeModel: 'soft',
  });
  await bidLogger.handle({
    type: 'auction_result', auctionId: AUCTION_ID, won: false, finalRank: 2, closeModel: 'soft',
    companyName: 'Waaree Energies Ltd.', lane: { origin: 'Degam', destination: 'Akola' },
    postedCloseAt: POSTED_CLOSE, finalCloseAt: FINAL_CLOSE, extensionsAfterLastBid: 2,
    attemptsAllowed: 3, landedBids: 1, ts: FINAL_CLOSE + 5000,
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const bidsRes = await get(base, '/api/export/bids?format=csv');
  ok(bidsRes.status === 200, 'GET /api/export/bids?format=csv returns 200');
  const bidsRow = rowByLoadId(parseCsv(bidsRes.text), AUCTION_ID);
  ok(!!bidsRow, `the bids CSV has a row for ${AUCTION_ID}`);
  if (bidsRow) {
    eq(bidsRow['Bid Time'], istDateTimeSecs(BID_TS), 'downloaded bids CSV states Bid Time to the second');
  }

  const outcomesRes = await get(base, '/api/export/outcomes?format=csv');
  ok(outcomesRes.status === 200, 'GET /api/export/outcomes?format=csv returns 200');
  const outcomesRow = rowByLoadId(parseCsv(outcomesRes.text), AUCTION_ID);
  ok(!!outcomesRow, `the outcomes CSV has a row for ${AUCTION_ID}`);
  if (outcomesRow) {
    eq(outcomesRow['Auction Date'], istDate(FINAL_CLOSE), 'downloaded outcomes CSV states the real (extended) close date');
    eq(outcomesRow['Auction Time'], istTime(FINAL_CLOSE), 'downloaded outcomes CSV states the real (extended) close time');
    ok(outcomesRow['Auction Time'] !== istTime(POSTED_CLOSE),
      `sanity: the posted close (${istTime(POSTED_CLOSE)}) and the real close (${istTime(FINAL_CLOSE)}) actually differ in this fixture`);
  }

  await new Promise((r) => server.close(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
