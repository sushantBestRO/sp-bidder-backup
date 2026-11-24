'use strict';
/**
 * _deriveRungCount GATE MATRIX (bidEngine._deriveRungCount(inputs, rules, companyName)).
 *
 * Every null path here is a REVERSIBILITY guarantee: on merge, a customer who is not explicitly opted in
 * (or a load whose platform cap / arm-type does not admit expansion) must keep the DEPLOYED coarse
 * 3-anchor buildBandLadder ladder, byte-identical. When the gates DO open, the derived count is
 *   max(anchorCount, min(revisionLimit, capKnob, RUNG_RUNAWAY_MAX=40, decrementHeadroom))
 * with capKnob = cfg.rungCap > 0 ? cfg.rungCap : Infinity (0/absent/negative/NaN => auto) and
 * decrementHeadroom = 1 + floor(bandSpan / minDecrement) (dropping to Infinity when minDec is 0/NaN).
 *
 * SEAM: this exercises _deriveRungCount DIRECTLY (not arm().ladder.length). The return value is the exact
 * contract - null vs a finite integer - and it is strictly more discriminating than ladder length: the
 * null path and an active derive that floors to anchorCount BOTH produce a 3-rung ladder, so only the
 * method's own return value separates "coarse (null)" from "active, floored to the anchors" (see the
 * anchor_floor check). test-rank-driven-endgame.js check 5 already covers the ladder-length integration
 * seam (wide->30, narrow->17, explicit rungCap 8->8); this file covers the gate matrix + numeric edges.
 *
 * Offline and deterministic: fake adapter, memory-backed scheduler, no timers, no network, no arm.
 *
 *   node scripts/test-derive-rung-count.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `rung-count-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// mkEngine copied verbatim from scripts/test-rank-driven-endgame.js (harness reuse per brief). Rank-only
// caps, minDecrement 100, revisionLimit 30 (adapter default), rungCap 0 (auto) unless overridden.
function mkEngine(softClose, cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose,
  });
}

// --- Fixtures. Expected ladder shapes hand-derived (cost*(1+margin/100), rounded, strictly descending,
//     floor last), NOT computed via the impl's own buildBandLadder, so the tests never agree-by-construction.
// BAND  -> [22400, 21600, 20800] : anchorCount 3, span 1600, headroom(minDec100)=floor(1600/100)+1=17
const BAND = { cost: 20_000, marginsPct: [12, 8, 4], minMarginPct: 4 };
// WIDE  -> [24520, 23440, 20060] : anchorCount 3, span 4460, headroom(minDec100)=floor(4460/100)+1=45
const WIDE = { cost: 20_000, marginsPct: [22.6, 17.2, 0.3], minMarginPct: 0.3 };
// NARROW-> [22400, 22320, 22250] : anchorCount 3, span  150, headroom(minDec100)=floor(150/100)+1=2
const NARROW = { cost: 20_000, marginsPct: [12, 11.6, 11.25], minMarginPct: 11.25 };
const ANCHOR_COUNT = 3;             // each band has 3 finite, strictly-descending margins -> 3 anchors
const ALLOW = 'Havells India Ltd';  // word-boundary tokenMatches allowlist token 'Havells' (proven by endgame check 5)
const DENY = 'Syngenta';            // not on the allowlist -> _resolveSoftStrategy resolves 'off'
const SOFT_ON = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };

// Global contract invariant: a non-null result is a FINITE INTEGER in [anchorCount, 40]. Number.isInteger
// also rejects NaN/Infinity, so this doubles as the poisoning guard on every active path.
function assertInvariant(v, label) {
  assert.ok(Number.isInteger(v), `${label}: non-null result is a finite integer (no NaN/Infinity/float leak)`);
  assert.ok(v >= ANCHOR_COUNT && v <= 40, `${label}: non-null result is within [${ANCHOR_COUNT}, 40]`);
}

(async () => {
  const engAuto = mkEngine(SOFT_ON); // rungCap default 0 (auto)

  // ============================================================================================
  // 1. limit_at_threshold - revisionLimit exactly 3 (== LOW_CAP_THRESHOLD) stays coarse. The contract
  //    is > 3 (strictly), NOT >= 3: a 3-cap load has no slack to absorb a fine ladder.
  // ============================================================================================
  {
    // Arrange
    const rules = { revisionLimit: 3, minDecrement: 100 };
    // Act
    const got = engAuto._deriveRungCount(BAND, rules, ALLOW);
    // Assert
    assert.strictEqual(got, null, 'revisionLimit exactly 3 (== threshold) returns null (> 3 required)');
    // catches: comparator flip `<=` -> `<` on the low-cap gate (3 would then derive 3 instead of null)
    ok('limit_at_threshold: revisionLimit == 3 returns null (boundary: > 3 required, not >=)');
  }

  // ============================================================================================
  // 2. limit_just_above - revisionLimit 4 (threshold + 1) is the first ACTIVE cap. min(4,Inf,40,17)=4.
  // ============================================================================================
  {
    // Arrange
    const rules = { revisionLimit: 4, minDecrement: 100 };
    // Act
    const got = engAuto._deriveRungCount(BAND, rules, ALLOW);
    // Assert
    assert.strictEqual(got, 4, 'revisionLimit 4 derives exactly 4 rungs (the platform cap binds)');
    assert.ok(got >= ANCHOR_COUNT, 'the derived count is never below the anchor count');
    assertInvariant(got, 'limit_just_above');
    // catches: off-by-one on the low-cap gate; Math.min identity collapse to a wrong term
    ok('limit_just_above: revisionLimit 4 derives 4 (non-null, >= anchorCount)');
  }

  // ============================================================================================
  // 3. limit_nan - NaN (and a string that Number() maps to NaN) fail the finite gate -> null. Proves the
  //    finite gate exists, not just the > 3 gate, and that a garbage cap never poisons Math.min.
  // ============================================================================================
  {
    // Act
    const gotNan = engAuto._deriveRungCount(BAND, { revisionLimit: NaN, minDecrement: 100 }, ALLOW);
    const gotStr = engAuto._deriveRungCount(BAND, { revisionLimit: 'not-a-number', minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(gotNan, null, 'revisionLimit NaN returns null (finite gate)');
    assert.strictEqual(gotStr, null, 'revisionLimit that coerces to NaN returns null (finite gate, F2 coercion)');
    // catches: dropped `!Number.isFinite(revisionLimit)` guard (NaN would flow into Math.min -> NaN result)
    ok('limit_nan: NaN / non-numeric revisionLimit returns null');
  }

  // ============================================================================================
  // 4. limit_undefined - an UNKNOWN platform cap fails closed to the coarse ladder: rules absent, and
  //    rules present but revisionLimit undefined, both -> null.
  // ============================================================================================
  {
    // Act
    const gotNoRules = engAuto._deriveRungCount(BAND, null, ALLOW);
    const gotNoLimit = engAuto._deriveRungCount(BAND, { minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(gotNoRules, null, 'missing rules (null) returns null (unknown cap fails closed)');
    assert.strictEqual(gotNoLimit, null, 'rules present but revisionLimit undefined returns null');
    // catches: null/undefined gate dropped; truthy collapse that treats an absent cap as usable
    ok('limit_undefined: missing rules / undefined revisionLimit returns null');
  }

  // ============================================================================================
  // 5. limit_infinity - Infinity is not finite -> null. This is the FINITE gate, distinct from both the
  //    > 3 gate and the 40-belt: Infinity must be refused up front, never clamped to 40.
  // ============================================================================================
  {
    // Act
    const got = engAuto._deriveRungCount(BAND, { revisionLimit: Infinity, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, null, 'revisionLimit Infinity returns null (finite gate, not the runaway belt)');
    // catches: dropped Number.isFinite finite gate (Infinity would fall through to min(Inf,Inf,40,17)=17)
    ok('limit_infinity: Infinity revisionLimit returns null');
  }

  // ============================================================================================
  // 6. limit_zero_negative - 0 and -5 are both <= 3 -> null (below the low-cap threshold).
  // ============================================================================================
  {
    // Act
    const gotZero = engAuto._deriveRungCount(BAND, { revisionLimit: 0, minDecrement: 100 }, ALLOW);
    const gotNeg = engAuto._deriveRungCount(BAND, { revisionLimit: -5, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(gotZero, null, 'revisionLimit 0 returns null (<= threshold)');
    assert.strictEqual(gotNeg, null, 'revisionLimit -5 returns null (<= threshold)');
    // catches: sign flip / comparator direction on the low-cap gate
    ok('limit_zero_negative: 0 and -5 return null');
  }

  // ============================================================================================
  // 7. soft_off - THE reversibility gate. A non-allowlisted shipper (soft strategy 'off') with a
  //    generous cap stays coarse (null); flipping ONLY the shipper name to an allowlisted one makes the
  //    SAME band+cap active (17). Master-gate-off also resolves 'off' even for an allowlisted shipper.
  // ============================================================================================
  {
    // Arrange
    const rules = { revisionLimit: 30, minDecrement: 100 };
    // Act
    const gotDeny = engAuto._deriveRungCount(BAND, rules, DENY);
    // Assert
    assert.strictEqual(gotDeny, null, 'non-allowlisted shipper (soft strategy off) returns null (reversibility)');
    // Contrast: only the allowlist differs, and it flips the result on -> proves the gate is load-bearing.
    const gotAllow = engAuto._deriveRungCount(BAND, rules, ALLOW);
    assert.strictEqual(gotAllow, 17, 'the same band+cap for an allowlisted shipper derives 17 (headroom binds)');
    // Master gate off => off even for an allowlisted shipper.
    const engMasterOff = mkEngine({ enabled: false, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const gotMasterOff = engMasterOff._deriveRungCount(BAND, rules, ALLOW);
    assert.strictEqual(gotMasterOff, null, 'soft-close master gate off returns null even for an allowlisted shipper');
    // catches: dropped `_resolveSoftStrategy(...) === 'off'` gate (a non-opted-in load would derive 17)
    ok('soft_off: soft strategy off returns null; allowlisted contrast is active (the reversibility gate)');
  }

  // ============================================================================================
  // 8. non_band_arm - the rate model has no margin anchors to interpolate between, so a single-price arm
  //    (and any cost-without-array-margins shape) returns null even with an otherwise-active cap+shipper.
  // ============================================================================================
  {
    // Arrange
    const rules = { revisionLimit: 30, minDecrement: 100 };
    // Act
    const gotRate = engAuto._deriveRungCount({ marketRate: 50_000, costFloor: 40_000 }, rules, ALLOW);
    const gotNoMargins = engAuto._deriveRungCount({ cost: 20_000 }, rules, ALLOW);
    const gotMarginsNotArray = engAuto._deriveRungCount({ cost: 20_000, marginsPct: null }, rules, ALLOW);
    // Assert
    assert.strictEqual(gotRate, null, 'rate-model (single-price) arm returns null (no margin band)');
    assert.strictEqual(gotNoMargins, null, 'band arm missing marginsPct returns null');
    assert.strictEqual(gotMarginsNotArray, null, 'marginsPct that is not an array returns null');
    // catches: dropped arm-type guard / removed Array.isArray(marginsPct) check
    ok('non_band_arm: rate model / missing / non-array marginsPct returns null');
  }

  // ============================================================================================
  // 9. cap_knob_zero_is_auto - rungCap 0 must mean AUTO (Infinity), never a literal 0 clamped into the
  //    min. WIDE + cap 30: min(30, Inf, 40, 45) = 30 (the platform cap binds).
  // ============================================================================================
  {
    // Act
    const got = engAuto._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, 30, 'rungCap 0 is auto (Infinity): the platform cap 30 binds, not a 0-clamp');
    assertInvariant(got, 'cap_knob_zero_is_auto');
    // catches: 0-clamp mutant - feeding cfg.rungCap (0) into Math.min would force max(3,0)=3
    ok('cap_knob_zero_is_auto: rungCap 0 -> 30 (auto knob, not a 0-clamp)');
  }

  // ============================================================================================
  // 10. cap_knob_negative - a negative rungCap is treated as auto; only > 0 engages the operator lever.
  // ============================================================================================
  {
    // Arrange
    const engNeg = mkEngine(SOFT_ON, { rungCap: -1 });
    // Act
    const got = engNeg._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, 30, 'rungCap -1 is treated as auto -> 30 (only a positive cap engages)');
    assertInvariant(got, 'cap_knob_negative');
    // catches: comparator `> 0` -> `>= 0` / `!= 0` (would engage -1: min(30,-1,...) -> max(3,-1)=3)
    ok('cap_knob_negative: rungCap -1 treated as auto -> 30');
  }

  // ============================================================================================
  // 11. cap_knob_nan - a NaN rungCap is auto with NO NaN poisoning of Math.min (Number.isFinite guard).
  // ============================================================================================
  {
    // Arrange
    const engNan = mkEngine(SOFT_ON, { rungCap: NaN });
    // Act
    const got = engNan._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, 30, 'rungCap NaN is treated as auto -> 30');
    assertInvariant(got, 'cap_knob_nan'); // Number.isInteger(NaN) is false -> catches a NaN leak
    // catches: branch-swapped / dropped Number.isFinite(cfg.rungCap) guard leaking NaN into Math.min
    ok('cap_knob_nan: rungCap NaN treated as auto -> 30 (no NaN poisoning)');
  }

  // ============================================================================================
  // 12. runaway_belt - an absurd cap (100) with a wide band whose headroom (45) also exceeds the belt:
  //     min(100, Inf, 40, 45) = 40. RUNG_RUNAWAY_MAX is the ONLY term that yields 40 here.
  // ============================================================================================
  {
    // Act
    const got = engAuto._deriveRungCount(WIDE, { revisionLimit: 100, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, 40, 'revisionLimit 100 + wide band clamps to RUNG_RUNAWAY_MAX (40)');
    assertInvariant(got, 'runaway_belt');
    // catches: RUNG_RUNAWAY_MAX constant tweaked (40 -> 41) or dropped from Math.min (would give 45)
    ok('runaway_belt: huge cap clamps to 40 (RUNG_RUNAWAY_MAX belt binds)');
  }

  // ============================================================================================
  // 13. headroom_exact_boundary - BAND headroom = floor(1600/100)+1 = 17; set the cap to exactly 17 (a
  //     tie). min(17, Inf, 40, 17) = 17. Pins the `+ 1` in decrementHeadroom and the tie in Math.min.
  // ============================================================================================
  {
    // Act
    const got = engAuto._deriveRungCount(BAND, { revisionLimit: 17, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, 17, 'headroom (17) == revisionLimit (17) resolves to 17, no off-by-one');
    assertInvariant(got, 'headroom_exact_boundary');
    // catches: off-by-one in the `+ 1` of decrementHeadroom (drops to 16); a mishandled Math.min tie
    ok('headroom_exact_boundary: headroom == cap == 17 -> 17 (no off-by-one)');
  }

  // ============================================================================================
  // 14. anchor_floor - tiny cap (4) on a NARROW band (headroom 2): min(4,Inf,40,2)=2, floored UP to
  //     anchorCount 3 by Math.max. The direct-return seam is REQUIRED here: this 3 is byte-identical to
  //     the null path's 3-rung ladder, so only the method's own return (3, not null) proves the floor.
  // ============================================================================================
  {
    // Act
    const got = engAuto._deriveRungCount(NARROW, { revisionLimit: 4, minDecrement: 100 }, ALLOW);
    // Assert
    assert.strictEqual(got, 3, 'derived 2 is floored UP to anchorCount 3 (never fewer than the anchors)');
    assertInvariant(got, 'anchor_floor');
    // catches: Math.max(anchorCount, derived) collapsed to `derived` (would return 2, dropping an anchor)
    ok('anchor_floor: derived below anchorCount is floored to anchorCount (3), active not null');
  }

  // ============================================================================================
  // 15. min_dec_zero_or_null - minDecrement 0 (guarded out -> headroom Infinity) and null (falls back to
  //     the caps default 100 -> headroom 45). Neither leaks Infinity or the belt: both bind on cap 30.
  // ============================================================================================
  {
    // Act
    const gotZero = engAuto._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: 0 }, ALLOW);
    const gotNull = engAuto._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: null }, ALLOW);
    // Assert
    assert.strictEqual(gotZero, 30, 'minDecrement 0 drops the headroom term (Infinity) -> cap 30 binds, finite');
    assert.strictEqual(gotNull, 30, 'minDecrement null falls back to caps default 100 -> min(30,Inf,40,45)=30');
    assertInvariant(gotZero, 'min_dec_zero'); // Number.isInteger rejects an Infinity leak
    assertInvariant(gotNull, 'min_dec_null');
    // catches: minDec<=0 guard dropped (headroom = floor(span/0)+1 leaking) or the caps-default fallback swapped
    ok('min_dec_zero_or_null: minDec 0 / null -> 30, finite and <= 40 (no Infinity/belt leak)');
  }

  // ============================================================================================
  // 16. min_dec_nan - minDecrement NaN: the finite guard drops headroom to Infinity (never divide by
  //     NaN), so the cap 30 binds. Result is finite, never NaN.
  // ============================================================================================
  {
    // Act
    const got = engAuto._deriveRungCount(WIDE, { revisionLimit: 30, minDecrement: NaN }, ALLOW);
    // Assert
    assert.strictEqual(got, 30, 'minDecrement NaN -> headroom Infinity -> cap 30 binds (never NaN)');
    assertInvariant(got, 'min_dec_nan'); // Number.isInteger(NaN) is false -> catches the poisoning
    // catches: dropped Number.isFinite(minDec) guard -> floor(span/NaN)+1 = NaN poisons Math.min -> NaN
    ok('min_dec_nan: minDecrement NaN -> 30, finite (no NaN poisoning)');
  }

  cleanup();
  console.log(`\n${pass}/16 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
