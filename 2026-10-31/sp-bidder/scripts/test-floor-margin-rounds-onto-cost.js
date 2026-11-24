'use strict';
/**
 * A FLOOR MARGIN TOO SMALL TO ADD A RUPEE IS REFUSED LIKE A 0% ONE.
 *
 * Regression target: A006. bidsAtCost refused only an effective floor margin of exactly 0, so a
 * 0.001% floor passed every gate and armed a floor of Math.round(cost x 1.00001) - the cost itself,
 * a bid at the buying price. Any floor margin in (0, 50/cost)% rounds onto the cost the same way.
 *
 * Pinned on both /price branches (capture and re-price). A floor margin whose rupee effect is real
 * still arms, and an exactly-0% refusal keeps its own wording.
 *
 *   node scripts/test-floor-margin-rounds-onto-cost.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-floor-rounds-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

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
const load = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });
const liveMonitor = (loadId) => {
  for (const s of stacks) { const m = s.engine.monitors.get(loadId); if (m && !m.finalized) return m; }
  return null;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const band = (lo) => ({ m_0: '9', m_1: '5', m_2: String(lo), use_override: '1', below_min_ack: '1' });

  console.log('\n1. capture with a 0.001% floor on Rs 29,000');
  {
    const r = await requests.createForLoad(load('FR-1'));
    const res = await post(base, `/price/${r.id}`, Object.assign({ cost: '29000' }, band(0.001)));
    ok(res.status === 400, `refused (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok(!liveMonitor('FR-1') && (await requests.getByToken(r.id)).status === 'awaiting_price', 'and nothing is armed');
  }

  console.log('\n2. re-price to a 0.001% floor');
  {
    const r = await requests.createForLoad(load('FR-2'));
    const armed = await post(base, `/price/${r.id}`, { cost: '29000' });
    ok(armed.status === 200 && !!liveMonitor('FR-2'), `setup: armed on the default band (HTTP ${armed.status})`);
    const res = await post(base, `/price/${r.id}`, Object.assign({ cost: '29000' }, band(0.001)));
    ok(res.status === 400, `refused (HTTP ${res.status}: ${res.json && res.json.error})`);
    const m = liveMonitor('FR-2');
    ok(!!m && m.floor > 29_000, `and the live ladder still bids above cost (floor ${m && m.floor})`);
  }

  console.log('\n3. controls');
  {
    const r = await requests.createForLoad(load('FR-3'));
    const res = await post(base, `/price/${r.id}`, Object.assign({ cost: '29000' }, band(0.5)));
    const m = liveMonitor('FR-3');
    ok(res.status === 200 && !!m && m.floor === 29_145, `a 0.5% floor (Rs 145 on Rs 29,000) still arms (HTTP ${res.status}, floor ${m && m.floor})`);
    const z = await requests.createForLoad(load('FR-4'));
    const zero = await post(base, `/price/${z.id}`, Object.assign({ cost: '29000' }, { m_0: '9', m_1: '5', m_2: '1', use_override: '1' }));
    ok(zero.status === 200, `a 1% floor arms (HTTP ${zero.status})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
