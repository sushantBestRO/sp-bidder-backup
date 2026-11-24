'use strict';

/**
 * The pricing band that priced a bid - `bidTimeCost` and its floor, off the ourBids entry whose
 * price is lastBidPrice (the bid the receipt reports), else the last entry. Shared by engineAlerts
 * (per-load won/lost receipts) and eodReport (the day summary) so both surfaces price a load's
 * margin against the same epoch's cost - see G-CC11: before this file existed the EOD aggregate re-derived its own doc-level-cost anchor and
 * could disagree with the receipt on the very same load.
 *
 * null on the ~3,136 records written before the snapshot existed, and on a rate-model or mock arm
 * that carries no cost - callers fall through to resolveBidTimeCost's later rungs. A non-finite or
 * non-positive cost is treated the same way: it cannot anchor a margin, and falling back beats
 * printing a garbage one.
 */
function bidTimeBand(rec) {
  const bids = Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean) : [];
  // ourBids is in arrival order and lastBidPrice keeps the lowest landed price, so a write banked
  // after a re-price retired its monitor sits last while the receipt reports another bid (T6 D1).
  const standing = Number(rec.lastBidPrice);
  const named = Number.isFinite(standing) ? bids.filter((b) => Number(b.price) === standing).pop() : null;
  const last = named || (bids.length ? bids[bids.length - 1] : null);
  const c = last && last.bidTimeCost != null ? Number(last.bidTimeCost) : null;
  if (!(Number.isFinite(c) && c > 0)) return null;
  const f = last.bidTimeMinMarginPct != null ? Number(last.bidTimeMinMarginPct) : null;
  const lo = last.bidTimeLowestMarginPct != null ? Number(last.bidTimeLowestMarginPct) : null;
  return { cost: c, minMarginPct: Number.isFinite(f) ? f : null, lowestMarginPct: Number.isFinite(lo) ? lo : null };
}

/**
 * The cost a LIVE cost correction withdrew - what the desk was pricing against before it typed the
 * new number, off bidLogger's `costCorrection` override. This is the pre-snapshot rows' version of
 * the same fact bidTimeBand reads per bid: those rows have no snapshot, but a corrected one does
 * carry the figure the correction replaced.
 *
 * null once a resume retires the override, because the restored cost IS rec.cost again.
 *
 * And null unless the correction was recorded against the bid being priced. A resume is only one of
 * the two ways a hold ends: an ordinary re-price supersedes it through retireHold, which clears the
 * hold but not the override, so the engine re-arms, bids again at a third cost, and the superseded
 * correction is still standing. Anchoring that later bid on it rendered a +1.00% win as -12.93%
 * carrying a "stands below your rate - squeeze the vendor" warning. `standingBidPrice` is the bid
 * the correction's `from` actually priced, so that is the test, and it holds on records already
 * written with a stale override.
 *
 * Repeat corrections walk back to the first one recorded against that same bid - the load is held
 * across them, so a later correction's `from` is a cost nothing was priced at.
 */
function withdrawnCost(rec) {
  const live = rec && rec.costCorrection;
  if (!live) return null;
  const standing = rec.lastBidPrice != null ? Number(rec.lastBidPrice) : null;
  const pricedStandingBid = (e) => !!e && e.reason !== 'resumed_by_desk'
    && standing != null && Number(e.standingBidPrice) === standing;
  if (!pricedStandingBid(live)) return null;
  const trail = Array.isArray(rec.costCorrections) ? rec.costCorrections : [];
  let first = live;
  for (let i = trail.length - 1; i >= 0; i--) {
    if (!pricedStandingBid(trail[i])) break;
    first = trail[i];
  }
  return positiveCost(first.from);
}

/**
 * The cost a margin should be measured against, for a closed-bids doc: the bid-time snapshot when
 * it exists, else the cost a live correction withdrew, else the doc-level (current) cost - the SAME
 * fallback order bidTimeBand's callers use, so a caller that only needs the number (not the floor)
 * can't drift from it.
 *
 * Owner's ruling, 2026-09-11 (F-C, reversing the 7e6f9d6 anchor flip): the margin reports whether
 * the bid was priced right when it went out, against the cost that actually authorised it - not
 * whatever the desk has since corrected it to. Because a placed price is always at or above the
 * bid-time floor (assertAboveFloor), a margin measured against either of the first two anchors can
 * never be negative; only the doc-cost fallback (no snapshot AND no correction that priced the
 * standing bid) can still go negative, since there is no historical figure to anchor on.
 */
function resolveBidTimeCost(rec) {
  const band = bidTimeBand(rec);
  if (band) return band.cost;
  const withdrawn = withdrawnCost(rec);
  if (withdrawn != null) return withdrawn;
  return positiveCost(rec.cost);
}

function positiveCost(v) {
  const c = v != null ? Number(v) : null;
  return Number.isFinite(c) && c > 0 ? c : null;
}

module.exports = { bidTimeBand, resolveBidTimeCost };
