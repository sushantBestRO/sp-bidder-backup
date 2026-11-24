'use strict';
/**
 * STOP, RE-ARM AND REQUEST CREATION RESOLVE A LOAD BY (PLATFORM, ID), NEVER BY A BARE ID.
 *
 * Regression target: C063. POST /api/auctions/:loadId/stop and /rearm resolved the record with
 * requests.getByLoad(loadId) and no platform, and the stop route fell back to the first stack whose
 * snapshot held that id. getByLoad documents the platform as optional because SuperProcure ids are
 * numeric and GoComet's alphanumeric - a coincidence test-platform-scoped-arm.js says must never be
 * relied on as a guard. With one id on both portals, the store's enumeration order decided which
 * portal's auction an operator's Stop hit. createForLoad's one-request-per-load check had the same
 * bare lookup, so a GoComet load sharing an id with a SuperProcure one never got a request at all.
 *
 * Now the routes take the portal (?platform=), the console sends it, and a request without one is
 * resolved only when a single portal holds that id; two portals holding it is refused, not guessed.
 *
 *   node scripts/test-stop-rearm-platform-scoped.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-platform-scoped-stop-'));

const http = require('http');
const { app, requests, stacks, store } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function post(base, url, obj, { api = false } = {}) {
  const body = JSON.stringify(obj || {});
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (api) headers.origin = base;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers },
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
// A GoComet record for the same id, written beside the SuperProcure one.
async function gocometTwin(spDoc, status) {
  const id = `${spDoc.id}gc`;
  await store.putDoc('priceRequests', id, Object.assign({}, spDoc, { id, platformKey: 'gocomet', status,
    price: { cost: 50_000, marginsPct: [9, 5, 1], minMarginPct: 1 } }));
  return id;
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. Stop on the GoComet row leaves the SuperProcure auction with the same id bidding');
  {
    const sp = await requests.createForLoad(load('777001'));
    ok((await post(base, `/price/${sp.id}`, { cost: '29000' })).status === 200 && !!liveMonitor('777001'), 'setup: SuperProcure 777001 is armed and bidding');
    const gcId = await gocometTwin(await requests.getByToken(sp.id), 'armed');
    const res = await post(base, '/api/auctions/777001/stop?platform=gocomet', {}, { api: true });
    ok(res.status === 200, `the stop is accepted (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok(!!liveMonitor('777001') && (await requests.getByToken(sp.id)).status === 'armed',
      'the SuperProcure auction is untouched and still bidding');
    ok((await requests.getByToken(gcId)).status === 'stopped', 'the GoComet record is the one stopped');
  }

  console.log('\n2. a request with no portal, on an id two portals hold, is refused rather than guessed');
  {
    const sp = await requests.createForLoad(load('777002'));
    await post(base, `/price/${sp.id}`, { cost: '29000' });
    const gcId = await gocometTwin(await requests.getByToken(sp.id), 'armed');
    const res = await post(base, '/api/auctions/777002/stop', {}, { api: true });
    ok(res.status === 409, `refused (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok(!!liveMonitor('777002') && (await requests.getByToken(sp.id)).status === 'armed'
      && (await requests.getByToken(gcId)).status === 'armed', 'and nothing was stopped on either portal');
  }

  console.log('\n3. Re-arm resolves by portal too');
  {
    const sp = await requests.createForLoad(load('777003'));
    await post(base, `/price/${sp.id}`, { cost: '29000' });
    ok((await post(base, '/api/auctions/777003/stop?platform=sp', {}, { api: true })).status === 200, 'setup: SuperProcure 777003 stopped');
    const gcId = await gocometTwin(await requests.getByToken(sp.id), 'stopped');
    const gcRes = await post(base, '/api/auctions/777003/rearm?platform=gocomet', {}, { api: true });
    ok(gcRes.status === 409 && !liveMonitor('777003') && (await requests.getByToken(sp.id)).status === 'stopped',
      `Re-arm on the GoComet row does not re-arm the SuperProcure one (HTTP ${gcRes.status}: ${gcRes.json && gcRes.json.error})`);
    const res = await post(base, '/api/auctions/777003/rearm?platform=sp', {}, { api: true });
    ok(res.status === 200 && (await requests.getByToken(sp.id)).status === 'armed' && !!liveMonitor('777003'),
      `the SuperProcure row re-arms from its own portal (HTTP ${res.status}: ${res.json && res.json.error})`);
    ok((await requests.getByToken(gcId)).status === 'stopped', 'the GoComet row is untouched');
  }

  console.log('\n4. control: an id only one portal holds still stops without a portal named');
  {
    const sp = await requests.createForLoad(load('777004'));
    await post(base, `/price/${sp.id}`, { cost: '29000' });
    const res = await post(base, '/api/auctions/777004/stop', {}, { api: true });
    ok(res.status === 200 && !liveMonitor('777004') && (await requests.getByToken(sp.id)).status === 'stopped',
      `stopped (HTTP ${res.status})`);
  }

  console.log('\n5. a GoComet load sharing an id with a SuperProcure one gets its own request');
  {
    const sp = await requests.createForLoad(load('777005'), { platformKey: 'sp' });
    const gc = await requests.createForLoad(load('777005'), { platformKey: 'gocomet' });
    ok(gc.id !== sp.id && (gc.platformKey === 'gocomet'), `two requests, one per portal (${sp.id} / ${gc.id} ${gc.platformKey})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
