'use strict';
/**
 * T3 D11 - recordAndHold's resume fallback fires on the WRONG condition.
 *
 * src/web/server.js recordAndHold:
 *   const resume = (priorDoc && priorDoc.hold && priorDoc.hold.resume) || resumePlanFrom(priorDoc);
 *
 * The comment above it states the intent: "an existing resume target always wins over this
 * write's own" - i.e. the fallback to resumePlanFrom (which derives a plan from THIS write's own
 * prior cost) should fire only when the prior doc has NO HOLD AT ALL. As written it also fires
 * whenever the prior hold simply carries no `resume` field, and in that case it derives the new
 * hold's resume target from the FIRST correction's cost - a cost that was itself unreachable
 * (that is why it went on hold), so a second correction hands the desk a resume button that
 * POST /resume then refuses.
 *
 * A hold with no `resume` field has no natural production trigger today (every hold-writing path
 * snapshots one), so this pin creates it directly on the store - the same "hand-edit of
 * data/priceRequests.json" the disposition names as the one reachable trigger.
 *
 * CONTROL: the first-hold path is unchanged - one correction on a never-held load still derives
 * its resume target from the pre-correction cost, and POST /resume on it still succeeds.
 * MECHANISM: a second correction on a hold with no resume snapshot must NOT derive a resume
 * target from the first correction's cost - and POST /resume must refuse with the plain
 * "cost ... not on record" message (400), never offer a target that itself then refuses (409).
 *
 *   node scripts/test-second-hold-resume-target.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-second-hold-resume-'));

const http = require('http');
const assert = require('assert');
const { app, requests, stacks, store } = require('../src/web/server');

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
const NEW_COST = 38_000;              // first correction: every rung of its band is above STANDING
const NEW_BAND = { marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8 };
const NEW_COST_2 = 42_000;            // second correction, still above STANDING under the same band

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
  const margin = (id, body) => req('POST', `${base}/api/price-requests/${id}/margin`, { body: JSON.stringify(body), origin: base });
  const resume = (id) => req('POST', `${base}/price/${id}/resume`, { body: '{}' });

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

  // ---- CONTROL: the first-hold path is unchanged ----
  {
    const r = await armedWithStandingBid('D11-CTL');
    const res = await margin(r.id, { ...NEW_BAND, cost: NEW_COST, confirm: true });
    assert.strictEqual(res.status, 200, `CONTROL: the first correction is held, not refused (got ${res.status})`);
    assert.strictEqual(res.json.held.resumeCost, COST,
      'CONTROL: a never-before-held load still derives its resume target from the pre-correction cost');
    ok('CONTROL: the first hold on a load still snapshots the pre-correction plan as its resume target');

    const back = await resume(r.id);
    assert.strictEqual(back.status, 200, `CONTROL: resuming the first hold still succeeds (got ${back.status})`);
    assert.strictEqual(back.json.savedMsg, 'Bidding resumed.', 'CONTROL: resume reports success in the normal words');
    ok('CONTROL: resuming a first (and only) hold still lands the pre-correction plan');
  }

  // ---- MECHANISM: a second correction on a hold with no resume snapshot ----
  {
    const r = await armedWithStandingBid('D11-MECH');
    const first = await margin(r.id, { ...NEW_BAND, cost: NEW_COST, confirm: true });
    assert.strictEqual(first.status, 200, `setup: the first correction should hold (got ${first.status})`);
    assert.strictEqual(first.json.held.resumeCost, COST, 'setup: the first hold snapshots the pre-correction cost, as CONTROL proved');

    // Simulate the one reachable trigger the disposition names: a hold record with no `resume`
    // field, which no writer on this codepath produces today. patchDoc merges shallowly at the
    // top level, so replacing `hold` wholesale is how the fixture strips just that field.
    const beforeSecond = await requests.getByToken(r.id);
    const strippedHold = Object.assign({}, beforeSecond.hold);
    delete strippedHold.resume;
    await store.patchDoc('priceRequests', r.id, { hold: strippedHold });
    const primed = await requests.getByToken(r.id);
    assert.ok(primed.hold && !primed.hold.resume, 'setup: the hold now carries no resume snapshot');

    const second = await margin(r.id, { ...NEW_BAND, cost: NEW_COST_2, confirm: true });
    assert.strictEqual(second.status, 200, `the second correction is held, not refused (got ${second.status})`);
    assert.notStrictEqual(second.json.held.resumeCost, NEW_COST,
      'MECHANISM: the second hold must not offer the FIRST correction\'s unreachable cost as a resume target');
    assert.strictEqual(second.json.held.resumeCost, null,
      'MECHANISM: with no resume snapshot to carry forward, the second hold offers no resume target at all');
    ok('a second correction on a resume-less hold does not derive a resume target from the first correction\'s cost');

    const attempt = await resume(r.id);
    assert.strictEqual(attempt.status, 400,
      `MECHANISM: resume is refused as a plain missing-record error (got ${attempt.status})`);
    assert.ok(attempt.json && /not on record/.test(attempt.json.error || ''),
      'MECHANISM: the refusal states plainly that the pre-correction cost is not on record');
    assert.ok(!attempt.json || !/^resumed/i.test(attempt.json.error || ''),
      'MECHANISM: the refusal never claims a resume that did not happen');
    ok('resuming a hold with no resume snapshot refuses cleanly instead of offering a target that then refuses');

    const after = await requests.getByToken(r.id);
    assert.ok(after.hold && after.hold.kind === 'standing' && after.price.cost === NEW_COST_2,
      'the hold and the corrected cost both survive the refused resume attempt untouched');
    ok('the refused resume leaves the hold and the corrected cost exactly where they were');
  }

  server.close();
  console.log(`\n${pass} passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
