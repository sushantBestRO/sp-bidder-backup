'use strict';
/**
 * The /price page states plainly when the load's portal account is logged out (the auth-dead state
 * the adapter already tracks, isAuthDead()) - one line, and the price is still accepted and saved.
 * Nothing else changes: no refusal, no held cost. When the account is online the page renders
 * byte-identical to today (docs/diagnoses/2026-09-28_rallis-never-priced.md, section 1: "the price
 * page does not know the login is dead" - the desk got no warning that a captured price could not
 * bid until someone reconnects).
 *
 * Boots the app in mock mode over the memory store on an ephemeral port, then monkeypatches the
 * mock stack's adapter with a real isAuthDead() (the mock adapter has none by default, so the
 * feature-detect in portalFactsFor must read false and stay silent until one is added).
 *
 *   node scripts/test-price-page-dead-login.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-price-deadlogin-'));

const assert = require('assert');
const http = require('http');
const { app, requests, stackForRequest } = require('../src/web/server');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) {
      headers['content-type'] = contentType || 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const BANNER = '⚠️ This portal login is logged out. Your rate is saved, but no bid goes out until the login is reconnected.';
const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Ankleshwar', destination: 'Nagpur' }, equipment: 'Trailer', units: 1,
  companyName: 'Rallis India Ltd', closesAt: now + 45 * 60_000, startsAt: now - 60_000, status: 'live',
});

(async () => {
  let n = 0;
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => req('GET', base + p);
  const postForm = (p, kv) => req('POST', base + p, { body: new URLSearchParams(kv).toString() });

  // ---- baseline: account online (mock adapter has no isAuthDead - feature-detected false) ----
  const rOnline = await requests.createForLoad(mkLoad('DL-1'), { deadlineAt: now + 40 * 60_000 });
  const gOnline = await get(`/price/${rOnline.id}`);
  ok(++n, 'online baseline GET renders the normal form');
  assert.strictEqual(gOnline.status, 200);
  assert.ok(/Enter your rate/.test(gOnline.text));
  ok(++n, 'online baseline has no dead-login banner');
  assert.ok(!gOnline.text.includes(BANNER), 'the banner text leaked onto a normal (online) page');
  const baselineHtml = gOnline.text;

  // ---- latch the account's adapter into auth-dead ----
  const stack = stackForRequest(rOnline);
  assert.ok(stack && stack.adapter, 'test setup: a mock stack with an adapter must exist for the primary account');
  stack.adapter.isAuthDead = () => true;

  const rDead = await requests.createForLoad(mkLoad('DL-2'), { deadlineAt: now + 40 * 60_000 });
  const gDead = await get(`/price/${rDead.id}`);
  ok(++n, 'dead-login GET still 200s the normal page');
  assert.strictEqual(gDead.status, 200);
  ok(++n, 'dead-login GET carries the exact owner-approved banner line');
  assert.ok(gDead.text.includes(BANNER), `banner missing from:\n${gDead.text}`);
  ok(++n, 'dead-login GET still renders the price form (not refused)');
  assert.ok(/Enter your rate/.test(gDead.text) && /id="mainForm"/.test(gDead.text), 'the entry form was suppressed on an auth-dead load');

  // ---- the price is still accepted AND saved while the login is dead ----
  const pDead = await postForm(`/price/${rDead.id}`, { cost: '24500' });
  ok(++n, 'POST while auth-dead still saves the cost');
  assert.strictEqual(pDead.status, 200);
  assert.ok(/Cost saved/.test(pDead.text), `expected a normal save confirmation, got:\n${pDead.text}`);
  const rDeadAfter = await requests.getByToken(rDead.id);
  ok(++n, 'the captured cost persisted on the request');
  assert.strictEqual(rDeadAfter.price && rDeadAfter.price.cost, 24500);

  // ---- re-price GET (now armed) still carries the banner while the login stays dead ----
  const gDead2 = await get(`/price/${rDead.id}`);
  ok(++n, 're-price GET (armed) still carries the banner');
  assert.ok(gDead2.text.includes(BANNER));

  // ---- reconnect: the SAME online request renders byte-identical to the pre-latch baseline ----
  stack.adapter.isAuthDead = () => false;
  const gRestored = await get(`/price/${rOnline.id}`);
  ok(++n, 'after reconnect, the online request is byte-identical to the baseline');
  assert.strictEqual(gRestored.text, baselineHtml, 'the page differs after the account came back online');

  // ---- review r1, Finding 2: a refusal page (noForm) must NEVER claim "your rate is saved" ----
  // Nothing here can ever bid (unsupported_rule refuses before a cost is asked for), so the banner's
  // claim would be false regardless of the login. A KG per-tonne load is the easiest live refusal
  // shape (assertRulesSupported: per_tonne requires unit MT) and needs no SP_PMT_BID flag state.
  stack.adapter.isAuthDead = () => true;
  const rRefused = await requests.createForLoad(
    Object.assign(mkLoad('DL-3'), { rules: { pricingMode: 'per_tonne', unit: 'KG' } }),
    { deadlineAt: now + 40 * 60_000 },
  );
  const gRefused = await get(`/price/${rRefused.id}`);
  ok(++n, 'auth-dead + unsupported_rule GET still 200s');
  assert.strictEqual(gRefused.status, 200);
  ok(++n, 'auth-dead + refused load shows the refusal card');
  assert.ok(/We will not bid this load/.test(gRefused.text), `expected the wontBid card, got:\n${gRefused.text}`);
  ok(++n, 'auth-dead + refused load has NO entry form (noForm)');
  assert.ok(!/id="mainForm"/.test(gRefused.text), 'the entry form rendered on a load that cannot ever be bid');
  ok(++n, 'auth-dead + refused load does NOT show the dead-login banner');
  assert.ok(!gRefused.text.includes(BANNER), `the banner claimed a saved price on a refusal page:\n${gRefused.text}`);

  server.close();

  const EXPECTED_CHECKS = 13;
  if (n !== EXPECTED_CHECKS) {
    console.error(`  FAIL - completion sentinel: ran ${n} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\n${pass}/${n} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
