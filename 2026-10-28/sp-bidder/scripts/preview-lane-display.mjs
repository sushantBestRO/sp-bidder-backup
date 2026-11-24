// A picture of the worklist's Lane column with BOTH portals' rows adjacent - which is the whole
// complaint. Side by side is the only way the inconsistency is visible at all; either portal on its
// own looks fine.
//
// Boots a bidder in MOCK mode, seeds price requests whose lane values are real strings off the live
// board, and drives the shipped console with headless Chrome. Pass --root to point one run at an
// export of another commit; the driver that builds both sides is preview-lane-display.sh.
//
//   node scripts/preview-lane-display.mjs --out <dir> [--root <tree>] [--label before|after]
//
// --out MUST be outside the repo: scripts/deploy.sh ships the working tree, so a PNG left in here
// would be copied onto the client's box.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(arg('root', path.resolve(HERE, '..')));
const LABEL = arg('label', 'after');
const OUT = path.resolve(arg('out', path.join(ROOT, '..', 'preview-out')));
fs.mkdirSync(OUT, { recursive: true });

const PORT = arg('port', String(4600 + Math.floor(Math.random() * 200)));
process.env.PORT = PORT;
process.env.HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(OUT, '.state-'));
delete process.env.PLATFORM;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
].find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });

const server = require(path.join(ROOT, 'src', 'web', 'server.js'));
const { parseGoCometLane } = require(path.join(ROOT, 'src', 'platform', 'gocometLane.js'));
const { requests, boot } = server;

// Every lane value below is a real string off the live board. Interleaved on purpose: the rows the
// desk screenshotted alternated between the portals, and that is when the shapes stop matching.
const SP = [
  ['24030382', 'UDHAMPUR', 'Supaul', 'Havells India Ltd.'],
  ['24029015', 'Sikandrabad', 'Chennai', 'Havells India Ltd.'],
  ['24029273', 'Haridwar', 'Coimbatore', 'Havells India Ltd.'],
  ['23534893', 'Bhiwandi, MH', 'Bawal, HR', 'Syngenta India'],
];
const GC_ORIGIN = 'Survey No. 1934, NH-48, Near Darshan Hotel, Village # Degam, Taluka # Chikhli, Degam-396530, Gujarat';
const GC = [
  ['26081239RM', GC_ORIGIN, 'M/S SUNSHINE ENTERPRISES Tejasvini Praful Soni Hedgewar nagar, DHARANGAON, DHARANGAON, MAHARASHTRA, 425105,IN MOB:8669148300'],
  ['260812UCZX', 'Survey No.644, Orpat Industrial Estate, Near Surajbar Bridge, Orpat Nagar, 8-A National Highway, Vandhia, Samakhiyali, Bhachau, Kutch - 370150 GSTIN :24ABDCS3684B1ZJ PAN :ABDCS3684B', 'M/S Balaji Traders,192/115a, Prabhakar Nagar,Diwedi Marg,Bai ka Bagh,Etawah-206001,Uttar Pradesh'],
  ['2608115VVB', GC_ORIGIN, 'M/S Rudransh Electrical Gut No 13 Plot No 22, Ram Nagar Kautha Nanded Waghala (M Corp), Navin Bridge, Nanded, Santoshi Mata MOB:8866950131 Nanded-431603'],
];

(async () => {
  if (typeof boot === 'function') await boot();
  const now = Date.now();
  let i = 0;
  const closesAt = () => now + (18 + (i += 3)) * 60_000;

  const seed = (load, platformKey) => requests.createForLoad(Object.assign({
    equipment: '32ft SXL', units: 1, closesAt: closesAt(), startsAt: now - 60_000,
    status: 'live', closeModelKnown: true,
  }, load), { deadlineAt: now + 15 * 60_000, platformKey });

  // Interleave so a screenshot of the top of the list always holds rows from both portals.
  for (let n = 0; n < Math.max(SP.length, GC.length); n += 1) {
    if (SP[n]) {
      const [id, origin, destination, companyName] = SP[n];
      await seed({
        id, companyName, lane: { origin, destination }, weight: 21, weightUnit: 'MT',
        points: [
          { kind: 'pickup', address: `Havells India Ltd., ${origin}, India 182101` },
          { kind: 'drop', address: `Warehouse 7, ${destination}, India 852131` },
        ],
      }, 'sp');
    }
    if (GC[n]) {
      const [id, origin, destination] = GC[n];
      await seed({
        id, companyName: 'Waaree Energies Ltd.', lane: { origin, destination },
        laneParsed: parseGoCometLane({ origin, destination, origin_zip_code: null, destination_zip_code: null }),
      }, 'gocomet');
    }
  }

  // server.js binds its own listener on PORT at require time - do NOT open a second one. Wait for it.
  const ready = async () => { try { await fetch(`http://127.0.0.1:${PORT}/api/price-requests`); return true; } catch (_) { return false; } };
  for (let n = 0; n < 100 && !(await ready()); n += 1) await new Promise((r) => setTimeout(r, 100));

  // The Lane column's values, dumped whether or not a browser is available - the picture is for the
  // client, but the strings are what a reviewer actually checks.
  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/price-requests`)).json();
  fs.writeFileSync(path.join(OUT, `${LABEL}-lane-column.json`), JSON.stringify(
    list.requests.map((r) => ({
      loadId: r.loadId,
      portal: r.platformKey,
      laneColumn: r.load.laneDisplay
        ? `${r.load.laneDisplay.origin} -> ${r.load.laneDisplay.destination}`
        : `${r.load.laneParsed?.origin?.label || r.load.lane?.origin} -> ${r.load.laneParsed?.destination?.label || r.load.lane?.destination}`,
      subRows: (r.load.laneDisplay?.points || r.load.points || []).length,
    })), null, 2));

  if (!CHROME) { console.log('NO CHROME FOUND - wrote the lane column as JSON only'); process.exit(0); }

  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const p = await browser.newPage();
  await p.setViewport({ width: 1500, height: 1100, deviceScaleFactor: 2 });
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
  // The worklist is a client-side fetch, so networkidle alone can screenshot an empty table.
  await p.waitForFunction(() => document.querySelectorAll('tbody tr').length > 4, { timeout: 20000 });
  const file = path.join(OUT, `${LABEL}-console-worklist.png`);
  await p.screenshot({ path: file, fullPage: true });
  console.log(`  ${file}`);

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
