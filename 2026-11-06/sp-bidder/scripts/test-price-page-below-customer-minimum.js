'use strict';
/**
 * A PER-LOAD BAND BELOW THE CUSTOMER MINIMUM IS ACCEPTED SILENTLY (R31-below-customer-minimum).
 *
 * The /price margin editor posts one margin per row (m_0..m_n). parseBandForm makes the lowest typed
 * margin the override's own minimum, so a band whose lowest margin sits below the customer's minimum
 * passes every check: the capture arms, a re-price re-arms, nothing asks the desk to confirm it,
 * nothing records who went below what, and the receipt says nothing about it.
 *
 * Customer minimum = the effective minimum of the band the load inherits without any per-load
 * override (assignment override > customer margin > default): its explicit minMarginPct, else its
 * lowest margin. Below = the override's lowest margin is strictly under it.
 *
 * What must happen instead:
 *   - without below_min_ack the capture and the re-price are refused with 409 BELOW_MINIMUM, a JSON
 *     caller gets { error, code, belowMinimum: { marginPct, customerMinPct } }, and nothing moves;
 *   - with below_min_ack=1 the band is saved and armed, and marginOverride.belowMinimum records
 *     { marginPct, customerMinPct, setBy: 'pricing', setAt };
 *   - the submitted-rate receipt for such a save carries a line naming both figures;
 *   - the served page carries the ack field and the customer minimum it prompts against.
 *
 * What must NOT move (pinned here, green before and after the fix):
 *   - the guard: an acked band [10, 7, 3] still arms no rung below cost x 1.03, and a JSON
 *     marginOverride with a margin below its OWN stated minimum is refused 400 with or without the ack;
 *   - a band at or above the customer minimum, and a plain cost-only capture, need no ack and record
 *     nothing; their receipt renders byte-for-byte as it does today.
 *
 * Figures: default band [12.6, 7.2, 6.3] min 5, so the customer minimum is 5. Typed band [10, 7, 3] at
 * cost 100000 is below it (3 < 5); its ladder is [110000, 107000, 103000] (100000 x 1.10 / 1.07 / 1.03).
 *
 *   node scripts/test-price-page-below-customer-minimum.js
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
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-below-custmin-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, notifier, customerStore } = require('../src/web/server');
const { renderMessage } = require('../src/notify/waTemplates');

const COST = '100000';
const CUSTOMER_MIN = 5;
const BELOW = { m_0: '10', m_1: '7', m_2: '3' };
const BELOW_LOWEST = 3;
const BELOW_LADDER = [110000, 107000, 103000];
const GUARD = 103000; // round(100000 x 1.03): the override's own minimum
const INHERITED_LADDER = [112600, 107200, 106300];
// A customer minimum no other figure on the page carries, so its presence on the served page is
// attributable to the prompt and nothing else.
const ODD_MIN = 4.85;

// The keys confirmSubmitted puts on a price_submitted payload today. A receipt rendered off only
// these keys is the receipt as it reads today.
const TODAY_RECEIPT_KEYS = ['platformKey', 'loadId', 'oaNo', 'shipper', 'origin', 'branch', 'closingTime',
  'route', 'cargoQty', 'enteredTime', 'submittedRate', 'rateByType', 'vehicleCount', 'changeLink',
  'openingBid', 'floorBid', 'openingPct', 'floorPct', 'accountId', 'accountLabel',
  // Named reversal, ruling 86 (owner, 26 Sep 2026): the receipt now carries the close-type and bids line.
  'closeRule'];

const receipts = [];
const realAlert = notifier.alert.bind(notifier);
notifier.alert = async (kind, payload, opts) => {
  if (kind === 'price_submitted') receipts.push(payload);
  return realAlert(kind, payload, opts);
};
const receiptFor = (loadId) => receipts.filter((p) => p.loadId === loadId).pop() || null;

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
const mkLoad = (id, companyName = 'Minimum Test Shipper') => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName, closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: null, pricingMode: 'flat' },
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
  assert.strictEqual(armedMonitor(loadId), null, 'a monitor was armed');
}
function assertBelowRecord(doc, t0) {
  const b = doc.marginOverride && doc.marginOverride.belowMinimum;
  assert.ok(b, `marginOverride carries no belowMinimum record: ${JSON.stringify(doc.marginOverride)}`);
  assert.deepStrictEqual({ marginPct: b.marginPct, customerMinPct: b.customerMinPct, setBy: b.setBy },
    { marginPct: BELOW_LOWEST, customerMinPct: CUSTOMER_MIN, setBy: 'pricing' });
  assert.ok(Number.isFinite(b.setAt) && b.setAt >= t0 && b.setAt <= Date.now(), `setAt ${b.setAt} is not the save time in ms`);
}
function assertBelowRefusal(res) {
  assert.ok(res.status === 409, `expected 409 BELOW_MINIMUM, got ${res.status} (${res.json && res.json.ok ? 'saved' : res.text.slice(0, 80)})`);
  assert.ok(res.json, 'no JSON body');
  assert.strictEqual(res.json.code, 'BELOW_MINIMUM');
  assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0, 'no error message');
  assert.deepStrictEqual(res.json.belowMinimum, { marginPct: BELOW_LOWEST, customerMinPct: CUSTOMER_MIN });
}
const hasPct = (line, n) => new RegExp(`(^|[^\\d.])${String(n).replace('.', '\\.')}%`).test(line);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (r, opts) => req('POST', `${base}/price/${r.id}`, opts);

  console.log('\n0. the customer minimum these checks are judged against');
  await check('a load with no customer record inherits the default band [12.6, 7.2, 6.3] min 5', async () => {
    const r = await requests.createForLoad(mkLoad('BM-PRE'));
    assert.deepStrictEqual([r.marginsPct, r.minMarginPct], [[12.6, 7.2, 6.3], CUSTOMER_MIN]);
  });

  console.log('\n1. first capture below the customer minimum, no acknowledgement: refused, nothing moves');
  await check('form capture of [10, 7, 3] without below_min_ack is refused 409', async () => {
    const r = await requests.createForLoad(mkLoad('BM-FORM-NOACK'));
    const res = await post(r, { body: form({ cost: COST, use_override: '1', ...BELOW }) });
    await tick();
    assert.ok(res.status === 409, `expected 409, got ${res.status}`);
    assertUntouched(await requests.getByToken(r.id), 'BM-FORM-NOACK');
  });
  await check('JSON capture of [10, 7, 3] without the ack gets { error, code: BELOW_MINIMUM, belowMinimum: { 3, 5 } }', async () => {
    const r = await requests.createForLoad(mkLoad('BM-JSON-NOACK'));
    const res = await post(r, json({ cost: COST, use_override: '1', ...BELOW }));
    assertBelowRefusal(res);
  });
  await check('the refused JSON capture leaves the request awaiting_price, unpriced and unarmed', async () => {
    assertUntouched(await requests.getByLoad('BM-JSON-NOACK'), 'BM-JSON-NOACK');
  });

  console.log('\n2. the same capture WITH below_min_ack: saved, armed, and recorded');
  const t0 = Date.now();
  const acked = await requests.createForLoad(mkLoad('BM-FORM-ACK'));
  const ackedRes = await post(acked, { body: form({ cost: COST, use_override: '1', ...BELOW, below_min_ack: '1' }) });
  await tick();
  await check('the acknowledged capture is accepted and armed', async () => {
    assert.ok(ackedRes.status < 400, `status ${ackedRes.status}`);
    assert.strictEqual((await requests.getByToken(acked.id)).status, 'armed');
    assert.ok(armedMonitor('BM-FORM-ACK'), 'no monitor armed');
  });
  await check('marginOverride.belowMinimum = { marginPct: 3, customerMinPct: 5, setBy: pricing, setAt }', async () => {
    assertBelowRecord(await requests.getByToken(acked.id), t0);
  });

  console.log('\n3. THE GUARD STAYS: an override never bids below its own minimum');
  await check('the acked band arms [110000, 107000, 103000]: every rung >= 103000 and the last is 103000', async () => {
    const m = armedMonitor('BM-FORM-ACK');
    assert.ok(m, 'no monitor');
    assert.ok(m.ladder.every((p) => p >= GUARD), `a rung sits below ${GUARD}: ${m.ladder}`);
    assert.strictEqual(m.ladder[m.ladder.length - 1], GUARD);
    assert.deepStrictEqual(m.ladder, BELOW_LADDER);
  });
  for (const ack of [false, true]) {
    await check(`JSON marginOverride { [10, 7, 3], min 5 } is refused 400 ${ack ? 'WITH' : 'without'} below_min_ack`, async () => {
      const id = ack ? 'BM-OBJ-ACK' : 'BM-OBJ-NOACK';
      const r = await requests.createForLoad(mkLoad(id));
      const body = { cost: COST, marginOverride: { marginsPct: [10, 7, 3], minMarginPct: 5 } };
      if (ack) body.below_min_ack = '1';
      const res = await post(r, json(body));
      assert.strictEqual(res.status, 400, `status ${res.status}`);
      assertUntouched(await requests.getByToken(r.id), id);
    });
  }

  console.log('\n4. re-price below the customer minimum: the same pair of behaviours');
  const armPlain = async (id) => {
    const r = await requests.createForLoad(mkLoad(id));
    const res = await post(r, { body: form({ cost: COST }) });
    await tick();
    assert.ok(res.status < 400, `plain capture of ${id} failed: ${res.status}`);
    return r;
  };
  let rpNo = null;
  await check('control: a plain cost-only capture needs no ack, arms the inherited ladder, records nothing', async () => {
    rpNo = await armPlain('BM-RP-NOACK');
    const doc = await requests.getByToken(rpNo.id);
    assert.strictEqual(doc.status, 'armed');
    assert.strictEqual(doc.marginOverride, null);
    assert.deepStrictEqual(armedMonitor('BM-RP-NOACK').ladder, INHERITED_LADDER);
  });
  const before = rpNo && await requests.getByToken(rpNo.id);
  const rpNoRes = rpNo && await post(rpNo, json({ cost: COST, ...BELOW }));
  await tick();
  await check('re-price to [10, 7, 3] without the ack is refused 409 BELOW_MINIMUM { 3, 5 }', async () => {
    assertBelowRefusal(rpNoRes);
  });
  await check('the refused re-price leaves the saved band, cost and armed ladder unchanged', async () => {
    const after = await requests.getByToken(rpNo.id);
    const pick = (d) => JSON.stringify([d.marginsPct, d.minMarginPct, d.price.cost, d.marginOverride]);
    assert.ok(pick(after) === pick(before), `request moved: ${pick(before)} -> ${pick(after)}`);
    assert.deepStrictEqual(armedMonitor('BM-RP-NOACK').ladder, INHERITED_LADDER);
  });
  const rpAck = await armPlain('BM-RP-ACK');
  const t1 = Date.now();
  const rpAckRes = await post(rpAck, json({ cost: COST, ...BELOW, below_min_ack: '1' }));
  await tick();
  await check('re-price WITH below_min_ack is saved and re-armed at [110000, 107000, 103000]', async () => {
    assert.ok(rpAckRes.status < 400, `status ${rpAckRes.status}: ${rpAckRes.text.slice(0, 160)}`);
    const doc = await requests.getByToken(rpAck.id);
    assert.deepStrictEqual(doc.marginsPct, [10, 7, 3]);
    assert.deepStrictEqual(armedMonitor('BM-RP-ACK').ladder, BELOW_LADDER);
  });
  await check('the acked re-price records marginOverride.belowMinimum { 3, 5, pricing, setAt }', async () => {
    assertBelowRecord(await requests.getByToken(rpAck.id), t1);
  });

  console.log('\n5. controls: at or above the customer minimum needs no ack and records nothing');
  // [10, 7, 6]: lowest 6 > 5. [10, 7, 5]: lowest 5 == 5, and below is strict.
  for (const [id, band] of [['BM-ABOVE', { m_0: '10', m_1: '7', m_2: '6' }], ['BM-EQUAL', { m_0: '10', m_1: '7', m_2: '5' }]]) {
    await check(`band [${band.m_0}, ${band.m_1}, ${band.m_2}] without an ack is accepted, armed, and records no belowMinimum`, async () => {
      const r = await requests.createForLoad(mkLoad(id));
      const res = await post(r, { body: form({ cost: COST, use_override: '1', ...band }) });
      await tick();
      assert.ok(res.status < 400, `status ${res.status}`);
      const doc = await requests.getByToken(r.id);
      assert.strictEqual(doc.status, 'armed');
      assert.ok(armedMonitor(id), 'no monitor armed');
      assert.ok(!(doc.marginOverride && doc.marginOverride.belowMinimum), `recorded ${JSON.stringify(doc.marginOverride)}`);
    });
  }

  console.log('\n6. the submitted-rate receipt');
  await check('the acked below-minimum capture receipt has a line naming both 3% and 5%', async () => {
    const p = receiptFor('BM-FORM-ACK');
    assert.ok(p, 'no price_submitted receipt was sent for the acked capture');
    const text = renderMessage('price_submitted', p);
    assert.ok(text.split('\n').some((l) => hasPct(l, BELOW_LOWEST) && hasPct(l, CUSTOMER_MIN)),
      `no line names both figures:\n${text}`);
  });
  for (const id of ['BM-ABOVE', 'BM-RP-NOACK']) {
    await check(`control: the ${id} receipt (no belowMinimum) renders exactly as today`, async () => {
      const p = receiptFor(id);
      assert.ok(p, `no price_submitted receipt was sent for ${id}`);
      const today = {};
      for (const k of TODAY_RECEIPT_KEYS) if (k in p) today[k] = p[k];
      assert.strictEqual(renderMessage('price_submitted', p), renderMessage('price_submitted', today));
    });
  }

  console.log('\n7. the served /price page carries the ack wiring and the figure it prompts against');
  await customerStore.upsert({ label: 'Odd Minimum Shipper', margin: { marginsPct: [12.6, 7.2, 6.3], minMarginPct: ODD_MIN } });
  const odd = await requests.createForLoad(mkLoad('BM-PAGE', 'Odd Minimum Shipper'));
  const page = (await req('GET', `${base}/price/${odd.id}`)).text;
  const inline = (page.match(/<script>[\s\S]*?<\/script>/g) || []).join('\n');
  await check('the page load inherits the customer record band, minimum 4.85', async () => {
    assert.strictEqual(odd.status, 'awaiting_price');
    assert.strictEqual(odd.minMarginPct, ODD_MIN);
  });
  await check('the inline script carries the below_min_ack field', async () => {
    assert.ok(inline.length > 0, 'no inline script');
    assert.ok(inline.includes('below_min_ack'), 'below_min_ack is not in the shipped script');
  });
  await check('the page carries the customer minimum 4.85 it will prompt against', async () => {
    assert.ok(/(^|[^\d.])4\.85(?![\d])/.test(page), '4.85 appears nowhere on the served page');
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a per-load band below the customer minimum is accepted silently (parseBandForm takes the lowest typed margin as the override's own minimum; no prompt, no record, no note):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a band below the customer minimum needs the desk's acknowledgement, is recorded and noted, and the guard still holds`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
