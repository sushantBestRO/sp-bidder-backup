// Screenshots the CONFIG surfaces - where the margin band ("rungs") and bidding behaviour get set:
//   1. Dashboard Settings page (default margin band via MarginBandEditor, cadence, anti-detection)
//   2. Customers page (per-customer margin band profiles - the second place a band is set)
//   3. The /price band re-shot after the automation-terminology sweep ("a mid price" sub-label)
//
// Run against the local mock dev stack:
//   SP_DEMO_SEED=1 npm start              (backend :4103, auth off in mock)
//   cd dashboard && npx vite              (console :4330)
// Then: node scripts/ui-settings-screenshots.mjs
//
// Output: scripts/ui-settings-shots/NN-description.png. Same puppeteer-core pattern as
// scripts/ui-state-flow-screenshots.mjs / ui-price-flow-screenshots.mjs.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'ui-settings-shots');
const DASH = process.env.DASH_URL || 'http://localhost:4330';
const API = process.env.API_URL || 'http://localhost:4103';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function robustClick(el) {
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await sleep(60);
  await el.click();
}
async function waitByText(page, tag, text, timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = await byText(page, tag, text);
    if (el) return el;
    await sleep(150);
  }
  return null;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--window-size=1440,1000'],
  });
  const dash = await browser.newPage();
  await dash.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

  console.log('\n[1] Settings page (full)');
  await dash.goto(DASH, { waitUntil: 'networkidle2' });
  await sleep(600);
  const settingsNav = await waitByText(dash, 'button', 'Settings');
  if (!settingsNav) throw new Error('Settings nav not found - is the dashboard up on :4330?');
  await robustClick(settingsNav);
  await sleep(900);
  await shot(dash, 'settings-full-page');

  console.log('\n[2] Settings: the Default margin band section (where the rungs/anchors are set)');
  const bandHdr = await byText(dash, 'h2, h3, div, span', 'Default margin band');
  if (bandHdr) {
    await bandHdr.evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await sleep(300);
    await shot(dash, 'settings-default-margin-band', { fullPage: false });
  } else {
    console.log('  (Default margin band header not found)');
  }

  console.log('\n[3] Settings: anti-detection block (expanded if collapsed)');
  const adHdr = await byText(dash, 'h2, h3, div, span, summary, button', 'Human-like');
  if (adHdr) {
    await adHdr.evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await sleep(300);
    await shot(dash, 'settings-anti-detection', { fullPage: false });
  }

  console.log('\n[4] Customers page (per-customer margin band profiles)');
  const custNav = await waitByText(dash, 'button', 'Customers');
  if (custNav) {
    await robustClick(custNav);
    await sleep(900);
    await shot(dash, 'customers-overview');
    // open the first customer's band editor if a row/edit affordance exists
    const editBtn = await byText(dash, 'button', 'Edit');
    if (editBtn) {
      await robustClick(editBtn);
      await sleep(500);
      await shot(dash, 'customers-margin-band-editor');
      await dash.keyboard.press('Escape');
      await sleep(200);
    } else {
      console.log('  (no Edit button visible - profile editor may open differently)');
    }
  }

  console.log('\n[5] /price band re-shot (post terminology sweep: "a mid price", no automation wording)');
  const reqs = await fetch(`${API}/api/price-requests`).then((r) => r.json()).then((d) => d.requests || []);
  const awaiting = reqs.find((r) => r.status === 'awaiting_price');
  if (awaiting) {
    const seg = awaiting.pathSeg || awaiting.publicSeg;
    const p = await browser.newPage();
    await p.setViewport({ width: 480, height: 900, deviceScaleFactor: 2 });
    await p.goto(`${API}/price/${seg}`, { waitUntil: 'networkidle2' });
    await sleep(400);
    const adjust = await byText(p, 'summary', 'Adjust');
    if (adjust) { await robustClick(adjust); await sleep(300); }
    await shot(p, 'price-band-expanded-new-sublabels');
    await p.close();
  } else {
    console.log('  (no awaiting_price load - restart backend with SP_DEMO_SEED=1)');
  }

  await browser.close();
  console.log(`\nDone - ${shotCount} screenshots in ${OUT}`);
})().catch((e) => { console.error('SCRIPT FAILED:', e); process.exit(1); });
