'use strict';
/**
 * Behavioural metrics.
 *
 * EVERY metric here answers "what did the engine DO", never "what would it have EARNED".
 * There is no win rate, no clearing price, no counterfactual outcome, and no place to put one.
 * The six questions this file exists to answer:
 *
 *   1. Did the engine fire at all on a load it should have bid?           -> fired, silent
 *   2. WHEN did it fire, relative to close and to each extension boundary? -> timing.*
 *   3. How many revisions did it consume against the platform budget?      -> revisions.*
 *   4. Did it survive the extension war, or exhaust itself early?          -> war.*
 *   5. Did it respect floor and ceiling?                                   -> constraints.*
 *   6. What rank did it hold over time?                                    -> rank.* (EXOGENOUS)
 *
 * On (6): rank in a replay is the rank BRL's RECORDED bot held at that instant. The replayed
 * engine's own bids do not move it, because moving it would require the competitor amounts the
 * platform masks. rank.* therefore describes the CONDITIONS the engine decided under, not a result
 * it achieved. It is reported because "what rank was showing when the engine chose to hold" is a
 * real behavioural question; it is never aggregated into anything outcome-shaped.
 */

/** Per-replay behavioural summary. */
function summariseRun(run, auction) {
  const bids = run.bids || [];
  const fired = bids.length > 0;
  const finalClose = run.finalCloseMs;
  // Keyed off when the moved deadline was IN EFFECT, not when BRL's bot noticed it. Using the
  // observation instant (`atMs`) understates survival badly: on an aliased slide `atMs` can sit
  // minutes past the boundary it reveals, so an engine that genuinely contested the final round
  // is scored as having missed it.
  const lastExtensionAt = lastExtensionInEffect(auction);

  const firesAfterLastExtension = lastExtensionAt == null
    ? bids.length
    : bids.filter((b) => b.atMs >= lastExtensionAt).length;

  const budget = run.limits ? run.limits.revisionLimit : null;
  const used = bids.length;
  // Exhaustion is whether the budget was empty AT CLOSE, read from the harness's own tracked
  // `revisionsLeftAtClose` — NOT from `bids.length >= budget`. Under reset-per-round the harness
  // restores the budget at every extension boundary, so a legitimate multi-round war can place more
  // bids than the per-round cap while never once exhausting a single round. `used >= budget` reports
  // those runs as exhausted; `revisionsLeftAtClose === 0` does not.
  const exhausted = budget != null && run.revisionsLeftAtClose === 0;
  // "Exhausted early" = the budget was empty at close AND the engine placed its last bid before the
  // final extension boundary, i.e. it had nothing left for the real close.
  const exhaustedEarly = exhausted && lastExtensionAt != null
    && bids.length > 0 && bids[bids.length - 1].atMs < lastExtensionAt;

  const floorBreaches = (run.violations || []).filter((v) => v.kind === 'floor_breach');
  const ceilingBreaches = (run.violations || []).filter((v) => v.kind === 'ceiling_breach');
  const driverErrors = (run.violations || []).filter((v) => String(v.kind).startsWith('driver_threw'));

  const ranksAtFire = bids.map((b) => b.rankAtFire).filter((r) => r != null);

  return {
    auctionId: run.auctionId,
    driver: run.driver,
    platform: run.platform,
    kind: run.kind,
    roundsLowerBound: run.roundsLowerBound,

    fired,
    silent: !fired,
    bidCount: bids.length,

    timing: {
      firstFireMsBeforeFinalClose: fired ? finalClose - bids[0].atMs : null,
      lastFireMsBeforeFinalClose: fired ? finalClose - bids[bids.length - 1].atMs : null,
      firstFireMsBeforeBelievedClose: fired ? bids[0].msBeforeBelievedClose : null,
      lastFireMsBeforeBelievedClose: fired ? bids[bids.length - 1].msBeforeBelievedClose : null,
      firesAfterLastExtension,
      // Accepted bids placed BEFORE the last recorded extension took effect — while the clock could
      // still be pushed out again. This is NOT trigger-window filtered: the harness does not thread a
      // trigger window into this metric, so it is named for exactly what it counts (a fire before the
      // last extension), not for the narrower "fired inside the trigger window" it cannot compute.
      firesBeforeLastExtension: countFiresBeforeLastExtension(bids, auction),
    },

    revisions: {
      budget,
      used,
      leftAtClose: run.revisionsLeftAtClose,
      exhausted,
      exhaustedEarly,
      // Which budget assumption this run was replayed under. Budget exhaustion is the BINDING
      // constraint on GoComet (3 per load vs 10-30 on SP), so the same engine on the same auction
      // can behave completely differently under the two policies — which is the point of
      // replaying both.
      policy: run.revisionPolicy || 'no-reset',
      resetsApplied: run.revisionResets || 0,
    },

    war: {
      extensionsInAuction: run.extensionsInAuction,
      survivedToFinalRound: lastExtensionAt == null ? null : firesAfterLastExtension > 0,
      // Based on the tracked remaining budget at close, not `budget - used` (which goes negative
      // under reset-per-round and lied about the final round).
      hadRevisionForFinalRound: budget == null ? null : run.revisionsLeftAtClose > 0 || firesAfterLastExtension > 0,
    },

    constraints: {
      floorBreaches: floorBreaches.length,
      ceilingBreaches: ceilingBreaches.length,
      floorRespected: floorBreaches.length === 0,
      ceilingRespected: ceilingBreaches.length === 0,
    },

    rank: {
      note: 'EXOGENOUS - recorded rank of BRL\'s own bot, not a rank this engine earned',
      atFires: ranksAtFire,
      bestAtFire: ranksAtFire.length ? Math.min(...ranksAtFire) : null,
      worstAtFire: ranksAtFire.length ? Math.max(...ranksAtFire) : null,
    },

    rejections: tally((run.rejections || []).map((r) => r.reason)),
    driverErrors: driverErrors.length,
    ticksRun: run.ticksRun,
    truncated: run.truncated,
  };
}

/** When the LAST recorded extension took effect. See the note in summariseRun. */
function lastExtensionInEffect(auction) {
  if (!auction || !auction.extensions || auction.extensions.length === 0) return null;
  let last = -Infinity;
  for (const e of auction.extensions) {
    last = Math.max(last, e.visibleFromMs != null ? e.visibleFromMs : e.atMs);
  }
  return Number.isFinite(last) ? last : null;
}

function countFiresBeforeLastExtension(bids, auction) {
  const last = lastExtensionInEffect(auction);
  if (last == null) return 0;
  return bids.filter((b) => b.atMs < last).length;
}

/** Aggregate across many runs. Order-independent and deterministic. */
function aggregate(summaries) {
  const n = summaries.length;
  if (n === 0) return { runs: 0 };
  const firedRuns = summaries.filter((s) => s.fired);
  const withExtensions = summaries.filter((s) => s.war.extensionsInAuction > 0);
  const survived = withExtensions.filter((s) => s.war.survivedToFinalRound === true);

  const lastFire = firedRuns.map((s) => s.timing.lastFireMsBeforeFinalClose).filter((x) => x != null).sort((a, b) => a - b);

  return {
    runs: n,
    fired: firedRuns.length,
    silent: n - firedRuns.length,
    silentPct: pct(n - firedRuns.length, n),
    totalBids: summaries.reduce((a, s) => a + s.bidCount, 0),
    auctionsWithExtensions: withExtensions.length,
    survivedFinalRound: survived.length,
    survivedFinalRoundPct: pct(survived.length, withExtensions.length),
    revisionsExhausted: summaries.filter((s) => s.revisions.exhausted).length,
    revisionsExhaustedEarly: summaries.filter((s) => s.revisions.exhaustedEarly).length,
    floorBreachRuns: summaries.filter((s) => s.constraints.floorBreaches > 0).length,
    ceilingBreachRuns: summaries.filter((s) => s.constraints.ceilingBreaches > 0).length,
    driverErrorRuns: summaries.filter((s) => s.driverErrors > 0).length,
    firesBeforeLastExtension: summaries.reduce((a, s) => a + s.timing.firesBeforeLastExtension, 0),
    lastFireMsBeforeFinalClose: {
      min: lastFire.length ? lastFire[0] : null,
      p50: pctl(lastFire, 50),
      p90: pctl(lastFire, 90),
      max: lastFire.length ? lastFire[lastFire.length - 1] : null,
    },
    rejectionReasons: mergeTallies(summaries.map((s) => s.rejections)),
  };
}

function tally(arr) {
  const out = {};
  for (const x of arr) { const k = x == null ? 'null' : String(x); out[k] = (out[k] || 0) + 1; }
  return sortKeys(out);
}
function mergeTallies(tallies) {
  const out = {};
  for (const t of tallies) for (const k of Object.keys(t)) out[k] = (out[k] || 0) + t[k];
  return sortKeys(out);
}
function sortKeys(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}
function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : null; }
function pctl(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}

/**
 * Compare the same engine on the same auctions under the two revision-budget assumptions.
 *
 * Returns only BEHAVIOURAL deltas — how many more bids the engine got to place, how many more
 * auctions it survived to the final round of, how often the no-reset assumption left it silent
 * through rounds it could have contested. Nothing here is an outcome or a win estimate; a bid
 * placed is not a bid won, and the harness has no way to know which it would have been.
 */
function compareRevisionPolicies(noResetSummaries, resetSummaries) {
  const byId = new Map();
  for (const s of noResetSummaries) byId.set(s.auctionId, { noReset: s, reset: null });
  for (const s of resetSummaries) {
    if (byId.has(s.auctionId)) byId.get(s.auctionId).reset = s;
    else byId.set(s.auctionId, { noReset: null, reset: s });
  }
  const paired = [...byId.values()].filter((p) => p.noReset && p.reset);
  const divergent = paired.filter((p) => p.noReset.bidCount !== p.reset.bidCount
    || p.noReset.war.survivedToFinalRound !== p.reset.war.survivedToFinalRound);

  return {
    pairedAuctions: paired.length,
    divergentAuctions: divergent.length,
    divergentPct: pct(divergent.length, paired.length),
    bidsNoReset: paired.reduce((a, p) => a + p.noReset.bidCount, 0),
    bidsReset: paired.reduce((a, p) => a + p.reset.bidCount, 0),
    exhaustedNoReset: paired.filter((p) => p.noReset.revisions.exhausted).length,
    exhaustedReset: paired.filter((p) => p.reset.revisions.exhausted).length,
    survivedNoReset: paired.filter((p) => p.noReset.war.survivedToFinalRound === true).length,
    survivedReset: paired.filter((p) => p.reset.war.survivedToFinalRound === true).length,
    examples: divergent.slice(0, 10).map((p) => ({
      auctionId: p.noReset.auctionId,
      rounds: p.noReset.roundsLowerBound,
      bidsNoReset: p.noReset.bidCount,
      bidsReset: p.reset.bidCount,
      survivedNoReset: p.noReset.war.survivedToFinalRound,
      survivedReset: p.reset.war.survivedToFinalRound,
    })),
  };
}

module.exports = { summariseRun, aggregate, compareRevisionPolicies };
