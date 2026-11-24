'use strict';
/**
 * A MARGIN-ONLY RE-PRICE IS JUDGED AGAINST THE SHIPPER CEILING USING THE COST ON RECORD.
 *
 * Regression target: A007. The /price re-price judged `costForCheck = req.body.cost` and the console
 * margin route ran its ceiling check only `if (body.cost != null)`, so a body carrying margins and no
 * cost skipped ceilingDeadPlan (which returns null on a non-finite cost), was saved, and re-armed the
 * live load onto a ladder whose floor sits above the ceiling: "ceiling below operating floor - will
 * not bid", on a load that was bidding a moment earlier.
 *
 * A margin-only body that keeps the ladder under the ceiling still saves on both routes.
 *
 *   node scripts/test-margin-only-reprice-ceiling.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '12,10,8';
process.env.SP_MIN_MARGIN_PCT = '8';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-margin-only-ceiling-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function post(base, url, obj, { api = false } = {}) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (api) { headers.origin = base; }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
// Ceiling 31,000 on a Rs 29,000 cost. The desk armed on its own 9/5/1 band (below the customer's 8%
// minimum, acknowledged), which floors at 29,290 and fits; the customer's 12/10/8 band floors at
// 31,320 and does not. Going back up to it without a cost in the body is the case under test.
const load = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: 31_000 } });
const liveMonitor = (loadId) => {
  for (const s of stacks) { const m = s.engine.monitors.get(loadId); if (m && !m.finalized) return m; }
  return null;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const armedLoad = async (id) => {
    const r = await requests.createForLoad(load(id));
    const res = await post(base, `/price/${r.id}`, { cost: '29000', m_0: '9', m_1: '5', m_2: '1', use_override: '1', below_min_ack: '1' });
    if (res.status !== 200 || !liveMonitor(id)) throw new Error(`setup: ${id} did not arm (HTTP ${res.status})`);
    return r;
  };

  console.log('\n1. /price re-price: margins only, no cost, floor above the ceiling');
  {
    const r = await armedLoad('MO-1');
    const res = await post(base, `/price/${r.id}`, { m_0: '12', m_1: '10', m_2: '8' });
    ok(res.status === 400 && /Rs 31,000/.test((res.json && res.json.error) || ''),
      `refused against the ceiling, judged on the cost on record (HTTP ${res.status}: ${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    const m = liveMonitor('MO-1');
    ok(after.marginsPct.join() === '9,5,1' && !!m && !m.ceilingBelowFloor, 'and the live plan is untouched');
  }

  console.log('\n2. console margin route: margins only, no cost, floor above the ceiling');
  {
    const r = await armedLoad('MO-2');
    const res = await post(base, `/api/price-requests/${r.id}/margin`, { marginsPct: [12, 10, 8], minMarginPct: 8, confirm: true }, { api: true });
    ok(res.status === 400 && /Rs 31,000/.test((res.json && res.json.error) || ''),
      `refused against the ceiling (HTTP ${res.status}: ${res.json && res.json.error})`);
    const m = liveMonitor('MO-2');
    ok((await requests.getByToken(r.id)).marginsPct.join() === '9,5,1' && !!m && !m.ceilingBelowFloor, 'and the live plan is untouched');
  }

  console.log('\n3. controls: a margin-only re-price that fits under the ceiling saves');
  {
    const r = await armedLoad('MO-3');
    const res = await post(base, `/price/${r.id}`, { m_0: '9', m_1: '5', m_2: '2', below_min_ack: '1' });
    ok(res.status === 200 && (await requests.getByToken(r.id)).marginsPct.join() === '9,5,2', `the /price re-price saves (HTTP ${res.status})`);
    const c = await armedLoad('MO-4');
    const cres = await post(base, `/api/price-requests/${c.id}/margin`, { marginsPct: [9, 5, 2], minMarginPct: 2, confirm: true, below_min_ack: '1' }, { api: true });
    ok(cres.status === 200, `the console route saves (HTTP ${cres.status}: ${cres.json && cres.json.error})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
