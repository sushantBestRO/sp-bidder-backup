'use strict';
/**
 * Regression: a load with more than one pickup and/or drop point must keep EVERY point
 * visible, not just the first pickup + last drop. SuperProcure's loadingPoints schema
 * allows multiple points per load even though most loads carry exactly one of each; two
 * surfaces used to silently collapse to a single pair:
 *   1. src/web/server.js renderLoadCard() — the public /price/<token> page a human prices from.
 *   2. src/web/exports.js — all 3 CSV builders had no points column at all.
 * Both are fixed to render/export every point (pickupPoints/dropPoints, '; '-joined per kind,
 * same convention as notify/waTemplates.js's dropAddress()).
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-multipoint-'));

const http = require('http');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { makeExporters } = require('../src/web/exports');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const POINTS = [
  { kind: 'pickup', address: 'Khopoli, Maharashtra 410203, India' },
  { kind: 'drop', address: 'Keeranur, Tamil Nadu 622507, India' },
  { kind: 'drop', address: 'Madurai, Tamil Nadu 625001, India' },
];

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  // ---- Part 1: renderLoadCard() via the real booted app — the public /price/<token> page ----
  const { app, requests: liveRequests } = require('../src/web/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const now = Date.now();
  const rq = await liveRequests.createForLoad({
    id: 'MP-1', lane: { origin: 'Khopoli', destination: 'Madurai' }, equipment: 'Trailer', units: 1,
    companyName: 'Syngenta India', points: POINTS, closesAt: now + 10 * 60_000, startsAt: now - 60_000,
    softClose: false, status: 'live',
  });
  const g = await req('GET', `${base}/price/${rq.id}`);
  ok(g.status === 200, 'multi-point load -> price page renders 200');
  const iP = g.text.indexOf('Khopoli, Maharashtra 410203, India');
  const iD1 = g.text.indexOf('Keeranur, Tamil Nadu 622507, India');
  const iD2 = g.text.indexOf('Madurai, Tamil Nadu 625001, India');
  ok(iP >= 0 && iD1 >= 0 && iD2 >= 0, 'all 3 points (1 pickup + 2 drops) appear in the rendered HTML');
  ok(iP < iD1 && iD1 < iD2, 'points render in array order (pickup, then drop, then drop)');
  const dropLabels = (g.text.match(/<span class="sk">Drop<\/span>/g) || []).length;
  ok(dropLabels === 2, `both drops get their OWN row, not collapsed into one (found ${dropLabels})`);
  const pickupLabels = (g.text.match(/<span class="sk">Pickup<\/span>/g) || []).length;
  ok(pickupLabels === 1, 'single pickup renders exactly one row');
  ok(!/Pickup 1|Drop 1|Drop 2/.test(g.text), 'no numbered labels — mirrors the dashboard convention of plain repeated labels');
  server.close();

  // ---- Part 2: CSV exports — pickupPoints/dropPoints appended, never inserted ----
  const store = createStore({ backend: 'memory' });
  const bidLogger = new BidLogger({ store });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
  const exporters = makeExporters({ store, bidLogger, requests });
  const expectedDrops = 'Keeranur, Tamil Nadu 622507, India; Madurai, Tamil Nadu 625001, India';
  const expectedPickup = 'Khopoli, Maharashtra 410203, India';

  await bidLogger.handle({
    type: 'armed', auctionId: 'M1', ts: now, lane: { origin: 'Khopoli', destination: 'Madurai' },
    equipment: 'Trailer', units: 1, companyName: 'Syngenta India', points: POINTS,
    cost: 80000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [90000, 85000], floor: 85000, costFloor: 80000,
  });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'M1', ts: now + 1000, price: 90000, rungIndex: 0, rank: 2, latencyMs: 200 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'M1', ts: now + 3000, won: true, finalRank: 1, closeModel: 'hard' });

  const hist = await exporters.build('bid-history', { from: null, to: null });
  ok(JSON.stringify(hist.headers.slice(-2)) === JSON.stringify(['pickupPoints', 'dropPoints']), 'bid-history: new columns appended at the end, not inserted');
  const histRow = hist.rows.find((r) => r[0] === 'M1');
  ok(histRow[hist.headers.indexOf('pickupPoints')] === expectedPickup, 'bid-history: pickupPoints carries the pickup address');
  ok(histRow[hist.headers.indexOf('dropPoints')] === expectedDrops, 'bid-history: dropPoints carries BOTH drops, semicolon-joined, in order');

  const detail = await exporters.build('bid-detail', { from: null, to: null });
  ok(JSON.stringify(detail.headers.slice(-2)) === JSON.stringify(['pickupPoints', 'dropPoints']), 'bid-detail: new columns appended at the end, not inserted');
  const detailRow = detail.rows.find((r) => r[0] === 'M1');
  ok(detailRow[detail.headers.indexOf('dropPoints')] === expectedDrops, 'bid-detail: per-bid row also carries the full dropPoints value');

  await store.putDoc('priceRequests', 'tok-mp', {
    id: 'tok-mp', loadId: 'L-MP', account: null,
    load: { lane: { origin: 'Khopoli', destination: 'Madurai' }, equipment: 'Trailer', units: 1, companyName: 'Syngenta India', points: POINTS, closesAt: now + 3_600_000, softClose: false },
    marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, status: 'awaiting_price', createdAt: now, price: null, capturedAt: null, deadlineAt: now + 3_500_000,
  });
  const pr = await exporters.build('price-requests', { from: null, to: null });
  ok(JSON.stringify(pr.headers.slice(-2)) === JSON.stringify(['pickupPoints', 'dropPoints']), 'price-requests: new columns appended at the end, not inserted');
  const prRow = pr.rows.find((r) => r[0] === 'L-MP');
  ok(prRow[pr.headers.indexOf('dropPoints')] === expectedDrops, 'price-requests: dropPoints carries both drops');

  const csv = require('../src/web/csv');
  const histCsv = csv.toCsv(hist.headers, hist.rows);
  ok(histCsv.includes(`"${expectedDrops}"`), 'CSV output: comma-containing dropPoints cell is correctly quoted (existing csvField escaping covers the new columns for free)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
