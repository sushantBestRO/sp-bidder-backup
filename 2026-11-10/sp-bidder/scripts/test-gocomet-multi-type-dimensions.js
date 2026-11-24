'use strict';
/**
 * Regression: origin/main ac9611e — Waaree multi-type price links dropped each truck's physical
 * size after parseCargoDescriptor(), so a 40FT rate could be entered against a different 40FT
 * shape. The price form and price_needed WhatsApp ask consequently named only the truck label.
 *
 * The one test follows the real offline path: GoComet parser -> listAuctions() -> price-request
 * snapshot -> price form -> Notifier._priceNeededData() -> renderMessage('price_needed'). It also
 * pins old snapshots, which have no per-type dimensions, to their existing no-size rendering.
 *
 *   node scripts/test-gocomet-multi-type-dimensions.js
 * @requires-summary-line
 */

// The server boot path reads these at require time. Keep all harness state in the permanent
// regression-fixture directory: this test never opens a portal or sends a message.
const fs = require('fs');
const path = require('path');
const runtimeDir = path.join(__dirname, '..', 'docs', 'tests', '2026-10-05_waaree-size-mobile', 'runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_DATA_DIR = runtimeDir;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { cargoTypeList, readLoadSpec } = require('../src/platform/gocometCargo');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { renderPriceForm } = require('../src/web/server');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) pass += 1;
  else { fail += 1; console.error('  FAIL -', message); }
};

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({
  exp: Math.floor(Date.now() / 1000) + 86_400, user_id: 'size-regression', client_id: 'size-regression',
})}.sig`;
const response = (body) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });

const DIM_A = `40'x8'x9'6\"`;
const DIM_B = `40'x8'x8'6\"`;
const TRUCK_GLYPH = '\u{1F69B}';
const SCREENSHOT_DESCRIPTORS = [
  `1 x 40FT (LxWXH - ${DIM_A}) 25 Ton Truck`,
  `1 x 40FT (LxWXH - ${DIM_A}) Truck`,
];
const DIFFERENT_SIZE_DESCRIPTORS = [
  `1 x 40FT (LxWXH - ${DIM_A}) 25 Ton Truck`,
  `1 x 40FT (LxWXH - ${DIM_B}) 25 Ton Truck`,
];
const MISSING_SECOND_SIZE_DESCRIPTORS = [
  `1 x 40FT (LxWXH - ${DIM_A}) 25 Ton Truck`,
  '1 x 40FT 25 Ton Truck',
];

function vehicleLines(message) {
  return message.split('\n').filter((line) => line.startsWith(`${TRUCK_GLYPH} `));
}

function vehicleTileRows(html) {
  const start = html.indexOf('<span class="sl">Vehicle</span>');
  const end = start < 0 ? -1 : html.indexOf('</div>', start);
  return start < 0 || end < 0 ? []
    : [...html.slice(start, end).matchAll(/<span class="trow">([^<]*)<\/span>/g)].map((m) => m[1]);
}

function costInput(html, index) {
  const marker = `id="cost_type_${index}"`;
  const at = html.indexOf(marker);
  const start = at < 0 ? -1 : html.lastIndexOf('<input ', at);
  const end = at < 0 ? -1 : html.indexOf('>', at);
  return start < 0 || end < 0 ? '' : html.slice(start, end + 1);
}

function ariaLabel(html, index) {
  const match = /aria-label="([^"]*)"/.exec(costInput(html, index));
  return match ? match[1] : '';
}

function costRow(html, index) {
  const marker = `id="cost_type_${index}"`;
  const at = html.indexOf(marker);
  const start = at < 0 ? -1 : html.lastIndexOf('<div class="mvtr"', at);
  const end = at < 0 ? -1 : html.indexOf('</div></div>', at);
  return start < 0 || end < 0 ? '' : html.slice(start, end + '</div></div>'.length);
}

async function loadFromGoComet(descriptors) {
  const enquiry = {
    key: 'WAAREE-SIZE-REGRESSION',
    name: 'Waaree full-size regression',
    bidding_closed: false,
    mode: 'FTL',
    client_company_name: 'Waaree Energies Ltd.',
    bid_close_timestamp: new Date(Date.now() + 30 * 60_000).toISOString(),
    quantity: descriptors,
  };
  const detail = { ...enquiry, cargo_quantity: descriptors.length, cargo_unit: 'TRUCK' };
  const adapter = new GoCometAdapter({
    token: validToken(),
    sleep: async () => {},
    fetchImpl: async (url) => String(url).includes('/enquiries/spot')
      ? response({ enquiries: [enquiry], total_pages: 1 })
      : response(detail),
  });
  const loads = await adapter.listAuctions({ maxPages: 1 });
  assert.strictEqual(loads.length, 1, 'fixture must map one GoComet enquiry');
  return loads[0];
}

async function snapshot(load, id) {
  const requests = new PriceRequestStore({ store: new MemoryStore(), marginsPct: [10], minMarginPct: 5 });
  return requests.createForLoad({ ...load, id }, {
    deadlineAt: Date.now() + 25 * 60_000,
    platformKey: 'gocomet',
  });
}

async function should_carry_each_multi_type_dimension_from_gocomet_to_the_price_link_and_whatsapp_ask() {
  // Arrange: captured Waaree descriptors, plus two variants that prove a size belongs to its own
  // type rather than to the load as a whole.
  const parsed = cargoTypeList(SCREENSHOT_DESCRIPTORS);
  const scalarSpec = readLoadSpec({ quantity: SCREENSHOT_DESCRIPTORS }, null);
  const differentSizes = cargoTypeList(DIFFERENT_SIZE_DESCRIPTORS);
  const missingSecondSize = cargoTypeList(MISSING_SECOND_SIZE_DESCRIPTORS);

  // Act: map the portal record, snapshot it for the durable price link, then render both desk
  // surfaces from their production entry points.
  const load = await loadFromGoComet(SCREENSHOT_DESCRIPTORS);
  const request = await snapshot(load, 'WAAREE-SIZE-REGRESSION');
  const priceHtml = renderPriceForm({}, request, {});
  const notifier = new Notifier({ baseUrl: 'http://desk.invalid', log: () => {} });
  const askData = await notifier._priceNeededData(request);
  const whatsapp = renderMessage('price_needed', askData);

  // Assert: parser identity fields stay exact while every individual type keeps its own size.
  ok(parsed && parsed.length === 2, 'the screenshot descriptors remain a two-type list');
  ok(JSON.stringify(parsed.map(({ label, count, match }) => ({ label, count, match }))) === JSON.stringify([
    { label: '40 ft, 25 T', count: 1, match: '40ftlxwxh40x8x9625ton' },
    { label: '40 ft', count: 1, match: '40ftlxwxh40x8x96' },
  ]), 'label, count, and match stay unchanged when dimensions are added');
  ok(JSON.stringify(parsed && parsed.map((type) => type.dimensions)) === JSON.stringify([DIM_A, DIM_A]),
    'cargoTypeList retains the parsed size on each screenshot truck type');
  ok(scalarSpec.dimensions === null, 'the legacy scalar dimensions field remains null for multi-type loads');
  ok(JSON.stringify(differentSizes && differentSizes.map((type) => type.dimensions)) === JSON.stringify([DIM_A, DIM_B]),
    'otherwise-equal types retain their different sizes instead of sharing one load-level value');
  ok(missingSecondSize && missingSecondSize[0].dimensions === DIM_A && missingSecondSize[1].dimensions == null,
    'a missing second size stays absent and never inherits the first type size');

  ok(JSON.stringify(load.cargoTypes && load.cargoTypes.map((type) => type.dimensions)) === JSON.stringify([DIM_A, DIM_A]),
    'GoComet listAuctions carries each parsed size on cargoTypes');
  ok(JSON.stringify(request.load.cargoTypes && request.load.cargoTypes.map((type) => type.dimensions)) === JSON.stringify([DIM_A, DIM_A]),
    'PriceRequestStore snapshots each type size for the durable price link');

  const htmlSize = `40'x8'x9'6&quot;`;
  const htmlSizeB = `40'x8'x8'6&quot;`;
  ok(JSON.stringify(vehicleTileRows(priceHtml)) === JSON.stringify([
    `1 &times; 40 ft, 25 T &middot; Size ${htmlSize}`,
    `1 &times; 40 ft &middot; Size ${htmlSize}`,
  ]), 'each Vehicle tile row visibly names its own full size');
  ok(ariaLabel(priceHtml, 0) === `Your cost per truck for 40 ft, 25 T, size ${htmlSize}`
    && ariaLabel(priceHtml, 1) === `Your cost per truck for 40 ft, size ${htmlSize}`,
  'each screenshot cost input has its exact own size aria label');
  ok(costRow(priceHtml, 0).includes(`Size (L &times; W &times; H): ${htmlSize}`)
    && costRow(priceHtml, 1).includes(`Size (L &times; W &times; H): ${htmlSize}`),
  'each screenshot cost row visibly shows the size beside its own input');

  ok(JSON.stringify(vehicleLines(whatsapp)) === JSON.stringify([
    `${TRUCK_GLYPH} 1 x 40 ft, 25 T . ${DIM_A}`,
    `${TRUCK_GLYPH} 1 x 40 ft . ${DIM_A}`,
  ]), 'both WhatsApp vehicle lines include their own size');

  // Different sizes travel on their own rows and fields, never through a shared load-level value.
  const differentLoad = await loadFromGoComet(DIFFERENT_SIZE_DESCRIPTORS);
  const differentRequest = await snapshot(differentLoad, 'WAAREE-SIZE-DIFFERENT');
  const differentHtml = renderPriceForm({}, differentRequest, {});
  const differentAsk = renderMessage('price_needed', await notifier._priceNeededData(differentRequest));
  ok(JSON.stringify(differentRequest.load.cargoTypes.map((type) => type.dimensions)) === JSON.stringify([DIM_A, DIM_B]),
    'the different-size GoComet snapshot preserves each type dimension');
  ok(JSON.stringify(vehicleTileRows(differentHtml)) === JSON.stringify([
    `1 &times; 40 ft, 25 T &middot; Size ${htmlSize}`,
    `1 &times; 40 ft, 25 T &middot; Size ${htmlSizeB}`,
  ]), 'different sizes stay paired with their own otherwise-equal Vehicle rows');
  ok(ariaLabel(differentHtml, 0) === `Your cost per truck for 40 ft, 25 T, size ${htmlSize}`
    && ariaLabel(differentHtml, 1) === `Your cost per truck for 40 ft, 25 T, size ${htmlSizeB}`,
  'different sizes stay paired with the exact corresponding cost-input aria labels');
  ok(costRow(differentHtml, 0).includes(`Size (L &times; W &times; H): ${htmlSize}`)
    && costRow(differentHtml, 1).includes(`Size (L &times; W &times; H): ${htmlSizeB}`),
  'different sizes stay visible beside their corresponding cost inputs');
  ok(JSON.stringify(vehicleLines(differentAsk)) === JSON.stringify([
    `${TRUCK_GLYPH} 1 x 40 ft, 25 T . ${DIM_A}`,
    `${TRUCK_GLYPH} 1 x 40 ft, 25 T . ${DIM_B}`,
  ]), 'different sizes stay paired with their corresponding WhatsApp lines');

  // One absent size stays absent on its row, input, and message; it cannot borrow a sibling's.
  const missingLoad = await loadFromGoComet(MISSING_SECOND_SIZE_DESCRIPTORS);
  const missingRequest = await snapshot(missingLoad, 'WAAREE-SIZE-MISSING');
  const missingHtml = renderPriceForm({}, missingRequest, {});
  const missingAsk = renderMessage('price_needed', await notifier._priceNeededData(missingRequest));
  ok(JSON.stringify(missingRequest.load.cargoTypes.map((type) => type.dimensions)) === JSON.stringify([DIM_A, undefined]),
    'the missing-size GoComet snapshot does not fill the absent sibling dimension');
  ok(JSON.stringify(vehicleTileRows(missingHtml)) === JSON.stringify([
    `1 &times; 40 ft, 25 T &middot; Size ${htmlSize}`,
    '1 &times; 40 ft, 25 T',
  ]), 'a missing size does not inherit its sibling size in the Vehicle tile');
  ok(ariaLabel(missingHtml, 0) === `Your cost per truck for 40 ft, 25 T, size ${htmlSize}`
    && ariaLabel(missingHtml, 1) === 'Your cost per truck for 40 ft, 25 T',
  'a missing size does not inherit its sibling size in the second cost-input aria label');
  ok(costRow(missingHtml, 0).includes(`Size (L &times; W &times; H): ${htmlSize}`)
    && !costRow(missingHtml, 1).includes('Size (L &times; W &times; H):'),
  'a missing size does not inherit its sibling size beside the second cost input');
  ok(JSON.stringify(vehicleLines(missingAsk)) === JSON.stringify([
    `${TRUCK_GLYPH} 1 x 40 ft, 25 T . ${DIM_A}`,
    `${TRUCK_GLYPH} 1 x 40 ft, 25 T`,
  ]), 'a missing size does not inherit its sibling size in WhatsApp');

  // Arrange + Act + Assert: an old snapshot with no field still reads exactly as it did before.
  const legacy = {
    ...request,
    load: {
      ...request.load,
      dimensions: null,
      cargoTypes: request.load.cargoTypes.map(({ label, count, match }) => ({ label, count, match })),
    },
  };
  const legacyHtml = renderPriceForm({}, legacy, {});
  const legacyAsk = renderMessage('price_needed', await notifier._priceNeededData(legacy));
  ok(!legacyHtml.includes(htmlSize) && !legacyAsk.includes(DIM_A),
    'old snapshots with no per-type dimensions render with no invented size');
  ok(JSON.stringify(vehicleTileRows(legacyHtml)) === JSON.stringify([
    '1 &times; 40 ft, 25 T', '1 &times; 40 ft',
  ]) && JSON.stringify(vehicleLines(legacyAsk)) === JSON.stringify([
    `${TRUCK_GLYPH} 1 x 40 ft, 25 T`, `${TRUCK_GLYPH} 1 x 40 ft`,
  ]),
  'old snapshot WhatsApp vehicle lines stay byte-for-byte in their existing form');

  // A stored, hand-built snapshot is still untrusted display data: dimensions must not inject HTML.
  const hostileDimensions = `40'x8'x9'6\"<script>alert(1)</script>`;
  const hostile = {
    ...request,
    load: {
      ...request.load,
      cargoTypes: [
        { label: '40 ft', count: 1, match: 'hostile-a', dimensions: hostileDimensions },
        { label: '40 ft', count: 1, match: 'hostile-b', dimensions: DIM_B },
      ],
    },
  };
  const hostileHtml = renderPriceForm({}, hostile, {});
  ok(!hostileHtml.includes('<script>alert(1)</script>')
    && hostileHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'),
  'a hand-built snapshot dimension is HTML-escaped on the price form');
}

(async () => {
  await should_carry_each_multi_type_dimension_from_gocomet_to_the_price_link_and_whatsapp_ask();

  // Completion sentinel: scripts/run-tests.js only sees the exit code. A test that returns before
  // its assertions would otherwise look green, so this floor makes early exit a hard failure.
  const EXPECTED_CHECKS = 26;
  ok(pass + fail === EXPECTED_CHECKS - 1,
    `completion sentinel: only ${pass + fail} checks ran, expected ${EXPECTED_CHECKS - 1}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(`${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error('test crashed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
