'use strict';
/**
 * A RESUME DOES NOT PUT A COST BACK ON A LIVE AUCTION THAT THE RE-PRICE ROUTE WOULD REFUSE.
 *
 * Regression target: T3 D6 (R2-10).
 *
 * The resume route re-armed off the cost stored in the hold record, and the only bound on that cost
 * was >= Rs 1. Every other writer of price.cost goes through the hard clerical floor. A hold record
 * written before the floor settings moved (or before the floor existed) could therefore put a figure
 * back onto a live auction one rupee under the floor the re-price route refuses on the same field.
 *
 * Production-default floor knobs (SP_MIN_COST_ABS / SP_MIN_COST_PER_KM unset): Rs 10,000 on this
 * 1,000 km load.
 *
 *   node scripts/test-resume-hard-cost-floor.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MARGINS_PCT = '25,18,12';
process.env.SP_MIN_MARGIN_PCT = '12';
delete process.env.SP_MIN_COST_ABS;
delete process.env.SP_MIN_COST_PER_KM;
delete process.env.SP_MIN_PLAUSIBLE_COST;
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resume-floor-'));

const http = require('http');
const { app, requests, stacks, store, notifier, hardCostFloorFor } = require('../src/web/server');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 11;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const COST = 60_000;
const STANDING = 58_000;
const NEW_COST = 64_000;
const LOAD = { lane: { origin: 'Bhiwandi', destination: 'Guwahati' }, equipment: 'SXL', units: 1,
  quoteType: 'FTL', companyName: 'Havells India Ltd', distanceKm: 1000, minDecrement: 1000,
  softClose: false, closeModelKnown: true, status: 'live' };

const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};

let resumedNotices = 0;
const realHoldResumed = notifier.holdResumed.bind(notifier);
notifier.holdResumed = async (...args) => { resumedNotices += 1; return realHoldResumed(...args); };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const floor = hardCostFloorFor(LOAD).floor;
  if (floor !== 10_000) throw new Error(`setup: expected the production-default floor Rs 10,000 on 1,000 km, got ${floor}`);

  // A held load whose resume snapshot carries `resumeCost` - the record as an earlier floor setting
  // would have left it on disk.
  const heldLoad = async (loadId, resumeCost) => {
    const now = Date.now();
    const r = await requests.createForLoad(Object.assign({}, LOAD, { id: loadId, closesAt: now + 40 * 60_000, startsAt: now - 60_000 }));
    const armed = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: String(COST) }), contentType: 'application/x-www-form-urlencoded' });
    if (armed.status !== 200) throw new Error(`setup: ${loadId} did not arm (HTTP ${armed.status})`);
    const m = liveMonitor(loadId);
    if (!m) throw new Error(`setup: no monitor for ${loadId}`);
    m.lastBidPrice = STANDING; m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId)) {
        s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: STANDING, everBid: true });
      }
    }
    const corrected = await req('POST', `${base}/price/${r.id}`,
      { body: JSON.stringify({ cost: NEW_COST, m_0: '25', m_1: '18', m_2: '12', use_override: '1' }) });
    if (corrected.status !== 200) throw new Error(`setup: ${loadId} correction refused (HTTP ${corrected.status})`);
    const doc = await requests.getByToken(r.id);
    if (!doc.hold || !doc.hold.resume) throw new Error(`setup: ${loadId} is not held with a resume snapshot`);
    await store.patchDoc('priceRequests', r.id,
      { hold: Object.assign({}, doc.hold, { resume: Object.assign({}, doc.hold.resume, { cost: resumeCost }) }) });
    return r;
  };

  console.log('\n1. a resume cost one rupee under the floor is refused, and nothing moves');
  {
    const r = await heldLoad('RSF-1', floor - 1);
    const monitorBefore = liveMonitor('RSF-1');
    const refusalsBefore = (await store.readEvents('costFloorRefused')).length;
    const noticesBefore = resumedNotices;
    const res = await req('POST', `${base}/price/${r.id}/resume`, { body: '{}' });
    ok(res.status === 400, `the resume is refused as a bad cost (got ${res.status})`);
    ok(!!res.json && /Rs 9,999/.test(res.json.error || '') && /not resumed/i.test(res.json.error || ''),
      `in words that name the figure and say the load was not resumed (got "${res.json && res.json.error}")`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === NEW_COST, `the Rs 9,999 never reaches price.cost (got ${after.price.cost})`);
    ok(!!after.hold && after.hold.kind === 'standing' && !after.holdHistory,
      'the hold is not spent, so the desk still has the panel and can re-price from it');
    ok(liveMonitor('RSF-1') === monitorBefore, 'the monitor the load had is left alone - nothing was stopped or rebuilt');
    ok(resumedNotices === noticesBefore, 'the load group is not told bidding resumed');
    const evs = await store.readEvents('costFloorRefused');
    ok(evs.length === refusalsBefore + 1 && evs[evs.length - 1].source === 'resume' && evs[evs.length - 1].entered === floor - 1,
      'and the refusal is recorded like every other floor refusal, tagged with the resume seam');
  }

  console.log('\n2. the browser gets a page that says so, not a bidding page');
  {
    const r = await heldLoad('RSF-2', floor - 1);
    const page = await req('POST', `${base}/price/${r.id}/resume`, { body: form({}), contentType: 'application/x-www-form-urlencoded' });
    ok(page.status === 400 && /Rs 9,999/.test(page.text) && !/Bidding resumed/.test(page.text),
      `HTML resume answers 400 with the figure and no "Bidding resumed." (got ${page.status})`);
    ok((await requests.getByToken(r.id)).price.cost === NEW_COST, 'and the cost is untouched');
  }

  console.log('\n3. the floor figure itself still resumes');
  {
    const r = await heldLoad('RSF-3', floor);
    const res = await req('POST', `${base}/price/${r.id}/resume`, { body: '{}' });
    const after = await requests.getByToken(r.id);
    ok(res.status === 200 && after.price.cost === floor && !after.hold,
      `a resume at exactly Rs 10,000 lands (got ${res.status}, cost ${after.price.cost})`);
    ok(!!liveMonitor('RSF-3'), 'with a live monitor behind it');
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
