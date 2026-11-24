'use strict';
/**
 * AN ALL-BLANK PER-TRUCK-TYPE COST IS REFUSED IN WORDS, NOT WITH A SERVER FAULT.
 *
 * Regression target: A005 (the all-blank half). readCostByType returns ['', ''] for a per-type form
 * submitted with every rate blank, normalizeCostByType returns null for it, and both the capture and
 * the re-price branch of POST /price/:token then read `.cost` off that null: a TypeError, answered as
 * a 500 on the public money page. Reachable by a raw POST or a page whose `required` did not hold.
 *
 * Now both branches refuse it as bad input, name what to enter, and write nothing. A filled vector
 * still captures and re-prices as before.
 *
 *   node scripts/test-per-type-cost-all-blank-refused.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-per-type-blank-'));

const http = require('http');
const { app, requests } = require('../src/web/server');

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

const TYPES = [{ label: '32FT', match: '32ft', count: 1 }, { label: '20FT', match: '20ft', count: 1 }];
const load = (id) => ({ id, lane: { origin: 'Pune', destination: 'Delhi' }, equipment: 'Mixed', units: 2, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', cargoTypes: TYPES });

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. capture: every per-type rate blank');
  {
    const r = await requests.createForLoad(load('PT-BLANK-1'));
    const res = await post(base, `/price/${r.id}`, { cost_type_0: '', cost_type_1: '' });
    ok(res.status === 400, `refused as bad input, not a server fault (HTTP ${res.status})`);
    ok(!!res.json && /cost for each of the 2 truck types/i.test(res.json.error || ''), `saying what to enter (${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.status === 'awaiting_price' && !after.price, 'and nothing was saved');
  }

  console.log('\n2. re-price: every per-type rate blank on an armed per-type load');
  {
    const r = await requests.createForLoad(load('PT-BLANK-2'));
    const armed = await post(base, `/price/${r.id}`, { cost_type_0: '30000', cost_type_1: '20000' });
    ok(armed.status === 200, `setup: a filled vector captures (HTTP ${armed.status})`);
    const before = await requests.getByToken(r.id);
    const res = await post(base, `/price/${r.id}`, { cost_type_0: '', cost_type_1: '', m_0: '9', m_1: '5', m_2: '1' });
    ok(res.status === 400, `refused as bad input, not a server fault (HTTP ${res.status})`);
    ok(!!res.json && /cost for each of the 2 truck types/i.test(res.json.error || ''), `saying what to enter (${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && after.price.cost === before.price.cost && after.price.cost === 25_000,
      `and the armed plan is untouched (cost ${after.price.cost})`);
    const again = await post(base, `/price/${r.id}`, { cost_type_0: '32000', cost_type_1: '22000', m_0: '9', m_1: '5', m_2: '1' });
    const now = await requests.getByToken(r.id);
    ok(again.status === 200 && now.price.cost === 27_000, `control: a filled re-price still lands (HTTP ${again.status}, cost ${now.price.cost})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
