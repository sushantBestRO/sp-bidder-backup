// Drives the model-console pages (Accounts / Customers / Team / Assignments / Notifications) and
// the load tables through the states the UI-cohesion redesign touches, screenshotting each one.
//
// Unlike scripts/ui-state-flow-screenshots.mjs (which expects a backend + a vite dev server you
// started yourself), this harness OWNS its stack: it spawns the Express server on its own port with
// an in-memory store, seeds the model through the real /api endpoints, drives the built console,
// then tears the server down. That makes it re-runnable after every edit with no cleanup, and it
// screenshots exactly what production serves (Express serving dashboard/dist) rather than what the
// vite dev proxy serves.
//
//   npm run build:console          # once, and again after any dashboard/src change
//   node scripts/ui-cohesion-screenshots.mjs
//   node scripts/ui-cohesion-screenshots.mjs --only=team,customers
//   node scripts/ui-cohesion-screenshots.mjs --tag=after     # prefixes the output filenames
//
// Output: scripts/ui-cohesion-screenshots/[tag-]NN-description.png, numbered in flow order.

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'ui-cohesion-screenshots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// A port of its own, so a dev stack already running on 4103 is never disturbed and the two
// harnesses can run side by side.
const PORT = Number(process.env.SHOT_PORT || 4399);
const BASE = `http://localhost:${PORT}`;

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const TAG = argOf('tag');
const ONLY = (argOf('only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const wants = (section) => ONLY.length === 0 || ONLY.includes(section);

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- server lifecycle --------------------------------------------------------------------
// STORE_BACKEND=memory keeps every run hermetic (no data/*.json to clean up, no chance of a
// harness run polluting a real local store). No SP_ADMIN_PASS_HASH => AUTH_ON is false, so the
// /api gate is open and there is no login page to drive. PLATFORM is unset => mock adapter,
// which by construction can never place a real bid.
function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'web', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), STORE_BACKEND: 'memory', SP_DEMO_SEED: '1', PLATFORM: '', SP_ADMIN_PASS_HASH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));
  child.on('exit', (code) => { if (code) console.error('[server] exited early, code', code, '\n', logs.join('')); });
  return { child, logs };
}

async function waitForServer(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`server did not come up on ${BASE} within ${timeoutMs}ms`);
}

// Mutating /api POSTs are rejected unless Origin's host matches Host (the CSRF guard in
// server.js). fetch() sends no Origin from Node, so set it explicitly.
async function post(route, body) {
  const r = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json error page */ }
  if (!r.ok || (json && json.error)) throw new Error(`POST ${route} -> ${r.status} ${text.slice(0, 200)}`);
  return json;
}

// ---- the seed ----------------------------------------------------------------------------
// Deliberately shaped to exercise the cohesion cases, not just the happy path:
//  - Syngenta: covered by TWO people (the overlap the Assignments matrix exists to show), and by
//    people on two different branches, so the Customers page's derived "Branches" has >1 value.
//  - Waaree: one coverer, carries its own margin, so margin-source precedence is visible.
//  - Acme Foods: NO coverer at all (an orphan customer) and no margin - the empty-state case.
//  - Sameer->Syngenta carries a marginOverride, so the matrix's "overridden" dot renders.
//  - Central Desk is alertAll with no assignments - the "gets every load" row.
//  - An unmatched load (companyName that matches no customer alias) must exist so the load
//    tables' unmatched fallback renders.
async function seedModel() {
  const customers = [
    { customerId: 'syngenta', label: 'Syngenta', aliases: ['Syngenta India', 'Syngenta India Ltd'], margin: { marginsPct: [12, 8, 5], minMarginPct: 3 }, auction: { attemptsAllowed: 3, closeModel: 'hard' }, enabled: true },
    { customerId: 'waaree', label: 'Waaree', aliases: ['Waaree Energies'], margin: { marginsPct: [10, 6], minMarginPct: 4 }, auction: null, enabled: true },
    { customerId: 'acme-foods', label: 'Acme Foods', aliases: [], margin: null, auction: null, enabled: true },
    { customerId: 'dormant-co', label: 'Dormant Co', aliases: [], margin: null, auction: null, enabled: false },
  ];
  for (const c of customers) await post('/api/customers', c);

  const people = [
    { personId: 'pankaj', name: 'Pankaj', phone: '+919812345671', email: 'pankaj@example.com', accountId: 'primary', alertPrefs: ['price_needed', 'won', 'lost'], alertAll: false, enabled: true },
    { personId: 'sameer', name: 'Sameer', phone: '+919812345672', accountId: 'primary', alertPrefs: ['price_needed', 'error'], alertAll: false, enabled: true },
    { personId: 'central-desk', name: 'Central Pricing Desk', phone: '+919812345673', accountId: 'primary', alertPrefs: 'all', alertAll: true, enabled: true },
    { personId: 'inactive-ravi', name: 'Ravi (on leave)', phone: '+919812345674', accountId: 'primary', alertPrefs: ['won'], alertAll: false, enabled: false },
  ];
  for (const p of people) await post('/api/people', p);

  const assignments = [
    { personId: 'pankaj', customerId: 'syngenta', enabled: true },
    { personId: 'pankaj', customerId: 'waaree', enabled: true },
    { personId: 'sameer', customerId: 'syngenta', marginOverride: { marginsPct: [9, 6], minMarginPct: 4 }, alertKinds: ['price_needed'], enabled: true },
  ];
  for (const a of assignments) await post('/api/assignments', a);

  // Drive the mock reconnect so the account carries a persisted login contact. The mock branch of
  // /reconnect/verify accepts any code. The number is deliberately Pankaj's, so the Accounts page
  // renders the "on the team as ..." join rather than only the "not on the team" branch.
  await post('/api/accounts/primary/reconnect/start', { phone: '9812345671' });
  await post('/api/accounts/primary/reconnect/verify', { otp: '123456' });

  const [c, p, a] = await Promise.all([
    fetch(`${BASE}/api/customers`).then((r) => r.json()),
    fetch(`${BASE}/api/people`).then((r) => r.json()),
    fetch(`${BASE}/api/assignments`).then((r) => r.json()),
  ]);
  console.log(`[seed] ${c.customers.length} customers, ${p.people.length} people, ${a.assignments.length} assignments`);
}

// ---- puppeteer helpers (same idioms as ui-state-flow-screenshots.mjs) ---------------------
let shotCount = 0;
async function shot(page, name) {
  shotCount += 1;
  const prefix = TAG ? `${TAG}-` : '';
  const file = path.join(OUT, `${prefix}${String(shotCount).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log('  ->', path.basename(file));
}

// The console renders no test-ids, so elements are found by tag + visible text.
async function byText(page, tag, text) {
  const handle = await page.evaluateHandle(
    (tag, text) => Array.from(document.querySelectorAll(tag)).find((el) => el.textContent && el.textContent.trim().includes(text)) || null,
    tag, text,
  );
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
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
// scrollIntoView first (the page may have grown past the fold), then a REAL mouse click -
// Radix listens for pointer events and silently ignores a programmatic node.click().
async function robustClick(el) {
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await sleep(60);
  await el.click();
}
async function nav(page, label) {
  const btn = await waitByText(page, 'button', label);
  if (!btn) throw new Error(`nav button not found: ${label}`);
  await robustClick(btn);
  await sleep(650);
}
// Clear before typing: Chrome's number input inserts mid-string rather than replacing.
async function setValue(el, value) {
  await el.evaluate((node) => { node.value = ''; });
  await el.type(value);
}

// ---- the flow ----------------------------------------------------------------------------
(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dashboard', 'dist', 'index.html'))) {
    throw new Error('dashboard/dist is missing - run `npm run build:console` first.');
  }

  const { child } = startServer();
  const shutdown = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(1); });

  try {
    await waitForServer();
    console.log(`[server] up on ${BASE}`);
    await seedModel();

    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--force-color-profile=srgb', '--window-size=1440,1000'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 });

    // Surface any console error the pages throw - a silent React crash otherwise just looks like
    // an oddly empty screenshot.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

    await page.goto(BASE, { waitUntil: 'networkidle2' });
    await sleep(600);

    if (wants('overview')) {
      console.log('\n[overview]');
      await shot(page, 'overview');
    }

    if (wants('customers')) {
      console.log('\n[customers]');
      await nav(page, 'Customers');
      await shot(page, 'customers-list');
      const addBtn = await waitByText(page, 'button', 'Add customer');
      if (addBtn) { await robustClick(addBtn); await sleep(400); await shot(page, 'customers-draft-new'); }
      const cancel = await byText(page, 'button', 'Cancel');
      if (cancel) { await robustClick(cancel); await sleep(300); }
      // Edit an existing customer -> the draft card is where "Covered by" will live.
      const editSyngenta = await page.evaluateHandle(() => {
        const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes('Syngenta'));
        return row ? row.querySelector('button[aria-label^="Edit"]') : null;
      });
      const editEl = editSyngenta.asElement();
      if (editEl) { await robustClick(editEl); await sleep(400); await shot(page, 'customers-draft-edit-syngenta'); }
    }

    if (wants('team')) {
      console.log('\n[team]');
      await nav(page, 'Team');
      await shot(page, 'team-list');
      const addPerson = await waitByText(page, 'button', 'Add person');
      if (addPerson) { await robustClick(addPerson); await sleep(400); await shot(page, 'team-draft-new'); }
      const cancel = await byText(page, 'button', 'Cancel');
      if (cancel) { await robustClick(cancel); await sleep(300); }
      const editPankaj = await page.evaluateHandle(() => {
        const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes('Pankaj'));
        return row ? row.querySelector('button[aria-label^="Edit"]') : null;
      });
      const editEl = editPankaj.asElement();
      if (editEl) { await robustClick(editEl); await sleep(400); await shot(page, 'team-draft-edit-pankaj'); }
    }

    // The combobox is the one genuinely new control, and it is the one a happy-path sweep never
    // opens. Drive it by KEYBOARD ONLY - AI-authored UI defaults to mouse-only and inaccessible.
    if (wants('combobox')) {
      console.log('\n[combobox] keyboard-only, on the Team edit form');
      await nav(page, 'Team');
      const editPankaj = await page.evaluateHandle(() => {
        const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes('Pankaj'));
        return row ? row.querySelector('button[aria-label^="Edit"]') : null;
      });
      const editEl = editPankaj.asElement();
      if (!editEl) throw new Error('could not open the Pankaj edit form');
      await robustClick(editEl);
      await sleep(400);

      const box = await page.$('input[role="combobox"][aria-label="Covers these customers"]');
      if (!box) throw new Error('the Covers combobox did not render');

      // Focus alone must open the list (no click).
      await box.focus();
      await sleep(300);
      await shot(page, 'combobox-open-on-focus');

      // ArrowDown twice, then screenshot the active row. aria-activedescendant must track it.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await sleep(200);
      const active = await page.evaluate(() => {
        const el = document.querySelector('input[role="combobox"][aria-label="Covers these customers"]');
        const id = el && el.getAttribute('aria-activedescendant');
        const row = id && document.getElementById(id);
        return { id, text: row ? row.textContent.trim() : null, expanded: el && el.getAttribute('aria-expanded') };
      });
      console.log('  aria-activedescendant:', JSON.stringify(active));
      await shot(page, 'combobox-keyboard-active-row');

      // Filter down to a single option.
      await box.type('acme');
      await sleep(250);
      await shot(page, 'combobox-filtered');

      // A query matching nothing offers the create row.
      await box.evaluate((n) => { n.value = ''; });
      await box.type('Zeta Corp');
      await sleep(250);
      await shot(page, 'combobox-create-row');

      // Enter on the create row must actually create the customer AND select it.
      await page.keyboard.press('Enter');
      await sleep(900);
      await shot(page, 'combobox-after-create');
      const created = await fetch(`${BASE}/api/customers`).then((r) => r.json());
      const zeta = (created.customers || []).find((c) => c.label === 'Zeta Corp');
      console.log('  create-if-missing ->', zeta ? `created ${zeta.customerId}` : 'FAILED (no customer created)');

      // Backspace on an empty query removes the last chip - mouse-free chip removal.
      await page.keyboard.press('Backspace');
      await sleep(250);
      await shot(page, 'combobox-backspace-removed-chip');

      // Escape closes without submitting the surrounding draft form.
      await page.keyboard.press('Escape');
      await sleep(250);
      await shot(page, 'combobox-escape-closed');

      // Leave the form without saving, so later sections see the seeded state.
      const cancel = await byText(page, 'button', 'Cancel');
      if (cancel) { await robustClick(cancel); await sleep(300); }
    }

    // Regression proof for the coverage-wipe bug: "Add customer" with a label that slugifies onto an
    // existing customer must be REFUSED, not silently overwrite it and delete its assignments.
    if (wants('collision')) {
      console.log('\n[collision] Add an existing customer -> must refuse, not overwrite');
      const before = await fetch(`${BASE}/api/assignments`).then((r) => r.json());
      await nav(page, 'Customers');
      const addBtn = await waitByText(page, 'button', 'Add customer');
      await robustClick(addBtn);
      await sleep(400);
      const nameInput = await page.$('input[placeholder="e.g. Syngenta"]');
      if (!nameInput) throw new Error('the customer name input did not render');
      await nameInput.type('Syngenta'); // already exists, seeded above
      const saveBtn = await byText(page, 'button', 'Save');
      await robustClick(saveBtn);
      await sleep(900);
      await shot(page, 'collision-add-existing-customer-refused');

      const after = await fetch(`${BASE}/api/assignments`).then((r) => r.json());
      const kept = after.assignments.length === before.assignments.length;
      console.log(`  assignments before=${before.assignments.length} after=${after.assignments.length} ->`, kept ? 'PRESERVED' : 'WIPED (regression!)');
      const cust = await fetch(`${BASE}/api/customers`).then((r) => r.json());
      const syn = cust.customers.find((c) => c.customerId === 'syngenta');
      console.log('  syngenta margin still set ->', syn && syn.margin ? 'YES' : 'NO (regression!)');
      if (!kept || !(syn && syn.margin)) throw new Error('coverage-wipe regression reproduced');

      const cancel = await byText(page, 'button', 'Cancel');
      if (cancel) { await robustClick(cancel); await sleep(300); }
    }

    if (wants('assignments')) {
      console.log('\n[assignments]');
      await nav(page, 'Assignments');
      await shot(page, 'assignments-matrix');
    }

    if (wants('accounts')) {
      console.log('\n[accounts]');
      await nav(page, 'Accounts');
      await shot(page, 'accounts');
    }

    if (wants('notifications')) {
      console.log('\n[notifications]');
      await nav(page, 'Notifications');
      await shot(page, 'notifications');
    }

    if (wants('config')) {
      console.log('\n[config]');
      await nav(page, 'Bidding targets');
      await shot(page, 'bidding-targets');
    }

    if (wants('loads')) {
      console.log('\n[loads]');
      await nav(page, 'Price Requests');
      await shot(page, 'price-requests');
      await nav(page, 'Live Bids');
      await shot(page, 'live-bids');
      await nav(page, 'History');
      await shot(page, 'history');
    }

    await browser.close();

    if (pageErrors.length) {
      console.log('\n[page errors] ' + pageErrors.length + ' captured:');
      for (const e of pageErrors.slice(0, 10)) console.log('  !', e.slice(0, 200));
    } else {
      console.log('\n[page errors] none');
    }
    console.log(`\nDone - ${shotCount} screenshots in ${OUT}`);
  } finally {
    shutdown();
  }
})().catch((e) => { console.error('SCRIPT FAILED:', e); process.exit(1); });
