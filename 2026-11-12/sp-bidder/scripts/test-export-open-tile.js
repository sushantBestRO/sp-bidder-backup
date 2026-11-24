'use strict';
/**
 * /api/export/summary "open" field regression test. The Export strip's "Inquiries" tile is a
 * rolling ~7-day discovery count, not a live count - the desk read it as currently-open and saw
 * 301 against 6 genuinely open (2026-09-09 audit). The fix adds a same-payload `open` field
 * carrying the awaiting_price/armed/stopped count so the strip has an honest answer to "how many
 * are open right now", computed by REUSING exportModel.summarizeHistory's existing predicate
 * rather than a second copy of it.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');
const model = require('../src/web/exportModel');
const { app, store, requests, bidLogger } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function get(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

(async () => {
  const now = Date.now();
  const baseLoad = (id) => ({
    id, loadId: id, account: null, customer: null, createdAt: now - 3_600_000,
    load: { lane: { origin: 'Alwar', destination: 'Kamrup' }, equipment: '32ft', units: 1, companyName: 'Havells', closesAt: now + 3_600_000 },
    marginsPct: [10], minMarginPct: 5,
  });

  // Three genuinely open rows (the "open right now" the desk is asking for) ...
  await store.putDoc('priceRequests', 'O1', Object.assign(baseLoad('O1'), { status: 'awaiting_price', capturedAt: null, price: null }));
  await store.putDoc('priceRequests', 'O2', Object.assign(baseLoad('O2'), { status: 'armed', capturedAt: now - 1000, price: { cost: 40000 } }));
  await store.putDoc('priceRequests', 'O3', Object.assign(baseLoad('O3'), { status: 'stopped', capturedAt: now - 1000, price: { cost: 40000 } }));
  // ... and three closed/decided rows that must NOT count as open.
  await store.putDoc('priceRequests', 'O4', Object.assign(baseLoad('O4'), { status: 'skipped_no_price', capturedAt: null, price: null }));
  await store.putDoc('priceRequests', 'O5', Object.assign(baseLoad('O5'), { status: 'dismissed', capturedAt: null, price: null }));
  await store.putDoc('priceRequests', 'O6', Object.assign(baseLoad('O6'), { status: 'closed', capturedAt: now - 1000, price: { cost: 40000 } }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await get(base, '/api/export/summary');
  ok(res.status === 200, '/api/export/summary returns 200');
  ok(res.json && typeof res.json.open === 'number', '/api/export/summary carries a numeric open field');
  eq(res.json.summary.inquiries, 6, 'inquiries is unchanged: still every discovered row (6)');
  eq(res.json.open, 3, 'open counts only awaiting_price/armed/stopped (O1,O2,O3)');

  // The field must equal exportModel.summarizeHistory's own predicate over the same rows, proving
  // the route reuses it rather than carrying a second copy of the same logic.
  const { funnel } = await model.buildDatasets({ requests, bidLogger }, { platformKey: 'sp' });
  const wantOpen = model.summarizeHistory(funnel).open;
  eq(res.json.open, wantOpen, "route's open field matches summarizeHistory(funnel).open directly");

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
