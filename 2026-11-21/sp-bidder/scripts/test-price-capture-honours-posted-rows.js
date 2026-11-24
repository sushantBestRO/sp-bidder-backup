'use strict';
/**
 * EDITED MARGIN ROWS POSTED WITHOUT use_override ARE DROPPED (T1 D6, R2-5).
 *
 * The /price capture page always posts its margin rows m_0..m_n. The capture branch reads them only
 * when the hidden use_override is '1' or 'on', and the only thing that sets it is the page script.
 * A page whose script is dead or threw leaves use_override "", so rows the desk edited to
 * [30, 25, 20] are thrown away: the load arms on the inherited [12.6, 7.2, 6.3] under HTTP 200, and
 * the audit says marginSource 'default'. Ruled repair: shape A, honour the posted rows.
 *
 * What must happen instead: rows that differ from the band the request carries are the band this
 * load is captured on, with or without the flag, and they pass the same gates as a flagged band
 * (rows [10, 7, 3] under a 5% customer minimum need below_min_ack).
 *
 * What must NOT move (green before and after the fix):
 *   - the flagged post (use_override=1) of the same rows arms them;
 *   - an untouched page (the rendered rows posted back, flag "") stays a cost-only capture on the
 *     inherited band: marginSource and the 5% minimum are kept, so on a load capped at 106,000 it
 *     still arms the one bid at the ceiling.
 *
 * Figures: default band [12.6, 7.2, 6.3] min 5, cost 100,000. Inherited ladder
 * [112600, 107200, 106300]; rows [30, 25, 20] give [130000, 125000, 120000]. Ceiling 106,000 sits
 * between the 105,000 guard and 106,300, so the inherited plan there is [106000].
 *
 *   node scripts/test-price-capture-honours-posted-rows.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-posted-rows-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks } = require('../src/web/server');

const COST = '100000';
const INHERITED = [12.6, 7.2, 6.3];
const INHERITED_LADDER = [112600, 107200, 106300];
const EDITED = { m_0: '30', m_1: '25', m_2: '20' };
const EDITED_LADDER = [130000, 125000, 120000];
const CEILING = 106000;

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

// What a browser posts from the rendered #mainForm with nothing touched: every enabled named input.
function mainFormBody(html) {
  const start = html.indexOf('id="mainForm"');
  assert.ok(start >= 0, 'the served page has no #mainForm');
  const end = html.indexOf('</form>', start);
  const body = {};
  const re = /<input\b[^>]*>/g;
  const chunk = html.slice(start, end);
  let tag;
  while ((tag = re.exec(chunk))) {
    const t = tag[0];
    if (/\bdisabled\b/.test(t)) continue;
    const name = /\bname="([^"]+)"/.exec(t);
    const value = /\bvalue="([^"]*)"/.exec(t);
    if (name) body[name[1]] = value ? value[1] : '';
  }
  return body;
}

const now = Date.now();
const mkLoad = (id, ceilingPrice = null) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName: 'Posted Rows Test Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
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

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Fetch the page, take its untouched #mainForm body, apply the desk's edits, post it as a form.
  const submitPage = async (id, edits, ceiling = null) => {
    const r = await requests.createForLoad(mkLoad(id, ceiling));
    const page = await req('GET', `${base}/price/${r.id}`);
    assert.strictEqual(page.status, 200, `GET /price returned ${page.status}`);
    const body = Object.assign(mainFormBody(page.text), { cost: COST }, edits);
    const res = await req('POST', `${base}/price/${r.id}`, { body: form(body) });
    await tick();
    return { r, res, body, doc: await requests.getByToken(r.id), m: armedMonitor(id) };
  };
  const armedLine = (s) => `status ${s.res.status}, doc ${s.doc.status} marginsPct ${JSON.stringify(s.doc.marginsPct)} min ${s.doc.minMarginPct} source ${s.doc.marginSource}, ladder ${JSON.stringify(s.m && s.m.ladder)}`;

  console.log('\n0. the page this is about');
  await check('the served capture page posts its rows m_0..m_2 and a use_override that is empty until the script sets it', async () => {
    const r = await requests.createForLoad(mkLoad('PR-PAGE'));
    const body = mainFormBody((await req('GET', `${base}/price/${r.id}`)).text);
    assert.deepStrictEqual([body.m_0, body.m_1, body.m_2].map(Number), INHERITED);
    assert.strictEqual(body.use_override, '');
  });

  console.log('\n1. rows edited to [30, 25, 20], use_override left ""');
  const edited = await submitPage('PR-EDIT', EDITED);
  await check('the load arms the posted rows [130000, 125000, 120000], not the inherited ladder', async () => {
    assert.ok(edited.res.status < 400, `status ${edited.res.status}: ${edited.res.text.slice(0, 160)}`);
    assert.ok(edited.m, 'no monitor armed');
    assert.deepStrictEqual(edited.m.ladder, EDITED_LADDER, `posted rows dropped: ${armedLine(edited)}`);
  });
  await check('the request records the posted band as this load\'s own: [30, 25, 20], the customer\'s 5% minimum kept (R31c), marginSource bid', async () => {
    assert.deepStrictEqual([edited.doc.marginsPct, edited.doc.minMarginPct, edited.doc.marginSource],
      [[30, 25, 20], 5, 'bid'], armedLine(edited));
  });

  console.log('\n2. rows edited to [10, 7, 3] (below the 5% customer minimum), use_override "", no ack');
  const below = await submitPage('PR-BELOW', { m_0: '10', m_1: '7', m_2: '3' });
  await check('the honoured rows meet the below-minimum gate: 409 BELOW_MINIMUM, nothing armed', async () => {
    assert.strictEqual(below.res.status, 409, `expected 409 BELOW_MINIMUM, got ${armedLine(below)}`);
    assert.strictEqual(below.doc.status, 'awaiting_price');
    assert.strictEqual(below.m, null, `armed ${JSON.stringify(below.m && below.m.ladder)}`);
  });

  console.log('\n3. controls: behaviour that must not move');
  await check('the same edited rows WITH use_override=1 arm [130000, 125000, 120000]', async () => {
    const s = await submitPage('PR-FLAG', Object.assign({ use_override: '1' }, EDITED));
    assert.ok(s.res.status < 400, `status ${s.res.status}`);
    assert.deepStrictEqual(s.m && s.m.ladder, EDITED_LADDER, armedLine(s));
    assert.strictEqual(s.doc.marginSource, 'bid');
  });
  await check('the untouched page (rendered rows, flag "") arms the inherited band and keeps its source and 5% minimum', async () => {
    const s = await submitPage('PR-UNTOUCHED', {});
    assert.ok(s.res.status < 400, `status ${s.res.status}`);
    assert.deepStrictEqual(s.m && s.m.ladder, INHERITED_LADDER, armedLine(s));
    assert.deepStrictEqual([s.doc.marginsPct, s.doc.minMarginPct, s.doc.marginSource], [INHERITED, 5, 'default'], armedLine(s));
  });
  await check('the untouched page on a load capped at 106,000 still arms the one bid at the ceiling [106000]', async () => {
    const s = await submitPage('PR-UNTOUCHED-CAP', {}, CEILING);
    assert.ok(s.res.status < 400, `status ${s.res.status}: ${s.res.text.slice(0, 160)}`);
    assert.deepStrictEqual(s.m && s.m.ladder, [CEILING], armedLine(s));
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - margin rows edited on /price are dropped when use_override is not set (the capture branch reads m_0..m_n only behind the flag the page script sets, so a dead script arms the inherited band under 200):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - rows the desk edited are the band the load is captured on, flag or no flag, and an untouched page stays a cost-only capture`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
