'use strict';
/**
 * D015, the held path. closedBids is a HELD collection (read through FileStore._heldEntries, not
 * _coll), and that read passed no onCorrupt: a corrupt closed-bids ledger was moved aside and reset
 * to {} with only atomicFile's warn line, and the next write persisted the empty ledger. It must
 * raise the same onCorrupt every other collection does (test-store-corrupt-alert.js).
 * @requires-summary-line
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { FileStore } = require('../src/store/fileStore');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-corrupt-held-test-'));
  const file = path.join(dataDir, 'closedBids.json');

  for (const [label, op] of [
    ['getDoc', (s) => s.getDoc('closedBids', 'L1')],
    ['listDocs', (s) => s.listDocs('closedBids')],
    ['putDoc', (s) => s.putDoc('closedBids', 'L2', { auctionId: 'L2' })],
    ['patchDoc', (s) => s.patchDoc('closedBids', 'L3', { auctionId: 'L3' })],
    ['removeDoc', (s) => s.removeDoc('closedBids', 'L1')],
    ['getDocAsync', (s) => s.getDocAsync('closedBids', 'L1')],
  ]) {
    fs.writeFileSync(file, '{ "L1": { "auctionId": "L1" ');
    const store = new FileStore({ dataDir });
    const reported = [];
    store.onCorrupt = (collection) => { reported.push(collection); };
    let threw = false;
    try { await op(store); } catch (_) { threw = true; }
    ok(!threw, `${label}: a corrupt closedBids ledger still falls back without throwing`);
    ok(reported.length === 1 && reported[0] === 'closedBids',
      `${label}: onCorrupt fires once with 'closedBids' for a corrupt held ledger, got ${JSON.stringify(reported)}`);
    ok(store.takeCorrupt('closedBids') === true, `${label}: takeCorrupt reports the held collection`);
    for (const f of fs.readdirSync(dataDir)) fs.unlinkSync(path.join(dataDir, f));
  }

  {
    fs.writeFileSync(file, JSON.stringify({ L1: { auctionId: 'L1' } }));
    const store = new FileStore({ dataDir });
    let fired = false;
    store.onCorrupt = () => { fired = true; };
    const v = await store.getDoc('closedBids', 'L1');
    ok(!fired, 'a clean held ledger never fires onCorrupt');
    ok(v && v.auctionId === 'L1', 'a clean held ledger still reads its real value');
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
