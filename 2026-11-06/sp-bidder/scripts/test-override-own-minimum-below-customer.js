'use strict';
/**
 * AN OVERRIDE WHOSE OWN MINIMUM IS BELOW THE CUSTOMER MINIMUM IS ACCEPTED SILENTLY
 * (R31b-override-own-minimum).
 *
 * The below-customer-minimum gate compares only the override's LOWEST MARGIN with the customer
 * minimum (PriceRequestStore.belowCustomerMinimum, reached from the /price capture, the re-price and
 * setBidOverride). But an override's own minMarginPct is its guard, and a shipper ceiling between that
 * guard and the lowest band price is bid AT the ceiling. So a JSON marginOverride
 * { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 1 } - every margin above a customer minimum of 5, its
 * own minimum 1 - needs no acknowledgement and leaves no record, and on a load capped at 102,000 it
 * arms one bid at 102,000: 2% over cost under a 5% customer minimum, never confirmed.
 *
 * What must happen instead: "below the customer minimum" is judged on the override's own minimum
 * (every margin is already at or above it; on the form path it is the lowest row), and that figure is
 * the marginPct in the 409 body and in marginOverride.belowMinimum.
 *
 * What must NOT move (green before and after the fix):
 *   - an override whose own minimum is at or above the customer minimum (5, 6) needs no ack and
 *     records nothing;
 *   - the form capture of rows [10, 7, 3] is refused without the ack and records marginPct 3 with it;
 *   - an override with a margin below its own minimum is refused 400 with or without the ack;
 *   - the acknowledged override on the capped load still gets its one bid at the ceiling, never below
 *     its own guard.
 *
 * Figures: default band [12.6, 7.2, 6.3] min 5, so the customer minimum is 5. Cost 100,000.
 * Override min 1: guard = round(100000 x 1.01) = 101,000; band prices [112600, 107200, 106300].
 * Ceiling 102,000 sits between the guard and 106,300, so the plan is one bid at 102,000.
 *
 *   node scripts/test-override-own-minimum-below-customer.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12.6,7.2,6.3';
process.env.SP_MIN_MARGIN_PCT = '5';

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-own-min-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

const COST = '100000';
const CUSTOMER_MIN = 5;
const BAND = [12.6, 7.2, 6.3];
const OWN_MIN = 1;
const LOW_OVERRIDE = { marginsPct: BAND, minMarginPct: OWN_MIN };
const CEILING = 102000;
const OWN_GUARD = 101000; // round(100000 x 1.01)

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });

const now = Date.now();
const mkLoad = (id, ceilingPrice = null) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'Own Minimum Test Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice, pricingMode: 'flat' },
});
const armedMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m) return m;
  }
  return null;
};
const tick = () => new Promise((r) => setImmediate(r));

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

function assertUntouched(doc, loadId) {
  assert.strictEqual(doc.status, 'awaiting_price', `status is ${doc.status}`);
  assert.ok(!doc.price || doc.price.cost == null, `a price was recorded: ${JSON.stringify(doc.price)}`);
  const m = armedMonitor(loadId);
  assert.strictEqual(m, null, `a monitor was armed with ladder ${m && JSON.stringify(m.ladder)}`);
}
function assertRefused(res, marginPct, loadId) {
  const m = armedMonitor(loadId);
  assert.ok(res.status === 409, `expected 409 BELOW_MINIMUM, got ${res.status}${m ? ` and armed ${JSON.stringify(m.ladder)}` : ''}`);
  assert.ok(res.json, 'no JSON body');
  assert.strictEqual(res.json.code, 'BELOW_MINIMUM');
  assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0, 'no error message');
  assert.deepStrictEqual(res.json.belowMinimum, { marginPct, customerMinPct: CUSTOMER_MIN });
}
function assertRecord(doc, marginPct, t0) {
  const b = doc.marginOverride && doc.marginOverride.belowMinimum;
  assert.ok(b, `marginOverride carries no belowMinimum record: ${JSON.stringify(doc.marginOverride)}`);
  assert.deepStrictEqual({ marginPct: b.marginPct, customerMinPct: b.customerMinPct, setBy: b.setBy },
    { marginPct, customerMinPct: CUSTOMER_MIN, setBy: 'pricing' });
  assert.ok(Number.isFinite(b.setAt) && b.setAt >= t0 && b.setAt <= Date.now(), `setAt ${b.setAt} is not the save time in ms`);
}
function assertNoRecord(doc) {
  assert.ok(!(doc.marginOverride && doc.marginOverride.belowMinimum), `recorded ${JSON.stringify(doc.marginOverride)}`);
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (r, opts) => req('POST', `${base}/price/${r.id}`, opts);
  const captureOverride = async (id, override, { ack = false, ceiling = null } = {}) => {
    const r = await requests.createForLoad(mkLoad(id, ceiling));
    const body = { cost: COST, marginOverride: override };
    if (ack) body.below_min_ack = '1';
    const res = await post(r, json(body));
    await tick();
    return { r, res };
  };

  console.log('\n0. the customer minimum these checks are judged against');
  await check('a load with no customer record inherits the default band [12.6, 7.2, 6.3] min 5', async () => {
    const r = await requests.createForLoad(mkLoad('OM-PRE'));
    assert.deepStrictEqual([r.marginsPct, r.minMarginPct], [BAND, CUSTOMER_MIN]);
  });

  console.log('\n1. override { [12.6, 7.2, 6.3], min 1 } on an uncapped load');
  const noAck = await captureOverride('OM-NOACK', LOW_OVERRIDE);
  await check('without below_min_ack it is refused 409 BELOW_MINIMUM { marginPct: 1, customerMinPct: 5 }', async () => {
    assertRefused(noAck.res, OWN_MIN, 'OM-NOACK');
  });
  await check('the refused capture leaves the request awaiting_price, unpriced and unarmed', async () => {
    assertUntouched(await requests.getByToken(noAck.r.id), 'OM-NOACK');
  });
  const t0 = Date.now();
  const acked = await captureOverride('OM-ACK', LOW_OVERRIDE, { ack: true });
  await check('with below_min_ack it is accepted and armed', async () => {
    assert.ok(acked.res.status < 400, `status ${acked.res.status}: ${acked.res.text.slice(0, 160)}`);
    assert.strictEqual((await requests.getByToken(acked.r.id)).status, 'armed');
    assert.ok(armedMonitor('OM-ACK'), 'no monitor armed');
  });
  await check('with below_min_ack it records marginOverride.belowMinimum { 1, 5, pricing, setAt }', async () => {
    assertRecord(await requests.getByToken(acked.r.id), OWN_MIN, t0);
  });

  console.log('\n2. the same override on a load capped at 102,000 (between its 101,000 guard and 106,300)');
  const capNoAck = await captureOverride('OM-CAP-NOACK', LOW_OVERRIDE, { ceiling: CEILING });
  await check('without below_min_ack the capped capture is refused 409 BELOW_MINIMUM { 1, 5 }, not armed at the ceiling', async () => {
    assertRefused(capNoAck.res, OWN_MIN, 'OM-CAP-NOACK');
    assertUntouched(await requests.getByToken(capNoAck.r.id), 'OM-CAP-NOACK');
  });
  const capAck = await captureOverride('OM-CAP-ACK', LOW_OVERRIDE, { ack: true, ceiling: CEILING });
  await check('with below_min_ack the capped load arms exactly [102000], never below 101000', async () => {
    assert.ok(capAck.res.status < 400, `status ${capAck.res.status}: ${capAck.res.text.slice(0, 160)}`);
    const m = armedMonitor('OM-CAP-ACK');
    assert.ok(m, 'no monitor armed');
    assert.deepStrictEqual(m.ladder, [CEILING]);
    assert.ok(m.ladder.every((p) => p >= OWN_GUARD), `a rung sits below ${OWN_GUARD}: ${m.ladder}`);
  });

  console.log('\n3. the store records it for any caller');
  await check('setBidOverride on an awaiting request with { [12.6, 7.2, 6.3], min 1 } records belowMinimum { 1, 5 }', async () => {
    const r = await requests.createForLoad(mkLoad('OM-STORE'));
    await requests.setBidOverride(r.id, { marginsPct: BAND, minMarginPct: OWN_MIN }, { setBy: 'pricing' });
    const doc = await requests.getByToken(r.id);
    const b = doc.marginOverride && doc.marginOverride.belowMinimum;
    assert.ok(b, `marginOverride carries no belowMinimum record: ${JSON.stringify(doc.marginOverride)}`);
    assert.deepStrictEqual({ marginPct: b.marginPct, customerMinPct: b.customerMinPct }, { marginPct: OWN_MIN, customerMinPct: CUSTOMER_MIN });
  });

  console.log('\n4. controls: behaviour that must not move');
  // min 5 == customer minimum (below is strict); min 6 above it.
  for (const min of [5, 6]) {
    await check(`override { [12.6, 7.2, 6.3], min ${min} } without an ack is armed and records nothing`, async () => {
      const id = `OM-MIN-${min}`;
      const { r, res } = await captureOverride(id, { marginsPct: BAND, minMarginPct: min });
      assert.ok(res.status < 400, `status ${res.status}: ${res.text.slice(0, 160)}`);
      const doc = await requests.getByToken(r.id);
      assert.strictEqual(doc.status, 'armed');
      assert.ok(armedMonitor(id), 'no monitor armed');
      assertNoRecord(doc);
    });
  }
  const ROWS = { m_0: '10', m_1: '7', m_2: '3' };
  await check('form capture of rows [10, 7, 3] without the ack is refused 409 BELOW_MINIMUM { 3, 5 }', async () => {
    const r = await requests.createForLoad(mkLoad('OM-FORM-NOACK'));
    const res = await post(r, json({ cost: COST, use_override: '1', ...ROWS }));
    await tick();
    assertRefused(res, 3, 'OM-FORM-NOACK');
    assertUntouched(await requests.getByToken(r.id), 'OM-FORM-NOACK');
  });
  await check('form capture of rows [10, 7, 3] with the ack records marginPct 3', async () => {
    const t1 = Date.now();
    const r = await requests.createForLoad(mkLoad('OM-FORM-ACK'));
    const res = await post(r, { body: form({ cost: COST, use_override: '1', ...ROWS, below_min_ack: '1' }) });
    await tick();
    assert.ok(res.status < 400, `status ${res.status}`);
    assertRecord(await requests.getByToken(r.id), 3, t1);
  });
  for (const ack of [false, true]) {
    await check(`override { [10, 7, 3], min 5 } is refused 400 BAD_INPUT ${ack ? 'WITH' : 'without'} the ack`, async () => {
      const id = ack ? 'OM-BAD-ACK' : 'OM-BAD-NOACK';
      const { r, res } = await captureOverride(id, { marginsPct: [10, 7, 3], minMarginPct: 5 }, { ack });
      assert.strictEqual(res.status, 400, `status ${res.status}`);
      assertUntouched(await requests.getByToken(r.id), id);
    });
  }

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - an override whose own minimum is below the customer minimum is accepted silently (the gate compares only the lowest margin, while the override's own minimum is the guard a ceiling can be bid down to):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - an override is judged against the customer minimum on its own minimum, needs the desk's acknowledgement, and is recorded`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
