'use strict';
/**
 * Observability of the blind-rank guard: the guard must leave a trace, and the trace must be LATCHED.
 *
 * The guard itself (its bidding behaviour) is covered by scripts/test-blind-rank-guard.js. This file
 * covers only what the guard TELLS anybody, which was previously a single log.debug line - invisible
 * at the default LOG_LEVEL, and the exact shape the team was already burned by once (see the note at
 * realAdapter.js:881, "the prior debug-level line here never printed in prod"). A load that quietly
 * ran on fewer rungs than its ladder had could not be told apart from a normal one in a post-mortem.
 *
 * The latch is the load-bearing property here, not a nicety. The blind window is ~1.15s of ordinary
 * socket self-match latency on EVERY soft-close auction and the hot poll cadence is 200ms, so an
 * unlatched alert would fire roughly six times per auction as a matter of routine - and without
 * bound after a mid-auction restart where the rank never comes back. That is strictly worse than the
 * debug line it replaces: it would bury the event ring and train an operator to ignore the kind. So
 * "at most one per load" is asserted from several directions, including through the real tick loop.
 *
 * Also pinned here: the guard's alert must never reach WhatsApp (the recipient set includes the
 * client's director), and adding it must not move a single price on the wire.
 *
 *   node scripts/test-blind-rank-alert.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { BidEngine, decrementViolations: reexported } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const pricing = require('../src/engine/pricing');
const { toNotification, ERROR_KINDS } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const tmp = (tag) => path.join(os.tmpdir(), `blind-rank-alert-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0 };
const BAND = { cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 };
// The live band at cost 18000: rung 0 establishes, rung 1 is the only discretionary step, rung 2 is
// the reserved floor. Same fixture as test-blind-rank-guard.js on purpose - the two files describe
// two halves (behaviour / observability) of one guard and must not drift apart on the numbers.
const LADDER = [20268, 19296, 18486];

const baseAdapter = () => ({
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
  ensureSession: async () => ({}),
  writeEnabled: true,
  async getAuctionState() { return { ok: false }; },
  async placeBid() { return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 20 }; },
});

const st = (o) => Object.assign({ ok: true, status: 'live', myRank: null, totalBidders: 1,
  standingL1Price: null, closesInMs: 10000, revisionLimit: 3, revisionsLeft: null,
  minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }, o);

const armMeta = (id, closesInMs) => ({ id, lane: { origin: 'A', destination: 'B' }, units: 1,
  companyName: 'Havells', closesAt: Date.now() + closesInMs });

// Every engine in this file records its events, because every check here is about what was emitted.
function mkEngine(f, opts = {}) {
  const events = [];
  const eng = new BidEngine(baseAdapter(), new DurableScheduler(f),
    Object.assign({ config: CFG, rand: () => 0, onEvent: (e) => events.push(e) }, opts));
  return { eng, events, holds: () => events.filter((e) => e.type === 'alert' && e.kind === 'blind_rank_hold') };
}

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. The alert exists, is latched, and says something true.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('shape');
    const { eng, holds } = mkEngine(f);
    const m = eng.arm(armMeta('B1', 10000), BAND);
    assert.deepStrictEqual(m.ladder, LADDER);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268; // establish already banked

    assert.strictEqual(eng._decide(m, st({ myRank: null })), null, 'the guard holds on a null rank');
    assert.strictEqual(holds().length, 1, 'the hold raised exactly one alert');
    const a = holds()[0];
    assert.strictEqual(a.level, 'info', 'level is info - the hold is the normal case, not a fault');
    assert.strictEqual(a.auctionId, 'B1', 'the alert names the load');
    assert.strictEqual(a.heldDecision, 'step-down', 'the alert names which discretionary decision was blocked');
    assert.strictEqual(a.closeModel, 'hard');
    assert.strictEqual(a.currentRungIndex, 0, 'the alert carries the rung we were holding at');
    assert.deepStrictEqual(a.lane, { origin: 'A', destination: 'B' });
    assert.strictEqual(a.companyName, 'Havells');
    assert.ok(/rank/i.test(a.detail) && a.detail.includes('B1'), 'the detail names the load and the cause');
    ok('a blind-rank hold raises one info alert naming the load, the held decision and the cause');
    eng.kill(); rm(f);
  }

  {
    // THE property. Ten more consecutive blind ticks must add nothing: at 200ms hot cadence an
    // unlatched alert would fire about six times in the ~1.15s window alone.
    const f = tmp('latch');
    const { eng, holds } = mkEngine(f);
    const m = eng.arm(armMeta('B2', 10000), BAND);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;
    for (let i = 0; i < 11; i++) {
      assert.strictEqual(eng._decide(m, st({ myRank: null, closesInMs: 10000 - i * 200 })), null, 'still holding');
    }
    assert.strictEqual(holds().length, 1, 'eleven blind decisions still produced exactly one alert');
    ok('the alert is latched: repeated blind ticks on one load never repeat it');
    eng.kill(); rm(f);
  }

  {
    // The latch is SHARED between the two guard sites. They are one guard reported once per load,
    // not two independent conditions - a soft load whose extensions later exhaust crosses from the
    // soft-defend branch to the hard step-down branch and must not alert a second time.
    const f = tmp('shared');
    const { eng, holds } = mkEngine(f, { softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } });
    const m = eng.arm(armMeta('B3', 10000), BAND);
    assert.strictEqual(m.softStrategy, 'live', 'the soft-close endgame is engaged for this shipper');
    m.closeModel = 'soft'; m.extendCap = 3; m.extendsObserved = 0; m.revisionsLeft = 3;
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;

    assert.strictEqual(eng._effectivelyHard(m), false, 'extensions remain, so the soft branch owns the decision');
    assert.strictEqual(eng._decide(m, st({ myRank: null, closesInMs: 10000, closeModel: 'soft' })), null, 'soft branch holds');
    assert.strictEqual(holds().length, 1, 'the soft branch alerted once');
    assert.strictEqual(holds()[0].heldDecision, 'soft-close defend', 'and named itself as the soft-close defend');

    // Extensions exhaust -> the soft branch no longer applies, so the same monitor now reaches the
    // hard step-down guard. Outside the final window, so the snipe branch does not intercept.
    m.extendsObserved = 3;
    assert.strictEqual(eng._effectivelyHard(m), true, 'extensions exhausted');
    assert.strictEqual(eng._decide(m, st({ myRank: null, closesInMs: 10000, closeModel: 'soft' })), null, 'hard branch holds');
    assert.strictEqual(holds().length, 1, 'crossing to the other guard site did NOT alert again');
    ok('both guard sites share one latch: a load alerts once, not once per branch');
    eng.kill(); rm(f);
  }

  {
    // Per MONITOR, not per engine. Latching on engine-level state would silence every load after the
    // first, which on a busy box is most of them.
    const f = tmp('permonitor');
    const { eng, holds } = mkEngine(f);
    for (const id of ['B4', 'B5']) {
      const m = eng.arm(armMeta(id, 10000), BAND);
      m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;
      eng._decide(m, st({ myRank: null }));
    }
    assert.deepStrictEqual(holds().map((h) => h.auctionId), ['B4', 'B5'], 'each load alerted for itself');
    ok('the latch is per load: a second load still gets its own alert');
    eng.kill(); rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 2. Silence where there is nothing to report.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('quiet');
    const { eng, holds } = mkEngine(f);
    const m = eng.arm(armMeta('B6', 10000), BAND);

    // Establishing bid: rank is null but currentRungIndex is -1, so the establish is decided ABOVE
    // the guard and never reaches it. It must fire, and it must not look like a withheld step-down.
    assert.deepStrictEqual(eng._decide(m, st({ myRank: null })), { price: 20268, rungIndex: 0 }, 'establish fires blind');
    assert.strictEqual(holds().length, 0, 'the establishing bid raises no hold alert');
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;

    // A known rank never engages the guard at all - neither outranked nor winning.
    const seen = eng._decide(m, st({ myRank: 2 }));
    assert.ok(seen && seen.rungIndex === 1, 'a known rank steps down as before');
    assert.strictEqual(eng._decide(m, st({ myRank: 1 })), null, 'a known winning rank holds as before');
    assert.strictEqual(holds().length, 0, 'a known rank raises no hold alert either way');
    ok('no alert for the establishing bid, and none once a rank is known');
    eng.kill(); rm(f);
  }

  {
    // The final floor snipe is decided before the hard guard and never consults rank. A blind snipe
    // is the guard working as designed (holding costs margin, never the load), so it must stay quiet.
    const f = tmp('snipe');
    const { eng, holds } = mkEngine(f);
    const m = eng.arm(armMeta('B7', 2000), BAND);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 20268;
    assert.deepStrictEqual(eng._decide(m, st({ myRank: null, closesInMs: 1200 })), { price: 18486, rungIndex: 2 },
      'the floor rung still fires blind inside the final window');
    assert.strictEqual(holds().length, 0, 'the final snipe raises no hold alert');
    ok('the final floor snipe is untouched by the alert path as well as by the guard');
    eng.kill(); rm(f);
  }

  {
    // HONESTY OF THE MESSAGE. The guard returns before the due-checks that follow it
    // (next <= currentRungIndex, firedRungs.has(next)), so it fires on loads where no rung was due
    // in the first place. Here every non-floor rung is already spent and the monitor sits at the
    // last one, so a known rank would select nothing either - yet the alert still fires. Its wording
    // must therefore not assert that a rung was taken away from us; it may only say that no rung can
    // be selected while blind. Overclaiming here is the same defect class as the "operator console"
    // line that had to be corrected on the sibling alert.
    const f = tmp('nothing-due');
    const { eng, holds } = mkEngine(f);
    const m = eng.arm(armMeta('B10', 10000), BAND);
    m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1); m.lastBidPrice = 19296;

    // Precondition: with a KNOWN rank this monitor selects nothing - there is genuinely nothing due.
    assert.strictEqual(eng._decide(m, st({ myRank: 2 })), null, 'nothing is due even when the rank is known');
    // Same monitor, blind: the alert still fires (the guard cannot know nothing was due)...
    assert.strictEqual(eng._decide(m, st({ myRank: null })), null, 'still holds');
    assert.strictEqual(holds().length, 1, 'the hold alerted');
    // ...so it must not claim a rung was withheld, because on this load none was.
    assert.ok(!/withheld|denied|refused/i.test(holds()[0].detail),
      'the detail must not assert a rung was withheld - none was due on this load');
    assert.ok(/whether or not one was due/i.test(holds()[0].detail),
      'the detail explicitly hedges on whether a rung was due');
    ok('the alert does not overclaim: it never asserts a rung was withheld when none was due');
    eng.kill(); rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 3. Through the real tick loop: one alert, and not one price moved.
  // ---------------------------------------------------------------------------------------------
  {
    // The never-arrives case driven through _tick rather than _decide - the mid-auction-restart
    // shape, where the routed carrier is not re-registered until we bid again and the rank stays
    // null for the whole auction. This is the run that would emit unboundedly without the latch.
    const f = tmp('ticks');
    const placed = [];
    const events = [];
    const adapter = Object.assign(baseAdapter(), {
      async getAuctionState() { return st({ myRank: null, closesInMs: this._t }); },
      async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 20 }; },
    });
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: CFG, rand: () => 0, onEvent: (e) => events.push(e) });
    const m = eng.arm(armMeta('B8', 30000), BAND);
    // A long blind run: eight ticks, six of them inside the hot-cadence window where an unlatched
    // alert would fire on every single one.
    for (const t of [20000, 12000, 8000, 6000, 5000, 4000, 3000, 1200]) {
      adapter._t = t;
      await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    }
    eng.kill();

    const holds = events.filter((e) => e.type === 'alert' && e.kind === 'blind_rank_hold');
    assert.strictEqual(holds.length, 1, 'eight ticks with a permanently-null rank still produced ONE alert');
    ok('driven through the tick loop, a rank that never arrives alerts exactly once');

    // And the money path is byte-identical to what the guard alone produced (the assertion in
    // test-blind-rank-guard.js's never-arrives case): establish + floor snipe, mid rung withheld.
    assert.deepStrictEqual(placed, [20268, 18486], 'exactly the establish and the floor snipe, in order');
    assert.deepStrictEqual(m.ladder, LADDER, 'the ladder is untouched');
    ok('adding the alert moved no price: establish + floor snipe fired, the mid rung stayed withheld');
    rm(f);
  }

  // ---------------------------------------------------------------------------------------------
  // 4. It must never reach WhatsApp.
  // ---------------------------------------------------------------------------------------------
  {
    // The recipient set for that surface includes the client's director, and this alert is the
    // NORMAL case on every soft-close auction - routine traffic by nature. It must map to nothing.
    assert.ok(!ERROR_KINDS.has('blind_rank_hold'), 'the kind is not in the WhatsApp error set');
    const n = toNotification({ type: 'alert', level: 'info', kind: 'blind_rank_hold', auctionId: 'B9',
      heldDecision: 'step-down', detail: 'x', lane: { origin: 'A', destination: 'B' }, companyName: 'Havells' });
    assert.strictEqual(n, null, 'the alert maps to no recipient-facing notification');
    ok('the alert stays off the WhatsApp path (not an ERROR_KIND, maps to no notification)');
  }

  // ---------------------------------------------------------------------------------------------
  // 5. decrementViolations lives in pricing.js (the documented ladder-maths boundary).
  // ---------------------------------------------------------------------------------------------
  {
    assert.strictEqual(typeof pricing.decrementViolations, 'function',
      'the pure ladder predicate is exported from the pricing module');
    assert.strictEqual(reexported, pricing.decrementViolations,
      'the engine re-export is the SAME function, so no importer can drift onto a stale copy');
    // A live behavioural spot-check through the pricing import, so the move is proven by behaviour
    // and not only by identity: the real load from the diagnosis, 972 apart on a 1500 branch.
    const { ladder } = pricing.buildBandLadder({ cost: 18000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.deepStrictEqual(pricing.decrementViolations(ladder, 1500),
      [{ fromIndex: 0, toIndex: 1, fromPrice: 20268, toPrice: 19296, gap: 972 }]);
    assert.deepStrictEqual(pricing.decrementViolations(ladder, 100), []);
    ok('decrementViolations is exported from pricing.js and the engine re-export is the same function');
  }

  console.log(`\n${pass}/11 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
