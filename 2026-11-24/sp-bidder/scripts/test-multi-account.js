'use strict';
/**
 * Phase 2 two-account auth routing test (deterministic, offline, no network):
 *   A. accounts-as-data helpers: implicit-primary fallback, token-in-record
 *      rejection, env-ref token resolution, per-account allowlist + overlap warning,
 *      per-account intent-file namespacing (primary keeps today's exact path).
 *   B. discovery: per-account allowlist scoping, cross-account single-price-request
 *      dedupe (first enabled account wins, even on concurrent ticks), and the
 *      owner-scoped reconcile (poller A never drops poller B's asks).
 *   C. durable-scheduler isolation: two accounts' intents never collide.
 *   D. server boot with TWO mock accounts -> two stacks; /api/accounts; account-tagged
 *      /api/auctions rows; global kill/resume stops + restores BOTH engines.
 *   E. add-account script (mock platform): dry-run writes nothing, the write path
 *      persists the record + materializes primary, and the token NEVER hits disk.
 *   F. boot smoke: a fresh server with no accounts configured starts single-stack.
 */
const fs = require('fs'); // allowed: test harness (temp dirs + subprocess smoke), not app state
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// env BEFORE any src require: mock platform, ephemeral port, isolated data dir.
delete process.env.PLATFORM;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
delete process.env.SP_DEMO_SEED;
process.env.STORE_BACKEND = 'memory';
process.env.PORT = '0';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spmulti-'));
process.env.SP_DATA_DIR = TMP;

const config = require('../src/config');
const { createStore } = require('../src/store');
const { loadAccounts, validateAccount, resolveAccountToken, effectiveAllowlist, allowlistOverlapWarning, branchOverlaps, branchOverlapWarnings } = require('../src/auth/accounts');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function httpReq(port, method, p, body) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: '127.0.0.1', port, method, path: p,
        headers: Object.assign({ 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` },
          data ? { 'content-length': Buffer.byteLength(data) } : {}) },
      (res) => { let buf = ''; res.on('data', (c) => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json: j }); }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** Spawn `node src/web/server.js` with env overrides; resolve its stdout once it listens. */
function bootSmoke(envOverrides) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, envOverrides);
    delete env.PLATFORM;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'web', 'server.js')], { env });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('boot smoke timed out; output so far:\n' + out)); }, 20_000);
    const onData = (d) => {
      out += d.toString();
      if (/listening http/.test(out)) {
        clearTimeout(timer);
        child.kill();
        resolve(out);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { if (!/listening http/.test(out)) { clearTimeout(timer); reject(new Error(`server exited (${code}) before listening:\n` + out)); } });
  });
}

(async () => {
  const now = Date.now();

  // ---- A. accounts-as-data helpers -------------------------------------------
  {
    const s = createStore({ backend: 'memory' });
    const accs = await loadAccounts(s);
    ok(accs.length === 1 && accs[0].accountId === 'primary' && accs[0].tokenEnv === 'SP_TOKEN'
      && accs[0].enabled === true && accs[0].implicit === true, 'empty collection -> the one implicit primary (zero-config default)');

    ok(config.intentsFileFor('primary') === config.intentsFile, "intentsFileFor('primary') keeps today's exact path (live state survives the upgrade)");
    ok(config.intentsFileFor(null) === config.intentsFile, 'intentsFileFor(null) is the legacy path');
    ok(config.intentsFileFor('acc2') === path.join(config.dataDir, 'intents.acc2.json'), 'other accounts get suffixed intent files');
    ok(config.sessionFileFor('acc2') === path.join(config.dataDir, 'session.acc2.json'), 'other accounts get suffixed session files');

    let threw = null;
    try { validateAccount({ accountId: 'acc2', tokenEnv: 'SP_TOKEN_2', token: 'eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjoxfQ.sig' }); } catch (e) { threw = e.code; }
    ok(threw === 'BAD_ACCOUNT', "a record carrying a 'token' field is rejected (secrets stay by-reference)");
    threw = null;
    try { validateAccount({ accountId: 'acc2', tokenEnv: 'SP_TOKEN_2', note: 'eyJhbGciOiJIUzI1NiJ9.eyJzbXVnZ2xlZCI6MX0.abcdefghij' }); } catch (e) { threw = e.code; }
    ok(threw === 'BAD_ACCOUNT', 'a JWT smuggled into ANY record field is rejected');
    threw = null;
    try { validateAccount({ accountId: '../evil', tokenEnv: 'SP_TOKEN_2' }); } catch (e) { threw = e.code; }
    ok(threw === 'BAD_ACCOUNT', 'accountId is slug-validated (it names the intents file)');

    const env = { SP_TOKEN_2: 'Bearer  tok-2-value ' };
    ok(resolveAccountToken({ accountId: 'acc2', tokenEnv: 'SP_TOKEN_2' }, env) === 'tok-2-value', 'resolveAccountToken reads the named env var and strips Bearer');
    threw = null;
    try { resolveAccountToken({ accountId: 'acc2', tokenEnv: 'SP_TOKEN_2' }, {}); } catch (e) { threw = e.message; }
    ok(/SP_TOKEN_2/.test(threw || ''), 'a missing token env fails loudly, naming the exact var to set');

    const g = { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true };
    ok(effectiveAllowlist({ accountId: 'a' }, g) === g, 'no per-account allowlist -> the global one (today\'s semantics)');
    const own = { shippers: ['Renewsys'], lanes: [], hardCloseOnly: false };
    ok(effectiveAllowlist({ accountId: 'a', allowlist: own }, g) === own, 'a per-account allowlist overrides the global one');

    const A = { accountId: 'a', enabled: true }, B = { accountId: 'b', enabled: true };
    ok(allowlistOverlapWarning([A, B], { shippers: [] }) === null, 'two accounts with empty (fail-closed) scopes each bid nothing -> no overlap');
    ok(allowlistOverlapWarning([
      { accountId: 'a', enabled: true, allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true } },
      { accountId: 'b', enabled: true, allowlist: { shippers: ['Renewsys'], lanes: [], hardCloseOnly: true } },
    ], { shippers: [] }) === null, 'disjoint per-account shipper scopes -> no warning');
    ok(!!allowlistOverlapWarning([
      { accountId: 'a', enabled: true, allowlist: { shippers: ['Syngenta'], lanes: [], hardCloseOnly: true } },
      { accountId: 'b', enabled: true, allowlist: { shippers: ['Syngenta India'], lanes: [], hardCloseOnly: true } },
    ], { shippers: [] }), 'word-prefix shipper collision (Syngenta vs Syngenta India) -> warning');
    ok(allowlistOverlapWarning([A], { shippers: [] }) === null, 'a single enabled account never warns');

    // ---- branch-ID overlap: ground truth (real SP branchIds), not the shipper-name heuristic ----
    ok(branchOverlaps([
      { accountId: 'a', enabled: true, branchIds: [1, 2, 3] },
      { accountId: 'b', enabled: true, branchIds: [3, 4] },
    ]).length === 1, 'accounts sharing a real branchId -> one overlap entry');
    const [ov] = branchOverlaps([
      { accountId: 'a', enabled: true, branchIds: [1, 2, 3] },
      { accountId: 'b', enabled: true, branchIds: [3, 4] },
    ]);
    ok(ov.a === 'a' && ov.b === 'b' && ov.sharedBranchIds.length === 1 && ov.sharedBranchIds[0] === 3,
      'overlap entry names both accounts + the exact shared branch id(s)');
    ok(branchOverlaps([
      { accountId: 'a', enabled: true, branchIds: [1, 2] },
      { accountId: 'b', enabled: true, branchIds: [3, 4] },
    ]).length === 0, 'disjoint branchIds -> no overlap');
    ok(branchOverlaps([
      { accountId: 'a', enabled: true, branchIds: [] },
      { accountId: 'b', enabled: true, branchIds: [] },
    ]).length === 0, 'two not-yet-logged-in accounts (empty branchIds) are NOT treated as overlapping (unlike the shipper heuristic\'s empty-matches-all rule)');
    ok(branchOverlaps([
      { accountId: 'a', enabled: true, branchIds: [1] },
      { accountId: 'b', enabled: false, branchIds: [1] },
    ]).length === 0, 'a disabled account never counts toward overlap');
    ok(/share 1 real SuperProcure branch/.test(branchOverlapWarnings([
      { accountId: 'a', enabled: true, branchIds: [1, 2, 3] },
      { accountId: 'b', enabled: true, branchIds: [3, 4] },
    ])[0] || ''), 'branchOverlapWarnings renders a readable line naming the exact overlap');
  }

  // ---- B. discovery: per-account scoping + cross-account dedupe ---------------
  {
    const store = createStore({ backend: 'memory' });
    const requests = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
    const gate = { chain: Promise.resolve() };
    const base = { closesAt: now + 10 * 60_000, startsAt: now - 1000, status: 'live', softClose: false };
    const loads = [
      { id: 'SY1', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', ...base },
      { id: 'RE1', lane: { origin: 'C', destination: 'D' }, companyName: 'Renewsys India', ...base },
    ];
    const adapter = { listAuctions: async () => loads };
    const tagA = { accountId: 'primary', label: 'Primary' };
    const tagB = { accountId: 'acc2', label: 'Acme' };
    const pollerA = new DiscoveryPoller({ adapter, requests, notifier, account: tagA, gate,
      config: { allowlist: { shippers: ['Syngenta'] }, priceDeadlineLeadMs: 90_000 } });
    const pollerB = new DiscoveryPoller({ adapter, requests, notifier, account: tagB, gate,
      config: { allowlist: { shippers: ['Renewsys'] }, priceDeadlineLeadMs: 90_000 } });

    await pollerA.tick();
    await pollerB.tick();
    const rSY = await requests.getByLoad('SY1');
    const rRE = await requests.getByLoad('RE1');
    ok(rSY && rSY.account && rSY.account.accountId === 'primary', 'Syngenta load -> priced by account A (its allowlist)');
    ok(rRE && rRE.account && rRE.account.accountId === 'acc2', 'Renewsys load -> priced by account B (its allowlist)');
    ok((await requests.listAll()).length === 2, 'disjoint scopes -> one request per load, no cross-talk');

    // owner-scoped reconcile: RE1 is OUTSIDE A's allowlist but is B's request - a
    // re-tick of A must not drop it (the pre-fix bug with per-account allowlists).
    await pollerA.tick();
    ok(!!(await requests.getByLoad('RE1')), "A's reconcile leaves B's awaiting request alone (owner-scoped)");

    // overlap: BOTH accounts can see the same new load -> exactly ONE price request,
    // owned by the first account in order, even when the ticks run concurrently.
    loads.push({ id: 'BOTH1', lane: { origin: 'E', destination: 'F' }, companyName: 'Syngenta Renewsys JV', ...base });
    await Promise.all([pollerA.tick(), pollerB.tick()]);
    const all = (await requests.listAll()).filter((r) => r.loadId === 'BOTH1');
    ok(all.length === 1, `an overlapping load gets exactly ONE price request (got ${all.length})`);
    ok(all[0].account && all[0].account.accountId === 'primary', 'the FIRST enabled account owns the shared load (deterministic dedupe)');

    // untagged poller (single-account wiring) keeps today's behaviour: no account on the request
    const store2 = createStore({ backend: 'memory' });
    const requests2 = new PriceRequestStore({ store: store2, marginsPct: [12.6], minMarginPct: 6.3 });
    const solo = new DiscoveryPoller({ adapter: { listAuctions: async () => [loads[0]] }, requests: requests2, notifier,
      config: { allowlist: { shippers: ['Syngenta'] }, priceDeadlineLeadMs: 90_000 } }); // loads[0] is Syngenta; explicit list (empty now fails closed)
    await solo.tick();
    ok((await requests2.getByLoad('SY1')).account === null, 'single-account (untagged) requests stay account:null - identical to today');
  }

  // ---- C. per-account intent files: no cross-account collision ----------------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spsched-'));
    const f1 = path.join(dir, 'intents.json');
    const f2 = path.join(dir, 'intents.acc2.json');
    const s1 = new DurableScheduler(f1);
    const s2 = new DurableScheduler(f2);
    s1.upsert({ auctionId: 'A-1', closesAt: now + 60_000, status: 'armed', firedRungs: [] });
    s2.upsert({ auctionId: 'B-1', closesAt: now + 60_000, status: 'armed', firedRungs: [] });
    const r1 = new DurableScheduler(f1);
    const r2 = new DurableScheduler(f2);
    ok(!!r1.get('A-1') && !r1.get('B-1'), "account 1's intents file holds only its own intents");
    ok(!!r2.get('B-1') && !r2.get('A-1'), "account 2's intents file holds only its own intents");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- D. two mock accounts boot two stacks; global kill stops both -----------
  {
    const srv = require('../src/web/server');
    ok(srv.stacks.length === 1 && srv.stacks[0].account.accountId === 'primary',
      'pre-boot: module level has the one implicit-primary stack (existing tests rely on it)');
    await srv.store.putDoc('accounts', 'primary', { accountId: 'primary', label: 'Primary', tokenEnv: 'SP_TOKEN', enabled: true, createdAt: 1 });
    await srv.store.putDoc('accounts', 'acc2', { accountId: 'acc2', label: 'Acme Branch', tokenEnv: 'SP_TOKEN_2', enabled: true, createdAt: 2 });
    const server = await srv.boot();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    ok(srv.stacks.length === 2, `boot with two accounts builds two stacks (got ${srv.stacks.length})`);
    ok(srv.stacks[1].scheduler.filePath === config.intentsFileFor('acc2'), "second stack's intents are namespaced (intents.acc2.json)");
    ok(srv.stacks[0].engine !== srv.stacks[1].engine, 'each account gets its OWN engine instance');

    const accs = await httpReq(port, 'GET', '/api/accounts');
    ok(accs.status === 200 && accs.json.accounts.length === 2, '/api/accounts lists both accounts');
    ok(accs.json.accounts[1].label === 'Acme Branch' && accs.json.accounts[1].tokenEnv === 'SP_TOKEN_2', '/api/accounts carries label + tokenEnv (the name, never the token)');

    // arm demo auctions on the primary engine, then check the aggregated rows are account-tagged
    const seeded = await httpReq(port, 'POST', '/api/demo/seed', {});
    ok(seeded.status === 200 && seeded.json.seeded.length === 3, 'demo seed arms 3 auctions on the primary stack');
    const aRes = await httpReq(port, 'GET', '/api/auctions');
    ok(aRes.json.auctions.length === 3 && aRes.json.auctions.every((r) => r.account && r.account.label === 'Primary'),
      '/api/auctions rows carry the account tag when >1 account exists');
    const eng0 = await httpReq(port, 'GET', '/api/engine');
    ok(eng0.json.armed === 3, 'engine status aggregates armed counts across accounts');

    // GLOBAL kill: one tap stops EVERY account's engine
    const killed = await httpReq(port, 'POST', '/api/engine/kill', { reason: 'multi-account test' });
    ok(killed.status === 200 && srv.stacks.every((s) => s.engine.killed), 'kill stops BOTH engines (one kill stops everything)');
    const resumed = await httpReq(port, 'POST', '/api/engine/resume', {});
    ok(resumed.status === 200 && srv.stacks.every((s) => !s.engine.killed),
      'resume lifts the kill on BOTH engines (back to live)');

    for (const s of srv.stacks) for (const m of s.engine.snapshot()) s.engine.stop(m.auctionId);
    server.close();
  }

  // ---- E. add-account script: dry-run, write path, token never persisted ------
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spacct-'));
    const FAKE_TOKEN = 'FAKEHEADERxxxxxxxx.FAKEPAYLOADyyyyyyyy.tok2secretsig';
    const env = Object.assign({}, process.env, {
      SP_DATA_DIR: dir, STORE_BACKEND: 'file', SP_TOKEN: 'primary-token-present',
    });
    const script = path.join(__dirname, 'add-account.js');
    const run = (args) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });

    const dry = run(['--mock', '--dry-run', '--token', FAKE_TOKEN, '--id', 'acc2', '--token-env', 'SP_TOKEN_2']);
    ok(dry.status === 0, `dry-run exits 0 (got ${dry.status}: ${dry.stderr})`);
    ok(/DRY RUN/.test(dry.stdout), 'dry-run says so and validates the account');
    ok(/carrierId : 2668/.test(dry.stdout), 'dry-run prints the DERIVED carrierId (mock platform)');
    ok(!fs.existsSync(path.join(dir, 'accounts.json')), 'dry-run writes nothing');
    ok(!dry.stdout.includes('tok2secret') && !dry.stderr.includes('tok2secret'), 'dry-run never prints the token back');

    const wet = run(['--mock', '--token', FAKE_TOKEN, '--id', 'acc2', '--token-env', 'SP_TOKEN_2']);
    ok(wet.status === 0, `write run exits 0 (got ${wet.status}: ${wet.stderr})`);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
    ok(written.acc2 && written.acc2.tokenEnv === 'SP_TOKEN_2' && written.acc2.carrierId === 2668 && written.acc2.enabled === true,
      'account record persisted with tokenEnv NAME + derived carrierId/branchIds');
    ok(written.primary && written.primary.tokenEnv === 'SP_TOKEN', 'first explicit account materializes the primary record too (SP_TOKEN keeps bidding)');
    ok(/SP_TOKEN_2=/.test(wet.stdout) && /pm2 restart bid-command/.test(wet.stdout), 'prints the exact .env line to add + the pm2 restart step');
    ok(!wet.stdout.includes('tok2secret'), 'write run never prints the token back');
    // the token must not exist ANYWHERE on disk - scan every file in the data dir
    const files = [];
    (function walk(d) { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); if (ent.isDirectory()) walk(p); else files.push(p); } })(dir);
    ok(files.length > 0 && files.every((f) => !fs.readFileSync(f, 'utf8').includes('tok2secret')), 'token never persisted to ANY file in the data dir');

    const dup = run(['--mock', '--token', FAKE_TOKEN, '--id', 'acc2']);
    ok(dup.status === 1 && /already exists/.test(dup.stderr), 're-adding the same accountId is refused');

    // --email: rejects an invalid address, trims whitespace before validating (a value pasted
    // straight from the branch survey excel commonly carries it), and writes via patchDoc - not
    // putDoc - so it merges onto (never clobbers) a phone already on file for that accountId.
    const badEmail = run(['--mock', '--token', FAKE_TOKEN, '--id', 'acc3', '--token-env', 'SP_TOKEN_3', '--email', 'not-an-email']);
    ok(badEmail.status === 1 && /not a valid email/.test(badEmail.stderr), '--email rejects an invalid address');

    const contactsFile = path.join(dir, 'accountContacts.json');
    fs.writeFileSync(contactsFile, JSON.stringify({ acc3: { accountId: 'acc3', phone: '+919812345671', updatedAt: 0 } }));
    // the mock adapter's fixed identity (branchIds [101,102]) makes acc3 collide with acc2
    // (saved above) by construction - --confirm-overlap here is just clearing that gate, not
    // what this particular run is testing (see the dedicated overlap tests below for that).
    const withEmail = run(['--mock', '--token', FAKE_TOKEN, '--id', 'acc3', '--token-env', 'SP_TOKEN_3', '--email', '  ops@bestroadways.com  ', '--confirm-overlap']);
    ok(withEmail.status === 0, `--email write run exits 0 (got ${withEmail.status}: ${withEmail.stderr})`);
    ok(/email {5}: ops@bestroadways\.com {2}\(saved/.test(withEmail.stdout), '--email is trimmed before the summary echo, not just before storage');
    const contacts = JSON.parse(fs.readFileSync(contactsFile, 'utf8'));
    ok(contacts.acc3.email === 'ops@bestroadways.com', '--email is trimmed + lowercased before it is stored');
    ok(contacts.acc3.phone === '+919812345671', 'writing the email via patchDoc did NOT clobber a phone already on file for this accountId (the putDoc bug this test pins)');

    // branch-overlap gate: the mock adapter always returns the SAME fixed identity
    // (branchIds [101,102]), so a fourth mock account collides with acc2/acc3 by construction.
    const dryOverlap = run(['--mock', '--dry-run', '--token', FAKE_TOKEN, '--id', 'acc4', '--token-env', 'SP_TOKEN_4']);
    ok(dryOverlap.status === 0, `dry-run with overlap still exits 0 (got ${dryOverlap.status})`);
    ok(/Branch overlap with 2 existing/.test(dryOverlap.stdout), 'dry-run SURFACES the overlap (against both acc2 and acc3) even though nothing is written');

    const wetBlocked = run(['--mock', '--token', FAKE_TOKEN, '--id', 'acc4', '--token-env', 'SP_TOKEN_4']);
    ok(wetBlocked.status === 1 && /--confirm-overlap/.test(wetBlocked.stderr), 'write is REFUSED without --confirm-overlap when a real branch overlap exists');
    ok(!JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8')).acc4, 'the blocked account is never persisted');

    const wetConfirmed = run(['--mock', '--token', FAKE_TOKEN, '--id', 'acc4', '--token-env', 'SP_TOKEN_4', '--confirm-overlap']);
    ok(wetConfirmed.status === 0, `--confirm-overlap allows the write through (got ${wetConfirmed.status}: ${wetConfirmed.stderr})`);
    const written2 = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
    ok(written2.acc4 && written2.acc4.enabled === true, 'the confirmed account is saved despite the overlap');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- F. boot smoke: fresh server, NO accounts configured -> single stack ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spboot-'));
    const out = await bootSmoke({ SP_DATA_DIR: dir, STORE_BACKEND: 'file', PORT: '0' });
    ok(/mode=mock listening/.test(out), 'no-accounts boot starts clean (single implicit-primary stack)');
    ok(!/accounts:/.test(out), 'no-accounts boot prints NO accounts line (output identical to today)');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
