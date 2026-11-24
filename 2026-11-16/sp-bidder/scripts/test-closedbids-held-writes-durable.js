'use strict';
/**
 * closedBids writes through the held cache reach the disk: a fresh store reads back every put, patch
 * and remove.
 *
 * FileStore holds closedBids as pre-serialized entries so a write costs the changed document, not the
 * collection (T1). Every in-process read then comes from that cache while the file's signature is
 * unchanged, so a write that updated the cache but never reached the file reads correctly until the
 * next restart, when the result records it carried are gone. The suite used memory stores and the
 * same instance, so a dropped save or a dropped entry update survived it (mutation critique, PR-1).
 *
 *   node scripts/test-closedbids-held-writes-durable.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (a temp data dir), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-durable-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

(async () => {
  const a = new FileStore({ dataDir: dir });
  await a.putDoc('closedBids', 'L1', { auctionId: 'L1', won: null, ourBids: [{ price: 50400 }] });
  await a.putDoc('closedBids', 'L2', { auctionId: 'L2', won: false });
  await a.patchDoc('closedBids', 'L1', { won: true, finalRank: 1 });
  // Read back before anything else writes: a later write re-saves the whole cache and would hide a
  // patch that never reached the file.
  const afterPatch = await new FileStore({ dataDir: dir }).getDoc('closedBids', 'L1');
  assert.ok(afterPatch && afterPatch.won === true && afterPatch.finalRank === 1,
    `a patch was not on disk before the next write: ${JSON.stringify(afterPatch)}`);
  const removed = await a.removeDoc('closedBids', 'L2');
  const removedMissing = await a.removeDoc('closedBids', 'NOPE');

  assert.strictEqual(removed, true, `removeDoc of an existing closed record returned ${removed}`);
  assert.strictEqual(removedMissing, false, `removeDoc of a missing record returned ${removedMissing}`);
  ok(1, 'removeDoc reports whether a record was removed');

  const b = new FileStore({ dataDir: dir }); // a restart: nothing held, everything from disk
  const l1 = await b.getDoc('closedBids', 'L1');
  assert.ok(l1, 'a fresh store does not see the closed record written before the restart');
  assert.deepStrictEqual({ won: l1.won, finalRank: l1.finalRank, ourBids: l1.ourBids },
    { won: true, finalRank: 1, ourBids: [{ price: 50400 }] },
    `the patched fields did not survive a restart: ${JSON.stringify(l1)}`);
  ok(2, 'a patch to a closed record survives a restart');

  assert.strictEqual(await b.getDoc('closedBids', 'L2'), null, 'a removed closed record came back after a restart');
  assert.strictEqual((await b.listDocs('closedBids')).length, 1, 'the closed-record count after a restart is wrong');
  ok(3, 'a removal survives a restart');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'closedBids.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk), ['L1'], `closedBids.json holds ${JSON.stringify(Object.keys(onDisk))}`);
  ok(4, 'the file on disk holds exactly what the store reports');

  console.log(`\n${pass}/4 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
