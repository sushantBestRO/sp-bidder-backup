'use strict';
/**
 * CSV export test (deterministic, offline, memory store). Two halves:
 *   1. csv.js — RFC-4180 escaping edge cases + the analysis-shaping helpers
 *      (ISO timestamps, pipe-joined arrays, blank-for-unknown booleans).
 *   2. exports.js — every builder against a seeded store, asserting header row +
 *      cell content, the anyBid flag, the config-diff flatten, and the empty
 *      result set (header-only, no crash).
 */
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { makeExporters } = require('../src/web/exports');
const csv = require('../src/web/csv');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)})`);

// Split a CSV document into non-empty lines (CRLF-delimited, trailing newline).
const lines = (s) => s.split('\r\n').filter((l) => l.length);
const rowFor = (csvStr, needle) => lines(csvStr).find((l) => l.includes(needle));

(async () => {
  // ---- 1. csv.js pure helpers ----
  eq(csv.csvField('plain'), 'plain', 'field: plain passthrough');
  eq(csv.csvField('a,b'), '"a,b"', 'field: comma -> quoted');
  eq(csv.csvField('he said "hi"'), '"he said ""hi"""', 'field: quotes doubled + wrapped');
  eq(csv.csvField('line1\nline2'), '"line1\nline2"', 'field: newline -> quoted');
  eq(csv.csvField(null), '', 'field: null -> blank');
  eq(csv.csvField(0), '0', 'field: zero -> "0" (not blank)');
  // CSV formula injection (CWE-1236): a leading = + - @ / TAB / CR is text-forced with an apostrophe.
  eq(csv.csvField('=SUM(A1)'), "'=SUM(A1)", 'field: =formula lead neutralized');
  eq(csv.csvField('+919000000001'), "'+919000000001", 'field: +NN phone neutralized (no evaluate)');
  eq(csv.csvField('@cmd'), "'@cmd", 'field: @ lead neutralized');
  eq(csv.csvField('-2+3'), "'-2+3", 'field: - lead neutralized');
  eq(csv.csvField('=HYPERLINK("x"),y'), '"\'=HYPERLINK(""x""),y"', 'field: formula + comma -> neutralized then quoted');
  eq(csv.iso(0), '1970-01-01T00:00:00.000Z', 'iso: epoch 0');
  eq(csv.iso(null), '', 'iso: null -> blank');
  eq(csv.iso('not-a-date'), '', 'iso: garbage -> blank');
  eq(csv.pipe([12.6, 7.2, 6.3]), '12.6|7.2|6.3', 'pipe: joins with |');
  eq(csv.pipe([]), '', 'pipe: empty -> blank');
  eq(csv.bool(true), 'true', 'bool: true');
  eq(csv.bool(false), 'false', 'bool: false');
  eq(csv.bool(null), '', 'bool: null -> blank (unknown != no)');
  eq(csv.json({ a: 1 }), '{"a":1}', 'json: object -> JSON string');
  eq(csv.json(null), '', 'json: null -> blank');
  eq(csv.toCsv(['a', 'b'], []), 'a,b\r\n', 'toCsv: empty rows -> header only');
  eq(csv.stamp(0), '1970-01-01', 'stamp: date only');
  eq(csv.stamp(null), 'all', 'stamp: open bound -> "all"');

  // ---- 2. exporters against a seeded store ----
  const store = createStore({ backend: 'memory' });
  const bidLogger = new BidLogger({ store });
  const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
  const exporters = makeExporters({ store, bidLogger, requests });
  const now = Date.now();

  eq(exporters.has('bid-history'), true, 'registry: known stream');
  eq(exporters.has('bogus'), false, 'registry: unknown stream');
  ok(exporters.keys().length === 6, 'registry: six streams');

  // empty store: every export is header-only (no crash, valid CSV)
  const emptyHist = await exporters.build('bid-history', { from: null, to: null });
  eq(csv.toCsv(emptyHist.headers, emptyHist.rows).trim(), emptyHist.headers.join(','), 'bid-history: empty -> header only');
  const emptyNotif = await exporters.build('notifications', { from: null, to: null });
  eq(emptyNotif.rows.length, 0, 'notifications: empty -> zero rows');

  // seed two auctions: A1 won (two real bids, comma in shipper), A2 lost (one real bid)
  await bidLogger.handle({ type: 'armed', auctionId: 'A1', ts: now, lane: { origin: 'Chakan', destination: 'Bawal' }, equipment: '20ft', units: 3, companyName: 'Syngenta, Ltd', cost: 80000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [90080, 85760, 85040], floor: 85040, costFloor: 80000 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'A1', ts: now + 1000, price: 90080, rungIndex: 0, rank: 2, latencyMs: 210 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'A1', ts: now + 2000, price: 85040, rungIndex: 2, rank: 1, latencyMs: 180 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'A1', ts: now + 3000, won: true, finalRank: 1, closeModel: 'hard' });
  await bidLogger.handle({ type: 'armed', auctionId: 'A2', ts: now, lane: { origin: 'Pune', destination: 'Hosur' }, equipment: '32ft', units: 1, companyName: 'Renewsys', cost: 50000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [56300, 53150], floor: 53150 });
  await bidLogger.handle({ type: 'bid_placed', auctionId: 'A2', ts: now + 1000, price: 56300, rungIndex: 0, rank: 4, latencyMs: 200 });
  await bidLogger.handle({ type: 'auction_result', auctionId: 'A2', ts: now + 3000, won: false, finalRank: 4, closeModel: 'hard' });

  // bid-history
  const hist = await exporters.build('bid-history', { from: null, to: null });
  eq(hist.headers[0], 'auctionId', 'bid-history: first column');
  eq(hist.rows.length, 2, 'bid-history: two auctions');
  const histCsv = csv.toCsv(hist.headers, hist.rows);
  ok(histCsv.includes('"Syngenta, Ltd"'), 'bid-history: comma shipper is quoted');
  const a1 = hist.rows.find((r) => r[0] === 'A1');
  const H = (name) => a1[hist.headers.indexOf(name)];
  eq(H('won'), 'true', 'bid-history: A1 won=true');
  eq(H('anyBid'), 'true', 'bid-history: A1 had a bid');
  eq(H('numBids'), 2, 'bid-history: A1 numBids=2');
  eq(H('openingBid'), 90080, 'bid-history: openingBid = ladder[0]');
  eq(H('floorBid'), 85040, 'bid-history: floorBid = ladder[last]');
  eq(H('marginBand'), '12.6|7.2|6.3', 'bid-history: marginBand pipe-joined');
  ok(/^\d{4}-\d{2}-\d{2}T/.test(H('closedAt')), 'bid-history: closedAt is ISO');
  const a2 = hist.rows.find((r) => r[0] === 'A2');
  eq(a2[hist.headers.indexOf('anyBid')], 'true', 'bid-history: A2 had a bid -> anyBid=true');

  // bid-detail: one row per bid (3 bids total: A1 x2, A2 x1). No dryRun column - every bid is real.
  const detail = await exporters.build('bid-detail', { from: null, to: null });
  eq(detail.rows.length, 3, 'bid-detail: 3 bid rows total');
  ok(!detail.headers.includes('dryRun'), 'bid-detail: no dryRun column (dry-run removed)');
  const firstA1 = detail.rows.find((r) => r[0] === 'A1' && r[detail.headers.indexOf('bidNumber')] === 1);
  eq(firstA1[detail.headers.indexOf('latencyMs')], 210, 'bid-detail: latency carried');
  const secondA1 = detail.rows.find((r) => r[0] === 'A1' && r[detail.headers.indexOf('bidNumber')] === 2);
  eq(secondA1[detail.headers.indexOf('price')], 85040, 'bid-detail: A1 bid #2 price carried');

  // price-requests: one priced (ttp derivable, comma shipper), one awaiting (no cost)
  await store.putDoc('priceRequests', 'tok-priced', {
    id: 'tok-priced', loadId: 'L-100', account: null,
    load: { lane: { origin: 'Bhiwandi', destination: 'Delhi' }, equipment: '22ft', units: 2, companyName: 'Tata, Steel', productName: 'Coils', closesAt: now + 3_600_000, softClose: false },
    marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, status: 'armed', createdAt: now - 600_000,
    price: { cost: 42000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 }, capturedAt: now, deadlineAt: now + 3_500_000,
  });
  await store.putDoc('priceRequests', 'tok-await', {
    id: 'tok-await', loadId: 'L-101', account: null,
    load: { lane: { origin: 'Surat', destination: 'Vapi' }, equipment: '19ft', units: 1, companyName: 'Renewsys', closesAt: now + 7_200_000, softClose: true },
    marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, status: 'awaiting_price', createdAt: now, price: null, capturedAt: null, deadlineAt: now + 7_000_000,
  });
  const pr = await exporters.build('price-requests', { from: null, to: null });
  eq(pr.rows.length, 2, 'price-requests: two requests');
  const priced = pr.rows.find((r) => r[0] === 'L-100');
  const P = (name) => priced[pr.headers.indexOf(name)];
  eq(P('status'), 'armed', 'price-requests: status carried');
  eq(P('cost'), 42000, 'price-requests: captured cost');
  eq(P('timeToPriceMins'), 10, 'price-requests: ttp = 10 min (createdAt -> capturedAt)');
  ok(csv.toCsv(pr.headers, pr.rows).includes('"Tata, Steel"'), 'price-requests: comma shipper quoted');
  const awaiting = pr.rows.find((r) => r[0] === 'L-101');
  eq(awaiting[pr.headers.indexOf('cost')], '', 'price-requests: unpriced -> blank cost');
  eq(awaiting[pr.headers.indexOf('timeToPriceMins')], '', 'price-requests: unpriced -> blank ttp');
  eq(awaiting[pr.headers.indexOf('softClose')], 'true', 'price-requests: softClose bool');

  // notifications
  await store.appendEvent('notifications', { kind: 'price_needed', to: '+919000000001', name: 'Desk', ok: true, error: null, messageId: 'msg-1' });
  await store.appendEvent('notifications', { kind: 'error', to: '+919000000002', name: 'Plant', ok: false, error: 'http 401', messageId: null });
  const notif = await exporters.build('notifications', { from: null, to: null });
  eq(notif.rows.length, 2, 'notifications: two rows');
  const failRow = rowFor(csv.toCsv(notif.headers, notif.rows), 'http 401');
  ok(failRow && failRow.includes('false'), 'notifications: failed send has ok=false + error');

  // config-audit: one save touching two fields -> two rows (flattened)
  await store.appendEvent('configChanges', {
    action: 'config_save', actor: 'dev', ip: '127.0.0.1', changed: ['marginsPct', 'notifyMode'],
    changes: [
      { field: 'marginsPct', before: [12.6, 7.2, 6.3], after: [14, 8, 6.5] },
      { field: 'notifyMode', before: 'dashboard', after: 'whatsapp' },
    ],
  });
  const audit = await exporters.build('config-audit', { from: null, to: null });
  eq(audit.rows.length, 2, 'config-audit: 2 changed fields -> 2 rows');
  const marginRow = audit.rows.find((r) => r[audit.headers.indexOf('field')] === 'marginsPct');
  eq(marginRow[audit.headers.indexOf('before')], '[12.6,7.2,6.3]', 'config-audit: before is JSON string');
  eq(marginRow[audit.headers.indexOf('after')], '[14,8,6.5]', 'config-audit: after is JSON string');

  // engine-mode
  await store.appendEvent('engineMode', { action: 'go_live', actor: 'dev', ip: '127.0.0.1', armed: 3 });
  await store.appendEvent('engineMode', { action: 'kill', actor: 'dev', ip: '127.0.0.1', reason: 'manual (console)', wasLive: true });
  const eng = await exporters.build('engine-mode', { from: null, to: null });
  eq(eng.rows.length, 2, 'engine-mode: two actions');
  const killRow = eng.rows.find((r) => r[eng.headers.indexOf('action')] === 'kill');
  eq(killRow[eng.headers.indexOf('wasLive')], 'true', 'engine-mode: kill wasLive=true');
  eq(killRow[eng.headers.indexOf('reason')], 'manual (console)', 'engine-mode: reason carried');
  const goliveRow = eng.rows.find((r) => r[eng.headers.indexOf('action')] === 'go_live');
  eq(goliveRow[eng.headers.indexOf('armed')], 3, 'engine-mode: go_live armed count');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
