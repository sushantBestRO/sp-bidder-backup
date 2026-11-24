'use strict';
/**
 * Danger-zone ACCEPT model, end to end. deadlineAt is now an ADVISORY danger line; the ONLY hard
 * stop is the auction actually closing (closesAt). This pins two seams:
 *
 *   STORE (priceRequests.js) - the guard itself:
 *     capture()/setBidOverride() throw GONE only when now >= closesAt. Past deadlineAt but before
 *     closesAt they SUCCEED (best-effort late bid). Tests 1-4.
 *
 *   ROUTE (POST /price/:token -> renderCaptured / re-price savedMsg) - the operator-facing receipt:
 *     comfortably-early  -> "Cost saved" / "Bidding will start automatically" (no caveat)
 *     danger zone        -> "Cost recorded - armed" / "may not land in time"
 *     danger re-price     -> saved message carries "the new price may not land in time"
 *   The route renders the REAL receipt HTML off the booted app (mock stack, memory store). Tests 5-8.
 *
 * A "danger-zone" request = closesAt comfortably future, deadlineAt patched into the past. deadlineAt
 * is what the danger check reads; closesAt stays future so the auction is genuinely still open.
 *
 *   node scripts/test-danger-zone-accept.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
// the mock stack's DurableScheduler writes intents.json on arm - keep it out of data/
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-danger-zone-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { PriceRequestStore, COLLECTION } = require('../src/pricing/priceRequests');
const { createStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ---------------------------------------------------------------------------------------------
// STORE-LEVEL helpers (fresh memory store per test, no engine) - mirror test-reprice-cutoff.js
// ---------------------------------------------------------------------------------------------
const BAND = [12, 10, 8];
const NEW_BAND = [10, 8, 6.3];
const mkStore = () => new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: BAND, minMarginPct: 6.3 });
const mkStoreLoad = (id, closesInMs = 30 * 60_000) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL',
  units: 1, companyName: 'Durian Industries', closesAt: Date.now() + closesInMs, startsAt: Date.now() - 1000, status: 'live', softClose: false });

async function throwsGone(fn, msg) {
  try { await fn(); assert.fail(`expected GONE, got success: ${msg}`); }
  catch (e) { assert.strictEqual(e.code, 'GONE', `${msg} (got code=${e.code}, message=${e.message})`); }
}
async function armedReq(rq, id) {
  const created = await rq.createForLoad(mkStoreLoad(id), { deadlineAt: Date.now() + 60_000 });
  await rq.capture(created.id, { cost: 45_000 }); // comfortably early -> armed
  return created.id;
}
// move only deadlineAt into the past (auction still open) -> the danger zone
async function enterDangerZone(rq, id) {
  await rq.store.patchDoc(COLLECTION, id, { deadlineAt: Date.now() - 1_000 });
}
// move the auction's real close (and deadline) into the past -> genuinely closed on the portal
async function closeAuction(rq, id) {
  const d = await rq.getByToken(id);
  await rq.store.patchDoc(COLLECTION, id, { load: { ...(d.load || {}), closesAt: Date.now() - 1_000 }, deadlineAt: Date.now() - 40_000 });
}

// ---------------------------------------------------------------------------------------------
// ROUTE-LEVEL helpers (boot the real app once, hit it over http) - mirror test-price-page-states.js
// ---------------------------------------------------------------------------------------------
function httpReq(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

(async () => {
  // =============================================================================================
  // STORE-LEVEL: the guard reads closesAt, not deadlineAt
  // =============================================================================================

  // 1) capture in the DANGER ZONE (deadline past, auction still open) -> ACCEPTED, arms
  // catches: comparator/field mutant that gates capture on deadlineAt (`now >= deadlineAt -> GONE`)
  //          instead of closesAt - that would wrongly refuse a still-winnable late cost.
  {
    const rq = mkStore();
    const created = await rq.createForLoad(mkStoreLoad('CAP-DANGER'), { deadlineAt: Date.now() + 60_000 });
    await enterDangerZone(rq, created.id); // deadlineAt -> past, closesAt still 30min out
    const updated = await rq.capture(created.id, { cost: 47_500 });
    assert.strictEqual(updated.status, 'armed', 'danger-zone capture arms the request (not refused)');
    assert.strictEqual(updated.price.cost, 47_500, 'danger-zone capture stores the exact captured cost');
    ok('capture in the danger zone (deadline past, auction open) is ACCEPTED and arms');
  }

  // 2) capture PAST THE REAL CLOSE -> refused (GONE), nothing armed
  // catches: guard removed / comparator flipped (`now < closesAt -> GONE`) - a closed auction
  //          would silently arm a bid that can never place.
  {
    const rq = mkStore();
    const created = await rq.createForLoad(mkStoreLoad('CAP-CLOSED'), { deadlineAt: Date.now() + 60_000 });
    await closeAuction(rq, created.id); // load.closesAt -> past
    await throwsGone(() => rq.capture(created.id, { cost: 47_500 }), 'capture past the real close is refused');
    const after = await rq.getByToken(created.id);
    assert.strictEqual(after.status, 'awaiting_price', 'refused capture left the request awaiting (no armed side effect)');
    assert.strictEqual(after.price, null, 'refused capture wrote no price');
    ok('capture past the real close -> GONE, request untouched');
  }

  // 3) re-price (setBidOverride) in the DANGER ZONE -> ACCEPTED, applies new cost + band
  // catches: mutant that also gates the armed re-price on deadlineAt - a last-second corrected
  //          rate would be rejected while the auction is still open and snipeable.
  {
    const rq = mkStore();
    const id = await armedReq(rq, 'SET-DANGER');
    await enterDangerZone(rq, id);
    const updated = await rq.setBidOverride(id, { marginsPct: NEW_BAND, minMarginPct: 6.3, cost: 41_000 }, { setBy: 'pricing' });
    assert.strictEqual(updated.price.cost, 41_000, 'danger-zone re-price applies the new cost');
    assert.deepStrictEqual(updated.marginsPct, NEW_BAND, 'danger-zone re-price applies the new band');
    ok('setBidOverride in the danger zone is ACCEPTED (new cost + band applied)');
  }

  // 4) re-price PAST THE REAL CLOSE -> refused (GONE), original cost/band intact
  // catches: guard removed on the armed re-price path - a closed auction would let a re-price
  //          rebuild a ladder the engine can never fire.
  {
    const rq = mkStore();
    const id = await armedReq(rq, 'SET-CLOSED');
    await closeAuction(rq, id);
    await throwsGone(() => rq.setBidOverride(id, { marginsPct: NEW_BAND, minMarginPct: 6.3, cost: 41_000 }, { setBy: 'pricing' }),
      'setBidOverride past the real close is refused');
    const after = await rq.getByToken(id);
    assert.strictEqual(after.price.cost, 45_000, 'refused re-price left the original captured cost');
    assert.deepStrictEqual(after.marginsPct, BAND, 'refused re-price left the original band');
    ok('setBidOverride past the real close -> GONE, override not applied');
  }

  // =============================================================================================
  // ROUTE-LEVEL: the receipt HTML the operator actually reads (real app, real render)
  // =============================================================================================
  const { app, requests, store } = require('../src/web/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postForm = (p, kv) => httpReq('POST', base + p, { body: new URLSearchParams(kv).toString(), contentType: 'application/x-www-form-urlencoded' });

  const now = Date.now();
  const mkRouteLoad = (id) => ({
    id, lane: { origin: 'Khopoli', destination: 'Keeranur' }, equipment: 'Trailer', units: 1,
    companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000, softClose: false, status: 'live',
  });

  // 5) COMFORTABLE capture receipt: plain "Cost saved", no danger caveat
  // catches: mutant that forces danger=true (drops the `now >= deadlineAt` guard) - the operator
  //          would see the alarming "may not land in time" caveat on a bid with ample runway.
  {
    const rA = await requests.createForLoad(mkRouteLoad('DZ-COMFY-CAP'), { deadlineAt: now + 60_000 }); // deadline 60s out
    const p = await postForm(`/price/${rA.id}`, { cost: '80000' });
    assert.strictEqual(p.status, 200, `comfortable capture -> 200 (got ${p.status}: ${p.text.slice(0, 200)})`);
    assert.ok(/Cost saved/.test(p.text), 'comfortable capture receipt heading is "Cost saved"');
    assert.ok(/Bidding will start automatically\./.test(p.text), 'comfortable capture receipt says bidding starts automatically');
    assert.ok(!/may not land in time/.test(p.text), 'comfortable capture receipt carries NO danger caveat');
    assert.ok(/Rs 80000/.test(p.text), 'comfortable capture receipt echoes the captured cost (not an empty stub)');
    const doc = await requests.getByToken(rA.id);
    assert.strictEqual(doc.status, 'armed', 'comfortable capture actually armed the request (side effect)');
    assert.strictEqual(doc.price.cost, 80000, 'comfortable capture persisted the exact cost');
    ok('receipt (comfortable capture): "Cost saved" + auto-start, no caveat, request armed');
  }

  // 6) DANGER-ZONE capture receipt: "Cost recorded - armed" + the honest caveat
  // catches: mutant that drops the deadline check OR flips `now < closesAt` -> danger would be
  //          false -> the operator gets the falsely reassuring "Bidding will start automatically".
  {
    const rB = await requests.createForLoad(mkRouteLoad('DZ-DANGER-CAP'), { deadlineAt: now + 60_000 });
    await store.patchDoc(COLLECTION, rB.id, { deadlineAt: Date.now() - 1_000 }); // deadline past, closesAt still 10min out
    const p = await postForm(`/price/${rB.id}`, { cost: '81000' });
    assert.strictEqual(p.status, 200, `danger-zone capture -> 200 (got ${p.status}: ${p.text.slice(0, 200)})`);
    assert.ok(/Cost recorded - armed/.test(p.text), 'danger-zone capture receipt heading is "Cost recorded - armed"');
    assert.ok(/may not land in time/.test(p.text), 'danger-zone capture receipt carries the "may not land in time" caveat (no automation wording)');
    assert.ok(!/Bidding will start automatically\./.test(p.text), 'danger-zone capture receipt does NOT promise auto-start');
    assert.ok(/Rs 81000/.test(p.text), 'danger-zone capture receipt echoes the captured cost');
    const doc = await requests.getByToken(rB.id);
    assert.strictEqual(doc.status, 'armed', 'danger-zone capture still arms best-effort (side effect)');
    assert.strictEqual(doc.price.cost, 81000, 'danger-zone capture persisted the exact cost');
    ok('receipt (danger-zone capture): "Cost recorded - armed" + caveat, still armed');
  }

  // 7) DANGER-ZONE re-price receipt: saved message carries "the new price may not land in time"
  // catches: mutant that drops the reprice dangerZone branch - a late re-price would read as the
  //          calm "bidding off the new cost" when the bot may in fact miss it.
  {
    const rC = await requests.createForLoad(mkRouteLoad('DZ-DANGER-REPRICE'), { deadlineAt: now + 60_000 });
    await postForm(`/price/${rC.id}`, { cost: '80000' }); // capture comfortably -> armed
    await store.patchDoc(COLLECTION, rC.id, { deadlineAt: Date.now() - 1_000 }); // now enter the danger zone
    // 5% sits below the default 6.3% minimum, so the desk confirms it.
    const p = await postForm(`/price/${rC.id}`, { cost: '72000', m_0: '15', m_1: '10', m_2: '5', below_min_ack: '1' });
    assert.strictEqual(p.status, 200, `danger-zone re-price -> 200 (got ${p.status}: ${p.text.slice(0, 200)})`);
    assert.ok(/the new price may not land in time/.test(p.text), 'danger-zone re-price saved message carries the new-price caveat');
    assert.ok(/id="cost"[^>]*value="72000"/.test(p.text), 'danger-zone re-price form reflects the NEW cost (re-price actually applied)');
    const doc = await requests.getByToken(rC.id);
    assert.strictEqual(doc.price.cost, 72000, 'danger-zone re-price persisted the new cost (side effect)');
    assert.strictEqual(doc.marginsPct[0], 15, 'danger-zone re-price persisted the new band');
    ok('receipt (danger-zone re-price): "the new price may not land in time", new cost/band applied');
  }

  // 8) COMFORTABLE re-price receipt: the plain saved message, no caveat
  // catches: mutant that forces the reprice dangerZone true - a comfortably-early re-price would
  //          wrongly warn about missing the bid.
  {
    const rD = await requests.createForLoad(mkRouteLoad('DZ-COMFY-REPRICE'), { deadlineAt: now + 60_000 });
    await postForm(`/price/${rD.id}`, { cost: '80000' }); // capture comfortably -> armed, deadline stays 60s out
    const p = await postForm(`/price/${rD.id}`, { cost: '70000', m_0: '15', m_1: '10', m_2: '5', below_min_ack: '1' });
    assert.strictEqual(p.status, 200, `comfortable re-price -> 200 (got ${p.status}: ${p.text.slice(0, 200)})`);
    assert.ok(/Saved - bidding off the new cost and margins now\./.test(p.text), 'comfortable re-price saved message is the plain confirmation');
    assert.ok(!/may not land in time/.test(p.text), 'comfortable re-price saved message carries NO danger caveat');
    assert.ok(/id="cost"[^>]*value="70000"/.test(p.text), 'comfortable re-price form reflects the NEW cost (re-price actually applied)');
    const doc = await requests.getByToken(rD.id);
    assert.strictEqual(doc.price.cost, 70000, 'comfortable re-price persisted the new cost (side effect)');
    ok('receipt (comfortable re-price): plain "Saved - bidding off the new cost and margins now.", no caveat');
  }

  server.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
