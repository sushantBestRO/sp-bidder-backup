'use strict';
/**
 * TWO GUARDS THE RESUME ROUTE MUST KEEP WHERE THE PER-TYPE FLOOR, THE HOLD ROLLBACK AND THE STOP RACE MEET.
 *
 * 1. The clerical floor binds each truck type's rate (R2-A), and the resume route judges the stored
 *    cost before it writes it back (R2-10). A per-type load's resume snapshot carries the per-type
 *    rates, so judging only the blend lets one rate under the floor go back onto a live auction:
 *    [45,000 x 10, 4,999 x 1] blends to Rs 41,364, well above a Rs 5,000 floor.
 * 2. A resume whose re-arm throws is rolled back (R2-1), and a Stop ends a hold (R2-2). If the Stop
 *    lands after the resume's write and before the rollback's, the rollback must not write the hold
 *    back onto the stopped record: that is a load held AND stopped, the state R2-2 removed, and the
 *    desk would be told it is "still on hold". Nor may the failed resume's own figures stay behind:
 *    the stopped record keeps the corrected plan, so a later Re-arm never bids the withdrawn cost.
 * 3. The mirror race: the rollback lands, then the Stop, then the monitor is put back. The desk is
 *    told the load was stopped, not that it is still on hold.
 *
 *   node scripts/test-resume-integration-guards.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '5000';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resume-guards-'));

const http = require('http');
const { app, requests, stacks, store } = require('../src/web/server');

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

const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};
const setStanding = (loadId, price) => {
  const m = liveMonitor(loadId);
  if (!m) throw new Error(`setup: no monitor for ${loadId}`);
  m.lastBidPrice = price; m.landedBids = 1;
  for (const s of stacks) {
    if (s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId)) {
      s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: price, everBid: true });
    }
  }
};

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

const now = Date.now();
const TWO_TYPES = {
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, quoteType: 'FTL', companyName: 'Havells',
  softClose: false, closeModelKnown: true, status: 'live',
  units: 11, cargoLines: 2, equipment: '10 x 32 ft MXL, 18 T + 1 x 20 ft ODC, 10 T',
  cargoTypes: [
    { label: '32 ft MXL, 18 T', count: 10, match: '32ftmxl18t' },
    { label: '20 ft ODC, 10 T', count: 1, match: '20ftodc10t' },
  ],
};
const blendOf = (a, b) => Math.round((a * 10 + b) / 11);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const priceForm = (id, body) => req('POST', `${base}/price/${id}`, { body: form(body), contentType: 'application/x-www-form-urlencoded' });
  const resume = (id) => req('POST', `${base}/price/${id}/resume`, { body: '{}' });

  // A per-type load captured at [45,000, 41,000], bid at its opening, then corrected up to
  // [52,000, 48,000] with a plan that no longer improves on that bid, so the correction holds.
  const heldTwoType = async (loadId) => {
    const r = await requests.createForLoad(Object.assign({ id: loadId, closesAt: now + 40 * 60_000, startsAt: now - 60_000 }, TWO_TYPES));
    const cap = await priceForm(r.id, { cost: String(blendOf(45000, 41000)), cost_type_0: '45000', cost_type_1: '41000' });
    if (cap.status !== 200) throw new Error(`setup: ${loadId} did not arm (HTTP ${cap.status})`);
    const armed = await requests.getByToken(r.id);
    setStanding(loadId, armed.ladder ? armed.ladder[0] : liveMonitor(loadId).ladder[0]);
    const corrected = await priceForm(r.id, { cost: String(blendOf(52000, 48000)), cost_type_0: '52000', cost_type_1: '48000',
      m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (corrected.status !== 200) throw new Error(`setup: ${loadId} correction refused (HTTP ${corrected.status}: ${corrected.text.slice(0, 160)})`);
    const doc = await requests.getByToken(r.id);
    if (!doc.hold || doc.hold.kind !== 'standing' || !doc.hold.resume) throw new Error(`setup: ${loadId} is not held`);
    const snap = doc.hold.resume.costByType;
    if (!snap || !Array.isArray(snap.types) || snap.types.length !== 2) throw new Error(`setup: ${loadId} resume snapshot carries no per-type rates`);
    return { r, doc };
  };

  console.log('\n1. a per-type resume snapshot with one rate under the floor is refused, though its blend is not');
  {
    const { r, doc } = await heldTwoType('RIG-1');
    const types = doc.hold.resume.costByType.types.map((t, i) => (i === 1 ? Object.assign({}, t, { cost: 4999 }) : t));
    const blend = blendOf(45000, 4999);
    await store.patchDoc('priceRequests', r.id, { hold: Object.assign({}, doc.hold, { resume: Object.assign({}, doc.hold.resume,
      { cost: blend, costByType: Object.assign({}, doc.hold.resume.costByType, { cost: blend, types }) }) }) });
    const before = await requests.getByToken(r.id);
    const res = await resume(r.id);
    ok(res.status === 400, `the resume is refused (got ${res.status}), though the blend Rs ${blend} clears the Rs 5,000 floor`);
    ok(!!res.json && /not resumed/i.test(res.json.error || '') && /4,999/.test(res.json.error || '') && /20 ft ODC/.test(res.json.error || ''),
      `in words that name the truck type and its rate (got "${res.json && res.json.error}")`);
    const after = await requests.getByToken(r.id);
    ok(JSON.stringify(after.price.costByType) === JSON.stringify(before.price.costByType) && !!after.hold,
      'the held per-type rates stay on the plan and the hold is not spent');
  }

  console.log('\n2. control: the untouched per-type snapshot resumes');
  {
    const { r } = await heldTwoType('RIG-2');
    const res = await resume(r.id);
    const after = await requests.getByToken(r.id);
    ok(res.status === 200 && !after.hold && after.price.costByType.types.map((t) => t.cost).join() === '45000,41000',
      `both rates above the floor: resumed onto [45000, 41000] (got ${res.status} ${(res.json && res.json.error) || ''})`);
  }

  // Armed at Rs 29,000, bid at its opening, then corrected up to Rs 38,000 with a plan that no longer
  // improves on that bid, so the correction holds.
  const heldSingle = async (loadId) => {
    const r = await requests.createForLoad({
      id: loadId, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
      quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
      softClose: false, closeModelKnown: true, status: 'live',
    });
    if ((await priceForm(r.id, { cost: '29000' })).status !== 200) throw new Error(`setup: ${loadId} did not arm`);
    setStanding(loadId, 31_610);
    const corrected = await priceForm(r.id, { cost: '38000', m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (corrected.status !== 200) throw new Error(`setup: ${loadId} correction refused (HTTP ${corrected.status})`);
    if (!(await requests.getByToken(r.id)).hold) throw new Error(`setup: ${loadId} is not held`);
    return r;
  };

  console.log('\n3. a Stop that lands between a failed resume and its rollback wins');
  {
    const r = await heldSingle('RIG-3');

    const realUndo = requests.undoResume;
    requests.undoResume = async function (token, prior) {
      await requests.stop(token);
      return realUndo.call(this, token, prior);
    };
    const restoreArm = breakArm(1);
    let res;
    try { res = await resume(r.id); } finally { restoreArm(); requests.undoResume = realUndo; }
    const after = await requests.getByToken(r.id);
    ok(res.status === 409, `the desk gets the lost-race refusal, not a server fault (got ${res.status})`);
    ok(!!res.json && /stopped/i.test(res.json.error || '') && !/on hold/i.test(res.json.error || ''),
      `saying the load was stopped, not that it is still on hold (got "${res.json && res.json.error}")`);
    ok(after.status === 'stopped', `the Stop stands (got ${after.status})`);
    ok(!after.hold, 'and the rollback did not write the hold back onto the stopped record');
    ok(!liveMonitor('RIG-3'), 'nothing is bidding the stopped load');
    ok(after.price.cost === 38_000 && JSON.stringify(after.marginsPct) === '[9,7.2,1.8]',
      `the failed resume leaves nothing behind: the stopped record keeps the corrected plan (got Rs ${after.price.cost}, [${after.marginsPct}])`);
    const last = (after.holdHistory || []).slice(-1)[0];
    ok(!!last && last.resolvedReason === 'superseded_by_operator_stop',
      `and the hold is recorded as ended by the stop, not spent by a resume that did not happen (got ${last && last.resolvedReason})`);
    ok(!!res.json && /not resumed/i.test(res.json.error || ''), `the desk reads that it was not resumed (got "${res.json && res.json.error}")`);
  }

  console.log('\n4. a Stop that lands after the rollback and before the monitor is back');
  {
    const r = await heldSingle('RIG-4');
    const realUndo = requests.undoResume;
    requests.undoResume = async function (token, prior) {
      const out = await realUndo.call(this, token, prior);
      await requests.stop(token);
      return out;
    };
    const restoreArm = breakArm(1);
    let res;
    try { res = await resume(r.id); } finally { restoreArm(); requests.undoResume = realUndo; }
    const after = await requests.getByToken(r.id);
    ok(res.status === 409, `the desk gets the lost-race refusal, not a server fault (got ${res.status})`);
    ok(!!res.json && /not resumed/i.test(res.json.error || '') && /stopped/i.test(res.json.error || '') && !/on hold/i.test(res.json.error || ''),
      `saying it was not resumed and the load was stopped, not that it is still on hold (got "${res.json && res.json.error}")`);
    ok(after.status === 'stopped' && !after.hold, `the Stop stands and ended the hold (got ${after.status}, hold ${JSON.stringify(after.hold && after.hold.kind)})`);
    ok(after.price.cost === 38_000, `on the corrected plan (got Rs ${after.price.cost})`);
    ok(!liveMonitor('RIG-4'), 'nothing is bidding the stopped load');
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
