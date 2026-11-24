'use strict';
/**
 * Seam 1 verification. No network.
 *   A. CONTRACT: FileStore and MemoryStore pass the identical suite (proves the
 *      seam is real, not leaky — a network backend later is a drop-in).
 *   B. GREP GATE: no require('fs') for app state outside src/store/.
 *
 *   node scripts/test-store.js
 */
const fs = require('fs'); // allowed here: this is a test + the grep-gate scanner, not app state
const os = require('os');
const path = require('path');
const assert = require('assert');
const { FileStore, MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sortById = (arr) => [...arr].sort((a, b) => String(a.id).localeCompare(String(b.id)));

// One suite, run against any store; returns a snapshot of observable results.
async function runContract(store) {
  const r = {};
  // keyed documents
  r.missing = await store.getDoc('accounts', 'nope');                 // -> null
  await store.putDoc('accounts', 'a1', { id: 'a1', platform: 'superprocure', enabled: true });
  await store.putDoc('accounts', 'a2', { id: 'a2', platform: 'superprocure', enabled: false });
  r.got = await store.getDoc('accounts', 'a1');
  r.patched = await store.patchDoc('accounts', 'a1', { enabled: false, branchIds: [1, 2] });
  // patchDoc on a key with NO prior doc must create it (not throw, not silently no-op) - the
  // exact shape rememberAccountContact (server.js) relies on for a brand-new account's very
  // first login-contact record.
  r.patchedNew = await store.patchDoc('accountContacts', 'brand-new', { accountId: 'brand-new', email: 'x@y.com' });
  r.list = sortById(await store.listDocs('accounts'));
  r.removed = await store.removeDoc('accounts', 'a2');
  r.removedMissing = await store.removeDoc('accounts', 'a2');          // -> false (already gone)
  r.listAfter = sortById(await store.listDocs('accounts'));

  // the NON-BLOCKING document methods - same observable results as their sync siblings, and the
  // same backing collection, so a sync read sees an async write.
  await store.putDocAsync('anchors', 'n1', { id: 'n1', open: true });
  await store.putDocAsync('anchors', 'n2', { id: 'n2', open: false });
  r.gotAsync = await store.getDocAsync('anchors', 'n1');
  r.missingAsync = await store.getDocAsync('anchors', 'nope');
  r.crossRead = await store.getDoc('anchors', 'n1');
  r.listAsync = sortById(await store.listDocsAsync('anchors'));
  r.removedAsync = await store.removeDocAsync('anchors', 'n2');
  r.removedMissingAsync = await store.removeDocAsync('anchors', 'n2');
  // Two writes to ONE collection, in flight together. The sync path gets its read-modify-write
  // atomicity from running in a single tick; the async path has to serialize to keep it, and
  // without that the second write reads the pre-write map and drops the first's document.
  await Promise.all([
    store.putDocAsync('anchors', 'c1', { id: 'c1' }),
    store.putDocAsync('anchors', 'c2', { id: 'c2' }),
  ]);
  r.afterConcurrent = sortById(await store.listDocsAsync('anchors')).map((d) => d.id);

  // append-only event streams (the day-1 log shape)
  const t0 = Date.now();
  await store.appendEvent('bids', { ts: t0, kind: 'bid', price: 100 });
  await store.appendEvent('bids', { ts: t0 + 10, kind: 'bid', price: 90 });
  await store.appendEvent('bids', { ts: t0 + 20, kind: 'bid', price: 80 });
  r.allEvents = (await store.readEvents('bids', { from: t0, to: t0 + 100 })).map((e) => e.price);
  r.rangeEvents = (await store.readEvents('bids', { from: t0 + 10, to: t0 + 100 })).map((e) => e.price);
  return r;
}

(async () => {
  // ---- A. contract: both backends, identical observable behaviour ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spstore-'));
  const fileRes = await runContract(new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') }));
  const memRes = await runContract(new MemoryStore());

  assert.deepStrictEqual(fileRes, memRes, 'FileStore and MemoryStore produce identical results');
  // and spot-check the actual expected values (so "identical" can't be identically-wrong)
  assert.strictEqual(fileRes.missing, null, 'missing doc -> null');
  assert.deepStrictEqual(fileRes.patched, { id: 'a1', platform: 'superprocure', enabled: false, branchIds: [1, 2] }, 'patch merges');
  assert.deepStrictEqual(fileRes.patchedNew, { accountId: 'brand-new', email: 'x@y.com' }, 'patch on a missing key creates the doc instead of throwing or no-oping');
  assert.strictEqual(fileRes.list.length, 2, 'list has both docs before remove');
  assert.strictEqual(fileRes.removed, true, 'remove existing -> true');
  assert.strictEqual(fileRes.removedMissing, false, 'remove missing -> false');
  assert.strictEqual(fileRes.listAfter.length, 1, 'list has one doc after remove');
  assert.deepStrictEqual(fileRes.gotAsync, { id: 'n1', open: true }, 'async put/get round-trips');
  assert.strictEqual(fileRes.missingAsync, null, 'missing doc -> null on the async read too');
  assert.deepStrictEqual(fileRes.crossRead, { id: 'n1', open: true }, 'a sync read sees an async write');
  assert.strictEqual(fileRes.removedAsync, true, 'async remove existing -> true');
  assert.strictEqual(fileRes.removedMissingAsync, false, 'async remove missing -> false');
  assert.deepStrictEqual(fileRes.afterConcurrent, ['c1', 'c2', 'n1'], 'concurrent async writes to one collection all survive');
  assert.deepStrictEqual(fileRes.allEvents, [100, 90, 80], 'all events in append order');
  assert.deepStrictEqual(fileRes.rangeEvents, [90, 80], 'from-filter drops the earlier event');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  ok('contract: FileStore === MemoryStore (docs + event streams)');

  // ---- B. grep gate: no require('fs') for app state outside src/store/ ----
  const srcRoot = path.join(__dirname, '..', 'src');
  const offenders = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      if (p.split(path.sep).includes('store')) continue; // src/store/ is the allowed home of fs
      // serverHealth.js reads live MACHINE health (statfs free space, log-file sizes, uptime) for the
      // daily heartbeat's Server section - a read-only probe, never app state. The gate's concern is
      // app STATE persistence going through the store seam, so this read-only health reader is allowed.
      if (ent.name === 'serverHealth.js') continue;
      const body = fs.readFileSync(p, 'utf8');
      if (/require\(\s*['"]fs['"]\s*\)/.test(body)) offenders.push(path.relative(srcRoot, p));
    }
  })(srcRoot);
  assert.deepStrictEqual(offenders, [], 'no require("fs") outside src/store/ — offenders: ' + JSON.stringify(offenders));
  ok('grep gate: no fs for app state outside src/store/');

  console.log(`\n${pass}/2 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
