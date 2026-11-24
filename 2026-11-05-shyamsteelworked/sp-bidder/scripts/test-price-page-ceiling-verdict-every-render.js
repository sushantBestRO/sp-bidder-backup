'use strict';
/**
 * THE /price CEILING VERDICT IS THE SERVER'S RULE ON EVERY RENDER OF THE RE-PRICE PAGE.
 *
 * Rows typed on /price at or above the customer minimum keep that minimum as their guard
 * (withCustomerMinimum), so a shipper ceiling between the guard and the lowest row is bid ONCE, at
 * the ceiling. The page's own ceiling verdict (guardPctNow -> ceilReason -> ceilRender) applies the
 * same rule, but it reads the customer minimum from CUSTMIN, which the server inlines from
 * renderPriceForm's opts.customerMinPct. The GET re-price page passes it. Three other renders of the
 * same page do not:
 *   - a stray POST to an armed load (the one-field capture form resubmitted), via renderRequestStatus;
 *   - a capture POST that lost a race to another desk, via renderRequestStatus (named reversal, A009:
 *     that capture is now an error on the price screen, so no price form is rendered for it at all);
 *   - the "Bidding resumed." page after a hold.
 * On those, renderPriceForm falls back to CUSTMIN = null for a per-load override with no
 * below-minimum record, the page judges the lowest row, and a load the server bids once at the
 * ceiling is shown as "Price too high" with a cost rewrite on offer.
 *
 * What must hold: on each of those renders the served page's own verdict functions, executed on the
 * served cost and rows, say what the server does on submit - one bid at the ceiling, no refusal.
 * The server half is checked too: those loads are armed at [105500], and re-posting the same cost and
 * rows is a same-rate re-save, refused with nothing changed (owner ruling 26 Sep).
 *
 * Controls (green before and after the fix):
 *   - the GET re-price page, which already passes the customer minimum, reads the one-bid note;
 *   - a cost whose customer-minimum guard is itself above the ceiling reads "Price too high" on the
 *     stray-POST page, and the server refuses it.
 *
 * Figures: default band [12.6, 7.2, 6.3] minimum 5, so the customer minimum is 5. Cost 100,000, flat.
 * Rows [13, 7.2, 6.3] price at [113000, 107200, 106300]; ceiling 105,500.
 *   guard at 5%   = round(100000 x 1.05)  = 105,000 <= 105,500 -> one bid at 105,500
 *   guard at 6.3% = round(100000 x 1.063) = 106,300 >  105,500 -> "Price too high" (the wrong verdict)
 *   cost 101,000: guard at 5% = 106,050 > 105,500 -> dead on either guard (the dead control)
 *
 * The verdict functions are lifted out of the SERVED page (brace-matched, byte for byte) and run on
 * stub rows carrying the served input values, the same approach as test-price-page-confirm.js.
 *
 *   node scripts/test-price-page-ceiling-verdict-every-render.js
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceil-verdict-render-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const { app, requests, stacks, store } = require('../src/web/server');

const COST = '100000';
const EDITED = { m_0: '13', m_1: '7.2', m_2: '6.3' };
const CEILING = 105500;
const ONE_BID = 'All 3 prices are above Rs 1,05,500. One bid goes out, at Rs 1,05,500.';
const STANDING = 106300;      // the resume fixture's standing bid: the lowest rung of the uncapped plan
const CORRECTED = '101000';   // the correction that holds it: lowest row 6.3% -> 107,363, above that bid
const DEAD_COST = 101000;     // guard at the 5% customer minimum = 106,050, above the ceiling

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
const form = (obj) => ({ body: Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') });
const json = (obj) => ({ body: JSON.stringify(obj), contentType: 'application/json' });
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
const VERDICT_FNS = ['num', 'priceOf', 'cval', 'rowsGovern', 'guardPctNow', 'lowestRow', 'ceilBinding', 'rowPrices',
  'ceilSplit', 'ceilDead', 'ceilReason', 'ceilCostTarget', 'ceilEl', 'ceilRender'];
const REQUIRED_FNS = VERDICT_FNS.filter((n) => n !== 'guardPctNow');
/**
 * The page as the desk has it: the served constants, the served cost and rows (or the ones given, as
 * the desk would type them), and the served ceiling functions. Returns what ceilRender writes.
 */
function pageVerdict(html, { cost = null } = {}) {
  const js = inlineScripts(html);
  const lifted = VERDICT_FNS.map((n) => [n, fnSrc(js, n)]);
  const missing = lifted.filter(([n, s]) => s == null && REQUIRED_FNS.includes(n)).map(([n]) => n);
  if (missing.length) throw new Error(`the served page has no ${missing.join(', ')}`);
  const costAttr = html.match(/<input id="cost"[^>]*\bvalue="([^"]*)"/);
  if (!costAttr) throw new Error('the served page has no cost input');
  const rowVals = [...html.matchAll(/name="m_(\d+)" value="([^"]*)"/g)].map((m) => m[2]);
  if (!rowVals.length) throw new Error('the served page has no margin rows');
  const neutral = html.match(/id="ceilHead" data-neutral="([^"]*)"/);
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, textContent: '', hidden: true,
    getAttribute: (a) => (id === 'ceilHead' && a === 'data-neutral' && neutral ? neutral[1] : null),
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const ctx = {
    ptRows: [],
    document: { getElementById: el },
    nf: new Intl.NumberFormat('en-IN'),
    cost: { value: cost != null ? String(cost) : costAttr[1] },
    over: { value: '' },
    rows: rowVals.map((v) => ({ querySelector: (s) => (s === '.mpct' ? { value: v } : null), classList: { add() {}, remove() {} } })),
  };
  vm.createContext(ctx);
  vm.runInContext(['REPRICE', 'CEILING', 'CEILSTATE', 'GUARDPCT', 'CUSTMIN', 'HARDFLOOR'].map((n) => `var ${n}=${varSrc(js, n)};`).join('\n')
    + '\n' + lifted.filter(([, s]) => s).map(([, s]) => s).join('\n'), ctx);
  vm.runInContext('ceilRender()', ctx);
  const cv = vm.runInContext('cval()', ctx);
  return {
    CUSTMIN: vm.runInContext('CUSTMIN', ctx), REPRICE: vm.runInContext('REPRICE', ctx), rows: rowVals, cost: cv,
    reason: vm.runInContext(`ceilReason(${cv})`, ctx),
    head: el('ceilHead').textContent, verdict: el('ceilVerdict').textContent,
    why: el('ceilWhy').textContent, fix: el('ceilFix').hidden ? null : el('ceilFix').textContent,
  };
}
const show = (v) => `CUSTMIN ${v.CUSTMIN}, reason ${v.reason}, head "${v.head}", verdict "${v.verdict}"`
  + `${v.why ? `, why "${v.why}"` : ''}${v.fix ? `, fix "${v.fix}"` : ''}`;
function assertOneBid(v, what) {
  assert.ok(v.REPRICE === true, `${what}: not the re-price page`);
  assert.deepStrictEqual([v.cost, v.rows], [Number(COST), ['13', '7.2', '6.3']], `${what}: served cost and rows`);
  assert.ok(v.reason === null && v.verdict === ONE_BID && v.fix === null,
    `${what} judges the rows on their lowest row, not the customer minimum the server keeps as the guard: ${show(v)}`);
}

const now = Date.now();
const mkLoad = (id, { ceilingPrice = CEILING } = {}) => ({
  id, lane: { origin: 'Vapi', destination: 'Nagpur' }, equipment: '32 Feet', units: 1,
  companyName: 'Ceiling Verdict Test Shipper', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live', rules: { ceilingPrice, pricingMode: 'flat', minDecrement: 100 },
});
const liveMonitor = (loadId) => {
  for (const s of stacks) {
    const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
    if (m && !m.finalized) return m;
  }
  return null;
};
const tick = () => new Promise((r) => setImmediate(r));

// The race: the next capture() for `token` first lets another desk's capture land, then runs, and
// records how it ended (NOT_OPEN is the lost race).
const realCapture = requests.capture;
let race = null;
requests.capture = async function capture(token, body) {
  if (!(race && race.token === token && !race.done)) return realCapture.call(this, token, body);
  race.done = true;
  await race.first();
  try { return await realCapture.call(this, token, body); } catch (e) { race.lost = e.code; throw e; }
};

let checks = 0;
const failures = [];
async function check(label, fn) {
  checks++;
  try { await fn(); console.log(`  ok  ${checks}. ${label}`); }
  catch (e) { failures.push(`${checks}. ${label} - ${e.message.split('\n')[0]}`); console.error(`  FAIL ${checks}. ${label} - ${e.message}`); }
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (id, opts) => req('POST', `${base}/price/${id}`, opts);
  const armEdited = async (loadId, opts) => {
    const r = await requests.createForLoad(mkLoad(loadId, opts));
    const res = await post(r.id, json({ cost: COST, use_override: '1', ...EDITED }));
    await tick();
    assert.ok(res.status < 400, `setup: the edited capture of ${loadId} was refused ${res.status}: ${said(res)}`);
    const doc = await requests.getByToken(r.id);
    assert.ok(doc.status === 'armed' && doc.marginSource === 'bid' && doc.marginOverride
      && doc.marginOverride.minMarginPct === 5 && !doc.marginOverride.belowMinimum,
    `setup: ${loadId} should be armed on a per-load override with minimum 5 and no below-minimum record: ${JSON.stringify(doc.marginOverride)}`);
    return r;
  };
  // What the server does with the page's own cost and rows: a re-price with no ceiling or minimum ack.
  // Named reversal (owner ruling 26 Sep): re-posting the saved cost and rows is a same-rate re-save,
  // refused on the page with nothing changed. The server's verdict on these figures is the ladder
  // they are already armed on, so that is what is read.
  const serverOneBid = async (id, loadId) => {
    const res = await post(id, json({ cost: COST, ...EDITED }));
    await tick();
    assert.ok(res.status === 409 && res.json && /is already the rate on this load\. Nothing to change\.$/.test(res.json.error),
      `the same cost and rows are not refused as a same-rate re-save: ${res.status} ${said(res)}`);
    const m = liveMonitor(loadId);
    assert.ok(m, 'nothing is armed after the re-price');
    assert.deepStrictEqual(m.ladder, [CEILING], `armed ladder ${m.ladder}`);
  };

  // ---- setup: four armed loads, each on rows [13, 7.2, 6.3] at 100,000 under a 105,500 ceiling ----
  const ctl = await armEdited('VR-GET');
  assert.deepStrictEqual(liveMonitor('VR-GET') && liveMonitor('VR-GET').ladder, [CEILING], 'setup: the capture arms one bid at the ceiling');

  const stray = await armEdited('VR-STRAY');
  const strayRes = await post(stray.id, form({ cost: COST }));
  assert.ok(strayRes.status === 200 && /var REPRICE=true/.test(strayRes.text),
    `setup: the stray one-field POST should be served the re-price page: ${strayRes.status} ${said(strayRes)}`);

  const raced = await requests.createForLoad(mkLoad('VR-RACE'));
  let winner = null;
  race = { token: raced.id, first: async () => { winner = await post(raced.id, json({ cost: COST, use_override: '1', ...EDITED })); } };
  const raceRes = await post(raced.id, form({ cost: COST }));
  await tick();
  assert.ok(winner && winner.status === 200, `setup: the other desk's capture did not land first: ${winner && winner.status}`);
  assert.strictEqual(race.lost, 'CAPTURE_LOST', 'setup: the losing capture should fail CAPTURE_LOST');

  // Resume: arm with no ceiling, put a bid on the board at the lowest rung, correct the cost so every
  // rung is above that bid (held), then the shipper's ceiling is on the load before the desk resumes -
  // written onto the stored load, the way test-resume-arms-or-refuses.js writes the close.
  const held = await armEdited('VR-RESUME', { ceilingPrice: null });
  const hm = liveMonitor('VR-RESUME');
  hm.lastBidPrice = STANDING;
  hm.landedBids = 1;
  for (const s of stacks) {
    if (s.engine && s.engine.scheduler && s.engine.scheduler.get('VR-RESUME')) {
      s.engine.scheduler.update('VR-RESUME', { landedBids: 1, landedBidPrice: STANDING, everBid: true });
    }
  }
  const corrected = await post(held.id, json({ cost: CORRECTED, ...EDITED }));
  const heldDoc = await requests.getByToken(held.id);
  assert.ok(corrected.status === 200 && heldDoc.hold && heldDoc.hold.kind === 'standing',
    `setup: the correction should hold the load: ${corrected.status} ${said(corrected)}`);
  await store.patchDoc('priceRequests', held.id,
    { load: Object.assign({}, heldDoc.load, { rules: Object.assign({}, heldDoc.load.rules, { ceilingPrice: CEILING }) }) });
  const resumeRes = await req('POST', `${base}/price/${held.id}/resume`, form({}));
  await tick();
  assert.ok(resumeRes.status === 200 && /Bidding resumed\./.test(resumeRes.text) && /var REPRICE=true/.test(resumeRes.text),
    `setup: the resume should serve the re-price page saying bidding resumed: ${resumeRes.status} ${said(resumeRes)}`);
  const rdoc = await requests.getByToken(held.id);
  assert.ok(!rdoc.hold && rdoc.marginSource === 'bid' && rdoc.minMarginPct === 5,
    `setup: the resume should restore the per-load plan at minimum 5: hold ${!!rdoc.hold}, ${rdoc.marginSource}, ${rdoc.minMarginPct}`);
  assert.deepStrictEqual(liveMonitor('VR-RESUME') && liveMonitor('VR-RESUME').ladder, [CEILING],
    'setup: the resumed plan should be bid once at the ceiling');

  console.log('\n1. control: the GET re-price page (it passes the customer minimum)');
  await check('GET /price on the armed load: the page reads one bid at Rs 1,05,500, no fix offered', async () => {
    const page = await req('GET', `${base}/price/${ctl.id}`);
    assert.strictEqual(page.status, 200);
    const v = pageVerdict(page.text);
    assert.strictEqual(v.CUSTMIN, 5, `the GET page inlines CUSTMIN ${v.CUSTMIN}`);
    assertOneBid(v, 'the GET re-price page');
  });

  console.log('\n2-4. the other renders of the same page');
  await check('stray POST of the one-field capture form to the armed load: the page it serves reads one bid at Rs 1,05,500', async () => {
    assertOneBid(pageVerdict(strayRes.text), 'the stray-POST page');
  });
  await check('a capture that lost the race to another desk: served an error saying so, and no price form to misjudge', async () => {
    const shown = raceRes.text.replace(/&#39;/g, "'");
    assert.ok(raceRes.status === 409 && shown.includes('Not saved: another price was saved for this load just now. Reload to see it.'),
      `the raced capture is an error on the screen: ${raceRes.status} ${said(raceRes)}`);
    assert.ok(!/var REPRICE=/.test(raceRes.text), 'and no re-price form is rendered for it');
  });
  await check('resume from hold: the "Bidding resumed." page reads one bid at Rs 1,05,500', async () => {
    assertOneBid(pageVerdict(resumeRes.text), 'the resumed page');
  });

  console.log('\n5-7. what the server does with the same cost and rows on submit');
  await check('stray-POST load: the same cost and rows re-posted are refused as a same-rate re-save, still armed at exactly [105500]', () => serverOneBid(stray.id, 'VR-STRAY'));
  await check('raced load: the same cost and rows re-posted are refused as a same-rate re-save, still armed at exactly [105500]', () => serverOneBid(raced.id, 'VR-RACE'));
  await check('resumed load: the same cost and rows re-posted are refused as a same-rate re-save, still armed at exactly [105500]', () => serverOneBid(held.id, 'VR-RESUME'));

  console.log('\n8. control: a cost the customer minimum cannot fit under the ceiling');
  await check('stray-POST page at cost 101,000: "Price too high", and the server refuses that re-price', async () => {
    const v = pageVerdict(strayRes.text, { cost: DEAD_COST });
    assert.ok(v.reason === 'margin' && v.head === 'Price too high', `the page should say the load is dead: ${show(v)}`);
    const res = await post(stray.id, json({ cost: String(DEAD_COST), ...EDITED }));
    assert.strictEqual(res.status, 400, `the server answered ${res.status}: ${said(res)}`);
    assert.deepStrictEqual(liveMonitor('VR-STRAY') && liveMonitor('VR-STRAY').ladder, [CEILING], 'the refused re-price moved the armed ladder');
  });

  requests.capture = realCapture;
  for (const s of stacks) { try { if (s.engine) s.engine.kill('test done'); } catch (_) {} }
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} of ${checks} checks - a re-price page rendered without the customer minimum (renderRequestStatus, resume) judges the ceiling on the lowest row, so a load the server bids once at the ceiling reads "Price too high":`);
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nPASS: all ${checks} checks - every render of the /price re-price page judges the ceiling on the customer minimum, as the server does`);
  process.exit(0);
})().catch((e) => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.error('FAIL (setup):', e && e.stack);
  process.exit(1);
});
