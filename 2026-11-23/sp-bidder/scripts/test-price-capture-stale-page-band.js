'use strict';
/**
 * AN UNTOUCHED PRICE PAGE OPENED BEFORE A CONSOLE BAND SAVE ARMS THE OLD ROWS AS ITS OWN (B-1).
 *
 * A console save of a customer's margin re-snapshots every request still awaiting a price (M0-F6).
 * A /price page opened before that save still shows, and posts, the rows it rendered. The capture
 * counts rows as edited when they differ from the band the request carries NOW (T1 D6), so the
 * untouched old rows [12.6, 7.2, 6.3] read as a desk edit: the load arms them as a per-load 'bid'
 * band nobody set, instead of the saved [20, 15, 10]. With the saved minimum raised to 8 the same
 * untouched page is refused as below the customer's minimum.
 *
 * What must happen instead: the page carries the band it rendered, and rows equal to that band are
 * untouched, so the capture arms the band the request carries now.
 *
 * What must NOT move (green before and after the fix):
 *   - a page opened after the save arms the saved band;
 *   - a row the desk did edit on the old page is honoured as this load's band (T1 D6);
 *   - a page with no record of what it rendered, or a garbled one, posting the stored rows untouched
 *     arms the stored band under its own source.
 *
 * Figures: cost 100,000. Old band [12.6, 7.2, 6.3] min 5 arms [112600, 107200, 106300]; saved
 * [20, 15, 10] arms [120000, 115000, 110000].
 *
 *   node scripts/test-price-capture-stale-page-band.js
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
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stale-page-band-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, customerStore } = require('../src/web/server');

const COST = '100000';
const OLD = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const OLD_LADDER = [112600, 107200, 106300];
const UP = { marginsPct: [20, 15, 10], minMarginPct: 5 };
const UP_MIN8 = { marginsPct: [20, 15, 10], minMarginPct: 8 };
const UP_LADDER = [120000, 115000, 110000];

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
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });

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
const rowNames = (body) => Object.keys(body).filter((k) => /^m_\d+$/.test(k));
// What a page served before this change posts: its rows, cost and flags, and nothing else hidden.
const withoutRenderedRecord = (body) => {
  const keep = new Set([...rowNames(body), 'cost', 'use_override', 'low_cost_ack', 'ceiling_ack', 'below_min_ack']);
  return Object.fromEntries(Object.entries(body).filter(([k]) => keep.has(k)));
};

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
  const pageFor = async (r) => mainFormBody((await req('GET', `${base}/price/${r.id}`)).text);
  const submit = async (r, body) => {
    const res = await req('POST', `${base}/price/${r.id}`, { body: form(Object.assign({}, body, { cost: COST })) });
    await tick();
    const doc = await requests.getByToken(r.id);
    const m = armedMonitor(doc.loadId);
    return { res, doc, m, line: `HTTP ${res.status}, ${doc.status} ${JSON.stringify(doc.marginsPct)} min ${doc.minMarginPct} source ${doc.marginSource}, ladder ${JSON.stringify(m && m.ladder)}` };
  };
  // A customer on OLD with one load waiting; the page is opened, then the console saves `saved`.
  const stalePage = async (label, loadId, saved) => {
    const c = await customerStore.upsert({ label, margin: OLD });
    const r = await requests.createForLoad(mkLoad(loadId, c.label));
    const page = await pageFor(r);
    assert.deepStrictEqual(rowNames(page).map((k) => Number(page[k])), OLD.marginsPct, 'setup: the page shows the old rows');
    const sv = await api('/api/customers', Object.assign({}, c, { margin: saved }));
    assert.strictEqual(sv.status, 200, `setup: the console save answered ${sv.status}`);
    const d = await requests.getByToken(r.id);
    assert.deepStrictEqual([d.marginsPct, d.minMarginPct], [saved.marginsPct, saved.minMarginPct], 'setup: the save re-snapshotted the waiting load');
    return { c, r, page };
  };

  console.log('\n1. page opened on [12.6, 7.2, 6.3], console saves [20, 15, 10], page submitted untouched');
  const a = await stalePage('Stale Page Shipper', 'SPB-STALE', UP);
  const sa = await submit(a.r, a.page);
  await check('the load arms the saved band [120000, 115000, 110000], not the rows the page happened to show', async () => {
    assert.ok(sa.res.status < 400, sa.line);
    assert.deepStrictEqual(sa.m && sa.m.ladder, UP_LADDER, `stale rows armed: ${sa.line}`);
  });
  await check('the request keeps the saved band under the customer\'s source, not a per-load band nobody set', async () => {
    assert.deepStrictEqual([sa.doc.marginsPct, sa.doc.minMarginPct, sa.doc.marginSource],
      [UP.marginsPct, UP.minMarginPct, `customer:${a.c.customerId}`], sa.line);
  });

  console.log('\n2. the same, with the saved minimum raised to 8');
  const b = await stalePage('Stale Page Min Shipper', 'SPB-STALE-MIN', UP_MIN8);
  const sb = await submit(b.r, b.page);
  await check('the untouched page is not refused as below the new 8% minimum; it arms [120000, 115000, 110000] min 8', async () => {
    assert.ok(sb.res.status < 400, `refused: ${sb.line}`);
    assert.deepStrictEqual([sb.m && sb.m.ladder, sb.doc.minMarginPct, sb.doc.marginSource],
      [UP_LADDER, 8, `customer:${b.c.customerId}`], sb.line);
  });

  console.log('\n3. controls: behaviour that must not move');
  await check('a page opened after the save arms the saved band', async () => {
    const r = await requests.createForLoad(mkLoad('SPB-FRESH', a.c.label));
    const s = await submit(r, await pageFor(r));
    assert.deepStrictEqual([s.m && s.m.ladder, s.doc.marginSource], [UP_LADDER, `customer:${a.c.customerId}`], s.line);
  });
  await check('a row the desk edited on the old page (7.2 -> 8, flag "") is honoured: [112600, 108000, 106300], source bid', async () => {
    const d = await stalePage('Stale Page Edit Shipper', 'SPB-EDIT', UP);
    const s = await submit(d.r, Object.assign({}, d.page, { m_1: '8' }));
    assert.ok(s.res.status < 400, s.line);
    assert.deepStrictEqual([s.m && s.m.ladder, s.doc.marginsPct, s.doc.marginSource],
      [[112600, 108000, 106300], [12.6, 8, 6.3], 'bid'], s.line);
  });
  await check('a page with no record of what it rendered, posting the stored rows untouched, arms the stored band under its source', async () => {
    const c = await customerStore.upsert({ label: 'Legacy Page Shipper', margin: OLD });
    const r = await requests.createForLoad(mkLoad('SPB-LEGACY', c.label));
    const s = await submit(r, withoutRenderedRecord(await pageFor(r)));
    assert.deepStrictEqual([s.m && s.m.ladder, s.doc.marginSource], [OLD_LADDER, `customer:${c.customerId}`], s.line);
  });
  await check('a garbled record of what it rendered is ignored the same way', async () => {
    const c = await customerStore.upsert({ label: 'Garbled Page Shipper', margin: OLD });
    const r = await requests.createForLoad(mkLoad('SPB-GARBLED', c.label));
    const page = withoutRenderedRecord(await pageFor(r));
    const s = await submit(r, Object.assign(page, { rows_shown: 'x,,|' }));
    assert.deepStrictEqual([s.m && s.m.ladder, s.doc.marginSource], [OLD_LADDER, `customer:${c.customerId}`], s.line);
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - an untouched /price page opened before a console band save arms its old rows as a per-load band (the capture compares posted rows to the re-snapshotted band, not to the band the page showed):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - an untouched page arms the band the request carries now, and rows the desk edited are still honoured`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
