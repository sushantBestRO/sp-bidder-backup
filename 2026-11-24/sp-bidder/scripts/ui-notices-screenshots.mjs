// Screenshots every state of the in-app notice system that replaced the browser dialogs:
//   toasts (success / error / warn / stacked), the confirm modal (default + danger), each
//   converted flow mid-interaction, and the /price page's inline confirm.
//
// Runs against a stack booted from THIS worktree on its own ports + its own data dir, so it
// never touches the demo stack on :4103/:4330:
//   cd dashboard && npm run build
//   SP_DATA_DIR=<temp> PLATFORM=mock STORE_BACKEND=file SP_DEMO_SEED=1 PORT=4317 \
//     SP_MIN_PLAUSIBLE_COST=500 SP_MIN_COST_ABS=0 SP_MIN_COST_PER_KM=0 node src/web/server.js
// Then: node scripts/ui-notices-screenshots.mjs
//
// Express serves the built console itself, so one port covers both the console and /price -
// and what gets shot is the production bundle, not a dev server.
//
// Same puppeteer-core pattern as scripts/ui-settings-screenshots.mjs / ui-price-flow-screenshots.mjs.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';

const OUT = process.env.SHOT_DIR || path.join(process.cwd(), 'ui-notices-shots');
const APP = process.env.APP_URL || 'http://localhost:4317';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shotCount = 0;
async function shot(page, name, { fullPage = false } = {}) {
  shotCount += 1;
  const file = path.join(OUT, `${String(shotCount).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log('  ->', path.basename(file));
}

async function byText(page, tag, text) {
  const h = await page.evaluateHandle((tag, text) => {
    const els = Array.from(document.querySelectorAll(tag));
    return els.find((el) => el.textContent && el.textContent.trim().includes(text)) || null;
  }, tag, text);
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}
async function waitByText(page, tag, text, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = await byText(page, tag, text);
    if (el) return el;
    await sleep(150);
  }
  return null;
}
async function click(el) {
  await el.evaluate((n) => n.scrollIntoView({ block: 'center' }));
  await sleep(80);
  await el.click();
}
async function nav(page, label) {
  const el = await waitByText(page, 'button', label);
  if (!el) throw new Error(`nav "${label}" not found`);
  await click(el);
  await sleep(800);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--force-color-profile=srgb', '--window-size=1440,1000'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

  // The nav-guard shot deliberately leaves a page dirty, which arms the browser's own
  // beforeunload prompt (lib/unsavedChanges.ts). That is a real browser feature for
  // refresh/close - not an alert() this work replaces - but it blocks the next goto(), so
  // accept it automatically. Any OTHER native dialog reaching here would be a regression the
  // grep gate should already have caught.
  page.on('dialog', async (d) => {
    console.log(`  (native ${d.type()} auto-accepted: ${JSON.stringify(d.message()).slice(0, 60)})`);
    await d.accept();
  });

  // Make sure the engine is LIVE before the kill-flow shots, whatever a previous run left behind.
  async function ensureLive() {
    await page.goto(APP, { waitUntil: 'networkidle2' });
    await sleep(1200);
    const r = await byText(page, 'button', 'Resume');
    if (r) { await click(r); await sleep(900); }
  }

  // ------------------------------------------------- 1. FAILED kill -> sticky error toast
  // The real failure path, forced at the network layer. Before this, a failed kill resolved to
  // { error } and was dropped on the floor while the badge still read LIVE - the operator
  // believed bidding had stopped when it had not. Shot FIRST, while the engine is still live.
  console.log('\n[1] Kill that fails -> sticky error toast');
  await ensureLive();
  await page.setRequestInterception(true);
  const failKill = (req) => {
    if (req.url().includes('/api/engine/kill')) {
      req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'engine unreachable (simulated for this screenshot)' }) });
    } else req.continue();
  };
  page.on('request', failKill);
  const killF = await waitByText(page, 'button', 'Kill');
  if (!killF) throw new Error('Kill control not found - is the console built and the stack on :4317?');
  await click(killF);
  await sleep(1000);
  await shot(page, 'toast-error-kill-failed-sticky');
  page.off('request', failKill);
  await page.setRequestInterception(false);

  // ---------------------------------------------------------------- 2. kill -> success toast
  console.log('\n[2] Topbar Kill -> success toast (outcome that used to be silent)');
  await ensureLive();
  const kill = await waitByText(page, 'button', 'Kill');
  if (kill) {
    await click(kill);
    await sleep(900);
    await shot(page, 'toast-success-bidding-stopped');
  }

  // ------------------------------------------------------------- 3. resume -> success toast
  console.log('\n[3] Resume -> success toast');
  const resume = await waitByText(page, 'button', 'Resume');
  if (resume) {
    await click(resume);
    await sleep(900);
    await shot(page, 'toast-success-bidding-resumed');
  }

  // ------------------------------------------------------- 4. warn toast: session expired
  // Every data call 401s -> the console used to become the login screen with no explanation,
  // which reads as a crash rather than a timeout.
  console.log('\n[4] Session expiry -> warn toast (was a silent bounce to login)');
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await page.setRequestInterception(true);
  const fail401 = (req) => {
    if (req.url().includes('/api/') && !req.url().includes('/api/session')) {
      req.respond({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthorized' }) });
    } else req.continue();
  };
  page.on('request', fail401);
  const navBtn = await waitByText(page, 'button', 'Customers');
  if (navBtn) await click(navBtn);
  await sleep(1600);
  await shot(page, 'toast-warn-session-expired');
  page.off('request', fail401);
  await page.setRequestInterception(false);

  // ------------------------------------- 5. nav-guard confirm (the migrated hand-rolled one)
  console.log('\n[5] Nav guard -> "Discard unsaved changes?" via the shared confirm');
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(1200);
  let guardShot = false;
  for (const pageName of ['Bidding targets', 'Settings', 'Notifications']) {
    if (guardShot) break;
    await nav(page, pageName);
    const field = await page.$('input[type="number"], input[type="text"]:not([readonly])');
    if (!field) continue;
    await field.click({ clickCount: 3 });
    await page.keyboard.type('9');
    await sleep(700);
    const away = await byText(page, 'button', 'Customers');
    if (!away) continue;
    await click(away);
    await sleep(600);
    const keep = await byText(page, 'button', 'Keep editing');
    if (keep) {
      await shot(page, 'confirm-discard-unsaved-changes');
      await click(keep);
      await sleep(400);
      guardShot = true;
    }
  }
  if (!guardShot) console.log('  (could not make a page dirty - nav guard not captured)');

  // ------------------------------------------------ 6. danger confirm: remove a person
  console.log('\n[6] Team -> remove person: danger confirm (cancelled, keeps the data)');
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await nav(page, 'Team');
  const delP = await page.$('button[aria-label^="Delete"]');
  if (delP) {
    await click(delP);
    await sleep(500);
    await shot(page, 'confirm-danger-remove-person');
    const cancel = await waitByText(page, 'button', 'Cancel');
    if (cancel) { await click(cancel); await sleep(400); }
  } else {
    console.log('  (no team member seeded)');
  }

  // -------------------------------------------- 7. the other theme (console defaults dark)
  console.log('\n[7] Light theme: danger confirm + toast');
  const themeBtn = await page.$('button[aria-label="Toggle theme"]');
  if (themeBtn) { await click(themeBtn); await sleep(600); }
  await nav(page, 'Customers');
  const delL = await page.$('button[aria-label^="Delete"]');
  if (delL) {
    await click(delL);
    await sleep(500);
    await shot(page, 'light-confirm-danger-delete-customer');
    const c = await waitByText(page, 'button', 'Cancel');
    if (c) { await click(c); await sleep(300); }
  }
  const killL = await waitByText(page, 'button', 'Kill');
  if (killL) { await click(killL); await sleep(800); await shot(page, 'light-toast-success'); }
  if (themeBtn) { await click(themeBtn); await sleep(500); } // back to dark

  // ------------------------------ 8. destructive, LAST: confirm a delete through to the toast
  console.log('\n[8] Customers -> delete confirmed through -> success toast');
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(1200);
  await nav(page, 'Customers');
  const del = await page.$('button[aria-label^="Delete"]');
  if (del) {
    await click(del);
    await sleep(500);
    await shot(page, 'confirm-danger-delete-customer');
    const yes = await waitByText(page, 'button', 'Delete customer');
    if (yes) {
      await click(yes);
      await sleep(1000);
      await shot(page, 'toast-success-customer-deleted');
    }
  } else {
    console.log('  (no customer row with a delete affordance)');
  }

  // --------------------------------------------- 9. /price page inline confirm (Phase 2)
  console.log('\n[9] /price low-cost guard -> inline in-app dialog (was window.confirm)');
  const reqs = await fetch(`${APP}/api/price-requests`).then((r) => r.json()).then((d) => d.requests || []);
  const awaiting = reqs.find((r) => r.status === 'awaiting_price');
  if (awaiting) {
    const seg = awaiting.pathSeg || awaiting.publicSeg;
    const p = await browser.newPage();
    await p.setViewport({ width: 480, height: 940, deviceScaleFactor: 2 });
    await p.goto(`${APP}/price/${seg}`, { waitUntil: 'networkidle2' });
    await sleep(500);
    const costInput = await p.$('#cost, input[name="cost"]');
    if (costInput) {
      await costInput.click({ clickCount: 3 });
      await p.keyboard.type('2'); // well under the Rs 500 soft floor
      await sleep(400);
      await shot(p, 'price-low-cost-entered');
      const submit = await p.$('form button[type="submit"], form button:not([type])');
      if (submit) {
        await submit.click();
        await sleep(600);
        await shot(p, 'price-confirm-inapp-dialog');
      }
    } else {
      console.log('  (no cost input on the price page)');
    }
    await p.close();
  } else {
    console.log('  (no awaiting_price request - boot the backend with SP_DEMO_SEED=1)');
  }

  await browser.close();
  console.log(`\nDone - ${shotCount} screenshots in ${OUT}`);
})().catch((e) => { console.error('SCRIPT FAILED:', e); process.exit(1); });
