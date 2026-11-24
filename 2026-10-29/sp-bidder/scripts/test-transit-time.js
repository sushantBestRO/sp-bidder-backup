'use strict';
/**
 * CONDITIONAL TRANSIT TIME (Module 2 L2) - the capture -> carry -> wire -> fail-closed loop.
 *
 * SuperProcure loads carrying loadIsTransitTimeOn REQUIRE transit time on the bid: transitTime
 * null -> HTTP 400, "3" (a STRING of days) -> 201, proven live on SIKA. The days are not on the
 * load - a pricing operator enters them with the cost - and they are sticky per load (every
 * rung/revision re-sends the same value). This file proves the whole loop around the wire golden
 * (which lives in test-loadrules-payload.js sections 8-9):
 *   A. capture() intake gate: a transit-required load cannot be priced without valid days
 *      (BAD_INPUT, actionable message); a non-transit load DISCARDS any days it is handed.
 *   B. armFromRequest merges the captured days onto the LoadRules (meta.rules.transitDays),
 *      without mutating the request's own rules snapshot; the merged rules ride the durable
 *      intent and survive a restart (sticky across rehydrate).
 *   C. the engine hands them to placeBid, and FAILS CLOSED (MISSING_TRANSIT_TIME, no rung spent,
 *      no bid, transit_time_missing_blocked alert -> WhatsApp 'error') on a transit-required
 *      monitor with no days - e.g. a request captured before the transit build deployed.
 *   D. setBidOverride is SET-ONCE recovery for exactly those legacy requests: it fills missing
 *      days and never edits existing ones; clearBidOverride preserves them.
 *   E. the price_needed WhatsApp ask tells the pricing person days are needed (transit loads only).
 *   F. the /price page: required days field on capture, server-side 400 without it, fixed
 *      (read-only) display once captured, editable recovery field on a legacy armed request.
 *
 *   node scripts/test-transit-time.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir + intent files), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-transit-'));

const http = require('http');
const assert = require('assert');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');
const { deriveLoadRules, normalizeTransitDays, MAX_TRANSIT_DAYS } = require('../src/model/loadRules');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');
const { app, requests, store } = require('../src/web/server');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const tmp = (tag) => path.join(os.tmpdir(), `transit-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];

async function throwsBad(fn, label) {
  try { await fn(); } catch (e) {
    assert.strictEqual(e.code, 'BAD_INPUT', `${label}: expected BAD_INPUT, got ${e.code || '(no code)'} - ${e.message}`);
    return;
  }
  assert.fail(`${label}: expected BAD_INPUT, nothing thrown`);
}

// a SIKA-shaped transit-required raw SP load -> the exact rules a real discovery tick derives
const transitRules = (id) => deriveLoadRules({
  id, companyName: 'SIKA India', branchCarrierCarrierId: 2667, loadIsTransitTimeOn: 1,
  branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3,
});
const mkLoad = (id, { transit = true } = {}) => ({
  id, lane: { origin: 'Pune', destination: 'Indore' }, equipment: 'Trailer', units: 1,
  companyName: transit ? 'SIKA India' : 'Syngenta India',
  closesAt: Date.now() + 10 * 60_000, startsAt: Date.now() - 60_000, status: 'live', softClose: false,
  rules: transit ? transitRules(id) : deriveLoadRules({ id, branchCarrierCarrierId: 10686, branchAuctionExtendTime: '00:00:00' }),
});
const newRequests = () => new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: BAND, minMarginPct: 6.3 });
const stubAdapter = (recorded) => ({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
  ensureSession: async () => ({}),
  writeEnabled: true,
  getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
    closesInMs: 1000, revisionLimit: 3, revisionsLeft: 3, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }),
  placeBid: async (auctionId, price, opts) => { recorded.push({ auctionId, price, opts }); return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; },
});

(async () => {
  // ---- normalizeTransitDays: the one shared day-parser (form inputs arrive as strings) ----
  {
    assert.strictEqual(normalizeTransitDays(3), 3, 'number 3 -> 3');
    assert.strictEqual(normalizeTransitDays('3'), 3, 'string "3" -> 3');
    assert.strictEqual(normalizeTransitDays(null), null, 'null -> null');
    assert.strictEqual(normalizeTransitDays(''), null, 'blank -> null');
    assert.strictEqual(normalizeTransitDays(1), 1, '1 (the minimum whole day) is allowed - lower-bound accept, mirrors the MAX cap');
    assert.strictEqual(normalizeTransitDays(0), null, '0 days -> null (not a plausible transit)');
    assert.strictEqual(normalizeTransitDays(-2), null, 'negative -> null');
    assert.strictEqual(normalizeTransitDays(3.5), null, 'decimal days -> null (uncaptured wire territory, never guessed)');
    assert.strictEqual(normalizeTransitDays('abc'), null, 'non-numeric -> null');
    assert.strictEqual(normalizeTransitDays(MAX_TRANSIT_DAYS), MAX_TRANSIT_DAYS, `${MAX_TRANSIT_DAYS} (the cap) is allowed`);
    assert.strictEqual(normalizeTransitDays(MAX_TRANSIT_DAYS + 1), null, `${MAX_TRANSIT_DAYS + 1} -> null (fat-finger guard)`);
    ok('normalizeTransitDays: whole days 1..cap from number or string; everything else null');
  }

  // ---- A. capture() intake gate ----
  {
    const rq = newRequests();
    const created = await rq.createForLoad(mkLoad('TT-A1'));
    await throwsBad(() => rq.capture(created.id, { cost: 50000 }), 'transit load without days');
    await throwsBad(() => rq.capture(created.id, { cost: 50000, transitDays: '' }), 'transit load with blank days');
    await throwsBad(() => rq.capture(created.id, { cost: 50000, transitDays: 0 }), 'transit load with 0 days');
    await throwsBad(() => rq.capture(created.id, { cost: 50000, transitDays: 3.5 }), 'transit load with decimal days');
    await throwsBad(() => rq.capture(created.id, { cost: 50000, transitDays: MAX_TRANSIT_DAYS + 1 }), 'transit load with absurd days');
    // the refusals left the request open - the pricing person retries on the same link
    assert.strictEqual((await rq.getByToken(created.id)).status, 'awaiting_price', 'refused captures leave the request open');
    const capt = await rq.capture(created.id, { cost: 50000, transitDays: '4' });
    assert.strictEqual(capt.status, 'armed', 'valid days -> armed');
    assert.strictEqual(capt.price.transitDays, 4, 'days stored normalized (number 4, from the form string "4")');
    ok('capture(): transit-required load refuses absent/blank/0/decimal/absurd days (request stays open), stores valid days');
  }
  {
    const rq = newRequests();
    const created = await rq.createForLoad(mkLoad('TT-A2', { transit: false }));
    const capt = await rq.capture(created.id, { cost: 50000, transitDays: 5 });
    assert.strictEqual(capt.price.transitDays, undefined, 'a non-transit load DISCARDS supplied days (never stored, never wired)');
    ok('capture(): days handed to a non-transit load are discarded - its wire stays byte-identical');
  }

  // ---- B. armFromRequest merge + sticky carry (intent + restart) ----
  {
    const f = tmp('carry');
    const recorded = [];
    const mkEngine = () => new BidEngine(stubAdapter(recorded), new DurableScheduler(f), { config: { minInterFireMs: 0 } });
    const rq = newRequests();
    const created = await rq.createForLoad(mkLoad('TT-B1'));
    const capt = await rq.capture(created.id, { cost: 50000, transitDays: 4 });

    const e1 = mkEngine();
    const monitor = armFromRequest(e1, capt);
    if (monitor.timer) clearTimeout(monitor.timer);
    assert.strictEqual(monitor.meta.rules.transitDays, 4, 'armFromRequest merges the captured days onto meta.rules');
    assert.strictEqual(monitor.meta.rules.loadIsTransitTimeOn, true, 'the merged rules keep the transit flag');
    assert.strictEqual(capt.load.rules.transitDays, undefined, 'the request\'s own rules snapshot is NOT mutated by the merge');
    assert.strictEqual(e1.scheduler.get('TT-B1').rules.transitDays, 4, 'the durable intent carries the merged days');

    // the engine actually hands them to placeBid (the wire translation itself is golden-pinned
    // in test-loadrules-payload.js section 8)
    const state = await e1.adapter.getAuctionState();
    await e1._maybeBid(monitor, state);
    assert.strictEqual(recorded.length, 1, 'the bid fired');
    assert.strictEqual(recorded[0].opts.transitDays, 4, 'placeBid opts carry transitDays (buildBidPayload\'s input)');
    e1.kill('simulated crash');

    // restart: a fresh engine over the same intent file re-arms with the days intact (sticky)
    const e2 = mkEngine();
    await e2.rehydrate();
    const m2 = e2.monitors.get('TT-B1');
    assert.ok(m2, 'rehydrate re-armed the load');
    assert.strictEqual(m2.meta.rules.transitDays, 4, 'transit days survive a restart (sticky per load)');
    e2.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
    ok('armFromRequest -> meta.rules -> placeBid opts -> durable intent -> rehydrate all carry the days');
  }

  // ---- C. engine fail-closed: transit-required monitor with NO days (pre-transit-build capture) ----
  {
    const f = tmp('failclosed');
    const recorded = [];
    const events = [];
    const engine = new BidEngine(stubAdapter(recorded), new DurableScheduler(f), { config: { minInterFireMs: 0 }, onEvent: (e) => events.push(e) });
    const monitor = engine.arm(
      { id: 'TT-C1', lane: { origin: 'Pune', destination: 'Indore' }, units: 1, companyName: 'SIKA India',
        closesAt: Date.now() + 1000, rules: transitRules('TT-C1') }, // days never captured
      { cost: 40000, marginsPct: BAND, minMarginPct: 6.3 });
    if (monitor.timer) clearTimeout(monitor.timer); // drive ticks manually

    const state = await engine.adapter.getAuctionState();
    let me = null; try { await engine._maybeBid(monitor, state); } catch (e) { me = e; }
    assert.ok(me && me.code === 'MISSING_TRANSIT_TIME', '_maybeBid throws MISSING_TRANSIT_TIME');
    assert.strictEqual(recorded.length, 0, 'no bid was placed (refuse, never the silent bid-and-400)');
    assert.deepStrictEqual([...monitor.firedRungs], [], 'no rung was spent by the refused attempt');

    await engine._tick(monitor); if (monitor.timer) clearTimeout(monitor.timer);
    const alert = events.find((e) => e.type === 'alert' && e.kind === 'transit_time_missing_blocked');
    assert.ok(alert, '_tick emits a transit_time_missing_blocked alert');
    assert.strictEqual(alert.auctionId, 'TT-C1', 'the alert names the load');
    assert.ok(/re-price/.test(alert.detail), 'the alert tells the operator the fix (re-price with days)');
    assert.strictEqual(recorded.length, 0, 'still no bid placed after a full tick');
    // and it reaches a human: the alert maps to the WhatsApp 'error' notification
    const n = toNotification(alert);
    assert.ok(n && n.kind === 'error', 'transit_time_missing_blocked routes to the error notification (a human is paged)');
    ok('engine fails closed on missing days: no rung, no bid, transit_time_missing_blocked alert -> error notification');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- D. setBidOverride: SET-ONCE recovery; sticky thereafter; clear preserves ----
  {
    const rq = newRequests();
    const created = await rq.createForLoad(mkLoad('TT-D1'));
    // simulate a request captured BEFORE the transit build: armed, price without transitDays
    await rq.store.patchDoc('priceRequests', created.id, {
      status: 'armed', price: { cost: 50000, marginsPct: BAND, minMarginPct: 6.3 }, capturedAt: Date.now(),
    });
    const filled = await rq.setBidOverride(created.id, { marginsPct: [13, 9, 7], minMarginPct: 7, transitDays: '5' }, { setBy: 'pricing' });
    assert.strictEqual(filled.price.transitDays, 5, 'recovery: setBidOverride fills MISSING days (set-once)');
    const again = await rq.setBidOverride(created.id, { marginsPct: [14, 9, 7], minMarginPct: 7, transitDays: 9 }, { setBy: 'pricing' });
    assert.strictEqual(again.price.transitDays, 5, 'sticky: a later override does NOT change existing days');
    const cleared = await rq.clearBidOverride(created.id);
    assert.strictEqual(cleared.price.transitDays, 5, 'clearBidOverride reverts the band but PRESERVES the days');
    ok('setBidOverride fills missing days once, never edits them after; clearBidOverride preserves them');
  }

  // ---- E. the price_needed ask says "days too, not just the rate" (transit loads only) ----
  {
    const base = { shipperName: 'SIKA India', link: 'http://x/price/1', laneFrom: 'Pune', laneTo: 'Indore',
      cargo: '1 x Trailer', closesText: '20-07-2026 02:00 PM', loadId: 'TT-E1' };
    const withTransit = renderMessage('price_needed', { ...base, needsTransitTime: true });
    const without = renderMessage('price_needed', base);
    assert.ok(/🚚 Enter transit days with the rate/.test(withTransit), 'transit-required ask carries the transit-days instruction line');
    assert.ok(!/transit/i.test(without), 'a non-transit ask has NO transit line (no dangling label)');
    // the transit line sits directly under the close-time line in the minimal ask (do not lose it)
    const closeIdx = withTransit.indexOf('20-07-2026 02:00 PM');
    const transitIdx = withTransit.indexOf('🚚 Enter transit days');
    assert.ok(closeIdx >= 0 && transitIdx > closeIdx, 'the transit line renders right under the close-time line');
    ok('price_needed: transit instruction on transit loads only, right under the close time');
  }

  // ---- F. the /price page over HTTP (the untrusted boundary) ----
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, url, { body = null, contentType = null } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = contentType || 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
  const get = (p) => req('GET', base + p);
  const postForm = (p, kv) => req('POST', base + p, { body: new URLSearchParams(kv).toString(), contentType: 'application/x-www-form-urlencoded' });

  // capture form: the days field is present + required on a transit load, absent otherwise
  {
    const rT = await requests.createForLoad(mkLoad('TT-F1'));
    const g = await get(`/price/${rT.id}`);
    assert.strictEqual(g.status, 200, 'transit capture form renders');
    assert.ok(/name="transit_days"[^>]*required/.test(g.text), 'transit form: days input present + required');
    assert.ok(/requires transit time/.test(g.text), 'transit form: explains why the days are needed');
    const rN = await requests.createForLoad(mkLoad('TT-F2', { transit: false }));
    const gN = await get(`/price/${rN.id}`);
    // the INPUT is what must be absent (the shared client script legitimately mentions the id)
    assert.ok(!/name="transit_days"/.test(gN.text), 'non-transit form: NO days input at all');
    ok('/price GET: required days field on a transit load only');

    // the server, not the HTML `required`, is the gate: a form POST without days is a 400,
    // and the request stays open for a retry
    const pBad = await postForm(`/price/${rT.id}`, { cost: '50000' });
    assert.strictEqual(pBad.status, 400, 'POST without days -> 400');
    assert.ok(/requires transit time/.test(pBad.text), 'the error page says what to add');
    assert.strictEqual((await requests.getByToken(rT.id)).status, 'awaiting_price', 'refused POST leaves the request open');
    const pBad2 = await postForm(`/price/${rT.id}`, { cost: '50000', transit_days: '2.5' });
    assert.strictEqual(pBad2.status, 400, 'POST with decimal days -> 400');

    const pOk = await postForm(`/price/${rT.id}`, { cost: '50000', transit_days: '4' });
    assert.strictEqual(pOk.status, 200, 'POST with days captures');
    assert.ok(/Cost saved/.test(pOk.text), 'capture confirmed');
    assert.ok(/Transit time <b>4 days<\/b>/.test(pOk.text), 'the confirmation echoes the days that will ride every bid');
    const doc = await requests.getByToken(rT.id);
    assert.strictEqual(doc.price.transitDays, 4, 'days persisted on the armed request');

    // armed -> the same link re-opens as the re-price form; the days are a FIXED display
    const gR = await get(`/price/${rT.id}`);
    assert.ok(/name="transit_days"[^>]*value="4" disabled/.test(gR.text), 're-price form: days shown fixed (disabled), never re-editable');
    assert.ok(/Fixed for this load/.test(gR.text), 're-price form: says the value is sticky');
    // a re-price submit does NOT carry days; the stored value survives the re-arm
    const rp = await postForm(`/price/${rT.id}`, { cost: '48000', m_0: '13', m_1: '9', m_2: '7' });
    assert.strictEqual(rp.status, 200, 're-price submit works on a transit load');
    const doc2 = await requests.getByToken(rT.id);
    assert.strictEqual(doc2.price.transitDays, 4, 'days survive a re-price (sticky through setBidOverride + re-arm)');
    assert.strictEqual(doc2.price.cost, 48000, 'the re-priced cost landed');
    ok('/price POST: server-side gate (400 without/invalid days), capture persists days, re-price keeps them fixed');
  }

  // legacy recovery over HTTP: an armed transit request with NO days shows an editable field,
  // and a re-price submit fills it (set-once)
  {
    const rL = await requests.createForLoad(mkLoad('TT-F3'));
    await store.patchDoc('priceRequests', rL.id, {
      status: 'armed', price: { cost: 60000, marginsPct: BAND, minMarginPct: 6.3 }, capturedAt: Date.now(),
    });
    const g = await get(`/price/${rL.id}`);
    assert.ok(/name="transit_days"[^>]*required/.test(g.text), 'legacy armed transit load: the days field is EDITABLE (recovery)');
    const rp = await postForm(`/price/${rL.id}`, { cost: '60000', m_0: '13', m_1: '9', m_2: '7', transit_days: '6' });
    assert.strictEqual(rp.status, 200, 'recovery re-price submit works');
    const doc = await requests.getByToken(rL.id);
    assert.strictEqual(doc.price.transitDays, 6, 'recovery re-price filled the missing days (set-once)');
    const g2 = await get(`/price/${rL.id}`);
    assert.ok(/name="transit_days"[^>]*value="6" disabled/.test(g2.text), 'after recovery the field is fixed like any captured load');
    ok('/price recovery: a legacy armed transit load takes days once via re-price, then locks them');
  }

  server.close();
  console.log(`\n${pass}/10 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
