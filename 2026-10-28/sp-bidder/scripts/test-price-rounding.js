'use strict';
/**
 * ROUND-FIGURE QUOTING - the grid snap, its floor invariant, and its opt-in gate.
 * Mechanism and rationale live at pricing.js roundLadderToGrid; this pins the behaviour.
 *
 * Why these three cases carry the file:
 *
 * R2 - "nearest" is the intuitive reading of round-figure quoting, and it is wrong. Its values are
 * chosen so down and nearest disagree (11,260 -> 11,200, never 11,300), so a future Math.round fails
 * here instead of silently on the wire.
 *
 * R7 - arm() asserts a ceiling-capped ladder's last rung EQUALS plan.floor. Snap the rungs but not
 * the floor and every ceiling-carrying load on an opted-in shipper throws FLOOR at arm: the load
 * never bids, and the desk watches a cost it typed in go nowhere. This is why the snapper returns a
 * floor at all rather than only a ladder.
 *
 * R6 - the gate must stay opt-in. On a shipper that never asked for it, the raised floor makes the
 * final snipe fire above the true floor and forfeit auctions the un-snapped ladder would have won.
 *
 * Offline and deterministic: no clock read for a decision, no reachable adapter write (placeBid
 * throws), fixed costs and margins. The band is the deployed [12.6, 7.2, 6.3], so R4's collapse is
 * the shape a real tight cost produces rather than a contrived one.
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { buildBandLadder, roundLadderToGrid } = require('../src/engine/pricing');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { validate, defaultsFrom } = require('../src/admin/configStore');

// Completion sentinel - run-tests.js grades by EXIT CODE alone, so a file that exits 0 after running
// nothing reads as a pass. Setting process.exitCode inside an 'exit' listener overrides even an
// explicit process.exit(0).
const EXPECTED = 16;
let passed = 0;
process.on('exit', () => {
  if (passed !== EXPECTED) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${passed} of ${EXPECTED} cases - this file exited ` +
      `early, or cases were added/removed without updating EXPECTED. This run is NOT a pass.`);
    process.exitCode = 1;
  }
});
function ok(name) { passed++; console.log('  ok  ', name); }

const TMPS = [];
function tmp() {
  const p = path.join(os.tmpdir(), `price-rounding-${process.pid}-${TMPS.length}.json`);
  TMPS.push(p);
  return p;
}

const BAND = [12.6, 7.2, 6.3];
const MIN_MARGIN = 6.3;

/** A BidEngine wired for plan-only work: no timers, no writes, no network. */
function engineWith(rounding) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: null, totalBidders: 0 }),
    placeBid: async () => { throw new Error('placeBid must be unreachable in this test'); },
    writeEnabled: true,
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), { rounding });
  eng._schedule = () => {};  // no live timers
  eng._planWake = () => {};
  return eng;
}

const DURIAN_ON = { enabled: true, shippers: ['Durian'], step: 100 };

function preview(eng, cost, companyName, rules) {
  return eng.planPreview({ companyName, rules: rules || null }, { cost, marginsPct: BAND, minMarginPct: MIN_MARGIN });
}

/** A minimal valid operator config, for exercising configStore.validate's rounding block. */
function baseCfg() {
  return {
    marginsPct: BAND, minMarginPct: MIN_MARGIN, recipients: [], allowlist: { shippers: [], lanes: [], hardCloseOnly: true },
    notifyMode: 'dashboard', discoveryIntervalMs: 30_000, priceDeadlineLeadMs: 90_000, reminderLeadMs: 60_000,
    antiDetection: { enabled: true, cadenceJitterMs: 250, openJitterMs: 250, maxBidsPerMin: 20, minInterFireMs: 150 },
    softClose: { enabled: false, shippers: [], mode: 'shadow', reserve: 1 },
  };
}

// ---------------------------------------------------------------------------
// R1 - THE FLOOR IS NEVER BREACHED, over a sweep of costs and grids.
// ---------------------------------------------------------------------------
{
  let checked = 0;
  for (const cost of [800, 1000, 4321, 9999, 10_000, 17_500, 30_000, 123_456, 987_654]) {
    for (const step of [10, 50, 100, 500, 1000]) {
      const band = buildBandLadder({ cost, marginsPct: BAND, minMarginPct: MIN_MARGIN });
      const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step });
      for (const p of snapped.ladder) {
        assert.ok(p >= band.floor,
          `snapped rung ${p} fell below the operating floor ${band.floor} (cost ${cost}, step ${step})`);
        assert.ok(p >= band.trueCost,
          `snapped rung ${p} fell below true cost ${band.trueCost} (cost ${cost}, step ${step})`);
      }
      assert.ok(snapped.floor >= band.floor,
        `snapped floor ${snapped.floor} is below the operating floor ${band.floor} it replaced`);
      assert.strictEqual(snapped.ladder[snapped.ladder.length - 1], snapped.floor,
        'the floor must remain the last rung after snapping');
      checked += 1;
    }
  }
  assert.strictEqual(checked, 45, 'the sweep must actually run every cost x step pair');
  ok('R1 no snapped rung ever falls below the operating floor or true cost, across 45 cost x grid pairs');
}

// ---------------------------------------------------------------------------
// R2 - ROUNDS DOWN, NOT TO NEAREST. Both values here round UP under "nearest".
// ---------------------------------------------------------------------------
{
  const band = buildBandLadder({ cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  assert.deepStrictEqual(band.ladder, [33_780, 32_160, 31_890], 'the live band on a 30,000 cost');
  const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step: 100 });

  assert.strictEqual(snapped.ladder[0], 33_700,
    '33,780 must round DOWN to 33,700 - "nearest" would give 33,800 and hand away margin for nothing');
  assert.strictEqual(snapped.ladder[1], 32_100,
    '32,160 must round DOWN to 32,100 - "nearest" would give 32,200');
  ok('R2 rungs above the floor round DOWN, not to nearest (both values here round UP under nearest)');
}

// ---------------------------------------------------------------------------
// R3 - THE FLOOR ROUNDS UP, and every surviving rung sits exactly on the grid.
// ---------------------------------------------------------------------------
{
  const band = buildBandLadder({ cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step: 100 });

  assert.strictEqual(band.floor, 31_890, 'the un-snapped operating floor');
  assert.strictEqual(snapped.floor, 31_900,
    'the floor is the one rung that can only round UP - down (31,800) would breach it');
  assert.strictEqual(snapped.ladder[snapped.ladder.length - 1], 31_900, 'and it is the last rung');
  for (const p of snapped.ladder) {
    assert.strictEqual(p % 100, 0, `rung ${p} is not on the 100 grid - the shipper would discard this bid`);
  }
  ok('R3 the floor rounds UP (31,890 -> 31,900) and every rung lands exactly on the grid');
}

// ---------------------------------------------------------------------------
// R4 - COLLAPSE IS REAL, STRICTLY DESCENDING, AND STILL FLOOR-SAFE.
// A tight cost puts two of the three anchors on the same grid point.
// ---------------------------------------------------------------------------
{
  const band = buildBandLadder({ cost: 10_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  assert.deepStrictEqual(band.ladder, [11_260, 10_720, 10_630], 'the live band on a 10,000 cost');
  const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step: 100 });

  assert.deepStrictEqual(snapped.ladder, [11_200, 10_700],
    'the 10,720 and 10,630 anchors both land on 10,700 - three prices become two');
  assert.strictEqual(snapped.floor, 10_700, 'and the collapsed rung IS the new floor');
  assert.ok(snapped.floor >= band.floor, 'the collapse must not breach the floor it collapsed onto');
  for (let i = 1; i < snapped.ladder.length; i++) {
    assert.ok(snapped.ladder[i] < snapped.ladder[i - 1], 'the ladder must stay STRICTLY descending after dedupe');
  }
  ok('R4 a tight band collapses 3 rungs to 2, strictly descending, floor still safe');
}

// ---------------------------------------------------------------------------
// R5 - AN UNUSABLE STEP IS A NO-OP, byte-identical. Guards the disabled path.
// ---------------------------------------------------------------------------
{
  const band = buildBandLadder({ cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  for (const step of [undefined, null, NaN, 0, 1, -100, 'abc']) {
    const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step });
    assert.deepStrictEqual(snapped.ladder, band.ladder, `step ${String(step)} must return the ladder untouched`);
    assert.strictEqual(snapped.floor, band.floor, `step ${String(step)} must return the floor untouched`);
  }
  ok('R5 an absent / non-finite / <=1 step returns the ladder and floor byte-identically');
}

// ---------------------------------------------------------------------------
// R6 - THE OPT-IN GATE. Off, or on-but-not-allowlisted, must be byte-identical.
// ---------------------------------------------------------------------------
{
  const bare = buildBandLadder({ cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });

  const offEngine = engineWith(undefined); // no rounding block at all - the deployed default
  assert.deepStrictEqual(preview(offEngine, 30_000, 'Durian Industries').ladder, bare.ladder,
    'with no rounding config, even Durian must bid exactly as before this build');

  const gateOff = engineWith({ enabled: false, shippers: ['Durian'], step: 100 });
  assert.deepStrictEqual(preview(gateOff, 30_000, 'Durian Industries').ladder, bare.ladder,
    'master gate off must beat an allowlist entry');

  const otherShipper = engineWith(DURIAN_ON);
  assert.deepStrictEqual(preview(otherShipper, 30_000, 'Syngenta India Pvt Ltd').ladder, bare.ladder,
    'a shipper not on the allowlist must be byte-identical - rounding is a cost, never a default');

  const on = engineWith(DURIAN_ON);
  const durian = preview(on, 30_000, 'Durian Industries');
  assert.deepStrictEqual(durian.ladder, [33_700, 32_100, 31_900], 'the allowlisted shipper IS snapped');
  assert.strictEqual(durian.floor, 31_900, 'and the preview reports the snapped floor the desk will see');

  const emptyList = engineWith({ enabled: true, shippers: [], step: 100 });
  assert.deepStrictEqual(preview(emptyList, 30_000, 'Durian Industries').ladder, bare.ladder,
    'an empty allowlist means nobody, never everybody');
  ok('R6 opt-in gate: off / gate-off / other-shipper / empty-list are all byte-identical; only Durian snaps');
}

// ---------------------------------------------------------------------------
// R7 - THE CEILING. The desk is shown the SHIPPER'S number; only the capping input
// is grid-floored. And arm() must not throw its FLOOR assert on the capped ladder.
// ---------------------------------------------------------------------------
{
  const eng = engineWith(DURIAN_ON);
  const rules = { ceilingPrice: '33750.00', pricingMode: 'flat', revisionLimit: 3, minDecrement: 100 };

  const pv = preview(eng, 30_000, 'Durian Industries', rules);
  assert.strictEqual(pv.ceiling, 33_750,
    'the REPORTED ceiling must stay the shipper\'s published number - the desk must never re-price against a cap nobody published');
  for (const p of pv.ladder) {
    assert.strictEqual(p % 100, 0, `capped rung ${p} left the grid`);
    assert.ok(p <= 33_700, `capped rung ${p} exceeds the on-grid cap the engine may actually send`);
  }

  // The real arm - this is where the ladder-last-rung === plan.floor assertion lives.
  const armed = eng.arm(
    { id: 'DUR-CEIL-1', companyName: 'Durian Industries', closesAt: Date.now() + 600_000, rules },
    { cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN },
  );
  assert.ok(armed, 'arm must return a monitor, not throw a FLOOR-coded error on the ceiling cap');
  assert.strictEqual(armed.ladder[armed.ladder.length - 1], armed.floor,
    'the armed ladder\'s last rung must equal the armed floor - the invariant arm() asserts');
  assert.strictEqual(armed.floor, 31_900, 'and that floor is the SNAPPED one, not the 31,890 the band built');
  ok('R7 the desk sees the shipper\'s published ceiling, the cap is grid-floored, and arm() survives its FLOOR assert');
}

// ---------------------------------------------------------------------------
// R8 - setRounding ROUND-TRIP. Every DEFAULT_ROUNDING key must survive, because
// server.js re-applies the whole config at BOOT, not only on an operator save.
// ---------------------------------------------------------------------------
{
  const eng = engineWith(DURIAN_ON);
  const keys = Object.keys(eng.roundCfg).sort();
  assert.deepStrictEqual(keys, ['enabled', 'shippers', 'step'], 'the config surface is these three keys');

  eng.setRounding({ enabled: true, shippers: ['Durian', 'Borosil'], step: 500 });
  assert.deepStrictEqual(eng.roundCfg, { enabled: true, shippers: ['Durian', 'Borosil'], step: 500 },
    'an explicit save applies every field');

  eng.setRounding({ enabled: false });
  assert.deepStrictEqual(eng.roundCfg.shippers, ['Durian', 'Borosil'],
    'a partial save must PRESERVE the allowlist, not delete it - boot re-applies this on every start');
  assert.strictEqual(eng.roundCfg.step, 500, 'and must preserve the step');

  eng.setRounding({ step: 'abc' });
  assert.strictEqual(eng.roundCfg.step, 500, 'a garbage step keeps the current value rather than landing NaN');
  eng.setRounding({ step: 999_999 });
  assert.strictEqual(eng.roundCfg.step, 5000, 'an absurd step is clamped to the max, never applied raw');
  ok('R8 setRounding round-trips every key and a partial save never silently drops the allowlist');
}

// ---------------------------------------------------------------------------
// R9 - configStore REFUSES a bad step rather than coercing it.
// ---------------------------------------------------------------------------
{
  // Genuinely unusable: out of range, fractional, non-numeric. Refused rather than coerced, because
  // silently landing on 100 would round on a grid nobody chose.
  for (const badStep of [5001, 99.5, 'abc']) {
    assert.throws(() => validate(Object.assign(baseCfg(), { rounding: { enabled: true, shippers: ['Durian'], step: badStep } })),
      /rounding.step must be/,
      `step ${String(badStep)} must be REFUSED`);
  }
  // At or below 1 is a legal "no grid" - see R16 for why refusing it wedges every unrelated save.
  for (const offStep of [0, 1, -100]) {
    const cfg = validate(Object.assign(baseCfg(), { rounding: { enabled: true, shippers: ['Durian'], step: offStep } }));
    assert.strictEqual(cfg.rounding.step, 1, `step ${offStep} is a legal "no grid", normalised to 1`);
  }
  const good = validate(Object.assign(baseCfg(), { rounding: { enabled: true, shippers: [' Durian ', ''], step: 100 } }));
  assert.deepStrictEqual(good.rounding, { enabled: true, shippers: ['Durian'], step: 100 },
    'a valid block passes, with shipper names trimmed and blanks dropped');

  const absent = validate(baseCfg());
  assert.deepStrictEqual(absent.rounding, { enabled: false, shippers: [], step: 100 },
    'a config with no rounding block lands on the OFF default, not on rounding-everything');
  ok('R9 configStore refuses an out-of-range step and defaults a missing block to OFF');
}

// ---------------------------------------------------------------------------
// R10 - A PER-TONNE LOAD IS NEVER SNAPPED, even for an allowlisted shipper.
// The grid is in wire-amount space; a per-MT rate is not.
// ---------------------------------------------------------------------------
{
  const eng = engineWith(DURIAN_ON);
  const bare = buildBandLadder({ cost: 2_240, marginsPct: BAND, minMarginPct: MIN_MARGIN });

  // A per-tonne load is refused BOTH wire-amount-space transforms - the grid AND the min-decrement
  // re-spacing - for the one reason: a Rs 2,240/MT rate is not in the space either number is measured
  // in. So byte-identity with the bare band remains exactly the right assertion. The off-grid check
  // under it states the same claim a second way, so a future change that snaps these rungs fails here
  // even if some other transform happens to reproduce the same array.
  // Per-tonne bidding ON and an MT unit: with it off the preview now says the load will not be bid
  // and shows no prices at all (A057), which would pin nothing about the grid.
  const priorPmt = process.env.SP_PMT_BID;
  process.env.SP_PMT_BID = '1';
  let perTonne;
  try { perTonne = preview(eng, 2_240, 'Durian Industries', { pricingMode: 'per_tonne', rateType: 'PMT', unit: 'MT' }); }
  finally { if (priorPmt === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = priorPmt; }
  assert.deepStrictEqual(perTonne.ladder, bare.ladder,
    'a per-tonne ladder must be byte-identical - a 100 grid on a Rs 2,240/MT rate is a ~4% move, not a rounder figure');
  for (const p of perTonne.ladder) assert.notStrictEqual(p % 100, 0, `per-tonne rung ${p} landed on the grid`);

  const flat = preview(eng, 2_240, 'Durian Industries', { pricingMode: 'flat' });
  assert.notDeepStrictEqual(flat.ladder, bare.ladder, 'the same cost on a FLAT load IS snapped - the gate is the basis, not the number');
  for (const p of flat.ladder) assert.strictEqual(p % 100, 0, `flat rung ${p} left the grid`);
  ok('R10 a per-tonne load is refused the grid while the same cost on a flat load is snapped');
}

// ---------------------------------------------------------------------------
// R11 - THE BAND IS AN UPPER BOUND ON THE SNAP. A grid wider than the band's rupee
// span would otherwise clamp every rung UP to gridFloor and quote above the desk's
// authorised top margin. Refuse instead, and never move the opening up.
// ---------------------------------------------------------------------------
{
  let refusals = 0;
  for (const [cost, step] of [[30_000, 5000], [20_000, 5000], [7_900, 1000], [1_200, 100]]) {
    const band = buildBandLadder({ cost, marginsPct: BAND, minMarginPct: MIN_MARGIN });
    const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step });
    assert.ok(snapped.ladder[0] <= band.ladder[0],
      `snapped opening ${snapped.ladder[0]} exceeds the desk's authorised opening ${band.ladder[0]} (cost ${cost}, step ${step})`);
    if (!snapped.applied) {
      refusals += 1;
      assert.strictEqual(snapped.reason, 'grid_wider_than_band', 'a refusal must name why');
      assert.deepStrictEqual(snapped.ladder, band.ladder, 'a refused snap returns the ladder untouched');
      assert.strictEqual(snapped.floor, band.floor, 'a refused snap returns the floor untouched');
    }
  }
  assert.ok(refusals >= 3, `expected the wide-grid cases to refuse, got ${refusals} refusals`);

  // And the general invariant across the R1 sweep: never quote above the band.
  for (const cost of [800, 1000, 4321, 9999, 10_000, 17_500, 30_000, 123_456, 987_654]) {
    for (const step of [10, 50, 100, 500, 1000]) {
      const band = buildBandLadder({ cost, marginsPct: BAND, minMarginPct: MIN_MARGIN });
      const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step });
      assert.ok(snapped.ladder[0] <= band.ladder[0],
        `snapped opening exceeded the band opening at cost ${cost}, step ${step}`);
    }
  }
  ok('R11 a grid wider than the band is refused, and no snapped opening ever exceeds the desk\'s own opening');
}

// ---------------------------------------------------------------------------
// R12 - A FRACTIONAL STEP IS NOT A GRID. It would put non-integer rupees on the
// wire, which Math.round then turns back into odd figures - defeating the feature.
// ---------------------------------------------------------------------------
{
  const band = buildBandLadder({ cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  const snapped = roundLadderToGrid({ ladder: band.ladder, floor: band.floor, step: 99.5 });
  assert.strictEqual(snapped.applied, false, 'a fractional step must not snap');
  assert.deepStrictEqual(snapped.ladder, band.ladder, 'and must return the ladder untouched');

  assert.throws(() => validate(Object.assign(baseCfg(), { rounding: { enabled: true, shippers: ['Durian'], step: 99.5 } })),
    /rounding.step must be/, 'configStore must reject a fractional step the way it rejects 5001');

  const eng = engineWith({ enabled: true, shippers: ['Durian'], step: 99.5 });
  assert.strictEqual(eng.roundCfg.step, 100, 'a fractional env step falls back to the default rather than reaching the snapper');
  ok('R12 a fractional step is refused at the snapper, rejected by configStore, and coerced away at boot');
}

// ---------------------------------------------------------------------------
// R13 - step <= 1 MEANS "NO GRID" AT EVERY LAYER. It used to mean three things:
// no-op in pricing, "use 100" in the engine, and a hard save error in configStore.
// ---------------------------------------------------------------------------
{
  const eng = engineWith({ enabled: true, shippers: ['Durian'], step: 1 });
  assert.strictEqual(eng.roundCfg.step, null, 'a step of 1 is an explicit request for NO grid, not the 100 default');
  const bare = buildBandLadder({ cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  assert.deepStrictEqual(preview(eng, 30_000, 'Durian Industries').ladder, bare.ladder,
    'and it must actually leave the ladder alone rather than snapping to 100');

  const eng2 = engineWith(DURIAN_ON);
  eng2.setRounding({ step: 1 });
  assert.strictEqual(eng2.roundCfg.step, null, 'setRounding honours the same meaning');
  eng2.setRounding({ step: 'abc' });
  assert.strictEqual(eng2.roundCfg.step, null, 'a garbage step keeps the current value (now null), never silently becomes a grid');

  // Only a real number or a non-blank string may ask for "no grid". Number() maps all of these to 0,
  // which would otherwise read as an explicit request from a value expressing no intent at all.
  for (const notAnIntent of [null, '', '   ', false, []]) {
    const e = engineWith({ enabled: true, shippers: ['Durian'], step: notAnIntent });
    assert.strictEqual(e.roundCfg.step, 100,
      `${JSON.stringify(notAnIntent)} must fall back to the default, not be read as "no grid"`);
  }
  ok('R13 step <= 1 means "no grid" consistently at the snapper, the constructor and setRounding');
}

// ---------------------------------------------------------------------------
// R14 - THE GRID ROUND-TRIPS ON THE INTENT. Enabling the feature needs a restart;
// if the ladder were rebuilt from live config the restart would re-plan in-flight
// loads onto new prices and remapFiredRungs (which matches by PRICE) would lose
// every fired rung, so the monitor would re-establish above its own standing bid.
// ---------------------------------------------------------------------------
{
  const armedUnderGrid = engineWith(DURIAN_ON);
  const meta = { id: 'DUR-RT-1', companyName: 'Durian Industries', closesAt: Date.now() + 600_000, rules: null };
  const m = armedUnderGrid.arm(meta, { cost: 30_000, marginsPct: BAND, minMarginPct: MIN_MARGIN });
  assert.deepStrictEqual(m.ladder, [33_700, 32_100, 31_900], 'armed under the grid');

  const intent = armedUnderGrid.scheduler.activeIntents().find((i) => i.auctionId === 'DUR-RT-1');
  assert.ok(intent, 'the arm must have persisted an intent');
  assert.strictEqual(intent.roundStep, 100, 'the effective grid is persisted alongside cost/marginsPct');

  // The restart case: a process where rounding is OFF replays the same intent.
  const afterRestart = engineWith(undefined);
  const { meta: m2, inputs: i2 } = afterRestart._intentToArm(intent);
  const replanned = afterRestart._planFor(i2, m2.rules, m2.companyName).plan;
  assert.deepStrictEqual(replanned.ladder, m.ladder,
    'the rehydrated ladder must match the one the load was armed with, not the live config');

  // And the mirror: an intent predating the field resolves from config rather than pinning to "no grid".
  const legacy = Object.assign({}, intent); delete legacy.roundStep;
  const onNow = engineWith(DURIAN_ON);
  const { meta: m3, inputs: i3 } = onNow._intentToArm(legacy);
  assert.strictEqual(i3.roundStep, undefined, 'an intent with no roundStep key must not be pinned to null');
  assert.deepStrictEqual(onNow._planFor(i3, m3.rules, m3.companyName).plan.ladder, [33_700, 32_100, 31_900],
    'a pre-field intent resolves the grid from config, exactly as before this change');
  ok('R14 the effective grid persists on the intent and a rehydrate rebuilds the identical ladder');
}

// ---------------------------------------------------------------------------
// R15 - A REFUSED GRID MUST NOT LEAVE THE CEILING IN GRID SPACE. The ladder stays
// un-snapped when the grid is refused, so a grid-floored cap would compare two
// different spaces and stand the bot down on a load it could profitably win.
// ---------------------------------------------------------------------------
{
  const rules = { ceilingPrice: '22000.00', pricingMode: 'flat', revisionLimit: 3, minDecrement: 100 };
  const off = preview(engineWith(undefined), 20_000, 'Durian Industries', rules);
  // step 5000 on a 20,000 cost is refused by R11's rule, so the ladder is the un-snapped one.
  const on = preview(engineWith({ enabled: true, shippers: ['Durian'], step: 5000 }), 20_000, 'Durian Industries', rules);

  assert.ok(on.ladder.length > 0,
    'a refused grid must not turn into a stand-down: there is real margin under this ceiling');
  assert.notStrictEqual(on.willNotBid, 'ceiling_below_floor', 'the bot must not report "cannot win profitably" here');
  assert.deepStrictEqual(on.ladder, off.ladder,
    'with the grid refused the ladder AND its cap must match the un-rounded plan exactly');
  ok('R15 a refused grid leaves the ceiling in rupee space - no stand-down on a winnable load');
}

// ---------------------------------------------------------------------------
// R16 - A DOCUMENTED "NO GRID" VALUE MUST NOT WEDGE UNRELATED SAVES. validate()
// runs over the whole merged doc, and the boot defaults come from an unvalidated
// env var - so a rejected step blocks saving margins, recipients, everything.
// ---------------------------------------------------------------------------
{
  const saved = validate(Object.assign(baseCfg(), { rounding: { enabled: true, shippers: ['Durian'], step: 1 } }));
  assert.strictEqual(saved.rounding.step, 1, 'step 1 is a legal "no grid", normalised to one spelling');

  // The wedge: a config whose rounding block came from a bad env var must still let an unrelated
  // panel save. defaultsFrom is the seam that sanitises it.
  for (const envStep of [1, 0, 0.5, 99.5, 10_000, 'abc', undefined]) {
    const defaults = defaultsFrom({
      marginsPct: BAND, minMarginPct: MIN_MARGIN, allowlist: { shippers: [], lanes: [], hardCloseOnly: true },
      antiDetection: { enabled: true, cadenceJitterMs: 250, openJitterMs: 250, maxBidsPerMin: 20, minInterFireMs: 150 },
      softClose: { enabled: false, shippers: [], mode: 'shadow', reserve: 1 },
      rounding: { enabled: true, shippers: ['Durian'], step: envStep },
      notifyMode: 'dashboard', discoveryIntervalMs: 30_000, priceDeadlineLeadMs: 90_000, reminderLeadMs: 60_000,
      recipients: [],
    });
    assert.doesNotThrow(() => validate(Object.assign(defaults, { notifyMode: 'whatsapp' })),
      `env step ${String(envStep)} must not block an unrelated Settings save`);
  }
  ok('R16 a bad or "no grid" env step never wedges the operator out of saving unrelated settings');
}

for (const p of TMPS) { try { fs.unlinkSync(p); } catch (_) {} }
console.log(`\nround-figure quoting: ${passed}/${EXPECTED} cases passed\n`);
