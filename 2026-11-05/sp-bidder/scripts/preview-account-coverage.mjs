// A picture of the Accounts page when a login has lost its branch scope - the 18-Sep-2026
// incident, where `master` fell from 259 branches to 13 and four enrolled customers went dark
// while the card kept saying "Connected".
//
// Boots a bidder in MOCK mode, seeds the accounts (and their branch metadata) with the shape read
// off the live box on 19 Sep, and drives the shipped console with headless Chrome. The seed is
// identical for both runs, so the only difference between before/after is the console itself.
//
//   node scripts/preview-account-coverage.mjs --out <dir> [--label before|after]
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

const PORT = arg('port', String(4800 + Math.floor(Math.random() * 200)));
process.env.PORT = PORT;
process.env.HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(OUT, '.state-'));
// The global soft-close opt-in, as it reads on the box (enabled, live, 13 shippers). It is an
// independent admission path checked AHEAD of the allowlist, so it is the declaration that makes
// "no login can see Havells" a fact about the estate rather than about one card.
process.env.SP_SOFT_CLOSE_ENABLED = '1';
process.env.SP_SOFT_CLOSE_MODE = 'live';
process.env.SP_SOFT_CLOSE_SHIPPERS = [
  'Havells', 'Dynamic Cables', 'Cords Cable', 'Payal Polyplast', 'Epack', 'Renewsys', 'Shriji',
  'KEI', 'Transrail', 'Vishal', 'Premier', 'Goodluck', 'Safex Chemicals',
].join(',');
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
const { MockSuperProcureAdapter } = require(path.join(ROOT, 'src', 'platform', 'mockAdapter.js'));
const { store, boot, stacks } = server;

const YEAR = 365 * 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();

// Branch metadata exactly as getHeader.branchList gives it, reduced to what the screen uses.
// `customer` is SP's freighterName. Counts and names are the live 19-Sep readings.
const spread = (customer, n, startId, namer) => Array.from({ length: n }, (_, i) => ({
  branchId: startId + i,
  name: namer ? namer(i) : `${customer} ${i + 1}`,
  customer,
  bidPermission: 2,
}));

const SEED = [
  {
    accountId: 'primary', label: 'Primary', carrierId: 10686, tokenEnv: 'SP_TOKEN',
    allowlist: { shippers: ['Syngenta', 'Renewsys'], lanes: [], hardCloseOnly: true },
    tokenExp: now + YEAR, tokenIat: now - 45 * 86_400_000,
    scope: { count: 48, prevCount: 49, changedAt: now - 14 * 86_400_000 },
    branches: [
      ...spread('Walkaroo ECC', 39, 71131),
      ...spread('Renewsys India Private Limited', 5, 77902, (i) => ['Patalganga', 'Hyderabad', 'REN-P', 'REN-H', 'Bengaluru'][i]),
      ...spread('MAHINDRA AGRI SOLUTIONS LTD', 1, 80250, () => 'Nashik'),
      ...spread('RAYZON SOLAR PVT LTD', 1, 82439, () => 'Surat'),
      ...spread('APAR', 1, 93220, () => 'Umbergaon'),
      ...spread('Syngenta India Pvt Ltd', 1, 93533, () => 'Indore'),
    ],
  },
  {
    accountId: 'neemrana', label: 'Neemrana', carrierId: 33732, tokenEnv: 'SP_TOKEN_5',
    allowlist: { shippers: ['__none__'], lanes: [], hardCloseOnly: true },
    tokenExp: now + YEAR, tokenIat: now - 45 * 86_400_000,
    scope: { count: 61, prevCount: 60, changedAt: now - 37 * 86_400_000 },
    branches: spread('Ashirvad Pipes Pvt Ltd', 61, 102012),
  },
  {
    accountId: 'master', label: 'Best Roadways (Master)', carrierId: 2667, tokenEnv: 'SP_TOKEN_7', spUser: 'Staff User',
    allowlist: { shippers: ['Tata Consumer', 'ADAMA', 'Havells', 'KEI'], lanes: [], hardCloseOnly: true },
    loginEmail: 'bidding@bestroadways.com',
    tokenExp: now + YEAR, tokenIat: now - 31 * HOUR,
    // The incident: 259 -> 13, 258 removed, one kept. Confirmed six-hourly ever since.
    scope: { count: 13, prevCount: 259, changedAt: now - 31 * HOUR, confirmedAt: now - 2 * HOUR, added: 12, removed: 258 },
    branches: [
      ...spread('Demo on Prod', 12, 217429, (i) => `Demo Branch ${i + 1}`),
      ...spread('Transrail Lighting Limited', 1, 40662, () => 'Spot- Deoli'),
    ],
  },
  {
    accountId: 'branch-login-2', label: 'Branch login 2', carrierId: 88168, tokenEnv: 'SP_TOKEN_8',
    allowlist: { shippers: ['__none__'], lanes: [], hardCloseOnly: false },
    loginPhone: '+919000000011',
    tokenExp: now + YEAR, tokenIat: now - 44 * 86_400_000,
    scope: { count: 211, prevCount: 206, changedAt: now - 44 * 86_400_000 },
    branches: [
      ...spread('Tata Consumer Product Ltd', 206, 204),
      ...spread('Durian Industries Ltd', 3, 9001),
      ...spread('BG', 1, 173, () => 'BorosilLimited(Govindgarh)'),
      ...spread('Syngenta India Pvt Ltd', 1, 9101, () => 'Pune'),
    ],
  },
  {
    accountId: 'rallis', label: 'Rallis India', carrierId: 132, tokenEnv: 'SP_TOKEN_RALLIS',
    allowlist: { shippers: ['Rallis'], lanes: [], hardCloseOnly: true },
    loginPhone: '+919000000012',
    // White-label tenant: an 8-hour session, which is why the badge must read hours not days.
    tokenExp: now + 5 * HOUR, tokenIat: now - 3 * HOUR,
    scope: { count: 72, prevCount: 72, changedAt: null },
    branches: spread('Rallis India Limited', 72, 300001),
  },
  {
    accountId: 'rakesh-kapoor-s-clients', label: "Rakesh Kapoor's Clients", carrierId: 5667, tokenEnv: 'SP_TOKEN_9',
    allowlist: null, // inherits the global list - the one account that does
    tokenExp: now + YEAR, tokenIat: now - 30 * 86_400_000,
    scope: { count: 6, prevCount: 6, changedAt: null },
    branches: [
      ...spread('Automat Group', 4, 500001),
      ...spread('Premier Polyfilm Ltd.', 1, 500101, () => 'Sikandrabad'),
      ...spread('VISHAL PIPES LIMITED', 1, 500201, () => 'Sikandrabad - PMT'),
    ],
  },
];

(async () => {
  await boot();

  // Mock mode builds one implicit primary stack at module level. Keep its engine and scheduler and
  // hand the same pair to every seeded stack: /api/engine reduces over stacks reading
  // `s.engine.snapshot()`, so a stack without one 500s the whole console shell. The engine is not
  // what this preview is about - the accounts payload is.
  const tmpl = stacks[0];
  stacks.length = 0;
  for (const s of SEED) {
    const account = {
      accountId: s.accountId, label: s.label, tokenEnv: s.tokenEnv, enabled: true,
      carrierId: s.carrierId, branchIds: s.branches.map((b) => b.branchId),
      allowlist: s.allowlist, createdAt: now - YEAR,
    };
    const adapter = new MockSuperProcureAdapter(server.sim || {}, {});
    // The console reads identity off adapter.account when the real adapter has logged in; mock has
    // no login, so hand it the same shape rather than teaching the route about mock.
    adapter.account = {
      carrierId: s.carrierId, branchIds: account.branchIds,
      company: s.label, user: s.spUser || null, tokenExp: s.tokenExp, tokenIat: s.tokenIat,
    };
    stacks.push({
      account, adapter, tag: { accountId: s.accountId, label: s.label },
      engine: tmpl && tmpl.engine, scheduler: tmpl && tmpl.scheduler, discovery: null,
    });

    await store.putDoc('accounts', s.accountId, account);
    // The new collection the after-console reads. The before-console ignores it entirely, which is
    // exactly the contrast these two screenshots are for.
    // Seed the shape saveBranches actually writes. `shrankFrom` is what the card reads, and it is
    // carried across unchanged confirmations - unlike accountScope.prevCount, which an earlier
    // version of this seed used and which the real writer collapses to the current count within
    // one refresh cycle. Seeding that produced screenshots of a state production cannot hold.
    await store.putDoc('accountBranches', s.accountId, {
      accountId: s.accountId,
      branches: s.branches,
      count: s.branches.length,
      shrankFrom: s.scope && s.scope.prevCount > s.branches.length ? s.scope.prevCount : null,
      updatedAt: (s.scope && s.scope.confirmedAt) || now - 6 * HOUR,
    });
    if (s.loginPhone || s.loginEmail) {
      await store.putDoc('accountContacts', s.accountId, {
        accountId: s.accountId, phone: s.loginPhone || null, email: s.loginEmail || null,
      });
    }
  }

  const listening = server.app.listen ? null : null;
  void listening;

  // What the page asserts, dumped whether or not a browser is available - the picture is for the
  // client, the JSON is what a reviewer checks.
  // --serve: leave the seeded backend up and hand the port to a vite dev server, so the panel can
  // actually be clicked. No browser, no screenshots, no exit.
  if (argv.includes('--serve')) {
    console.log('');
    console.log('  seeded backend listening on http://127.0.0.1:' + PORT);
    console.log('  accounts: ' + SEED.map((s) => s.accountId).join(', '));
    console.log('  now run:  cd dashboard && npm run dev   ->  http://localhost:4330');
    console.log('');
    return; // express keeps the process alive; nothing below runs
  }

  const res = await fetch(`http://127.0.0.1:${PORT}/api/accounts`);
  const body = await res.json();
  fs.writeFileSync(path.join(OUT, `${LABEL}-accounts.json`), JSON.stringify(body, null, 2));
  console.log(`  ${LABEL}: ${(body.accounts || []).length} accounts, estate=${JSON.stringify(body.estate || null)}`);

  if (!CHROME) { console.log('NO CHROME FOUND - wrote the accounts payload as JSON only'); process.exit(0); }

  const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));
  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const shot = async (name, width, height, prep) => {
    const p = await browser.newPage();
    await p.setViewport({ width, height, deviceScaleFactor: 2 });
    // The console is a single route; the landing page is a localStorage preference, not a URL.
    await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => localStorage.setItem('bidcommand.landingPage', 'accounts'));
    await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle0' });
    await p.waitForFunction(() => document.body.innerText.includes('Best Roadways (Master)'), { timeout: 20000 });
    if (prep) await prep(p);
    const file = path.join(OUT, `${LABEL}-${name}.png`);
    await p.screenshot({ path: file, fullPage: true });
    console.log(`  ${file}`);
    await p.close();
  };

  await shot('accounts-desktop', 1200, 1000);
  await shot('accounts-phone', 400, 900);
  // The expanded branch list only exists after the change; harmless no-op before it.
  await shot('accounts-expanded', 1200, 1000, async (p) => {
    const opened = await p.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /show branches/i.test(b.textContent || ''));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (opened) await p.waitForFunction(() => /hide branches/i.test(document.body.innerText), { timeout: 5000 }).catch(() => {});
  });

  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
