'use strict';
/**
 * CONSOLE HISTORY VIEWS: SERIALISED ONCE PER VERSION OF THEIR SOURCE FILES.
 *
 * Regression target (latency map row 11): /api/closed-bids and /api/history re-read every closed bid
 * and re-serialised the whole response on each refresh, about 0.45-0.53 s of the event loop per call
 * on the box, every 5 s and 15 s while a console has those views open.
 *
 * Boots the app (mock mode, file store in a temp dir, no boot()/listen of its own) on an ephemeral
 * port and counts how often the closed-bids collection is scanned.
 *   1. /api/closed-bids twice with no write between scans closedBids once, and both bodies match.
 *   2. /api/history twice with no write between scans closedBids once.
 *   3. a write to closedBids invalidates both: the next response shows it.
 *   4. a hand edit of closedBids.json (another writer) is seen too.
 *   5. a request for another window (from/to) is its own entry, not the cached body.
 *
 *   node scripts/test-console-history-cache.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'file';
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const http = require('http');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-cache-'));
process.env.SP_DATA_DIR = dir;
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

const { app, store } = require('../src/web/server');

function get(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

const closedRec = (id, closedAt) => ({ auctionId: id, status: 'closed', closedAt, won: true, finalRank: 1,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, shipper: 'Tata Steel', ourBids: [{ price: 50000, ts: closedAt }],
  lastBidPrice: 50000 });

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  await store.putDoc('closedBids', 'A1', closedRec('A1', 1_000));
  let scans = 0;
  const listDocs = store.listDocs.bind(store);
  store.listDocs = (collection, ...rest) => { if (collection === 'closedBids') scans += 1; return listDocs(collection, ...rest); };

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  await check('1. /api/closed-bids twice with no write scans closedBids once', async () => {
    scans = 0;
    const a = await get(base, '/api/closed-bids');
    const b = await get(base, '/api/closed-bids');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body, b.body, 'the two bodies differ');
    assert.strictEqual(scans, 1, `closedBids scanned ${scans} times for two unchanged refreshes`);
  });

  await check('2. /api/history twice with no write scans closedBids once', async () => {
    scans = 0;
    const a = await get(base, '/api/history');
    const b = await get(base, '/api/history');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.body, b.body, 'the two bodies differ');
    assert.strictEqual(scans, 1, `closedBids scanned ${scans} times for two unchanged refreshes`);
  });

  await check('3. a write invalidates both views', async () => {
    await store.putDoc('closedBids', 'B2', closedRec('B2', 2_000));
    const cb = JSON.parse((await get(base, '/api/closed-bids')).body);
    assert.ok(cb.closedBids.some((r) => r.auctionId === 'B2'), '/api/closed-bids still served the pre-write body');
    const h = JSON.parse((await get(base, '/api/history')).body);
    assert.ok(h.rows.length === 2, `/api/history still served ${h.rows.length} rows after the write`);
  });

  await check('4. a hand edit of closedBids.json is seen', async () => {
    const file = path.join(dir, 'closedBids.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    onDisk.C3 = closedRec('C3', 3_000);
    fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
    const cb = JSON.parse((await get(base, '/api/closed-bids')).body);
    assert.ok(cb.closedBids.some((r) => r.auctionId === 'C3'), 'the hand-edited record is missing');
  });

  await check('5. another window is its own entry', async () => {
    const all = JSON.parse((await get(base, '/api/closed-bids')).body);
    const early = JSON.parse((await get(base, '/api/closed-bids?from=0&to=1500')).body);
    assert.strictEqual(all.closedBids.length, 3);
    assert.deepStrictEqual(early.closedBids.map((r) => r.auctionId), ['A1']);
  });

  server.close();
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 5, `expected 5 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-console-history-cache:', e && e.stack); process.exit(1); });
