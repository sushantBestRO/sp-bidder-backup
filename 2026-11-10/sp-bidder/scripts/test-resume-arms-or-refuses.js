'use strict';
/**
 * A RESUME EITHER PUTS THE LOAD BACK ON THE LADDER, OR IT REFUSES OUT LOUD.
 *
 * There is no third outcome, and the third outcome is what shipped: resumeBidding never read
 * req.status while the route's re-arm was gated on it, so a held load the desk had STOPPED took the
 * write, spent its hold, armed nothing, answered "Bidding resumed.", told the load's own WhatsApp
 * group the same, and 409'd every retry after that. The load then sat out the rest of the auction
 * and the loss read as an ordinary loss - the exact class this project's price-page gate forbids.
 *
 * So this drives the real /price/:token/resume route, against the real store and the real engine,
 * and asserts the two halves that gate cannot be satisfied without:
 *   - a resume that reports success has a LIVE monitor behind it, in the engine, for that load;
 *   - a resume that cannot re-arm changes nothing, sends no resumed notice, and leaves the hold
 *     where it was so the desk can act on it.
 *
 *   node scripts/test-resume-arms-or-refuses.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resume-arms-'));

const http = require('http');
const { app, requests, stacks, store, notifier } = require('../src/web/server');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 30;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

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
const NEW_COST = 38_000;              // the correction: every rung of its band is above STANDING

// The monitor as the ENGINE holds it, which is the only thing that makes a load actually bid. A
// resume's whole claim is that this exists again afterwards.
const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};

// The desk notice is an outbound side effect with no store row behind it, so it is counted at the
// notifier rather than inferred from a log line.
let resumedNotices = 0;
const realHoldResumed = notifier.holdResumed.bind(notifier);
notifier.holdResumed = async (...args) => { resumedNotices += 1; return realHoldResumed(...args); };

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

  // Arm a load, put a bid on its board the way a landed bid really leaves things (monitor AND
  // durable intent - arm() rebuilds the successor's standing price from the intent), then correct
  // the cost upward so the engine holds it.
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
    const corrected = await priceForm(r.id, { cost: String(NEW_COST), m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    if (corrected.status !== 200) throw new Error(`setup failed to hold ${id}: HTTP ${corrected.status}`);
    const doc = await requests.getByToken(r.id);
    if (!doc.hold || doc.hold.kind !== 'standing') throw new Error(`setup failed: ${id} is not held`);
    return r;
  };

  console.log('\n1. a resume that reports success has a live monitor behind it');
  {
    const r = await heldLoad('RES-1');
    const before = resumedNotices;
    const res = await resume(r.id);
    ok(res.status === 200 && !!res.json && res.json.savedMsg === 'Bidding resumed.',
      `the resume is accepted and says so (got ${res.status})`);
    const m = liveMonitor('RES-1');
    ok(!!m, 'and the engine is holding a live monitor for the load - the sentence is true');
    ok(!!m && m.ladder.some((p) => p <= STANDING - 1),
      'whose ladder still has a rung the portal will take, so the load is bidding and not just armed on paper');
    ok(!!m && m.landedBids > 0, 'carrying the bid already on the board - a resume is not a fresh budget');
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === COST && !after.hold,
      'the pre-correction plan is back and the hold is spent - which is what makes the notice honest');
    ok(resumedNotices === before + 1, 'and the load group is told once');
  }

  console.log('\n2. a resume that cannot re-arm refuses, and spends nothing');
  {
    const r = await heldLoad('RES-2');
    const heldDoc = await requests.getByToken(r.id);
    // The real console Stop, then the hold written back: Stop now ends a hold (T3 D2), so a record
    // that is held AND stopped is one a stop wrote before that change, still on disk.
    const stopped = await req('POST', `${base}/api/auctions/RES-2/stop`, { body: '{}', origin: base });
    if (stopped.status !== 200) throw new Error(`setup failed to stop RES-2: HTTP ${stopped.status}`);
    await store.patchDoc('priceRequests', r.id, { hold: heldDoc.hold, holdHistory: heldDoc.holdHistory || null });
    const beforeDoc = await requests.getByToken(r.id);
    if (beforeDoc.status !== 'stopped' || !beforeDoc.hold) throw new Error('setup: RES-2 should be stopped and still held');
    const before = resumedNotices;

    const res = await resume(r.id);
    ok(res.status === 409, `the resume is REFUSED, not confirmed (got ${res.status})`);
    ok(!!res.json && !/resumed/i.test(res.json.error || '') && /re-arm/.test(res.json.error || ''),
      'in words that name the state and the way out, rather than reporting a resume that did not happen');
    ok(!res.json || res.json.savedMsg !== 'Bidding resumed.',
      'nothing on the response claims bidding resumed');
    ok(resumedNotices === before, 'and the load group is NOT told it is bidding again');

    const after = await requests.getByToken(r.id);
    ok(!!after.hold && after.hold.kind === 'standing' && after.hold.correctedCost === NEW_COST,
      'the hold is intact - it is not spent by a resume that armed nothing');
    ok(!after.holdHistory, 'so nothing was retired into the hold history either');
    ok(after.price.cost === NEW_COST, 'and the corrected cost stands: a refused resume restores nothing');
    ok(!liveMonitor('RES-2'), 'the load is still not bidding, which the desk was told rather than left to find out');

    // The refusal is not a dead end. Re-arm puts the load back on the ladder, and the resume the
    // desk came for then does what it says.
    const rearmed = await req('POST', `${base}/api/auctions/RES-2/rearm`, { body: '{}', origin: base });
    ok(rearmed.status === 200, `the console Re-arm still works on the refused load (got ${rearmed.status})`);
    const second = await resume(r.id);
    ok(second.status === 200 && !!second.json && second.json.savedMsg === 'Bidding resumed.',
      'and the resume then lands');
    const m = liveMonitor('RES-2');
    ok(!!m && m.ladder[m.ladder.length - 1] < NEW_COST,
      'with a live monitor on the restored plan, not the correction that was withdrawn');
    ok(!(await requests.getByToken(r.id)).hold, 'and the hold is spent only now, by the resume that armed');
  }

  console.log('\n3. a held load the close sweep has retired gets the closed page, not an instruction it cannot follow');
  {
    const r = await heldLoad('RES-3');
    const beforeDoc = await requests.getByToken(r.id);
    // Close the auction under the held load and let the poller's own sweep run, which is the part
    // a direct closesAt patch does not reproduce: finalizeClosed moves 'armed' -> 'closed' and
    // never touches the hold, so the row the desk taps Resume on is held AND no longer armed.
    await store.patchDoc('priceRequests', r.id,
      { load: Object.assign({}, beforeDoc.load, { closesAt: Date.now() - 1000, liveClosesAt: null }) });
    await requests.finalizeClosed();
    const swept = await requests.getByToken(r.id);
    if (swept.status !== 'closed' || !swept.hold) throw new Error(`setup: RES-3 should be swept to closed and still held (status=${swept.status}, hold=${!!swept.hold})`);
    const before = resumedNotices;

    const res = await resume(r.id);
    ok(res.status === 410, `the resume is refused as CLOSED, not as not-bidding (got ${res.status})`);
    ok(!!res.json && /closed on the portal/.test(res.json.error || '') && !/re-arm/.test(res.json.error || ''),
      'in the auction\'s own terms - never pointing at a re-arm the close guard would refuse anyway');
    const page = await req('POST', `${base}/price/${r.id}/resume`,
      { body: form({}), contentType: 'application/x-www-form-urlencoded' });
    ok(page.status === 410 && /This auction has closed/.test(page.text),
      `and the browser lands on the load's own held-closed page (got ${page.status})`);

    const after = await requests.getByToken(r.id);
    ok(!!after.hold && after.hold.correctedCost === NEW_COST && !after.holdHistory,
      'the hold record is untouched, so the page it renders from is still there');
    ok(after.price.cost === NEW_COST, 'and the corrected cost stands - a refused resume restores nothing');
    ok(resumedNotices === before, 'with no resumed notice for an auction nobody can bid any more');
  }

  console.log('\n4. a portal that cannot bid refuses BEFORE the write, not after it');
  {
    const r = await heldLoad('RES-4');
    if (!liveMonitor('RES-4')) throw new Error('setup: RES-4 should still be monitored while held');
    // The operator kill-switch as the arm path sees it: a fixed per-process capability off the
    // adapter (GC_BID off on the GoComet stack), not a per-call decision.
    const savedCaps = stacks.map((s) => (s.engine ? s.engine.caps : null));
    for (const s of stacks) if (s.engine) s.engine.caps = Object.assign({}, s.engine.caps, { biddingEnabled: false });
    const before = resumedNotices;
    try {
      const res = await resume(r.id);
      ok(res.status === 409, `the resume is refused, and as a portal state rather than a server fault (got ${res.status})`);
      ok(!!res.json && /not live for bidding/.test(res.json.error || '') && !/^resumed/.test(res.json.error || ''),
        'saying the portal will not bid it - not "resumed but" something the desk cannot act on');
      ok(resumedNotices === before, 'and the load group is NOT told it is bidding again');

      const after = await requests.getByToken(r.id);
      ok(!!after.hold && after.hold.kind === 'standing' && after.hold.correctedCost === NEW_COST && !after.holdHistory,
        'the hold is NOT spent by a resume that was never going to reach the ladder');
      ok(after.price.cost === NEW_COST,
        'and the corrected cost is NOT rolled back - the desk keeps the number it corrected to');
      ok(!!liveMonitor('RES-4'),
        'the monitor the load still had is left alone, because nothing stopped it to re-arm it');
    } finally {
      stacks.forEach((s, i) => { if (s.engine) s.engine.caps = savedCaps[i]; });
    }
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
