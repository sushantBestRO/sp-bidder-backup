'use strict';
/**
 * T3 D12 - armedFloorFor's null exit (server.js: "nothing to ask" / "nothing to judge") fails
 * OPEN inside standingBidHeld, while its FLOOR_UNAVAILABLE twin (a floor that genuinely could
 * not be computed) fails CLOSED with the same hold shape. Both describe the identical fact from
 * the desk's point of view - a bid IS standing and we cannot tell whether the saved band beats
 * it - so both must refuse identically.
 *
 * With the null exit taken (forced here the way the bug-hunt verifier did: shadowing
 * engine.planPreview with a non-function, since deleting it is a no-op on a prototype method),
 * POST /price/:token on a correction whose whole ladder sits above the standing bid currently
 * answers 200 "Saved - bidding off the new cost and margins now.", writes no hold, and lets the
 * confirmation fire - on a load that will never bid again. No production input reaches this
 * exit today (every real stack carries planPreview); this pins the mechanism directly.
 *
 * CONTROL: a normal armed load, corrected to a cost whose ladder is still fully reachable
 * against the standing bid, still saves and confirms exactly as today - the fix must not touch
 * the ordinary re-price path.
 * MECHANISM: the SAME unreachable correction, with planPreview shadowed away, must be held with
 * the FLOOR_UNAVAILABLE twin's own reason ('floor_not_computable') - never silently confirmed.
 *
 *   node scripts/test-armed-floor-null-fails-closed.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-floor-null-'));

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

const COST = 29_000;
const STANDING = 31_610;              // ladder[0] on the pinned band - what the load has on the portal
const REACHABLE_COST = 28_000;        // corrected, still under STANDING at every rung: [30520,29400,28280]
const UNREACHABLE_COST = 38_000;      // corrected, every rung of its band is above STANDING
const UNREACHABLE_BAND = { m_0: '9', m_1: '7.2', m_2: '1.8' };

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
  const priceJson = (id, body) => req('POST', `${base}/price/${id}`, { body: JSON.stringify(body) });

  const armedWithStandingBid = async (id) => {
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
    return r;
  };

  // ---- CONTROL: a normal armed load, corrected to a still-reachable cost, saves as today ----
  {
    const r = await armedWithStandingBid('D12-CTL');
    const res = await priceJson(r.id, { cost: REACHABLE_COST, m_0: '9', m_1: '5', m_2: '1', use_override: '1' });
    assert.strictEqual(res.status, 200, `CONTROL: a reachable correction is accepted (got ${res.status})`);
    assert.strictEqual(res.json && res.json.savedMsg, 'Saved - bidding off the new cost and margins now.',
      'CONTROL: a reachable correction still confirms bidding in the normal words');
    assert.strictEqual(res.json && res.json.held, null, 'CONTROL: a reachable correction is not held');
    const after = await requests.getByToken(r.id);
    assert.ok(!after.hold, 'CONTROL: no hold record is written for a reachable correction');
    ok('CONTROL: a normal armed load with a reachable correction still saves and confirms unchanged');
  }

  // ---- MECHANISM: force armedFloorFor's null exit on an otherwise-unreachable correction ----
  {
    const r = await armedWithStandingBid('D12-MECH');
    // Shadow planPreview on every stack's engine - not delete: a class method lives on the
    // prototype, so `delete` is a no-op and the real method would still answer underneath it.
    const saved = stacks.map((s) => (s.engine ? s.engine.planPreview : undefined));
    for (const s of stacks) if (s.engine) s.engine.planPreview = null;
    try {
      const res = await priceJson(r.id, { cost: UNREACHABLE_COST, ...UNREACHABLE_BAND, use_override: '1' });
      assert.strictEqual(res.status, 200, `MECHANISM: the correction save itself still succeeds (got ${res.status})`);
      assert.notStrictEqual(res.json && res.json.savedMsg, 'Saved - bidding off the new cost and margins now.',
        'MECHANISM: an unreachable correction must NOT confirm bidding when the floor could not even be asked for');
      assert.ok(res.json && res.json.held, 'MECHANISM: the correction must be held, exactly like its FLOOR_UNAVAILABLE twin');
      assert.strictEqual(res.json.held.reason, 'floor_not_computable',
        'MECHANISM: held with the SAME reason/wording the genuinely-uncomputable twin uses');
      const after = await requests.getByToken(r.id);
      assert.ok(after.hold && after.hold.kind === 'standing' && after.hold.reason === 'floor_not_computable',
        'MECHANISM: the hold record is written, carrying the same reason');
      ok('a stack whose engine cannot even be asked for a floor now fails CLOSED, like its FLOOR_UNAVAILABLE twin');
    } finally {
      stacks.forEach((s, i) => { if (s.engine) s.engine.planPreview = saved[i]; });
    }
  }

  server.close();
  console.log(`\n${pass} passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
