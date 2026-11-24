'use strict';
/**
 * THE "MATCH THE CEILING" CORRECTIVE IS NOT A FIXED POINT: IT KEYS ON THE MARGIN THAT BINDS.
 *
 * Regression target: A015. ceilingCostTarget computed the buying price off max(band), the top bid
 * margin. On an inverted stored band - a minimum margin above every bid margin - the operating floor
 * at that price still sits over the cap, so re-submitting the offered cost returns the identical
 * refusal naming the identical figure, forever.
 *
 * The binding margin is the larger of the top bid margin and the minimum margin, since every price
 * the ladder sends is raised to the minimum-margin price. A normal band's corrective is unchanged.
 *
 *   node scripts/test-ceiling-corrective-binding-margin.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceil-corrective-'));

const http = require('http');
const { app, requests, store, ceilingCostTarget } = require('../src/web/server');

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
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: 30_000 } });
const target = (msg) => { const m = /Use Rs ([\d,]+) or less/.exec(msg || ''); return m ? Number(m[1].replace(/,/g, '')) : null; };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. an inverted stored band: bid margins 5/4/3, minimum 8');
  {
    const r = await requests.createForLoad(load('CC-1'));
    await store.patchDoc('priceRequests', r.id, { marginsPct: [5, 4, 3], minMarginPct: 8 });
    const first = await post(base, `/price/${r.id}`, { cost: '29000' });
    const t = target(first.json && first.json.error);
    ok(first.status === 400 && t != null, `the cost is refused against the Rs 30,000 cap with a buying price (${first.json && first.json.error})`);
    const second = t != null ? await post(base, `/price/${r.id}`, { cost: String(t) }) : null;
    ok(!!second && second.status === 200,
      `entering that buying price clears the refusal (HTTP ${second && second.status}: ${second && second.json && second.json.error})`);
  }

  console.log('\n2. control: a normal band keeps its corrective');
  {
    ok(ceilingCostTarget(15_500, [12.6, 7.2, 6], 6) === 13_765, `12.6/7.2/6 under a 15,500 cap -> 13,765 (got ${ceilingCostTarget(15_500, [12.6, 7.2, 6], 6)})`);
    ok(ceilingCostTarget(15_500, [12.6, 7.2, 6]) === 13_765, 'and the same with no minimum passed');
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
