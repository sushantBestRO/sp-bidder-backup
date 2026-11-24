'use strict';
/**
 * GoComet OTP re-auth wire client (src/auth/gcOtpAuth.js) - fully offline.
 *
 * Every call goes through an injected mock transport. Nothing here reaches a GoComet host, which
 * is not merely a test-hygiene point: a real leg-2 call MAILS A ONE-TIME CODE to BRL's live
 * vendor account, so a test that "accidentally" hit the network would be spamming a client's
 * inbox from CI.
 *
 * WHAT THIS PINS, in rough order of how much it matters:
 *
 *   A. THE FOUR LEGS, in order, with the right method and the right params - and in particular
 *      that `short_lived_token` threads leg 2 -> 3 -> 4. The final login REQUIRES it, and an
 *      earlier draft of this module omitted it entirely (it modelled the flow as two legs), which
 *      would have failed against a real server while passing any test that did not check the body.
 *   B. FAILURES STAY DISTINGUISHABLE. Leg 3 failing means the human mistyped the code and should
 *      retype it; leg 4 failing means the code was accepted and the login broke, so retyping is
 *      useless. Collapsing those into one "auth failed" sends an operator to re-read a correct
 *      email, so the two codes are pinned apart explicitly.
 *   C. BOTH ENVELOPE PLACEMENTS. The shipped bundle reads `.data.short_lived_token` through a
 *      helper we do not hold, so whether that is an axios wrapper (fields top-level) or a real
 *      nested envelope is genuinely unsettled. The module reads both; this pins both, because
 *      picking one on a code-reading inference is precisely how the SuperProcure PMT `amount`
 *      belief flipped twice, the second time shipping a defect.
 *   D. The strict "a 200 that is not a JSON object is refused" rule. A Next.js PAGE route answers
 *      200 with HTML - trusting the status code would let a page masquerade as an endpoint and
 *      fail much later, unrecognisably, as a bad OTP.
 *   E. The offline JWT gate and the vendor-API identity probe.
 *
 *   node scripts/test-gc-otp-auth.js
 */
const gc = require('../src/auth/gcOtpAuth');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Every check below must run. A file that exits 0 having asserted nothing is a silent green run
// in this project's exit-code-graded runner, so the sentinel at the bottom pins the count.
const EXPECTED_CHECKS = 122;

// ---- test doubles ------------------------------------------------------------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
/** A structurally-valid JWT (header.payload.sig); the signature is never checked offline. */
function makeToken(claims) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}
const liveToken = () => makeToken({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', token_type: 'web' });
const deadToken = () => makeToken({ exp: Math.floor(Date.now() / 1000) - 60, user_id: 'u1', token_type: 'web' });

/**
 * `handler(url, init, index)` returns {status, body}. A string body is sent verbatim (so an HTML
 * page can be simulated); anything else is JSON-stringified. Records every call.
 */
function mockFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const [path, query] = String(url).split('?');
    calls.push({
      url, path, method,
      query: Object.fromEntries(new URLSearchParams(query || '')),
      body: init && init.body ? JSON.parse(init.body) : null,
      init,
    });
    const r = handler(url, init, calls.length - 1) || {};
    const text = r.body === undefined ? '' : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return { status: r.status, text: async () => text };
  };
  f.calls = calls;
  return f;
}

const PROFILE = {
  authBaseUrl: 'https://login.example.test',
  otpUserCheckPath: '/api/v1/login/is-user-present',
  otpRequestPath: '/api/v1/engagement-app/send-email-otp',
  otpVerifyPath: '/api/v1/engagement-app/verify-email-otp',
  otpLoginPath: '/api/v1/login/otp-login',
};
const EMAIL = 'ops@bestroadways.test';
const HANDLE = 'slt-abc123';
const OTP = '123456';

async function grab(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/**
 * The happy-path server, parameterised by which envelope it answers in. `nest` puts
 * short_lived_token / success / user_present under `data`, which is the reading that holds if
 * GoComet's postRequest helper is NOT axios.
 */
function happyServer({ nest = false, token = null } = {}) {
  const wrap = (o) => (nest ? { data: o } : o);
  return (url) => {
    if (url.includes('is-user-present')) return { status: 200, body: wrap({ user_present: true }) };
    if (url.includes('send-email-otp')) return { status: 200, body: wrap({ short_lived_token: HANDLE }) };
    if (url.includes('verify-email-otp')) return { status: 200, body: wrap({ success: true }) };
    if (url.includes('otp-login')) return { status: 200, body: { token: token || liveToken(), schemas: ['app'], user: { company_type: 'vendor' } } };
    return { status: 404, body: { error: 'unexpected path' } };
  };
}

// ---- A. authProfile: four config-driven legs ---------------------------------------------------

(function groupA() {
  const p = gc.authProfile();
  ok(p.base === 'https://login.gocomet.com', `A1 default host from config, got ${p.base}`);
  ok(p.userCheckPath === '/api/v1/login/is-user-present', `A2 leg-1 precheck path, got ${p.userCheckPath}`);
  ok(p.requestPath === '/api/v1/engagement-app/send-email-otp', `A3 leg-2 send path (read off the shipped bundle), got ${p.requestPath}`);
  ok(p.verifyPath === '/api/v1/engagement-app/verify-email-otp', `A4 leg-3 verify path, got ${p.verifyPath}`);
  ok(p.loginPath === '/api/v1/login/otp-login', `A5 leg-4 login path, got ${p.loginPath}`);

  // The refuted candidate must not creep back in as any leg's default.
  const all = [p.userCheckPath, p.requestPath, p.verifyPath, p.loginPath].join(' ');
  ok(!/login\/send-otp/.test(all), 'A6 the old convention-derived guess `login/send-otp` is gone');
  ok(!/login\/type/.test(all), 'A7 `/login/type` (a Next.js PAGE route) is not used as an auth path');

  // Each leg is independently re-pinnable, so a GoComet redeploy is an env change not a code change.
  const o = gc.authProfile({ otpRequestPath: '/api/v1/engagement-app/send-email-otp-v2' });
  ok(o.requestUrl === 'https://login.gocomet.com/api/v1/engagement-app/send-email-otp-v2', `A8 leg 2 is overridable alone, got ${o.requestUrl}`);
  ok(o.loginUrl === 'https://login.gocomet.com/api/v1/login/otp-login', 'A9 overriding one leg leaves the others untouched');
  ok(gc.authProfile({ authBaseUrl: 'https://h.test/' }).base === 'https://h.test', 'A10 trailing slash trimmed off the host');
})();

// ---- B. the four legs, in order, with the right shapes -------------------------------------------

async function groupB() {
  const f = mockFetch(happyServer());
  const started = await gc.requestOtp({ email: EMAIL, fetchImpl: f, ...PROFILE });
  const out = await gc.verifyOtp({ ...started, otp: OTP, fetchImpl: f, ...PROFILE });

  ok(f.calls.length === 4, `B1 exactly four legs are performed, got ${f.calls.length}`);

  const [c1, c2, c3, c4] = f.calls;
  ok(c1.method === 'GET' && c1.path.endsWith('/api/v1/login/is-user-present'), `B2 leg 1 is a GET to is-user-present, got ${c1.method} ${c1.path}`);
  ok(c1.query.email === EMAIL, 'B3 leg 1 passes the address as a query param');

  ok(c2.method === 'POST' && c2.path.endsWith('/api/v1/engagement-app/send-email-otp'), `B4 leg 2 is a POST to send-email-otp, got ${c2.method} ${c2.path}`);
  ok(c2.body.email === EMAIL, 'B5 leg 2 posts {email}');
  ok(c2.body.otp === undefined, 'B6 leg 2 sends no code - it is what CAUSES the code to be mailed');

  // Leg 3 is a GET with BOTH values in the query string - not a POST body.
  ok(c3.method === 'GET' && c3.path.endsWith('/api/v1/engagement-app/verify-email-otp'), `B7 leg 3 is a GET to verify-email-otp, got ${c3.method} ${c3.path}`);
  ok(c3.query.otp === OTP, 'B8 leg 3 passes the code as a query param');
  ok(c3.query.short_lived_token === HANDLE, 'B9 leg 3 passes the short_lived_token as a query param');
  ok(c3.body === null, 'B10 leg 3 has no request body (it is a GET)');

  // THE REGRESSION THIS FILE EXISTS FOR: leg 4 must carry short_lived_token.
  ok(c4.method === 'POST' && c4.path.endsWith('/api/v1/login/otp-login'), `B11 leg 4 is a POST to otp-login, got ${c4.method} ${c4.path}`);
  ok(c4.body.short_lived_token === HANDLE, 'B12 leg 4 carries short_lived_token - the login is refused without it');
  ok(c4.body.email === EMAIL, 'B13 leg 4 carries the email');
  ok(c4.body.otp === OTP, 'B14 leg 4 carries the code');
  ok(c4.body.recaptcha_token === 'abcd', 'B15 leg 4 sends the literal recaptcha placeholder the shipped action overwrites with');
  ok(c4.body.recaptcha_token_type === 'v3', 'B16 leg 4 sends the recaptcha type');
  ok(c4.body.redirect_url === undefined, 'B17 redirect_url is omitted unless asked for');

  ok(out.token && out.claims.user_id === 'u1', 'B18 the JWT is returned with decoded claims');
  ok(out.expiresAt > Date.now(), 'B19 the expiry is resolved from the exp claim');
  ok(out.tokenType === 'web', `B20 token_type is surfaced (the OTP mint is a web token), got ${out.tokenType}`);
  ok(Array.isArray(out.schemas) && out.schemas[0] === 'app', 'B21 schemas are surfaced for the multi-schema case');
  ok(started.sessionRef === HANDLE && started.shortLivedToken === HANDLE, 'B22 requestOtp hands back the handle as the session ref');
  ok(started.email === EMAIL, 'B23 requestOtp carries the email forward (leg 4 needs it)');

  const f2 = mockFetch(happyServer());
  await gc.verifyOtp({ sessionRef: HANDLE, email: EMAIL, otp: OTP, redirectUrl: 'https://app.gocomet.com/enquiry/spot', fetchImpl: f2, ...PROFILE });
  ok(f2.calls[1].body.redirect_url === 'https://app.gocomet.com/enquiry/spot', 'B24 an explicit redirect_url is passed through');

  // The precheck is skippable, and skipping it removes exactly one call.
  const f3 = mockFetch(happyServer());
  await gc.requestOtp({ email: EMAIL, fetchImpl: f3, skipUserCheck: true, ...PROFILE });
  ok(f3.calls.length === 1 && f3.calls[0].path.endsWith('send-email-otp'), `B25 skipUserCheck drops leg 1 only, got ${f3.calls.length} calls`);
}

// ---- C. both envelope placements ----------------------------------------------------------------

async function groupC() {
  // Nested `data` - the reading that holds if postRequest/getRequest are NOT axios.
  const fN = mockFetch(happyServer({ nest: true }));
  const startedN = await gc.requestOtp({ email: EMAIL, fetchImpl: fN, ...PROFILE });
  ok(startedN.shortLivedToken === HANDLE, 'C1 short_lived_token is read from a nested data envelope');
  const outN = await gc.verifyOtp({ ...startedN, otp: OTP, fetchImpl: fN, ...PROFILE });
  ok(outN.token, 'C2 a nested `data.success` still satisfies leg 3');

  // Top-level - the reading that holds if they ARE axios.
  const fT = mockFetch(happyServer({ nest: false }));
  const startedT = await gc.requestOtp({ email: EMAIL, fetchImpl: fT, ...PROFILE });
  ok(startedT.shortLivedToken === HANDLE, 'C3 short_lived_token is read from the top level');
  ok((await gc.verifyOtp({ ...startedT, otp: OTP, fetchImpl: fT, ...PROFILE })).token, 'C4 a top-level `success` satisfies leg 3');

  ok(gc.readEither({ a: 1 }, 'a') === 1, 'C5 readEither prefers the top level');
  ok(gc.readEither({ data: { a: 2 } }, 'a') === 2, 'C6 readEither falls through to data');
  ok(gc.readEither({ a: 1, data: { a: 2 } }, 'a') === 1, 'C7 the top level wins when both are present');
  ok(gc.readEither(null, 'a') === undefined, 'C8 readEither is null-safe');

  // A nested false must not be mistaken for absent - it is an authoritative negative.
  const fAbsent = mockFetch((url) => (url.includes('is-user-present')
    ? { status: 200, body: { data: { user_present: false } } }
    : { status: 200, body: { short_lived_token: HANDLE } }));
  const eAbsent = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fAbsent, ...PROFILE }));
  ok(eAbsent && eAbsent.code === 'GC_OTP_USER_NOT_REGISTERED', 'C9 a nested user_present:false is honoured');
}

// ---- D. leg 1 precheck: refuse a definite no, never block on anything else -----------------------

async function groupD() {
  const fNo = mockFetch((url) => (url.includes('is-user-present')
    ? { status: 200, body: { user_present: false } }
    : { status: 200, body: { short_lived_token: HANDLE } }));
  const eNo = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fNo, ...PROFILE }));
  ok(eNo && eNo.code === 'GC_OTP_USER_NOT_REGISTERED', `D1 user_present:false refuses before mailing anything (got ${eNo && eNo.code})`);
  ok(/not registered/.test(eNo.message), 'D2 the message matches what the portal itself says');
  ok(fNo.calls.length === 1, `D3 nothing is mailed after a definite no, got ${fNo.calls.length} calls`);

  // FAIL-OPEN on a broken precheck. It is a courtesy endpoint; the authoritative check is leg 2.
  // Failing closed here would make a non-essential endpoint a hard dependency of BRL's only route
  // back to a working GoComet session.
  const f404 = mockFetch((url) => (url.includes('is-user-present')
    ? { status: 404, body: { error: 'gone' } }
    : { status: 200, body: { short_lived_token: HANDLE } }));
  const s404 = await gc.requestOtp({ email: EMAIL, fetchImpl: f404, ...PROFILE });
  ok(s404.shortLivedToken === HANDLE, 'D4 a 404 on the precheck does NOT block the flow');
  ok(s404.userCheck === 'inconclusive', `D5 the inconclusive precheck is reported honestly, got ${s404.userCheck}`);

  const fBoom = mockFetch((url) => { if (url.includes('is-user-present')) throw new Error('ETIMEDOUT'); return { status: 200, body: { short_lived_token: HANDLE } }; });
  ok((await gc.requestOtp({ email: EMAIL, fetchImpl: fBoom, ...PROFILE })).shortLivedToken === HANDLE, 'D6 an unreachable precheck does not block the flow');

  const fHtml = mockFetch((url) => (url.includes('is-user-present')
    ? { status: 200, body: '<!DOCTYPE html><html>...' }
    : { status: 200, body: { short_lived_token: HANDLE } }));
  ok((await gc.requestOtp({ email: EMAIL, fetchImpl: fHtml, ...PROFILE })).shortLivedToken === HANDLE, 'D7 an HTML answer from the precheck does not block the flow');

  const eNoEmail = await grab(() => gc.requestOtp({ fetchImpl: mockFetch(happyServer()), ...PROFILE }));
  ok(eNoEmail && eNoEmail.code === 'GC_OTP_EMAIL_REQUIRED', 'D8 a missing address is refused before any request');
}

// ---- E. leg 2 shape failures: contract-moved vs refused ------------------------------------------

function sendServer(res) {
  return (url) => (url.includes('is-user-present') ? { status: 200, body: { user_present: true } } : res);
}

async function groupE() {
  const f404 = mockFetch(sendServer({ status: 404, body: { error: 'Not Found' } }));
  const e404 = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: f404, ...PROFILE }));
  ok(e404 && e404.code === 'GC_OTP_UNEXPECTED_SHAPE', `E1 a 404 on leg 2 is a contract failure (got ${e404 && e404.code})`);
  ok(/leg 2 \(send-email-otp\)/.test(e404.message), 'E2 the error names WHICH leg failed');
  ok(/https:\/\/login\.example\.test\/api\/v1\/engagement-app\/send-email-otp/.test(e404.message), 'E3 the error names the exact endpoint it called');
  ok(/HTTP 404/.test(e404.message), 'E4 the error states what actually came back');
  ok(/expected: HTTP 2xx with a JSON object body/.test(e404.message), 'E5 the error states what it expected');
  ok(/GC_OTP_REQUEST_PATH/.test(e404.message), 'E6 the error names the env var that re-pins this leg');
  ok(/shipped login bundle/.test(e404.message), 'E7 the error says the path was READ off shipped code');
  ok(/not a guess/.test(e404.message), 'E8 the error no longer calls the path a guess');
  ok(/contract MOVED/.test(e404.message), 'E9 the error names the actual likely cause - a GoComet redeploy');
  ok(!/CONFIGURED GUESS/.test(e404.message), 'E10 the old guess framing is gone');
  ok(e404.leg === 'leg 2 (send-email-otp)' && e404.endpoint, 'E11 the leg and endpoint are machine-readable on the error');

  // THE TRAP, kept: a Next.js PAGE route answers 200 with HTML. Status alone would accept it.
  const fHtml = mockFetch(sendServer({ status: 200, body: '<!DOCTYPE html><html><head><title>GoComet</title></head><body>...' }));
  const eHtml = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fHtml, ...PROFILE }));
  ok(eHtml && eHtml.code === 'GC_OTP_UNEXPECTED_SHAPE', `E12 a 200 carrying HTML is REFUSED, not accepted (got ${eHtml && eHtml.code})`);
  ok(/not a JSON object/.test(eHtml.message), 'E13 the error says why the 200 was refused');
  ok(/an HTML document/.test(eHtml.message), 'E14 the error identifies the body as HTML - i.e. a page route');

  const f405 = mockFetch(sendServer({ status: 405, body: { error: 'Method Not Allowed' } }));
  ok((await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: f405, ...PROFILE }))).code === 'GC_OTP_UNEXPECTED_SHAPE', 'E15 a 405 is also a contract failure');

  const fEmpty = mockFetch(sendServer({ status: 200 }));
  const eEmpty = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fEmpty, ...PROFILE }));
  ok(eEmpty && eEmpty.code === 'GC_OTP_UNEXPECTED_SHAPE' && /empty body/.test(eEmpty.message), 'E16 a 200 with an empty body is refused and says so');

  // The other side of the line: the endpoint exists and answered like an API - it just refused.
  const f429 = mockFetch(sendServer({ status: 429, body: { message: 'Too many requests. Try again later.' } }));
  const e429 = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: f429, ...PROFILE }));
  ok(e429 && e429.code === 'GC_OTP_SEND_REFUSED', `E17 an API-shaped refusal is distinguished from a moved contract (got ${e429 && e429.code})`);
  ok(/Too many requests/.test(e429.message), "E18 the server's own reason is surfaced");
  ok(!/contract MOVED/.test(e429.message), 'E19 a genuine refusal does not blame the configured path');

  // A 200 with no handle: the remaining legs are impossible, and that must be said plainly.
  const fNoHandle = mockFetch(sendServer({ status: 200, body: { message: 'ok' } }));
  const eNoHandle = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fNoHandle, ...PROFILE }));
  ok(eNoHandle && eNoHandle.code === 'GC_OTP_NO_SESSION_HANDLE', `E20 a 200 with no short_lived_token fails loudly (got ${eNoHandle && eNoHandle.code})`);
  ok(/keys: \[message\]/.test(eNoHandle.message), 'E21 the error reports which keys DID arrive');
  ok(/top level or under `data`/.test(eNoHandle.message), 'E22 the error states both placements were checked');
  ok(/may still have been emailed/.test(eNoHandle.message), 'E23 the error warns a code may have been sent anyway');

  const fNet = mockFetch(() => ({ status: 200, body: { user_present: true } }));
  const fThrow = async (url, init) => { if (url.includes('send-email-otp')) throw new Error('ENOTFOUND'); return fNet(url, init); };
  const eNet = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fThrow, ...PROFILE }));
  ok(eNet && eNet.code === 'GC_OTP_UNEXPECTED_SHAPE' && /ENOTFOUND/.test(eNet.message), 'E24 an unreachable host reports the cause and the endpoint');
}

// ---- F. leg 3 vs leg 4: the failures must stay distinguishable ------------------------------------

function legServer({ verify, login }) {
  return (url) => {
    if (url.includes('verify-email-otp')) return verify;
    if (url.includes('otp-login')) return login;
    return { status: 404, body: {} };
  };
}

async function groupF() {
  const base = { sessionRef: HANDLE, email: EMAIL, otp: OTP, ...PROFILE };

  // Leg 3 says the code is wrong. THIS is the user error - the only retryable one in the flow.
  const fBad = mockFetch(legServer({ verify: { status: 200, body: { success: false } }, login: { status: 200, body: { token: liveToken() } } }));
  const eBad = await grab(() => gc.verifyOtp({ ...base, fetchImpl: fBad }));
  ok(eBad && eBad.code === 'GC_OTP_INCORRECT', `F1 a falsy success on leg 3 is a bad code (got ${eBad && eBad.code})`);
  ok(/Incorrect OTP/.test(eBad.message), 'F2 the portal wording is used');
  ok(/enter it again/.test(eBad.message), 'F3 the message tells the operator to retype');
  ok(fBad.calls.length === 1, `F4 leg 4 is NOT attempted after leg 3 rejects the code, got ${fBad.calls.length} calls`);

  // Leg 4 fails AFTER leg 3 accepted the code. Retyping cannot help, and the error must say so.
  const f401 = mockFetch(legServer({ verify: { status: 200, body: { success: true } }, login: { status: 401, body: { message: 'Session expired' } } }));
  const e401 = await grab(() => gc.verifyOtp({ ...base, fetchImpl: f401 }));
  ok(e401 && e401.code === 'GC_OTP_LOGIN_REJECTED', `F5 a leg-4 rejection is NOT reported as a bad code (got ${e401 && e401.code})`);
  ok(e401.code !== 'GC_OTP_INCORRECT', 'F6 leg 3 and leg 4 failures carry different codes');
  ok(/not a retype/.test(e401.message), 'F7 the leg-4 error tells the operator retyping will not help');
  ok(/Session expired/.test(e401.message), "F8 the server's reason is surfaced");

  const fNoTok = mockFetch(legServer({ verify: { status: 200, body: { success: true } }, login: { status: 200, body: { message: 'ok' } } }));
  const eNoTok = await grab(() => gc.verifyOtp({ ...base, fetchImpl: fNoTok }));
  ok(eNoTok && eNoTok.code === 'GC_OTP_LOGIN_FAILED', `F9 a tokenless 200 on leg 4 fails loudly (got ${eNoTok && eNoTok.code})`);
  ok(/keys: \[message\]/.test(eNoTok.message), 'F10 the error reports which keys DID arrive');

  const fV404 = mockFetch(legServer({ verify: { status: 404, body: { error: 'gone' } }, login: { status: 200, body: {} } }));
  const eV404 = await grab(() => gc.verifyOtp({ ...base, fetchImpl: fV404 }));
  ok(eV404 && eV404.code === 'GC_OTP_UNEXPECTED_SHAPE', 'F11 a moved leg-3 contract is a shape failure');
  ok(/leg 3 \(verify-email-otp\)/.test(eV404.message) && /GC_OTP_VERIFY_PATH/.test(eV404.message), 'F12 it names leg 3 and leg 3\'s env var');

  const fV500 = mockFetch(legServer({ verify: { status: 500, body: { message: 'boom' } }, login: { status: 200, body: {} } }));
  const eV500 = await grab(() => gc.verifyOtp({ ...base, fetchImpl: fV500 }));
  ok(eV500 && eV500.code === 'GC_OTP_VERIFY_FAILED', `F13 a 5xx on leg 3 is a verify failure, not a bad code (got ${eV500 && eV500.code})`);

  // Local guards - these must cost zero requests, because a wasted attempt burns the handle.
  const fGuard = mockFetch(happyServer());
  const eShort = await grab(() => gc.verifyOtp({ ...base, otp: '123', fetchImpl: fGuard }));
  ok(eShort && eShort.code === 'GC_OTP_MALFORMED', `F14 a short code is refused locally (got ${eShort && eShort.code})`);
  ok(/exactly 6 digits/.test(eShort.message), 'F15 the malformed-code message states the rule');
  ok((await grab(() => gc.verifyOtp({ ...base, otp: 'abcdef', fetchImpl: fGuard }))).code === 'GC_OTP_MALFORMED', 'F16 a non-numeric code is refused locally');
  ok(fGuard.calls.length === 0, `F17 a malformed code costs ZERO requests - it must not burn the handle, got ${fGuard.calls.length}`);

  const eNoHandle = await grab(() => gc.verifyOtp({ email: EMAIL, otp: OTP, fetchImpl: fGuard, ...PROFILE }));
  ok(eNoHandle && eNoHandle.code === 'GC_OTP_NO_SESSION_HANDLE', 'F18 verifying without the handle is refused with a specific code');
  const eNoMail = await grab(() => gc.verifyOtp({ sessionRef: HANDLE, otp: OTP, fetchImpl: fGuard, ...PROFILE }));
  ok(eNoMail && eNoMail.code === 'GC_OTP_EMAIL_REQUIRED', 'F19 verifying without the email is refused');
  ok(/verifyOtp\(\{\.\.\.started, otp\}\)/.test(eNoMail.message), 'F20 that error shows the intended call shape');
}

// ---- G. token extraction + the offline JWT gate ---------------------------------------------------

async function groupG() {
  const tok = liveToken();
  const base = { sessionRef: HANDLE, email: EMAIL, otp: OTP, ...PROFILE };
  const withLogin = (body, status = 200) => mockFetch(legServer({ verify: { status: 200, body: { success: true } }, login: { status, body } }));

  ok((await gc.verifyOtp({ ...base, fetchImpl: withLogin({ token: `Bearer ${tok}` }) })).token === tok, 'G1 a Bearer prefix is stripped off the minted token');
  ok((await gc.verifyOtp({ ...base, fetchImpl: withLogin({ data: { token: tok } }) })).token === tok, 'G2 a nested data.token envelope is still read');
  ok(gc.extractToken({ accessToken: tok }) === tok, 'G3 extractToken accepts an accessToken alias');
  ok(gc.extractToken({ nothing: 1 }) === null, 'G4 extractToken invents nothing when there is no token');

  const eJunk = await grab(() => gc.verifyOtp({ ...base, fetchImpl: withLogin({ token: 'not-a-jwt-at-all' }) }));
  ok(eJunk && eJunk.code === 'GC_TOKEN_MALFORMED', `G5 a non-JWT value is refused offline (got ${eJunk && eJunk.code})`);

  const eNoExp = await grab(() => gc.verifyOtp({ ...base, fetchImpl: withLogin({ token: makeToken({ user_id: 'u1' }) }) }));
  ok(eNoExp && eNoExp.code === 'GC_TOKEN_MALFORMED', 'G6 a JWT with no exp claim is refused (nothing could watch its expiry)');

  const eDead = await grab(() => gc.verifyOtp({ ...base, fetchImpl: withLogin({ token: deadToken() }) }));
  ok(eDead && eDead.code === 'GC_TOKEN_EXPIRED', `G7 an already-expired mint is refused offline (got ${eDead && eDead.code})`);
  ok(/ALREADY EXPIRED/.test(eDead.message), 'G8 the expiry error is unmistakable');
  ok(/clock/.test(eDead.message), 'G9 the error names the host clock, the usual cause of a dead-on-arrival mint');

  ok(gc.assertUsableToken(tok).expiresAt > Date.now(), 'G10 assertUsableToken accepts a live token standalone');
  ok(grab(() => gc.assertUsableToken(deadToken())) !== null, 'G11 assertUsableToken refuses a dead one standalone');
}

// ---- H. the identity probe -----------------------------------------------------------------------

async function groupH() {
  const tok = liveToken();
  const f200 = mockFetch(() => ({ status: 200, body: { data: [] } }));
  const res = await gc.identityProbe({ token: tok, baseUrl: 'https://enquiry.example.test', fetchImpl: f200 });
  ok(res.ok === true && res.status === 200, 'H1 a 200 on the vendor API accepts the mint');
  ok(/\/api\/v1\/vendor\/enquiries\/spot\?page=1&size=1$/.test(f200.calls[0].url), `H2 probes the vendor spot surface, got ${f200.calls[0].url}`);
  ok(f200.calls[0].init.headers.authorization === tok, 'H3 the JWT is sent BARE - a Bearer prefix 401s on this API');
  ok(f200.calls[0].init.headers.schema === 'app' && f200.calls[0].init.headers['ops-client-schema'] === 'app', 'H4 the schema header pair the API requires is present');

  const f401 = mockFetch(() => ({ status: 401, body: { error: 'unauthorized' } }));
  const e401 = await grab(() => gc.identityProbe({ token: tok, baseUrl: 'https://enquiry.example.test', fetchImpl: f401 }));
  ok(e401 && e401.code === 'GC_IDENTITY_PROBE_FAILED', `H5 a 401 REFUSES the mint (got ${e401 && e401.code})`);
  ok(e401.status === 401, 'H6 the status is machine-readable on the error');
  ok(/cannot bid/.test(e401.message), 'H7 the error states the consequence: this token cannot bid');

  const f302 = mockFetch(() => ({ status: 302, body: '' }));
  ok((await grab(() => gc.identityProbe({ token: tok, baseUrl: 'https://e.test', fetchImpl: f302 }))) !== null, 'H8 a non-200 (302) is refused - only 200 is accepted');
  ok((await grab(() => gc.identityProbe({ fetchImpl: f200 }))) !== null, 'H9 an absent token is refused before any request');

  // It must never fire on its own - a mint is not allowed to become a live authenticated request.
  const fFlow = mockFetch(happyServer());
  const started = await gc.requestOtp({ email: EMAIL, fetchImpl: fFlow, ...PROFILE });
  await gc.verifyOtp({ ...started, otp: OTP, fetchImpl: fFlow, ...PROFILE });
  ok(!fFlow.calls.some((c) => c.path.includes('/vendor/')), 'H10 the vendor API is never touched automatically by the OTP flow');
}

// ---- I. no credential ever reaches an error string -------------------------------------------------

async function groupI() {
  const tok = liveToken();
  ok(gc.redactJwts(`prefix ${tok} suffix`).indexOf(tok) === -1, 'I1 redactJwts removes a JWT from arbitrary text');
  ok(/\[REDACTED-JWT\]/.test(gc.redactJwts(tok)), 'I2 the redaction is visible rather than silent');

  const fLeak = mockFetch(sendServer({ status: 500, body: `<html>debug dump ${tok}</html>` }));
  const eLeak = await grab(() => gc.requestOtp({ email: EMAIL, fetchImpl: fLeak, ...PROFILE }));
  ok(eLeak.message.indexOf(tok) === -1, 'I3 a token in a failing leg-2 body never reaches the error message');

  const fLeak4 = mockFetch(legServer({ verify: { status: 200, body: { success: true } }, login: { status: 500, body: `oops ${tok}` } }));
  const eLeak4 = await grab(() => gc.verifyOtp({ sessionRef: HANDLE, email: EMAIL, otp: OTP, fetchImpl: fLeak4, ...PROFILE }));
  ok(eLeak4.message.indexOf(tok) === -1, 'I4 a token in a failing leg-4 body never reaches the error message');

  // The short-lived handle is a credential too - it is what lets someone complete a login.
  const fH = mockFetch(legServer({ verify: { status: 404, body: { error: 'gone' } }, login: { status: 200, body: {} } }));
  const eH = await grab(() => gc.verifyOtp({ sessionRef: HANDLE, email: EMAIL, otp: OTP, fetchImpl: fH, ...PROFILE }));
  ok(eH.message.indexOf(HANDLE) === -1, 'I5 the short_lived_token is not echoed into an error message');
}

// ---- run -------------------------------------------------------------------------------------------

(async function run() {
  await groupB();
  await groupC();
  await groupD();
  await groupE();
  await groupF();
  await groupG();
  await groupH();
  await groupI();

  const total = pass + fail;
  if (total !== EXPECTED_CHECKS) {
    console.error(`\nSENTINEL FAILED: ran ${total} checks, expected ${EXPECTED_CHECKS}.`);
    console.error('The runner grades by exit code only, so a file that returns early would otherwise');
    console.error('report a silent green. Update EXPECTED_CHECKS deliberately when adding checks.');
    process.exit(1);
  }
  console.log(`\ngc-otp-auth: ${pass}/${total} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
