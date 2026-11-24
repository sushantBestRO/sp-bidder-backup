'use strict';
/**
 * THE CEILING NOTE AND THE RE-PRICE TOAST CARRY THE "USE RS Y" CONTROL WHENEVER A VALID COST EXISTS.
 *
 * Owner report (2026-09-26): "Cost too high errors sometimes don't render the suggested fix button."
 * The note heads "Cost too high" when the typed cost is itself over the cap, and that branch always
 * hid the button - so the same load showed the button at one cost ("Price too high") and not at a
 * slightly higher one. The re-price toast never had a control at all. And the offered cost was never
 * checked against the load's hard cost floor, which refuses it outright.
 *
 *   A. capture page script: "Cost too high" shows the button; "Price too high" keeps it (control)
 *   B. a target under the hard cost floor: no button, a plain line saying no cost fits
 *   C. re-price page, server-rendered (no script) on a cost-dead saved cost: the button is there
 *   D. re-price toast: a ceiling refusal's toast carries the control and it runs the corrective
 *
 * Figures: cap 30,000, band 9/5/1, minimum 1 -> the corrective is floor(30,000 / 1.09) = 27,522.
 *
 *   node scripts/test-ceiling-note-fix-button.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '10';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceil-note-fix-'));

const http = require('http');
const vm = require('vm');
const { app, requests } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function req(method, url, { body = null, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = type; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, text: b, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}

function inlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, out = '';
  while ((m = re.exec(html))) out += m[1] + '\n';
  return out;
}
function fnSrc(js, name) {
  const head = `function ${name}(`;
  const at = js.indexOf(head);
  if (at < 0) return null;
  let depth = 0;
  for (let k = js.indexOf('{', at); k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(at, k + 1);
  }
  throw new Error(`unterminated function ${name}`);
}
function varSrc(js, name) {
  const m = js.match(new RegExp(`(?:var |,)${name}=([^,;\\n]+)`));
  if (!m) throw new Error(`the served page has no ${name}`);
  return m[1];
}
const NOTE_FNS = ['num', 'priceOf', 'cval', 'rowsGovern', 'lowestRow', 'guardPctNow', 'ceilBinding', 'rowPrices', 'ceilSplit',
  'ceilDead', 'ceilReason', 'ceilCostTarget', 'ceilEl', 'ceilRender'];

/** The served ceiling note, run the way the page runs it on a keystroke, at the cost the desk typed. */
function runNote(html, cost) {
  const js = inlineScripts(html);
  const lifted = NOTE_FNS.map((n) => fnSrc(js, n)).filter(Boolean);
  const served = [...html.matchAll(/name="m_(\d+)" value="([^"]*)"/g)].map((m) => m[2]);
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: '', hidden: true, getAttribute: () => null,
    classList: { add() {}, remove() {}, toggle() {} } });
  const ctx = {
    ptRows: [],
    document: { getElementById: el }, nf: new Intl.NumberFormat('en-IN'),
    cost: { value: String(cost) }, over: { value: '' },
    rows: served.map((v) => ({ querySelector: (s) => (s === '.mpct' ? { value: v } : null), classList: { add() {}, remove() {} } })),
  };
  vm.createContext(ctx);
  vm.runInContext(['REPRICE', 'CEILING', 'CEILSTATE', 'GUARDPCT', 'CUSTMIN', 'HARDFLOOR'].map((n) => `var ${n}=${varSrc(js, n)};`).join('\n')
    + '\n' + lifted.join('\n') + '\nceilRender();', ctx);
  return { head: el('ceilHead').textContent, why: el('ceilWhy').textContent, fix: el('ceilFix').hidden ? null : el('ceilFix').textContent };
}

// A DOM just deep enough for showToast: elements that keep their children, attributes and listeners.
function toastDom() {
  const mk = (tag) => {
    const e = { tagName: tag, children: [], attrs: {}, listeners: {}, className: '', textContent: '', type: '',
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      setAttribute(k, v) { this.attrs[k] = v; }, remove() {}, classList: { add() {}, remove() {} },
      addEventListener(ev, fn) { this.listeners[ev] = fn; } };
    Object.defineProperty(e, 'innerHTML', { set() { e.children = [mk('svg')]; }, get() { return ''; } });
    Object.defineProperty(e, 'firstChild', { get() { return e.children[0]; } });
    return e;
  };
  const body = mk('body');
  return { body, document: { createElement: mk, body } };
}
const allNodes = (n) => [n, ...(n.children || []).flatMap(allNodes)];

const CAP = 30_000;
let seq = 0;
const mkLoad = (over = {}) => ({
  id: `CNF-${++seq}`, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: CAP, minDecrement: 100 }, ...over,
});
const NO_FIX = 'No cost can bid under the max bid. Quote it by hand.';

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nA. capture page: both ceiling verdicts carry the button');
  const capture = (await req('GET', `${base}/price/${(await requests.createForLoad(mkLoad())).id}`)).text;
  {
    const v = runNote(capture, 31_000);
    ok(v.head === 'Cost too high' && v.fix === 'Use Rs 27,522', `cost 31,000 over the cap: "Cost too high" with "Use Rs 27,522" (${JSON.stringify(v)})`);
    ok(/^Use Rs 27,522 or less\.$/.test(v.why), `and the line names the button (${v.why})`);
    const m = runNote(capture, 29_800);
    ok(m.head === 'Price too high' && m.fix === 'Use Rs 27,522', `control: cost 29,800, "Price too high" keeps "Use Rs 27,522" (${JSON.stringify(m)})`);
    const fits = runNote(capture, 20_000);
    ok(fits.fix === null, `control: a cost that fits shows no button (${JSON.stringify(fits)})`);
  }

  console.log('\nB. no valid cost: the corrective is under the hard cost floor (Rs 10/km x 2,800 km = Rs 28,000)');
  {
    const page = (await req('GET', `${base}/price/${(await requests.createForLoad(mkLoad({ distanceKm: 2800 }))).id}`)).text;
    for (const cost of [29_800, 31_000]) {
      const v = runNote(page, cost);
      ok(v.fix === null && v.why.endsWith(NO_FIX), `cost ${cost}: no button, and the line ends "${NO_FIX}" (${JSON.stringify(v)})`);
    }
  }

  console.log('\nC. re-price page, server-rendered on a saved cost that is over the cap');
  {
    const r = await requests.createForLoad(mkLoad());
    const armed = await req('POST', `${base}/price/${r.id}`, { body: JSON.stringify({ cost: '20000' }) });
    ok(armed.status === 200, `setup: armed at Rs 20,000 (HTTP ${armed.status})`);
    const saved = await req('POST', `${base}/price/${r.id}`, { body: JSON.stringify({ cost: '31000', m_0: '9', m_1: '5', m_2: '1', rows_shown: '9,5,1', ceiling_ack: '1' }) });
    ok(saved.status === 200, `setup: Rs 31,000 saved through the override (HTTP ${saved.status}: ${saved.json && (saved.json.error || saved.json.savedMsg)})`);
    const page = (await req('GET', `${base}/price/${r.id}`)).text;
    const head = /<div class="st" id="ceilHead"[^>]*>([^<]*)<\/div>/.exec(page);
    const btn = /<noscript><a class="efix" href="[^"]*\?cost=27522">([^<]*)<\/a><\/noscript>/.exec(page);
    ok(head && head[1] === 'Cost too high', `the note heads "Cost too high" (${head && head[1]})`);
    ok(btn && btn[1] === 'Use Rs 27,522', `and with no script the control is a link that types it: ${btn && btn[0]}`);

    console.log('\nD. re-price toast: a ceiling refusal carries the control');
    const js = inlineScripts(page);
    const sub = fnSrc(js, 'submitJson') || '';
    ok(/ceilToastAction\(r\.data\)/.test(sub), 'submitJson hands the refusal data to ceilToastAction');
    const dom = toastDom();
    let ran = null;
    const ctx = { document: dom.document, nf: new Intl.NumberFormat('en-IN'), requestAnimationFrame: (f) => f(),
      setTimeout: () => 0, clearTimeout: () => {}, useCostTarget: (t) => { ran = t; } };
    vm.createContext(ctx);
    vm.runInContext(`var toastEl=null,toastTimer=null;\n${fnSrc(js, 'showToast') || ''}\n${fnSrc(js, 'ceilToastAction') || 'function ceilToastAction(){return null;}'}`, ctx);
    const act = vm.runInContext('ceilToastAction({error:"x",code:"CEILING_DEAD",costTarget:27522})', ctx);
    ok(act && act.label === 'Use Rs 27,522', `a ceiling refusal with costTarget 27,522 yields "Use Rs 27,522" (${JSON.stringify(act && act.label)})`);
    ok(vm.runInContext('ceilToastAction({error:"x",code:"CEILING_DEAD",costTarget:null})', ctx) === null
      && vm.runInContext('ceilToastAction({error:"x",code:"BELOW_MINIMUM"})', ctx) === null,
    'no costTarget, or another refusal: no control');
    vm.runInContext('showToast("Not saved.",true,true,ceilToastAction({code:"CEILING_DEAD",costTarget:27522}))', ctx);
    const btnNode = allNodes(dom.body).find((n) => n.tagName === 'button' && n.textContent === 'Use Rs 27,522');
    ok(!!btnNode, 'the toast renders a "Use Rs 27,522" button');
    if (btnNode && btnNode.listeners.click) btnNode.listeners.click({ preventDefault() {} });
    ok(ran === 27522, `tapping it types the corrective (useCostTarget got ${ran})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
