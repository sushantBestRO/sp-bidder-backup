'use strict';
/**
 * A COST CORRECTED BACK DOWN BY HAND IS ON THE APPEND-ONLY CORRECTION TRAIL, LIKE THE RAISE WAS.
 *
 * Regression target: A046. noteCostCorrection ran only on the held path (recordAndHold) and on a
 * resume. The desk raises a cost above our standing bid (held, trail gets 29,000 -> 38,000), then
 * types it back down to one the portal can take: that re-price is not held, so the trail kept only
 * the raise and dropped the withdrawal, and the live correction override still named 38,000.
 *
 * Unchanged: a re-price with no bid standing writes no correction, because there is nothing on the
 * board for a correction to be about.
 *
 *   node scripts/test-downward-reprice-cost-correction.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-down-correction-'));

const http = require('http');
const { app, requests, stacks, store, bidLogger } = require('../src/web/server');

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
const STANDING = 31_610;
const standBid = (loadId) => {
  const m = liveMonitor(loadId);
  m.lastBidPrice = STANDING; m.landedBids = 1;
  for (const s of stacks) {
    if (s.engine.scheduler.get(loadId)) s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: STANDING, everBid: true });
  }
};
const band = { m_0: '9', m_1: '7.2', m_2: '1.8' };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. raise above the standing bid (held), then bring it back down (not held)');
  {
    const r = await requests.createForLoad(load('DC-1'));
    ok((await post(base, `/price/${r.id}`, { cost: '29000' })).status === 200, 'setup: armed at Rs 29,000');
    standBid('DC-1');
    const up = await post(base, `/price/${r.id}`, Object.assign({ cost: '38000' }, band));
    ok(up.status === 200 && !!up.json && !!up.json.held, `setup: the raise to Rs 38,000 is held (HTTP ${up.status})`);
    await bidLogger.noteCostCorrection('noop-flush', {});
    let rec = await store.getDoc('closedBids', 'DC-1');
    ok(!!rec && Array.isArray(rec.costCorrections) && rec.costCorrections.length === 1 && rec.costCorrections[0].to === 38_000,
      `setup: the raise is on the trail (${rec && JSON.stringify(rec.costCorrections)})`);
    const down = await post(base, `/price/${r.id}`, Object.assign({ cost: '30000' }, band));
    ok(down.status === 200 && !(down.json && down.json.held), `the correction back down lands and is not held (HTTP ${down.status})`);
    await bidLogger.noteCostCorrection('noop-flush', {});
    rec = await store.getDoc('closedBids', 'DC-1');
    const trail = (rec && rec.costCorrections) || [];
    ok(trail.length === 2 && trail[1].from === 38_000 && trail[1].to === 30_000 && trail[1].standingBidPrice === STANDING,
      `the withdrawal is appended to the trail (${JSON.stringify(trail)})`);
    ok(!!rec && !!rec.costCorrection && rec.costCorrection.to === 30_000,
      `and the live correction names the cost now on the plan (${rec && JSON.stringify(rec.costCorrection)})`);
  }

  console.log('\n2. control: no bid standing, so a re-price down is not a correction');
  {
    const r = await requests.createForLoad(load('DC-2'));
    await post(base, `/price/${r.id}`, { cost: '32000' });
    const down = await post(base, `/price/${r.id}`, Object.assign({ cost: '30000' }, band));
    await bidLogger.noteCostCorrection('noop-flush', {});
    const rec = await store.getDoc('closedBids', 'DC-2');
    ok(down.status === 200 && !!rec && !rec.costCorrections && !rec.costCorrection,
      `no correction is written (${rec && JSON.stringify(rec.costCorrections)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
