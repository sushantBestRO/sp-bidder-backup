'use strict';

/**
 * The one close time a closed-auction record may be REPORTED with, shared by the two client-facing
 * surfaces that state it: the outcome receipt (notify/engineAlerts) and the History/outcomes export
 * (web/exportModel).
 *
 * It lives here, in a neutral module, for the same reason util/serverClock.js does - the two callers
 * sit in different layers and neither may require the other, and the first attempt at this shipped
 * the rule twice with a difference in it. The export took the portal close unconditionally while the
 * receipt took it through the staleness fallback, so one load reported two close times 190s apart on
 * the two surfaces and the export printed an auction close earlier than the bid time it listed for
 * the same load. One definition, or it drifts again.
 *
 * Pure: no I/O, no clock read, no logging.
 */

/**
 * -> epoch ms to report as this auction's close, or null when the record carries neither fact.
 *
 * Prefers the PLATFORM's published deadline (finalCloseAt) over our own finalize instant (closedAt).
 * closedAt is when this process decided the auction was over: on a soft close it trails the real
 * close by the finalize debounce, and it is stamped off a local clock that drifts. The portal's own
 * number is the better one nearly always.
 *
 * It is NOT always better, which is the whole reason this is a function and not a field read. On the
 * inferred-extension branch the engine deliberately does not advance its believed close (the socket
 * froze and no forward jump was ever published), so on those closes the portal number is behind
 * reality. A last-chance shot fires on the platform's live countdown, so a bid can land inside that
 * window carrying a timestamp AFTER the stale close - and reporting it would state a close time
 * earlier than a bid we list on the same surface. closedAt is late but never early; that is the
 * property worth keeping when the two disagree in that direction. So on a record that cannot say
 * whether its close was published, the portal close is refused exactly when it predates our own
 * last bid.
 *
 * A record that can say so (hasResultFacts) needs no inference from our clock: the engine flags the
 * stale case itself (finalCloseUnknown), and a GoComet accept can come back after the published close
 * by this machine's clock and still be on the board, so the portal close stands.
 */
function reportedCloseAt(rec) {
  if (!rec) return null;
  const fallback = numeric(rec.closedAt);
  const portal = numeric(rec.finalCloseAt);
  if (portal == null) return fallback;
  if (hasResultFacts(rec) && rec.finalCloseUnknown !== true) return portal;
  const bidTs = numeric(lastPlacedBidTs(rec));
  if (bidTs != null && portal < bidTs) return fallback;
  return portal;
}

/** The most recent entry in a record's own-bid log, or null when nothing of ours landed. */
function lastPlacedBid(rec) {
  const bids = rec && Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean) : [];
  return bids.length ? bids[bids.length - 1] : null;
}

function lastPlacedBidTs(rec) {
  const bid = lastPlacedBid(rec);
  return bid ? bid.ts : null;
}

// The facts an auction_result carries once the engine reports attempts and close provenance. The
// engine always emits every key, null when unknown, so their presence (not their value) is what
// tells a result recorded after that change from one recorded before it.
const RESULT_FACT_KEYS = ['attemptsAllowed', 'extensionsAfterLastBid', 'postedCloseAt', 'finalCloseUnknown',
  'lastBidBeforeTriggerWindow', 'leadAfterLastBid', 'lastBidInFinalSeconds'];

function hasResultFacts(o) {
  return !!o && RESULT_FACT_KEYS.some((k) => o[k] !== undefined);
}

/**
 * How far ahead of the close one of our bids landed, in ms, for the receipt and the every-bid
 * export alike.
 *   landingMs - to the close in force when the bid was decided: the countdown it was decided on,
 *               less the time from that decision to the accept. Both are differences on one clock,
 *               so the offset between this machine and the portal never enters.
 *   toFinalMs - to the auction's final close: landingMs plus how far the close moved after the bid.
 * Each is null when a fact it needs is missing (a bid recorded before decidedAt existed), never
 * guessed, and never negative: an accept that comes back after the close by our clock was still
 * taken by the portal, so it landed at the close.
 */
function bidGapsMs(bid, finalCloseAt) {
  const countdown = numeric(bid && bid.closesInMs);
  const decidedAt = numeric(bid && bid.decidedAt);
  const ts = numeric(bid && bid.ts);
  if (countdown == null || decidedAt == null || ts == null) return { landingMs: null, toFinalMs: null };
  const landing = countdown - (ts - decidedAt);
  const believed = numeric(bid.believedCloseAt);
  const final = numeric(finalCloseAt);
  const toFinal = believed != null && final != null ? landing + (final - believed) : null;
  return { landingMs: Math.max(0, landing), toFinalMs: toFinal == null ? null : Math.max(0, toFinal) };
}

/**
 * Whether our last recorded bid went out at the desk's lowest band margin (or below it), judged
 * against the pricing it was actually placed under: the epoch in costHistory that owns the bid, or
 * the current plan. "Lowest" is the lowest BAND margin, never the floor guard below it, so this reads
 * the same whether or not the ladder carries a floor rung. The band rung's price is allowed to have
 * been rounded down by up to half a percent. null when the pricing or the bid cannot be read.
 */
function lastBidAtLowestMargin(rec) {
  const bids = rec && Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean) : [];
  if (!bids.length) return null;
  const idx = bids.length - 1;
  const epochs = Array.isArray(rec.costHistory) ? rec.costHistory : [];
  const owner = epochs.find((e) => Number(e.ourBidsBefore) > idx) || rec;
  const cost = numeric(owner.cost);
  const margins = Array.isArray(owner.marginsPct) ? owner.marginsPct.map(Number).filter(Number.isFinite) : [];
  const price = numeric(bids[idx].price);
  if (!(cost > 0) || !margins.length || price == null) return null;
  // A step below the minimum is bid at the minimum-margin price, so that is the lowest bid there.
  const min = numeric(owner.minMarginPct);
  const lowest = min != null ? Math.max(Math.min(...margins), min) : Math.min(...margins);
  return price <= cost * (1 + lowest / 100) * 1.005;
}

// SuperProcure's own refusal for a write that arrived after the auction ended. GoComet's nearest
// message ("the enquiry is closed or maximum revision limit") cannot tell a closed enquiry from a spent
// budget, so it never proves an early close.
const PORTAL_ENDED_RE = /auction\s+has\s+already\s+ended\s+for\s+this\s+load/i;
// A refusal this close to the published close is clock offset between this machine and the portal
// (up to ~4 s measured), not an early close.
const EARLY_CLOSE_MIN_MS = 5000;

/**
 * When the portal ended this auction before the close it published, going by the earliest write it
 * refused as "already ended" - or null when no refusal proves that.
 */
function earlyPortalCloseAt(rec) {
  const published = numeric(rec && rec.finalCloseAt);
  if (published == null) return null;
  const at = (Array.isArray(rec.rejectedBids) ? rec.rejectedBids : [])
    .filter((r) => r && PORTAL_ENDED_RE.test(`${r.reason || ''} ${r.body || ''}`))
    .map((r) => numeric(r.ts)).filter((t) => t != null);
  const earliest = at.length ? Math.min(...at) : null;
  return earliest != null && earliest <= published - EARLY_CLOSE_MIN_MS ? earliest : null;
}

/**
 * Why a closed load ended the way it did, for the closed-bids record. Every branch states only what
 * the record proves; anything it cannot prove is 'unknown', never a guess in either direction.
 *   landedBids / noBidReason come off the auction_result (the record keeps neither).
 */
// Did this record ever enter a genuine hold (bidLogger's costCorrections trail carries a
// hold-lifecycle reason)? A plain cost correction with no reason - e.g. an unheld downward
// re-price - does NOT count; only 'hold_entered' (recordAndHold) or 'resumed_by_desk'
// (resumeBidding) prove the load was actually paused.
function wasHeld(rec) {
  const trail = Array.isArray(rec && rec.costCorrections) ? rec.costCorrections : [];
  return trail.some((e) => e && (e.reason === 'hold_entered' || e.reason === 'resumed_by_desk'));
}

function resultReasonOf(rec, { landedBids = null, noBidReason = null } = {}) {
  if (!rec) return 'unknown';
  if (rec.won === true) return 'won';
  const landed = Number(landedBids);
  if (landedBids == null || !Number.isFinite(landed)) return 'unknown';
  const early = earlyPortalCloseAt(rec) != null;
  if (landed === 0) {
    if (early) return 'no_bid_portal_closed_early';
    return noBidReason ? `no_bid_${noBidReason}` : 'unknown';
  }
  // won null is a close the portal never settled; its last live rank is not a result.
  if (rec.won !== false) return 'unknown';
  const rank = numeric(rec.finalRank);
  if (rank == null || !(rank > 1)) return 'unknown';
  const lowest = lastBidAtLowestMargin(rec);
  if (lowest === true) return 'lost_on_price';
  if (lowest !== false || early) return 'unknown';
  if (rec.leadAfterLastBid === true) {
    // B112 (ruling 29): a rival winning while we held the lead is a genuine competitive loss -
    // UNLESS the record shows this load was actually HELD (a desk correction paused bidding) at
    // some point during its life, in which case the rival may have gotten through during OUR
    // pause, not by outbidding us live. Keyed on a GENUINE hold-lifecycle entry only
    // (reason 'hold_entered' or 'resumed_by_desk', written by recordAndHold/resumeBidding in
    // server.js) - an ordinary correction on a load that was never held (e.g. an unheld downward
    // re-price, which also appends to costCorrections with no reason) must not be mistaken for one.
    return wasHeld(rec) ? 'hold_undercut' : 'undercut_while_leading';
  }
  if (rec.leadAfterLastBid !== false) return 'unknown';
  // A landed bid the record never received (reconciled after an uncertain write) may have been the
  // lowest-margin one, so our fault cannot be claimed while one is missing.
  const recorded = Array.isArray(rec.ourBids) ? rec.ourBids.filter(Boolean).length : 0;
  return landed > recorded ? 'unknown' : 'lost_on_timing';
}

// Records come back from persisted JSON, so a timestamp can arrive as a numeric string or as a
// shape that is not a time at all; anything that is not a finite number is "not known".
function numeric(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { reportedCloseAt, lastPlacedBid, bidGapsMs, hasResultFacts, lastBidAtLowestMargin, earlyPortalCloseAt,
  resultReasonOf, RESULT_FACT_KEYS };
