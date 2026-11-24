'use strict';
/**
 * THE CONSOLE RE-ARM BIDS A KEPT RATE THE MINIMUM IN FORCE NOW REFUSES (A-4).
 *
 * Every other seam that arms a cost judges it against the clerical minimum in force at that moment:
 * capture, re-price, and resume (for exactly this reason: a figure stored under an older minimum).
 * The console Re-arm arms the kept cost and per-type rates as they are. So a two-type load captured
 * at [45,000 x 10, 7,000 x 1] under a Rs 6,200 minimum, stopped, and re-armed after the console
 * setting raised the minimum to Rs 3,000 + Rs 9/km (Rs 8,580 on 620 km) bids Rs 7,000 on the ODC
 * line.
 *
 * What must happen instead: the Re-arm refuses before the load leaves 'stopped', naming the truck
 * type and its rate, and the console shows that text where the operator pressed Re-arm, not a bare
 * "failed" with the reason in a hover tooltip.
 *
 * What must NOT move: a kept rate above the minimum in force re-arms as before.
 *
 *   node scripts/test-rearm-judges-kept-rate.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '500';
process.env.SP_MIN_COST_ABS = '5000';
process.env.SP_MIN_COST_PER_KM = '10';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-rearm-kept-rate-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

const CONSOLE_PAGE = path.join(__dirname, '..', 'dashboard', 'src', 'pages', 'PriceRequests.tsx');

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
const form = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

const now = Date.now();
const TWO_TYPES = { units: 11, cargoLines: 2, equipment: '10 x 32 ft MXL + 1 x 20 ft ODC', distanceKm: 619.2,
  cargoTypes: [{ label: '32 ft MXL, 18 T', count: 10, match: '32ftmxl18t' }, { label: '20 ft ODC, 10 T', count: 1, match: '20ftodc10t' }] };
const mkLoad = (id, over) => Object.assign({ id, lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32 ft MXL', units: 1,
  quoteType: 'FTL', companyName: 'Rearm Floor Shipper', closesAt: now + 30 * 60_000, startsAt: now - 60_000, distanceKm: 619.2,
  softClose: false, closeModelKnown: true, status: 'live' }, over || {});
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
  const api = (p, body) => req('POST', base + p, { body: JSON.stringify(body || {}), origin: base });
  const captured = async (loadId, over, fields) => {
    const r = await requests.createForLoad(mkLoad(loadId, over));
    const res = await req('POST', `${base}/price/${r.id}`, { body: form(Object.assign({ low_cost_ack: '1' }, fields)), contentType: 'application/x-www-form-urlencoded' });
    if (res.status !== 200) throw new Error(`setup: capture of ${loadId} answered ${res.status}`);
    return r;
  };

  const perType = await captured('RK-TYPES', TWO_TYPES, { cost_type_0: '45000', cost_type_1: '7000' });
  const single = await captured('RK-ONE', {}, { cost: '7000' });
  const above = await captured('RK-ABOVE', TWO_TYPES, { cost_type_0: '45000', cost_type_1: '9000' });
  const saved = await api('/api/config', { clericalFloor: { absRs: 3000, perKmRs: 9 } });
  if (saved.status !== 200) throw new Error(`setup: the minimum setting save answered ${saved.status}: ${saved.text.slice(0, 160)}`);
  for (const id of ['RK-TYPES', 'RK-ONE', 'RK-ABOVE']) {
    const s = await api(`/api/auctions/${id}/stop`);
    if (s.status !== 200) throw new Error(`setup: stop of ${id} answered ${s.status}`);
  }

  console.log('\n1. per-type rates [45,000, 7,000] kept, minimum now Rs 3,000 + Rs 9/km');
  {
    const res = await api('/api/auctions/RK-TYPES/rearm');
    const d = await requests.getByToken(perType.id);
    await check('the Re-arm is refused and the load stays stopped with nothing bidding', async () => {
      assert.deepStrictEqual([res.status >= 400, d.status, !!liveMonitor('RK-TYPES')], [true, 'stopped', false],
        `HTTP ${res.status}, record ${d.status}, monitor ${JSON.stringify(liveMonitor('RK-TYPES') && liveMonitor('RK-TYPES').ladder)}`);
    });
    await check('the refusal names the truck type and its rate: 20 ft ODC, 10 T at Rs 7,000', async () => {
      const msg = String(res.json && res.json.error);
      assert.ok(/^Not re-armed\./.test(msg) && /20 ft ODC, 10 T/.test(msg) && /Rs 7,000/.test(msg), `got "${msg}"`);
    });
  }

  console.log('\n2. a single kept cost Rs 7,000 under the same minimum');
  {
    const res = await api('/api/auctions/RK-ONE/rearm');
    const d = await requests.getByToken(single.id);
    await check('the Re-arm is refused naming Rs 7,000 and the load stays stopped', async () => {
      const msg = String(res.json && res.json.error);
      assert.deepStrictEqual([res.status >= 400, d.status, !!liveMonitor('RK-ONE')], [true, 'stopped', false], `HTTP ${res.status} "${msg}"`);
      assert.ok(/^Not re-armed\./.test(msg) && /Rs 7,000/.test(msg), `got "${msg}"`);
    });
  }

  console.log('\n3. the console shows the refusal text');
  await check('the Re-arm control renders the server\'s message as visible text, not only a hover title', async () => {
    const src = fs.readFileSync(CONSOLE_PAGE, 'utf8');
    const start = src.indexOf('function RearmButton');
    assert.ok(start >= 0, 'RearmButton not found');
    const end = src.indexOf('\nfunction ', start + 1);
    assert.ok(end > start, 'no function follows RearmButton');
    const body = src.slice(start, end);
    assert.ok(/>\s*\{err\}\s*</.test(body), 'the error text is not rendered as a text node in RearmButton');
  });

  console.log('\n4. control: a kept rate above the minimum in force');
  await check('per-type [45,000, 9,000] re-arms: 200, armed, a live monitor', async () => {
    const res = await api('/api/auctions/RK-ABOVE/rearm');
    const d = await requests.getByToken(above.id);
    assert.deepStrictEqual([res.status, d.status, !!liveMonitor('RK-ABOVE')], [200, 'armed', true], res.text.slice(0, 160));
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - the console Re-arm arms a kept cost or per-type rate without judging it against the minimum in force:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - the console Re-arm refuses a kept rate under the minimum in force, names it, and the console shows why`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
