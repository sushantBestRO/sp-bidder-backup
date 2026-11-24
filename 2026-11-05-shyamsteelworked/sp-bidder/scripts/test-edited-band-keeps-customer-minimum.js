'use strict';
/**
 * AN EDITED /price BAND KEEPS THE CUSTOMER MINIMUM AS ITS GUARD (R31c-edited-band-keeps-customer-minimum).
 *
 * The /price editor posts one margin per row (m_0..m_n) and parseBandForm makes the LOWEST ROW the
 * override's own minimum. So the customer's minimum is dropped the moment the desk edits any row,
 * even an edit above it such as raising the opening: the stored override's guard silently rises
 * from the customer minimum to the lowest row, and a shipper ceiling that clears the customer
 * minimum but not the lowest row is refused as ceiling-dead, where the untouched band would bid
 * once at the ceiling.
 *
 * What must happen instead: a per-load band from the /price rows (first capture, re-price, and the
 * preview's `m` parameter) takes minimum = min(lowest row, customer minimum), where the customer
 * minimum is the effective minimum of the band the load inherits with no override. A customer
 * minimum that is not above 0 (a legacy stored 0) is ignored and the lowest row is the minimum.
 *
 * What must NOT move (green before and after the fix):
 *   - rows below the customer minimum ([10, 7, 3]) are refused 409 BELOW_MINIMUM { 3, 5 } without the
 *     acknowledgement; with it they arm at minimum 3, record belowMinimum, and never bid below 103,000;
 *   - rows whose lowest equals the customer minimum keep minimum 5 and need no acknowledgement;
 *   - an untouched cost-only capture arms the request's own band, minimum 5;
 *   - on a customer whose stored minimum is 0, edited rows take minimum 6.3 (never 0) and are not
 *     refused as a bid at cost;
 *   - a JSON marginOverride object keeps its own explicit minimum.
 *
 * Figures: default band [12.6, 7.2, 6.3] minimum 5, so the customer minimum is 5. Cost 100,000, flat,
 * no round-figure grid. Edited rows [13, 7.2, 6.3] price at [113000, 107200, 106300].
 *   guard at 5%   = round(100000 x 1.05)  = 105,000
 *   guard at 6.3% = round(100000 x 1.063) = 106,300
 *   ceiling 105,500 sits between them: biddable once at 105,500 on a 5% guard, dead on a 6.3% guard.
 *   rows [10, 7, 3] -> [110000, 107000, 103000], guard round(100000 x 1.03) = 103,000.
 *
 *   node scripts/test-edited-band-keeps-customer-minimum.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-edited-band-min-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, store } = require('../src/web/server');

const COST = '100000';
const CUSTOMER_MIN = 5;
const INHERITED_BAND = [12.6, 7.2, 6.3];
const INHERITED_LADDER = [112600, 107200, 106300];
const EDITED = { m_0: '13', m_1: '7.2', m_2: '6.3' };
const EDITED_BAND = [13, 7.2, 6.3];
const EDITED_LADDER = [113000, 107200, 106300];
const CEILING = 105500;
const BELOW = { m_0: '10', m_1: '7', m_2: '3' };
const BELOW_LADDER = [110000, 107000, 103000];
const BELOW_GUARD = 103000;
const LEGACY_COMPANY = 'Legacy Zero Minimum Traders';

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
const form = (obj) => ({ body: Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') });
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });
const said = (res) => (res.json ? `${res.json.code || ''} ${res.json.error || ''}`.trim() : res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));

const now = Date.now();
const mkLoad = (id, { ceilingPrice = null, companyName = 'Edited Band Test Shipper' } = {}) => ({
  id, lane: { origin: 'Vapi', destination: 'Nagpur' }, equipment: '32 Feet', units: 1,
  companyName, closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice, pricingMode: 'flat', minDecrement: 100 },
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

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (r, opts) => req('POST', `${base}/price/${r.id}`, opts);
  const armPlain = async (id, opts) => {
    const r = await requests.createForLoad(mkLoad(id, opts));
    const res = await post(r, form({ cost: COST }));
    await tick();
    assert.ok(res.status < 400, `precondition: the untouched capture of ${id} was refused ${res.status}: ${said(res)}`);
    return r;
  };

  console.log('\n1-3. first capture and preview of rows [13, 7.2, 6.3] (the opening raised, every row above 5%)');
  await check('form capture, no ceiling: armed at [113000, 107200, 106300] with marginOverride.minMarginPct 5, no belowMinimum', async () => {
    const r = await requests.createForLoad(mkLoad('EB-CAP'));
    assert.deepStrictEqual([r.marginsPct, r.minMarginPct], [INHERITED_BAND, CUSTOMER_MIN], 'precondition: the inherited band');
    const res = await post(r, form({ cost: COST, use_override: '1', ...EDITED }));
    await tick();
    assert.ok(res.status < 400, `status ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.status, 'armed');
    assert.deepStrictEqual(armedMonitor('EB-CAP') && armedMonitor('EB-CAP').ladder, EDITED_LADDER);
    assert.ok(!(doc.marginOverride && doc.marginOverride.belowMinimum), `recorded ${JSON.stringify(doc.marginOverride)}`);
    assert.deepStrictEqual(doc.marginOverride.marginsPct, EDITED_BAND);
    assert.strictEqual(doc.marginOverride.minMarginPct, CUSTOMER_MIN,
      `the edited band's minimum is ${doc.marginOverride.minMarginPct}, its lowest row, not the customer minimum ${CUSTOMER_MIN} - `
      + 'editing a row above the minimum raised the guard');
    assert.strictEqual(doc.minMarginPct, CUSTOMER_MIN, `the request's minMarginPct is ${doc.minMarginPct}`);
  });

  await check('form capture on a 105,500 ceiling, no acks: accepted and armed at exactly [105500]', async () => {
    const r = await requests.createForLoad(mkLoad('EB-CAP-CEIL', { ceilingPrice: CEILING }));
    const res = await post(r, json({ cost: COST, use_override: '1', ...EDITED }));
    await tick();
    const m = armedMonitor('EB-CAP-CEIL');
    assert.ok(res.status < 400,
      `refused ${res.status} (${said(res)}) - the edited band was judged on a 6.3% guard of 106,300, so a ceiling of `
      + `${CEILING} that clears the 5% customer minimum reads as ceiling-dead`);
    assert.strictEqual((await requests.getByToken(r.id)).status, 'armed');
    assert.ok(m, 'nothing was armed');
    assert.strictEqual(m.ceilingBelowFloor, false, 'the armed monitor is flagged ceilingBelowFloor');
    assert.deepStrictEqual(m.ladder, [CEILING], `armed ladder: ${m.ladder}`);
  });

  await check('preview ?cost=100000&m=13,7.2,6.3 on the 105,500 ceiling: ladder [105500], floor 105500, no willNotBid', async () => {
    const r = await requests.createForLoad(mkLoad('EB-PREVIEW', { ceilingPrice: CEILING }));
    const plain = await req('GET', `${base}/price/${r.id}/preview?cost=${COST}`);
    assert.ok(plain.status === 200 && plain.json && plain.json.willNotBid === undefined
      && JSON.stringify(plain.json.ladder) === JSON.stringify([CEILING]),
    `precondition: the untouched preview is not [${CEILING}]: ${plain.status} ${plain.text.slice(0, 160)}`);
    const res = await req('GET', `${base}/price/${r.id}/preview?cost=${COST}&m=13,7.2,6.3`);
    assert.strictEqual(res.status, 200, `preview answered ${res.status}: ${res.text.slice(0, 160)}`);
    assert.strictEqual(res.json.willNotBid, undefined,
      `the preview says willNotBid '${res.json.willNotBid}' (floor ${res.json.floor}) - the m rows were validated with the `
      + 'lowest row as the minimum');
    assert.deepStrictEqual(res.json.ladder, [CEILING], `preview ladder: ${res.json.ladder}`);
    assert.strictEqual(res.json.floor, CEILING, `preview floor: ${res.json.floor}`);
  });

  console.log('\n4-5. re-price of an armed load to rows [13, 7.2, 6.3]');
  await check('re-price, no ceiling: 200, saved minMarginPct 5, re-armed at [113000, 107200, 106300]', async () => {
    const r = await armPlain('EB-RP');
    assert.deepStrictEqual(armedMonitor('EB-RP') && armedMonitor('EB-RP').ladder, INHERITED_LADDER, 'precondition: armed on the inherited band');
    const res = await post(r, json({ cost: COST, ...EDITED }));
    await tick();
    assert.ok(res.status < 400, `status ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.deepStrictEqual(doc.marginsPct, EDITED_BAND, `saved band ${doc.marginsPct}`);
    assert.deepStrictEqual(armedMonitor('EB-RP') && armedMonitor('EB-RP').ladder, EDITED_LADDER);
    assert.strictEqual(doc.minMarginPct, CUSTOMER_MIN,
      `the re-priced band's minimum is ${doc.minMarginPct}, its lowest row, not the customer minimum ${CUSTOMER_MIN}`);
    assert.strictEqual(doc.marginOverride && doc.marginOverride.minMarginPct, CUSTOMER_MIN);
  });

  await check('re-price on the 105,500 ceiling, no ceiling_ack, no below_min_ack: 200, re-armed at [105500]', async () => {
    const r = await armPlain('EB-RP-CEIL', { ceilingPrice: CEILING });
    assert.deepStrictEqual(armedMonitor('EB-RP-CEIL') && armedMonitor('EB-RP-CEIL').ladder, [CEILING],
      'precondition: the untouched capture arms one bid at the ceiling');
    const res = await post(r, json({ cost: COST, ...EDITED }));
    await tick();
    assert.ok(res.status < 400,
      `refused ${res.status} (${said(res)}) - the re-priced band was judged on its lowest row 6.3%, so the ceiling it `
      + 'was already bidding at reads as ceiling-dead');
    const doc = await requests.getByToken(r.id);
    assert.deepStrictEqual(doc.marginsPct, EDITED_BAND, `saved band ${doc.marginsPct}`);
    const m = armedMonitor('EB-RP-CEIL');
    assert.ok(m, 'nothing is armed after the re-price');
    assert.deepStrictEqual(m.ladder, [CEILING], `re-armed ladder: ${m.ladder}`);
  });

  console.log('\n6. the confirmation for rows below the customer minimum stays');
  await check('rows [10, 7, 3] without below_min_ack: 409 BELOW_MINIMUM { 3, 5 }, nothing armed', async () => {
    const r = await requests.createForLoad(mkLoad('EB-BELOW-NOACK'));
    const res = await post(r, json({ cost: COST, use_override: '1', ...BELOW }));
    await tick();
    assert.strictEqual(res.status, 409, `status ${res.status}: ${said(res)}`);
    assert.strictEqual(res.json.code, 'BELOW_MINIMUM');
    assert.deepStrictEqual(res.json.belowMinimum, { marginPct: 3, customerMinPct: CUSTOMER_MIN });
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.status, 'awaiting_price');
    assert.strictEqual(armedMonitor('EB-BELOW-NOACK'), null);
  });
  await check('rows [10, 7, 3] with below_min_ack: armed at minimum 3, belowMinimum { 3, 5 }, last rung 103000, none below', async () => {
    const r = await requests.createForLoad(mkLoad('EB-BELOW-ACK'));
    const res = await post(r, form({ cost: COST, use_override: '1', ...BELOW, below_min_ack: '1' }));
    await tick();
    assert.ok(res.status < 400, `status ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.status, 'armed');
    assert.strictEqual(doc.marginOverride.minMarginPct, 3);
    const b = doc.marginOverride.belowMinimum;
    assert.deepStrictEqual(b && { marginPct: b.marginPct, customerMinPct: b.customerMinPct }, { marginPct: 3, customerMinPct: CUSTOMER_MIN });
    const m = armedMonitor('EB-BELOW-ACK');
    assert.ok(m, 'nothing was armed');
    assert.deepStrictEqual(m.ladder, BELOW_LADDER);
    assert.strictEqual(m.ladder[m.ladder.length - 1], BELOW_GUARD);
    assert.ok(m.ladder.every((p) => p >= BELOW_GUARD), `a rung sits below ${BELOW_GUARD}: ${m.ladder}`);
  });

  console.log('\n7. controls');
  await check('rows [12.6, 7.2, 5] (lowest row equals the customer minimum): minimum 5, no ack needed, nothing recorded', async () => {
    const r = await requests.createForLoad(mkLoad('EB-EQUAL'));
    const res = await post(r, form({ cost: COST, use_override: '1', m_0: '12.6', m_1: '7.2', m_2: '5' }));
    await tick();
    assert.ok(res.status < 400, `status ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.status, 'armed');
    assert.strictEqual(doc.marginOverride.minMarginPct, CUSTOMER_MIN);
    assert.ok(!doc.marginOverride.belowMinimum, `recorded ${JSON.stringify(doc.marginOverride)}`);
  });
  await check('an untouched cost-only capture arms the request\'s own band at minimum 5', async () => {
    const r = await armPlain('EB-PLAIN');
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.marginOverride, null);
    assert.deepStrictEqual([doc.marginsPct, doc.minMarginPct], [INHERITED_BAND, CUSTOMER_MIN]);
    assert.deepStrictEqual(armedMonitor('EB-PLAIN').ladder, INHERITED_LADDER);
  });
  await check('customer with a legacy stored minimum of 0: rows [13, 7.2, 6.3] take minimum 6.3, never 0, and arm', async () => {
    // Written past validation: validateMargins refuses a 0 minimum, so a stored one predates the rule.
    await store.putDoc('customers', 'legacy-zero-minimum', {
      customerId: 'legacy-zero-minimum', label: LEGACY_COMPANY, aliases: [LEGACY_COMPANY], enabled: true,
      margin: { marginsPct: INHERITED_BAND.slice(), minMarginPct: 0 }, auction: null,
    });
    const r = await requests.createForLoad(mkLoad('EB-LEGACY', { companyName: LEGACY_COMPANY }));
    assert.strictEqual(await requests.customerMinimumFor(r), 0, 'precondition: the customer minimum resolves to the stored 0');
    const res = await post(r, form({ cost: COST, use_override: '1', ...EDITED }));
    await tick();
    assert.ok(res.status < 400, `status ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.status, 'armed');
    assert.strictEqual(doc.marginOverride.minMarginPct, 6.3);
    assert.strictEqual(doc.minMarginPct, 6.3);
    const m = armedMonitor('EB-LEGACY');
    assert.ok(m, 'nothing was armed');
    assert.deepStrictEqual(m.ladder, EDITED_LADDER);
  });
  await check('JSON marginOverride { [13, 7.2, 6.3], min 6 } keeps its own minimum 6', async () => {
    const r = await requests.createForLoad(mkLoad('EB-JSON'));
    const res = await post(r, json({ cost: COST, marginOverride: { marginsPct: EDITED_BAND, minMarginPct: 6 } }));
    await tick();
    assert.ok(res.status < 400, `status ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.strictEqual(doc.status, 'armed');
    assert.strictEqual(doc.marginOverride.minMarginPct, 6);
    assert.strictEqual(doc.minMarginPct, 6);
  });

  for (const s of stacks) { try { if (s.engine) s.engine.kill('test done'); } catch (_) {} }
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - an edited /price band drops the customer minimum (parseBandForm makes the lowest row the override's own minimum, so the guard rises to it and a ceiling between the two is refused as ceiling-dead):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - an edited /price band keeps the customer minimum as its guard, unless a row goes below it`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
