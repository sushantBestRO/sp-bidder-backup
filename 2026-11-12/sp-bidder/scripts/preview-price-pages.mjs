// Visual preview harness for every /price page state a pricing operator can land on, under the
// "accept late bids to the real close" model: deadlineAt is an advisory danger line (form stays
// open, red "best-effort, may not land" banner), and the only wall is the auction actually closing.
//
// Boots the bidder in MOCK mode (memory store, no WhatsApp, isolated port, discovery stopped so
// nothing expires mid-run), seeds each state, and screenshots every path with real headless Chrome
// driving the real routes.  Run:  node scripts/preview-price-pages.mjs
// Screenshots land in docs/reviews/superprocure-bidder/reprice-cutoff/screenshots/.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const PORT = process.env.PREVIEW_PORT || '4399';
process.env.PORT = PORT;
process.env.HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_BASE_URL = `http://127.0.0.1:${PORT}`;
delete process.env.PLATFORM;            // -> mock adapter
delete process.env.SP_ADMIN_PASS_HASH;  // -> auth off (mock)

const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
if (!CHROME) { console.error('No Chrome/Edge binary found - set CHROME_PATH or PUPPETEER_EXECUTABLE_PATH'); process.exit(1); }

const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'docs', 'reviews', 'superprocure-bidder', 'reprice-cutoff', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const server = require(path.join(ROOT, 'src', 'web', 'server.js'));
const { COLLECTION } = require(path.join(ROOT, 'src', 'pricing', 'priceRequests.js'));
const puppeteer = require('puppeteer-core');
const { requests, boot, stacks } = server;

const COST = 46500;
const BAND = [12, 9, 6.3];

function mkLoad(id, { closesInMs = 30 * 60_000 } = {}) {
  return {
    id, lane: { origin: 'Bhiwandi', destination: 'Nagpur' }, equipment: '32ft SXL', units: 1,
    weight: 21, weightUnit: 'MT', productName: 'Steel coils', distanceKm: 705,
    companyName: 'Havells India', closesAt: Date.now() + closesInMs, startsAt: Date.now() - 60_000,
    status: 'live', softClose: false,
    points: [
      { kind: 'pickup', address: 'Plot 14, MIDC Bhiwandi, Thane 421302' },
      { kind: 'drop', address: 'Warehouse 7, MIHAN SEZ, Nagpur 441108' },
    ],
  };
}
async function awaiting(id, { closesInMs } = {}) { return requests.createForLoad(mkLoad(id, { closesInMs })); }
async function armed(id, { closesInMs } = {}) {
  const r = await awaiting(id, { closesInMs });
  await requests.setBidOverride(r.id, { marginsPct: BAND, minMarginPct: BAND[BAND.length - 1] }, { setBy: 'operator' }).catch(() => {});
  await requests.capture(r.id, { cost: COST });
  return r;
}
// danger zone: only the advisory deadline is past; the auction is still open (a late bid is accepted)
async function pastDeadline(id) { await requests.store.patchDoc(COLLECTION, id, { deadlineAt: Date.now() - 5_000 }); }
// the auction has actually closed on the portal (the only hard stop)
async function closeAuction(id) {
  const d = await requests.getByToken(id);
  await requests.store.patchDoc(COLLECTION, id, { load: { ...(d.load || {}), closesAt: Date.now() - 60_000 }, deadlineAt: Date.now() - 95_000 });
}

const results = [];
async function shot(page, name, note) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  results.push({ name, note });
  console.log(`  shot  ${name}  (${note})`);
}
async function gotoForm(page, id) { await page.goto(`${BASE}/price/${id}`, { waitUntil: 'networkidle0', timeout: 15_000 }); }
async function waitClass(page, cls) {
  await page.waitForFunction((c) => {
    const el = document.getElementById('closewarn');
    return el && el.className.indexOf(c) !== -1;
  }, { timeout: 20_000, polling: 100 }, cls);
}
async function postForm(page, id, bodyObj) {
  const res = await page.evaluate(async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    return { status: r.status, html: await r.text() };
  }, `${BASE}/price/${id}`, new URLSearchParams(bodyObj).toString());
  await page.setContent(res.html, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 250));
  return res.status;
}

(async () => {
  await boot();
  for (const s of stacks) { try { s.discovery && s.discovery.stop && s.discovery.stop(); } catch (_) {} }
  console.log(`[preview] booted mock server on ${BASE}`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 2 }); // operators open these on a phone

  // ---------------- CAPTURE (first cost, status awaiting_price) ----------------
  const cLive = await awaiting('CAP-LIVE', { closesInMs: 30 * 60_000 });
  await gotoForm(page, cLive.id);
  await shot(page, 'capture-1-live', 'capture form, comfortable time to close');

  const cDanger = await awaiting('CAP-DANGER', { closesInMs: 45_000 }); await pastDeadline(cDanger.id);
  await gotoForm(page, cDanger.id);
  await waitClass(page, 'red');
  await shot(page, 'capture-2-danger', 'DANGER ZONE: form stays OPEN, red "best-effort, may not land" banner');

  const cDangerR = await awaiting('CAP-DANGER-RCPT', { closesInMs: 45_000 }); await pastDeadline(cDangerR.id);
  await postForm(page, cDangerR.id, { cost: COST });
  await shot(page, 'capture-3-danger-receipt', 'POST a cost in the danger zone -> "Cost recorded - armed, may not get a bid in"');

  const cOk = await awaiting('CAP-OK', { closesInMs: 30 * 60_000 });
  await postForm(page, cOk.id, { cost: COST });
  await shot(page, 'capture-4-saved', 'POST a cost comfortably -> "Cost saved"');

  const cClosed = await awaiting('CAP-CLOSED', { closesInMs: 20 * 60_000 }); await closeAuction(cClosed.id);
  await gotoForm(page, cClosed.id);
  await shot(page, 'capture-5-auction-closed', 'GET after the auction closed -> "This auction has closed"');

  // ---------------- RE-PRICE (armed) ----------------
  const rLive = await armed('REP-LIVE', { closesInMs: 30 * 60_000 });
  await gotoForm(page, rLive.id);
  await shot(page, 'reprice-1-live', 're-price form, comfortable time to close');

  const rDanger = await armed('REP-DANGER', { closesInMs: 45_000 }); await pastDeadline(rDanger.id);
  await gotoForm(page, rDanger.id);
  await waitClass(page, 'red');
  await shot(page, 'reprice-2-danger', 'DANGER ZONE: re-price form open, red "best-effort" banner');

  const rDangerR = await armed('REP-DANGER-RCPT', { closesInMs: 45_000 }); await pastDeadline(rDangerR.id);
  await postForm(page, rDangerR.id, { m_0: BAND[0], m_1: BAND[1], m_2: BAND[2], cost: COST });
  await shot(page, 'reprice-3-danger-receipt', 'POST a re-price in the danger zone -> "Saved and armed, may not get a bid in"');

  const rClosed = await armed('REP-CLOSED', { closesInMs: 20 * 60_000 }); await closeAuction(rClosed.id);
  const stC = await postForm(page, rClosed.id, { m_0: BAND[0], m_1: BAND[1], m_2: BAND[2], cost: COST });
  await shot(page, 'reprice-4-auction-closed', `POST a re-price after close -> ${stC} "This auction has closed"`);

  await browser.close();
  console.log(`\n[preview] ${results.length} screenshots -> ${OUT}`);
  for (const r of results) console.log(`  - ${r.name}.png : ${r.note}`);
  process.exit(0);
})().catch((e) => { console.error('\n[preview] FAILED:', e && e.stack || e); process.exit(1); });
