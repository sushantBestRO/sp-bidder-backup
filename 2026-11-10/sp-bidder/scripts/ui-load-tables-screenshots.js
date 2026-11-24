'use strict';
// Screenshots the three load tables (Price Requests, Live Bids, History) at three desktop widths,
// against a fixture set shaped like the rows the desk actually sees, and counts every table cell
// whose content paints past its own box - in the static page and in the Stop / Re-arm confirmation
// states, which a static shot never reaches. Verification for any change to those tables' layout.
//
//   npm run build:console                                   # after any dashboard/src change
//   node scripts/ui-load-tables-screenshots.js --tag=after  # prefixes the output filenames
//   node scripts/ui-load-tables-screenshots.js --widths=1440,1920 --scheme=dark
//
// Output: scripts/ui-load-tables-screenshots/<tag>-<width>-<page>.png plus one overflow line per
// shot on stdout. Owns its stack: boots the server in-process on its own port with an in-memory
// store, so it is re-runnable with no cleanup and never touches data/*.json.

const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'ui-load-tables-screenshots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.SHOT_PORT || 4397);
const BASE = `http://127.0.0.1:${PORT}`;

const argOf = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const TAG = argOf('tag');
const WIDTHS = (argOf('widths') || '1440,1680,1920').split(',').map((s) => Number(s.trim())).filter(Boolean);
const SCHEME = argOf('scheme') || 'light';

// config.js reads process.env at module-load time, so everything the boot depends on is set before
// the first require that pulls it in. No admin hash => AUTH_ON false => no login page to drive.
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_DEMO_SEED = '1';
process.env.PORT = String(PORT);
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-shots-'));
delete process.env.SP_ADMIN_PASS_HASH;

const puppeteer = require('puppeteer-core');
const { boot, requests } = require('../src/web/server');

const H = 60 * 60_000;
const M = 60_000;

// One row per shape that has broken this table before: a scheduled SuperProcure load carrying
// every Vehicle fact (the row from the 20-Sep screenshot), a long customer name with a long drop
// address, a GoComet load whose lane IS two postal addresses, a hand-set margin band, a stopped
// load (the widest Action control), a dismissed one, and an expired one for History's Skipped row.
async function seedFixtures() {
  const now = Date.now();
  const sp = (id, over) => ({
    id, softClose: false, status: 'live', startsAt: now - M, companyName: 'Borosil',
    lane: { origin: 'Govindgarh', destination: 'Thane' },
    points: [
      { kind: 'pickup', address: 'BG, Govindgarh, Rajasthan, India' },
      { kind: 'drop', address: 'Thane, Maharashtra,India' },
    ],
    equipment: 'Container 14 MT 32ft', units: 1, weight: 15, weightUnit: 'MT', distanceKm: 1165.23,
    productName: 'OPAL GLASS CROCKERY',
    ...over,
  });

  await requests.createForLoad(sp('25577051', { status: 'scheduled', startsAt: now + 7 * H + 43 * M, closesAt: now + 7 * H + 58 * M }));

  await requests.createForLoad(sp('25570415', {
    closesAt: now + 8 * H + 4 * M,
    companyName: 'Tata Consumer Products Limited (Beverages Division)',
    lane: { origin: 'Govindgarh', destination: 'Kolkata' },
    points: [
      { kind: 'pickup', address: 'BG, Govindgarh, Rajasthan, India' },
      { kind: 'drop', address: 'JANTA GLASS HOUSE, Kolkata, WEST BENGAL, India, 700001' },
    ],
    equipment: '40ft Multi Axle Trailer Flatbed', units: 2, weight: 26, distanceKm: 1592.51,
    productName: 'Packaged tea and beverages',
  }));

  await requests.createForLoad({
    id: 'GC-260920A1', softClose: false, status: 'live', startsAt: now - M, closesAt: now + 52 * M,
    companyName: 'Waaree Energies',
    lane: {
      origin: 'Plot No. 12, Waaree Energies Ltd, Chikhli Industrial Area, Surat, Gujarat 394230',
      destination: 'Adani Solar Park, Khavda, Kutch, Gujarat 370510',
    },
    equipment: 'Dala Body LPT - 22Ft', units: 1, weight: 7.5, weightUnit: 'MT', distanceKm: 1389.88,
    productName: 'Solar Modules',
  }, { platformKey: 'gocomet' });

  const override = await requests.createForLoad(sp('25570462', { closesAt: now + 8 * H + 6 * M, units: 1, weight: 9 }));
  await requests.setBidOverride(override.id, { marginsPct: [9, 6], minMarginPct: 4 }, { setBy: 'shots' });

  const stopped = await requests.createForLoad(sp('25570323', {
    closesAt: now + 8 * H + 2 * M, lane: { origin: 'Bagru', destination: 'Hyderabad' },
    points: [
      { kind: 'pickup', address: 'Bagru, Rajasthan, India' },
      { kind: 'drop', address: 'Hyderabad, Telangana, India' },
    ],
    equipment: 'Dala Body LPT - 22Ft', weight: 7.5, distanceKm: 1389.88,
  }));
  await requests.capture(stopped.id, { cost: 80000 });
  await requests.stop(stopped.id);

  // No portal points, and lane ends carrying SuperProcure's state suffix - the shape the first
  // repair of the duplicate-address finding missed, because the label has the suffix stripped.
  await requests.createForLoad(sp('25571777', {
    closesAt: now + 6 * H + 15 * M, companyName: 'Havells',
    lane: { origin: 'Chakan, MH', destination: 'Bawal, HR' }, points: null,
    equipment: '32ft SXL', units: 1, weight: 18, distanceKm: 1204.4, productName: 'Switchgear',
  }));

  const dismissed = await requests.createForLoad(sp('25570999', { closesAt: now + 5 * H }));
  await requests.dismiss(dismissed.id);

  await requests.createForLoad(sp('25560001', { closesAt: now - 10 * M }));
  await requests.expireOverdue(now);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function byText(page, tag, text) {
  const handle = await page.evaluateHandle(
    (tag, text) => Array.from(document.querySelectorAll(tag)).find((el) => el.textContent && el.textContent.trim().includes(text)) || null,
    tag, text,
  );
  const el = handle.asElement();
  if (!el) { await handle.dispose(); return null; }
  return el;
}
async function waitByText(page, tag, text, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const el = await byText(page, tag, text);
    if (el) return el;
    await sleep(150);
  }
  throw new Error(`not found: <${tag}> containing "${text}"`);
}

// Every <td> whose content is wider than the cell, plus whether the table itself is wider than its
// scroll wrapper. A cell in the first list is painting into its neighbour; the second is the
// horizontal-scroll case. Both are the defects this harness exists to catch.
async function overflowReport(page) {
  return page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll('table td, table th'));
    const spill = cells
      .filter((td) => td.scrollWidth > td.clientWidth + 1)
      .map((td) => `${td.tagName.toLowerCase()} "${(td.textContent || '').trim().slice(0, 40)}" ${td.scrollWidth}>${td.clientWidth}`);
    const table = document.querySelector('table');
    const wrap = table && table.parentElement;
    return {
      cells: cells.length,
      spill,
      tableWidth: table ? table.getBoundingClientRect().width : 0,
      wrapWidth: wrap ? wrap.clientWidth : 0,
      rows: document.querySelectorAll('table tbody tr').length,
      // Natural per-column widths, so a declared width is set from a measurement, never a guess.
      heads: Array.from(document.querySelectorAll('thead th')).map((th) => `${(th.textContent || '').trim()}=${Math.round(th.getBoundingClientRect().width)}`),
    };
  });
}

// The states a static shot never reaches: Stop on Live Bids and Re-arm on the worklist each swap
// their button for a confirmation that renders beside the row's other controls, inside the pinned
// Action cell. Measured ~550ms after the click - the button holds its busy state for 400ms
// (withMinDelay) and the confirmation stays up for 700ms after that before the row leaves.
async function interactionPass(page, prefix) {
  let spilled = 0;
  for (const [label, control, slug] of [['Live Bids', 'Stop', 'live-bids-after-stop'], ['Price Requests', 'Re-arm', 'price-requests-after-rearm']]) {
    const tab = await waitByText(page, 'button', label);
    await tab.click();
    await waitByText(page, 'td', '#');
    await sleep(500);
    const btn = await byText(page, 'button', control);
    if (!btn) { console.log(`${label}: no ${control} control on any row - interaction state not measured`); continue; }
    await btn.click();
    await sleep(550);
    const r = await overflowReport(page);
    await page.screenshot({ path: path.join(OUT, `${prefix}${slug}.png`) });
    spilled += r.spill.length;
    console.log(`${label} after ${control}: ${r.spill.length} overflowing cell(s)`);
    for (const s of r.spill) console.log(`    ${s}`);
    await sleep(1200);
  }
  return spilled;
}

(async () => {
  if (!fs.existsSync(path.join(ROOT, 'dashboard', 'dist', 'index.html'))) {
    throw new Error('dashboard/dist is missing - run `npm run build:console` first.');
  }
  fs.mkdirSync(OUT, { recursive: true });

  const server = await boot();
  await seedFixtures();
  console.log(`[server] up on ${BASE}, fixtures seeded`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  let failures = 0;
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: SCHEME }]);
      await page.goto(BASE, { waitUntil: 'networkidle0' });
      for (const [label, slug] of [['Price Requests', 'price-requests'], ['Live Bids', 'live-bids'], ['History', 'history']]) {
        const btn = await waitByText(page, 'button', label);
        await btn.click();
        await waitByText(page, 'td', '#');
        await sleep(700);
        const prefix = TAG ? `${TAG}-` : '';
        const file = path.join(OUT, `${prefix}${width}-${slug}.png`);
        await page.screenshot({ path: file, fullPage: true });
        const r = await overflowReport(page);
        // Horizontal scroll is reported, not failed: below a table's declared floor the wrapper is
        // MEANT to scroll (Live Bids and History do at a 1440 viewport). A cell painting past its
        // own box is never meant to happen.
        const scrolls = r.tableWidth > r.wrapWidth + 1;
        if (r.spill.length) failures += 1;
        console.log(`${path.basename(file)}: ${r.rows} rows, table ${Math.round(r.tableWidth)} in ${r.wrapWidth}${scrolls ? ' (SCROLLS)' : ''}, ${r.spill.length} overflowing cell(s)`);
        console.log(`    columns: ${r.heads.join('  ')}`);
        for (const s of r.spill) console.log(`    ${s}`);
      }
      await page.close();
    }

    // LAST, and on its own page: Stop and Re-arm are real mutations against the one store seeded
    // above, so running them between widths left 1680 and 1920 measuring a fixture set that no
    // longer held the stopped row they were supposed to cover. The row counts stayed identical
    // either way, because Stop and Re-arm move a load in opposite directions between the two
    // tables - which is exactly why the mutation was invisible in the run that introduced it.
    const ipage = await browser.newPage();
    await ipage.setViewport({ width: WIDTHS[0], height: 1000, deviceScaleFactor: 1 });
    await ipage.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: SCHEME }]);
    await ipage.goto(BASE, { waitUntil: 'networkidle0' });
    if (await interactionPass(ipage, `${TAG ? `${TAG}-` : ''}${WIDTHS[0]}-`)) failures += 1;
    await ipage.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} shot(s) with an overflowing cell` : '\nno overflowing cells');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
