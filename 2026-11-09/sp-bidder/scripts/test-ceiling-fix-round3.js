'use strict';
/**
 * THIRD ROUND ON THE CEILING CORRECTIVE (verification of 0ecdeb8).
 *
 *   A. A per-truck-type rate typed UNDER the load's hard cost floor no longer makes the page say no
 *      cost fits. The fit starts from that rate lifted to the floor, so [110,000, 30,000] and
 *      [110,000, 37,999] at cap 90,500 (floor Rs 38,000) both offer 92,032 / 38,000, and those rates
 *      submit. The server's answer to the typed rates is the hard-floor refusal, not "no cost fits".
 *   B. A form reopened from a refusal link carries the desk's below-minimum acknowledgement once. The
 *      page adopts it and disables the hidden copy, so its own stamp is the only one posted; and a
 *      body that does carry it twice is still an acknowledgement.
 *   C. The GET page whose closed-record read failed is headed for opening a page, not for a save.
 *
 *   node scripts/test-ceiling-fix-round3.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '10';
process.env.SP_MARGINS_PCT = '9,5,3';
process.env.SP_MIN_MARGIN_PCT = '3';
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceil-round3-'));

const http = require('http');
const vm = require('vm');
const { app, requests, store } = require('../src/web/server');
const { cargoTypeList } = require('../src/platform/gocometCargo');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const F = 'application/x-www-form-urlencoded';

function req(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = F; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: b })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const enc = (pairs) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const text = (res) => res.text.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const fixLink = (html) => { const m = /<a class="efix" href="([^"]+)">([^<]+)<\/a>/.exec(html || ''); return m ? { href: m[1].replace(/&amp;/g, '&'), label: m[2] } : null; };
// What a browser posts from the page's main form with no script: every named, enabled input.
function formPairs(html) {
  const f = /<form[^>]*id="mainForm"[^>]*>([\s\S]*?)<\/form>/.exec(html);
  const out = [];
  for (const m of (f ? f[1] : '').matchAll(/<input\b([^>]*)>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    if (!name || /\sdisabled(\s|=|$)/.test(m[1])) continue;
    const v = /\bvalue="([^"]*)"/.exec(m[1]);
    out.push([name[1], v ? v[1].replace(/&amp;/g, '&') : '']);
  }
  return out;
}
function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, out = '';
  while ((m = re.exec(html))) out += m[1] + '\n';
  return out;
}
function fnSrc(js, name) {
  const at = js.indexOf(`function ${name}(`);
  if (at < 0) return null;
  let depth = 0;
  for (let k = js.indexOf('{', at); k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(at, k + 1);
  }
  return null;
}
const varSrc = (js, n) => { const m = js.match(new RegExp(`(?:var |,)${n}=([^,;\\n]+)`)); if (!m) throw new Error(`no ${n}`); return m[1]; };

function perTypeNote(html, rates) {
  const js = inlineScripts(html);
  const fns = ['num', 'priceOf', 'cval', 'rowsGovern', 'lowestRow', 'guardPctNow', 'ceilBinding', 'rowPrices', 'ceilSplit', 'ceilDead',
    'ceilReason', 'fitRatesToTarget', 'ceilFixRates', 'ceilCostTarget', 'ceilEl', 'ceilRender', 'ptInput'].map((n) => fnSrc(js, n)).filter(Boolean);
  const served = [...html.matchAll(/name="m_\d+" value="([^"]*)"/g)].map((m) => m[1]);
  const counts = [...html.matchAll(/class="mvtr" data-count="([^"]*)"/g)].map((m) => Number(m[1]));
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: '', hidden: true, getAttribute: () => null, classList: { add() {}, remove() {}, toggle() {} } });
  const ins = rates.map((v) => ({ value: String(v) }));
  const blend = Math.round(rates.reduce((s, v, i) => s + v * counts[i], 0) / counts.reduce((a, b) => a + b, 0));
  const ctx = { document: { getElementById: el }, nf: new Intl.NumberFormat('en-IN'), cost: { value: String(blend) }, over: { value: '' },
    rows: served.map((v) => ({ querySelector: (s) => (s === '.mpct' ? { value: v } : null), classList: { add() {}, remove() {} } })),
    ptRows: counts.map((c, i) => ({ getAttribute: () => String(c), querySelector: () => ins[i] })) };
  vm.createContext(ctx);
  vm.runInContext(['REPRICE', 'CEILING', 'CEILSTATE', 'GUARDPCT', 'CUSTMIN', 'HARDFLOOR'].map((n) => `var ${n}=${varSrc(js, n)};`).join('\n')
    + '\n' + fns.join('\n') + '\nceilRender();', ctx);
  const t = vm.runInContext('ceilCostTarget()', ctx);
  return { fix: el('ceilFix').hidden ? null : el('ceilFix').textContent, why: el('ceilWhy').textContent,
    rates: t == null ? null : vm.runInContext(`ceilFixRates(${t})`, ctx) };
}

const TYPES = cargoTypeList(["5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck", "1 x 20FTODC (LxWXH - 20'x8'x8'8\") 10 Ton Truck"]);
let seq = 0;
const mkLoad = (over = {}) => ({
  id: `CR3-${++seq}`, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: 30_000, minDecrement: 100 }, ...over,
});

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nA. a typed rate under the hard floor');
  for (const typed of [[110000, 30000], [110000, 37999]]) {
    const r = await requests.createForLoad(mkLoad({ units: 6, cargoLines: 2, cargoTypes: TYPES, distanceKm: 3800,
      rules: { ceilingPrice: 90_500, minDecrement: 100 } }));
    await store.patchDoc('priceRequests', r.id, { marginsPct: [9, 5, 1], minMarginPct: 1 });
    const html = (await req('GET', `${base}/price/${r.id}`)).text;
    const note = perTypeNote(html, typed);
    ok(note.fix === 'Use Rs 83,027' && JSON.stringify(note.rates) === '[92032,38000]',
      `${typed.join(' / ')}: the page offers Rs 83,027 as 92,032 / 38,000 (${JSON.stringify(note)})`);
    const refused = await req('POST', `${base}/price/${r.id}`, enc([['cost', '1'], ['cost_type_0', String(typed[0])], ['cost_type_1', String(typed[1])]]));
    ok(refused.status === 400 && /looks too low for this load/.test(text(refused)) && !/No cost can bid/.test(text(refused)),
      `${typed.join(' / ')}: the server answers the typed rates with the hard-floor refusal (${text(refused).slice(0, 160)})`);
    const done = await req('POST', `${base}/price/${r.id}`, enc([['cost', '1'], ['cost_type_0', '92032'], ['cost_type_1', '38000']]));
    ok(done.status === 200, `${typed.join(' / ')}: the offered rates submit (HTTP ${done.status}: ${text(done).slice(0, 120)})`);
  }

  console.log('\nB. the reopened form posts its acknowledgement once, and a doubled one still counts');
  {
    const r = await requests.createForLoad(mkLoad());
    const refused = await req('POST', `${base}/price/${r.id}`,
      'cost=29900&m_0=2&m_1=1.5&m_2=1&rows_shown=9%2C5%2C3&below_min_ack=1');
    const link = fixLink(refused.text);
    const page = (await req('GET', base + link.href)).text;
    ok(/<input type="hidden" id="prefillAck" name="below_min_ack" value="1">/.test(page), 'the reopened form carries the acknowledgement for a no-script submit');

    const js = inlineScripts(page);
    const adopt = fnSrc(js, 'adoptPrefillAck');
    const input = { disabled: false };
    const ctx = { document: { getElementById: (id) => (id === 'prefillAck' ? input : null) }, minAckdAt: null,
      belowMin: () => true, lowestRow: () => 1 };
    vm.createContext(ctx);
    if (adopt) vm.runInContext(`${adopt}\nadoptPrefillAck();`, ctx);
    ok(input.disabled === true && ctx.minAckdAt === 1,
      `the script adopts it and disables the hidden copy (disabled ${input.disabled}, acknowledged at ${ctx.minAckdAt})`);
    ok(/adoptPrefillAck\(\);/.test(js), 'and the page calls it on load');

    const doubled = formPairs(page).concat([['below_min_ack', '1']]);
    const done = await req('POST', `${base}/price/${r.id}`, enc(doubled));
    ok(done.status === 200, `a body carrying the acknowledgement twice is accepted (HTTP ${done.status}: ${text(done).slice(0, 160)})`);
  }

  console.log('\nC. GET with a failed closed-record read');
  {
    const r = await requests.createForLoad(mkLoad());
    const realGet = store.getDoc.bind(store);
    store.getDoc = async (coll, id) => { if (coll === 'closedBids') throw new Error('disk read failed'); return realGet(coll, id); };
    const page = await req('GET', `${base}/price/${r.id}`);
    store.getDoc = realGet;
    const h1 = (/<h1>([^<]*)<\/h1>/.exec(page.text) || [])[1];
    const st = (/<div class="enote"><div class="st">([^<]*)<\/div>/.exec(page.text) || [])[1];
    ok(page.status === 503 && h1 === 'Could not load this page' && st === 'Try again' && /Could not check this load\. Try again\./.test(page.text),
      `HTTP ${page.status}, heading "${h1}", label "${st}"`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
