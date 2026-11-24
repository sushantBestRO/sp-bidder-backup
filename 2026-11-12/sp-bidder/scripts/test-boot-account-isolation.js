'use strict';
/**
 * Regression for the 2026-07-11 incident: one account's SuperProcure login failing at
 * boot must not crash bidding for every OTHER enabled account. Before the fix, boot()'s
 * real-mode activation loop had no try/catch, so a single 401 propagated out of boot()
 * into `boot().catch(...) -> process.exit(1)` and took the whole process down for ~4.5
 * minutes - not just the broken account. Diagnosis: docs/diagnoses/2026-07-11_bidder-repeated-read-failures-23057405.md
 *
 * Deterministic, offline, no network: RealSuperProcureAdapter's login/connectSocket/
 * listAuctions are monkey-patched (module-level, shared prototype) before any account
 * activates, so which account "fails" is controlled purely by its token string.
 *
 *   A. Partial failure (in-process): 3 accounts, the middle one's login rejects ->
 *      boot() still resolves, the two healthy accounts are fully activated, the broken
 *      one is torn down + dropped from `stacks` (not left as a zombie), and a WhatsApp
 *      alert fires naming it.
 *   B. Total failure (subprocess): every enabled account's login rejects -> boot()
 *      still throws and the process still exits non-zero (the one genuinely fatal case
 *      that should keep failing loud).
 */
const fs = require('fs'); // allowed: test harness (temp dirs + subprocess), not app state
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// env BEFORE any src require: real platform (this bug only exists on the REAL boot path),
// ephemeral port, isolated data dir, in-memory store.
process.env.PLATFORM = 'real';
process.env.STORE_BACKEND = 'memory';
process.env.PORT = '0';
process.env.SP_ADMIN_PASS_HASH = 'test-hash'; // boot()'s gate only checks truthiness
process.env.SP_SESSION_SECRET = 'test-session-secret';
delete process.env.SP_DEMO_SEED;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spbootiso-'));
process.env.SP_DATA_DIR = TMP;
// which account "fails" is decided purely by its token containing BROKEN - no accountId
// awareness needed in the patched adapter methods.
process.env.SP_TOKEN = 'good-token-primary';
process.env.SP_TOKEN_2 = 'BROKEN-token-flaky';
process.env.SP_TOKEN_3 = 'good-token-2';
// A boot failure that is NOT an auth failure, so the alert fork is pinned in BOTH directions. Without
// it a change that routed every boot failure through the session-death copy would pass, and the desk
// would be told "the SuperProcure login is logged out" about a DNS outage.
process.env.SP_TOKEN_4 = 'NETFAIL-token-netfail';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const FAKE_IDENTITY = () => ({
  carrierId: 9001, branchIds: [1, 2, 3], isCarrier: true, company: 'Test Co',
  user: 'Test User', userId: 'u1', tokenExp: Date.now() + 365 * 86400000, serverTimeOffsetMs: 0,
});

function patchRealAdapter(RealSuperProcureAdapter) {
  RealSuperProcureAdapter.prototype.login = async function () {
    if (String(this.token || '').includes('BROKEN')) {
      const e = new Error('auth_failed_401');
      e.code = 'AUTH';
      throw e;
    }
    // No `code` at all - the shape a transport/config failure arrives in.
    if (String(this.token || '').includes('NETFAIL')) throw new Error('getaddrinfo ENOTFOUND api.superprocure.com');
    this.account = FAKE_IDENTITY();
    return this.account;
  };
  RealSuperProcureAdapter.prototype.connectSocket = async function () { return null; };
  RealSuperProcureAdapter.prototype.listAuctions = async function () { return []; };
}

(async () => {
  // ---- A. partial failure: one bad account never blocks the healthy ones ----
  {
    const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
    patchRealAdapter(RealSuperProcureAdapter);

    const srv = require('../src/web/server');
    await srv.store.putDoc('accounts', 'primary', { accountId: 'primary', label: 'Primary', tokenEnv: 'SP_TOKEN', enabled: true, createdAt: 1 });
    await srv.store.putDoc('accounts', 'flaky', { accountId: 'flaky', label: 'Flaky Branch', tokenEnv: 'SP_TOKEN_2', enabled: true, createdAt: 2 });
    await srv.store.putDoc('accounts', 'good2', { accountId: 'good2', label: 'Good Branch 2', tokenEnv: 'SP_TOKEN_3', enabled: true, createdAt: 3 });
    await srv.store.putDoc('accounts', 'netfail', { accountId: 'netfail', label: 'Netfail Branch', tokenEnv: 'SP_TOKEN_4', enabled: true, createdAt: 4 });

    const alerts = [];
    const originalAlert = srv.notifier.alert.bind(srv.notifier);
    srv.notifier.alert = async (kind, payload, opts) => { alerts.push({ kind, payload, opts }); return originalAlert(kind, payload, opts); };

    let bootError = null;
    let server = null;
    try { server = await srv.boot(); } catch (e) { bootError = e; }

    ok(!bootError, `boot() resolves despite one bad account (threw: ${bootError && bootError.message})`);
    ok(srv.stacks.length === 2, `the two healthy accounts stay up (got ${srv.stacks.length} stacks)`);
    ok(srv.stacks.every((s) => s.account.accountId !== 'flaky'), 'the broken account is dropped from stacks, not left as a zombie');
    ok(srv.stacks.some((s) => s.account.accountId === 'primary') && srv.stacks.some((s) => s.account.accountId === 'good2'),
      'both healthy accounts (primary, good2) are present');
    ok(srv.stacks.every((s) => s.adapter.account && s.adapter.account.carrierId === 9001), 'both healthy accounts actually logged in (adapter.account set)');
    ok(srv.stacks.every((s) => s.tag && s.tag.accountId), '2 accounts still remain (still >1) -> stay correctly tagged after the drop, not stripped to single-account output');

    // The fixture's login() throws with code AUTH (see patchRealAdapter), so this boot failure takes
    // the SESSION-DEATH fork: same template, same wording and same key shape the runtime latch uses,
    // so the desk reads one story whether the session died at boot or at 12:07 on a Tuesday. It no
    // longer renders the generic error copy with a raw `auth_failed_401` in it - that string is an
    // engineer's, and this message reaches the client's Director.
    const alert = alerts.find((a) => a.kind === 'error' && a.payload && a.payload.authDead);
    ok(!!alert, 'a WhatsApp-pipeline alert fires for the broken account');
    ok(!!alert && alert.payload.accountId === 'flaky' && alert.payload.accountLabel === 'Flaky Branch',
      'it names the account by its HUMAN label, not the internal id, and carries the id for the contact lookup');
    // Scanned over the payload's STRING fields, never JSON.stringify of the whole object. The payload
    // carries `since`, a live 13-digit Date.now(), and roughly one epoch in 200 contains the digit run
    // "401" - so the old whole-blob form reddened `npm test` at random on diffs that changed nothing,
    // which teaches people to re-run the gate instead of reading it. Jargon can only live in text, so
    // scanning the text is both stricter and deterministic. Generic over the keys on purpose: a string
    // field added to this payload later is covered without anyone remembering to extend the list.
    const jargon = (payload) => Object.values(payload || {})
      .filter((v) => typeof v === 'string')
      .some((v) => /auth_failed_401|token/i.test(v));
    ok(!!alert && typeof alert.payload.accountLabel === 'string' && !jargon(alert.payload),
      'and carries no HTTP status or token jargon - the reader is the desk, not an engineer');
    // THE PERMANENT-DEDUPE BUG. The key used to be a bare `flaky_boot_failed`, and _markSent writes a
    // PERMANENT store document with no TTL - so the first boot failure that actually sent silenced
    // every later one on that account, for good. The boot instant makes each boot its own key.
    ok(!!alert && alert.opts && /^sp_auth_dead_flaky_\d+$/.test(alert.opts.dedupeKey || ''),
      'the key carries the account AND the boot instant, so a repeat failure on a later boot is not silently swallowed');
    ok(!!alert && alert.opts && alert.opts.dedupeKey !== 'sp_auth_dead_flaky_0',
      'and the instant is a real timestamp, not a zero placeholder');

    // THE OTHER SIDE OF THE FORK. A boot failure with no AUTH code keeps the generic alarm verbatim -
    // telling the desk a login is logged out when the box could not resolve DNS would be a lie that
    // sends someone to reconnect an account that is fine.
    const generic = alerts.find((a) => a.kind === 'error' && /netfail/i.test((a.payload && a.payload.context) || ''));
    ok(!!generic, 'a NON-auth boot failure still fires the generic alarm naming the account');
    ok(!!generic && !generic.payload.authDead, 'and does NOT take the session-death template');
    ok(!!generic && /ENOTFOUND/.test(generic.payload.detail || ''), 'its detail still carries the real failure reason');
    ok(!!generic && generic.opts && /^netfail_boot_failed_\d+$/.test(generic.opts.dedupeKey || ''),
      'and it too gains the boot instant, so the permanent-dedupe trap is closed on both branches');

    // The dropped account must not become an orphan: its store record has to survive
    // untouched (still enabled, same tokenEnv) so /api/accounts can still show it and
    // reconnect/verify can still find it as an EXISTING account rather than minting it a
    // fresh tokenEnv slot. This is the data precondition both of those fixes depend on.
    const { loadAccounts } = require('../src/auth/accounts');
    const persisted = await loadAccounts(srv.store);
    const flakyRecord = persisted.find((a) => a.accountId === 'flaky');
    ok(!!flakyRecord, 'the dropped account record is never deleted from the store');
    ok(!!flakyRecord && flakyRecord.enabled !== false, 'the dropped account record stays enabled (not silently disabled)');
    ok(!!flakyRecord && flakyRecord.tokenEnv === 'SP_TOKEN_2', 'the dropped account record keeps its original tokenEnv slot (nothing reassigns it)');

    for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
    if (server) server.close();
  }

  // ---- B. total failure: every account bad -> boot() still throws, process still exits non-zero ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spbootiso-total-'));
    const shimPath = path.join(dir, 'shim.js');
    const adapterPath = JSON.stringify(path.join(__dirname, '..', 'src', 'platform', 'realAdapter.js'));
    fs.writeFileSync(shimPath, [
      "'use strict';",
      `const { RealSuperProcureAdapter } = require(${adapterPath});`,
      "RealSuperProcureAdapter.prototype.login = async function () { const e = new Error('auth_failed_401'); e.code = 'AUTH'; throw e; };",
      "RealSuperProcureAdapter.prototype.connectSocket = async function () { return null; };",
      "RealSuperProcureAdapter.prototype.listAuctions = async function () { return []; };",
    ].join('\n'));

    const env = Object.assign({}, process.env, {
      PLATFORM: 'real', STORE_BACKEND: 'file', PORT: '0',
      SP_ADMIN_PASS_HASH: 'test-hash', SP_SESSION_SECRET: 'test-session-secret',
      SP_DATA_DIR: dir, SP_TOKEN: 'always-broken-token',
    });
    delete env.SP_TOKEN_2; delete env.SP_TOKEN_3; delete env.SP_DEMO_SEED;

    const r = spawnSync(process.execPath, ['--require', shimPath, path.join(__dirname, '..', 'src', 'web', 'server.js')],
      { env, encoding: 'utf8', timeout: 15_000 });

    ok(r.status !== 0, `a fully-broken account set still exits non-zero (got ${r.status})`);
    ok(!/listening http/.test(r.stdout || ''), 'the server never reports listening when every account failed');
    ok(/every enabled account failed to come online/.test((r.stdout || '') + (r.stderr || '')), 'the fatal path still names why boot gave up');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', (e && e.stack) || e); process.exit(1); });
