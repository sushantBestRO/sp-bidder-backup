'use strict';
/**
 * ENGINE + LADDER INVARIANTS - the suite's first PROPERTY test.
 *
 * Every other scripts/test-*.js in here pins a NAMED case: "for THIS state, expect THAT decision".
 * This file asserts the other half - "for ALL auctions of this shape, THIS must hold" - by generating
 * bounded random auctions and driving the real BidEngine through them end to end. Where a sequence
 * test proves the engine does the right thing on the fifteen situations somebody thought of, this one
 * proves it never does a specifically WRONG thing on any of the several hundred nobody did.
 *
 * WHY THERE IS NO PROPERTY-TEST LIBRARY HERE. This package has ZERO devDependencies by deliberate
 * design (plain node + the built-in `assert`), and a bidding bot on live money is not the place to
 * take a new transitive dependency tree for test sugar. So the generator is a hand-rolled seeded LCG.
 * It is seeded with a FIXED constant, so a run is byte-reproducible: a flaky test on a money path is
 * worse than no test at all. The seed is printed on failure so a counterexample replays exactly.
 * Math.random() is never called and the wall clock is never read for a decision - this machine's
 * clock drift is documented to flip SIGN day to day, so a wall-clock-derived generator would make
 * "does it pass" a function of what time it is. The engine runs against a VIRTUAL clock (Date.now is
 * swapped for the duration and restored in cleanup) and a stubbed placeBid that records every write.
 * No network, no real adapter, no sleeps.
 *
 * THE EIGHT PROPERTIES
 *
 *   P1  FLOOR IS ABSOLUTE. Over any generated auction - any ladder shape, any rejection sequence,
 *       any rank sequence, any close model - no amount handed to placeBid is ever below the operating
 *       floor, the operating floor is never below true cost, and the floor is always the last rung.
 *   P2  assertAboveFloor IS EXACT AT THE BOUNDARY. It throws for price < floor and returns for
 *       price >= floor, for any generated pair. (price === floor must NOT throw.)
 *   P3  A HOSTILE COUNTDOWN NEVER PUTS A NON-PRICE ON THE WIRE. A non-finite countdown is held
 *       before any rung is chosen (it used to reach ladder[NaN], with only the floor assert in the
 *       way). Property: for a hostile countdown, either nothing is written or the amount written is
 *       finite and >= floor, and every non-finite one ends held with the desk told.
 *   P4  PRICES ARE MONOTONICALLY NON-INCREASING. Across one auction, each successive ACCEPTED price
 *       is <= the previous one. A descending ladder that ever steps UP is a defect.
 *   P5  selectRung's WALK-DOWN IS BOUNDED, TERMINATING, AND NEVER RE-OFFERS A SPENT RUNG.
 *   P6  WRITE COUNT IS BOUNDED, with concrete ceilings - not merely "finite".
 *   P7  NO NaN / NEGATIVE / ABSURD DERIVED TIMING, including on SuperProcure's year-2100 placeholder
 *       close time, which parses as a VALID date and therefore defeats every NaN guard.
 *   P8  NO SILENT FORFEIT. A load that was armed, priced and still has budget never closes having
 *       written nothing; and under persistent price/state refusal the ladder walks all the way DOWN
 *       to the floor instead of freezing at one price.
 *
 * WHAT THE GENERATOR IS CONSTRAINED TO. Generating arbitrary numbers at this engine would mostly test
 * the input guards, so every dimension is drawn from the PRODUCTION domain recorded on the box:
 * trigger windows of 100-200 SECONDS (not the 2,500ms floor window); extendMs from the observed set
 * {0 (Renewsys, can never extend), 60s, 120s, 180s (Havells)}; revisionLimit from {3 (Dynamic Cables,
 * Vishal, Premier), 5, 10, 30 (Havells), 50}; minDecrement from the observed {100, 500, 1000, 1500};
 * ladders of 3 to 30 rungs; and rank that is NULL until one of our own bids actually LANDS, because
 * SuperProcure's socket only self-matches the routed carrier after it has bid as that carrier. The
 * platform never reveals a rival's price on these loads (standingPriceVisible false), so nothing here
 * models a competitor - only our own rank, our own ladder, and the load's own published mechanics.
 *
 * ONE INVARIANT FROM THE BRIEF DID NOT SURVIVE CONTACT, and it is recorded here rather than quietly
 * weakened. "If an auction runs to close with rungs remaining and we are not rank 1, the floor rung is
 * eventually offered" is FALSE on the rank-driven fine ladder, BY DESIGN: selectRung('snipe') fires
 * the HIGHEST rung that still wins rather than dumping the floor, so a 30-rung allowlisted load
 * closing at rank 2 stops around rung 17 with the floor unspent and budget in hand. That is the
 * documented rank-aware endgame, not a defect. P8 therefore asserts the generalisation that IS true
 * and IS what the production loads lost money to: never zero writes, and never frozen at one price.
 *
 *   node scripts/test-engine-ladder-invariants.js
 */

// Silence the engine's operational logger for the sweep. currentThreshold() re-reads this per log
// call, so setting it here covers everything downstream. Without it a few hundred generated auctions
// print several thousand warn/error lines and the actual assertions become unfindable.
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { buildBandLadder, selectRung, assertAboveFloor } = require('../src/engine/pricing');

// ---------------------------------------------------------------------------------------------
// SEED. Fixed on purpose. Change it only to hunt for new counterexamples, never to make a red run
// green - a property that only holds for one seed is not a property. Printed on any failure.
// ---------------------------------------------------------------------------------------------
const SEED = 0x5EEDBEEF;

/**
 * A 32-bit linear congruential generator (Numerical Recipes constants), returning [0, 1).
 * Deliberately tiny and deliberately NOT crypto: what is needed is a reproducible stream, and an LCG
 * is the smallest thing that gives one without a dependency. Math.imul keeps the multiply in 32-bit
 * space so the sequence is identical on every platform and node version.
 */
function mkRng(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const intIn = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

// ---------------------------------------------------------------------------------------------
// COMPLETION SENTINEL - registered BEFORE any case runs.
//
// scripts/run-tests.js grades this file by EXIT CODE ONLY. A generator loop that returns early, or an
// unhandled rejection that leaves the process to exit 0 on an empty event loop, would read as a
// silent green zero-assertion pass - the worst possible outcome for a money-path test. So the
// expected property count is registered here, at the top of the file, and checked on 'exit'. A
// bottom-of-IIFE registration would be just as broken as an inline assert, because the very failure
// mode being guarded against is the bottom never being reached. Setting process.exitCode inside an
// 'exit' listener overrides an explicit process.exit(0), which is what makes this work.
// ---------------------------------------------------------------------------------------------
const EXPECTED_PROPERTIES = 8;
let passed = 0;
let reachedEnd = false;
process.on('exit', () => {
  if (reachedEnd && passed === EXPECTED_PROPERTIES) return;
  console.error(`\n*** SENTINEL: ${passed}/${EXPECTED_PROPERTIES} properties completed`
    + `${reachedEnd ? '' : ' and the suite never reached its end'} - this run is NOT a pass.`);
  console.error(`*** seed = 0x${SEED.toString(16).toUpperCase()}`);
  process.exitCode = 1;
});
const ok = (n) => { console.log('  ok  ' + n); passed++; };

// ---------------------------------------------------------------------------------------------
// Virtual clock + temp files.
// ---------------------------------------------------------------------------------------------
const REAL_NOW = Date.now;
let NOW = 1_700_000_000_000; // a fixed virtual epoch; never the wall clock
const CLEAN = [];
let fileSeq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `pbt-ladder-${process.pid}-${fileSeq++}.json`);
  CLEAN.push(f);
  return f;
};
function cleanup() {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
}

// SuperProcure's year-2100 placeholder close time, verbatim from the live records. It PARSES as a
// valid date, which is precisely why every NaN guard misses it and why it once produced wrong
// displays, forever-armed loads AND silent zero-bid misses.
const YEAR_2100_MS = Date.parse('2100-05-24T19:53:25.000Z');

// ---------------------------------------------------------------------------------------------
// GENERATOR - one auction spec, every dimension drawn from the production domain.
// ---------------------------------------------------------------------------------------------
function genMargins(rng) {
  const n = intIn(rng, 2, 4);            // the desk bands in production carry 2-4 anchors
  let v = 6 + rng() * 16;                // top anchor 6-22% (live Havells band opens at 12.6)
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push(Math.round(v * 10) / 10);
    v = Math.max(0.4, v - (0.5 + rng() * 5));
  }
  // Hand them in a RANDOM order some of the time: buildBandLadder normalises to descending, and the
  // normalisation is part of what is under test.
  if (rng() < 0.3) out.reverse();
  return out;
}

function genSpec(rng, i) {
  const marginsPct = genMargins(rng);
  // minMarginPct: usually absent (defaults to the band's lowest). 15% of the time it is the
  // documented env-typo / stale-config shape - zero or negative - which MUST clamp to true cost.
  const minMarginPct = rng() < 0.15 ? pick(rng, [-5, 0, -0.5, -12]) : undefined;
  const cost = intIn(rng, 8_000, 400_000);
  const band = buildBandLadder({ cost, marginsPct, minMarginPct });
  const ceilingMode = pick(rng, ['none', 'none', 'none', 'none', 'above', 'mid', 'below']);
  const spread = Math.max(1, band.opening - band.floor);
  let ceilingPrice = null;
  if (ceilingMode === 'above') ceilingPrice = band.opening + Math.round(spread * 0.5) + 100;
  else if (ceilingMode === 'mid') ceilingPrice = band.floor + Math.round(spread * 0.5);
  else if (ceilingMode === 'below') ceilingPrice = Math.max(1, band.floor - intIn(rng, 100, 5_000));
  return {
    id: `PBT-${i}`,
    cost, marginsPct, minMarginPct, band, ceilingMode, ceilingPrice,
    closeModel: pick(rng, ['hard', 'soft', 'soft', 'soft']),
    // The rung-expansion / rank-driven allowlist. Off = the DEPLOYED path every non-opted customer
    // runs today; on = the rank-driven endgame + fine ladder.
    allowlisted: rng() < 0.5,
    mode: rng() < 0.12 ? 'shadow' : 'live',
    revisionLimit: pick(rng, [3, 3, 5, 10, 30, 50]),          // observed live caps
    minDecrement: pick(rng, [100, 100, 500, 1_000, 1_500]),   // observed live Bid Difference
    extendMs: pick(rng, [0, 60_000, 120_000, 180_000, 180_000]),
    extendCapPublished: pick(rng, [null, 0, 1, 2, 3, 5, 10]), // null = UNKNOWN cap (fail closed)
    // Real soft branches publish 100-200 SECONDS. 0 is Havells-hard (a hard window wearing a soft
    // close model); null is a branch that publishes none, where no window may be invented.
    triggerWindowMs: pick(rng, [null, 0, 100_000, 120_000, 150_000, 180_000, 200_000]),
    openMs: intIn(rng, 120_000, 420_000),
    rttMs: intIn(rng, 20, 800),
    outcome: pick(rng, ['accept', 'accept', 'accept', 'reject_price', 'reject_first',
      'rate_limited_then_accept', 'throw_then_accept', 'reject_not_biddable', 'reject_cap']),
    rankMode: pick(rng, ['outranked', 'outranked', 'win_after_bid', 'blind_forever', 'flip']),
    outrankedAt: intIn(rng, 2, 6),
    // SuperProcure publishing its year-2100 placeholder as the close time for the first K frames.
    placeholderFrames: rng() < 0.15 ? intIn(rng, 1, 4) : 0,
    seedForJitter: Math.floor(rng() * 0xFFFFFFFF),
  };
}

// ---------------------------------------------------------------------------------------------
// THE DRIVER - run one generated auction to close against the real engine.
//
// The tick loop is driven by the ENGINE'S OWN cadence: _schedule is replaced with a recorder, and the
// virtual clock is advanced by exactly the delay the engine asked for. That is deliberate - it means
// _cadence is under test on every single tick (P7) rather than being bypassed by a fixed step, and it
// means a cadence that ever returned a negative or NaN delay would stall or corrupt the sweep
// visibly instead of being papered over.
//
// The anti-snipe mechanic is modelled the way the branch actually behaves: a bid that LANDS with less
// than triggerWindowMs remaining pushes the close out by extendMs, until the branch's extend count is
// used up. So extensions here are CAUSED by our own bids, exactly as the live mechanic causes them.
// ---------------------------------------------------------------------------------------------
const MAX_TICKS = 4_000;

async function runAuction(spec) {
  const rng = mkRng(spec.seedForJitter);
  const writes = [];   // every placeBid call: { price, opts, accepted, atMs, remaining }
  const events = [];
  let closeAt = NOW + spec.openMs;
  let framesServed = 0;
  let extendsUsed = 0;
  let myRank = null;
  let landed = 0;
  let attempt = 0;
  const realCap = spec.extendCapPublished == null ? 3 : spec.extendCapPublished;
  const trig = spec.triggerWindowMs;

  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: spec.minDecrement,
      revisionLimit: spec.revisionLimit, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => {
      framesServed += 1;
      // The year-2100 placeholder rides the ABSOLUTE close field while the countdown stays real -
      // the shape that produced the forever-armed loads, because it parses as a valid date.
      const usePlaceholder = framesServed <= spec.placeholderFrames;
      return {
        ok: true,
        status: (closeAt - NOW) <= 0 ? 'closed' : 'live',
        myRank,
        totalBidders: 4,
        standingL1Price: null,
        closesInMs: closeAt - NOW,
        closesAtMs: usePlaceholder ? YEAR_2100_MS : closeAt,
        revisionLimit: spec.revisionLimit,
        revisionsLeft: null,             // SuperProcure exposes none; realAdapter hardcodes null
        closeModel: spec.closeModel,
        extendMs: spec.extendMs,
        extendCount: spec.extendCapPublished,
        triggerWindowMs: spec.triggerWindowMs,
        measuredRttMs: spec.rttMs,
      };
    },
    placeBid: async (id, price, opts) => {
      attempt += 1;
      const rec = { price, opts, accepted: false, atMs: NOW, remaining: closeAt - NOW };
      writes.push(rec);
      if (spec.outcome === 'reject_not_biddable') {
        return { accepted: false, reason: 'Load not available for bidding',
          text: 'Load not available for bidding', status: 400 };
      }
      if (spec.outcome === 'reject_cap') {
        return { accepted: false, reason: 'Bid limit exceeded', text: 'Bid limit exceeded', status: 400 };
      }
      if (spec.outcome === 'reject_price') {
        return { accepted: false, reason: 'Amount is invalid', text: 'Amount is invalid', status: 400 };
      }
      if (spec.outcome === 'reject_first' && attempt <= 2) {
        return { accepted: false, reason: 'Amount is invalid', text: 'Amount is invalid', status: 400 };
      }
      if (spec.outcome === 'rate_limited_then_accept' && attempt <= 3) {
        return { accepted: false, reason: 'rate_limited', retryAfterMs: 500, status: 429 };
      }
      if (spec.outcome === 'throw_then_accept' && attempt === 1) {
        throw new Error('socket hang up');
      }
      // ACCEPTED. The anti-snipe extension is caused by OUR OWN landing bid, as on the real branch.
      landed += 1;
      if (spec.closeModel === 'soft' && spec.extendMs > 0 && trig != null && trig > 0
          && (closeAt - NOW) <= trig && extendsUsed < realCap) {
        closeAt += spec.extendMs;
        extendsUsed += 1;
      }
      if (spec.rankMode === 'win_after_bid') myRank = 1;
      else if (spec.rankMode === 'outranked') myRank = spec.outrankedAt;
      else if (spec.rankMode === 'flip') myRank = (landed % 2 === 0) ? 1 : spec.outrankedAt;
      // 'blind_forever' leaves myRank null: the socket never self-matched us. This is the exact
      // shape of the three Alwar loads that closed with the floor unspent.
      rec.accepted = true;
      return { accepted: true, myRank, revisionsLeft: null, latencyMs: 20 };
    },
  };

  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, maxBidsPerMin: 20 },
    softClose: {
      enabled: true,
      shippers: spec.allowlisted ? ['Havells'] : ['SomeoneElse'],
      mode: spec.mode,
      reserve: 1,
    },
    onEvent: (e) => events.push(e),
    rand: rng, // seeded: cadence + establish jitter are reproducible
  });

  const cadences = [];
  let nextDelay = null;
  eng._schedule = (m, d) => { nextDelay = d; cadences.push(d); };

  const meta = {
    id: spec.id,
    lane: { origin: 'ALWAR', destination: 'Manimajra' },
    units: 1,
    companyName: 'Havells',
    branchName: 'ALWAR',
    closesAt: closeAt,
    rules: { revisionLimit: spec.revisionLimit, minDecrement: spec.minDecrement,
      ceilingPrice: spec.ceilingPrice },
  };
  const m = eng.arm(meta, { cost: spec.cost, marginsPct: spec.marginsPct,
    minMarginPct: spec.minMarginPct });

  let ticks = 0;
  while (!m.finalized && ticks < MAX_TICKS) {
    nextDelay = null;
    await eng._tick(m);
    ticks += 1;
    if (m.finalized) break;
    // A cadence that is not a usable delay is itself a failure - assert it at the point of use so
    // the sweep can never silently spin on a NaN or walk backwards on a negative.
    assert.ok(Number.isFinite(nextDelay) && nextDelay >= 0 && nextDelay <= 60_000,
      `${spec.id}: engine rescheduled with an unusable delay ${nextDelay}`);
    NOW += Math.max(1, Math.round(nextDelay));
  }

  const kinds = new Set(events.filter((e) => e.type === 'alert').map((e) => e.kind));
  const startedAt = closeAt - spec.openMs;
  return {
    spec, monitor: m, writes, events, kinds, ticks, cadences,
    finalized: m.finalized,
    spanMs: NOW - startedAt,
    terminal: kinds.has('load_not_biddable') || kinds.has('bid_cap_exhausted'),
  };
}

// ---------------------------------------------------------------------------------------------
(async () => {
  const t0 = REAL_NOW();
  Date.now = () => NOW;

  // =============================================================================================
  // THE SWEEP. One corpus of generated auctions; P1, P4, P6 and P8 all read it, so the expensive
  // part (driving the real engine to close) is paid once.
  // =============================================================================================
  const N_AUCTIONS = 120;
  const specRng = mkRng(SEED);
  const runs = [];
  for (let i = 0; i < N_AUCTIONS; i++) {
    NOW = 1_700_000_000_000 + i * 86_400_000; // a fresh virtual day per auction; never the wall clock
    runs.push(await runAuction(genSpec(specRng, i)));
  }

  // ---- P1. FLOOR IS ABSOLUTE -------------------------------------------------------------------
  // The one invariant in this codebase that should never be in question. assertAboveFloor throws a
  // FLOOR-coded error if a bid price is below the floor; the property is that it never NEEDS to.
  //
  // Kills: buildBandLadder's per-rung `Math.max(operatingFloor, ...)` flipped to Math.min; the
  // `Math.max(trueCost, marginFloor)` clamp flipped or deleted (a negative minMarginPct then drags
  // the operating floor under cost - a guaranteed-loss bid); dropping the "floor is always the last
  // rung" push; capLadderToCeiling raising the floor rung.
  {
    let checked = 0;
    for (const r of runs) {
      const m = r.monitor;
      const floor = m.floor;
      assert.ok(Number.isFinite(floor) && floor > 0, `${r.spec.id}: floor is not a finite positive number (${floor})`);
      // The OPERATING floor can never sit below true cost, however badly minMarginPct is configured.
      assert.ok(floor >= Math.round(r.spec.cost),
        `${r.spec.id}: operating floor ${floor} is below true cost ${Math.round(r.spec.cost)} `
        + `(minMarginPct=${r.spec.minMarginPct})`);
      // Ladder structure: strictly descending, every rung at or above the floor, floor is last.
      for (let i = 1; i < m.ladder.length; i++) {
        assert.ok(m.ladder[i] < m.ladder[i - 1],
          `${r.spec.id}: ladder is not strictly descending at ${i}: ${JSON.stringify(m.ladder)}`);
      }
      for (const rung of m.ladder) {
        assert.ok(Number.isFinite(rung) && rung >= floor,
          `${r.spec.id}: rung ${rung} is below the floor ${floor}`);
      }
      assert.strictEqual(m.ladder[m.ladder.length - 1], floor,
        `${r.spec.id}: the floor is not the last rung`);
      // And the thing that actually matters: no amount below the floor ever reached the seam.
      for (const w of r.writes) {
        assert.ok(typeof w.price === 'number' && Number.isFinite(w.price),
          `${r.spec.id}: placeBid was handed a non-finite amount ${String(w.price)}`);
        assert.ok(w.price >= floor,
          `${r.spec.id}: placeBid was handed ${w.price}, below the floor ${floor}`);
        assert.ok(m.ladder.includes(w.price),
          `${r.spec.id}: placeBid was handed ${w.price}, which is not a rung of ${JSON.stringify(m.ladder)}`);
        checked += 1;
      }
      // The floor guard is a backstop, not a working part - it must never have had to fire.
      assert.ok(!r.kinds.has('floor_breach_blocked'),
        `${r.spec.id}: the engine built a sub-floor bid and assertAboveFloor caught it`);
      assert.ok(!r.kinds.has('ceiling_breach_blocked'),
        `${r.spec.id}: the engine built an over-ceiling bid`);
    }
    assert.ok(checked >= 100,
      `P1 is near-vacuous: only ${checked} amounts reached the seam across ${N_AUCTIONS} auctions`);
    ok(`P1 floor is absolute: ${checked} generated bid amounts across ${N_AUCTIONS} auctions, none below the `
      + 'operating floor, no operating floor below true cost, floor always the last rung');
  }

  // ---- P2. assertAboveFloor IS EXACT AT THE BOUNDARY --------------------------------------------
  // Kills: `!(price >= costFloor)` weakened to `!(price > costFloor)` (throws on the legal
  // price === floor, which is the FLOOR SNIPE ITSELF - the single most important bid of the auction);
  // strengthened to `price < costFloor - 1`; the throw deleted outright.
  {
    const rng = mkRng(SEED ^ 0x11111111);
    let below = 0, atOrAbove = 0;
    for (let i = 0; i < 300; i++) {
      const floor = intIn(rng, 1, 500_000);
      // Draw the price RELATIVE to the floor so the boundary is hit often - an unconstrained pair
      // would almost never land on price === floor, which is the case a comparator flip breaks.
      const delta = pick(rng, [-intIn(rng, 1, 10_000), -1, 0, 0, 1, intIn(rng, 1, 10_000)]);
      const price = floor + delta;
      if (price < floor) {
        below += 1;
        assert.throws(() => assertAboveFloor(price, floor),
          (e) => e && e.code === 'FLOOR',
          `assertAboveFloor(${price}, ${floor}) must throw a FLOOR-coded error`);
      } else {
        atOrAbove += 1;
        assert.strictEqual(assertAboveFloor(price, floor), price,
          `assertAboveFloor(${price}, ${floor}) must return the price untouched`);
      }
    }
    // A non-finite amount must fail CLOSED, not sail through - this is the ladder[NaN] case P3 drives.
    for (const bad of [undefined, NaN, null, 'x']) {
      assert.throws(() => assertAboveFloor(bad, 1_000), (e) => e && e.code === 'FLOOR',
        `assertAboveFloor(${String(bad)}, 1000) must fail closed`);
    }
    // AND THE SAME HOSTILITY IN THE FLOOR POSITION, which nothing in this suite used to drive: the
    // floor only ever received intIn(rng, 1, 500_000), so the operand that decides how low a bid may
    // go was the one operand never tested with a non-number. Every value here coerces to 0 or NaN
    // under a bare relational compare, i.e. "there is no floor" - Number(null), Number(''),
    // Number([]) and Number(false) are all 0. An unknown floor is not a floor of zero.
    for (const bad of [undefined, null, NaN, '', ' ', [], false, 'x']) {
      assert.throws(() => assertAboveFloor(5_000, bad), (e) => e && e.code === 'FLOOR',
        `assertAboveFloor(5000, ${JSON.stringify(bad)}) must fail closed - an unknown floor is not zero`);
    }
    assert.ok(below >= 50 && atOrAbove >= 50, `P2 generated a lopsided sample (${below}/${atOrAbove})`);
    ok(`P2 assertAboveFloor is exact at the boundary: 300 generated pairs (${below} below / ${atOrAbove} at-or-above) `
      + 'plus four non-finite amounts and eight non-numeric floors, all fail closed or pass through exactly');
  }

  // ---- P3. A HOSTILE COUNTDOWN NEVER PUTS A NON-PRICE ON THE WIRE ------------------------------
  // A hostile countdown is not hypothetical: SuperProcure's year-2100 placeholder is documented, and
  // any close-time field that fails to parse yields NaN. On the DEPLOYED (non-allowlisted) hard
  // step-down path a non-finite `closesInMs` made _scheduledRungIndex return NaN and ladder[NaN]
  // `undefined`, with assertAboveFloor the only thing between that and the wire. A non-finite
  // countdown is now UNKNOWN and _maybeBid holds the load before any rung is chosen (owner ruling,
  // A087), so the non-finite drives must end held; the finite ones (year 2100, +-1e18) must write
  // only real ladder prices.
  {
    const rng = mkRng(SEED ^ 0x22222222);
    let drives = 0, refusals = 0, held = 0, nonFinite = 0;
    for (let i = 0; i < 120; i++) {
      NOW = 1_800_000_000_000 + i * 3_600_000;
      const cost = intIn(rng, 8_000, 400_000);
      const marginsPct = genMargins(rng);
      const writes = [];
      const adapter = {
        capabilities: () => ({ standingPriceVisible: false, minDecrement: 100,
          revisionLimit: 30, closeModel: 'unknown' }),
        ensureSession: async () => ({}),
        getAuctionState: async () => ({ ok: false }),
        placeBid: async (id, price) => { writes.push(price); return { accepted: true, myRank: 2, revisionsLeft: null }; },
      };
      const heldAlerts = [];
      const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
        config: { openAtMs: 15_000, floorWindowMs: 2_500 },
        softClose: { enabled: false },   // the deployed, non-allowlisted clock-scheduled step-down
        onEvent: (e) => { if (e && e.type === 'alert' && e.kind === 'close_unknown_held') heldAlerts.push(e); },
        rand: mkRng(SEED ^ i),
      });
      eng._schedule = () => {};
      const m = eng.arm({ id: `NAN-${i}`, lane: { origin: 'A', destination: 'B' }, units: 1,
        companyName: 'SomeoneElse', closesAt: NOW + 600_000 }, { cost, marginsPct });
      m.closeModel = 'hard';
      // Stand on rung 0 with something on the board, so _decide falls through to the step-down.
      m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = m.ladder[0]; m.landedBids = 1;
      const hostile = pick(rng, [NaN, undefined, YEAR_2100_MS - NOW, 1e18, -1e18]);
      const state = { closesInMs: hostile, myRank: intIn(rng, 2, 8), minDecrement: 100,
        standingL1Price: null, measuredRttMs: 60 };
      // Every derived timing value stays usable even here (the P7 predicates, at the fire point).
      const cad = eng._cadence(hostile, m);
      assert.ok(Number.isFinite(cad) && cad >= 0, `NAN-${i}: cadence ${cad} on a hostile countdown`);
      assert.strictEqual(typeof eng._isLastChance(hostile), 'boolean');
      let code = null;
      try { await eng._maybeBid(m, state); } catch (e) { code = e && e.code; }
      drives += 1;
      if (code === 'FLOOR') refusals += 1;
      if (!Number.isFinite(hostile)) {
        nonFinite += 1;
        if (writes.length === 0 && heldAlerts.length === 1) held += 1;
      }
      // THE PROPERTY: nothing was written, or what was written is a real, finite, at-or-above-floor
      // rung price. Never `undefined`, never NaN.
      for (const p of writes) {
        assert.ok(typeof p === 'number' && Number.isFinite(p) && p >= m.floor && m.ladder.includes(p),
          `NAN-${i}: a hostile countdown (${String(hostile)}) put ${String(p)} on the wire `
          + `(floor ${m.floor}, ladder ${JSON.stringify(m.ladder)})`);
      }
    }
    assert.ok(nonFinite > 0 && held === nonFinite,
      `P3: ${held} of ${nonFinite} non-finite countdowns were held with nothing written and the desk told`);
    ok(`P3 a hostile countdown never puts a non-price on the wire: ${drives} drives (NaN / undefined / the `
      + `year-2100 placeholder / +-1e18), ${held} non-finite held, ${refusals} refused at the floor guard, `
      + 'zero undefined amounts on the wire');
  }

  // ---- P4. PRICES ARE MONOTONICALLY NON-INCREASING ----------------------------------------------
  // Scoped to ACCEPTED bids, deliberately and with a reason: on a non-cap REJECTION the engine rolls
  // currentRungIndex back (the D3 repair) so the establish branch can reopen, which legitimately
  // re-attempts a HIGHER rung than one SuperProcure just refused. Nothing stood on the board for that
  // higher price, so our standing bid never rose - and the standing bid is what the invariant is
  // about. Asserting monotonicity over ATTEMPTS instead would fail on correct code.
  //
  // Kills: `currentRungIndex = Math.max(currentRungIndex, rungIndex)` weakened to a bare assignment
  // on the accepted path; selectRung's `if (target <= i) return null` weakened to `< i`.
  {
    let sequences = 0, comparisons = 0;
    for (const r of runs) {
      const acc = r.writes.filter((w) => w.accepted).map((w) => w.price);
      if (acc.length >= 2) sequences += 1;
      for (let i = 1; i < acc.length; i++) {
        comparisons += 1;
        assert.ok(acc[i] <= acc[i - 1],
          `${r.spec.id}: accepted price stepped UP, ${acc[i - 1]} -> ${acc[i]} `
          + `(ladder ${JSON.stringify(r.monitor.ladder)})`);
      }
      // ...and the standing bid never sits below the floor either.
      for (const p of acc) assert.ok(p >= r.monitor.floor, `${r.spec.id}: accepted a sub-floor ${p}`);
    }
    assert.ok(sequences >= 20 && comparisons >= 50,
      `P4 is near-vacuous: ${sequences} multi-bid auctions, ${comparisons} comparisons`);
    ok(`P4 accepted prices are monotonically non-increasing: ${comparisons} successive-price comparisons `
      + `across ${sequences} multi-bid auctions, never a step up`);
  }

  // ---- P5. selectRung's WALK-DOWN IS BOUNDED, TERMINATING, NEVER RE-OFFERS A SPENT RUNG ----------
  // pricing.js's `while (target < last && rungFired(firedRungs, target)) target++` is BOTH the
  // skip-what-is-spent rule and the walk-down mechanism itself - a change that erases it froze the
  // price at one value forever, which is a shipped regression.
  //
  // Kills: `target++` flipped to `target--` (returns -1 -> ladder[-1] undefined); `target < last`
  // widened to `<=` (returns last+1 -> off the end of the ladder); the walk deleted (returns a rung
  // already spent); the `Math.trunc(k)` on a junk rank removed (fractional index -> undefined price);
  // `if (k === 1) return null` widened to `k <= 1`; the defend clamp `Math.min(target, last - 1)`
  // widened to `last` (spends the reserved floor mid-auction).
  {
    const rng = mkRng(SEED ^ 0x33333333);
    let defends = 0, snipes = 0, holds = 0, walked = 0;
    for (let i = 0; i < 600; i++) {
      const last = intIn(rng, 2, 29);                       // production ladders run 3-30 rungs
      const i0 = intIn(rng, -1, last);                      // -1 = before establish
      const phase = rng() < 0.5 ? 'defend' : 'snipe';
      const fired = new Set();
      const nFired = intIn(rng, 0, last);
      for (let f = 0; f < nFired; f++) fired.add(intIn(rng, 0, last));
      const jumpPerRival = pick(rng, [1, 1, 1, 2, 3, 0, -1, NaN, undefined]);  // incl. bad env values
      const k = pick(rng, [null, undefined, 1, 2, 3, 5, 9, 40, NaN, Infinity, 2.7, -3, 0]);
      const out = selectRung({ i: i0, k, last, firedRungs: fired, phase, jumpPerRival });
      const where = `selectRung(i=${i0}, k=${String(k)}, last=${last}, phase=${phase}, `
        + `jpr=${String(jumpPerRival)}, fired=${JSON.stringify([...fired])})`;

      if (out === null) { holds += 1; continue; }
      // BOUNDED and INTEGRAL: the result indexes a real ladder rung. Everything else is an
      // `undefined` price on live money.
      assert.ok(Number.isInteger(out) && out >= 0 && out <= last, `${where} -> ${out}: out of [0, ${last}]`);

      if (phase === 'defend') {
        defends += 1;
        // The floor is the reserved decisive shot; a mid-auction defend must never take it.
        assert.ok(out < last, `${where} -> ${out}: a defend spent the reserved floor rung`);
        // A defend only ever steps DEEPER than where we already stand.
        assert.ok(out > i0, `${where} -> ${out}: a defend did not step deeper than i=${i0}`);
        // ...and never onto a rung already spent. This is the walk-down, stated as a property.
        assert.ok(!fired.has(out), `${where} -> ${out}: a defend re-offered an already-spent rung`);
        if (fired.has(i0 + 1)) walked += 1;
      } else {
        snipes += 1;
        // A snipe may spend the floor and ONLY the floor may be re-offered (it is unfired by design
        // and is the one price we are sure wins if anything of ours does).
        assert.ok(out === last || !fired.has(out),
          `${where} -> ${out}: a snipe re-offered an already-spent non-floor rung`);
        assert.ok(out === last || out > i0,
          `${where} -> ${out}: a snipe stepped no deeper than i=${i0} without falling to the floor`);
      }
      // A blind or junk rank never yields a mid-auction guess: it holds on defend and falls to the
      // floor on the last shot.
      if (k == null || !Number.isFinite(k)) {
        assert.strictEqual(out, last, `${where} -> ${out}: a blind/junk rank must collapse to the floor on a snipe`);
      }
      // Winning is sacred: rank 1 never improves its own leading bid.
      assert.notStrictEqual(Math.trunc(Number(k)), 1, `${where} -> ${out}: fired a rung while holding rank 1`);
    }
    // Non-vacuity: the sample must actually have exercised holds, both phases, and the walk itself.
    assert.ok(defends >= 50 && snipes >= 50 && holds >= 50 && walked >= 10,
      `P5 sample is lopsided: defends=${defends} snipes=${snipes} holds=${holds} walked=${walked}`);
    ok(`P5 walk-down is bounded, terminating and never re-offers a spent rung: 600 generated selections `
      + `(${defends} defend / ${snipes} snipe / ${holds} hold, ${walked} of them forced to walk past a spent rung)`);
  }

  // ---- P6. WRITE COUNT IS BOUNDED ---------------------------------------------------------------
  // Concrete ceilings, not "finite". A prior regression put 23 refused writes on a shared LIVE
  // account against a correct value of ~5, and the account is shared with the client's own human
  // operators - every surplus write is a slot a human might have needed.
  //
  // Kills: `bidTimes.length >= effectiveCap` weakened to `>` (an off-by-one that lets 21 writes
  // through a 20/min cap); deleting `if (monitor.loadNotBiddable) return;` (a per-load state refusal
  // then retries for the whole auction - the 23-writes-instead-of-1 defect verbatim); deleting
  // `monitor.revisionsLeft = 0` on a cap rejection; deleting the shadow early-return, which would put
  // real money on the wire for a customer who was only ever supposed to be observed.
  {
    const MAX_PER_MIN = 20;
    let saturated = 0, terminals = 0, shadows = 0, cleanRuns = 0;
    for (const r of runs) {
      const w = r.writes;
      // (a) the rolling-window contract of the runaway guard, measured directly.
      let worstWindow = 0;
      for (let i = 0; i < w.length; i++) {
        let n = 0;
        for (let j = i; j < w.length; j++) if (w[j].atMs - w[i].atMs < 60_000) n += 1;
        if (n > worstWindow) worstWindow = n;
      }
      assert.ok(worstWindow <= MAX_PER_MIN,
        `${r.spec.id}: ${worstWindow} writes inside one 60s window, cap is ${MAX_PER_MIN}`);
      if (worstWindow === MAX_PER_MIN) saturated += 1;

      // (b) a TERMINAL platform refusal costs exactly ONE write. Not "few" - one.
      if (r.terminal) {
        terminals += 1;
        assert.strictEqual(w.length, 1,
          `${r.spec.id}: a terminal refusal (${[...r.kinds].join(',')}) cost ${w.length} writes, must cost exactly 1`);
      }

      // (c) SHADOW performs zero wire writes by construction.
      if (r.monitor.softStrategy === 'shadow') {
        shadows += 1;
        assert.strictEqual(w.length, 0, `${r.spec.id}: a shadow monitor wrote ${w.length} times`);
      }

      // (d) with every bid accepted, each rung fires at most once - so the ladder length is the
      //     ceiling. This is what "~5, not 23" looks like as an invariant.
      if (r.spec.outcome === 'accept' && r.monitor.softStrategy !== 'shadow' && !r.spec.ceilingPrice) {
        cleanRuns += 1;
        assert.ok(w.length <= r.monitor.ladder.length,
          `${r.spec.id}: ${w.length} writes on an all-accepted ${r.monitor.ladder.length}-rung ladder`);
      }

      // (e) the derived global ceiling: the per-minute cap applied over the auction's own span.
      const bound = MAX_PER_MIN * (Math.ceil(r.spanMs / 60_000) + 1);
      assert.ok(w.length <= bound,
        `${r.spec.id}: ${w.length} writes over ${Math.round(r.spanMs / 1000)}s exceeds the derived ceiling ${bound}`);
    }
    assert.ok(saturated >= 1, 'P6 never saturated the per-minute cap, so the off-by-one is untested');
    assert.ok(terminals >= 5, `P6 only saw ${terminals} terminal-refusal auctions`);
    assert.ok(shadows >= 1, 'P6 never generated a shadow monitor');
    assert.ok(cleanRuns >= 10, `P6 only saw ${cleanRuns} all-accepted auctions`);
    ok(`P6 write count is bounded: <=${MAX_PER_MIN} per rolling minute across ${N_AUCTIONS} auctions `
      + `(${saturated} saturated the cap), exactly 1 write on each of ${terminals} terminal refusals, `
      + `0 on each of ${shadows} shadow monitors, <= ladder length on ${cleanRuns} all-accepted auctions`);
  }

  // ---- P7. NO NaN / NEGATIVE / ABSURD DERIVED TIMING --------------------------------------------
  // Any time field can arrive as the year-2100 placeholder, which parses as a VALID date and so
  // defeats every NaN guard - the documented cause of wrong displays, forever-armed loads and silent
  // zero-bid misses.
  //
  // Kills: dropping `!Number.isFinite(closesInMs)` from _cadence's band branch (band arithmetic then
  // yields NaN and the monitor stalls); `Math.max(this.cfg.pollHotMs, toTarget)` flipped to Math.min
  // (a negative or zero poll delay - a hot spin on a live account); _softFinalShotBand losing its
  // `w <= 0` guard (a zero-width band at remaining 0); _isLastChance returning a non-boolean.
  {
    const rng = mkRng(SEED ^ 0x44444444);
    const eng = new BidEngine({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
      ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }),
      placeBid: async () => { throw new Error('P7 is a pure-predicate property; no write may occur'); },
    }, new DurableScheduler(tmp()), {
      config: { openAtMs: 15_000, floorWindowMs: 2_500, openJitterMs: 4_000 },
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live' },
      onEvent: () => {}, rand: mkRng(SEED ^ 0x4444),
    });
    eng._schedule = () => {};
    const m = eng.arm({ id: 'P7', lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName: 'Havells', closesAt: NOW + 600_000 }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });

    const PHASES = ['monitoring', 'preparing', 'active_bidding', 'closing'];
    const HOSTILE = [NaN, undefined, null, Infinity, -Infinity, YEAR_2100_MS, YEAR_2100_MS - NOW,
      1e18, -1e18, 0, -1];
    let cases = 0, bands = 0;
    for (let i = 0; i < 400; i++) {
      // Countdown: mostly real (0-15 min), sometimes one of the hostile shapes.
      const remaining = rng() < 0.3 ? pick(rng, HOSTILE) : intIn(rng, 0, 900_000);
      m.closeModel = pick(rng, ['soft', 'soft', 'hard']);
      m.softStrategy = pick(rng, ['live', 'live', 'off', 'shadow']);
      m.triggerWindowMs = pick(rng, [null, 0, 100_000, 150_000, 200_000, NaN, YEAR_2100_MS]);
      m.extendCap = pick(rng, [null, 0, 1, 3, 10]);
      m.extendsObserved = intIn(rng, 0, 12);
      m._openAtFrac = null; // re-roll the establish jitter each case
      cases += 1;

      const cad = eng._cadence(remaining, m);
      assert.ok(Number.isFinite(cad), `P7: cadence is not finite for remaining=${String(remaining)}`);
      assert.ok(cad >= eng.cfg.pollHotMs, `P7: cadence ${cad} is below the hot poll for remaining=${String(remaining)}`);
      assert.ok(cad <= eng.cfg.pollFarMs + eng.cfg.cadenceJitterMs,
        `P7: cadence ${cad} exceeds the far poll + jitter for remaining=${String(remaining)}`);

      const est = eng._establishThreshold(m);
      assert.ok(Number.isFinite(est) && est >= eng.cfg.openAtMs && est <= eng.cfg.openAtMs + eng.cfg.openJitterMs,
        `P7: establish threshold ${est} is outside [openAtMs, openAtMs + jitter]`);

      const band = eng._decisiveBandFor(m);
      if (band != null) {
        bands += 1;
        assert.ok(Number.isFinite(band.opensAt) && Number.isFinite(band.closesAt),
          `P7: decisive band carries a non-finite edge ${JSON.stringify(band)}`);
        assert.ok(band.closesAt >= 0 && band.opensAt > band.closesAt,
          `P7: decisive band is inverted or negative ${JSON.stringify(band)}`);
        assert.strictEqual(band.opensAt - band.closesAt, eng.cfg.floorWindowMs,
          `P7: decisive band width is not floorWindowMs ${JSON.stringify(band)}`);
      }

      assert.strictEqual(typeof eng._isLastChance(remaining), 'boolean', 'P7: _isLastChance is not boolean');
      assert.strictEqual(typeof eng._decisiveShotDue(m, remaining), 'boolean', 'P7: _decisiveShotDue is not boolean');
      assert.ok(PHASES.includes(eng._phase(remaining)), `P7: _phase returned ${eng._phase(remaining)}`);

      const tel = eng._triggerWindowTelemetry(m, remaining);
      assert.ok(tel.triggerWindowMs === null || Number.isFinite(tel.triggerWindowMs),
        'P7: telemetry leaked a non-finite trigger window');
      assert.ok(tel.insideTriggerWindow === null || typeof tel.insideTriggerWindow === 'boolean',
        'P7: telemetry leaked a non-boolean insideTriggerWindow');

      // The clock-scheduled rung index is integral and in range for any FINITE countdown. (It is
      // deliberately NOT asserted for a non-finite one: it does return NaN there, and P3 is the
      // property that pins what stops that NaN from reaching the wire.)
      if (Number.isFinite(remaining)) {
        const sri = eng._scheduledRungIndex(m, remaining);
        assert.ok(Number.isInteger(sri) && sri >= 0 && sri <= m.ladder.length - 1,
          `P7: _scheduledRungIndex(${remaining}) = ${sri}, outside [0, ${m.ladder.length - 1}]`);
      }
    }
    // The documented placeholder, pinned as an explicit non-random case beside the generated sweep.
    assert.strictEqual(eng._isLastChance(NaN), false, 'P7: a NaN countdown must not read as the last chance');
    assert.strictEqual(eng._isLastChance(YEAR_2100_MS), false,
      'P7: the year-2100 placeholder must not read as the last chance');
    assert.ok(Number.isFinite(eng._cadence(YEAR_2100_MS, m)), 'P7: the year-2100 placeholder produced a non-finite cadence');
    assert.ok(bands >= 20, `P7 only produced ${bands} decisive bands, so that branch is barely covered`);
    ok(`P7 no NaN / negative / absurd derived timing: ${cases} generated countdown+window combinations `
      + `(including NaN, +-Infinity and the year-2100 placeholder), ${bands} decisive bands, every cadence `
      + 'inside [hot, far+jitter]');
  }

  // ---- P8. NO SILENT FORFEIT --------------------------------------------------------------------
  // The generalised form of the production defect: loads that were armed and priced closing with
  // nothing on the board, or with the ladder frozen at one price. Both halves are measured facts -
  // 15 soft loads across three customers closed with the floor unspent while armed and priced, and
  // the D3 audit measured a blanket rollback pinning selectRung on one rung (9700 x 12, floor never
  // reached) where origin/main walked 9700 -> 9400 -> 9100 -> 8000 in four polls.
  //
  // Kills: erasing the firedRungs walk-down (the ladder then freezes at one price under refusal);
  // dropping the D3 `currentRungIndex = _priorCurrentRungIndex` restore (a refused establish then
  // closes the establish branch forever and the load forfeits with zero writes); deleting
  // _lastResortFloor's release.
  {
    let forfeitChecked = 0, refusalWalks = 0, coarseFloors = 0;
    for (const r of runs) {
      const m = r.monitor;
      const s = r.spec;
      const exempt = m.softStrategy === 'shadow'          // places nothing by construction
        || m.ceilingBelowFloor                            // fail-closed: cannot win profitably
        || r.kinds.has('ceiling_below_floor');
      if (!exempt) {
        forfeitChecked += 1;
        // (a) NEVER ZERO WRITES on a load we armed and priced with budget in hand.
        assert.ok(r.writes.length >= 1,
          `${s.id}: armed and priced, ${r.ticks} ticks, and never wrote once `
          + `(closeModel=${m.closeModel} strategy=${m.softStrategy} rank=${s.rankMode} outcome=${s.outcome})`);
        // (b) and it closed properly rather than being abandoned by the sweep.
        assert.ok(r.finalized, `${s.id}: never finalized within ${MAX_TICKS} ticks`);
        assert.ok(r.ticks < MAX_TICKS, `${s.id}: hit the tick ceiling - the auction did not terminate`);
      }

      // (c) THE WALK-DOWN, end to end. Under persistent price/state refusal the ladder must walk all
      //     the way DOWN to the floor, not freeze. This is the D3 audit table as a property, and the
      //     DISTINCT-price count is the number that discriminates: a load whose establish is refused
      //     and whose rank therefore never comes online offers exactly two prices (the establish rung,
      //     then the bounded last-resort floor at the buzzer) if the currentRungIndex restore is
      //     missing, against the full ladder when it is present. Two is not a walk-down; three is the
      //     smallest count that can only be produced by one.
      if (s.outcome === 'reject_price' && !exempt) {
        refusalWalks += 1;
        const distinct = new Set(r.writes.map((w) => w.price));
        assert.ok(distinct.size >= Math.min(m.ladder.length, 3),
          `${s.id}: ${r.writes.length} refused writes but only ${distinct.size} distinct price(s) - `
          + `the ladder froze instead of walking down (ladder ${JSON.stringify(m.ladder)}, `
          + `offered ${JSON.stringify([...distinct])})`);
        assert.ok(distinct.has(m.ladder[m.ladder.length - 1]),
          `${s.id}: persistent refusal never reached the floor ${m.ladder[m.ladder.length - 1]} `
          + `(offered ${JSON.stringify([...distinct])})`);
      }

      // (d) THE COARSE LADDER (<= 3 rungs - every customer not on the rung-expansion allowlist, and
      //     every low-cap load) runs the deployed always-floor snipe, so a load that closes outranked
      //     with budget left MUST have offered the floor. The fine rank-driven ladder is deliberately
      //     excluded: selectRung('snipe') there fires the highest rung that still wins rather than
      //     dumping the floor, which is the documented rank-aware endgame, not a forfeit.
      if (!exempt && !r.terminal && m.ladder.length <= 3 && m.myRank !== 1
          && (m.revisionsLeft == null || m.revisionsLeft > 0) && s.rankMode !== 'win_after_bid') {
        coarseFloors += 1;
        assert.ok(r.writes.some((w) => w.price === m.ladder[m.ladder.length - 1]),
          `${s.id}: a coarse ${m.ladder.length}-rung load closed outranked with `
          + `${m.revisionsLeft} revisions left and the floor ${m.ladder[m.ladder.length - 1]} never offered `
          + `(offered ${JSON.stringify(r.writes.map((w) => w.price))})`);
      }
    }
    assert.ok(forfeitChecked >= 80, `P8 only checked ${forfeitChecked} auctions for forfeit`);
    assert.ok(refusalWalks >= 5, `P8 only saw ${refusalWalks} persistent-refusal auctions`);
    assert.ok(coarseFloors >= 10, `P8 only saw ${coarseFloors} coarse outranked closes`);
    ok(`P8 no silent forfeit: ${forfeitChecked} armed+priced auctions all wrote at least once and terminated, `
      + `${refusalWalks} persistently-refused loads all walked the ladder down to the floor, `
      + `${coarseFloors} coarse outranked closes all offered the floor`);
  }

  reachedEnd = true;
  const totalWrites = runs.reduce((a, r) => a + r.writes.length, 0);
  const totalTicks = runs.reduce((a, r) => a + r.ticks, 0);
  console.log(`\nseed = 0x${SEED.toString(16).toUpperCase()}  |  ${N_AUCTIONS} generated auctions, `
    + `${totalTicks} engine ticks, ${totalWrites} recorded placeBid calls, 0 network calls`);
  console.log(`${passed}/${EXPECTED_PROPERTIES} properties passed  (${REAL_NOW() - t0}ms)`);
  cleanup();
  process.exit(0);
})().catch((e) => {
  cleanup();
  console.error(`\nFAILED (seed = 0x${SEED.toString(16).toUpperCase()}):`, (e && e.stack) || e);
  process.exit(1);
});
