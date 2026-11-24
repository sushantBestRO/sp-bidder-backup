'use strict';
/**
 * A RE-PRICE WHOSE RE-ARM THROWS PUTS THE LOAD BACK AS IT WAS, OR HOLDS IT AND SAYS SO.
 *
 * Regression target: A008. The three re-price routes (POST /price/:token on an armed load, and the
 * console's /api/price-requests/:id/margin and /margin/clear) write the new plan, then
 * reArmWithNewBand stops the live monitor and arms the new one. When that arm threw for any reason
 * other than the two named codes, the routes answered 500 "saved but re-arm failed": the record read
 * armed on the new plan, nothing was bidding, and nobody was told plainly. A shut write gate was not
 * special-cased either, and was found only after the monitor had been stopped.
 *
 * Owner's default, as pinned here (mirroring the /resume and /rearm routes):
 *   - the re-arm throws once: the record goes back to the prior plan, the prior plan is re-armed, and
 *     the desk is told nothing changed and what the load is still bidding at - never a 500;
 *   - the re-arm of the prior plan throws too: the load is parked on its prior cost (not armed), the
 *     desk is told plainly that it is not bidding, and an error alert is raised;
 *   - a portal whose write gate is shut is refused before anything is written, and the live monitor
 *     is left running.
 *
 *   node scripts/test-reprice-rearm-failure-rolls-back.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-reprice-rollback-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function post(base, url, obj, { api = false } = {}) {
  const body = JSON.stringify(obj);
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (api) headers.origin = base;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers },
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
const breakArm = (times) => {
  let left = times;
  const saved = [];
  for (const s of stacks) {
    const real = s.engine.arm;
    saved.push([s.engine, real]);
    s.engine.arm = function (...a) {
      if (left > 0) { left -= 1; throw new Error('arm refused: stale load rules snapshot'); }
      return real.apply(this, a);
    };
  }
  return () => { for (const [engine, fn] of saved) engine.arm = fn; };
};
const alerts = [];
for (const s of stacks) {
  const realEmit = s.engine.emit.bind(s.engine);
  s.engine.emit = (e) => { if (e && e.type === 'alert') alerts.push(e); return realEmit(e); };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const armedLoad = async (id) => {
    const r = await requests.createForLoad(load(id));
    const res = await post(base, `/price/${r.id}`, { cost: '29000' });
    if (res.status !== 200 || !liveMonitor(id)) throw new Error(`setup: ${id} did not arm (HTTP ${res.status})`);
    return r;
  };
  const reprice = (r) => post(base, `/price/${r.id}`, { cost: '33000', m_0: '9', m_1: '5', m_2: '1' });

  console.log('\n1. /price re-price, the re-arm throws once');
  {
    const r = await armedLoad('RP-1');
    const restore = breakArm(1);
    let res;
    try { res = await reprice(r); } finally { restore(); }
    ok(res.status !== 200 && res.status < 500, `a refusal, not a success and not a server fault (HTTP ${res.status})`);
    ok(!!res.json && /^Not changed\. This load is still bidding at Rs 29,000, as before\. Try again\.$/.test(res.json.error || ''),
      `saying what the load is still bidding at, with the error in the log, not the desk text (${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && after.price.cost === 29_000, `the record is back on the prior plan (${after.status}, ${after.price.cost})`);
    const m = liveMonitor('RP-1');
    ok(!!m && m.ladder[m.ladder.length - 1] === 29_290, `and a live monitor bids the prior ladder (floor ${m && m.floor})`);
  }

  console.log('\n2. /price re-price, the re-arm of the prior plan throws too');
  {
    const r = await armedLoad('RP-2');
    const alertsBefore = alerts.length;
    const restore = breakArm(2);
    let res;
    try { res = await reprice(r); } finally { restore(); }
    ok(res.status !== 200 && res.status < 500, `a refusal, not a server fault (HTTP ${res.status})`);
    // Owner wording: short, and no error text in it (that goes to the log).
    ok(!!res.json && /^Not saved\. This load isn't bidding now\. Re-arm it or bid by hand\.$/.test(res.json.error || ''), `saying plainly the load is not bidding now (${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.status !== 'armed' && after.price && after.price.cost === 29_000,
      `the record no longer reads armed, and keeps the prior cost (${after.status}, ${after.price && after.price.cost})`);
    ok(!liveMonitor('RP-2'), 'nothing is bidding, and nothing claims to be');
    ok(alerts.slice(alertsBefore).some((e) => String(e.auctionId) === 'RP-2' && e.level === 'error'),
      'an error alert names the load');
  }

  console.log('\n3. /price re-price on a portal whose write gate is shut');
  {
    const r = await armedLoad('RP-3');
    const engine = stacks[0].engine;
    const caps = engine.caps;
    engine.caps = Object.assign({}, caps, { biddingEnabled: false });
    let res;
    try { res = await reprice(r); } finally { engine.caps = caps; }
    ok(res.status === 409, `refused before the write (HTTP ${res.status}: ${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.status === 'armed' && after.price.cost === 29_000, 'the record is untouched');
    ok(!!liveMonitor('RP-3'), 'and the live monitor was never stopped');
  }

  console.log('\n4. console margin route, the re-arm throws once');
  {
    const r = await armedLoad('RP-4');
    const restore = breakArm(1);
    let res;
    try { res = await post(base, `/api/price-requests/${r.id}/margin`, { marginsPct: [12, 8, 2], minMarginPct: 2, cost: 30000, confirm: true }, { api: true }); }
    finally { restore(); }
    ok(res.status !== 200 && res.status < 500, `a refusal, not a server fault (HTTP ${res.status}: ${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 29_000 && after.marginsPct.join() === '9,5,1' && !!liveMonitor('RP-4'),
      `back on the prior plan and bidding (${after.price.cost}, ${after.marginsPct})`);
  }

  console.log('\n5. console margin/clear route, the re-arm throws once');
  {
    const r = await armedLoad('RP-5');
    const set = await post(base, `/api/price-requests/${r.id}/margin`, { marginsPct: [12, 8, 2], minMarginPct: 2, confirm: true }, { api: true });
    ok(set.status === 200, `setup: a per-load band is set (HTTP ${set.status})`);
    const restore = breakArm(1);
    let res;
    try { res = await post(base, `/api/price-requests/${r.id}/margin/clear`, { confirm: true }, { api: true }); }
    finally { restore(); }
    ok(res.status !== 200 && res.status < 500, `a refusal, not a server fault (HTTP ${res.status}: ${res.json && res.json.error})`);
    const after = await requests.getByToken(r.id);
    ok(after.marginsPct.join() === '12,8,2' && after.marginSource === 'bid' && !!liveMonitor('RP-5'),
      `the per-load band is back and bidding (${after.marginsPct}, ${after.marginSource})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
