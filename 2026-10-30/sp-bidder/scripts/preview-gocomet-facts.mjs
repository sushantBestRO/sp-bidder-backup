// Before/after screenshots of what a GoComet load looks like to a pricer.
//
// Boots a bidder in MOCK mode with a GoComet stack registered, seeds loads built from the CAPTURED
// live enquiry (scripts/fixtures/gocomet/), and drives the real routes with headless Chrome. The
// point is a picture of the shipped bytes, not of a mock-up.
//
// The BEFORE side is rendered by a checkout of the base branch exported to a temp directory, so it
// is genuinely the old code rather than the new code with facts withheld. Pass --root to point one
// run at such an export; the driver script that builds both sides is preview-gocomet-facts.sh.
//
//   node scripts/preview-gocomet-facts.mjs --out <dir> [--root <tree>] [--label before|after]
//
// Output goes wherever --out says and MUST be outside the repo: scripts/deploy.sh ships the
// working tree, so a PNG left in here would be copied onto the client's box.
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

const PORT = arg('port', String(4400 + Math.floor(Math.random() * 200)));
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
const { GoCometAdapter } = require(path.join(ROOT, 'src', 'platform', 'gocometAdapter.js'));
const { requests, boot, stacks, app } = server;

const FIX = path.join(HERE, 'fixtures', 'gocomet');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LIST = readFix('spot-enquiries.list.json');
const DETAIL = readFix('enquiry-detail.json');
const KEY = '2608115VVB';
const CAPTURED_AT = Date.parse('2026-08-11T05:10:00.000Z');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(CAPTURED_AT / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

const GC_ACCOUNT = 'gocomet-primary';

/** The load exactly as the adapter maps it from the captured bytes, on whichever tree is loaded. */
async function mappedLoad() {
  const a = new GoCometAdapter({
    token, sleep: async () => {}, now: () => CAPTURED_AT,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes(`/enquiries/${KEY}/bidding-data`)) return resp(404, { error: 'n/a' });
      if (u.includes(`/enquiries/${KEY}`)) return resp(200, DETAIL);
      if (u.includes('/enquiries/spot')) return resp(200, LIST);
      return resp(404, { error: 'no_route' });
    },
  });
  const [l] = await a.listAuctions({ maxPages: 1 });
  return l;
}

function pushGoCometStack() {
  const adapter = new GoCometAdapter({ token: null, bidEnabled: true });
  const stack = {
    account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    tag: { accountId: GC_ACCOUNT, label: 'GoComet' },
    platformKey: 'gocomet',
    adapter,
    engine: { caps: adapter.capabilities(), snapshot: () => [], planPreview: () => ({ ladder: [46500, 44000, 42000], floor: 42000, rungCount: 3 }) },
  };
  const at = stacks.findIndex((s) => s.account && s.account.accountId === GC_ACCOUNT);
  if (at >= 0) stacks[at] = stack; else stacks.push(stack);
}

(async () => {
  if (typeof boot === 'function') await boot();
  pushGoCometStack();

  const base = await mappedLoad();
  const now = Date.now();
  const seed = (over) => requests.createForLoad({
    ...base, closesAt: now + 20 * 60_000, startsAt: now - 60_000, status: 'live',
    account: { accountId: GC_ACCOUNT, label: 'GoComet' }, ...over,
  }, { deadlineAt: now + 18 * 60_000, platformKey: 'gocomet' });

  // The live case, and the case that made the desk complain about the worklist: a record stored
  // before the lane parser existed, which carries no parsed lane of its own.
  const live = await seed({});
  await seed({ id: 'PRE-PARSER-RECORD', laneParsed: null });

  // server.js binds its own listener on PORT at require time - do NOT open a second one, which is
  // an EADDRINUSE against ourselves. Just wait for the port to answer.
  const ready = async () => { try { await fetch(`http://127.0.0.1:${PORT}/api/price-requests`); return true; } catch (_) { return false; } };
  for (let i = 0; i < 100 && !(await ready()); i += 1) await new Promise((r) => setTimeout(r, 100));
  const srv = { close() {} };

  if (!CHROME) {
    // Still leave something reviewable behind. A missing browser must not cost the whole run.
    const html = await (await fetch(`http://127.0.0.1:${PORT}/price/${live.id}`)).text();
    fs.writeFileSync(path.join(OUT, `${LABEL}-price-page.html`), html);
    console.log(`NO CHROME FOUND - wrote HTML only: ${path.join(OUT, `${LABEL}-price-page.html`)}`);
    srv.close(); process.exit(0);
  }

  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const shot = async (name, url, width, height, full = true) => {
    const p = await browser.newPage();
    await p.setViewport({ width, height, deviceScaleFactor: 2 });
    await p.goto(url, { waitUntil: 'networkidle0' });
    const file = path.join(OUT, `${LABEL}-${name}.png`);
    await p.screenshot({ path: file, fullPage: full });
    await p.close();
    console.log(`  ${file}`);
  };

  // Phone width is the real one: the capture link is opened off a WhatsApp message.
  await shot('price-page-phone', `http://127.0.0.1:${PORT}/price/${live.id}`, 400, 900);
  await shot('price-page-desktop', `http://127.0.0.1:${PORT}/price/${live.id}`, 900, 1000);

  // The worklist the desk works from. Served by the console bundle when one is present; the raw
  // payload is dumped either way so the Lane values can be read even without a build.
  const list = await (await fetch(`http://127.0.0.1:${PORT}/api/price-requests`)).json();
  fs.writeFileSync(path.join(OUT, `${LABEL}-worklist-lanes.json`), JSON.stringify(
    list.requests.map((r) => ({
      loadId: r.loadId,
      storedLaneParsed: r.load.laneParsed ? 'present' : 'ABSENT on the record',
      laneColumnWouldShow: [r.load.laneParsed?.origin?.label || r.load.lane?.origin,
        r.load.laneParsed?.destination?.label || r.load.lane?.destination],
    })), null, 2));
  if (fs.existsSync(path.join(ROOT, 'dashboard', 'dist', 'index.html'))) {
    await shot('console-worklist', `http://127.0.0.1:${PORT}/`, 1400, 900, false);
  } else {
    console.log('  (no dashboard/dist - console screenshot skipped, worklist JSON written instead)');
  }

  await browser.close();
  srv.close();
  console.log(`\n${LABEL}: done -> ${OUT}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
