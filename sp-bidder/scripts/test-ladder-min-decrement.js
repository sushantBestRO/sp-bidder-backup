'use strict';
/**
 * LADDER RUNG SPACING vs THE PLATFORM'S MINIMUM BID DIFFERENCE.
 *
 * The defect, on a real load (SuperProcure 24966289): the desk typed cost 38,000 on a
 * [14, 11.5, 10.3] band and the engine armed three prices, of which one could never be sent - the
 * step from 43,320 to 42,370 is 950, under that load's 1,000 minimum bid difference. The guard in
 * _maybeBid refused it correctly and refused it with a bare `return`, so the rung never bid, nothing
 * was logged, nothing was recorded, and because it was never banked it was re-selected and
 * re-discarded on every 200ms tick for the rest of the auction. The load lost at rank 4 with no
 * trace anywhere that it had run on two prices instead of three.
 *
 * The arithmetic the old code never performed: 43,320 - 41,914 = 1,406 of span, and three rungs need
 * 2 x 1,000. THREE PRICES WERE NEVER POSSIBLE on that load. No snapping fixes that; only the desk
 * widening its prices, or an honest two-attempt plan, does.
 *
 * What is pinned here, in the order the failure travels:
 *   1. the defect itself, so a regression fails HERE rather than on live money;
 *   2. deriveSpacedLadder - the two anchors never move, no derived rung can breach the operating
 *      price, and a ladder that already clears its minimum comes back byte-identical;
 *   3. per-TRUCK-TYPE loads, where each rung is scaled onto each type's own rate before it is sent
 *      and the portal measures its minimum on THOSE amounts - a blended ladder that clears the
 *      minimum can still put two refused amounts on the cheaper line;
 *   4. the plan is deterministic across a re-price and a restart, or remapFiredRungs (which matches
 *      by PRICE) loses every fired rung and the bot re-establishes above its own standing bid;
 *   5. the runtime guard can no longer be silent - one alert, one durable record, one entry in
 *      unfireableRungs, and nothing further for the rest of the auction.
 *
 *   node scripts/test-ladder-min-decrement.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { buildBandLadder, interpolateBandLadder, decrementViolations, deriveSpacedLadder,
  fittingRungs, scaleLadderByType, perTypeMinDecrement } = require('../src/engine/pricing');
const { resolvePerTypePrices } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidLogger } = require('../src/logging/bidLogger');
const { createStore } = require('../src/store');
const { ladderNotice, ladderCaveat, ladderShortfall } = require('../src/pricing/ladderNotice');

// Completion sentinel - run-tests.js grades by EXIT CODE alone, so a file that exits 0 after running
// nothing reads as a pass.
const EXPECTED = 34;
let passed = 0;
process.on('exit', () => {
  if (passed !== EXPECTED) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${passed} of ${EXPECTED} cases - this file exited `
      + 'early, or cases were added/removed without updating EXPECTED. This run is NOT a pass.');
    process.exitCode = 1;
  }
});
const ok = (n) => { passed++; console.log('  ok  ' + n); };

const tmp = (tag) => path.join(os.tmpdir(), `ladder-mindec-${tag}-${process.pid}.json`);
const rm = (f) => { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } };

// The T4 load, verbatim.
const T4 = { cost: 38_000, marginsPct: [14, 11.5, 10.3], minMarginPct: 10.3 };
const T4_MINDEC = 1000;

/**
 * Function source with comments removed, for the checks that assert what the CODE reads. This file
 * is safety commentary as much as it is code, and the comments name the very fields the code is
 * forbidden to touch - so scanning raw source would match the prose warning against a thing rather
 * than the thing.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every adjacent gap, the step INTO the last rung included - the platform's own view. */
function everyGapClears(ladder, minDec) {
  for (let i = 1; i < ladder.length; i++) if (ladder[i - 1] - ladder[i] < minDec) return false;
  return true;
}

const planEngine = (caps = {}, opts = {}) => {
  const adapter = {
    capabilities: () => Object.assign({ standingPriceVisible: false, minDecrement: 100,
      revisionLimit: 3, closeModel: 'hard' }, caps),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: null, totalBidders: 0 }),
    placeBid: async () => { throw new Error('placeBid must be unreachable in this test'); },
    writeEnabled: true,
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp(`plan-${Math.random()}`)), opts);
  eng._schedule = () => {};
  eng._planWake = () => {};
  return eng;
};

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. THE DEFECT, pinned first. If this block ever stops failing to clear the minimum, the fixture
  //    has drifted and everything below is testing a different load.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder(T4);
    assert.deepStrictEqual(band.ladder, [43_320, 42_370, 41_914], 'the T4 band is the ladder the live builder produces');
    const v = decrementViolations(band.ladder, T4_MINDEC);
    assert.strictEqual(v.length, 1, 'exactly one non-floor step is under the minimum');
    assert.deepStrictEqual(v[0], { fromIndex: 0, toIndex: 1, fromPrice: 43_320, toPrice: 42_370, gap: 950 });
    assert.ok(!everyGapClears(band.ladder, T4_MINDEC), 'the raw band cannot send all three prices');
    // The capacity arithmetic the old code never performed.
    assert.strictEqual(band.ladder[0] - band.ladder[2], 1_406, 'the whole band spans 1,406');
    assert.ok(1_406 < 2 * T4_MINDEC, 'three rungs need 2,000 of span, so three prices were never possible');
    ok('RED: the T4 band arms a rung the platform would refuse, and three prices never fit at all');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. THE DERIVATION on that same load.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder(T4);
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: T4_MINDEC });
    assert.deepStrictEqual(d.ladder, [43_320, 41_914], 'the unfittable middle rung is dropped');
    assert.strictEqual(d.requested, 3);
    assert.strictEqual(d.fits, 2);
    assert.deepStrictEqual(d.dropped, [{ index: 1, price: 42_370, reason: 'no_legal_slot' }]);
    assert.deepStrictEqual(d.moved, []);
    assert.deepStrictEqual(decrementViolations(d.ladder, T4_MINDEC), [], 'the existing detector is satisfied');
    // The strict check the existing detector cannot make: it exempts the step into the last rung.
    assert.ok(everyGapClears(d.ladder, T4_MINDEC), 'EVERY step clears the minimum, the last one included');
    assert.strictEqual(d.floor, band.floor, 'the operating floor is untouched');
    ok('GREEN: the T4 ladder derives to two spaced prices, and every step the portal measures clears 1,000');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. THE ANCHOR INVARIANT. The opening is the desk's authorised top margin and the last rung is
  //    the operating price it set; arm() asserts the latter equals plan.floor. Neither may EVER
  //    move, under any input.
  // ---------------------------------------------------------------------------------------------
  {
    const fixtures = [
      { cost: 38_000, marginsPct: [14, 11.5, 10.3], minDec: 1000 },
      { cost: 38_000, marginsPct: [14, 11.5, 8.0], minDec: 1000 },
      { cost: 38_000, marginsPct: [14, 8.2, 8.0], minDec: 500 },
      { cost: 18_000, marginsPct: [12.6, 7.2, 2.7], minDec: 100 },
      { cost: 18_000, marginsPct: [12.6, 10, 7.2, 2.7], minDec: 1500 },
      { cost: 10_000, marginsPct: [12.6, 12.5, 6.3], minDec: 100 },
      { cost: 2_240, marginsPct: [12.6, 7.2, 6.3], minDec: 100 },
      { cost: 60_000, marginsPct: [12.6, 7.2, 2.7], minDec: 100_000 }, // a minimum wider than the whole band
    ];
    for (const f of fixtures) {
      const band = buildBandLadder({ cost: f.cost, marginsPct: f.marginsPct, minMarginPct: f.marginsPct[f.marginsPct.length - 1] });
      const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: f.minDec });
      const tag = `cost ${f.cost} / ${f.marginsPct.join('-')} / minDec ${f.minDec}`;
      assert.strictEqual(d.ladder[0], band.ladder[0], `${tag}: the opening never moves`);
      assert.strictEqual(d.ladder[d.ladder.length - 1], band.ladder[band.ladder.length - 1],
        `${tag}: the operating price never moves`);
      assert.strictEqual(d.floor, band.floor, `${tag}: the floor is unchanged`);
      for (let i = 1; i < d.ladder.length; i++) {
        assert.ok(d.ladder[i] < d.ladder[i - 1], `${tag}: strictly descending`);
        // Floor-safe by construction: lo >= lastRung + minDecrement, so no derived rung can land at
        // or below the operating price.
        assert.ok(d.ladder[i] >= band.floor, `${tag}: rung ${d.ladder[i]} is at or above the operating price`);
      }
      assert.ok(d.ladder.length >= 2, `${tag}: both anchors survive`);
    }
    ok('the opening and the operating price survive every fixture, and no derived rung breaches the floor');
  }

  // ---------------------------------------------------------------------------------------------
  // 4. SNAP DOWN - the ordinary case, and the competitive direction in a reverse auction.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder({ cost: 38_000, marginsPct: [14, 11.5, 8.0], minMarginPct: 8.0 });
    assert.deepStrictEqual(band.ladder, [43_320, 42_370, 41_040], 'fixture band');
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: 1000 });
    assert.deepStrictEqual(d.ladder, [43_320, 42_320, 41_040], 'the middle rung drops to the latest legal price');
    assert.strictEqual(d.ladder.length, 3, 'the rung COUNT is preserved - the desk keeps all three attempts');
    assert.deepStrictEqual(d.moved, [{ index: 1, from: 42_370, to: 42_320, gapBefore: 950 }]);
    assert.ok(everyGapClears(d.ladder, 1000));
    assert.strictEqual(d.fits, 3);
    ok('snap DOWN: a middle rung moves to the latest legal price and all three attempts survive');
  }

  // ---------------------------------------------------------------------------------------------
  // 5. SNAP UP - fires only when a desk price sits so close above the operating price that keeping
  //    it there would strand the rungs below it. Bounded by hi, so it can never rise above its
  //    predecessor and never above the opening.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder({ cost: 38_000, marginsPct: [14, 8.2, 8.0], minMarginPct: 8.0 });
    assert.deepStrictEqual(band.ladder, [43_320, 41_116, 41_040], 'fixture band: the middle sits 76 above the last rung');
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: 500 });
    assert.deepStrictEqual(d.ladder, [43_320, 41_540, 41_040], 'the middle rung is raised just clear of the operating price');
    assert.strictEqual(d.ladder.length, 3, 'the rung count is preserved');
    assert.ok(d.ladder[1] <= band.ladder[0] - 500, 'a raised rung never comes within the minimum of the opening');
    assert.ok(d.ladder[1] < d.ladder[0], 'and never at or above the opening itself');
    assert.ok(everyGapClears(d.ladder, 500));
    ok('snap UP: a rung stranding the ones below it is raised, bounded by the opening minus the minimum');
  }

  // ---------------------------------------------------------------------------------------------
  // 6. THE NO-OP GUARANTEE. This is what the deploy safety argument rests on: a ladder with no
  //    violation comes back byte-identical, so an armed load rehydrates onto the same prices and
  //    remapFiredRungs matches index-for-index through its equality fast path.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder({ cost: 60_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: 100 });
    assert.deepStrictEqual(d.ladder, band.ladder, 'the live band at a wide cost is byte-identical');
    assert.strictEqual(d.applied, false, 'and reports that it changed nothing');
    assert.deepStrictEqual(d.dropped, []);
    assert.deepStrictEqual(d.moved, []);

    // The interpolated (fine-ladder) path is protected by the same guarantee.
    const fine = interpolateBandLadder({ cost: 60_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7,
      rungs: 12, minDecrement: 100 });
    const dFine = deriveSpacedLadder({ ladder: fine.ladder, floor: fine.floor, minDecrement: 100 });
    assert.deepStrictEqual(dFine.ladder, fine.ladder, 'an interpolated ladder that already clears its minimum is untouched');
    assert.strictEqual(dFine.applied, false);

    // A decrement the engine cannot act on is not a constraint to reshape prices around - the same
    // predicate decrementViolations uses, so the derivation can never move a price on a load where
    // the guard would never have fired.
    for (const bad of [null, undefined, 0, -100, NaN, '1500']) {
      const dBad = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: bad });
      assert.deepStrictEqual(dBad.ladder, band.ladder, `minDecrement ${String(bad)} -> untouched`);
      assert.strictEqual(dBad.applied, false);
    }
    ok('NO-OP: a clean ladder, a clean interpolated ladder, and an unusable minimum all return byte-identical');
  }

  // ---------------------------------------------------------------------------------------------
  // 7. THE FIT COUNT - how many prices actually reach the board. Skipping a rung only ever WIDENS
  //    the gap the engine measures against its own last bid, so a ladder with one tight middle
  //    degrades to two prices rather than to one.
  // ---------------------------------------------------------------------------------------------
  {
    assert.deepStrictEqual(fittingRungs([43_320, 42_370, 41_914], 1000), [43_320, 41_914],
      'the raw T4 band would have sent two prices, not three - the silent degradation, measured');
    assert.deepStrictEqual(fittingRungs([43_320, 41_914], 1000), [43_320, 41_914]);
    assert.deepStrictEqual(fittingRungs([43_320, 41_914], 2000), [43_320],
      'a span narrower than one minimum can send only the opening');
    assert.deepStrictEqual(fittingRungs([43_320, 41_914], null), [43_320, 41_914],
      'an unknown minimum constrains nothing');
    ok('the fit count walks from the last REACHABLE rung, so one tight step costs one price and not the rest');
  }

  // ---------------------------------------------------------------------------------------------
  // 8. PER-TRUCK-TYPE SCALING mirrors the adapter EXACTLY. pricing/ sits under the platform seam and
  //    cannot import an adapter, so the formula is duplicated - and a duplicate that drifts is worse
  //    than no check at all. Run one fixture through both and compare.
  // ---------------------------------------------------------------------------------------------
  {
    const spec = { cost: 60_000, types: [
      { index: 0, label: '40 ft', match: '40ft', count: 1, cost: 100_000 },
      { index: 1, label: '20 ft', match: '20ft', count: 1, cost: 20_000 },
    ] };
    const pricedLines = [
      { key: 'freight_charges_custom_charge_40ft', units: 1 },
      { key: 'freight_charges_custom_charge_20ft', units: 1 },
    ];
    const ladder = [67_560, 67_260, 66_000];
    const mine = scaleLadderByType(ladder, spec);
    for (let i = 0; i < ladder.length; i++) {
      const theirs = resolvePerTypePrices(spec, pricedLines, ladder[i], 66_000, 'E1');
      const byLabel = new Map([...theirs.values()].map((v) => [v.label, v.price]));
      for (const t of mine) {
        assert.strictEqual(t.amounts[i], byLabel.get(t.label),
          `rung ${ladder[i]} on "${t.label}": pricing says ${t.amounts[i]}, the adapter says ${byLabel.get(t.label)}`);
      }
    }
    assert.strictEqual(scaleLadderByType(ladder, null), null, 'one blended rate is the uniform path');
    assert.strictEqual(scaleLadderByType(ladder, { cost: 0, types: spec.types }), null,
      'an unusable vector is refused loudly at bid time, so it is never given invented spacing here');
    ok('the per-type scaling in pricing/ produces the same amounts as the adapter that actually sends them');
  }

  // ---------------------------------------------------------------------------------------------
  // 9. THE PER-TYPE DEFECT the blended check cannot see: every blended gap clears the minimum, and
  //    the cheaper truck type still gets two amounts the portal would refuse.
  // ---------------------------------------------------------------------------------------------
  {
    const spec = { cost: 60_000, types: [
      { index: 0, label: '40 ft', match: '40ft', count: 1, cost: 100_000 },
      { index: 1, label: '20 ft', match: '20ft', count: 1, cost: 20_000 },
    ] };
    const band = buildBandLadder({ cost: 60_000, marginsPct: [12.6, 12.35, 12.0], minMarginPct: 12.0 });
    assert.deepStrictEqual(band.ladder, [67_560, 67_410, 67_200], 'fixture band');

    // Blended-only: every gap clears 100, so a blended check reports a healthy three-price plan.
    assert.ok(everyGapClears(band.ladder, 100), 'the BLENDED ladder clears the minimum on every step');
    const blendedOnly = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: 100 });
    assert.deepStrictEqual(blendedOnly.ladder, band.ladder, 'a blended-only derivation changes nothing');
    assert.strictEqual(blendedOnly.fits, 3, 'and would claim three attempts');

    // What actually goes on the wire for the cheap type refuses two of them.
    const scaled = scaleLadderByType(band.ladder, spec);
    const cheap = scaled.find((s) => s.label === '20 ft');
    assert.deepStrictEqual(cheap.amounts, [22_520, 22_470, 22_400], 'the 20 ft line is sent these amounts');
    assert.ok(cheap.amounts[0] - cheap.amounts[1] < 100, 'and its first step is only 50 - the portal would refuse it');
    assert.deepStrictEqual(fittingRungs(band.ladder, 100, scaled), [67_560, 67_200],
      'so only two of the three rungs can actually be sent on every line');

    // The per-type-aware requirement, expressed in the space the ladder is built in.
    const need = perTypeMinDecrement(100, spec);
    assert.strictEqual(need, 300, 'the blended ladder must be spaced by 300 for a 100 minimum to hold on the 20 ft line');
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: need });
    assert.deepStrictEqual(d.ladder, [67_560, 67_200], 'the rung that cannot be sent on every line is dropped');
    const dScaled = scaleLadderByType(d.ladder, spec);
    for (const t of dScaled) assert.ok(everyGapClears(t.amounts, 100), `"${t.label}" clears the minimum on every step`);
    assert.strictEqual(fittingRungs(d.ladder, 100, dScaled).length, 2, 'and the honest attempt count is two');
    ok('PER-TYPE: a blended ladder that clears the minimum still refuses two amounts on the cheaper line, and the derivation catches it');
  }

  {
    // perTypeMinDecrement must never LOOSEN the requirement, and must fall back to the uniform rule
    // rather than invent one from a vector it cannot use.
    const one = { cost: 60_000, types: [{ label: 'A', cost: 60_000, count: 1 }] };
    assert.strictEqual(perTypeMinDecrement(100, one), 100, 'a single type is the uniform path');
    assert.strictEqual(perTypeMinDecrement(100, null), 100);
    assert.strictEqual(perTypeMinDecrement(100, { cost: 60_000, types: [{ label: 'A', cost: 60_000 }, { label: 'B', cost: 0 }] }), 100,
      'an unusable type cost falls back to the uniform rule rather than to a fabricated one');
    const dear = { cost: 60_000, types: [{ label: 'A', cost: 100_000 }, { label: 'B', cost: 90_000 }] };
    assert.ok(perTypeMinDecrement(100, dear) >= 100, 'types priced ABOVE the blend never relax the requirement below the platform minimum');
    ok('the per-type requirement only ever tightens, and an unusable vector falls back to the platform minimum');
  }

  // ---------------------------------------------------------------------------------------------
  // 10. THE ARMED PLAN. The whole point: what arm() builds contains no rung the runtime guard would
  //     discard, and the page is told how many attempts the load really has.
  // ---------------------------------------------------------------------------------------------
  {
    const eng = planEngine();
    const rules = { minDecrement: T4_MINDEC, revisionLimit: 3 };
    const { plan } = eng._planFor(T4, rules, 'Havells');
    assert.deepStrictEqual(plan.ladder, [43_320, 41_914], 'arm builds the derived ladder');
    assert.ok(everyGapClears(plan.ladder, T4_MINDEC), 'no armed rung is one the guard would discard');
    assert.strictEqual(plan.rungsRequested, 3);
    assert.strictEqual(plan.rungsFitting, 2);
    assert.strictEqual(plan.minDecrement, T4_MINDEC);
    assert.strictEqual(plan.floor, 41_914, 'the operating price is still the last rung');

    // planPreview runs the same _planFor, which is why the page cannot drift from the arm.
    const pv = eng.planPreview({ id: '24966289', rules, companyName: 'Havells' }, T4);
    assert.deepStrictEqual(pv.ladder, plan.ladder, 'the page shows exactly what the arm will build');
    assert.strictEqual(pv.rungsRequested, 3);
    assert.strictEqual(pv.rungsFitting, 2);
    assert.deepStrictEqual(pv.fittingPrices, [43_320, 41_914]);
    ok('the armed plan carries no discardable rung, and the preview reports two attempts of a requested three');
  }

  // ---------------------------------------------------------------------------------------------
  // 11. THE PAGE COPY. This is the half that turns a silent runtime degradation into something the
  //     desk can act on while acting is still cheap, so the words are pinned, not just the numbers.
  //
  //     The shortfall is a HALF-FAILURE and reads as one: two short lines and a corrective figure,
  //     not a paragraph. The owner rejected the paragraph form on 2026-09-10 - it was neutral,
  //     seven lines long, and buried in a panel the desk had to open - so the shape here is the
  //     product requirement, not a style preference, and the test is what keeps it from drifting
  //     back into prose.
  // ---------------------------------------------------------------------------------------------
  {
    const eng = planEngine();
    // Ruling 67: the corrective is offered only at or above the minimum-margin guard, so the band
    // carries minimum 6.3 (guard Rs 40,394) and the Rs 41,320 corrective is a legitimate one.
    const pv = eng.planPreview({ id: '24966289', rules: { minDecrement: T4_MINDEC, revisionLimit: 3 }, companyName: 'Havells' },
      { ...T4, minMarginPct: 6.3 });
    const sh = ladderShortfall(pv);
    assert.strictEqual(sh.fact, 'Only 2 of your 3 prices can be sent - this customer needs Rs 1,000 between bids.');
    assert.strictEqual(sh.action, 'Set your last price at Rs 41,320 or less to send all three.');
    assert.strictEqual(sh.costTarget, 41_320, 'the button and the sentence name one number');
    // The corrective target is the arithmetic that makes this bucket 1 rather than an FYI.
    assert.strictEqual(43_320 - 2 * T4_MINDEC, 41_320, 'the target restores the third attempt');
    // ONE LINE EACH. A second sentence in either field is the paragraph growing back.
    for (const line of [sh.fact, sh.action]) {
      assert.ok(line.length <= 100, `"${line}" must stay a single readable line`);
      assert.strictEqual(line.replace(/\.$/, '').indexOf('. '), -1, `"${line}" must be one sentence`);
    }
    // The send list belongs beside the prices, not in a block read on the way to Submit.
    assert.ok(!/We will send/.test(sh.fact + sh.action), 'the shortfall block does not re-list the prices');
    // Internal vocabulary must never reach the desk.
    for (const banned of [/\bband\b/i, /\bfloor\b/i, /your lowest price/i, /—/]) {
      assert.ok(!banned.test(sh.fact + sh.action), `the shortfall must not contain ${banned}`);
    }
    // A shortfall owns the state outright: the neutral line must not tell a second story beside it.
    assert.strictEqual(ladderNotice(pv), null, 'a shortfall silences the moved-price notice');
    ok('the shortfall states the loss in one line and the corrective number in one more');
  }

  {
    // The block disappears the moment it stops being true - there is no shortfall to report when
    // every price the desk typed reaches the board.
    const eng = planEngine();
    const clean = eng.planPreview({ id: 'C2', rules: { minDecrement: 100, revisionLimit: 3 }, companyName: 'Havells' },
      { cost: 60_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.strictEqual(clean.rungsFitting, clean.rungsRequested);
    assert.strictEqual(ladderShortfall(clean), null, 'an intact plan raises no shortfall');
    // Same suppression the notice has, and for the same reason: the count is the engine's, not the
    // desk's, so no sentence may name it.
    assert.strictEqual(ladderShortfall({ ladder: [43_320, 41_914], fittingPrices: [43_320], rungsRequested: 10,
      rungsFitting: 1, minDecrement: 1000, spacingMinDecrement: 1000, countsAreDeskFacing: false }), null,
    'no shortfall sentence when the count is not the desk\'s own');
    ok('an intact plan and a fine ladder both raise no shortfall block at all');
  }

  {
    // Down to ONE attempt, and the target that restores all of them sits below cost. Two is still
    // worth having on a snipe, so the fallback offers a second price rather than giving up the
    // one-tap lever entirely.
    const sh = ladderShortfall({ ladder: [43_320, 41_914], fittingPrices: [43_320], rungsRequested: 3,
      rungsFitting: 1, minDecrement: 4_000, spacingMinDecrement: 4_000, countsAreDeskFacing: true,
      trueCost: 38_000 });
    assert.strictEqual(sh.fact, 'Only 1 of your 3 prices can be sent - this customer needs Rs 4,000 between bids.');
    assert.strictEqual(sh.action, 'Set your last price at Rs 39,320 or less to send a second price.');
    assert.strictEqual(sh.costTarget, 39_320);
    assert.ok(sh.costTarget > 38_000, 'and the fallback target is still above the desk cost');

    // Both targets below cost: no number to put on a button, so only the other lever is offered.
    const none = ladderShortfall({ ladder: [43_320, 41_914], fittingPrices: [43_320], rungsRequested: 3,
      rungsFitting: 1, minDecrement: 40_000, spacingMinDecrement: 40_000, countsAreDeskFacing: true,
      trueCost: 38_000 });
    assert.strictEqual(none.action, 'Move your prices further apart to send all three.');
    assert.strictEqual(none.costTarget, null, 'no button figure when every target sits below cost');
    assert.ok(!/set your last price/i.test(none.action), 'and no price below the desk cost is ever suggested');
    ok('a target below cost degrades to a second attempt, then to the spread lever, never to a loss');
  }

  {
    // A moved price keeps all the attempts, so the desk is told what moved rather than what was lost.
    const eng = planEngine();
    const pv = eng.planPreview({ id: 'M1', rules: { minDecrement: 1000, revisionLimit: 3 }, companyName: 'Havells' },
      { cost: 38_000, marginsPct: [14, 11.5, 8.0], minMarginPct: 8.0 });
    assert.strictEqual(pv.rungsFitting, 3);
    assert.strictEqual(ladderNotice(pv),
      'Your middle price will go out at Rs 42,320 instead of Rs 42,370. This customer needs each new bid to be '
      + 'at least Rs 1,000 below the one before it, and Rs 42,370 is only Rs 950 below your first price. '
      + 'Your first and last prices are unchanged.');

    // And a plan that does exactly what the desk typed says nothing at all.
    const clean = eng.planPreview({ id: 'C1', rules: { minDecrement: 100, revisionLimit: 3 }, companyName: 'Havells' },
      { cost: 60_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.strictEqual(ladderNotice(clean), null, 'an intact plan raises no notice');
    ok('a moved price is named on the page, and an intact plan stays silent');
  }

  {
    // The portal never published this load's minimum: say so rather than present the fallback as fact.
    // It is a CAVEAT, not a notice - a missing fact, not a changed plan - because the page replaces
    // the price line with a notice and appends a caveat under it. Returning this as a notice hid the
    // desk's own prices on every keystroke for every load whose minimum is unknown.
    const base = { ladder: [43_320, 41_914], fittingPrices: [43_320, 41_914], rungsRequested: 2,
      rungsFitting: 2, minDecrement: 1000, spacingMinDecrement: 1000, rungsMoved: [],
      countsAreDeskFacing: true, minDecrementUnknown: true };
    assert.strictEqual(ladderNotice(base), null, 'an unchanged plan raises NO notice, so the ladder still renders');
    assert.strictEqual(ladderCaveat(base),
      "We do not have this customer's minimum gap between bids for this load yet, so we are planning on Rs 1,000. "
      + 'If the real gap turns out to be wider, one of your prices may not go out.');
    // The ratified copy ends "You will be told on the close message if that happens." Nothing reads
    // skippedRungs[] onto a close message yet, and a promise the code does not keep is worse on a
    // money page than no promise. This assertion is the reminder to restore the sentence in the same
    // change that implements the receipt.
    assert.ok(!/close message/.test(ladderCaveat(base)), 'and promises no channel that does not exist yet');
    assert.strictEqual(ladderCaveat({ minDecrementUnknown: false, minDecrement: 1000 }), null,
      'a known minimum raises no caveat at all');
    ok('an unknown minimum is a caveat under the prices, not a notice that replaces them');
  }

  {
    // THE ROUTING RULE, asserted on its own: a lost price is the amber block's story and the neutral
    // line stays out of it, even when the derivation also moved a rung. Two descriptions of one plan
    // in two places is the paragraph this split exists to break up.
    const both = { ladder: [43_320, 41_914], fittingPrices: [43_320], rungsRequested: 3,
      rungsFitting: 1, minDecrement: 40_000, spacingMinDecrement: 40_000,
      rungsMoved: [{ index: 1, from: 42_370, to: 42_320, gapBefore: 950 }],
      countsAreDeskFacing: true, trueCost: 38_000 };
    assert.strictEqual(ladderNotice(both), null, 'a shortfall silences the notice even with a moved rung');
    assert.ok(ladderShortfall(both), 'and the shortfall block carries the state instead');
    ok('a lost price routes to the amber block alone, never to both surfaces at once');
  }

  {
    // A count taken off an ENGINE-built fine ladder is not "your N prices" - the desk sees its own
    // margin rows and never typed that number, so the sentence is suppressed rather than guessed.
    const notice = ladderNotice({ ladder: [43_320, 41_914], fittingPrices: [43_320], rungsRequested: 10,
      rungsFitting: 1, minDecrement: 1000, spacingMinDecrement: 1000, rungsMoved: [],
      countsAreDeskFacing: false });
    assert.strictEqual(notice, null, 'no count sentence when the count is not the desk\'s own');
    ok('the interpolated fine-ladder path raises no count sentence, so no desk is told about prices it never typed');
  }

  // ---------------------------------------------------------------------------------------------
  // 12. DETERMINISM. _planFor is re-entered on a re-price, a scheduled wake and a post-restart
  //     rehydrate. If the ladder were a function of a live per-tick value the same intent would
  //     rebuild onto DIFFERENT prices, remapFiredRungs (which matches by price) would find none of
  //     them, and the monitor would believe it had never bid - re-establishing above its own
  //     standing bid on a live auction.
  // ---------------------------------------------------------------------------------------------
  {
    // CODE only. _planFor's comments discuss both of the fields it must not read, by name and at
    // length, so a raw toString() scan would match its own prose and this check would be a
    // tautology that can never fail.
    const src = stripComments(BidEngine.prototype._planFor.toString());
    assert.ok(!/state\.minDecrement/.test(src), '_planFor must never read the live per-tick decrement');
    assert.ok(/rules\.minDecrement/.test(src), '_planFor reads the validated per-load rule');
    // The RAW field off the adapter's load map is uncoerced (it can be a string or junk); only the
    // deriveLoadRules-validated one may reach a price.
    assert.ok(!/load\.minDecrement/.test(src), '_planFor must never read the raw, unvalidated load field');
    ok('_planFor reads the validated per-load minimum and never the live or the raw one');
  }

  {
    const f = tmp('rebuild');
    const eng = planEngine();
    eng.scheduler = new DurableScheduler(f);
    const rules = { minDecrement: T4_MINDEC, revisionLimit: 3 };
    const meta = { id: 'R1', lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells',
      rules, closesAt: Date.now() + 60_000 };
    const a = eng._planFor(T4, rules, 'Havells').plan;
    const b = eng._planFor(T4, rules, 'Havells').plan;
    assert.deepStrictEqual(a.ladder, b.ladder, 'two identical calls build one ladder');

    const m = eng.arm(meta, T4);
    assert.deepStrictEqual(m.ladder, [43_320, 41_914]);
    m.firedRungs.add(0);
    m.currentRungIndex = 0;
    eng.scheduler.update('R1', { firedRungs: [...m.firedRungs], ladder: m.ladder.slice() });

    // The restart path: rebuild the arm inputs from the durable intent, exactly as the boot
    // supervisor does, and re-arm on a fresh engine.
    const eng2 = planEngine();
    eng2.scheduler = eng.scheduler;
    const { meta: reMeta, inputs: reInputs } = eng2._intentToArm(eng.scheduler.get('R1'));
    const m2 = eng2.arm(reMeta, reInputs);
    assert.deepStrictEqual(m2.ladder, m.ladder, 'a rehydrate rebuilds the identical ladder');
    // The remap lands on the durable INTENT (the boot supervisor copies it onto the monitor
    // afterwards), and that is where the property being pinned actually lives: an identical ladder
    // takes remapFiredRungs' equality fast path and carries every spent rung index-for-index. A
    // ladder that rebuilt differently would carry NOTHING, and the monitor would re-establish above
    // its own standing bid on a live auction.
    assert.deepStrictEqual(eng2.scheduler.get('R1').firedRungs, [0],
      'so remapFiredRungs carries the spent rung forward');
    rm(f);
    ok('a re-price and a restart rebuild the identical derived ladder, and the fired rung survives the remap');
  }

  // ---------------------------------------------------------------------------------------------
  // 13. THE RUNTIME GUARD CAN NO LONGER BE SILENT. After the derivation this path is unreachable for
  //     a load armed from a fresh intent, so it is driven here through the case that keeps it
  //     reachable: an intent armed BEFORE the derivation shipped, rehydrated onto its old ladder.
  // ---------------------------------------------------------------------------------------------
  {
    const src = stripComments(BidEngine.prototype._maybeBid.toString());
    // Bounded by the NEXT invariant rather than by assertAboveFloor: the standing-bid hold now sits
    // between the two, and its `return` follows _holdAboveStandingBid - which records a refusal,
    // logs at error level and emits a desk alert. It is routed, not silent. Slicing as far as
    // assertAboveFloor swept that sibling's return into this branch's assertion.
    const endAnchor = src.indexOf('const mustImproveOn');
    const branch = src.slice(src.indexOf('const minDec ='),
      endAnchor !== -1 ? endAnchor : src.indexOf('assertAboveFloor'));
    assert.ok(branch.length > 0, 'the min-decrement branch was located');
    assert.ok(/_recordRungDiscard/.test(branch), 'the branch routes through the recorder');
    assert.ok(!/^\s*return;\s*$/m.test(branch),
      'the min-decrement branch must contain NO bare return - a silent refusal on the post-page path is the defect itself');
    ok('the min-decrement branch in _maybeBid contains no bare return and routes through the recorder');
  }

  {
    const f = tmp('guard');
    const events = [];
    const placed = [];
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        // Rank only after our establish: a rank before it triggers the LOW_CAP discount (3 -> 2), and the
        // rung-1 step would then have 1 revision left, which PR-T5's hard-close floor reserve holds.
        return { ok: true, status: 'live', myRank: placed.length ? 2 : null, totalBidders: 2, standingL1Price: null,
          closesInMs: 30_000, revisionLimit: 3, revisionsLeft: null, minDecrement: 1500,
          closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0 }, rand: () => 0,
        onEvent: (e) => { events.push(e); logger.handle(e); } });
    const m = eng.arm({ id: 'G1', lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName: 'Havells', closesAt: Date.now() + 30_000 },
    { cost: 18_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    // The pre-deploy intent: a ladder whose middle step (972) is under the LIVE 1500 minimum. The
    // capture-time snapshot said 100, so the derivation left it alone - which is exactly the case
    // the runtime guard still has to catch.
    assert.deepStrictEqual(m.ladder, [20_268, 19_296, 18_486], 'armed on the un-derived ladder');

    await eng._tick(m); if (m.timer) clearTimeout(m.timer);   // establish at rung 0
    assert.deepStrictEqual(placed, [20_268], 'the establishing bid lands');
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);   // rung 1 is 972 below - refused

    const discards = () => events.filter((e) => e.type === 'alert' && e.kind === 'rung_discarded_min_decrement');
    assert.strictEqual(discards().length, 1, 'the refusal raises exactly one alert');
    const a = discards()[0];
    assert.strictEqual(a.level, 'warn');
    assert.strictEqual(a.auctionId, 'G1', 'the alert names the load');
    assert.strictEqual(a.rungIndex, 1);
    assert.strictEqual(a.price, 19_296);
    assert.strictEqual(a.lastBidPrice, 20_268);
    assert.strictEqual(a.minDecrement, 1500);
    assert.strictEqual(a.gap, 972);
    assert.ok(a.detail.includes('G1') && /\b972\b/.test(a.detail) && /\b1500\b/.test(a.detail),
      'the detail names the load, the gap and the minimum in plain terms');
    assert.ok(m.unfireableRungs.has(1), 'the rung is banked as unfireable');
    assert.ok(!m.firedRungs.has(1), 'but NOT as spent - a discarded rung was never offered');

    // The durable half. A discarded rung used to be byte-identical in the record to one that was
    // never due; skippedRungs[] is what tells them apart after the fact.
    await logger.handle({ type: 'noop' });
    const rec = await store.getDoc('closedBids', 'G1');
    assert.ok(Array.isArray(rec.skippedRungs) && rec.skippedRungs.length === 1, 'one durable skippedRungs entry');
    assert.strictEqual(rec.skippedRungs[0].price, 19_296);
    assert.strictEqual(rec.skippedRungs[0].rungIndex, 1);
    assert.strictEqual(rec.skippedRungs[0].minDecrement, 1500);
    assert.strictEqual(rec.skippedRungs[0].reason, 'min_decrement');
    const stream = await store.readEvents('bids');
    assert.strictEqual(stream.filter((x) => x.kind === 'rung_discarded').length, 1,
      'and one line on the un-backfillable stream, which survives even when no armed record does');

    // THE LATCH. At the 200ms hot cadence an unlatched emit would bury the ring and train an
    // operator to ignore the kind; an unbanked rung would be re-selected forever.
    for (let i = 0; i < 50; i++) { await eng._tick(m); if (m.timer) clearTimeout(m.timer); }
    assert.strictEqual(discards().length, 1, 'fifty further ticks add no second alert');
    await logger.handle({ type: 'noop' });
    const rec2 = await store.getDoc('closedBids', 'G1');
    assert.strictEqual(rec2.skippedRungs.length, 1, 'and no second durable entry');
    assert.ok(!placed.includes(19_296), 'the refused price never reached the wire');
    eng.kill();
    rm(f);
    ok('a discarded rung emits ONE alert, banks itself unfireable, writes ONE durable record, and stays quiet for 50 ticks');
  }

  {
    // MUTATION CHECK on the property that matters: the discard path cannot be taken without a
    // record. Stub the recorder out and the guard becomes the bare `return` it used to be - so if
    // the branch were ever restored to that shape, this spy would never be called and the count
    // below would be zero.
    const f = tmp('mutate');
    const placed = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        // Same budget reason as G1: no rank before our establish, so the rung-1 step still has 2 revisions.
        return { ok: true, status: 'live', myRank: placed.length ? 2 : null, totalBidders: 2, standingL1Price: null,
          closesInMs: 30_000, revisionLimit: 3, revisionsLeft: null, minDecrement: 1500,
          closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: { openAtMs: 60_000, floorWindowMs: 2_500, minInterFireMs: 0 }, rand: () => 0 });
    const m = eng.arm({ id: 'G2', lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName: 'Havells', closesAt: Date.now() + 30_000 },
    { cost: 18_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    let calls = 0;
    const real = eng._recordRungDiscard.bind(eng);
    eng._recordRungDiscard = (mon, decision, minDec) => { calls++; return real(mon, decision, minDec); };
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    assert.strictEqual(calls, 1, 'every discard goes through the recorder - a bare return would leave this at 0');
    assert.ok(!placed.includes(19_296), 'and the refusal itself still holds');
    eng.kill();
    rm(f);
    ok('MUTATION: the discard path cannot be taken without going through the recorder');
  }

  {
    // The unfireable rung must not be re-selected, and the FLOOR must stay reachable - a guard that
    // suppressed the decisive shot would trade one silent failure for a worse one.
    const f = tmp('select');
    const eng = planEngine();
    eng.scheduler = new DurableScheduler(f);
    const m = eng.arm({ id: 'S1', lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName: 'Havells', closesAt: Date.now() + 30_000 },
    { cost: 18_000, marginsPct: [12.6, 10, 7.2, 2.7], minMarginPct: 2.7 });
    const last = m.ladder.length - 1;
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = m.ladder[0];
    m.unfireableRungs.add(1);
    const excl = eng._selectableExclusions(m);
    assert.ok(excl.has(0) && excl.has(1), 'rung selection sees both the spent and the unfireable rung');
    assert.ok(!excl.has(2) && !excl.has(last), 'and nothing else');
    m.unfireableRungs.clear();
    assert.strictEqual(eng._selectableExclusions(m), m.firedRungs,
      'with nothing discarded the view IS firedRungs, so an untouched monitor behaves byte-identically');
    rm(f);
    ok('an unfireable rung is excluded from selection without being marked spent, and the floor stays reachable');
  }

  // ---------------------------------------------------------------------------------------------
  // 14. THE ON-DEMAND RULES READ. GoComet publishes its minimum gap only on the enquiry detail,
  //     behind a budgeted enrichment that a busy cycle skips - and nothing later recovers it, so a
  //     load that missed its slot would plan on the platform fallback for its whole life with
  //     nobody told. The price page is a human-latency moment, so it spends one read there.
  // ---------------------------------------------------------------------------------------------
  {
    const { GoCometAdapter } = require('../src/platform/gocometAdapter');
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
      + `${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86_400, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;
    const mkResp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

    let gets = 0;
    const okAdapter = new GoCometAdapter({ token, sleep: async () => {}, minGetIntervalMs: 0,
      globalMinGetIntervalMs: 0, routineGetIntervalMs: 0,
      fetchImpl: async () => { gets++; return mkResp(200, { data: { slab_rate: 300, cargo_quantity: 2 } }); } });
    assert.deepStrictEqual(await okAdapter.refreshLoadRules('E9'), { minDecrement: 300 },
      'the detail read yields this load\'s own minimum, not the platform fallback');
    assert.strictEqual(gets, 1, 'one read');
    await okAdapter.refreshLoadRules('E9');
    assert.strictEqual(gets, 1, 'and the adapter cache absorbs the repeat, so a second keystroke costs nothing');

    // A read that does not land returns null, so the caller says the value is unknown rather than
    // presenting the platform fallback as this customer's rule.
    const failAdapter = new GoCometAdapter({ token, sleep: async () => {}, minGetIntervalMs: 0,
      globalMinGetIntervalMs: 0, routineGetIntervalMs: 0,
      fetchImpl: async () => mkResp(500, { error: 'boom' }) });
    assert.strictEqual(await failAdapter.refreshLoadRules('E10'), null, 'a failed read reports nothing, never a guess');
    assert.strictEqual(await failAdapter.refreshLoadRules(null), null, 'and a missing id never reaches the wire');
    ok('the on-demand rules read returns this load\'s own minimum, caches the repeat, and reports nothing on failure');
  }

  // ---------------------------------------------------------------------------------------------
  // 15. A RUNG THAT DOES NOT FIT SAYS NOTHING ABOUT THE ONES BELOW IT. `lo` falls by one minimum per
  //     later index (one less rung to reserve room for) while `hi` holds until a rung is accepted,
  //     so abandoning the tail at the first failure threw away attempts that were legal all along.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder({ cost: 30_000, marginsPct: [12.6, 10, 7.2, 2.7], minMarginPct: 2.7 });
    assert.deepStrictEqual(band.ladder, [33_780, 33_000, 32_160, 30_810], 'fixture: a four-anchor band');
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: 1000 });
    assert.deepStrictEqual(d.ladder, [33_780, 32_160, 30_810],
      'the rung that could not fit is dropped and the one below it is still placed');
    assert.deepStrictEqual(d.dropped.map((x) => x.index), [1], 'exactly one rung dropped, not the whole tail');
    assert.ok(everyGapClears(d.ladder, 1000), 'and every surviving step clears the minimum');
    assert.strictEqual(d.fits, 3, 'three attempts, not the two the tail-drop produced');
    ok('a middle rung that cannot fit costs ONE attempt, never every attempt below it');
  }

  // ---------------------------------------------------------------------------------------------
  // 16. TWO COUNTS, TWO AUDIENCES. The platform measures the step into the last rung; the engine
  //     exempts it (isFloorRung / snipe) because the decisive shot must never be silently dropped.
  //     A "we will send" sentence is a claim about the ENGINE.
  // ---------------------------------------------------------------------------------------------
  {
    const ladder = [20_268, 19_134]; // gap 1134, under a 1500 minimum
    assert.deepStrictEqual(fittingRungs(ladder, 1500), [20_268],
      'the strict count - what the platform will accept - sees one price');
    assert.deepStrictEqual(fittingRungs(ladder, 1500, null, { lastRungAlwaysAttempted: true }), ladder,
      'the desk-facing count sees two, because the engine attempts the floor regardless');
    const eng = planEngine();
    const pv = eng.planPreview({ id: 'F1', rules: { minDecrement: 1500, revisionLimit: 3 }, companyName: 'Havells' },
      { cost: 18_000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    assert.strictEqual(pv.rungsFitting, pv.ladder.length,
      'so the page never claims fewer prices than the bot will actually send');
    // And the count the desk reads is that same desk-facing one, so the block never reports a price
    // lost that the engine will in fact attempt.
    assert.ok(ladderShortfall(pv).fact.indexOf(`Only ${pv.ladder.length} of your `) === 0,
      'and the shortfall counts the floor rung the engine still fires');
    ok('the desk-facing count follows the ENGINE\'s rule; the strict platform rule stays inside the derivation');
  }

  // ---------------------------------------------------------------------------------------------
  // 17. PER-TONNE IS REFUSED THE DERIVATION, mirroring _resolveRoundingStep's refusal of the grid:
  //     minDecrement is in wire-amount space and a per-MT rate is not, and unlike the interpolation
  //     pass (which only drops) this function constructs a new price out of it.
  // ---------------------------------------------------------------------------------------------
  {
    const eng = planEngine();
    const band = { cost: 2_240, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 };
    const bare = buildBandLadder(band);
    const flat = eng._planFor(band, { minDecrement: 100, revisionLimit: 3, pricingMode: 'flat' }, 'X').plan;
    const pmt = eng._planFor(band, { minDecrement: 100, revisionLimit: 3, pricingMode: 'per_tonne' }, 'X').plan;
    assert.deepStrictEqual(pmt.ladder, bare.ladder, 'a per-tonne ladder is left exactly as the band built it');
    assert.notDeepStrictEqual(flat.ladder, bare.ladder, 'while the same numbers on a flat load ARE re-spaced');
    ok('a per-tonne rate is never re-spaced by a wire-amount-space minimum');
  }

  // ---------------------------------------------------------------------------------------------
  // 18. THE REHYDRATE REMAP. firedRungs are INDICES; a restart that rebuilds a shorter ladder moves
  //     what each index means. Restoring the raw persisted indices would bank the new FLOOR as spent
  //     and every floor gate reads firedRungs.has(last) - the bot goes dark at the buzzer.
  // ---------------------------------------------------------------------------------------------
  {
    const f = tmp('rehydrate');
    const sched = new DurableScheduler(f);
    // An intent as it stood BEFORE the derivation shipped: the full three-rung ladder, with the
    // opening and the middle both already fired.
    sched.upsert({ auctionId: 'H1', status: 'armed', ladder: [43_320, 42_370, 41_914],
      firedRungs: [0, 1], cost: 38_000, marginsPct: [14, 11.5, 10.3], minMarginPct: 10.3,
      lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells',
      rules: { minDecrement: T4_MINDEC, revisionLimit: 3 }, closesAt: Date.now() + 60_000 });
    const eng = planEngine();
    eng.scheduler = sched;
    eng._schedule = () => {};
    await eng.rehydrate();
    const m = eng.monitors.get('H1');
    assert.deepStrictEqual(m.ladder, [43_320, 41_914], 'the restart rebuilds the derived, shorter ladder');
    const last = m.ladder.length - 1;
    assert.ok(!m.firedRungs.has(last),
      'the FLOOR is not banked as spent - a raw index carry-over would have marked it and killed the snipe');
    assert.deepStrictEqual([...m.firedRungs].sort(), [0], 'only the rung whose PRICE survived carries forward');
    eng.kill();
    rm(f);
    ok('a restart onto a re-spaced ladder carries rungs by PRICE, so the decisive shot stays available');
  }

  // ---------------------------------------------------------------------------------------------
  // 19. THE GRID SNAP RUNS AFTER THE DERIVATION, and rewrites every price. The moved/dropped diff was
  //     computed against the pre-snap ladder, so left alone it names prices that are never sent - the
  //     page-vs-wire disagreement this whole change exists to remove, reintroduced one transform
  //     later. Only rungsFitting was originally recomputed post-transform; this pins the same
  //     discipline for the two fields the desk actually reads as prices.
  // ---------------------------------------------------------------------------------------------
  {
    const BAND = { cost: 30_000, marginsPct: [12.6, 10, 7.2, 2.7], minMarginPct: 2.7 };
    const rules = { minDecrement: 1000, revisionLimit: 3 };
    const bare = buildBandLadder(BAND).ladder;
    assert.deepStrictEqual(bare, [33_780, 33_000, 32_160, 30_810], 'fixture: a four-anchor band');

    // Without a grid, the derivation drops index 1 and SAYS so - this is the diff the snap invalidates.
    const plain = planEngine().planPreview({ companyName: 'Other', rules }, BAND);
    assert.deepStrictEqual(plain.ladder, [33_780, 32_160, 30_810], 'the derivation alone drops one rung');
    assert.deepStrictEqual(plain.rungsDropped.map((d) => d.price), [33_000],
      'and names the dropped price while that ladder is still the one being sent');

    // Same load on a round-figure shipper: the snap rewrites every surviving price.
    const grid = planEngine({}, { rounding: { enabled: true, shippers: ['Durian'], step: 200 } })
      .planPreview({ companyName: 'Durian Industries', rules }, BAND);
    assert.deepStrictEqual(grid.ladder, [33_600, 32_000, 31_000], 'the grid snap rewrites the derived ladder');
    for (const p of grid.ladder) assert.strictEqual(p % 200, 0, `rung ${p} is off the 200 grid`);
    // The derivation's EFFECT survives the snap - the dropped rung does not come back.
    assert.strictEqual(grid.ladder.length, bare.length - 1, 'the dropped rung stays dropped through the snap');
    assert.strictEqual(grid.rungsRequested, 4, 'and the desk is still counted against its own four prices');
    // The RECORD of it does not, because it no longer describes prices that will be sent.
    assert.deepStrictEqual(grid.rungsDropped, [], 'the stale drop record is cleared');
    assert.deepStrictEqual(grid.rungsMoved, [], 'and so is the stale move record');
    // The property that actually protects the desk, stated directly: nothing the notice can quote is
    // absent from the ladder that will be sent.
    for (const m of grid.rungsMoved) {
      assert.ok(grid.ladder.includes(m.to), `notice would quote Rs ${m.to}, which is not in the final ladder`);
    }
    const gridCopy = String(ladderNotice(grid) || '') + JSON.stringify(ladderShortfall(grid) || {});
    assert.ok(!/33,000/.test(gridCopy), 'and the superseded price 33,000 never reaches the desk');
    ok('a grid snap after the derivation clears the stale moved/dropped record, and the drop itself survives');
  }

  // ---------------------------------------------------------------------------------------------
  // 20. THE CEILING CAP does the same thing one layer further out - and worse, because lowering the
  //     opening onto the cap can RE-OPEN a gap the derivation had closed. The attempt count is
  //     recomputed on the capped ladder for exactly this reason.
  // ---------------------------------------------------------------------------------------------
  {
    const BAND = { cost: 30_000, marginsPct: [12.6, 10, 7.2, 2.7], minMarginPct: 2.7 };
    const rules = { minDecrement: 1000, revisionLimit: 3, ceilingPrice: 32_500 };
    const cap = planEngine().planPreview({ companyName: 'Other', rules }, BAND);
    // Ruling 68: the capped ladder is re-spaced, so 32,160 (340 under the cap) is dropped.
    assert.deepStrictEqual(cap.ladder, [32_500, 30_810], 'the cap lowers the opening onto the ceiling');
    assert.strictEqual(cap.ceiling, 32_500);
    assert.ok(cap.ladder.every((p, i) => i === 0 || cap.ladder[i - 1] - p >= 1000),
      'every step of the capped ladder clears the 1,000 minimum');
    // So the attempt count must be taken on the CAPPED ladder, not carried through from before it.
    assert.strictEqual(cap.rungsFitting, 2, 'the count catches the re-opened gap and reports two attempts');
    assert.deepStrictEqual(cap.fittingPrices, [32_500, 30_810], 'naming the prices that can actually be sent');
    // And the pre-cap diff is cleared rather than quoting prices the cap has replaced.
    assert.deepStrictEqual(cap.rungsDropped, [], 'the stale drop record is cleared');
    assert.deepStrictEqual(cap.rungsMoved, [], 'and so is the stale move record');
    for (const m of cap.rungsMoved) {
      assert.ok(cap.ladder.includes(m.to), `notice would quote Rs ${m.to}, which is not in the final ladder`);
    }
    const capCopy = String(ladderNotice(cap) || '') + JSON.stringify(ladderShortfall(cap) || {});
    assert.ok(!/33,780|33,000/.test(capCopy), 'no pre-cap price reaches the desk');
    ok('a ceiling cap after the derivation re-opens a gap, and both the count and the record follow the capped ladder');
  }

  // ---------------------------------------------------------------------------------------------
  // 21. THE PAGE ITSELF. The copy being right is half of it; the other half is WHERE it lands and
  //     WHAT COLOUR it is, and neither of those is visible to any assertion about strings. The first
  //     build of this state put correct words in neutral grey inside a collapsed panel, and the
  //     owner's verdict was that it read as a footnote rather than as a loss. So the three things
  //     that made it a footnote are pinned here: position, palette, and whether the desk can act.
  // ---------------------------------------------------------------------------------------------
  {
    const page = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8')
      // The working tree is CRLF here, so an ordering assertion written with \n matches nothing.
      .replace(/\r\n/g, '\n'));

    // POSITION. Below the price panel, above Submit - on the path to the button, not inside an
    // expander. Asserted on the template's own ordering rather than on a rendered page, because that
    // ordering is the requirement.
    // ORDERING, not adjacency. The requirement is band panel -> shortfall -> Submit, and siblings
    // legitimately sit on that path without changing it: the zero-margin guard adds a `disabled`
    // attribute to the submit tag, and the held-state work inserts a portal-warning slot between
    // the shortfall block and the button. Pinning the exact literal made this assertion fail on
    // changes that leave the requirement intact.
    const iBand = page.indexOf('${bandBlock}');
    const iWarn = page.indexOf('${ladderWarnBlock}');
    const iBtn = page.indexOf('<button type="submit"', iWarn);
    const order = (iBand !== -1 && iWarn > iBand && iBtn > iWarn) ? iWarn : -1;
    assert.ok(order > 0, 'the shortfall block sits between the price panel and the Submit button');

    // PALETTE. Amber, and the page's OWN amber - the same pair .closewarn.amber already uses, so one
    // page never shows two different warning colours. Never red (nothing is broken, bids still go
    // out) and never the neutral .bfacts grey (something IS lost) - checked up to the demoted lever's
    // own rule, which is deliberately excluded below: that one lever is a plain text link and is
    // SUPPOSED to read as muted, the way .ceilalt already does for the ceiling block's own second lever.
    const css = page.slice(page.indexOf('.lwarn{'), page.indexOf('.lwacts .lwalt{'));
    assert.ok(/background:hsl\(45 95% 92%\)/.test(css), 'the block carries the page amber ground');
    assert.ok(/border:1px solid hsl\(45 85% 78%\)/.test(css), 'and the page amber border');
    assert.ok(/\.lwfact\{[^}]*color:var\(--warn\)/.test(css), 'the fact line is the amber warn ink');
    assert.ok(!/var\(--danger\)|hsl\(4 /.test(css), 'and nothing in the block is red');
    assert.ok(!/var\(--muted-fg\)/.test(css), 'nor the surviving button muted into the neutral grey it was rejected as');
    ok('the shortfall block is amber, and sits between the prices and the Submit button');

    // ONE BUTTON, ONE LINK. "Use Rs N" stays the only button-styled lever; "Adjust prices" is demoted
    // to a plain inline text link matching the page's own .ceilalt pattern (small, underlined, no
    // button chrome) rather than a second competing button.
    const lwaltCss = page.slice(page.indexOf('.lwacts .lwalt{'), page.indexOf('.lwacts .lwalt{') + 200);
    assert.ok(/text-decoration:underline/.test(lwaltCss), 'the demoted lever reads as an underlined link');
    assert.ok(/background:none/.test(lwaltCss), 'with no button fill left on it');
    assert.ok(/border:0/.test(lwaltCss), 'and no button border either');
    assert.ok(/font-size:1[0-2]\.?\d*px/.test(lwaltCss), 'set small, like the ceiling block\'s own demoted lever');
    ok('the second lever is a plain text link, not a second button');
  }

  {
    const script = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8')
      // The working tree is CRLF here, so an ordering assertion written with \n matches nothing.
      .replace(/\r\n/g, '\n'));

    // THE ONE-TAP LEVER. The corrective figure goes onto a button through pctForRs, the same
    // conversion typing it into that row's own rupee box performs - the form posts margin percent, so
    // a price written anywhere else is a number the server never receives.
    assert.ok(/lwUse\.textContent='Use Rs '\+nf\.format\(lwTarget\)/.test(script),
      'the button wears the corrective number');
    assert.ok(/pctIn\.value=pctForRs\(lwTarget,cv\)/.test(script),
      'and tapping it writes that price into the last row in percent space');
    assert.ok(/markCustom\(\);lwOpen\(\);syncRs\(row,cv\);footer\(\)/.test(script),
      'marking the override, opening the rows so the change is seen, and re-previewing');
    // Both levers reveal the rows, because the list of what will be sent lives in there.
    assert.ok(/function lwOpen\(\)\{var d=document\.querySelector\('details\.band'\);if\(d\)d\.open=true;\}/.test(script),
      'both actions open the price panel rather than changing numbers behind it');

    // NO STALE WARNING. Every path that stops short of a fresh preview hides BOTH blocks in the slot
    // first; a warning about a cost the desk has already replaced is worse than none, and the
    // floor-step block is worse still because it holds the submit shut while it stands.
    assert.ok(/if\(!\(cv>0\)\)\{if\(li\)li\.remove\(\);lwHide\(\);fsRender\(null\);return;\}/.test(script), 'cleared cost hides it');
    assert.ok(/pvSeq\+\+;lwHide\(\);fsRender\(null\);/.test(script), 'a sub-floor cost hides it');
    assert.ok(/if\(j\.willNotBid\)\{lwHide\(\);fsRender\(null\);/.test(script), 'a load that will not bid hides it');

    // THE PRICE LINE names what reaches the board, not what survived the plan - the two differ
    // whenever a grid snap or a ceiling cap re-opens a gap the derivation had closed.
    assert.ok(/var send=\(j\.fittingPrices&&j\.fittingPrices\.length\)\?j\.fittingPrices:j\.ladder;/.test(script),
      'the price line is built from the prices that can actually be sent');
    ok('the desk can fix the shortfall in one tap, and no stale warning survives a re-price');
  }

  console.log(`\n${passed}/${EXPECTED} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
