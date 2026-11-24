'use strict';
/**
 * A SHIPPER CEILING IN THE GAP BETWEEN THE MINIMUM-MARGIN GUARD AND THE LOWEST BAND PRICE IS BID ONCE,
 * AT THE CEILING - not refused.
 *
 * Regression target: R30-ceiling-gap. The band margins are the bids and the minimum margin is a guard:
 * no price may go below guard = max(round(cost), round(cost x (1 + min/100))). Since the guard stopped
 * being a rung, the ladder's floor is the lowest BAND price, which sits above the guard whenever the
 * minimum is below the band's lowest margin. arm() still refuses any load whose ceiling is below that
 * floor (`capAt < plan.floor` sets ceilingBelowFloor), and planPreview mirrors it with willNotBid
 * 'ceiling_below_floor', so the /price capture demands a ceiling acknowledgement and the preview shows
 * nothing. A ceiling that leaves a legal price above the guard is therefore never bid.
 *
 * Cost 100,000, band [12.6, 7.2, 6.3], minimum 5:
 *   guard  G = max(100000, round(100000 x 1.05))  = 105,000
 *   floor  F = round(100000 x 1.063)              = 106,300   (ladder [112600, 107200, 106300])
 *   ceiling 105,500 -> one bid at 105,500. ceiling 105,000 -> one bid at 105,000 (the boundary).
 *
 * WHAT MUST NOT MOVE:
 *   - a ceiling below the guard (104,999) is still refused as ceiling_below_floor and never bid;
 *   - a ceiling at or above the lowest band price caps the ladder exactly as today (110,000 ->
 *     [110000, 107200, 106300]; 106,300 -> one bid at 106,300), and no ceiling leaves the full band;
 *   - a band with no gap (minimum equal to its lowest margin, 6.3) with ceiling 105,500 is refused;
 *   - a per-tonne load carrying a ceiling is refused as per_tonne_ceiling.
 *
 * Offline and deterministic: fake adapter on the engine with a temp-file scheduler and a virtual clock
 * stepped by the delay the engine schedules; the /price routes over 127.0.0.1 in mock mode on a memory
 * store. No RNG on an asserted path, no sleeps.
 *
 *   node scripts/test-ceiling-gap-bids-once-at-ceiling.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
// The inherited band on the /price path: the same band and minimum as the engine checks.
process.env.SP_MARGINS_PCT = '12.6,7.2,6.3';
process.env.SP_MIN_MARGIN_PCT = '5';

const os = require('os');
const fs = require('fs');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-ceiling-gap-'));
process.env.SP_DATA_DIR = DATA_DIR;

const assert = require('assert');
const http = require('http');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 100_000;
const GAP_BAND = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const NO_GAP_BAND = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
const GUARD = 105_000;
const BAND_PRICES = [112_600, 107_200, 106_300];
const BAND_BOTTOM = 106_300;
const IN_GAP = 105_500;
const BID_CAP = 3;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
let SERVER = null;
const tmp = () => { const f = path.join(os.tmpdir(), `ceiling-gap-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

function mkEngine(adapter) {
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, cadenceJitterMs: 0, minInterFireMs: 0 },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return eng;
}

const idleAdapter = () => ({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
  ensureSession: async () => ({}),
  getAuctionState: async () => ({ ok: false }),
  placeBid: async () => { throw new Error('placeBid must not be reached here'); },
});

const rulesWith = (ceilingPrice, pricingMode = 'flat') =>
  ({ revisionLimit: BID_CAP, minDecrement: 100, pricingMode, ceilingPrice });

const metaFor = (ceilingPrice, closesAt, pricingMode) => ({
  id: String(700_000 + seq++), lane: { origin: 'Vapi', destination: 'Nagpur' }, units: 1,
  companyName: 'Acme Coatings', branchName: 'MAIN', closesAt, rules: rulesWith(ceilingPrice, pricingMode),
});

function armOn(eng, ceilingPrice, band, closesAt) {
  const m = eng.arm(metaFor(ceilingPrice, closesAt), { cost: COST, ...band });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return m;
}

function previewOn(ceilingPrice, band, pricingMode) {
  const eng = mkEngine(idleAdapter());
  return eng.planPreview(metaFor(ceilingPrice, Date.now() + 900_000, pricingMode), { cost: COST, ...band });
}

// One hard-close load from 70s out to the close through the real _tick. Rank is null until our first
// bid lands, then 2 (outranked) for the rest of the auction, so every rung and the final shot get
// their chance. Stops when the load finalizes or the engine schedules nothing further.
async function runToClose(ceilingPrice, band) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    const closeAt = vnow + 70_000;
    const sent = [];
    let rank = null;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: closeAt - vnow > 0 ? 'live' : 'closed', myRank: rank,
        totalBidders: 5, standingL1Price: null, closesInMs: closeAt - vnow, revisionLimit: BID_CAP,
        closeModel: 'hard', minDecrement: 100, measuredRttMs: 80 }),
      placeBid: async (id, price) => {
        sent.push(price);
        rank = 2;
        return { accepted: true, ok: true, myRank: 2, revisionsLeft: null };
      },
    };
    const eng = mkEngine(adapter);
    let nextDelay = null;
    eng._schedule = (mon, d) => { nextDelay = d; };
    const m = armOn(eng, ceilingPrice, band, closeAt);
    for (let ticks = 0; !m.finalized && ticks < 5_000; ticks++) {
      nextDelay = null;
      await eng._tick(m);
      if (m.finalized || nextDelay == null) break;
      vnow += Math.max(1, nextDelay);
    }
    return { sent, monitor: m };
  } finally { Date.now = REAL_NOW; }
}

function req(method, url, { body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (body != null) { headers['content-type'] = 'application/x-www-form-urlencoded'; headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const form = (obj) => Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

let web = null;
async function startWeb() {
  if (web) return web;
  const { app, requests, stacks } = require('../src/web/server');
  SERVER = app.listen(0, '127.0.0.1');
  await new Promise((r) => SERVER.once('listening', r));
  const base = `http://127.0.0.1:${SERVER.address().port}`;
  const now = Date.now();
  const mkLoad = (id, ceilingPrice) => ({
    id, lane: { origin: 'Vapi', destination: 'Nagpur' }, equipment: '32 Feet', units: 1,
    companyName: 'Acme Coatings', closesAt: now + 40 * 60_000, startsAt: now - 60_000,
    softClose: false, closeModelKnown: true, status: 'live',
    rules: { ceilingPrice, pricingMode: 'flat', minDecrement: 100 },
  });
  const armedMonitor = (loadId) => {
    for (const s of stacks) {
      const m = s.engine && s.engine.monitors ? s.engine.monitors.get(loadId) : null;
      if (m) return m;
    }
    return null;
  };
  web = { base, requests, mkLoad, armedMonitor };
  return web;
}

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED = 12;
process.on('exit', (code) => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  if (ran === EXPECTED && pass === EXPECTED) {
    if (code === 0) console.log(`\nPASS ceiling gap bids once at ceiling: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - a ceiling between the minimum-margin guard `
    + 'and the lowest band price is refused as ceiling_below_floor instead of bid once at the ceiling');
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

(async () => {
  console.log('ceiling gap bids once at ceiling');

  await check('1 gap-arms-at-ceiling: ceiling 105,500 arms ladder [105500], floor 105500, not ceiling-below-floor', () => {
    const eng = mkEngine(idleAdapter());
    const m = armOn(eng, IN_GAP, GAP_BAND, Date.now() + 900_000);
    assert.strictEqual(m.ceilingBelowFloor, false,
      `ceiling ${IN_GAP} sits above the guard ${GUARD} but the load was flagged ceilingBelowFloor against the band `
      + `bottom ${m.floor} - a legal price exists and the load is refused`);
    assert.deepStrictEqual(m.ladder, [IN_GAP], `the armed ladder must be the ceiling alone: ${m.ladder}`);
    assert.strictEqual(m.floor, IN_GAP, `the armed floor must be the ceiling ${IN_GAP}, got ${m.floor}`);
    assert.ok(eng._bidOpts(m).floor >= GUARD, `the adapter belt floor ${eng._bidOpts(m).floor} sits below the guard ${GUARD}`);
  });

  await check('2 gap-bids-once: ceiling 105,500 driven to the close sends exactly one bid, at 105,500', async () => {
    const { sent, monitor } = await runToClose(IN_GAP, GAP_BAND);
    for (const p of sent) assert.ok(p >= GUARD, `sent ${p}, below the guard ${GUARD}: ${sent}`);
    assert.deepStrictEqual(sent, [IN_GAP],
      `expected exactly one bid at ${IN_GAP}, sent [${sent}] (ceilingBelowFloor=${monitor.ceilingBelowFloor}, `
      + `refusal=${monitor.noBid && monitor.noBid.reason})`);
  });

  await check('3 boundary-ceiling-equals-guard: ceiling 105,000 arms [105000] and bids once at 105,000', async () => {
    const eng = mkEngine(idleAdapter());
    const m = armOn(eng, GUARD, GAP_BAND, Date.now() + 900_000);
    assert.strictEqual(m.ceilingBelowFloor, false,
      `ceiling ${GUARD} equals the guard but the load was flagged ceilingBelowFloor against the band bottom ${m.floor}`);
    assert.deepStrictEqual(m.ladder, [GUARD], `the armed ladder must be [${GUARD}]: ${m.ladder}`);
    assert.strictEqual(m.floor, GUARD, `the armed floor must be ${GUARD}, got ${m.floor}`);
    const { sent } = await runToClose(GUARD, GAP_BAND);
    assert.deepStrictEqual(sent, [GUARD], `expected exactly one bid at ${GUARD}, sent [${sent}]`);
  });

  await check('4 preview-matches-arm: planPreview for ceilings 105,500 and 105,000 returns [capAt], floor capAt, no willNotBid', () => {
    for (const k of [IN_GAP, GUARD]) {
      const p = previewOn(k, GAP_BAND);
      assert.strictEqual(p.willNotBid, undefined,
        `planPreview for ceiling ${k} says willNotBid '${p.willNotBid}' (floor ${p.floor}) - the desk is told the load cannot be bid`);
      assert.deepStrictEqual(p.ladder, [k], `planPreview ladder for ceiling ${k}: ${p.ladder}`);
      assert.strictEqual(p.floor, k, `planPreview floor for ceiling ${k}: ${p.floor}`);
    }
  });

  await check('5 price-preview-route: GET /price/:token/preview?cost=100000 (no m) on a 105,500 ceiling returns [105500], no willNotBid', async () => {
    const { base, requests, mkLoad } = await startWeb();
    const r = await requests.createForLoad(mkLoad('GAP-PREVIEW', IN_GAP));
    const res = await req('GET', `${base}/price/${r.id}/preview?cost=${COST}`);
    assert.strictEqual(res.status, 200, `preview answered ${res.status}: ${res.text.slice(0, 200)}`);
    assert.strictEqual(res.json.willNotBid, undefined,
      `the preview says willNotBid '${res.json.willNotBid}' for a load with a legal price at the ceiling`);
    assert.deepStrictEqual(res.json.ladder, [IN_GAP], `preview ladder: ${res.json.ladder}`);
  });

  await check('6 price-capture-arms: POST /price/:token cost 100000 on the inherited band, no ceiling_ack, is accepted and armed at [105500]', async () => {
    const { base, requests, mkLoad, armedMonitor } = await startWeb();
    const r = await requests.createForLoad(mkLoad('GAP-CAPTURE', IN_GAP));
    assert.deepStrictEqual(r.marginsPct, GAP_BAND.marginsPct, `precondition: inherited band ${r.marginsPct}`);
    assert.strictEqual(r.minMarginPct, GAP_BAND.minMarginPct, `precondition: inherited minimum ${r.minMarginPct}`);
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: String(COST) }) });
    assert.ok(res.status < 400,
      `the capture was refused with ${res.status} without a ceiling acknowledgement - the page treats a biddable load `
      + `as ceiling-dead ("${(res.text.match(/Max bid[^<]{0,80}/) || ['no ceiling copy'])[0]}")`);
    const after = await requests.getByToken(r.id);
    assert.strictEqual(after.status, 'armed', `the request is '${after.status}', not armed`);
    const m = armedMonitor('GAP-CAPTURE');
    assert.ok(m, 'nothing was armed');
    assert.strictEqual(m.ceilingBelowFloor, false, 'the armed monitor is flagged ceilingBelowFloor');
    assert.deepStrictEqual(m.ladder, [IN_GAP], `armed ladder: ${m.ladder}`);
  });

  await check('7 control-below-guard-refused: ceiling 104,999 stays ceiling_below_floor, never bid', async () => {
    const eng = mkEngine(idleAdapter());
    const m = armOn(eng, GUARD - 1, GAP_BAND, Date.now() + 900_000);
    assert.strictEqual(m.ceilingBelowFloor, true, 'a ceiling below the guard must fail closed');
    const p = previewOn(GUARD - 1, GAP_BAND);
    assert.strictEqual(p.willNotBid, 'ceiling_below_floor', `planPreview willNotBid: ${p.willNotBid}`);
    assert.deepStrictEqual(p.ladder, [], `planPreview ladder: ${p.ladder}`);
    const { sent, monitor } = await runToClose(GUARD - 1, GAP_BAND);
    assert.deepStrictEqual(sent, [], `a bid went out under a ceiling below the guard: ${sent}`);
    assert.strictEqual(monitor.noBid && monitor.noBid.reason, 'ceiling_below_floor',
      `refusal recorded: ${monitor.noBid && monitor.noBid.reason}`);
  });

  await check('8 control-ceiling-above-band-bottom: ceiling 110,000 caps to [110000, 107200, 106300]; no ceiling is the full band', () => {
    const eng = mkEngine(idleAdapter());
    const capped = armOn(eng, 110_000, GAP_BAND, Date.now() + 900_000);
    assert.strictEqual(capped.ceilingBelowFloor, false);
    assert.deepStrictEqual(capped.ladder, [110_000, 107_200, 106_300], `capped ladder: ${capped.ladder}`);
    assert.strictEqual(capped.floor, BAND_BOTTOM);
    const open = armOn(eng, null, GAP_BAND, Date.now() + 900_000);
    assert.deepStrictEqual(open.ladder, BAND_PRICES, `uncapped ladder: ${open.ladder}`);
    assert.deepStrictEqual(previewOn(110_000, GAP_BAND).ladder, [110_000, 107_200, 106_300]);
    assert.deepStrictEqual(previewOn(null, GAP_BAND).ladder, BAND_PRICES);
  });

  await check('9 control-ceiling-at-band-bottom: ceiling 106,300 arms [106300] and bids once at 106,300', async () => {
    const eng = mkEngine(idleAdapter());
    const m = armOn(eng, BAND_BOTTOM, GAP_BAND, Date.now() + 900_000);
    assert.strictEqual(m.ceilingBelowFloor, false);
    assert.deepStrictEqual(m.ladder, [BAND_BOTTOM], `armed ladder: ${m.ladder}`);
    const { sent } = await runToClose(BAND_BOTTOM, GAP_BAND);
    assert.deepStrictEqual(sent, [BAND_BOTTOM], `expected exactly one bid at ${BAND_BOTTOM}, sent [${sent}]`);
  });

  await check('10 control-no-gap-refused: band min 6.3 (equal to its lowest margin) with ceiling 105,500 is refused', () => {
    const eng = mkEngine(idleAdapter());
    const m = armOn(eng, IN_GAP, NO_GAP_BAND, Date.now() + 900_000);
    assert.strictEqual(m.ceilingBelowFloor, true, 'with no gap the guard is the band bottom 106,300, so 105,500 must fail closed');
    assert.strictEqual(previewOn(IN_GAP, NO_GAP_BAND).willNotBid, 'ceiling_below_floor');
  });

  await check('11 control-per-tonne-ceiling: a per-tonne load carrying a 105,500 ceiling is refused as per_tonne_ceiling', () => {
    const p = previewOn(IN_GAP, GAP_BAND, 'per_tonne');
    assert.strictEqual(p.willNotBid, 'per_tonne_ceiling', `planPreview willNotBid: ${p.willNotBid}`);
    assert.deepStrictEqual(p.ladder, []);
  });

  await check('12 control-price-route-plumbing: a 110,000-ceiling load previews and captures onto [110000, 107200, 106300]', async () => {
    const { base, requests, mkLoad, armedMonitor } = await startWeb();
    const r = await requests.createForLoad(mkLoad('GAP-CONTROL', 110_000));
    const pv = await req('GET', `${base}/price/${r.id}/preview?cost=${COST}`);
    assert.strictEqual(pv.status, 200, `preview answered ${pv.status}`);
    assert.strictEqual(pv.json.willNotBid, undefined);
    assert.deepStrictEqual(pv.json.ladder, [110_000, 107_200, 106_300], `preview ladder: ${pv.json.ladder}`);
    const res = await req('POST', `${base}/price/${r.id}`, { body: form({ cost: String(COST) }) });
    assert.ok(res.status < 400, `capture answered ${res.status}`);
    const m = armedMonitor('GAP-CONTROL');
    assert.ok(m, 'nothing was armed');
    assert.deepStrictEqual(m.ladder, [110_000, 107_200, 106_300], `armed ladder: ${m.ladder}`);
  });

  for (const e of ENGINES) { try { e.kill('test done'); } catch (_) {} }
  if (SERVER) SERVER.close();
  process.exit(ran === EXPECTED && pass === EXPECTED ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
