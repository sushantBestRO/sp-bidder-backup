'use strict';
/**
 * Operator login gate over real HTTP: unauthenticated 401s, login/session/logout,
 * the /price public exemption, CSRF on login, failed-login lockout, and that an
 * accepted save lands in the audit trail attributed to the logged-in user.
 *
 * Boots mock mode + memory store WITH an admin hash so the gate is active (mock
 * with no hash runs auth-off - that path is covered by test-console-endpoints).
 */
const { hashPassword } = require('../src/auth/adminAuth');

process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_ADMIN_USER = 'admin';
process.env.SP_ADMIN_PASS_HASH = hashPassword('testpass');
process.env.SP_SESSION_SECRET = 'unit-test-secret-do-not-ship';

const http = require('http');
const { app } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

let base;
function req(method, p, { body, cookie, origin } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = {};
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const u = new URL(base + p);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let buf = ''; res.on('data', (d) => (buf += d));
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json, setCookie: res.headers['set-cookie'] || [] }); });
    });
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}
const cookieFrom = (arr) => { for (const c of arr) { const m = /^sp_session=([^;]*)/.exec(c); if (m) return `sp_session=${m[1]}`; } return null; };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const origin = base;

  // ---- unauthenticated: data routes are gated ----
  ok((await req('GET', '/api/config')).status === 401, 'GET /api/config without a session -> 401');
  ok((await req('GET', '/api/auctions')).status === 401, 'GET /api/auctions without a session -> 401');
  ok((await req('POST', '/api/config', { body: { minMarginPct: 5 }, origin })).status === 401, 'POST /api/config without a session -> 401');

  // ---- session reflects unauthenticated ----
  const s0 = await req('GET', '/api/session');
  ok(s0.status === 200 && s0.json.authenticated === false && s0.json.authRequired === true, '/api/session: unauthenticated + authRequired');

  // ---- login: wrong password rejected, correct accepted ----
  ok((await req('POST', '/api/login', { body: { user: 'admin', password: 'nope' }, origin })).status === 401, 'wrong password -> 401');
  const good = await req('POST', '/api/login', { body: { user: 'admin', password: 'testpass' }, origin });
  ok(good.status === 200 && good.json.ok === true, 'correct credentials -> 200');
  const cookie = cookieFrom(good.setCookie);
  ok(!!cookie, 'login sets the sp_session cookie');
  ok(/HttpOnly/i.test(good.setCookie.join(';')) && /SameSite=Strict/i.test(good.setCookie.join(';')), 'session cookie is HttpOnly + SameSite=Strict');

  // ---- authenticated access ----
  const s1 = await req('GET', '/api/session', { cookie });
  ok(s1.json.authenticated === true && s1.json.user === 'admin', '/api/session with cookie -> authenticated as admin');
  ok((await req('GET', '/api/config', { cookie })).status === 200, 'GET /api/config with a session -> 200');
  const saved = await req('POST', '/api/config', { body: { minMarginPct: 5 }, cookie, origin });
  ok(saved.status === 200 && saved.json.applied, 'POST /api/config with a session -> applied');

  // ---- audit trail attributes the save to the user ----
  const audit = await req('GET', '/api/config/audit', { cookie });
  ok(audit.status === 200 && Array.isArray(audit.json.changes) && audit.json.changes.length >= 1, 'audit trail has the change');
  const top = audit.json.changes[0];
  ok(top && top.actor === 'admin' && top.changed.includes('minMarginPct'), 'audit entry: actor=admin, minMarginPct changed');

  // ---- /price stays public (404, not 401 - proves it is not behind the gate) ----
  ok((await req('GET', '/price/this-token-does-not-exist')).status === 404, '/price/<token> public -> 404 not 401');

  // ---- CSRF still applies to login (no Origin -> blocked) ----
  ok((await req('POST', '/api/login', { body: { user: 'admin', password: 'testpass' } })).status === 403, 'login without Origin -> 403 (CSRF guard)');

  // ---- logout clears the cookie; a cleared client is unauthenticated ----
  const out = await req('POST', '/api/logout', { cookie, origin });
  ok(out.status === 200 && /sp_session=;/.test(out.setCookie.join(';')) && /Max-Age=0/i.test(out.setCookie.join(';')), 'logout returns a cookie-clearing header');
  ok((await req('GET', '/api/config')).status === 401, 'no cookie after logout -> 401');

  // ---- failed-login lockout (run last: it trips the throttle) ----
  let last;
  for (let i = 0; i < 5; i++) last = await req('POST', '/api/login', { body: { user: 'admin', password: 'wrong' }, origin });
  ok(last.status === 401, '5th wrong attempt still 401');
  ok((await req('POST', '/api/login', { body: { user: 'admin', password: 'testpass' }, origin })).status === 429, 'locked out after 5 failures -> 429 (even with the right password)');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
