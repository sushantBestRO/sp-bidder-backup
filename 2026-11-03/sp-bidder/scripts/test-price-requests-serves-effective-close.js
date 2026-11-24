'use strict';
/**
 * /api/price-requests SERVES THE CLOSE EVERY GATE READS - an extended auction stays on the worklist.
 *
 * Regression target: T1 D11 (R2-7).
 *
 * The record's `load.closesAt` is the discovery snapshot, written once. When the portal extends the
 * auction, refreshLiveClose writes `load.liveClosesAt`, and every server gate and sweep reads
 * effectiveCloseAt (the later of the two). The worklist endpoint spread `r.load` as-is, so the
 * console's worklist filter, sort, countdown and pending badge all read the superseded snapshot
 * (they read `load.closesAt`, and nothing else). The moment the snapshot passes, a load the server
 * still takes a cost for leaves the worklist and books skipped_no_price.
 *
 * WHAT MUST NOT MOVE:
 *   - a load that was never extended serves its close unchanged (check 1, the control);
 *   - the stored record's snapshot is never rewritten: the fix is in the payload (check 2).
 *
 * Offline and deterministic: mock platform, memory store, the real refreshLiveClose with an explicit
 * nowMs, and the console predicate evaluated at an explicit instant. No sleeps.
 *
 *   node scripts/test-price-requests-serves-effective-close.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_NOTIFY_MODE = 'dashboard';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const http = require('http');
const assert = require('assert');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-effective-close-'));
process.env.SP_DATA_DIR = DATA_DIR;

const { app, requests } = require('../src/web/server');
const { effectiveCloseAt } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const cleanup = () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} };

function getJson(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// dashboard/src/pages/PriceRequests.tsx visibleRows, the close clause, transcribed verbatim.
const MAX_PLAUSIBLE_CLOSE_MS = 30 * 24 * 60 * 60 * 1000;
const worklistVisible = (r, now) =>
  (!r.load?.closesAt || (r.load.closesAt > now && r.load.closesAt <= now + MAX_PLAUSIBLE_CLOSE_MS));

const T0 = Date.now();
const SNAPSHOT_CLOSE = T0 + 5 * 60_000;
const STEP_MS = 10 * 60_000;
const LIVE_CLOSE = SNAPSHOT_CLOSE + 9 * 60_000;

const mkLoad = (id) => ({
  id, lane: { origin: 'Khopoli', destination: 'Keeranur' }, equipment: 'Trailer', units: 1,
  companyName: 'Syngenta India', closesAt: SNAPSHOT_CLOSE, startsAt: T0 - 60_000, softClose: true, status: 'live',
});

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const finish = (code) => { server.close(); cleanup(); process.exit(code); };

  try {
    const plain = await requests.createForLoad(mkLoad('EC-PLAIN'), { deadlineAt: T0 + 60 * 60_000 });
    const ext = await requests.createForLoad(mkLoad('EC-EXTENDED'), { deadlineAt: T0 + 60 * 60_000 });
    const moved = await requests.refreshLiveClose(ext.id, LIVE_CLOSE, { extensionStepMs: STEP_MS, nowMs: T0 });
    assert.ok(moved && moved.load.liveClosesAt === LIVE_CLOSE, 'setup: refreshLiveClose must accept the extension');

    const api = await getJson(base, '/api/price-requests');
    assert.strictEqual(api.status, 200, 'setup: /api/price-requests answers 200');
    const rowOf = (loadId) => (api.json.requests || []).find((x) => String(x.loadId) === loadId);
    const plainRow = rowOf('EC-PLAIN');
    const extRow = rowOf('EC-EXTENDED');
    assert.ok(plainRow && extRow, 'setup: both requests are on the worklist payload');

    // ---- 1. CONTROL: a load that was never extended serves its close unchanged
    assert.strictEqual(plainRow.load.closesAt, SNAPSHOT_CLOSE, 'control: an un-extended load serves its own close');
    assert.strictEqual(worklistVisible(plainRow, SNAPSHOT_CLOSE + 1_000), false,
      'control: an un-extended load leaves the worklist once its close has passed');
    ok('control: a non-extended load serves its close unchanged');

    // ---- 2. POSITIVE PIN: the stored snapshot is never rewritten
    const stored = await requests.getByToken(ext.id);
    assert.strictEqual(stored.load.closesAt, SNAPSHOT_CLOSE, 'the stored snapshot close is untouched by a read');
    assert.strictEqual(stored.load.liveClosesAt, LIVE_CLOSE, 'the stored live close is untouched by a read');
    ok('the record keeps its snapshot; only the payload resolves the close');

    // ---- 3. THE DEFECT: the extended load serves the superseded snapshot
    assert.strictEqual(extRow.load.closesAt, effectiveCloseAt(stored.load),
      `T1 D11 snapshot close served: /api/price-requests load.closesAt is ${extRow.load.closesAt} (the discovery `
      + `snapshot) but every server gate reads effectiveCloseAt = ${effectiveCloseAt(stored.load)} (the portal's `
      + 'extended close); the endpoint spreads r.load without resolving it');
    const between = SNAPSHOT_CLOSE + 1_000;
    assert.strictEqual(worklistVisible(extRow, between), true,
      'T1 D11: one second after the superseded snapshot close, with the portal close 9 minutes out, the console '
      + 'worklist must still show the load the server still takes a cost for');
    ok('extended: the worklist payload serves the effective close, and the console keeps the row');

    console.log(`\nPASS - ${pass}/3 checks passed`);
    finish(0);
  } catch (e) {
    console.error('\nFAILED (T1 D11 worklist serves the snapshot close):', e && e.message ? e.message : e);
    finish(1);
  }
})().catch((e) => { console.error('harness error:', e); cleanup(); process.exit(1); });
