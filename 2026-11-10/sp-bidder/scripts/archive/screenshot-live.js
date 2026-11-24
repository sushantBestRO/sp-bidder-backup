'use strict';
// Drives the BidPilot UI through the real "Connect account" flow (pastes the
// token, read-only) and screenshots the live SuperProcure loads.
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 4103;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const COOKIE_FILE = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
const OUT = path.join(__dirname, '..', '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function token() { for (const l of fs.readFileSync(COOKIE_FILE, 'utf8').split(/\r?\n/)) { if (l.startsWith('#') || !l.trim()) continue; const p = l.split('\t'); if (p[5] === 'token') return p[6]; } }

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--force-color-profile=srgb'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 1180, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.type('#tokenInput', token());
  await page.click('#connectBtn');
  await sleep(6000); // connect + listAuctions
  await page.screenshot({ path: path.join(OUT, 'ui-live-real.png'), fullPage: true });
  console.log('wrote ui-live-real.png');
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
