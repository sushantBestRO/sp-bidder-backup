'use strict';
/**
 * Console endpoints integration test: boots the app (mock mode + memory store, no
 * real boot()/listen) on an ephemeral port and exercises the three base-panel
 * endpoints over real HTTP - /api/config (GET + POST round-trip + validation),
 * /api/auctions (shape), /api/closed-bids (closed-only + summary).
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// exercise the base panels with the login gate OFF (mock dev default); clear any
// ambient admin creds so the gate can't trip from the shell environment.
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');
const { app, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = Object.assign(
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      extraHeaders || {},
    );
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json }); }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => req('GET', base + p);
  const post = (p, b) => req('POST', base + p, b, { origin: base }); // same-origin browser sim

  // ---- /api/config defaults ----
  const c0 = await get('/api/config');
  ok(c0.status === 200 && c0.json.config && Array.isArray(c0.json.config.marginsPct), '/api/config returns config with marginsPct');
  ok(Array.isArray(c0.json.meta.alertKinds) && c0.json.meta.alertKinds.length > 0, '/api/config meta carries alertKinds');

  // ---- /api/config save round-trip ----
  const saved = await post('/api/config', {
    marginsPct: [10, 5], minMarginPct: 4,
    allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true },
    recipients: [{ name: 'X', phone: '9820098200', alerts: ['won'] }],
    discoveryIntervalMs: 20000, priceDeadlineLeadMs: 60000, notifyMode: 'dashboard',
  });
  ok(saved.status === 200 && saved.json.applied, 'POST /api/config applies');
  const c1 = await get('/api/config');
  ok(JSON.stringify(c1.json.config.marginsPct) === JSON.stringify([10, 5]), 'saved marginsPct persisted');
  ok(c1.json.config.allowlist.shippers[0] === 'Syngenta', 'saved allowlist persisted');
  ok(c1.json.config.recipients.length === 1 && c1.json.config.recipients[0].name === 'X', 'saved recipient persisted');

  // ---- /api/config validation ----
  const badMargins = await post('/api/config', { marginsPct: [] });
  ok(badMargins.status === 400, 'empty marginsPct rejected (400)');
  const badInterval = await post('/api/config', { discoveryIntervalMs: 100 });
  ok(badInterval.status === 400, 'too-small discoveryIntervalMs rejected (400)');

  // ---- CSRF guard on mutating /api ----
  const noOrigin = await req('POST', base + '/api/config', { minMarginPct: 0 });
  ok(noOrigin.status === 403, 'POST /api/config without Origin is blocked (403)');
  const crossSite = await req('POST', base + '/api/config', { minMarginPct: 0 }, { origin: 'http://evil.example' });
  ok(crossSite.status === 403, 'POST /api/config from a cross-site Origin is blocked (403)');

  // ---- /api/auctions shape (nothing armed) ----
  const a = await get('/api/auctions');
  ok(a.status === 200 && Array.isArray(a.json.auctions), '/api/auctions returns an array');
  ok(typeof a.json.mode === 'string', '/api/auctions reports the mode');

  // ---- /api/closed-bids: only closed, with a correct summary ----
  await store.putDoc('closedBids', 'Z1', { auctionId: 'Z1', lane: { origin: 'A', destination: 'B' }, equipment: 'T', won: true, finalRank: 1, ourBids: [{ price: 100, rungIndex: 0, rank: 1, ts: Date.now() }], lastBidPrice: 100, closedAt: Date.now(), status: 'closed' });
  await store.putDoc('closedBids', 'Z2', { auctionId: 'Z2', lane: { origin: 'C', destination: 'D' }, equipment: 'T', won: false, finalRank: 2, ourBids: [{ price: 200, rungIndex: 0, rank: 2, ts: Date.now() }], lastBidPrice: 200, closedAt: Date.now(), status: 'closed' });
  await store.putDoc('closedBids', 'Z3', { auctionId: 'Z3', status: 'open', ourBids: [] }); // open -> excluded
  // Z4 closed with zero bids -> a NO-BID, which must not be counted as a loss.
  await store.putDoc('closedBids', 'Z4', { auctionId: 'Z4', lane: { origin: 'E', destination: 'F' }, equipment: 'T', won: false, finalRank: null, ourBids: [], closedAt: Date.now(), status: 'closed' });
  const cb = await get('/api/closed-bids');
  ok(cb.status === 200 && cb.json.closedBids.length === 3, `/api/closed-bids returns only closed (got ${cb.json.closedBids.length})`);
  ok(cb.json.summary.total === 3 && cb.json.summary.won === 1 && cb.json.summary.lost === 1 && cb.json.summary.noBid === 1, 'closed-bids summary splits won/lost/no-bid');
  ok(cb.json.summary.winRate === 50, `closed-bids winRate is over decided auctions (got ${cb.json.summary.winRate})`);

  // ---- /api/history: the COMPLETE record - closed auctions PLUS never-priced enquiries ----
  // Z5 was discovered and surfaced to the desk but never priced, so it has NO closedBids record at
  // all and is structurally invisible to /api/closed-bids above. Having a row for it here is the
  // whole point of this endpoint: the console's History page could not show a skipped enquiry.
  await store.putDoc('priceRequests', 'Z5', {
    id: 'Z5', loadId: 'Z5', status: 'skipped_no_price', createdAt: Date.now(), capturedAt: null,
    load: { lane: { origin: 'G', destination: 'H' }, equipment: 'T', companyName: 'Syngenta', closesAt: Date.now() - 1000 },
  });
  const hh = await get('/api/history');
  ok(hh.status === 200 && Array.isArray(hh.json.rows), '/api/history returns rows');
  const hIds = hh.json.rows.map((r) => r.loadId).sort().join(',');
  ok(hIds === 'Z1,Z2,Z4,Z5', `/api/history unions both stores, open auction excluded (got ${hIds})`);
  ok(hh.json.rows.some((r) => r.loadId === 'Z5' && r.status === 'skipped_no_price'), '/api/history carries the never-priced enquiry with its status');
  ok(!hh.json.rows.some((r) => '_req' in r || '_closed' in r || 'ourBids' in r), '/api/history never ships the source docs or the bid ladder');
  ok(hh.json.summary.enquiries === 4 && hh.json.summary.skipped === 1, `/api/history summary counts the skipped enquiry (got ${hh.json.summary.enquiries}/${hh.json.summary.skipped})`);
  ok(hh.json.summary.winPct === 50, `/api/history win rate is over decided auctions (got ${hh.json.summary.winPct})`);
  ok(typeof (hh.json.window && hh.json.window.note) === 'string', '/api/history states its retention window');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
