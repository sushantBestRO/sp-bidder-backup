'use strict';
/**
 * AUTH BYPASS REGRESSION (2026-07-25, found in the PR #98 r2 review, verified live on prod).
 *
 * Express defaults `case sensitive routing` OFF, so `app.get('/api/x')` compiled to a
 * case-INSENSITIVE regex. The operator-session gate and the CSRF guard both decided whether to
 * engage with a case-SENSITIVE `req.path.startsWith('/api/')`. The two disagreed: `GET /API/state`
 * MATCHED the route but FAILED the prefix test, so the gate called next() without checking for a
 * session and the handler answered an unauthenticated caller. Confirmed on the live box:
 * `/api/state` -> 401, `/API/state` -> 200 with engine state. Reachable by anyone holding the
 * shared nginx Basic credential (the outer wall is one shared password, the app login is the
 * per-operator inner gate) or anything with loopback/SSRF reach on the co-tenant VPS.
 *
 * This test boots the app with the login gate ON and drives REAL requests. The prior guard for
 * this surface asserted route-vs-gate ORDER by String.indexOf on the source, which cannot detect
 * a matching-semantics mismatch - which is exactly why the bypass shipped green.
 *
 *   node scripts/test-case-auth-bypass.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// Gate ON: a hash + session secret is what flips AUTH_ON in server.js. Value is a real scrypt
// hash of a throwaway password; nothing here logs in, every request below is anonymous.
process.env.SP_ADMIN_PASS_HASH = 'scrypt$16384$8$1$0123456789abcdef$0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SP_SESSION_SECRET = 'test-session-secret-not-a-real-one';

const http = require('http');
const assert = require('assert');
const { app } = require('../src/web/server');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function req(method, path, base, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, body: buf })); },
    );
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The exact shape that was live-exploitable: same route, varied casing, no session cookie.
  // 200 here means the operator gate was skipped. 401 (gate engaged) or 404 (router refused the
  // casing) are both safe; what must never happen is a success carrying real data.
  const cases = ['/API/state', '/Api/state', '/aPi/state', '/API/config', '/API/price-requests'];
  for (const p of cases) {
    const res = await req('GET', p, base);
    assert.notStrictEqual(res.status, 200, `${p} answered 200 without a session - auth bypass`);
    assert.ok(res.status === 401 || res.status === 404, `${p} -> ${res.status} (want 401 or 404)`);
    ok(`anonymous GET ${p} is refused (${res.status})`);
  }

  // Control: the canonical lower-case path must still be gated, not merely absent.
  const canon = await req('GET', '/api/state', base);
  assert.strictEqual(canon.status, 401, `/api/state -> ${canon.status} (want 401)`);
  ok('anonymous GET /api/state is refused (401) - the gate itself still works');

  // The CSRF guard shares the same prefix test; a varied-case mutating POST must not slip it.
  // Anything except 2xx is acceptable (401 gate, 403 CSRF, 404 router) - never a success.
  const post = await req('POST', '/API/engine/kill', base, { 'content-type': 'application/json' });
  assert.ok(post.status >= 400, `POST /API/engine/kill -> ${post.status} (want >= 400)`);
  ok(`anonymous varied-case mutating POST is refused (${post.status})`);

  // Public surfaces must stay reachable - the fix must not gate what the desk uses without a login.
  const price = await req('GET', '/price/definitely-not-a-real-token', base);
  assert.ok(price.status === 404 || price.status === 200, `/price/<bad token> -> ${price.status}`);
  ok('public /price surface still reachable without a session');

  server.close();
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('FAILED:', e && e.message); process.exit(1); });
