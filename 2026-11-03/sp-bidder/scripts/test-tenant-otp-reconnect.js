'use strict';
/**
 * White-label tenant OTP reconnect + short-lived-token expiry warnings.
 *
 * The money-relevant property under test is NOT "does the OTP flow work" - it is WHICH HOST each
 * leg talks to. An account on a customer's own SuperProcure deployment must have its code
 * requested from, verified against, and its fresh token probed against THAT deployment. Getting it
 * wrong sends a live customer credential to a third-party host and fails in a way that reads as
 * "the portal is down".
 *
 *   PART 1  spOtpAuth wire shape: SP main unchanged, tenant routed by authBaseUrl/webOrigin
 *   PART 2  OTP failure modes: wrong code, unregistered mobile, account picker, unreachable host
 *   PART 3  expiry ladder: long path untouched, short-lived tokens get ONE leading warning
 *   PART 4  jwtIat / token lifetime
 *   PART 5  live routes (mock server): tenant resolution, authDead on /api/accounts, session TTL
 *
 * Offline and deterministic - every transport is a stub, no network, no live SuperProcure.
 */
const assert = require('assert');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const os = require('os');
const path = require('path');

// env BEFORE any src require: mock platform, ephemeral port, isolated data dir.
delete process.env.PLATFORM;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
delete process.env.SP_DEMO_SEED;
process.env.STORE_BACKEND = 'memory';
process.env.PORT = '0';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sptenant-'));
process.env.SP_DATA_DIR = TMP;

const { requestOtp, verifyOtp, authProfile, AUTH_API } = require('../src/auth/spOtpAuth');
const { checkTokenExpiry, expiryCheckIntervalMs, SHORT_WARN_MS } = require('../src/notify/tokenExpiry');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const resp = (status, body) => ({ status, json: async () => body });
const bodyOf = (cap) => JSON.parse(cap.init.body);

// The Rallis tenant, exactly as the account record carries it.
const TENANT = {
  authBaseUrl: 'https://logistics-auth.tatachemicals.com',
  webOrigin: 'https://logistics.tatachemicals.com',
  apiBaseUrl: 'https://logistics.tatachemicals.com/api',
  socketUrl: 'https://logistics.tatachemicals.com',
  socketPath: '/api/socket.io',
};

function fakeNotifier() {
  const calls = [];
  return { calls, alert: async (kind, payload, opts) => { calls.push({ kind, payload, opts }); } };
}

const HOUR = 3600000;
const DAY = 86400000;
// The measured Rallis session lifetime: 8.16 hours against SP main's 8,760.
const RALLIS_LIFE_MS = Math.round(8.16 * HOUR);

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mkJwt = (claims) => `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u(claims)}.sig`;

(async () => {
  // ================= PART 1: wire shape, SP main vs tenant =================
  {
    // --- SP main stays exactly as it shipped (no tenant fields passed) ---
    let cap = null;
    const okFetch = async (url, init) => { cap = { url, init }; return resp(200, { message: 'OTP sent', data: { id: 'sid-main' } }); };
    await requestOtp({ phone: '9594963428', fetchImpl: okFetch });
    ok(cap.url === `${AUTH_API}/api/v2/auth/phone`, 'SP main requestOtp still posts to auth-api /api/v2/auth/phone');
    ok(bodyOf(cap).phone === '9594963428' && bodyOf(cap).countryCode === '+91',
      'SP main still sends a bare 10-digit phone plus a separate countryCode');

    // --- tenant: different HOST, different PATH, different BODY ---
    cap = null;
    await requestOtp({
      phone: '9594963428', authBaseUrl: TENANT.authBaseUrl, webOrigin: TENANT.webOrigin, fetchImpl: okFetch,
    });
    ok(cap.url === 'https://logistics-auth.tatachemicals.com/api/v1/auth/phone',
      'tenant requestOtp posts to the TENANT auth host on /api/v1/auth/phone (not main, not v2)');
    ok(bodyOf(cap).phone === '919594963428',
      'tenant requestOtp inlines the country code into phone (12 digits), as the tenant capture shows');
    ok(!('countryCode' in bodyOf(cap)), 'tenant requestOtp sends NO separate countryCode field');
    ok(!/superprocure\.com/.test(cap.url), 'tenant OTP request never touches a superprocure.com host');

    // --- verify leg ---
    let vcap = null;
    const vFetch = async (url, init) => { vcap = { url, init }; return resp(200, { message: 'Authentication successful.', data: { redirectUrl: 'https://logistics.tatachemicals.com/?token=x', token: 'tenant-jwt' } }); };
    const v = await verifyOtp({ sessionId: 'sid', otp: '123456', authBaseUrl: TENANT.authBaseUrl, webOrigin: TENANT.webOrigin, fetchImpl: vFetch });
    ok(vcap.url === 'https://logistics-auth.tatachemicals.com/api/v1/auth/validate/otp',
      'tenant verifyOtp posts to the tenant auth host (same path as main)');
    ok(bodyOf(vcap).redirectUrl === 'https://logistics.tatachemicals.com/',
      "tenant verifyOtp sends the TENANT's own redirectUrl, not app.superprocure.com");
    ok(bodyOf(vcap).selection === null && bodyOf(vcap).ssoLogin === '',
      'tenant verifyOtp keeps the captured selection/ssoLogin fields');
    ok(v.token === 'tenant-jwt', 'tenant token is read out of the {message,data:{redirectUrl,token}} envelope');

    // --- URL hygiene ---
    const p = authProfile({ authBaseUrl: 'https://t.example.com/', webOrigin: 'https://w.example.com/' });
    ok(p.base === 'https://t.example.com' && p.redirectUrl === 'https://w.example.com/',
      'trailing slashes are normalised, redirectUrl keeps exactly one');
    const p2 = authProfile({ authBaseUrl: 'https://t.example.com' });
    ok(p2.redirectUrl === 'https://t.example.com/', 'redirectUrl falls back to the auth host when no webOrigin is set');
    const p3 = authProfile({});
    ok(p3.base === AUTH_API && p3.redirectUrl === 'https://app.superprocure.com',
      'no authBaseUrl means SP main - the default every existing account normalises to');
  }

  // ================= PART 2: OTP failure modes =================
  {
    let threw = null;
    try {
      await verifyOtp({ sessionId: 's', otp: '000000', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(401, { error: 'AUTH-003', message: 'OTP is incorrect.', data: null }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'OTP_INCORRECT', 'wrong OTP on a tenant throws OTP_INCORRECT');

    threw = null;
    try {
      await requestOtp({ phone: '9000000000', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(404, { error: 'AUTH-001', message: 'Phone number not found.', data: null }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'PHONE_NOT_FOUND', 'a mobile not registered on the tenant throws PHONE_NOT_FOUND');

    // A mobile mapped to several carrier accounts gets the account picker instead of a token.
    // This is the shape the two-step `selection` exchange would consume; the bidder does not
    // implement that leg, so it must refuse clearly rather than report a bad code.
    threw = null; let msg = '';
    try {
      await verifyOtp({ sessionId: 's', otp: '123456', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(200, { message: 'Please choose the relevant account.', data: { accounts: [{ id: 1, selection: 'sel-jwt-a' }, { id: 2, selection: 'sel-jwt-b' }] } }) });
    } catch (e) { threw = e.code; msg = e.message; }
    ok(threw === 'OTP_ACCOUNT_PICKER', 'an account-picker response throws OTP_ACCOUNT_PICKER, not OTP_VERIFY_FAILED');
    ok(/more than one account/i.test(msg), 'the picker error tells the operator what is actually wrong');

    // An empty accounts array is not a picker - it must not mask a genuine token failure.
    threw = null;
    try {
      await verifyOtp({ sessionId: 's', otp: '123456', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(200, { message: 'odd', data: { accounts: [] } }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'OTP_VERIFY_FAILED', 'an EMPTY accounts array falls through to OTP_VERIFY_FAILED');

    // Tenant unreachable: DNS/TLS/connection failure surfaces as a thrown transport error rather
    // than being swallowed into a success with no token.
    threw = null;
    try {
      await requestOtp({ phone: '9594963428', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; } });
    } catch (e) { threw = e.code; }
    ok(threw === 'ENOTFOUND', 'an unreachable tenant host propagates the transport error to the route');

    threw = null;
    try {
      await verifyOtp({ sessionId: 's', otp: '123456', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(502, 'gateway') });
    } catch (e) { threw = e.code; }
    ok(threw === 'OTP_VERIFY_FAILED', 'a non-JSON 502 from the tenant is OTP_VERIFY_FAILED, not a crash');

    // --- the picker must not out-rank a usable token ---
    // SP main's success envelope has never been captured, so one carrying the resolved account
    // list ALONGSIDE the token is possible. Refusing on the presence of accounts[] alone would
    // break every SP-main reconnect - the live-money path.
    const bothShapes = async () => resp(200, {
      message: 'ok', data: { accounts: [{ id: 1, selection: 'sel' }], token: 'the-jwt' },
    });
    const both = await verifyOtp({ sessionId: 's', otp: '123456', fetchImpl: bothShapes });
    ok(both.token === 'the-jwt', 'an envelope carrying BOTH accounts[] and a token yields the token, not a picker refusal');
    const bothTenant = await verifyOtp({ sessionId: 's', otp: '123456', authBaseUrl: TENANT.authBaseUrl, fetchImpl: bothShapes });
    ok(bothTenant.token === 'the-jwt', 'same on a tenant - a token always wins over the picker branch');

    // --- the picker must out-rank the generic error catch-all ---
    // The pre-existing `j.error` guard turns any truthy error into "OTP is incorrect". No tenant
    // picker response has ever been captured, and this API does stamp codes (AUTH-001/AUTH-003),
    // so a picker carrying one must not be reported to the operator as a wrong code.
    threw = null;
    try {
      await verifyOtp({ sessionId: 's', otp: '123456', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(200, { error: 'AUTH-0NN', message: 'Please choose the relevant account.', data: { accounts: [{ id: 1 }, { id: 2 }] } }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'OTP_ACCOUNT_PICKER', 'a picker response carrying an error code is still a picker, not OTP_INCORRECT');

    // ...but a genuine 401 must never be reported as a picker.
    threw = null;
    try {
      await verifyOtp({ sessionId: 's', otp: '000000', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(401, { error: 'AUTH-003', message: 'OTP is incorrect.', data: { accounts: [{ id: 1 }] } }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'OTP_INCORRECT', 'a 401 stays OTP_INCORRECT even if the body carries accounts[]');

    // --- a bare 404 means different things on the two deployments ---
    threw = null;
    try {
      await requestOtp({ phone: '9594963428', fetchImpl: async () => resp(404, { message: 'nope' }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'PHONE_NOT_FOUND', 'a bare 404 on SP MAIN still means the mobile is unregistered (unchanged)');

    threw = null; msg = '';
    try {
      await requestOtp({ phone: '9594963428', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(404, { message: 'Cannot POST /api/v1/auth/phone' }) });
    } catch (e) { threw = e.code; msg = e.message; }
    ok(threw === 'OTP_START_FAILED',
      'a bare 404 on a TENANT is a wrong-URL failure, not "your mobile is unregistered" - a mistyped authBaseUrl must not read as a phone problem');
    ok(/logistics-auth\.tatachemicals\.com\/api\/v1\/auth\/phone/.test(msg),
      'the tenant failure names the URL actually called, so the operator can see the bad host');

    threw = null;
    try {
      await requestOtp({ phone: '9000000000', authBaseUrl: TENANT.authBaseUrl,
        fetchImpl: async () => resp(404, { error: 'AUTH-001', message: 'Phone number not found.' }) });
    } catch (e) { threw = e.code; }
    ok(threw === 'PHONE_NOT_FOUND', 'a tenant that says AUTH-001 explicitly is still PHONE_NOT_FOUND');
  }

  // ================= PART 3: the expiry ladder =================
  {
    // --- the long path must be untouched: this is the live SP-main + GoComet behaviour ---
    {
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + 10 * DAY, notifier: n, now, accountLabel: 'primary' });
      const keys = n.calls.map((c) => c.opts.dedupeKey).sort();
      ok(n.calls.length === 2 && keys[0] === 'token_expiry_warn_primary_14' && keys[1] === 'token_expiry_warn_primary_30',
        'lifetime unknown -> the original day ladder, unchanged (10 days out fires 30 + 14)');
    }
    {
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + 10 * DAY, notifier: n, now, accountLabel: 'primary', tokenLifetimeMs: 365 * DAY });
      ok(n.calls.length === 2, 'a genuinely long lifetime also takes the day ladder (365d token unaffected)');
    }

    // --- the burst this exists to kill. A lapsed short token now takes its own branch and raises at
    // most ONE message, on the customer channel; the admin copy belongs to the wire rail
    // (raiseAuthDead -> account_auth_expired). See test-session-expiry-alert.js for the full pin.
    {
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now - HOUR, notifier: n, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
      ok(n.calls.length === 1, 'an already-dead 8h token fires ONE alert, not one per crossed day-threshold');
      const desk = n.calls[0];
      ok(desk.kind === 'desk_notice', 'and it is the desk half - the clock raises no second admin alert for a lapse');
      ok(/disconnected/i.test(desk.payload.detail) && !/expires/i.test(desk.payload.detail),
        'a past-expiry short token gets the disconnect wording, not a re-fired "expires" warning');
    }

    // --- a fresh token is silent; the warning leads the expiry ---
    {
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + 8 * HOUR, notifier: n, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
      ok(n.calls.length === 0, 'a freshly minted 8h token warns about nothing');
    }
    {
      // 90 minutes out no longer crosses anything - the 2h rung is gone and the only remaining
      // rung is 30 minutes. Silence here is the exact fix for the owner's "only 30 minutes before" ask.
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + 90 * 60000, notifier: n, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
      ok(n.calls.length === 0, '90 minutes left is silent - the 2h rung this used to cross is gone');
    }
    {
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + 20 * 60000, notifier: n, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS, deskCustomer: 'Rallis' });
      const errCalls = n.calls.filter((c) => c.kind === 'error');
      ok(errCalls.length === 1 && /_30m$/.test(errCalls[0].opts.dedupeKey),
        '20 minutes left fires ONLY the 30m rung - the only rung left');
      ok(/in ~20m/.test(errCalls[0].payload.detail), 'sub-hour remaining is stated in minutes');
      ok(n.calls.filter((c) => c.kind === 'desk_notice').length === 1,
        'and the warning also reaches the account\'s customer group, in its own words');
    }

    // --- the rotation trap: a permanent dedupe mark must not silence the NEXT token ---
    {
      const n = fakeNotifier();
      const now = Date.now();
      const first = now + 20 * 60000;
      await checkTokenExpiry({ tokenExp: first, notifier: n, now, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
      await checkTokenExpiry({ tokenExp: first + RALLIS_LIFE_MS, notifier: n, now: now + RALLIS_LIFE_MS, accountLabel: 'rallis', tokenLifetimeMs: RALLIS_LIFE_MS });
      const keys = n.calls.filter((c) => c.kind === 'error').map((c) => c.opts.dedupeKey);
      ok(keys.length === 2 && keys[0] !== keys[1],
        'a rotated token gets its OWN dedupe key - the notifier mark is permanent, so a shared key would silence every future token');
      ok(keys.every((k) => k.startsWith('token_expiry_warn_rallis_')), 'short-token keys stay namespaced to the account label');
    }

    // --- a token shorter than the smallest rung still gets one warning ---
    {
      const n = fakeNotifier();
      const now = Date.now();
      await checkTokenExpiry({ tokenExp: now + 5 * 60000, notifier: n, now, accountLabel: 'tiny', tokenLifetimeMs: 20 * 60000 });
      ok(n.calls.filter((c) => c.kind === 'error').length === 1,
        'a 20-minute token still gets exactly one admin warning rather than falling silent');
    }

    // --- two accounts on the same tenant do not collide ---
    {
      const n = fakeNotifier();
      const now = Date.now();
      const exp = now + 20 * 60000;
      await checkTokenExpiry({ tokenExp: exp, notifier: n, now, accountLabel: 'a', tokenLifetimeMs: RALLIS_LIFE_MS });
      await checkTokenExpiry({ tokenExp: exp, notifier: n, now, accountLabel: 'b', tokenLifetimeMs: RALLIS_LIFE_MS });
      const keys = n.calls.filter((c) => c.kind === 'error').map((c) => c.opts.dedupeKey);
      ok(new Set(keys).size === 2, 'per-account dedupe keys stay distinct on a shared tenant');
    }

    // --- no notifier / no expiry is still a no-op ---
    await checkTokenExpiry({ tokenExp: null, notifier: fakeNotifier(), tokenLifetimeMs: RALLIS_LIFE_MS });
    await checkTokenExpiry({ tokenExp: Date.now() + HOUR, notifier: null, tokenLifetimeMs: RALLIS_LIFE_MS });
    ok(true, 'a missing tokenExp or notifier never throws on the short path either');

    // --- the cadence, which is what makes a pre-expiry warning deliverable at all ---
    ok(expiryCheckIntervalMs(RALLIS_LIFE_MS) === 5 * 60000, 'a short-lived token is re-checked every 5 minutes');
    ok(expiryCheckIntervalMs(365 * DAY) === 24 * 3600000, 'a long-lived token keeps the 24h cadence');
    ok(expiryCheckIntervalMs(null) === 24 * 3600000, 'unknown lifetime keeps the 24h cadence');
    ok(expiryCheckIntervalMs(RALLIS_LIFE_MS) < Math.min(...SHORT_WARN_MS),
      'the cadence is finer than the smallest rung, so no rung can be stepped over between checks');
  }

  // ================= PART 4: token lifetime from the JWT =================
  {
    const iat = 1754300000, exp = iat + Math.round(8.16 * 3600);
    ok(RealSuperProcureAdapter.jwtIat(mkJwt({ iat, exp })) === iat * 1000, 'jwtIat reads iat in ms');
    ok(RealSuperProcureAdapter.jwtExp(mkJwt({ iat, exp })) === exp * 1000, 'jwtExp still reads exp in ms');
    ok(RealSuperProcureAdapter.jwtIat(mkJwt({ exp })) === null, 'a token with no iat yields null (lifetime unknown)');
    ok(RealSuperProcureAdapter.jwtIat('not-a-jwt') === null, 'a malformed token yields null rather than throwing');
    const life = RealSuperProcureAdapter.jwtExp(mkJwt({ iat, exp })) - RealSuperProcureAdapter.jwtIat(mkJwt({ iat, exp }));
    ok(Math.abs(life - RALLIS_LIFE_MS) < 1000, 'the decoded lifetime matches the measured 8.16h tenant session');

    // tokenLifetimeOf must MEASURE when iat is absent rather than reporting "unknown". Returning
    // null there silently reinstates the day ladder and the 24h cadence, i.e. both original
    // defects, with nothing in the logs to distinguish that from the feature working.
    const now = Date.now();
    const srvMod = require('../src/web/server');
    ok(typeof srvMod.tokenLifetimeOf === 'function', 'tokenLifetimeOf is exported for this check');
    ok(srvMod.tokenLifetimeOf({ tokenExp: now + 8 * HOUR, tokenIat: now - 10000 }, now) === (8 * HOUR + 10000),
      'with iat present the lifetime is exp - iat');
    const measured = srvMod.tokenLifetimeOf({ tokenExp: now + 8 * HOUR }, now);
    ok(measured === 8 * HOUR,
      'with iat ABSENT the lifetime falls back to the measured remaining life, not null');
    ok(require('../src/notify/tokenExpiry').isShortLived(measured),
      'that measured fallback still classifies an 8h token as short-lived, so the hour ladder survives a missing iat');
    ok(srvMod.tokenLifetimeOf({ tokenExp: now - HOUR }, now) === null, 'an already-expired token has no positive lifetime');
    ok(srvMod.tokenLifetimeOf(null, now) === null && srvMod.tokenLifetimeOf({}, now) === null,
      'a missing account or missing exp yields null');
  }

  // ================= PART 5: live routes on a mock server =================
  {
    const srv = require('../src/web/server');
    await srv.store.putDoc('accounts', 'primary', { accountId: 'primary', label: 'Primary', tokenEnv: 'SP_TOKEN', enabled: true, createdAt: 1 });
    await srv.store.putDoc('accounts', 'rallis', {
      accountId: 'rallis', label: 'Rallis', tokenEnv: 'SP_TOKEN_RALLIS', enabled: true, createdAt: 2, carrierId: 132,
      apiBaseUrl: TENANT.apiBaseUrl, authBaseUrl: TENANT.authBaseUrl, webOrigin: TENANT.webOrigin,
      socketUrl: TENANT.socketUrl, socketPath: TENANT.socketPath,
    });
    // A tenant account whose auth host was never filled in - the half-configured case the route
    // refuses rather than quietly asking SuperProcure main for the code.
    await srv.store.putDoc('accounts', 'halfway', {
      accountId: 'halfway', label: 'Halfway', tokenEnv: 'SP_TOKEN_HALF', enabled: true, createdAt: 3,
      apiBaseUrl: TENANT.apiBaseUrl,
    });
    // Disabled, but still a tenant: its OTP must never be requested from SP main.
    await srv.store.putDoc('accounts', 'offtenant', {
      accountId: 'offtenant', label: 'Off Tenant', tokenEnv: 'SP_TOKEN_OFF', enabled: false, createdAt: 4,
      apiBaseUrl: TENANT.apiBaseUrl, authBaseUrl: TENANT.authBaseUrl, webOrigin: TENANT.webOrigin,
    });
    // The dangerous mirror image of 'halfway': an auth host but no API host.
    await srv.store.putDoc('accounts', 'authonly', {
      accountId: 'authonly', label: 'Auth Only', tokenEnv: 'SP_TOKEN_AUTHONLY', enabled: true, createdAt: 5,
      authBaseUrl: TENANT.authBaseUrl, webOrigin: TENANT.webOrigin,
    });

    const server = await srv.boot();
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    // --- which host does each account authenticate against ---
    ok((await srv.tenantAuthFor('primary')) === null, 'an SP-main account resolves to no tenant (stays on SP main)');
    ok((await srv.tenantAuthFor('nope-not-a-real-id')) === null, 'an unknown id resolves to no tenant (the connect-new flow is SP main)');
    const rt = await srv.tenantAuthFor('rallis');
    ok(rt && rt.authBaseUrl === TENANT.authBaseUrl && rt.apiBaseUrl === TENANT.apiBaseUrl
      && rt.webOrigin === TENANT.webOrigin && rt.socketPath === TENANT.socketPath,
      'a tenant account resolves all five routing fields off its record');
    const ht = await srv.tenantAuthFor('halfway');
    ok(ht && ht.authBaseUrl === null, 'a tenant account with no authBaseUrl resolves as a tenant with a null auth host (the route refuses it)');
    const ot = await srv.tenantAuthFor('offtenant');
    ok(ot && ot.authBaseUrl === TENANT.authBaseUrl, 'a DISABLED tenant account still resolves to its own host, never to SP main');
    // The mirror-image half-configuration: an auth host but no API host. The OTP would correctly
    // mint a TENANT token and the identity probe would then send it to SuperProcure main.
    const at = await srv.tenantAuthFor('authonly');
    ok(at && at.authBaseUrl === TENANT.authBaseUrl && at.apiBaseUrl === null,
      'a tenant account with authBaseUrl but no apiBaseUrl resolves with a null API host (the route refuses it too)');

    // --- the half-configured-tenant refusal itself ---
    // Both fields are required together: either one alone routes a credential to the wrong host.
    ok(srv.tenantConfigError('primary', null) === null, 'an SP-main account (no tenant) is never refused');
    ok(srv.tenantConfigError('rallis', rt) === null, 'a fully configured tenant is allowed through');
    const halfErr = srv.tenantConfigError('halfway', ht);
    ok(typeof halfErr === 'string' && /authBaseUrl/.test(halfErr) && !/apiBaseUrl/.test(halfErr),
      'apiBaseUrl-without-authBaseUrl is refused, naming the missing field');
    const authErr = srv.tenantConfigError('authonly', at);
    ok(typeof authErr === 'string' && /apiBaseUrl/.test(authErr) && !/authBaseUrl/.test(authErr),
      'authBaseUrl-without-apiBaseUrl is refused too - this is the direction that would send a TENANT token to SuperProcure main');
    const bothErr = srv.tenantConfigError('x', { authBaseUrl: null, apiBaseUrl: null, webOrigin: 'https://w.example.com' });
    ok(/authBaseUrl and apiBaseUrl/.test(bothErr), 'a tenant record with neither host names both missing fields');

    // tenantAuthFor must THROW, not return null, when the account list cannot be read: null means
    // "this account is SP main", and a failed read is not evidence of that. Returning null there
    // routes a tenant's OTP to SuperProcure main and skips the guard entirely.
    const realList = srv.store.listDocs.bind(srv.store);
    srv.store.listDocs = async (coll) => {
      if (coll === 'accounts') throw new Error('simulated store read failure');
      return realList(coll);
    };
    // Must be an account NOT in `stacks` - the live-stack hit short-circuits before the store read.
    // 'offtenant' is disabled, so boot never built a stack for it, which is also the real-world
    // shape here: a boot-dropped or disabled tenant account is exactly what gets reconnected.
    ok(!srv.stacks.some((s) => s.account.accountId === 'offtenant'), 'offtenant has no live stack, so it takes the store path');
    let resolveThrew = false;
    try { await srv.tenantAuthFor('offtenant'); } catch { resolveThrew = true; }
    ok(resolveThrew, 'tenantAuthFor propagates a store read failure instead of silently answering "SP main"');
    srv.store.listDocs = realList;
    ok((await srv.tenantAuthFor('offtenant')) !== null, 'and resolves normally once the store recovers');

    // --- authDead on /api/accounts ---
    const a1 = await httpReq(port, 'GET', '/api/accounts');
    ok(a1.status === 200, '/api/accounts responds 200');
    const primary = a1.json.accounts.find((x) => x.accountId === 'primary');
    ok(primary && primary.authDead === false, 'a healthy stack reports authDead false (field present, not undefined)');
    ok(primary && 'tokenLifetimeMs' in primary,
      'the accounts payload carries tokenLifetimeMs, so the console can tell an 8h session from a 365d one');

    srv.stacks[0].adapter.isAuthDead = () => true;
    const a2 = await httpReq(port, 'GET', '/api/accounts');
    const dead = a2.json.accounts.find((x) => x.accountId === 'primary');
    ok(dead && dead.authDead === true,
      'a stack whose session is dead reports authDead true even though connected stays true');
    ok(dead.connected === true,
      'connected is deliberately NOT redefined - a latched account can still read, so the scope-refresh path must stay open');
    delete srv.stacks[0].adapter.isAuthDead;

    // --- OTP session lifecycle on the routes ---
    const noSess = await httpReq(port, 'POST', '/api/accounts/primary/reconnect/verify', { otp: '123456' });
    ok(noSess.status === 410, 'verify with no pending session is 410 (request a new code)');

    const badPhone = await httpReq(port, 'POST', '/api/accounts/primary/reconnect/start', { phone: '12345' });
    ok(badPhone.status === 400, 'start refuses a phone that is not a valid Indian mobile');

    const started = await httpReq(port, 'POST', '/api/accounts/primary/reconnect/start', { phone: '9594963428' });
    ok(started.status === 200 && /XXXXXX3428$/.test(started.json.maskedPhone),
      'start returns a masked phone and never echoes the full number');

    const badOtp = await httpReq(port, 'POST', '/api/accounts/primary/reconnect/verify', { otp: '12' });
    ok(badOtp.status === 400, 'verify refuses a code that is not 4-8 digits');

    const good = await httpReq(port, 'POST', '/api/accounts/primary/reconnect/verify', { otp: '123456' });
    ok(good.status === 200 && good.json.ok === true, 'a well-formed code completes the mock reconnect');
    ok(!JSON.stringify(good.json).includes('eyJ'), 'the reconnect response never carries a token');

    const replay = await httpReq(port, 'POST', '/api/accounts/primary/reconnect/verify', { otp: '123456' });
    ok(replay.status === 410, 'the session is consumed on success - a replayed code is refused');

    await new Promise((r) => server.close(r));
  }

  // Completion sentinel: run-tests.js grades by EXIT CODE alone, so a file that returns early
  // (an unref'd timer, a swallowed throw) would otherwise be scored as a silent green pass.
  const EXPECTED_CHECKS = 84;
  assert.strictEqual(fail, 0, `${fail} checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });

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
