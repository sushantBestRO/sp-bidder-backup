'use strict';
/**
 * EVERY CONSOLE WRITE THAT MOVES AN INHERITED BAND REACHES THE LOADS WAITING FOR A PRICE (B-2, B-4).
 *
 * createForLoad snapshots the inherited band onto the request and capture arms that snapshot. The
 * customer, margin-profile and assignment saves re-snapshot waiting requests (M0-F6), but four other
 * writes move the same band and do not: the default band save (POST /api/config) and the customer,
 * margin-profile and assignment deletes. A default save that raised the minimum from 6.3 to 8 left a
 * waiting load on the old rows, and a plain capture armed a 6.3% bottom price with no confirmation.
 *
 * Each write is checked on its own, immediately after it and before the next one runs: one check
 * after all of them passes while any single save's re-snapshot is missing, because the next save
 * re-snapshots every waiting request anyway.
 *
 * What must NOT move: an armed load keeps its ladder when its customer is deleted.
 *
 * Figures: default [12.6, 7.2, 6.3] min 6.3; customer band [20, 15, 10] min 10; an older customer band
 * [12.6, 7.2, 6.3] min 5; assignment band [15, 10, 9] min 9; saved default [12.6, 10, 8] min 8, which
 * on cost 100,000 arms [112600, 110000, 108000].
 *
 *   node scripts/test-band-writes-resnapshot-each.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-band-writes-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, customerStore } = require('../src/web/server');

const COST = '100000';
const DEFAULT = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
const OLD = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const CUST = { marginsPct: [20, 15, 10], minMarginPct: 10 };
const CUST_LADDER = [120000, 115000, 110000];
const ASSIGNED = { marginsPct: [15, 10, 9], minMarginPct: 9 };
const NEW_DEFAULT = { marginsPct: [12.6, 10, 8], minMarginPct: 8 };
const NEW_DEFAULT_LADDER = [112600, 110000, 108000];

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
const line = (d) => `${JSON.stringify(d.marginsPct)} min ${d.minMarginPct} source ${d.marginSource}`;

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
  const api = (p, body) => req('POST', base + p, { body: JSON.stringify(body || {}), origin: base });
  const capture = async (r, body) => { const res = await req('POST', `${base}/price/${r.id}`, { body: JSON.stringify(body) }); await tick(); return res; };
  const waiting = async (loadId, label, band) => {
    const r = await requests.createForLoad(mkLoad(loadId, label));
    assert.deepStrictEqual(bandOf(r), band, `setup: ${loadId} should start on ${JSON.stringify(band)}, got ${line(r)}`);
    return r;
  };
  const expectBand = async (r, band, source) => {
    const d = await requests.getByToken(r.id);
    assert.deepStrictEqual([bandOf(d), d.marginSource], [band, source], `snapshot not refreshed: ${line(d)}`);
  };
  const ok200 = (res, what) => assert.strictEqual(res.status, 200, `setup: ${what} answered ${res.status}: ${res.text.slice(0, 160)}`);

  console.log('\n1. customer save [12.6, 7.2, 6.3] min 5 -> [20, 15, 10] min 10');
  {
    const c = await customerStore.upsert({ label: 'Each Save Customer', margin: OLD });
    const r = await waiting('EW-CUST-SAVE', c.label, OLD);
    const res = await api('/api/customers', Object.assign({}, c, { margin: CUST }));
    await check('the waiting load carries [20, 15, 10] min 10 straight after the customer save', async () => {
      ok200(res, 'the customer save');
      await expectBand(r, CUST, `customer:${c.customerId}`);
    });
  }

  console.log('\n2. margin-profile save [12.6, 7.2, 6.3] min 5 -> [20, 15, 10] min 10');
  {
    const c = await customerStore.upsert({ label: 'Each Profile Customer', margin: OLD });
    const r = await waiting('EW-PROFILE-SAVE', c.label, OLD);
    const res = await api('/api/margin-profiles', { customer: c.label, marginsPct: CUST.marginsPct, minMarginPct: CUST.minMarginPct });
    await check('the waiting load carries [20, 15, 10] min 10 straight after the margin-profile save', async () => {
      ok200(res, 'the margin-profile save');
      await expectBand(r, CUST, `customer:${c.customerId}`);
    });
  }

  console.log('\n3. assignment save [15, 10, 9] min 9 on a customer on [12.6, 7.2, 6.3] min 5');
  const assignedCustomer = await customerStore.upsert({ label: 'Each Assigned Customer', margin: OLD });
  const assignedLoad = await waiting('EW-ASSIGN', assignedCustomer.label, OLD);
  let assignmentId = null;
  {
    const person = await api('/api/people', { name: 'Each Desk', phone: '+919000000009' });
    ok200(person, 'the person save');
    const res = await api('/api/assignments', { personId: person.json.person.personId, customerId: assignedCustomer.customerId, marginOverride: ASSIGNED });
    assignmentId = res.json && res.json.assignment && res.json.assignment.assignmentId;
    await check('the waiting load carries [15, 10, 9] min 9 straight after the assignment save', async () => {
      ok200(res, 'the assignment save');
      await expectBand(assignedLoad, ASSIGNED, `assignment:${assignmentId}`);
    });
  }

  console.log('\n4. customer on [20, 15, 10] min 10 deleted');
  {
    const c = await customerStore.upsert({ label: 'Each Deleted Customer', margin: CUST });
    const armed = await requests.createForLoad(mkLoad('EW-CUST-DEL-ARMED', c.label));
    const armedRes = await capture(armed, { cost: COST });
    const r = await waiting('EW-CUST-DEL', c.label, CUST);
    const res = await api(`/api/customers/${c.customerId}/delete`);
    await check('the waiting load falls back to the default [12.6, 7.2, 6.3] min 6.3', async () => {
      ok200(res, 'the customer delete');
      await expectBand(r, DEFAULT, 'default');
    });
    await check('control: the armed load of that customer keeps its ladder [120000, 115000, 110000]', async () => {
      assert.ok(armedRes.status < 400, `setup capture answered ${armedRes.status}`);
      assert.deepStrictEqual(armedMonitor('EW-CUST-DEL-ARMED') && armedMonitor('EW-CUST-DEL-ARMED').ladder, CUST_LADDER);
      assert.deepStrictEqual(bandOf(await requests.getByToken(armed.id)), CUST);
    });
  }

  console.log('\n5. margin profile [20, 15, 10] min 10 cleared (customer kept)');
  {
    const c = await customerStore.upsert({ label: 'Each Cleared Customer', margin: CUST });
    const r = await waiting('EW-PROFILE-DEL', c.label, CUST);
    const res = await api(`/api/margin-profiles/sp/${c.customerId}/delete`);
    await check('the waiting load falls back to the default [12.6, 7.2, 6.3] min 6.3', async () => {
      ok200(res, 'the margin-profile delete');
      await expectBand(r, DEFAULT, 'default');
    });
  }

  console.log('\n6. the assignment from section 3 deleted');
  {
    const res = await api(`/api/assignments/${assignmentId}/delete`);
    await check('the waiting load falls back to its customer band [12.6, 7.2, 6.3] min 5', async () => {
      ok200(res, 'the assignment delete');
      await expectBand(assignedLoad, OLD, `customer:${assignedCustomer.customerId}`);
    });
  }

  console.log('\n7. default band saved as [12.6, 10, 8] min 8');
  {
    const r = await waiting('EW-DEFAULT', 'Each Unmatched Shipper', DEFAULT);
    const res = await api('/api/config', NEW_DEFAULT);
    await check('the waiting load on the default carries [12.6, 10, 8] min 8', async () => {
      ok200(res, 'the config save');
      await expectBand(r, NEW_DEFAULT, 'default');
    });
    await check('a plain cost capture on it arms [112600, 110000, 108000], not the old 6.3% bottom price', async () => {
      const cap = await capture(r, { cost: COST });
      assert.ok(cap.status < 400, `capture answered ${cap.status}: ${cap.text.slice(0, 160)}`);
      assert.deepStrictEqual(armedMonitor('EW-DEFAULT') && armedMonitor('EW-DEFAULT').ladder, NEW_DEFAULT_LADDER);
    });
  }

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a console write that moves an inherited band does not reach the loads already waiting for a price (only some writes re-snapshot open requests):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - every console write that moves an inherited band re-snapshots the loads waiting for a price, each on its own`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
