'use strict';

const { createLogger } = require('../logging/logger');

// Module-scoped, not threaded through function params: every function here is a pure
// pricing calculation called from a handful of call sites (bidEngine.js, snipeHarness.js,
// scripts/test-*.js), none of which already carry a `log` dependency through this seam,
// so there is no existing DI convention to match — createLogger('pricing') once at
// require-time is the simplest way to make ladder construction observable.
const log = createLogger('pricing');

/**
 * Pricing — turn the operator's two numbers into a bid plan.
 *
 * The operator supplies exactly two numbers per auction (the human IS the pricing intelligence
 * for a single client who knows their lanes):
 *   - marketRate: the rate they expect it'll take to win this lane right now.
 *   - costFloor:  the absolute floor. The bot MUST NEVER bid below this. This is the hard
 *                 invariant the reference system lacked.
 *
 * Two strategies, chosen by what the platform exposes:
 *
 *   A) rank-only (SuperProcure default): we cannot see rivals' prices, so we cannot do "L1 minus
 *      epsilon". The correct shape is a DESCENDING LADDER from an opening price down to the
 *      floor, with FINE rungs (the reference used only 3 coarse rungs and left money / wins on
 *      the table). We start high to keep margin and step down only as the clock forces us, never
 *      past the floor.
 *
 *   B) price-visible: if we can read the standing L1 price, undercut it by exactly the minimum
 *      decrement, clamped to the floor. Strictly better than a ladder.
 *
 * Either way the floor is enforced at the moment of payload build, not just here.
 */

function round(n) { return Math.round(n); }

/**
 * Build a descending ladder of `rungs` prices from opening down to costFloor.
 * opening = marketRate * (1 + openingMarkupPct). If that is below the floor
 * (operator set an aggressive floor above market), the whole ladder collapses
 * to [floor].
 */
function buildLadder({ marketRate, costFloor, openingMarkupPct = 0.10, rungs = 6 }) {
  if (!(marketRate > 0) || !Number.isFinite(marketRate)) throw new Error('marketRate must be a finite number > 0');
  if (!(costFloor > 0) || !Number.isFinite(costFloor)) throw new Error('costFloor must be a finite number > 0');
  rungs = Math.max(2, Math.round(rungs)); // >=2 so the i/(rungs-1) spacing never divides by zero (NaN rungs)

  const opening = round(marketRate * (1 + openingMarkupPct));
  const top = Math.max(opening, costFloor);
  if (top <= costFloor) {
    log.debug('ladder collapsed to a single rung: opening markup did not clear the floor', {
      marketRate, costFloor, opening });
    return { opening: costFloor, floor: costFloor, ladder: [costFloor] };
  }
  const ladder = [];
  // geometric-ish spacing so we give away less early, more late
  for (let i = 0; i < rungs; i++) {
    const frac = i / (rungs - 1); // 0..1
    // ease-in: spend margin slowly at first, faster near the end
    const eased = frac * frac;
    const price = round(top - (top - costFloor) * eased);
    ladder.push(Math.max(price, costFloor));
  }
  // dedupe + ensure strictly descending and floor is the last rung
  const clean = [];
  for (const p of ladder) {
    if (clean.length === 0 || p < clean[clean.length - 1]) clean.push(p);
  }
  if (clean[clean.length - 1] !== costFloor) clean.push(costFloor);
  log.debug('ladder built', { marketRate, costFloor, opening: top, rungCount: clean.length });
  return { opening: top, floor: costFloor, ladder: clean };
}

/**
 * Decrement-aware undercut for price-visible platforms.
 * Returns the price to bid to take L1, or null if we cannot beat the standing
 * price without breaching the floor.
 */
function computeUndercut({ standingL1Price, minDecrement, costFloor }) {
  if (standingL1Price == null) return null;
  const target = standingL1Price - Math.max(1, minDecrement);
  if (target < costFloor) return null; // can't win without going below floor -> stand down
  return round(target);
}

/**
 * The highest price a NEW offer on a load may carry, given what WE already have standing on it.
 * Null when nothing stands, i.e. no constraint.
 *
 * A reverse auction accepts only an improvement on your own last offer, and it is the PLATFORM's
 * rule, not ours: SuperProcure says it verbatim on a refused revision - "Amount is invalid. Amount
 * should be less than or equal to 51650", against our own standing 51,750 on a load whose decrement
 * is 100 - and GoComet answers 422 "You've increased the quote price".
 *
 * One home, because the same question is asked at three layers (the re-price API before it saves,
 * the engine's rung selection, and the belt at the fire point) and three copies of this arithmetic
 * would silently disagree at the boundary. The `Math.max(1, ...)` floor is the same one
 * computeUndercut directly above uses, and it is doing real work here: a platform may legitimately
 * report a decrement of 0 ("unknown / not enforced", src/platform/adapter.js), and without the
 * clamp this returns the standing price itself - a price that improves on nothing, which a rung
 * selector would then pick and a fire-point guard would then refuse, once per tick, forever.
 */
function maxImprovementPrice(standingBidPrice, minDecrement) {
  const standing = Number(standingBidPrice);
  if (!Number.isFinite(standing) || !(standing > 0)) return null;
  const dec = Number(minDecrement);
  return standing - (Number.isFinite(dec) && dec > 1 ? dec : 1);
}

/**
 * Explicit margin-BAND ladder — the faithful GoComet / BRL Syngenta model.
 *
 * GoComet bids three EXPLICIT tiers off the cost (its "marketValue"): HIGH, MEDIUM,
 * LOW = cost x (1 + pct/100), with live-prod percents 12.6 / 7.2 / 6.3. The medium
 * tier is a deliberately-chosen value, NOT the geometric midpoint between high and
 * low — so this maps each configured percent straight to a price (unlike
 * buildMarginLadder, which eases the spacing for many-rung soft-close auctions).
 *
 * For a 3-bid hard close (Syngenta: bidsAllowed 3) this yields exactly the
 * HIGH/MEDIUM/LOW the engine establishes -> steps to -> snipes. Floor = the lowest
 * tier; the engine can never bid below it.
 *
 * @param marginsPct e.g. [12.6, 7.2, 6.3]. Order is normalised to descending.
 */
function buildBandLadder({ cost, marginsPct, minMarginPct }) {
  if (!(cost > 0) || !Number.isFinite(cost)) throw new Error('cost must be a finite number > 0');
  if (!Array.isArray(marginsPct) || marginsPct.length === 0) throw new Error('marginsPct must be a non-empty array');
  const desc = [...marginsPct].map(Number).filter((m) => Number.isFinite(m)).sort((a, b) => b - a);
  if (desc.length === 0) throw new Error('marginsPct has no finite values');
  // TWO FLOORS (Suyashh's correction, 2026-06-26): the true cost is the physical wall
  // (never below = a guaranteed loss); the OPERATING floor = cost x (1 + minMarginPct)
  // is the practical "never below" (minMarginPct >= the opportunity cost of the asset).
  // minMarginPct defaults to the band's lowest % when omitted (backward-compatible).
  const minM = (minMarginPct != null && Number.isFinite(+minMarginPct)) ? +minMarginPct : desc[desc.length - 1];
  // Clamp to true cost: a zero/negative minMarginPct (env typo, stale config doc) must never
  // pull the operating floor below cost, or the engine would place a guaranteed-loss bid.
  const trueCost = Math.round(cost);
  const marginFloor = Math.round(cost * (1 + minM / 100));
  const operatingFloor = Math.max(trueCost, marginFloor);
  // The clamp above is silent by construction (Math.max just wins), which is exactly the
  // failure mode that needs surfacing: a mis-set minMarginPct would otherwise produce a
  // below-cost operating floor with no trace of it having happened. Flag it loudly here so
  // an operator sees the correction rather than discovering it later as an unexplained margin.
  //
  // `<=`, not `<`. At exactly 0 the floor lands ON cost, which is the case that actually cost
  // money - 133 loads, 13 won at no margin - and the `<` this guard shipped with meant the one
  // instrument built to catch a mis-set floor was blind to the value that costs the most. Nothing
  // downstream changes: this only stops the clamp being silent.
  if (marginFloor <= trueCost) {
    log.warn('operating floor is not above true cost: nothing stops a bid on this load going out at cost', {
      minMarginPct: minM, cost: trueCost, computedFloor: marginFloor, operatingFloor });
  }
  if (desc[desc.length - 1] < minM) {
    log.warn('a band margin sits below the minimum margin: it is raised to the minimum-margin price at bid time', {
      marginsPct: desc, minMarginPct: minM, raisedTo: operatingFloor });
  }
  const ladder = [];
  for (const m of desc) {
    const price = Math.max(operatingFloor, Math.round(cost * (1 + m / 100))); // never below the operating floor
    if (ladder.length === 0 || price < ladder[ladder.length - 1]) ladder.push(price); // strictly descending, deduped
  }
  const floor = ladder[ladder.length - 1];
  log.debug('band ladder built', { cost: trueCost, floor, guard: operatingFloor, rungCount: ladder.length, minMarginPct: minM });
  return { opening: ladder[0], floor, guard: operatingFloor, trueCost, minMarginPct: minM, ladder, marginsPct: desc };
}

/**
 * The floor margin buildBandLadder will ACTUALLY use - the explicit one when it is a real number,
 * otherwise the band's lowest. Mirrors the resolution at the top of buildBandLadder so a caller can
 * test the EFFECTIVE value rather than the stored field: an absent minMarginPct is not "no floor
 * problem", it hands the job to a band whose own lowest margin may be 0 or negative, and a guard
 * reading Number.isFinite(Number(minMarginPct)) cannot see that at all.
 * Returns null when no margin can be resolved (the rate model, or a band of junk).
 */
function effectiveFloorMarginPct({ marginsPct, minMarginPct }) {
  if (minMarginPct != null && Number.isFinite(+minMarginPct)) return +minMarginPct;
  if (!Array.isArray(marginsPct)) return null;
  const finite = marginsPct.map(Number).filter((n) => Number.isFinite(n));
  return finite.length ? Math.min(...finite) : null;
}

/**
 * ONE floor-margin decision, shared by every arm path (S4, 2026-09-16).
 *
 * At an effective floor margin of 0 or below the operating floor above clamps to the desk's own
 * cost and the ladder walks down to a bid at no margin - 133 loads, 77 bid at cost, 13 won,
 * Rs 5,59,500 of freight. Substituting the house default is the only outcome that neither forfeits
 * the auction nor bids it at cost; with no positive house default there is nothing to substitute,
 * so it refuses rather than arming.
 *
 * It lives here, beside the arithmetic it protects, because the previous guard lived in exactly one
 * caller (armFromRequest) while two others reached buildBandLadder without it. There must be one.
 *
 * Returns null when the band is sound, else { stored, substituted } for the caller to apply,
 * announce and heal.
 */
function floorMarginSubstitution({ marginsPct, minMarginPct, houseDefaultPct }) {
  const stored = effectiveFloorMarginPct({ marginsPct, minMarginPct });
  if (stored == null || stored > 0) return null;
  const house = Number(houseDefaultPct);
  if (!(house > 0)) {
    const e = new Error('cannot arm: this load carries a 0% floor margin and the house default is 0% too, so every bid would be at cost - fix the margin band');
    e.code = 'BAD_INPUT';
    throw e;
  }
  return { stored, substituted: house };
}

/**
 * Has this rung already been spent? firedRungs is a Set on the live monitor and an array in a
 * few durable-intent paths (see bidEngine.js remapFiredRungs), so tolerate both - and a falsy
 * value - without assuming a type. Tiny and pure, kept beside selectRung, its only caller.
 */
function rungFired(firedRungs, idx) {
  if (!firedRungs) return false;
  if (typeof firedRungs.has === 'function') return firedRungs.has(idx); // Set (the live monitor)
  if (Array.isArray(firedRungs)) return firedRungs.includes(idx);       // array (durable intent)
  return false;
}

/**
 * RANK-DRIVEN rung selection - the single source of truth for WHICH rung the bot commits next,
 * shared verbatim by soft-close defend, hard-close step-down and the final snipe. It is the code
 * form of the logic spec's s3 rule (_research/2026-07-24_softclose-rung-logic-and-arm-inputs.md):
 * step down one rung per rival ahead of us (jump = k - 1), and at the buzzer fire the HIGHEST rung
 * that still wins rather than dumping the floor.
 *
 * PURE by construction: no monitor mutation, no logging, no clock read. The engine owns the timing
 * gates (is this the trigger window, are extensions left, is this the last chance) and the side
 * effects (firedRungs.add, telemetry); this answers only "given where I stand and my live rank,
 * which rung is next". Establish (i === -1, fire rung 0 to turn rank on) is a separate engine
 * branch and is deliberately NOT modelled here - selectRung runs only for defend and snipe.
 *
 *   - i            currentRungIndex - the rung we are standing on.
 *   - k            our live rank (1 = winning, null = not yet known / blind window).
 *   - last         ladder.length - 1 - the floor rung index.
 *   - firedRungs   rungs already spent (a Set on the live monitor; an array is tolerated).
 *   - phase        'defend' (mid-auction, the floor stays reserved) | 'snipe' (the final shot,
 *                  the ONLY place the floor may be spent).
 *   - jumpPerRival how many rungs to step per rival ahead - the single tunable knob (s6), a
 *                  system/customer-level setting, never a per-load input. Default 1.
 *
 * Returns the rung index to fire, or null to HOLD (bid nothing). A snipe never holds except on a
 * live win (k === 1): out of information its fallback is always the floor, the one price we are
 * sure wins if anything of ours does.
 *
 * @param {Object} opts - the rung-selection inputs (destructured).
 * @param {number} opts.i - currentRungIndex: the rung we are standing on (-1 before establish).
 * @param {number|null} opts.k - our live rank; 1 = winning, null/non-finite = blind window.
 * @param {number} opts.last - ladder.length - 1, the floor rung index.
 * @param {Set<number>|number[]} opts.firedRungs - rungs already spent.
 * @param {'defend'|'snipe'} opts.phase - 'defend' reserves the floor; 'snipe' may spend it.
 * @param {number} [opts.jumpPerRival=1] - rungs stepped down per rival ahead.
 * @returns {number|null} - the ladder index to fire, or null to HOLD (bid nothing).
 */
function selectRung({ i, k, last, firedRungs, phase, jumpPerRival = 1 }) {
  const snipe = phase === 'snipe';
  // RANK UNKNOWN (blind window): the floor is the last-shot fallback, never a mid-auction guess.
  // A null rank is not the same as "losing" (spec s3), so a defend on it holds. `==` also catches
  // undefined.
  if (k == null) return snipe ? last : null;
  // JUNK RANK: the wire can lie. A non-finite rank is treated as BLIND (the same conservative read
  // as null); a fractional one truncates - untruncated it becomes a fractional jump and a fractional
  // ladder index (ladder[1.5] === undefined -> an undefined-price bid on live money).
  if (!Number.isFinite(k)) return snipe ? last : null;
  k = Math.trunc(k);
  // WINNING: never improve a leading bid - it only pushes the clock out and invites a counter.
  if (k === 1) return null;
  // OUTRANKED: we sit behind k - 1 rivals; step down one rung per rival ahead (times the knob).
  // Sanitize the knob at the point of use: a bad boot-time env (SP_SOFT_JUMP_PER_RIVAL='abc' -> NaN) or a
  // non-positive value must never make jump NaN/negative and index the ladder with `undefined`. Fall back
  // to 1 (the default, one rung per rival) - the conservative, margin-protecting direction.
  const jpr = (Number.isFinite(jumpPerRival) && jumpPerRival > 0) ? jumpPerRival : 1;
  const jump = Math.max(0, k - 1) * jpr;
  let target = i + jump;
  if (!snipe) {
    // DEFEND (mid-auction): the floor is reserved for the final window, so clamp to last - 1.
    target = Math.min(target, last - 1);
    if (target <= i) return null; // no deeper than where we already stand -> hold, reserve for later
    // Walk down past any rung already spent, but never onto the floor. If nothing unfired is left
    // below the floor, hold - the snipe still owns the floor.
    while (target < last && rungFired(firedRungs, target)) target++;
    if (target >= last) return null;
    return target;
  }
  // SNIPE (final shot). COARSE-LADDER GUARD: on a < 3-rung ladder (KEI / Syngenta and every customer
  // not yet on the rung-expansion allowlist) the only decisive move is the floor - collapse straight
  // to it, preserving the live always-floor snipe byte-for-byte.
  if (last < 3) return last;
  target = Math.min(target, last); // the floor is available here, and only here
  if (target <= i) return last;    // can't step deeper by rank -> fire the floor, the sure shot
  // Skip spent rungs; the floor is unfired by design, so this walk always lands on a real rung.
  while (target < last && rungFired(firedRungs, target)) target++;
  return target;
}

/**
 * ANCHOR-PRESERVING rung interpolation - the pricing half of Layer 3. Turns the desk's coarse
 * margin band into a finer ladder WITHOUT ever moving one of the desk's chosen prices, so a load
 * that allows many bids can step down in small rank-driven increments while every configured
 * margin still maps to a biddable rung.
 *
 * Why this exists rather than buildMarginLadder: buildMarginLadder resamples top -> floor with an
 * easing curve and silently MOVES the middle anchor (~Rs 81 off the live [12.6, 7.2, 2.7] band).
 * This function builds buildBandLadder FIRST to pin the exact anchors + floor, then INSERTS new
 * rungs strictly between adjacent anchors - it never recomputes or shifts an anchor.
 *
 * Method:
 *   1. buildBandLadder -> the anchors (strictly descending, floor last, exact).
 *   2. If we cannot or need not add rungs (`rungs` <= anchor count, a single-rung collapsed band
 *      with no gaps to fill, or a non-finite target) return buildBandLadder's result
 *      BYTE-FOR-BYTE.
 *   3. Distribute `rungs - anchors.length` inserted rungs across the anchor gaps in proportion to
 *      each gap's rupee width; hand any leftover to the WIDEST gaps first (deterministic). Space
 *      each gap's inserts evenly, strictly between its two anchors.
 *   4. Structural min-decrement pass: while any adjacent pair is under minDecrement (a threshold
 *      >= 1 also folds in strictly-descending dedup), drop the INSERTED rung on the tightest such
 *      pair - never an anchor, never the floor. An anchor-anchor gap under the decrement is left
 *      alone: that is the desk's own margins sitting too close, the pre-existing
 *      ladder-validity-alert hazard, not something to hide by dropping a price the desk asked for.
 *
 * Invariants held: the floor is always the last rung and unchanged; every anchor price is present
 * (so every configured margin stays biddable); the ladder is strictly descending and deduped; the
 * final rung count sits between the anchor count and `rungs`.
 *
 * Returns the same shape as buildBandLadder ({ opening, floor, trueCost, minMarginPct, ladder,
 * marginsPct }) so it is a drop-in for the arm path.
 *
 * @param {Object} opts - the interpolation inputs (destructured).
 * @param {number} opts.cost - the desk cost the margin band is applied to.
 * @param {number[]} opts.marginsPct - the desk's margin anchors, e.g. [12.6, 7.2, 2.7].
 * @param {number} [opts.minMarginPct] - operating-floor margin; defaults to the band's lowest.
 * @param {number} opts.rungs - target rung count; <= the anchor count returns the coarse band.
 * @param {number} [opts.minDecrement] - platform minimum bid difference; defaults to 1.
 * @returns {{opening: number, floor: number, trueCost: number, minMarginPct: number,
 *   ladder: number[], marginsPct: number[]}} - buildBandLadder's shape, ladder interpolated.
 */
function interpolateBandLadder({ cost, marginsPct, minMarginPct, rungs, minDecrement }) {
  const band = buildBandLadder({ cost, marginsPct, minMarginPct });
  const anchors = band.ladder;
  const n = anchors.length;
  const want = Math.round(Number(rungs));
  // Nothing to interpolate: fewer target rungs than anchors, a collapsed single-rung band (no gaps to
  // fill), or a garbage target -> hand back buildBandLadder untouched (byte-identical).
  if (!Number.isFinite(want) || want <= n || n < 2) return band;

  // Split `extra` inserted rungs across the n - 1 anchor gaps by rupee width.
  const extra = want - n;
  const gaps = [];
  for (let g = 0; g < n - 1; g++) gaps.push(anchors[g] - anchors[g + 1]);
  const totalWidth = anchors[0] - anchors[n - 1]; // == sum(gaps); > 0 since anchors strictly descend
  const alloc = gaps.map((w) => Math.floor((extra * w) / totalWidth));
  let leftover = extra - alloc.reduce((a, b) => a + b, 0); // strictly < gaps.length (each floor loses < 1)
  // Deterministic leftover: widest gap first, ties broken by the lower (earlier) gap index.
  const widestFirst = gaps.map((w, idx) => ({ w, idx })).sort((a, b) => (b.w - a.w) || (a.idx - b.idx));
  for (let x = 0; leftover > 0; x++, leftover--) alloc[widestFirst[x].idx]++;

  // Build the combined ladder: each anchor, then its gap's evenly-spaced inserts. Anchors carry a flag
  // so the min-decrement pass can never drop one.
  const entries = [];
  for (let g = 0; g < n; g++) {
    entries.push({ price: anchors[g], anchor: true });
    if (g < n - 1) {
      const hi = anchors[g], lo = anchors[g + 1], m = alloc[g];
      for (let j = 1; j <= m; j++) {
        entries.push({ price: Math.round(hi - ((hi - lo) * j) / (m + 1)), anchor: false }); // strictly hi > p > lo
      }
    }
  }

  // Structural min-decrement + strict-descending pass. A threshold >= 1 folds dedup in (any gap <= 0 is
  // < threshold), so the result is strictly descending even when no decrement was supplied.
  const threshold = (Number.isFinite(minDecrement) && minDecrement > 0) ? minDecrement : 1;
  for (;;) {
    let tightestAt = -1, tightestGap = Infinity;
    for (let t = 1; t < entries.length; t++) {
      const gap = entries[t - 1].price - entries[t].price;
      if (gap >= threshold) continue;
      // Fixable only when at least one endpoint is an inserted rung; an anchor-anchor pair under the
      // decrement is left in place (the desk's own margins are too close - a validity-alert matter).
      if (entries[t - 1].anchor && entries[t].anchor) continue;
      if (gap < tightestGap) { tightestGap = gap; tightestAt = t; }
    }
    if (tightestAt === -1) break;
    // Drop the inserted endpoint of the tightest violating pair; if the lower one is the anchor, drop
    // the upper (inserted) one instead. The floor is an anchor, so it can never be dropped here.
    const dropIdx = entries[tightestAt].anchor ? tightestAt - 1 : tightestAt;
    entries.splice(dropIdx, 1);
  }

  const ladder = entries.map((e) => e.price);
  return { ...band, ladder, opening: ladder[0] };
}

/**
 * LADDER VALIDITY vs the platform's MINIMUM DECREMENT - the detection half, pure and side-effect
 * free. Lives here with the rest of the ladder maths (buildLadder / buildBandLadder /
 * capLadderToCeiling); the engine owns only the alerting half, which touches monitor state.
 *
 * SuperProcure enforces a per-load "Bid Difference" (loadBidDifference, observed live at 100, 500,
 * 1000 and 1500): a revision must sit at least that far BELOW our own standing bid or the platform
 * refuses it. bidEngine._maybeBid already refuses to fire a non-floor step whose gap is under that
 * value, and that refusal is correct - firing it would spend a scarce rung on a guaranteed
 * rejection. What is wrong is that it refuses with a bare `return`: the rung simply never bids, and
 * nothing anywhere tells anybody it happened.
 *
 * The silence hides a real configuration hazard, because the two numbers involved come from
 * unrelated places and nothing reconciles them. buildBandLadder spaces rungs by MARGIN, so the gap
 * between two rungs is cost x (margin_i - margin_j) / 100 - driven by the desk cost an operator
 * types in per load. minDecrement is a property of the shipper's branch. On the live band the only
 * non-floor step is cost x 0.054, which falls under a 1500 decrement for any cost below about
 * Rs 27,800 and under a 1000 decrement below about Rs 18,500. A real load at cost 18,000 builds
 * 20268 / 19296 / 18486 - a 972 gap - so on a wide-decrement branch its middle rung is unfireable
 * and the ladder silently degrades from three prices to two.
 *
 * Only NON-FLOOR steps are reported, matching the guard's own `isFloorRung` exemption exactly: a
 * step INTO the floor rung is always attempted regardless of spacing (the floor is the decisive
 * shot and fires best-effort), so flagging it would be a false alarm.
 *
 * Adjacent pairs are the right unit because they are the TIGHTEST gap the engine can ever
 * attempt. _decide may skip a rung (`next = max(currentRungIndex + 1, _scheduledRungIndex(...))`),
 * and a skip only ever widens the gap measured against lastBidPrice. So adjacent pairs clearing
 * the decrement PROVES no non-floor step can be refused for spacing; an adjacent pair failing it
 * proves that consecutive step would be refused - not that the rung is unreachable down every
 * possible path.
 *
 * @param {number[]} ladder - the descending rung prices, floor last.
 * @param {number} minDecrement - this load's minimum bid difference (SP loadBidDifference).
 * @param {Array} [scaled] - scaleLadderByType's per-line amounts: the portal measures each line, so a
 *   step any one line cannot clear is a violation even when the blended step clears.
 * @returns {Array<{fromIndex: number, toIndex: number, fromPrice: number, toPrice: number,
 *   gap: number}>} - one entry per adjacent NON-FLOOR step whose gap is under minDecrement; empty
 *   when the ladder has fewer than 3 rungs or minDecrement is not a finite positive number.
 */
function decrementViolations(ladder, minDecrement, scaled) {
  // Fewer than 3 rungs means the only step available is the one into the floor, which is exempt.
  if (!Array.isArray(ladder) || ladder.length < 3) return [];
  // A decrement the engine cannot act on means there is nothing to report: _maybeBid disables its
  // own guard on a falsy minDec (it tests `&& minDec`), so a null / undefined / 0 value can never
  // cause a refusal and must not raise an alert about one.
  //
  // This test is deliberately STRICTER than that bare truthiness check, and stays that way on
  // purpose. Number.isFinite additionally rejects NaN and a numeric STRING - '1500' is truthy and
  // would compare arithmetically against a numeric gap just fine, so the loose test would accept it
  // where this one does not. Stricter is the safe direction for a pure DETECTOR: the worst it can
  // do is stay quiet on a load where _maybeBid would in fact refuse a rung, which is exactly the
  // pre-existing silence this function was written to improve on and never worse than it. The loose
  // direction is the dangerous one - it would let the alert claim a refusal the engine never hits.
  // Reachability, checked rather than assumed: in the captured SuperProcure corpus
  // loadBidDifference arrives as an UNQUOTED number on every observed load (100 / 500 / 1000 /
  // 1500), unlike ceilingPrice on the same object, which genuinely is quoted. So the string case
  // does not occur today and the divergence is inert. If the wire ever does start quoting it, the
  // correct fix is to coerce at the map boundary the way plausibleCeiling already coerces
  // ceilingPrice - one shared normalisation - not to loosen this predicate.
  if (!Number.isFinite(minDecrement) || !(minDecrement > 0)) return [];
  const out = [];
  const last = ladder.length - 1;
  for (let to = 1; to < last; to++) { // `to < last` is precisely "never a step INTO the floor rung"
    const gap = ladder[to - 1] - ladder[to];
    const lineShort = Array.isArray(scaled) && scaled.some((l) => l.amounts[to - 1] - l.amounts[to] < minDecrement);
    if (gap < minDecrement || lineShort) {
      out.push({ fromIndex: to - 1, toIndex: to, fromPrice: ladder[to - 1], toPrice: ladder[to], gap });
    }
  }
  return out;
}

/**
 * THE STEP INTO THE FLOOR RUNG - the one step decrementViolations deliberately does not walk.
 *
 * The floor is the reserved decisive shot and _maybeBid exempts it from the min-decrement guard, so
 * it is ATTEMPTED whatever its spacing. decrementViolations mirrors that exemption on purpose (its
 * alert must never claim a refusal the engine would not hit) and returns [] outright below three
 * rungs. The consequence is that the one step nothing refuses is also the one step nothing reports:
 * the engine fires it, the portal measures it like any other revision, and the load closes having
 * bid one fewer time than the desk was shown.
 *
 * This is the PLATFORM's view, the same side deriveSpacedLadder takes (see its EVERY GAP IS MEASURED
 * HERE note). Detection only - the ladder is not reshaped, because whether SuperProcure really
 * enforces loadBidDifference on this step is unsettled in this codebase and cannot be settled off a
 * live bid.
 *
 * MEASURED FROM THE LAST LANDABLE RUNG, not from the adjacent index, and that is the whole
 * arithmetic. A middle rung the portal will refuse is never sent, so the step it would have made is
 * never measured - the gap that reaches the floor is the one from the last price that can actually
 * land above it, which is only ever WIDER. Comparing adjacent pairs instead would report a violation
 * on every ladder carrying an unfireable middle, which is the commonest shape there is.
 *
 * WHICH OF THE TWO CONDITIONS BOUND, because fittingRungs excludes on EITHER the blended gap or any
 * one line's own gap, and reporting the blended pair for a per-line exclusion prints arithmetic that
 * contradicts itself - "only Rs 1200 above ... under a minimum of Rs 1000" on a load whose cheap
 * line actually moved Rs 400. `bindingLine` is null when the blended step is what fell short, and
 * otherwise carries the tightest failing line's own amounts, which are what the portal measured.
 *
 * @param {number[]} ladder - the descending rung prices, floor last.
 * @param {number} minDecrement - this load's minimum bid difference.
 * @param {Array} [scaled] - scaleLadderByType's per-line amounts, where the desk priced per type.
 * @returns {{fromPrice: number, toPrice: number, gap: number, minDecrement: number,
 *   rungsLandable: number, bindingLine: {label: ?string, fromPrice: number, toPrice: number,
 *   gap: number}|null}|null} - null when the floor rung can land, or when the decrement is not a
 *   finite positive number the engine could act on.
 */
function floorStepViolation(ladder, minDecrement, scaled) {
  if (!Array.isArray(ladder) || ladder.length < 2) return null;
  if (!Number.isFinite(minDecrement) || !(minDecrement > 0)) return null;
  const landable = fittingRungs(ladder, minDecrement, scaled);
  const toIndex = ladder.length - 1;
  const toPrice = ladder[toIndex];
  const fromPrice = landable[landable.length - 1];
  if (fromPrice === toPrice) return null;
  // The same index fittingRungs measured from - its `prev`, the last rung that actually landed - so
  // the per-line amounts compared here are the ones that decided the exclusion, not an adjacent pair.
  // Price identifies the index exactly: every producer of a ladder here emits it strictly descending
  // and deduped (buildBandLadder, capLadderToCeiling, roundLadderToGrid all enforce it).
  const fromIndex = ladder.indexOf(fromPrice);
  let bindingLine = null;
  if (fromPrice - toPrice >= minDecrement && Array.isArray(scaled)) {
    for (const s of scaled) {
      const gap = s.amounts[fromIndex] - s.amounts[toIndex];
      if (gap < minDecrement && (!bindingLine || gap < bindingLine.gap)) {
        bindingLine = { label: s.label || null, fromPrice: s.amounts[fromIndex], toPrice: s.amounts[toIndex], gap };
      }
    }
  }
  return { fromPrice, toPrice, gap: fromPrice - toPrice, minDecrement, rungsLandable: landable.length, bindingLine };
}

/**
 * DERIVE A LADDER THE PLATFORM WILL ACTUALLY ACCEPT - the repair half of what decrementViolations
 * only detects. Rung spacing comes from the desk's MARGINS (cost x (margin_i - margin_j) / 100) and
 * the minimum bid difference comes from the shipper's branch; nothing reconciled them, so a load
 * whose margins sit close together at its cost built three prices of which only two could ever be
 * sent, silently.
 *
 * TWO ANCHORS NEVER MOVE. ladder[0] is the desk's top margin, and raising it quotes above what the
 * desk authorised - the exact thing roundLadderToGrid refuses at grid_wider_than_band. The last rung
 * is the band's lowest price; moving it breaks arm()'s own assertion that a
 * capped ladder's last rung equals plan.floor, and the floor invariant with it.
 *
 * EVERY GAP IS MEASURED HERE, INCLUDING THE STEP INTO THE LAST RUNG - and that is deliberately
 * STRICTER than decrementViolations, which exempts it. The exemption in the engine (isFloorRung at
 * _maybeBid) is a best-effort ATTEMPT at the decisive shot, not permission from the platform: the
 * portal applies its rule to that revision like any other. decrementViolations mirrors the engine's
 * looser view so its alert can never claim a refusal the engine would not hit; this function mirrors
 * the PLATFORM. Both are correct for their caller. If they are ever merged, the merge goes toward
 * this one.
 *
 * THE PLACEMENT RULE, walking the middles with `prev` = the last accepted price and `rem` = middles
 * still to place after this one:
 *     hi = prev - minDecrement                 latest legal price under our own previous rung
 *     lo = lastRung + (rem + 1) * minDecrement  earliest legal price that still leaves room below
 *     lo > hi -> no legal slot exists: drop this rung and every remaining middle
 *     else    -> min(hi, max(lo, anchor))
 * Down first: min(hi, ...) is the only clamp that fires in the ordinary case, and down is the
 * competitive direction in a reverse auction - the same money decision roundLadderToGrid states. Up
 * fires only when a desk price sits so close above the last rung that it would strand the rungs
 * below it, and it is bounded by hi, so it can never rise above its predecessor or above the
 * opening.
 *
 * FLOOR-SAFE BY CONSTRUCTION: lo >= lastRung + minDecrement > lastRung, so no derived rung can land
 * at or below the operating price and assertAboveFloor keeps its meaning unchanged.
 *
 * NO-OP GUARANTEE, which the deploy safety argument leans on: if every adjacent gap already clears
 * minDecrement then min(hi, max(lo, a_i)) === a_i for every middle, so every ladder that works today
 * comes back byte-identical and a rehydrate remaps its fired rungs index-for-index.
 *
 * @param {Object} opts
 * @param {number[]} opts.ladder - the descending rung prices, operating floor last.
 * @param {number} opts.floor - the operating floor (returned unchanged; the last rung is pinned).
 * @param {number} opts.minDecrement - the minimum gap the platform will accept between our own
 *   successive bids on this load.
 * @returns {{ladder: number[], floor: number, dropped: Array<{index, price, reason}>,
 *   moved: Array<{index, from, to, gapBefore}>, fits: number, requested: number, applied: boolean,
 *   reason: string|null}}
 */
function deriveSpacedLadder({ ladder, floor, minDecrement }) {
  const requested = Array.isArray(ladder) ? ladder.length : 0;
  const untouched = (reason) => ({ ladder, floor, dropped: [], moved: [], fits: requested,
    requested, applied: false, reason });
  if (!Array.isArray(ladder) || ladder.length < 2) return untouched('ladder_too_short');
  // Mirrors decrementViolations' predicate exactly: a decrement the engine cannot act on is not a
  // constraint to reshape prices around.
  if (!Number.isFinite(minDecrement) || !(minDecrement > 0)) return untouched('no_min_decrement');
  const lastRung = ladder[ladder.length - 1];
  const out = [ladder[0]];
  const dropped = [];
  const moved = [];
  let prev = ladder[0];
  for (let i = 1; i < ladder.length - 1; i++) {
    const rem = ladder.length - 2 - i;
    const hi = prev - minDecrement;
    const lo = lastRung + (rem + 1) * minDecrement;
    if (lo > hi) {
      // DROP THIS ONE AND KEEP WALKING - never the whole tail. `lo` falls by minDecrement with every
      // later index (there is one less rung to reserve room for) while `hi` is unchanged until a rung
      // is actually accepted, so a rung that does not fit says nothing about the ones below it.
      // Abandoning the tail here threw away legal attempts on live money: the 4-anchor band
      // [33780, 33000, 32160, 30810] at a 1000 minimum came back as two prices when
      // [33780, 32160, 30810] fits with 1620 and 1350 to spare.
      dropped.push({ index: i, price: ladder[i], reason: 'no_legal_slot' });
      continue;
    }
    const price = Math.min(hi, Math.max(lo, ladder[i]));
    if (price !== ladder[i]) moved.push({ index: i, from: ladder[i], to: price, gapBefore: ladder[i - 1] - ladder[i] });
    out.push(price);
    prev = price;
  }
  out.push(lastRung);
  return { ladder: out, floor, dropped, moved, fits: fittingRungs(out, minDecrement).length,
    requested, applied: dropped.length > 0 || moved.length > 0, reason: null };
}

/**
 * WHICH of a ladder's prices can actually reach the board, and therefore how many attempts the desk
 * really has. Greedy from the opening: a rung is reachable when its gap from the last REACHABLE rung
 * clears the minimum, which is the right unit because skipping a rung only ever WIDENS the gap the
 * engine measures against its own last bid (the same argument decrementViolations makes for adjacent
 * pairs). So a ladder with one tight middle degrades to two prices, not to one.
 *
 * `scaled` is the per-truck-type amounts (scaleLadderByType) when the desk priced each type
 * separately: the portal applies its minimum to the amount on each LINE, so a rung is reachable only
 * when the blended amount AND every line's own amount clear it.
 */
function fittingRungs(ladder, minDecrement, scaled, { lastRungAlwaysAttempted = false } = {}) {
  if (!Array.isArray(ladder) || !ladder.length) return [];
  if (!Number.isFinite(minDecrement) || !(minDecrement > 0)) return ladder.slice();
  const last = ladder.length - 1;
  const out = [ladder[0]];
  let prev = 0;
  for (let i = 1; i < ladder.length; i++) {
    // THE LAST RUNG IS A DIFFERENT QUESTION, and which answer is right depends on who is asking.
    // The PLATFORM measures its minimum on that step like any other, which is why the derivation
    // above counts it. The ENGINE attempts it regardless - _maybeBid exempts isFloorRung and the
    // snipe from the guard, because the decisive shot is the one that must never be silently
    // dropped. A sentence that says "we will send" is a claim about the ENGINE, so the desk-facing
    // count passes this flag and the strict count (used to shape prices) does not. Without the
    // split the page told a desk "we will send Rs 20,268 and nothing after it" on a load where the
    // bot then fired the floor too, inviting them to widen the band and give away margin to buy
    // back an attempt they already had.
    if (lastRungAlwaysAttempted && i === last) { out.push(ladder[i]); prev = i; continue; }
    if (ladder[prev] - ladder[i] < minDecrement) continue;
    if (scaled && scaled.some((s) => s.amounts[prev] - s.amounts[i] < minDecrement)) continue;
    out.push(ladder[i]);
    prev = i;
  }
  return out;
}

/**
 * THE AMOUNTS EACH RUNG ACTUALLY SENDS on a load the desk priced per truck type. This is the pricing
 * side's mirror of the adapter's own scaling (gocometAdapter.resolvePerTypePrices: the rung is read
 * as a multiplier over the blended cost it was built from and re-applied to each type's own cost),
 * and the two must produce identical numbers - pinned by scripts/test-ladder-min-decrement.js, which
 * runs a fixture through both. It is duplicated rather than imported because pricing/ sits under the
 * platform seam and may not reach up into a specific adapter.
 *
 * Returns null for the uniform path (one rate) and for a vector this build cannot use - a junk
 * vector is refused loudly at bid time by the adapter, and inventing per-line spacing for it here
 * would be a guess.
 */
function scaleLadderByType(ladder, costByType) {
  const types = costByType && Array.isArray(costByType.types) ? costByType.types : null;
  if (!Array.isArray(ladder) || !ladder.length || !types || types.length < 2) return null;
  const base = Number(costByType.cost);
  if (!Number.isFinite(base) || base <= 0) return null;
  const out = [];
  for (const t of types) {
    const cost = Number(t && t.cost);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    out.push({ label: (t && t.label) || null, cost, amounts: ladder.map((p) => Math.round(p * cost / base)) });
  }
  return out;
}

/**
 * The minimum gap to SPACE A BLENDED LADDER BY so that every truck type's own line still clears the
 * platform minimum. A rung sends cost_t / base times the blended amount, so on a type cheaper than
 * the blend the sent gap SHRINKS by that ratio - a blended ladder that clears the minimum can still
 * put two refused amounts on the cheap line. Scaling the requirement up by base / cost_t is the same
 * constraint expressed in the space the ladder is built in.
 *
 * ceil() is what makes it exact rather than approximately right: with a blended gap of at least
 * ceil(minDecrement x base / cost_t) the exact per-type difference is >= minDecrement, and rounding
 * two prices onto integers cannot pull their difference below it.
 */
function perTypeMinDecrement(minDecrement, costByType) {
  if (!Number.isFinite(minDecrement) || !(minDecrement > 0)) return minDecrement;
  const types = costByType && Array.isArray(costByType.types) ? costByType.types : null;
  const base = Number(costByType && costByType.cost);
  if (!types || types.length < 2 || !Number.isFinite(base) || base <= 0) return minDecrement;
  let need = minDecrement;
  for (const t of types) {
    const cost = Number(t && t.cost);
    if (!Number.isFinite(cost) || cost <= 0) return minDecrement; // unusable vector -> the uniform rule
    need = Math.max(need, Math.ceil((minDecrement * base) / cost));
  }
  return need;
}

/**
 * The floor invariant, asserted right before any bid leaves the building.
 *
 * BOTH operands must be real numbers, and the floor is the one that used to be taken on trust. A
 * bare `price >= costFloor` reads an UNKNOWN floor as no floor at all - `5000 >= null` is
 * `5000 >= 0` - so the single assertion protecting live money passed on null, '', [] and false
 * alike, in the exact direction that costs money. The mirror assertion (assertBelowCeiling) already
 * throws on every one of those. No caller reaches this with a non-finite floor today, which is what
 * makes fail-closed free: the throw is a backstop against a future one, never a working part.
 */
function assertAboveFloor(price, costFloor) {
  if (!Number.isFinite(costFloor) || !(price >= costFloor)) {
    const e = new Error(`floor_breach: price ${price} < costFloor ${costFloor}`);
    e.code = 'FLOOR';
    throw e;
  }
  return price;
}

/**
 * A shipper CEILING price caps the bid: we must NEVER bid above it (SuperProcure rejects a bid over
 * the ceiling, and on 430 loads - mostly Havells - it is the real constraint). But SuperProcure's
 * numeric fields lie (the year-2100 placeholder close time is the canonical example), so a ceiling
 * is enforced ONLY when it is PLAUSIBLE: a finite number > 0 AND within a sane upper bound (<= 1e9,
 * ~100 crore - far above any real single-load freight ceiling, so a bigger value is a placeholder/
 * overflow sentinel the way the year-2100 close is, not a real cap). An absent, null, blank,
 * non-numeric, zero, negative, or implausibly-large ceiling is IGNORED (returns null) - which is
 * money-SAFE, because with no ceiling applied the cost floor still fully protects the downside (an
 * un-capped bid can only ever bid too HIGH and lose the auction, never below cost). Coerces a string
 * ("120000" / "90000.00" off the wire) the same way the carrier id is numeric-normalised at
 * buildBidPayload, trimming surrounding whitespace so a padded field still parses.
 * This is the SINGLE source of "is this ceiling real", shared by the map boundary (deriveLoadRules /
 * realAdapter._mapLoad re-export this), the adapter's ceiling belt, and the engine's ladder cap, so
 * they can never disagree about whether a ceiling is in force.
 */
function plausibleCeiling(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;   // garbage ("n/a", etc.) -> unknown, never NaN downstream
  if (n <= 0) return null;                // 0 / -1 sentinel -> no real ceiling
  if (n > 1e9) return null;               // placeholder/overflow sentinel (year-2100-class) -> reject, fail closed
  return n;
}

/**
 * The CEILING invariant, asserted right before any bid leaves the building - the upper-bound mirror
 * of assertAboveFloor. Throws a CEILING-coded error if the amount would exceed the ceiling; NEVER
 * clamps (the caller fails closed, it does not silently lower the bid). `!(price <= ceiling)` also
 * rejects a NaN price, so a bad amount fails closed rather than fail-open.
 */
function assertBelowCeiling(price, ceiling) {
  if (!(price <= ceiling)) {
    const e = new Error(`ceiling_breach: price ${price} > ceiling ${ceiling}`);
    e.code = 'CEILING';
    throw e;
  }
  return price;
}

/**
 * Cap a descending ladder at a ceiling: every rung above the ceiling is lowered TO the ceiling, then
 * the ladder is de-duped back to strictly descending. The caller MUST only call this when the
 * ceiling is >= the floor (the lowest rung), so the floor rung is never raised and the hard floor
 * invariant is preserved (min(floor, ceiling) === floor). A ceiling at or above the opening rung
 * leaves the ladder byte-identical (every min() is a no-op). This is the "clamp the ladder to the
 * ceiling" the scope calls for - a VISIBLE cap of the plan (surfaced on the armed event + logged at
 * arm time), NOT a silent adjustment of a bid amount at the wire (that stays forbidden - the
 * amount-level guarantee is assertBelowCeiling, which throws rather than clamps).
 */
function capLadderToCeiling(ladder, ceiling) {
  const capped = [];
  for (const r of ladder) {
    const v = Math.min(r, ceiling);
    if (capped.length === 0 || v < capped[capped.length - 1]) capped.push(v);
  }
  return capped;
}

// The admissible rupee grid, ONE definition shared by every layer that gates it (config boot, the
// configStore save validator, the engine's own coercion) so they can never drift into accepting
// different values. MIN is 2 because 1 is "no grid" and 0/negative are meaningless; MAX is a chosen
// belt against a fat-fingered save, not a measured limit - a wide grid is separately refused per-load
// by the grid_wider_than_band branch below, which is the real protection.
const ROUNDING_STEP_MIN = 2;
const ROUNDING_STEP_MAX = 5000;

/**
 * ROUND A LADDER ONTO A RUPEE GRID, for a shipper that refuses odd amounts and considers only round
 * figures. Applied to the FINISHED ladder, never to the margin band: the desk's margins stay exactly
 * what the desk set, and only the prices that leave the building are snapped.
 *
 * DIRECTION IS THE MONEY DECISION, and "nearest" is the wrong answer - it is a coin flip between the
 * two real options with no invariant behind it. Rungs round DOWN (the competitive direction in a
 * reverse auction), EXCEPT where down would breach the operating floor. The floor can only ever round
 * UP, so the returned floor is ceil(floor / step) * step and every rung is clamped to it.
 *
 * THE FLOOR MOVES ONTO THE GRID, and that is load-bearing rather than incidental. arm() asserts that
 * a ceiling-capped ladder's last rung EQUALS plan.floor; return the un-snapped floor and every
 * ceiling-carrying load on an opted-in shipper throws FLOOR at arm and never bids. Raising it is also
 * strictly safer - the returned floor is >= the one it replaces, so a bid clearing the new floor
 * clears the old by construction. Bounded cost: at most step - 1 rupees, on the one rung where the
 * shipper's rule and our floor genuinely conflict.
 *
 * THE BAND IS A CEILING ON THE SNAP, NOT ONLY A FLOOR. When the grid is wide relative to the band's
 * rupee span, ceil(floor/step)*step lands ABOVE the opening rung and every rung clamps up to it - the
 * ladder collapses to one price ABOVE the top margin the desk authorised (step 5000 on a 20,000 cost
 * bid 25,000, a 25% margin against an authorised 12.6%). There is no legal on-grid price between the
 * floor and the opening in that case, so this REFUSES rather than inventing one outside the band:
 * `applied: false` and the input returned untouched, the same fail-open-to-today direction every
 * other gate in this feature takes. Bidding an un-round price loses the auction; bidding above the
 * desk's authorised band is a quote nobody approved.
 *
 * COLLAPSE IS REAL. Snapping deduplicates, so adjacent rungs closer together than `step` land on one
 * grid point and a 3-rung band on a tight cost can come back as 2 rungs or 1. That is a strategy
 * change, not a rendering detail - hence the caller's log when the count drops.
 *
 * @param {Object} opts
 * @param {number[]} opts.ladder - the descending rung prices, floor last.
 * @param {number} opts.floor - the operating floor (the ladder's lowest rung).
 * @param {number} opts.step - the grid, in rupees (100 = round figures to the hundred).
 * @returns {{ladder: number[], floor: number, applied: boolean, reason: string|null}} - snapped,
 *   strictly descending, floor last; or the input untouched with applied:false and a reason.
 */
function roundLadderToGrid({ ladder, floor, step }) {
  const untouched = (reason) => ({ ladder, floor, applied: false, reason });
  if (!Array.isArray(ladder) || ladder.length === 0) return untouched('empty_ladder');
  if (!Number.isInteger(step) || step <= 1) return untouched('no_grid');
  if (!Number.isFinite(floor) || !(floor > 0)) return untouched('no_floor');
  const gridFloor = Math.ceil(floor / step) * step;
  // No on-grid price exists between the floor and the opening: snapping here could only quote above
  // the desk's band. Refuse the grid instead of moving the opening up to meet it.
  if (gridFloor > ladder[0]) return untouched('grid_wider_than_band');
  const out = [];
  for (const p of ladder) {
    const down = Math.floor(p / step) * step;
    const v = down >= gridFloor ? down : gridFloor; // below the grid floor there is exactly one legal price
    if (out.length === 0 || v < out[out.length - 1]) out.push(v);
  }
  if (out[out.length - 1] !== gridFloor) out.push(gridFloor);
  return { ladder: out, floor: gridFloor, applied: true, reason: null };
}

/** Parse "HH:MM:SS" -> seconds (SuperProcure auction-extend time). */
function parseHMS(s) {
  if (typeof s !== 'string') return 0;
  const m = s.match(/(\d+):(\d+):(\d+)/);
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

/**
 * Margin-band ladder — the SuperProcure / BRL model. Bid = cost x (1 + margin).
 * Opens at the MAX margin (fattest), eases down to the MIN margin (= the floor).
 * `rungs` = how many price points to use (cap at the load's allowed bid count;
 * Syngenta=3 -> coarse 12/8/6, Renewsys=30 -> fine steps). Floor is hard.
 */
function buildMarginLadder({ cost, maxMarginPct = 12, minMarginPct = 6, rungs = 3 }) {
  if (!(cost > 0)) throw new Error('cost must be > 0');
  const opening = Math.round(cost * (1 + maxMarginPct / 100));
  const floor = Math.round(cost * (1 + minMarginPct / 100));
  rungs = Math.max(2, Math.round(rungs));
  const raw = [];
  for (let i = 0; i < rungs; i++) {
    const f = i / (rungs - 1);
    const eased = f * f; // shed margin slowly early, faster late
    raw.push(Math.max(floor, Math.round(opening - (opening - floor) * eased)));
  }
  const ladder = [];
  for (const p of raw) if (ladder.length === 0 || p < ladder[ladder.length - 1]) ladder.push(p);
  if (ladder[ladder.length - 1] !== floor) ladder.push(floor);
  return { opening, floor, ladder, maxMarginPct, minMarginPct };
}

module.exports = { buildLadder, computeUndercut, maxImprovementPrice, assertAboveFloor, buildMarginLadder, buildBandLadder, parseHMS,
  plausibleCeiling, assertBelowCeiling, capLadderToCeiling, decrementViolations, selectRung, interpolateBandLadder,
  roundLadderToGrid, ROUNDING_STEP_MIN, ROUNDING_STEP_MAX,
  deriveSpacedLadder, fittingRungs, scaleLadderByType, perTypeMinDecrement, floorStepViolation,
  effectiveFloorMarginPct, floorMarginSubstitution };
