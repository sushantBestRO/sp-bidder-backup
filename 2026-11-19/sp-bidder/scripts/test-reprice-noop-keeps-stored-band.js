'use strict';
/**
 * A RE-PRICE SAVE THAT CHANGES NO MARGIN REWRITES THE STORED MINIMUM (T1 D13, R2-8).
 *
 * The re-price page renders one input per band margin and no minimum. parseBandForm makes the lowest
 * posted row the minimum, and setBidOverride stores it. So opening the link and pressing Save - with
 * the rows untouched, or with only the cost changed - replaces the minimum the load inherited:
 *   - a customer band [12.6, 7.2, 6.3] min 5 comes back as min 6.3. On a load capped at 106,000
 *     (armed as one bid at the ceiling) that turns the Save into a 400 "max bid" refusal;
 *   - a stored band whose minimum sits above its lowest row ([12.6, 7.2, 6.3] min 8, saved before
 *     margins below the minimum were refused) comes back as min 6.3, which the below-minimum gate
 *     then refuses as "6.3% is below this customer's 8% minimum" on a Save the desk did not change.
 *
 * What must happen instead: rows posted exactly as the page rendered them leave the stored margins
 * and minimum as they were, whether or not the cost changed.
 *
 * What must NOT move (green before and after the fix):
 *   - rows the desk edits still set the band, and the customer minimum stays its guard where the
 *     lowest typed row is above it (M0-R31c, ruling 66);
 *   - an edited lowest row below the customer minimum still needs below_min_ack (409 without it).
 *
 * Figures: cost 100,000. Band [12.6, 7.2, 6.3] min 5 arms [112600, 107200, 106300]; capped at
 * 106,000 it arms [106000] (guard 105,000). Band [12.6, 7.2, 6.3] min 8 arms [112600, 108000]
 * (rows below the 108,000 guard are raised to it). Rows [14, 9, 7] arm [114000, 109000, 107000].
 *
 *   node scripts/test-reprice-noop-keeps-stored-band.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-noop-reprice-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const { app, requests, stacks, customerStore } = require('../src/web/server');

const COST = '100000';
const ROWS = [12.6, 7.2, 6.3];
const CEILING = 106000;
const MIN5 = 'Noop Five Shipper';
const MIN8 = 'Noop Legacy Shipper';

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
const mkLoad = (id, companyName, ceilingPrice = null) => ({
  id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, equipment: '32 Feet', units: 1,
  companyName, closesAt: now + 40 * 60_000, startsAt: now - 60_000,
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
const refusal = (res) => { const m = /<div class="sb">([^<]*)<\/div>/.exec(res.text); return m ? m[1].trim().slice(0, 160) : res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); };

let checks = 0;
const failures = [];
const SAME_RATE = /is already the rate on this load\. Nothing to change\./;
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  await customerStore.upsert({ label: MIN5, margin: { marginsPct: ROWS, minMarginPct: 5 } });
  const legacy = { marginsPct: ROWS, minMarginPct: 8 };
  await customerStore.upsert({ label: MIN8, margin: legacy }, { storedMargin: legacy });

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const armLoad = async (id, companyName, ceiling = null) => {
    const r = await requests.createForLoad(mkLoad(id, companyName, ceiling));
    const res = await req('POST', `${base}/price/${r.id}`, json({ cost: COST }));
    await tick();
    assert.ok(res.status < 400, `setup capture of ${id} returned ${res.status}: ${res.text.slice(0, 160)}`);
    return r;
  };
  // Open the re-price link, take the #mainForm body as rendered, apply edits, press Save.
  const savePage = async (r, loadId, edits = {}) => {
    const before = await requests.getByToken(r.id);
    const ladderBefore = armedMonitor(loadId) && armedMonitor(loadId).ladder.slice();
    const page = await req('GET', `${base}/price/${r.id}`);
    assert.strictEqual(page.status, 200, `GET /price returned ${page.status}`);
    const body = Object.assign(mainFormBody(page.text), edits);
    const res = await req('POST', `${base}/price/${r.id}`, { body: form(body) });
    await tick();
    const after = await requests.getByToken(r.id);
    const m = armedMonitor(loadId);
    return { before, after, res, body, ladderBefore, ladder: m && m.ladder,
      line: `status ${res.status}${res.status >= 400 ? ` (${refusal(res)})` : ''}, stored ${JSON.stringify(after.marginsPct)} min ${after.minMarginPct} (price.min ${after.price && after.price.minMarginPct}), ladder ${JSON.stringify(m && m.ladder)}` };
  };

  console.log('\n0. the loads these checks save');
  const a = await armLoad('NR-A', MIN5);
  const b = await armLoad('NR-B', MIN5, CEILING);
  const c = await armLoad('NR-C', MIN8);
  await check('customer band [12.6, 7.2, 6.3] min 5 arms [112600, 107200, 106300]; capped at 106,000 it arms [106000]; legacy min 8 arms [112600, 108000]', async () => {
    assert.deepStrictEqual(armedMonitor('NR-A').ladder, [112600, 107200, 106300]);
    assert.deepStrictEqual(armedMonitor('NR-B').ladder, [CEILING]);
    assert.deepStrictEqual(armedMonitor('NR-C').ladder, [112600, 108000]);
    assert.deepStrictEqual([a.minMarginPct, c.minMarginPct], [5, 8]);
  });

  console.log('\n1. Save pressed on the re-price page with the rows untouched');
  const sa = await savePage(a, 'NR-A');
  // Named reversal (owner ruling 26 Sep): Save with the rate AND the rows untouched is a same-rate
  // re-save, refused on the page with nothing written. D13's invariant still holds - the stored
  // minimum is not rewritten and no max-bid or below-minimum refusal is raised - and the cost-changed
  // Save below still carries the original regression.
  await check('min-5 band: refused as a same-rate re-save, and the stored margins and minimum are unchanged ([12.6, 7.2, 6.3] min 5)', async () => {
    assert.ok(sa.res.status === 409 && SAME_RATE.test(sa.line), `status ${sa.line}`);
    assert.deepStrictEqual([sa.after.marginsPct, sa.after.minMarginPct, sa.after.price.minMarginPct], [ROWS, 5, 5], `minimum rewritten: ${sa.line}`);
    assert.deepStrictEqual(sa.ladder, sa.ladderBefore, sa.line);
  });
  const sa2 = await savePage(a, 'NR-A', { cost: '98000' });
  await check('min-5 band, only the cost changed to 98,000: minimum stays 5', async () => {
    assert.ok(sa2.res.status < 400, `status ${sa2.line}`);
    assert.deepStrictEqual([sa2.after.price.cost, sa2.after.minMarginPct, sa2.after.price.minMarginPct], [98000, 5, 5], `minimum rewritten: ${sa2.line}`);
  });
  const sb = await savePage(b, 'NR-B');
  await check('min-5 band capped at 106,000: the untouched Save is refused as a same-rate re-save, not as "max bid", and the ladder stays [106000]', async () => {
    assert.ok(sb.res.status === 409 && SAME_RATE.test(sb.line), `untouched Save not refused as same-rate: ${sb.line}`);
    assert.deepStrictEqual(sb.ladder, [CEILING], sb.line);
    assert.strictEqual(sb.after.minMarginPct, 5, sb.line);
  });
  const sc = await savePage(c, 'NR-C');
  await check('legacy band min 8: the untouched Save is refused as a same-rate re-save, not as below minimum, minimum stays 8, ladder stays [112600, 108000]', async () => {
    assert.ok(sc.res.status === 409 && SAME_RATE.test(sc.line), `untouched Save not refused as same-rate: ${sc.line}`);
    assert.deepStrictEqual([sc.after.minMarginPct, sc.after.price.minMarginPct], [8, 8], sc.line);
    assert.deepStrictEqual(sc.ladder, [112600, 108000], sc.line);
  });

  console.log('\n2. controls: behaviour that must not move');
  // Ruling 66: under M0-R31c an edited band keeps the customer minimum (5) as its guard.
  await check('rows edited to [14, 9, 7] set the band, minimum 5 (the customer minimum stays the guard), ladder [114000, 109000, 107000]', async () => {
    const r = await armLoad('NR-EDIT', MIN5);
    const s = await savePage(r, 'NR-EDIT', { m_0: '14', m_1: '9', m_2: '7' });
    assert.ok(s.res.status < 400, `status ${s.line}`);
    assert.deepStrictEqual([s.after.marginsPct, s.after.minMarginPct], [[14, 9, 7], 5], s.line);
    assert.deepStrictEqual(s.ladder, [114000, 109000, 107000], s.line);
  });
  await check('rows edited to [10, 7, 3] under the 5% customer minimum, no ack: 409 BELOW_MINIMUM, load unchanged', async () => {
    const r = await armLoad('NR-LOW', MIN5);
    const s = await savePage(r, 'NR-LOW', { m_0: '10', m_1: '7', m_2: '3' });
    assert.strictEqual(s.res.status, 409, s.line);
    assert.deepStrictEqual([s.after.marginsPct, s.after.minMarginPct], [ROWS, 5], s.line);
    assert.deepStrictEqual(s.ladder, s.ladderBefore, s.line);
  });

  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a re-price Save with the margin rows untouched rewrites the stored minimum (the page renders the rows and no minimum, and parseBandForm makes the lowest row the minimum):`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - an untouched re-price Save keeps the stored margins and minimum, and edited rows still set the band`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
