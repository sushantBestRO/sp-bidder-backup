// Drives the Bid Command dashboard + the /price/:token re-price page through every state
// this session touched, screenshotting each one. Run against the local mock dev stack:
//   backend:   SP_DEMO_SEED=1 npm start        (http://localhost:4103)
//   dashboard: cd dashboard && npm run dev     (http://localhost:4330)
// Then:
//   node scripts/ui-state-flow-screenshots.mjs
//
// Output: scripts/ui-audit-screenshots/NN-description.png, numbered in flow order so they
// can be read start to finish. Uses puppeteer-core (already a project dependency) against a
// local Chrome install, same pattern as scripts/archive/screenshot-live.js.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'ui-audit-screenshots');
const DASH = process.env.DASH_URL || 'http://localhost:4330';
const API = process.env.API_URL || 'http://localhost:4103';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// click({clickCount:3}) does not reliably select-all in a real Chrome <input type=number> -
// typed text can insert mid-string instead of replacing it (e.g. "15" into "12.6" becomes
// "1152.6"). Clear the value directly first, then type.
async function setValue(el, value) {
  await el.evaluate((node) => { node.value = ''; });
  await el.type(value);
}
// Scroll into view first in case the page grew taller after an earlier step (e.g. expanding
// the band editor) and the element ended up below the viewport fold. Then use Puppeteer's
// built-in el.click() (real mouse events at the element's bounding box) rather than a
// programmatic node.click() - Radix (dropdown menus etc.) listens for pointer events, so a
// synthetic DOM .click() silently no-ops on it even though it works fine on plain buttons.
async function robustClick(el) {
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await sleep(50);
  await el.click();
}

let shotCount = 0;
async function shot(page, name) {
  shotCount += 1;
  const file = path.join(OUT, `${String(shotCount).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('  ->', path.basename(file));
}

// Find an element by tag + exact-ish text content (dashboard has no test-ids, so this is the
// robust way to click "the button that says Stop" etc. without depending on class names).
async function byText(page, tag, text, root) {
  const handle = await (root || page).evaluateHandle(
    (tag, text) => {
      const els = Array.from(document.querySelectorAll(tag));
      return els.find((el) => el.textContent && el.textContent.trim().includes(text)) || null;
    },
    tag,
    text,
  );
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}
async function waitByText(page, tag, text, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = await byText(page, tag, text);
    if (el) return el;
    await sleep(150);
  }
  return null;
}
// Row containing a given text anywhere inside it (for "the row with lane Bhiwandi -> Bawal").
async function rowWithText(page, text) {
  return byText(page, 'tr', text);
}

async function seedFreshDemoData() {
  // Re-seeding requires a backend restart (SP_DEMO_SEED only seeds on boot) - this script
  // assumes the backend was already started fresh with SP_DEMO_SEED=1 right before running it
  // (see the header comment). It just verifies the expected demo loads are present.
  const res = await fetch(`${API}/api/price-requests`);
  const data = await res.json();
  const byLoad = Object.fromEntries((data.requests || []).map((r) => [r.loadId, r]));
  return byLoad;
}

(async () => {
  const reqs = await seedFreshDemoData();
  console.log('Seeded price requests:', Object.keys(reqs));
  const armedLoad = Object.values(reqs).find((r) => r.status === 'armed' && r.loadId !== 'DEMO-PR-1');
  const awaitingLoad = Object.values(reqs).find((r) => r.status === 'awaiting_price');
  if (!armedLoad) throw new Error('No armed demo load found - restart the backend with SP_DEMO_SEED=1 first.');
  console.log('Using armed load:', armedLoad.loadId, 'lane', armedLoad.load.lane);
  if (awaitingLoad) console.log('Using awaiting load:', awaitingLoad.loadId);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--window-size=1440,1000'],
  });

  const dash = await browser.newPage();
  await dash.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

  console.log('\n[1] Dashboard loads');
  await dash.goto(DASH, { waitUntil: 'networkidle2' });
  await sleep(500);
  await shot(dash, 'dashboard-home');

  console.log('\n[2] Price Requests page');
  const prNav = await waitByText(dash, 'button', 'Price Requests');
  await robustClick(prNav);
  await sleep(700);
  await shot(dash, 'price-requests-overview');

  console.log('\n[3] Price Requests: three-dot menu on an awaiting_price row');
  if (awaitingLoad) {
    // three-dot trigger has no text - find it via aria-label instead
    const dotBtn = await dash.evaluateHandle((loadId) => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
      if (!row) return null;
      return row.querySelector('button[aria-label="More actions"]');
    }, awaitingLoad.loadId);
    const dotEl = dotBtn.asElement();
    if (dotEl) {
      await robustClick(dotEl);
      await sleep(300);
      await shot(dash, 'price-requests-dropdown-awaiting');
      await dash.keyboard.press('Escape');
      await sleep(200);
    } else {
      console.log('  (no three-dot found on awaiting row - skipping)');
    }
  }

  console.log('\n[4] Live Bids page');
  const lbNav = await waitByText(dash, 'button', 'Live Bids');
  await robustClick(lbNav);
  await sleep(700);
  await shot(dash, 'live-bids-overview');

  console.log('\n[5] Live Bids: scroll to show the sticky Action column stays pinned');
  await dash.evaluate(() => {
    const scroller = document.querySelector('.overflow-x-auto');
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  });
  await sleep(300);
  await shot(dash, 'live-bids-scrolled-sticky-action-column');
  await dash.evaluate(() => {
    const scroller = document.querySelector('.overflow-x-auto');
    if (scroller) scroller.scrollLeft = 0;
  });
  await sleep(200);

  console.log('\n[6] Live Bids: Copy link confirmation state');
  const armedRow = await rowWithText(dash, armedLoad.loadId);
  if (armedRow) {
    const copyBtn = await dash.evaluateHandle((loadId) => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
      if (!row) return null;
      return row.querySelector('button[aria-label="Copy link"]');
    }, armedLoad.loadId);
    const copyEl = copyBtn.asElement();
    if (copyEl) {
      await robustClick(copyEl);
      await sleep(150);
      await shot(dash, 'live-bids-copy-link-copied');
      await sleep(1300); // let the "Copied" state clear
    }
  }

  console.log('\n[7] Re-price: click opens a NEW TAB');
  const pagesBefore = (await browser.pages()).length;
  const repriceBtn = await dash.evaluateHandle((loadId) => {
    const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
    if (!row) return null;
    return Array.from(row.querySelectorAll('a')).find((a) => a.textContent.includes('Re-price'));
  }, armedLoad.loadId);
  const repriceEl = repriceBtn.asElement();
  if (!repriceEl) throw new Error('Could not find the Re-price link on the armed row.');
  await robustClick(repriceEl);
  await sleep(800);
  const pagesAfter = await browser.pages();
  const reprice = pagesAfter[pagesAfter.length - 1];
  // Generously tall viewport: the band editor + Rs-mirror values + toast can push real content
  // height well past a phone's visible area. fullPage screenshots capture everything regardless,
  // but a short viewport made earlier clicks land outside document.elementFromPoint's range and
  // silently miss - robustClick's scrollIntoView covers this too, but a taller viewport avoids
  // needing to lean on that as the only safety net.
  await reprice.setViewport({ width: 480, height: 1400, deviceScaleFactor: 2 });
  await reprice.bringToFront();
  await sleep(400);
  await shot(reprice, 'reprice-form-initial');
  console.log('  new tab opened:', pagesAfter.length > pagesBefore ? 'YES' : 'NO (bug)');

  console.log('\n[8] Re-price: expand the band editor');
  const adjust = await waitByText(reprice, 'summary', 'Adjust');
  if (adjust) { await robustClick(adjust); await sleep(300); await shot(reprice, 'reprice-form-band-expanded'); }

  console.log('\n[9] Re-price: edit margin only, submit -> toast wording check');
  const firstPct = await reprice.$('.mpct');
  if (firstPct) {
    await setValue(firstPct, '15');
    await sleep(200);
    await shot(reprice, 'reprice-form-margin-edited-before-submit');
    const mainSubmit = await reprice.$('#mainForm button[type=submit]');
    if (mainSubmit) {
      await robustClick(mainSubmit);
      await sleep(200);
      await shot(reprice, 'reprice-form-saving-state');
      await sleep(700);
      await shot(reprice, 'reprice-toast-margin-only');
      await sleep(3800); // let the toast auto-dismiss
      await shot(reprice, 'reprice-toast-dismissed');
    }
  }

  console.log('\n[10] Re-price: edit cost only, submit -> toast wording check');
  const costInput = await reprice.$('#cost');
  if (costInput) {
    await setValue(costInput, '72000');
    await sleep(200);
    const mainSubmit2 = await reprice.$('#mainForm button[type=submit]');
    if (mainSubmit2) {
      await robustClick(mainSubmit2);
      await sleep(900);
      await shot(reprice, 'reprice-toast-cost-only');
      await sleep(3800);
    }
  }

  console.log('\n[11] Re-price: edit BOTH cost and margin, submit -> toast wording check');
  if (costInput) await setValue(costInput, '68000');
  const pctInputs = await reprice.$$('.mpct');
  if (pctInputs[1]) await setValue(pctInputs[1], '9');
  await sleep(200);
  const mainSubmit3 = await reprice.$('#mainForm button[type=submit]');
  if (mainSubmit3) {
    await robustClick(mainSubmit3);
    await sleep(900);
    await shot(reprice, 'reprice-toast-cost-and-margin');
    await sleep(3800);
  }

  console.log('\n[12] Re-price: revert to inherited band');
  const revertBtn = await reprice.$('#revertForm button[type=submit]');
  if (revertBtn) {
    const visible = await reprice.evaluate((el) => el.offsetParent !== null, revertBtn);
    if (visible) {
      await robustClick(revertBtn);
      await sleep(900);
      await shot(reprice, 'reprice-toast-reverted');
      await sleep(3800);
    } else {
      console.log('  (revert button present but hidden - marginSource was not "bid" at this point)');
    }
  }

  console.log('\n[13] Re-price: invalid cost -> error toast');
  if (costInput) {
    await setValue(costInput, '0');
    const mainSubmit4 = await reprice.$('#mainForm button[type=submit]');
    if (mainSubmit4) {
      await robustClick(mainSubmit4);
      await sleep(900);
      await shot(reprice, 'reprice-toast-error-invalid-cost');
      await sleep(3800);
    }
    // restore a valid cost so later steps aren't left in a broken state - deliberately NOT
    // submitted, this load moves on to the Stop/Re-arm steps next either way
    await setValue(costInput, '65000');
  }

  await reprice.close();
  await dash.bringToFront();

  console.log('\n[14] Live Bids: Stop -> confirmation state -> row moves to Price Requests');
  const stopBtn = await dash.evaluateHandle((loadId) => {
    const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
    if (!row) return null;
    return Array.from(row.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Stop' || b.textContent.includes('Stop'));
  }, armedLoad.loadId);
  const stopEl = stopBtn.asElement();
  if (stopEl) {
    await robustClick(stopEl);
    await sleep(150);
    await shot(dash, 'live-bids-stop-confirmation-state');
    await sleep(1200);
    await shot(dash, 'live-bids-after-stop');
  }

  console.log('\n[15] Price Requests: stopped row (Re-arm + three-dot with Copy link)');
  await robustClick(prNav);
  await sleep(900);
  await shot(dash, 'price-requests-stopped-row');

  const stoppedRow = await rowWithText(dash, armedLoad.loadId);
  if (stoppedRow) {
    const dotBtn2 = await dash.evaluateHandle((loadId) => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
      if (!row) return null;
      return row.querySelector('button[aria-label="More actions"]');
    }, armedLoad.loadId);
    const dotEl2 = dotBtn2.asElement();
    if (dotEl2) {
      await robustClick(dotEl2);
      await sleep(300);
      await shot(dash, 'price-requests-stopped-dropdown-copy-link');
      await dash.keyboard.press('Escape');
      await sleep(200);
    } else {
      console.log('  BUG CHECK: no three-dot on the stopped row (Copy link missing)');
    }
  }

  console.log('\n[16] Price Requests: Re-arm -> confirmation state -> row moves to Live Bids');
  const rearmBtn = await dash.evaluateHandle((loadId) => {
    const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
    if (!row) return null;
    return Array.from(row.querySelectorAll('button')).find((b) => b.textContent.includes('Re-arm'));
  }, armedLoad.loadId);
  const rearmEl = rearmBtn.asElement();
  if (rearmEl) {
    await robustClick(rearmEl);
    await sleep(150);
    await shot(dash, 'price-requests-rearm-confirmation-state');
    await sleep(1200);
    await shot(dash, 'price-requests-after-rearm');
  }

  console.log('\n[17] Live Bids: confirm the row is back');
  await robustClick(lbNav);
  await sleep(900);
  await shot(dash, 'live-bids-after-rearm-confirmed');

  if (awaitingLoad) {
    console.log('\n[18] Price Requests: Dismiss an awaiting row');
    await robustClick(prNav);
    await sleep(700);
    const dotBtn3 = await dash.evaluateHandle((loadId) => {
      const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
      if (!row) return null;
      return row.querySelector('button[aria-label="More actions"]');
    }, awaitingLoad.loadId);
    const dotEl3 = dotBtn3.asElement();
    if (dotEl3) {
      await robustClick(dotEl3);
      await sleep(300);
      const dismissBtn = await waitByText(dash, 'div[role="menuitem"]', 'Dismiss', 1500);
      if (dismissBtn) {
        await robustClick(dismissBtn);
        await sleep(900);
        await shot(dash, 'price-requests-dismissed-row');

        const dotBtn4 = await dash.evaluateHandle((loadId) => {
          const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(loadId));
          if (!row) return null;
          return row.querySelector('button[aria-label="More actions"]');
        }, awaitingLoad.loadId);
        const dotEl4 = dotBtn4.asElement();
        if (dotEl4) {
          await robustClick(dotEl4);
          await sleep(300);
          await shot(dash, 'price-requests-dismissed-dropdown-restore');
          // Actually click Restore (rather than just Escape) so the row goes back to
          // awaiting_price - both proves Restore really works, and leaves the row available
          // for step 19's capture-form comparison, which needs its own awaiting_price row.
          const restoreBtn = await waitByText(dash, 'div[role="menuitem"]', 'Restore', 1500);
          if (restoreBtn) {
            await robustClick(restoreBtn);
            await sleep(700);
            await shot(dash, 'price-requests-restored-row');
          } else {
            await dash.keyboard.press('Escape');
          }
        }
      }
    }
  }

  console.log('\n[19] Original capture form (awaiting_price -> /price/:token), for comparison');
  const rC = await fetch(`${API}/api/price-requests`).then((r) => r.json());
  const stillAwaiting = (rC.requests || []).find((r) => r.status === 'awaiting_price');
  if (stillAwaiting) {
    const capturePage = await browser.newPage();
    await capturePage.setViewport({ width: 480, height: 1400, deviceScaleFactor: 2 });
    await capturePage.goto(`${API}/price/${stillAwaiting.pathSeg}`, { waitUntil: 'networkidle2' });
    await sleep(400);
    await shot(capturePage, 'capture-form-awaiting-original');

    const captureCost = await capturePage.$('#cost');
    if (captureCost) {
      await setValue(captureCost, '55000');
      const captureBtn = await capturePage.$('#mainForm button[type=submit], form button[type=submit]');
      if (captureBtn) {
        await robustClick(captureBtn);
        await sleep(900);
        await shot(capturePage, 'capture-form-saved-dead-end-page');
      }
    }
    await capturePage.close();
  } else {
    console.log('  (no awaiting_price load left to demo the capture form - skipped)');
  }

  await browser.close();
  console.log('\nDone -', shotCount, 'screenshots written to', OUT);
})().catch((e) => {
  console.error('SCRIPT FAILED:', e);
  process.exit(1);
});
