'use strict';
/**
 * POST /api/accounts/:accountId/refresh-scope - the operator's manual scope pick-up
 * (server.js), over real HTTP on the mock app. The refresher itself is unit-tested in
 * test-scope-refresh.js; this pins the ROUTE's contract: 404 unknown account, 409 when
 * no live SP session backs the account (mock stacks never get a refresher), and the
 * deferred/failed/ok mappings (409 deferred - never interrupt an armed auction;
 * 502 failed - old session kept; 200 ok with the fresh branch count).
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
// mock/dev auth-off (the house pattern - see test-console-endpoints.js); clear ambient creds.
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const http = require('http');
const { app, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(url);
    const headers = Object.assign(
      data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      extraHeaders || {},
    );
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json }); }); },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => req('POST', base + p, b || {}, { origin: base }); // same-origin browser sim

  // ---- unknown account ----
  const missing = await post('/api/accounts/nope/refresh-scope');
  ok(missing.status === 404, `unknown account -> 404 (got ${missing.status})`);

  // ---- mock stack: no refresher was ever built (real mode only) ----
  const mock = await post('/api/accounts/primary/refresh-scope');
  ok(mock.status === 409 && /real mode/.test(mock.json.error || ''), `no live SP session -> 409 real-mode message (got ${mock.status}: ${mock.json && mock.json.error})`);

  // ---- inject a refresher stand-in on the primary stack and pin each outcome mapping.
  // The route only consumes refresh()'s result contract, which is exactly what the real
  // ScopeRefresher returns (pinned in test-scope-refresh.js) - so a stub per outcome keeps
  // this test offline while still exercising the full express pipeline (auth gate, CSRF
  // guard, param handling, status mapping).
  const calls = [];
  const stub = (result) => ({ refresh: async (opts) => { calls.push(opts); return result; } });

  stacks[0].scopeRefresher = stub({ ok: false, deferred: true, armedCount: 2, trigger: 'manual' });
  const deferred = await post('/api/accounts/primary/refresh-scope');
  ok(deferred.status === 409 && deferred.json.deferred === true && deferred.json.armedCount === 2,
    `armed auctions -> 409 deferred with the count (got ${deferred.status}: ${JSON.stringify(deferred.json)})`);
  ok(/never interrupted/.test(deferred.json.error || ''), 'deferred message tells the operator live bidding is protected');

  stacks[0].scopeRefresher = stub({ ok: false, error: 'auth_failed_401', consecutiveFailures: 1, trigger: 'manual' });
  const failed = await post('/api/accounts/primary/refresh-scope');
  ok(failed.status === 502 && /auth_failed_401/.test(failed.json.error || ''), `failed refresh -> 502 carrying the cause (got ${failed.status})`);
  ok(/untouched/.test(failed.json.error || ''), 'failure message says the existing session is kept');

  stacks[0].scopeRefresher = stub({ ok: false, inFlight: true });
  const busy = await post('/api/accounts/primary/refresh-scope');
  ok(busy.status === 409 && /already running/.test(busy.json.error || ''), `in-flight refresh -> 409 (got ${busy.status})`);

  stacks[0].scopeRefresher = stub({ ok: true, branches: 276, changed: true, prevCount: 249, trigger: 'manual' });
  const okRes = await post('/api/accounts/primary/refresh-scope');
  ok(okRes.status === 200 && okRes.json.ok === true && okRes.json.branches === 276
    && okRes.json.changed === true && okRes.json.prevCount === 249,
    `successful refresh -> 200 with branches/changed/prevCount (got ${okRes.status}: ${JSON.stringify(okRes.json)})`);
  ok(calls.every((c) => c && c.trigger === 'manual'), 'the route always invokes refresh as a MANUAL trigger');

  stacks[0].scopeRefresher = null; // leave the shared mock stack as it was
  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
