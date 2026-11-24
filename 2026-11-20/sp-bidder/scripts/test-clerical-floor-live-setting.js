'use strict';
/**
 * THE CLERICAL FLOOR IS A LIVE SETTING, UNSET BY DEFAULT.
 *
 * Regression target: R2-A (CW-29), with T1 BH-BOUNDARY-2.
 *
 * The hard clerical-error floor is read from SP_MIN_COST_ABS / SP_MIN_COST_PER_KM once, at require
 * time, so the only way to change the figure is an .env edit and a restart. The client is to supply
 * the figure; the owner's ruling makes it a runtime setting in the config store, unset by default.
 * Shape built here: `clericalFloor: { absRs, perKmRs }`.
 *   - UNSET (both null): the env floor applies, unchanged in value, max(abs, perKm x km).
 *   - SET: floor = absRs + perKmRs x ceil(km), the "Rs 10/km + Rs 5,000" shape put to the client.
 * Either way it binds each truck type's rate (see test-clerical-floor-per-type.js), truck basis
 * only; PMT keeps its carve-out. A save takes effect on the next request with no restart, survives a
 * restart, is not disturbed by a save of another panel, and a junk value is refused at the save.
 *
 * Here the env floor is Rs 5,000 abs / Rs 10 per km, on a 619.2 km lane (620 whole km): Rs 6,200.
 * The setting saved is Rs 3,000 + Rs 9/km: Rs 3,000 + 9 x 620 = Rs 8,580.
 *
 * WHAT MUST NOT MOVE (positive pins, green on the base):
 *   - unset, a single rate is refused at Rs 6,199 and armed at Rs 6,200, and the page inlines 6,200;
 *   - set, Rs 8,580 exactly still arms on capture, re-price and the console route;
 *   - a PMT rate of Rs 800/MT arms with the setting in force;
 *   - clearing the setting puts the env floor back.
 *
 *   node scripts/test-clerical-floor-live-setting.js
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
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-clerical-setting-'));

const http = require('http');
const config = require('../src/config');
const { app, requests, store, configStore } = require('../src/web/server');
const { ConfigStore, defaultsFrom } = require('../src/admin/configStore');

let pass = 0, fail = 0, n = 0;
const failed = [];
const ok = (c, m) => {
  n++;
  if (c) { pass++; console.log(`  ok  ${n}. ${m}`); } else { fail++; failed.push(`${n}. ${m}`); console.error(`  FAIL ${n}. ${m}`); }
};

function call(method, url, { body = null, contentType = null, origin = null } = {}) {
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
let seq = 0;
const mkLoad = (over) => Object.assign({
  id: `CS-${++seq}`, lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32 ft MXL', units: 1,
  quoteType: 'FTL', companyName: 'Havells', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', distanceKm: 619.2,
}, over || {});
const TWO_TYPES = {
  units: 11, cargoLines: 2, equipment: '10 x 32 ft MXL, 18 T + 1 x 20 ft ODC, 10 T',
  cargoTypes: [
    { label: '32 ft MXL, 18 T', count: 10, match: '32ftmxl18t' },
    { label: '20 ft ODC, 10 T', count: 1, match: '20ftodc10t' },
  ],
};
const UNSET = { absRs: null, perKmRs: null };
const SET = { absRs: 3000, perKmRs: 9 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const capture = (token, fields) => call('POST', `${base}/price/${token}`, { body: form(fields), contentType: 'application/x-www-form-urlencoded' });
  const saveConfig = (partial) => call('POST', `${base}/api/config`, { body: JSON.stringify(partial), origin: base });
  const readFloor = async () => { const r = await call('GET', `${base}/api/config`); return r.json && r.json.config ? r.json.config.clericalFloor : undefined; };
  const captureOne = async (cost, over) => {
    const r = await requests.createForLoad(mkLoad(over));
    const res = await capture(r.id, { cost: String(cost) });
    return { res, doc: await requests.getByToken(r.id) };
  };
  const armedAt = async (cost) => {
    const { res, doc } = await captureOne(cost);
    if (res.status !== 200 || doc.status !== 'armed') throw new Error(`setup: could not arm at Rs ${cost} (HTTP ${res.status}, ${doc.status})`);
    return doc;
  };
  const reprice = (doc, cost) => call('POST', `${base}/price/${doc.id}`, {
    body: JSON.stringify({ cost: String(cost), ...Object.fromEntries(doc.marginsPct.map((m, i) => [`m_${i}`, String(m)])) }) });
  const consoleCost = (doc, cost) => call('POST', `${base}/api/price-requests/${doc.id}/margin`, {
    body: JSON.stringify({ marginsPct: doc.marginsPct, minMarginPct: doc.minMarginPct, cost, confirm: true }), origin: base });
  const pageFloor = async () => {
    const r = await requests.createForLoad(mkLoad());
    const page = await call('GET', `${base}/price/${r.id}`);
    const m = /var HARDFLOOR=(\d+);/.exec(page.text);
    return m ? Number(m[1]) : null;
  };

  console.log('\nA. unset by default - the env floor, unchanged in value');
  {
    const floor = await readFloor();
    ok(same(floor, UNSET), `the config carries clericalFloor, unset by default (got ${JSON.stringify(floor)})`);
    const lo = await captureOne(6199);
    const at = await captureOne(6200);
    ok(lo.res.status === 400 && at.res.status === 200 && at.doc.status === 'armed',
      `PIN unset: Rs 6,199 refused and Rs 6,200 armed on a 620 km lane (HTTP ${lo.res.status} / ${at.res.status})`);
    const pf = await pageFloor();
    ok(pf === 6200, `PIN unset: the page inlines the env floor of 6,200 (got ${pf})`);
  }

  console.log('\nB. set - the next request uses the new floor, no restart');
  {
    const res = await saveConfig({ clericalFloor: SET });
    ok(res.status === 200 && res.json && same(res.json.config.clericalFloor, SET),
      `the save is accepted and returns the setting (HTTP ${res.status}, got ${JSON.stringify(res.json && res.json.config && res.json.config.clericalFloor)})`);
    const lo = await captureOne(8579);
    ok(lo.res.status === 400 && lo.doc.status === 'awaiting_price',
      `capture: Rs 8,579 is refused under Rs 3,000 + 9 x 620 = Rs 8,580 (HTTP ${lo.res.status}, ${lo.doc.status})`);
    ok(lo.res.status === 400 && /8,580/.test(lo.res.text), 'capture: the refusal names the required Rs 8,580');
    const at = await captureOne(8580);
    ok(at.res.status === 200 && at.doc.status === 'armed', `PIN: Rs 8,580 exactly arms (HTTP ${at.res.status})`);
    const pf = await pageFloor();
    ok(pf === 8580, `page: the served script carries the live floor of 8,580 (got ${pf})`);
  }
  {
    const r = await requests.createForLoad(mkLoad(TWO_TYPES));
    const res = await capture(r.id, { cost_type_0: '45000', cost_type_1: '8579' });
    ok(res.status === 400, `capture: per-type [45,000, 8,579] is refused under the live floor (HTTP ${res.status})`);
  }
  {
    const doc = await armedAt(20000);
    const lo = await reprice(doc, 8579);
    ok(lo.status === 400, `re-price: Rs 8,579 is refused under the live floor (HTTP ${lo.status})`);
    const at = await reprice(await requests.getByToken(doc.id), 8580);
    ok(at.status === 200, `PIN re-price: Rs 8,580 saves (HTTP ${at.status})`);
  }
  {
    const doc = await armedAt(20000);
    const lo = await consoleCost(doc, 8579);
    const after = await requests.getByToken(doc.id);
    ok(lo.status === 400 && after.price.cost === 20000,
      `console: Rs 8,579 is refused under the live floor and the armed cost stands (HTTP ${lo.status}, cost ${after.price.cost})`);
    const at = await consoleCost(doc, 8580);
    ok(at.status === 200, `PIN console: Rs 8,580 saves (HTTP ${at.status})`);
  }
  {
    const { res, doc } = await captureOne(800, { quoteType: 'PMT', units: 22 });
    ok(res.status === 200 && doc.status === 'armed', `PIN: a PMT rate of Rs 800/MT arms with the setting in force (HTTP ${res.status})`);
  }

  console.log('\nC. the setting survives another panel\'s save and a restart');
  {
    await saveConfig({ notifyMode: 'dashboard' });
    const floor = await readFloor();
    ok(same(floor, SET), `a save of another field leaves the setting alone (got ${JSON.stringify(floor)})`);
    const fresh = new ConfigStore({ store, defaults: defaultsFrom(config) });
    const reread = (await fresh.get()).clericalFloor;
    ok(same(reread, SET), `a fresh config store over the same data reads the setting back (got ${JSON.stringify(reread)})`);
  }

  console.log('\nD. junk is refused at the save, and a refused save moves nothing');
  {
    const neg = await saveConfig({ clericalFloor: { absRs: -1, perKmRs: 9 } });
    ok(neg.status === 400, `a negative figure is refused (HTTP ${neg.status})`);
    const word = await saveConfig({ clericalFloor: { absRs: 'abc', perKmRs: 9 } });
    ok(word.status === 400, `a non-numeric figure is refused (HTTP ${word.status})`);
    const perKmWord = await saveConfig({ clericalFloor: { absRs: 3000, perKmRs: 'ten' } });
    ok(perKmWord.status === 400, `a non-numeric per-km figure is refused (HTTP ${perKmWord.status})`);
    const refusedCode = async (partial) => { try { await configStore.save(partial); return 'saved'; } catch (e) { return e.code; } };
    const nan = await refusedCode({ clericalFloor: { absRs: NaN, perKmRs: 9 } });
    ok(nan === 'BAD_INPUT', `NaN is refused at the store (got ${nan})`);
    const inf = await refusedCode({ clericalFloor: { absRs: 3000, perKmRs: Infinity } });
    ok(inf === 'BAD_INPUT', `Infinity is refused at the store (got ${inf})`);
    const floor = await readFloor();
    ok(same(floor, SET), `after every refusal the saved setting is still Rs 3,000 + Rs 9/km (got ${JSON.stringify(floor)})`);
  }

  console.log('\nE. clearing the setting puts the env floor back');
  {
    const res = await saveConfig({ clericalFloor: UNSET });
    ok(res.status === 200 && same(res.json && res.json.config.clericalFloor, UNSET),
      `the clear is accepted (HTTP ${res.status}, got ${JSON.stringify(res.json && res.json.config && res.json.config.clericalFloor)})`);
    const lo = await captureOne(6199);
    const mid = await captureOne(8579);
    ok(lo.res.status === 400 && mid.res.status === 200,
      `PIN cleared: Rs 6,199 refused again and Rs 8,579 arms (HTTP ${lo.res.status} / ${mid.res.status})`);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed (of ${n})`);
  if (fail) {
    console.error('FAIL - the clerical floor is an env constant, not a live setting:');
    for (const f of failed) console.error('  * ' + f);
    process.exit(1);
  }
  console.log(`PASS test-clerical-floor-live-setting (${n} checks)`);
  process.exit(0);
})().catch((e) => { console.error('could_not_run:', e && e.stack); process.exit(2); });
