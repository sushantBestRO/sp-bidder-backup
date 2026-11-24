'use strict';
/**
 * THE /price PAGE SCRIPT UNDER A BINDING CEILING: THE ONE-BID NOTE, THE CAPPED SUMMARY, AND THE GUARD
 * ITS VERDICT JUDGES ON.
 *
 * Three client-side behaviours of the /price page that no other test executes:
 *   A. the ceiling note - when every price is above the ceiling and the load is still biddable, one
 *      bid goes out at the ceiling, and the note says so ("All 3 prices are above Rs X. One bid goes
 *      out, at Rs X." / "Your price is above Rs X. One bid goes out, at Rs X.") instead of describing
 *      a walk that starts at the ceiling;
 *   B. the band summary - under a binding ceiling it lists the prices that go out, each capped at the
 *      ceiling and deduped (sentPrices), not the typed prices;
 *   C. the guard the ceiling verdict judges on (guardPctNow) - rows the desk has typed keep the
 *      customer minimum as their guard unless the lowest row is below it, the server's
 *      withCustomerMinimum rule, so a ceiling between that guard and the lowest row is not "Price too
 *      high".
 *
 * Controls (the same before and after any of them): the partial-cap sentence, the all-under
 * sentence, the typed-price summary with no price above the ceiling and on a dead load, a cost dead
 * on the customer minimum, and an untouched capture page.
 *
 * The functions are lifted out of the SERVED page (brace-matched, byte for byte) and run on stub
 * rows, the same approach as test-price-page-confirm.js. Where a check types rows or a cost, it is
 * what the desk would type into that page.
 *
 * Figures: default band [12.6, 7.2, 6.3] minimum 5, so the customer minimum is 5. Ceiling 105,500.
 *   rows [13, 7.2, 6.3] at 100,000 -> [113000, 107200, 106300], guard 105,000 -> one bid at 105,500
 *   rows [8, 5.2, 5]    at 100,000 -> [108000, 105200, 105000] -> goes out as 105,500 / 105,200 / 105,000
 *   rows [13, 7.2, 6.3] at 90,000  -> [101700, 96480, 95670], all under the ceiling
 *   rows [13, 7.2, 6.3] at 101,000 -> [114130, 108272, 107363], guard 106,050 above the ceiling: dead
 *   one row [8]         at 100,000 -> 108,000, guard 105,000 -> one bid at 105,500
 *
 *   node scripts/test-price-page-one-bid-note-and-summary.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-one-bid-note-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const { app, requests, stacks } = require('../src/web/server');

const COST = '100000';
const CEILING = 105500;
const EDITED = ['13', '7.2', '6.3'];
const PARTIAL = ['8', '5.2', '5'];
const NEUTRAL_HEAD = 'Customer will not pay above Rs 1,05,500';

function req(method, url, { body = null, contentType = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const said = (res) => (res.json ? `${res.json.code || ''} ${res.json.error || ''}`.trim() : res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160));

// ---- the served page, executed -------------------------------------------------------------
function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, out = '';
  while ((m = re.exec(html))) out += m[1] + '\n';
  return out;
}
// One function declaration, brace-matched. Null when the page does not define it; the page's own
// functions only ever call what the page defines.
function fnSrc(js, name) {
  const head = `function ${name}(`;
  const at = js.indexOf(head);
  if (at < 0) return null;
  if (js.indexOf(head, at + 1) >= 0) throw new Error(`the served page defines ${name} twice`);
  let depth = 0;
  for (let k = js.indexOf('{', at); k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(at, k + 1);
  }
  throw new Error(`unterminated function ${name} in the served page`);
}
function varSrc(js, name) {
  const m = js.match(new RegExp(`(?:var |,)${name}=([^,;\\n]+)`));
  if (!m) throw new Error(`the served page has no ${name}`);
  return m[1];
}
const OPTIONAL_FNS = ['guardPctNow', 'sentPrices'];
const PAGE_FNS = ['num', 'priceOf', 'cval', 'rowsGovern', 'lowestRow', 'ceilBinding', 'rowPrices', 'ceilSplit', 'ceilDead',
  'ceilReason', 'ceilCostTarget', 'ceilEl', 'ceilRender', 'footer', ...OPTIONAL_FNS];
/**
 * The page as the desk has it: the served constants and functions, the served cost and rows unless
 * the desk types others, and the use_override flag the page flips when a row is edited. Runs the
 * ceiling note and the band summary the way the page does on every keystroke.
 */
function runPage(html, { cost = null, rows = null, edited = false } = {}) {
  const js = inlineScripts(html);
  const lifted = PAGE_FNS.map((n) => [n, fnSrc(js, n)]);
  const missing = lifted.filter(([n, s]) => s == null && !OPTIONAL_FNS.includes(n)).map(([n]) => n);
  if (missing.length) throw new Error(`the served page has no ${missing.join(', ')}`);
  const costAttr = html.match(/<input id="cost"[^>]*\bvalue="([^"]*)"/);
  if (!costAttr) throw new Error('the served page has no cost input');
  const served = [...html.matchAll(/name="m_(\d+)" value="([^"]*)"/g)].map((m) => m[2]);
  if (!served.length) throw new Error('the served page has no margin rows');
  if (rows && rows.length !== served.length) throw new Error(`the page has ${served.length} rows, not ${rows.length}`);
  const neutral = html.match(/id="ceilHead" data-neutral="([^"]*)"/);
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, textContent: '', hidden: true,
    getAttribute: (a) => (id === 'ceilHead' && a === 'data-neutral' && neutral ? neutral[1] : null),
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const noop = () => {};
  const ctx = {
    ptRows: [],
    document: { getElementById: el },
    nf: new Intl.NumberFormat('en-IN'),
    cost: { value: cost != null ? String(cost) : costAttr[1] },
    over: { value: edited ? '1' : '' },
    foot: { style: {}, className: '', textContent: '' },
    brange: { textContent: '' },
    mvSum: noop, syncCeiling: noop, zmRender: noop, previewLadder: noop,
    rows: (rows || served).map((v) => ({ querySelector: (s) => (s === '.mpct' ? { value: v } : null), classList: { add() {}, remove() {} } })),
  };
  vm.createContext(ctx);
  vm.runInContext(['REPRICE', 'CEILING', 'CEILSTATE', 'GUARDPCT', 'CUSTMIN', 'HARDFLOOR'].map((n) => `var ${n}=${varSrc(js, n)};`).join('\n')
    + '\n' + lifted.filter(([, s]) => s).map(([, s]) => s).join('\n'), ctx);
  vm.runInContext('ceilRender();footer();', ctx);
  const cv = vm.runInContext('cval()', ctx);
  return {
    CUSTMIN: vm.runInContext('CUSTMIN', ctx), REPRICE: vm.runInContext('REPRICE', ctx),
    reason: vm.runInContext(`ceilReason(${cv})`, ctx),
    head: el('ceilHead').textContent, note: el('ceilVerdict').textContent,
    fix: el('ceilFix').hidden ? null : el('ceilFix').textContent, summary: ctx.brange.textContent,
  };
}
const show = (v) => `reason ${v.reason}, head "${v.head}", note "${v.note}", summary "${v.summary}"${v.fix ? `, fix "${v.fix}"` : ''}`;

const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Vapi', destination: 'Nagpur' }, equipment: '32 Feet', units: 1,
  companyName: 'One Bid Note Test Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: CEILING, pricingMode: 'flat', minDecrement: 100 },
});
const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};
const tick = () => new Promise((r) => setImmediate(r));

let checks = 0;
const failures = [];
function check(label, fn) {
  checks++;
  try { fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const armedPage = async (loadId, body, ladder) => {
    const r = await requests.createForLoad(mkLoad(loadId));
    const res = await req('POST', `${base}/price/${r.id}`, { body: JSON.stringify({ cost: COST, ...body }) });
    await tick();
    assert.ok(res.status < 400, `setup: the capture of ${loadId} was refused ${res.status}: ${said(res)}`);
    assert.deepStrictEqual(liveMonitor(loadId) && liveMonitor(loadId).ladder, ladder, `setup: ${loadId} armed ladder`);
    const page = await req('GET', `${base}/price/${r.id}`);
    assert.ok(page.status === 200 && /var REPRICE=true/.test(page.text), `setup: ${loadId} re-price page ${page.status}`);
    return page.text;
  };
  // The server bids each of these once, at the ceiling.
  const three = await armedPage('OB-THREE', { use_override: '1', m_0: '13', m_1: '7.2', m_2: '6.3' }, [CEILING]);
  const one = await armedPage('OB-ONE', { marginOverride: { marginsPct: [8], minMarginPct: 5 } }, [CEILING]);
  const capR = await requests.createForLoad(mkLoad('OB-CAPTURE'));
  const capRes = await req('GET', `${base}/price/${capR.id}`);
  assert.ok(capRes.status === 200 && /var REPRICE=false/.test(capRes.text), `setup: capture page ${capRes.status}`);
  const capture = capRes.text;
  const threeV = runPage(three);
  assert.strictEqual(threeV.CUSTMIN, 5, 'setup: the re-price page inlines the customer minimum');

  console.log('\nA. the ceiling note when every price is above the ceiling');
  check('three prices above Rs 1,05,500: the note reads "All 3 prices are above Rs 1,05,500. One bid goes out, at Rs 1,05,500."', () => {
    assert.strictEqual(threeV.note, 'All 3 prices are above Rs 1,05,500. One bid goes out, at Rs 1,05,500.', show(threeV));
  });
  check('one price above Rs 1,05,500: the note reads "Your price is above Rs 1,05,500. One bid goes out, at Rs 1,05,500."', () => {
    const v = runPage(one);
    assert.strictEqual(v.note, 'Your price is above Rs 1,05,500. One bid goes out, at Rs 1,05,500.', show(v));
  });
  check('control: rows [8, 5.2, 5], one price above - the partial-cap sentence is unchanged', () => {
    const v = runPage(three, { rows: PARTIAL });
    assert.strictEqual(v.note, '1 of 3 prices is above Rs 1,05,500. Bidding starts at Rs 1,05,500 instead.', show(v));
  });
  check('control: cost 90,000, every price under the ceiling - "All 3 prices are under Rs 1,05,500."', () => {
    const v = runPage(three, { cost: 90000 });
    assert.strictEqual(v.note, 'All 3 prices are under Rs 1,05,500.', show(v));
  });

  console.log('\nB. the band summary under a binding ceiling');
  check('three prices above the ceiling: the summary is the one price that goes out, "Rs 1,05,500"', () => {
    assert.strictEqual(threeV.summary, 'Rs 1,05,500', show(threeV));
  });
  check('rows [8, 5.2, 5]: the summary caps the top price, "Rs 1,05,500 → 1,05,200 → 1,05,000"', () => {
    const v = runPage(three, { rows: PARTIAL });
    assert.strictEqual(v.summary, 'Rs 1,05,500 → 1,05,200 → 1,05,000', show(v));
  });
  check('control: with no price above the ceiling, and on a dead load, the summary lists the typed prices', () => {
    const under = runPage(three, { cost: 90000 });
    assert.strictEqual(under.summary, 'Rs 1,01,700 → 96,480 → 95,670', show(under));
    const dead = runPage(three, { cost: 101000 });
    assert.ok(dead.reason === 'margin', `precondition: cost 101,000 is dead: ${show(dead)}`);
    assert.strictEqual(dead.summary, 'Rs 1,14,130 → 1,08,272 → 1,07,363', show(dead));
  });

  console.log('\nC. the guard the ceiling verdict judges on');
  check('re-price page, rows [13, 7.2, 6.3] at 100,000: no verdict against the load, the neutral heading, no fix', () => {
    assert.ok(threeV.reason === null && threeV.head === NEUTRAL_HEAD && threeV.fix === null,
      `the re-price page judges its rows on the lowest row, not the customer minimum: ${show(threeV)}`);
  });
  check('capture page, the desk edits the rows to [13, 7.2, 6.3] and types 100,000: no verdict against the load', () => {
    const v = runPage(capture, { cost: 100000, rows: EDITED, edited: true });
    assert.ok(v.reason === null && v.head === NEUTRAL_HEAD && v.fix === null,
      `the capture page judges the edited rows on the lowest row, not the customer minimum: ${show(v)}`);
  });
  check('control: the same edit at 101,000 (dead on the customer minimum too) reads "Price too high"', () => {
    const v = runPage(capture, { cost: 101000, rows: EDITED, edited: true });
    assert.ok(v.reason === 'margin' && v.head === 'Price too high', show(v));
  });
  check('control: the untouched capture page at 100,000 (its own band) has no verdict against the load', () => {
    const v = runPage(capture, { cost: 100000 });
    assert.ok(v.reason === null && v.head === NEUTRAL_HEAD, show(v));
  });

  for (const s of stacks) { try { if (s.engine) s.engine.kill('test done'); } catch (_) {} }
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - the /price page script under a binding ceiling (the ceilRender one-bid note, the footer's capped summary, or the guard ceilReason judges on) no longer matches the one bid the server sends:`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - under a binding ceiling the /price page says one bid, lists the prices that go out, and judges typed rows on the customer minimum`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
