'use strict';
/**
 * EVERY CEILING REFUSAL THAT HAS A VALID CORRECTIVE COST CARRIES THE "USE RS Y" CONTROL.
 *
 * Owner report (2026-09-26): "Cost too high errors sometimes don't render the suggested fix button."
 * The server refusal named the buying price ("To bid this load you need the truck at Rs Y or less.
 * Enter that cost and submit again.") but no path that delivers it carried a control: the form-post
 * page was bare text and the re-price JSON had no figure for the toast to act on. The "Cost too high"
 * case (cost above the cap) offered no buying price at all.
 *
 * Paths pinned, each with the same load figures (cap 30,000, band 9/5/1, minimum 1, target 27,522):
 *   1. capture, form post (no script): margin-dead and cost-dead both link "Use Rs 27,522" to the
 *      form with that cost typed, and the linked cost arms
 *   2. capture, JSON: both carry costTarget
 *   3. re-price, JSON (the script toast) and form post
 *   4. per-truck-type load: the link carries every rate scaled to the target, and those rates arm
 *   5. round-figure grid shipper: the offered cost arms on a cap that sits off the grid
 *   6. inverted band (A015): the corrective keys on the minimum and arms
 *   7. no valid cost (the target is under the load's hard cost floor): no control, a plain line
 *   8. GoComet: same control, and no refusal names SuperProcure
 *
 *   node scripts/test-ceiling-refusal-fix-button.js
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
process.env.SP_ROUNDING_ENABLED = '1';
process.env.SP_ROUNDING_SHIPPERS = 'Gridline Test Shipper';
process.env.SP_ROUNDING_STEP = '100';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceil-fix-button-'));

const http = require('http');
const { app, requests, store, stacks } = require('../src/web/server');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { cargoTypeList } = require('../src/platform/gocometCargo');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

function req(method, url, { body = null, type = null } = {}) {
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
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const decode = (s) => s.replace(/&amp;/g, '&');
const text = (res) => (res.json ? `${res.json.code || ''} ${res.json.error || ''}` : res.text.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
// The one control on a refusal page that types the buying price for the desk.
const fixLink = (html) => {
  const m = /<a class="efix" href="([^"]+)">([^<]+)<\/a>/.exec(html || '');
  return m ? { href: decode(m[1]), label: m[2] } : null;
};
const inputValue = (html, id) => { const m = new RegExp(`<input id="${id}"[^>]*\\bvalue="([^"]*)"`).exec(html); return m ? m[1] : null; };

const CAP = 30_000;
const TARGET = 27_522;             // floor(30,000 / 1.09)
const NO_FIX = 'No cost can bid under the max bid. Quote it by hand.';
let seq = 0;
const mkLoad = (over = {}) => ({
  id: `CFB-${++seq}`, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1, quoteType: 'FTL',
  companyName: 'Waaree Energies', closesAt: Date.now() + 40 * 60_000, startsAt: Date.now() - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice: CAP, minDecrement: 100 }, ...over,
});

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const postForm = (r, obj) => req('POST', `${base}/price/${r.id}`, { body: form(obj), type: 'application/x-www-form-urlencoded' });
  const postJson = (r, obj) => req('POST', `${base}/price/${r.id}`, { body: JSON.stringify(obj), type: 'application/json' });
  const follow = async (href, extra = {}) => {
    const u = new URL(base + href);
    const page = await req('GET', u.href);
    const fields = Object.fromEntries(u.searchParams.entries());
    return { page, fields, post: await req('POST', `${base}${u.pathname}`, { body: form({ ...fields, ...extra }), type: 'application/x-www-form-urlencoded' }) };
  };

  console.log('\n1. capture, form post: both kinds of ceiling refusal carry the control, and it works');
  for (const [kind, cost] of [['margin-dead (cost under the cap, lowest price over it)', 29_800], ['cost-dead ("Cost too high", cost over the cap)', 31_000]]) {
    const r = await requests.createForLoad(mkLoad());
    const res = await postForm(r, { cost: String(cost) });
    const link = fixLink(res.text);
    ok(res.status === 400 && link && link.label === 'Use Rs 27,522', `${kind}: the refusal page has "Use Rs 27,522" (HTTP ${res.status}, control ${JSON.stringify(link)})`);
    ok(/Use Rs 27,522 or less\./.test(text(res)), `${kind}: and the sentence names the same figure (${text(res).slice(0, 220)})`);
    if (link) {
      const { page, post } = await follow(link.href);
      ok(page.status === 200 && inputValue(page.text, 'cost') === String(TARGET), `${kind}: the control opens the form with Rs 27,522 typed (value ${inputValue(page.text, 'cost')})`);
      ok(post.status === 200, `${kind}: and submitting that cost arms the load (HTTP ${post.status}: ${text(post).slice(0, 160)})`);
    }
  }

  console.log('\n2. capture, JSON: the figure travels with the refusal');
  for (const cost of [29_800, 31_000]) {
    const r = await requests.createForLoad(mkLoad());
    const res = await postJson(r, { cost: String(cost) });
    ok(res.status === 400 && res.json && res.json.code === 'CEILING_DEAD' && res.json.costTarget === TARGET,
      `cost ${cost}: JSON carries code CEILING_DEAD and costTarget 27,522 (${JSON.stringify(res.json)})`);
  }

  console.log('\n3. re-price: the toast gets the figure, the no-script form gets the control');
  {
    const r = await requests.createForLoad(mkLoad());
    const armed = await postJson(r, { cost: '20000' });
    ok(armed.status === 200, `setup: the load arms at Rs 20,000 (HTTP ${armed.status}: ${text(armed)})`);
    const band = { m_0: '9', m_1: '5', m_2: '1', rows_shown: '9,5,1' };
    const viaScript = await postJson(r, { cost: '29800', ...band });
    ok(viaScript.status === 400 && viaScript.json && viaScript.json.costTarget === TARGET,
      `JSON re-price: costTarget 27,522 for the toast (${JSON.stringify(viaScript.json)})`);
    const viaForm = await postForm(r, { cost: '31000', ...band });
    const link = fixLink(viaForm.text);
    ok(viaForm.status === 400 && link && link.label === 'Use Rs 27,522', `form re-price: the refusal page has the control (${JSON.stringify(link)})`);
    if (link) {
      const page = await req('GET', base + link.href);
      ok(inputValue(page.text, 'cost') === String(TARGET), `the re-price form opens with Rs 27,522 typed (value ${inputValue(page.text, 'cost')})`);
    }
    const plain = await req('GET', `${base}/price/${r.id}`);
    ok(inputValue(plain.text, 'cost') === '20000', 'control: the re-price form without the link still shows the cost on record');
  }

  console.log('\n4. per-truck-type load: every rate is scaled to the target');
  {
    const types = cargoTypeList(["5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck", "1 x 20FTODC (LxWXH - 20'x8'x8'8\") 10 Ton Truck"]);
    const r = await requests.createForLoad(mkLoad({ units: 6, cargoLines: 2, cargoTypes: types, rules: { ceilingPrice: 90_500, minDecrement: 100 } }));
    const res = await postForm(r, { cost: '1', cost_type_0: '100000', cost_type_1: '40000' });
    const link = fixLink(res.text);
    ok(res.status === 400 && link && link.label === 'Use Rs 83,027', `the refusal on a blend of 90,000 offers Rs 83,027 (${JSON.stringify(link)}; ${text(res).slice(0, 200)})`);
    if (link) {
      const { fields, post } = await follow(link.href, { cost: '1' });
      ok(fields.cost_type_0 === '92252' && fields.cost_type_1 === '36900' && !('cost' in fields),
        `the control carries each rate scaled by the same factor, floored (${JSON.stringify(fields)})`);
      ok(post.status === 200, `and those rates arm the load (HTTP ${post.status}: ${text(post).slice(0, 160)})`);
    }
  }

  console.log('\n5. round-figure grid shipper: the offered cost is valid on the grid');
  {
    // Cap 15,550 sits off the 100 grid. The corrective keys on the raw cap (14,809, a single price
    // of 15,549), and the grid cannot snap a price that close to the cap, so the load bids unrounded
    // at 15,549 rather than being refused again.
    const r = await requests.createForLoad(mkLoad({ companyName: 'Gridline Test Shipper', rules: { ceilingPrice: 15_550, minDecrement: 100 } }));
    await store.patchDoc('priceRequests', r.id, { marginsPct: [5], minMarginPct: 5 });
    const res = await postForm(r, { cost: '15000' });
    const link = fixLink(res.text);
    ok(res.status === 400 && link && link.label === 'Use Rs 14,809', `the grid refusal offers Rs 14,809 (${JSON.stringify(link)})`);
    if (link) {
      const { post } = await follow(link.href);
      ok(post.status === 200, `and that cost arms rather than being refused again (HTTP ${post.status}: ${text(post).slice(0, 200)})`);
    }
  }

  console.log('\n6. inverted band (A015): the corrective keys on the minimum');
  {
    const r = await requests.createForLoad(mkLoad());
    await store.patchDoc('priceRequests', r.id, { marginsPct: [5, 4, 3], minMarginPct: 8 });
    const res = await postForm(r, { cost: '29000' });
    const link = fixLink(res.text);
    ok(res.status === 400 && link && link.label === 'Use Rs 27,777', `the refusal offers Rs 27,777 (${JSON.stringify(link)})`);
    if (link) {
      const { post } = await follow(link.href);
      ok(post.status === 200, `and that cost arms (HTTP ${post.status}: ${text(post).slice(0, 160)})`);
    }
  }

  console.log('\n7. no valid cost: the target is under the load\'s hard cost floor');
  {
    // 2,800 km at Rs 10/km puts the floor at Rs 28,000, above the 27,522 the cap allows.
    const r = await requests.createForLoad(mkLoad({ distanceKm: 2800 }));
    for (const cost of [29_800, 31_000]) {
      const res = await postForm(r, { cost: String(cost) });
      ok(res.status === 400 && !fixLink(res.text) && text(res).includes(NO_FIX) && !/27,522/.test(text(res)),
        `cost ${cost}: no control, and the page says "${NO_FIX}" (${text(res).slice(0, 220)})`);
      const j = await postJson(r, { cost: String(cost) });
      ok(j.status === 400 && j.json && j.json.costTarget == null && j.json.error.includes(NO_FIX), `cost ${cost}: JSON has no costTarget (${JSON.stringify(j.json)})`);
    }
  }

  console.log('\n8. GoComet: the same control, and no refusal names SuperProcure');
  {
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft', platformLabel: 'GoComet' }),
      ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }), placeBid: async () => ({ accepted: false }),
    };
    const engine = new BidEngine(adapter, new DurableScheduler(path.join(process.env.SP_DATA_DIR, 'gc-intent.json')), { config: {} });
    const account = { accountId: 'gocomet-primary', label: 'GoComet' };
    stacks.push({ account, tag: account, platformKey: 'gocomet', adapter, engine });
    for (const [cost, fix] of [[29_800, true], [31_000, true]]) {
      const r = await requests.createForLoad(mkLoad({ account }), { platformKey: 'gocomet' });
      const res = await postForm(r, { cost: String(cost) });
      const link = fixLink(res.text);
      ok(res.status === 400 && (!!link === fix) && !/SuperProcure/.test(text(res)),
        `GoComet cost ${cost}: HTTP ${res.status}, control ${JSON.stringify(link)}, portal-neutral (${text(res).slice(0, 200)})`);
    }
    const r = await requests.createForLoad(mkLoad({ account, distanceKm: 2800 }), { platformKey: 'gocomet' });
    const res = await postForm(r, { cost: '31000' });
    ok(res.status === 400 && !/SuperProcure/.test(text(res)) && text(res).includes(NO_FIX),
      `GoComet with no valid cost: the plain line, no portal name (${text(res).slice(0, 220)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
