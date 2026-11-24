'use strict';
/**
 * /api/version over real HTTP: it must sit behind the same operator-session gate as the other
 * admin endpoints (401 without a session), and return the running-build provenance JSON once
 * authenticated. Boots mock mode + memory store WITH an admin hash so the gate is active
 * (same setup as test-auth.js).
 */
const { hashPassword } = require('../src/auth/adminAuth');

process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_ADMIN_USER = 'admin';
process.env.SP_ADMIN_PASS_HASH = hashPassword('testpass');
process.env.SP_SESSION_SECRET = 'unit-test-secret-do-not-ship';

const http = require('http');
const fs = require('fs');
const path = require('path');
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

  // ---- unauthenticated: /api/version is gated exactly like the sibling admin endpoints ----
  const anon = await req('GET', '/api/version');
  ok(anon.status === 401, 'GET /api/version without a session -> 401');
  // sanity: a sibling admin endpoint refuses the same way (proves it's the shared gate, not a fluke)
  ok((await req('GET', '/api/config')).status === 401, 'GET /api/config without a session -> 401 (same gate)');

  // ---- authenticate ----
  const good = await req('POST', '/api/login', { body: { user: 'admin', password: 'testpass' }, origin });
  const cookie = cookieFrom(good.setCookie);
  ok(good.status === 200 && !!cookie, 'login succeeds and sets a session cookie');

  // ---- authenticated: 200 + the provenance JSON shape ----
  const v = await req('GET', '/api/version', { cookie });
  ok(v.status === 200, 'GET /api/version with a session -> 200');
  ok(v.json && typeof v.json === 'object', '/api/version returns a JSON object');
  ok(typeof v.json.version === 'string' && v.json.version.length > 0, '/api/version carries a non-empty version string');
  ok('sha' in v.json && 'tag' in v.json && 'branch' in v.json && 'builtAt' in v.json && 'builderHost' in v.json && 'dirty' in v.json,
    '/api/version JSON has the full provenance shape (sha/tag/branch/builtAt/builderHost/dirty)');
  ok(typeof v.json.dirty === 'boolean', '/api/version dirty is a boolean');
  // Whether this checkout is STAMPED is ambient, not something the suite controls: version.json is
  // gitignored and written by scripts/deploy.sh at package time, so any tree that has cut a release
  // carries one and a fresh clone does not. Asserting the dev sentinel unconditionally therefore
  // failed in exactly the checkout releases are cut FROM - the deploy worktree - where `npm test`
  // is the pre-deploy gate and the pre-flight guard reads the tree as clean (version.json is
  // gitignored, so `git status --porcelain` never mentions it). A red failure there is worse than
  // no test: it is one a human learns to wave through immediately before shipping live-money code.
  // Assert whichever branch actually applies - both are real, specified loadVersionInfo() behaviour.
  let onDisk = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
  } catch (_) { /* absent or malformed - both are specified to yield the sentinel */ }
  if (onDisk && typeof onDisk.version === 'string' && onDisk.version) {
    ok(v.json.version === onDisk.version && v.json.sha === onDisk.sha,
      '/api/version reports the stamp that is actually on disk, field for field');
  } else {
    ok(v.json.version === 'dev' && v.json.sha === 'unknown',
      '/api/version reports the dev sentinel when there is no readable stamp');
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
