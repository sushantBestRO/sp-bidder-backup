'use strict';
/**
 * Timeline reconstruction — turning bid history back into auctions.
 *
 * THE CORE INSIGHT
 * GoComet exposes neither an extension counter nor the extension increment. But every bid record
 * carries `timeToClosingMs`, so each bid pins an IMPLIED ABSOLUTE CLOSE:
 *
 *     impliedClose_i = timestamp_i + timeToClosingMs_i
 *
 * For a static deadline that value is constant across every bid on an enquiry (to within network
 * jitter). When it SLIDES FORWARD, the deadline moved. This is the same signal the production
 * engine uses live (`bidEngine._observeExtension` watches `state.closesAtMs` jump forward), so a
 * timeline rebuilt this way drives the real engine through the real code path.
 *
 * ============================================================================================
 * A FORWARD SLIDE IS *NOT* AUTOMATICALLY AN EXTENSION — the band filter is mandatory
 * ============================================================================================
 * The obvious detector ("slide > 60s = extension round") is WRONG and inflates counts ~3.5x. It
 * catches shipper RE-OPENS of an enquiry, whose slides run FIVE HOURS TO TWENTY-TWO DAYS. Run
 * naively against the dead-bot corpus it reports 207 apparent extension boundaries where only 60
 * are real. The Jul-25 extension-mechanics study flags this same long tail in its section 4, and
 * the Jul-31 revisions study discarded its entire first pass over exactly this error.
 *
 * So a slide is classified by BAND, and the bands are explicit and configurable (DEFAULTS below),
 * never buried constants:
 *
 *   delta <= noiseToleranceSec (5s) ......... 'none'. Measured jitter: p50 0.15s, p99 ~3.9s.
 *   noiseTolerance < delta < bandLow ........ 'sub_band'. Below any known increment. Not a round.
 *   bandLow <= delta <= bandHigh (100-400s).. 'extension'. EXACTLY ONE anti-snipe round.
 *   bandHigh < delta <= aliasWindow (1h) .... 'aliased_multi_round'. Real rounds collapsed by poll
 *                                             aliasing, but the count is not recoverable with
 *                                             confidence, so these are reported SEPARATELY and
 *                                             never added to the headline round count.
 *   delta > aliasWindow ..................... 'reopen' (when bidsSubmitted also resets) or
 *                                             'unclassified_gap'. Both CUT the segment: a new
 *                                             auction is starting, not a round continuing.
 *
 * The 100-400s band brackets both documented increments (240s at Sachin-Surat, 300s elsewhere)
 * with room for poll jitter. Measured against this corpus the in-band increments cluster at
 * 296-302s, independently reproducing the 300s figure the frozen Postgres gave.
 *
 * THE RE-OPEN TELL: a re-opened enquiry restarts BRL's own bid counter, so `bidsSubmitted` falls
 * back toward 1 across the boundary. That is a second signal independent of slide size, and both
 * are checked.
 *
 * ============================================================================================
 * WHY ROUND COUNTS ARE A LOWER BOUND — four separate undercounts, all unavoidable locally
 * ============================================================================================
 *   1. Extensions before our first bid or after our last bid are entirely invisible. This is the
 *      dominant one: the bot only re-bids while it is still losing, so it stops observing exactly
 *      when it stops caring.
 *   2. An enquiry with fewer than two timed bids yields no observable slide at all.
 *   3. Aliased slides (400s-1h) hold 2+ real rounds each and are deliberately NOT counted into the
 *      headline, because de-aliasing needs an increment this corpus cannot confirm per-auction.
 *   4. The bid logs carry NO plant/origin field, so the per-plant 240s/300s split CANNOT be applied
 *      here at all — one band serves every plant.
 * Every reported round count is therefore labelled a lower bound, everywhere, without exception.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * No competitor bid amounts are read, stored, modelled or inferred — the corpus does not contain
 * them and nothing here reconstructs them. Clock movement, round counts, BRL's own rank and BRL's
 * own revision counters are the permitted signals. See replay/README.md > The honesty boundary.
 */

const DEFAULTS = {
  /** Implied-close wobble from network RTT and poll timing. Measured p99 ~3.9s across 19,616 pairs. */
  noiseToleranceSec: 5,
  /** Anti-snipe band, inclusive. Brackets the 240s and 300s documented increments plus jitter. */
  bandLowSec: 100,
  bandHighSec: 400,
  /**
   * Above bandHigh but below this, a slide is real extension activity collapsed by poll aliasing.
   * Counted and reported, but never folded into the confident round total.
   */
  aliasWindowSec: 3600,
  /** Tolerance for calling an in-band slide "on grid" against the nominal increment. */
  gridToleranceSec: 10,
  /** Nominal increment, used ONLY for the on-grid quality check, never to multiply round counts. */
  nominalIncrementSec: 300,
};

const SLIDE_KINDS = ['none', 'sub_band', 'extension', 'aliased_multi_round', 'reopen', 'unclassified_gap'];

/** Group normalised records by enquiryKey, dropping rows that cannot anchor a timeline. */
function groupByEnquiry(records) {
  const byKey = new Map();
  for (const r of records) {
    if (!r.enquiryKey || r.tsMs == null) continue;
    if (!byKey.has(r.enquiryKey)) byKey.set(r.enquiryKey, []);
    byKey.get(r.enquiryKey).push(r);
  }
  // Stable ordering: timestamp, then file, then in-file index. Never insertion order.
  for (const arr of byKey.values()) {
    arr.sort((a, b) => (a.tsMs - b.tsMs)
      || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
      || (a.index - b.index));
  }
  return byKey;
}

/**
 * Classify one forward slide between two consecutive observations.
 * @returns {{kind: string, rounds: number, onGrid: boolean, gridErrSec: number}}
 */
function classifySlide(deltaSec, prevObs, nextObs, cfgIn) {
  const cfg = Object.assign({}, DEFAULTS, cfgIn);
  if (deltaSec <= cfg.noiseToleranceSec) return { kind: 'none', rounds: 0, onGrid: false, gridErrSec: 0 };
  if (deltaSec < cfg.bandLowSec) return { kind: 'sub_band', rounds: 0, onGrid: false, gridErrSec: 0 };

  if (deltaSec <= cfg.bandHighSec) {
    const err = Math.abs(deltaSec - cfg.nominalIncrementSec);
    return { kind: 'extension', rounds: 1, onGrid: err <= cfg.gridToleranceSec, gridErrSec: round3(err) };
  }

  if (deltaSec <= cfg.aliasWindowSec) {
    return { kind: 'aliased_multi_round', rounds: 0, onGrid: false, gridErrSec: 0 };
  }

  // Beyond the alias window. A re-open restarts BRL's own bid counter for the enquiry, so a fall in
  // bidsSubmitted alongside a multi-hour slide is the corroborating tell.
  const prevSubmitted = prevObs && prevObs.rec ? prevObs.rec.bidsSubmitted : null;
  const nextSubmitted = nextObs && nextObs.rec ? nextObs.rec.bidsSubmitted : null;
  const counterReset = prevSubmitted != null && nextSubmitted != null && nextSubmitted < prevSubmitted;
  return { kind: counterReset ? 'reopen' : 'unclassified_gap', rounds: 0, onGrid: false, gridErrSec: 0 };
}

/** Reconstruct every replayable auction in a corpus. */
function reconstructCorpus(records, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts);
  const byKey = groupByEnquiry(records);
  const auctions = [];
  for (const key of [...byKey.keys()].sort()) {
    for (const a of reconstructEnquiry(key, byKey.get(key), cfg)) auctions.push(a);
  }
  auctions.sort((a, b) => (a.openMs - b.openMs)
    || (a.enquiryKey < b.enquiryKey ? -1 : a.enquiryKey > b.enquiryKey ? 1 : 0)
    || (a.segment - b.segment));
  return auctions;
}

function reconstructEnquiry(enquiryKey, rows, cfgIn) {
  const cfg = Object.assign({}, DEFAULTS, cfgIn);
  // Only rows with a real timeToClosingMs pin a close. PUBLIC_SUBMISSION rows (ttc null) are
  // catalogue entries, not timed bids, so they cannot anchor the timeline — but they DO carry
  // BRL's own pricing model output, harvested below.
  const timed = rows.filter((r) => r.timeToClosingMs != null && Number.isFinite(r.timeToClosingMs));
  if (timed.length === 0) return [];

  const obs = timed.map((r) => ({ atMs: r.tsMs, closeAtMs: r.tsMs + r.timeToClosingMs, rec: r }));

  // Walk once, classifying every consecutive pair, cutting segments on re-open / unexplained gap.
  // `believedClose` on each segment tracks the close in effect at the segment's END — advanced on
  // EVERY positive move (in-band, aliased, sub_band, and sub-noise), not only the clock-moves that
  // count as rounds — so a segment ending on a sub-band slide does not leave finalCloseMs behind.
  const segments = [];
  let cur = { obs: [obs[0]], slides: [], cutReason: null, believedClose: obs[0].closeAtMs };
  let believed = obs[0].closeAtMs;

  for (let i = 1; i < obs.length; i++) {
    const deltaSec = (obs[i].closeAtMs - believed) / 1000;

    // A close moving BACKWARD beyond jitter is a reschedule, not an extension. Cut.
    if (deltaSec < -cfg.noiseToleranceSec) {
      segments.push(cur);
      cur = { obs: [obs[i]], slides: [], cutReason: 'backward_reschedule', believedClose: obs[i].closeAtMs };
      believed = obs[i].closeAtMs;
      continue;
    }

    const cls = classifySlide(deltaSec, obs[i - 1], obs[i], cfg);

    if (cls.kind === 'reopen' || cls.kind === 'unclassified_gap') {
      segments.push(cur);
      cur = { obs: [obs[i]], slides: [], cutReason: cls.kind, believedClose: obs[i].closeAtMs };
      believed = obs[i].closeAtMs;
      continue;
    }

    if (cls.kind !== 'none') {
      cur.slides.push({
        atMs: obs[i].atMs,
        fromMs: believed,
        toMs: obs[i].closeAtMs,
        slideSec: round3(deltaSec),
        kind: cls.kind,
        rounds: cls.rounds,
        onGrid: cls.onGrid,
        gridErrSec: cls.gridErrSec,
        revisionsLeftBefore: obs[i - 1].rec.revisionsLeft,
        revisionsLeftAfter: obs[i].rec.revisionsLeft,
        bidsSubmittedBefore: obs[i - 1].rec.bidsSubmitted,
        bidsSubmittedAfter: obs[i].rec.bidsSubmitted,
        successAfter: obs[i].rec.success,
      });
    }
    if (deltaSec > 0) { believed = obs[i].closeAtMs; cur.believedClose = believed; }
    cur.obs.push(obs[i]);
  }
  segments.push(cur);

  // Pricing is per SEGMENT, not per enquiry. A re-open cuts a new segment (a genuinely new auction),
  // so stamping one enquiry-wide pricing object onto every segment scored re-opened segments against
  // a stale cost basis. Partition the timeline by segment-start boundaries and take each segment's
  // own pricing row (from its own PUBLIC_SUBMISSION rows) within that window; null when it has none.
  const segStarts = segments.map((s) => s.obs[0].atMs);
  const pickPricing = (i) => {
    const lo = i === 0 ? -Infinity : segStarts[i];
    const hi = i === segments.length - 1 ? Infinity : segStarts[i + 1];
    for (const r of rows) {
      if (r.tsMs == null || r.tsMs < lo || r.tsMs >= hi) continue;
      if (r.calculatedBids && r.calculatedBids.marketValue != null) return r.calculatedBids;
    }
    return null;
  };

  return segments.map((seg, idx) => buildAuction(enquiryKey, idx, seg, cfg, pickPricing(idx)));
}

function buildAuction(enquiryKey, segment, seg, cfg, pricing) {
  const obs = seg.obs;

  const inBand = seg.slides.filter((s) => s.kind === 'extension');
  const aliased = seg.slides.filter((s) => s.kind === 'aliased_multi_round');
  const subBand = seg.slides.filter((s) => s.kind === 'sub_band');

  // Replay clock movement uses every slide that really moved the close within this segment
  // (in-band AND aliased both genuinely moved the deadline), so the engine sees the true clock it
  // faced. Only the in-band ones contribute to ROUND COUNTS.
  const clockMoves = seg.slides
    .filter((s) => s.kind === 'extension' || s.kind === 'aliased_multi_round')
    .map((s) => ({
      atMs: s.atMs, fromMs: s.fromMs, toMs: s.toMs, slideSec: s.slideSec,
      kind: s.kind, impliedRounds: s.rounds, onGrid: s.onGrid, gridErrSec: s.gridErrSec,
      /**
       * When the moved deadline was IN EFFECT, as distinct from when BRL's bot happened to
       * notice it (`atMs`).
       *
       * This distinction is load-bearing and getting it wrong silently truncates most replays.
       * `atMs` is the timestamp of the bid that REVEALED the slide, and it is routinely LATER
       * than the close it superseded — on 251108QK9Z the old close was 11:25:00 and the bot did
       * not bid again until 11:29:49. Driving an engine off `atMs` makes it believe the auction
       * ended at 11:25:00 and the whole extension war becomes invisible.
       *
       * But the auction demonstrably did NOT end at 11:25:00, because bids landed after it. So
       * the deadline had already moved by then. The extension is therefore in effect from
       * `fromMs` at the latest — which is exactly what a live poller polling through the old
       * close would have observed. Taking the earlier of the two is correct in both directions:
       * if our bot happened to see it BEFORE the old close, that earlier instant is the truth.
       *
       * Replaying the recorded bot's blind spots would test the OLD bot's poll cadence, not the
       * engine under test — and the engine's own cadence is the harness's to control.
       */
      visibleFromMs: Math.min(s.atMs, s.fromMs),
    }));

  // The close in effect at the segment's end, tracked across ALL positive moves (see
  // reconstructEnquiry). Keying this off the last clock-move (which excludes sub_band slides) left
  // finalCloseMs behind the true last believed close whenever a segment ended on a sub-band slide,
  // and the blindTailMs clamp below then hid the resulting negative as a clean 0.
  const finalCloseMs = seg.believedClose != null ? seg.believedClose : obs[0].closeAtMs;

  const ourBids = obs.map((o) => ({
    atMs: o.atMs,
    bidType: o.rec.bidType,
    price: o.rec.bidPrice,
    rank: o.rec.currentRank,
    revisionsLeft: o.rec.revisionsLeft,
    bidsSubmitted: o.rec.bidsSubmitted,
    success: o.rec.success,
    msBeforeBelievedClose: Math.round(o.closeAtMs - o.atMs),
  }));

  // Observed revision budget: largest (revisionsLeft + bidsSubmitted) seen. Reported as observed,
  // never asserted as the platform rule.
  let revisionBudgetObserved = null;
  for (const b of ourBids) {
    if (b.revisionsLeft != null && b.bidsSubmitted != null) {
      const total = b.revisionsLeft + b.bidsSubmitted;
      if (revisionBudgetObserved == null || total > revisionBudgetObserved) revisionBudgetObserved = total;
    }
  }

  // Revision behaviour ACROSS in-band extension boundaries — the direct evidence for whether the
  // 3-revision budget resets per round. Kept per auction so the aggregate stays auditable.
  const revisionBoundaries = inBand
    .filter((s) => s.revisionsLeftBefore != null && s.revisionsLeftAfter != null)
    .map((s) => ({
      atMs: s.atMs,
      before: s.revisionsLeftBefore,
      after: s.revisionsLeftAfter,
      bidsBefore: s.bidsSubmittedBefore,
      bidsAfter: s.bidsSubmittedAfter,
      direction: s.revisionsLeftAfter > s.revisionsLeftBefore ? 'increased'
        : s.revisionsLeftAfter < s.revisionsLeftBefore ? 'decreased' : 'unchanged',
      // The decisive pattern: a SUCCESSFUL bid from a previously exhausted budget. No no-reset
      // reading explains it.
      fromExhausted: s.revisionsLeftBefore === 0 && s.revisionsLeftAfter > 0 && s.successAfter === true,
    }));

  return {
    kind: 'reconstructed-timeline',
    platform: 'gocomet',
    enquiryKey,
    segment,
    cutReason: seg.cutReason,
    openMs: obs[0].atMs,
    originalCloseMs: obs[0].closeAtMs,
    finalCloseMs,
    observationCount: obs.length,
    closeTimeline: obs.map((o) => ({ atMs: o.atMs, closeAtMs: o.closeAtMs })),

    /** Clock movement replayed to the engine (in-band + aliased). */
    extensions: clockMoves,
    /** In-band, high-confidence anti-snipe rounds. Round counts are built ONLY from these. */
    confirmedExtensions: inBand.length,
    confirmedRoundsLowerBound: inBand.length,
    /** Real clock movement whose round count is not recoverable. Reported, never counted. */
    aliasedSlides: aliased.length,
    subBandSlides: subBand.length,

    ourBids,
    revisionBudgetObserved,
    revisionBoundaries,
    pricing: pricing || null,

    quality: {
      singleObservation: obs.length === 1,
      // Any extension after our last bid is invisible, so a long blind tail means this auction's
      // round count is especially weakly bounded.
      blindTailMs: Math.max(0, finalCloseMs - obs[obs.length - 1].atMs),
      onGridExtensions: inBand.filter((s) => s.onGrid).length,
    },
  };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

/** Summarise a reconstructed set. Every count that could be read as a true round count is named. */
function summarise(auctions) {
  const withExt = auctions.filter((a) => a.confirmedExtensions > 0);
  const allExt = [];
  for (const a of auctions) for (const e of a.extensions) if (e.kind === 'extension') allExt.push(e);
  const onGrid = allExt.filter((e) => e.onGrid).length;
  const rounds = withExt.map((a) => a.confirmedRoundsLowerBound).sort((x, y) => x - y);

  const bounds = [];
  for (const a of auctions) for (const b of a.revisionBoundaries) bounds.push(b);

  return {
    auctions: auctions.length,
    multiObservation: auctions.filter((a) => a.observationCount > 1).length,
    auctionsShowingConfirmedExtension: withExt.length,
    confirmedExtensionEvents: allExt.length,
    confirmedEventsOnGrid: onGrid,
    confirmedEventsOnGridPct: allExt.length ? round3(100 * onGrid / allExt.length) : null,
    maxConfirmedRoundsLowerBound: rounds.length ? rounds[rounds.length - 1] : 0,
    medianConfirmedRoundsAmongExtended: rounds.length ? rounds[Math.floor(rounds.length / 2)] : null,
    aliasedSlidesExcluded: auctions.reduce((n, a) => n + a.aliasedSlides, 0),
    subBandSlidesExcluded: auctions.reduce((n, a) => n + a.subBandSlides, 0),
    reopenSegments: auctions.filter((a) => a.cutReason === 'reopen').length,
    unclassifiedGapSegments: auctions.filter((a) => a.cutReason === 'unclassified_gap').length,
    backwardRescheduleSegments: auctions.filter((a) => a.cutReason === 'backward_reschedule').length,
    revisionBoundaries: {
      total: bounds.length,
      increased: bounds.filter((b) => b.direction === 'increased').length,
      unchanged: bounds.filter((b) => b.direction === 'unchanged').length,
      decreased: bounds.filter((b) => b.direction === 'decreased').length,
      successFromExhausted: bounds.filter((b) => b.fromExhausted).length,
    },
  };
}

module.exports = {
  DEFAULTS, SLIDE_KINDS, classifySlide, reconstructCorpus, reconstructEnquiry, groupByEnquiry, summarise,
};
