'use strict';
/**
 * A RESUME WHOSE RE-ARM THROWS LEAVES THE LOAD AS IT FOUND IT, AND SAYS SO.
 *
 * Regression target: T3 D1 (R2-1).
 *
 * resumeBidding commits the resume (hold retired into holdHistory, the pre-correction cost put back)
 * before the route re-arms, and the re-arm stops the live monitor before it arms the new one. When
 * the arm threw, nothing was put back: the record read armed and bidding, no monitor existed, the
 * hold was spent so a second tap answered 409 "this load is not on hold", and the price page showed
 * an ordinary bidding page for a load nothing was bidding.
 *
 * The two refusals the route can name are asked before the write; this drives the residual one, an
 * engine.arm() throw, through the real /price/:token/resume route.
 *
 *   node scripts/test-resume-rearm-throw-rolls-back.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resume-rollback-'));

const http = require('http');
const { app, requests, stacks, store, notifier } = require('../src/web/server');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 17;
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

const COST = 29_000;
const STANDING = 31_610;
const NEW_COST = 38_000;

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

// engine.arm() throws a plain Error on its next `times` calls, then behaves.
const breakArm = (times) => {
  let left = times;
  const saved = [];
  for (const s of stacks) {
    if (!s.engine || typeof s.engine.arm !== 'function') continue;
    const real = s.engine.arm;
    saved.push([s.engine, real]);
    s.engine.arm = function (...a) {
      if (left > 0) { left -= 1; throw new Error('arm refused: stale load rules snapshot'); }
      return real.apply(this, a);
    };
  }
  return () => { for (const [engine, fn] of saved) engine.arm = fn; };
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const priceForm = (id, body) => req('POST', `${base}/price/${id}`, { body: form(body), contentType: 'application/x-www-form-urlencoded' });
  const resume = (id) => req('POST', `${base}/price/${id}/resume`, { body: '{}' });

  const heldLoad = async (loadId) => {
    const now = Date.now();
    const r = await requests.createForLoad({
      id: loadId, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
      quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
      softClose: false, closeModelKnown: true, status: 'live',
    });
    if ((await priceForm(r.id, { cost: String(COST) })).status !== 200) throw new Error(`setup: ${loadId} did not arm`);
    const m = liveMonitor(loadId);
    if (!m) throw new Error(`setup: no monitor for ${loadId}`);
    m.lastBidPrice = STANDING; m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId)) {
        s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: STANDING, everBid: true });
      }
    }
    const corrected = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (corrected.status !== 200) throw new Error(`setup: ${loadId} correction refused (HTTP ${corrected.status})`);
    const doc = await requests.getByToken(r.id);
    if (!doc.hold || doc.hold.kind !== 'standing' || !doc.hold.resume) throw new Error(`setup: ${loadId} is not held`);
    const rec = await store.getDoc('closedBids', loadId);
    if (!rec || !rec.costCorrection) throw new Error(`setup: ${loadId} carries no live cost correction`);
    return r;
  };

  console.log('\n1. the re-arm throws once: the resume is refused and the load is put back as it was');
  {
    const r = await heldLoad('RRB-1');
    const noticesBefore = resumedNotices;
    const restore = breakArm(1);
    let res;
    try { res = await resume(r.id); } finally { restore(); }
    ok(res.status !== 200 && res.status < 500, `the desk gets a refusal, not a success and not a server fault (got ${res.status})`);
    ok(!!res.json && /not resumed/i.test(res.json.error || '') && /Rs 38,000/.test(res.json.error || ''),
      `saying it was not resumed and what the load is still on (got "${res.json && res.json.error}")`);
    const after = await requests.getByToken(r.id);
    ok(!!after.hold && after.hold.kind === 'standing' && after.hold.correctedCost === NEW_COST,
      'the hold is back, so the panel and its Resume button are too');
    ok(!after.holdHistory || after.holdHistory.length === 0, 'and no retired hold is left in the history for a resume that did not happen');
    ok(after.price.cost === NEW_COST && after.status === 'armed',
      `the plan is the held one again: armed at Rs ${NEW_COST} (got ${after.status}, ${after.price.cost})`);
    const m = liveMonitor('RRB-1');
    ok(!!m, 'the load has a live monitor again - the one the re-arm stopped is replaced');
    ok(!!m && m.ladder[m.ladder.length - 1] > STANDING,
      'on the held ladder, so the engine keeps holding rather than bidding the withdrawn plan');
    const rec = await store.getDoc('closedBids', 'RRB-1');
    ok(!!rec && !!rec.costCorrection && rec.costCorrection.to === NEW_COST,
      'the live cost correction still describes the cost on the plan');
    ok(resumedNotices === noticesBefore, 'the load group is not told bidding resumed');

    const page = await req('GET', `${base}/price/${r.id}`);
    ok(/id="holdPanel"/.test(page.text) && /id="askResume"/.test(page.text),
      'a reload of the price link shows the hold panel with Resume, not an ordinary bidding page');

    const second = await resume(r.id);
    const done = await requests.getByToken(r.id);
    ok(second.status === 200 && !!second.json && second.json.savedMsg === 'Bidding resumed.',
      `the same button works on the next tap (got ${second.status} ${(second.json && second.json.error) || ''})`);
    ok(done.price.cost === COST && !done.hold && !!liveMonitor('RRB-1'),
      'and that resume puts back the pre-correction cost with a live monitor');
    ok(resumedNotices === noticesBefore + 1, 'the load group is told once, for the resume that happened');
  }

  console.log('\n2. the re-arm throws and so does putting the monitor back: still refused, still resumable');
  {
    const r = await heldLoad('RRB-2');
    const noticesBefore = resumedNotices;
    const restore = breakArm(2);
    let res;
    try { res = await resume(r.id); } finally { restore(); }
    ok(res.status !== 200 && !!res.json && /not resumed/i.test(res.json.error || '') && /not bidding/i.test(res.json.error || ''),
      `the desk is told it was not resumed and is not bidding now (got ${res.status} "${res.json && res.json.error}")`);
    const after = await requests.getByToken(r.id);
    ok(!!after.hold && after.price.cost === NEW_COST && (!after.holdHistory || after.holdHistory.length === 0),
      'the record is put back to the held plan, so the Resume button is still there');
    ok(resumedNotices === noticesBefore, 'no resumed notice');
    const second = await resume(r.id);
    ok(second.status === 200 && !!liveMonitor('RRB-2') && (await requests.getByToken(r.id)).price.cost === COST,
      `once the arm works, Resume puts the load back on the ladder (got ${second.status})`);
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
