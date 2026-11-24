'use strict';
/**
 * BOTH PORTAL ADAPTERS KEEP THEIR HTTP CONNECTION OPEN ACROSS A QUIET SPELL.
 *
 * Regression target (latency map row 7): Node's fetch drops an idle connection after about 4 s, while
 * SuperProcure and GoComet both keep one open for 65 s or more, so a write after a quiet spell paid a
 * fresh TCP and TLS handshake (about 50 ms at p50 on the box). Measured on the adapters' own default
 * transport (no fetchImpl injected), against a local HTTP server that counts connections.
 *
 * Pinned:
 *   1. SuperProcure: three writes, 300 ms then 6 s apart, go over one connection.
 *   2. GoComet: the same.
 *   3. control: plain fetch over the same gaps opens a second connection after the 6 s gap, so the
 *      gap is long enough to show the difference.
 *   4. SP_HTTP_KEEPALIVE=0 puts both adapters back on plain fetch: a second connection after the gap.
 *   5. every write is still sent once: the server sees exactly three requests per run, no retry.
 *   6. the pool keeps an idle connection 30 s, inside the portals' measured "at least 65 s".
 *
 *   node scripts/test-portal-http-keepalive.js
 */
process.env.LOG_LEVEL = 'silent';

const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const GAPS_MS = [300, 6_000];
const EXPECTED_CHECKS = 6;

function countingServer() {
  const s = { connections: 0, requests: 0 };
  s.server = http.createServer((req, res) => {
    s.requests += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":{"ok":true}}');
    });
  });
  // 0: no idle timeout and no Keep-Alive header, like both portals, so the client picks the timeout.
  s.server.keepAliveTimeout = 0;
  s.server.on('connection', () => { s.connections += 1; });
  return new Promise((resolve) => s.server.listen(0, '127.0.0.1', () => {
    s.base = `http://127.0.0.1:${s.server.address().port}`;
    resolve(s);
  }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function gapped(send) {
  const statuses = [await send()];
  for (const g of GAPS_MS) { await wait(g); statuses.push(await send()); }
  return statuses;
}

function spAdapter(base) {
  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  return new RealSuperProcureAdapter({ token: 'x.eyJ1X2lkIjoxfQ.x', apiBaseUrl: base, authProbeEnabled: false });
}

function gcAdapter(base) {
  const { GoCometAdapter } = require('../src/platform/gocometAdapter');
  return new GoCometAdapter({ token: 't', userId: 'u', baseUrl: base, bidEnabled: true });
}

const CHILD = `
process.env.LOG_LEVEL = 'silent';
const [sp, gc] = process.argv.slice(1);
const { RealSuperProcureAdapter } = require('./src/platform/realAdapter');
const { GoCometAdapter } = require('./src/platform/gocometAdapter');
const a = new RealSuperProcureAdapter({ token: 'x.eyJ1X2lkIjoxfQ.x', apiBaseUrl: sp, authProbeEnabled: false });
const g = new GoCometAdapter({ token: 't', userId: 'u', baseUrl: gc, bidEnabled: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const run = async (send) => { await send(); for (const w of ${JSON.stringify(GAPS_MS)}) { await wait(w); await send(); } };
  await Promise.all([
    run(() => a._request('POST', '/sp/bid', { body: { a: 1 }, retry: false })),
    run(() => g._request('PUT', '/quotes/1/submit', { body: { a: 1 } })),
  ]);
  process.exit(0);
})();
`;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  const [sp, gc, plain, offSp, offGc] = await Promise.all([countingServer(), countingServer(), countingServer(),
    countingServer(), countingServer()]);
  let spStatuses;
  let gcStatuses;
  const child = new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', CHILD, offSp.base, offGc.base], {
      cwd: require('path').join(__dirname, '..'), env: { ...process.env, SP_HTTP_KEEPALIVE: '0' }, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`off-switch child exited ${code}`))));
  });
  let adapterError = null;
  await Promise.all([
    (async () => {
      try {
        const a = spAdapter(sp.base);
        spStatuses = await gapped(async () => (await a._request('POST', '/sp/bid', { body: { a: 1 }, retry: false })).status);
      } catch (e) { adapterError = e; }
    })(),
    (async () => {
      try {
        const g = gcAdapter(gc.base);
        gcStatuses = await gapped(async () => (await g._request('PUT', '/quotes/1/submit', { body: { a: 1 } })).status);
      } catch (e) { adapterError = e; }
    })(),
    gapped(async () => { const r = await fetch(`${plain.base}/x`, { method: 'POST', body: '{}' }); await r.text(); return r.status; }),
    child,
  ]);

  await check('1. SuperProcure: three writes 300 ms then 6 s apart go over one connection', async () => {
    if (adapterError) throw adapterError;
    assert.deepStrictEqual(spStatuses, [200, 200, 200], `statuses ${spStatuses}`);
    assert.strictEqual(sp.connections, 1, `${sp.connections} connections for 3 writes`);
  });
  await check('2. GoComet: three writes 300 ms then 6 s apart go over one connection', async () => {
    if (adapterError) throw adapterError;
    assert.deepStrictEqual(gcStatuses, [200, 200, 200], `statuses ${gcStatuses}`);
    assert.strictEqual(gc.connections, 1, `${gc.connections} connections for 3 writes`);
  });
  await check('3. control: plain fetch opens a second connection after the 6 s gap', async () => {
    assert.strictEqual(plain.connections, 2, `${plain.connections} connections; the gap no longer shows the idle drop`);
  });
  await check('4. SP_HTTP_KEEPALIVE=0: both adapters are back on plain fetch', async () => {
    assert.strictEqual(offSp.connections, 2, `SuperProcure: ${offSp.connections} connections with keep-alive off`);
    assert.strictEqual(offGc.connections, 2, `GoComet: ${offGc.connections} connections with keep-alive off`);
  });
  await check('5. every write is sent once: three requests per run', async () => {
    for (const [name, s] of [['sp', sp], ['gc', gc], ['plain', plain], ['off sp', offSp], ['off gc', offGc]]) {
      assert.strictEqual(s.requests, 3, `${name}: the server saw ${s.requests} requests for 3 writes`);
    }
  });

  // Review of 9b2dd20 (non-blocking 5): the portals' idle timeout is measured only as "at least 65 s",
  // so the pool keeps a connection for 30 s, well inside it; a server-side close must never leave a
  // dead pooled socket for a bid write.
  await check('6. idle connections are kept 30 s', async () => {
    assert.strictEqual(require('../src/platform/portalFetch').KEEPALIVE_MS, 30_000);
  });

  for (const s of [sp, gc, plain, offSp, offGc]) { s.server.closeAllConnections(); s.server.close(); }
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-portal-http-keepalive:', e && e.message); process.exit(1); });
