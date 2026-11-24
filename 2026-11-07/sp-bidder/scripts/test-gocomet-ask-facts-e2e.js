'use strict';
/**
 * GC-1: BC-35 (truck dimensions) and BC-36 (extra pickup/drop points) were reaching the desk only
 * because three separate wires stayed connected - none of which any existing test pinned. An
 * independent verifier reverted each one in turn and every suite still passed:
 *   1. Notifier._priceNeededData carrying `L.dimensions` onto the ask's data
 *   2. Notifier._priceNeededData carrying `L.otherOrigins`/`L.otherDestinations` onto it
 *   3. server.js's renderLoadCard rendering the "Also pickup"/"Also drop" tiles on /price
 *
 * This drives the REAL production seam end to end - GoCometAdapter.listAuctions() (mocked
 * transport only) -> Notifier._priceNeededData -> renderMessage, and the same mapped load through
 * the REAL renderPriceForm - so a revert of any one of the three wires above turns THIS file red,
 * whatever else in the suite still passes.
 *
 *   node scripts/test-gocomet-ask-facts-e2e.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-e2e-'));

const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { renderPriceForm } = require('../src/web/server');

const results = [];
const check = (n, desc, fn) => {
  try { fn(); results.push({ n, ok: true }); }
  catch (e) { results.push({ n, ok: false }); console.error(`  FAIL ${n}. ${desc}: ${e.message}`); }
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64url({ alg: 'ES256' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

(async () => {
  const base = Date.now();
  const list = { data: { total_page: 1, enquiries: [{ key: 'K1', name: '(2 Point Delivery) ENT-2026-000001',
    origin: 'Plot 1, GIDC, Chikhli-396521, Gujarat', destination: 'Degam-396530, Gujarat',
    origin_zip_code: '396521', destination_zip_code: '396530', bidding_closed: false,
    quantity: [`1 x 32FTSXL (LxWXH 32'x8'x8'8") 9 Ton Truck`], bid_close_timestamp: new Date(base + 3600e3).toISOString() }] } };
  const fetchImpl = async (url) => {
    if (url.includes('/enquiries/spot')) return resp(200, list);
    if (/\/enquiries\/K1$/.test(url)) return resp(200, { data: { cargo_quantity: 1, cargo_unit: 'TRUCK', slab_rate: 100,
      quantity: [`1 x 32FTSXL (LxWXH 32'x8'x8'8") 9 Ton Truck`],
      other_origins: ['Plot 9, Valsad-396001, Gujarat'], other_origin_zip_codes: ['396001'],
      other_destinations: ['Road 1, Hathras-204101, Uttar Pradesh'], other_destination_zip_codes: ['204101'] } });
    return resp(404, {});
  };
  const adapter = new GoCometAdapter({ token, fetchImpl, sleep: async () => {}, now: () => base });
  const [load] = await adapter.listAuctions();

  const notifier = new Notifier({ baseUrl: 'http://x' });
  const request = { id: 'r1', token: 't1', loadId: 'K1', platform: 'gocomet', load, deadlineAt: base + 3000e3, status: 'pending' };
  const data = await notifier._priceNeededData(request);
  const kind = templateFor ? templateFor('price_needed', data) : 'price_needed';
  const wa = renderMessage(kind, data);

  const r = { id: 'r1', token: 't1', loadId: 'K1', status: 'pending', platform: 'gocomet', load, marginsPct: [5, 3], minMarginPct: 2 };
  const html = renderPriceForm({ headers: {}, query: {} }, r, {});

  check(1, 'the mapped load carries the truck dimensions and the extra pickup/drop points (adapter half, not under test here)', () => {
    assert.strictEqual(load.dimensions, `32'x8'x8'8"`);
    assert.ok(load.otherOrigins && load.otherOrigins.length, 'adapter did not map otherOrigins');
    assert.ok(load.otherDestinations && load.otherDestinations.length, 'adapter did not map otherDestinations');
  });

  check(2, 'GC-1 wire 1: the WhatsApp ask carries the dimensions Notifier._priceNeededData reads off the load', () => {
    assert.ok(/32'x8'x8'8"/.test(wa), `dimensions missing from the ask (got: ${JSON.stringify(wa)})`);
  });

  check(3, 'GC-1 wire 2: the WhatsApp ask carries the extra pickup/drop Notifier._priceNeededData reads off the load', () => {
    assert.ok(/\*Also pickup\* - Valsad 396001/.test(wa), `extra pickup missing from the ask (got: ${JSON.stringify(wa)})`);
    assert.ok(/\*Also drop\* - Hathras 204101/.test(wa), `extra drop missing from the ask (got: ${JSON.stringify(wa)})`);
  });

  check(4, 'GC-1 wire 3: the served /price page carries the "Also pickup"/"Also drop" tiles from renderLoadCard', () => {
    assert.ok(/<span class="sl">Also pickup<\/span><span class="sv">Valsad 396001<\/span>/.test(html), '/price page is missing the Also pickup tile');
    assert.ok(/<span class="sl">Also drop<\/span><span class="sv">Hathras 204101<\/span>/.test(html), '/price page is missing the Also drop tile');
  });

  const EXPECTED = 4;
  const failed = results.filter((r) => !r.ok).map((r) => r.n);
  assert.strictEqual(results.length, EXPECTED, `expected ${EXPECTED} checks, ran ${results.length}`);
  if (failed.length) {
    console.error(`FAIL: ${failed.length} of ${EXPECTED} checks (${failed.join(', ')}) - a BC-35/BC-36 production wire is disconnected`);
    process.exit(1);
  }
  console.log(`PASS: all ${EXPECTED} checks`);
})();
