'use strict';
/**
 * THE STEP INTO THE FLOOR RUNG, and the fact that nothing anywhere reported it.
 *
 * The floor rung is the reserved decisive shot. _maybeBid exempts it from the min-decrement guard on
 * purpose (a shot we must never silently drop), so when the step into it is under the load's minimum
 * bid difference the engine fires it, the portal may refuse it, and the load closes having bid once -
 * on a plan the desk page showed as complete.
 *
 * THE MECHANISM IS PINNED HERE; THE SURFACE IS PINNED IN test-floor-step-price-gate.js. This step is
 * knowable the moment a cost is typed, so what the desk reads is a /price block that holds the
 * submit shut and offers the correction. arm() keeps only its own log record - an operator alert on
 * the way out of arm() could describe nothing but a load already committed.
 *
 * THREE producers can emit that step and no detector covered it:
 *   - a 2-RUNG ladder: deriveSpacedLadder's middle loop never runs, so it pushes the floor with no
 *     gap check, reports applied=false, and its correctly-computed `fits` is discarded.
 *   - the SHIPPER-CEILING cap in arm(), which runs after the grid snap and the derivation and can
 *     lower the opening onto the cap, re-opening the gap above the floor.
 *   - the GRID SNAP, whose re-check calls decrementViolations - which by design never walks the
 *     floor step and returns [] outright below three rungs.
 *
 * What is pinned here:
 *   1. each producer's ladder, and that the pre-existing detectors stay silent on it;
 *   2. the new check reporting it on the FINAL ladder - after the snap and after the cap - through
 *      arm(), which is the one chokepoint every restore path funnels through;
 *   3. the step measured from the last rung that can actually LAND, not from the adjacent index, so
 *      a ladder whose unfireable middle leaves a legal floor step raises no false alarm;
 *   4. nothing about the condition reaching an operator channel;
 *   5. silence where the question is meaningless (per-tonne) or already answered (a clean ladder).
 *
 * This is DETECTION only. Whether SuperProcure really enforces its loadBidDifference on the floor
 * step is unsettled in this codebase (pricing.js says it does, bidEngine says it is open), so no
 * ladder is reshaped here - the step is made visible and the desk decides.
 *
 *   node scripts/test-ladder-floor-step-detector.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { buildBandLadder, deriveSpacedLadder, decrementViolations, scaleLadderByType, perTypeMinDecrement,
  floorStepViolation } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification, ERROR_KINDS } = require('../src/notify/engineAlerts');
const { floorStepRefusal } = require('../src/pricing/ladderNotice');

const KIND = 'ladder_floor_step_below_min_decrement';

// Completion sentinel - run-tests.js grades by EXIT CODE alone, so a file that exits 0 after running
// nothing reads as a pass.
const EXPECTED = 13;
let passed = 0;
process.on('exit', () => {
  if (passed !== EXPECTED) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${passed} of ${EXPECTED} cases - this file exited `
      + 'early, or cases were added/removed without updating EXPECTED. This run is NOT a pass.');
    process.exitCode = 1;
  }
});
const ok = (n) => { passed++; console.log('  ok  ' + n); };

const files = [];
const tmp = (tag) => { const f = path.join(os.tmpdir(), `floorstep-${tag}-${process.pid}-${files.length}.json`); files.push(f); return f; };
process.on('exit', () => { for (const f of files) { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } } });

/** An engine whose ladder maths is real and whose timers, network and wire are not. */
function engine(opts = {}) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: null, totalBidders: 0 }),
    placeBid: async () => { throw new Error('placeBid must be unreachable in this test'); },
    writeEnabled: true,
  };
  const events = [];
  const logs = [];
  const log = { debug: () => {}, info: (m, x) => logs.push(['info', m, x]),
    warn: (m, x) => logs.push(['warn', m, x]), error: (m, x) => logs.push(['error', m, x]) };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp('eng')),
    Object.assign({ onEvent: (e) => events.push(e), log }, opts));
  eng._schedule = () => {};
  eng._planWake = () => {};
  return { eng, events, logs };
}

const armed = (eng, id, rules, inputs) => eng.arm(
  { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, companyName: 'Havells', rules,
    closesAt: Date.now() + 30 * 60_000 }, inputs);

const alertsOf = (events) => events.filter((e) => e && e.type === 'alert' && e.kind === KIND);
// What arm() leaves behind now that the operator alert is gone: its own log record of having armed a
// load carrying the step. The monitor deliberately does not expose the two fields - they have no
// engine reader, and giving them one is how a detect-only change starts steering a bid.
const fsLog = (logs) => (logs.find((l) => l[0] === 'warn' && /floor rung/i.test(l[1])) || [])[2] || null;

(async () => {
  // ---------------------------------------------------------------------------------------------
  // 1. THE 2-RUNG PRODUCER, and the silence around it. deriveSpacedLadder pushes the floor with no
  //    gap check; decrementViolations returns [] below three rungs; the derivation reports nothing
  //    because it changed nothing.
  // ---------------------------------------------------------------------------------------------
  {
    const band = buildBandLadder({ cost: 5_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(band.ladder, [5_630, 5_315], 'fixture: a two-rung band');
    const d = deriveSpacedLadder({ ladder: band.ladder, floor: band.floor, minDecrement: 1000 });
    assert.deepStrictEqual(d.ladder, [5_630, 5_315], 'the derivation leaves it untouched');
    assert.strictEqual(d.applied, false, 'so it reports nothing - the log line at bidEngine 1111 never runs');
    assert.strictEqual(d.fits, 1, 'while its own strict count knows only ONE price can land');
    assert.deepStrictEqual(decrementViolations(d.ladder, 1000), [],
      'and the runtime detector is silent: it exempts the floor step and bails below three rungs');

    const { eng } = engine();
    const pv = eng.planPreview({ companyName: 'Havells', rules: { minDecrement: 1000 } },
      { cost: 5_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(pv.ladder, [5_630, 5_315]);
    assert.ok(pv.floorStepViolation, 'the plan now carries the floor-step violation');
    assert.strictEqual(pv.floorStepViolation.gap, 315, 'the step into the floor is 315');
    assert.strictEqual(pv.floorStepViolation.minDecrement, 1000, 'against a 1,000 minimum');
    assert.strictEqual(pv.rungsLandable, 1, 'one price can land, not the two the engine will attempt');
    assert.strictEqual(pv.rungsFitting, 2, 'the engine-attempt count is unchanged - it still fires the floor');
    eng.kill();
    ok('a two-rung ladder whose floor step is under the minimum is reported, where three detectors were silent');
  }

  // ---------------------------------------------------------------------------------------------
  // 2. THE SAME LOAD THROUGH THE REAL arm(). The plan-time fact is worth nothing if the armed
  //    monitor does not raise it - arm() is the chokepoint every restore path funnels through.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events, logs } = engine();
    const m = armed(eng, 'FS2', { minDecrement: 1000 }, { cost: 5_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(m.ladder, [5_630, 5_315], 'the armed ladder is the two-rung one');
    const rec = fsLog(logs);
    assert.ok(rec, 'arm() records having armed a load carrying the step');
    assert.strictEqual(rec.gap, 315);
    assert.strictEqual(rec.minDecrement, 1000);
    assert.strictEqual(rec.rungsLandable, 1);
    assert.strictEqual(alertsOf(events).length, 0,
      'and nothing is emitted: the desk was told at price entry, so an alert here could only describe a load already committed');
    eng.kill();
    ok('arm() records the fact on its own log, and sends no operator alert');
  }

  // ---------------------------------------------------------------------------------------------
  // 3. THE CEILING-CAP PRODUCER - the highest-frequency one, and the one behind no feature gate. The
  //    cap runs after the derivation and lowers the opening onto the ceiling, re-opening the gap
  //    above the floor. Through the REAL arm(), because the cap lives there and nowhere else.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events, logs } = engine();
    const m = armed(eng, 'FS3', { minDecrement: 1000, ceilingPrice: 41_000 },
      { cost: 38_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(m.ladder, [41_000, 40_394], 'the cap lowers the opening onto the ceiling');
    assert.strictEqual(m.floor, 40_394, 'and the floor rung is untouched, as arm() asserts');
    assert.deepStrictEqual(decrementViolations(m.ladder, 1000), [],
      'the pre-existing runtime detector reports NOTHING on this armed ladder');
    const rec = fsLog(logs);
    assert.ok(rec, 'the new check reports it');
    assert.strictEqual(rec.gap, 606, 'the step into the floor is 606 against a 1,000 minimum');
    assert.strictEqual(rec.rungsLandable, 1, 'so only the opening can land');
    assert.strictEqual(alertsOf(events).length, 0, 'on the plan, and on no operator channel');
    eng.kill();
    ok('the ceiling cap is caught on the ladder that was actually armed, where decrementViolations returns []');
  }

  // ---------------------------------------------------------------------------------------------
  // 4. THE GRID-SNAP PRODUCER. Post-snap gaps are multiples of the step. A middle price is re-placed
  //    in whole grid steps after the snap (A053), but a two-price ladder has no middle to move, so a
  //    snap that rounds the opening down and the floor up can still re-open the one step there is.
  //    The snap's own re-check calls decrementViolations and so cannot see this.
  //    Named reversal, A053: this used a four-margin band whose snap left 26,500 -> 26,000 under the
  //    minimum; the grid re-derivation now places that middle at 27,000, so the fixture is a
  //    two-price band where the producer still exists.
  // ---------------------------------------------------------------------------------------------
  {
    const BAND = { cost: 25_000, marginsPct: [9.6, 4.4], minMarginPct: 4.4 };
    const rules = { minDecrement: 1000 };
    const plain = engine();
    const before = plain.eng.planPreview({ companyName: 'Durian Industries', rules }, BAND);
    assert.deepStrictEqual(before.ladder, [27_400, 26_100], 'un-snapped, the derivation clears every step');
    assert.strictEqual(before.floorStepViolation, null, 'so there is nothing to report before the snap');
    plain.eng.kill();

    const { eng, events, logs } = engine({ rounding: { enabled: true, shippers: ['Durian'], step: 500 } });
    const m = eng.arm({ id: 'FS4', lane: { origin: 'Bhiwandi', destination: 'Alwar' },
      companyName: 'Durian Industries', rules, closesAt: Date.now() + 30 * 60_000 }, BAND);
    assert.deepStrictEqual(m.ladder, [27_000, 26_500], 'the snap rewrites both prices onto the 500 grid');
    assert.deepStrictEqual(decrementViolations(m.ladder, 1000), [],
      'the snap re-check is satisfied - it never walks the step into the floor');
    const rec = fsLog(logs);
    assert.ok(rec, 'the new check reports the step the snap re-opened');
    assert.strictEqual(rec.gap, 500, '27,000 -> 26,500 is 500 against a 1,000 minimum');
    assert.strictEqual(alertsOf(events).length, 0, 'on the plan, and on no operator channel');
    eng.kill();
    ok('a grid snap that re-opens the floor step is caught, where the snap\'s own re-check is silent');
  }

  // ---------------------------------------------------------------------------------------------
  // 5. NO FALSE ALARM. The step the portal measures is from the last rung that can actually LAND,
  //    not from the adjacent index - a middle rung the engine will never send only ever WIDENS the
  //    gap into the floor. Checking adjacent pairs would cry wolf on every such ladder.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events } = engine();
    const m = armed(eng, 'FS5', { minDecrement: 1000, ceilingPrice: 32_500 },
      { cost: 30_000, marginsPct: [12.6, 10, 7.2, 2.7], minMarginPct: 2.7 });
    // Named reversal, ruling 68 (PR-3 R2-9): a ceiling cap re-spaces the ladder, so the middle rung that
    // would sit within the minimum of the cap is dropped instead of re-opening the step above it.
    assert.deepStrictEqual(m.ladder, [32_500, 30_810], 'the cap re-spaces the ladder: the middle rung under the minimum is dropped');
    assert.ok(m.ladder[0] - m.ladder[1] >= 1000, 'the step into the floor clears the minimum');
    assert.strictEqual(alertsOf(events).length, 0, 'and no alert is raised');
    eng.kill();

    // The sharper half of the same rule, on the check itself. Adjacent floor gap 500, under the
    // minimum - but the middle rung can never be sent, so the step the portal will actually measure
    // is 28,000 -> 27,000, which is exactly 1,000 and legal. An adjacent-pair check cries wolf here.
    assert.strictEqual(floorStepViolation([28_000, 27_500, 27_000], 1000), null,
      'an unfireable middle widens the real floor step - nothing to report');
    const v = floorStepViolation([28_000, 27_500, 27_400], 1000);
    assert.ok(v, 'and when the widened step is still short, it IS reported');
    assert.deepStrictEqual(v, { fromPrice: 28_000, toPrice: 27_400, gap: 600, minDecrement: 1000,
      rungsLandable: 1, bindingLine: null },
      'measured from the last rung that can land, not from the adjacent index');
    ok('the step is measured from the last LANDABLE rung, so an unfireable middle raises no false alarm');
  }

  // ---------------------------------------------------------------------------------------------
  // 6. A CLEAN LADDER stays silent, and the landable count agrees with the ladder it was taken on.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events } = engine();
    const m = armed(eng, 'FS6', { minDecrement: 1000 },
      { cost: 38_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.strictEqual(alertsOf(events).length, 0, 'a ladder every step of which clears the minimum says nothing');
    const pv = eng.planPreview({ companyName: 'Havells', rules: { minDecrement: 1000 } },
      { cost: 38_000, marginsPct: [12.6, 7.2, 2.7], minMarginPct: 2.7 });
    assert.strictEqual(pv.floorStepViolation, null);
    assert.strictEqual(pv.rungsLandable, m.ladder.length, 'every rung can land');
    assert.strictEqual(pv.rungsLandable, pv.rungsFitting, 'so the two counts agree');
    eng.kill();
    ok('a ladder that clears its minimum end to end raises nothing, and both counts agree');
  }

  // ---------------------------------------------------------------------------------------------
  // 7. PER-TONNE IS NOT ASKED. minDecrement is SuperProcure's loadBidDifference, a number in
  //    WIRE-AMOUNT space; a per-MT rate is not. _planFor already refuses to RE-SPACE a per-tonne
  //    ladder for that reason, and a detector that judged one would raise an alarm about a
  //    comparison this codebase declares unproven.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events } = engine();
    const m = armed(eng, 'FS7', { minDecrement: 1000, pricingMode: 'per_tonne', rateType: 'PMT' },
      { cost: 2_240, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.ok(m.ladder[0] - m.ladder[1] < 1000, 'fixture: the per-MT floor step is far under the raw decrement');
    assert.strictEqual(alertsOf(events).length, 0, 'and nothing is claimed about it');
    eng.kill();
    ok('a per-tonne ladder raises no floor-step alert - the decrement is in a different unit space');
  }

  // ---------------------------------------------------------------------------------------------
  // 8. THE SURFACE. This step is knowable the moment a cost is typed, so it belongs on the /price
  //    form while the correction is still free - test-floor-step-price-gate.js pins the block, the
  //    disabled submit and the corrective button. What is pinned HERE is the absence that replaced
  //    the operator alert: a kind quietly added back to a routing set is how it would return.
  // ---------------------------------------------------------------------------------------------
  {
    assert.ok(!ERROR_KINDS.has(KIND), 'the kind is not on the ops error channel that reaches the client');
    assert.strictEqual(toNotification({ type: 'alert', level: 'error', kind: KIND, auctionId: 'FS8' }), null,
      'and an event carrying it would resolve to no notification at all');
    ok('the condition reaches the desk at price entry, and nothing about it reaches the Director');
  }

  // ---------------------------------------------------------------------------------------------
  // 9. THE COUNT THE DESK IS GIVEN. rungsFitting is the ENGINE's attempt count and keeps its
  //    meaning (the floor always fires). rungsLandable is the PORTAL's, and on a violating load the
  //    two differ by exactly the floor rung - which is the fact the page had no way to state.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng } = engine();
    const pv = eng.planPreview({ companyName: 'Havells', rules: { minDecrement: 1000, ceilingPrice: 41_000 } },
      { cost: 38_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(pv.ladder, [41_000, 40_394], 'the preview mirrors what arm() capped');
    assert.strictEqual(pv.rungsRequested, 2);
    assert.strictEqual(pv.rungsFitting, 2, 'the engine will attempt two prices');
    assert.strictEqual(pv.rungsLandable, 1, 'the portal will take one');
    assert.ok(pv.floorStepViolation, 'and the preview says which step accounts for the difference');
    eng.kill();
    ok('the preview carries both counts, so the gap between attempted and landable is stateable');
  }

  // ---------------------------------------------------------------------------------------------
  // 10. THE PER-TYPE LOAD, which no case above reaches. The threshold this check is judged against
  //     is the load's RAW minimum: the per-type requirement is already carried by `scaled`, whose
  //     amounts are real per-line currency. Passing the blended-space spacingMinDecrement instead
  //     applied the type scaling a SECOND time and measured a 22,000 line against 2,273 on a load
  //     whose published minimum is 1,000 - an error-level claim, on the Director's channel, quoting
  //     a threshold the load does not have.
  // ---------------------------------------------------------------------------------------------
  {
    const costByType = { cost: 50_000, types: [{ label: 'Trailer', cost: 60_000 }, { label: 'LCV', cost: 22_000 }] };
    const ladder = [56_300, 53_150];
    const scaled = scaleLadderByType(ladder, costByType);
    assert.deepStrictEqual(scaled.map((s) => s.amounts[0] - s.amounts[1]), [3780, 1386],
      'fixture: every line moves by more than the load\'s real 1,000 minimum');
    assert.strictEqual(perTypeMinDecrement(1000, costByType), 2273,
      'while the blended-space threshold is 2,273 - correct for SPACING a blended ladder, not for this check');
    assert.strictEqual(floorStepViolation(ladder, 1000, scaled), null,
      'against the raw minimum the floor rung lands and there is nothing to report');

    const { eng, events } = engine();
    const m = armed(eng, 'FS10', { minDecrement: 1000, costByType },
      { cost: 50_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.deepStrictEqual(m.ladder, [56_300, 53_150]);
    assert.strictEqual(alertsOf(events).length, 0, 'and arm() stays silent on it');
    const pv = eng.planPreview({ companyName: 'Havells', rules: { minDecrement: 1000, costByType } },
      { cost: 50_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.strictEqual(pv.rungsLandable, 2, 'both prices can land, on the page as well as in the engine');
    assert.strictEqual(pv.floorStepViolation, null);
    eng.kill();
    ok('a per-type load whose line gaps clear the raw minimum raises nothing - the scaling is not applied twice');
  }

  // ---------------------------------------------------------------------------------------------
  // 11. THE COUNT AFTER THE CAP. The ceiling cap collapses rungs onto the cap and de-dupes, so an
  //     attempt count taken in _planFor before it names attempts the armed plan cannot make. Case 3
  //     cannot catch this - its fixture keeps two rungs either side of the cap. Here three become
  //     two, and the sentence has to say the load lost ONE attempt, not two.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events, logs } = engine();
    const m = armed(eng, 'FS11', { minDecrement: 1000, ceilingPrice: 40_800 },
      { cost: 40_000, marginsPct: [25, 20, 1.5], minMarginPct: 1.5 });
    assert.deepStrictEqual(m.ladder, [40_800, 40_600], 'the cap collapsed a three-rung ladder to two');
    assert.strictEqual(alertsOf(events).length, 0);
    const rec = fsLog(logs);
    assert.strictEqual(rec.rungsFitting, 2, 'the attempt count is the capped ladder\'s, not the pre-cap 3');
    assert.strictEqual(rec.rungsLandable, 1, 'so the pair says one attempt was lost, not two');
    const pv = eng.planPreview({ companyName: 'Havells', rules: { minDecrement: 1000, ceilingPrice: 40_800 } },
      { cost: 40_000, marginsPct: [25, 20, 1.5], minMarginPct: 1.5 });
    assert.strictEqual(pv.rungsFitting, 2, 'and arm() counts what the page counts, on the same ladder');
    eng.kill();
    ok('the attempt count is recomputed on the capped ladder, beside the post-cap landable count');
  }

  // ---------------------------------------------------------------------------------------------
  // 12. A LOAD THAT WILL NEVER BID SAYS NOTHING. With the ceiling under the operating floor arm()
  //     sets ceilingBelowFloor and _decide refuses every tick, placing zero bids - so a sentence
  //     about how many prices reach the board is false, and it would land beside that load's own
  //     cannot-win-profitably notice. The FACT is still carried for the preview and the dashboard.
  // ---------------------------------------------------------------------------------------------
  {
    const { eng, events, logs } = engine();
    const m = armed(eng, 'FS12', { minDecrement: 1000, ceilingPrice: 4_000 },
      { cost: 5_000, marginsPct: [12.6, 6.3], minMarginPct: 6.3 });
    assert.strictEqual(m.ceilingBelowFloor, true, 'fixture: the cap sits under the operating floor');
    assert.strictEqual(alertsOf(events).length, 0, 'no board-outcome claim is made about it');
    // The fact is still gathered. What this load's desk reads is its own cannot-win-profitably
    // refusal, and the /price block is judged on the same plan - so there is nothing left here that
    // could contradict it.
    assert.ok(floorStepViolation(m.ladder, 1000), 'the ladder does violate - the check was not skipped');
    assert.ok(fsLog(logs), 'and arm() recorded it, the same as on any other violating load');
    eng.kill();
    ok('a load that will never bid still carries the fact, and still says nothing to an operator');
  }

  // ---------------------------------------------------------------------------------------------
  // 13. THE NUMBERS BELONG TO THE CONDITION THAT PRODUCED THEM. fittingRungs drops a rung on EITHER
  //     the blended gap OR any line's own gap; reporting the blended pair for a per-line exclusion
  //     printed "only Rs 1200 above ... under a minimum of Rs 1000" - arithmetic that contradicts
  //     itself, on the one channel whose credibility is the whole point. Independent of case 10:
  //     this fixture clears the raw minimum on the blend and still fails on the cheap line.
  // ---------------------------------------------------------------------------------------------
  {
    const costByType = { cost: 30_000, types: [{ label: 'Trailer', cost: 40_000 }, { label: 'Tempo', cost: 10_000 }] };
    const ladder = [32_700, 31_500];
    assert.ok(ladder[0] - ladder[1] >= 1000, 'fixture: the BLENDED step clears the raw minimum');
    const v = floorStepViolation(ladder, 1000, scaleLadderByType(ladder, costByType));
    assert.ok(v, 'yet the floor rung cannot land, because the cheap line moves only Rs 400');
    assert.deepStrictEqual(v.bindingLine, { label: 'Tempo', fromPrice: 10_900, toPrice: 10_500, gap: 400 },
      'and the violation names the line that bound, with that line\'s own amounts');

    const { eng, events, logs } = engine();
    const m = armed(eng, 'FS13', { minDecrement: 1000, costByType },
      { cost: 30_000, marginsPct: [9, 5], minMarginPct: 5 });
    assert.strictEqual(alertsOf(events).length, 0);
    const rec = fsLog(logs);
    assert.strictEqual(rec.gap, 1200, 'the ladder\'s own blended step is still carried');
    assert.strictEqual(rec.bindingLine.gap, 400, 'beside the line that actually bound');
    const copy = floorStepRefusal({ ladder: m.ladder, ceiling: null, rungsRequested: 2,
      rungsFitting: rec.rungsFitting, minDecrement: 1000, countsAreDeskFacing: true,
      floorStepViolation: v });
    assert.ok(/Tempo/.test(copy.fact), 'and the sentence the desk reads names that line');
    assert.ok(/Rs 10,500 is only Rs 400 below Rs 10,900/.test(copy.fact),
      'quoting that line\'s own pair, so the gap and the minimum beside it no longer contradict each other');
    assert.strictEqual(copy.priceTarget, null,
      'with no blended figure offered: the price that clears one truck\'s own gap is not this arithmetic');
    eng.kill();
    ok('a per-line exclusion reports the per-line pair, not a blended gap that is not under the stated minimum');
  }

  console.log(`\n${passed}/${EXPECTED} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
