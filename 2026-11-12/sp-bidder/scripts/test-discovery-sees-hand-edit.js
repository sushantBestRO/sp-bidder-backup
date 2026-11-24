'use strict';
/**
 * DISCOVERY ACTS ON THE PRICE-REQUEST COLLECTION AS IT STANDS - positive pin.
 *
 * Pins what a fix for the discovery-pass stall (the pass re-reading and re-parsing the whole
 * priceRequests collection through FileStore for every listed load, on the tick thread) must not take
 * away. This file PASSES on the code it was written against; it exists to go red if the repair trades
 * one of these properties for speed:
 *
 *   1. AN OPERATOR HAND EDIT TO data/priceRequests.json IS LIVE ON THE NEXT PASS, with no restart.
 *      Deleting a listed load's record makes the next pass ask for it again, and so does a same-size
 *      edit with the file's mtime put back to its pre-edit millisecond (a listed record's loadId
 *      changed to another of the same length). A cache kept across passes must not serve the pre-edit collection.
 *   2. A LOAD LISTED TWICE IN ONE LISTING GETS ONE REQUEST AND ONE ASK. The pass's own create is
 *      visible to the rest of the same pass.
 *   3. A CHANGE ANOTHER ACTOR MAKES WHILE THE PASS WAITS ON THE NOTIFIER IS SEEN BY THE REST OF THE
 *      SAME PASS. A dismissed request restored through PriceRequestStore.restore during the price ask
 *      for an earlier load gets its moved close refreshed when the pass reaches it.
 *
 * Asserts only what discovery produces (tick counts, requests, asks), never how the collection is
 * read. The one assumption about the on-disk form is that priceRequests.json stays a single JSON
 * document an operator can edit.
 *
 * Offline and deterministic: real DiscoveryPoller + PriceRequestStore + FileStore on temp dirs under
 * os.tmpdir(), removed at the end; fake portal and notifier. No network, no RNG, no sleeps.
 *
 *   node scripts/test-discovery-sees-hand-edit.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp dataDir, operator edits), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store/fileStore');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');

const EXPECTED_CHECKS = 5;
let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const HOUR = 3_600_000;
const STEP_MS = 300_000;
const SHIPPER = 'Havells India Ltd';
const DIRS = [];
const cleanup = () => { for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };

function portalLoad(id, closesAt) {
  return {
    id, lane: { origin: 'Sanand, Gujarat 382110', destination: 'Hosur, Tamil Nadu 635126' }, equipment: '32 ft MXL',
    units: 1, companyName: SHIPPER, shipmentType: 'FTL', closesAt, startsAt: closesAt - 4 * HOUR,
    status: 'live', softClose: true, closeModelKnown: true, closeModel: 'soft',
    points: [{ kind: 'pickup', address: 'Plot 12, GIDC, Sanand, Gujarat 382110, India' }, { kind: 'drop', address: 'Depot 4, Hosur, Tamil Nadu 635126, India' }],
  };
}

function storedRecord(token, loadId, closesAt, status = 'awaiting_price') {
  const load = Object.assign({}, portalLoad(loadId, closesAt));
  delete load.id;
  delete load.closeModel;
  return {
    id: token, loadId, account: null, platformKey: 'gocomet', customer: null, load,
    marginsPct: [9, 5, 1], minMarginPct: 1, marginSource: 'default', marginOverride: null,
    status, createdAt: closesAt - 5 * HOUR, deadlineAt: closesAt - 35_000, price: null, capturedAt: null,
    notified: true, notifiedAt: closesAt - 5 * HOUR + 2_000, reminderSentAt: null,
    ...(status === 'dismissed' ? { dismissedAt: closesAt - 4 * HOUR } : {}),
  };
}

function setup(records, { onAsk } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-hand-edit-'));
  DIRS.push(dir);
  const file = path.join(dir, COLLECTION + '.json');
  const map = {};
  for (const r of records) map[r.id] = r;
  fs.writeFileSync(file, JSON.stringify(map, null, 2));
  const h = { dir, file, listing: [], asks: [] };
  const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
  h.requests = new PriceRequestStore({ store, marginsPct: [9, 5, 1], minMarginPct: 1, platformKey: 'gocomet' });
  const notifier = {
    requestPrice: async (req) => { h.asks.push(req.loadId); if (onAsk) await onAsk(req, h); return { delivered: true }; },
    remindApproaching: async () => ({ delivered: true }),
    alert: async () => ({ delivered: true }),
  };
  const portal = {
    capabilities: () => ({ closeModel: 'soft', extensionCeiling: null, extensionIncrementMs: STEP_MS }),
    listAuctions: async () => h.listing,
  };
  h.poller = new DiscoveryPoller({
    adapter: portal, requests: h.requests, notifier, platformKey: 'gocomet',
    config: { allowlist: { shippers: [SHIPPER] }, priceDeadlineLeadMs: 35_000, reminderLeadMs: 300_000 },
  });
  h.onDisk = () => Object.values(JSON.parse(fs.readFileSync(file, 'utf8')));
  h.forLoad = (loadId) => h.onDisk().filter((r) => String(r.loadId) === String(loadId));
  return h;
}

let property = 'setup';

(async () => {
  const now = Date.now();

  property = 'an operator hand edit is live on the next pass';
  const L1 = 'GCQ100001X';
  const L2 = 'GCQ100002X';
  const L2_RENAMED = 'GCQ900002X';
  const c1 = now + 2 * HOUR;
  const c2 = now + 3 * HOUR;
  const h = setup([storedRecord('tokL1aaaaaa', L1, c1), storedRecord('tokL2aaaaaa', L2, c2)]);
  h.listing = [portalLoad(L1, c1), portalLoad(L2, c2)];

  const first = await h.poller.tick();
  assert.strictEqual(first.created, 0, 'baseline: both listed loads already have requests, so nothing is created');
  assert.deepStrictEqual(h.asks, [], 'baseline: no price is asked');
  ok('1. baseline pass: two listed loads with existing requests, nothing created, nothing asked');

  const edited = JSON.parse(fs.readFileSync(h.file, 'utf8'));
  delete edited.tokL1aaaaaa;
  fs.writeFileSync(h.file, JSON.stringify(edited, null, 2));
  const second = await h.poller.tick();
  assert.strictEqual(second.created, 1, `after the operator deleted load ${L1}'s record by hand, the next pass creates one request (got ${JSON.stringify(second)})`);
  assert.deepStrictEqual(h.asks, [L1], `after the hand delete, the next pass asks for load ${L1} exactly once`);
  const recreated = h.forLoad(L1);
  assert.strictEqual(recreated.length, 1, `load ${L1} has exactly one request after the hand delete`);
  assert.notStrictEqual(recreated[0].id, 'tokL1aaaaaa', `load ${L1}'s request is a new one, not the deleted record`);
  ok('2. a record deleted by hand between passes is recreated and asked for by the next pass');

  const raw = fs.readFileSync(h.file, 'utf8');
  const before = fs.statSync(h.file);
  const needle = `"loadId": "${L2}"`;
  assert.strictEqual(raw.split(needle).length, 2, `setup: load ${L2}'s loadId appears exactly once in the file`);
  const sameSize = raw.replace(needle, `"loadId": "${L2_RENAMED}"`);
  assert.strictEqual(Buffer.byteLength(sameSize), Buffer.byteLength(raw), 'setup: the edit leaves the byte length unchanged');
  fs.writeFileSync(h.file, sameSize);
  // fs.utimes carries a double of seconds, so a sub-microsecond mtime cannot be restored exactly;
  // restoring stat.mtime (the rounded millisecond Date) makes that Date identical.
  fs.utimesSync(h.file, before.atime, before.mtime);
  const afterEdit = fs.statSync(h.file);
  assert.strictEqual(afterEdit.size, before.size, 'setup: the file size is unchanged by the edit');
  assert.strictEqual(afterEdit.mtime.getTime(), before.mtime.getTime(), 'setup: the file mtime is restored to its pre-edit millisecond');
  const third = await h.poller.tick();
  assert.strictEqual(third.created, 1, `after a same-size hand edit that moved load ${L2}'s record to another loadId, the next pass creates one request (got ${JSON.stringify(third)})`);
  assert.deepStrictEqual(h.asks, [L1, L2], `after the same-size edit, the next pass asks for load ${L2} exactly once`);
  assert.strictEqual(h.forLoad(L2).length, 1, `load ${L2} has exactly one request after the same-size edit`);
  assert.strictEqual(h.forLoad(L2_RENAMED).length, 1, 'the hand-edited record is still there under its new loadId');
  ok('3. a same-size hand edit with the mtime restored is acted on by the next pass');

  property = 'a load listed twice in one listing gets one request and one ask';
  const N = 'GCQ200001X';
  const d = setup([]);
  d.listing = [portalLoad(N, now + 2 * HOUR), portalLoad(N, now + 2 * HOUR)];
  const dup = await d.poller.tick();
  assert.strictEqual(dup.created, 1, `a load listed twice is created once (got ${JSON.stringify(dup)})`);
  assert.deepStrictEqual(d.asks, [N], 'a load listed twice is asked for exactly once');
  assert.strictEqual(d.forLoad(N).length, 1, 'a load listed twice has exactly one request');
  ok('4. a load listed twice in one listing gets exactly one request and one requestPrice call');

  property = "another actor's change during the notifier wait is seen by the rest of the same pass";
  const NEW = 'GCQ300001X';
  const R = 'GCQ300002X';
  const cR = now + 2 * HOUR;
  const movedR = cR + 120_000;
  let restoredMidPass = false;
  const o = setup([storedRecord('tokRdismiss', R, cR, 'dismissed')], {
    onAsk: async (req, hh) => {
      if (req.loadId !== NEW) return;
      await new Promise((resolve) => setImmediate(resolve));
      await hh.requests.restore('tokRdismiss');
      restoredMidPass = true;
    },
  });
  o.listing = [portalLoad(NEW, now + 4 * HOUR), portalLoad(R, movedR)];
  const other = await o.poller.tick();
  assert.ok(restoredMidPass, 'setup: the restore ran while the pass waited on the price ask for the earlier load');
  assert.strictEqual(other.created, 1, `the new load is created (got ${JSON.stringify(other)})`);
  assert.deepStrictEqual(o.asks, [NEW], 'only the new load is asked for');
  const rec = o.forLoad(R);
  assert.strictEqual(rec.length, 1, `load ${R} still has exactly one request`);
  assert.strictEqual(rec[0].status, 'awaiting_price', `load ${R} is awaiting a price after the restore`);
  assert.strictEqual(rec[0].load.liveClosesAt, movedR, `load ${R}, restored mid-pass, carries the refreshed liveClosesAt from the same pass`);
  ok('5. a request restored by another actor while the pass waited on the notifier gets its moved close refreshed in the same pass');

  assert.strictEqual(pass, EXPECTED_CHECKS, `ran ${pass} of ${EXPECTED_CHECKS} checks`);
  console.log(`\nPASS test-discovery-sees-hand-edit: ${pass}/${EXPECTED_CHECKS} checks`);
  cleanup();
  process.exit(0);
})().catch((e) => {
  cleanup();
  console.error(`\nFAIL test-discovery-sees-hand-edit (check ${pass + 1}, ${property}): ${e && e.message}`);
  process.exit(1);
});
