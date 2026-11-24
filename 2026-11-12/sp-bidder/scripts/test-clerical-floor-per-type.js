'use strict';
/**
 * THE CLERICAL FLOOR BINDS EACH TRUCK TYPE'S RATE, NOT THE BLEND.
 *
 * Regression target: T1 BH-BOUNDARY-2 and audit H3 (R2-A).
 *
 * The hard clerical-error floor (hardCostFloorFor / enforceHardCostFloor) exists to refuse a missing
 * digit outright. On a load with more than one truck type the desk types one rate per type, and every
 * enforcement site judges only the truck-weighted BLEND of those rates. Ten 32 ft trucks at Rs 45,000
 * and one ODC at Rs 4,999 (the desk meant 49,990) blend to Rs 41,364, which clears a Rs 5,000 floor,
 * so the Rs 4,999 arms and goes out on that freight line. The same Rs 4,999 typed as a single rate
 * is refused. Four sites share the hole:
 *   - the /price capture gate judges normalizeCostByType(...).cost, the blend;
 *   - the re-price gate judges req.body.cost, the page's hidden blend field, so it is also blind to a
 *     posted vector whose blend is itself under the floor (H3: a decoy `cost` walks it through);
 *   - the page's own mirror (HARDFLOOR / hardFloorOk) reads cval(), and ptSync writes the blend there;
 *   - the console margin route accepts one cost only, so it has no per-type hole today; checks here
 *     pin that it keeps refusing a sub-floor cost on a multi-type load.
 *
 * Owner ruling 2026-09-19: the floor binds EACH per-type rate. Truck basis only; PMT keeps its
 * carve-out.
 *
 * WHAT MUST NOT MOVE (controls, green before and after):
 *   - a single-type load is refused one rupee under the floor and accepted exactly at it;
 *   - a multi-type load whose every rate clears the floor (one of them exactly at it) arms;
 *   - an ordinary per-type re-price saves;
 *   - a PMT load, single rate or per type, is never judged against the rupee floor;
 *   - on the page, a per-type entry that clears the floor still submits.
 *
 * The page checks execute the SHIPPED inline scripts against a minimal DOM built from the served
 * HTML, then fire the form's submit. A submit counts as refused when the handler prevents it (or,
 * on the re-price form, never posts), or when the browser's own constraint validation would stop it
 * first, so either a script gate or a native min on the rate inputs satisfies the check.
 *
 *   node scripts/test-clerical-floor-per-type.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '500';
process.env.SP_MIN_COST_ABS = '5000';
process.env.SP_MIN_COST_PER_KM = '0';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-clerical-per-type-'));

const http = require('http');
const { app, requests } = require('../src/web/server');

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

// ---- a minimal DOM over the served HTML, enough to run the page's own scripts ------------------
const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'wbr', 'col', 'area']);
function parseHtml(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const root = mkEl('#root', {});
  let cur = root;
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const tag = m[2].toLowerCase();
    if (m[1]) {
      let p = cur;
      while (p && p.tagName.toLowerCase() !== tag) p = p.parentNode;
      if (p && p.parentNode) cur = p.parentNode;
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] == null ? '' : a[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const el = mkEl(tag, attrs);
    el.parentNode = cur; cur.children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(m[3])) cur = el;
  }
  return root;
}
function matchesCompound(el, sel) {
  if (!el.attrs) return false;
  const m = /^([a-zA-Z][\w-]*)?((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(sel);
  if (!m) return false;
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  for (const p of m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    if (p[1] && el.attrs.id !== p[1]) return false;
    if (p[2] && !(el.attrs.class || '').split(/\s+/).includes(p[2])) return false;
    if (p[3] && (!(p[3] in el.attrs) || (p[4] != null && el.attrs[p[3]] !== p[4]))) return false;
  }
  return true;
}
function matches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2, p = el.parentNode;
  while (i >= 0 && p) { if (matchesCompound(p, parts[i])) i--; p = p.parentNode; }
  return i < 0;
}
function walk(el, out) { for (const c of el.children) { out.push(c); walk(c, out); } return out; }
function mkEl(tag, attrs) {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), attrs, children: [], parentNode: null, style: {}, dataset: {},
    value: attrs.value != null ? attrs.value : '', textContent: '',
    get innerHTML() { return el._html || ''; },
    set innerHTML(v) { el._html = String(v); el.children = parseHtml(el._html).children; el.children.forEach((c) => { c.parentNode = el; }); },
    get firstChild() { return el.children[0] || null; },
    disabled: 'disabled' in attrs, checked: 'checked' in attrs, hidden: 'hidden' in attrs,
    get id() { return attrs.id || ''; },
    get type() { return attrs.type || (tag === 'input' ? 'text' : ''); },
    get name() { return attrs.name || ''; },
    get className() { return attrs.class || ''; }, set className(v) { attrs.class = String(v); },
    classList: {
      add: (...c) => { const s = new Set((attrs.class || '').split(/\s+/).filter(Boolean)); c.forEach((x) => s.add(x)); attrs.class = [...s].join(' '); },
      remove: (...c) => { attrs.class = (attrs.class || '').split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      toggle: (c, force) => { const has = (attrs.class || '').split(/\s+/).includes(c); const want = force === undefined ? !has : !!force; if (want) el.classList.add(c); else el.classList.remove(c); return want; },
      contains: (c) => (attrs.class || '').split(/\s+/).includes(c),
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    hasAttribute: (k) => k in attrs,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
    fire: (t, ev) => { const e = ev || { type: t, target: el, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, defaultPrevented: false }; (listeners[t] || []).slice().forEach((fn) => fn.call(el, e)); return e; },
    appendChild: (c) => { c.parentNode = el; el.children.push(c); return c; },
    insertBefore: (c) => { c.parentNode = el; el.children.push(c); return c; },
    removeChild: (c) => { el.children = el.children.filter((x) => x !== c); return c; },
    remove: () => { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter((x) => x !== el); },
    querySelector: (s) => walk(el, []).find((x) => matches(x, s)) || null,
    querySelectorAll: (s) => walk(el, []).filter((x) => matches(x, s)),
    closest: (s) => { let p = el; while (p) { if (p.attrs && matches(p, s)) return p; p = p.parentNode; } return null; },
    contains: (x) => { let p = x; while (p) { if (p === el) return true; p = p.parentNode; } return false; },
    focus: () => { if (el.ownerDocument) el.ownerDocument.activeElement = el; },
    blur() {}, select() {}, scrollIntoView() {}, insertAdjacentHTML() {}, setCustomValidity() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }),
    submit: () => { el.nativeSubmits = (el.nativeSubmits || 0) + 1; },
  };
  return el;
}
// What a browser's constraint validation does before it ever fires `submit`: an enabled, non-hidden
// input that is required-and-empty or under its own min stops the submit.
function nativeBlocks(formEl) {
  return formEl.querySelectorAll('input').some((i) => {
    if (i.disabled || i.type === 'hidden') return false;
    const v = String(i.value).trim();
    if (i.hasAttribute('required') && v === '') return true;
    const min = i.getAttribute('min');
    return v !== '' && min != null && min !== '' && Number(v) < Number(min);
  });
}
function runPage(html, pathname) {
  const root = parseHtml(html);
  const document = {
    activeElement: null, body: null,
    getElementById: (id) => root.querySelector(`#${id}`),
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    createElement: (t) => { const e = mkEl(t, {}); e.ownerDocument = document; return e; },
    addEventListener() {}, removeEventListener() {},
  };
  document.body = root.querySelector('body') || root;
  walk(root, []).forEach((e) => { e.ownerDocument = document; });
  const posts = [];
  const fetch = (url, init) => { if (init && init.method === 'POST') posts.push({ url, body: init.body }); return new Promise(() => {}); };
  const window = { confirm: () => true, addEventListener() {}, removeEventListener() {} };
  const location = { pathname, reload() {}, href: pathname };
  const timers = { setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0 };
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const src of scripts) {
    new Function('document', 'window', 'location', 'fetch', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', src)(
      document, window, location, fetch, timers.setTimeout, timers.clearTimeout, timers.requestAnimationFrame);
  }
  return { document, posts };
}
// Types each rate the way a desk does (value, then the input event), then presses submit. On the
// single-rate form the one rate goes into #cost.
function submitRates(html, pathname, rates) {
  const { document, posts } = runPage(html, pathname);
  const ids = document.getElementById('cost_type_0') ? rates.map((_, i) => `cost_type_${i}`) : ['cost'];
  ids.forEach((id, i) => { const inp = document.getElementById(id); inp.value = String(rates[i]); inp.fire('input'); });
  const mainForm = document.getElementById('mainForm');
  if (nativeBlocks(mainForm)) return { refused: true, posts };
  const ev = mainForm.fire('submit');
  // The capture form posts natively, so letting the event through IS the submit. The re-price form
  // always prevents it and posts through fetch, so there only an absent POST is a refusal.
  const reprice = /var REPRICE=true/.test(html);
  const refused = reprice ? posts.length === 0 : (ev.defaultPrevented && mainForm.nativeSubmits == null);
  return { refused, posts };
}

const now = Date.now();
const mkLoad = (id, over) => Object.assign({
  id, lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32 ft MXL', units: 1,
  quoteType: 'FTL', companyName: 'Havells', closesAt: now + 20 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live',
}, over || {});
const TWO_TYPES = {
  units: 11, cargoLines: 2, equipment: '10 x 32 ft MXL, 18 T + 1 x 20 ft ODC, 10 T',
  cargoTypes: [
    { label: '32 ft MXL, 18 T', count: 10, match: '32ftmxl18t' },
    { label: '20 ft ODC, 10 T', count: 1, match: '20ftodc10t' },
  ],
};
const blendOf = (a, b) => String(Math.round((a * 10 + b) / 11));
const typeCosts = (doc) => (doc && doc.price && doc.price.costByType ? doc.price.costByType.types.map((t) => t.cost) : null);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const capture = (token, fields) => call('POST', `${base}/price/${token}`, { body: form(fields), contentType: 'application/x-www-form-urlencoded' });
  const reprice = (token, fields) => call('POST', `${base}/price/${token}`, { body: JSON.stringify(fields) });
  const bandFields = (doc) => Object.fromEntries((doc.marginsPct || []).map((m, i) => [`m_${i}`, String(m)]));
  const armedTwoType = async (id, rates) => {
    const r = await requests.createForLoad(mkLoad(id, TWO_TYPES));
    const res = await capture(r.id, { cost: blendOf(rates[0], rates[1]), cost_type_0: String(rates[0]), cost_type_1: String(rates[1]) });
    const doc = await requests.getByToken(r.id);
    if (res.status !== 200 || doc.status !== 'armed') throw new Error(`setup: could not arm ${id} at [${rates}] (HTTP ${res.status}, ${doc.status})`);
    return doc;
  };

  console.log('\nA. capture - the controls, then one type under the floor');
  {
    const r = await requests.createForLoad(mkLoad('CF-A1'));
    const res = await capture(r.id, { cost: '4999' });
    ok(res.status === 400, `CONTROL: a single rate of Rs 4,999 is refused (HTTP ${res.status})`);
  }
  {
    const r = await requests.createForLoad(mkLoad('CF-A2'));
    const res = await capture(r.id, { cost: '5000' });
    const doc = await requests.getByToken(r.id);
    ok(res.status === 200 && doc.status === 'armed', `CONTROL: a single rate exactly at Rs 5,000 arms (HTTP ${res.status}, ${doc.status})`);
  }
  {
    const r = await requests.createForLoad(mkLoad('CF-A3', TWO_TYPES));
    const res = await capture(r.id, { cost: blendOf(45000, 5000), cost_type_0: '45000', cost_type_1: '5000' });
    const doc = await requests.getByToken(r.id);
    ok(res.status === 200 && doc.status === 'armed',
      `CONTROL: per-type [45,000, 5,000], every rate at or above the floor, arms (HTTP ${res.status}, ${doc.status})`);
  }
  {
    const r = await requests.createForLoad(mkLoad('CF-A4', TWO_TYPES));
    const res = await capture(r.id, { cost: blendOf(45000, 4999), cost_type_0: '45000', cost_type_1: '4999' });
    const doc = await requests.getByToken(r.id);
    ok(res.status === 400,
      `capture: per-type [45,000, 4,999] is refused - the ODC rate is under the Rs 5,000 floor even though the blend (Rs ${blendOf(45000, 4999)}) is not (HTTP ${res.status})`);
    ok(doc.status === 'awaiting_price' && !typeCosts(doc),
      `capture: the refused per-type entry armed nothing and stored no vector (status ${doc.status}, stored ${JSON.stringify(typeCosts(doc))})`);
    ok(res.status === 400 && /4,999/.test(res.text) && /5,000/.test(res.text),
      'capture: the refusal names the figure entered (Rs 4,999) and the figure required (Rs 5,000)');
  }
  {
    const r = await requests.createForLoad(mkLoad('CF-A5', TWO_TYPES));
    const res = await capture(r.id, { cost_type_0: '4999', cost_type_1: '45000' });
    ok(res.status === 400, `capture: the dearer-count type under the floor is refused too, with no posted cost at all (HTTP ${res.status})`);
  }

  console.log('\nB. re-price - the gate reads the posted blend, never the rates');
  {
    const doc = await armedTwoType('CF-B1', [45000, 40000]);
    const res = await reprice(doc.id, { cost: blendOf(46000, 41000), ...bandFields(doc), cost_type_0: '46000', cost_type_1: '41000' });
    const after = await requests.getByToken(doc.id);
    ok(res.status === 200 && JSON.stringify(typeCosts(after)) === '[46000,41000]',
      `CONTROL: an ordinary per-type re-price saves (HTTP ${res.status}, stored ${JSON.stringify(typeCosts(after))})`);
  }
  {
    const doc = await armedTwoType('CF-B2', [45000, 40000]);
    const res = await reprice(doc.id, { cost: blendOf(45000, 4999), ...bandFields(doc), cost_type_0: '45000', cost_type_1: '4999' });
    const after = await requests.getByToken(doc.id);
    ok(res.status === 400,
      `re-price: per-type [45,000, 4,999] with the page's own blend as cost is refused (HTTP ${res.status})`);
    ok(JSON.stringify(typeCosts(after)) === '[45000,40000]',
      `re-price: the armed vector is untouched by the refused re-price (stored ${JSON.stringify(typeCosts(after))})`);
  }
  {
    const doc = await armedTwoType('CF-B3', [45000, 40000]);
    const res = await reprice(doc.id, { cost: '99999', ...bandFields(doc), cost_type_0: '4000', cost_type_1: '4000' });
    const after = await requests.getByToken(doc.id);
    ok(res.status === 400 && JSON.stringify(typeCosts(after)) === '[45000,40000]',
      `re-price (H3): rates of [4,000, 4,000] under a decoy posted cost of 99,999 are refused (HTTP ${res.status}, stored ${JSON.stringify(typeCosts(after))})`);
  }

  console.log('\nC. console margin route - one cost only; it must keep refusing a sub-floor cost on a multi-type load');
  {
    const doc = await armedTwoType('CF-C1', [45000, 40000]);
    const res = await call('POST', `${base}/api/price-requests/${doc.id}/margin`, {
      body: JSON.stringify({ marginsPct: doc.marginsPct, minMarginPct: doc.minMarginPct, cost: 4999, confirm: true }), origin: base });
    const after = await requests.getByToken(doc.id);
    ok(res.status === 400 && JSON.stringify(typeCosts(after)) === '[45000,40000]',
      `console: Rs 4,999 on a multi-type armed load is refused and the vector survives (HTTP ${res.status})`);
  }

  console.log('\nD. PMT keeps its carve-out');
  {
    const r = await requests.createForLoad(mkLoad('CF-D1', { quoteType: 'PMT', units: 22 }));
    const res = await capture(r.id, { cost: '800' });
    const doc = await requests.getByToken(r.id);
    ok(res.status === 200 && doc.status === 'armed', `CONTROL: a PMT single rate of Rs 800/MT arms (HTTP ${res.status})`);
  }
  {
    const r = await requests.createForLoad(mkLoad('CF-D2', { ...TWO_TYPES, quoteType: 'PMT' }));
    const res = await capture(r.id, { cost_type_0: '800', cost_type_1: '700' });
    const doc = await requests.getByToken(r.id);
    ok(res.status === 200 && doc.status === 'armed',
      `CONTROL: PMT per-type [800, 700] is never judged against the rupee floor (HTTP ${res.status}, ${doc.status})`);
  }

  console.log('\nE. the page mirror - the served script must refuse a per-type rate under the floor');
  {
    const r = await requests.createForLoad(mkLoad('CF-E0'));
    const page = await call('GET', `${base}/price/${r.id}`);
    const pathname = new URL(`${base}/price/${r.id}`).pathname;
    ok(submitRates(page.text, pathname, [4999]).refused && !submitRates(page.text, pathname, [5000]).refused,
      'CONTROL page (single rate): the shipped script stops Rs 4,999 and lets Rs 5,000 through, so this harness sees the page gate');
  }
  {
    const r = await requests.createForLoad(mkLoad('CF-E1', TWO_TYPES));
    const page = await call('GET', `${base}/price/${r.id}`);
    const pathname = new URL(`${base}/price/${r.id}`).pathname;
    const good = submitRates(page.text, pathname, [45000, 5000]);
    ok(!good.refused, 'CONTROL page (capture): per-type [45,000, 5,000] submits');
    const bad = submitRates(page.text, pathname, [45000, 4999]);
    ok(bad.refused, 'page (capture): per-type [45,000, 4,999] is stopped before it leaves the page');
  }
  {
    const doc = await armedTwoType('CF-E2', [45000, 40000]);
    const page = await call('GET', `${base}/price/${doc.id}`);
    const pathname = new URL(`${base}/price/${doc.id}`).pathname;
    ok(/var REPRICE=true/.test(page.text), 'setup: the armed load serves the re-price form');
    const good = submitRates(page.text, pathname, [46000, 41000]);
    ok(!good.refused && good.posts.length === 1, `CONTROL page (re-price): per-type [46,000, 41,000] posts (${good.posts.length} post)`);
    const bad = submitRates(page.text, pathname, [45000, 4999]);
    ok(bad.refused, `page (re-price): per-type [45,000, 4,999] never posts (${bad.posts.length} post)`);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed (of ${n})`);
  if (fail) {
    console.error('FAIL - the clerical floor judges the truck-weighted blend, not each truck type\'s rate:');
    for (const f of failed) console.error('  * ' + f);
    process.exit(1);
  }
  console.log(`PASS test-clerical-floor-per-type (${n} checks)`);
  process.exit(0);
})().catch((e) => { console.error('could_not_run:', e && e.stack); process.exit(2); });
