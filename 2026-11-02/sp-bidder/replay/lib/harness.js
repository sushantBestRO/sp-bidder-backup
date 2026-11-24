'use strict';
/**
 * ReplayHarness — drives an engine through a reconstructed auction on a virtual clock.
 *
 * ============================================================================================
 * THE ENGINE DRIVER INTERFACE  (this is the whole contract; you do not need to read the rest)
 * ============================================================================================
 * An engine is replayed by supplying a driver object. Five members, only two required:
 *
 *   {
 *     name: 'my-engine@v3',                  // REQUIRED. Appears in the report.
 *
 *     init(ctx) -> engineState,              // REQUIRED. Called once, before the first tick.
 *                                            //   ctx = { auction, limits, clock, floor, ceiling }
 *                                            //   Return anything; it is handed back on every call.
 *
 *     onTick(engineState, obs) -> decision,  // REQUIRED. Called once per tick, in time order.
 *                                            //   Return null to hold, or { price, ...meta } to bid.
 *                                            //   `price` must be a finite number. Any other keys
 *                                            //   (rungIndex, defend, snipe, ...) are carried
 *                                            //   through to the report untouched.
 *
 *     onResult(engineState, result),         // OPTIONAL. Outcome of a returned decision.
 *                                            //   result = { accepted, reason, price, obs }
 *
 *     finalize(engineState, outcome),        // OPTIONAL. Called once after the close.
 *   }
 *
 * THE OBSERVATION (`obs`) is deliberately shaped like the production adapter's getAuctionState
 * return (src/platform/adapter.js:72-90) so the SuperProcure engine plugs in with a thin driver:
 *
 *   { ok, nowMs, myRank, totalBidders, standingL1Price, closesInMs, closesAtMs, revisionsLeft,
 *     revisionLimit, closeModel, minDecrement, extendMs, extendCount, triggerWindowMs,
 *     measuredRttMs }
 *
 * `standingL1Price` is ALWAYS null and that is structural, not incidental — see below.
 *
 * ============================================================================================
 * THE HONESTY BOUNDARY  (read this before adding any metric)
 * ============================================================================================
 * SuperProcure MASKS external competitor bid amounts: the socket only ever exposes BRL's own
 * account for non-self rows, and the 2026-07-13 capture confirms it (all 8 bidDetails rows are
 * Best Roadways Limited). The GoComet logs are BRL's own bot's output and contain no rival prices
 * either. The harness therefore CANNOT compute, and MUST NOT report:
 *
 *     - a counterfactual win rate            - a clearing price
 *     - "we would have won this"             - any rival's price, modelled or estimated
 *
 * There is no competitor-price field anywhere in this harness for such a number to live in, and
 * `standingL1Price` is pinned to null so an engine cannot accidentally receive one. Rank IS
 * legitimately available and is the one competitive read the platform does not mask.
 *
 * A SECOND, SUBTLER BOUNDARY — the replay is OPEN-LOOP. Rank and close-time movement are replayed
 * from the record; the engine's own replayed bids do NOT feed back into them, because computing
 * the market's response would require exactly the competitor prices we cannot see. So rank in a
 * replay is EXOGENOUS: it is the rank BRL's recorded bot held at that instant, not a rank the
 * replayed engine earned. Every rank-derived metric is labelled accordingly. What the harness
 * measures is BEHAVIOURAL CORRECTNESS — did the engine fire, when, within budget, within its
 * constraints, did it survive the extension war — never outcome.
 */

const { VirtualClock } = require('./clock');

const DEFAULTS = {
  coarseTickMs: 30_000,   // cadence far from close
  fineTickMs: 1_000,      // cadence inside the endgame window
  fineWindowMs: 180_000,  // how long before each believed close to switch to fine cadence
  maxTicks: 20_000,       // runaway guard; truncation is reported, never silent
};

/**
 * Build the tick schedule for an auction. Deterministic: same auction in, identical instants out.
 *
 * Every recorded observation instant and every extension instant is always a tick, so the engine
 * sees each clock movement at exactly the moment the record shows it becoming visible — which
 * faithfully reproduces the poll-aliasing the real bot experienced rather than papering over it.
 */
function buildTickSchedule(auction, cfg) {
  const instants = new Set();
  const add = (t) => { if (Number.isFinite(t) && t >= auction.openMs && t <= auction.finalCloseMs) instants.add(Math.round(t)); };

  add(auction.openMs);
  add(auction.finalCloseMs);
  for (const o of (auction.closeTimeline || [])) add(o.atMs);
  for (const e of (auction.extensions || [])) { add(e.atMs); add(e.fromMs); add(extensionVisibleAt(e)); }
  for (const b of (auction.ourBids || [])) add(b.atMs);

  // Endgame windows: fine cadence before every believed close (the original and each extended one).
  const closes = [auction.originalCloseMs, auction.finalCloseMs];
  for (const e of (auction.extensions || [])) { closes.push(e.fromMs); closes.push(e.toMs); }
  for (const c of closes) {
    if (!Number.isFinite(c)) continue;
    for (let t = c; t >= c - cfg.fineWindowMs; t -= cfg.fineTickMs) add(t);
  }
  // Coarse backbone across the whole window.
  for (let t = auction.openMs; t <= auction.finalCloseMs; t += cfg.coarseTickMs) add(t);

  const arr = [...instants].sort((a, b) => a - b);
  if (arr.length <= cfg.maxTicks) return { ticks: arr, truncated: false };
  // Keep the LAST maxTicks instants — the endgame is what matters — and record the truncation.
  return { ticks: arr.slice(arr.length - cfg.maxTicks), truncated: true, droppedTicks: arr.length - cfg.maxTicks };
}

/**
 * Believed close at instant t: the close in effect at t.
 *
 * Keyed off `visibleFromMs` (when the moved deadline was in effect), NOT `atMs` (when BRL's bot
 * happened to notice). See the note on visibleFromMs in reconstruct.js — using atMs makes every
 * poll-aliased auction appear to end at its original close and silently truncates the replay.
 */
function extensionVisibleAt(e) {
  return e.visibleFromMs != null ? e.visibleFromMs : e.atMs;
}

function believedCloseAt(auction, t) {
  let believed = auction.originalCloseMs;
  for (const e of (auction.extensions || [])) {
    if (extensionVisibleAt(e) <= t) believed = e.toMs; else break;
  }
  return believed;
}

/**
 * Number of clock-move BOUNDARIES visible at instant t.
 *
 * Counts EVENTS, not rounds. An aliased slide contributes one boundary even though it collapsed
 * two or more real rounds, because what the engine (and the revision-reset policy) reacts to is
 * "the deadline just moved", which happened once as far as any observer could tell. Round counts
 * come from `confirmedRoundsLowerBound` and are deliberately a different number.
 */
function extensionsSeenAt(auction, t) {
  let n = 0;
  for (const e of (auction.extensions || [])) { if (extensionVisibleAt(e) <= t) n += 1; else break; }
  return n;
}

/**
 * Exogenous rank at instant t: BRL's recorded rank at or before t. Null before the first record.
 * NOT a rank the replayed engine earned — see the honesty boundary above.
 */
function recordedRankAt(auction, t) {
  let rank = null;
  for (const b of (auction.ourBids || [])) {
    if (b.atMs <= t) { if (b.rank != null) rank = b.rank; } else break;
  }
  return rank;
}

class ReplayHarness {
  constructor(opts = {}) {
    this.cfg = Object.assign({}, DEFAULTS, opts);
  }

  /**
   * Replay one auction against one driver.
   * @returns ReplayResult — see metrics.js for what is derived from it.
   */
  run(auction, driver, runOpts = {}) {
    if (!driver || typeof driver.onTick !== 'function' || typeof driver.init !== 'function') {
      throw new Error('driver must implement init(ctx) and onTick(state, obs)');
    }
    const cfg = this.cfg;
    const { ticks, truncated, droppedTicks } = buildTickSchedule(auction, cfg);
    const clock = new VirtualClock(auction.openMs);

    const limits = deriveLimits(auction, runOpts);
    const floor = runOpts.floor != null ? runOpts.floor : null;
    const ceiling = runOpts.ceiling != null ? runOpts.ceiling : limits.ceilingPrice;

    let revisionsLeft = limits.revisionLimit;
    const bids = [];
    const rejections = [];
    const violations = [];
    let ticksRun = 0;
    let extensionsSeenPrev = 0;
    let revisionResets = 0;

    // Whether the platform's revision budget RESETS on each anti-snipe round.
    //
    // This is the single highest-value open unknown on GoComet and it decides whether a deep
    // extension war is winnable at all. The evidence (60 in-band boundaries in BRL's own logs:
    // 43 increased, 13 unchanged, 4 decreased, with successful bids from an exhausted budget)
    // points to RESET at medium-high confidence — but it is n=60 from a stale corpus, so the
    // engine's production default stays conservative. The harness therefore replays BOTH and the
    // report shows the behavioural difference, which is the comparison it exists to produce.
    const revisionPolicy = runOpts.revisionPolicy || 'no-reset';
    if (revisionPolicy !== 'no-reset' && revisionPolicy !== 'reset-per-round') {
      throw new Error(`unknown revisionPolicy '${revisionPolicy}' (expected 'no-reset' or 'reset-per-round')`);
    }

    const state = driver.init({ auction, limits, clock, floor, ceiling });

    // The latest instant at which a recorded extension still becomes visible. While that instant
    // is ahead of us the auction PROVABLY continued — a recorded extension is evidence the close
    // did not hold — so the run must not terminate at a believed close that was about to move.
    //
    // Without this the replay dies on sub-second jitter: `believed` drifts a few hundred ms past
    // `originalCloseMs` while tracking noise, so the first extension's effective instant can land
    // a hair AFTER the original close and the loop breaks ~150ms before learning about it. That
    // silently truncated every aliased auction in the first run of this harness.
    let lastExtensionVisibleMs = -Infinity;
    for (const e of (auction.extensions || [])) {
      lastExtensionVisibleMs = Math.max(lastExtensionVisibleMs, extensionVisibleAt(e));
    }

    for (const t of ticks) {
      clock.advanceTo(t);
      ticksRun += 1;
      const believedClose = believedCloseAt(auction, t);
      if (t > believedClose && t > lastExtensionVisibleMs) break;   // genuinely over

      const seenNow = extensionsSeenAt(auction, t);
      if (revisionPolicy === 'reset-per-round' && seenNow > extensionsSeenPrev && limits.revisionLimit != null) {
        revisionsLeft = limits.revisionLimit;
        revisionResets += 1;
      }
      extensionsSeenPrev = seenNow;

      const obs = {
        ok: true,
        nowMs: t,
        myRank: recordedRankAt(auction, t),
        totalBidders: null,                 // never exposed by either platform's record
        standingL1Price: null,              // STRUCTURAL: competitor amounts are masked
        // Clamped at 0: inside the brief window where the old close has passed but the extension
        // has not yet surfaced, a live poller reads "about to close", never a negative countdown.
        closesInMs: Math.max(0, believedClose - t),
        closesAtMs: believedClose,
        revisionsLeft,
        revisionLimit: limits.revisionLimit,
        closeModel: limits.closeModel,
        minDecrement: limits.minDecrement,
        extendMs: limits.extendMs,
        extendCount: limits.extendCount,
        triggerWindowMs: limits.triggerWindowMs,
        measuredRttMs: 0,
        extensionsSeen: seenNow,
      };

      let decision = null;
      try {
        decision = driver.onTick(state, obs);
      } catch (e) {
        violations.push({ atMs: t, kind: 'driver_threw', detail: e && e.message ? e.message : String(e) });
        continue;
      }
      if (!decision) continue;

      const result = this._applyDecision({ decision, obs, floor, ceiling, revisionsLeft, limits });
      if (result.accepted) {
        revisionsLeft = revisionsLeft == null ? null : revisionsLeft - 1;
        bids.push({
          atMs: t,
          price: decision.price,
          msBeforeBelievedClose: believedClose - t,
          msBeforeFinalClose: auction.finalCloseMs - t,
          extensionsSeen: obs.extensionsSeen,
          rankAtFire: obs.myRank,
          revisionsLeftAfter: revisionsLeft,
          meta: omit(decision, ['price']),
        });
      } else {
        rejections.push({ atMs: t, price: decision.price, reason: result.reason });
      }
      for (const v of result.violations) violations.push(Object.assign({ atMs: t }, v));
      if (typeof driver.onResult === 'function') {
        // `decision` is passed through so a driver can mirror its engine's accepted-bid state
        // transitions (rung ladder, snipe/defend latches). Existing drivers that ignore it are
        // unaffected — the added key is additive.
        try { driver.onResult(state, { accepted: result.accepted, reason: result.reason, price: decision.price, obs, decision }); }
        catch (e) { violations.push({ atMs: t, kind: 'driver_threw_onResult', detail: String(e && e.message || e) }); }
      }
    }

    const outcome = {
      auctionId: auction.enquiryKey != null ? `${auction.enquiryKey}#${auction.segment}` : auction.scenarioId,
      bids, rejections, violations, ticksRun, truncated, droppedTicks: droppedTicks || 0,
    };
    if (typeof driver.finalize === 'function') {
      try { driver.finalize(state, outcome); } catch (e) {
        violations.push({ atMs: auction.finalCloseMs, kind: 'driver_threw_finalize', detail: String(e && e.message || e) });
      }
    }

    return {
      driver: driver.name || 'unnamed',
      auctionId: outcome.auctionId,
      kind: auction.kind,
      platform: auction.platform,
      openMs: auction.openMs,
      originalCloseMs: auction.originalCloseMs,
      finalCloseMs: auction.finalCloseMs,
      extensionsInAuction: (auction.extensions || []).length,
      // ONLY in-band anti-snipe rounds. Aliased slides moved the clock but their round count is
      // not recoverable, so they are excluded here and reported separately.
      roundsLowerBound: auction.confirmedRoundsLowerBound != null
        ? auction.confirmedRoundsLowerBound
        : (auction.scriptedRounds || 0),
      aliasedSlides: auction.aliasedSlides || 0,
      limits, floor, ceiling,
      revisionPolicy, revisionResets,
      bids, rejections, violations,
      ticksRun, truncated, droppedTicks: droppedTicks || 0,
      revisionsLeftAtClose: revisionsLeft,
    };
  }

  _applyDecision({ decision, obs, floor, ceiling, revisionsLeft, limits }) {
    const violations = [];
    const price = decision.price;
    if (!Number.isFinite(price)) return { accepted: false, reason: 'invalid_price', violations };
    if (revisionsLeft != null && revisionsLeft <= 0) return { accepted: false, reason: 'no_revisions_left', violations };
    if (price <= 0) return { accepted: false, reason: 'invalid_price', violations };

    // Constraint violations are RECORDED, not silently corrected — the point is to surface an
    // engine that would have breached, not to protect it from itself.
    if (floor != null && price < floor) {
      violations.push({ kind: 'floor_breach', price, floor, detail: `bid ${price} below floor ${floor}` });
    }
    if (ceiling != null && price > ceiling) {
      violations.push({ kind: 'ceiling_breach', price, ceiling, detail: `bid ${price} above ceiling ${ceiling}` });
      return { accepted: false, reason: 'above_ceiling', violations };
    }
    return { accepted: true, reason: null, violations };
  }
}

function deriveLimits(auction, runOpts) {
  if (auction.platform === 'superprocure') {
    const cm = auction.closeModel || {};
    return {
      closeModel: cm.actuallySoftCloses ? 'soft' : 'hard',
      declaredSoftByExtendTimeAlone: !!cm.softByExtendTimeAlone,
      extendMs: (cm.extendSeconds || 0) * 1000,
      extendCount: cm.extendCount,
      triggerWindowMs: (cm.triggerWindowSec || 0) * 1000,
      revisionLimit: runOpts.revisionLimit != null ? runOpts.revisionLimit : (auction.limits && auction.limits.revisionLimit) || null,
      minDecrement: (auction.limits && auction.limits.minDecrement) || null,
      ceilingPrice: (auction.limits && auction.limits.ceilingPrice) || null,
    };
  }
  // GoComet: the platform exposes neither an increment nor a counter, so both are supplied as
  // harness parameters (seeded from the published empirical model) and labelled as such.
  return {
    closeModel: (auction.extensions || []).length > 0 ? 'soft' : 'unknown',
    declaredSoftByExtendTimeAlone: null,
    extendMs: runOpts.extendMs != null ? runOpts.extendMs : 300_000,
    extendCount: runOpts.extendCount != null ? runOpts.extendCount : null,   // NOT exposed by GoComet
    triggerWindowMs: runOpts.triggerWindowMs != null ? runOpts.triggerWindowMs : null,
    // GoComet's documented budget is 3. Whether it RESETS per round is unverified (see the
    // extension-mechanics research, s.8), so the observed value wins when the record has one.
    revisionLimit: runOpts.revisionLimit != null ? runOpts.revisionLimit
      : (auction.revisionBudgetObserved != null ? auction.revisionBudgetObserved : 3),
    minDecrement: null,
    ceilingPrice: null,
  };
}

function omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj).sort()) if (!keys.includes(k)) out[k] = obj[k];
  return out;
}

module.exports = { ReplayHarness, buildTickSchedule, believedCloseAt, recordedRankAt, extensionsSeenAt, DEFAULTS };
