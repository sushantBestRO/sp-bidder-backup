'use strict';
/**
 * The store-corrupt alert (D015) must reach priceRequests through the parse cache #256 added
 * (FileStore._parsedDocs), the path every sync priceRequests read takes: discovery and the open
 * price page. The async read the D015 pin covers does not pass through it.
 *
 * @requires-summary-line
 *   node scripts/test-store-corrupt-alert-parse-cache.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileStore } = require('../src/store/fileStore');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrupt-parse-cache-'));
  fs.writeFileSync(path.join(dataDir, 'priceRequests.json'), '{{{ garbage');
  const store = new FileStore({ dataDir });
  const reported = [];
  store.onCorrupt = (collection) => { reported.push(collection); };

  ok((await store.getDoc('priceRequests', 'r1')) === null, 'a corrupt priceRequests still reads as empty, never throws');
  ok(reported.length === 1 && reported[0] === 'priceRequests',
    `a corrupt priceRequests read through the parse cache fires onCorrupt once, got ${JSON.stringify(reported)}`);
  ok(fs.readdirSync(dataDir).some((f) => /^priceRequests\.json\.corrupt\./.test(f)), 'the corrupt file is backed up');

  ok(Array.isArray(await store.listDocs('priceRequests')), 'a second read after the backup still reads');
  ok(reported.length === 1, `the one corrupt file is reported once, not on every read, got ${reported.length}`);

  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-parse-cache-'));
  fs.writeFileSync(path.join(clean, 'priceRequests.json'), JSON.stringify({ r1: { loadId: 'r1' } }));
  const cleanStore = new FileStore({ dataDir: clean });
  let fired = false;
  cleanStore.onCorrupt = () => { fired = true; };
  const doc = await cleanStore.getDoc('priceRequests', 'r1');
  ok(doc && doc.loadId === 'r1' && !fired, 'control: a clean priceRequests reads its value and never fires onCorrupt');

  console.log(`${pass}/6 checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
