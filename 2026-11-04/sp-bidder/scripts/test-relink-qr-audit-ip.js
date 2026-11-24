'use strict';
/**
 * THE AUDIT TRAIL RECORDS THE REAL CLIENT, NOT THE PROXY (PR #106 r1, Finding 7).
 *
 * WHY A SEPARATE, REALLY-BOOTED APP. The unit tests for createRelinkQrHandler drive the handler with
 * a hand-built `req` object literal, and one of them used to hand-supply `ip: '10.0.0.9'` and then
 * assert the audit record carried '10.0.0.9'. That assertion cannot fail: it pins that the handler
 * copies a field it was given, which was never in doubt, while the thing actually in doubt - what
 * Express resolves req.ip TO in production - was bypassed entirely. The suite stayed green while
 * every record on the box read the constant "127.0.0.1", because the app binds loopback, nginx
 * proxies loopback -> loopback, and `trust proxy` was never set. A mock cannot catch that. Only a
 * real Express request carrying a real X-Forwarded-For can, which is what this file issues.
 *
 * WHAT IS BEING PROTECTED. `app.set('trust proxy', 'loopback')` in src/web/server.js is one line
 * that repairs SEVEN audit streams at once - the margin audit, the four accountReconnect records,
 * the config-change record, the engine audit, and the senderQr record on the pairing-credential
 * serve. That last one is why this matters most: after a wrong-handset re-link, "who pulled a QR,
 * and from where" is the question the incident turns on, and a column of identical 127.0.0.1 rows
 * answers it with nothing.
 *
 * The forged-header case is asserted too, because the fix must not trade a useless field for a
 * attacker-controlled one. 'loopback' trusts exactly one hop; nginx uses $proxy_add_x_forwarded_for,
 * so a client's forged value is followed by its real address and Express reads the real one.
 *
 *   node scripts/test-relink-qr-audit-ip.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';

const http = require('http');
const assert = require('assert');
const { hashPassword } = require('../src/auth/adminAuth');

const PASSWORD = 'not-a-real-password-just-for-this-test';
process.env.SP_ADMIN_USER = 'ops';
process.env.SP_ADMIN_PASS_HASH = hashPassword(PASSWORD);
process.env.SP_SESSION_SECRET = 'test-session-secret-not-a-real-one';

// Maytapi creds ARE set here (unlike test-relink-qr-auth.js, which deletes them to prove the 503
// path): this test needs the handler to run all the way through to the serve + audit.
const SLOT = '128023';
process.env.SP_MAYTAPI_TOKEN = 'test-token-not-a-real-one';
process.env.SP_MAYTAPI_PRODUCT_ID = 'test-product';
process.env.SP_MAYTAPI_PHONE_ID = SLOT;
process.env.SP_MAYTAPI_ENDPOINT = 'https://maytapi.invalid/api';
// Point the monitor-state read at a path that does not exist, so the expected number is null and the
// binding gate resolves 'first-run' -> allowed. This test is about the audit field, not the gate.
process.env.MONITOR_STATE_FILE = require('path').join(require('os').tmpdir(), 'no-such-monitor-state-for-this-test.json');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-qr-payload-for-this-test'),
]);

// Stub the global fetch the handler falls back to when no transport is injected (which is how
// src/web/server.js wires it in production). Resolved per call inside fetchPhones/fetchQr, so
// replacing it after require() is enough.
global.fetch = async (url) => {
  const u = String(url);
  if (/listPhones$/.test(u)) {
    // Logged-out slot: number null, status qr-screen - the state the page exists to serve.
    return { ok: true, status: 200, json: async () => ({ data: [{ id: Number(SLOT), number: null, status: 'qr-screen' }] }) };
  }
  if (/qrCode$/.test(u)) {
    return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
  }
  throw new Error(`unexpected fetch in test: ${u}`);
};

const { app, store } = require('../src/web/server');
const { RELINK_QR_PATH } = require('./lib/sender-qr');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function req(method, path, base, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
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

  const login = await req('POST', '/api/login', base, { 'content-type': 'application/json', origin: base },
    JSON.stringify({ user: 'ops', password: PASSWORD }));
  assert.strictEqual(login.status, 200, `login -> ${login.status} ${login.body}`);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
  ok('the test operator can log in');

  // ---- the request that matters: a real client address behind a real forwarded header ----
  // The test connects over loopback, exactly as nginx does in production. Without trust proxy the
  // recorded ip is the socket peer (127.0.0.1) and this assertion fails - which is the whole point.
  //
  // The header carries TWO addresses on purpose, so one request pins both halves of the fix. nginx
  // uses $proxy_add_x_forwarded_for, i.e. it APPENDS the true peer to whatever the client sent, so
  // '1.2.3.4, 203.0.113.7' is exactly what a client forging '1.2.3.4' produces on the wire. Asserting
  // the recorded value is the RIGHTMOST address proves both that the proxy header is being read at
  // all (not 127.0.0.1) and that only the one trusted hop is believed (not 1.2.3.4). `trust proxy:
  // true` would take the leftmost and hand an attacker control of the field that identifies them,
  // which is worse than the constant it replaces - so this assertion is what keeps 'loopback' from
  // being "simplified" to true later.
  const served = await req('GET', `${RELINK_QR_PATH}?img=1`, base, { cookie, 'x-forwarded-for': '1.2.3.4, 203.0.113.7' });
  assert.strictEqual(served.status, 200, `authenticated ?img=1 -> ${served.status} ${served.body}`);
  assert.ok(served.body.subarray(0, 8).equals(PNG.subarray(0, 8)), 'the served body is the PNG');
  ok('an authenticated ?img=1 request serves the QR PNG');

  const events = await store.readEvents('senderQr');
  assert.strictEqual(events.length, 1, `expected exactly one senderQr audit record, got ${events.length}`);
  assert.notStrictEqual(events[0].ip, '127.0.0.1',
    'the audit record stored the loopback proxy address - trust proxy is unset, and every forensic record in this app is a constant');
  assert.notStrictEqual(events[0].ip, '1.2.3.4',
    'the audit record believed a CLIENT-supplied X-Forwarded-For value - trust proxy is too permissive (want loopback, not true)');
  assert.strictEqual(events[0].ip, '203.0.113.7',
    `the audit record recorded ip=${events[0].ip}, want the address the trusted hop appended`);
  assert.strictEqual(events[0].actor, 'ops', `the audit record names the operator (got ${events[0].actor})`);
  assert.strictEqual(String(events[0].phoneId), SLOT, 'the audit record names the slot');
  assert.strictEqual(events[0].bytes, PNG.length, 'the audit record counts the bytes served, never the bytes themselves');
  assert.ok(!('base64' in events[0]) && !JSON.stringify(events[0]).includes('fake-qr-payload'),
    'the audit record must never carry the QR bytes');
  ok(`the senderQr audit record carries the REAL client address (${events[0].ip}) - not the loopback proxy, and not the forged hop`);

  server.close();
  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('FAILED:', e && e.message); process.exit(1); });
