'use strict';
/**
 * Ladder validity vs the platform's minimum decrement.
 *
 * The engine already refuses to fire a non-floor ladder step that sits less than the load's
 * minimum bid difference below our last bid (bidEngine._maybeBid) - correctly, because the
 * platform would reject it and the rung would be spent for nothing. But it refuses with a bare
 * `return`: the rung never bids and nobody is told. On the live band the only non-floor step is
 * cost x 0.054, so on a real Rs 18,000 load (20268 / 19296 / 18486, a 972 gap) that middle rung is
 * already unfireable on any branch running a 1000 or 1500 bid difference.
 *
 * These checks cover the DETECTION that was added: the pure predicate, the once-per-monitor
 * operator alert, and - most importantly - that the detection changes no bidding behaviour and
 * never reaches the WhatsApp path.
 *
 *   node scripts/test-ladder-validity-alert.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BidEngine, decrementViolations } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { buildBandLadder } = require('../src/engine/pricing');
const { toNotification, ERROR_KINDS } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const tmp = (tag) => path.join(os.tmpdir(), `ladder-validity-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

// A monitor-driving adapter whose getAuctionState reports a fixed per-load decrement.
function makeAdapter({ minDecrement, closesInMs = 8000, myRank = 2, placed = [] }) {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: true,
    async getAuctionState() {
      return { ok: true, status: 'live', myRank, totalBidders: 2, standingL1Price: null,
        closesInMs, revisionLimit: 3, revisionsLeft: null, minDecrement, closeModel: 'hard', measuredRttMs: 50 };
    },
    async placeBid(id, price) { placed.push(price); return { accepted: true, myRank, revisionsLeft: null, latencyMs: 20 }; },
  };
}

const armMeta = (id, closesInMs) => ({ id, lane: { origin: 'A', destination: 'B' }, units: 1,
  companyName: 'Test Shipper', closesAt: Date.now() + closesInMs });

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. The pure predicate.
  // ---------------------------------------------------------------------------------------------
  {
    // The real load from the diagnosis: cost 18000 on the live 12.6 / 7.2 / 2.7 band.
    const plan = buildBandLadder({ cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.deepStrictEqual(plan.ladder, [20268, 19296, 18486], 'the reference ladder is the one the live band builds');
    ok('reference ladder for cost 18000 on the live band is 20268 / 19296 / 18486');

    assert.deepStrictEqual(decrementViolations(plan.ladder, 100), [], 'a 100 decrement clears the 972 step');
    assert.deepStrictEqual(decrementViolations(plan.ladder, 500), [], 'a 500 decrement clears the 972 step');
    ok('narrow decrements (100 / 500) report no violation on the reference ladder');

    for (const minDec of [1000, 1500]) {
      const v = decrementViolations(plan.ladder, minDec);
      assert.strictEqual(v.length, 1, `a ${minDec} decrement flags exactly one step`);
      assert.deepStrictEqual(v[0], { fromIndex: 0, toIndex: 1, fromPrice: 20268, toPrice: 19296, gap: 972 });
    }
    ok('wide decrements (1000 / 1500) flag the 20268 -> 19296 step, gap 972');
  }

  {
    // The step INTO the floor rung is exempt: _maybeBid always attempts the floor regardless of
    // spacing, so reporting it would be a false alarm. On the reference ladder the floor step is
    // 810 - narrower than the flagged one - and must still never appear.
    const v = decrementViolations([20268, 19296, 18486], 1500);
    assert.ok(!v.some((x) => x.toIndex === 2), 'the step into the floor rung is never reported');
    ok('the step into the floor rung is exempt, even when it is the narrowest gap on the ladder');

    // Ladders with no non-floor step at all.
    assert.deepStrictEqual(decrementViolations([20000, 18000], 5000), [], '2-rung ladder: only step is into the floor');
    assert.deepStrictEqual(decrementViolations([18486], 5000), [], '1-rung collapsed ladder has no steps');
    ok('ladders of 1 or 2 rungs report nothing (their only step, if any, is into the floor)');

    // An unknown / disabled decrement must not warn - it mirrors the guard's own truthiness test,
    // so the alert can never claim a refusal the engine would not actually hit.
    for (const bad of [null, undefined, 0, -100, NaN, '1500']) {
      assert.deepStrictEqual(decrementViolations([20268, 19296, 18486], bad), [], `decrement ${String(bad)} -> no violation`);
    }
    ok('an unknown, zero, negative or non-numeric decrement reports nothing (mirrors the guard)');

    // A 4-margin band can carry more than one offending non-floor step.
    const wide = buildBandLadder({ cost: 18000, marginsPct: [12.6, 10, 7.2, 2.7], minMarginPct: 2.7 });
    const v4 = decrementViolations(wide.ladder, 1500);
    assert.strictEqual(v4.length, 2, 'both non-floor steps of the 4-rung ladder are flagged');
    ok('every offending non-floor step is reported, not just the first');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. The engine surfaces it once, as a console/log alert.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('alert');
    const events = [];
    const placed = [];
    const eng = new BidEngine(makeAdapter({ minDecrement: 1500, placed }), new DurableScheduler(f),
      { config: { openAtMs: 15000, floorWindowMs: 2500, minInterFireMs: 0 }, rand: () => 0,
        onEvent: (e) => events.push(e) });
    const m = eng.arm(armMeta('L1', 8000), { cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.deepStrictEqual(m.ladder, [20268, 19296, 18486], 'monitor armed on the reference ladder');

    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    const alerts = events.filter((e) => e.type === 'alert' && e.kind === 'ladder_below_min_decrement');
    assert.strictEqual(alerts.length, 1, 'exactly one validity alert after the first tick');
    const a = alerts[0];
    assert.strictEqual(a.level, 'warn');
    assert.strictEqual(a.auctionId, 'L1', 'the alert names the load');
    assert.strictEqual(a.minDecrement, 1500, 'the alert carries the platform minimum');
    assert.deepStrictEqual(a.violations, [{ fromIndex: 0, toIndex: 1, fromPrice: 20268, toPrice: 19296, gap: 972 }]);
    assert.ok(/\b972\b/.test(a.detail), 'the detail names the offending gap');
    assert.ok(/\b1500\b/.test(a.detail), 'the detail names the platform minimum');
    assert.ok(a.detail.includes('L1'), 'the detail names the load');
    ok('a ladder with an unfireable rung raises one warn alert naming load, gap and platform minimum');

    // Latched: further ticks must not repeat it.
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    const again = events.filter((e) => e.type === 'alert' && e.kind === 'ladder_below_min_decrement');
    assert.strictEqual(again.length, 1, 'still exactly one alert after three ticks');
    ok('the alert is latched to one per monitor, not repeated every tick');
    eng.kill();
    rm(f);
  }

  {
    // A load whose spacing clears its decrement must stay silent.
    const f = tmp('quiet');
    const events = [];
    const eng = new BidEngine(makeAdapter({ minDecrement: 100 }), new DurableScheduler(f),
      { config: { openAtMs: 15000, floorWindowMs: 2500, minInterFireMs: 0 }, rand: () => 0,
        onEvent: (e) => events.push(e) });
    const m = eng.arm(armMeta('L2', 8000), { cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(events.filter((e) => e.kind === 'ladder_below_min_decrement').length, 0,
      'a ladder that clears its decrement raises nothing');
    ok('no alert when the ladder spacing clears the load decrement (no false alarm)');
    eng.kill();
    rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. It must not reach WhatsApp, and must not change any bid.
  // ---------------------------------------------------------------------------------------------
  {
    assert.ok(!ERROR_KINDS.has('ladder_below_min_decrement'), 'the kind is not in the WhatsApp error set');
    const n = toNotification({ type: 'alert', level: 'warn', kind: 'ladder_below_min_decrement',
      auctionId: 'L1', minDecrement: 1500, detail: 'x', lane: { origin: 'A', destination: 'B' } });
    assert.strictEqual(n, null, 'the alert maps to no recipient-facing notification');
    ok('the alert stays off the WhatsApp path (maps to no notification)');
  }

  {
    // The behavioural guarantee that matters on live money: adding the detection changes nothing
    // about which prices go on the wire. Same adapter, same seed, same ticks - with the alert
    // firing (1500 decrement) and without it (100 decrement, spacing clears) the placed prices
    // must be exactly what the pre-existing min-decrement guard produces.
    const runs = {};
    for (const minDecrement of [1500, 100]) {
      const f = tmp(`bids-${minDecrement}`);
      const placed = [];
      const eng = new BidEngine(makeAdapter({ minDecrement, placed }), new DurableScheduler(f),
        { config: { openAtMs: 15000, floorWindowMs: 2500, minInterFireMs: 0 }, rand: () => 0 });
      const m = eng.arm(armMeta('L3', 8000), { cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
      for (let i = 0; i < 3; i++) { await eng._tick(m); if (m.timer) clearTimeout(m.timer); }
      eng.kill();
      runs[minDecrement] = { placed: placed.slice(), firedRungs: [...m.firedRungs].sort(), ladder: m.ladder.slice() };
      rm(f);
    }
    // The alerting run still obeys the original guard: no non-floor step under 1500 was placed.
    for (let i = 1; i < runs[1500].placed.length; i++) {
      const gap = runs[1500].placed[i - 1] - runs[1500].placed[i];
      const intoFloor = runs[1500].placed[i] === runs[1500].ladder[runs[1500].ladder.length - 1];
      assert.ok(gap <= 0 || intoFloor || gap >= 1500, `no non-floor step violates the 1500 decrement (gap ${gap})`);
    }
    // And the ladder itself is untouched by the detection.
    assert.deepStrictEqual(runs[1500].ladder, [20268, 19296, 18486], 'ladder unchanged on the alerting run');
    assert.deepStrictEqual(runs[100].ladder, [20268, 19296, 18486], 'ladder unchanged on the quiet run');
    assert.ok(runs[1500].placed.length > 0, 'the alerting load still bids (the detection never stands the bot down)');
    ok('the detection changes no ladder, spends no rung, and never suppresses a bid');
  }

  console.log(`\n${pass}/12 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
