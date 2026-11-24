'use strict';
/**
 * Pins D012 (fix/ops-alerting-divergences), REDESIGNED 26 Sep after review.
 *
 * Named reversal: the original detector measured elapsed time ("armed loads but no bid landed for
 * N minutes"), which the review found fires on ordinary quiet stretches - replayed on the 24 Sep
 * snapshot it would have alerted roughly 150 times across 35 of 42 days, because a load armed far
 * from its close, held, stood down, or ceiling-below-floor all look identical to a stall under a
 * pure elapsed-time measure. Every pin below that asserted the old armedAt/window behaviour is
 * retired; noLandingReport() and its whole test are replaced.
 *
 * The new detector counts a streak of CONSECUTIVE closes on one account (BidEngine is already
 * one-per-account/stack) that landed zero bids with no reason recorded at all - a held load
 * (_holdUnknownClose) never arms and never finalizes, so it cannot inflate the streak; a
 * stood-down or ceiling-below-floor close DOES record a reason (_recordRefusal), so it resets the
 * streak like any other explained close. Any landed bid also resets it. Default threshold: 2.
 *
 * @requires-summary-line
 *   node scripts/test-d012-no-landing-detector.js
 */
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');
const os = require('os');
const path = require('path');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const fakeAdapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }) };
const tmpScheduler = () => new DurableScheduler(path.join(os.tmpdir(), `d012-${process.pid}-${Math.random()}.json`));

const armReal = (eng, id, closesAt) => eng.arm(
  { id, lane: { origin: 'A', destination: 'B' }, units: 1, closesAt },
  { marketRate: 70_000, costFloor: 40_000 },
);

(async () => {
  // ---- a fresh engine reports nothing ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    assert.strictEqual(eng.noLandingReport(), null, 'a fresh engine, no closes yet, reports nothing');
    ok('control: a fresh engine reports nothing');
  }

  // ---- a long normal auction that landed a bid: no alert ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m = armReal(eng, 'NORMAL', Date.now() - 3 * 3600_000); // "long" - armed hours ago
    m.landedBids = 3;
    await eng._finalize(m, { myRank: 2 }).catch(() => {});
    assert.strictEqual(eng.noLandingReport(), null,
      'a long-running auction that landed bids is not a silent failure, however old it is');
    ok('control: a long normal auction that landed bids raises no alert');
  }

  // ---- a held monitor (_holdUnknownClose): never arms, never finalizes, cannot inflate the streak ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    eng._holdUnknownClose({ auctionId: 'HELD-1', lane: { origin: 'A', destination: 'B' }, companyName: 'Havells', status: 'awaiting_price' });
    assert.strictEqual(eng.closeUnknownHeld.has('HELD-1'), true, 'fixture: the load is actually held');
    assert.strictEqual(eng.noLandingReport(), null, 'D012: a held load is invisible to the detector - it never reaches a close');
    ok('D012: a held monitor raises no alert (it never finalizes at all)');
  }

  // ---- one silent no-bid close: below threshold (2), no alert yet ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m = armReal(eng, 'SILENT-1', Date.now() + 60_000);
    m.landedBids = 0;
    await eng._finalize(m, { myRank: null }).catch(() => {});
    assert.strictEqual(eng.noLandingReport(), null, 'one silent no-bid close alone is below the default threshold of 2');
    ok('control: a single silent no-bid close does not yet alert');
  }

  // ---- two silent no-bid closes in a row: alert, streak reported ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m1 = armReal(eng, 'SILENT-A', Date.now() + 60_000);
    m1.landedBids = 0;
    await eng._finalize(m1, { myRank: null }).catch(() => {});
    const m2 = armReal(eng, 'SILENT-B', Date.now() + 60_000);
    m2.landedBids = 0;
    await eng._finalize(m2, { myRank: null }).catch(() => {});
    const r = eng.noLandingReport();
    assert.ok(r, 'D012: two consecutive silent no-bid closes cross the threshold');
    assert.strictEqual(r.streak, 2, 'reports the streak length');
    ok('D012: two silent no-bid closes in a row raise one alert');
  }

  // ---- a stood-down close (recorded reason) breaks the streak, even sitting between two silent ones ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m1 = armReal(eng, 'SILENT-C', Date.now() + 60_000);
    m1.landedBids = 0;
    await eng._finalize(m1, { myRank: null }).catch(() => {});
    const m2 = armReal(eng, 'STOOD-DOWN', Date.now() + 60_000);
    m2.landedBids = 0;
    eng._recordRefusal(m2, 'stood_down_below_floor', { floor: 40_000 });
    await eng._finalize(m2, { myRank: null }).catch(() => {});
    assert.strictEqual(eng.noLandingReport(), null,
      'D012: an explained (stood-down) zero-bid close resets the streak - it is not a silent failure');
    ok('D012: a stood-down close resets the streak rather than extending it');
  }

  // ---- a ceiling-below-floor close (recorded reason) resets the streak the same way ----
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m1 = armReal(eng, 'SILENT-D', Date.now() + 60_000);
    m1.landedBids = 0;
    await eng._finalize(m1, { myRank: null }).catch(() => {});
    const m2 = armReal(eng, 'CEILING', Date.now() + 60_000);
    m2.landedBids = 0;
    eng._recordRefusal(m2, 'ceiling_below_floor', { ceiling: 30_000, floor: 40_000 });
    await eng._finalize(m2, { myRank: null }).catch(() => {});
    assert.strictEqual(eng.noLandingReport(), null,
      'D012: an explained (ceiling-below-floor) zero-bid close resets the streak too');
    ok('D012: a ceiling-below-floor close resets the streak rather than extending it');
  }

  // ---- DiscoveryPoller integration: an engine wired in raises the alert once the streak crosses threshold ----
  {
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: [10], minMarginPct: 5 });
    const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
    const calls = [];
    const origAlert = notifier.alert.bind(notifier);
    notifier.alert = async (kind, payload, opts) => { calls.push({ kind, payload, opts }); return origAlert(kind, payload, opts); };

    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    const m1 = armReal(eng, 'STUCK-1', Date.now() + 60_000);
    m1.landedBids = 0;
    await eng._finalize(m1, { myRank: null }).catch(() => {});
    const m2 = armReal(eng, 'STUCK-2', Date.now() + 60_000);
    m2.landedBids = 0;
    await eng._finalize(m2, { myRank: null }).catch(() => {});

    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => [] }, requests: rq, notifier,
      config: { allowlist: { shippers: [] } }, engine: eng,
    });
    await poller.tick();
    // Named reversal (owner-approved terse wording, 26 Sep): was /zero landed bids/.
    const found = calls.find((c) => c.payload && c.payload.context === 'discovery' && /closes in a row with no bid landed/.test(c.payload.detail || ''));
    assert.ok(found, `D012: DiscoveryPoller raises the no-landing alert when its wired engine reports a streak: calls=${JSON.stringify(calls.map((c) => c.payload && c.payload.detail))}`);
    ok('D012: DiscoveryPoller checks its wired engine and alerts on a genuine silent-failure streak');
  }

  // ---- review correction (26 Sep): the streak alert is a ONE-SHOT LATCH, not a level query - a
  // wedged-but-idle account (two silent closes, then nothing armed and nothing new closing for 12
  // hours) must alert exactly ONCE, not re-fire on every tick for as long as the streak stands.
  {
    const eng = new BidEngine(fakeAdapter, tmpScheduler());
    for (const id of ['IDLE-1', 'IDLE-2']) {
      const m = armReal(eng, id, Date.now() + 60_000);
      m.landedBids = 0;
      await eng._finalize(m, { myRank: null }).catch(() => {});
    }
    const s = createStore({ backend: 'memory' });
    const rq = new PriceRequestStore({ store: s, marginsPct: [10], minMarginPct: 5 });
    const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://t' });
    const seen = new Set();
    notifier.alert = async (kind, payload, opts) => {
      if (payload && /closes in a row with no bid landed/.test(payload.detail || '')) seen.add(opts && opts.dedupeKey);
      return true;
    };
    const poller = new DiscoveryPoller({
      adapter: { listAuctions: async () => [] }, requests: rq, notifier,
      config: { allowlist: { shippers: ['X'] } }, engine: eng,
    });
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      // 12 idle hours, a tick every 30s, nothing armed and nothing new closing the whole time.
      for (let t = 0; t < 12 * 3600_000; t += 30_000) { skew = t; await poller.tick(); }
    } finally { Date.now = realNow; }
    assert.strictEqual(seen.size, 1,
      `D012: exactly one alert (by dedupe key) across 12 idle hours after a two-close streak, got ${seen.size} distinct key(s): ${JSON.stringify([...seen])}`);
    ok('D012: the silent-failure streak alerts exactly once, then stays quiet through a fully idle 12-hour stretch');
  }

  console.log(`\n${pass}/9 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
