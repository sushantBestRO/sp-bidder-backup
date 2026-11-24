'use strict';
/**
 * GC-2/GC-3: the /price page's "Also" tile for GoComet's extra pickup/drop points.
 *
 * Shares laneDisplay.twoPointFacts with the WhatsApp ask (test-gocomet-ask-two-point.js pins that
 * half) so the two surfaces cannot state a load's extra stops differently. An extra pickup and an
 * extra drop joined onto one unlabelled "Also" tile reads as one fact about one end, and a pricer
 * reading it as an extra drop when it is really an extra pickup prices the wrong route.
 *
 * Drives the REAL GoCometAdapter mapping (mocked transport only) into the REAL renderPriceForm,
 * the same seam the desk's browser renders, rather than hand-building a load object with
 * pre-mapped fields a future adapter change could silently drift from.
 *
 *   node scripts/test-price-page-two-point-facts.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-2point-'));

const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { renderPriceForm } = require('../src/web/server');

const results = [];
const check = (n, desc, fn) => {
  try { fn(); results.push({ n, ok: true }); }
  catch (e) { results.push({ n, ok: false }); console.error(`  FAIL ${n}. ${desc}: ${e.message}`); }
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64url({ alg: 'ES256' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

async function mappedLoad(extraDetail) {
  const base = Date.now();
  const list = { data: { total_page: 1, enquiries: [{ key: 'K1', origin: 'Plot 1, GIDC, Chikhli-396521, Gujarat', destination: 'Degam-396530, Gujarat',
    origin_zip_code: '396521', destination_zip_code: '396530', bidding_closed: false, bid_close_timestamp: new Date(base + 3600e3).toISOString() }] } };
  const fetchImpl = async (url) => {
    if (url.includes('/enquiries/spot')) return resp(200, list);
    if (/\/enquiries\/K1$/.test(url)) return resp(200, { data: { cargo_quantity: 1, cargo_unit: 'TRUCK', slab_rate: 100, ...extraDetail } });
    return resp(404, {});
  };
  const a = new GoCometAdapter({ token, fetchImpl, sleep: async () => {}, now: () => base });
  const [load] = await a.listAuctions();
  return load;
}

function priceHtml(load) {
  const r = { id: 'x', token: 'tok', loadId: 'K1', status: 'pending', platform: 'gocomet', load, marginsPct: [5, 3], minMarginPct: 2 };
  return renderPriceForm({ headers: {}, query: {} }, r, {});
}

function tile(html, label) {
  const m = html.match(new RegExp(`<span class="sl">${label}</span><span class="sv">([^<]*)</span>`));
  return m ? m[1] : null;
}

const stops = (n) => ({
  addr: Array.from({ length: n }, (_, i) => `Road ${i}, Town${String.fromCharCode(97 + (i % 26))}-2${String(i).padStart(5, '0')}`),
  zip: Array.from({ length: n }, (_, i) => `2${String(i).padStart(5, '0')}`),
});

(async () => {
  const p1 = stops(1);
  const pickupOnly = await mappedLoad({ other_origins: p1.addr, other_origin_zip_codes: p1.zip });

  const d1 = stops(1);
  const dropOnly = await mappedLoad({ other_destinations: d1.addr, other_destination_zip_codes: d1.zip });

  const both = await mappedLoad({
    other_origins: p1.addr, other_origin_zip_codes: p1.zip,
    other_destinations: d1.addr, other_destination_zip_codes: d1.zip,
  });

  const d2 = stops(2);
  const twoDrops = await mappedLoad({ other_destinations: d2.addr, other_destination_zip_codes: d2.zip });

  const d6 = stops(6);
  const manyDrops = await mappedLoad({ other_destinations: d6.addr, other_destination_zip_codes: d6.zip });

  check(1, 'an extra pickup alone renders "Also pickup", never a bare "Also"', () => {
    const html = priceHtml(pickupOnly);
    assert.strictEqual(tile(html, 'Also pickup'), 'Towna 200000');
    assert.strictEqual(tile(html, 'Also'), null);
  });

  check(2, 'an extra drop alone renders "Also drop", never a bare "Also"', () => {
    const html = priceHtml(dropOnly);
    assert.strictEqual(tile(html, 'Also drop'), 'Towna 200000');
    assert.strictEqual(tile(html, 'Also'), null);
  });

  check(3, 'an extra pickup AND an extra drop render as two separate tiles, never joined on one', () => {
    const html = priceHtml(both);
    assert.strictEqual(tile(html, 'Also pickup'), 'Towna 200000');
    assert.strictEqual(tile(html, 'Also drop'), 'Towna 200000');
    assert.ok(!/Towna 200000, Towna 200000/.test(html), 'a pickup and a drop must never share one tile - that reads a drop as a pickup');
  });

  check(4, 'two stops in the SAME list still join on one comma-separated tile, uncapped', () => {
    const html = priceHtml(twoDrops);
    assert.strictEqual(tile(html, 'Also drop'), 'Towna 200000, Townb 200001');
  });

  check(5, 'GC-3: more than 3 stops in one list shows the first 3, then "+N more"', () => {
    const html = priceHtml(manyDrops);
    assert.strictEqual(tile(html, 'Also drop'), 'Towna 200000, Townb 200001, Townc 200002, +3 more');
  });

  const EXPECTED = 5;
  const failed = results.filter((r) => !r.ok).map((r) => r.n);
  assert.strictEqual(results.length, EXPECTED, `expected ${EXPECTED} checks, ran ${results.length}`);
  if (failed.length) {
    console.error(`FAIL: ${failed.length} of ${EXPECTED} checks (${failed.join(', ')}) - the /price page's extra-stop tile is not pickup/drop-safe`);
    process.exit(1);
  }
  console.log(`PASS: all ${EXPECTED} checks`);
})();
