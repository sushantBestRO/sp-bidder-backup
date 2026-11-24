'use strict';
/**
 * R33-won-margin-low - A WIN AT THE BAND'S LOWEST PRICE GETS THE "MARGIN LOW" NOTE.
 *
 * Regression target: branch fix/margin-floor-is-a-guard. The minimum margin is a guard and is never
 * bid, so the lowest price the engine can send is the band's lowest price. The WON receipt's
 * "Margin low" note (waTemplates wonWarning) still fires only when the won margin is at or below
 * minMarginPct - a figure no bid can reach any more. A win at the bottom rung, the thinnest win the
 * plan allows, says nothing.
 *
 * The note must compare the won margin against the lowest band margin in force when the bid went
 * out, lifted to the minimum where a legacy stored band sits below it:
 * threshold = max(lowest band margin, minMarginPct). Three seams carry that figure:
 *   - the engine's bid_placed carries `lowestPct` (lowest band anchor margin off the durable intent,
 *     beside `openingPct`);
 *   - bidLogger stamps it as `bidTimeLowestMarginPct` on the ourBids entry and the bids stream;
 *   - bidTimeBand / outcomeEnrichment surface it as `lowestMarginPct`, and the won template keys
 *     the note on it.
 * With no bid-time snapshot the doc-level band (rec.marginsPct lowest, lifted by rec.minMarginPct)
 * is used, else rec.minMarginPct, else 5.
 *
 * Worked numbers: cost 100,000, band [12.6, 7.2, 6.3], minimum 5. Band prices 112,600 / 107,200 /
 * 106,300 (cost x 1.126 / 1.072 / 1.063); the guard is 105,000 (cost x 1.05) and is never a rung.
 *
 * WHAT MUST NOT MOVE (checks 8-12, green now and after):
 *   - a win at 107,200 (+7.20%) carries no note;
 *   - a legacy stored band [12.6, 7.2, 0] minimum 5 won at 105,000 (+5.00%) keeps its note
 *     (threshold max(0, 5) = 5);
 *   - a snapshot that predates the new field judges against its own bid-time minimum, never the
 *     doc-level band;
 *   - a negative-margin win and a cost-corrected win keep their own branches and get no nag.
 *
 * Offline and deterministic: fake adapter, memory store, temp-file scheduler, rand pinned to 0, the
 * countdown driven through the real _tick on a virtual clock. No real sleeps, no network.
 *
 *   node scripts/test-won-margin-low-keyed-on-lowest-band.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { bidTimeBand } = require('../src/notify/bidTimeCost');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

const COST = 100_000;
const BAND = { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 };
const BAND_PRICES = [112_600, 107_200, 106_300];
const BOTTOM = 106_300;
const LOWEST_PCT = 6.3;
const FLOOR_WINDOW_MS = 2_500;
const BID_CAP = 3;
const WARN = '⚠';

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `won-margin-low-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

function receipt(rec) {
  const data = Object.assign({ oaNo: rec.auctionId, finalRank: 1, landedBids: 1 }, outcomeEnrichment(rec));
  return renderMessage(templateFor('won', data), data);
}

// The note is the warning line that names the won margin. Its sentence is desk copy and is not pinned.
const marginNote = (body, pct) => body.split('\n').find((l) => l.includes(WARN) && l.includes(`${pct}%`)) || null;

function snapshotWin(id, price, bid, doc = {}) {
  return Object.assign({
    auctionId: id, cost: COST, marginsPct: BAND.marginsPct, minMarginPct: BAND.minMarginPct,
    lastBidPrice: price, won: true, finalRank: 1, status: 'closed',
    ourBids: [Object.assign({ price, rungIndex: 2, ts: 1_788_869_161_610 }, bid)],
  }, doc);
}

// One hard-close load walked to its close through the real engine, its events piped through the real
// logger. Rank 2 until the bottom rung lands, then 1, so the load is won at the bottom rung.
async function runWinAtBottom() {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  const events = [];
  let chain = Promise.resolve();
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
        rank = price === BOTTOM ? 1 : 2;
        return { accepted: true, ok: true, myRank: rank, revisionsLeft: null };
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, cadenceJitterMs: 0 },
      rand: () => 0,
      onEvent: (e) => { events.push(e); chain = chain.then(() => logger.handle(e)); },
    });
    ENGINES.push(eng);
    let nextDelay = null;
    eng._schedule = (mon, d) => { nextDelay = d; };
    const m = eng.arm({ id: 'R33E2E', lane: { origin: 'Jaipur', destination: 'Pune' }, equipment: '32ft', units: 1,
      companyName: 'Syngenta', branchName: 'MAIN', closesAt: closeAt,
      rules: { revisionLimit: BID_CAP, minDecrement: 100, pricingMode: 'flat' } }, { cost: COST, ...BAND });
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    for (let ticks = 0; !m.finalized && ticks < 5_000; ticks++) {
      nextDelay = null;
      await eng._tick(m);
      if (m.finalized) break;
      assert.ok(nextDelay != null, 'the engine scheduled no next tick');
      vnow += Math.max(1, nextDelay);
    }
    assert.ok(m.finalized, 'the load never reached its close');
    await chain;
    return { sent, events, store, rec: await store.getDoc('closedBids', 'R33E2E') };
  } finally { Date.now = REAL_NOW; }
}

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED = 12;
process.on('exit', (code) => {
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  if (ran === EXPECTED && pass === EXPECTED) {
    if (code === 0) console.log(`\nwon margin low keyed on lowest band: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${ran}/${EXPECTED} checks ran, ${pass} passed - the won receipt's margin-low note is keyed on `
    + 'the minimum margin, which is never bid, instead of the lowest band margin');
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
  console.log('won margin low keyed on lowest band');
  const run = await runWinAtBottom();
  assert.deepStrictEqual(run.sent, BAND_PRICES, `setup: the engine must walk the band exactly, sent ${run.sent}`);
  assert.ok(run.rec && run.rec.won === true && run.rec.lastBidPrice === BOTTOM,
    `setup: the load must close won at ${BOTTOM} (won=${run.rec && run.rec.won}, last=${run.rec && run.rec.lastBidPrice})`);

  await check('1 engine-emits-lowestPct: every bid_placed carries the lowest band margin beside openingPct', () => {
    const placed = run.events.filter((e) => e.type === 'bid_placed');
    assert.strictEqual(placed.length, BAND_PRICES.length, `expected ${BAND_PRICES.length} bid_placed, got ${placed.length}`);
    for (const e of placed) {
      assert.strictEqual(e.openingPct, 12.6, `openingPct moved: ${e.openingPct}`);
      assert.strictEqual(e.minMarginPct, 5, `minMarginPct moved: ${e.minMarginPct}`);
      assert.strictEqual(e.lowestPct, LOWEST_PCT,
        `bid_placed at ${e.price} carries lowestPct=${e.lowestPct}; it must carry the band's lowest margin ${LOWEST_PCT}`);
    }
  });

  await check('2 logger-stamps-bidTimeLowestMarginPct: ourBids and the bids stream carry the lowest band margin', async () => {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store, log: () => {} });
    await logger.handle({ type: 'armed', auctionId: 'R33L', lane: { origin: 'Jaipur', destination: 'Pune' }, units: 1,
      cost: COST, ...BAND, ladder: BAND_PRICES, floor: BOTTOM, ts: 1 });
    await logger.handle({ type: 'bid_placed', auctionId: 'R33L', price: BOTTOM, rungIndex: 2, ts: 2,
      cost: COST, minMarginPct: 5, openingPct: 12.6, lowestPct: LOWEST_PCT });
    const rec = await store.getDoc('closedBids', 'R33L');
    const bid = rec.ourBids[0];
    assert.strictEqual(bid.bidTimeCost, COST, `bidTimeCost moved: ${bid.bidTimeCost}`);
    assert.strictEqual(bid.bidTimeMinMarginPct, 5, `bidTimeMinMarginPct moved: ${bid.bidTimeMinMarginPct}`);
    assert.strictEqual(bid.bidTimeLowestMarginPct, LOWEST_PCT,
      `ourBids entry carries bidTimeLowestMarginPct=${bid.bidTimeLowestMarginPct}, expected ${LOWEST_PCT} off the event's lowestPct`);
    const streamed = (await store.readEvents('bids')).filter((e) => e.kind === 'bid_placed' && e.auctionId === 'R33L');
    assert.strictEqual(streamed.length, 1);
    assert.strictEqual(streamed[0].bidTimeLowestMarginPct, LOWEST_PCT,
      `the bids stream event carries bidTimeLowestMarginPct=${streamed[0].bidTimeLowestMarginPct}`);
  });

  await check('3 enrichment-surfaces-lowestMarginPct: bidTimeBand and outcomeEnrichment carry the bid-time lowest margin', () => {
    const rec = snapshotWin('R33B', BOTTOM, { bidTimeCost: COST, bidTimeMinMarginPct: 5, bidTimeLowestMarginPct: LOWEST_PCT });
    const band = bidTimeBand(rec);
    assert.strictEqual(band.cost, COST);
    assert.strictEqual(band.minMarginPct, 5);
    assert.strictEqual(band.lowestMarginPct, LOWEST_PCT, `bidTimeBand.lowestMarginPct=${band.lowestMarginPct}`);
    const e = outcomeEnrichment(rec);
    assert.strictEqual(e.minMarginPct, 5);
    assert.strictEqual(e.lowestMarginPct, LOWEST_PCT, `outcomeEnrichment.lowestMarginPct=${e.lowestMarginPct}`);
  });

  await check('4 bottom-rung-win-noted: won at 106,300 (+6.30%) on a bid-time band [12.6, 7.2, 6.3] min 5 carries the note', () => {
    const rec = snapshotWin('R33W1', BOTTOM, { bidTimeCost: COST, bidTimeMinMarginPct: 5, bidTimeLowestMarginPct: LOWEST_PCT });
    assert.strictEqual(outcomeEnrichment(rec).marginPct, '6.30');
    const body = receipt(rec);
    assert.ok(marginNote(body, '6.30'),
      'a win at the band\'s lowest price (+6.30%, threshold max(6.3, 5) = 6.3) printed no margin-low note - '
      + `the note is still keyed on the 5% minimum, which is never bid:\n${body}`);
  });

  await check('5 ceiling-win-noted: won at 105,500 (+5.50%) on the same bid-time band carries the note', () => {
    // A ceiling at 105,500 caps the ladder to one bid below the band bottom but above the 105,000 guard.
    const rec = snapshotWin('R33W2', 105_500, { rungIndex: 0, bidTimeCost: COST, bidTimeMinMarginPct: 5, bidTimeLowestMarginPct: LOWEST_PCT });
    assert.strictEqual(outcomeEnrichment(rec).marginPct, '5.50');
    const body = receipt(rec);
    assert.ok(marginNote(body, '5.50'),
      `a win at +5.50%, under the band's lowest 6.3%, printed no margin-low note (threshold is still the 5% minimum):\n${body}`);
  });

  await check('6 doc-band-no-snapshot: a row with no bid-time snapshot judges against the doc band\'s lowest margin', () => {
    const rec = snapshotWin('R33W3', BOTTOM, {});
    assert.strictEqual(bidTimeBand(rec), null, 'precondition: this row carries no bid-time snapshot');
    assert.strictEqual(outcomeEnrichment(rec).marginPct, '6.30');
    const body = receipt(rec);
    assert.ok(marginNote(body, '6.30'),
      `won at +6.30% against a doc band [12.6, 7.2, 6.3] min 5 printed no margin-low note (keyed on rec.minMarginPct 5):\n${body}`);
  });

  await check('7 end-to-end: the real engine -> logger -> enrichment -> won receipt notes a bottom-rung win', () => {
    const last = run.rec.ourBids[run.rec.ourBids.length - 1];
    assert.strictEqual(last.price, BOTTOM);
    assert.strictEqual(last.bidTimeCost, COST);
    const body = receipt(run.rec);
    assert.ok(marginNote(body, '6.30'),
      `the load won at its band bottom ${BOTTOM} (+6.30%) got no margin-low note on the receipt `
      + `(bid-time lowest margin on the record: ${last.bidTimeLowestMarginPct}):\n${body}`);
  });

  await check('8 control-healthy-win: won at 107,200 (+7.20%) carries no note', () => {
    const rec = snapshotWin('R33C1', 107_200, { rungIndex: 1, bidTimeCost: COST, bidTimeMinMarginPct: 5, bidTimeLowestMarginPct: LOWEST_PCT });
    const body = receipt(rec);
    assert.ok(!body.includes(WARN), `a +7.20% win must carry no warning line:\n${body}`);
  });

  await check('9 control-legacy-band-below-min: [12.6, 7.2, 0] min 5 won at 105,000 (+5.00%) keeps its note', () => {
    // Legacy stored band whose lowest margin sits below the minimum: the price bid there is the 5%
    // guard, so threshold = max(0, 5) = 5 and a +5.00% win is at it.
    const rec = snapshotWin('R33C2', 105_000,
      { bidTimeCost: COST, bidTimeMinMarginPct: 5, bidTimeLowestMarginPct: 0 }, { marginsPct: [12.6, 7.2, 0] });
    const body = receipt(rec);
    assert.ok(marginNote(body, '5.00'), `a +5.00% win against threshold 5 must carry the note:\n${body}`);
  });

  await check('10 control-epoch-not-mixed: a snapshot without the new field judges against its own bid-time minimum', () => {
    // Pre-field snapshot: bid-time minimum 5 only. The doc band's 6.3 must not be borrowed, so +6.30% > 5 is no note.
    const rec = snapshotWin('R33C3', BOTTOM, { bidTimeCost: COST, bidTimeMinMarginPct: 5 });
    const body = receipt(rec);
    assert.ok(!marginNote(body, '6.30'),
      `a bid-time snapshot's threshold was mixed with the doc-level band:\n${body}`);
  });

  await check('11 control-negative-margin: a below-cost win keeps its rupee line and gets no margin-low nag', () => {
    const rec = snapshotWin('R33C4', 98_000, {});
    const e = outcomeEnrichment(rec);
    assert.strictEqual(e.marginPct, '-2.00');
    assert.strictEqual(e.belowRateBy, '2,000');
    const body = receipt(rec);
    assert.ok(body.split('\n').some((l) => l.includes(WARN) && l.includes('2,000')), `the rupee line is missing:\n${body}`);
    assert.ok(!marginNote(body, '-2.00'), `a negative-margin win got the margin-low nag:\n${body}`);
  });

  await check('12 control-cost-corrected: a win under a corrected-up cost gets the cost alert, not the margin-low nag', () => {
    // Bid-time cost 100,000, desk since corrected to 110,000; won 106,300 is 3,700 under it.
    const rec = snapshotWin('R33C5', BOTTOM,
      { bidTimeCost: COST, bidTimeMinMarginPct: 5, bidTimeLowestMarginPct: LOWEST_PCT }, { cost: 110_000 });
    const e = outcomeEnrichment(rec);
    assert.strictEqual(e.costCorrectedTo, '1,10,000');
    assert.strictEqual(e.belowCostBy, '3,700');
    const body = receipt(rec);
    assert.ok(!marginNote(body, '6.30'), `a cost-corrected win got the margin-low nag:\n${body}`);
  });
})().catch((e) => { console.error(e); process.exitCode = 1; });
