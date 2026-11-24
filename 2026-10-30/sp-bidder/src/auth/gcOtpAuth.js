'use strict';

const config = require('../config');
const { GoCometAdapter } = require('../platform/gocometAdapter');

/**
 * Server-side proxy for GoComet's OTP re-auth - the GoComet twin of auth/spOtpAuth.js.
 *
 * GoComet issues a ~30-day JWT and ships NO refresh endpoint, so the only way to renew a session
 * is to log in again with an emailed one-time code. Two public calls:
 *   1. requestOtp({email})           -> {sessionRef}   (GoComet mails a 6-digit code)
 *   2. verifyOtp({sessionRef, otp})  -> {token}        (checks the code, then mints the JWT)
 *
 * NO HEADLESS BROWSER. BRL's own legacy bot does this by launching Puppeteer, typing into the
 * real login page and scraping the token off the wire with a CDP `Network.responseReceived`
 * listener (reference/brl-gocomet/source/server.js:790-812). That is not because a browser is
 * required - it is because whoever wrote it never worked out the HTTP calls. What that listener
 * captures is a plain JSON POST response, so an HTTP client reaches the same token with none of
 * the browser's cost or flakiness.
 *
 * Runs ONLY on the server, so a freshly minted token never reaches a browser: nothing here writes
 * to a response, and `fetchImpl` is injectable so the whole flow is unit-testable against a mock
 * transport with no live GoComet call.
 *
 * ---- THE FLOW IS FOUR LEGS, AND THE PUBLIC API IS TWO ------------------------------------------
 *
 * Every path below is READ OFF GOCOMET'S OWN SHIPPED CODE - the login page chunk
 * (login-ea2fcd48bd6b6382.js, fetched 2026-08-10) plus the shared users-actions chunk from the
 * 2026-08-04 HAR - not inferred from naming conventions:
 *
 *   leg 1  GET  login/is-user-present?email=        -> {user_present}      [precheck, sends nothing]
 *   leg 2  POST engagement-app/send-email-otp       -> {short_lived_token} [mails the code]
 *   leg 3  GET  engagement-app/verify-email-otp     -> {success}           [checks the code]
 *   leg 4  POST login/otp-login                     -> {token}             [mints the JWT]
 *
 * `short_lived_token` threads 2 -> 3 -> 4 and the final login REQUIRES it. requestOtp performs
 * legs 1-2; verifyOtp performs legs 3-4. Collapsing 3+4 behind one call is for the caller's sake
 * - an operator types a code once - but the two are genuinely separate requests and they FAIL
 * DISTINGUISHABLY, which is the point: leg 3 failing means the human mistyped the code
 * (GC_OTP_INCORRECT, retryable by typing it again), while leg 4 failing means the code was right
 * and the login itself broke (GC_OTP_LOGIN_*, not the operator's fault and not fixed by retrying).
 * Merging those into one "auth failed" would send an operator to re-read an email that was fine.
 *
 * ---- THE ONE THING STILL GENUINELY UNKNOWN ----------------------------------------------------
 *
 * The bundle reads its results as `t.data.short_lived_token` and `A.data.success`, through helpers
 * (`postRequest`/`getRequest`) that live in a module we do not hold. If those are axios - which
 * their signature and the `(A||{}).data.success` guard both suggest - then `.data` is axios's
 * response wrapper and the fields are TOP-LEVEL in the JSON body. If they are a thin fetch wrapper
 * returning the parsed body, `data` is a real nested envelope. The bundle cannot distinguish these.
 *
 * So this module reads BOTH placements rather than picking one. That is not laziness: the
 * SuperProcure PMT `amount` belief in CLAUDE.local.md flipped TWICE on exactly this class of
 * mistake - an inference about the wire drawn from reading code rather than from an observed
 * request - and the second flip shipped a defect. Reading both costs nothing and cannot be wrong.
 */

// Confirmed field names. `short_lived_token` is the handle that threads legs 2-4.
const SHORT_LIVED_TOKEN_KEY = 'short_lived_token';

// The vendor surface a minted token must prove itself on. See identityProbe.
const VENDOR_PROBE_PATH = '/api/v1/vendor/enquiries/spot?page=1&size=1';

// The login page refuses to submit anything that is not exactly six digits, so a malformed code is
// rejected locally - before it can burn a request and, worse, consume the short_lived_token.
const OTP_PATTERN = /^\d{6}$/;

const trimSlash = (s) => String(s).replace(/\/+$/, '');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read a field from either the top level or a nested `data` envelope. See the header note on why
 * both are read; do not "tidy" this down to one placement without an OBSERVED request to justify it.
 */
function readEither(json, key) {
  if (!isPlainObject(json)) return undefined;
  if (json[key] !== undefined) return json[key];
  if (isPlainObject(json.data) && json.data[key] !== undefined) return json.data[key];
  return undefined;
}

/**
 * Resolve the wire contract. Defaults come from `config.gocomet` (env-driven) so a GoComet
 * redeploy that moves one leg is an env override; every field is overridable per call so tests
 * never touch config.
 */
function authProfile({ authBaseUrl, otpUserCheckPath, otpRequestPath, otpVerifyPath, otpLoginPath } = {}) {
  const gc = config.gocomet || {};
  const base = trimSlash(authBaseUrl || gc.authBaseUrl || 'https://login.gocomet.com');
  const userCheckPath = otpUserCheckPath || gc.otpUserCheckPath || '/api/v1/login/is-user-present';
  const requestPath = otpRequestPath || gc.otpRequestPath || '/api/v1/engagement-app/send-email-otp';
  const verifyPath = otpVerifyPath || gc.otpVerifyPath || '/api/v1/engagement-app/verify-email-otp';
  const loginPath = otpLoginPath || gc.otpLoginPath || '/api/v1/login/otp-login';
  return {
    base,
    userCheckPath,
    requestPath,
    verifyPath,
    loginPath,
    userCheckUrl: `${base}${userCheckPath}`,
    requestUrl: `${base}${requestPath}`,
    verifyUrl: `${base}${verifyPath}`,
    loginUrl: `${base}${loginPath}`,
  };
}

/** Browser-coherent headers for the auth host - what the login page itself sends. */
function authHeaders() {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: 'https://www.gocomet.com',
    referer: 'https://www.gocomet.com/',
  };
}

/**
 * Strip anything JWT-shaped out of text before it can reach an error message or a console.
 *
 * Error strings here quote the server's response body so an unexpected answer is diagnosable, and
 * an unexpected answer is by definition one nobody inspected in advance. Errors get logged and
 * logs get pasted into chat threads; a token that leaks that way is a live GoComet session on
 * BRL's real vendor account. So redaction happens where the text is captured, not where it is
 * printed - there is no path that prints an unredacted body.
 */
function redactJwts(text) {
  if (text == null) return text;
  // Anchored on `eyJ` - base64url of `{"`, which every JWT header and payload begins with. That is
  // both tighter and safer than matching three dot-separated base64 runs by length: it will not
  // eat an ordinary dotted identifier out of a diagnostic string, and it does not depend on the
  // signature being long (a short signature is still a token).
  return String(text).replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+/g, '[REDACTED-JWT]');
}

async function readBody(r) {
  let text = null;
  let json = null;
  if (typeof r.text === 'function') {
    text = await r.text().catch(() => null);
    if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
  } else if (typeof r.json === 'function') {
    json = await r.json().catch(() => null);
  }
  return { text, json };
}

async function postJson(fetchImpl, url, body) {
  let r;
  try {
    r = await fetchImpl(url, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  } catch (err) {
    return { status: 0, json: null, text: null, networkError: String((err && err.message) || err) };
  }
  return { status: r.status, ...(await readBody(r)) };
}

async function getJson(fetchImpl, url, params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v != null) qs.set(k, String(v));
  const full = qs.toString() ? `${url}?${qs.toString()}` : url;
  let r;
  try {
    r = await fetchImpl(full, { method: 'GET', headers: authHeaders() });
  } catch (err) {
    return { status: 0, json: null, text: null, url: full, networkError: String((err && err.message) || err) };
  }
  return { status: r.status, url: full, ...(await readBody(r)) };
}

/** A bounded, redacted description of what actually came back. */
function describeBody({ json, text }) {
  if (isPlainObject(json)) return `JSON object, keys: [${Object.keys(json).join(', ')}]`;
  if (Array.isArray(json)) return `JSON array (${json.length} items)`;
  if (json != null) return `JSON ${typeof json}`;
  if (text == null || text === '') return 'empty body';
  const head = redactJwts(text).replace(/\s+/g, ' ').trim().slice(0, 200);
  const kind = /^\s*<(!doctype|html)/i.test(text) ? 'an HTML document' : 'non-JSON text';
  return `${kind}: ${head}${text.length > 200 ? '...' : ''}`;
}

/**
 * Raised when a leg does not answer the way an API endpoint answers - a 404/405, or a body that is
 * not a JSON object.
 *
 * These paths are NOT guesses; they are read off GoComet's own shipped login bundle. So this error
 * does not say "your path is probably wrong" - it says the contract MOVED, which is a different
 * and much rarer thing, and names the env var that re-pins it without a code change. The
 * not-a-JSON-object rule is kept deliberately strict: a Next.js page route answers 200 with HTML,
 * and trusting the status code alone is what would let a page masquerade as an endpoint and fail
 * much later, unrecognisably, as a bad OTP.
 */
function unexpectedShapeError(leg, url, res, why, envVar) {
  const e = new Error([
    `GoComet OTP ${leg} did not answer like an API endpoint - ${why}.`,
    `  called:   ${url}`,
    '  expected: HTTP 2xx with a JSON object body',
    `  got:      HTTP ${res.status || 'no response'}${res.networkError ? ` (${res.networkError})` : ''}, ${describeBody(res)}`,
    '',
    'This path was read off GoComet\'s own shipped login bundle (login-ea2fcd48bd6b6382.js), so it',
    'is not a guess. An answer like this means the contract MOVED - GoComet redeployed the login',
    'page - or the configured host is wrong. It does NOT mean the account is broken.',
    '',
    `Re-pin it with ${envVar} (no code change), and confirm the live flow with:`,
    '  node scripts/probe-gocomet-otp.js --i-understand-this-sends-a-real-otp --email <addr>',
  ].join('\n'));
  e.code = 'GC_OTP_UNEXPECTED_SHAPE';
  e.leg = leg;
  e.endpoint = url;
  e.status = res.status;
  return e;
}

/** Shared gate: 404/405 and non-JSON-object bodies are contract failures, whatever the status. */
function assertApiShaped(leg, url, res, envVar) {
  if (res.status === 404 || res.status === 405) {
    throw unexpectedShapeError(leg, url, res, `HTTP ${res.status} means no such route or method`, envVar);
  }
  if (!isPlainObject(res.json)) {
    throw unexpectedShapeError(leg, url, res, 'the body is not a JSON object', envVar);
  }
}

/**
 * Legs 1-2 - check the address is known, then ask GoComet to mail a one-time code.
 *
 * Returns `{sessionRef, shortLivedToken, email}`; spread the whole result into verifyOtp
 * (`verifyOtp({...started, otp})`), which needs BOTH the handle and the address.
 */
async function requestOtp({
  email, fetchImpl = fetch, skipUserCheck = false,
  authBaseUrl, otpUserCheckPath, otpRequestPath, otpVerifyPath, otpLoginPath,
} = {}) {
  const addr = String(email == null ? '' : email).trim();
  if (!addr) {
    const e = new Error('GoComet OTP: an email address is required to request a code.');
    e.code = 'GC_OTP_EMAIL_REQUIRED';
    throw e;
  }
  const p = authProfile({ authBaseUrl, otpUserCheckPath, otpRequestPath, otpVerifyPath, otpLoginPath });

  // ---- leg 1: precheck. Refuse on a DEFINITE no; never block on anything else. ----
  //
  // The asymmetry is deliberate. `user_present:false` is an authoritative answer and gives the
  // operator the one message that actually helps ("this address has no GoComet account"), which is
  // exactly what the portal shows. But this endpoint is only a courtesy - the authoritative check
  // is leg 2 itself - so a precheck that 404s, times out or answers oddly must NOT take the whole
  // re-auth down with it. Failing closed here would turn a non-essential endpoint into a hard
  // dependency of BRL's only route back to a working GoComet session.
  let userCheck = null;
  if (!skipUserCheck) {
    const res1 = await getJson(fetchImpl, p.userCheckUrl, { email: addr });
    const present = readEither(res1.json, 'user_present');
    if (res1.status >= 200 && res1.status < 300 && present === false) {
      const e = new Error(`GoComet: ${addr} is not registered as a user. Use the address the GoComet account's login is under.`);
      e.code = 'GC_OTP_USER_NOT_REGISTERED';
      throw e;
    }
    userCheck = present === undefined ? 'inconclusive' : 'present';
  }

  // ---- leg 2: mail the code ----
  const res = await postJson(fetchImpl, p.requestUrl, { email: addr });
  assertApiShaped('leg 2 (send-email-otp)', p.requestUrl, res, 'GC_OTP_REQUEST_PATH');

  if (res.status < 200 || res.status >= 300) {
    // The endpoint EXISTS and answered like an API - it just refused. A rate limit or a locked
    // account lands here, and none of that is fixed by re-pinning a path, so this deliberately
    // does not carry the contract-moved framing above.
    const e = new Error(
      `GoComet refused to send the code (HTTP ${res.status}) at ${p.requestUrl}: `
      + `${redactJwts(res.json.message || res.json.error || JSON.stringify(res.json).slice(0, 200))}`,
    );
    e.code = 'GC_OTP_SEND_REFUSED';
    e.status = res.status;
    throw e;
  }

  const handle = readEither(res.json, SHORT_LIVED_TOKEN_KEY);
  if (typeof handle !== 'string' || !handle) {
    // Without this the remaining two legs cannot run at all - it is the thread through 2 -> 3 -> 4.
    const e = new Error([
      `GoComet sent no \`${SHORT_LIVED_TOKEN_KEY}\` from ${p.requestUrl}, so the code cannot be verified.`,
      `  got: HTTP ${res.status}, ${describeBody(res)}`,
      `  expected: \`${SHORT_LIVED_TOKEN_KEY}\` at the top level or under \`data\` (both are read).`,
      '  A code may still have been emailed; it is unusable without this handle.',
    ].join('\n'));
    e.code = 'GC_OTP_NO_SESSION_HANDLE';
    throw e;
  }

  return { sessionRef: handle, shortLivedToken: handle, email: addr, userCheck };
}

/**
 * Legs 3-4 - check the code, then exchange it for the JWT, then validate the JWT offline.
 *
 * `sessionRef` is the `short_lived_token` from requestOtp; `email` is required too, because the
 * final login call sends both. Spreading requestOtp's whole result is the intended call shape.
 */
async function verifyOtp({
  sessionRef, otp, email = null, redirectUrl = null,
  fetchImpl = fetch, now = Date.now,
  authBaseUrl, otpUserCheckPath, otpRequestPath, otpVerifyPath, otpLoginPath,
} = {}) {
  const p = authProfile({ authBaseUrl, otpUserCheckPath, otpRequestPath, otpVerifyPath, otpLoginPath });
  const handle = String(sessionRef == null ? '' : sessionRef).trim();
  const addr = String(email == null ? '' : email).trim();
  const code = String(otp == null ? '' : otp).trim();

  if (!addr) {
    const e = new Error('GoComet OTP: the email address is required to verify a code - pass requestOtp\'s whole result through (verifyOtp({...started, otp})).');
    e.code = 'GC_OTP_EMAIL_REQUIRED';
    throw e;
  }
  if (!handle) {
    const e = new Error(`GoComet OTP: the \`${SHORT_LIVED_TOKEN_KEY}\` from requestOtp is required - the login call will not accept a code without it.`);
    e.code = 'GC_OTP_NO_SESSION_HANDLE';
    throw e;
  }
  // Checked locally, before either request. A malformed code cannot succeed, and spending the
  // short_lived_token on it would force the operator through another email round trip.
  if (!OTP_PATTERN.test(code)) {
    const e = new Error(`GoComet OTP: the code must be exactly 6 digits (got ${code.length} character${code.length === 1 ? '' : 's'}).`);
    e.code = 'GC_OTP_MALFORMED';
    throw e;
  }

  // ---- leg 3: check the code. A GET, with both values as query params. ----
  const res3 = await getJson(fetchImpl, p.verifyUrl, { otp: code, [SHORT_LIVED_TOKEN_KEY]: handle });
  assertApiShaped('leg 3 (verify-email-otp)', p.verifyUrl, res3, 'GC_OTP_VERIFY_PATH');
  if (res3.status < 200 || res3.status >= 300) {
    const e = new Error(`GoComet could not verify the code (HTTP ${res3.status}) at ${p.verifyUrl}: ${redactJwts(res3.json.message || res3.json.error || describeBody(res3))}`);
    e.code = 'GC_OTP_VERIFY_FAILED';
    e.status = res3.status;
    throw e;
  }
  if (!readEither(res3.json, 'success')) {
    // The portal's own wording for this exact condition. It is a USER error and the only one in
    // the flow that is fixed by trying again, so it must never be merged into the failures below.
    const e = new Error('Incorrect OTP. Check the code in the email and enter it again.');
    e.code = 'GC_OTP_INCORRECT';
    throw e;
  }

  // ---- leg 4: mint the JWT ----
  const body = {
    email: addr,
    otp: code,
    [SHORT_LIVED_TOKEN_KEY]: handle,
    // The login page computes a real reCAPTCHA token and the shared action then overwrites it with
    // these literals before the request leaves - which is what proves the server ignores it.
    recaptcha_token: 'abcd',
    recaptcha_token_type: 'v3',
  };
  if (redirectUrl) body.redirect_url = redirectUrl;

  const res4 = await postJson(fetchImpl, p.loginUrl, body);
  const token = extractToken(res4.json);

  if (!token && (res4.status === 401 || res4.status === 403 || (isPlainObject(res4.json) && res4.json.error))) {
    // Distinct from GC_OTP_INCORRECT on purpose: leg 3 already accepted this code, so a rejection
    // here is NOT the operator mistyping and retyping it will not help.
    const e = new Error(
      `GoComet rejected the login after accepting the code (HTTP ${res4.status}): `
      + redactJwts((isPlainObject(res4.json) && (res4.json.message || res4.json.error)) || 'no reason given')
      + '. The code was correct, so this is not a retype - the short-lived handle may have expired.',
    );
    e.code = 'GC_OTP_LOGIN_REJECTED';
    e.status = res4.status;
    throw e;
  }
  if (res4.status < 200 || res4.status >= 300 || !token) {
    const e = new Error([
      `GoComet OTP leg 4 (otp-login) returned no usable token from ${p.loginUrl}.`,
      `  got: HTTP ${res4.status}${res4.networkError ? ` (${res4.networkError})` : ''}, ${describeBody(res4)}`,
      '  expected: a top-level `token`. extractToken also accepts data.token, authToken,',
      '  accessToken and jwt, so this means the envelope changed shape entirely.',
    ].join('\n'));
    e.code = 'GC_OTP_LOGIN_FAILED';
    e.status = res4.status;
    throw e;
  }

  const clean = String(token).replace(/^Bearer\s+/i, '').trim();
  const { claims, expiresAt } = assertUsableToken(clean, { now });

  // `schemas` decides whether GoComet's own frontend would have sent this user to its account
  // picker (a vendor with more than one schema). The token is minted either way - the bundle
  // stores it before that branch - so this is reported, never fatal. It is surfaced because a
  // multi-schema account is the likeliest explanation if identityProbe then refuses the token.
  const schemas = isPlainObject(res4.json) && Array.isArray(res4.json.schemas) ? res4.json.schemas : [];
  return { token: clean, claims, expiresAt, schemas, tokenType: claims.token_type || null };
}

/** Read the JWT out of leg 4's envelope. Top-level `token` is the confirmed shape. */
function extractToken(j) {
  if (!j) return null;
  if (typeof j === 'string' && j) return j;
  if (!isPlainObject(j)) return null;
  const candidates = [j, isPlainObject(j.data) ? j.data : null, isPlainObject(j.user) ? j.user : null];
  for (const c of candidates) {
    if (!c) continue;
    const t = c.token || c.authToken || c.accessToken || c.jwt || c.access_token;
    if (typeof t === 'string' && t) return t;
  }
  return null;
}

/**
 * Validate a token OFFLINE before it is ever treated as a session - structure and expiry only.
 *
 * Reuses GoCometAdapter's own claim readers rather than a second JWT parser, so the check that
 * accepts a mint and the check the adapter later applies at login() cannot disagree. Catching a
 * paste error or an already-expired mint here makes it fail fast and locally, at the moment a
 * human is sitting there able to retry, instead of at the next auction.
 */
function assertUsableToken(token, { now = Date.now } = {}) {
  const claims = GoCometAdapter.jwtClaims(token);
  const expiresAt = GoCometAdapter.jwtExp(token);
  if (!claims || !expiresAt) {
    const e = new Error('GoComet OTP: the value returned is not a readable JWT (no decodable payload or no `exp` claim). Treating it as a session would fail at the next auction instead of now.');
    e.code = 'GC_TOKEN_MALFORMED';
    throw e;
  }
  if (now() >= expiresAt) {
    const e = new Error(`GoComet OTP: the minted token is ALREADY EXPIRED (exp ${new Date(expiresAt).toISOString()}). Check the clock on this host, then re-run the OTP flow.`);
    e.code = 'GC_TOKEN_EXPIRED';
    throw e;
  }
  return { claims, expiresAt };
}

/**
 * Prove a freshly minted token actually works on the VENDOR API before anything relies on it.
 *
 * A mint proves a login happened; it does not prove the resulting token is accepted where the
 * bidder needs it. The OTP token carries `token_type: web` and the vendor API is a different
 * surface, so "the OTP succeeded" and "the bidder can read enquiries" are two claims, and only
 * the second one matters. One cheap authenticated GET settles it, and only a 200 counts - a 401
 * or 403 means the mint is useless for bidding no matter how clean the login looked.
 *
 * NEVER called automatically: it is a live authenticated request, so it runs when a caller asks.
 */
async function identityProbe({ token, baseUrl, fetchImpl = fetch } = {}) {
  const bare = String(token == null ? '' : token).replace(/^Bearer\s+/i, '').trim();
  if (!bare) {
    const e = new Error('GoComet identity probe: no token supplied.');
    e.code = 'GC_IDENTITY_PROBE_FAILED';
    throw e;
  }
  const root = trimSlash(baseUrl || (config.gocomet && config.gocomet.baseUrl) || 'https://enquiry.gocomet.com');
  const url = `${root}${VENDOR_PROBE_PATH}`;
  let r;
  try {
    // Mirrors gocometAdapter._headers(). The BARE JWT with no `Bearer` prefix, plus the
    // schema/ops-client-schema pair, is load-bearing: prefixing it or dropping those headers
    // yields 401 on this API, which would make a perfectly good token look dead.
    r = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: bare,
        'ops-client-schema': 'app',
        origin: 'https://app.gocomet.com',
        referer: 'https://app.gocomet.com/',
        schema: 'app',
      },
    });
  } catch (err) {
    const e = new Error(`GoComet identity probe could not reach ${url}: ${String((err && err.message) || err)}`);
    e.code = 'GC_IDENTITY_PROBE_FAILED';
    throw e;
  }
  if (r.status !== 200) {
    const e = new Error(
      `GoComet identity probe FAILED (HTTP ${r.status}) on ${url}. The OTP mint succeeded but the `
      + 'token is not accepted on the vendor API, so it cannot bid. A 401/403 here usually means the '
      + 'account resolved to a different schema than `app` at login.',
    );
    e.code = 'GC_IDENTITY_PROBE_FAILED';
    e.status = r.status;
    throw e;
  }
  return { ok: true, status: 200, url };
}

module.exports = {
  requestOtp,
  verifyOtp,
  identityProbe,
  authProfile,
  extractToken,
  assertUsableToken,
  redactJwts,
  readEither,
  SHORT_LIVED_TOKEN_KEY,
  VENDOR_PROBE_PATH,
};
