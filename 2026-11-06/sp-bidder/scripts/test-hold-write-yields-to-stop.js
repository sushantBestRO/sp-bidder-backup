'use strict';
/**
 * A HOLD WRITTEN AFTER A STOP LEAVES THE LOAD HELD AND STOPPED (D-1 / H-1).
 *
 * A correction the portal cannot take is saved, re-armed, and then held: recordAndHold awaits the
 * cost-correction write on the close-time record and then writes the hold with a plain patch. A
 * console Stop landing in that turn ends bidding and marks the record stopped, and the hold is then
 * written on top of it. The desk is shown the hold panel, and its Resume answers 409 because the load
 * is stopped: the state R2-2 exists to end.
 *
 * What must happen instead: the hold is written only on a record that is still armed. When the Stop
 * won, the correction itself was already saved, so the desk is told "Saved, but this load was stopped
 * at the same moment, so it is not bidding." on every route that holds: the /price re-price, the
 * console margin route and the console margin clear.
 *
 * What must NOT move: with no Stop, the same correction is saved and held.
 *
 * Figures: default band [9, 5, 1], cost 29,000 arms [31610, 30450, 29290] with 31,610 standing. The
 * correction is cost 38,000 on [9, 7.2, 1.8], every price above 31,610.
 *
 *   node scripts/test-hold-write-yields-to-stop.js
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
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hold-yields-stop-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, bidLogger } = require('../src/web/server');

const COST = 29_000;
const STANDING = 31_610;
const NEW_COST = 38_000;
const NEW_BAND = { marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8 };
const SAVED_BUT_STOPPED = 'Saved, but this load was stopped at the same moment, so it is not bidding.';

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

const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const priceForm = (id, body) => req('POST', `${base}/price/${id}`, { body: form(body), contentType: 'application/x-www-form-urlencoded' });
  const priceJson = (id, body) => req('POST', `${base}/price/${id}`, { body: JSON.stringify(body) });
  const margin = (id, body) => req('POST', `${base}/api/price-requests/${id}/margin`, { body: JSON.stringify(body), origin: base });
  const clearMargin = (id) => req('POST', `${base}/api/price-requests/${id}/margin/clear`, { body: JSON.stringify({ confirm: true }), origin: base });
  const stop = (loadId) => req('POST', `${base}/api/auctions/${loadId}/stop`, { body: '{}', origin: base });

  const armedWithStandingBid = async (loadId, standing = STANDING) => {
    const r = await requests.createForLoad({ id: loadId, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
      quoteType: 'FTL', companyName: 'Hold Stop Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
      softClose: false, closeModelKnown: true, status: 'live' });
    const cap = await priceForm(r.id, { cost: String(COST) });
    if (cap.status !== 200) throw new Error(`setup: capture of ${loadId} answered ${cap.status}`);
    const m = liveMonitor(loadId);
    m.lastBidPrice = standing; m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(loadId)) s.engine.scheduler.update(loadId, { landedBids: 1, landedBidPrice: standing, everBid: true });
    }
    return r;
  };
  // The Stop lands while recordAndHold awaits the close-time correction write, after the re-arm check.
  const stopDuringCorrectionNote = async (loadId, send) => {
    let release; const gate = new Promise((res) => { release = res; });
    let reached; const atGate = new Promise((res) => { reached = res; });
    const orig = bidLogger.noteCostCorrection;
    bidLogger.noteCostCorrection = function (...a) { reached(); return gate.then(() => orig.apply(this, a)); };
    try {
      const pending = send();
      await atGate;
      const s = await stop(loadId);
      if (s.status !== 200) throw new Error(`setup: the stop answered ${s.status}`);
      release();
      return await pending;
    } finally { bidLogger.noteCostCorrection = orig; }
  };
  // The Stop lands just before the hold is written (the revert records no correction to wait on).
  const stopBeforeHoldWrite = async (loadId, send) => {
    const real = requests.holdBidding;
    let stopped = null;
    requests.holdBidding = async function (...a) { stopped = await stop(loadId); return real.apply(this, a); };
    try {
      const res = await send();
      if (!stopped || stopped.status !== 200) throw new Error(`setup: the stop did not land inside the save (${stopped && stopped.status})`);
      return res;
    } finally { requests.holdBidding = real; }
  };
  const recordLine = (d) => `status ${d.status}, hold ${JSON.stringify(d.hold && d.hold.kind)}, cost ${d.price && d.price.cost}`;

  console.log('\n1. the desk re-prices on /price and the correction holds; a console Stop lands before the hold is written');
  {
    const r = await armedWithStandingBid('HWS-PRICE');
    const res = await stopDuringCorrectionNote('HWS-PRICE', () => priceJson(r.id, Object.assign({ cost: NEW_COST },
      { m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' })));
    const d = await requests.getByToken(r.id);
    await check('the stopped record carries no hold', async () => {
      assert.deepStrictEqual([d.status, d.hold || null], ['stopped', null], recordLine(d));
    });
    await check(`the desk is told "${SAVED_BUT_STOPPED}" (409), not shown a hold panel`, async () => {
      assert.deepStrictEqual([res.status, res.json && res.json.error, !!(res.json && res.json.held)], [409, SAVED_BUT_STOPPED, false],
        `HTTP ${res.status} ${JSON.stringify(res.json && (res.json.error || res.json.held && 'held panel'))}`);
    });
    await check('the price page offers no Resume on the stopped load', async () => {
      const page = await req('GET', `${base}/price/${r.id}`);
      assert.ok(!/id="askResume"/.test(page.text), 'the page still renders the Resume button');
    });
    await check('the correction itself is saved (cost 38,000) and nothing is bidding', async () => {
      assert.deepStrictEqual([d.price && d.price.cost, !!liveMonitor('HWS-PRICE')], [NEW_COST, false], recordLine(d));
    });
  }

  console.log('\n2. the console margin route saves a cost that holds; a Stop lands before the hold is written');
  {
    const r = await armedWithStandingBid('HWS-MARGIN');
    const res = await stopDuringCorrectionNote('HWS-MARGIN', () => margin(r.id, Object.assign({ cost: NEW_COST, confirm: true }, NEW_BAND)));
    const d = await requests.getByToken(r.id);
    await check('the stopped record carries no hold', async () => {
      assert.deepStrictEqual([d.status, d.hold || null], ['stopped', null], recordLine(d));
    });
    await check(`the console is told "${SAVED_BUT_STOPPED}" (409)`, async () => {
      assert.deepStrictEqual([res.status, res.json && res.json.error], [409, SAVED_BUT_STOPPED], `HTTP ${res.status} ${res.text.slice(0, 160)}`);
    });
  }

  console.log('\n3. the console margin clear lands held; a Stop lands before the hold is written');
  {
    const r = await armedWithStandingBid('HWS-CLEAR', 29_200);
    const live = await margin(r.id, { marginsPct: [9, 5, 0.6], minMarginPct: 0.6, cost: COST, confirm: true, below_min_ack: '1' });
    if (live.status !== 200 || live.json.held) throw new Error(`setup: the override should leave the load biddable (got ${live.status})`);
    const res = await stopBeforeHoldWrite('HWS-CLEAR', () => clearMargin(r.id));
    const d = await requests.getByToken(r.id);
    await check('the stopped record carries no hold', async () => {
      assert.deepStrictEqual([d.status, d.hold || null], ['stopped', null], recordLine(d));
    });
    await check(`the console is told "${SAVED_BUT_STOPPED}" (409)`, async () => {
      assert.deepStrictEqual([res.status, res.json && res.json.error], [409, SAVED_BUT_STOPPED], `HTTP ${res.status} ${res.text.slice(0, 160)}`);
    });
  }

  console.log('\n4. control: with no Stop the same correction is saved and held');
  await check('the /price correction answers 200 with the hold panel and the record is armed and held', async () => {
    const r = await armedWithStandingBid('HWS-CONTROL');
    const res = await priceJson(r.id, { cost: NEW_COST, m_0: '9', m_1: '7.2', m_2: '1.8', use_override: '1' });
    const d = await requests.getByToken(r.id);
    assert.deepStrictEqual([res.status, !!(res.json && res.json.held), d.status, d.hold && d.hold.kind], [200, true, 'armed', 'standing'], recordLine(d));
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a Stop landing before the hold is written leaves the load held and stopped (recordAndHold writes the hold with a plain patch, not authorised by the armed status):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a hold is written only on a record still armed, and a Stop that wins is reported as saved but not bidding`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
