'use strict';
/**
 * The first GET /price/:token records openedAt (D026, #255) through a setImmediate-deferred
 * synchronous patchDoc on priceRequests. FileStore holds priceRequests as a parse cache keyed by
 * file version (latency map row 6). The next read of that request, through the cache, must show
 * the openedAt the deferred write landed - a stale cached copy would tell the desk scorecard the
 * link was never opened.
 *
 * Regression target: the merge of #255 into perf/final-window-latency.
 *
 * @requires-summary-line
 *   node scripts/test-price-open-through-parse-cache.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'file';
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir, read counter), not app state
const path = require('path');
const http = require('http');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-open-cache-'));
process.env.SP_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

const { app, requests, store } = require('../src/web/server');
const { FileStore } = require('../src/store/fileStore');

const file = path.join(dir, 'priceRequests.json');
let reads = 0;
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (path.resolve(String(p)) === path.resolve(file)) reads += 1;
  return realRead.call(this, p, ...rest);
};

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

function get(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    }).on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  ok(store instanceof FileStore, 'setup sanity: the server runs on the FileStore that holds the parse cache');

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();

  const r = await requests.createForLoad({
    id: 'OPEN-CACHE-1', lane: { origin: 'Alwar', destination: 'Pune' }, equipment: '32ft', units: 1,
    companyName: 'Havells India', closesAt: now + 3600000, startsAt: now - 60000,
  }, { deadlineAt: now + 60000 });

  const primed = await requests.getByToken(r.id);
  ok(primed && primed.openedAt == null, 'setup sanity: a request nobody has opened carries no openedAt');
  const readsAfterPrime = reads;
  await requests.getByToken(r.id);
  ok(reads === readsAfterPrime, `setup sanity: an unchanged file is served from the cache (reads ${readsAfterPrime} -> ${reads})`);

  const t1 = Date.now();
  const res = await get(base, `/price/${r.id}`);
  ok(res.status === 200, `the price page renders (status ${res.status})`);
  await wait(50);

  const onDisk = JSON.parse(realRead(file, 'utf8'))[r.id];
  ok(onDisk && onDisk.openedAt != null && onDisk.openedAt >= t1,
    `setup sanity: the deferred patchDoc landed openedAt on disk (got ${onDisk && onDisk.openedAt})`);

  const next = await requests.getByToken(r.id);
  ok(next.openedAt === onDisk.openedAt,
    `the next getByToken through the cache shows the openedAt on disk (cache ${next.openedAt}, disk ${onDisk.openedAt})`);

  const listed = (await requests.listAll()).find((x) => x.id === r.id);
  ok(listed && listed.openedAt === onDisk.openedAt,
    `a list read through the cache shows it too (got ${listed && listed.openedAt})`);

  const readsAfterRefresh = reads;
  const again = await requests.getByToken(r.id);
  ok(reads === readsAfterRefresh && again.openedAt === onDisk.openedAt,
    `the refreshed cache holds the post-write version: no re-read, openedAt kept (reads ${readsAfterRefresh} -> ${reads})`);

  console.log(`${pass}/${pass} checks passed`);
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
