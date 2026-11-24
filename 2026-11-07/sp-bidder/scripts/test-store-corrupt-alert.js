'use strict';
/**
 * Pins D015 (fix/ops-alerting-divergences).
 *
 * atomicFile.readJSON already backs up a corrupt collection file and fires onCorrupt if the
 * caller passed one, but only DurableScheduler (intents) and targetPriceWatch ever did. Every
 * OTHER FileStore collection (accounts, priceRequests, notifSent, config, ...) fell back to {}
 * silently through FileStore._coll / _collAsync, which passed no onCorrupt at all - and the
 * async read path (readJSONAsync) did not even accept the option. FileStore must alert on any
 * collection's corrupt file, sync or async, via a settable onCorrupt hook.
 * @requires-summary-line
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { FileStore } = require('../src/store/fileStore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-corrupt-test-'));

  // ---- sync path: getDoc on a corrupt file ----
  {
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), '{ not json');
    const store = new FileStore({ dataDir });
    let reported = null;
    store.onCorrupt = (collection) => { reported = collection; };
    const v = await store.getDoc('accounts', 'primary');
    ok(v === null, 'a corrupt collection still falls back to {} (no doc found), never throws');
    ok(reported === 'accounts', 'D015 sync: onCorrupt fires with the collection name for a corrupt collection file');
    ok(fs.readdirSync(dataDir).some((f) => /^accounts\.json\.corrupt\./.test(f)),
      'the corrupt file is still backed up, as before');
  }

  // ---- async path: getDocAsync on a corrupt file ----
  {
    fs.writeFileSync(path.join(dataDir, 'priceRequests.json'), '{{{ garbage');
    const store = new FileStore({ dataDir });
    let reported = null;
    store.onCorrupt = (collection) => { reported = collection; };
    const v = await store.getDocAsync('priceRequests', 'r1');
    ok(v === null, 'async: a corrupt collection still falls back to {} (no doc found), never throws');
    ok(reported === 'priceRequests', 'D015 async: onCorrupt fires with the collection name for a corrupt collection file');
  }

  // ---- a store with no onCorrupt wired behaves exactly as before (no throw, no crash) ----
  {
    fs.writeFileSync(path.join(dataDir, 'notifSent.json'), 'not even close to json');
    const store = new FileStore({ dataDir }); // onCorrupt left null
    let threw = false;
    let v;
    try { v = await store.getDoc('notifSent', 'x'); } catch (_) { threw = true; }
    ok(!threw && v === null, 'no onCorrupt wired: still falls back safely, exactly as before this fix');
  }

  // ---- a clean file never fires onCorrupt ----
  {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ current: { a: 1 } }));
    const store = new FileStore({ dataDir });
    let fired = false;
    store.onCorrupt = () => { fired = true; };
    const v = await store.getDoc('config', 'current');
    ok(!fired, 'a clean file never fires onCorrupt');
    ok(v && v.a === 1, 'a clean file still reads its real value');
  }

  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
