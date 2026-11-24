'use strict';
/**
 * THE CAPTURE AUDIT ROW RECORDS THE PRICES THE ENGINE ARMED, NOT THE MARGIN ARITHMETIC.
 *
 * Regression target: A011. The cost_captured row wrote prices = round(cost x (1 + m/100)) off the
 * margins, before the arm ran the floor clamp, dedupe, decrement spacing, grid snap and ceiling cap,
 * so on any load where one of those moved a price the durable trail named prices that never went on
 * the ladder. No bid is mispriced by it; the record is.
 *
 * Pinned on a load whose minimum bid difference drops the middle price, and on a plain load where
 * the two agree (unchanged).
 *
 *   node scripts/test-capture-audit-armed-prices.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-audit-armed-'));

const http = require('http');
const { app, requests, stacks, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function post(base, url, obj) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const load = (id, rules) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: rules || null });
const liveMonitor = (loadId) => {
  for (const s of stacks) { const m = s.engine.monitors.get(loadId); if (m && !m.finalized) return m; }
  return null;
};
const capturedRow = async (loadId) => (await store.readEvents('configChanges'))
  .find((e) => e.action === 'cost_captured' && Array.isArray(e.changed) && e.changed.some((c) => String(c).includes(loadId)));
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. a minimum bid difference of Rs 1,500 drops the middle price');
  {
    const r = await requests.createForLoad(load('AUD-1', { minDecrement: 1500 }));
    const res = await post(base, `/price/${r.id}`, { cost: '29000' });
    await settle();
    const m = liveMonitor('AUD-1');
    const row = await capturedRow('AUD-1');
    ok(res.status === 200 && !!m, `setup: armed (HTTP ${res.status}, ladder ${m && m.ladder})`);
    ok(!!m && m.ladder.length === 2, `setup: the armed ladder really differs from the margin arithmetic (${m && m.ladder})`);
    const prices = row && row.changes[0].after.prices;
    ok(!!row && JSON.stringify(prices) === JSON.stringify(m && m.ladder),
      `the audit row records the armed prices (row ${JSON.stringify(prices)}, armed ${m && JSON.stringify(m.ladder)})`);
    ok(!!row && row.changes[0].after.cost === 29_000 && JSON.stringify(row.changes[0].after.marginsPct) === '[9,5,1]',
      'and still carries the cost and the margins as entered');
  }

  console.log('\n2. control: a plain load, where the arithmetic and the armed ladder agree');
  {
    const r = await requests.createForLoad(load('AUD-2'));
    await post(base, `/price/${r.id}`, { cost: '29000' });
    await settle();
    const row = await capturedRow('AUD-2');
    ok(!!row && JSON.stringify(row.changes[0].after.prices) === '[31610,30450,29290]',
      `prices are unchanged (${row && JSON.stringify(row.changes[0].after.prices)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
