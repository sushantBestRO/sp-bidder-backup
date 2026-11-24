'use strict';
/**
 * A LOAD THE ENGINE HAS ALREADY FINALIZED TAKES NO MORE PRICES.
 *
 * Live case (26 Sep, SuperProcure 25829357, Havells): priced 66 s before the posted close, the first
 * read showed the auction over and the engine finalized it as lost. The request still read armed, so
 * the price page accepted two more re-prices before the posted close. Each one stopped the finalized
 * monitor, armed a fresh one, finalized it again, and sent the desk group another "rate submitted"
 * receipt for a load nothing would ever bid.
 *
 * Pinned:
 *   1. a re-price (script JSON and no-script form) on a finalized load is refused with
 *      "This auction has closed. Nothing was saved." - nothing is armed, saved or sent
 *   2. exactly one outcome per load: the repeats add no auction_result, no alert, no receipt
 *   3. the same holds after a restart, when only the closed record remains
 *   4. control: a closed-while-down record (result unknown) still takes a re-price
 *
 *   node scripts/test-closed-load-refuses-price.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-closed-load-'));

const http = require('http');
const { app, requests, store, stacks, notifier } = require('../src/web/server');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const WORDS = 'Auction closed. Nothing saved.';

function post(base, id, { json, form }) {
  const body = json ? JSON.stringify(json) : Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const type = json ? 'application/json' : 'application/x-www-form-urlencoded';
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}/price/${id}`, { method: 'POST', headers: { 'content-type': type, 'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ status: res.statusCode, json: j, text: b }); }); });
    r.on('error', reject); r.write(body); r.end();
  });
}
const said = (res) => (res.json ? res.json.error || '' : res.text.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
let seq = 0;
const load = () => ({ id: `CLR-${++seq}`, lane: { origin: 'Tumkur', destination: 'Bangalore' }, equipment: '32 FT SXL', units: 1,
  quoteType: 'FTL', companyName: 'Havells India', closesAt: Date.now() + 66_000, startsAt: Date.now() - 14 * 60_000,
  softClose: false, closeModelKnown: true, status: 'live' });
const band = { m_0: '9', m_1: '5', m_2: '1', rows_shown: '9,5,1' };

const calls = { receipts: [], alerts: [] };
const realConfirm = notifier.confirmSubmitted.bind(notifier);
const realAlert = notifier.alert.bind(notifier);
notifier.confirmSubmitted = (req, ...rest) => { calls.receipts.push(req && req.loadId); return realConfirm(req, ...rest); };
notifier.alert = (kind, payload, ...rest) => { calls.alerts.push([kind, payload && (payload.auctionId || payload.loadId)]); return realAlert(kind, payload, ...rest); };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = stacks[0].engine;
  const eventsFor = (id, type) => engine.events.filter((e) => e.type === type && String(e.auctionId) === id).length;

  // Arms the load, then has the engine finalize it the way the live read did.
  const finalizedLoad = async () => {
    const r = await requests.createForLoad(load());
    const armed = await post(base, r.id, { json: { cost: '19000' } });
    const id = String(r.loadId);
    const m = engine.monitors.get(id);
    if (armed.status !== 200 || !m) throw new Error(`setup: ${id} did not arm (HTTP ${armed.status}: ${said(armed)})`);
    await engine._finalize(m, { myRank: null });
    await settle();
    return { r, id, monitor: m };
  };

  console.log('\n1-2. re-price on a load the engine finalized');
  {
    const { r, id, monitor } = await finalizedLoad();
    const before = { results: eventsFor(id, 'auction_result'), armed: eventsFor(id, 'armed'), receipts: calls.receipts.length,
      alerts: calls.alerts.filter(([, a]) => String(a) === id).length };
    ok(before.results === 1, `setup: the engine booked one outcome (${before.results})`);
    const viaScript = await post(base, r.id, { json: { cost: '19000', ...band, m_2: '5' } });
    const viaForm = await post(base, r.id, { form: { cost: '19500', ...band } });
    await settle();
    ok(viaScript.status === 410 && said(viaScript) === WORDS, `script re-price refused (HTTP ${viaScript.status}: ${said(viaScript).slice(0, 160)})`);
    ok(viaForm.status === 410 && said(viaForm).includes(WORDS), `form re-price refused (HTTP ${viaForm.status}: ${said(viaForm).slice(0, 200)})`);
    ok(engine.monitors.get(id) === monitor && monitor.finalized, 'the finalized monitor was not replaced by a fresh arm');
    ok(eventsFor(id, 'armed') === before.armed, `no new arm (${eventsFor(id, 'armed')} armed events, was ${before.armed})`);
    ok(eventsFor(id, 'auction_result') === 1, `exactly one outcome for the load (${eventsFor(id, 'auction_result')})`);
    ok(calls.alerts.filter(([, a]) => String(a) === id).length === before.alerts, 'no further alert for the load');
    ok(calls.receipts.length === before.receipts, `no further "rate submitted" receipt (${calls.receipts.length - before.receipts} sent)`);
    const after = await requests.getByToken(r.id);
    ok(after.price.cost === 19000 && JSON.stringify(after.marginsPct) === JSON.stringify([9, 5, 1]),
      `nothing was saved (cost ${after.price.cost}, band ${after.marginsPct})`);
  }

  console.log('\n3. after a restart only the closed record remains');
  {
    const { r, id } = await finalizedLoad();
    engine.monitors.delete(id);
    const res = await post(base, r.id, { form: { cost: '19500', ...band } });
    await settle();
    ok(res.status === 410 && said(res).includes(WORDS), `refused on the closed record alone (HTTP ${res.status}: ${said(res).slice(0, 160)})`);
    ok(!engine.monitors.get(id), 'and nothing was armed');
  }

  console.log('\n4. control: a close the engine never saw (closed while down) still takes a re-price');
  {
    const r = await requests.createForLoad(load());
    const armed = await post(base, r.id, { json: { cost: '19000' } });
    const id = String(r.loadId);
    await store.patchDoc('closedBids', id, { status: 'closed', closedWhileDown: true });
    const res = await post(base, r.id, { json: { cost: '19500', ...band } });
    ok(armed.status === 200 && res.status === 200, `re-price accepted (HTTP ${res.status}: ${said(res).slice(0, 160)})`);
  }

  server.close();
  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
