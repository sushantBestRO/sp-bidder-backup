'use strict';
/**
 * THE RE-LINK QR ENDPOINT IS NEVER REACHABLE WITHOUT AN OPERATOR SESSION (PR #98 r2, Finding 2).
 *
 * GET /api/wa/relink-qr serves a live WhatsApp PAIRING credential. Its abuse is not a data read:
 * Maytapi's instance for the slot is the COMPANION device, so whoever scans the QR becomes the
 * linked account - an outsider who scrapes a fresh one re-points BRL's production sender at their
 * own WhatsApp, and every customer notification then goes out from, and every inbound message
 * arrives at, that phone. It is the highest-value endpoint in the app by some distance.
 *
 * WHY THIS FILE EXISTS AT ALL. The guard this replaces asserted route-vs-gate ORDER by reading
 * server.js as a STRING and comparing two String.indexOf results. A source-ordering assertion can
 * only ever prove where a line sits in a file; it cannot detect a MATCHING-SEMANTICS bypass, which
 * is exactly the class of bug that shipped green past it - Express's case-insensitive routing
 * matched `/API/wa/relink-qr` while the gate's case-sensitive prefix test did not, so the gate
 * called next() with no session check. Only a real request can tell the difference, so these are
 * real requests against a really-booted app.
 *
 * Two independent controls are asserted here, deliberately, because the r2 fix added the second:
 *   1. the /api session gate (hardened by #103: `case sensitive routing` + a normalising apiPath).
 *   2. the handler's OWN currentAdmin() check inside createRelinkQrHandler, so the endpoint still
 *      fails closed if the gate is ever reordered, split, or has a route block inserted above it.
 *
 *   node scripts/test-relink-qr-auth.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// Gate ON. A real scrypt hash of a throwaway password, so the authenticated leg below can actually
// log in - that leg is what proves a 401 means "refused", not "no such route".
const http = require('http');
const assert = require('assert');
const { hashPassword } = require('../src/auth/adminAuth');

const PASSWORD = 'not-a-real-password-just-for-this-test';
process.env.SP_ADMIN_USER = 'ops';
process.env.SP_ADMIN_PASS_HASH = hashPassword(PASSWORD);
process.env.SP_SESSION_SECRET = 'test-session-secret-not-a-real-one';
// No Maytapi creds on purpose: an AUTHENTICATED caller must get 503 ("not configured"), which is a
// response only reachable from INSIDE the handler. That is the assertion that makes the 401s below
// mean something - without it they would also pass if the route had simply never been mounted.
delete process.env.SP_MAYTAPI_TOKEN;
delete process.env.SP_MAYTAPI_PRODUCT_ID;
delete process.env.SP_MAYTAPI_PHONE_ID;

const { app } = require('../src/web/server');
const { RELINK_QR_PATH } = require('./lib/sender-qr');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function req(method, path, base, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
      },
    );
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---- ANONYMOUS, every casing, both legs. Nothing may succeed. ----
  // The canonical path must be REFUSED (401), not merely absent. The varied casings may 401 (gate
  // engaged) or 404 (router refused the casing after #103) - both are safe; a 200 is the bypass.
  const anon = [
    { p: RELINK_QR_PATH, want401: true },
    { p: `${RELINK_QR_PATH}?img=1`, want401: true },
    { p: '/API/wa/relink-qr', want401: false },
    { p: '/API/wa/relink-qr?img=1', want401: false },
    { p: '/Api/wa/relink-qr', want401: false },
    { p: '/api/WA/relink-qr?img=1', want401: false },
  ];
  for (const c of anon) {
    const res = await req('GET', c.p, base);
    assert.notStrictEqual(res.status, 200, `${c.p} answered 200 with no session - the pairing credential is exposed`);
    assert.ok(!/^image\//.test(String(res.headers['content-type'] || '')), `${c.p} returned an image body without a session`);
    if (c.want401) {
      assert.strictEqual(res.status, 401, `${c.p} -> ${res.status} (want 401: refused, not missing)`);
    } else {
      assert.ok(res.status === 401 || res.status === 404, `${c.p} -> ${res.status} (want 401 or 404)`);
    }
    ok(`anonymous GET ${c.p} is refused (${res.status})`);
  }

  // ---- the HTML hand-off: a human tapping the alert link on a phone with no session ----
  // A bare JSON 401 dead-ends the exact emergency workflow this page replaces, so a top-level HTML
  // navigation is bounced to the console login carrying a return-to. It is still a refusal: no QR,
  // no page, no Maytapi read.
  const nav = await req('GET', RELINK_QR_PATH, base, { accept: 'text/html,application/xhtml+xml' });
  assert.strictEqual(nav.status, 302, `HTML navigation -> ${nav.status} (want 302 to the login)`);
  assert.ok(
    String(nav.headers.location || '').startsWith(`/?next=${encodeURIComponent(RELINK_QR_PATH)}`),
    `redirect went to ${nav.headers.location} (want /?next=<this path>)`,
  );
  ok(`an un-sessioned HTML navigation is bounced to the login with a return-to (${nav.headers.location})`);

  // The hand-off must not become a second way in. The ?img=1 leg is an <img> sub-resource, not a
  // navigation, and every non-HTML caller stays on the JSON 401.
  const imgNav = await req('GET', `${RELINK_QR_PATH}?img=1`, base, { accept: 'text/html,application/xhtml+xml' });
  assert.strictEqual(imgNav.status, 401, `?img=1 with an HTML accept -> ${imgNav.status} (want 401, never a redirect)`);
  ok('the ?img=1 leg is never redirected, whatever it claims to accept - it is the leg that carries the credential');

  const wildcard = await req('GET', RELINK_QR_PATH, base, { accept: '*/*' });
  assert.strictEqual(wildcard.status, 401, `Accept: */* -> ${wildcard.status} (want 401)`);
  ok('a bare Accept: */* (curl, XHR) gets the JSON 401, not the HTML hand-off');

  // A varied-case path must NOT pick up the HTML branch either - the redirect is matched on the
  // exact canonical path on purpose. Broadening what the auth boundary treats specially is how the
  // last bypass appeared.
  const casedNav = await req('GET', '/API/wa/relink-qr', base, { accept: 'text/html' });
  assert.notStrictEqual(casedNav.status, 302, '/API/wa/relink-qr was given the HTML hand-off - the special case must be exact-path only');
  ok(`a varied-case HTML navigation gets no special treatment (${casedNav.status})`);

  // ---- AUTHENTICATED: proves the 401s above are the gate refusing, not a missing route ----
  const login = await req('POST', '/api/login', base, {
    'content-type': 'application/json',
    origin: base,
  }, JSON.stringify({ user: 'ops', password: PASSWORD }));
  assert.strictEqual(login.status, 200, `login -> ${login.status} ${login.body}`);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  ok('the test operator can log in (the session cookie is real)');

  const authed = await req('GET', RELINK_QR_PATH, base, { cookie });
  assert.strictEqual(authed.status, 503, `authenticated GET -> ${authed.status} (want 503: reached the handler, no maytapi creds)`);
  assert.ok(/not configured/i.test(authed.body), `503 body was ${authed.body}`);
  ok('an AUTHENTICATED request reaches the handler (503, no maytapi creds) - so the 401s above are a refusal, not a missing route');

  // The credential leg is reachable only with the same session, and answers from inside the handler.
  const authedImg = await req('GET', `${RELINK_QR_PATH}?img=1`, base, { cookie });
  assert.strictEqual(authedImg.status, 503, `authenticated ?img=1 -> ${authedImg.status} (want 503)`);
  ok('the ?img=1 leg is reachable with a session and answers from inside the handler');

  server.close();
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('FAILED:', e && e.message); process.exit(1); });
