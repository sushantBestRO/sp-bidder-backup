'use strict';
/**
 * patchDoc's COMPARE-AND-SET: a patch carrying `__expect` writes only if the stored document still
 * holds those values, on every backend and both FileStore layouts.
 *
 * Regression target: T1 D9 (R2-6), the store half. A re-price reads the record, checks it is
 * 'armed', and writes later; without a precondition at the write, an operator Stop that landed in
 * between is silently merged under the re-price. The re-price's write now says which status it was
 * authorised against, and the store refuses it when that status has moved.
 *
 * WHAT MUST NOT MOVE:
 *   - a patch with no `__expect` merges exactly as before (check 1 per backend);
 *   - `__expect` is a precondition, never a stored field (checked on every successful write).
 *
 * Offline and deterministic: MemoryStore, and FileStore under os.tmpdir().
 *
 *   node scripts/test-store-patch-expect.js
 */
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const os = require('os');
const path = require('path');
const assert = require('assert');
const { FileStore, MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

async function contract(label, store, coll) {
  await store.putDoc(coll, 'k1', { id: 'k1', status: 'armed', cost: 30000 });

  const plain = await store.patchDoc(coll, 'k1', { cost: 31000 });
  assert.deepStrictEqual(plain, { id: 'k1', status: 'armed', cost: 31000 }, `${label}: a plain patch merges as before`);
  ok(`${label}: a patch with no __expect merges as before`);

  const matched = await store.patchDoc(coll, 'k1', { cost: 32000, __expect: { status: 'armed' } });
  assert.deepStrictEqual(matched, { id: 'k1', status: 'armed', cost: 32000 }, `${label}: a matching precondition writes`);
  assert.deepStrictEqual(await store.getDoc(coll, 'k1'), { id: 'k1', status: 'armed', cost: 32000 },
    `${label}: the stored document carries no __expect key`);
  ok(`${label}: a matching __expect writes, and is not stored`);

  await store.patchDoc(coll, 'k1', { status: 'stopped', stoppedAt: 1 });
  let refused = null;
  try { await store.patchDoc(coll, 'k1', { cost: 99999, __expect: { status: 'armed' } }); }
  catch (e) { refused = e; }
  assert.ok(refused, `${label}: a patch expecting 'armed' on a 'stopped' document must be refused, not merged`);
  assert.strictEqual(refused.code, 'EXPECT_FAILED', `${label}: refused with code EXPECT_FAILED (got ${refused.code})`);
  assert.strictEqual(refused.actual, 'stopped', `${label}: the refusal names the status it found`);
  assert.deepStrictEqual(await store.getDoc(coll, 'k1'), { id: 'k1', status: 'stopped', cost: 32000, stoppedAt: 1 },
    `${label}: the refused patch wrote nothing`);
  ok(`${label}: a moved status refuses the write and leaves the document as the other writer left it`);

  let missing = null;
  try { await store.patchDoc(coll, 'nope', { cost: 1, __expect: { status: 'armed' } }); }
  catch (e) { missing = e; }
  assert.ok(missing && missing.code === 'EXPECT_FAILED', `${label}: a precondition on a missing document refuses`);
  assert.strictEqual(await store.getDoc(coll, 'nope'), null, `${label}: nothing was created for the missing key`);
  ok(`${label}: a precondition on a missing document refuses and creates nothing`);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-patch-expect-'));
  try {
    await contract('MemoryStore', new MemoryStore(), 'priceRequests');
    await contract('FileStore', new FileStore({ dataDir: dir }), 'priceRequests');
    await contract('FileStore held collection', new FileStore({ dataDir: dir }), 'closedBids');
    console.log(`\nPASS - ${pass}/12 checks passed`);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED (T1 D9 store compare-and-set):', e && e.message ? e.message : e);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
})();
