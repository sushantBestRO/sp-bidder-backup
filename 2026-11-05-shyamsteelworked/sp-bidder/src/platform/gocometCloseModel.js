'use strict';
/**
 * GoComet close model - the client-side reconstruction of a reactive soft close whose mechanics the
 * platform does not expose.
 *
 * WHY THIS FILE EXISTS AT ALL. SuperProcure hands the engine its close model on a plate: the load
 * carries `branchAuctionExtendTime` (the increment), `extra.branchExtendAuctionCount` (the cap) and
 * `branchAuctionRemainingTime` (the anti-snipe trigger window), so `realAdapter._mapLoad` can just
 * read them. GoComet exposes NONE of the three. What it exposes is a countdown (`bid_closing_in`,
 * whole seconds) that silently slides forward when somebody bids late. Every fact the endgame needs
 * has to be RECONSTRUCTED from watching that one number move.
 *
 * WHY IT LIVES IN src/platform/ AND NOT src/engine/. It holds a table of GoComet plant names.
 * `docs/MULTI_PLATFORM_ARCHITECTURE.md` invariant 1 - no portal-specific identifier outside
 * `src/platform/` - therefore applies to it directly.
 *
 * WHAT IT IS, STRUCTURALLY. A TRANSLATOR owned by `gocometAdapter`, one instance per enquiry key,
 * fed one observation per `getAuctionState` tick. It is NOT a second per-monitor state machine
 * running beside `bidEngine._observeExtension`: it never sees a monitor, never decides anything
 * about money, and its whole output leaves through the ordinary state fields the engine already
 * speaks (`extendMs` today). The engine keeps sole ownership of round counting for strategy; the
 * rounds counted here exist only to decide what may be learned about the increment.
 *
 * THE EMPIRICAL BASE (automated-bidding/_research/2026-07-25_gocomet-extension-mechanics.md; 825
 * closed Waaree auctions, 1,507 recorded extension events):
 *   - 67.6% of auctions extend at least once. mean 1.77, median 1, p90 4, p95 6, max observed 22.
 *   - There is NO cap on rounds. The war is demand-limited: it ends when late bidding stops. The
 *     22-round auction ran ~2 hours past its posted close and was still stepping cleanly.
 *   - `auction_type` says "British Auction" on all 831 rows INCLUDING the 22-round one. It is
 *     useless. Never gate extension handling on it - infer from close-time movement only.
 *
 * THE INCREMENT IS 299s AND IS NOT PER-PLANT. The "300s at the big plants, 240s at Sachin-Surat and
 * the small ones" split that the first pass reported is a FLOORING ARTEFACT: it was derived from
 * `bid_close_time`, which GoComet truncates to the minute, so a true 4m59s step reads as either 4
 * or 5 minutes depending only on where the close sat inside its own minute. Read off
 * `bid_close_timestamp` the step is 299s platform-wide, and closes therefore drift ~1s EARLIER per
 * round (23s of accumulated drift observed over a long chain) - wider than a snipe window, which is
 * why nothing here may key off the posted close. A second, independent derivation from BRL's
 * archived bid-log close-time SLIDE measured 60 anti-snipe boundaries at 296-302s, the 1-2s spread
 * being poll timing.
 *
 * That study also paid for the clean-band rule below by getting it wrong first: its initial pass used
 * a >60s slide threshold and reported 207 "resets" whose slide magnitudes were 5 hours to 22 days -
 * shipper RE-OPENS of an enquiry, not anti-snipe rounds. Restricting to the 100-400s band removed
 * them. maxRoundJumpMs and the `implausible_jump` anomaly path exist so this model cannot make the
 * same mistake at runtime, where the cost is not a wrong statistic but a wrongly-inflated round
 * counter.
 *
 * NO CAP, SO NO "EFFECTIVELY HARD". `bidEngine._effectivelyHard()` degrades an unknown extension
 * cap to TRUE - treat the believed close as final and run the proven hard snipe. On SuperProcure
 * that is a sound fail-closed degrade because SP's caps are small (0/1/3). Here the cap does not
 * EXIST, so this model never reports "effectively hard" and exposes no such concept. Terminality is
 * only ever established RETROSPECTIVELY - see isTerminal().
 *
 * LEGAL WALL (Competition Act s.3(3)(d), architecture-level and non-negotiable). Everything here is
 * derived from ONE number: our own load's countdown. No competitor amount is read, stored, inferred
 * or modelled anywhere in this file, and nothing here can be used to signal to another bidder.
 */

/**
 * Per-plant extension seeds, matched as case-folded substrings against the load's origin string,
 * MOST SPECIFIC FIRST, because GoComet's origin is a full address ("Degam (Survey No. 1934, NH-48,
 * Chikhli)") in which a coarse region name can easily co-occur with a different plant's name.
 *
 * EVERY ENTRY CARRIES THE SAME VALUE, AND THAT IS THE FINDING, NOT AN OVERSIGHT. The earlier table
 * seeded Sachin, GIDC, Valsad, Haryana, Mumbai and Surat at 240,000 off the truncation artefact
 * described above. Carrying that number over would have published `extendMs: 240_000` on those
 * plants, sizing the engine's sustained-zero finalize debounce at 243s against a real 299s step -
 * i.e. finalizing mid-extension, and `_finalize` is terminal, so the auction is abandoned silently
 * and indistinguishably from a loss. The table survives as the OVERRIDE MECHANISM (operator rules
 * are tried first, and this is the one place that changes if a genuine per-plant difference is ever
 * measured off `bid_close_timestamp`); the split it used to encode does not.
 */
const PLANT_INCREMENTS_MS = Object.freeze([
  { match: 'nandigram', ms: 300_000 },
  { match: 'umbergaon', ms: 300_000 },
  { match: 'tumb', ms: 300_000 },
  { match: 'chikhli', ms: 300_000 },
  { match: 'degam', ms: 300_000 },
  { match: 'ecotech', ms: 300_000 },
  { match: 'greater noida', ms: 300_000 },
  { match: 'sachin', ms: 300_000 },
  { match: 'gidc', ms: 300_000 },
  { match: 'valsad', ms: 300_000 },
  { match: 'haryana', ms: 300_000 },
  { match: 'mumbai', ms: 300_000 },
  { match: 'surat', ms: 300_000 },
]);

/**
 * The measured 299s step rounded UP to 300s, and the seed for an unrecognised plant.
 *
 * ROUNDING UP IS THE SAFE DIRECTION AND ROUNDING DOWN IS NOT, because the consumer is
 * `bidEngine.js` line ~1403: `debounceMs = isSoft && state.extendMs ? state.extendMs +
 * finalizeDebounceMs : finalizeDebounceMs`. Over-stating it costs a few wasted polls at the end of
 * a dead auction. Under-stating it finalizes a monitor mid-extension, and finalize is terminal
 * (`monitor.finalized` is never unset and `_schedule` refuses a finalized monitor), so the auction
 * is abandoned for good with no alert. 299,000 is the measured truth and is therefore exactly the
 * value NOT to publish.
 */
const GOCOMET_INCREMENT_DEFAULT_MS = 300_000;

const DEFAULT_CLOSE_MODEL = Object.freeze({
  incrementMs: GOCOMET_INCREMENT_DEFAULT_MS,
  // Smallest forward move of a LIVE deadline that counts as an extension. The countdown is the
  // platform's own value in whole seconds, so the only noise in a derived close time is
  // second-quantization plus the gap between the server computing the countdown and us timestamping
  // the reply. Nothing but a real extension moves a live deadline forward by 30s, and the ~1s/round
  // close drift is BACKWARD, so the forward-only rule already absorbs it. Deliberately NOT scaled
  // off the increment the way SP's `extendMs * 0.5` rule is: a reactive close sets the new deadline
  // to roughly (now + increment), so a bid landing early in a wide reactive window produces a jump
  // materially smaller than the increment. This threshold does NOT apply across a held zero - see
  // observe().
  minJumpMs: 30_000,
  // Above this a forward move is not an anti-snipe round: the research's raw histogram has a tail
  // from 60 minutes to 14 days that is SHIPPER RE-OPENS of an enquiry, a different mechanic. Such a
  // move is counted as ONE round and flagged, never divided into hundreds of phantom rounds.
  maxRoundJumpMs: 60 * 60 * 1000,
  // Belt on the multi-round divider so one garbage countdown cannot inflate the round counter by an
  // arbitrary amount. 12 rounds is an hour at the 300s increment.
  maxRoundsPerObservation: 12,
  // How long an exhausted countdown must be HELD before the deadline is treated as having visibly
  // passed on a still-answering auction. Two adapter GET spacings (5,000ms each), so one stray zero
  // read can never trip it but two consecutive ones do.
  zeroHoldMs: 10_000,
  // How long the countdown must stay exhausted before the auction is called over. See isTerminal().
  terminalGraceMs: 30_000,
  // 1,247 of 1,250 in-band events are 240s or 300s once truncation is accounted for. A jump outside
  // this band is not evidence about the increment and is never learned from.
  cleanBandMinMs: 100_000,
  cleanBandMaxMs: 400_000,
});

/**
 * Seed the extension increment for a load from its plant (GoComet's `origin`).
 *
 * FAIL-SAFE DIRECTION IS UP. The seed feeds two consumers and both are more patient with a larger
 * value: the published `extendMs` (a longer finalize debounce) and the multi-round divider (a
 * larger increment divides a jump into FEWER rounds, so the counter undercounts rather than
 * inflating). Under the three-revisions-per-enquiry budget, holding is the recoverable failure and
 * spending is not, which is why an unrecognised plant seeds at the full increment.
 *
 * @param {string|null} origin - the load's origin/plant string, e.g. lane.origin.
 * @param {Array<{match: string, ms: number}>|null} overrides - operator-supplied rules, tried FIRST.
 * @returns {number} the seed increment in ms.
 */
function resolvePlantIncrementMs(origin, overrides) {
  const hay = String(origin == null ? '' : origin).toLowerCase();
  if (!hay) return GOCOMET_INCREMENT_DEFAULT_MS;
  const rules = (Array.isArray(overrides) ? overrides : []).concat(PLANT_INCREMENTS_MS);
  for (const r of rules) {
    if (!r || !r.match) continue;
    const ms = Number(r.ms);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (hay.includes(String(r.match).toLowerCase())) return ms;
  }
  return GOCOMET_INCREMENT_DEFAULT_MS;
}

/** Median of a non-empty numeric array (even length -> lower-mid, so the result is always observed). */
function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * One instance per armed GoComet enquiry, owned by the adapter. Pure: it is fed observations and
 * answers questions. It never polls, never calls an adapter, and never decides anything about
 * money - it only says what the clock has done.
 */
class GoCometCloseModel {
  /**
   * @param {Object} opts
   * @param {number} [opts.incrementMs] - the per-plant seed (resolvePlantIncrementMs).
   * @param {number} [opts.minJumpMs] @param {number} [opts.maxRoundJumpMs]
   * @param {number} [opts.maxRoundsPerObservation] @param {number} [opts.zeroHoldMs]
   * @param {number} [opts.terminalGraceMs]
   * @param {number} [opts.cleanBandMinMs] @param {number} [opts.cleanBandMaxMs]
   */
  constructor(opts = {}) {
    const cfg = Object.assign({}, DEFAULT_CLOSE_MODEL, opts || {});
    // Coerce every numeric the same way bidEngine's constructor coerces softCfg: config.js reads env
    // with Number(), so a malformed env lands NaN, and a NaN increment would silently disable round
    // counting (every comparison against NaN is false) with no error anywhere.
    for (const k of ['incrementMs', 'minJumpMs', 'maxRoundJumpMs', 'maxRoundsPerObservation',
      'zeroHoldMs', 'terminalGraceMs', 'cleanBandMinMs', 'cleanBandMaxMs']) {
      const v = Number(cfg[k]);
      cfg[k] = (Number.isFinite(v) && v > 0) ? v : DEFAULT_CLOSE_MODEL[k];
    }
    this.cfg = cfg;

    this.seedIncrementMs = cfg.incrementMs;
    this.learnedIncrementMs = null;     // set once >=1 non-first clean-band single-round jump is seen
    // High-water mark of everything publishedExtendMs() may ever return. Starts at the seed and
    // only ever moves up - see publishedExtendMs for why the money path may not follow the sample
    // back down, and why the ratchet is maintained here rather than in the accessor.
    this._extendHighWaterMs = cfg.incrementMs;
    this.roundsObserved = 0;            // extension ROUNDS, multi-round aware (not "jumps seen")
    this.jumpsObserved = 0;             // raw forward jumps seen; < roundsObserved when aliasing occurred
    this.impliedCloseAt = null;         // belief about the live deadline (epoch ms)
    this.firstObservedAt = null;
    this.lastObservedAt = null;
    this.zeroSince = null;              // when the countdown was first seen exhausted (null once live)
    this._zeroHeld = false;             // this zero run outlived zeroHoldMs
    this._cleanJumps = [];              // clean-band single-round jumps, the learning sample
    this.anomalies = [];                // {kind, jumpMs, atMs} - surfaced, never silently swallowed
  }

  /** The increment in force: the learned value once there is evidence, else the per-plant seed. */
  get incrementMs() {
    return this.learnedIncrementMs != null ? this.learnedIncrementMs : this.seedIncrementMs;
  }

  /** True once a live jump has confirmed the increment, so an operator can tell seed from evidence. */
  get incrementConfirmed() { return this.learnedIncrementMs != null; }

  /**
   * What the adapter publishes as `state.extendMs` - the translator's one output on the money path.
   *
   * IT IS A RATCHET: the running maximum of the seed and every learned value ever computed, so it
   * is non-decreasing for the life of the enquiry. `incrementMs` above is the round-counting value,
   * where a learned number that moves either way is merely a more accurate divisor. This is a
   * different consumer with an asymmetric cost: it sizes the engine's finalize debounce, so a value
   * below the true step finalizes a live auction permanently while a value above it wastes polls.
   *
   * A FLOOR AT THE SEED IS NOT ENOUGH, and that is what this used to be. `learnedIncrementMs` is a
   * MEDIAN over a growing sample, and median() takes the lower-middle element, so a second sample
   * below the first drags it down: a plant that published 390s on one clean jump fell back to 320s
   * on the next, mid-auction, without ever touching the seed floor. The shrink cannot be recovered
   * from - the debounce it sized has already expired the monitor, `finalized` is never unset, and
   * the auction is abandoned indistinguishably from a loss.
   *
   * THE RATCHET LIVES ON THE PUBLISHED VALUE, NOT ON THE LEARNED ONE, and not inside this accessor.
   * Ratcheting `learnedIncrementMs` would pin the round divider and the operator-facing snapshot to
   * one long jump forever, and those two want the honest running median. Ratcheting inside the
   * accessor would make the guarantee only as strong as the caller's read pattern - a peak nobody
   * happened to read would not latch. Updating it at the single site where the learned value
   * changes makes the property hold over time rather than over reads.
   */
  publishedExtendMs() {
    return this._extendHighWaterMs;
  }

  /** Wall-clock the war has been running, measured from the first live observation. */
  warElapsedMs(atMs) {
    if (this.firstObservedAt == null) return 0;
    return Math.max(0, Number(atMs) - this.firstObservedAt);
  }

  /**
   * Feed one poll's worth of state.
   *
   * `bidding_closed` IS NOT AN INPUT AND MUST NOT BECOME ONE. The earlier version of this model
   * keyed terminality on `bidding_closed OR zero-held`, reading as two independent signals. A census
   * of all 44 captured live `bidding-data` responses
   * (automated-bidding/_research/2026-08-10_gocomet-bidding-data-key-census.md) shows the endpoint
   * returns exactly seven keys and that is not one of them - the disjunct could never fire, so the
   * "two signals" were always one. Passing the field here is harmless and simply ignored; see
   * isTerminal() for why it is deliberately not honoured even if it starts arriving.
   *
   * @param {Object} o
   * @param {number|null} o.closeAtMs - the adapter's server-clock-derived absolute close, or
   *   null/undefined when the countdown is exhausted. Never derived from the local wall clock.
   * @param {number} o.atMs - local wall clock at which this observation was taken.
   * @returns {{extended: boolean, roundsCounted: number, jumpMs: number|null, heldZero: boolean,
   *   roundsObserved: number, incrementMs: number, anomaly: string|null, terminal: boolean}}
   */
  observe(o = {}) {
    const atMs = Number(o.atMs);
    const nil = (anomaly = null) => ({ extended: false, roundsCounted: 0, jumpMs: null,
      heldZero: this._zeroHeld, roundsObserved: this.roundsObserved, incrementMs: this.incrementMs,
      anomaly, terminal: this.isTerminal(atMs) });
    if (!Number.isFinite(atMs)) return nil('bad_observation_clock');
    this.lastObservedAt = atMs;

    const closeAtMs = Number(o.closeAtMs);
    const exhausted = o.closeAtMs == null || !Number.isFinite(closeAtMs);
    if (exhausted) {
      // Do NOT derive an implied close from an exhausted countdown - it would read as the deadline
      // having moved BACKWARD to now, and the forward-only rule would then have to defend against
      // our own bookkeeping rather than against real platform behaviour. Just start the clock that
      // isTerminal reads, and leave the belief where it is.
      if (this.zeroSince == null) this.zeroSince = atMs;
      if (atMs - this.zeroSince >= this.cfg.zeroHoldMs) this._zeroHeld = true;
      return nil();
    }

    // --- THE EXTENSION HIDDEN BEHIND A HELD ZERO, AND WHY A JUMP THRESHOLD MISSES IT -------------
    // A deadline that visibly expired while the platform kept answering, and then produced a live
    // countdown again, has been extended - there is no other mechanism on this portal that can make
    // an expired auction start counting down again. The magnitude of the move carries no
    // information here and must not be a condition, because a reactive close is written as
    // (bid instant + increment) rather than (old close + increment): after a long hold the new
    // deadline can land only seconds beyond the expired one, well under minJumpMs, and a bare
    // forward-jump test drops exactly that round. The belief is known-stale, so it is ADOPTED
    // outright rather than moved forward-only, and the jump is not learned from.
    const wasHeld = this._zeroHeld;
    const heldTerminal = this.isTerminal(atMs);
    this.zeroSince = null;
    this._zeroHeld = false;

    if (this.impliedCloseAt == null) {
      this.impliedCloseAt = closeAtMs;
      this.firstObservedAt = atMs;
      return nil();
    }

    const jump = closeAtMs - this.impliedCloseAt;
    if (wasHeld) {
      // A zero that outlived terminalGraceMs and THEN produced a live countdown is the corpus's
      // shipper RE-OPEN, not an anti-snipe round - the same mechanic maxRoundJumpMs catches on the
      // live path. It still counts one round, because competition has demonstrably resumed, but it
      // is flagged so a re-open is never mistaken for evidence about the increment.
      const anomaly = heldTerminal ? 'reopen_after_terminal' : null;
      this.impliedCloseAt = closeAtMs;
      this.jumpsObserved += 1;
      this.roundsObserved += 1;
      if (anomaly) this.anomalies.push({ kind: anomaly, jumpMs: jump, atMs });
      return { extended: true, roundsCounted: 1, jumpMs: jump, heldZero: true,
        roundsObserved: this.roundsObserved, incrementMs: this.incrementMs, anomaly,
        terminal: false };
    }

    if (jump < this.cfg.minJumpMs) {
      // Ordinary countdown drift on a live auction. FORWARD-ONLY, exactly as SP's _observeExtension
      // does it: never let the belief slide backward on quantization wobble, or the next real jump
      // is measured from a depressed base and reads larger than it was.
      if (jump > 0) this.impliedCloseAt = closeAtMs;
      return nil();
    }

    // --- a real forward move of a live deadline: an extension happened ---
    this.jumpsObserved += 1;
    this.impliedCloseAt = closeAtMs;

    let anomaly = null;
    let roundsCounted;
    if (jump > this.cfg.maxRoundJumpMs) {
      // Not the anti-snipe mechanic - a shipper RE-OPEN. Count ONE, because a fresh round of
      // competition has certainly begun, but never divide a re-open into hundreds of phantom
      // rounds, and surface it so it is diagnosable rather than silent.
      roundsCounted = 1;
      anomaly = 'implausible_jump';
    } else {
      roundsCounted = Math.max(1, Math.round(jump / this.incrementMs));
      if (roundsCounted > this.cfg.maxRoundsPerObservation) {
        roundsCounted = this.cfg.maxRoundsPerObservation;
        anomaly = 'rounds_clamped';
      }
      // LEARN the increment, but only from evidence that can actually bear on it:
      //   - not the FIRST extension: it is measured from the ORIGINAL posted deadline, so where
      //     inside the reactive window the late bid landed offsets it. Learning from it biases the
      //     increment low, and a low increment overcounts rounds.
      //   - single-round jumps only. A 2-round jump carries no information about the increment that
      //     is not circular (we used the increment to decide it was 2 rounds).
      //   - inside the clean band only.
      if (this.roundsObserved > 0 && roundsCounted === 1
          && jump >= this.cfg.cleanBandMinMs && jump <= this.cfg.cleanBandMaxMs) {
        this._cleanJumps.push(jump);
        this.learnedIncrementMs = median(this._cleanJumps);
        if (this.learnedIncrementMs > this._extendHighWaterMs) {
          this._extendHighWaterMs = this.learnedIncrementMs;
        }
      }
    }

    this.roundsObserved += roundsCounted;
    if (anomaly) this.anomalies.push({ kind: anomaly, jumpMs: jump, atMs });
    return { extended: true, roundsCounted, jumpMs: jump, heldZero: false,
      roundsObserved: this.roundsObserved, incrementMs: this.incrementMs, anomaly, terminal: false };
  }

  /**
   * Is the auction genuinely over?
   *
   * THIS IS THE ONE QUESTION SuperProcure'S ENGINE NEVER HAS TO ASK PROSPECTIVELY, and the reason
   * the whole endgame shape differs. SP knows the cap, so it can compute in advance that the current
   * round is the last one. Here there is no cap, so a round can only ever be shown to have been the
   * last one AFTERWARDS, by the deadline passing and nothing happening.
   *
   * THE ZERO-HELD RULE IS THE WHOLE TEST. It used to be the second half of a disjunction whose first
   * half was GoComet's own `bidding_closed`; the key census killed that half (see observe()), so
   * this is now the sole carrier and is written as such rather than left looking like a fallback.
   * The grace exists because a reactive close is applied by the platform in response to a bid, and
   * the observed order of "countdown reaches zero" and "extension is written" is not atomic from a
   * poller's outside view: the live Phase-2 capture read `closingIn null` for an auction whose
   * deadline never moved (a true close), and that is the same read shape a not-yet-applied extension
   * produces. The grace buys the difference.
   *
   * IF GoComet EVER STARTS SENDING `bidding_closed`, THIS STILL WILL NOT READ IT, and that is a
   * decision rather than an omission. Honouring it would ACCELERATE a terminal verdict on the
   * strength of a field nothing in 44 captures has ever shown us, and the cost asymmetry runs
   * entirely one way: terminating late wastes polls, terminating early abandons a live auction
   * permanently. The failure mode of ignoring it is therefore bounded at terminalGraceMs of extra
   * patience per close. Wiring it in is a change to make once it has been observed carrying a value,
   * with the fixture to prove it - not before.
   *
   * @param {number} atMs
   * @returns {boolean}
   */
  isTerminal(atMs) {
    if (this.zeroSince == null) return false;
    const t = Number(atMs);
    if (!Number.isFinite(t)) return false;
    return (t - this.zeroSince) >= this.cfg.terminalGraceMs;
  }

  /** Compact state for events, alerts and the bid record's fire-time context. */
  snapshot() {
    return {
      roundsObserved: this.roundsObserved,
      jumpsObserved: this.jumpsObserved,
      incrementMs: this.incrementMs,
      publishedExtendMs: this.publishedExtendMs(),
      incrementConfirmed: this.incrementConfirmed,
      seedIncrementMs: this.seedIncrementMs,
      impliedCloseAt: this.impliedCloseAt,
      anomalies: this.anomalies.length,
    };
  }
}

module.exports = {
  GoCometCloseModel,
  resolvePlantIncrementMs,
  PLANT_INCREMENTS_MS,
  GOCOMET_INCREMENT_DEFAULT_MS,
  DEFAULT_CLOSE_MODEL,
};
