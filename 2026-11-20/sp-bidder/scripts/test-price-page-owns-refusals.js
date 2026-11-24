'use strict';
/**
 * The price page owns the desk's own refusals; WhatsApp does not repeat them (owner ruling 26 Sep:
 * "Bid Command portal side rejections need not be surfaced on the wa messages ... price page errors
 * are responsible for that itself").
 *
 * Regression target: Waaree 2609269ZYK. Cost Rs 1,65,000 already saved, our bids Rs 1,79,850 and
 * Rs 1,73,910 both off it; the desk re-saved the same Rs 1,65,000, the load went on hold, and the
 * Director got "New rate saved. Bidding stopped on this load." with three figures he could not read.
 *
 *   1. A re-price whose rate equals the saved rate, band unchanged, is refused on the page: 409,
 *      "Rs {rate} is already the rate on this load. Nothing to change.", no write, no re-arm, no audit
 *      row, no WhatsApp. Per-type loads: only when every rate is equal. A margin-only change is not
 *      one. Resume is never refused as a same rate, and neither is a re-save on a held load.
 *   2. A genuinely lower re-price whose rate plus margin still does not beat our board bid shows the
 *      page's hold panel, and the engine's reprice_unreachable_ladder reaches no WhatsApp.
 *   3. The portal-refusal notices, the one desk notice that is sometimes the only notice
 *      (ceiling_below_floor), the ops alerts and the result receipts all still send.
 *
 * @requires-summary-line
 *
 *   node scripts/test-price-page-owns-refusals.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5.4';
process.env.SP_MIN_MARGIN_PCT = '5.4';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-page-owns-refusals-'));

const http = require('http');
const { app, requests, stacks, store, notifier } = require('../src/web/server');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');

const EXPECTED = 32;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL - ' + m); } };

function call(method, url, { body = null, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const asc = (v) => JSON.stringify(v === undefined ? null : v).replace(/[^ -~]/g, (c) => 'u+' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const visible = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');

const sent = [];
notifier.alert = async (kind, data, opts) => { sent.push({ kind, data, dedupeKey: opts && opts.dedupeKey }); return true; };
const sentFor = (loadId) => sent.filter((s) => s.data && (String(s.data.auctionId) === loadId || String(s.data.loadId) === loadId));

const now = Date.now();
const mkLoad = (id, over) => Object.assign({
  id, lane: { origin: 'Samakhiyali', destination: 'Noida' }, equipment: '32 ft MXL', units: 1,
  quoteType: 'FTL', companyName: 'Waaree Energies Ltd.', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
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

const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };
const monitorOf = (id) => {
  for (const s of stacks) { const m = s.engine && s.engine.monitors && s.engine.monitors.get(id); if (m) return { m, engine: s.engine }; }
  return { m: null, engine: null };
};
const auditRows = async (loadId) => ((await store.readEvents('configChanges')) || [])
  .filter((e) => e && Array.isArray(e.changed) && e.changed.some((c) => String(c).includes(String(loadId)))).length;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const capture = (token, fields) => call('POST', `${base}/price/${token}`, { body: form(fields), contentType: 'application/x-www-form-urlencoded' });
  const repriceJson = (token, fields) => call('POST', `${base}/price/${token}`, { body: JSON.stringify(fields) });
  const repriceForm = (token, fields) => call('POST', `${base}/price/${token}`, { body: form(fields), contentType: 'application/x-www-form-urlencoded' });
  const resume = (token) => call('POST', `${base}/price/${token}/resume`, { body: '{}' });
  const bandFields = (doc) => Object.fromEntries((doc.marginsPct || []).map((m, i) => [`m_${i}`, String(m)]));

  const armed = async (id, fields, over) => {
    const r = await requests.createForLoad(mkLoad(id, over));
    const res = await capture(r.id, fields);
    const doc = await requests.getByToken(r.id);
    if (res.status !== 200 || doc.status !== 'armed') throw new Error(`setup: could not arm ${id} (HTTP ${res.status}, ${doc.status})`);
    return doc;
  };
  const standBid = (id, price) => {
    const { m } = monitorOf(id);
    if (!m) throw new Error(`setup: no monitor for ${id}`);
    m.lastBidPrice = price;
    m.landedBids = 1;
    for (const s of stacks) {
      if (s.engine && s.engine.scheduler && s.engine.scheduler.get(id)) {
        s.engine.scheduler.update(id, { landedBids: 1, landedBidPrice: price, everBid: true });
      }
    }
  };

  try {
    console.log('\n1. the same rate re-saved is refused on the page, and nothing changes (2609269ZYK)');
    {
      const doc = await armed('ZYK-1', { cost: '165000' });
      standBid('ZYK-1', 173_910);
      const before = JSON.stringify(await requests.getByToken(doc.id));
      const monBefore = monitorOf('ZYK-1').m;
      const auditBefore = await auditRows('ZYK-1');
      const sentBefore = sentFor('ZYK-1').length;

      const res = await repriceJson(doc.id, { cost: '165000', ...bandFields(doc) });
      ok(res.status === 409, `the re-save is refused with 409 (got ${res.status})`);
      ok(!!res.json && res.json.error === '₹1,65,000 is already the rate on this load. Nothing to change.',
        `in the page's own line (got ${asc(res.json && res.json.error)})`);
      ok(JSON.stringify(await requests.getByToken(doc.id)) === before, 'the price request is byte-identical: no cost, band, hold or epoch write');
      ok(monitorOf('ZYK-1').m === monBefore, 'the live monitor is the same object: no stop, no re-arm, the load keeps bidding as it was');
      ok((await auditRows('ZYK-1')) === auditBefore, 'no margin-audit row is written for a save that changed nothing');
      ok(sentFor('ZYK-1').length === sentBefore, 'and nothing goes to WhatsApp');

      const html = await repriceForm(doc.id, { cost: '165000', ...bandFields(doc) });
      ok(html.status === 409 && visible(html.text).includes('₹1,65,000 is already the rate on this load. Nothing to change.'),
        `the HTML form post gets the same refusal on the page (HTTP ${html.status})`);
      ok(JSON.stringify(await requests.getByToken(doc.id)) === before && monitorOf('ZYK-1').m === monBefore,
        'and still changes nothing');
    }

    console.log('\n1b. with no live monitor the same rate re-saved still re-arms the load');
    {
      const doc = await armed('NOMON-1', { cost: '165000' });
      monitorOf('NOMON-1').engine.stop('NOMON-1');
      const res = await repriceJson(doc.id, { cost: '165000', ...bandFields(doc) });
      ok(res.status === 200 && !!monitorOf('NOMON-1').m, `accepted and bidding again (HTTP ${res.status})`);
    }

    console.log('\n2. a margin-only change on the same rate is not a same-rate re-save');
    {
      const doc = await armed('MRG-1', { cost: '165000' });
      const sentBefore = sentFor('MRG-1').length;
      const res = await repriceJson(doc.id, { cost: '165000', m_0: '10', m_1: '6' });
      const after = await requests.getByToken(doc.id);
      ok(res.status === 200, `a new band on the same rate saves (got ${res.status})`);
      ok(after.price.cost === 165_000 && JSON.stringify(after.marginsPct) === '[10,6]', `stored ${after.price.cost} at ${JSON.stringify(after.marginsPct)}`);
      ok(sentFor('MRG-1').slice(sentBefore).some((s) => s.kind === 'price_submitted'),
        'and the re-price receipt still goes out, unchanged');
    }

    console.log('\n3. per-type: refused only when every rate is equal');
    {
      const doc = await armed('PT-1', { cost: blendOf(45000, 40000), cost_type_0: '45000', cost_type_1: '40000' }, TWO_TYPES);
      const before = JSON.stringify(await requests.getByToken(doc.id));
      const monBefore = monitorOf('PT-1').m;
      const same = await repriceJson(doc.id, { cost: blendOf(45000, 40000), ...bandFields(doc), cost_type_0: '45000', cost_type_1: '40000' });
      ok(same.status === 409 && !!same.json && /^₹45,000 and ₹40,000 are already the rates on this load\. Nothing to change\.$/.test(same.json.error),
        `every rate equal is refused (HTTP ${same.status}, ${asc(same.json && same.json.error)})`);
      ok(JSON.stringify(await requests.getByToken(doc.id)) === before && monitorOf('PT-1').m === monBefore, 'with nothing written and no re-arm');
      const one = await repriceJson(doc.id, { cost: blendOf(45000, 39000), ...bandFields(doc), cost_type_0: '45000', cost_type_1: '39000' });
      const after = await requests.getByToken(doc.id);
      ok(one.status === 200 && after.price.costByType.types.map((t) => t.cost).join(',') === '45000,39000',
        `one rate changed saves (HTTP ${one.status})`);
    }

    console.log('\n4. resume is never refused as a same rate: a desk hold resumed at the held plan re-arms and bids');
    {
      const doc = await armed('RES-1', { cost: '30000' });
      await requests.holdBidding(doc.id, { kind: 'standing', reason: 'new_floor_above_standing_bid',
        standingBidPrice: 32_700, correctedCost: 30_000, floor: 31_620,
        resume: { cost: 30_000, marginsPct: doc.marginsPct, minMarginPct: doc.minMarginPct, marginSource: doc.marginSource } });
      const monHeld = monitorOf('RES-1').m;
      const res = await resume(doc.id);
      const after = await requests.getByToken(doc.id);
      const { m } = monitorOf('RES-1');
      ok(res.status === 200 && !!res.json && !res.json.held,
        `a resume at the held plan (Rs 30,000, the rate already saved) is taken, not refused as a same rate (HTTP ${res.status}, ${asc(res.json && res.json.error)})`);
      ok(!after.hold && !!m && m !== monHeld && !m._unreachableLadderAlerted && m.ladder.length > 0,
        'the hold record is retired and a fresh monitor is armed on the plan, free to bid');
    }

    console.log('\n4b. on a held load the same rate re-saved is not refused either');
    {
      const doc = await armed('HELD-1', { cost: '30000' });
      standBid('HELD-1', 32_700);
      const first = await repriceJson(doc.id, { cost: '31100', ...bandFields(doc) });
      if (first.status !== 200 || !(await requests.getByToken(doc.id)).hold) throw new Error(`setup: the upward correction should hold (HTTP ${first.status})`);
      const again = await repriceJson(doc.id, { cost: '31100', ...bandFields(doc) });
      ok(again.status === 200 && !!again.json && !!again.json.held,
        `the re-save goes through and the page shows the hold again (HTTP ${again.status}, ${asc(again.json && again.json.error)})`);
    }

    console.log('\n5. a genuine lower re-price that still cannot beat our board bid: page explains, WhatsApp silent');
    {
      const doc = await armed('LOW-1', { cost: '30000' });
      standBid('LOW-1', 32_700);
      const sentBefore = sentFor('LOW-1').length;
      const res = await repriceJson(doc.id, { cost: '29900', m_0: '12', m_1: '10' });
      const saveSent = sentFor('LOW-1').slice(sentBefore);
      ok(res.status === 200 && !!res.json && !!res.json.held, `the lower rate saves and comes back held (HTTP ${res.status})`);
      const panel = String(res.json && res.json.held && res.json.held.panel);
      ok(/On hold/.test(panel) && panel.includes('Rs 32,700') && panel.includes('Rs 29,900'),
        'the page panel states it: on hold, our Rs 32,700 on the board, your Rs 29,900');

      const { m, engine } = monitorOf('LOW-1');
      const seen = [];
      const realEmit = engine.emit.bind(engine);
      engine.emit = (e) => { seen.push(e); return realEmit(e); };
      const mark = sent.length;
      try { engine._decide(m, { closesInMs: 20 * 60_000 }); } finally { engine.emit = realEmit; }
      await settle();
      const evt = seen.find((e) => e && e.kind === 'reprice_unreachable_ladder');
      ok(!!evt && evt.standingBidPrice === 32_700 && evt.correctedCost === 29_900,
        'the engine still stands the load down and raises reprice_unreachable_ladder for the record');
      const routed = sent.slice(mark).filter((x) => x.data && x.data.auctionId === 'LOW-1');
      ok(routed.length === 0, `the server sends it to nobody, because the page showed this hold (sent ${JSON.stringify(routed.map((x) => x.kind))})`);
      ok(saveSent.every((x) => x.kind !== 'price_submitted' && x.kind !== 'desk_notice'),
        `and the save itself sent no receipt and no notice (sent ${JSON.stringify(saveSent.map((x) => x.kind))})`);
    }

    console.log('\n6. what still sends: portal refusals, the ceiling stand-down, ops alerts');
    {
      const lane = { origin: 'Bhuj', destination: 'Chennai' };
      const deskEvt = (kind, over) => Object.assign({ type: 'alert', level: 'error', kind, auctionId: `P-${kind}`,
        lane, companyName: 'Waaree Energies Ltd.', branchName: '' }, over || {});
      for (const [kind, over] of [
        ['bid_price_raise_refused', { round: 1, standingQuote: 150000 }],
        ['refused_price_bound', { round: 1, price: 150000, refusal: 'bid must be lower' }],
        ['refusal_unrecognised', { round: 1, price: 150000, refusal: 'something new' }],
        ['ceiling_below_floor', { ceiling: 30000, floor: 30540, cost: 29000 }],
      ]) {
        const mark = sent.length;
        await notifyEngineEvent(notifier, deskEvt(kind, over), null, null, null);
        const got = sent.slice(mark).filter((x) => x.data && x.data.auctionId === `P-${kind}`);
        ok(got.length === 1 && got[0].kind === 'desk_notice' && got[0].data.reason === kind,
          `${kind} still reaches the desk group (${JSON.stringify(got.map((s) => s.kind))})`);
      }
      for (const kind of ['close_unknown_held', 'reprice_arm_failed']) {
        const mark = sent.length;
        await notifyEngineEvent(notifier, { type: 'alert', level: 'error', kind, auctionId: `O-${kind}`, detail: kind, episode: 1 }, null, null, null);
        const got = sent.slice(mark).filter((x) => x.data && x.data.auctionId === `O-${kind}`);
        ok(got.length === 1 && got[0].kind === 'error', `${kind} still pages ops (${JSON.stringify(got.map((s) => s.kind))})`);
      }
    }

    console.log('\n7. result receipts are unchanged');
    {
      const result = (id, won, landedBids) => ({ type: 'auction_result', auctionId: id, won, landedBids,
        lane: { origin: 'Pune', destination: 'Nashik' }, companyName: 'Waaree Energies Ltd.', branchName: '' });
      for (const [id, won, landed, kind] of [['RC-WON', true, 2, 'won'], ['RC-LOST', false, 2, 'lost'], ['RC-NOBID', false, 0, 'lost']]) {
        const mark = sent.length;
        await notifyEngineEvent(notifier, result(id, won, landed), null, null, null);
        const got = sent.slice(mark).filter((x) => x.data && x.data.auctionId === id);
        ok(got.length === 1 && got[0].kind === kind && got[0].dedupeKey === `${id}_${kind}`,
          `${id} sends its ${kind} receipt under the same key (${JSON.stringify(got.map((s) => [s.kind, s.dedupeKey]))})`);
      }
    }
  } finally {
    server.close();
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  if (fail || pass !== EXPECTED) {
    console.log(`FAIL - ${fail} failed, ${pass} passed, expected ${EXPECTED}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL (threw):', e && e.stack || e); process.exit(1); });
