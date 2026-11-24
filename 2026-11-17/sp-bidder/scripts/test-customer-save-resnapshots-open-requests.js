'use strict';
/**
 * A SAVED CUSTOMER MARGIN NEVER REACHES LOADS ALREADY WAITING FOR A PRICE (M0-F6).
 *
 * createForLoad snapshots the inherited band (assignment override > customer margin > default) onto
 * the request, and capture arms that snapshot. No customer, margin-profile or assignment save touches
 * open requests. So after a customer's minimum is raised from 5 to 8, a load that was already waiting
 * still shows the old rows on /price and a plain cost capture arms them - [112600, 107200, 106300],
 * a 6.3% bottom rung - with no prompt, while a per-load band at 6% on a twin load is refused as
 * below the 8% minimum. The customer minimum is read live; the band that arms is not.
 *
 * What must happen instead (default under owner review): a save of the band a load inherits
 * re-snapshots every request still awaiting a price that inherits it, so the page shows the saved
 * rows and the capture arms them.
 *
 * What must NOT move (green before and after the fix):
 *   - an ARMED load keeps the ladder it is bidding (a console save never moves a live ladder);
 *   - an awaiting load with its own per-load band keeps it;
 *   - an awaiting load of another customer is untouched.
 *
 * Figures: cost 100,000. Old band [12.6, 7.2, 6.3] min 5 arms [112600, 107200, 106300]; saved band
 * [12.6, 10, 8] min 8 arms [112600, 110000, 108000]; an assignment band [15, 10, 9] min 9 arms
 * [115000, 110000, 109000].
 *
 *   node scripts/test-customer-save-resnapshots-open-requests.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MARGINS_PCT = '12.6,7.2,6.3';
process.env.SP_MIN_MARGIN_PCT = '6.3';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-resnapshot-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, customerStore } = require('../src/web/server');

const COST = '100000';
const OLD = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const OLD_LADDER = [112600, 107200, 106300];
const NEW = { marginsPct: [12.6, 10, 8], minMarginPct: 8 };
const NEW_LADDER = [112600, 110000, 108000];
const ASSIGNED = { marginsPct: [15, 10, 9], minMarginPct: 9 };
const ASSIGNED_LADDER = [115000, 110000, 109000];

function req(method, url, { body = null, contentType = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });

const now = Date.now();
const mkLoad = (id, companyName) => ({
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
const bandOf = (d) => ({ marginsPct: d.marginsPct, minMarginPct: d.minMarginPct });

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
  const api = (p, body) => req('POST', base + p, Object.assign(json(body), { origin: base }));
  const capture = async (r, body) => { const res = await req('POST', `${base}/price/${r.id}`, json(body)); await tick(); return res; };

  const main = await customerStore.upsert({ label: 'Resnap Shipper', margin: OLD });
  const other = await customerStore.upsert({ label: 'Resnap Other Shipper', margin: OLD });
  const legacyProfile = await customerStore.upsert({ label: 'Resnap Profile Shipper', margin: OLD });
  const assigned = await customerStore.upsert({ label: 'Resnap Assigned Shipper', margin: OLD });

  const aw = await requests.createForLoad(mkLoad('RS-AW', main.label));
  const awOwn = await requests.createForLoad(mkLoad('RS-AW-OWN', main.label));
  await requests.setBidOverride(awOwn.id, { marginsPct: [14, 9, 7], minMarginPct: 7 }, { setBy: 'pricing' });
  const armed = await requests.createForLoad(mkLoad('RS-ARMED', main.label));
  const armedRes = await capture(armed, { cost: COST });
  const awOther = await requests.createForLoad(mkLoad('RS-OTHER', other.label));
  const awProfile = await requests.createForLoad(mkLoad('RS-PROFILE', legacyProfile.label));
  const awAssigned = await requests.createForLoad(mkLoad('RS-ASSIGNED', assigned.label));

  console.log('\n0. before any save');
  await check('the awaiting loads snapshot [12.6, 7.2, 6.3] min 5 and the armed one bids [112600, 107200, 106300]', async () => {
    assert.deepStrictEqual(bandOf(aw), OLD);
    assert.strictEqual(aw.marginSource, `customer:${main.customerId}`);
    assert.ok(armedRes.status < 400, `setup capture returned ${armedRes.status}`);
    assert.deepStrictEqual(armedMonitor('RS-ARMED').ladder, OLD_LADDER);
  });

  const saved = await api('/api/customers', Object.assign({}, main, { margin: NEW }));
  const profileSaved = await api('/api/margin-profiles', { customer: legacyProfile.label, marginsPct: NEW.marginsPct, minMarginPct: NEW.minMarginPct });
  const person = await api('/api/people', { name: 'Resnap Desk', phone: '+919000000009' });
  const assignment = person.json && person.json.person
    ? await api('/api/assignments', { personId: person.json.person.personId, customerId: assigned.customerId, marginOverride: ASSIGNED })
    : person;

  console.log('\n1. customer margin saved through the console as [12.6, 10, 8] min 8');
  await check('the save itself succeeds (setup)', async () => {
    assert.strictEqual(saved.status, 200, saved.text.slice(0, 160));
    assert.strictEqual(await requests.customerMinimumFor(aw), 8);
  });
  await check('the load awaiting a price now carries the saved band [12.6, 10, 8] min 8, still sourced to the customer', async () => {
    const d = await requests.getByToken(aw.id);
    assert.deepStrictEqual(bandOf(d), NEW, `snapshot not refreshed: ${JSON.stringify(bandOf(d))} source ${d.marginSource}`);
    assert.strictEqual(d.marginSource, `customer:${main.customerId}`);
  });
  await check('a plain cost capture on it arms the saved band [112600, 110000, 108000]', async () => {
    const res = await capture(aw, { cost: COST });
    const m = armedMonitor('RS-AW');
    assert.ok(res.status < 400, `status ${res.status}: ${res.text.slice(0, 160)}`);
    assert.deepStrictEqual(m && m.ladder, NEW_LADDER, `armed the stale snapshot: ${JSON.stringify(m && m.ladder)}`);
  });

  console.log('\n2. the same save through the other two console routes');
  await check('margin-profiles save [12.6, 10, 8] min 8: the awaiting load carries it', async () => {
    assert.strictEqual(profileSaved.status, 200, profileSaved.text.slice(0, 160));
    const d = await requests.getByToken(awProfile.id);
    assert.deepStrictEqual(bandOf(d), NEW, `snapshot not refreshed: ${JSON.stringify(bandOf(d))} source ${d.marginSource}`);
  });
  await check('assignment band [15, 10, 9] min 9 saved: the awaiting load carries it and a capture arms [115000, 110000, 109000]', async () => {
    assert.strictEqual(assignment.status, 200, `setup: ${assignment.text.slice(0, 160)}`);
    const d = await requests.getByToken(awAssigned.id);
    assert.deepStrictEqual(bandOf(d), ASSIGNED, `snapshot not refreshed: ${JSON.stringify(bandOf(d))} source ${d.marginSource}`);
    const res = await capture(awAssigned, { cost: COST });
    assert.ok(res.status < 400, `status ${res.status}`);
    assert.deepStrictEqual(armedMonitor('RS-ASSIGNED') && armedMonitor('RS-ASSIGNED').ladder, ASSIGNED_LADDER);
  });

  console.log('\n3. controls: behaviour that must not move');
  await check('the ARMED load keeps its band min 5 and its live ladder [112600, 107200, 106300]', async () => {
    const d = await requests.getByToken(armed.id);
    assert.deepStrictEqual(bandOf(d), OLD);
    assert.deepStrictEqual([d.price.marginsPct, d.price.minMarginPct], [OLD.marginsPct, OLD.minMarginPct]);
    assert.deepStrictEqual(armedMonitor('RS-ARMED').ladder, OLD_LADDER);
  });
  await check('the awaiting load with its own band keeps [14, 9, 7] min 7, source bid', async () => {
    const d = await requests.getByToken(awOwn.id);
    assert.deepStrictEqual([d.marginsPct, d.minMarginPct, d.marginSource], [[14, 9, 7], 7, 'bid']);
  });
  await check('the awaiting load of another customer keeps [12.6, 7.2, 6.3] min 5', async () => {
    const d = await requests.getByToken(awOther.id);
    assert.deepStrictEqual(bandOf(d), OLD);
    assert.strictEqual(d.marginSource, `customer:${other.customerId}`);
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a saved customer or assignment margin never reaches loads already awaiting a price (the band is snapshotted at createForLoad and no save re-snapshots open requests, so capture arms the stale band):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a saved margin re-snapshots the loads still awaiting a price, and armed loads and per-load bands are left alone`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
