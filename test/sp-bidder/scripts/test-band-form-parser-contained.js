'use strict';
/**
 * parseBandForm ACCEPTS BANDS validateMargins REFUSES (T1 D17).
 *
 * The /price routes parse the posted rows m_0..m_n with parseBandForm and then run their money gates
 * (zero margin, shipper ceiling, below-minimum, the armed floor) on what it returns. The write path
 * re-checks the band with validateMargins. parseBandForm has no sign check and no upper bound, so a
 * row of -5 or 1001 passes the parser, every gate judges that band, and only the write refuses it -
 * with "invalid margin override: every margin must be a number >= 0", which is not desk copy.
 *
 * What must happen instead: every band parseBandForm accepts, validateMargins accepts too, and a
 * negative or over-cap row is refused at the parser in plain words, before any gate or write.
 *
 * What must NOT move (green before and after the fix):
 *   - ordinary rows, trimmed rows and a row of exactly MAX_MARGIN_PCT parse;
 *   - a blank row and a 0% lowest row are refused as they are today.
 *
 * Figures: default band [12.6, 7.2, 6.3] min 5, cost 100,000, armed ladder [112600, 107200, 106300].
 *
 *   node scripts/test-band-form-parser-contained.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-band-parse-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { parseBandForm, validateMargins, MAX_MARGIN_PCT } = require('../src/pricing/marginValidate');
const { app, requests, stacks } = require('../src/web/server');

const COST = '100000';
const INHERITED_LADDER = [112600, 107200, 106300];

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
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genBody(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const float = (lo, hi) => lo + rand() * (hi - lo);
  const body = {};
  const n = int(1, 4);
  for (let i = 0; i < n; i++) {
    const kind = int(0, 9);
    let v;
    if (kind <= 5) v = String(Math.round(float(0.1, 20) * 10) / 10);
    else if (kind === 6) v = String(-Math.round(float(0.1, 20) * 10) / 10);
    else if (kind === 7) v = String(Math.round(float(1001, 1e6)));
    else if (kind === 8) v = ['0', '0.0', '  4.5  ', '1e-7', '+3'][int(0, 4)];
    else v = String(int(0, 25));
    body[`m_${i}`] = v;
  }
  return body;
}
// null when the parser refuses the body; otherwise whether the write validator accepts what it parsed.
function contained(body) {
  let parsed;
  try { parsed = parseBandForm(body); } catch (_) { return null; }
  try { validateMargins(parsed.marginsPct, parsed.minMarginPct); return { ok: true, parsed }; }
  catch (e) { return { ok: false, parsed, why: e.message }; }
}
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e; } };

const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'Band Parse Test Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
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
const technical = /invalid margin override|marginsPct|minMarginPct|>=|Error:/;

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  console.log('\n1. the parser\'s accept-set sits inside the write validator\'s');
  for (const [name, body] of [['a negative row { m_0: -1 }', { m_0: '-1' }],
    [`a row over ${MAX_MARGIN_PCT}% { m_0: 1001 }`, { m_0: '1001' }],
    ['a negative row under a positive one { 12.6, -5 }', { m_0: '12.6', m_1: '-5' }]]) {
    await check(`${name}: refused by parseBandForm (BAD_INPUT), not passed on to be refused by the write`, async () => {
      const r = contained(body);
      assert.strictEqual(r, null, `parseBandForm accepted ${JSON.stringify(r && r.parsed)}; validateMargins ${r && r.ok ? 'accepts' : `refuses: ${r && r.why}`}`);
      assert.strictEqual(refusal(() => parseBandForm(body)).code, 'BAD_INPUT');
    });
  }
  await check('seeded sweep of 20,000 bodies: no band accepted by the parser is refused by the write validator', async () => {
    const rand = mulberry32(20260918);
    let accepted = 0;
    const leaks = [];
    for (let i = 0; i < 20000; i++) {
      const body = genBody(rand);
      const r = contained(body);
      if (!r) continue;
      accepted++;
      if (!r.ok) leaks.push(`${JSON.stringify(body)} -> ${r.why}`);
    }
    assert.ok(accepted > 0, 'the sweep produced no parseable body');
    assert.strictEqual(leaks.length, 0, `${leaks.length} of ${accepted} parsed bands refused by validateMargins, first ${leaks[0]}`);
  });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\n2. a negative row on the /price routes');
  await check('first capture, use_override=1, rows [12.6, -5, 6.3]: 400 in plain words, nothing armed', async () => {
    const r = await requests.createForLoad(mkLoad('BP-CAP'));
    const res = await req('POST', `${base}/price/${r.id}`, json({ cost: COST, use_override: '1', m_0: '12.6', m_1: '-5', m_2: '6.3' }));
    await tick();
    const msg = res.json && res.json.error;
    assert.strictEqual(res.status, 400, `status ${res.status}: ${msg}`);
    assert.ok(typeof msg === 'string' && /0%/.test(msg) && !technical.test(msg), `message is not the parser's plain refusal: ${msg}`);
    assert.strictEqual((await requests.getByToken(r.id)).status, 'awaiting_price');
    assert.strictEqual(armedMonitor('BP-CAP'), null);
  });
  await check('re-price of an armed load, rows [12.6, -5, 6.3]: 400 in plain words, ladder unchanged', async () => {
    const r = await requests.createForLoad(mkLoad('BP-RE'));
    const cap = await req('POST', `${base}/price/${r.id}`, json({ cost: COST }));
    await tick();
    assert.ok(cap.status < 400, `setup capture returned ${cap.status}`);
    const res = await req('POST', `${base}/price/${r.id}`, json({ cost: COST, m_0: '12.6', m_1: '-5', m_2: '6.3' }));
    await tick();
    const msg = res.json && res.json.error;
    assert.strictEqual(res.status, 400, `status ${res.status}: ${msg}`);
    assert.ok(typeof msg === 'string' && /0%/.test(msg) && !technical.test(msg), `message is not the parser's plain refusal: ${msg}`);
    assert.deepStrictEqual(armedMonitor('BP-RE') && armedMonitor('BP-RE').ladder, INHERITED_LADDER);
  });

  console.log('\n3. controls: behaviour that must not move');
  await check('ordinary, trimmed and signed rows parse: [12.6, 7.2, 6.3], "  4.5  ", "+3"', async () => {
    assert.deepStrictEqual(parseBandForm({ m_0: '12.6', m_1: '7.2', m_2: '6.3' }), { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(parseBandForm({ m_0: '  4.5  ', m_1: '+3' }), { marginsPct: [4.5, 3], minMarginPct: 3 });
  });
  await check(`a row of exactly ${MAX_MARGIN_PCT}% parses`, async () => {
    assert.deepStrictEqual(parseBandForm({ m_0: String(MAX_MARGIN_PCT), m_1: '5' }).marginsPct, [MAX_MARGIN_PCT, 5]);
  });
  await check('a blank row and a 0% lowest row are still refused BAD_INPUT', async () => {
    assert.strictEqual(refusal(() => parseBandForm({ m_0: '12.6', m_1: '' })).code, 'BAD_INPUT');
    assert.strictEqual(refusal(() => parseBandForm({ m_0: '12.6', m_1: '0' })).code, 'BAD_INPUT');
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - parseBandForm accepts bands validateMargins refuses (no sign or range check), so the /price gates judge a band the write then refuses:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - every band the /price parser accepts is one the write accepts, and a negative or over-cap row is refused in plain words`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
