'use strict';
/**
 * A ROLLED-BACK RE-PRICE OR RESUME PUTS BACK THE QUOTE'S EPOCH, SO THE PORTAL'S VERDICTS STILL STAND.
 *
 * Regression target: A008 review finding 1. The put-back restored cost, margins, price and hold but
 * not repriceEpoch, which the failed write had already bumped. The re-armed monitor therefore read the
 * rolled-back plan as a NEW quote and dropped the carried refusalState - submission closed, raise
 * refused, the refused-price run - and would re-send prices the portal had already refused while the
 * desk was told the load was bidding "as before". The same gap sat in undoResume.
 *
 * Driven through the real /price routes with engine.arm() failing once.
 *
 *   node scripts/test-reprice-rollback-keeps-verdicts.js
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
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rollback-verdicts-'));

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
const eng = () => stacks[0].engine;
const latch = (id) => {
  const m = eng().monitors.get(id);
  m.submissionClosed = true; m.priceRaiseRefused = true;
  eng().scheduler.update(id, { refusalState: eng()._refusalStateOf(m) });
};
const armFailsOnce = () => {
  const e = eng(); const real = e.arm; let left = 1;
  e.arm = function (...a) { if (left > 0) { left -= 1; throw new Error('arm refused'); } return real.apply(this, a); };
  return () => { e.arm = real; };
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. re-price rolled back');
  {
    const r = await requests.createForLoad(load('RV-1'));
    ok((await post(base, `/price/${r.id}`, { cost: '29000' })).status === 200, 'setup: armed');
    latch('RV-1');
    const epochBefore = (await requests.getByToken(r.id)).repriceEpoch;
    const restore = armFailsOnce();
    let res;
    try { res = await post(base, `/price/${r.id}`, { cost: '33000', m_0: '9', m_1: '5', m_2: '1' }); } finally { restore(); }
    const after = await requests.getByToken(r.id);
    const m = eng().monitors.get('RV-1');
    ok(res.status === 409 && after.price.cost === 29_000, `setup: rolled back to Rs 29,000 (HTTP ${res.status})`);
    ok((after.repriceEpoch || 0) === (epochBefore || 0), `the quote's epoch is put back (${epochBefore} -> ${after.repriceEpoch})`);
    ok(!!m && m.submissionClosed === true && m.priceRaiseRefused === true,
      `the re-armed monitor still holds the portal's verdicts (submissionClosed ${m && m.submissionClosed}, priceRaiseRefused ${m && m.priceRaiseRefused})`);
  }

  console.log('\n2. resume rolled back');
  {
    const r = await requests.createForLoad(load('RV-2'));
    await post(base, `/price/${r.id}`, { cost: '29000' });
    const m0 = eng().monitors.get('RV-2');
    m0.lastBidPrice = 31_610; m0.landedBids = 1;
    eng().scheduler.update('RV-2', { landedBids: 1, landedBidPrice: 31_610, everBid: true });
    const held = await post(base, `/price/${r.id}`, { cost: '38000', m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    ok(held.status === 200 && !!(await requests.getByToken(r.id)).hold, 'setup: the correction is held');
    latch('RV-2');
    const epochBefore = (await requests.getByToken(r.id)).repriceEpoch;
    const restore = armFailsOnce();
    let res;
    try { res = await post(base, `/price/${r.id}/resume`, {}); } finally { restore(); }
    const after = await requests.getByToken(r.id);
    const m = eng().monitors.get('RV-2');
    ok(res.status === 409 && !!after.hold, `setup: the resume is refused and the hold is back (HTTP ${res.status})`);
    ok((after.repriceEpoch || 0) === (epochBefore || 0), `the quote's epoch is put back (${epochBefore} -> ${after.repriceEpoch})`);
    ok(!!m && m.submissionClosed === true && m.priceRaiseRefused === true, 'the re-armed held monitor still holds the verdicts');
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
