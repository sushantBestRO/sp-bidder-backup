'use strict';
/**
 * A RE-PRICE PAGE SUBMITTED WITH ITS ROWS UNTOUCHED KEEPS THE BAND THE LOAD CARRIES NOW.
 *
 * Regression target: B-1 on the re-price branch. The capture branch judges posted rows against the rows the
 * page rendered (rows_shown), so a page opened before a band change arms the current band. The re-price
 * branch (an armed load) still judges them against the stored band. So when the stored band moved under an
 * open page - another desk captured on a fresh page after a customer save, or the console re-priced the band
 * - the stale page, saved with its rows untouched, arms the rows it happened to show as this load's own band.
 *
 *   node scripts/test-reprice-stale-page-band.js
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
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-reprice-stale-page-'));

const http = require('http');
const { app, requests, stacks, customerStore } = require('../src/web/server');

let pass = 0, fail = 0;
const EXPECTED_CHECKS = 6;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

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
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// The fields the served page would post: every enabled input inside the main form, at its rendered value.
function mainFormBody(html) {
  const start = html.indexOf('id="mainForm"');
  if (start < 0) return null;
  const chunk = html.slice(start, html.indexOf('</form>', start));
  const body = {};
  const re = /<input\b[^>]*>/g;
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

const OLD = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const UP = { marginsPct: [20, 15, 10], minMarginPct: 5 };
const now = Date.now();
const mkLoad = (id, companyName) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName, closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: null, pricingMode: 'flat' },
});
const monitorOf = (loadId) => {
  for (const s of stacks) { const m = s.engine && s.engine.monitors && s.engine.monitors.get(loadId); if (m && !m.finalized) return m; }
  return null;
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (p, body) => req('POST', base + p, { body: JSON.stringify(body), contentType: 'application/json', origin: base });
  const page = async (r) => mainFormBody((await req('GET', `${base}/price/${r.id}`)).text);
  const submit = async (r, body, cost) => {
    const res = await req('POST', `${base}/price/${r.id}`, { body: form(Object.assign({}, body, { cost })) });
    await new Promise((x) => setImmediate(x));
    const d = await requests.getByToken(r.id);
    const m = monitorOf(d.loadId);
    return { status: res.status, doc: d, ladder: m ? m.ladder : null,
      line: `HTTP ${res.status} | ${d.status} ${JSON.stringify(d.marginsPct)} min ${d.minMarginPct} ladder ${JSON.stringify(m && m.ladder)}` };
  };

  console.log('\n1. desk A opens the page, a customer save moves the band, desk B captures on a fresh page, then A saves untouched');
  {
    const c = await customerStore.upsert({ label: 'Stale Two Desks', margin: OLD });
    const r = await requests.createForLoad(mkLoad('RSP-1', c.label));
    const deskA = await page(r);
    if (!deskA || deskA.rows_shown !== '12.6,7.2,6.3') throw new Error(`setup: page A rendered rows_shown ${deskA && deskA.rows_shown}`);
    await api('/api/customers', Object.assign({}, c, { margin: UP }));
    const b = await submit(r, await page(r), '100000');
    if (b.status !== 200 || JSON.stringify(b.doc.marginsPct) !== '[20,15,10]') throw new Error(`setup: desk B did not capture the saved band (${b.line})`);
    const a = await submit(r, deskA, '101000');
    ok(a.status === 200 && JSON.stringify(a.doc.marginsPct) === '[20,15,10]',
      `the load keeps the band it carries now, [20, 15, 10], not the rows page A showed (${a.line})`);
    ok(JSON.stringify(a.ladder) === '[121200,116150,111100]', `and bids it at the new cost Rs 1,01,000 (${a.line})`);
  }

  console.log('\n2. the console re-prices the band under an open re-price page, then the page is saved untouched');
  {
    const c = await customerStore.upsert({ label: 'Stale Console Reprice', margin: OLD });
    const r = await requests.createForLoad(mkLoad('RSP-2', c.label));
    const cap = await submit(r, await page(r), '100000');
    if (cap.status !== 200) throw new Error(`setup: RSP-2 did not arm (${cap.line})`);
    const openPage = await page(r);
    const mr = await api(`/api/price-requests/${r.id}/margin`, { marginsPct: [20, 15, 10], minMarginPct: 5, cost: 100000, confirm: true });
    if (mr.status !== 200) throw new Error(`setup: console re-price answered ${mr.status}`);
    const a = await submit(r, openPage, '102000');
    ok(a.status === 200 && JSON.stringify(a.doc.marginsPct) === '[20,15,10]',
      `the console's band [20, 15, 10] stands (${a.line})`);
    ok(JSON.stringify(a.ladder) === '[122400,117300,112200]', `bid at the new cost Rs 1,02,000 (${a.line})`);
  }

  console.log('\n3. controls: an edited row is honoured, and a page with no rows_shown keeps the stored-band comparison');
  {
    const c = await customerStore.upsert({ label: 'Stale Edited Row', margin: OLD });
    const r = await requests.createForLoad(mkLoad('RSP-3', c.label));
    const deskA = await page(r);
    await api('/api/customers', Object.assign({}, c, { margin: UP }));
    await submit(r, await page(r), '100000');
    const a = await submit(r, Object.assign({}, deskA, { m_0: '14' }), '100000');
    ok(a.status === 200 && JSON.stringify(a.doc.marginsPct) === '[14,7.2,6.3]', `rows the desk changed are the band (${a.line})`);

    const c2 = await customerStore.upsert({ label: 'No Field Page', margin: OLD });
    const r2 = await requests.createForLoad(mkLoad('RSP-4', c2.label));
    await submit(r2, await page(r2), '100000');
    const noField = Object.assign({}, await page(r2));
    delete noField.rows_shown;
    const a2 = await submit(r2, noField, '103000');
    ok(a2.status === 200 && JSON.stringify(a2.doc.marginsPct) === '[12.6,7.2,6.3]',
      `an untouched page with no rows_shown keeps the stored band (${a2.line})`);
  }

  server.close();
  if (fail || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED: ${fail} failing, ran ${pass} of ${EXPECTED_CHECKS} checks - a stale re-price page saved untouched arms the rows it showed`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
