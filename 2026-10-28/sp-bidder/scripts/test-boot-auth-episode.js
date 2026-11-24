'use strict';
/**
 * THE BOOT PATH'S OWN AUTH ALERT - driven through boot(), not through the adapter.
 *
 * The runtime latch and boot are the two independent detectors of "this account cannot bid", and the
 * reconciled design gave the runtime one two mechanisms boot never received:
 *
 *   1. THE CAUSE. `authReason` distinguishes a session SuperProcure revoked (remedy: Reconnect) from a
 *      token that simply ran past its own exp (remedy: a fresh verification code), and picks between
 *      two templates. It is threaded through ensureSession - and login(), the function that fails at
 *      boot, never calls ensureSession and never stamps one. So every boot-time auth failure rendered
 *      the revocation copy, including for a token that had merely lapsed: the wrong remedy, on the
 *      exact restart-mid-outage path the persisted episode ledger was built to make matter.
 *
 *   2. THE EPISODE. The down-alert's dedupe key IS the episode identity, and the ledger is hydrated
 *      before any stack is built - so a restart during a still-open outage arrives already knowing
 *      that outage's identity. Keying the boot alert off a fresh `bootAt` anyway minted a second
 *      DELIVERABLE key for the same ongoing episode: a duplicate "logged out" on every restart, while
 *      the eventual all-clear still carries the original identity and never closes the duplicate.
 *
 * Both gaps were invisible to the suite because nothing drove boot()'s real bootFailures loop for
 * them - the existing restart scenario exercises the adapter directly. This file drives boot().
 *
 * Deterministic, offline, no network: login/connectSocket/listAuctions are monkey-patched on the
 * shared prototype before any account activates, and which account fails is decided purely by its
 * token. FOUR accounts in ONE boot (three failures plus one healthy, because a total failure is the
 * genuinely fatal path and aborts):
 *
 *   healthy  logs in - present only so boot() does not take the every-account-down abort
 *   lapsed   token's own exp is in the PAST      -> account_auth_expired copy
 *   revoked  token is live, SuperProcure says no -> account_auth_dead copy (the other side of the fork)
 *   ongoing  a mark for episode E0 is already on disk -> the alert is keyed to E0, and is swallowed
 *            by E0's own already-delivered message rather than adding a duplicate
 *
 *   node scripts/test-boot-auth-episode.js
 */
const fs = require('fs'); // allowed: test harness (temp dir), not app state
const os = require('os');
const path = require('path');

// env BEFORE any src require.
process.env.PLATFORM = 'real';
process.env.STORE_BACKEND = 'memory';
process.env.PORT = '0';
process.env.SP_ADMIN_PASS_HASH = 'test-hash';
process.env.SP_SESSION_SECRET = 'test-session-secret';
delete process.env.SP_DEMO_SEED;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spbootauth-'));
process.env.SP_DATA_DIR = TMP;

const NOW = Date.now();
/** A token shaped exactly like the ones jwtExp reads: header.<base64 payload>.signature. */
const jwt = (expMs) => 'h.' + Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), u_id: 'u1' }))
  .toString('base64') + '.s';

process.env.SP_TOKEN = 'good-token';                       // healthy
process.env.SP_TOKEN_2 = jwt(NOW - 3_600_000);             // lapsed an hour ago
process.env.SP_TOKEN_3 = jwt(NOW + 30 * 86_400_000);       // live for another month
process.env.SP_TOKEN_4 = jwt(NOW + 30 * 86_400_000);       // ditto - this one carries a prior episode

// The outage that was already open when this process last stopped. Ten minutes before this boot, so
// it is unmistakably NOT bootAt.
const E0 = NOW - 600_000;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const EXPECTED_CHECKS = 15;
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  if (fail === 0 && pass === EXPECTED_CHECKS) return;
  if (fail === 0) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
      + ' - the file exited early, or checks were removed without updating the count');
  }
  process.exitCode = 1;
});

const FAKE_IDENTITY = () => ({
  carrierId: 9001, branchIds: [1, 2, 3], isCarrier: true, company: 'Test Co',
  user: 'Test User', userId: 'u1', tokenExp: NOW + 365 * 86_400_000, serverTimeOffsetMs: 0,
});

(async () => {
  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  // Only 'good-token' logs in. Everything else is a dead SuperProcure session, which is the ONE
  // shape boot classifies as an auth failure (code AUTH); the token's own exp is what the boot site
  // then reads to decide WHICH auth failure it is, and login tells it nothing either way - which is
  // the whole gap.
  RealSuperProcureAdapter.prototype.login = async function () {
    if (this.token !== 'good-token') { const e = new Error('auth_failed_401'); e.code = 'AUTH'; throw e; }
    this.account = FAKE_IDENTITY();
    return this.account;
  };
  RealSuperProcureAdapter.prototype.connectSocket = async function () { return null; };
  RealSuperProcureAdapter.prototype.listAuctions = async function () { return []; };

  const { templateFor } = require('../src/notify/waTemplates');
  const { WhatsAppClient } = require('../src/notify/whatsapp');
  const { Notifier } = require('../src/notify/notifier');
  const { MemoryStore } = require('../src/store');
  const { raiseAuthDead } = require('../src/notify/authAlert');
  const srv = require('../src/web/server');

  await srv.store.putDoc('accounts', 'healthy', { accountId: 'healthy', label: 'Healthy', tokenEnv: 'SP_TOKEN', enabled: true, createdAt: 1 });
  await srv.store.putDoc('accounts', 'lapsed', { accountId: 'lapsed', label: 'Lapsed Token', tokenEnv: 'SP_TOKEN_2', enabled: true, createdAt: 2 });
  await srv.store.putDoc('accounts', 'revoked', { accountId: 'revoked', label: 'Revoked Session', tokenEnv: 'SP_TOKEN_3', enabled: true, createdAt: 3 });
  await srv.store.putDoc('accounts', 'ongoing', { accountId: 'ongoing', label: 'Ongoing Outage', tokenEnv: 'SP_TOKEN_4', enabled: true, createdAt: 4 });

  // THE OUTAGE THAT SURVIVED THE RESTART, on disk exactly as the adapter's own hook left it. boot()
  // hydrates this before it builds a single stack.
  await srv.store.putDoc(srv.AUTH_DEAD_MARKS_COLLECTION, 'ongoing',
    { accountId: 'ongoing', since: E0, accountLabel: 'Ongoing Outage' });

  // THE REAL DELIVERY STACK behind the composition root's notifier, so "was a duplicate SENT" is a
  // measured number rather than an inference from a dedupe key. Its store already carries the
  // sent-mark for E0's message - which is the state a restart mid-outage actually starts in, because
  // that message is the reason the mark exists.
  const sends = [];
  const transport = async (url, opts) => {
    sends.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const deskNotifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => ([{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }]),
    healthProvider: async () => true });

  // ...and the pre-restart message itself, delivered, marking E0's key the way the real one did.
  await deskNotifier.alert('error', { authDead: true, accountId: 'ongoing', accountLabel: 'Ongoing Outage',
    since: E0, authReason: null }, { dedupeKey: `sp_auth_dead_ongoing_${E0}` });
  ok(sends.length === 1, `the pre-restart down-alert was delivered and marked (sends=${sends.length})`);
  const sendsBeforeBoot = sends.length;

  const alerts = [];
  const inFlight = [];
  srv.notifier.alert = (kind, payload, opts) => {
    alerts.push({ kind, payload, opts });
    const p = deskNotifier.alert(kind, payload, opts);
    inFlight.push(p);
    return p;
  };

  let bootError = null;
  let server = null;
  try { server = await srv.boot(); } catch (e) { bootError = e; }
  await Promise.all(inFlight.splice(0));

  ok(!bootError, `boot() resolves with one healthy account (threw: ${bootError && bootError.message})`);
  ok(srv.stacks.length === 1, `only the healthy account stays up (got ${srv.stacks.length} stacks)`);

  const authAlertFor = (id) => alerts.find((a) => a.kind === 'error' && a.payload && a.payload.authDead
    && a.payload.accountId === id);

  // ---- FINDING 4: the boot alert names the CAUSE, in both directions ----
  const lapsed = authAlertFor('lapsed');
  ok(!!lapsed, 'the lapsed-token account raises a session-death alert at boot');
  ok(!!lapsed && lapsed.payload.authReason === 'token_expired',
    `THE CAUSE, DERIVED AT THE BOOT SITE: login() stamps no authReason, so the boot path reads the `
    + `token's own exp - got ${lapsed && lapsed.payload.authReason}`);
  ok(!!lapsed && templateFor('error', lapsed.payload) === 'account_auth_expired',
    'so the desk is told to get a fresh verification code, not to Reconnect an account whose session '
    + 'was never revoked');

  const revoked = authAlertFor('revoked');
  ok(!!revoked, 'a genuinely revoked session also raises the session-death alert');
  ok(!!revoked && !revoked.payload.authReason,
    'THE OTHER SIDE OF THE FORK: its token has a month left, so no expiry claim is made about it');
  ok(!!revoked && templateFor('error', revoked.payload) === 'account_auth_dead',
    'and it keeps the general "logged out, quote by hand" copy - the expiry copy would be a specific '
    + 'claim about this account that is simply false');

  // ---- FINDING 5: the boot alert is keyed to the EPISODE, not to this boot ----
  const ongoing = authAlertFor('ongoing');
  ok(!!ongoing, 'the account with an outage still open also raises at boot');
  ok(!!ongoing && ongoing.payload.since === E0,
    `THE EPISODE, NOT THE BOOT: the hydrated identity is what the alert carries - got `
    + `${ongoing && ongoing.payload.since}, expected ${E0}`);
  ok(!!ongoing && ongoing.opts && ongoing.opts.dedupeKey === `sp_auth_dead_ongoing_${E0}`,
    'under the key the pre-restart message already holds, so this is the same message rather than a '
    + 'second one');
  // COUNTED AS A TOTAL, because that is the only form in which "no duplicate" is falsifiable here:
  // this boot legitimately sends TWO messages (lapsed and revoked are genuinely new outages), so an
  // assertion that nothing at all was sent would fail for the right reason and an assertion scoped to
  // a substring of the copy would pass for the wrong one. Three sends means the ongoing outage added
  // exactly nothing; four means the restart duplicated it.
  ok(sends.length === sendsBeforeBoot + 2,
    `NO DUPLICATE REACHES THE DESK: this boot sends one message per GENUINELY NEW outage (lapsed, `
    + `revoked) and nothing for the one already open - expected ${sendsBeforeBoot + 2} sends in total, `
    + `got ${sends.length}`);

  // ...and the fresh-outage accounts must NOT have been folded into anything: with no prior mark they
  // key off bootAt, which is what keeps the notifier's permanent, TTL-less sent-mark from silencing
  // every later boot failure on that account.
  const bootKeyed = [lapsed, revoked].every((a) => a && a.opts
    && /^sp_auth_dead_(lapsed|revoked)_\d{13}$/.test(a.opts.dedupeKey || '')
    && a.payload.since !== E0 && a.payload.since >= NOW);
  ok(bootKeyed, 'an account with NO prior mark still keys off this boot instant, so a repeat failure '
    + 'on a later boot is a new message rather than silence');
  ok(sends.filter((s) => /logged out|verification code/i.test(String(s.message || ''))).length >= 2,
    'and the two genuinely new failures did reach the desk');

  for (const s of srv.stacks) { try { s.discovery.stop(); } catch (_) {} }
  if (server) server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', (e && e.stack) || e); process.exit(1); });
