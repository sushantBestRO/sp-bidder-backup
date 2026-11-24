'use strict';
/**
 * THE CONSOLE MARGIN ROUTE STORES A BELOW-MINIMUM BAND UNCONFIRMED, AND /price ARMS IT (M0-F2, M0-F5).
 *
 * /price refuses a per-load band whose own minimum is below the customer minimum unless the body
 * carries below_min_ack (409 BELOW_MINIMUM). POST /api/price-requests/:id/margin has no such gate:
 * it stores { [12.6, 7.2, 6.3], min 1 } against a 5% customer minimum with a 200, and on an armed
 * load it re-arms the lower band. The /price capture gate then judges only a band in the request
 * BODY, so a plain cost capture on that load arms the stored override with no confirmation - on a
 * load capped at 102,000 that is one bid at 102,000, 2% over cost under a 5% customer minimum.
 *
 * What must happen instead:
 *   - the margin route refuses a band below the customer minimum without below_min_ack, exactly as
 *     /price does: 409, code BELOW_MINIMUM, belowMinimum { marginPct, customerMinPct }, nothing saved
 *     and nothing re-armed;
 *   - the /price capture judges the band it will arm, a STORED override included, so a capture that
 *     would arm a stored below-minimum override needs below_min_ack too (JSON and native form).
 *
 * What must NOT move (green before and after the fix):
 *   - with below_min_ack the route stores the band and records belowMinimum;
 *   - a band at the customer minimum needs no ack on the route;
 *   - with below_min_ack the capture arms the stored override, one bid at the ceiling [102000];
 *   - a capture on a stored override at the customer minimum, or on no override, needs no ack.
 *
 * Figures: default band [12.6, 7.2, 6.3] min 5, so the customer minimum is 5. Cost 100,000.
 * Override min 1 guards at 101,000; ceiling 102,000 sits between that and 106,300, so it arms
 * [102000]. Rows [10, 7, 3] min 3 arm [110000, 107000, 103000].
 *
 *   node scripts/test-margin-route-below-minimum-ack.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12.6,7.2,6.3';
process.env.SP_MIN_MARGIN_PCT = '5';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-route-below-min-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

const COST = '100000';
const CUSTOMER_MIN = 5;
const BAND = [12.6, 7.2, 6.3];
const INHERITED_LADDER = [112600, 107200, 106300];
const LOW = { marginsPct: BAND, minMarginPct: 1 };
const LOW_ROWS = { marginsPct: [10, 7, 3], minMarginPct: 3 };
const CEILING = 102000;

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });

function mainFormBody(html) {
  const start = html.indexOf('id="mainForm"');
  assert.ok(start >= 0, 'the served page has no #mainForm');
  const end = html.indexOf('</form>', start);
  const body = {};
  const re = /<input\b[^>]*>/g;
  const chunk = html.slice(start, end);
  let tag;
  while ((tag = re.exec(chunk))) {
    const t = tag[0];
    if (/\bdisabled\b/.test(t)) continue;
    const name = /\bname="([^"]+)"/.exec(t);
    const value = /\bvalue="([^"]*)"/.exec(t);
    if (name) body[name[1]] = value ? value[1] : '';
  }
  return body;
}

const now = Date.now();
const mkLoad = (id, ceilingPrice = null) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'Route Minimum Test Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice, pricingMode: 'flat' },
});
const armedMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m) return m;
  }
  return null;
};
const tick = () => new Promise((r) => setImmediate(r));

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

function assertRefused(res, marginPct, extra = '') {
  assert.ok(res.status === 409, `expected 409 BELOW_MINIMUM, got ${res.status}${extra}`);
  assert.ok(res.json, 'no JSON body');
  assert.strictEqual(res.json.code, 'BELOW_MINIMUM');
  assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0, 'no error message');
  assert.deepStrictEqual(res.json.belowMinimum, { marginPct, customerMinPct: CUSTOMER_MIN });
}
const docLine = (d, loadId) => ` | stored ${JSON.stringify(d.marginOverride && { m: d.marginOverride.marginsPct, min: d.marginOverride.minMarginPct })} source ${d.marginSource} status ${d.status} ladder ${JSON.stringify(armedMonitor(loadId) && armedMonitor(loadId).ladder)}`;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = (r, band) => req('POST', `${base}/api/price-requests/${r.id}/margin`, Object.assign(json(band), { origin: base }));
  const capture = async (r, body) => { const res = await req('POST', `${base}/price/${r.id}`, json(body)); await tick(); return res; };
  const armed = async (id, ceiling = null) => {
    const r = await requests.createForLoad(mkLoad(id, ceiling));
    const res = await capture(r, { cost: COST });
    assert.ok(res.status < 400, `setup capture of ${id} returned ${res.status}`);
    return r;
  };
  // A stored below-minimum override, written the way this route writes it once the desk has confirmed.
  const storedLow = async (id) => {
    const r = await requests.createForLoad(mkLoad(id, CEILING));
    const res = await route(r, Object.assign({ below_min_ack: '1' }, LOW));
    assert.ok(res.status < 400, `setup route save on ${id} returned ${res.status}: ${res.text.slice(0, 160)}`);
    return r;
  };

  console.log('\n1. POST /api/price-requests/:id/margin, band below the 5% customer minimum, no below_min_ack');
  await check('awaiting load, { [12.6, 7.2, 6.3], min 1 }: 409 BELOW_MINIMUM { 1, 5 }, nothing stored', async () => {
    const r = await requests.createForLoad(mkLoad('RM-AW-1'));
    const res = await route(r, LOW);
    const d = await requests.getByToken(r.id);
    assertRefused(res, 1, docLine(d, 'RM-AW-1'));
    assert.deepStrictEqual([d.marginOverride, d.marginSource, d.minMarginPct], [null, 'default', CUSTOMER_MIN]);
  });
  await check('awaiting load, { [10, 7, 3], min 3 }: 409 BELOW_MINIMUM { 3, 5 }, nothing stored', async () => {
    const r = await requests.createForLoad(mkLoad('RM-AW-3'));
    const res = await route(r, LOW_ROWS);
    const d = await requests.getByToken(r.id);
    assertRefused(res, 3, docLine(d, 'RM-AW-3'));
    assert.strictEqual(d.marginOverride, null);
  });
  await check('armed load, confirm:true, { [10, 7, 3], min 3 }: 409 BELOW_MINIMUM { 3, 5 }, ladder stays [112600, 107200, 106300]', async () => {
    const r = await armed('RM-ARMED');
    const res = await route(r, Object.assign({ confirm: true }, LOW_ROWS));
    const d = await requests.getByToken(r.id);
    assertRefused(res, 3, docLine(d, 'RM-ARMED'));
    assert.deepStrictEqual(armedMonitor('RM-ARMED').ladder, INHERITED_LADDER);
    assert.deepStrictEqual([d.marginsPct, d.minMarginPct], [BAND, CUSTOMER_MIN]);
  });

  console.log('\n2. /price capture on a load carrying a stored { min 1 } override, capped at 102,000, no below_min_ack');
  await check('JSON capture { cost } with no override in the body: 409 BELOW_MINIMUM { 1, 5 }, not armed', async () => {
    const r = await storedLow('RM-F5-JSON');
    const res = await capture(r, { cost: COST });
    const d = await requests.getByToken(r.id);
    assertRefused(res, 1, docLine(d, 'RM-F5-JSON'));
    assert.strictEqual(d.status, 'awaiting_price');
    assert.strictEqual(armedMonitor('RM-F5-JSON'), null);
  });
  await check('native form post of the untouched page: refused 409, not armed', async () => {
    const r = await storedLow('RM-F5-FORM');
    const page = await req('GET', `${base}/price/${r.id}`);
    const body = Object.assign(mainFormBody(page.text), { cost: COST });
    const res = await req('POST', `${base}/price/${r.id}`, { body: form(body) });
    await tick();
    const d = await requests.getByToken(r.id);
    assert.strictEqual(res.status, 409, `expected 409, got ${res.status}${docLine(d, 'RM-F5-FORM')}`);
    assert.strictEqual(d.status, 'awaiting_price');
    assert.strictEqual(armedMonitor('RM-F5-FORM'), null);
  });

  console.log('\n3. controls: behaviour that must not move');
  await check('route WITH below_min_ack stores { min 1 } and records belowMinimum { 1, 5 }', async () => {
    const r = await storedLow('RM-ACK');
    const d = await requests.getByToken(r.id);
    assert.deepStrictEqual([d.marginOverride.minMarginPct, d.marginSource], [1, 'bid']);
    const b = d.marginOverride.belowMinimum;
    assert.ok(b, 'no belowMinimum record');
    assert.deepStrictEqual([b.marginPct, b.customerMinPct], [1, CUSTOMER_MIN]);
  });
  await check('route with a band at the customer minimum ({ [12.6, 7.2, 6.3], min 5 }) needs no ack and records nothing', async () => {
    const r = await requests.createForLoad(mkLoad('RM-AT-MIN'));
    const res = await route(r, { marginsPct: BAND, minMarginPct: CUSTOMER_MIN });
    assert.ok(res.status < 400, `status ${res.status}: ${res.text.slice(0, 160)}`);
    const d = await requests.getByToken(r.id);
    assert.strictEqual(d.marginSource, 'bid');
    assert.ok(!(d.marginOverride && d.marginOverride.belowMinimum), 'recorded belowMinimum');
  });
  await check('capture WITH below_min_ack on the stored { min 1 } override arms exactly [102000]', async () => {
    const r = await storedLow('RM-F5-ACK');
    const res = await capture(r, { cost: COST, below_min_ack: '1' });
    assert.ok(res.status < 400, `status ${res.status}: ${res.text.slice(0, 160)}`);
    assert.deepStrictEqual(armedMonitor('RM-F5-ACK') && armedMonitor('RM-F5-ACK').ladder, [CEILING]);
  });
  await check('capture on a stored override at the customer minimum, no ack, arms [112600, 107200, 106300]', async () => {
    const r = await requests.createForLoad(mkLoad('RM-AT-MIN-CAP'));
    await route(r, { marginsPct: BAND, minMarginPct: CUSTOMER_MIN });
    const res = await capture(r, { cost: COST });
    assert.ok(res.status < 400, `status ${res.status}: ${res.text.slice(0, 160)}`);
    assert.deepStrictEqual(armedMonitor('RM-AT-MIN-CAP') && armedMonitor('RM-AT-MIN-CAP').ladder, INHERITED_LADDER);
  });
  await check('capture with no override anywhere, no ack, arms the inherited ladder', async () => {
    const r = await armed('RM-PLAIN');
    assert.ok(r);
    assert.deepStrictEqual(armedMonitor('RM-PLAIN').ladder, INHERITED_LADDER);
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a band below the customer minimum reaches the ladder unconfirmed (the console margin route has no below_min_ack gate, and the /price capture judges only a band in the body, never the stored override it arms):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - the margin route and the capture of a stored override both need the below-minimum confirmation`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
