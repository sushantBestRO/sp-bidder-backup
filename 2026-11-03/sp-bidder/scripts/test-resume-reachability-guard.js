'use strict';
/**
 * H6 - POSITIVE PIN. src/pricing/priceRequests.js resumeBidding runs assertLadderReachable(plan,
 * standingBid) right before it writes the restored plan back (the last reachability refusal on
 * the resume path) - nothing in the suite pins it. If the standing bid has moved since the hold
 * was recorded (a further correction, a manual portal action) so that even the pre-correction
 * plan can no longer improve on it, resuming must still refuse rather than rebuild a monitor
 * around a price the portal will reject on arrival.
 *
 * This passes at base - it is a guard against regression, not a fix for a defect. Its teeth are
 * proven separately with two named mutants in a private clone (assert call removed; comparison
 * inverted/weakened), never by editing this file.
 *
 * CONTROL: the standing bid has not moved past the resume plan's floor - resume succeeds.
 * MECHANISM: the standing bid has moved below the resume plan's floor while held - resume is
 * refused with the reachability gate's own corrective message, not confirmed.
 *
 *   node scripts/test-resume-reachability-guard.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';    // no WhatsApp send in a unit test
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
// Pin the band so every number here is exact: cost 29,000 -> [31610, 30450, 29290].
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resume-reach-'));

const http = require('http');
const assert = require('assert');
const { app, requests, stacks } = require('../src/web/server');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const COST = 29_000;                  // pre-correction cost -> resume plan floor 29,290 (band 9/5/1)
const RESUME_FLOOR = 29_290;
const STANDING = 31_610;              // ladder[0] on the pinned band - what the load has on the portal
const NEW_COST = 38_000;              // correction: every rung of its band is above STANDING
const NEW_BAND = { m_0: '9', m_1: '7.2', m_2: '1.8' };

const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const mkLoad = (id) => ({
    id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live',
  });
  const priceForm = (id, body) => req('POST', `${base}/price/${id}`,
    { body: form(body), contentType: 'application/x-www-form-urlencoded' });
  const resume = (id) => req('POST', `${base}/price/${id}/resume`, { body: '{}' });

  const heldLoad = async (id) => {
    const r = await requests.createForLoad(mkLoad(id));
    const armed = await priceForm(r.id, { cost: String(COST) });
    if (armed.status !== 200) throw new Error(`setup failed to arm ${id}: HTTP ${armed.status}`);
    const m = liveMonitor(id);
    if (!m) throw new Error(`setup failed: no live monitor for ${id}`);
    m.lastBidPrice = STANDING;
    m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(id)) {
        s.engine.scheduler.update(id, { landedBids: 1, landedBidPrice: STANDING, everBid: true });
      }
    }
    const corrected = await priceForm(r.id, { cost: String(NEW_COST), ...NEW_BAND, use_override: '1' });
    if (corrected.status !== 200) throw new Error(`setup failed to hold ${id}: HTTP ${corrected.status}`);
    const doc = await requests.getByToken(r.id);
    if (!doc.hold || doc.hold.kind !== 'standing') throw new Error(`setup failed: ${id} is not held`);
    if (!doc.hold.resume || Number(doc.hold.resume.cost) !== COST) throw new Error(`setup failed: ${id} resume snapshot is wrong`);
    return r;
  };

  // ---- CONTROL: the standing bid has not moved past the resume plan's floor ----
  {
    const r = await heldLoad('REACH-CTL');
    const res = await resume(r.id);
    assert.strictEqual(res.status, 200, `CONTROL: a reachable resume succeeds (got ${res.status})`);
    assert.strictEqual(res.json && res.json.savedMsg, 'Bidding resumed.', 'CONTROL: resume reports success in the normal words');
    const m = liveMonitor('REACH-CTL');
    assert.ok(m && m.ladder.some((p) => p <= STANDING - 1), 'CONTROL: the restored plan has a rung that improves on the standing bid');
    ok('CONTROL: a resume whose pre-correction plan still improves on the standing bid succeeds');
  }

  // ---- MECHANISM: the standing bid has moved below the resume plan's floor while held ----
  {
    const r = await heldLoad('REACH-MECH');
    // The portal moved against us while the load sat held - the standing price is now BELOW the
    // pre-correction plan's own floor, so putting that plan back would not improve on it.
    const m = liveMonitor('REACH-MECH');
    m.lastBidPrice = RESUME_FLOOR - 90; // 29,200 - one tick under the resume plan's 29,290 floor
    const res = await resume(r.id);
    assert.strictEqual(res.status, 409, `MECHANISM: an unreachable resume is refused, not confirmed (got ${res.status})`);
    assert.ok(res.json && /does not improve on/.test(res.json.error || ''),
      'MECHANISM: refused with the reachability gate\'s own corrective message');
    assert.ok(!res.json || res.json.savedMsg !== 'Bidding resumed.', 'MECHANISM: nothing claims bidding resumed');
    const after = await requests.getByToken(r.id);
    assert.ok(after.hold && after.hold.kind === 'standing', 'MECHANISM: the hold is untouched - a refused resume spends nothing');
    ok('MECHANISM: a resume that can no longer improve on the (moved) standing bid is refused, not confirmed');
  }

  server.close();
  console.log(`\n${pass} passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
