'use strict';
/**
 * FILESTORE: priceRequests.json IS READ ONCE PER FILE VERSION, AND EVERY CALLER GETS ITS OWN COPY.
 *
 * Regression target (latency map row 6): every getDoc, patchDoc and listDocs on priceRequests
 * re-read and re-parsed the whole file (3.55 MB, 95 ms median per parse on the box), at least five
 * times per discovery pass plus every open price page's 4 s poll, on the thread that runs the bids.
 *
 * Pinned (a temp data dir, fs.readFileSync counted for the collection's own path):
 *   1. an unchanged file is read once across getDoc, listDocs, getDoc, listDocs.
 *   2. a write through the store invalidates: the next read sees the written value.
 *   3. a hand edit (another writer) is seen on the next read.
 *   4. mutating a doc from getDoc or listDocs does not change what the next read returns.
 *   5. the documents and their order are what an uncached read returns.
 *
 *   node scripts/test-filestore-price-requests-cache.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store/fileStore');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-pr-cache-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
const file = path.join(dir, 'priceRequests.json');

const seed = {
  tokB: { id: 'tokB', status: 'awaiting_price', lane: { origin: 'Pune', destination: 'Hosur' }, price: null },
  tokA: { id: 'tokA', status: 'captured', lane: { origin: 'Chikhli', destination: 'Noida' }, price: { cost: 50000 } },
  '123': { id: '123', status: 'dismissed', lane: { origin: 'Nagpur', destination: 'Raipur' }, price: null },
};
function writeSeed(obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

let reads = 0;
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  if (path.resolve(String(p)) === path.resolve(file)) reads += 1;
  return realRead.call(this, p, ...rest);
};

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ': ' + (e && e.message)); }
}

(async () => {
  await check('1. an unchanged file is read once across four reads', async () => {
    writeSeed(seed);
    const store = new FileStore({ dataDir: dir });
    reads = 0;
    await store.getDoc('priceRequests', 'tokA');
    await store.listDocs('priceRequests');
    await store.getDoc('priceRequests', 'tokB');
    await store.listDocs('priceRequests');
    assert.strictEqual(reads, 1, `priceRequests.json was read ${reads} times for 4 reads of an unchanged file`);
  });

  await check('2. a write through the store invalidates', async () => {
    writeSeed(seed);
    const store = new FileStore({ dataDir: dir });
    await store.listDocs('priceRequests');
    await store.patchDoc('priceRequests', 'tokB', { status: 'captured' });
    assert.strictEqual((await store.getDoc('priceRequests', 'tokB')).status, 'captured', 'patchDoc not seen');
    await store.putDoc('priceRequests', 'tokC', { id: 'tokC', status: 'awaiting_price' });
    assert.ok((await store.listDocs('priceRequests')).some((d) => d.id === 'tokC'), 'putDoc not seen');
    await store.removeDoc('priceRequests', 'tokA');
    assert.strictEqual(await store.getDoc('priceRequests', 'tokA'), null, 'removeDoc not seen');
    await store.putDocAsync('priceRequests', 'tokD', { id: 'tokD' });
    assert.ok(await store.getDoc('priceRequests', 'tokD'), 'putDocAsync not seen');
  });

  await check('3. a hand edit is seen on the next read', async () => {
    writeSeed(seed);
    const store = new FileStore({ dataDir: dir });
    await store.listDocs('priceRequests');
    writeSeed({ ...seed, tokA: { ...seed.tokA, status: 'hand-edited-by-ops' } });
    assert.strictEqual((await store.getDoc('priceRequests', 'tokA')).status, 'hand-edited-by-ops', 'the hand edit was not seen');
  });

  await check('4. mutating a returned doc does not leak into the next read', async () => {
    writeSeed(seed);
    const store = new FileStore({ dataDir: dir });
    const one = await store.getDoc('priceRequests', 'tokA');
    one.status = 'mutated';
    one.price.cost = 1;
    const all = await store.listDocs('priceRequests');
    all.find((d) => d.id === 'tokB').lane.origin = 'mutated';
    all.push({ id: 'intruder' });
    const again = await store.getDoc('priceRequests', 'tokA');
    assert.strictEqual(again.status, 'captured', 'a getDoc caller\'s mutation leaked');
    assert.strictEqual(again.price.cost, 50000, 'a nested mutation leaked');
    const list = await store.listDocs('priceRequests');
    assert.strictEqual(list.find((d) => d.id === 'tokB').lane.origin, 'Pune', 'a listDocs caller\'s mutation leaked');
    assert.strictEqual(list.length, 3, 'a push onto the returned list leaked');
  });

  await check('5. the documents and their order match an uncached read', async () => {
    writeSeed(seed);
    const store = new FileStore({ dataDir: dir });
    await store.listDocs('priceRequests');
    const expected = Object.values(JSON.parse(realRead(file, 'utf8')));
    assert.deepStrictEqual(await store.listDocs('priceRequests'), expected);
    assert.deepStrictEqual(await store.getDoc('priceRequests', '123'), seed['123']);
    assert.strictEqual(await store.getDoc('priceRequests', 'nope'), null);
  });

  fs.readFileSync = realRead;
  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, 5, `expected 5 checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-filestore-price-requests-cache:', e && e.message); process.exit(1); });
