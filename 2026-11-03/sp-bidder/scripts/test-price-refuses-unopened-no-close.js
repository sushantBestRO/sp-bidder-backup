'use strict';
/**
 * /price ACCEPTS A COST FOR A LOAD THAT HAS NOT OPENED AND HAS NO CLOSING TIME (W1-3 residual).
 *
 * A load that has not opened yet is not armed at capture: armFromRequest hands it to
 * engine.schedule(), and the wake re-reads the close at the start time. When the request carries no
 * close (null) or an impossible one (0, i.e. 1 Jan 1970), capture() lets it through - the
 * closed-auction check and the year-2100 placeholder check are both false on it - so the desk gets
 * 200, a "rate received" receipt and a scheduled intent with no close. If the wake still finds no
 * close it holds the load and sends "Not bidding this load" afterwards. That is knowable at submit.
 *
 * What must happen instead (bucket 1 of the price-page gate): the submit is refused with a plain
 * corrective message, as a 4xx, on the JSON and the form path. Nothing is saved, scheduled, armed or
 * receipted; the request stays open so the desk can price it once a close is on record.
 *
 * What must NOT move (green before and after the fix):
 *   - a not-yet-open load WITH a real close is accepted and scheduled for its start;
 *   - the year-2100 placeholder close is still refused 410 as it is today;
 *   - an open load with a real close is armed.
 *
 *   node scripts/test-price-refuses-unopened-no-close.js
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

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-unopened-noclose-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, notifier } = require('../src/web/server');

const COST = '100000';
const receipts = [];
const realAlert = notifier.alert.bind(notifier);
notifier.alert = async (kind, payload, opts) => {
  if (kind === 'price_submitted') receipts.push(payload);
  return realAlert(kind, payload, opts);
};
const receiptFor = (loadId) => receipts.filter((p) => String(p.loadId) === String(loadId)).pop() || null;

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
const OPENS = now + 20 * 60_000;
const unopened = (id, closesAt) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'Unopened Test Shipper', closesAt, startsAt: OPENS,
  softClose: false, closeModelKnown: true, status: 'scheduled', rules: { ceilingPrice: null, pricingMode: 'flat' },
});
const open = (id) => Object.assign(unopened(id, now + 40 * 60_000), { startsAt: now - 60_000, status: 'live' });
const engineState = (loadId) => {
  for (const s of stacks) {
    const e = s.engine;
    if (!e) continue;
    const m = e.monitors ? e.monitors.get(loadId) : null;
    const it = e.scheduler && e.scheduler.get ? e.scheduler.get(loadId) : null;
    if (m || it) return { monitor: !!m, intent: it ? it.status : null };
  }
  return { monitor: false, intent: null };
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const technical = /closesAt|null|undefined|NaN|\bbot\b|—|Error:/;

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

async function assertNothingTaken(r, loadId) {
  const d = await requests.getByToken(r.id);
  assert.strictEqual(d.status, 'awaiting_price', `request is ${d.status}`);
  assert.ok(!d.price || d.price.cost == null, `a price was stored: ${JSON.stringify(d.price)}`);
  const st = engineState(loadId);
  assert.deepStrictEqual(st, { monitor: false, intent: null }, `engine holds ${JSON.stringify(st)}`);
  assert.strictEqual(receiptFor(loadId), null, 'a "rate received" receipt was sent');
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postJson = async (r, body) => { const res = await req('POST', `${base}/price/${r.id}`, json(body)); await settle(); return res; };

  console.log('\n1. not-yet-open load, no close on record');
  for (const [tag, closesAt] of [['null', null], ['0', 0]]) {
    const id = `UN-${tag}`;
    const r = await requests.createForLoad(unopened(id, closesAt));
    const res = await postJson(r, { cost: COST });
    await check(`closesAt ${tag}: JSON submit refused 4xx with a plain message`, async () => {
      assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx refusal, got ${res.status}, engine ${JSON.stringify(engineState(id))}, receipt ${!!receiptFor(id)}`);
      const msg = res.json && res.json.error;
      assert.ok(typeof msg === 'string' && msg.length > 0, 'no error message');
      assert.ok(!technical.test(msg), `message is not plain: ${msg}`);
    });
    await check(`closesAt ${tag}: nothing saved, scheduled, armed or receipted`, async () => {
      await assertNothingTaken(r, id);
    });
  }
  await check('closesAt null, native form submit: refused 4xx, nothing taken', async () => {
    const r = await requests.createForLoad(unopened('UN-FORM', null));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: COST }) });
    await settle();
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx refusal, got ${res.status}, engine ${JSON.stringify(engineState('UN-FORM'))}`);
    await assertNothingTaken(r, 'UN-FORM');
  });

  console.log('\n2. controls: behaviour that must not move');
  await check('not-yet-open load with a real close: accepted and scheduled for its start', async () => {
    const r = await requests.createForLoad(unopened('UN-REAL', now + 60 * 60_000));
    const res = await postJson(r, { cost: COST });
    assert.ok(res.status < 400, `status ${res.status}: ${res.text.slice(0, 160)}`);
    assert.deepStrictEqual(engineState('UN-REAL'), { monitor: false, intent: 'scheduled' });
  });
  await check('not-yet-open load with the year-2100 placeholder close: still refused 410', async () => {
    const r = await requests.createForLoad(unopened('UN-2100', Date.UTC(2100, 4, 24)));
    const res = await postJson(r, { cost: COST });
    assert.strictEqual(res.status, 410, `status ${res.status}`);
    await assertNothingTaken(r, 'UN-2100');
  });
  await check('open load with a real close: armed', async () => {
    const r = await requests.createForLoad(open('UN-OPEN'));
    const res = await postJson(r, { cost: COST });
    assert.ok(res.status < 400, `status ${res.status}`);
    assert.strictEqual(engineState('UN-OPEN').monitor, true);
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - /price accepts a cost for a load that has not opened and has no closing time (capture's close checks are false on a null or 0 close, so the load is receipted and scheduled with nothing to bid against):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - a not-yet-open load with no closing time is refused at submit, and loads with a real close are unaffected`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
