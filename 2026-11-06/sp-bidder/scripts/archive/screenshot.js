'use strict';
// Drives headless Chrome through the real UI (clicks "Try demo"), captures two
// shots: mid-action and at results. Requires the server running on PORT (4103).
const puppeteer = require('puppeteer-core');
const path = require('path');

const PORT = process.env.PORT || 4103;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(__dirname, '..', '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--force-color-profile=srgb'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1240, height: 1180, deviceScaleFactor: 2 });

  // 1) the connect gate
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'ui-connect.png') });
  console.log('wrote ui-connect.png');

  // 2) enter demo, let auctions reach the active window
  await page.click('#demoBtn');
  await sleep(31_000);
  await page.screenshot({ path: path.join(OUT, 'ui-live.png') });
  console.log('wrote ui-live.png');

  // 3) results (44s + 48s auctions have closed -> wins on the banner)
  await sleep(22_000);
  await page.screenshot({ path: path.join(OUT, 'ui-results.png') });
  console.log('wrote ui-results.png');

  await browser.close();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
