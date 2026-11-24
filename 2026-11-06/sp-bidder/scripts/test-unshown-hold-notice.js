'use strict';
/**
 * The "New rate saved. Bidding stopped on this load." notice goes out only for a desk correction the
 * page did NOT show as held.
 *
 * Regression target: the 260908LD2Z shape. The desk corrects a cost while the old monitor's bid is
 * still on the wire. The save route reads no standing bid, so the page says "Saved - bidding", the
 * bid then lands and is handed to the new monitor, and the engine stands the load down on the
 * unreachable ladder. With the notice unrouted nobody was told and the page kept saying bidding.
 *
 *   A. in-flight race: exactly one notice, and the page then shows the hold;
 *   B. a hold the console route recorded: no notice;
 *   C. a GoComet floor landing on its own, no correction (2609269ZYK): no notice;
 *   D. a /price correction held on the page: the page shows it, no notice.
 *   E. a page hold written before this deploy (no epoch), then the restart re-emit: no notice, Resume kept;
 *   F. an existing page hold is never replaced by the engine hold;
 *   G. a late event from an older correction, after the next save: no notice, no hold written.
 *
 * Real server, real engine, events through the server's own routing chain.
 *
 * @requires-summary-line
 *
 *   node scripts/test-unshown-hold-notice.js
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
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-unshown-hold-'));

const http = require('http');
const { app, requests, stacks, notifier } = require('../src/web/server');

const EXPECTED = 15;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL - ' + m); } };

function call(method, url, { body = null, contentType = 'application/json', origin = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType; headers['content-length'] = Buffer.byteLength(body); }
    if (origin) headers.origin = origin;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const visible = (html) => String(html).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
const settle = async () => { for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r)); };

const sent = [];
notifier.alert = async (kind, data, opts) => { sent.push({ kind, data, dedupeKey: opts && opts.dedupeKey }); return true; };
const notices = (loadId, from = 0) => sent.slice(from).filter((s) => s.kind === 'desk_notice' && s.data
  && s.data.reason === 'reprice_unreachable_ladder' && String(s.data.auctionId) === loadId);

const now = Date.now();
const mkLoad = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
  softClose: false, closeModelKnown: true, status: 'live',
});
const live = (rank) => ({ ok: true, status: 'live', myRank: rank, totalBidders: 3, standingL1Price: null, closesInMs: 20_000,
  revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const monitorOf = (id) => {
  for (const s of stacks) { const m = s.engine && s.engine.monitors && s.engine.monitors.get(id); if (m) return { m, engine: s.engine, stack: s }; }
  return { m: null, engine: null, stack: null };
};
const quiet = (m) => { if (m && m.timer) clearTimeout(m.timer); };

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const capture = (token, fields) => call('POST', `${base}/price/${token}`, { body: form(fields), contentType: 'application/x-www-form-urlencoded' });
  const repriceJson = (token, fields) => call('POST', `${base}/price/${token}`, { body: JSON.stringify(fields) });
  const margin = (id, body) => call('POST', `${base}/api/price-requests/${id}/margin`, { body: JSON.stringify(body), origin: base });
  const armed = async (id, cost) => {
    const r = await requests.createForLoad(mkLoad(id));
    const res = await capture(r.id, { cost: String(cost) });
    if (res.status !== 200) throw new Error(`setup: could not arm ${id} (HTTP ${res.status})`);
    return r;
  };
  const standBid = (id, price) => {
    const { m, engine } = monitorOf(id);
    m.lastBidPrice = price;
    m.landedBids = 1;
    if (engine.scheduler.get(id)) engine.scheduler.update(id, { landedBids: 1, landedBidPrice: price, everBid: true });
  };

  try {
    console.log('\nA. a correction saved while the old bid is on the wire: one notice, and the page shows the hold');
    {
      const r = await armed('RACE-1', 29_000);
      const { m: m1, engine } = monitorOf('RACE-1');
      quiet(m1);
      let release = null;
      const realPlace = engine.adapter.placeBid;
      engine.adapter.placeBid = function (id, price, opts) {
        if (String(id) !== 'RACE-1') return realPlace.call(this, id, price, opts);
        return new Promise((res) => { release = () => res({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 30 }); });
      };
      const inFlight = engine._maybeBid(m1, live(2));
      await settle();
      if (!release) throw new Error('setup: the establishing bid never went on the wire');
      const mark = sent.length;
      const res = await repriceJson(r.id, { cost: '38000', m_0: '9', m_1: '7.2', m_2: '1.8' });
      ok(res.status === 200 && !!res.json && !res.json.held,
        `the page took the save as bidding, because no bid had landed when it read (HTTP ${res.status}, held ${!!(res.json && res.json.held)})`);
      const m2 = monitorOf('RACE-1').m;
      quiet(m2);
      release();
      await inFlight;
      engine.adapter.placeBid = realPlace;
      ok(m2.landedBids > 0 && m2.ladder[m2.ladder.length - 1] > m2.lastBidPrice,
        `the landed bid was handed to the new monitor, whose whole band now sits above it (${m2.lastBidPrice} vs floor ${m2.ladder[m2.ladder.length - 1]})`);
      await engine._maybeBid(m2, live(1));
      quiet(m2);
      await settle();
      const got = notices('RACE-1', mark);
      ok(m2._unreachableLadderAlerted === true && got.length === 1,
        `the engine holds the load and exactly one "New rate saved. Bidding stopped" notice goes out (sent ${got.length})`);
      const page = await call('GET', `${base}/price/${r.id}`);
      ok(!!(await requests.getByToken(r.id)).hold && /On hold/.test(visible(page.text)),
        'and the page no longer says bidding: the hold is on the record and the strip is shown');
    }

    console.log('\nB. a hold the console margin route recorded: no notice');
    {
      const r = await armed('CON-1', 29_000);
      standBid('CON-1', 31_610);
      const mark = sent.length;
      const res = await margin(r.id, { marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8, cost: 38_000, confirm: true });
      ok(res.status === 200 && !!res.json && !!res.json.held, `the console save comes back held (HTTP ${res.status})`);
      const { m, engine } = monitorOf('CON-1');
      quiet(m);
      await engine._maybeBid(m, live(2));
      quiet(m);
      await settle();
      ok(m._unreachableLadderAlerted === true && notices('CON-1', mark).length === 0,
        `the engine holds it and no notice goes out (sent ${notices('CON-1', mark).length})`);
    }

    console.log('\nD. a /price correction held on the page: the page shows it, no notice');
    {
      const r = await armed('PAGE-1', 29_000);
      standBid('PAGE-1', 31_610);
      const mark = sent.length;
      const res = await repriceJson(r.id, { cost: '38000', m_0: '9', m_1: '7.2', m_2: '1.8' });
      const panel = String(res.json && res.json.held && res.json.held.panel);
      ok(res.status === 200 && /On hold/.test(panel) && panel.includes('Rs 31,610') && panel.includes('Rs 38,000'),
        `the page shows the hold with both figures (HTTP ${res.status})`);
      const { m, engine } = monitorOf('PAGE-1');
      quiet(m);
      await engine._maybeBid(m, live(2));
      quiet(m);
      await settle();
      ok(m._unreachableLadderAlerted === true, 'the engine holds the load');
      ok(notices('PAGE-1', mark).length === 0, `and no notice goes out (sent ${notices('PAGE-1', mark).length})`);
    }
    console.log('\nC. a GoComet floor landing on its own, with no correction (2609269ZYK): no notice');
    {
      const realNow = Date.now;
      const H = require('./lib/walk-harness');
      const gc = H.load({ platform: 'gc', band: { cost: 50_000, marginsPct: [9, 1.8], minMarginPct: 1 }, gc: { roundPolicy: { finalAfterExtensions: 0 } } });
      for (let cd = 25_000; cd >= 1_000; cd -= 500) await gc.at(cd, { rank: gc.writes.length ? 2 : null });
      gc.done();
      Date.now = realNow;
      if (!gc.writes.length || gc.writes[gc.writes.length - 1].price !== gc.ladder[gc.ladder.length - 1]) {
        throw new Error(`setup: the walk-off GoComet run should land its floor (${JSON.stringify(gc.trace())})`);
      }
      const evts = gc.events.filter((e) => e.type === 'alert' && e.kind === 'reprice_unreachable_ladder');
      const id = String(gc.m.auctionId);
      const mark = sent.length;
      for (const e of gc.events) stacks[0].engine.onEvent(e);
      await settle();
      ok(evts.length === 0 && notices(id, mark).length === 0,
        `the engine raises no hold over its own floor (${evts.length}) and nothing goes to WhatsApp (${notices(id, mark).length})`);
    }

    // The latch that stops a second emit lives on the monitor, in memory; a restart rebuilds the
    // monitor at the same epoch and raises the hold again.
    const restartTick = async (id) => {
      const { m, engine } = monitorOf(id);
      quiet(m);
      m._unreachableLadderAlerted = false;
      m.noBid = null;
      await engine._maybeBid(m, live(2));
      quiet(m);
      await settle();
      return m;
    };
    const CORR = { cost: '38000', m_0: '9', m_1: '7.2', m_2: '1.8' };

    console.log('\nE. a page hold written before this deploy (no epoch on it), then the deploy restart: no notice, Resume kept');
    {
      const r = await armed('LEG-1', 29_000);
      standBid('LEG-1', 31_610);
      await repriceJson(r.id, CORR);
      const shown = await requests.getByToken(r.id);
      if (!shown.hold || !shown.hold.resume) throw new Error('setup: the correction should hold with a resume plan');
      const legacy = Object.assign({}, shown.hold);
      delete legacy.repriceEpoch;
      delete legacy.at;
      await requests.holdBidding(r.id, legacy);
      const mark = sent.length;
      const m = await restartTick('LEG-1');
      const after = await requests.getByToken(r.id);
      ok(m._unreachableLadderAlerted === true && notices('LEG-1', mark).length === 0,
        `the rebuilt monitor raises the hold again and nothing goes to WhatsApp (sent ${notices('LEG-1', mark).length})`);
      ok(!!after.hold && after.hold.source !== 'engine' && !!after.hold.resume,
        `the page hold stands with its Resume plan (source ${after.hold && after.hold.source}, resume ${!!(after.hold && after.hold.resume)})`);
    }

    console.log('\nF. an existing page hold is never replaced by the engine hold, whatever epoch it carries');
    {
      const r = await armed('KEEP-1', 29_000);
      standBid('KEEP-1', 31_610);
      await repriceJson(r.id, CORR);
      const shown = await requests.getByToken(r.id);
      await requests.holdBidding(r.id, Object.assign({}, shown.hold, { repriceEpoch: shown.repriceEpoch + 5 }));
      await restartTick('KEEP-1');
      const after = await requests.getByToken(r.id);
      ok(!!after.hold && after.hold.source !== 'engine' && !!after.hold.resume && after.hold.repriceEpoch === shown.repriceEpoch + 5,
        `the page hold is untouched (source ${after.hold && after.hold.source}, resume ${!!(after.hold && after.hold.resume)})`);
    }

    console.log('\nG. a late event from an older correction, after the next save: no notice, no hold written');
    {
      const r = await armed('STALE-1', 29_000);
      const { m: m1, engine } = monitorOf('STALE-1');
      quiet(m1);
      await repriceJson(r.id, { cost: '30000', m_0: '9', m_1: '5', m_2: '1' });
      await repriceJson(r.id, { cost: '31000', m_0: '9', m_1: '5', m_2: '1' });
      const before = await requests.getByToken(r.id);
      if (before.hold || !(before.repriceEpoch >= 2)) throw new Error(`setup: two bidding corrections expected (epoch ${before.repriceEpoch}, hold ${!!before.hold})`);
      quiet(monitorOf('STALE-1').m);
      const stale = { type: 'alert', level: 'error', kind: 'reprice_unreachable_ladder', auctionId: 'STALE-1',
        standingBidPrice: 31_610, correctedCost: 38_000, floor: 38_684, opening: 41_420, price: 38_684, reachAt: 31_609,
        repriceEpoch: before.repriceEpoch - 1, lane: m1.meta.lane, companyName: m1.meta.companyName };
      const mark = sent.length;
      engine.onEvent(stale);
      await settle();
      const after = await requests.getByToken(r.id);
      ok(notices('STALE-1', mark).length === 0, `nothing goes to WhatsApp (sent ${notices('STALE-1', mark).length})`);
      ok(!after.hold, `and no hold is written onto the load that is bidding (hold ${JSON.stringify(after.hold && { source: after.hold.source, epoch: after.hold.repriceEpoch })})`);
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
