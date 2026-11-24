// Visual evidence for the multi-truck-type GoComet build (Tier 1): what the desk sees on a load
// that carries more than one truck type, and that a single-type load is untouched.
//
// Boots the bidder in MOCK mode (memory store, no WhatsApp, isolated port, discovery stopped) with
// a REAL GoCometAdapter registered as a stack, so the price page reads GoComet's own capabilities
// (partialVehicleCountSupported:false, multiCargoBidSupported:true) rather than the simulator's.
// Every load is built by running the real adapter's listAuctions over enquiry payloads shaped on
// scripts/fixtures/gocomet/ - so cargoTypes, equipment and units come out of the shipped parser,
// not out of a hand-written object.  Run:  node scripts/preview-multi-truck-type.mjs
// Screenshots + the WhatsApp ask text land in docs/screenshots/2026-08-20_multi-truck-type/.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PORT = process.env.PREVIEW_PORT || '4397';
process.env.PORT = PORT;
process.env.HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_BASE_URL = `http://127.0.0.1:${PORT}`;
// Its own scratch data dir: the harness arms real price requests, and without this it writes
// intents and auth marks into the working tree it was run from.
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-preview-'));
delete process.env.PLATFORM;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!CHROME) { console.error('No Chrome/Edge binary found - set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH'); process.exit(1); }

const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'docs', 'screenshots', '2026-08-20_multi-truck-type');
fs.mkdirSync(OUT, { recursive: true });

const server = require(path.join(ROOT, 'src', 'web', 'server.js'));
const { GoCometAdapter } = require(path.join(ROOT, 'src', 'platform', 'gocometAdapter.js'));
const { renderMessage } = require(path.join(ROOT, 'src', 'notify', 'waTemplates.js'));
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
const { requests, boot, stacks, notifier } = server;

const FIX = path.join(HERE, 'fixtures', 'gocomet');
const BASE_LIST = JSON.parse(fs.readFileSync(path.join(FIX, 'spot-enquiries.list.json'), 'utf8'));
const BASE_DETAIL = JSON.parse(fs.readFileSync(path.join(FIX, 'enquiry-detail.json'), 'utf8'));

const GC_ACCOUNT = 'gocomet-primary';
const CLOSES_IN_MS = 25 * 60_000;
const RATE = 63780; // per truck; the rate on the captured asymmetric quote (63780 x 5 + 42520 x 1)
// Per-truck-type costs for the asymmetric load, deliberately far apart - a 40 ft 25 T and a 20 ft
// ODC 10 T are not worth the same per truck, which is the whole reason the form asks twice.
const TYPE_COSTS = [58000, 39000];

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

/**
 * One enquiry, run through the REAL adapter so equipment/cargoTypes/units are parser output.
 * `descriptors` is GoComet's own `quantity` array - one entry per truck type, carrying its count.
 */
async function mappedLoad({ key, descriptors, totalTrucks, origin, destination, originZip, destinationZip, distanceKm, ref }) {
  const now = Date.now();
  const closeIso = new Date(now + CLOSES_IN_MS).toISOString();
  const zips = { origin_zip_code: originZip, destination_zip_code: destinationZip };
  const item = {
    ...BASE_LIST.enquiries[0],
    key, name: ref, quantity: descriptors, origin, destination, ...zips,
    bid_close_timestamp: closeIso, bid_close_time: closeIso,
  };
  const detail = {
    ...BASE_DETAIL,
    key, name: ref, quantity: descriptors, origin, destination, ...zips,
    cargo_quantity: totalTrucks, cargo_unit: 'TRUCK',
    // Per-unit declared weights, one per descriptor. readLoadSpec refuses to collapse several into
    // one Weight tile, so a multi-type load carries none - shown as it really is, not faked.
    gross_weight: descriptors.map((d) => `${d} 25000.0 KG`),
    bid_close_timestamp: closeIso, bid_close_time: closeIso,
    current_server_time: new Date(now).toISOString(),
    custom_columns: BASE_DETAIL.custom_columns.map((c) => (
      /^distance_in_km(?:_|$)/.test(c.key) ? { ...c, value: String(distanceKm) } : c)),
  };
  const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(now / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
  const a = new GoCometAdapter({
    token, sleep: async () => {}, now: () => now,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes(`/enquiries/${key}/bidding-data`)) return resp(404, { error: 'n/a' });
      if (u.includes(`/enquiries/${key}`)) return resp(200, detail);
      if (u.includes('/enquiries/spot')) return resp(200, { ...BASE_LIST, enquiries: [item] });
      return resp(404, { error: 'no_route' });
    },
  });
  const [l] = await a.listAuctions({ maxPages: 1 });
  if (!l) throw new Error(`adapter mapped no load for ${key}`);
  return l;
}

function pushGoCometStack() {
  const adapter = new GoCometAdapter({ token: null, bidEnabled: true });
  const stack = {
    account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    tag: { accountId: GC_ACCOUNT, label: 'GoComet' },
    platformKey: 'gocomet',
    adapter,
    engine: { caps: adapter.capabilities(), snapshot: () => [], planPreview: () => ({ ladder: [], floor: 0, rungCount: 0 }) },
  };
  const at = stacks.findIndex((s) => s.account && s.account.accountId === GC_ACCOUNT);
  if (at >= 0) stacks[at] = stack; else stacks.push(stack);
}

const results = [];
async function shot(page, name, note) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  results.push({ name, note });
  console.log(`  shot  ${name}.png  (${note})`);
}

(async () => {
  await boot();
  for (const s of stacks) { try { s.discovery && s.discovery.stop && s.discovery.stop(); } catch (_) {} }
  pushGoCometStack();
  console.log(`[preview] booted mock server + GoComet stack on ${BASE}`);

  const MANESAR_PUNE = {
    origin: 'Plot 42, Sector 8, IMT Manesar, Gurugram-122051, Haryana',
    destination: 'Survey No 118, Chakan MIDC Phase II, Taluka Khed, Pune-410501, Maharashtra',
    originZip: '122051', destinationZip: '410501', distanceKm: 1428,
  };

  const asym = await mappedLoad({
    key: '260807SXV9', ref: '3262511465-5601270693 (E.com)', totalTrucks: 6, ...MANESAR_PUNE,
    descriptors: ['5 x 40FT (LxWXH  40\'x8\'x9\'6") 25 Ton Truck', '1 x 20FTODC (LxWXH  20\'x8\'x8\'6") 10 Ton Truck'],
  });
  const equal = await mappedLoad({
    key: '260817Q9LG', ref: '3262518841-5601279044 (E.com)', totalTrucks: 10,
    origin: 'Survey No. 1934, NH-48, Village Degam, Taluka Chikhli, Degam-396530, Gujarat',
    destination: 'Plot B-17, Mundra Port SEZ, Mundra, Kutch-370421, Gujarat',
    originZip: '396530', destinationZip: '370421', distanceKm: 412,
    descriptors: ['5 x 40FT (LxWXH  40\'x8\'x9\'6") 25 Ton Truck', '5 x 40FTHB (LxWXH  40\'x8\'x9\'6") 25 Ton Truck'],
  });
  const single = await mappedLoad({
    key: '2608125T8R', ref: '3262512207-5601271882 (E.com)', totalTrucks: 6, ...MANESAR_PUNE,
    descriptors: ['6 x 40FT (LxWXH  40\'x8\'x9\'6") 25 Ton Truck'],
  });

  for (const [tag, l] of [['asym', asym], ['equal', equal], ['single', single]]) {
    console.log(`  mapped ${tag}: equipment=${JSON.stringify(l.equipment)} units=${l.units} cargoLines=${l.cargoLines} cargoTypes=${JSON.stringify(l.cargoTypes || null)}`);
  }

  const seed = async (l) => requests.createForLoad(
    { ...l, startsAt: Date.now() - 60_000, status: 'live', account: { accountId: GC_ACCOUNT, label: 'GoComet' } },
    { deadlineAt: Date.now() + CLOSES_IN_MS - 90_000, platformKey: 'gocomet' },
  );
  const rAsym = await seed(asym);
  const rEqual = await seed(equal);
  const rSingle = await seed(single);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 900, deviceScaleFactor: 2 }); // the link is opened off WhatsApp, on a phone

  const gotoForm = async (id) => {
    await page.goto(`${BASE}/price/${id}`, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.waitForSelector('#cost', { timeout: 10000 });
  };
  // On a multi-type load #cost is a hidden blended figure, so the visible entry point is the first
  // per-type rate box. Waiting on it is what proves the per-type form actually rendered.
  const gotoTypeForm = async (id) => {
    await gotoForm(id);
    await page.waitForSelector('#cost_type_0', { timeout: 10000 });
  };

  await gotoTypeForm(rAsym.id);
  await shot(page, '01-multi-type-unequal-counts', '5 x 40 ft + 1 x 20 ft ODC, no rate typed yet');

  // The same page with a rate in the box. The running total is computed by the page's own
  // footer()/mvSum() hook, so typing is the only honest way to make it appear.
  for (let i = 0; i < TYPE_COSTS.length; i++) {
    await page.click(`#cost_type_${i}`);
    await page.type(`#cost_type_${i}`, String(TYPE_COSTS[i]), { delay: 30 });
  }
  await page.waitForFunction(() => {
    const el = document.getElementById('mvTotal');
    return el && el.textContent.trim().length > 0;
  }, { timeout: 10000, polling: 100 });
  const totalLine = await page.$eval('#mvTotal', (el) => el.textContent.trim());
  const blended = await page.$eval('#cost', (el) => el.value);
  await shot(page, '02-multi-type-unequal-with-rate', `${TYPE_COSTS.join(' / ')} typed -> whole load ${totalLine}, blended cost ${blended}`);

  await gotoTypeForm(rEqual.id);
  await shot(page, '03-multi-type-equal-counts', '5 x 40 ft + 5 x 40 ft HB, the 10-truck Waaree shape');

  await gotoForm(rSingle.id);
  await shot(page, '04-single-type-unchanged', 'one truck type, 6 trucks - no type block, no running total');

  // --- the WhatsApp ask, rendered through the shipped template ---------------------------------
  const askFor = async (r) => {
    const doc = await requests.getByToken(r.id);
    return renderMessage('price_needed', await notifier._priceNeededData(doc));
  };
  const asks = [
    ['MULTI-TYPE, UNEQUAL COUNTS (5 x 40 ft + 1 x 20 ft ODC)', await askFor(rAsym)],
    ['MULTI-TYPE, EQUAL COUNTS (5 x 40 ft + 5 x 40 ft HB)', await askFor(rEqual)],
    ['SINGLE TYPE (6 x 40 ft) - unchanged control', await askFor(rSingle)],
  ];
  fs.writeFileSync(path.join(OUT, '05-whatsapp-ask.txt'),
    asks.map(([h, b]) => `===== ${h} =====\n\n${b}\n`).join('\n\n'), 'utf8');
  console.log('  text  05-whatsapp-ask.txt');

  await browser.close();
  console.log(`\n[preview] ${results.length} screenshots + 1 text file -> ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error('\n[preview] FAILED:', (e && e.stack) || e); process.exit(1); });
