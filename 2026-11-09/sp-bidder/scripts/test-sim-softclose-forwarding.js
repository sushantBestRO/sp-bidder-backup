'use strict';
/**
 * SIM soft-close forwarding + extend-cap regression.
 *
 * Two sim blockers this proves fixed (both stopped the soft-close endgame from ever
 * running inside the simulator / demo / Suyashh walkthrough):
 *
 *   1. mockAdapter.getAuctionState USED to DROP minDecrement / extendMs / extendCount /
 *      triggerWindowMs / closesAtMs / revisionLimit. Without those, bidEngine._observeExtension
 *      can never confirm an extension (extendCount + closesAtMs + extendMs are its inputs), so
 *      monitor.extendCap stays null and _effectivelyHard returns true from the start -> every
 *      soft sim auction is treated as effectively-hard and the defend/snipe arc never occurs.
 *      getAuctionState now forwards all six, matching realAdapter.js:697-715.
 *
 *   2. auctionSim had NO extension cap: a late bid extended the close forever, so the sim could
 *      never reach a genuinely-final window. spawn() now takes an extendCap (null = unlimited =
 *      today's behaviour) and submitBid only extends while extendsUsed < extendCap - the same
 *      endgame the real branchExtendAuctionCount produces.
 *
 *   node scripts/test-sim-softclose-forwarding.js
 */
const assert = require('assert');
const { AuctionSim } = require('../src/sim/auctionSim');
const { MockSuperProcureAdapter } = require('../src/platform/mockAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// A lane with generous headroom so US bids never brush the (randomised) ceiling.
const LANE = { origin: 'Bhiwandi, MH', destination: 'Hosur, TN', equipment: '32ft SXL', weight: 15, baseRate: 100_000 };

(async () => {
  // ---- 1. mockAdapter.getAuctionState forwards the six soft-close fields the real adapter surfaces ----
  {
    const sim = new AuctionSim({ onEvent: () => {} });
    const a = sim.spawn({
      lane: LANE, competitors: 0, closeModel: 'soft', durationMs: 60_000,
      extendCap: 2, minDecrement: 1500, softExtendWindowMs: 15_000, softExtendByMs: 20_000, revisionLimit: 3,
    });
    const adapter = new MockSuperProcureAdapter(sim, { transientFailRate: 0 }); // deterministic: no read blip
    await adapter.login();
    const s = await adapter.getAuctionState(a.id);

    assert.strictEqual(s.ok, true, 'state read ok');
    assert.strictEqual(s.closeModel, 'soft', 'soft close model surfaced');
    // the exact six fields _observeExtension / _effectivelyHard need, previously dropped:
    assert.strictEqual(s.extendCount, 2, 'extendCount forwarded (= extendCap)');
    assert.strictEqual(s.triggerWindowMs, 15_000, 'triggerWindowMs forwarded (= softExtendWindowMs)');
    assert.strictEqual(s.extendMs, 20_000, 'extendMs forwarded (= softExtendByMs)');
    assert.strictEqual(s.minDecrement, 1500, 'minDecrement forwarded (per-load Bid Difference)');
    assert.strictEqual(s.revisionLimit, 3, 'revisionLimit forwarded');
    assert.strictEqual(s.closesAtMs, a.closesAt, 'closesAtMs is the ABSOLUTE close, not the relative countdown');
    assert.ok(s.closesAtMs > s.closesInMs, 'absolute close (epoch) dwarfs the relative closesInMs');
    // the precondition _observeExtension actually checks (finite cap + finite absolute close):
    assert.ok(Number.isFinite(s.extendCount) && Number.isFinite(s.closesAtMs) && s.extendMs > 0,
      '_observeExtension inputs are all present and finite (was: all null -> always returned false)');
    ok('mockAdapter.getAuctionState forwards extendCount/triggerWindowMs/extendMs/minDecrement/revisionLimit/closesAtMs (all six were dropped)');
  }

  // ---- 2. a late bid extends the close ONLY while extendsUsed < extendCap, then stops ----
  {
    let nowMs = 1_000_000;                                   // injected deterministic clock
    const sim = new AuctionSim({ clock: () => nowMs, onEvent: () => {} });
    const a = sim.spawn({
      lane: LANE, competitors: 0, closeModel: 'soft', durationMs: 30_000,
      extendCap: 2, softExtendWindowMs: 10_000, softExtendByMs: 20_000, revisionLimit: 20, minDecrement: 100,
    });
    assert.strictEqual(a.extendCap, 2, 'extendCap stored on the auction');
    assert.strictEqual(a.extendsUsed, 0, 'extendsUsed starts at 0');
    const origClose = a.closesAt;
    assert.strictEqual(origClose, 1_030_000, 'initial close = now + durationMs');

    // extension #1: bid inside the window (room under cap) -> close moves out, extendsUsed 0 -> 1
    nowMs = origClose - 5_000;                               // remaining 5000 <= window 10000
    const r1 = sim.submitBid(a.id, 'US', 60_000);
    assert.strictEqual(r1.accepted, true, 'bid 1 accepted');
    assert.strictEqual(r1.extended, true, 'bid 1 fired an extension (room under cap)');
    assert.strictEqual(a.extendsUsed, 1, 'extendsUsed = 1');
    assert.strictEqual(a.closesAt, origClose + 20_000, 'close pushed out by softExtendByMs');

    // extension #2: still under cap (1 < 2) -> extends again, cap now reached
    nowMs = a.closesAt - 5_000;
    const r2 = sim.submitBid(a.id, 'US', 59_000);
    assert.strictEqual(r2.extended, true, 'bid 2 fired an extension (still under cap)');
    assert.strictEqual(a.extendsUsed, 2, 'extendsUsed = 2 (cap reached)');
    const cappedClose = a.closesAt;

    // bid #3 inside the window but cap is exhausted (2 == 2) -> NO extension: genuinely final window
    nowMs = cappedClose - 5_000;
    const r3 = sim.submitBid(a.id, 'US', 58_000);
    assert.strictEqual(r3.accepted, true, 'bid 3 still accepted');
    assert.strictEqual(r3.extended, false, 'bid 3 did NOT extend (cap exhausted -> auction is now genuinely final)');
    assert.strictEqual(a.extendsUsed, 2, 'extendsUsed stays at the cap');
    assert.strictEqual(a.closesAt, cappedClose, 'close unchanged once the cap is reached');
    ok('extendCap gates the deadline: extends while extendsUsed < cap, stops extending once the cap is reached');
  }

  // ---- 3. extendCap: null (default) still extends indefinitely (backward-compat, unchanged behaviour) ----
  {
    let nowMs = 2_000_000;
    const sim = new AuctionSim({ clock: () => nowMs, onEvent: () => {} });
    const a = sim.spawn({
      lane: LANE, competitors: 0, closeModel: 'soft', durationMs: 30_000,
      softExtendWindowMs: 10_000, softExtendByMs: 20_000, revisionLimit: 20, minDecrement: 100,
      // extendCap omitted -> null -> unlimited (this is exactly what demo.js / existing tests rely on)
    });
    assert.strictEqual(a.extendCap, null, 'extendCap defaults to null (unlimited)');

    // fire far more extensions than any finite cap would allow; every late bid must still extend
    const ROUNDS = 6;
    for (let i = 0; i < ROUNDS; i++) {
      nowMs = a.closesAt - 5_000;                            // step into each fresh window
      const r = sim.submitBid(a.id, 'US', 60_000 - i * 500);
      assert.strictEqual(r.extended, true, `round ${i + 1}: still extends (no cap)`);
      assert.strictEqual(a.extendsUsed, i + 1, `round ${i + 1}: extendsUsed keeps climbing`);
    }
    assert.strictEqual(a.extendsUsed, ROUNDS, 'unlimited extends: every late bid pushed the close');
    ok('extendCap null keeps extending indefinitely (backward-compat: existing demo/tests unchanged)');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
