'use strict';
/**
 * SECOND ROUND ON THE CEILING CORRECTIVE AND THE BOOKED-LOAD GATE (verification of 5482237).
 *
 *   A. Per-truck-type loads: the page and the server offer the same rates, found by one rule that
 *      keeps every rate at or above the load's hard cost floor. The offered rates always submit, and
 *      "no cost fits" is said only when none does. Figures: floor Rs 38,000 (Rs 10/km x 3,800 km),
 *      cap 90,500, rates 100,000 x 5 / 40,000 x 1. Scaling both lands the small type at 36,900, under
 *      the floor; the fit keeps it at 38,000 and takes the rest off the other: 92,032 / 38,000.
 *   B. Edited margins: the refusal's link carries the rows the desk posted, so the reopened form is
 *      exactly what the figure was computed against, and submitting it as reopened is accepted.
 *   C. The server-drawn re-price note: with no script the control is a real link, and a per-type
 *      load's link carries the fitted rates.
 *   D. The console margin editor (set and clear) refuses a booked load like every other door.
 *   E. A failed read of the closed record refuses with a retry line instead of arming blind.
 *   F. A load booked while a re-price is in flight is refused before the write.
 *   G. A cost typed from a link does not outlive the page: the URL is cleaned on load.
 *
 *   node scripts/test-ceiling-fix-and-booked-round2.js
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
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceil-round2-'));

const http = require('http');
const vm = require('vm');
const { app, requests, store, stacks } = require('../src/web/server');
const { cargoTypeList } = require('../src/platform/gocometCargo');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function req(method, url, { body = null, type = null, origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = type; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, text: b, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const text = (res) => (res.json ? `${res.json.error || ''}` : res.text.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
const fixLink = (html) => { const m = /<a class="efix" href="([^"]+)">([^<]+)<\/a>/.exec(html || ''); return m ? { href: m[1].replace(/&amp;/g, '&'), label: m[2] } : null; };
const inputs = (html, re) => [...html.matchAll(re)].map((m) => m[1]);

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
  throw new Error(`unterminated function ${name}`);
}
const varSrc = (js, n) => { const m = js.match(new RegExp(`(?:var |,)${n}=([^,;\\n]+)`)); if (!m) throw new Error(`no ${n}`); return m[1]; };

/** The served page's ceiling note and its button, run on a per-type form holding these rates. */
function runPerTypeNote(html, rates) {
  const js = inlineScripts(html);
  const fns = ['num', 'priceOf', 'cval', 'rowsGovern', 'lowestRow', 'guardPctNow', 'ceilBinding', 'rowPrices', 'ceilSplit', 'ceilDead',
    'ceilReason', 'fitRatesToTarget', 'ceilFixRates', 'ceilCostTarget', 'ceilEl', 'ceilRender', 'ptInput'].map((n) => fnSrc(js, n)).filter(Boolean);
  const served = inputs(html, /name="m_\d+" value="([^"]*)"/g);
  const counts = inputs(html, /class="mvtr" data-count="([^"]*)"/g).map(Number);
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: '', hidden: true, getAttribute: () => null, classList: { add() {}, remove() {}, toggle() {} } });
  const ptInputs = rates.map((v) => ({ value: String(v) }));
  const blend = Math.round(rates.reduce((s, v, i) => s + v * counts[i], 0) / counts.reduce((a, b) => a + b, 0));
  const ctx = {
    document: { getElementById: el }, nf: new Intl.NumberFormat('en-IN'), cost: { value: String(blend) }, over: { value: '' },
    rows: served.map((v) => ({ querySelector: (s) => (s === '.mpct' ? { value: v } : null), classList: { add() {}, remove() {} } })),
    ptRows: counts.map((c, i) => ({ getAttribute: () => String(c), querySelector: () => ptInputs[i] })),
  };
  vm.createContext(ctx);
  vm.runInContext(['REPRICE', 'CEILING', 'CEILSTATE', 'GUARDPCT', 'CUSTMIN', 'HARDFLOOR'].map((n) => `var ${n}=${varSrc(js, n)};`).join('\n')
    + '\n' + fns.join('\n') + '\nceilRender();', ctx);
  const t = vm.runInContext('ceilCostTarget()', ctx);
  return { fix: el('ceilFix').hidden ? null : el('ceilFix').textContent, why: el('ceilWhy').textContent,
    rates: t == null || !vm.runInContext('typeof ceilFixRates', ctx).startsWith('f') ? null : vm.runInContext(`ceilFixRates(${t})`, ctx) };
}

const TYPES = cargoTypeList(["5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck", "1 x 20FTODC (LxWXH - 20'x8'x8'8\") 10 Ton Truck"]);
let seq = 0;
const mkLoad = (over = {}) => ({
  id: `CR2-${++seq}`, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: 30_000, minDecrement: 100 }, ...over,
});
const perTypeLoad = (over = {}) => mkLoad({ units: 6, cargoLines: 2, cargoTypes: TYPES, distanceKm: 3800,
  rules: { ceilingPrice: 90_500, minDecrement: 100 }, ...over });
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = stacks[0].engine;
  const postForm = (r, obj) => req('POST', `${base}/price/${r.id}`, { body: form(obj), type: 'application/x-www-form-urlencoded' });
  const postJson = (r, obj) => req('POST', `${base}/price/${r.id}`, { body: JSON.stringify(obj), type: 'application/json' });
  const api = (url, obj) => req('POST', base + url, { body: JSON.stringify(obj), type: 'application/json', origin: base });
  const armedEvents = (id) => engine.events.filter((e) => e.type === 'armed' && String(e.auctionId) === id).length;
  const book = async (r) => { await engine._finalize(engine.monitors.get(String(r.loadId)), { myRank: null }); await settle(); };

  console.log('\nA. per-truck-type: the page and the server offer the same rates, and they submit');
  {
    const r = await requests.createForLoad(perTypeLoad());
    const page = (await req('GET', `${base}/price/${r.id}`)).text;
    const note = runPerTypeNote(page, [100000, 40000]);
    ok(note.fix === 'Use Rs 83,027' && JSON.stringify(note.rates) === '[92032,38000]',
      `the note offers Rs 83,027 as 92,032 / 38,000, both over the Rs 38,000 floor (${JSON.stringify(note)})`);
    const refused = await postForm(r, { cost: '90000', cost_type_0: '100000', cost_type_1: '40000' });
    const link = fixLink(refused.text);
    ok(refused.status === 400 && link && /cost_type_0=92032&cost_type_1=38000/.test(link.href) && link.label === 'Use Rs 83,027',
      `the server refusal offers the same rates, not "no cost fits" (${JSON.stringify(link)}; ${text(refused).slice(0, 180)})`);
    const done = await postForm(r, { cost: '1', cost_type_0: '92032', cost_type_1: '38000' });
    ok(done.status === 200, `those rates submit (HTTP ${done.status}: ${text(done).slice(0, 160)})`);

    // Cap 40,000 puts the target at 36,697, under the Rs 38,000 floor for every type.
    const none = await requests.createForLoad(perTypeLoad({ rules: { ceilingPrice: 40_000, minDecrement: 100 } }));
    const nonePage = (await req('GET', `${base}/price/${none.id}`)).text;
    const noneNote = runPerTypeNote(nonePage, [100000, 40000]);
    ok(noneNote.fix === null && /No cost can bid under the max bid/.test(noneNote.why), `a target under the floor for every type: no button (${JSON.stringify(noneNote)})`);
    const noneRes = await postForm(none, { cost: '1', cost_type_0: '100000', cost_type_1: '40000' });
    ok(noneRes.status === 400 && !fixLink(noneRes.text) && /No cost can bid under the max bid/.test(text(noneRes)),
      `and the server says so too (${text(noneRes).slice(0, 180)})`);
  }

  console.log('\nB. edited margins: the link carries the rows the desk posted');
  {
    const r = await requests.createForLoad(mkLoad());
    const refused = await postForm(r, { cost: '29900', m_0: '2', m_1: '1.5', m_2: '1', rows_shown: '9,5,3', below_min_ack: '1' });
    const link = fixLink(refused.text);
    ok(refused.status === 400 && link && link.label === 'Use Rs 29,411', `refused with Rs 29,411 against the posted 2/1.5/1 (${JSON.stringify(link)})`);
    if (link) {
      const u = new URL(base + link.href);
      const page = (await req('GET', u.href)).text;
      const rows = inputs(page, /name="m_\d+" value="([^"]*)"/g);
      ok(rows.join('/') === '2/1.5/1', `the reopened form shows the posted rows (${rows.join('/')})`);
      const shown = (/name="rows_shown" value="([^"]*)"/.exec(page) || [])[1];
      const acks = /name="below_min_ack" value="1"/.test(page);
      const body = { cost: (/<input id="cost"[^>]*\bvalue="([^"]*)"/.exec(page) || [])[1], rows_shown: shown };
      rows.forEach((v, i) => { body[`m_${i}`] = v; });
      if (acks) body.below_min_ack = '1';
      const done = await postForm(r, body);
      ok(done.status === 200, `submitted as reopened, it is accepted (HTTP ${done.status}: ${text(done).slice(0, 180)})`);
    }
  }

  console.log('\nC. the server-drawn re-price note works with no script');
  {
    const r = await requests.createForLoad(mkLoad());
    await postJson(r, { cost: '20000' });
    await postJson(r, { cost: '31000', m_0: '9', m_1: '5', m_2: '3', rows_shown: '9,5,3', ceiling_ack: '1' });
    const page = (await req('GET', `${base}/price/${r.id}`)).text;
    const ns = /<noscript><a class="efix" href="([^"]+)">([^<]+)<\/a><\/noscript>/.exec(page);
    ok(ns && ns[2] === 'Use Rs 27,522' && /\?cost=27522$/.test(ns[1].replace(/&amp;/g, '&')), `a real link for no script: ${ns && ns[0]}`);
    ok(/<button type="button" id="ceilFix" hidden>/.test(page), 'and the script-only button starts hidden (the script shows it)');

    const p = await requests.createForLoad(perTypeLoad());
    await postForm(p, { cost: '1', cost_type_0: '80000', cost_type_1: '40000' });
    await postForm(p, { cost: '1', cost_type_0: '100000', cost_type_1: '40000', m_0: '9', m_1: '5', m_2: '3', rows_shown: '9,5,3', ceiling_ack: '1' });
    const pPage = (await req('GET', `${base}/price/${p.id}`)).text;
    const pns = /<noscript><a class="efix" href="([^"]+)">([^<]+)<\/a><\/noscript>/.exec(pPage);
    ok(pns && /cost_type_0=92032&(amp;)?cost_type_1=38000/.test(pns[1]), `the per-type re-price link carries the fitted rates: ${pns && pns[1]}`);
  }

  console.log('\nD. the console margin editor refuses a booked load');
  for (const [route, body] of [['margin', { marginsPct: [8, 5, 3], minMarginPct: 3, confirm: true }], ['margin/clear', { confirm: true }]]) {
    const r = await requests.createForLoad(mkLoad({ closesAt: Date.now() + 66_000 }));
    await postJson(r, { cost: '19000' });
    await book(r);
    const id = String(r.loadId);
    const before = armedEvents(id);
    const res = await api(`/api/price-requests/${r.id}/${route}`, body);
    await settle();
    ok(res.status === 410 && res.json && res.json.error === 'Auction closed. Nothing saved.' && armedEvents(id) === before,
      `${route}: HTTP ${res.status} ${JSON.stringify(res.json)}, ${armedEvents(id) - before} new arms`);
  }

  console.log('\nE. a failed read of the closed record refuses rather than arming blind');
  {
    const r = await requests.createForLoad(mkLoad());
    await postJson(r, { cost: '20000' });
    const realGet = store.getDoc.bind(store);
    store.getDoc = async (coll, id) => { if (coll === 'closedBids') throw new Error('disk read failed'); return realGet(coll, id); };
    const before = armedEvents(String(r.loadId));
    const res = await postJson(r, { cost: '21000', m_0: '9', m_1: '5', m_2: '3', rows_shown: '9,5,3' });
    store.getDoc = realGet;
    ok(res.status === 503 && res.json && res.json.error === 'Could not check this load. Try again.' && armedEvents(String(r.loadId)) === before,
      `HTTP ${res.status} ${JSON.stringify(res.json)}`);
  }

  console.log('\nF. a load booked while a re-price is in flight is refused before the write');
  {
    const r = await requests.createForLoad(mkLoad());
    await postJson(r, { cost: '20000' });
    const real = requests.withCustomerMinimum;
    requests.withCustomerMinimum = async function (...a) {
      requests.withCustomerMinimum = real;
      await book(r);
      return real.apply(this, a);
    };
    const res = await postJson(r, { cost: '21000', m_0: '8', m_1: '5', m_2: '3', rows_shown: '9,5,3' });
    requests.withCustomerMinimum = real;
    const after = await requests.getByToken(r.id);
    ok(res.status === 410 && after.price.cost === 20000, `refused (HTTP ${res.status}: ${text(res)}), cost on record ${after.price.cost}`);
  }

  console.log('\nG. a cost typed from a link is dropped from the URL on load');
  {
    const r = await requests.createForLoad(mkLoad());
    const page = (await req('GET', `${base}/price/${r.id}?cost=27522&m_0=2`)).text;
    const js = inlineScripts(page);
    const fn = fnSrc(js, 'clearPrefillFromUrl');
    let replaced = null;
    const ctx = { location: { pathname: `/price/${r.id}`, search: '?cost=27522&m_0=2&keep=1', hash: '' },
      history: { replaceState: (s, t, u) => { replaced = u; } }, URLSearchParams };
    vm.createContext(ctx);
    if (fn) vm.runInContext(`${fn}\nclearPrefillFromUrl();`, ctx);
    ok(replaced === `/price/${r.id}?keep=1`, `the URL loses the typed figures and keeps the rest (${replaced})`);
    ok(/clearPrefillFromUrl\(\);/.test(js), 'and the page calls it on load');
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
