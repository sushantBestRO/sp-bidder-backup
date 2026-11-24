'use strict';
/**
 * THE /price PAGE SUB-LABELS ITS LOWEST MARGIN ROW "floor" (C8-lowest-row-label).
 *
 * renderPriceForm draws one row per band margin, each with a name ("Opening", "Middle", "Lowest")
 * and a small sub-label under it. The last row's sub-label is "floor". The lowest row is a bid - the
 * lowest price the plan sends - not a floor, and "floor" is a word the desk-facing copy does not use.
 *
 * What must happen instead: on both the capture page (request awaiting a price) and the re-price
 * page (request armed), the last row's sub-label reads "lowest bid" and no row's sub-label says
 * "floor".
 *
 * What must NOT move (pinned here, green before and after the fix):
 *   - the first row's sub-label "top price" and the middle row's "a price in between";
 *   - the row names "Opening", "Middle", "Lowest", one row per band margin.
 *
 * Asserted on the served HTML over real HTTP, mock platform, memory store, default band
 * [12.6, 7.2, 6.3] min 5 (three rows).
 *
 *   node scripts/test-price-page-lowest-row-label.js
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

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lowest-row-label-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests } = require('../src/web/server');

function req(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'Row Label Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: null, pricingMode: 'flat' },
});
const tick = () => new Promise((r) => setImmediate(r));

function bidRows(html) {
  const re = /<div class="bidrow[^"]*" data-i="(\d+)"><span class="bnm">([^<]*)<span class="bsub">([^<]*)<\/span>/g;
  const rows = [];
  let m;
  while ((m = re.exec(html))) rows.push({ i: Number(m[1]), name: m[2], sub: m[3] });
  return rows;
}

let checks = 0;
const failures = [];
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

function pageChecks(which, rows) {
  const last = rows[rows.length - 1] || {};
  check(`${which}: three rows named Opening, Middle, Lowest (control)`, () => {
    assert.deepStrictEqual(rows.map((r) => r.name), ['Opening', 'Middle', 'Lowest']);
  });
  check(`${which}: the first row's sub-label is "top price" (control)`, () => {
    assert.strictEqual(rows[0] && rows[0].sub, 'top price');
  });
  check(`${which}: the middle row's sub-label is "a price in between" (control)`, () => {
    assert.strictEqual(rows[1] && rows[1].sub, 'a price in between');
  });
  check(`${which}: the last row's sub-label reads "lowest bid"`, () => {
    assert.strictEqual(last.sub, 'lowest bid', `last row sub-label is "${last.sub}"`);
  });
  check(`${which}: no row sub-label says "floor"`, () => {
    const hit = rows.filter((r) => /\bfloor\b/i.test(r.sub));
    assert.strictEqual(hit.length, 0, `row(s) ${hit.map((r) => `${r.name}="${r.sub}"`).join(', ')} say floor`);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n1. the capture page (request awaiting a price)');
  const cap = await requests.createForLoad(mkLoad('RL-CAPTURE'));
  const capPage = await req('GET', `${base}/price/${cap.id}`);
  check('capture: the page is served for an awaiting_price request on the default band [12.6, 7.2, 6.3]', () => {
    assert.strictEqual(capPage.status, 200);
    assert.strictEqual(cap.status, 'awaiting_price');
    assert.deepStrictEqual(cap.marginsPct, [12.6, 7.2, 6.3]);
  });
  pageChecks('capture', bidRows(capPage.text));

  console.log('\n2. the re-price page (request armed)');
  const rp = await requests.createForLoad(mkLoad('RL-REPRICE'));
  const armRes = await req('POST', `${base}/price/${rp.id}`, 'cost=100000');
  await tick();
  const rpDoc = await requests.getByToken(rp.id);
  const rpPage = await req('GET', `${base}/price/${rp.id}`);
  check('re-price: a cost-only capture armed the request and its page is served', () => {
    assert.ok(armRes.status < 400, `capture status ${armRes.status}`);
    assert.strictEqual(rpDoc.status, 'armed');
    assert.strictEqual(rpPage.status, 200);
  });
  pageChecks('re-price', bidRows(rpPage.text));

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - the /price page sub-labels the lowest margin row "floor" (renderPriceForm) though that row is a bid:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - the lowest margin row reads "lowest bid" on the capture and re-price pages, and the other rows keep their labels`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
