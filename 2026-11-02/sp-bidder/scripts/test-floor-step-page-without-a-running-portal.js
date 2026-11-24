'use strict';
/**
 * THE RE-PRICE PAGE STILL RENDERS WHEN THE LOAD'S PORTAL IS NOT RUNNING.
 *
 * The floor-step block is pre-rendered on a re-price from the engine that owns the load. When that
 * portal's stack is not up there is no engine to ask, and the page must render without the block
 * (the live preview says what it can once the desk types) rather than fail: a price page that errors
 * is a load nobody can re-price at all. Mutation critique found nothing held that line.
 *
 *   node scripts/test-floor-step-page-without-a-running-portal.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12.6,6.3';
process.env.SP_MIN_MARGIN_PCT = '6.3';
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-floorstep-nostack-'));

const assert = require('assert');
const http = require('http');
const { app, requests } = require('../src/web/server');

function get(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ hostname: '127.0.0.1', port, path: p }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    r.on('error', reject);
    // A render that throws inside the async route never answers; that is the failure, not a hang.
    r.setTimeout(15_000, () => { r.destroy(new Error('the re-price page never answered')); });
  });
}

(async () => {
  const now = Date.now();
  const load = { id: 'NOSTACK1', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32 Feet', units: 1,
    companyName: 'Havells', closesAt: now + 40 * 60_000, startsAt: now - 60_000, softClose: false,
    closeModelKnown: true, status: 'live', rules: { minDecrement: 1000 } };
  const price = { cost: 5_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 };
  const created = await requests.createForLoad(load, { deadlineAt: now + 30 * 60_000 });
  // A portal no stack in this process serves: the same shape a GoComet load has while GoComet is down.
  await requests.store.patchDoc('priceRequests', created.id, {
    status: 'armed', marginsPct: price.marginsPct, minMarginPct: price.minMarginPct, price, platformKey: 'gocomet',
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  let failed = 0;
  try {
    const res = await get(srv.address().port, `/price/${created.id}`);
    try {
      assert.strictEqual(res.status, 200, `the re-price page answered ${res.status} for a load whose portal is not running`);
      assert.ok(/<form/.test(res.text), 'the re-price page rendered no form');
      assert.ok(/<div class="lwarn bad" id="floorStep" hidden>/.test(res.text),
        'with no engine to ask, the floor-step block must render hidden rather than claim a verdict');
      console.log('  ok  the re-price page renders, with the floor-step block hidden, when the portal is not running');
    } catch (e) { failed++; console.error('  FAIL -', e.message); }
  } finally { srv.close(); }
  if (failed) process.exit(1);
  console.log('\nfloor-step page without a running portal: 1/1 checks passed');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
