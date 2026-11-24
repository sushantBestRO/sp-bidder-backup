// Screenshots EVERY state of the server-rendered /price/:token pricing page - the pricing desk's
// only surface - so the rank-driven-rungs UI changes (band-row sub-labels reframed to describe the
// band not a firing sequence, "your prices" count-agnostic copy, and the .brows scroll clamp for a
// long band) can be eyeballed from a real user's perspective, plus the Suyashh walkthrough demo
// rendered as a shareable page.
//
// Run against the local mock dev stack (no login in mock mode):
//   SP_DEMO_SEED=1 npm start            (http://localhost:4103)
// Then:
//   node scripts/ui-price-flow-screenshots.mjs
//
// Output: scripts/ui-price-flow-shots/NN-description.png, numbered in flow order. Uses
// puppeteer-core (a project dependency) against a local Chrome, same pattern as
// scripts/ui-state-flow-screenshots.mjs.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);
const OUT = path.join(__dirname, 'ui-price-flow-shots');
const API = process.env.API_URL || 'http://localhost:4103';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real Chrome <input type=number> does not reliably select-all on triple-click; clear then type.
async function setValue(el, value) {
  await el.evaluate((node) => { node.value = ''; });
  await el.type(String(value));
}
async function robustClick(el, page) {
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await sleep(60);
  await el.click();
}
let shotCount = 0;
async function shot(page, name, { fullPage = true } = {}) {
  shotCount += 1;
  const file = path.join(OUT, `${String(shotCount).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log('  ->', path.basename(file));
}
async function byText(page, tag, text) {
  const handle = await page.evaluateHandle((tag, text) => {
    const els = Array.from(document.querySelectorAll(tag));
    return els.find((el) => el.textContent && el.textContent.trim().includes(text)) || null;
  }, tag, text);
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}

async function priceRequests() {
  const res = await fetch(`${API}/api/price-requests`);
  if (!res.ok) throw new Error(`GET /api/price-requests -> ${res.status}. Is the backend up on ${API} with SP_DEMO_SEED=1?`);
  const data = await res.json();
  return data.requests || [];
}
function segOf(r) { return r.pathSeg || r.publicSeg || (r.token ? r.token : null); }

// Open a fresh mobile page (the desk uses the link on a phone). Tall so fullPage captures all,
// but the viewport height is what the .brows max-height:40vh clamp is measured against.
async function mobilePage(browser) {
  const p = await browser.newPage();
  await p.setViewport({ width: 480, height: 900, deviceScaleFactor: 2 });
  return p;
}

// Render the CLI walkthrough demo as a styled "terminal" HTML page and screenshot it, so the
// Suyashh demo is a shareable visual, captured the same (puppeteer) way as the UI states.
async function shotWalkthrough(browser) {
  console.log('\n[demo] rendering the walkthrough as a page');
  let out;
  try {
    out = execFileSync('node', ['scripts/walkthrough.js'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, LOG_LEVEL: 'warn' } });
  } catch (e) {
    out = (e.stdout || '') + '\n[script exited non-zero]\n' + (e.stderr || '');
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#0b0f14;color:#d7dde3;font:13px/1.5 "Cascadia Code",Consolas,"SF Mono",Menlo,monospace;padding:24px}
    .win{max-width:920px;margin:0 auto;border:1px solid #223;border-radius:10px;overflow:hidden;box-shadow:0 8px 40px #0008}
    .bar{background:#161b22;padding:8px 14px;border-bottom:1px solid #223;color:#8b98a5;font-size:12px}
    .dot{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px;vertical-align:middle}
    pre{margin:0;padding:18px 20px;white-space:pre-wrap;word-break:break-word}
  </style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span>&nbsp; node scripts/walkthrough.js</div><pre>${esc(out)}</pre></div>`;
  const file = path.join(OUT, '_walkthrough.html');
  fs.writeFileSync(file, html);
  const p = await browser.newPage();
  await p.setViewport({ width: 980, height: 1200, deviceScaleFactor: 2 });
  await p.goto('file://' + file.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
  await sleep(200);
  await shot(p, 'demo-walkthrough-full');
  await p.close();
}

(async () => {
  const reqs = await priceRequests();
  console.log('price requests:', reqs.map((r) => `${r.loadId}:${r.status}`).join(', '));
  const awaiting = reqs.find((r) => r.status === 'awaiting_price');
  const armed = reqs.find((r) => r.status === 'armed');
  if (!awaiting && !armed) throw new Error('No awaiting/armed demo loads. Restart backend with SP_DEMO_SEED=1.');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb'],
  });

  // ---- CAPTURE FORM (awaiting_price) ----
  if (awaiting) {
    const seg = segOf(awaiting);
    console.log(`\n[capture] /price/${seg} (${awaiting.loadId}, ${awaiting.load?.companyName}, units ${awaiting.load?.units})`);
    const p = await mobilePage(browser);
    await p.goto(`${API}/price/${seg}`, { waitUntil: 'networkidle2' });
    await sleep(400);
    await shot(p, 'capture-01-initial-band-collapsed');            // "your prices fill in here" bfoot; per-vehicle cost label
    const adjust = await byText(p, 'summary', 'Adjust');
    if (adjust) { await robustClick(adjust, p); await sleep(300); await shot(p, 'capture-02-band-expanded-sublabels'); } // top price / a step / floor
    const cost = await p.$('#cost');
    if (cost) { await setValue(cost, '18000'); await sleep(300); await shot(p, 'capture-03-cost-typed-prices-fill-in'); }
    await p.close();
  }

  // ---- REPRICE FORM (armed) ----
  if (armed) {
    const seg = segOf(armed);
    console.log(`\n[reprice] /price/${seg} (${armed.loadId}, ${armed.load?.companyName})`);
    const p = await mobilePage(browser);
    await p.goto(`${API}/price/${seg}`, { waitUntil: 'networkidle2' });
    await sleep(400);
    await shot(p, 'reprice-04-initial');
    const adjust = await byText(p, 'summary', 'Adjust');
    if (adjust) { await robustClick(adjust, p); await sleep(300); await shot(p, 'reprice-05-band-expanded-sublabels'); }

    // LONG BAND: POST an 8-margin override so the band exceeds .brows max-height:40vh and must
    // scroll (the change that keeps the submit button reachable on a many-rung customer).
    console.log('  posting an 8-margin override to exercise the .brows scroll clamp');
    const body = new URLSearchParams();
    body.set('cost', String(armed.price?.cost || 65000));
    body.set('use_override', '1');
    ['12.6', '11', '9.5', '8', '7', '6', '5', '4'].forEach((m, i) => body.set(`m_${i}`, m));
    try {
      const rr = await fetch(`${API}/price/${seg}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      console.log('  override POST ->', rr.status);
    } catch (e) { console.log('  override POST failed:', e.message); }
    await p.goto(`${API}/price/${seg}`, { waitUntil: 'networkidle2' });
    await sleep(400);
    const adjust2 = await byText(p, 'summary', 'Adjust');
    if (adjust2) { await robustClick(adjust2, p); await sleep(300); }
    await shot(p, 'reprice-06-long-band-scroll-viewport', { fullPage: false }); // viewport shot: shows the 40vh clamp + scrollbar
    await shot(p, 'reprice-07-long-band-full');                                  // fullPage: all 8 rows for reference
    await p.close();
  }

  // ---- DEMO WALKTHROUGH (rendered) ----
  await shotWalkthrough(browser);

  await browser.close();
  console.log(`\nDone - ${shotCount} screenshots in ${OUT}`);
})().catch((e) => { console.error('SCRIPT FAILED:', e); process.exit(1); });
