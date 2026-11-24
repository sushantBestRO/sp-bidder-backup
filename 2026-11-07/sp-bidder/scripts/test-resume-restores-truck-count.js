'use strict';
/**
 * A RESUME PUTS BACK THE TRUCK COUNT IT WAS BIDDING FOR, NOT JUST THE COST.
 *
 * Regression target: T3 D3 (R2-3).
 *
 * The re-price form moves the cost and the truck count in one submit. When that submit is held, a
 * resume restored the pre-correction cost and kept the correction's count, so the load went back to
 * bidding Rs 29,000 per truck for 2 of 5 trucks - a plan nobody entered. The count is the vcq the
 * adapter puts on the wire.
 *
 * Drives the real /price/:token and /price/:token/resume routes against the real store and engine.
 *
 *   node scripts/test-resume-restores-truck-count.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resume-trucks-'));

const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 8;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

const COST = 29_000;
const STANDING = 31_610;
const NEW_COST = 38_000;
const TRUCKS = 5;

const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};
const intentCount = (loadId) => {
  for (const s of stacks) {
    const it = s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId);
    if (it) return it.bidVehicleCount != null ? it.bidVehicleCount : null;
  }
  return undefined;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const post = (id, body) => req('POST', `${base}/price/${id}`, { body: JSON.stringify(body) });
  const resume = (id) => req('POST', `${base}/price/${id}/resume`, { body: '{}' });

  const heldLoad = async (loadId, armBody, correctionBody) => {
    const r = await requests.createForLoad({
      id: loadId, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: TRUCKS,
      quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
      softClose: false, closeModelKnown: true, status: 'live',
    });
    const armed = await post(r.id, Object.assign({ cost: COST }, armBody));
    if (armed.status !== 200) throw new Error(`setup: ${loadId} did not arm (HTTP ${armed.status})`);
    const m = liveMonitor(loadId);
    if (!m) throw new Error(`setup: no monitor for ${loadId}`);
    m.lastBidPrice = STANDING; m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId)) {
        s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: STANDING, everBid: true });
      }
    }
    const corrected = await post(r.id, Object.assign({ cost: NEW_COST, m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' }, correctionBody));
    if (corrected.status !== 200) throw new Error(`setup: ${loadId} correction refused (HTTP ${corrected.status})`);
    const doc = await requests.getByToken(r.id);
    if (!doc.hold || doc.hold.kind !== 'standing') throw new Error(`setup: ${loadId} is not held`);
    return { r, doc };
  };

  console.log('\n1. the desk lowered the count in the same correction that was held');
  {
    const { r, doc } = await heldLoad('TRK-1', { vehicle_count: TRUCKS }, { vehicle_count: 2 });
    if (doc.price.bidVehicleCount !== 2) throw new Error('setup: the correction did not move the count to 2');
    const res = await resume(r.id);
    ok(res.status === 200, `the resume lands (got ${res.status})`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === COST, `the cost goes back to Rs ${COST} (got ${after.price.cost})`);
    ok(after.price.bidVehicleCount === TRUCKS,
      `and so does the truck count: ${TRUCKS} of ${TRUCKS}, not the correction's 2 (got ${after.price.bidVehicleCount})`);
    ok(intentCount('TRK-1') === TRUCKS,
      `the re-armed intent bids for ${TRUCKS} trucks (got ${intentCount('TRK-1')})`);
    ok(!!liveMonitor('TRK-1'), 'with a live monitor behind it');
  }

  console.log('\n2. the load was on the full count by default, then the correction lowered it');
  {
    const { r, doc } = await heldLoad('TRK-2', {}, { vehicle_count: 2 });
    if (doc.price.bidVehicleCount !== 2) throw new Error('setup: the correction did not move the count to 2');
    const res = await resume(r.id);
    const after = await requests.getByToken(r.id);
    ok(res.status === 200 && after.price.bidVehicleCount == null,
      `the resume drops the correction's 2 and goes back to the default full count (got ${after.price.bidVehicleCount})`);
    ok(intentCount('TRK-2') !== 2, `the re-armed intent no longer bids for 2 (got ${intentCount('TRK-2')})`);
  }

  console.log('\n3. a correction that left the count alone resumes with it unchanged');
  {
    const { r } = await heldLoad('TRK-3', { vehicle_count: 3 }, {});
    await resume(r.id);
    const after = await requests.getByToken(r.id);
    ok(after.price.bidVehicleCount === 3, `3 of ${TRUCKS} before, 3 of ${TRUCKS} after (got ${after.price.bidVehicleCount})`);
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
