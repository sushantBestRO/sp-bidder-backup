'use strict';

const { buildLadder, buildBandLadder, computeUndercut, maxImprovementPrice, assertAboveFloor, plausibleCeiling, capLadderToCeiling,
  decrementViolations, selectRung, interpolateBandLadder, roundLadderToGrid,
  ROUNDING_STEP_MIN, ROUNDING_STEP_MAX,
  deriveSpacedLadder, fittingRungs, scaleLadderByType, perTypeMinDecrement,
  floorStepViolation, floorMarginSubstitution } = require('./pricing');
// Read here rather than threaded through opts.config so the engine and armFromRequest cannot
// resolve different house floor margins - two sources for one rule is what S4 was.
const appConfig = require('../config');
const { assertRulesSupported, assertTransitSatisfied, reconcilePricingMode } = require('../model/loadRules');
const { tokenMatch } = require('../util/tokenMatch');
const { numericOrNull } = require('../util/numericOrNull');
const { bidGapsMs } = require('../util/reportedClose');
const { createLogger } = require('../logging/logger');
// The FTL multi-vehicle predicate (one source of truth, shared with discovery). Direction is
// one-way (discovery does not require the engine), so there is no import cycle.
const { isMultiVehicle } = require('../discovery/discovery');
// The anti-detection hard bounds live in configStore (the write-time validator). The engine
// re-reads minInterFireMs's cap from here so the write-side and the read-side clamp share ONE
// source of truth - see setAntiDetection.
const { AD_LIMITS } = require('../admin/configStore');
const { closeIsProvisional } = require('../platform/adapter');
const roundTracker = require('./roundTracker');
const walkMath = require('./walk');
const { randomUUID } = require('crypto');

// SuperProcure publishes no clock bound until its first clock reading; the walk assumes GoComet's
// whole-second default until then.
const SP_UNKNOWN_CLOCK_ERROR_MS = 1_000;
const WALK_PREPARE_LEAD_MS = 4_000;
// The OPEN read's round trip (0.27-0.72 s measured 2026-09-28) plus a tick. The hold check leads by
// this plus the adapter's login-wide gap between live-rank reads.
const LIVE_RANK_READ_BUDGET_MS = 1_500;
// Covers the synchronous pre-submit intent write on the bidding server.
const GC_SUBMISSION_PERSIST_MS = 100;

// Provisional-close (GoComet) final-round timing. A round whose load carries no roundPolicy is final
// after this many extensions (Waaree's capped plants). The buzzer is the declared write runway plus
// one read interval plus one countdown second (GoComet counts down in whole seconds), so a buzzer read
// that lands up to a second late still decides above the runway; the middle band is where a final
// round with attempts to spare takes its one non-floor shot. Reads are aimed inside each band because
// GoComet spaces a POLL read 5 s from the last one, and a POLL waiter queued just above the buzzer is
// released below it.
const DEFAULT_FINAL_AFTER_EXTENSIONS = 3;
// A091: a monitor finalized by a natural close (_finalize) or an unreadable retirement
// (_retireUnreadable) is never deleted by either of them - stop() is the only deletion path, and
// stop() is reached only from teardown/sim-reset/operator-stop/re-price/tick-fault-handoff, never
// from a normal close. Left alone, every closed load's monitor lives in memory for the process's
// whole life. Matches priceRequests.js PRUNE_RETENTION_MS: once the price request itself ages out,
// nothing can look this monitor up by loadId anyway, so the two should not disagree.
const CLOSED_MONITOR_RETENTION_MS = 7 * 86_400_000;
// D012 (redesigned 26 Sep after review): see noLandingReport's own doc for what this gates. The
// elapsed-time version this replaced fired on ordinary quiet stretches - replayed on the 24 Sep
// snapshot, 187 of 847 GoComet loads went over 60 min from arm to first landing, which projects to
// roughly 150 false alerts across 35 of 42 days.
const SILENT_NO_BID_STREAK_THRESHOLD = 2;
const PROVISIONAL_READ_INTERVAL_MS = 1_000;
const PROVISIONAL_COUNTDOWN_QUANTUM_MS = 1_000;
const PROVISIONAL_MIDDLE_BAND_MS = 12_000;
const PROVISIONAL_MIDDLE_AIM_MS = 11_000;
// Ruling 56: SuperProcure's pre-cap shot goes this far out, so its own effect on the close shows
// before the buzzer (the tracker watches for it for 2,500 ms).
const SP_PROBE_LEAD_MS = 6_000;
// A close whose last live read was further out than this left the last seconds unseen: a rival's move
// in them could not be answered (2026-09-25, Waaree 260925RP1C: 12.2 s).
const STALE_READ_AT_CLOSE_MS = 3_000;

// Ceiling on softOpenJitterMs, as a fraction of the mark it spreads. The knob is env-only and never
// passes through configStore's AD_LIMITS validator the way its sibling openJitterMs does, so the
// bound has to live at the read site (_jitteredMark). At the shipped default it caps the spread at
// 30,000ms, which leaves the mark inside GoComet's 300,000ms extension increment at every value the
// operator can set. Bounding the LARGER direction is the whole point: larger is the direction that
// walks the establish back out toward arm time and restores the defect.
const SOFT_OPEN_JITTER_MAX_FRACTION = 0.2;

// How far ahead of a published anti-snipe trigger window the NON-allowlisted establish mark sits.
// Deliberately its own constant rather than softCfg.establishLeadMs, which is a soft-close-ENDGAME
// knob: reading that one here steered opted-out customers off a feature whose own contract
// (DEFAULT_SOFT) says every monitor stays byte-identical to Module-1 while it is disabled, and -
// because softCfg is replaced wholesale on a Settings save and this is read per tick - moved loads
// that were already armed and in flight. Same value as that knob's shipped default, so nothing
// moves at shipped settings; what changes is that SP_SOFT_ESTABLISH_LEAD_MS can no longer reach
// this path, exactly as .env.example already tells the operator.
const NON_ALLOWLISTED_ESTABLISH_LEAD_MS = 40_000;

const DEFAULTS = {
  pollFarMs: 30_000,     // > 60s to close
  pollMidMs: 1_000,      // 10-60s
  pollHotMs: 200,        // <= 10s  (the snipe window)
  farThresholdMs: 60_000,
  hotThresholdMs: 10_000,
  openAtMs: 15_000,      // establish a bid (our presence/rank) at this much remaining
  // The establish mark for a SOFT-close load that is NOT on the soft-close allowlist. It used to
  // have no mark at all: that branch returned rung 0 on the first tick at any remaining, so every
  // GoComet load (closeModel 'soft' is a static platform capability, and no GoComet shipper has
  // ever been allowlisted) put BRL's opening price on the board seconds after the desk typed a
  // rate. Measured over the whole corpus: 376 of 504 GoComet loads bid more than an hour before
  // close, against 1,229 of 1,238 SuperProcure hard-close loads bidding in the final minute.
  //
  // WHAT SETS THE WIDTH, and it is NOT the walk. Holding the establish makes it the FIRST bid of
  // the auction, so every bid this load will ever place now lives inside this window. That is the
  // whole constraint: the window has to be wider than the longest gap in which the engine can
  // legitimately be unable to decide, or one routine event closes an armed, priced load with
  // nothing on the board.
  //
  // GoComet publishes exactly that gap. A 429 or 503 opens a read cooldown of rateLimitBackoffMs
  // (60,000) that a server Retry-After can extend to maxRateLimitBackoffMs (120,000); through it
  // every GET returns ok:false, and _tick returns on a failed read WITHOUT calling _decide. The
  // adapter publishes the total as an expected-liveness window of 125,000ms and its own comment
  // calls that a LEGITIMATE gap. _lastResortFloor cannot cover it - that is gated on _isLastChance,
  // which needs a live tick inside the last floorWindowMs, and a cooldown running to close
  // guarantees there is none. 150,000 leaves ~25s of live window even when a full cooldown opens at
  // the very top of it.
  //
  // The vendor identity is shared with BRL's own autopilot against a rate limit nobody has measured,
  // so this is a routine event, not a tail case.
  //
  // WHY NOT WIDER STILL. It stays inside GoComet's 299,000ms extension increment, so the opening
  // bid is committed for part of one extension round rather than for the whole auction - against
  // 376 of 504 loads that bid more than an hour before close before this gate existed. What that
  // buys is the DESK-CORRECTION RUNWAY, not concealment from rivals: GoComet's board is rank-only
  // (capabilities() ships standingPriceVisible false), so a standing price is not readable by a
  // competitor and the "exposed price" framing an earlier revision used here overstated the gain.
  //
  // KNOWN AND UNMEASURED: whether a bid AT this mark self-triggers an extension on GoComet. The
  // width above is derived entirely from the platform's READ budget, and the anti-self-extension
  // guard that would answer the other question is inert here - GoComet publishes no trigger window,
  // so _aheadOfTriggerWindow never fires and gocometStack's INERT_MECHANISMS declares it. The
  // repo's own research (_research/2026-07-25_gocomet-module-scope.md:139,292) works from a ~300s
  // reactive window and says every engine action self-triggers another round; against that
  // assumption 150,000 is half the increment and sits INSIDE the plausible window, so the expected
  // cost of this mark is up to one extra extension round out of a 3-revision budget. That is
  // accepted deliberately rather than dodged by widening: the increment-derived alternative
  // (extendMs + a lead, ~339s) is no better measured and gives back most of the runway this gate
  // exists to create. SETTLING IT NEEDS A LIVE CAPTURE, not more reasoning - establish on a real
  // GoComet load at ~150s remaining and watch whether bid_close_timestamp slides immediately. Until
  // that capture exists, treat a GoComet auction that gains a round right after our opening bid as
  // the evidence, and re-derive from state.extendMs then.
  //
  // The direction of error is deliberate and asymmetric. Too wide costs price exposure, which is
  // visible and recoverable. Too narrow costs the load outright, silently - the forfeit that cost
  // three Havells loads (see _lastResortFloor).
  //
  // HONEST LIMIT ON THIS NUMBER: it covers ONE cooldown. Chained rate-limit responses stack past
  // 125,000ms, and the adapter's global spacing widens to several seconds between ANY two reads
  // across every armed load under full backoff, so a heavily throttled account can still starve this
  // window. No width fixes that - the real answer is for the engine to notice it has gone blind and
  // bid on the last state it trusted, which this does not attempt. What this constant buys is that
  // the ROUTINE single cooldown, which the adapter treats as normal operation, can no longer take
  // the load. Treat a zero-bid GoComet close with a healthy ladder as evidence for that follow-up,
  // not as a reason to widen this further.
  //
  // These numbers are worked in BY HAND and deliberately not read off capabilities(): the engine
  // reads exactly four capability fields, and the read/write budget ones are pinned inert above the
  // platform seam (scripts/test-part1-part2-seam.js gate B2). Wiring them is a Part 2 decision with
  // a doc update attached, not a side effect of a timing fix. The cost of that is a real coupling:
  // if GoComet's cooldown constants move, this constant does not follow on its own.
  //
  // WHAT THIS IS NOT. It is not a budget the ladder paces itself across. The walk that actually
  // runs is establish, then the next unfired rung on the following tick (_scheduledRungIndex is
  // keyed to openAtMs, so above that mark f clamps to 0 and the step collapses to
  // currentRungIndex + 1), then the reserved floor released at floorWindowMs. Do not re-derive this
  // constant from "three attempts x one attempt's wall clock" - an earlier revision did, and the
  // paced walk it described does not exist.
  softOpenAtMs: 150_000,
  // Per-load spread on softOpenAtMs, so the first bid does not land at a fixed countdown mark on
  // every load. One-sided EARLIER (a LARGER remaining) by construction, exactly like openJitterMs,
  // so it can never drift toward the write budget or the floor window. Rolled once per monitor and
  // cached, so the mark is stable across ticks.
  //
  // NOT under the antiDetection gate that owns openJitterMs. There the jitter decorates a mark
  // chosen for correctness; here varied timing is the requirement itself (the desk asked for it),
  // and an operator turning anti-detection off would otherwise silently restore the fixed metronome
  // this exists to remove. The cost of sitting outside that gate is that it also sits outside
  // AD_LIMITS, so _softEstablishThreshold has to bound it at the read site instead - see
  // SOFT_OPEN_JITTER_MAX_FRACTION.
  softOpenJitterMs: 15_000,
  floorWindowMs: 2_500,  // the floor rung may only fire inside the last 2.5s
  // How long after our last landed bid a rank read that cannot show our own amount is still taken as
  // the rank from before it. A read showing our own landed amount is settled on arrival
  // (_ownBidSettled). The 1.2 s is the v2.14.2 box's accept -> improved-rank p50, which was mostly the
  // closed-bids stall fixed in 86f9309, so it is an upper bound, not SuperProcure's frame latency.
  rankSettleMs: 1_200,
  // After an accepted bid on a push-fed state, how often the socket cache is re-read for the frame
  // showing our own amount, so the tick that decides on the new rank runs when it arrives rather than
  // a full pollHotMs later. Bounded by rankSettleMs. null turns it off.
  rankFollowMs: 25,
  // How long a GoComet submit response's rank and close may stand in for the next bidding-data read
  // (_stateFromResponse). null turns it off.
  responseStateMaxAgeMs: 1_500,
  minLeadMs: 400,        // never fire so late the bid can't arrive (oneway + this)
  minInterFireMs: 150,   // don't spam the bid endpoint, but stay crisp in the snipe window
  finalizeDebounceMs: 3_000, // base sustained-zero window before finalizing (soft close adds the extend interval)
  openingMarkupPct: 0.10,
  rungs: 6,
  // Layer 3 fine-ladder cap (mirrors config.engine.rungCap / SP_RUNG_CAP). 0 = auto: bounded by
  // real constraints (platform bid cap, decrement headroom, runaway belt), not a fixed count.
  // Not a bid-rate control - bids are cadence-bounded, not grid-bounded.
  rungCap: 0,
  armLeadMs: 10_000,     // wake + arm this long BEFORE an auction's start (so we watch from frame #1)
  // Mirrors config.engine.delistedStaleMs / SP_DELISTED_STALE_MS - three missed 30s discovery polls.
  // How stale the adapter's cached listing must be before _checkDelisted tells the desk. It gates a
  // NOTICE and nothing else; no bidding decision reads it.
  delistedStaleMs: 90_000,
  // Mirrors config.engine.neverListedProbeBoundMs. How long a never-listed load (BC-15 Fix B,
  // ruling 65) waits for the discovery poll to settle it before falling back to a live probe of its
  // own - two 30s discovery polls, floored at 60s so a restart never opens N board-wide reads at
  // once. Gates the FALLBACK probe only; the fast path (a completed listing since arm) fires
  // regardless of this bound.
  neverListedProbeBoundMs: 60_000,
  startGraceMs: 5_000,   // read-fails while now < startsAt + this are the load's expected
                         //   not-yet-open state, not counted toward repeated_read_failures
  // How far past its own recorded close a NO-OUTCOME intent is still re-armed rather than retired
  // by the boot supervisor (see rehydrate). The recorded close is a lower bound on a soft auction's
  // end, never the end itself: _observeExtension deliberately does NOT advance the believed close
  // on the sustained-zero inference (it learns that a round happened, not when it now ends), and
  // this file's own live evidence is a SuperProcure socket frozen at a passed close for ~183s while
  // the auction ran, against a GoComet extension step of ~299s. Inside this window the platform -
  // not a stale timestamp - decides: the load is re-armed and the first live read finalizes it if
  // it really did close. Sized to cover one extension round on either platform plus settle.
  rehydrateGraceMs: 600_000,
  // The restart grace for a load whose round record says it is uncapped: the 22-round war ran ~2 h.
  uncappedRestartGraceMs: 7_200_000,
  // How long past a load's best-known close the engine keeps retrying reads that never succeed
  // before it gives up and retires the load as unknown. The bound is AGE, not a failure count: the
  // retry cadence decides how fast failures accrue, so a count measures our own polling rather than
  // the auction, and the fact that actually matters is that this load cannot still be running.
  //
  // SIZED ABOVE THE MEASURED WORST CASE, stated as the arithmetic rather than as a claim. The worst
  // GoComet load on record self-extended 22 rounds at ~299s: 22 x 299s = 6,578s = 1h50m past its
  // posted close (the same figure adapter.js and gocometAdapter.js both record). One hour does NOT
  // clear that - it is barely over half of it - and the gap matters precisely here, because the
  // bound is measured against believedCloseAt, which only advances on reads that SUCCEED. During
  // the read outage this feature triggers on, the belief is frozen while a live auction keeps
  // extending, so a bound under the extension career retires a load that is still running.
  //
  // Retirement is PERMANENT and the read failure is not: _retireUnreadable finalizes the monitor and
  // closes the intent, so activeIntents() drops it and nothing re-arms it when the portal answers
  // again. The asymmetry is the whole argument for erring long - waiting costs a retrying timer,
  // giving up early costs a priced load we were armed to bid.
  unreadableRetireMs: 7_200_000,
  // While one durable-write fault lasts on a load, how long before the desk is told again. The
  // notifier drops an error alert it cannot deliver without marking it, so this is what gives a
  // dropped first alert another attempt.
  writeFailRealertMs: 600_000,
  // Ruling 59 (W1-1 V3-F01): INSIDE one writeFailRealertMs window, how often a persisting fault
  // re-offers the SAME episode rather than staying silent until the window ends. Closes the gap the
  // window alone leaves open: a fault dropped at delivery (the notifier's sender was down, or its
  // persistent mark failed to write) got no further attempt until the whole window passed, so a load
  // that closed inside the window never received a delivered write-fault alert at all. The re-offer
  // reuses the episode's original stamp, so the notifier's own dedupe mark - once it lands - silently
  // absorbs every offer after the one that is actually delivered; this never mints a second alert on
  // a fault the desk was already told about.
  writeFailReofferMs: 60_000,
  // How long ONE announced retirement speaks for the ones that follow it. The retirement itself is
  // per-load, but the cause is almost always one global thing, so without a global clock the message
  // count scales with loads in flight rather than with faults. Sized to the retirement bound because
  // that is the span over which one outage's loads reach their own retirement age.
  //
  // Deliberately NOT an operator knob and NOT an env var, same reasoning as authAlarmSuppressMaxMs:
  // anyone who could raise it from the console could re-open a fan-out with no code review.
  unreadableAnnounceWindowMs: 7_200_000,
  // --- anti-detection (capped at "plausible human") ---
  cadenceJitterMs: 250,  // random spread on the far/mid poll cadence (NOT the snipe window)
  openJitterMs: 0,       // random spread that fires the FIRST (establish) bid up to this much
                         //   EARLIER than openAtMs, so presence isn't established at a fixed
                         //   countdown mark. Hard-close only; one-sided-earlier so it can never
                         //   drift toward the floor snipe or the latency lead. Engine default 0
                         //   (deterministic); the product enables ~4s via config/Settings.
  maxBidsPerMin: 20,     // per-auction soft runaway guard (a real 3-bid auction never nears this)
  // How many times ONE price may go on the wire for one load once the platform has already refused
  // it. An EXPLICIT bound on repeating a refused price, and the reason it is explicit is that
  // maxBidsPerMin was the only brake and it is the wrong instrument: it gates on RATE, so a refusal
  // the platform will give forever simply spends 20 writes a minute for as long as the auction
  // lasts. Measured on 260908LD2Z, 42 identical refused submissions of 38,684 over 304 seconds
  // against a shared live vendor account. Counted per DISTINCT price and reset the moment a
  // different price is refused or any bid is accepted, so a normal ladder walk-down - every rung a
  // new price - never approaches it, and only a genuine wall does.
  refusedPriceAttempts: 3,
  // Slots of maxBidsPerMin that ORDINARY traffic may not touch, held for the decisive floor shot.
  // The cap's gate in _maybeBid returns before _decide, so without this the last write budget goes to
  // whichever path asks first - always the retry loop, never the one 2.5s shot that ends the auction.
  // 4 leaves ordinary traffic 16 per minute (a real auction places 3) and the decisive shot a budget
  // it cannot be argued out of.
  floorSnipeReservedSlots: 4,
  // --- FTL multi-vehicle count (BID MAX ALWAYS, see _multiVehiclePlan / _maybeBid) ---
  multiVehicleBid: true,         // DEFAULT ON. On any load with a usable count > 1 the engine bids
                                 //   the FULL required vehicle count at the per-vehicle amount
                                 //   (vcq = round(units)) - never fewer vehicles than the load's
                                 //   count. Set false (env SP_MULTI_VEHICLE_BID=0) as an OFF-SWITCH
                                 //   to disable multi-vehicle bidding entirely (hold-and-alert on
                                 //   every multi-vehicle load). See _multiVehiclePlan.
  failClosedUnknownBasis: false, // whether an armed load with >1 units but NO recorded quoteType is
                                 //   treated as multi-vehicle. server.js sets this true in REAL mode
                                 //   only. When true, an unknown-basis count reads as multi-vehicle
                                 //   and now BIDS MAX (vcq = round(units)) rather than holding - the
                                 //   tonnes-vs-trucks ambiguity is caught before pricing by the
                                 //   price-page vehicle-count confirmation (renderPriceForm). Mock/sim
                                 //   (units 1-3, no basis) stays lenient (single). Default false.
  // --- the never_bid_before_close suppression BACKSTOP (see _finalize) -------------------------
  // How long a live adapter auth-dead latch may keep the zero-bid alarm quiet. Past this bound the
  // alarm resumes EVEN WHILE THE LATCH IS STILL SET, so a latch that sticks (an adapter bug, a clear
  // path that never fires) degrades to the OLD noisy behaviour rather than to silence. Noise is
  // survivable; silence is the 2026-07-13 incident this alarm exists because of.
  //
  // Deliberately NOT an operator knob and NOT an env var: it is not read by configStore and is not
  // exposed through the Settings API, because anyone who could raise it from the console could
  // re-open the hole with no code review. 2h covers the measured 2026-08-04 outage (12:07 to the
  // 13:42 restart, ~95 minutes) with headroom.
  authAlarmSuppressMaxMs: 7_200_000,
};

// L3 soft-close / auction-extension strategy config. DEFAULT OFF (fail closed): with `enabled` false
// (the default) NO load ever runs the soft-close endgame, so every monitor stays byte-identical to the
// deployed Module-1 behaviour. A soft auction is a late-binding to the existing sniper (the extension
// cap makes it hard-close once extensions exhaust); the one new control point is suppressing the floor
// snipe until then. Overridden per deploy from config.js (env) and live-editable via setSoftClose.
const DEFAULT_SOFT = {
  enabled: false,           // master gate; OFF => soft-close endgame never engages (Module-1 behaviour)
  shippers: [],             // per-customer opt-in allowlist (shipper-name tokens); empty => nobody (opt-in, not blanket)
  mode: 'shadow',           // 'shadow' = observe + log would-have-done decisions, ZERO wire writes | 'live'
  reserve: 1,               // revisions ALWAYS held back for the final-window floor snipe (D5)
  jumpPerRival: 1,          // rank-driven step size: rungs stepped down per rival ahead (jump = (k-1) x this)
  establishLeadMs: 40_000,  // how far before the anti-snipe trigger window a soft load establishes (LM#5)
  // How many times the never-forfeit release (_lastResortFloor) may offer the reserved floor on ONE
  // load. An EXPLICIT bound, deliberately not "whatever maxBidsPerMin leaves over": the diagnosis
  // names leaning on that cap as the cause of the loss it was cited as the cure for, and a load
  // SuperProcure refuses every time would otherwise produce one refused write per hot poll (~12 in
  // the 2.5s last-chance window) on a shared live account. 3 is one shot plus two retries - enough
  // for a transient refusal to clear, far short of a stream.
  lastResortFloorAttempts: 3,
  // No trigger-window knob: the trigger window is a per-BRANCH fact read per-load off the live SP object
  // (branchAuctionRemainingTime), never an operator/config fallback - see config.js softClose note.
};

// Round-figure quoting (pricing.js roundLadderToGrid). Shaped like DEFAULT_SOFT and resolved the same
// way - master gate plus a per-shipper opt-in allowlist on word-boundary tokenMatch - so a shipper
// with no opt-in is provably unchanged and this can never become a blanket default.
const DEFAULT_ROUNDING = {
  enabled: false,  // master gate; OFF => no ladder is ever snapped
  shippers: [],    // opt-in allowlist; empty => nobody, even with the master gate on
  step: 100,       // the grid in rupees
};

/**
 * Coerce a configured step to the ONE meaning pricing.js already defines for it, so a value cannot
 * read as "no grid" at one layer and "the default grid" at another. A finite step at or below 1 is
 * an explicit request for NO grid and is honoured as null; only a genuinely unusable value
 * (non-numeric, NaN, fractional - which would put non-integer rupees on the wire) falls back, and it
 * falls back to `fallback` rather than to null because on an opted-in shipper silently NOT rounding
 * is the failure the desk would never see.
 */
function coerceRoundingStep(raw, fallback) {
  // Number(null) / Number('') / Number(false) / Number([]) are all 0, which would read as an explicit
  // "no grid" from a value that expresses no such intent. Only a real number or a non-blank string can
  // ask for one.
  if (raw === null || raw === undefined || typeof raw === 'boolean' || Array.isArray(raw)) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n <= 1) return null;                    // explicit "no grid"
  if (!Number.isInteger(n) || n < ROUNDING_STEP_MIN) return fallback;
  return Math.min(n, ROUNDING_STEP_MAX);
}

// Misconfig belt on the derived rung count - above the largest real platform bid cap (30), so it
// only stops a garbage feed value or a misconfigured SP_RUNG_CAP from building an absurd ladder.
const RUNG_RUNAWAY_MAX = 40;

// SHARED-ACCOUNT BID BUDGET (docs/diagnoses/2026-07-21_tata-bid-limit-rejection.md).
//
// SuperProcure's per-load revision cap (branchBidCountAllowed, commonly 3) is counted by the
// PLATFORM against the whole carrier account, not against this process. BRL humans bid MANUALLY on
// the same account the bot logs in as, so a slot the bot never spent can already be gone. SP exposes
// NO used-count and NO remaining-count anywhere (branchBidCount / bidCount / totalBids were null on
// all 339 open rows in the 2026-07-21 read-only probe; realAdapter.getAuctionState hardcodes
// revisionsLeft null), and the socket's `bids` frame is CURRENT STANDINGS - one active row per
// carrier - not a revision history, so its length cannot be used as a used-count either. The engine
// therefore cannot ever KNOW the true remaining budget. What follows are the two signals it does have.

// LOW_CAP_THRESHOLD - at or below this static cap there is no slack to absorb a slot a human already
// spent. 7 of 12 active customers sit at branchBidCountAllowed <= 3 (Tata, KEI, Cords Cable, Vishal
// Pipes, Safex, BG, Ashirvad), and the 3-rung ladder consumes a fresh 3-cap with ZERO reserve, so on
// those loads a single pre-consumed slot is the difference between reaching the floor and being
// refused at it. Above this, the cap (5/10/30) absorbs a foreign bid without changing what we can
// reach, so the discount is not applied and behaviour stays byte-identical to the deployed build.
const LOW_CAP_THRESHOLD = 3;

// How long a transport-thrown write is watched for on a portal that shows our own standing bid
// (SuperProcure publishes it about 1.15 s after a landed bid), and how often it is read meanwhile.
const OWN_BID_CONFIRM_MS = 1_500;
const OWN_BID_POLL_MS = 250;

// The bounded re-offer of the desk notice's ALL-CLEAR, matching realAdapter._maybeReRaiseDown in
// shape and in reasoning. desk_notice rides HEALTH_POLICY 'drop' (skip and discard, no retry), and
// this is the one message in the set whose absence costs money: a desk still hand-quoting after the
// bot is back double-counts against SuperProcure's shared per-load bid cap. So the emit is repeated
// on a cadence rather than latched after one attempt. It is a DELIVERY retry, not a second message -
// the dedupe key is identical, and notifier._markSent writes its permanent sent-mark only when a send
// actually reached somebody, so a delivered retraction dedupes every re-offer to nothing while a
// dropped one gets another chance. Bounded because the load closes on its own schedule and an
// unbounded offer would keep re-entering the notifier for the rest of the auction.
const AUTH_CLEARED_REOFFER_MS = 60_000;
const AUTH_CLEARED_MAX_OFFERS = 10;
// How many stopped-but-not-yet-re-armed retraction debts the carry map may hold - see stop().
const AUTH_NOTICE_CARRY_MAX = 200;

// THE ANTI-SNIPE INCREMENT WHEN THE PLATFORM PUBLISHES NONE.
//
// A MISSING extension increment and an increment of ZERO are different facts and must not resolve to
// the same behaviour. `extendMs: 0` is the platform saying this branch runs no anti-snipe rounds;
// `extendMs: null` is the platform not having said anything, and it is REACHABLE ON THE LIVE
// SUPERPROCURE PATH: realAdapter reads the increment off the cached REST metadata only
// (`meta.extendSeconds ? *1000 : null`) while it reads soft-close off the SOCKET's sticky
// AuctionExtended latch as well, so an empty loadMeta - a fresh Map after any restart, or a load SP
// has delisted from /sp/loads/v4 - yields closeModel 'soft' with no increment on an ok:true read.
// Reading that null as zero collapsed the soft settle window to the bare 3 s clock-skew guard and
// terminally retired live auctions with their reserved floor rung unspent.
//
// 180 s is MEASURED, not chosen: it is the same live 2026-07-25 Havells observation recorded in
// _observeExtension below - 4 of 4 soft auctions whose socket froze at closesInMs 0 closed 183.1 to
// 183.4 s later, i.e. one clean 180 s extension plus this engine's own 3 s finalize debounce. It is
// the honest answer to "how long can this platform run past a close it has stopped publishing", and
// it is used ONLY where the increment is absent. A published increment always wins, at any value.
const UNPUBLISHED_EXTEND_MS = 180_000;
// How long a frozen countdown's one close check may stay unanswered before T4's floor fallback runs.
const FROZEN_CHECK_TIMEOUT_MS = 5_000;
// A GoComet detail close this much later than the frozen close is a reopen.
const GC_REOPEN_MIN_MS = 30_000;

/**
 * The anti-snipe increment in ms for this tick's state, as a NUMBER, distinguishing the two cases the
 * raw field conflates. Finite and >= 0 is the platform's own answer and is returned untouched (so a
 * published 0 still means "no extension mechanic" and every published increment behaves exactly as
 * before). Anything else - null, undefined, NaN, a negative, a numeric STRING that `> 0` would have
 * silently coerced into string concatenation at the debounce - is "not published" and resolves to the
 * measured fallback rather than to zero.
 */
function extendIncrementMs(state) {
  const raw = state ? state.extendMs : null;
  return Number.isFinite(raw) && raw >= 0 ? raw : UNPUBLISHED_EXTEND_MS;
}

// The smallest close change that is a real move rather than countdown rounding.
function realCloseMoveMs(state) {
  return Number.isFinite(state.minCloseJumpMs) && state.minCloseJumpMs > 0 ? state.minCloseJumpMs : extendIncrementMs(state) / 2;
}

// Node's setTimeout ceiling. Above 2**31-1 ms (~24.86 days) the delay overflows a signed 32-bit int
// and the timer fires IMMEDIATELY instead of sleeping - it does not throw, it does not clamp, it
// just goes off. That matters here because boundedParse admits a start time up to 30 days out
// (MAX_PLAUSIBLE_DEADLINE_MS), so the 24.86-to-30-day band is reachable from real platform data.
const TIMER_MAX_MS = 2_147_483_647;

// Plausibility bound on an absolute close time the PLATFORM hands the engine: +/-30 days, the same
// span and the same doctrine both adapters already apply at their own parse boundary
// (realAdapter's boundedParse, gocometAdapter's _boundedParseMs). Restated here rather than
// imported from either, because the engine sits ABOVE the platform seam and has to hold this for an
// adapter that never ran those: getAuctionState's own JSDoc (adapter.js) does not even list
// closesAtMs, so omitting or nulling it is conforming behaviour.
const MAX_PLAUSIBLE_CLOSE_SKEW_MS = 30 * 86_400_000;

// An absolute close time the engine may ACT on, or null for "not known" - and "not known" is never
// a time. Finiteness alone decides nothing here, which is why this is not a bare Number.isFinite:
// Number(null) is a finite 0 that reads as a close on 1 Jan 1970 (a monitor armed at epoch, and
// that epoch persisted onto the durable intent), and SuperProcure's year-2100 placeholder is a
// perfectly valid number that reads as a 74-year runway the engine will never race against. Both
// have cost real bids. A caller handed null keeps the close it already had.
function plausibleCloseAt(raw, now) {
  const n = numericOrNull(raw);
  if (n == null) return null;
  if (n < now - MAX_PLAUSIBLE_CLOSE_SKEW_MS || n > now + MAX_PLAUSIBLE_CLOSE_SKEW_MS) return null;
  return n;
}

// The monitor's mirrors of the round tracker (ruling 56 (a)) after it counted or moved the close. A
// function rather than a method so the engine doubles that borrow _observeExtension need nothing new.
function mirrorRound(engine, monitor, res) {
  const t = monitor._round;
  const forward = monitor.believedCloseAt == null || t.closeAt > monitor.believedCloseAt;
  if (t.closeAt != null && (forward || res.kind === 'backward')) {
    monitor.believedCloseAt = t.closeAt;
    if (forward) engine._clearSubmissionClosedOnForwardMove(monitor, t.closeAt);
  }
  if (monitor.provisionalClose || monitor.softStrategy !== 'off') {
    monitor.extendsObserved = t.rounds;
    if (!monitor.provisionalClose && Number.isInteger(t.publishedCap)) monitor.extendCap = t.publishedCap;
    // A reschedule re-opens the once-per-round defend for the new window without spending a cap round.
    if (res.kind === 'reschedule' || res.kind === 'reschedule_in_war') {
      monitor._lastDefendAtExtend = null;
      engine.log.info('close moved outside a round; treated as a reschedule', { auctionId: monitor.auctionId,
        kind: res.kind, rounds: t.rounds, closeAt: t.closeAt });
    }
    for (const e of res.events) {
      if (e.type !== 'cap_exceeded' || monitor._capExceededAlerted) continue;
      monitor._capExceededAlerted = true;
      engine.emit({ type: 'alert', level: 'warn', kind: 'extend_cap_exceeded', auctionId: monitor.auctionId,
        extendsObserved: e.rounds, cap: e.cap, lane: monitor.meta.lane, companyName: monitor.meta.companyName });
    }
    if (res.counted > 0 && !monitor.provisionalClose) {
      engine.emit({ type: 'extension_observed', auctionId: monitor.auctionId,
        extendsObserved: monitor.extendsObserved, extendCap: monitor.extendCap,
        believedCloseAt: monitor.believedCloseAt, lane: monitor.meta.lane, companyName: monitor.meta.companyName });
    }
  }
}

// The close a load was posted with, written onto the durable intent at its FIRST persistence only and
// never re-derived. _persistRound advances `closesAt`, so after an extension it cannot be read
// back from there. The source is the price request's snapshot close when that is earlier than the
// armed close. An intent persisted before this field existed stays without one - an unknown posted
// close, not a wrong one - except on a provisional-close load, whose round count needs a value and
// takes the earliest close still on record.
function postedCloseFor(prior, meta, provisional) {
  if (prior && numericOrNull(prior.postedCloseAt) != null) return {};
  if (!prior) return { postedCloseAt: plausibleCloseAt(numericOrNull(meta.postedCloseAt) ?? meta.closesAt, Date.now()) };
  if (!provisional) return {};
  const earliest = [numericOrNull(prior.closesAt), numericOrNull(meta.closesAt)].filter((v) => v != null && v > 0);
  return { postedCloseAt: numericOrNull(meta.postedCloseAt) ?? (earliest.length ? Math.min(...earliest) : null) };
}

// Our last landed bid as fixed at landing, for the durable intent. A rank 1 seen after the landing
// belongs to the process that saw it, so a restored record does not carry it unless the landing
// itself said so. shotRoundId is set only when the landing was its round's one shot.
function durableLastLanded(l) {
  return { closeAt: l.closeAt, extendsObserved: l.extendsObserved, roundId: l.roundId, shotRoundId: l.shotRoundId,
    landingMs: l.landingMs, triggerWindowMs: l.triggerWindowMs, incrementMs: l.incrementMs,
    countdownMs: l.countdownMs, heldRank1: l.heldRank1 };
}

// A record without a plausible close is no record: it cannot say which close our bid was measured against.
function restoredLastLanded(prior) {
  const l = prior && prior.lastLanded;
  const closeAt = l && typeof l === 'object' ? plausibleCloseAt(l.closeAt, Date.now()) : null;
  if (closeAt == null) return null;
  const roundId = (key) => (typeof l[key] === 'string' ? l[key] : null);
  return { closeAt, extendsObserved: numericOrNull(l.extendsObserved), roundId: roundId('roundId'),
    shotRoundId: roundId('shotRoundId'), landingMs: numericOrNull(l.landingMs),
    triggerWindowMs: numericOrNull(l.triggerWindowMs), incrementMs: numericOrNull(l.incrementMs),
    countdownMs: numericOrNull(l.countdownMs), heldRank1: l.heldRank1 === true ? true : null };
}

// A load's round policy as the engine and the durable intent hold it, or null for "not set" (the
// default cap applies). finalAfterExtensions null is a real value - an uncapped plant - and is kept.
function normaliseRoundPolicy(rp) {
  if (!rp || typeof rp !== 'object' || !('finalAfterExtensions' in rp)) return null;
  const c = rp.finalAfterExtensions;
  if (c !== null && !(Number.isInteger(c) && c >= 0)) return null;
  return typeof rp.source === 'string' ? { finalAfterExtensions: c, source: rp.source } : { finalAfterExtensions: c };
}

// The platform's cap refusal, verbatim from the live incident: HTTP 400 with the PLAINTEXT body
// `Bid limit exceeded` (no JSON, no machine code, no header - the whole payload is those three
// words). Matched deliberately NARROWLY - word-order-exact, whitespace-tolerant, case-insensitive -
// rather than by any looser "limit"/"exceeded" heuristic, because the consequence of a match is
// TERMINAL for the load's budget: we stop spending rungs on live money. A false positive silently
// costs an auction, so this must never catch a neighbouring refusal such as the observed
// "Load is under approval for allotment. Bidding is not allowed." Both the parsed `reason` and the
// raw body/text are searched because realAdapter surfaces the same plaintext on several fields
// depending on whether the body parsed as JSON.
const BID_CAP_REJECTION_RE = /bid\s+limit\s+exceeded/i;

// The platform's "this load is not biddable" refusal, verbatim from the live records: HTTP 400 with
// the PLAINTEXT body `Load not available for bidding`. Matched with the same deliberate NARROWNESS
// as the cap refusal above, and for the mirror-image reason: a match here STOPS this load for good,
// so a false positive silently forfeits a winnable auction. It must never catch the neighbouring
// refusals SuperProcure has its own distinct strings for - "Auction has already ended for this
// load", "Load is under approval for allotment. Bidding is not allowed.", "Amount is invalid...",
// "Amount is greater than ceiling price" - every one of which is a different decision.
const LOAD_NOT_BIDDABLE_RE = /load\s+not\s+available\s+for\s+bidding/i;

// The platform's QUANTITY refusal, verbatim from the live records: HTTP 400 with the PLAINTEXT body
// `Quote quantity is greater than total quantity`. Matched with the same deliberate NARROWNESS as
// the two above - a match here stands the load down at the count it sent, so a false positive
// forfeits a winnable auction. Anchored on the distinctive "quote quantity ... total quantity"
// pairing rather than the bare word "quantity", which appears in unrelated SuperProcure refusals
// (the PMT `PMT_QUANTITY` path among them) that are NOT terminal and must keep their retry behaviour.
const QUANTITY_REFUSED_RE = /quote\s+quantity\s+is\s+greater\s+than\s+total\s+quantity/i;

// GoComet's UPWARD-REVISION refusal, verbatim from the live records: HTTP 422 carrying
// `You've increased the quote price. Please add a remark explaining the change to continue` - 141
// refusals over 9 loads. Anchored on the four-word phrase rather than the whole sentence for two
// reasons that both cut toward reliability, not looseness: the apostrophe in "You've" is a straight
// or a typographic quote depending on the encoder, and the remark clause is the portal's suggested
// remedy - the half most likely to be reworded. Neither portal uses this phrase for anything else.
const RAISE_REFUSED_RE = /increased\s+the\s+quote\s+price/i;

// SuperProcure's MONOTONICITY refusal AND THE CAP IT CARRIES, verbatim from the live records: HTTP
// 400 with the PLAINTEXT body `Amount is invalid. Amount should be less than or equal to 51650` -
// 1,459 occurrences over 282 loads. On the affected loads that number is our OWN standing bid minus
// the branch's minimum decrement, which makes this SuperProcure's form of the same verdict GoComet
// spells out in words: the price may not be raised.
//
// The number is CAPTURED, not merely matched, and that capture is the whole reason this refusal does
// not get a blanket latch. It is genuinely retryable whenever the ladder still holds a rung at or
// below the cap - measured over the 2026-08-02 box snapshot, 14 of 140 such refusals were exactly
// that, and those loads went on to land a bid by walking down. Only where the FLOOR rung sits ABOVE
// the cap can no rung the engine still owns ever be accepted. See raiseRefusal().
// Digit GROUPS, not `(\d+)`, and the separators are stripped before the parse. Every cap in the
// corpus is a bare integer, so this is unobserved rather than fixed - but `(\d+)` against a
// hypothetical `equal to 51,650` captures `51`, which is finite, passes the guard, and reads as a cap
// below every floor there is. That silently latches the whole class. A bad READ of the number must
// not be able to look like a valid verdict.
const AMOUNT_CAP_RE = /amount\s+should\s+be\s+less\s+than\s+or\s+equal\s+to\s+([\d,]+)/i;

// The two ways a portal says THE SUBMISSION WINDOW IS OVER. SuperProcure, verbatim:
// `Auction has already ended for this load` - 5,276 refused writes over 120 loads. GoComet, verbatim:
// `Validation failed: Cannot Submit Quote either the enquiry is closed or you have reached maximum
// revision limit` - 2,304 refusals over 57 loads and rising. Word-order-exact on both, the same
// narrowness the three classifiers above are held to.
//
// THE GOCOMET STRING CONFLATES TWO CONDITIONS AND CANNOT SEPARATE THEM. Nothing here tries to: the
// only conclusion drawn is the one both readings support - no further submission on this load can be
// accepted, so stop sending. What is deliberately NOT concluded is anything the ambiguity would make
// unsound. The revision budget is not zeroed (if it was the closed-enquiry reading, the budget is
// intact and zeroing it hands a later re-price a phantom exhausted load), and the load is not
// declared closed for finalize purposes (that stays the platform countdown's job).
const SUBMISSION_CLOSED_RE = /auction\s+has\s+already\s+ended\s+for\s+this\s+load|cannot\s+submit\s+quote\s+either\s+the\s+enquiry\s+is\s+closed/i;

// The pre-wire refusals worth retrying: a throttle, a quote read that never landed, came back
// body-less or came back as a server error or unreadable body, and a quote another writer moved
// between our two reads. Every other code marked placed:false - and any throw with no code - is
// raised against the armed load or the quote as it stands, so it would be raised again on every
// attempt; that load is stood down and handed to the desk instead.
const PREWIRE_RETRY_CODES = new Set(['RATE_LIMITED', 'NETWORK', 'NO_BODY', 'QUOTE_READ_FAILED', 'QUOTE_CHANGED']);

// Every classifier scans the SAME fields through this ONE point, factored out so no two can drift
// apart on which fields they look at - a classifier that reads `reason` but not `text` would silently
// mis-class every rejection whose body did not parse.
//
// WHICH FIELDS ACTUALLY CARRY ANYTHING, stated precisely because an earlier version of this comment
// claimed "four fields" and was wrong. realAdapter.placeBid returns `reason`, `text` and `raw` and no
// `body` at all (realAdapter.js, the placeBid return): `reason` prefers SP's JSON message and falls
// back to the raw plaintext, `text` is always the raw body, `raw` is the parsed JSON when there was
// one and the text otherwise. `res.body` is scanned defensively for mock/sim/GoComet adapters that
// may shape a rejection differently - it is dead against the real adapter, and describing it as one
// of four fields the platform populates was a phantom.
// How many folded load ids one rolled-up retirement message may name. The desk needs the ids to act
// on the instruction the alert gives it ("check the portal"), but one outage can strand dozens and
// this line goes to WhatsApp - past the cap the count still states the total.
const UNREADABLE_FOLDED_ID_CAP = 10;

// Consecutive ticks that may throw past their own handlers before the load is handed to the desk.
const TICK_FAULT_HANDOFF_AT = 3;

/** "A, B and 3 more" - the folded loads, named, from a capped id list plus the true total. */
function foldedIdList(ids, count) {
  const rest = count - ids.length;
  return rest > 0 ? `${ids.join(', ')} and ${rest} more` : ids.join(', ');
}

function rejectionMatch(res, re) {
  if (!res) return null;
  // A SERVER FAULT IS NOT A VERDICT. Guarded here, once, so every classifier built on this scan -
  // cap, load-not-biddable, quantity, raise, submission-closed - declines a >=500 envelope instead
  // of each needing its own copy of the same check. A portal 5xx can carry an application body that
  // happens to match a classifier's wording; that is a transport fault, not the platform ruling.
  if (Number.isFinite(res.status) && res.status >= 500) return null;
  for (const field of [res.reason, res.text, res.body, res.raw]) {
    if (typeof field === 'string') {
      const m = re.exec(field);
      if (m) return m;
    }
  }
  return null;
}

function rejectionSays(res, re) {
  return rejectionMatch(res, re) != null;
}

function isBidCapRejection(res) {
  return rejectionSays(res, BID_CAP_REJECTION_RE);
}

/**
 * The standing price after a write we are treating as ON THE BOARD, given what the intent already
 * holds. LOWEST WINS, on every writer of landedBidPrice rather than only the retired-monitor one.
 *
 * The ladder descends and each landed bid replaces the last, so a write that resolves out of send
 * order must never raise the durable price back above what the board really holds. It would put
 * _mustImproveOn above the real board, the engine would re-offer over its own live bid, and every
 * rung between the two is refused - the 260908LD2Z loop, re-entered through the field added to end
 * it. One expression, three call sites, so they cannot drift apart again.
 */
function lowestStandingPrice(priorPrice, price) {
  const prior = Number(priorPrice);
  return (Number.isFinite(prior) && prior > 0) ? Math.min(prior, price) : price;
}

/**
 * Is this refusal the PER-LOAD STATE one - SuperProcure saying this load is not biddable at all?
 *
 * This is a property of the LOAD, not of our price, our timing, our session or our account, and the
 * forensic evidence for that is a natural controlled pair: two Borosil loads inside the identical
 * 12:06-12:21 IST window on 2026-07-25, same account, same carrier registration, same session, same
 * connection - 23484018 refused at 12:20:36.096, 23484099 ACCEPTED at 12:20:57.816, 88 ms later.
 * Everything but the load id held constant.
 *
 * It is also PERSISTENT, which is what makes the response a stand-down rather than a retry. Across
 * every bid log on the box there are 19 refusal records over 14 distinct loads (831 loads took a bid
 * attempt, so 1.7%), and every one of the 14 has `ourBids: []` and `landedBids: 0` - not one ever
 * landed a bid at any point, and retries 24 s and 3 min apart were refused alike. Cross-joining the
 * rank_sample stream against closedBids.json sharpens it further: of the 28 loads whose max
 * totalBidders stayed 0 over their whole monitored life, 13/13 were refused; of the 624 loads with
 * >= 1 bidder, 0 were refused. No bid from anyone - ours or a rival's - ever reached the live
 * auction feed on these loads, and none ever extended. It is ongoing, not historical: load 23718407
 * took two refusals at 12:03 IST on 2026-08-01.
 *
 * So a retry cannot win the load, and the only thing it can still do is put ~23 refused writes on a
 * shared LIVE account instead of 1.
 */
function isLoadNotBiddableRejection(res) {
  return rejectionSays(res, LOAD_NOT_BIDDABLE_RE);
}

/**
 * Is this refusal the QUANTITY one - SuperProcure saying the vehicle count we quoted exceeds the
 * load's own total? Verbatim from the live records: HTTP 400, PLAINTEXT body
 * `Quote quantity is greater than total quantity`.
 *
 * A property of the QUANTITY, not of our price, and that distinction is the whole point. Until this
 * classifier existed the string fell through to the default PRICE/STATE class - "this PRICE was
 * refused, walk the ladder down and retry" - so the engine answered a quantity verdict by conceding
 * margin it never needed to concede, and did it over and over against a wall.
 *
 * PRICE-INDEPENDENT, and measured rather than assumed: the identical body came back at every rung of
 * a full ladder walk on one load, then eight more times on the re-fired floor rung. A retry at the
 * SAME count cannot win the load; all it can add is refused writes on a shared live account.
 *
 * It is NOT count-independent. SuperProcure range-checks the count we send - it could not produce
 * this error otherwise - and on FTL it stores the count we sent rather than deriving one from the
 * load. So the verdict binds the COUNT, not the load, and a strictly lower count is a quote SP has
 * not ruled on: see monitor.quantityRefusedAtVcq for the one attempt it earns.
 */
function isQuantityRefusedRejection(res) {
  return rejectionSays(res, QUANTITY_REFUSED_RE);
}

/**
 * Is this refusal the one the engine has no answer to - the portal saying our price MAY NOT BE
 * RAISED - and if so, what cap did it name?
 *
 * A property of the DIRECTION of the revision, not of the price being too high, and that is the
 * distinction the whole classifier exists for. Until it existed both portals' strings fell to the
 * default PRICE/STATE class - "this PRICE was refused, walk the ladder down and retry" - which is
 * the one response that cannot help: a reverse auction refuses an upward revision because a bid of
 * ours is ALREADY STANDING, lower, and lowering further only concedes margin the auction never
 * asked for. Measured on 260908LD2Z: 41,420 -> 40,736 -> 38,684 against a refusal that meant "you
 * may not raise".
 *
 * TWO PORTALS, TWO SHAPES, and the two are settled by different evidence - a number on SuperProcure,
 * the platform's own words on GoComet. Neither is a bare string match standing in for a judgement.
 *
 *   SuperProcure states the verdict as a numeric cap, and that cap is the test. The refusal fires
 *   routinely and harmlessly whenever a rung lands inside the branch's minimum decrement of our own
 *   last bid, and the walk-down is then the correct and productive response. So the verdict binds
 *   the LADDER, not the load: only where the FLOOR - the lowest price this load is allowed to offer
 *   at all - is still above the cap can no rung ever be accepted. Where a rung at or below the cap
 *   remains, this returns null and today's ladder walk is untouched. Measured over the 2026-08-02
 *   box snapshot: 126 of 140 such refusals named a cap below the load's own floor, and the other 14
 *   went on to land a bid by walking down.
 *
 *   WHAT THE SP CAP IS is not always our own standing bid, and the test deliberately does not care.
 *   On the affected loads it was (standing minus the branch decrement), but BRL's own records carry
 *   the same wording for a shipper CEILING too. The engine has a separate, earlier class for that
 *   cause (ceiling_below_floor), so a ceiling that reaches here is mislabelled - and the ACTION is
 *   identical either way, because both readings say the same thing: no price this ladder may offer
 *   is acceptable, so stop offering. The cap rides the record and the alert precisely so a human can
 *   tell which it was; nothing here infers it.
 *
 *   GoComet spells the verdict out in words ("You've increased the quote price") and names no
 *   ceiling, so there is no number to test against - and none is needed, because THE STRING IS THE
 *   EVIDENCE. GoComet emits it only when a quote already stands on this vendor identity below what
 *   we just sent. Its write is a fetch-mutate-PUT of one whole quote document the adapter's own
 *   contract note calls "shared with another writer on this same vendor identity", so that standing
 *   number is BRL's money whoever typed it - this engine, BRL's autopilot, or a person at the desk.
 *   Owner ruling 26 Sep (260925SQRC): the caller answers it BELOW that standing quote while a band
 *   price below it remains (_continueBelowStanding), and stands down only when none does.
 *
 *   THIS DELIBERATELY DOES NOT CONSULT landedBids OR foreignBidsDetected, and that is a correction,
 *   not an oversight. Both were tried. `landedBids` counts what THIS PROCESS landed and so misses a
 *   hand quote entirely; `foreignBidsDetected` is structurally a PRE-FIRST-WRITE inference
 *   (disqualified by ownBidAttempts/everBid, both set on an ATTEMPT rather than a landing), so it
 *   can never become true for a quote placed AFTER the bot's first write. Predicating on either made
 *   the engine treat its own five-condition inference as stronger evidence than the platform
 *   asserting the fact directly, and measured six lower prices going out under a standing BRL desk
 *   quote. The platform's own statement outranks any inference the engine can make about it.
 *
 * A cap that cannot be read as a finite number, or a floor the caller cannot supply, returns null -
 * fail toward the existing retry behaviour, so a vendor rewording can never silently latch loads.
 *
 * @param {object} res the platform rejection envelope
 * @param {number} floorPrice the lowest rung on this load's ladder
 * @returns {null|{cap: number|null}} null to leave the refusal in the price/state class
 */
function raiseRefusal(res, floorPrice) {
  if (rejectionSays(res, RAISE_REFUSED_RE)) return { cap: null };
  const m = rejectionMatch(res, AMOUNT_CAP_RE);
  if (!m) return null;
  // DIGITS, RE-TESTED after the separators come out, because Number('') is 0 and 0 is finite. The
  // character class that admits thousands separators also admits a capture of nothing but separators,
  // and that strips to the empty string, parses to a cap of ZERO, passes a bare isFinite, and sits
  // below every floor there is - latching the terminal class off a number the platform never sent.
  // The finite check alone cannot catch it; only re-asserting the shape can.
  const digits = String(m[1]).replace(/,/g, '');
  if (!/^\d+$/.test(digits)) return null;
  const cap = Number(digits);
  if (!Number.isFinite(cap) || !Number.isFinite(floorPrice)) return null;
  if (floorPrice <= cap) return null; // a rung the engine still owns can still be accepted
  return { cap };
}

/**
 * Is this refusal the portal stating that THE SUBMISSION WINDOW IS OVER - the auction has ended, or
 * (GoComet, inseparably) the enquiry is closed or the revision limit is spent?
 *
 * Terminal for submission and for nothing else. Both readings of the ambiguous GoComet string agree
 * that no further write on this load can be accepted, which is the only claim made from it; see
 * SUBMISSION_CLOSED_RE for what is deliberately not inferred. The measured cost of having no class
 * for it is 5,276 refused SuperProcure writes across 120 loads plus 2,304 GoComet ones across 57,
 * every one of them on a shared live vendor account, at roughly 45 per load rather than the 1 it
 * takes to learn the answer.
 */
function isSubmissionClosedRejection(res) {
  return rejectionSays(res, SUBMISSION_CLOSED_RE);
}

/**
 * Is this refusal the ACCOUNT-WIDE one - SuperProcure has ended our login's session, so nothing we
 * send on this account can be accepted at all?
 *
 * Keyed on the HTTP STATUS, never on the body. On 2026-08-04 at 12:07 IST SuperProcure revoked
 * BRL's sessions and answered every write `401 Token is invalid.`; the engine had no class for it,
 * read each 401 as a price refusal, and walked the ladder to the floor against a wall - 88 attempts
 * on one load, 360 across ten in 38 minutes, zero landed. "Token is invalid." is a string
 * SuperProcure can reword at will; 401 is the contract. Matching on prose here would put the whole
 * fix one vendor copy-edit away from silently reverting to the incident.
 *
 * 403 is included alongside 401 because SuperProcure has never been observed distinguishing a
 * REVOKED session from a FORBIDDEN one on this endpoint, and the response to both is identical: we
 * cannot bid on this account right now, so hold everything and let a human sign it back in.
 *
 * Written as a plain two-field status read, and it must stay that way. The rejection classifiers
 * above scan a literal field list, and scripts/test-rejection-classify-contract.js greps the FIRST
 * `for (const field of [...])` in this file and asserts it is exactly rejectionSays' four fields -
 * so a second field loop introduced above rejectionSays breaks that contract. This classifier reads
 * one number and needs no loop.
 *
 * The class is TRANSIENT and ACCOUNT-scoped, which is what separates it from the two terminal
 * per-load classes below it. Nothing about the load is wrong and nothing about the price is wrong:
 * the write never reached the auction. So the ladder, the endgame latches and the per-load budget
 * must all survive completely intact, and bidding resumes by itself the moment the session is back.
 */
function isAuthRejection(res) {
  return !!res && (res.status === 401 || res.status === 403);
}

/**
 * Does ANY classifier above have a name for this refusal?
 *
 * The question is deliberately coarser than "which class is it", and its answer is deliberately
 * NARROW in consequence: it chooses which of two reasons a refused-price stand-down records, and
 * whether that stand-down pages ops. It does NOT change how many attempts a price gets - only five
 * refusals carry a named regex, so most of the ordinary price/state population answers false here,
 * and letting that shorten a retry would cut the walk-down on the loads the record shows winning.
 *
 * `AMOUNT_CAP_RE` is tested RAW here rather than through raiseRefusal, and the difference matters.
 * raiseRefusal answers "is this terminal", which depends on the load's floor; recognition answers
 * "have we seen this wording", which does not. A cap that leaves a rung reachable is the healthy
 * walk-down (14 of 140 in the 2026-08-02 snapshot) and is emphatically recognised - reading it as
 * unrecognised would retire the one class that must keep retrying.
 *
 * A 5xx never reaches this question: server faults are excluded from the refused-price run at the
 * call site, because a transport hiccup is not the platform stating anything at all.
 *
 * Reuses rejectionSays rather than scanning fields itself, so the single field list above stays the
 * only one in this file - scripts/test-rejection-classify-contract.js greps for exactly that.
 */
function isRecognisedRefusal(res) {
  if (isAuthRejection(res)) return true;
  for (const re of [BID_CAP_REJECTION_RE, LOAD_NOT_BIDDABLE_RE, QUANTITY_REFUSED_RE,
    RAISE_REFUSED_RE, AMOUNT_CAP_RE, SUBMISSION_CLOSED_RE]) {
    if (rejectionSays(res, re)) return true;
  }
  return false;
}

// The two reasons _recordRefusal lets a later, DIFFERENT reason overwrite. Both are written at the
// refused-price hold as the two arms of one ternary, and both are deliberately-weak placeholders
// rather than terminal findings - see _recordRefusal for the full precedence argument. Named here
// rather than inlined so the set is one list, and so a third placeholder cannot be added to the
// hold without landing in the reader's eye here too.
const REPLACEABLE_PLACEHOLDER_REASONS = new Set(['refused_price_bound', 'refusal_unrecognised']);

// The refusal reasons that stay on the outcome even when a bid of OURS already landed.
//
// _finalize otherwise nulls the whole refusal whenever landedBids > 0, on the sound argument that a
// fought loss must never carry a stale reason. These three break that argument, and price_raise_refused
// breaks it by DEFINITION: it fires only when a standing quote is what the portal is refusing to let
// us raise above, which is landedBids > 0 exactly. The hold's two placeholders reach the same state
// whenever the ladder landed an early rung and a later price walled. On all three the desk is left
// believing a corrected rate went in while the board holds the older, lower one - so the fact has to
// survive the gate and let the template layer decide, which is what lostHeldClause does.
//
// bid_cap_exhausted is deliberately NOT here: a landed close whose budget then ran out is an ordinary
// loss, and the plain LOST receipt already says the true thing about it.
const REASONS_SURVIVING_A_LANDED_BID = new Set([
  'price_raise_refused', 'refused_price_bound', 'refusal_unrecognised']);

// Re-price safety. firedRungs are INDICES into a ladder. When an operator re-prices a load the bot
// is already armed on, the ladder is rebuilt from the NEW band and may have different prices / fewer
// rungs; re-applying the old indices verbatim can let a stale index collide with the new ladder's
// floor index and gate off the final-snipe rung (the bot goes dark on a live auction). Remap by
// PRICE instead: a fired rung means we already bid that exact (integer) price, so carry it forward
// only where the new ladder still has that price. An UNCHANGED ladder (restart/rehydrate re-arm, not
// a re-price) is preserved index-for-index, so restart safety and duplicate-price ladders are untouched.
function remapFiredRungs(prior, newLadder) {
  if (!prior || !Array.isArray(prior.firedRungs) || !prior.firedRungs.length) return [];
  const oldLadder = Array.isArray(prior.ladder) ? prior.ladder : null;
  if (oldLadder && oldLadder.length === newLadder.length && oldLadder.every((p, i) => p === newLadder[i])) {
    return prior.firedRungs.slice(); // same ladder -> exact index-for-index carryover
  }
  if (!oldLadder) return prior.firedRungs.filter((i) => i >= 0 && i < newLadder.length); // no old ladder to map: clamp into bounds
  const out = new Set();
  for (const i of prior.firedRungs) {
    const price = oldLadder[i];
    if (price == null) continue;
    const j = newLadder.indexOf(price); // integer prices -> exact match
    if (j >= 0) out.add(j);
  }
  return [...out].sort((a, b) => a - b);
}

// A durable record that shows something of ours reached the wire.
function carriesSpend(it) {
  return it.everBid === true || Number(it.landedBids) > 0 || (Array.isArray(it.firedRungs) && it.firedRungs.length > 0);
}

// A rate-model plan carries no guard: its floor IS the guard, so no price exists between the two.
function ceilingClearsGuard(capAt, plan) {
  return Number.isFinite(plan.guard) && capAt >= plan.guard;
}

// T4 D1: lowering the opening onto the cap narrows its first step, which can put a price the portal
// refuses on the armed ladder. Re-spaced only when the cap changed the ladder, so a ceiling above the
// opening plans exactly as no ceiling. On a round-figure shipper the gap is taken in whole grid steps,
// which keeps every moved price on the grid.
function capAndRespace(plan, capAt) {
  const capped = capLadderToCeiling(plan.ladder, capAt);
  if (String(capped) === String(plan.ladder)) return capped;
  const step = plan.roundStepApplied;
  const min = plan.spacingMinDecrement;
  const spacing = (step && Number.isFinite(min) && min > 0) ? Math.ceil(min / step) * step : min;
  return deriveSpacedLadder({ ladder: capped, floor: plan.floor, minDecrement: spacing }).ladder;
}

/**
 * BidEngine — runs one self-rescheduling monitor per armed auction.
 *
 * Core principles (from the research + the cloned eBay-sniper lineage):
 *  - Fire off the platform's OWN countdown (state.closesInMs), latency-compensated
 *    by half the measured RTT. Never the local wall clock. This is the single most
 *    important correctness property and dissolves clock-skew entirely.
 *  - Adaptive cadence: cheap far out, 200ms in the snipe window.
 *  - Hold L1 silently; only spend margin (step down the ladder) when actually
 *    outranked. Reserve the floor rung for the final seconds.
 *  - Hard floor invariant: a bid below costFloor can never be built.
 *  - Idempotent: each rung fires once; an in-flight bid blocks a second; on a
 *    failed/uncertain submit, read rank back before deciding again.
 *  - Soft close aware: timing is always relative to the live countdown, so an
 *    anti-snipe extension simply makes us hold — we don't waste the floor early.
 */
class BidEngine {
  constructor(adapter, scheduler, opts = {}) {
    this.adapter = adapter;
    this.scheduler = scheduler;
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.onEvent = opts.onEvent || (() => {});
    // A2 (capture-only): a DEDICATED per-tick rank/density telemetry sink, separate from onEvent on
    // purpose. onEvent goes through emit(), which pushes to the 500-cap dashboard ring AND fans out
    // to the WhatsApp notifier - a one-per-tick (200ms in the snipe window) sample would flush the
    // operator's event ring and flood the notifier. onSample carries only {auctionId, myRank,
    // totalBidders, closesInMs, ts} straight to the append-only bids jsonl. Default no-op, so any
    // path (tests, sim) that does not wire it stays byte-identical.
    this.onSample = opts.onSample || (() => {});
    // Operational logger, threaded the same opts-based way as onEvent/rand below: a
    // caller (or a test) can inject a scoped logger, and every real deployment gets the
    // module-scoped default without server.js needing to wire anything explicitly.
    this.log = opts.log || createLogger('bidEngine');
    this.monitors = new Map();        // auctionId -> monitor (actively bidding)
    // D012: consecutive closes on this account with zero landed bids and no explained reason -
    // see noLandingReport. One engine per stack/account (see the auth-suppression note in
    // _finalize), so this counter is already account-scoped without an explicit key.
    this._silentNoBidStreak = 0;
    // Review correction (26 Sep): noLandingReport's own one-shot latch for the CURRENT streak - set
    // the moment it is reported, cleared only when the streak itself resets (see _finalize). Without
    // it, a wedged-but-otherwise-idle account (nothing armed, nothing closing) re-reported the SAME
    // streak on every tick forever - 13 alerts across one 12-hour idle overnight in the review's repro.
    this._silentNoBidStreakAlerted = false;
    this._silentNoBidStreakStart = null;
    this.scheduledTimers = new Map(); // auctionId -> wake timer (pre-start, not yet armed)
    // auctionId -> Map(fire token -> price) for every write on the wire right now. Engine-scoped, not
    // monitor-scoped, so a predecessor's write started before a stop() and a successor's write started
    // after it are both visible to each other's raise-refusal check (W1-7 F1). Set at the fire point,
    // cleared in that same fire's finally - see _addInFlightPrice / _removeInFlightPrice.
    this._inFlightPrices = new Map();
    // auctionId of every load held on an unknown close. In memory, not on the intent: each restore
    // door re-decides the hold, and a durable mark could fail to write or outlive the decision.
    this.closeUnknownHeld = new Set();
    // auctionId -> the desk-notice retraction debt of a monitor stop() is about to delete. IN MEMORY
    // on purpose, never on the durable intent: a restart that restored it would retract on the first
    // tick of a process that has not yet latched a still-dead token, telling the desk the login is
    // back while it is down. Written by stop(), consumed and cleared by arm(), and bounded at stop()
    // because a load stopped and never re-armed is never consumed by anyone.
    //
    // THAT REASONING ONLY COVERS A RESTART WHILE THE ACCOUNT IS STILL DEAD, which self-heals: the new
    // process re-arms, latches, and re-notifies under its own episode. A restart AFTER recovery is a
    // real hole and is accepted rather than closed - the debt dies with the process, nothing
    // re-notifies and nothing retracts, so the desk keeps an instruction nobody will withdraw. The
    // project deploys by restarting pm2, so it is reachable; closing it needs a durable store that can
    // distinguish the two, which this Map deliberately is not.
    this._authNoticeCarry = new Map();
    this.events = [];          // ring buffer for the dashboard
    // The unreadable-retirement announcement clock, per engine and NOT per auction - see
    // _retireUnreadable. `_unreadableFolded` is the count retired quietly since the last message; it
    // rides the next one rather than being dropped.
    this._unreadableAnnouncedAt = null;
    this._unreadableFolded = 0;
    this._unreadableFoldedIds = [];
    this._unreadableFlushTimer = null;
    this.caps = adapter.capabilities();

    // --- kill-switch (gap A3) ---
    // The engine ALWAYS places real bids: it runs the full decision loop against
    // real live state (rank/countdown from the socket) and calls placeBid. The
    // adapter's own writeEnabled is a second, independent backstop, lifted here so
    // the placeBid write path is open (kill lowers it again).
    if (adapter && 'writeEnabled' in adapter) adapter.writeEnabled = true;
    this.killed = false;
    this.killReason = null;
    this._rand = opts.rand || Math.random; // injectable so timing jitter is testable
    // L3 soft-close config: default OFF (fail closed). server.js passes config.softClose; setSoftClose
    // applies a live Settings save. When disabled (default), _resolveSoftStrategy returns 'off' for
    // every load and the soft-close endgame is never entered.
    this.softCfg = Object.assign({}, DEFAULT_SOFT, opts.softClose || {});
    // Boot-path parity with setSoftClose's per-field guards: config.js coerces env with Number(), so
    // a malformed env (SP_SOFT_ESTABLISH_LEAD_MS='abc') lands NaN here, and a NaN establishLeadMs /
    // reserve silently disables establish or defend on an allowlisted soft load with no error anywhere.
    for (const key of ['reserve', 'jumpPerRival', 'establishLeadMs', 'lastResortFloorAttempts']) {
      const v = Number(this.softCfg[key]);
      this.softCfg[key] = Number.isFinite(v) ? v : DEFAULT_SOFT[key];
    }
    // Same boot-path coercion as softCfg above, and for the same reason: config.js passes env through
    // Number() unvalidated, so without this a typo reaches the snapper on live money.
    this.roundCfg = Object.assign({}, DEFAULT_ROUNDING, opts.rounding || {});
    this.roundCfg.step = coerceRoundingStep(this.roundCfg.step, DEFAULT_ROUNDING.step);
    // T9 walk, per platform, off unless switched on; the measured step times arrive by setWalkTiming.
    this.walkCfg = walkMath.normaliseWalk(opts.walk);
    this.walkTiming = null;
  }

  /** A live Settings save of the walk block; read at every decision, so the next tick uses it. */
  setWalk(walk) {
    this.walkCfg = walkMath.normaliseWalk(walk);
  }

  /** The measured step and landing times ({ sp, gocomet } summaries), or null to use the manual values. */
  setWalkTiming(timing) {
    this.walkTiming = timing && typeof timing === 'object' ? timing : null;
  }

  emit(evt) {
    const e = Object.assign({ ts: Date.now() }, evt);
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    try { this.onEvent(e); } catch (_) {}
  }

  /**
   * Apply the operator's "human-like" anti-detection settings live (from Settings).
   * The engine reads these at point of use, so a save takes effect without a restart.
   *   enabled=false -> the two jitters THIS function owns are forced to 0 (fixed poll cadence +
   *   fixed HARD-close establish mark). The bids/min and inter-fire caps are SAFETY guards and stay
   *   active either way. softOpenJitterMs is deliberately NOT one of them - the soft establish
   *   spread is a requirement of that path rather than an overlay on it, so it keeps running with
   *   the card off, and it is bounded in _jitteredMark instead of by AD_LIMITS.
   * The snipe window (hot poll) is never jittered here — _cadence() owns that and it
   * is deliberately crisp (correctness, not stealth). Only fields present are touched.
   */
  setAntiDetection(ad) {
    if (!ad || typeof ad !== 'object') return;
    if (ad.enabled !== undefined || ad.cadenceJitterMs !== undefined || ad.openJitterMs !== undefined) {
      const jitter = ad.cadenceJitterMs !== undefined ? Number(ad.cadenceJitterMs) : this.cfg.cadenceJitterMs;
      const openJitter = ad.openJitterMs !== undefined ? Number(ad.openJitterMs) : this.cfg.openJitterMs;
      this.cfg.cadenceJitterMs = ad.enabled === false ? 0 : jitter;
      this.cfg.openJitterMs = ad.enabled === false ? 0 : openJitter;
    }
    if (ad.maxBidsPerMin !== undefined) this.cfg.maxBidsPerMin = Number(ad.maxBidsPerMin);
    if (ad.minInterFireMs !== undefined) {
      // Read-time re-clamp (defence in depth). configStore rejects an out-of-range minInterFireMs
      // at WRITE time, but a value persisted under an OLDER, looser cap (the max was 1000ms before
      // it tightened to 150ms) survives configStore.get() un-re-validated and would otherwise flow
      // in here uncapped. Left uncapped it delays or skips the last-chance floor shot - the
      // establish + floor double-fire lands on two consecutive ~200ms hot ticks, and the inter-fire
      // gate (_maybeBid) must stay under that cadence. Cap at the same AD_LIMITS bound so a stale
      // stored value can't quietly undermine the snipe until the operator next re-saves Settings.
      const cap = AD_LIMITS.minInterFireMs.max;
      let n = Number(ad.minInterFireMs);
      if (n > cap) {
        this.log.warn('minInterFireMs above the hot-poll ceiling; clamping to protect the floor snipe',
          { requested: n, cap });
        n = cap;
      }
      this.cfg.minInterFireMs = n;
    }
  }

  /**
   * Apply a live soft-close config save (Settings), the same read-at-point-of-use way as
   * setAntiDetection. Only fields present are touched. A soft-strategy resolution is snapshotted onto
   * each monitor at arm(), so a change here governs LOADS ARMED AFTER the save (an in-flight auction
   * keeps the posture it was armed under - never flips a live soft auction mid-window). Guards each
   * field so a malformed save can never turn a safe default into a live-fire posture by accident.
   */
  setSoftClose(sc) {
    if (!sc || typeof sc !== 'object') return;
    const cur = this.softCfg;
    this.softCfg = {
      enabled: sc.enabled !== undefined ? !!sc.enabled : cur.enabled,
      shippers: Array.isArray(sc.shippers) ? sc.shippers.slice() : cur.shippers,
      mode: (sc.mode === 'live' || sc.mode === 'shadow') ? sc.mode : cur.mode,
      reserve: (sc.reserve !== undefined && Number.isFinite(Number(sc.reserve))) ? Number(sc.reserve) : cur.reserve,
      jumpPerRival: (sc.jumpPerRival !== undefined && Number.isFinite(Number(sc.jumpPerRival))) ? Number(sc.jumpPerRival) : cur.jumpPerRival,
      establishLeadMs: (sc.establishLeadMs !== undefined && Number.isFinite(Number(sc.establishLeadMs))) ? Number(sc.establishLeadMs) : cur.establishLeadMs,
      // MUST be here. This object is a WHOLESALE REPLACE, not a merge, so any field the constructor
      // seeds and this literal omits is DELETED the first time setSoftClose runs - and server.js:4430
      // runs applyConfigValues(configStore.get()) -> setSoftClose at BOOT, after the engines are built.
      // So an omission here is not a Settings-save edge case; the field is gone on every process start.
      // Dropping this one specifically un-bounds _lastResortFloor: its guard is
      // `attempts >= softCfg.lastResortFloorAttempts`, and `n >= undefined` is false for EVERY n
      // (1e9 included), so the never-forfeit release stops being bounded at all. On a load SP keeps
      // refusing - `Load not available for bidding`, `Amount is invalid...`, 135 of them in the last
      // 7 days - the rejection restore puts snipeFired back, which reopens the guard above, leaving
      // this bound as the only limit. Unbounded there means one refused write per hot poll inside the
      // 2.5s band, on the master account BRL's own operators share. Pinned by
      // scripts/test-softclose-config-roundtrip.js; add any future softCfg field to that test too.
      lastResortFloorAttempts: (sc.lastResortFloorAttempts !== undefined && Number.isFinite(Number(sc.lastResortFloorAttempts))) ? Number(sc.lastResortFloorAttempts) : cur.lastResortFloorAttempts,
    };
  }

  /**
   * Resolve this load's soft-close posture ONCE at arm: 'off' | 'shadow' | 'live'. FAIL CLOSED: 'off'
   * unless the master gate is on AND the shipper is explicitly on the opt-in allowlist. 'off' means the
   * soft-close endgame never engages and the monitor behaves byte-identically to Module-1 (this is why a
   * hard-close load, and every load while soft-close is disabled, is provably unchanged). Shipper match
   * uses the SAME word-boundary tokenMatch discovery.matchesAllowlist uses, so intake and engine agree
   * on which shippers are enabled. NO competitor modelling anywhere - this reads only the shipper name
   * against operator-set config (legal-independence wall, D6).
   */
  _resolveSoftStrategy(meta) {
    const sc = this.softCfg;
    if (!sc || !sc.enabled) return 'off';
    const shippers = Array.isArray(sc.shippers) ? sc.shippers : [];
    if (!shippers.length) return 'off'; // opt-in, never a blanket default
    const name = String((meta && meta.companyName) || '');
    if (!shippers.some((s) => tokenMatch(name, s))) return 'off';
    return sc.mode === 'live' ? 'live' : 'shadow'; // default shadow; 'live' is the evidence-gated graduation (E1-E4)
  }

  /**
   * Live Settings save for round-figure quoting, mirroring setSoftClose's per-field guards. An
   * omitted field keeps its current value rather than reverting to the default - the whole config is
   * re-applied from configStore at boot, so a dropped field would silently un-round an opted-in
   * shipper on every process start.
   */
  setRounding(rc) {
    const cur = this.roundCfg;
    const next = rc || {};
    this.roundCfg = {
      enabled: next.enabled !== undefined ? !!next.enabled : cur.enabled,
      shippers: Array.isArray(next.shippers) ? next.shippers.map((s) => String(s).trim()).filter(Boolean) : cur.shippers,
      step: next.step !== undefined ? coerceRoundingStep(next.step, cur.step) : cur.step,
    };
    return this.roundCfg;
  }

  /**
   * This load's rupee grid, or null for "do not snap". FAIL OPEN TO TODAY'S BEHAVIOUR: null unless
   * the master gate is on AND the shipper is explicitly opted in, matched with the SAME word-boundary
   * tokenMatch discovery and _resolveSoftStrategy use, so intake and engine can never disagree about
   * who is enabled. Reads only the shipper name against operator-set config - no competitor modelling
   * (legal-independence wall).
   */
  _resolveRoundingStep(meta) {
    const rc = this.roundCfg;
    if (!rc || !rc.enabled) return null;
    const shippers = Array.isArray(rc.shippers) ? rc.shippers : [];
    if (!shippers.length) return null; // opt-in, never a blanket default
    const name = String((meta && meta.companyName) || '');
    if (!shippers.some((s) => tokenMatch(name, s))) return null;
    // PER-TONNE IS REFUSED, not rounded: the grid is in wire-amount space and a per-MT rate is not.
    // On a real captured Rs 2,240/MT rate a 100 grid is a ~4% move, multiplied again by the tonnage
    // when SuperProcure derives the stored total - a different bid, not a rounder number. Nobody has
    // said what a round figure means for a rate, so this declines to guess. Inert while PMT bidding
    // stays env-gated off; it exists so opening that gate cannot silently start rounding rates.
    if (meta && meta.rules && meta.rules.pricingMode === 'per_tonne') return null;
    return rc.step;
  }

  /**
   * The integer ceiling to cap the ladder at - floored to the grid too when this shipper quotes in
   * round figures, because capLadderToCeiling lowers a rung TO the ceiling and an un-snapped ceiling
   * would put that one off-grid price back on the wire, on the very customer that refuses them.
   * Flooring is the safe direction by construction (the capped rung only moves further below the
   * cap), and a snap that pushes the ceiling under the floor is caught by the ceiling-below-floor
   * branch rather than breaching anything.
   */
  _ceilingOnGrid(rawCeiling, roundStep) {
    if (rawCeiling == null) return null;
    if (roundStep == null) return Math.floor(rawCeiling);
    return Math.floor(rawCeiling / roundStep) * roundStep;
  }

  /**
   * KILL-SWITCH: hard stop. Halts every monitor's timer and lowers the adapter
   * write backstop. No bid can fire until resume(). A bug or a panicked operator
   * can always reach this.
   */
  kill(reason = 'manual') {
    this.killed = true;
    this.killReason = reason;
    if (this.adapter && 'writeEnabled' in this.adapter) this.adapter.writeEnabled = false;
    if (this.adapter && typeof this.adapter.cancelShotRefresh === 'function') this.adapter.cancelShotRefresh();
    for (const m of this.monitors.values()) { if (m.timer) clearTimeout(m.timer); this._clearWalkTimers(m); }
    for (const t of this.scheduledTimers.values()) clearTimeout(t);
    this.scheduledTimers.clear();
    // The unreadable-flush timer is a THIRD timer class alongside monitor timers and scheduled
    // wakes, and it was the one left unreleased: _flushUnreadableFolded carries no killed guard
    // and speaks unconditionally, so a fold armed before this kill could still reach the desk
    // up to unreadableAnnounceWindowMs (2h default) after the engine stopped.
    this._clearUnreadableFlushTimer();
    // With the flush timer released, nothing else would announce the folded loads once no live load
    // is left to read, so the kill alert names them and they leave the fold.
    const folded = this._unreadableFolded;
    const foldedIds = this._unreadableFoldedIds;
    this._unreadableFolded = 0;
    this._unreadableFoldedIds = [];
    this.emit({ type: 'alert', level: 'error', kind: 'killed', reason,
      ...(folded > 0 ? { detail: `${reason} - also, we could not read ${folded} load(s) from the portal for a long time after their close time, so we stopped watching them - the results are unknown, check the portal: ${foldedIdList(foldedIds, folded)}`,
        foldedFirstId: foldedIds[0] } : {}) });
  }

  /**
   * Retire an engine whose stack is being thrown away. Unlike kill() it raises no alert of its own
   * and is never lifted: a wake already parked on its platform read, which no stop() can reach, must
   * not arm a monitor here, and a tick in flight must not plant another.
   *
   * The one thing it does still speak: a fold the unreadable-flush timer was holding for a later
   * retirement to carry (see _flushUnreadableFolded). No later tick is coming on a discarded engine,
   * so the fold has no successor - left alone it would sit on a timer this engine no longer owns and
   * speak up to unreadableAnnounceWindowMs (2h default) after teardown, the same defect kill() closed
   * for its own path. Flushing is a no-op when nothing is folded.
   */
  discard() {
    this.discarded = true;
    this._flushUnreadableFolded();
  }

  /**
   * Lift a kill: un-kill back to real bidding. Re-lifts the adapter write backstop,
   * re-ticks monitors + re-plans wakes. No tick ran while killed, so the in-memory
   * ladder state (firedRungs, lastBidPrice, bidTimes) is the real pre-kill state and
   * carries forward untouched — a rung that already spent real money can't re-fire.
   */
  resume() {
    if (!this.killed) return;
    this.killed = false;
    this.killReason = null;
    if (this.adapter && 'writeEnabled' in this.adapter) this.adapter.writeEnabled = true;
    this.emit({ type: 'alert', level: 'info', kind: 'kill_lifted' });
    for (const m of this.monitors.values()) { if (!m.finalized) this._schedule(m, 0); }
    for (const it of this.scheduler.activeIntents()) {
      if (it.status !== 'scheduled' || this.monitors.has(it.auctionId)) continue;
      // resume() re-plans without passing rehydrate()'s hold, so this restore door holds too.
      if (this._closeUnknown(it)) this._holdUnknownClose(it); else this._planWake(it);
    }
  }

  /**
   * Turn arm() inputs into a bid plan + the pricing fields to persist for rehydrate.
   * Two pricing models, picked by the inputs:
   *   - explicit margin BAND (the GoComet/BRL Syngenta path): { cost, marginsPct }
   *     -> buildBandLadder. The opening rung = highest margin, floor = lowest.
   *   - generic rate model (mock/sim + any price-visible platform): { marketRate,
   *     costFloor } -> buildLadder (eased descending ladder).
   */
  _planFor(inputs, rules, companyName) {
    let plan, pricing, floorSub = null;
    if (inputs.cost != null && Array.isArray(inputs.marginsPct)) {
      // FAIL CLOSED ON A FLOOR MARGIN THAT IS NOT ABOVE 0. Here because this is the funnel every arm
      // path shares: #238's guard sat in armFromRequest, and the restart rehydrate and the scheduled
      // wake both rebuild inputs from the durable intent and call arm() directly, skipping it.
      // ANNOUNCING is arm()'s and schedule()'s job - planPreview shares this code and must not page
      // anyone per keystroke.
      floorSub = floorMarginSubstitution({ marginsPct: inputs.marginsPct,
        minMarginPct: inputs.minMarginPct, houseDefaultPct: appConfig.minMarginPct });
      const minMarginPct = floorSub ? floorSub.substituted : inputs.minMarginPct;
      // ONE SET OF INPUTS FROM HERE DOWN. _deriveRungCount rebuilds the coarse band itself to read
      // its anchor count and rupee span, so handed the raw `inputs` it sizes the fine ladder against
      // the band the substitution has already replaced - one extra anchor sitting AT COST and a
      // wider span - and independently re-fires buildBandLadder's at-cost warning on a load this
      // function just fixed.
      const planInputs = floorSub ? { ...inputs, minMarginPct } : inputs;
      // Layer 3 (reversibility spine): a shipper explicitly on the rung-expansion allowlist, on a load
      // whose platform bid cap admits it, gets a FINER anchor-preserving ladder - interpolateBandLadder
      // inserts rungs strictly BETWEEN the desk's margin anchors, never moving one. Everyone else, and
      // every coarse/unknown-cap load, takes the null path and buildBandLadder's exact 3-anchor ladder,
      // so the deployed behaviour stays BYTE-IDENTICAL for every customer not opted in.
      const rungCount = this._deriveRungCount(planInputs, rules, companyName);
      if (rungCount != null) {
        // PER-TONNE UNIT NOTE. rules.minDecrement is SP's loadBidDifference - the minimum gap between
        // our own successive bid AMOUNTS. Which amount is UNPROVEN for PMT: SP may measure the gap on
        // the per-MT number we send (amountPMT / bidRate) or on the multiplied total it STORES as
        // `amount`. It is consumed here as PER-MT rung spacing, undivided, and that is DELIBERATE
        // rather than an oversight:
        //   - if the number is measured on the STORED TOTAL, per-MT spacing >= minDecrement makes the
        //     stored gap (spacing x tonnage) >= minDecrement with room to spare, so SP's rule is
        //     satisfied. The only cost is a coarser ladder than SP would have allowed - never a
        //     rejected bid.
        //   - if the number is PER-MT, this is simply correct.
        // Note the 2026-08-05 wire fix does NOT disturb this reasoning: the stored amount is still
        // rate x tonnage, it is just SuperProcure rather than us doing the multiplying.
        // Neither reading can put a wrong amount on the wire (minDecrement is not a createV2 field
        // and buildBidPayload never reads it) and neither can breach the floor (the floor rung is an
        // anchor interpolateBandLadder cannot drop). So unlike the ceiling - where one reading blocks
        // every bid and the other disables a safety check - there is no fail-closed case to make here,
        // and refusing would be actively worse: real PMT loads DO carry a decrement (live Rajratan
        // 23129542 has loadBidDifference 10), so a refusal would block essentially every per-tonne
        // load. The edit to NOT make is dividing this by the load's tonnage to win back rungs - under
        // the per-MT reading that produces revisions SP rejects as too close. Pinned by
        // scripts/test-pmt-min-decrement.js, which builds the divided ladder and shows it goes under.
        // Settled by placing two real rungs on a PMT load carrying a loadBidDifference and seeing
        // which space SP measured the gap in.
        const minDecrement = (rules && rules.minDecrement != null) ? rules.minDecrement : this.caps.minDecrement;
        plan = interpolateBandLadder({ cost: planInputs.cost, marginsPct: planInputs.marginsPct,
          minMarginPct, rungs: rungCount, minDecrement });
      } else {
        plan = buildBandLadder({ cost: planInputs.cost, marginsPct: planInputs.marginsPct, minMarginPct });
      }
      // The margins persisted for rehydrate are the ANCHORS (band.marginsPct), never the interpolated
      // ladder, so a restart/re-price rebuilds the identical fine ladder deterministically off the same
      // inputs + rules (revisionLimit and minDecrement both round-trip on meta.rules).
      pricing = { cost: inputs.cost, marginsPct: plan.marginsPct, minMarginPct: plan.minMarginPct };
      plan.floorMarginSubstituted = floorSub;
    } else {
      plan = buildLadder({
        marketRate: inputs.marketRate, costFloor: inputs.costFloor,
        openingMarkupPct: this.cfg.openingMarkupPct, rungs: this.cfg.rungs,
      });
      pricing = { marketRate: inputs.marketRate, costFloor: inputs.costFloor };
    }
    // MIN-DECREMENT DERIVATION (T4). The pricing models above space rungs by MARGIN and have no
    // concept of the platform's minimum bid difference; buildBandLadder cannot have one with its
    // signature, and interpolateBandLadder's own pass only ever drops an INSERTED rung, leaving an
    // anchor-anchor pair under the decrement exactly where it was. So a load whose desk margins sit
    // close together at its cost armed three prices of which one could never be sent, and the
    // _maybeBid guard discarded it every tick with no trace. deriveSpacedLadder is the repair: it
    // moves or drops MIDDLE rungs until every step the platform will measure clears the minimum,
    // never touching the opening or the operating price.
    //
    // rules.minDecrement, NEVER state.minDecrement, and that is a determinism requirement rather
    // than a convenience. _planFor is re-entered on re-price, on a scheduled wake and on a
    // post-restart rehydrate; a ladder that were a function of a live per-tick value would rebuild
    // onto DIFFERENT prices from the same intent, and remapFiredRungs (which matches by price) would
    // silently lose every fired rung - the identical hazard already written up for the grid below.
    // The live value keeps its existing job: enforcement at _maybeBid.
    //
    // rules.minDecrement is also the VALIDATED field (deriveLoadRules, junk -> null). The raw
    // load.minDecrement off realAdapter._mapLoad is uncoerced and must never be read here.
    const planMinDec = (rules && rules.minDecrement != null) ? Number(rules.minDecrement) : this.caps.minDecrement;
    // Per-truck-type pricing scales each rung onto each type's own cost before it goes on the wire,
    // and the portal applies its minimum to the amount on each LINE. A blended gap that clears the
    // minimum can therefore still send two refused amounts on a type cheaper than the blend, so the
    // ladder is spaced by the requirement expressed in blended space.
    const perTypeCost = (rules && rules.costByType) || null;
    const spacingMinDec = perTypeMinDecrement(planMinDec, perTypeCost);
    // PER-TONNE IS REFUSED, not re-spaced - the same refusal, for the same reason, that
    // _resolveRoundingStep makes one screen above: minDecrement is SuperProcure's loadBidDifference,
    // a number in WIRE-AMOUNT space, and a per-MT rate is not. The pre-existing PER-TONNE UNIT NOTE
    // licenses consuming it undivided only where it can "never produce a rung SP would reject or a
    // bid below the floor" - true of interpolateBandLadder, which only ever DROPS an inserted rung,
    // and false here, because this function arithmetically constructs a new price from it. A 1000
    // decrement against a Rs 2,240/MT rate is not a spacing correction, it is a 45% move.
    const perTonne = !!(rules && rules.pricingMode === 'per_tonne');
    const modelLadderKey = String(plan.ladder);
    const spaced = perTonne
      ? { ladder: plan.ladder, floor: plan.floor, dropped: [], moved: [], fits: plan.ladder.length,
        requested: plan.ladder.length, applied: false, reason: 'per_tonne_unit_space' }
      : deriveSpacedLadder({ ladder: plan.ladder, floor: plan.floor, minDecrement: spacingMinDec });
    if (spaced.applied) {
      this.log.info('ladder re-spaced to the load minimum bid difference - some desk prices cannot be sent as typed', {
        companyName, minDecrement: planMinDec, spacingMinDecrement: spacingMinDec,
        before: plan.ladder, after: spaced.ladder, dropped: spaced.dropped, moved: spaced.moved });
    }
    plan.ladder = spaced.ladder;
    plan.minDecrement = Number.isFinite(planMinDec) ? planMinDec : null;
    plan.spacingMinDecrement = Number.isFinite(spacingMinDec) ? spacingMinDec : null;
    plan.rungsRequested = spaced.requested;
    plan.rungsDropped = spaced.dropped;
    plan.rungsMoved = spaced.moved;
    plan.costByType = perTypeCost;
    // The ladder the moved/dropped diff was computed against. The grid snap below and the ceiling cap
    // in planPreview both rewrite plan.ladder afterwards, and a "your middle price will go out at
    // Rs X" sentence naming a price a later transform has already replaced is exactly the page-vs-wire
    // disagreement this whole change exists to remove - so the diff is INVALIDATED rather than left
    // to describe a ladder that no longer exists.
    const derivedLadderKey = String(spaced.ladder);
    // FINE LADDERS DO NOT GET THE COUNT SENTENCES. On the interpolated path plan.ladder is
    // interpolateBandLadder's output, so a count taken from it is a number of rungs the ENGINE built,
    // not prices the DESK typed - and the desk sees its own margin rows. Telling someone who entered
    // three margins about "your ten prices", with a corrective target computed off ten, is a wrong
    // instruction about money. The ladder line still renders the real prices, which stays true.
    plan.deskPriceCount = Array.isArray(plan.marginsPct) ? plan.marginsPct.length : null;
    plan.countsAreDeskFacing = plan.deskPriceCount != null && spaced.requested <= plan.deskPriceCount;
    // Applied LAST so it snaps whatever the pricing model produced - band, interpolated band or rate
    // ladder alike - and so the desk's margin anchors are never rounded, only the prices derived from
    // them. plan.floor moves with the rungs; roundLadderToGrid carries why that is load-bearing.
    // THE GRID IS AN INPUT TO PRICES, so it round-trips on the DURABLE INTENT (_intentToArm: restart
    // rehydrate and scheduled wake) and is honoured from there when present. Resolving it live on
    // those paths would make the ladder a function of process config rather than of the intent:
    // enabling the feature needs a restart, and on that restart every still-open load for the shipper
    // would re-plan onto new prices, remapFiredRungs (which matches by PRICE) would find none of them,
    // and the monitor would believe it had never bid - re-establishing above its own standing bid on a
    // live auction. An intent predating this field carries undefined and resolves from config, so old
    // intents behave exactly as before.
    //
    // A RE-PRICE (armFromRequest) deliberately does NOT carry it and re-resolves live. That path is
    // already rebuilding the ladder from a new band, so its prices move regardless and remapFiredRungs
    // is expected to lose its by-price match - a new grid is no additional hazard there, and honouring
    // a stale grid would silently outlive the config change the desk just made.
    // The per-tonne refusal holds on every path, an intent's persisted grid included.
    const roundStep = perTonne ? null
      : (inputs && inputs.roundStep !== undefined)
        ? inputs.roundStep
        : this._resolveRoundingStep({ companyName, rules });
    pricing.roundStep = roundStep != null ? roundStep : null;
    plan.roundStepApplied = null; // set below only if the snap actually lands
    plan.rungsLostToGrid = 0;
    if (roundStep != null) {
      const before = plan.ladder.length;
      const snapped = roundLadderToGrid({ ladder: plan.ladder, floor: plan.floor, step: roundStep });
      // What the ladder was ACTUALLY snapped with, which is not the same as what was resolved: a
      // refused grid leaves the ladder un-snapped. Every later consumer (the ceiling cap above all)
      // must read this rather than re-resolving, or it works in grid space against an un-snapped
      // ladder and compares two different things.
      plan.roundStepApplied = snapped.applied ? roundStep : null;
      if (!snapped.applied) {
        // The shipper wants round figures and this load cannot give them one inside the desk's band.
        // Bidding un-round loses at most this auction; quoting outside the band is a price nobody
        // authorised, so the un-snapped ladder stands and the desk is told which trade was taken.
        this.log.warn('round-figure grid REFUSED for this load - bidding un-rounded rather than outside the band', {
          companyName, step: roundStep, reason: snapped.reason, opening: plan.ladder[0], floor: plan.floor });
      } else {
        // Re-spaced in whole grid steps, ONLY when the snap pulled a step under the requirement (a
        // raw spacing the grid cannot express, 150 on a 100 grid): each price is snapped on its own,
        // duplicates kept, and placed the way the derivation above places them. A snapped ladder
        // whose every step already clears the requirement comes back exactly as snapped, folds and
        // all - re-placing it would add prices nobody typed.
        const gridSpacing = (Number.isFinite(spacingMinDec) && spacingMinDec > 0)
          ? Math.ceil(spacingMinDec / roundStep) * roundStep : null;
        let ladder = snapped.ladder;
        const underGap = gridSpacing != null && ladder.some((p, i) => i > 0 && ladder[i - 1] - p < spacingMinDec);
        if (underGap) {
          const last = plan.ladder.length - 1;
          const onGrid = plan.ladder.map((p, i) => (i === last ? snapped.floor
            : Math.max(snapped.floor, Math.floor(p / roundStep) * roundStep)));
          ladder = onGrid[0] === snapped.floor ? [snapped.floor]
            : deriveSpacedLadder({ ladder: onGrid, floor: snapped.floor, minDecrement: gridSpacing }).ladder;
        }
        plan.ladder = ladder;
        plan.floor = snapped.floor;
        plan.opening = ladder[0];
        plan.rungsLostToGrid = Math.max(0, before - ladder.length);
        if (ladder.length < before) {
          this.log.warn('round-figure grid collapsed rungs - this shipper now steps through fewer prices', {
            companyName, step: roundStep, rungsBefore: before, rungsAfter: ladder.length, floor: plan.floor });
        }
        // The min-decrement pass inside interpolateBandLadder ran on the PRE-snap ladder, and the snap
        // can move an adjacent gap by up to `step`. Post-snap gaps are multiples of `step`, so the
        // guarantee survives only when the grid divides the platform's bid difference - which nothing
        // upstream establishes. Re-check here so a step the engine will refuse at _maybeBid is a
        // visible warning at arm rather than a rung that silently never bids.
        const minDec = (rules && rules.minDecrement != null) ? Number(rules.minDecrement) : this.caps.minDecrement;
        const violations = decrementViolations(plan.ladder, minDec, scaleLadderByType(plan.ladder, perTypeCost));
        if (violations.length) {
          this.log.warn('round-figure grid left steps under the load bid difference - those rungs will not fire', {
            companyName, step: roundStep, minDecrement: minDec, violations });
        }
      }
    }
    // HOW MANY PRICES CAN ACTUALLY GO OUT, counted LAST on the ladder that will really be sent: the
    // grid snap above can re-open a gap the derivation closed, so counting before it would report a
    // number the wire does not deliver. This is what the price page shows the desk against
    // rungsRequested, and it is the reduced-attempt count on a per-type load - the per-line amounts
    // are what the portal measures, so they are what is counted.
    if (String(plan.ladder) !== derivedLadderKey) { plan.rungsMoved = []; plan.rungsDropped = []; }
    // Whether spacing or the grid moved any price off what the pricing model built. The moved/dropped
    // lists cannot answer that: the line above empties them whenever the grid changed the ladder.
    plan.derivationChanged = String(plan.ladder) !== modelLadderKey;
    plan.rungsFitting = fittingRungs(plan.ladder, plan.minDecrement,
      scaleLadderByType(plan.ladder, perTypeCost), { lastRungAlwaysAttempted: true }).length;
    // The PORTAL's count beside the ENGINE's, because the two answer different questions and the gap
    // between them is exactly the defect: rungsFitting counts the floor as always attempted (it is),
    // so on a ladder whose floor step is under the minimum it promises one more price than the board
    // will ever take. Set here rather than carried from deriveSpacedLadder's `fits`, which was
    // computed before the grid snap above and before arm()'s ceiling cap - both of which rewrite
    // these prices. arm() and planPreview recompute after the cap for the same reason.
    Object.assign(plan, this._floorStepFacts(plan.ladder, plan, rules));
    // Structural floor guarantee: every plan MUST carry a finite floor > 0 (the lowest ladder rung).
    // buildBandLadder / buildLadder already construct it so, but assert it here so no pricing model
    // can reach the engine (and placeBid) without a real floor to gate against - this is the
    // foundation the floor-inside-placeBid belt trusts when it reads monitor.floor.
    if (!(plan.floor > 0) || !Number.isFinite(plan.floor)) {
      const e = new Error(`_planFor produced a non-finite or non-positive floor (${plan.floor})`);
      e.code = 'FLOOR';
      throw e;
    }
    return { plan, pricing };
  }

  /**
   * How many of a ladder's prices the PORTAL will take, and which step stops it taking the floor.
   *
   * Judged against the RAW minDecrement, the same value every sibling call site passes (`_planFor`'s
   * rungsFitting, planPreview's fitting) and the same value _minDecrementFor enforces at bid time.
   * The per-type requirement is already carried by `scaled`: fittingRungs applies the threshold to
   * each line's own real amounts, so passing the blended-space spacingMinDecrement here would scale
   * the per-line test a second time and tighten it by the square of the cost ratio - a 22,000-rupee
   * line on a 50,000 blend measured against 2,273 when the load's published minimum is 1,000.
   *
   * PER-TONNE IS NOT ASKED, for the reason _planFor already refuses to re-space one: minDecrement is
   * SuperProcure's loadBidDifference, a number in WIRE-AMOUNT space, and a per-MT rate is not.
   * Passing null leaves every rung landable and raises nothing, which is the honest answer to a
   * comparison this codebase declares unproven rather than a claim about the ladder.
   */
  _floorStepFacts(ladder, plan, rules) {
    const perTonne = !!(rules && rules.pricingMode === 'per_tonne');
    const minDec = perTonne ? null : plan.minDecrement;
    const scaled = scaleLadderByType(ladder, plan.costByType);
    return { rungsLandable: fittingRungs(ladder, minDec, scaled).length,
      floorStepViolation: floorStepViolation(ladder, minDec, scaled) };
  }

  /**
   * Say that _planFor corrected a floor margin that would have bid this load at cost. Loud on
   * purpose: the whole reason this ran for seven weeks is that the one guard aimed at it warned at
   * log level and nothing read the log. Called only from the paths that COMMIT to a plan - a preview
   * shares _planFor and must not raise an operator alert per keystroke.
   */
  _announceFloorMarginSubstitution(meta, plan, inputs) {
    const sub = plan && plan.floorMarginSubstituted;
    if (!sub) return;
    this.log.warn('stored floor margin was not above 0: arming on the house default instead of bidding at cost', {
      auctionId: meta.id, stored: sub.stored, substituted: sub.substituted, cost: inputs.cost });
    this.emit({ type: 'alert', level: 'error', kind: 'zero_floor_margin_substituted',
      auctionId: meta.id, lane: meta.lane, companyName: meta.companyName || null,
      branchName: meta.branchName || null,
      detail: `stored floor margin ${sub.stored}% would bid this load at cost (Rs ${inputs.cost}); armed on the house ${sub.substituted}% instead - correct this customer's margin`,
    });
  }

  /**
   * Layer 3 rung-count derivation - how many rungs the anchor-preserving FINE ladder should carry, or
   * null to keep today's coarse buildBandLadder ladder BYTE-IDENTICAL. The reversibility spine lives in
   * this method: it returns null (coarse, unchanged) unless EVERY gate opens, so on merge nothing
   * changes for any existing customer and only shippers explicitly enabled get finer ladders.
   *
   * null (coarse) when:
   *   - the arm is not a margin-band arm (the rate model has no margin anchors to interpolate between), OR
   *   - the platform's per-load bid cap (rules.revisionLimit) is unknown, OR
   *   - that cap is <= LOW_CAP_THRESHOLD (3) - KEI / Syngenta and every coarse load, whose 3-rung ladder
   *     already spends a fresh 3-cap with zero reserve, so `last < 3` keeps them on the always-floor snipe, OR
   *   - the shipper is NOT on the rung-expansion allowlist. That allowlist is REUSED from softCfg.shippers
   *     and matched with the SAME word-boundary tokenMatch _resolveSoftStrategy / discovery use, so a
   *     shipper only ever gets fine ladders + rank-aware snipe once explicitly opted in.
   *
   * Otherwise: min(revisionLimit, cfg.rungCap if set > 0, RUNG_RUNAWAY_MAX, decrement-headroom),
   * floored at the anchor count. rungCap is an operator back-off lever, not a bid-rate control -
   * bids stay cadence-bounded regardless of rung density.
   */
  _deriveRungCount(inputs, rules, companyName) {
    if (!(inputs && inputs.cost != null && Array.isArray(inputs.marginsPct))) return null;
    const revisionLimit = rules && rules.revisionLimit != null ? Number(rules.revisionLimit) : null;
    if (revisionLimit == null || !Number.isFinite(revisionLimit) || revisionLimit <= LOW_CAP_THRESHOLD) return null;
    // Allowlist gate, aligned EXACTLY with _decide's rankDriven (softStrategy !== 'off'): the fine ladder
    // is built only when the DECISION logic will also run rank-driven, so a fine ladder can never be armed
    // and then walked by the DEPLOYED clock schedule (which would give away margin on the extra rungs).
    // _resolveSoftStrategy already applies the master soft-close enable AND the shipper allowlist with the
    // same tokenMatch, so this requires soft-close to be ENABLED and matches the same shippers - one gate,
    // no way for the fine ladder and the rank-driven endgame to disagree about who is opted in.
    if (this._resolveSoftStrategy({ companyName }) === 'off') return null;
    // Coarse band built once to read the anchor count + rupee span (arm is not a hot path, so the extra
    // build is fine; interpolateBandLadder rebuilds it, but from the same inputs, so they never disagree).
    const band = buildBandLadder({ cost: inputs.cost, marginsPct: inputs.marginsPct, minMarginPct: inputs.minMarginPct });
    const anchorCount = band.ladder.length;
    const span = band.ladder[0] - band.ladder[anchorCount - 1];
    // PER-TONNE UNIT NOTE (see the fuller reasoning at the _planFor consumption site above): `span`
    // is in PER-MT space on a per-tonne load and minDec is SP's raw loadBidDifference, whose unit on
    // PMT is unproven. Consuming it undivided can only UNDER-count the rungs that fit, which is the
    // conservative direction; it can never produce a rung SP would reject or a bid below the floor.
    // Note this whole path is unreachable for a per-tonne load today: the allowlist gate above
    // returns null unless soft-close is enabled AND the shipper is opted in, and no PMT shipper is.
    const minDec = (rules && rules.minDecrement != null) ? Number(rules.minDecrement) : this.caps.minDecrement;
    const decrementHeadroom = (Number.isFinite(minDec) && minDec > 0) ? Math.floor(span / minDec) + 1 : Infinity;
    // The operator cap binds ONLY when explicitly set (> 0); 0/absent = auto (no fixed count).
    const capKnob = (Number.isFinite(this.cfg.rungCap) && this.cfg.rungCap > 0) ? this.cfg.rungCap : Infinity;
    const derived = Math.min(revisionLimit, capKnob, RUNG_RUNAWAY_MAX, decrementHeadroom);
    return Math.max(anchorCount, derived);
  }

  /**
   * Arm the bot on an auction.
   * @param meta { id, lane, equipment, units, closesAt }
   * @param inputs { cost, marginsPct } (margin-band) OR { marketRate, costFloor } (rate)
   */
  /**
   * Read-only: same _planFor/_deriveRungCount gates as arm(), no monitor/state created.
   * Feeds the /price page preview so it can't drift from what an actual arm would produce.
   */
  planPreview(meta, inputs) {
    // Planned in the pricing-mode space arm() heals to, and judged by the gate _maybeBid applies.
    const rules = reconcilePricingMode(meta && meta.rules);
    if (rules !== (meta && meta.rules)) meta = Object.assign({}, meta, { rules });
    const { plan } = this._planFor(inputs, meta && meta.rules, meta && meta.companyName);
    // Mirror arm()'s ceiling resolution (below) so the desk preview can never show a price the armed
    // engine would cap away, or a biddable ladder for a load arm() will refuse outright.
    const rawCeiling = plausibleCeiling(meta && meta.rules && meta.rules.ceilingPrice);
    // Same published-vs-sendable split as arm() - `ceiling` is the shipper's number and is what the
    // desk is shown; `capAt` is what the engine may actually send.
    const ceiling = rawCeiling == null ? null : Math.floor(rawCeiling);
    const capAt = this._ceilingOnGrid(rawCeiling, plan.roundStepApplied);
    // Mirrors arm()'s unit-space guard (see the long note there). A per-tonne load carrying a ceiling
    // is refused outright, so the desk must be told THAT - not shown a per-MT-capped ladder for a load
    // that will never bid, and not told "the ceiling sits below your lowest price", which is the
    // per-MT comparison arm() no longer trusts on this basis.
    if (ceiling != null && meta && meta.rules && meta.rules.pricingMode === 'per_tonne') {
      return { ladder: [], floor: plan.floor, rungCount: 0, willNotBid: 'per_tonne_ceiling', ceiling,
        floorMarginSubstituted: plan.floorMarginSubstituted || null };
    }
    try { assertRulesSupported(meta && meta.rules); } catch (e) {
      if (e.code !== 'UNSUPPORTED_RULE') throw e;
      return { ladder: [], floor: plan.floor, rungCount: 0, willNotBid: 'unsupported_rule',
        floorMarginSubstituted: plan.floorMarginSubstituted || null };
    }
    const oneBidAtCeiling = ceiling != null && capAt < plan.floor && ceilingClearsGuard(capAt, plan);
    if (ceiling != null && capAt < plan.floor && !oneBidAtCeiling) {
      return { ladder: [], floor: plan.floor, rungCount: 0, willNotBid: 'ceiling_below_floor', ceiling,
        floorMarginSubstituted: plan.floorMarginSubstituted || null };
    }
    const ladder = oneBidAtCeiling ? [capAt]
      : (ceiling != null ? capAndRespace(plan, capAt) : plan.ladder).slice();
    const floor = oneBidAtCeiling ? capAt : plan.floor;
    // The ceiling cap lowers rungs onto the cap and de-dupes, so it can close a gap the derivation
    // opened. Re-count on the capped ladder rather than carrying plan.rungsFitting through, or the
    // page would promise attempts the capped plan cannot make.
    const fitting = fittingRungs(ladder, plan.minDecrement, scaleLadderByType(ladder, plan.costByType),
      { lastRungAlwaysAttempted: true });
    // The cap rewrites the ladder, so a moved/dropped diff taken before it no longer names prices
    // that will be sent - same invalidation, same reason, as after the grid snap in _planFor.
    const capChanged = String(ladder) !== String(plan.ladder);
    return { ladder, floor, rungCount: ladder.length,
      ceiling: ceiling != null ? ceiling : undefined,
      minDecrement: plan.minDecrement, spacingMinDecrement: plan.spacingMinDecrement,
      // Recomputed on the CAPPED ladder for the same reason the attempt count above is.
      ...this._floorStepFacts(ladder, plan, meta && meta.rules),
      rungsRequested: plan.rungsRequested, rungsFitting: fitting.length, fittingPrices: fitting,
      roundStep: plan.roundStepApplied, rungsLostToGrid: plan.rungsLostToGrid,
      rungsDropped: capChanged ? [] : plan.rungsDropped, rungsMoved: capChanged ? [] : plan.rungsMoved,
      // A ceiling that reshapes the ladder is stated by the page's ceiling note. The minimum-gap copy
      // would blame the bid gap for prices the ceiling took, and promise a fix that cannot send them.
      countsAreDeskFacing: !!plan.countsAreDeskFacing && !capChanged, trueCost: plan.trueCost, guard: plan.guard,
      // Data only - the /price page does not render this yet. A
      // stored band whose effective floor margin was <= 0 armed on the house default instead, and
      // this is the same fact arm()/schedule() already announce, surfaced here without paging
      // anyone: planPreview must stay silent (see the comment on _planFor's call site above).
      floorMarginSubstituted: plan.floorMarginSubstituted || null };
  }

  arm(meta, inputs) {
    if (this.monitors.has(meta.id)) return this.monitors.get(meta.id);
    // STALE-SNAPSHOT GUARD. The LoadRules on `meta` is a SNAPSHOT taken at discovery time and handed
    // back verbatim by every restore path - armFromRequest on capture/re-price, _intentToArm on a
    // scheduled wake or a post-restart rehydrate. A PMT load captured or armed BEFORE the per-tonne
    // build carries the old hardcoded pricingMode:'flat', and buildBidPayload plus every fail-closed
    // layer branch purely on pricingMode. Since the 2026-08-05 wire fix that is no longer an AMOUNT
    // error (both branches send Math.round(price)) - it silently strips the GUARDS: the SP_PMT_BID
    // gate, the MT-only refusal (the ~1000x KG trap), the ceiling refusal, the true in:"PMT" basis,
    // and the pmt_amount_mismatch oracle, which is gated on the mode we sent. Re-derive the
    // basis from the load's OWN recorded rateType, which every snapshot carries, instead of trusting
    // the snapshotted mode - the same recovery the transit mechanic already does for "a request
    // captured before the transit build deployed". reconcilePricingMode is one-directional (only
    // corrects UP to per_tonne, never down to flat) and returns the SAME object for every non-PMT
    // load, so nothing else can observe a change. Done HERE because arm() is the one chokepoint all
    // four restore paths funnel through, and monitor.meta.rules is exactly what _bidOpts hands the
    // wire - so the corrected value reaches the payload builder, the _maybeBid guard, AND the intent
    // re-persisted below (which heals the stale snapshot on disk for the next restart).
    const reconciledRules = reconcilePricingMode(meta.rules);
    if (reconciledRules !== meta.rules) {
      this.log.warn('load rules predate the per-tonne build: re-deriving the pricing basis from the load\'s own rateType', {
        auctionId: meta.id, rateType: meta.rules && meta.rules.rateType,
        snapshotted: meta.rules && meta.rules.pricingMode, reDerived: reconciledRules.pricingMode });
      meta = Object.assign({}, meta, { rules: reconciledRules }); // never mutate the caller's meta
    }
    const { plan, pricing } = this._planFor(inputs, meta.rules, meta.companyName);
    this._announceFloorMarginSubstitution(meta, plan, inputs);

    // CEILING (Module 2 L5): a shipper ceilingPrice caps the bid. Resolved ONCE here from the load's
    // own LoadRules fact, bound-checked - plausibleCeiling ignores an absent/implausible ceiling,
    // which is money-safe (with no cap the floor still guards the downside). Floored to an integer
    // because every bid goes on the wire as Math.round(amount): floor(ceiling) is the largest integer
    // bid that respects it.
    //   - ceiling BELOW the minimum-margin guard -> no winnable price exists without breaching it.
    //     FAIL CLOSED: flag the monitor so _decide never bids it and alerts once ("cannot win
    //     profitably"). The ladder is deliberately left UNcapped here (never used) so the hard floor
    //     invariant - floor is the lowest rung - stays intact; we never clamp toward the ceiling.
    //   - ceiling between the guard and the lowest band price -> ONE bid, at the ceiling.
    //   - ceiling AT/ABOVE the floor -> cap the ladder to it (a visible, logged cap surfaced on the
    //     armed event) so no rung, and so no bid, can exceed the ceiling.
    //   - PER-TONNE load carrying a ceiling -> the ceiling's UNIT is unproven (see below). Draw NO
    //     conclusion from it here. assertRulesSupported refuses the load outright (per_tonne_ceiling),
    //     so this is the only honest posture; acting on it in per-MT space would be a guess.
    const rawCeiling = plausibleCeiling(meta.rules && meta.rules.ceilingPrice);
    // TWO VALUES, and they must stay two. `ceiling` is the SHIPPER'S published cap and is what every
    // operator-facing surface reports - the refusal detail, the price page, the no-bid receipt. `capAt`
    // is the highest price we may actually send, which on a round-figure shipper is that cap floored to
    // the grid. Collapse them into one and the desk re-prices against a number the shipper never
    // published, up to step - 1 rupees below the real cap.
    const ceiling = rawCeiling == null ? null : Math.floor(rawCeiling);
    const capAt = this._ceilingOnGrid(rawCeiling, plan.roundStepApplied);
    // UNIT-SPACE UNKNOWN. Every comparison in this block is per-MT: plan.floor is the per-MT operating
    // floor and plan.ladder holds per-MT rungs. Since the 2026-08-05 wire fix the adapter belt is
    // per-MT too (body.amount is the bare rate), so the two consumers of ceilingPrice no longer sit in
    // DIFFERENT spaces the way they did - but that never was the whole problem, and the part that
    // remains is untouched: SuperProcure's ceilingPrice is in an UNPROVEN unit on a PMT load. No
    // captured PMT load carries a non-null ceilingPrice (all 11 on the 2026-08-05 board are null), and
    // the only evidence - FTL ceilings sitting in wire-amount magnitudes, Havells "300000.00", Shriji
    // "90000.00" - is an inference from a different basis. Inferring a PMT semantic from FTL is
    // exactly how the amount-is-a-total error entered this codebase, so it must not be repeated here.
    // The resolution is to fail closed, NOT to pick a space: a per-tonne load carrying a plausible
    // ceiling is refused by assertRulesSupported (per_tonne_ceiling). This guard removes the per-MT
    // stand-down as well, so the refusal is the single verdict rather than a race between the two.
    // Without it, a ceiling that happens to parse BELOW the per-MT floor trips ceilingBelowFloor,
    // _decide returns early, and the load is reported to the human as "cannot win profitably" - a
    // conclusion computed from the very comparison this code declares unproven - instead of "the
    // ceiling's unit is unknown". Money-safe either way (both paths bid nothing); this is about which
    // reason the operator is told. Once a real PMT ceiling is observed and its unit is proven, fix
    // this block and the adapter belt TOGETHER, and drop this guard and the per_tonne_ceiling refusal
    // with them.
    const perTonneCeilingUnproven = ceiling != null
      && meta.rules && meta.rules.pricingMode === 'per_tonne';
    if (perTonneCeilingUnproven) {
      this.log.warn('per-tonne load carries a shipper ceiling of an unproven unit - not capping and not standing down; the load is refused as per_tonne_ceiling', {
        auctionId: meta.id, ceiling, floor: plan.floor });
    }
    let ceilingBelowFloor = false;
    if (ceiling != null && !perTonneCeilingUnproven) {
      // Viability is judged on capAt, not on the published ceiling: on a round-figure shipper the
      // question is whether a legal ON-GRID price exists under the cap, not merely a legal one.
      // The floor is the lowest BAND price, and the minimum-margin guard can sit below it. A cap in
      // that gap still leaves one price the desk authorised: the cap itself, bid once.
      if (capAt < plan.floor && ceilingClearsGuard(capAt, plan)) {
        this.log.info('shipper ceiling is below the lowest band price but above the minimum-margin guard - one bid at the ceiling', {
          auctionId: meta.id, ceiling, capAt, lowestBandPrice: plan.floor, guard: plan.guard });
        plan.ladder = [capAt];
        plan.floor = capAt;
      } else if (capAt < plan.floor) {
        ceilingBelowFloor = true;
        this.log.warn(capAt === ceiling
          ? 'ceiling below operating floor - will not bid (fail closed)'
          : 'no on-grid price exists under the shipper ceiling - will not bid (fail closed)', {
          auctionId: meta.id, ceiling, capAt, floor: plan.floor });
      } else {
        const capped = capAndRespace(plan, capAt);
        // The hard floor invariant must survive the cap: with ceiling >= floor the lowest rung is
        // unchanged (min(floor, ceiling) === floor). Assert it rather than trust it on live money.
        if (capped[capped.length - 1] !== plan.floor) {
          const e = new Error(`ceiling cap altered the floor rung (${capped[capped.length - 1]} != ${plan.floor})`);
          e.code = 'FLOOR';
          throw e;
        }
        if (capped.length !== plan.ladder.length || capped[0] !== plan.ladder[0]) {
          this.log.info('ladder capped to shipper ceiling', {
            auctionId: meta.id, ceiling, capAt, opening: capped[0], rungCount: capped.length });
        }
        plan.ladder = capped;
      }
    }

    // THE STEP INTO THE FLOOR RUNG, checked HERE because this is the only point past all three
    // producers of a sub-minimum one - a 2-rung ladder (deriveSpacedLadder's middle loop never runs,
    // so it pushes the floor with no gap check and reports applied=false), the grid snap in
    // _planFor, and the ceiling cap immediately above. Every other layer exempts that step, which is
    // why it reached the portal unreported: _maybeBid exempts it so the decisive shot always fires,
    // and decrementViolations mirrors that exemption by design.
    //
    // DETECTION, not repair. pricing.js says the platform measures this step like any other while
    // _reachableAt calls that an open question, and reshaping the ladder on the stricter reading
    // would drop a shot this engine currently wins loads with.
    Object.assign(plan, this._floorStepFacts(plan.ladder, plan, meta.rules));
    // Re-counted on the CAPPED ladder, never carried from plan.rungsFitting (set at _planFor time,
    // before the cap above rewrote these prices) - planPreview recomputes here for the same reason
    // and says so. Carrying it through put a pre-cap count beside the post-cap rungsLandable in the
    // same sentence, so a cap that collapsed a rung was reported as two lost attempts, not one.
    // Assigned back so the monitor and every later reader carry the count of the ladder that armed.
    plan.rungsFitting = fittingRungs(plan.ladder, plan.minDecrement,
      scaleLadderByType(plan.ladder, plan.costByType), { lastRungAlwaysAttempted: true }).length;
    // THE DESK IS TOLD AT PRICE ENTRY, NOT THE DIRECTOR AFTER THE FACT. This step is knowable the
    // moment a cost is typed, so /price renders it and holds the submit shut (ladderNotice
    // floorStepRefusal, server.js floorStepPreflight) while the correction is still free. An
    // operator alert on the way out of arm() could only describe a load already committed, which is
    // bucket 3 of the price-page gate dressed as bucket 2.
    //
    // The log line stays, as the engine's own record of a load that armed carrying the step - the
    // measured facts and no claim about what the portal will do with them, which is a question
    // _reachableAt and floorStepViolation both decline to settle.
    if (plan.floorStepViolation) {
      const v = plan.floorStepViolation;
      this.log.warn('armed with the step into the floor rung under the minimum bid difference', {
        auctionId: meta.id, ladder: plan.ladder, floor: plan.floor, minDecrement: v.minDecrement,
        fromPrice: v.fromPrice, toPrice: v.toPrice, gap: v.gap, bindingLine: v.bindingLine,
        rungsLandable: v.rungsLandable, rungsFitting: plan.rungsFitting });
    }

    // Preserve persisted firedRungs (remapped by price to the new ladder — see remapFiredRungs):
    // rehydrate() re-enters arm() and resetting to [] would let a restart re-fire a spent rung; a
    // re-price rebuilds the ladder from a new band, so the fired rungs are remapped, not carried raw.
    const prior = this.scheduler.get(meta.id);
    // DEPLOY OBSERVABILITY for the min-decrement derivation. A load already armed when this shipped
    // rehydrates through here onto a ladder the derivation may have re-spaced. The safety argument
    // is that the affected rung has never fired (the _maybeBid guard has been discarding it every
    // tick) and that the two anchors never move, so remapFiredRungs cannot lose a spent rung - but
    // that is an argument, not a proof, so make the first deploy observable instead of assumed.
    if (plan.rungsRequested != null && plan.derivationChanged
        && prior && Array.isArray(prior.ladder) && prior.ladder.length
        && String(prior.ladder) !== String(plan.ladder)) {
      this.log.warn('re-arming an existing intent onto a re-spaced ladder - fired rungs remap by price', {
        auctionId: meta.id, persisted: prior.ladder, derived: plan.ladder,
        firedRungs: prior.firedRungs || [], minDecrement: plan.minDecrement });
    }
    // Re-price safety for the FOREIGN-BID detection (distinct from the firedRungs remap above).
    // firedRungs carries forward BY PRICE, so a genuine COST re-price legitimately carries nothing
    // forward — every rung price changed, remapFiredRungs returns [], and armFromRequest's restore
    // no-ops because it guards on .length. That is correct rung bookkeeping, but it erases the one
    // fact _detectForeignBids depends on: whether THIS bot has already bid THIS load. Without it a
    // re-armed monitor is byte-identical to a never-bid one (ownBidAttempts 0, firedRungs empty,
    // currentRungIndex -1) while our own pre-re-price bid still holds a standing rank — so the
    // detection counts OUR OWN spent bid as a foreign one. On a cap<=3 load re-priced after one bid
    // that double-count walks the budget to 0 and the final floor snipe never fires (the bot goes
    // dark at the buzzer). Carry a price-INDEPENDENT boolean across the re-arm instead.
    // Back-compat: intents written before this key existed prove the same thing with non-empty
    // firedRungs, so a load already in flight at deploy time rehydrates with the guard intact.
    const priorEverBid = !!(prior && (prior.everBid === true
      || (Array.isArray(prior.firedRungs) && prior.firedRungs.length > 0)));
    // foreignSlotUncounted's durable twin. Once everBid latches true, _detectForeignBids can never
    // re-fire on this load again (see its ownBidAttempts/firedRungs/everBid guards) - so a re-price
    // or restart that rebuilds the monitor AFTER that point has no way to re-observe the standing
    // rank that proved a slot was already spent. It has to be carried forward explicitly instead.
    const priorForeignSlotUncounted = !!(prior && prior.foreignSlotUncounted === true);
    // Restart + re-price safety for the PARTICIPATION fact, the same class of hole priorEverBid
    // closes for the ATTEMPT fact - and the one _finalize's zero-bid alarm and the WhatsApp outcome
    // template both read at close. rehydrate() re-enters arm() for every still-live auction, so a
    // purely per-process counter comes back 0 on a load that already has real bids on the board:
    // `sh scripts/deploy.sh` restarts pm2 mid-auction, the ladder is already spent (revisionsLeft
    // restored at 0), no further bid can land, and the desk is told "NO BID PLACED" for a load we
    // bid three times. currentRungIndex used to survive that by accident (rebuilt from the durable
    // firedRungs in rehydrate) and this derivation correctly stopped reading it, so the durability
    // it was providing has to be replaced deliberately rather than dropped.
    // Back-compat for an intent written BEFORE this key existed: status 'bidding' proves the same
    // thing, because it is written at exactly one site - the ACCEPTED-bid update below - never on an
    // arm and never on a rejection. So a load already in flight at deploy time rehydrates with the
    // fact intact, and the count is exact from the next landed bid onward.
    const priorLandedBids = (() => {
      const n = prior ? Number(prior.landedBids) : NaN;
      if (Number.isFinite(n) && n >= 0) return n;
      return prior && prior.status === 'bidding' ? 1 : 0;
    })();
    // Re-price safety for the STANDING PRICE - the comparand every "can this ladder still be bid"
    // question needs, and the one this monitor used to throw away (`lastBidPrice: null` below).
    // A reverse auction refuses any offer at or above what we already have standing, so a re-armed
    // monitor that has forgotten its own price re-establishes ABOVE it and every rung is refused:
    // load 260908LD2Z, 2026-09-08, bid_rejected 41420 against its own live 31,610, 114 minutes
    // before close. firedRungs cannot carry this, because a genuine cost re-price changes every
    // price and remapFiredRungs correctly returns [].
    // LANDED only, restored from the intent so it survives a restart as well as a re-price. The
    // shadow path also sets lastBidPrice (it wants a number for the trace) but places nothing on the
    // wire, so it deliberately does not persist here - nothing stands, nothing constrains.
    // BACK-COMPAT for an intent written BEFORE this key existed, and it is the whole point rather
    // than a nicety: `sh scripts/deploy.sh` restarts pm2 mid-day, so on the day this ships EVERY
    // live auction rehydrates off an intent with no landedBidPrice - and a re-price on one of those
    // is exactly the event that produced 260908LD2Z. The same treatment everBid and landedBids each
    // carry two blocks above, from the same evidence: an intent that proves a bid landed
    // (landedBids, or the 'bidding' status written at the accepted-bid site alone) carries the
    // ladder it was armed on and the rungs it spent, so the LOWEST fired price is what stands.
    // Lowest, not highest: the ladder descends and each landed bid replaces the last.
    // The rung to read is the HIGHEST index in the durable set, always - the lowest price on a
    // descending ladder. The in-memory firedRungs does bank what was OFFERED (the rejection handler
    // adds the rung the moment SuperProcure refuses it), but the DURABLE set is written at three
    // sites and all three are LANDED - the accepted path, the transport-throw path that counts an
    // undisproved write as on the board, and _recordLandedAfterRetire - each writing the whole
    // in-memory set with the rung that just landed already added. selectRung only ever walks DOWN
    // the ladder, so the rung that just landed is the largest index in that snapshot, and a refusal
    // banked after it never reaches disk at all. Max is therefore the last landed bid exactly, in
    // every shape the engine can produce - including the commonest one, an early rung refused and
    // later rungs landed.
    //
    // It is also the fail-closed direction under any residual ambiguity, which is why it is taken
    // unconditionally rather than only where the counts agree. standingBid() feeds
    // assertLadderReachable, so a price read too HIGH makes the submit gate permissive: the /price
    // page saves a band no rung of which the portal can ever accept, and the load goes silently dark
    // - the exact failure this branch exists to remove. Read too LOW, the gate refuses at the page
    // with a corrective message the desk can act on. Max can only ever err low.
    const priorLandedBidPrice = (() => {
      const n = prior ? Number(prior.landedBidPrice) : NaN;
      if (Number.isFinite(n) && n > 0) return n;
      if (!prior || !(priorLandedBids > 0)) return null;
      if (!Array.isArray(prior.ladder) || !Array.isArray(prior.firedRungs) || !prior.firedRungs.length) return null;
      const price = Number(prior.ladder[Math.max(...prior.firedRungs)]);
      return Number.isFinite(price) && price > 0 ? price : null;
    })();
    // Re-price safety for the RETRACTION DEBT, and it is the one survivor here whose loss is unsafe
    // rather than merely wasteful. A re-price is stop + armFromRequest, stop deletes the monitor, and
    // a rebuilt monitor with no record owes the desk no all-clear - so the hand-bid instruction stands
    // forever and the desk keeps quoting against SuperProcure's shared per-load cap. Under the boolean
    // latch this replaced, losing the field only meant a harmless re-notify; now it drops the STOP
    // signal. Carried in memory by stop() rather than on the intent - see the constructor.
    const carriedAuthNotice = this._authNoticeCarry.get(meta.id) || null;
    this._authNoticeCarry.delete(meta.id);
    // Durable for the same reason landedBids is, and it is load-bearing in the same way: it is the
    // ONLY thing holding the ladder walk for a load whose establish was released early by the
    // re-price exemption. A restart is routine here - `sh scripts/deploy.sh` restarts the pm2
    // process mid-auction - and rehydrate rebuilds currentRungIndex from firedRungs, which skips the
    // establish branch entirely, so nothing would ever set this again. Without persistence the load
    // comes back with the flag gone and steps down immediately, outside the mark: exactly the defect
    // the hold exists to stop, reintroduced by a deploy.
    const priorEstablishedBeforeWindow = !!(prior && prior.establishedBeforeWindow);
    // THE PORTAL'S VERDICTS ON THIS QUOTE. A RESTART and a RE-PRICE both land here, and the
    // in-memory-only latches conflated them: a re-price is a quote the portal has never ruled on, so
    // inheriting a verdict about the last one would be wrong, while a restart rebuilds the same quote
    // from the same durable intent, so the verdicts still stand. `sh scripts/deploy.sh` restarts pm2
    // on every deploy, and the re-walk that followed re-spent a 3-attempt budget at prices the portal
    // had already refused - which the platform may well count against the cap anyway (see the
    // rejection path's note on that).
    //
    // NOT EVERY VERDICT, and the exclusions are deliberate rather than missed. What carries is what
    // _refusalStateOf writes: priceRaiseRefused (with its cap), submissionClosed, and the
    // refused-price run. loadNotBiddable and quantityRefused / quantityRefusedAtVcq are NOT carried -
    // they are SuperProcure's live state about a load it may since have reopened, so the engine
    // re-learns them at the cost of one refused write per lifetime rather than inheriting a stale
    // stand-down. The rung that earned such a verdict is withheld from offeredRungs to match, or the
    // carry-back would bank the spend while dropping the verdict and walk the ladder down instead.
    //
    // THE DISCRIMINATOR IS THE EPOCH, NOT THE LADDER, and that is the correction. Comparing ladders
    // reads process identity off a value that does not depend on every input a re-price can change:
    // plan.ladder derives from cost / margins / rules and NEVER from the vehicle count, so a desk
    // re-price that lowers the truck count - or a plain no-change re-submit - rebuilt a byte-identical
    // ladder, passed the compare, and applied three terminal verdicts to a quote the portal had never
    // seen. The load then went completely silent: rungs 0..n-1 blocked by the banked offeredRungs and
    // the floor blocked by the carried refused-price run, against a portal that would have accepted.
    // The epoch cannot be defeated that way because it is not derived from the quote at all - it is
    // stamped by the three writers that rebuild it (priceRequests.bumpRepriceEpoch) and by nothing
    // else, so a restart replays it and only a desk action moves it.
    //
    // The ladder compare stays as a second AND, and it is not redundant: offeredRungs are INDICES
    // into this ladder, so carrying them onto a differently-priced one would bank the wrong prices.
    // It can now only ever refuse a carry, never grant one - which is the safe direction for a path
    // whose failure mode is a silent load.
    const armEpoch = Number.isInteger(meta.repriceEpoch) ? meta.repriceEpoch : 0;
    const priorRefusal = (prior && prior.refusalState && Array.isArray(prior.ladder)
      && String(prior.ladder) === String(plan.ladder)
      && (Number.isInteger(prior.refusalState.epoch) ? prior.refusalState.epoch : 0) === armEpoch)
      ? prior.refusalState : null;
    const refusalFacts = priorRefusal || {};
    // Rungs this ladder has OFFERED that the durable firedRungs does not already hold: the refusals
    // banked after the last landed write. firedRungs is written at LANDED sites only and
    // priorLandedBidPrice above reads it as "the last bid that stands", so the refusals cannot go
    // there; and what is already there is not repeated here, so each spent rung has one durable home.
    const carriedOfferedRungs = Array.isArray(refusalFacts.offeredRungs)
      ? refusalFacts.offeredRungs.filter((i) => Number.isInteger(i) && i >= 0 && i < plan.ladder.length) : [];
    const provisional = closeIsProvisional(this.caps);
    const provisionalFacts = {};
    let roundPolicy = null;
    if (provisional) {
      // Saved per load: once an intent carries a policy, a re-arm or restart keeps it even if the
      // customer record has changed since.
      roundPolicy = normaliseRoundPolicy(prior && prior.roundPolicy) || normaliseRoundPolicy(meta.roundPolicy);
      provisionalFacts.roundPolicy = roundPolicy;
      if (meta.roundPolicy !== roundPolicy) meta = Object.assign({}, meta, { roundPolicy });
      // W9's per-customer switch rides the intent so a restart keeps it; a request that resolved it wins.
      const preEmptive = meta.preEmptiveFloorAtRankOne === true
        || (meta.preEmptiveFloorAtRankOne === undefined && !!prior && prior.preEmptiveFloorAtRankOne === true);
      if (preEmptive || (prior && 'preEmptiveFloorAtRankOne' in prior)) provisionalFacts.preEmptiveFloorAtRankOne = preEmptive;
      if (preEmptive !== (meta.preEmptiveFloorAtRankOne === true)) meta = Object.assign({}, meta, { preEmptiveFloorAtRankOne: preEmptive });
    }
    const priorRound = prior && prior.round && typeof prior.round === 'object' ? prior.round : null;
    // durable intent FIRST, before we touch the platform — survives a restart.
    const intent = this.scheduler.upsert({
      auctionId: meta.id,
      lane: meta.lane, equipment: meta.equipment, units: meta.units,
      // pricing basis (FTL/PMT) survives the intent round-trip so the multi-vehicle guard still
      // works after a restart/rehydrate - without it, a rehydrated FTL-multi load loses its basis
      // and would fail OPEN (bid vcq:-1 again). null on mock/sim/pre-fix intents.
      quoteType: meta.quoteType || null,
      // Operator-chosen truck count (a partial when the desk lowered it) must survive a
      // restart/rehydrate too, or a re-armed load reverts to bid-max (round(units)) and over-commits
      // more trucks than the desk chose. null -> the engine's bid-max default (round(units)).
      bidVehicleCount: (meta.bidVehicleCount != null) ? meta.bidVehicleCount : null,
      companyName: meta.companyName || null, // shipper must survive the intent round-trip (wake/rehydrate) or History + won/lost alerts lose it
      // which portal this load came from, so a restart/rehydrate re-arm still stamps the closedBids
      // record correctly (see the 'armed' emit below) rather than losing the tag on the next event.
      platformKey: meta.platformKey || null,
      branchName: meta.branchName || null, // branch ROUTING key must survive it too, for the same reason: a rehydrated Alwar load whose events lose the branch label routes its alerts to the general group instead of the branch group
      poster: meta.poster || null, // the shipper-side contact the WON message names must survive the intent round-trip too - a deploy mid-auction (deploy.sh restarts pm2) would otherwise rehydrate the load with no poster and the win would go out without the number the desk needs to place the vehicle
      shipperRef: meta.shipperRef || null, // the OA number the loss receipt names, same round-trip reason as poster
      points: meta.points || null, // full pickup/drop addresses survive a restart with the intent
      laneCells: meta.laneCells || null, // the lane cells the receipt renders - same round-trip reason as points
      rules: meta.rules || null, // LoadRules must survive wake/rehydrate too, or a re-armed load loses the per-load facts the payload builder will need
      laneFreight: meta.laneFreight || null, // A3: SP's published lane anchor survives the intent round-trip (same as rules/points) so a scheduled-wake or post-restart arm still lands it on closedBids
      // D038: the seven display-only closedBids fields survive the intent round-trip too, same
      // round-trip reason as branchName/poster/laneFreight above.
      loadCode: meta.loadCode != null ? meta.loadCode : null,
      distanceKm: meta.distanceKm != null ? meta.distanceKm : null,
      weight: meta.weight != null ? meta.weight : null,
      weightUnit: meta.weightUnit || null,
      capturedAt: meta.capturedAt != null ? meta.capturedAt : null,
      marginSource: meta.marginSource || null,
      closesAt: meta.closesAt,
      ...postedCloseFor(prior, meta, provisional),
      ...pricing,
      ladder: plan.ladder,
      status: 'armed',
      firedRungs: remapFiredRungs(prior, plan.ladder),
      everBid: priorEverBid, // survives the price-keyed remap; see the note above
      foreignSlotUncounted: priorForeignSlotUncounted, // survives the same remap; see the note above
      landedBids: priorLandedBids, // durable participation fact; survives restart AND re-price (see above)
      landedBidPrice: priorLandedBidPrice, // durable standing price; survives restart AND re-price (see above)
      pendingGcSubmission: (prior && prior.pendingGcSubmission) || null,
      gcUnconfirmedSubmissions: (prior && prior.gcUnconfirmedSubmissions) || [],
      establishedBeforeWindow: priorEstablishedBeforeWindow, // holds the walk across a restart (see above)
      refusalState: priorRefusal, // null on a re-price: the verdicts were about the old quote
      // Which quote this intent is now armed on. Durable so the RESTART path has it: rehydrate goes
      // through _intentToArm, which never sees the price request, so without this the restart would
      // arm at epoch 0 against verdicts stamped at 3 and drop a carry-back that is legitimately due.
      repriceEpoch: armEpoch,
      finalRank: prior ? (prior.finalRank ?? null) : null,
      won: prior ? (prior.won ?? null) : null,
      ...provisionalFacts,
    });

    const softStrategy = this._resolveSoftStrategy(meta);
    const round = roundTracker.createTracker({ platform: provisional ? 'gc' : 'sp', closeModel: this.caps.closeModel,
      softStrategy, postedCloseAt: numericOrNull(intent.postedCloseAt), restored: priorRound,
      capPrior: roundPolicy ? roundPolicy.finalAfterExtensions : undefined,
      closeAt: plausibleCloseAt(meta.closesAt, Date.now()),
      resumed: !!prior && !priorRound && prior.status !== 'scheduled', nowMs: Date.now() });
    // softStrategy 'off' SuperProcure loads are tracked for the closed record only (ruling 56 (d)).
    const mirrorsRounds = provisional || softStrategy !== 'off';
    const restoredClose = priorRound ? plausibleCloseAt(priorRound.closeAt, Date.now()) : null;
    const lastLanded = restoredLastLanded(prior);

    const monitor = {
      auctionId: meta.id, meta, intent,
      // When THIS monitor armed (wall clock) - the bound _checkDelisted races a never-listed load's
      // first full listing against (BC-15 Fix B, ruling 65). Not persisted: a rehydrate re-arms and
      // restarts the race, which is correct - the old race's listing, if any, said nothing about a
      // load this process has not listed itself.
      armedAt: Date.now(),
      ladder: plan.ladder, floor: plan.floor,
      // The minimum-margin guard, below the lowest band price; null on a rate-model plan.
      guard: Number.isFinite(plan.guard) ? plan.guard : null,
      repriceEpoch: armEpoch, // stamped onto every verdict this monitor persists (see _refusalStateOf)
      // shipper ceiling (integer, floored) and whether it sits below the floor (a fail-closed load
      // the engine refuses to bid). null ceiling = no cap in force. Re-derived on every arm from the
      // LoadRules, so a rehydrate/re-price recomputes it - no stale ceiling survives a restart.
      ceiling, ceilingBelowFloor,
      // Seeded from the spend the intent now carries (remapped onto this ladder above), so every caller -
      // the scheduled wake, rehydrate, a re-price routed through schedule() - arms a monitor that knows
      // what already went on the wire, rather than one that establishes again below its own bid (T2 D9).
      currentRungIndex: intent.firedRungs && intent.firedRungs.length ? Math.max(...intent.firedRungs) : -1,
      // Plus the refusals banked after the last landed write, which firedRungs never holds
      // (see carriedOfferedRungs): the two records are disjoint, so this is a union, not a merge.
      firedRungs: new Set([...(intent.firedRungs || []), ...carriedOfferedRungs]),
      // Rungs the min-decrement guard refused. Deliberately NOT folded into firedRungs, which means
      // SPENT - a different fact, and one the budget accounting and the foreign-bid detection both
      // read. This set is what ends the re-select-and-re-discard-every-tick loop: rung selection
      // consults it alongside firedRungs, so a rung the platform would refuse is not re-chosen 200ms
      // later for the rest of the auction. Per-monitor and not persisted: a re-price or a restart
      // rebuilds the ladder, and a rung that is still unfireable re-records itself on the next tick.
      unfireableRungs: new Set(),
      // Rungs refused by a verdict this engine re-learns rather than carries (loadNotBiddable,
      // quantityRefused). Held out of the persisted offeredRungs so the next lifetime can re-offer the
      // same price and re-earn the same stand-down, instead of skipping to the rung below it. Not
      // restored across a lifetime for the same reason the verdicts are not.
      _relearnedRungs: new Set(),
      _rungDiscardAlerted: new Set(), // one alert per (auctionId, rungIndex), not one per tick
      status: 'monitoring',
      myRank: null, totalBidders: 0,
      // restore remaining revisions across a restart (fresh arm = static cap). Re-seeding to the
      // cap mid-auction would let the engine exceed the platform's revision limit.
      revisionsLeft: (prior && prior.revisionsLeft != null) ? prior.revisionsLeft : this.caps.revisionLimit,
      closesInMs: Math.max(0, meta.closesAt - Date.now()),
      closeModel: this.caps.closeModel,
      standingL1Price: null,
      bidInProgress: false, lastFireAt: 0, lastBidPrice: priorLandedBidPrice,
      pendingGcSubmission: intent.pendingGcSubmission || null,
      gcUnconfirmedSubmissions: intent.gcUnconfirmedSubmissions || [],
      // The per-load minimum decrement as the platform last reported it, so the re-price API judges
      // reachability against the real number rather than the static capability default
      // (SuperProcure's Bid Difference varies per load - 100 and 1500 both seen). In-memory only:
      // the API reads it off the LIVE monitor before the re-arm replaces it, and a monitor rebuilt
      // by a restart re-learns it on its first state read rather than inheriting a stale value.
      lastMinDecrement: null,
      // landedBids: bids that actually went ON THE BOARD for this load - incremented at exactly the
      // two sites where a write reached SuperProcure and was not disproved (an ACCEPTED placeBid, and
      // a transport throw whose read-back could not prove the write never committed). Two deliberate
      // exclusions, for opposite reasons:
      //   - a REJECTION: SP refusing the write means nothing is on the board. That is the whole
      //     distinction the attempt-based `everBid` flag below does NOT draw (see the note there and
      //     _finalize's derivation).
      //   - a SHADOW decision: shadow performs ZERO wire writes by construction, so a would-have-
      //     placed shot is not a placed one. It still sets lastBidPrice (the shadow trace wants the
      //     price), which is why lastBidPrice is NOT part of the close-time derivation any more.
      // DURABLE, unlike ownBidAttempts: persisted on the intent at each landed site and restored
      // above, because both consumers read it at CLOSE - by which time a mid-auction restart may have
      // rebuilt this monitor from disk.
      landedBids: priorLandedBids,
      // Restored, not defaulted to false: see priorEstablishedBeforeWindow above.
      establishedBeforeWindow: priorEstablishedBeforeWindow,
      consecutiveReadFails: 0, stoodDown: false,
      // noBid: the refusal this load took KNOWINGLY, recorded by _recordRefusal at the site that
      //   took it ({ reason, ...facts }), or null if no refusal was ever taken. Read at close by
      //   _refusalAtClose to tell an intentional zero-bid from a broken one, and to put the reason
      //   on the desk's own outcome receipt. Per-monitor and NOT persisted on the intent: a re-price
      //   (stop + armFromRequest) or a restart builds a fresh monitor, and a refusal that still
      //   applies re-records itself on the next tick, while one the desk has since fixed correctly
      //   does not. There is no value in a stale reason surviving the change that resolved it.
      noBid: null,
      // The weaker sibling of noBid: this load can still bid, but only its floor - every rung above
      // it is at or above our own standing bid. Same per-monitor, not-persisted rule and for the same
      // reason: a re-price rebuilds the ladder this fact is about.
      floorOnlyBiddable: null,
      // The desk-notice record - { episode, state } - i.e. which message about this outage already
      // went to the desk. Unlike noBid directly above it, this one SURVIVES a rebuild; see the carry.
      _authNotice: carriedAuthNotice,
      bidTimes: [], // fire timestamps for the bids/min cap
      timer: null, finalized: false,
      _openAtFrac: null, // per-auction random fraction for the jittered establish mark (rolled once)
      _wasL1: false, // tracks L1->not-L1 transitions for the 'outbid' notification
      // --- L3 soft-close / auction-extension state (inert unless softStrategy !== 'off') ---
      softStrategy, // 'off' | 'shadow' | 'live', resolved ONCE at arm
      // Mirrors of the round tracker's R and published C (ruling 56 (a)): only the tracker writes them.
      _round: round,
      extendsObserved: mirrorsRounds ? round.rounds : 0,
      extendCap: !provisional && mirrorsRounds && Number.isInteger(round.publishedCap) ? round.publishedCap : null,
      triggerWindowMs: null,       // per-load branchAuctionRemainingTime from live state; null until surfaced (fail closed - no fallback)
      believedCloseAt: restoredClose != null && !(meta.closesAt >= restoredClose) ? restoredClose
        : (meta.closesAt != null ? meta.closesAt : null), // absolute server-epoch close; FORWARD-only
      // --- shared-account bid-budget state (Tata 2026-07-21) ---
      // ownBidAttempts: bids THIS PROCESS put on the wire for this load, counted at the fire point
      //   (accepted, rejected, or thrown alike - the wire was used either way). It is the clock the
      //   foreign-bid detection reads: a rank that exists while this is still 0 cannot be ours.
      //   Deliberately NOT restored from the intent - see the rehydrate note in _tick's detection.
      ownBidAttempts: 0,
      // everBid: DURABLE "this bot has put a bid on the wire for this load", restored from the
      //   intent so it survives BOTH a restart and a re-price. ownBidAttempts is per-process and
      //   firedRungs is per-ladder; this is neither, which is exactly why the re-price hole needs it.
      everBid: priorEverBid,
      // foreignSlotUncounted: DURABLE twin, restored the same way and for the same reason as everBid
      // just above - see priorForeignSlotUncounted.
      foreignSlotUncounted: priorForeignSlotUncounted,
      // capExhausted: the PLATFORM told us the per-load budget is gone ("Bid limit exceeded").
      //   Terminal for the load: no further rung is spent, and no later state read may raise
      //   revisionsLeft back above zero (fail closed - the platform's refusal outranks our belief).
      capExhausted: false,
      // loadNotBiddable: the PLATFORM told us this load is not biddable at all ("Load not available
      //   for bidding"). Terminal for the load, and for a different reason than capExhausted: the
      //   budget is fine, there is simply nothing here to bid into. Distinguished from capExhausted
      //   deliberately - the two need different desk copy and different money semantics (a cap
      //   rejection zeroes revisionsLeft; this one must not, or a re-price would inherit a phantom
      //   exhausted budget). NOT persisted on the intent: it is SuperProcure's live state, so a
      //   re-price or a restart re-learns it on the next attempt rather than inheriting a stale
      //   verdict about a load SP may since have reopened.
      loadNotBiddable: false,
      // _delistedNoticed: the desk has been told this load looks dropped from SuperProcure's listing.
      //   A REPORTING latch and nothing more - no bidding decision reads it, unlike loadNotBiddable
      //   directly above, which is the platform's own verdict and does stop the ladder. It is shared
      //   with the post-refusal stand-down so one load produces one message either way. NOT persisted:
      //   it describes a message already sent to a live thread, and a re-price or restart re-earns it.
      _delistedNoticed: false,
      // quantityRefused / quantityRefusedAtVcq: the PLATFORM refused the vehicle COUNT we quoted
      //   ("Quote quantity is greater than total quantity"). Distinct from both latches above: the
      //   budget is intact (so revisionsLeft is deliberately NOT zeroed, same reasoning as
      //   loadNotBiddable) and the load is open to bidding - it is the quantity, and only the
      //   quantity, SuperProcure will not take.
      //   The verdict binds A COUNT, not the load, so this pair is the latch and not the boolean
      //   alone: quantityRefusedAtVcq holds the LOWEST count refused so far, and it only ever moves
      //   down, which is what bounds the retry. Null means nothing went on the wire - stand the load
      //   down outright rather than reason about a count we did not send. An ACCEPTED bid clears
      //   both, or one landed bid would freeze the auction with its ladder unspendable behind a
      //   verdict SuperProcure has just contradicted.
      //   NOT persisted on the intent, for the same reason loadNotBiddable is not: it is a live
      //   platform verdict, so a re-price or restart re-learns it rather than inheriting a stale one.
      quantityRefused: false,
      quantityRefusedAtVcq: null,
      // priceRaiseRefused / priceRaiseRefusedCap: the PLATFORM refused the price because it is
      //   ABOVE what already stands on the board - GoComet's "You've increased the quote price",
      //   or SuperProcure's numeric cap where even our floor rung sits above it (see raiseRefusal).
      //   Terminal for SUBMISSION on this load and for nothing else: the budget is intact (not
      //   zeroed, same reasoning as loadNotBiddable) and a bid of ours is standing - which is the
      //   very reason the revision is refused, and why walking the ladder down in answer concedes
      //   margin for a price the portal would refuse just the same. The cap rides alongside where
      //   the platform named one, because it is the number that settles whether any rung could ever
      //   have landed.
      //   Persisted against THIS LADDER and restored only while the ladder is unchanged - see
      //   priorRefusal above for why a restart and a re-price part company here.
      priceRaiseRefused: refusalFacts.priceRaiseRefused === true,
      priceRaiseRefusedCap: refusalFacts.priceRaiseRefusedCap != null ? refusalFacts.priceRaiseRefusedCap : null,
      // submissionClosed: the PLATFORM said the submission window is over - "Auction has already
      //   ended for this load", or GoComet's conflated closed-or-revision-limit string. Terminal for
      //   submission only: revisionsLeft is deliberately untouched (the GoComet string cannot say
      //   which of the two conditions it was) and finalizing stays the countdown's job, so this
      //   stops writing without pretending to know when the auction ended.
      submissionClosed: refusalFacts.submissionClosed === true,
      // _submissionClosedAtClose: the believed close in force when submissionClosed last latched
      //   (ruling 60). Read by _clearSubmissionClosedOnForwardMove; null when never latched.
      //   Restored with the latch. A latch carried from a record that predates the anchor falls
      //   back to this arm's close, so the first published move past it still clears it.
      _submissionClosedAtClose: refusalFacts.submissionClosed !== true ? null
        : (refusalFacts.submissionClosedAtClose != null ? refusalFacts.submissionClosedAtClose
          : (meta.closesAt != null ? meta.closesAt : null)),
      // prewireStoodDown: a bid was refused before it left the box for a reason that repeats on
      //   every attempt (see PREWIRE_RETRY_CODES), and the desk was asked to bid the load by hand.
      //   Not persisted, like the latches above: a re-price or restart re-learns it.
      prewireStoodDown: false,
      // _refusedPrice / _refusedPriceCount: how many times in a row the platform has refused this
      //   exact price. The bound the always-floor snipe never had - see cfg.refusedPriceAttempts.
      //   _refusedPriceHeld is the once-per-RUN dedupe on the hold's log line, and its lifetime has
      //   to be the run's: it is cleared wherever the other two are, both on an accepted bid and on
      //   a different price starting a new run. Clearing it on only one of those left a load that
      //   walked off one wall onto another holding the second price with no log line at all.
      //   The run is keyed on the price AND the vehicle count sent with it, because the vcq clamp
      //   re-sends one price at a corrected count and that is a quote the platform has not ruled on.
      //   _refusedPriceUnrecognised / _refusedPriceBody / _refusedPriceStatus carry the SHAPE and the
      //   platform's own words forward from the refusal to the hold one tick later, where the
      //   rejection envelope no longer exists. They decide what the stand-down is CALLED and whether
      //   ops is paged - never how many attempts it gets, which is the budget's job alone. They ride
      //   the run, so a different price starts a fresh, unprejudiced one.
      //   The run rides the ladder too, so it is carried on the same key. _refusedPriceHeld is NOT:
      //   it dedupes a log line within one run, and a fresh process owes the desk the notice again.
      _refusedPrice: refusalFacts.refusedPrice != null ? refusalFacts.refusedPrice : null,
      _refusedPriceVcq: refusalFacts.refusedPriceVcq != null ? refusalFacts.refusedPriceVcq : null,
      _refusedPriceCount: refusalFacts.refusedPriceCount != null ? refusalFacts.refusedPriceCount : 0,
      _refusedBoundTight: refusalFacts.boundTight === true,
      _refusedPriceHeld: false,
      _refusedPriceUnrecognised: refusalFacts.refusedPriceUnrecognised === true,
      _refusedPriceBody: refusalFacts.refusedPriceBody != null ? refusalFacts.refusedPriceBody : null,
      _refusedPriceStatus: refusalFacts.refusedPriceStatus != null ? refusalFacts.refusedPriceStatus : null,
      // foreignBidsDetected: a standing rank existed on this account BEFORE this process bid at all,
      //   so a bid we did not place is holding a position - i.e. the team bid from the portal. A
      //   DETECTION, never a conclusion about how many slots are gone (SP exposes no used-count).
      foreignBidsDetected: false,
      // The latest tick's decision was the rank-1 hold on the last hard-close revision, inside the final
      // window. Read at close only.
      heldLeadAtLastDecision: false,
      // --- rank-driven endgame single-shot / cadence latches (L3, rank-driven rungs) ---
      // snipeFired: the ONE decisive final-window shot has already been placed - makes the snipe
      //   single-shot (the final window is too short for a bid war). NOT persisted on the intent, so a
      //   re-arm resets it - which is safe (a fresh monitor should be able to snipe again).
      snipeFired: false,
      // _lastDefendAtExtend: the extendsObserved count at which the LAST soft-close defend fired.
      //   The defend is once-per-extension-round: we step down at most one rung per extension round,
      //   then hold until the next extension advances extendsObserved. null = no defend yet. NOT
      //   persisted (per-round cadence is a live-window concern, reset-on-re-arm is safe).
      _lastDefendAtExtend: null,
      // The roundId whose one round shot (SP pre-cap buzzer, GoComet round shot) is taken. Restored from
      // the last landed bid, so a restart or re-price does not take the same round's shot twice.
      _shotRoundId: lastLanded ? lastLanded.shotRoundId : null,
      _lastLandedAt: null,
      // Our last accepted bid as the engine saw it: { closeAt, extendsObserved, roundId, shotRoundId,
      // landingMs, triggerWindowMs, incrementMs, countdownMs, heldRank1 }. Restored from the intent on a
      // restart or re-price, minus what only the old process saw (restoredLastLanded).
      _lastLanded: lastLanded,
      provisionalClose: provisional,
      // The load's first posted close, from the durable intent (postedCloseFor), on every platform. The
      // provisional round count and the result record both read it here.
      postedCloseAt: numericOrNull(intent.postedCloseAt),
    };
    this.monitors.set(meta.id, monitor);
    // Before the armed event, so a load SuperProcure has already dropped is called out at or before
    // armedAt rather than at the snipe. See _checkDelisted - it notifies and returns; the arm below
    // proceeds untouched either way.
    this._checkDelisted(monitor);
    this.emit({ type: 'armed', auctionId: meta.id, lane: meta.lane, equipment: meta.equipment,
      gcUnconfirmedSubmissions: monitor.gcUnconfirmedSubmissions,
      units: meta.units, companyName: meta.companyName, points: meta.points || null,
      platformKey: meta.platformKey || null, // which portal - BidLogger stamps this onto closedBids
      branchName: meta.branchName || null, // D038: branch was carried on meta/the intent but never reached this event, so closedBids never carried it
      laneFreight: meta.laneFreight || null, // A3: carry SP's lane anchor onto the armed event -> closedBids doc
      // BC-28: the pricing basis (FTL/PMT) already lives on meta/the intent (see arm() above) for
      // the multi-vehicle guard, but never reached this event, so a closedBids row outliving its
      // price request had no way to tell a truck load from a per-tonne one. Display/reporting-only,
      // same class as loadCode/distanceKm below - never read by the bidding path itself.
      quoteType: meta.quoteType || null,
      // D038: the seven fields the durable closedBids record needs so an audit or export
      // reconstruction survives the price-request's ~7-day prune. Display-only, same as branchName.
      loadCode: meta.loadCode != null ? meta.loadCode : null,
      distanceKm: meta.distanceKm != null ? meta.distanceKm : null,
      weight: meta.weight != null ? meta.weight : null,
      weightUnit: meta.weightUnit || null,
      capturedAt: meta.capturedAt != null ? meta.capturedAt : null,
      marginSource: meta.marginSource || null,
      // L3: resolved rung count (fine ladders expand beyond the 3 anchors only for allowlisted shippers);
      // stamped for post-hoc validation of the ladder the monitor actually armed on. Additive field.
      rungCount: plan.ladder.length,
      ...pricing, ladder: plan.ladder, floor: plan.floor, closesInMs: monitor.closesInMs });
    if (monitor.pendingGcSubmission && !(this._gcActiveAttempts && this._gcActiveAttempts.has(monitor.pendingGcSubmission.attemptId))) {
      this._recordGcUnconfirmed(monitor, monitor.pendingGcSubmission);
    }
    this._schedule(monitor, 0);
    return monitor;
  }

  /** Map a persisted intent back to arm() arguments (pricing model preserved). */
  _intentToArm(it) {
    const meta = { id: it.auctionId, lane: it.lane, equipment: it.equipment, units: it.units,
      quoteType: it.quoteType || null, // restore the pricing basis so the multi-vehicle guard holds post-restart
      bidVehicleCount: (it.bidVehicleCount != null) ? it.bidVehicleCount : null, // restore the desk's chosen count (else bid-max default)
      companyName: it.companyName || null, branchName: it.branchName || null, points: it.points || null, laneCells: it.laneCells || null, rules: it.rules || null,
      platformKey: it.platformKey || null, // restore the portal tag so a post-restart/wake arm still stamps closedBids
      poster: it.poster || null, // restore the shipper-side contact so a post-restart / scheduled-wake win still carries it (see arm())
      shipperRef: it.shipperRef || null, // restore the OA number for the loss receipt (see arm())
      laneFreight: it.laneFreight || null, // A3: restore SP's lane anchor from the intent so a post-restart / scheduled-wake arm still carries it onto closedBids
      // D038: restore the seven display-only closedBids fields the same way
      loadCode: it.loadCode != null ? it.loadCode : null,
      distanceKm: it.distanceKm != null ? it.distanceKm : null,
      weight: it.weight != null ? it.weight : null,
      weightUnit: it.weightUnit || null,
      capturedAt: it.capturedAt != null ? it.capturedAt : null,
      marginSource: it.marginSource || null,
      // THE RESTART REPLAYS THE SAME EPOCH, which is the whole of what makes a restart a restart.
      // Reading it back unchanged is what lets arm() carry the portal's verdicts here and drop them
      // on a re-price, where armFromRequest supplies a bumped one off the price request instead.
      repriceEpoch: Number.isInteger(it.repriceEpoch) ? it.repriceEpoch : 0,
      closesAt: it.closesAt };
    if (it.roundPolicy !== undefined) meta.roundPolicy = it.roundPolicy;
    if (it.preEmptiveFloorAtRankOne !== undefined) meta.preEmptiveFloorAtRankOne = it.preEmptiveFloorAtRankOne === true;
    const inputs = (it.cost != null && Array.isArray(it.marginsPct))
      ? { cost: it.cost, marginsPct: it.marginsPct, minMarginPct: it.minMarginPct }
      : { marketRate: it.marketRate, costFloor: it.costFloor };
    // Only when the intent actually carries the key: an intent written before the grid existed must
    // resolve from config (undefined), not be pinned to "no grid" (null).
    if ('roundStep' in it) inputs.roundStep = it.roundStep;
    return { meta, inputs };
  }

  /**
   * Pre-arm an auction (gap A4): persist a 'scheduled' intent and set a durable
   * wake to arm it `armLeadMs` before its start time, so the engine is watching
   * from the first socket frame. Survives a restart through the same intent store.
   * For discovered-but-not-yet-live Syngenta auctions.
   * @param meta { id, lane, equipment, units, startsAt, closesAt }
   * @param inputs { cost, marginsPct } OR { marketRate, costFloor }
   */
  schedule(meta, inputs) {
    if (this.monitors.has(meta.id)) return this.monitors.get(meta.id); // already armed
    // A re-price routed here by a frozen "starts later" snapshot can land on a load that has already
    // bid. A fresh scheduled record over it erases the spend and parks a live auction until the
    // snapshot's start, so it is armed instead, which keeps the spend (T2 D5).
    const existing = this.scheduler.get(meta.id);
    if (existing && existing.status !== 'closed' && existing.status !== 'scheduled' && carriesSpend(existing)) {
      return this.arm(meta, inputs);
    }
    // The same heal arm() applies, so the persisted ladder and rules are in the space the wake arms in.
    const reconciledRules = reconcilePricingMode(meta.rules);
    if (reconciledRules !== meta.rules) meta = Object.assign({}, meta, { rules: reconciledRules });
    const { plan, pricing } = this._planFor(inputs, meta.rules, meta.companyName);
    this._announceFloorMarginSubstitution(meta, plan, inputs);
    const prior = this.scheduler.get(meta.id);
    const intent = this.scheduler.upsert({
      auctionId: meta.id, lane: meta.lane, equipment: meta.equipment, units: meta.units,
      quoteType: meta.quoteType || null, // basis survives the scheduled-wake round-trip (see arm())
      bidVehicleCount: (meta.bidVehicleCount != null) ? meta.bidVehicleCount : null, // desk's chosen count survives the scheduled-wake too
      companyName: meta.companyName || null,
      platformKey: meta.platformKey || null, // survives the scheduled-intent wake too (see arm())
      branchName: meta.branchName || null, // branch routing key survives the scheduled-intent wake too (a scheduled load's alerts must reach the same group its ask did)
      poster: meta.poster || null, // shipper-side contact survives the scheduled-intent wake too - a scheduled load is armed by the WAKE, so without this every pre-armed load's win would go out contact-less
      shipperRef: meta.shipperRef || null, // OA number survives the scheduled-intent wake too, same reason as poster
      points: meta.points || null,
      laneCells: meta.laneCells || null, // the lane cells survive the scheduled-intent wake too, same as points
      rules: meta.rules || null, // LoadRules survives the scheduled-intent wake, same as companyName/points
      laneFreight: meta.laneFreight || null, // A3: lane anchor survives the scheduled-intent wake too (a scheduled load's FIRST armed event comes from the wake, so the anchor must ride the intent to reach closedBids)
      // D038: the seven display-only closedBids fields survive the scheduled-intent wake too -
      // without this a pre-armed (scheduled) load's FIRST 'armed' event, fired by the wake through
      // _intentToArm, would carry none of them even though armFromRequest's meta had them.
      loadCode: meta.loadCode != null ? meta.loadCode : null,
      distanceKm: meta.distanceKm != null ? meta.distanceKm : null,
      weight: meta.weight != null ? meta.weight : null,
      weightUnit: meta.weightUnit || null,
      capturedAt: meta.capturedAt != null ? meta.capturedAt : null,
      marginSource: meta.marginSource || null,
      startsAt: meta.startsAt, closesAt: meta.closesAt,
      ...postedCloseFor(prior, meta, closeIsProvisional(this.caps)),
      ...pricing, ladder: plan.ladder,
      // upsert MERGES, so a load that already carries verdicts keeps refusalState through a schedule
      // that resets firedRungs to []. Writing the epoch here is what stops that being a hole: a
      // re-price arrives with a bumped epoch, the stale verdicts still carry the old one, and arm()
      // refuses the carry on the wake. Same value, same key, same comparison as the armed path.
      repriceEpoch: Number.isInteger(meta.repriceEpoch) ? meta.repriceEpoch : 0,
      status: 'scheduled', firedRungs: [], finalRank: null, won: null,
      ...(closeIsProvisional(this.caps) ? { roundPolicy: normaliseRoundPolicy(meta.roundPolicy) } : {}),
    });
    this.emit({ type: 'scheduled', auctionId: meta.id, lane: meta.lane, equipment: meta.equipment,
      startsAt: meta.startsAt, closesAt: meta.closesAt, ...pricing });
    this._planWake(intent);
    return intent;
  }

  /**
   * (Re)arm the wake timer that fires arm() at startsAt - armLeadMs for a scheduled intent.
   *
   * THE DEFERRED-ARM PATH, and the 2026-08-05 silent-zero-bid defect lived here. A load whose
   * snapshot says "not started yet" does not arm at capture: armFromRequest routes it to schedule(),
   * which lands here and sleeps until the snapshot's start time. Two things then went wrong.
   *
   * FIRST, it was completely silent. Nothing was logged when the wake was planned and nothing was
   * emitted (`type:'scheduled'` hits bidLogger's `default: return`), so a load could sit here for
   * the best part of an hour leaving no trace at all. On BG load 23679922 the gap between the desk
   * capturing a rate and the engine's single poll was 2,922,676 ms - 48.7 minutes - and nothing in
   * the record explained it. It was this timer. `armedAt` landed 9,976 ms before the snapshot's
   * startsAt, i.e. exactly armLeadMs, which is what identified the path.
   *
   * SECOND, and this is what actually cost the bids: every close check on this path reads the
   * FROZEN snapshot. The price-request load object is written once at first discovery and never
   * refreshed (discovery skips a load it has already seen), so if SuperProcure moved the window -
   * or the load was withdrawn and relisted - the snapshot still says "opens later, closes later"
   * while the auction is already over. The wake then armed into a dead auction, the first poll read
   * remainingMs 0, and the load closed having placed nothing. Same signature on KEI 23794211,
   * armed against a captured close of 11:45 IST when the real close was 11:29.
   *
   * So the wake now RE-READS before arming - but off the adapter's loadMeta listing cache, which the
   * discovery poll rewrites every ~30s, NOT off a live platform call. That covers the FIRST cause
   * only: a window SuperProcure moved and the listing poll has since re-read. It does NOT cover the
   * withdrawn/relisted case - loadMeta is written once per sighting and never evicted, so a delisted
   * load keeps its last-known close and a healthy local countdown, and this path arms on it exactly
   * as it did before. The read is nearly free and happens once per scheduled load, on a path with no
   * clock to beat.
   *
   * FAIL DIRECTION IS DELIBERATE: a read that fails or returns nothing still ARMS. Not arming on a
   * bad read would turn a transient blip into the exact silent forfeit this is fixing; arming and
   * polling is always recoverable, not arming is not.
   */
  _planWake(it) {
    const id = it.auctionId;
    const prev = this.scheduledTimers.get(id);
    if (prev) { clearTimeout(prev); this.scheduledTimers.delete(id); }
    this.closeUnknownHeld.delete(id); // planning a wake ends a hold; the wake re-holds if it must
    if (this.killed || this.discarded) return; // resume() re-plans
    if (this._closedPastGrace(it)) { // already closed while away -> retire
      // A throw here used to escape _planWake outright - reached from resume()'s re-plan loop, it
      // broke that loop mid-iteration and every later scheduled load got no wake at all. Contained
      // the same way the scheduled-wake retire failure is: the desk hears wake_retire_failed and
      // the caller keeps going.
      // Was silent. A load retiring here has had a rate entered by a human and will never bid, so
      // it owes the desk the same receipt every other never-bid path gives them - sent before the
      // write, because that fact holds whether or not the write lands.
      this._alertWakeRetired(it, 'plan');
      try {
        this.scheduler.update(id, { status: 'closed', won: it.won ?? null });
      } catch (err) {
        this.log.error('scheduled load found already closed but the retire write failed', {
          auctionId: id, err: (err && err.message) ? err.message : String(err) });
        this.emit({ type: 'alert', level: 'error', kind: 'wake_retire_failed', auctionId: id,
          detail: 'This auction has closed and we placed no bid, but we could not mark it as stopped in our records.',
          lane: it.lane, companyName: it.companyName || null, branchName: it.branchName || null });
      }
      return;
    }
    const fireAt = (it.startsAt || Date.now()) - this.cfg.armLeadMs;
    // TIMER_MAX CLAMP. Node fires setTimeout IMMEDIATELY for any delay above 2**31-1 ms (~24.86
    // days) - it does not sleep, it overflows. boundedParse admits a startsAt up to 30 days out
    // (MAX_PLAUSIBLE_DEADLINE_MS), so the 24.86-30 day band produced an instant wake on a load that
    // had not opened. Clamp and re-plan on wake: the re-plan is what makes a clamped sleep correct
    // rather than merely bounded.
    const raw = Math.max(0, fireAt - Date.now());
    const delay = Math.min(raw, TIMER_MAX_MS);
    const willRePlan = delay < raw;
    // The line that would have explained 23679922 outright. INFO, once per scheduled load, off the
    // hot path entirely - this timer is set at most a handful of times per load, never per tick.
    this.log.info('arm deferred to a scheduled wake', { auctionId: id, startsAt: it.startsAt || null,
      closesAt: it.closesAt || null, delayMs: delay, fireAt,
      windowMs: (it.startsAt && it.closesAt) ? (it.closesAt - it.startsAt) : null,
      clampedFrom: willRePlan ? raw : null });
    const wake = async () => {
      this.scheduledTimers.delete(id);
      if (this.killed || this.discarded) return; // resume() re-plans; a discarded engine never does
      if (this.monitors.has(id)) return;  // already armed
      const planned = this.scheduler.get(id);
      if (!planned || planned.status === 'closed' || planned.status === 'stopped') return;
      // A clamped sleep has not reached the real fire time yet - plan the next leg and stop here.
      if (willRePlan) { this._planWake(planned); return; }
      if (this._closedPastGrace(planned)) {
        this.scheduler.update(id, { status: 'closed' });
        this._alertWakeRetired(planned, 'wake');
        return;
      }
      // THE RE-READ. Everything above this line trusts the frozen price-request snapshot; this
      // reads the adapter's loadMeta listing cache instead, which the discovery poll rewrites every
      // ~30s. That freshness IS the fix, but it is a CACHE READ, NOT A LIVE PLATFORM READ, and the
      // difference decides what may be concluded below. getAuctionState subscribes and reads in the
      // same call (_ensureWatching), so on a load that was only ever scheduled no socket frame has
      // arrived yet and both closesInMs and closesAtMs fall back to the cached REST close - which is
      // blind to a live anti-snipe extension by construction. loadMeta is also never evicted, so a
      // delisted load still reports a healthy countdown. Fresher than the snapshot; not authoritative
      // about whether the auction is actually over.
      //
      // A FIELD THE PLATFORM DID NOT SEND IS NOT A VALUE, and both close fields below are read
      // through that rule rather than through a bare Number(): Number(null) is a finite 0, so an
      // UNKNOWN countdown otherwise satisfies the "already expired" test and an UNKNOWN absolute
      // close otherwise arms the monitor at epoch 1970. Unknown resolves to neither verdict - the
      // load keeps the close it was priced against and stays alive for a later read to settle,
      // which is the same fail direction the note above takes on a read that fails outright.
      let live = null;
      try {
        if (this.adapter && typeof this.adapter.getAuctionState === 'function') {
          live = await this.adapter.getAuctionState(id);
        }
      } catch (_) { live = null; }
      // Nothing captured before the await may be reused after it. `killed` and `monitors` are
      // re-checked, and the durable INTENT is re-READ rather than carried across, because it is
      // where both mutations of this window land: an operator stop writes status:'stopped', which
      // arm()'s own upsert would overwrite back to 'armed', and a re-price upserts a new cost and
      // ladder, which the pre-await copy would bid straight past at the superseded price. Only a
      // still-'scheduled' intent may be armed from here.
      if (this.killed || this.discarded || this.monitors.has(id)) return;
      const cur = this.scheduler.get(id);
      if (!cur || cur.status !== 'scheduled') {
        this.log.info('scheduled wake stood down - the intent changed while the platform read was in flight', {
          auctionId: id, status: cur ? cur.status : null });
        return;
      }
      if (live && live.ok) {
        const liveClose = plausibleCloseAt(live.closesAtMs, Date.now());
        const liveRemaining = numericOrNull(live.closesInMs);
        const dead = live.status === 'closed'
          || (liveRemaining != null && liveRemaining <= 0);
        if (dead) {
          // THE DEFECT, now named at the moment it happens instead of showing up as one poll at
          // remainingMs 0 forty minutes later. Retired without arming rather than left to
          // manufacture a zero-bid record with no explanation.
          //
          // THE VERDICT IS TERMINAL AND RESTS ON ONE CACHED SAMPLE - a known accepted risk, not a
          // settled question. `dead` derives from closesInMs/status, which per the re-read note
          // above resolve to the cached REST close at a scheduled wake, so a soft-close load still
          // running on an anti-snipe extension can read closed here and be retired while it is
          // live. There is no debounce and no retry, unlike _tick's sustained-zero finalize rule,
          // and Havells soft-close branches run in production. A close-model gate belongs here and
          // needs its own change and tests - but it must DEFER the verdict without adopting the
          // cached close as the load's real close: a prior attempt wrote that past close onto the
          // durable intent, which rehydrate() then retires on the next restart.
          this.scheduler.update(id, { status: 'closed', won: cur.won ?? null,
            finalRank: cur.finalRank ?? null });
          // A captured close already behind us moved nothing; it is the plain never-armed retire.
          if (cur.closesAt && cur.closesAt <= Date.now()) {
            this._alertWakeRetired(cur, 'wake');
            return;
          }
          this.log.error('scheduled wake found the auction already closed; retiring without arming', {
            auctionId: id, capturedCloseAt: cur.closesAt || null, platformCloseAt: liveClose,
            capturedStartsAt: cur.startsAt || null,
            lateByMs: liveClose != null ? (Date.now() - liveClose) : null });
          this.emit({ type: 'alert', level: 'error', kind: 'armed_into_closed_auction', auctionId: id,
            // A FIXED sentence, like wake_arm_failed's. engineAlerts falls through to
            // `detail: evt.kind`, so an emit without one puts the raw enum in a human's WhatsApp.
            detail: 'the auction had already closed by the time we tried to arm this load, so no bid was placed - the closing time captured when it was priced was later than the platform\'s',
            lane: cur.lane, companyName: cur.companyName || null, branchName: cur.branchName || null,
            capturedCloseAt: cur.closesAt || null, platformCloseAt: liveClose });
          return;
        }
        // The close MOVED EARLIER while we slept. Not fatal on its own - there is still time, and
        // arming with the corrected close below is the repair - but it is the fact no artifact in
        // this system could previously report, so it gets its own signal. Backward only: a forward
        // move is a soft-close extension and already has extension_observed.
        if (liveClose != null && cur.closesAt && liveClose < cur.closesAt - 1000) {
          this.log.warn('the platform close time moved EARLIER than the one captured at pricing time', {
            auctionId: id, capturedCloseAt: cur.closesAt, platformCloseAt: liveClose,
            deltaMs: liveClose - cur.closesAt });
          this.emit({ type: 'alert', level: 'warn', kind: 'close_time_moved_earlier', auctionId: id,
            detail: 'the platform moved this load\'s closing time earlier than the one captured when it was priced - we are now working to the new close',
            lane: cur.lane, companyName: cur.companyName || null, branchName: cur.branchName || null,
            capturedCloseAt: cur.closesAt, platformCloseAt: liveClose,
            deltaMs: liveClose - cur.closesAt });
        }
        // ARM ON THE LIVE CLOSE, not the captured one. Without this the monitor's countdown is wrong
        // from frame 1 and every cadence, phase and snipe decision is computed against a close that
        // has moved - which is how a load reaches its real close still sitting in 'monitoring'.
        const { meta, inputs } = this._intentToArm(cur);
        if (liveClose != null) meta.closesAt = liveClose;
        if (this._closeUnknown(meta)) { this._holdUnknownClose(cur); return; }
        this.arm(meta, inputs);
        return;
      }
      // No usable read -> arm anyway (see the fail-direction note above), unless there is no close
      // to arm against: that countdown is NaN or decades long, so the load is held instead.
      const { meta, inputs } = this._intentToArm(cur);
      if (this._closeUnknown(meta)) { this._holdUnknownClose(cur); return; }
      this.arm(meta, inputs);
    };
    const t = setTimeout(() => {
      // _wakeFailed alerts the desk BEFORE its durable retire, and that retire rethrows every fs
      // failure by design. Uncaught here it rejects a promise nobody holds. The intent stays active
      // on disk, so a restart before the close re-arms a load the desk was just told to quote by
      // hand - which is why this failure gets its own desk alert and not only a log line.
      wake().catch((e) => this._wakeFailed(id, e)).catch((e) => {
        this.log.error('scheduled wake failed and the stranded load could not be retired on disk', {
          auctionId: id, err: (e && e.message) ? e.message : String(e) });
        const it = this.scheduler.get(id);
        this.emit({ type: 'alert', level: 'error', kind: 'wake_retire_failed', auctionId: id,
          detail: 'Could not mark this load as stopped. It may start bidding again after a restart. If you bid it by hand, tell us.',
          lane: it ? it.lane : null, companyName: (it && it.companyName) || null,
          branchName: (it && it.branchName) || null });
      });
    }, delay);
    if (t.unref) t.unref();
    this.scheduledTimers.set(id, t);
  }

  /**
   * The desk receipt for a load retired on the scheduled-wake path without ever arming.
   *
   * Both retire branches in _planWake were silent, and they are the quietest lines in the engine: a
   * human had entered a rate, the desk was told "rate received", and then the load simply vanished
   * with no bid, no alert and no outcome message.
   */
  _alertWakeRetired(it, branch) {
    if (!it) return;
    this.log.warn('scheduled load retired without arming - its close had already passed', {
      auctionId: it.auctionId, closesAt: it.closesAt || null, startsAt: it.startsAt || null,
      lateByMs: it.closesAt ? (Date.now() - it.closesAt) : null, branch });
    this.emit({ type: 'alert', level: 'warn', kind: 'wake_retired_past_close', auctionId: it.auctionId,
      detail: 'this load\'s auction had already closed before we could arm it, so no bid was placed',
      lane: it.lane, companyName: it.companyName || null, branchName: it.branchName || null,
      closesAt: it.closesAt || null, branch });
  }

  /**
   * A scheduled wake that threw.
   *
   * arm() genuinely throws - a ceiling cap that alters the floor rung raises a FLOOR error - and the
   * outer catch used to make that a log line and nothing else. wake() deletes its own timer before
   * doing any work, so the load was then left with no timer, no monitor and an intent still at
   * 'scheduled': a priced load that would never bid and never be retired, which is the same silent
   * forfeit this path exists to close, reached by the error route. It is also a REGRESSION of the
   * async change - a synchronous throw here used to crash the process, and PM2 + rehydrate() were
   * built to recover the load through exactly that restart.
   *
   * THE DETAIL IS FIXED PROSE AND NEVER THE ERROR TEXT. Both reachable arm() throws embed rupee
   * figures - the capped opening rung and the operating floor - and this kind routes to the same
   * WhatsApp error channel the client's Director subscribes to. The cause belongs in the log line.
   */
  _wakeFailed(id, err) {
    this.log.error('scheduled wake failed', { auctionId: id,
      err: (err && err.message) ? err.message : String(err) });
    const it = this.scheduler.get(id);
    // A monitor exists => arm() got past creating it and the load IS being watched, so the throw
    // came from something after that point and retiring the intent would orphan a live monitor.
    const stranded = !this.monitors.has(id) && !!it && it.status !== 'closed';
    this.emit({ type: 'alert', level: 'error', kind: 'wake_arm_failed', auctionId: id,
      detail: stranded
        ? 'we hit an error arming this load at its scheduled start time, so no bid will be placed - quote it by hand if the auction is still open'
        : 'the scheduled wake for this load hit an error after it was already armed - the load itself is not stranded',
      lane: it ? it.lane : null, companyName: (it && it.companyName) || null,
      branchName: (it && it.branchName) || null });
    if (!stranded) return;
    this.scheduler.update(id, { status: 'closed', won: it.won ?? null });
  }

  /** Re-arm everything that was live before a restart. The restart-safety payoff. */
  async rehydrate() {
    // WARNING: a corrupt intents file loads as zero intents (atomicFile backs it up), silently
    // abandoning every live auction. Alert loudly instead of booting empty with no signal.
    if (typeof this.scheduler.hadLoadError === 'function' && this.scheduler.hadLoadError()) {
      this.emit({ type: 'alert', level: 'error', kind: 'intents_file_corrupt',
        message: 'durable intents file was unreadable and was backed up; live auctions before the restart were NOT re-armed - check open auctions manually' });
    }
    const active = this.scheduler.activeIntents();
    if (active.length === 0) return 0;
    // THE WRITE GATE IS THE CALLER'S, NOT THIS METHOD'S, and that placement is a pinned architectural
    // boundary rather than an oversight: scripts/test-part1-part2-seam.js asserts the engine reads
    // exactly four capabilities, and write PERMISSION is deliberately decided above it - the intake
    // path is where an arm gets refused (priceRequests, PLATFORM_BIDDING_DISABLED). Reaching for
    // caps.biddingEnabled here would move that decision into the engine, which is a Part 2 change and
    // must not arrive as a side effect of a restart fix. See rehydrateGoCometStack in src/web/server.js
    // for the gate that keeps a writes-off portal from re-arming a ladder that throws on every rung.
    // SWEEP FIRST, THEN ANNOUNCE. This used to emit and return activeIntents().length before the
    // loop retired an unknown share of them, so the count applied no close-time test at all - the
    // same fault the writes-off branch was repaired for, except this method serves the write-enabled
    // GoComet path and every SuperProcure stack. On the boot this branch exists for it read "resumed
    // 52 live auction(s)" while all 52 retired and nothing re-armed, and server.js folds the return
    // value into the boot banner, so the log line carried the same wrong number. An operator who
    // believes 52 auctions came back hand-quotes none of them.
    // Alert loudly so a restart mid-auction is visible.
    // See _research/2026-06-25_restart-recovery-and-softclose-finalize.md.
    const { retired, stillOpen, failed } = this.retirePastClose();
    const resumable = [];
    let held = 0;
    for (const it of stillOpen) {
      if (this._closeUnknown(it)) { this._holdUnknownClose(it); held += 1; } else resumable.push(it);
    }
    let unarmable = 0;
    for (const it of resumable) {
      // ONE INTENT arm() CANNOT PRICE MUST NOT ABORT THE RE-ARM - the same containment the
      // retirement sweep above already applies, for a far worse blast radius. arm() genuinely
      // throws (a BAD_INPUT floor-margin refusal, a FLOOR error from a ceiling that caps the floor
      // rung), and this loop runs under boot() through activateRealStack: an escaping throw leaves
      // `stacks` empty, boot() exits the process, and pm2 restarts it onto the identical durable
      // intent. Nothing between those restarts heals the stored record, so the loop that took one
      // load down takes the whole bidder down, permanently.
      try {
        // not yet started -> re-plan its wake instead of arming now
        if (it.status === 'scheduled') { this._planWake(it); continue; }
        // armed/bidding -> re-arm and restore which rungs already fired
        const { meta, inputs } = this._intentToArm(it);
        const m = this.arm(meta, inputs);
        // READ THE RUNGS BACK OFF THE INTENT arm() JUST REWROTE, never the raw pre-arm indices on `it`.
        // firedRungs are INDICES, and arm() remaps them BY PRICE (remapFiredRungs) precisely because a
        // rebuilt ladder may not have the same rungs at the same positions. Restoring `it.firedRungs`
        // verbatim bypassed that remap - safe only while a restart was guaranteed to rebuild a
        // byte-identical ladder, which the min-decrement derivation ends. On a ladder that lost a rung,
        // old index 1 (a middle) lands on the new index 1, which is the FLOOR: the monitor would
        // believe its decisive shot was already spent, every floor gate reads firedRungs.has(last),
        // and the bot goes dark at the buzzer on a live auction.
        const restored = (this.scheduler.get(it.auctionId) || {}).firedRungs || [];
        for (const r of restored) m.firedRungs.add(r);
        if (restored.length) m.currentRungIndex = Math.max(...restored);
      } catch (e) {
        unarmable += 1;
        this._rehydrateArmFailed(it, e);
      }
    }
    // A load that threw did not resume, and this number is read as "auctions that came back" -
    // scripts/test-rehydrate-resume-count.js pins that contract. The notice is emitted only now, after
    // every arm has run, so it states the same number (T2 D8); each failure raised its own per-load
    // alert above, which is what the desk acts on.
    const resumed = resumable.length - unarmable;
    this.emit({ type: 'alert', level: 'info',
      kind: 'restart_with_live_auctions', count: resumed, retired, held,
      message: `resumed ${resumed} live auction(s)`
        + (retired ? `, retired ${retired} that had already ended` : '')
        + (held ? `, holding ${held} whose closing time is missing or invalid` : '')
        + (failed.length ? `, ${failed.length} could not be retired` : '') });
    // The info notice above states the count, but it routes nowhere a desk-visible channel reads. This
    // is its error-class twin for loads the sweep could not retire, mirroring the GoComet writes-off
    // branch: the auctionId carries every failed id (sorted, joined), so two restarts stranding
    // different loads never collapse onto the same dedupe key.
    if (failed.length) {
      const failedIds = failed.map((it) => String(it.auctionId)).sort();
      this.emit({ type: 'alert', level: 'error', kind: 'rehydrate_retire_failed',
        auctionId: failedIds.join(','),
        detail: `we could not tidy up ${failedIds.length} auction(s) that ended while we were down, `
          + 'so the closed-auction reporting for those loads may be wrong until the next restart' });
    }
    return resumed;
  }

  /**
   * A persisted close the engine can neither race against nor retire on: absent, non-numeric, zero,
   * or past the +/-30-day plausibility bound on the future side. A close far in the PAST is not this -
   * the sweep retires it, and nothing is bid either way.
   */
  _closeUnknown(it) {
    const n = numericOrNull(it.closesAt);
    return n == null || n <= 0 || n > Date.now() + MAX_PLAUSIBLE_CLOSE_SKEW_MS;
  }

  /**
   * HOLD, never arm and never retire (owner ruling, 2026-09-20). Armed, the year-2100 placeholder is
   * a 73-year countdown and an absent close is a NaN one, which loses every comparison in _cadence
   * and polls at the snipe cadence for the life of the process. Retired, a load a human priced is
   * written off on a close nobody knows. The intent stays active, so a re-price with a real close
   * picks it up; until then the desk is the only one who can bid it.
   */
  _holdUnknownClose(it) {
    this.log.error('held a load whose closing time on record is missing or implausible - not armed, not retired', {
      auctionId: it.auctionId, status: it.status, closesAt: it.closesAt === undefined ? '(absent)' : it.closesAt });
    // Status untouched, so the load stays active for a re-price to pick up; scheduledSnapshot()
    // stops showing it as a wake that will fire.
    this.closeUnknownHeld.add(it.auctionId);
    this.emit({ type: 'alert', level: 'error', kind: 'close_unknown_held', auctionId: it.auctionId,
      detail: 'Not bidding this load: its closing time is missing or invalid. Bid it by hand if the auction is still open.',
      lane: it.lane || null, companyName: it.companyName || null, branchName: it.branchName || null });
  }

  /**
   * A durable intent the restart could not re-arm. Containment, not repair.
   *
   * The intent is deliberately left ACTIVE rather than retired: the causes are stored records a
   * human can correct (a margin band, a ceiling), and retiring the load here would mean it never
   * comes back once the record is fixed. It costs one load until then, instead of the batch.
   *
   * THE DETAIL IS FIXED PROSE AND NEVER THE ERROR TEXT, for the reason spelled out on _wakeFailed:
   * both reachable arm() throws embed rupee figures, and this kind routes to the same WhatsApp
   * error channel the client's Director subscribes to. The cause belongs in the log line.
   */
  _rehydrateArmFailed(it, err) {
    this.log.error('could not re-arm a live auction after restart', { auctionId: it.auctionId,
      err: (err && err.message) ? err.message : String(err) });
    this.emit({ type: 'alert', level: 'error', kind: 'rehydrate_arm_failed', auctionId: it.auctionId,
      detail: 'we could not re-arm this load after a restart, so no bid will be placed - quote it by hand if the auction is still open',
      lane: it.lane || null, companyName: it.companyName || null, branchName: it.branchName || null });
  }

  /**
   * The RETIREMENT half of rehydrate, without the re-arm. Returns {retired, stillOpen, failed},
   * where stillOpen is the intents that survived the sweep - the only ones a caller may truthfully
   * call "running" - and failed is the past-close intents whose durable write did not land.
   *
   * Split out because the two halves need different permission. Re-arming resumes live bidding and
   * is gated on the portal's write flag (rehydrateGoCometStack); retiring an auction that ended
   * while the process was down writes no bid, corrects a ledger record that is otherwise read as a
   * fought loss, and is correct on every portal whatever the write flag says. Running only the gated
   * half is what left the writes-off path reporting a raw activeIntents() count - which applies no
   * close-time test at all - as "auctions running before the restart", telling the desk to hand-quote
   * loads that closed weeks ago, and retiring none of them so the same wrong instruction returned on
   * every subsequent restart.
   */
  retirePastClose() {
    const active = this.scheduler.activeIntents();
    const stillOpen = [];
    const failed = [];
    let retired = 0;
    for (const it of active) {
      // ONE INTENT'S DURABLE WRITE FAILING MUST NOT ABORT THE SWEEP. Every retirement ends in
      // scheduler.update() -> _persist(), which rethrows synchronously on any fs failure, so an
      // unguarded loop handed the caller an EMPTY stillOpen the moment the first write failed - and
      // the caller's "these are still open, quote them by hand" instruction is guarded on that array
      // being non-empty. The desk lost the one instruction it could act on. A failed intent is past
      // its close, so it belongs in neither of the other two answers: it is not retired, and telling
      // anyone to go and bid it would be a second wrong answer rather than a fix for the first.
      try {
        if (this._retireIfPastClose(it)) retired += 1;
        else stillOpen.push(it);
      } catch (_) {
        failed.push(it);
      }
    }
    return { retired, stillOpen, failed };
  }

  /**
   * Retire ONE durable intent if its auction is genuinely over. True when it was retired.
   *
   * Can't read final rank back, so DON'T book a phantom loss: keep any recorded outcome, else mark
   * unknown so win/loss reporting isn't corrupted.
   *
   * A RECORDED CLOSE THAT HAS JUST PASSED IS NOT PROOF THE AUCTION IS OVER, and this branch is
   * terminal, so the doubt has to be resolved by the platform rather than by the timestamp. A soft
   * auction runs past every close it has published, and a round the engine never saw (a frozen
   * countdown, or rounds run while it was down) leaves the durable close at a time the auction has
   * outlived. Within the restart grace of a close whose OUTCOME IS STILL UNKNOWN the load is therefore left
   * alone instead - rehydrate re-arms it, and the first live read finalizes it in the ordinary way
   * if it really did close, and bids it if it did not. Past the grace, or with an outcome already on
   * the record, the close stands and closedWhileDown means what it says.
   */
  _retireIfPastClose(it) {
    if (!this._closedPastGrace(it)) return false;
    const closeAt = numericOrNull(it.closesAt);
    // An intent that already carries a RESULT is not closed-while-down - we saw how it ended and
    // only the retirement was outstanding, so it keeps the plain close it always got.
    if (it.won != null) {
      this.scheduler.update(it.auctionId, { status: 'closed',
        won: it.won, finalRank: it.finalRank ?? null, closedWhileDown: false });
      return true;
    }
    this._persistClosedWhileDown(it.auctionId, { won: null, finalRank: it.finalRank ?? null,
      meta: it, closesAt: closeAt });
    return true;
  }

  /**
   * The timestamp close test for _retireIfPastClose and both of _planWake's retires: the close has
   * passed AND the grace above no longer applies. _planWake's two retires used a bare `closesAt <= now` and so
   * retired, inside the same rehydrate(), a load this sweep had just left alone.
   */
  _closedPastGrace(it) {
    const closeAt = numericOrNull(it.closesAt);
    const pastByMs = (closeAt != null && closeAt > 0) ? Date.now() - closeAt : null;
    if (pastByMs == null || pastByMs < 0) return false;
    return !(it.won == null && pastByMs < this._restartGraceMs(it));
  }

  // Ruling 44: the saved close is a lower bound by every round still possible, so the grace covers
  // them - the rounds left under a known cap, or the uncapped bound when the round record has none.
  _restartGraceMs(it) {
    const grace = this.cfg.rehydrateGraceMs;
    const r = it.round;
    if (!r || typeof r !== 'object' || !r.cap || typeof r.cap !== 'object') return grace;
    if (r.cap.value === null) return Math.max(grace, this.cfg.uncappedRestartGraceMs);
    const left = Number.isInteger(r.cap.value) ? r.cap.value - (Number(r.rounds) || 0) : 0;
    const inc = numericOrNull(r.extendMs);
    return left > 0 && inc != null && inc > 0 ? grace + left * inc : grace;
  }

  /**
   * Poll cadence. `monitor` is OPTIONAL and additive: without it this is the deployed far/mid/hot
   * mapping, byte-for-byte. With it, one extra rule applies - and only to the loads that actually
   * have a decisive band (see _decisiveBandFor).
   *
   * WHY THE BAND HAS TO REACH THE SCHEDULER. The far/mid/hot thresholds are absolute (60s / 10s), and
   * they are the right shape for a HARD close, where the only moment that matters is the last 2.5s -
   * which the 200ms hot poll covers ~12 times over. A soft branch moves that moment: the decisive
   * shot has to land in the floorWindowMs-wide band immediately above the anti-snipe trigger window,
   * which on a real Havells branch is [100_000, 102_500] - deep inside far-poll territory, where the
   * next tick is ~30 SECONDS away. A 2,500ms target and a 30,000ms stride do not intersect except by
   * luck: measured across 2,000 cap-reached soft auctions, only 8.4% ever got a decision point inside
   * the band. On the other 91.6% the shot fell through to the deployed 2.5s answer - i.e. 97.5
   * seconds INSIDE the trigger window it exists to avoid.
   *
   * A rule the engine cannot reach is not a fix, so the band pulls the cadence in exactly the way the
   * hot threshold already does for a hard close: approach it without stepping over it, then poll hot
   * through it. Everything without a band - hard closes, soft-off loads, loads publishing no window,
   * loads whose extensions genuinely remain - keeps the deployed mapping untouched.
   */
  _cadence(closesInMs, monitor) {
    // Jitter the far/mid cadence so we never observe on a fixed metronome; keep the
    // snipe window (hot) crisp and deterministic — that timing is correctness, not stealth.
    const j = () => Math.floor(this._rand() * this.cfg.cadenceJitterMs);
    let normal;
    if (closesInMs > this.cfg.farThresholdMs) normal = this.cfg.pollFarMs + j();
    else if (closesInMs > this.cfg.hotThresholdMs) normal = this.cfg.pollMidMs + j();
    else normal = this.cfg.pollHotMs;

    if (monitor && Number.isFinite(closesInMs) && this._walkOn(monitor)) return this._walkCadence(monitor, closesInMs, normal);

    // A provisional-close load decides only in its middle band and at its buzzer. Above the buzzer the
    // next tick is aimed inside the next band rather than polled hot: a read requested between the
    // two is POLL-spaced by the GoComet adapter and would be released below the buzzer.
    if (monitor && monitor.provisionalClose && Number.isFinite(closesInMs)) {
      const buzzer = this._buzzerMs();
      if (closesInMs <= buzzer) return normal;
      if (closesInMs > PROVISIONAL_MIDDLE_AIM_MS) return Math.min(normal, closesInMs - PROVISIONAL_MIDDLE_AIM_MS);
      return closesInMs - (buzzer - PROVISIONAL_READ_INTERVAL_MS / 2);
    }

    // APPROACHING THE SOFT ESTABLISH MARK, for the same reason the decisive band below pulls the
    // cadence in: a mark the scheduler never aims at is not a mark. The soft establish gate is a
    // test on `remaining`, and _decisiveBandFor returns null for exactly this class of load
    // (softStrategy 'off'), so nothing else shortens the poll. The far bucket then strides 30,000ms
    // right up to farThresholdMs, and the tick that finally crosses the mark lands roughly uniformly
    // in (farThresholdMs - pollFarMs, farThresholdMs] - so the establish fired anywhere in
    // (~30s, 60s] regardless of what the mark was set to, and raising the knob changed nothing at
    // the bottom of that spread.
    //
    // Aim just INSIDE the mark rather than at it: the gate is `remaining <= mark`, so landing a few
    // ms above it costs a whole poll interval. Only ever SHORTENS the poll, and only while the load
    // is still unestablished - once currentRungIndex is set, the walk owns the cadence again.
    if (monitor && monitor.closeModel === 'soft' && monitor.softStrategy === 'off'
        && monitor.currentRungIndex < 0 && Number.isFinite(closesInMs)) {
      const mark = this._softEstablishThreshold(monitor);
      if (closesInMs > mark) {
        const toMark = (closesInMs - mark) + this.cfg.pollHotMs;
        if (toMark < normal) normal = Math.max(this.cfg.pollHotMs, toMark);
      }
    }

    const band = this._decisiveBandFor(monitor);
    if (band == null || !Number.isFinite(closesInMs)) return normal;

    if (closesInMs > band.opensAt) {
      // APPROACHING. Aim a quarter of the band's width past its opening edge rather than at the edge
      // itself, so ordinary poll latency and SP-clock slack in either direction cannot land us just
      // outside it. Only ever SHORTENS the poll - a load still minutes out keeps its 30s far poll.
      const width = band.opensAt - band.closesAt;
      const toTarget = (closesInMs - band.opensAt) + Math.floor(width / 4);
      if (toTarget < normal) return Math.max(this.cfg.pollHotMs, toTarget);
      return normal;
    }
    // INSIDE the band: poll hot, so the decisive shot has ~12 chances rather than one, and a tick
    // lost to a slow read does not cost the whole band.
    if (closesInMs > band.closesAt) return this.cfg.pollHotMs;
    return normal;
  }

  // The walk decides only inside its window. SuperProcure: aim a tick at close - maxWalkWindowMs, then
  // read hot (socket state). GoComet: aim each read at the next mark the walk acts on.
  _walkCadence(monitor, closesInMs, normal) {
    if (monitor.provisionalClose) {
      const aim = this._walkGcAimMs(monitor, closesInMs);
      return aim == null ? normal : Math.max(this.cfg.pollHotMs, Math.min(this.cfg.pollFarMs, aim));
    }
    const window = this.walkCfg.sp.maxWalkWindowMs;
    if (closesInMs > window) return Math.max(this.cfg.pollHotMs, Math.min(normal, closesInMs - window));
    // A step decides on the socket state, so a mark nearer than the next hot poll gets its own tick.
    const marks = this._walkMarks(monitor, closesInMs).map((m) => m.at).filter((m) => m < closesInMs);
    const next = marks.length ? Math.max(...marks) : null;
    const toMark = next == null ? Infinity : closesInMs - next;
    return Math.max(1, Math.min(normal, this.cfg.pollHotMs, toMark));
  }

  // The countdown marks the walk acts on next, each with how far ahead of it a read has to be asked for:
  // the probe lead, the prepare point and start, the deadline of the steps still wanted, the last step's
  // deadline (read-free in a confirmed GoComet final round), and GoComet's buzzer.
  _walkMarks(monitor, closesInMs) {
    const state = monitor._lastOkState;
    if (!state) return [];
    const gc = !!monitor.provisionalClose;
    const lead = gc ? PROVISIONAL_READ_INTERVAL_MS / 2 : 0;
    const t = this.walkParams(monitor, state);
    const v = this._walkVerdict(monitor);
    const noRead = this._walkNoRead(monitor, v);
    const lastDeadline = walkMath.stepDeadlineMs(1, t, { noReadSlack: noRead });
    let marks = [{ at: lastDeadline, lead: noRead ? 0 : lead }];
    // Holding rank 1 before a no-read last step: a read half a read BEFORE it, so an undercut is answered.
    if (noRead && state.myRank === 1) marks.push({ at: lastDeadline, lead: -lead });
    if (gc) marks.push({ at: this._buzzerMs(), lead });
    // Before the walk has started nothing decides above its start, so a read there is spent for nothing.
    const notAbove = (start) => { marks = marks.filter((m) => m.at <= start); };
    if (v.verdict === 'NOT_FINAL') marks.push({ at: this.walkCfg[this._walkPlatform(monitor)].probeLeadMs, lead });
    else if (gc && v.verdict === 'UNCERTAIN' && v.reason === 'uncapped_no_evidence') {
      const start = walkMath.walkStartMs(1, t);
      notAbove(start);
      marks.push({ at: start, lead });
    } else {
      const last = monitor.ladder.length - 1;
      const count = this._walkPrices(monitor, state, last).length || 1;
      const bidsLeft = gc ? monitor.revisionsLeft : this._hardCloseRevisionsLeft(monitor);
      const planned = Math.min(bidsLeft == null ? Infinity : bidsLeft, count, walkMath.maxWalkSteps(t));
      if (monitor._walkRoundId === v.roundId) {
        const steps = Math.min(planned, walkMath.stepsThatFit(closesInMs, t));
        if (steps >= 1) marks.push({ at: walkMath.stepDeadlineMs(steps, t, { noReadSlack: steps === 1 && noRead }), lead });
      } else {
        const start = walkMath.walkStartMs(planned, t);
        notAbove(start);
        marks.push({ at: start, lead });
        if (gc) marks.push({ at: start + WALK_PREPARE_LEAD_MS, lead });
      }
    }
    return marks.map((m) => ({ at: m.at - m.lead }));
  }

  // GoComet spaces reads of one enquiry 5 s apart above its decisive horizon, so polling would land its
  // reads at random points of the walk's window: the next read is aimed at the next mark instead.
  _walkGcAimMs(monitor, closesInMs) {
    const aims = this._walkMarks(monitor, closesInMs).map((m) => m.at).filter((m) => m < closesInMs);
    return aims.length ? closesInMs - Math.max(...aims) : null;
  }

  /**
   * The countdown mark (ms remaining) at which the FIRST (establish) bid fires on a
   * HARD-close auction. Base openAtMs, pushed EARLIER by a per-auction random slice of
   * openJitterMs so presence isn't established at the same mark every time (anti-detection).
   * One-sided-earlier by construction: the establish can never drift toward the floor-snipe
   * window or the latency lead. The random fraction is rolled ONCE per auction and cached, so
   * the decision is stable across ticks; openJitterMs itself is read live, so a Settings change
   * still takes effect (same fraction, new spread). Jitter 0 -> exactly openAtMs (today's
   * behaviour). A NON-allowlisted soft-close load uses _softEstablishThreshold instead, which is
   * floored at openAtMs so it can never be tighter than this; an ALLOWLISTED soft load establishes
   * LATE and uses this as the floor of its ahead-of-the-trigger-window mark
   * (max(this, triggerWindowMs + establishLeadMs)). See _decide.
   */
  _establishThreshold(monitor) {
    return this._jitteredMark(monitor, '_openAtFrac', this.cfg.openAtMs, this.cfg.openJitterMs);
  }

  /**
   * The countdown mark at which a SOFT-close, NON-allowlisted load establishes. See softOpenAtMs in
   * DEFAULTS for where the width comes from and why it is not openAtMs.
   *
   * Two floors, and both raise the mark (fire EARLIER), never lower it:
   *
   * openAtMs, so a soft window can never end up TIGHTER than the hard one - a soft portal needs at
   * least the runway a hard one does, and a misconfigured softOpenAtMs must not be able to squeeze
   * the walk.
   *
   * A KNOWN anti-snipe trigger window, plus a lead. This is the same RULE the allowlisted branch
   * applies by hand at its own establish site, not a shared implementation, and the two copies do
   * not agree everywhere - see the divergence note on _aheadOfTriggerWindow for the published-0 case
   * and for why converging them is its own change. Without this floor the mark is derived purely
   * from GoComet's budgets and then applied to every soft-close platform, and a SuperProcure branch
   * that runtime-reports soft close for a non-allowlisted customer publishes a 100-200 SECOND window
   * - so the mark would put BRL's OPENING (highest) bid inside it, self-trigger an extension, and
   * hand rivals a fresh round against a price we had just revealed. GoComet publishes no window at
   * all (null), so it keeps the softOpenAtMs mark unchanged; this only ever moves a platform that
   * tells us where its window is.
   *
   * FLOOR FIRST, THEN JITTER, and the order is load-bearing. Jittering first and flooring after
   * meant the Math.max picked the floor outright whenever the published window exceeded the top of
   * the jitter band (w >= 125,000 at shipped values), so every load on such a branch - Shriji
   * publishes 200s - fired its first bid at one identical countdown reading and the anti-fingerprint
   * spread was silently void on exactly the population that shares a live account with human
   * bidders. Adding the jitter on top of whichever base wins keeps the spread AND keeps the mark
   * clear of the window by the full lead. The cap stays sized off `base`, so the spread's magnitude
   * is the same number it was before the window is considered at all.
   */
  _softEstablishThreshold(monitor) {
    const base = Math.max(this.cfg.softOpenAtMs || 0, this.cfg.openAtMs);
    const floored = this._aheadOfTriggerWindow(monitor, base);
    return this._jitteredMark(monitor, '_softOpenAtFrac', floored, this.cfg.softOpenJitterMs,
      Math.floor(base * SOFT_OPEN_JITTER_MAX_FRACTION));
  }

  /**
   * CW-229 display-only field: the wall-clock moment the establish hold in _decide (the
   * non-allowlisted soft-close branch above) will release the first bid, or null when that hold
   * does not apply to this monitor. Write-only bookkeeping for /track - never read by _decide or
   * any other decision path, so it cannot move a bid.
   *
   * Scoped to exactly the population the hold gates: closeModel 'soft', NOT on the rank-driven
   * allowlist (softStrategy 'off' - see _resolveSoftStrategy, always one of 'off'/'shadow'/'live',
   * never undefined), and no bid landed yet (lastBidPrice == null). Hard-close and allowlisted-soft
   * loads establish on their own, differently-shaped marks and are unaffected by this fix, so they
   * report null here and /track renders them exactly as before.
   *
   * "By", never "in Xm": _softEstablishThreshold only ever grows (see _jitteredMark - one-sided
   * EARLIER), so for a fixed close this mark only ever moves earlier, and an extension that pushes
   * closesAt later is exactly the re-derivation the caller repeats on every read. The result is
   * always a genuine upper bound, never a guess.
   *
   * believedCloseAt FIRST, same reason as raiseAuthDeadIfLoggedOut (see its comment): meta.closesAt
   * is the ARM-time close and a confirmed extension moves only believedCloseAt, forward-only. GoComet
   * extensions are exactly the case this field exists to survive, so reading meta.closesAt alone
   * would show a stale, too-early time on every load that has actually extended.
   */
  _pendingFirstBidAtMs(monitor) {
    if (monitor.lastBidPrice != null) return null;
    if (monitor.provisionalClose) return null;
    if (monitor.closeModel !== 'soft' || monitor.softStrategy !== 'off') return null;
    const closesAt = monitor.believedCloseAt != null ? monitor.believedCloseAt
      : (monitor.meta && monitor.meta.closesAt);
    if (!Number.isFinite(closesAt)) return null;
    return closesAt - this._softEstablishThreshold(monitor);
  }

  /**
   * Display-only, for /track: the believed close of an unbid provisional-close load, whose bids go
   * only in the last seconds of a round. Null for every other monitor.
   */
  _lastSecondsCloseMs(monitor) {
    if (!monitor.provisionalClose || monitor.lastBidPrice != null) return null;
    const closesAt = monitor.believedCloseAt != null ? monitor.believedCloseAt
      : (monitor.meta && monitor.meta.closesAt);
    return Number.isFinite(closesAt) ? closesAt : null;
  }

  /**
   * Raise a candidate establish mark clear of this load's own published anti-snipe trigger window, by
   * NON_ALLOWLISTED_ESTABLISH_LEAD_MS. One definition with ONE caller - the non-allowlisted establish
   * mark - which rejects a non-positive window, because a published 0 means "a hard window wearing a
   * soft close model": it has no anti-snipe mechanic to dodge and must not push the mark out.
   *
   * Returns the mark untouched when the window is UNKNOWN. No window is ever fabricated (D6), and
   * leaving the mark alone is the answer that keeps every caller on its own reasoning. GoComet
   * publishes no window at all, so this is a no-op there.
   *
   * NOT ROUTED THROUGH THE ALLOWLISTED BRANCH, deliberately, and the two now differ on more than
   * shape. That branch's hand-written copy accepts a published 0 and computes
   * max(estThreshold, 0 + establishLeadMs), so converging it here would move the establish mark for
   * the eleven allowlisted SuperProcure shippers on any branch reporting a 0 window - live money, on
   * a path this change has no mandate over and no measurement for. It also reads the OPERATOR knob,
   * which is right for it and wrong here: the allowlisted endgame is opt-in, so an operator tuning
   * SP_SOFT_ESTABLISH_LEAD_MS is tuning a feature that shipper agreed to, while the same read on
   * this path steered customers who opted into nothing. The engine's own doctrine elsewhere
   * (_softFinalShotBand) treats 0 as "no anti-snipe mechanic", which suggests that copy is the
   * drifted one, but proving that and changing it is its own change with its own evidence. Until
   * then the divergence is documented, not silent.
   */
  /**
   * Surface this load's published anti-snipe trigger window onto the monitor. THE only writer of
   * that field, called from _tick's per-tick fact refresh.
   *
   * It used to live inside _observeExtension, below the point where it returns for
   * `softStrategy === 'off'` and for `closeModel !== 'soft'`. That return is right for the rest of that
   * function - counting extension rounds is soft-endgame bookkeeping - but it also meant the window
   * was never written for a load NOT on the soft-close allowlist, which is precisely the class whose
   * establish mark has to read it (_aheadOfTriggerWindow). The floor was therefore dead code on the
   * only loads it exists for, and the suite did not catch it because the tests assigned the field by
   * hand. The window is a published fact about the load, not a soft-endgame decision, so it belongs
   * out here where every load sees it.
   */
  _surfaceTriggerWindow(monitor, state) {
    if (state && state.triggerWindowMs != null && Number.isFinite(state.triggerWindowMs)) {
      monitor.triggerWindowMs = state.triggerWindowMs;
    }
  }

  _aheadOfTriggerWindow(monitor, mark) {
    const w = monitor.triggerWindowMs;
    if (w == null || !Number.isFinite(w) || w <= 0) return mark;
    return Math.max(mark, w + NON_ALLOWLISTED_ESTABLISH_LEAD_MS);
  }

  /**
   * A countdown mark, spread by a per-monitor random slice of `jitterMs` that is rolled ONCE and
   * cached under `cacheKey`, so the mark is stable for the life of the monitor while the spread
   * itself stays read-live (a Settings change takes effect on the same fraction).
   *
   * One-sided EARLIER by construction - the jitter is only ever ADDED to `baseMs`, so no
   * configuration of any caller's two knobs can push a mark toward the close, the write budget or
   * the floor window. `maxJitterMs` bounds the one direction that is unsafe: the sibling
   * `openJitterMs` is bounded 0-15000 at write time by AD_LIMITS in configStore, but a caller whose
   * knob is env-only never passes through that validator, and there a unit slip
   * (SP_SOFT_OPEN_JITTER_MS=900000, "15 minutes" in seconds) would silently walk the mark out to
   * a quarter of an hour and restore the very defect the mark exists to remove.
   */
  _jitteredMark(monitor, cacheKey, baseMs, jitterMs, maxJitterMs = null) {
    if (monitor[cacheKey] == null) monitor[cacheKey] = this._rand();
    let jitter = Math.max(0, Number(jitterMs) || 0);
    if (maxJitterMs != null) jitter = Math.min(jitter, Math.max(0, maxJitterMs));
    return baseMs + Math.floor(monitor[cacheKey] * jitter);
  }

  _schedule(monitor, delayMs) {
    if (monitor.finalized || this.killed || this.discarded) return;
    if (monitor.timer) clearTimeout(monitor.timer);
    monitor.timer = setTimeout(() => this._runTick(monitor), delayMs);
    if (monitor.timer.unref) monitor.timer.unref();
  }

  async _runTick(monitor) {
    // resume() re-plans every live monitor at delay 0 without knowing whether its tick is parked on
    // a platform read. That parked tick re-plans itself when it finishes, so starting another here
    // would put a second chain on the load.
    if (monitor._tickInFlight) return;
    monitor._tickInFlight = true;
    monitor._tickReadOk = false;
    try {
      await this._tick(monitor);
      // A failed read neither counts as a fault nor ends a run of them: only a tick that actually
      // checked the load does.
      if (monitor._tickReadOk) monitor._tickFaults = 0;
    } catch (e) {
      this._tickFaulted(monitor, e);
    } finally {
      monitor._tickInFlight = false;
    }
  }

  /**
   * A tick threw past its own handlers. The load keeps being watched and ops hears once per run of
   * faults with no successful check between them; at TICK_FAULT_HANDOFF_AT in such a run the load
   * goes to the desk instead.
   */
  _tickFaulted(monitor, err) {
    if (monitor.finalized) { this._tickFaultedAfterFinalize(monitor, err); return; }
    monitor._tickFaults = (monitor._tickFaults || 0) + 1;
    if (monitor._tickFaults === 1) monitor._tickFaultSince = Date.now();
    this.log.error('tick threw outside its own handlers', {
      auctionId: monitor.auctionId, consecutiveFaults: monitor._tickFaults,
      error: String((err && err.stack) || err) });
    if (monitor._tickFaults >= TICK_FAULT_HANDOFF_AT) {
      this._handTickFaultToDesk(monitor);
      return;
    }
    if (monitor._tickFaults === 1) {
      this.emit({ type: 'alert', level: 'error', kind: 'tick_fault', auctionId: monitor.auctionId,
        faultSince: monitor._tickFaultSince,
        detail: `Load ${monitor.auctionId}: a check on this load failed on our side. We are still watching it `
          + `and will check again shortly. If ${TICK_FAULT_HANDOFF_AT} checks in a row fail, we will stop bidding `
          + 'it and ask the desk to bid it by hand.',
        lane: monitor.meta.lane, companyName: monitor.meta.companyName,
        branchName: monitor.meta.branchName || null });
    }
    // Not _cadence: the fault may be _cadence itself, and it would throw again here. Time left comes
    // from the close itself: closesInMs is only refreshed by a tick that gets past the read, so after
    // an early fault it is as old as the last good tick.
    const closeAt = numericOrNull(monitor.believedCloseAt) ?? numericOrNull(monitor.meta.closesAt);
    const ms = closeAt != null ? closeAt - Date.now() : monitor.closesInMs;
    let retryMs = this.cfg.pollHotMs;
    if (ms > this.cfg.farThresholdMs) retryMs = this.cfg.pollFarMs;
    else if (ms > this.cfg.hotThresholdMs) retryMs = this.cfg.pollMidMs;
    this._schedule(monitor, retryMs);
  }

  /**
   * A tick faulted on a monitor that is no longer watching its load, so no retry or hand-off can
   * follow and none may be promised. A monitor still registered here finalized itself mid-tick
   * (its close could not be recorded), and ops is told to check the result on the portal. One an
   * operator stopped, or a re-price replaced, has nothing left to report: the load is already
   * someone else's.
   */
  _tickFaultedAfterFinalize(monitor, err) {
    const id = monitor.auctionId;
    const current = this.monitors.get(id) === monitor;
    this.log.error('tick threw after its monitor stopped watching the load', {
      auctionId: id, stillRegistered: current, error: String((err && err.stack) || err) });
    if (!current) return;
    this.emit({ type: 'alert', level: 'error', kind: 'tick_fault', auctionId: id, faultSince: Date.now(),
      detail: `Load ${id}: this load reached its close but a fault on our side stopped us recording the `
        + 'result. We are no longer watching it. Please check its result on the portal.',
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null });
  }

  /**
   * Stop watching a load whose ticks keep faulting and tell its desk group to bid it by hand. The
   * intent leaves the active set so a restart cannot re-arm a load the desk now owns. No outcome is
   * written: nothing here knows how the auction ends.
   */
  _handTickFaultToDesk(monitor) {
    const id = monitor.auctionId;
    this.stop(id);
    try {
      this.scheduler.update(id, { status: 'stopped', stopReason: 'tick_fault_handoff' });
    } catch (e) {
      this.log.error('could not save the desk hand-off; a restart would re-arm this load', {
        auctionId: id, error: String(e && e.message) });
      this.emit({ type: 'alert', level: 'error', kind: 'tick_fault_handoff_unsaved', auctionId: id,
        faultSince: monitor._tickFaultSince,
        detail: `Load ${id}: we handed this load to the desk but could not save that. `
          + 'A restart would start bidding it again alongside the desk.',
        lane: monitor.meta.lane, companyName: monitor.meta.companyName });
    }
    const standing = monitor.landedBids > 0 && monitor.lastBidPrice != null;
    this.emit({ type: 'alert', level: 'error', kind: 'tick_fault_handoff', auctionId: id,
      faultSince: monitor._tickFaultSince, consecutiveFaults: monitor._tickFaults,
      landedBids: monitor.landedBids || 0,
      standingBidPrice: standing ? monitor.lastBidPrice : null,
      myRank: monitor.myRank != null ? monitor.myRank : null,
      closesAt: numericOrNull(monitor.believedCloseAt) ?? numericOrNull(monitor.meta.closesAt),
      detail: `Load ${id}: ${monitor._tickFaults} checks in a row failed on our side, so we stopped bidding `
        + 'this load and asked the desk to bid it by hand.',
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null, laneCells: monitor.meta.laneCells || null });
  }

  /**
   * Has this load been unreadable for longer than any still-running auction could explain?
   *
   * Measured against the BELIEVED close, not the one captured at arm time. believedCloseAt only ever
   * advances on reads that SUCCEEDED, so it is exactly "the last close the platform actually told us
   * about" - which is the only close a failing read path is entitled to reason from. Falling back to
   * meta.closesAt covers a monitor that never got a good read at all.
   *
   * An UNKNOWN close does NOT mean no bound. There is no close to measure age past, but there is
   * still a clock the engine owns: how long this load has been continuously unreadable. Returning
   * false outright left exactly one silent-forever path in the change that exists to remove them -
   * a load whose close was never learned, on a portal that stops answering, keeps a live timer and
   * an armed intent for the lifetime of the process, and after the single repeated_read_failures
   * alert at the fifth failure nothing ever speaks about it again. The project's price-page gate
   * calls a currently-silent failure mode unacceptable, and that verdict does not except this branch.
   *
   * So the fallback measures the outage instead of the auction. It is strictly weaker evidence - an
   * unreadable load might still be running - which is why it is the fallback and not the rule, and
   * why it uses the same generous bound rather than a shorter one.
   */
  _unreadablePastBound(monitor) {
    const bound = this.cfg.unreadableRetireMs;
    if (!Number.isFinite(bound) || bound <= 0) return false;
    // plausibleCloseAt rejects a believed close more than 30 days from now in either direction -
    // SuperProcure's year-2100 placeholder included - so a load carrying one falls through to the
    // outage-clock arm below instead of measuring age against a close 74 years away that never comes.
    const closeAt = plausibleCloseAt(numericOrNull(monitor.believedCloseAt)
      ?? numericOrNull(monitor.meta && monitor.meta.closesAt), Date.now());
    if (closeAt != null && closeAt > 0) return Date.now() - closeAt >= bound;
    const failingSince = numericOrNull(monitor._firstReadFailAt);
    if (failingSince == null) return false;
    return Date.now() - failingSince >= bound;
  }

  /**
   * Give up on a load the portal will not answer for, LOUDLY.
   *
   * Deliberately NOT _finalize: that path takes an authoritative final read and books a real result,
   * and there is no read to be had here. What this knows is only that the auction is over and the
   * outcome was never seen, which is the same thing the restart sweep knows - so it lands in the
   * same closedWhileDown shape and surfaces through the same 'unknown' status rather than inventing
   * a loss.
   *
   * The alert is error-level and desk-visible because this is the runtime-only bucket of the
   * price-page gate: nothing at submit time could have predicted the portal going dark, so the
   * failure has to be rare and loud rather than a log line. THE DETAIL IS FIXED PROSE - this kind
   * routes to the same WhatsApp error channel the client's Director reads, and no ladder price or
   * load-specific figure belongs on it.
   */
  _retireUnreadable(monitor) {
    if (monitor.finalized) return;
    monitor.finalized = true;
    monitor.finalizedAt = Date.now(); // A091: starts this monitor's retention clock (see snapshot())
    if (monitor.timer) clearTimeout(monitor.timer);
    this._clearWalkTimers(monitor);
    monitor.status = 'closed';
    this.log.warn('load unreadable past its close - retiring as unknown', {
      auctionId: monitor.auctionId, consecutiveReadFails: monitor.consecutiveReadFails,
      believedCloseAt: monitor.believedCloseAt || null, boundMs: this.cfg.unreadableRetireMs });
    // THE RETIREMENT IS UNCONDITIONAL; ONLY THE MESSAGE IS GATED. The trigger is per-load, but the
    // cause that makes reads fail is almost always one global thing - an auth outage, a portal 5xx,
    // a rate-limit wall, an expired token. Every load armed across it retires a bound past its own
    // close, so an ungated emit scales the message count with loads in flight rather than with
    // faults: thirty stranded loads, thirty error-class messages on the channel that reaches the
    // client's Director, all symptoms of one outage. That is the 2026-08-04 fan-out (41 emits, 56
    // messages) arriving through a new door, and engineAlerts dedupes this kind per auctionId, so
    // nothing downstream collapses it either.
    //
    // THE CLOCK IS THE ENGINE'S OWN, not the adapter's auth latch. The gate that stood here was
    // `_authDeadNow() && _authDeadWithinBound()`, and _authDeadNow feature-detects adapter.isAuthDead
    // - a method gocometAdapter does not declare, so on the portal this whole path was written for it
    // was false unconditionally and consolidated nothing. It was only partial on SuperProcure too:
    // realAdapter derives authState from token expiry and 401/403 latching alone, so two of the four
    // causes named above (a 5xx storm, a rate-limit wall) left it false. An outage-scoped stamp is
    // true on both platforms and for every cause, which is what the borrowed latch could not be.
    //
    // A CONSOLIDATION, NOT A SILENCE, which is what the price-page gate turns on: the per-load log
    // line and the ledger write are untouched, the load reads as unknown on History, both exports and
    // the EOD, and the count retired quietly inside the window rides the NEXT message instead of
    // being discarded - which is more than the auth gate it replaces did.
    const now = Date.now();
    const windowMs = this.cfg.unreadableAnnounceWindowMs;
    const bounded = Number.isFinite(windowMs) && windowMs > 0;
    if (!bounded || this._unreadableAnnouncedAt == null || (now - this._unreadableAnnouncedAt) >= windowMs) {
      const folded = this._unreadableFolded;
      const foldedIds = this._unreadableFoldedIds;
      this._unreadableAnnouncedAt = now;
      this._unreadableFolded = 0;
      this._unreadableFoldedIds = [];
      this._clearUnreadableFlushTimer();
      // THE FOLDED LOADS ARE NAMED, not merely counted. The instruction this alert gives is "check
      // the portal", and engineAlerts dedupes the kind per auctionId, so a bare "(N more)" told the
      // desk a number with no way to reconstruct which loads it was being asked to check - and
      // nothing downstream carried them either. A load id is not a rupee figure; it is the one
      // load-specific value that makes the instruction actionable.
      this.emit({ type: 'alert', level: 'error', kind: 'unreadable_past_close_retired',
        auctionId: monitor.auctionId,
        detail: 'This load stopped showing on the portal after close, so we stopped watching it. Result unknown - please check the portal'
          + (folded > 0 ? ` (${folded} more were stopped the same way since the last message: ${foldedIdList(foldedIds, folded)})` : ''),
        lane: monitor.meta.lane, companyName: monitor.meta.companyName || null,
        branchName: monitor.meta.branchName || null });
    } else {
      this._unreadableFolded += 1;
      if (this._unreadableFoldedIds.length < UNREADABLE_FOLDED_ID_CAP) {
        this._unreadableFoldedIds.push(String(monitor.auctionId));
      }
      // NO SUCCESSOR IS GUARANTEED. See _flushUnreadableFolded - one shot for the remainder of the
      // window, so the tail of an outage is spoken rather than discarded.
      this._armUnreadableFlushTimer(Math.max(0, windowMs - (now - this._unreadableAnnouncedAt)));
    }
    const prior = this.scheduler.get(monitor.auctionId);
    this._persistClosedWhileDown(monitor.auctionId, {
      won: (prior && prior.won != null) ? prior.won : null,
      finalRank: (prior && prior.finalRank != null) ? prior.finalRank : null,
      meta: monitor.meta,
      monitor, // lets a failed intent write route through _recordWriteFailed below
      closesAt: numericOrNull(monitor.believedCloseAt)
        ?? numericOrNull(monitor.meta && monitor.meta.closesAt),
    });
  }

  _clearUnreadableFlushTimer() {
    if (this._unreadableFlushTimer) clearTimeout(this._unreadableFlushTimer);
    this._unreadableFlushTimer = null;
  }

  /** One shot, unref'd so it never holds the process open, and never stacked on itself. */
  _armUnreadableFlushTimer(ms) {
    if (this._unreadableFlushTimer) return;
    const t = setTimeout(() => {
      this._unreadableFlushTimer = null;
      this._flushUnreadableFolded();
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    this._unreadableFlushTimer = t;
  }

  /**
   * Speak the retirements the announce window folded, when no successor arrives to carry them.
   *
   * The window consolidates by making the quiet count ride the NEXT message, which holds only while
   * another retirement follows - and it is least likely to at the TAIL of an outage, where the last
   * loads abandoned are precisely the ones with no successor. Those were announced nowhere: the count
   * was drained only by a later retirement passing the window check, and the read path clearing
   * monitor._firstReadFailAt reset the outage clock without touching it. A live auction the engine
   * had given up on could therefore go permanently unspoken, which is the price-page gate's
   * unacceptable bucket.
   *
   * Two drains, both cheap: the portal answering again (the outage is over, nothing more is coming)
   * and a one-shot timer one window long (the outage is not over, and the desk has waited long
   * enough). The auctionId is the first folded load's, so engineAlerts' per-auction dedupe gives each
   * drain its own key rather than one 'global' key that would collapse every future drain into the
   * first one ever sent.
   *
   * IN-MEMORY ONLY, deliberately. A restart still drops a pending fold count, exactly as it always
   * did; closing that needs a durable store the announce clock is not, and is a different change.
   */
  _flushUnreadableFolded() {
    if (!this._unreadableFolded) return;
    const folded = this._unreadableFolded;
    const ids = this._unreadableFoldedIds;
    this._unreadableFolded = 0;
    this._unreadableFoldedIds = [];
    this._unreadableAnnouncedAt = Date.now();
    this._clearUnreadableFlushTimer();
    this.emit({ type: 'alert', level: 'error', kind: 'unreadable_past_close_retired',
      auctionId: ids[0] || null,
      detail: `we could not read ${folded} load(s) from the portal for a long time after their close time, so we stopped watching them - the results are unknown, check the portal: ${foldedIdList(ids, folded)}`,
      lane: null, companyName: null, branchName: null });
  }

  /**
   * Record "this auction ended and we never saw how" on BOTH durable stores.
   *
   * The intent write alone is not enough and that was the reporting half of this bug. closedWhileDown
   * lived only on the scheduler's intents file, which no reporting surface reads; the closed-bids
   * record - the one exportModel joins against - kept its pre-restart shape, i.e. landed bids and no
   * rank, which deriveStatus could only read as a loss. The event is what carries the flag across to
   * the ledger, through the same onEvent -> bidLogger seam every other engine fact travels on.
   *
   * NOT an auction_result, deliberately. That type coerces won to a boolean and routes a won/lost
   * receipt to WhatsApp, so replaying 52 orphans through it would have told the desk it lost 52
   * auctions - a louder version of exactly the wrong answer this exists to remove.
   */
  _persistClosedWhileDown(auctionId, { won = null, finalRank = null, meta = null, closesAt = null, monitor = null } = {}) {
    // The intent write is best-effort here, not a gate, ONLY when a monitor can own the write-fault
    // alert (the live _retireUnreadable path): the ledger event below is what the closed-bids record
    // (and every export that joins against it) actually reads, so it must still go out even when the
    // durable intent could not be marked - the same fail direction _planWake's own retire failure
    // takes. With no monitor (the boot-time rehydrate sweep, before any monitor exists) the write's
    // own failure is left to propagate exactly as before: retirePastClose() already contains it per
    // intent and rehydrate() already raises its own rehydrate_retire_failed alert for the batch -
    // swallowing it here would silently double-count the intent as retired.
    if (monitor) {
      try {
        this.scheduler.update(auctionId, { status: 'closed', won, finalRank, closedWhileDown: true });
      } catch (err) {
        this._recordWriteFailed(monitor, 'close_record_failed',
          'This auction has closed, but we could not save that to our records. Please check this load on the portal.',
          err, { won, finalRank });
      }
    } else {
      this.scheduler.update(auctionId, { status: 'closed', won, finalRank, closedWhileDown: true });
    }
    // closesAt rides the event because the LEDGER'S closedAt is read downstream as the auction's own
    // close time, not as a bookkeeping stamp: exportModel feeds it into auctionCloseAt, which is the
    // default basis for every date filter and the Auction Date/Time column in both exports. Without
    // it the record falls back to the emit instant, so a boot sweep would date every load it retires
    // to the restart - the 52 orphans all landing on deploy day, and dropping out of a filter for
    // the week they actually ran.
    this.emit({ type: 'closed_while_down', auctionId, won, finalRank, closesAt,
      lane: (meta && meta.lane) || null, companyName: (meta && meta.companyName) || null,
      branchName: (meta && meta.branchName) || null });
  }

  /**
   * Has SuperProcure stopped listing this load? Called before arming and on every armed tick, and it
   * NOTIFIES ONLY - the monitor stays armed, the ladder is untouched, and the snipe still fires.
   *
   * WHAT IT REPLACES. realAdapter's loadMeta is written once per sighting and never evicted, so a
   * load SuperProcure has dropped keeps a healthy local countdown and the engine learns nothing until
   * the platform refuses its snipe. On load 25084674 the last listing was 4.9 minutes before the arm
   * and the desk got the news 25 seconds before close. Across the 24 loads carrying that signature,
   * 23 landed zero bids; of the 13 in scope every one was ALREADY absent from the listing at arm
   * time, and 10 gave the desk under 40 seconds. The facts to call it were on hand the whole time -
   * listingTrace's only call site was the post-rejection telemetry block in _maybeBid.
   *
   * THREE CONDITIONS, each load-bearing:
   *   - NO BID HAS LANDED. The control group is 17 loads that stood down carrying biddingOn true and
   *     15 of them bid normally, so biddingOn alone does not separate the populations. A load with
   *     money already on the board is not this case whatever the listing says.
   *   - the cached listing said NOT open to bidding. Absent (null) is UNKNOWN, never false.
   *   - that listing is older than delistedStaleMs. A null age means this adapter has never listed
   *     the load - the post-restart arm-from-durable-intent case - and must read as UNKNOWN.
   *
   * NOTIFY AND STAY ARMED is a decision, not a default. The verdict rests on a cache the discovery
   * poll has merely stopped refreshing, so standing down would forfeit a relist on a guess; arming
   * and polling is recoverable and not arming is not, which is the same fail direction _planWake
   * already takes on a failed read. Nothing here writes a latch _maybeBid reads and nothing records a
   * refusal - a refusal recorded on a load that later relists and wins would be a false receipt.
   *
   * The platform's own refusal remains the authority. When it arrives, the stand-down in _maybeBid
   * records the reason and stands the load down as before; it just no longer sends a second desk
   * message about a load this one has already reported.
   */
  _checkDelisted(monitor) {
    if (monitor._delistedNoticed) return;
    if (monitor.landedBids > 0 || monitor.everBid) return;
    let trace = null;
    try {
      if (this.adapter && typeof this.adapter.listingTrace === 'function') {
        trace = this.adapter.listingTrace(monitor.auctionId) || null;
      }
    } catch (_) { return; }
    if (!trace) return;
    if (trace.lastSeenInListAgoMs == null) {
      // Never listed by this adapter (the post-restart arm). BC-15 Fix B originally probed the
      // portal for every one of these, once each, the moment they armed - on a restart that is one
      // board-wide read per armed load fired at once on the shared live account (ruling 65; broke
      // test-rejection-classify-contract.js C1 and test-submit-leg-network-fails-closed.js check 7,
      // both frozen read-cost contracts). Judged instead off the first full listing that completes
      // after THIS monitor armed - normally the discovery poll the stack already runs, so most
      // never-listed loads cost nothing extra. Only a load still unlisted once the bound below
      // elapses falls back to a probe of its own.
      let lastFullListingAt = null;
      try {
        if (this.adapter && typeof this.adapter.lastFullListingAt === 'function') {
          lastFullListingAt = this.adapter.lastFullListingAt();
        }
      } catch (_) { return; }
      if (lastFullListingAt != null && lastFullListingAt >= monitor.armedAt) {
        // A full listing ran after arm and the load is still absent (else trace.lastSeenInListAgoMs
        // above would not be null) - the same verdict the probe below reaches, read for free.
        this._markNotOpenAtArm(monitor, { stillListed: false, listedBiddingOn: null });
        return;
      }
      if (!monitor._listingProbed && this.adapter && typeof this.adapter.listingProbe === 'function'
          && Date.now() - monitor.armedAt >= this.cfg.neverListedProbeBoundMs) {
        monitor._listingProbed = true;
        this._probeNeverListed(monitor).catch(() => {});
      }
      return;
    }
    const ageMs = trace.lastSeenInListAgoMs;
    if (ageMs == null || trace.biddingOn == null || trace.biddingOn) return;
    if (ageMs <= this.cfg.delistedStaleMs) return;
    monitor._delistedNoticed = 'watching';
    this.log.warn('SuperProcure has stopped listing this load as open to bidding; telling the desk now instead of at the snipe', {
      auctionId: monitor.auctionId, lastSeenInListAgoMs: ageMs, biddingOn: trace.biddingOn,
      thresholdMs: this.cfg.delistedStaleMs, landedBids: monitor.landedBids,
      closesInMs: monitor.closesInMs });
    this.emit({ type: 'alert', level: 'warn', kind: 'load_not_biddable', auctionId: monitor.auctionId,
      // lane/companyName/branchName are the SCOPE keys - without a shipper on the payload no scoped
      // customer group can match, and the notice reaches nobody.
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null,
      lastSeenInListAgoMs: ageMs, biddingOn: trace.biddingOn,
      // No live probe here, unlike the stand-down: this fires while the auction is still running and
      // must not put a REST read on the money path. stillListed stays UNKNOWN rather than guessed.
      stillListed: null, listedBiddingOn: null,
      // This is an INFERENCE off a listing cache that stopped refreshing, not a platform refusal -
      // the engine stays armed and will still fire the snipe. Distinguishes the copy from the two
      // sibling emits of this same kind (a real SuperProcure refusal), which never set this.
      stillWatching: true });
  }

  /** The load_not_biddable notice for a never-listed load, shared by the fast (trace) and fallback
   * (probe) routes in _checkDelisted so both land the same desk-visible shape. */
  _markNotOpenAtArm(monitor, { stillListed, listedBiddingOn }) {
    if (monitor._delistedNoticed || monitor.landedBids > 0 || monitor.everBid) return;
    monitor._delistedNoticed = true;
    // Read at close only, and only when nothing of ours landed: a load that relists and bids is fine.
    monitor._notOpenAtArm = true;
    this.log.warn('SuperProcure is not offering this load for bidding; telling the desk at arm', {
      auctionId: monitor.auctionId, stillListed, listedBiddingOn });
    this.emit({ type: 'alert', level: 'warn', kind: 'load_not_biddable', auctionId: monitor.auctionId,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null,
      lastSeenInListAgoMs: null, biddingOn: null,
      stillListed, listedBiddingOn });
  }

  async _probeNeverListed(monitor) {
    const p = await this.adapter.listingProbe(monitor.auctionId);
    if (!p || monitor.finalized || this.killed) return;
    const notOpen = p.stillListed === false || (p.stillListed === true && p.biddingOn != null && !p.biddingOn);
    if (!notOpen) return;
    this._markNotOpenAtArm(monitor, { stillListed: p.stillListed, listedBiddingOn: p.biddingOn });
  }

  async _tick(monitor) {
    if (monitor.finalized || this.killed || this.discarded) return;
    // Above the platform read on purpose: the delisted case is exactly the one where getAuctionState
    // keeps answering healthily off a cache the discovery poll has stopped refreshing, and a load
    // whose reads have started failing outright deserves the notice too.
    this._checkDelisted(monitor);
    // The no-read shot decides on our own submit response when one is queued: the read before that
    // write has neither its rank (260928DDQK) nor the round it opened (260928J43Q).
    let state = this._consumeResponseState(monitor);
    if (this._walkClockShotDue(monitor, state)) {
      const shot = state ? this._withTrackerClose(monitor, state) : this._walkShotState(monitor);
      if (state) { monitor._lastOkState = shot; monitor._lastOkAt = Date.now(); }
      await this._attemptBid(monitor, shot);
      return this._schedule(monitor, this._cadence(this._provisionalRemainingMs(shot), monitor));
    }
    const fromResponse = !!state;
    if (!state) {
      try {
        state = await this.adapter.getAuctionState(monitor.auctionId);
      } catch (e) {
        state = { ok: false, error: String(e && e.message) };
      }
    }
    // Same rule as the scheduled wake: nothing captured before the await may be reused after it. A
    // stop, re-price or retire landing during the read finalizes THIS object, which the parked
    // continuation still holds by reference; without the re-check it bids the superseded ladder and
    // writes a live phase back over the retired load.
    if (monitor.finalized || this.killed) return;
    // The per-load minimum decrement as the platform reports it, recorded HERE - at the read that
    // surfaces it - and not at the fire point, because it is an observation of the auction and not
    // fire bookkeeping: a write the auth wall refuses must leave the monitor otherwise untouched
    // (scripts/test-auth-reversibility.js), and an observation reverted alongside a refused bid
    // would be a lie about what the platform said. Read by standingBid() for the re-price gate.
    if (state.ok && state.minDecrement != null) monitor.lastMinDecrement = state.minDecrement;

    if (!state.ok) {
      // A failed read BEFORE the load's known start time is the EXPECTED state, not a fault:
      // the scheduled wake arms armLeadMs (10s) before startsAt, and SuperProcure keeps
      // biddingOn 0 (closesAt null) and the socket silent until it opens the window, so
      // getAuctionState correctly answers ok:false for the whole pre-open gap. At the 1s
      // retry cadence below, that gap used to accrue 5 "failures" ~4-5s after EVERY scheduled
      // wake - before recovery was even possible - firing a spurious repeated_read_failures
      // WhatsApp ping per wake. Don't COUNT those, rather than count-but-mute: the alert
      // triggers on the counter hitting EXACTLY 5, so a muted counter sailing past 5 pre-open
      // would permanently disarm the real alert. startsAt comes from the durable intent
      // (schedule() persists it; arm()'s upsert merge carries it through the wake and across
      // a restart). Unknown startsAt -> counts as before. A read still failing AFTER
      // startsAt + startGraceMs counts from zero and alerts at the same 5-fail threshold.
      const startsAt = monitor.intent && monitor.intent.startsAt;
      const preOpen = typeof startsAt === 'number' && Date.now() < startsAt + this.cfg.startGraceMs;
      if (!preOpen) monitor.consecutiveReadFails += 1;
      // When this outage began, for the unknown-close arm of _unreadablePastBound. Stamped on the
      // same non-preOpen condition the counter uses, so the pre-open gap - where a failed read is
      // the EXPECTED answer, not a fault - never starts the clock.
      if (!preOpen && monitor._firstReadFailAt == null) monitor._firstReadFailAt = Date.now();
      if (state.authError) {
        this.emit({ type: 'alert', level: 'warn', kind: 'auth_error_mid_auction', auctionId: monitor.auctionId });
        try { await this.adapter.ensureSession(); } catch (_) {}
      }
      if (monitor.consecutiveReadFails === 5) {
        this.emit({ type: 'alert', level: 'warn', kind: 'repeated_read_failures', auctionId: monitor.auctionId,
          count: monitor.consecutiveReadFails });
      }
      // TERMINAL CONDITION. Without one this branch reschedules unconditionally, so a load the
      // portal has stopped answering for keeps a live timer and an intent at 'bidding' for the
      // lifetime of the process - and past the fifth failure it does so in silence, because that
      // alert fires on the counter hitting EXACTLY 5. See _unreadablePastBound for why the bound is
      // age rather than the failure count, and for the second arm that trips on an UNKNOWN close -
      // it falls back to how long the load has been continuously unreadable, so a load whose close
      // was never learned is bounded too rather than left as the one silent-forever path.
      if (this._unreadablePastBound(monitor)) return this._retireUnreadable(monitor);
      // LAST-SECONDS FALLBACK (ruling 64): a read failing this close to the believed close must not
      // leave the planned shot unsent - fires the last successful read's decision through the
      // ordinary write path so every existing guard still applies.
      await this._lastSecondsFallback(monitor);
      // skip this tick, retry soon — never crash the monitor
      return this._schedule(monitor, monitor._responseState ? 0 : Math.min(this.cfg.pollMidMs, 1000));
    }
    const raw = state;
    state = this._withTrackerClose(monitor, state);
    monitor._lastOkState = state;
    monitor._lastOkAt = Date.now();
    monitor._tickReadOk = true;
    // Only a portal read counts: a state built from our own submit response saw nothing new.
    if (!fromResponse && state.closesInMs > 0) monitor._lastLiveRead = { at: Date.now(), closesInMs: state.closesInMs };
    monitor.consecutiveReadFails = 0;
    monitor._firstReadFailAt = null; // the outage ended; a later one starts its own clock
    // ...and a cleared outage is one of the two drains for the announce window: no further retirement
    // is coming to carry the folded count, so speak it now. See _flushUnreadableFolded.
    if (this._unreadableFolded) this._flushUnreadableFolded();

    // refresh observed state
    // notify once when we drop out of L1 ('outbid'); the bot reacts on its own regardless.
    if (monitor._wasL1 && state.myRank != null && state.myRank > 1) {
      this.emit({ type: 'alert', level: 'info', kind: 'outranked', auctionId: monitor.auctionId, rank: state.myRank,
        // branch rides as a routing key so the outbid alert reaches the same group as the load's ask
        lane: monitor.meta.lane, companyName: monitor.meta.companyName, branchName: monitor.meta.branchName || null });
    }
    monitor._wasL1 = state.myRank === 1;
    monitor.myRank = state.myRank;
    this._maybeStampRankVisible(monitor, state);
    monitor.totalBidders = state.totalBidders;
    // A live remaining count may only ever LOWER the engine's belief, never raise it — a portal's
    // published count reflects what IT has counted, which lags our own writes by a round, so an
    // unconditional re-seed hands back the revision the accepted-bid decrement just spent and the
    // revisionsLeft<=0 stand-down can never trip. Downward is the direction that carries real
    // information: a count that DROPS between our ticks is a revision a human or another bot on
    // this shared vendor identity spent, and the engine must take it. Upward carries none, so it
    // is refused - including the _detectForeignBids discount, which the next tick would otherwise
    // undo. A platform that genuinely restores budget mid-auction (the open soft-close cap-reset
    // question) leaves the engine one revision short, which is the fail-closed side of it.
    // capExhausted OVERRIDES a live remaining outright: once the platform has refused a bid for
    // "Bid limit exceeded" it has told us on the wire that the budget is gone, and that beats any
    // count it also reports. The clamp is what holds after a re-arm, where capExhausted is rebuilt
    // as false and only the 0 carried on the durable intent remains.
    if (state.revisionsLeft != null && !monitor.capExhausted) {
      if (monitor.revisionsLeft == null || state.revisionsLeft < monitor.revisionsLeft) {
        monitor.revisionsLeft = state.revisionsLeft;
      }
    } else if (monitor.revisionsLeft == null && state.revisionLimit != null) monitor.revisionsLeft = state.revisionLimit;
    this._detectForeignBids(monitor, state);
    monitor.closesInMs = state.closesInMs;
    monitor.closeModel = state.closeModel || monitor.closeModel;
    this._surfaceTriggerWindow(monitor, state);
    if (monitor.closeModel === 'hard') monitor._sawHard = true;
    // An auction that read hard-close and is now observed extending (anti-snipe) is proof it is
    // soft-close - outside the hard-close-only intake. Surface it once so an operator who set
    // that restriction knows one slipped through (mis-classified at discovery, or armed before
    // the restriction). Bidding behaviour is unchanged; this only alerts. Gated on having seen
    // 'hard' first so a load that was soft from the start (e.g. the demo) doesn't false-alarm.
    if (monitor._sawHard && monitor.closeModel === 'soft' && !monitor._softAlerted) {
      monitor._softAlerted = true;
      this.emit({ type: 'alert', level: 'warn', kind: 'soft_close_observed', auctionId: monitor.auctionId,
        lane: monitor.meta.lane, companyName: monitor.meta.companyName });
    }
    monitor.standingL1Price = state.standingL1Price;
    monitor.measuredRttMs = state.measuredRttMs;
    // Ladder-vs-min-decrement validity. Placed here because this is the first point at which the
    // per-load decrement exists (it arrives on the state read, never on the armed meta - see
    // _checkLadderValidity), and ahead of the finalize/decide branch so the warning lands before the
    // ladder is walked rather than after the load is already lost. Latched to one alert per monitor.
    this._checkLadderValidity(monitor, state);
    // Track the sustained-zero run HERE, ahead of _observeExtension, rather than immediately before
    // the finalize test lower down where it used to sit. The values are identical on the same tick -
    // the finalize test below reads exactly what it read before - but the extension observer now sees
    // THIS tick's run length instead of the previous tick's, which is what lets it recognise the
    // missed final extension. That zeroed countdown is the only signal of that extension: once the
    // believed close passes, SuperProcure's socket stops publishing and closesAtMs freezes, so the
    // forward jump _observeExtension normally counts on never arrives.
    const countdownZero = Number.isFinite(state.closesInMs) && state.closesInMs <= 0;
    if (countdownZero && !monitor._zeroSince) monitor._zeroSince = Date.now();
    if (!countdownZero) monitor._zeroSince = null;
    // L3: count anti-snipe extensions + advance believed close BEFORE the finalize/decide steps, so a
    // same-tick extension is reflected in effectivelyHard and never finalizes early. A soft load with
    // softStrategy 'off' only has its believed close tracked; hard loads are untouched.
    this._observeExtension(monitor, raw);
    this._checkFrozenClose(monitor);
    if (monitor._lastLanded && state.myRank === 1) monitor._lastLanded.heldRank1 = true;
    // A2 (capture-only): sample OUR rank + bidder count + countdown once per monitor tick onto the
    // append-only bids jsonl. Rides the existing poll cadence - no new timer or poll. Reads only
    // already-computed state (myRank/totalBidders/closesInMs), stamps nothing back, and changes no
    // decision, price, or timing. Fires before the finalize/decide branch so the closing tick
    // (closesInMs <= 0) records our rank at close too. Wrapped so a telemetry sample can never
    // disturb the bid loop; the sink writes the jsonl append off-thread (non-blocking fs.promises),
    // so no synchronous disk I/O lands on this tick even when it is the one that fires the bid.
    //
    // The soft-close / budget context rides the sample too, so the jsonl carries a CONTINUOUS
    // trajectory of extension state and not just the discrete stamps on the bid records. The open
    // question this observability exists to answer - does SuperProcure RESET a load's bid-revision
    // cap when a soft-close auction auto-extends? - can only be answered by correlating a bid's
    // accept/reject outcome against how many extensions had been observed AT THAT MOMENT (SP
    // exposes no remaining-count anywhere), and the per-tick trace is what lets an analyst place a
    // bid record inside that timeline rather than interpolate between two bids minutes apart.
    //
    // This sample is emitted immediately AFTER _observeExtension rather than before it (where the
    // A2 sample originally sat) so extendsObserved/closeModel are THIS tick's values, not the
    // previous tick's: a one-tick lag on the very frames around an extension is precisely where
    // the lag would corrupt the correlation. It still precedes the finalize/decide branch, so the
    // closing-tick sample and the pre-wire non-blocking-append property are both preserved.
    // believedCloseAt is deliberately NOT repeated per tick - closesInMs above is its derivative
    // (an extension shows up as the countdown jumping back UP) and the absolute value is stamped
    // on every bid_placed / bid_rejected record, which is where the correlation is actually made.
    try {
      this.onSample({ auctionId: monitor.auctionId, myRank: state.myRank,
        totalBidders: state.totalBidders, closesInMs: state.closesInMs, ts: Date.now(),
        extendsObserved: monitor.extendsObserved, closeModel: monitor.closeModel,
        engineRevisionsLeft: monitor.revisionsLeft != null ? monitor.revisionsLeft : null });
    } catch (_) { /* never let a captured sample interfere with bidding */ }
    // The phase returned by _phase() lines up with the far/mid/hot buckets _cadence()
    // uses to pick the poll interval, so a phase change is exactly a cadence transition.
    // Log only on the transition, not every tick, since hot-phase ticks run every 200ms.
    const previousPollPhase = monitor.status;
    monitor.status = this._phase(state.closesInMs);
    if (monitor.status !== previousPollPhase) {
      this.log.debug('poll cadence phase transition', { auctionId: monitor.auctionId,
        from: previousPollPhase, to: monitor.status, remainingMs: state.closesInMs });
    }

    // (the sustained-zero run this debounce arms on is tracked above, ahead of _observeExtension)
    // Soft close (anti-snipe): a late bid re-extends the end, so wait out a quiet window
    // LONGER than the platform's extend interval before declaring it ended — finalizing on
    // a transient zero would miss the extension. Hard close: end is fixed, finalize at the
    // authoritative zero (base debounce only guards clock skew).
    //
    // The increment comes through extendIncrementMs, so an UNPUBLISHED increment widens this window
    // to the measured platform bound instead of collapsing it to the bare skew guard. _finalize is
    // TERMINAL ON DISK (it writes status 'closed' to the durable intent), so nothing - not the boot
    // supervisor, not a later real extension - can re-arm a monitor retired here. On a soft load this
    // is the ONLY thing that can retire the monitor: hardClosed is gated on !isSoft, so a frozen
    // socket's `status: 'closed'` cannot short-circuit it.
    const isSoft = monitor.closeModel === 'soft';
    const debounceMs = isSoft ? extendIncrementMs(state) + this.cfg.finalizeDebounceMs : this.cfg.finalizeDebounceMs;
    const sustainedZero = monitor._zeroSince != null && Date.now() - monitor._zeroSince >= debounceMs;
    const hardClosed = !isSoft && (state.status === 'closed' || countdownZero);
    if ((hardClosed || sustainedZero) && !(monitor.provisionalClose && this._reopenHoldsFinalize(monitor))) {
      return this._finalize(monitor, state);
    }

    // decide + maybe fire
    await this._attemptBid(monitor, state);
    this._armWalkClockFallback(monitor);

    // The monitor rides along so the cadence can see this load's decisive band (see _cadence): a
    // 30-second far poll steps straight over a 2,500ms band, and the band is where the soft-close
    // decisive shot has to land.
    this._schedule(monitor, monitor._responseState ? 0 : this._cadence(
      monitor.provisionalClose ? this._provisionalRemainingMs(state) : monitor.closesInMs, monitor));
  }

  /**
   * Decide and maybe fire off ONE state read - the ordinary successful tick, and the last-seconds
   * fallback's reconstructed read alike, so both take the identical belts and error handling.
   */
  async _attemptBid(monitor, state) {
    try {
      await this._maybeBid(monitor, state);
    } catch (e) {
      if (e && e.code === 'FLOOR') {
        this.emit({ type: 'alert', level: 'error', kind: 'floor_breach_blocked', auctionId: monitor.auctionId,
          detail: e.message });
      } else if (e && e.code === 'CEILING') {
        // The adapter ceiling belt refused an over-ceiling amount before the write (no rung spent, no
        // bid sent). In normal operation the ladder cap means this never fires - it is the structural
        // backstop mirroring floor_breach_blocked, surfaced the same way.
        this.emit({ type: 'alert', level: 'error', kind: 'ceiling_breach_blocked', auctionId: monitor.auctionId,
          detail: e.message });
      } else if (e && e.code === 'UNSUPPORTED_RULE') {
        // fail CLOSED: this load carries a rule flag we have not built for. assertRulesSupported
        // throws BEFORE the write block (like the floor guard), so NO rung was spent and NO bid
        // left the building - the monitor keeps polling and a human is paged to handle it manually,
        // never a wrong payload on live money.
        this._recordRefusal(monitor, 'unsupported_rule_blocked');
        this.emit({ type: 'alert', level: 'error', kind: 'unsupported_rule_blocked', auctionId: monitor.auctionId,
          detail: e.message, mechanics: e.mechanics || null,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName });
      } else if (e && e.code === 'MISSING_TRANSIT_TIME') {
        // fail CLOSED: a transit-required load with no captured transit days. Same posture as the
        // unsupported-rule guard (thrown BEFORE the write block - no rung spent, no bid sent), but
        // its own kind because the operator's fix is specific: open the load's price link and
        // enter the transit days. Without this refusal the bid would go out with transitTime:null
        // and SuperProcure would 400 it (proven live on SIKA) - a silent zero-bid miss.
        this._recordRefusal(monitor, 'transit_time_missing_blocked');
        this.emit({ type: 'alert', level: 'error', kind: 'transit_time_missing_blocked', auctionId: monitor.auctionId,
          detail: e.message,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName });
      } else {
        this.emit({ type: 'alert', level: 'error', kind: 'tick_error', auctionId: monitor.auctionId,
          detail: String(e && e.message) });
      }
    }
  }

  /**
   * Ruling 64: a read that fails inside the final seconds must not silently forfeit the planned
   * shot. Keyed on monitor.believedCloseAt - the round tracker's own field, kept compatible with a
   * later branch that takes over as its writer - and the LAST read that succeeded; never fires with
   * no prior successful read. N is the buzzer on a provisional (GoComet) close, floorWindowMs on a
   * hard (SuperProcure) close. Rank is the last known rank; rank 1 holds silently (ruling 39/47) -
   * the confirmed-final-round floor-regardless-of-rank behaviour in _decideProvisional does not
   * apply here, because a failed read means the round is no longer confirmed. Everything else - the
   * shot itself, and every guard on it (floor, ceiling, revisions left, latches, the kill switch) -
   * runs through the ordinary _maybeBid path unchanged.
   */
  async _lastSecondsFallback(monitor) {
    const lastOk = monitor._lastOkState;
    if (!lastOk) return;
    if (monitor.myRank === 1) return;
    const believedClose = numericOrNull(monitor.believedCloseAt);
    if (believedClose == null) return;
    const serverNow = typeof this.adapter.serverNow === 'function' ? this.adapter.serverNow() : Date.now();
    const remaining = believedClose - serverNow;
    let n = monitor.provisionalClose ? this._buzzerMs() : this.cfg.floorWindowMs;
    if (this._walkOn(monitor)) n = Math.max(n, walkMath.stepDeadlineMs(1, this.walkParams(monitor, lastOk)));
    if (!(remaining > 0) || remaining > n) return;
    // GoComet's own recompute in _maybeBid re-times closesInMs from closesAtMs/serverOffsetMs against
    // Date.now(), so the stale cached read is already re-timed there; SuperProcure carries no such
    // recompute, so its closesInMs is overwritten here with the believed remaining.
    const state = monitor.provisionalClose ? lastOk : { ...lastOk, closesInMs: remaining };
    await this._attemptBid(monitor, state);
  }

  _phase(closesInMs) {
    if (closesInMs > this.cfg.farThresholdMs) return 'monitoring';
    if (closesInMs > this.cfg.hotThresholdMs) return 'preparing';
    if (closesInMs > 0) return 'active_bidding';
    return 'closing';
  }

  /**
   * The DEPLOYED clock-driven "which rung is due" mapping - which ladder rung the deployed engine steps
   * to as the countdown runs down (deeper as time runs out). It is NO LONGER the rung selector for an
   * allowlisted (rankDriven) load - those run pricing.selectRung, the rank-driven rule. It is KEPT, and
   * only reached, on the DEPLOYED path (_decide's !rankDriven branches for the hard step-down), so a
   * non-allowlisted customer's step-down stays on the deployed clock walk - except where a known
   * hard-close budget is short and _shortBudgetMiddleRung picks the price. Do NOT route an allowlisted
   * load through this - that is the clock-vs-rank split the rank-driven change removes for opted-in loads.
   */
  _scheduledRungIndex(monitor, remaining) {
    const last = monitor.ladder.length - 1;
    const span = this.cfg.openAtMs - this.cfg.floorWindowMs;
    const f = span > 0 ? (this.cfg.openAtMs - remaining) / span : 1;
    const clamped = Math.max(0, Math.min(1, f));
    return Math.round(clamped * last);
  }

  /**
   * The single answer to "how many revisions can this hard-close load still spend" - every reserve
   * decision on the hard-close path reads this, never monitor.revisionsLeft directly, so a detected
   * foreign slot is discounted everywhere the budget is judged, not just where it happened to be
   * checked first. See foreignSlotUncounted (_detectForeignBids) for when the discount applies.
   */
  _hardCloseRevisionsLeft(monitor) {
    if (monitor.revisionsLeft == null) return null;
    return monitor.foreignSlotUncounted ? monitor.revisionsLeft - 1 : monitor.revisionsLeft;
  }

  // A hard close with a known budget keeps its last revision for the final-window floor.
  _hardCloseLastRevision(monitor) {
    const left = this._hardCloseRevisionsLeft(monitor);
    return monitor.closeModel !== 'soft' && left != null && left <= 1;
  }

  /**
   * OPEN OWNER QUESTION (Q3): on a hard close whose known budget cannot fund every unspent middle
   * price plus the floor, which middle price the deployed step-down sends. Default: the NEXT one
   * below where we stand. The alternative, "lowest middle", is `return unspent[unspent.length - 1]`:
   * the step would jump straight to the deepest middle price and never offer the ones above it.
   * Null when the budget fits or is unknown, which leaves the clock walk in charge.
   */
  _shortBudgetMiddleRung(monitor, last) {
    const left = this._hardCloseRevisionsLeft(monitor);
    if (monitor.closeModel === 'soft' || left == null) return null;
    const skip = this._selectableExclusions(monitor);
    const unspent = [];
    for (let i = monitor.currentRungIndex + 1; i < last; i++) if (!skip.has(i)) unspent.push(i);
    if (unspent.length === 0 || left >= unspent.length + 1) return null;
    return unspent[0];
  }

  /**
   * True once remaining time is inside the fixed "last chance" floor window - the point past
   * which ANY decision (including the establish rung) fires best-effort, ignoring the RTT-
   * compensated latency guard in _maybeBid, because the alternative is a guaranteed zero-bid
   * loss. Without this, an auction armed so late that the establish decision never clears the
   * latency guard sits with currentRungIndex stuck at -1 forever (_decide's currentRungIndex<0
   * branch never falls through to the floor-rung logic that WOULD ignore the guard), so the
   * engine places zero bids and never even attempts the final snipe.
   */
  _isLastChance(remainingMs) {
    return Number.isFinite(remainingMs) && remainingMs <= this.cfg.floorWindowMs;
  }

  /**
   * A live read whose countdown is null, undefined or NaN: the close is UNKNOWN and the load holds
   * (owner ruling, A087). Never last chance and never countdown zero, so it fires no floor and
   * finalizes nothing. Told to the desk once per monitor on the close_unknown_held channel.
   */
  _holdUnknownCountdown(monitor) {
    if (monitor._countdownUnknownAlerted) return;
    monitor._countdownUnknownAlerted = true;
    this.log.error('holding a live load: the portal read carried no usable countdown to close', {
      auctionId: monitor.auctionId });
    this.emit({ type: 'alert', level: 'error', kind: 'close_unknown_held', auctionId: monitor.auctionId,
      episode: `countdown_${Date.now()}`,
      detail: 'Not bidding this load for now: the portal is not showing its closing countdown. Bid it by hand if the auction is still open.',
      lane: monitor.meta.lane || null, companyName: monitor.meta.companyName || null,
      branchName: monitor.meta.branchName || null });
  }

  /**
   * Surface a ladder whose rung spacing this load's platform minimum will refuse - ONCE per
   * monitor, as an operator-visible alert. See decrementViolations for what counts as a violation
   * and why only non-floor, adjacent steps are reported.
   *
   * WHY THIS RUNS ON THE TICK AND NOT IN arm(). Since the Layer-3 rung interpolation,
   * deriveLoadRules DOES carry the per-load decrement (loadBidDifference -> rules.minDecrement) and
   * arm() uses it to SIZE the ladder - but that is the intake-time snapshot, not the live fact. The
   * AUTHORITATIVE value is the one each state read reports (state.minDecrement), the very value the
   * _maybeBid guard enforces, and a load armed off an absent/stale snapshot (falling back to the
   * adapter's static 100) can still carry rungs the LIVE decrement refuses. The first successful
   * getAuctionState is the earliest point the check is honest against the enforced value, and it is
   * still early: it is the monitor's first tick, normally minutes ahead of the close.
   *
   * The effective decrement is resolved with the SAME expression the guard in _maybeBid uses, so
   * the warning and the behaviour can never disagree about which value is in force.
   *
   * Deliberately NOT one of engineAlerts' ERROR_KINDS, so it never reaches WhatsApp. It reports a
   * pricing-configuration mismatch a human resolves at their own pace (re-price the load, or re-cut
   * the band), not a live-money refusal in progress - and the recipient-facing alert set is a
   * separate, undecided question that must not be pre-empted here.
   *
   * WHERE IT ACTUALLY LANDS, stated precisely because it is easy to overstate. The emit reaches the
   * engine's in-memory event ring and, through server.js's onEvent, the /api/state `events` array.
   * Nothing RENDERS that array today: the React console's api.ts `getState()` has zero call sites,
   * and the legacy /legacy page polls /api/state but reads only auctions/priceRequests. So the
   * channel an operator can actually read right now is the log line below - warn level, so it
   * survives the default LOG_LEVEL and lands in pm2-err.log on the box. Do not describe this alert
   * as reaching "the operator console" (that phrase means the React dashboard, per npm run
   * build:console) unless and until something is wired to read the ring.
   *
   * Pure observation. It reads monitor/state fields this tick has already refreshed, emits, and
   * returns: no rung is selected, no price moves, no revision is spent, no timer is touched.
   *
   * @param {Object} monitor - the live monitor; its ladder is checked and its one-shot latch set.
   * @param {Object} state - this tick's auction state; state.minDecrement beats the static cap.
   * @returns {void} - emits at most one ladder_below_min_decrement alert per monitor.
   */
  _checkLadderValidity(monitor, state) {
    if (monitor._ladderValidityAlerted) return; // latched: one alert per monitor
    const minDec = state.minDecrement != null ? state.minDecrement : this.caps.minDecrement;
    const violations = decrementViolations(monitor.ladder, minDec);
    if (!violations.length) return;
    monitor._ladderValidityAlerted = true;
    // Report the WORST (narrowest) gap in the human-readable line - it is the one that fails by the
    // widest margin and so the one that most clearly names the mismatch. The full list rides the
    // event for anyone reading the stream in detail.
    const worst = violations.reduce((a, b) => (b.gap < a.gap ? b : a));
    const detail = `load ${monitor.auctionId}: ladder step ${worst.fromPrice} -> ${worst.toPrice} is only ${worst.gap} apart, `
      + `under this load's minimum bid difference of ${minDec} - SuperProcure would refuse that revision, `
      + `so the rung can never bid and the ladder is effectively ${monitor.ladder.length - violations.length} prices, not ${monitor.ladder.length}`;
    this.log.warn('ladder rung spacing is below the load minimum bid difference - rung(s) unfireable', {
      auctionId: monitor.auctionId, minDecrement: minDec, ladder: monitor.ladder, violations, detail });
    this.emit({ type: 'alert', level: 'warn', kind: 'ladder_below_min_decrement', auctionId: monitor.auctionId,
      minDecrement: minDec, ladder: monitor.ladder.slice(), violations, detail,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName });
  }

  /**
   * A RUNG THE PLATFORM WOULD REFUSE, recorded instead of dropped on the floor.
   *
   * The refusal itself is correct and stays: firing a step the portal will reject spends one of a
   * handful of scarce revisions on a guaranteed rejection. What was wrong is that it refused with a
   * bare `return` - the rung never bid, nothing was emitted, nothing was logged, and because it was
   * never added to firedRungs it was re-selected and re-discarded on every 200ms tick for the rest of
   * the auction. A load that ran on two of its three prices was byte-identical in the record to one
   * that ran on three. That is the same hole rejectedBids[] was added to close on the write side, and
   * it is closed here the same way.
   *
   * Three effects, none of them optional:
   *   - unfireableRungs ends the re-select loop, WITHOUT polluting firedRungs (which means spent).
   *   - the alert is latched per (auctionId, rungIndex), mirroring _ladderValidityAlerted, so a
   *     monitor reports once per rung and not once per tick.
   *   - the rung_discarded event carries it to the durable record (skippedRungs[] on the closedBids
   *     doc plus a line on the un-backfillable bids stream), which is what makes a post-mortem able
   *     to tell a discarded rung from one that was never due.
   *
   * After the plan-time derivation this path is unreachable for a load armed from a fresh intent.
   * It stays reachable for three genuinely runtime-only cases, and each is a real surprise worth the
   * noise: a LIVE decrement wider than the one snapshotted at capture, an intent armed before the
   * derivation shipped and rehydrated onto its old ladder, and a grid snap that re-opened a gap.
   */
  _recordRungDiscard(monitor, decision, minDec) {
    const rungIndex = decision.rungIndex;
    if (rungIndex != null) monitor.unfireableRungs.add(rungIndex);
    const latchKey = rungIndex != null ? rungIndex : `p${decision.price}`;
    if (monitor._rungDiscardAlerted.has(latchKey)) return;
    monitor._rungDiscardAlerted.add(latchKey);
    // The guard above runs before the standing-bid belt, so a decision at or above our own standing
    // bid lands here too (M1). There is no gap to state then, and a negative one must never be shown.
    const rawGap = monitor.lastBidPrice - decision.price;
    const gap = rawGap > 0 ? rawGap : null;
    const detail = (gap != null
      ? `load ${monitor.auctionId}: Rs ${decision.price} is only Rs ${gap} below our own last bid of `
        + `Rs ${monitor.lastBidPrice}, under this load's minimum bid difference of Rs ${minDec} - `
      : `load ${monitor.auctionId}: Rs ${decision.price} is not below our own last bid of Rs ${monitor.lastBidPrice} - `)
      + 'the portal would refuse that revision, so it was not sent and this load runs on one fewer price';
    this.log.warn('rung discarded: the step is under the load minimum bid difference and would be refused', {
      auctionId: monitor.auctionId, rungIndex, price: decision.price,
      lastBidPrice: monitor.lastBidPrice, minDecrement: minDec, gap, detail });
    this.emit({ type: 'alert', level: 'warn', kind: 'rung_discarded_min_decrement',
      auctionId: monitor.auctionId, rungIndex, price: decision.price,
      lastBidPrice: monitor.lastBidPrice, minDecrement: minDec, gap, detail,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null });
    this.emit({ type: 'rung_discarded', auctionId: monitor.auctionId, rungIndex,
      price: decision.price, lastBidPrice: monitor.lastBidPrice, minDecrement: minDec, gap,
      reason: 'min_decrement', ts: Date.now(), ...this._budgetContext(monitor) });
  }

  /**
   * Rung selection's view of what is no longer worth choosing: spent rungs AND rungs the platform
   * would refuse for spacing. Returns firedRungs ITSELF when nothing has been discarded, so a
   * monitor that never hit the guard behaves byte-identically to before.
   *
   * Used only where the min-decrement guard actually applies. The final SNIPE is exempt from that
   * guard (decision.snipe makes it floor-equivalent at _maybeBid), so the snipe walk keeps reading
   * firedRungs alone - hiding a rung from it would drop the one shot that is allowed to be close.
   */
  _selectableExclusions(monitor) {
    const unfireable = monitor.unfireableRungs;
    if (!unfireable || !unfireable.size) return monitor.firedRungs;
    const fired = monitor.firedRungs;
    return { has: (i) => fired.has(i) || unfireable.has(i) };
  }

  /**
   * The blind-rank hold, given a trace that outlives the process - ONCE per monitor, from EITHER
   * guard site (soft defend and hard step-down share one latch, because they are one guard reported
   * once per load, not two independent conditions).
   *
   * WHY THIS EXISTS AT ALL. The guard withholds ladder rungs on live money. Until this, the only
   * record it left was a log.debug line, which is invisible at the default LOG_LEVEL - and the
   * comment at realAdapter.js:881 records the team having already been burned by exactly that shape
   * ("the prior debug-level line here never printed in prod"). A post-mortem on a load that quietly
   * ran on fewer rungs than its ladder had could not tell that from normal behaviour. The per-tick
   * debug lines at the call sites stay: they are the tick-by-tick detail when someone is actively
   * debugging with LOG_LEVEL=debug. This is the durable one.
   *
   * WHY IT IS LATCHED, and why that is not optional. The blind window is ~1.15s of ordinary socket
   * self-match latency on EVERY soft-close auction, and the hot poll cadence is 200ms - so an
   * unlatched emit would fire ~6 times per auction as a matter of routine, and unboundedly after a
   * mid-auction restart where the rank never comes back. A per-tick alert is worse than the debug
   * line it replaces: it buries the event ring and trains an operator to ignore the kind. One per
   * load is the whole point. Same one-shot shape as _noRevAlerted / _ceilingBlockedAlerted.
   *
   * WHY level 'info' AND NOT 'warn'. Firing is the NORMAL case, not a fault: the guard engages on
   * every soft-close auction while the first rank frame is in flight, and holding is the correct,
   * designed behaviour for the DISCRETIONARY rungs. Note what does NOT make it safe: this guard
   * returns, it does not fall through, so it does not "leave the final floor snipe outside itself" -
   * the load is protected instead by _lastResortFloor, which releases the reserved rung on the final
   * tick when every path is still holding. warn/error route to console.error -> pm2-err.log, a file
   * that carries almost no routine traffic today and is therefore worth something as a signal;
   * putting one line per soft auction into it would destroy that. 'info' still fixes the actual
   * defect - it clears the default LOG_LEVEL, so unlike the debug line it genuinely prints in
   * prod - and it matches stood_down_below_floor, the closest sibling (a deliberate decision not
   * to bid).
   *
   * NOT in engineAlerts' ERROR_KINDS, so it never reaches WhatsApp. It lands in the engine event
   * ring / /api/state `events` (which nothing renders yet - see _checkLadderValidity) and in
   * pm2-out.log. The log line is the channel an operator can read today.
   *
   * Pure observation, called only on a path that has already decided to hold: it emits and returns.
   * No rung is selected, no price moves, no revision is spent, no timer is touched.
   *
   * @param {Object} monitor - the live monitor; carries the one-per-load _blindRankAlerted latch.
   * @param {number} remainingMs - ms left on the platform countdown when the hold was taken.
   * @param {'step-down'|'soft-close defend'} heldDecision - which discretionary decision was
   *   blocked (see the naming note below).
   * @returns {void} - emits at most one blind_rank_hold alert per monitor, across both sites.
   */
  // `heldDecision` names WHICH discretionary decision was blocked ('step-down' | 'soft-close
  // defend'). Deliberately NOT called `branch`: every branch* field in this codebase and on the SP
  // wire (branchBidCount, branchAuctionExtendTime, branchAuctionRemainingTime) means the SHIPPER's
  // branch, so a `branch: 'step-down'` on the event stream would read as a shipper-branch value.
  _alertBlindRankHold(monitor, remainingMs, heldDecision) {
    if (monitor._blindRankAlerted) return; // latched: one alert per monitor, across both guard sites
    monitor._blindRankAlerted = true;
    // Word this as what is KNOWN, not more. The guard returns BEFORE the due-checks that follow it
    // (next <= currentRungIndex, firedRungs.has(next)), so at this point we do not know whether a
    // rung was actually due - only that while the rank is unknown none can be selected. Claiming a
    // rung "was withheld" would overstate it on every load where nothing was due anyway, which is
    // the same class of overclaim the "operator console" line in _checkLadderValidity had to lose.
    const detail = `load ${monitor.auctionId}: our own rank has not arrived yet (SuperProcure only publishes it `
      + `about 1.15s after our first bid, and not at all until we have bid as the routed carrier), so the engine `
      + `is holding - while the rank is unknown the discretionary ${heldDecision} cannot select a rung, whether or not `
      + `one was due. The establishing bid is decided before this guard, and if every path is still holding on the `
      + `final tick the reserved floor rung is released rather than the load forfeited, so this costs margin, not the load`;
    this.log.info('holding: rank not yet known (blind window) - no discretionary rung while blind', {
      auctionId: monitor.auctionId, heldDecision, remainingMs, closeModel: monitor.closeModel,
      currentRungIndex: monitor.currentRungIndex, detail });
    this.emit({ type: 'alert', level: 'info', kind: 'blind_rank_hold', auctionId: monitor.auctionId,
      heldDecision, remainingMs, closeModel: monitor.closeModel, currentRungIndex: monitor.currentRungIndex,
      detail, lane: monitor.meta.lane, companyName: monitor.meta.companyName });
  }

  /**
   * The already-computed soft-close / budget context stamped onto every durable bid record
   * (bid_placed and bid_rejected alike). Pure read of monitor fields the tick has just refreshed -
   * it computes nothing, reads nothing new, and touches no I/O, so it cannot perturb the money
   * path.
   *
   * WHY these four fields, on the BID records specifically. SuperProcure exposes no remaining-bid
   * count anywhere: getAuctionState hardcodes revisionsLeft null and every candidate REST field
   * (branchBidCount / bidCount / totalBids) was null on all 339 open rows in the 2026-07-21 probe.
   * So the ONLY way to witness whether SP resets a load's revision cap when a soft-close auction
   * auto-extends is to correlate, after the fact, a bid's accept/reject outcome against how many
   * extensions had been observed when it fired. A reset shows up as a bid that should have exceeded
   * the static cap coming back ACCEPTED after an extension, instead of rejected with "Bid limit
   * exceeded". None of that is reconstructable from the current logs - extension state has never
   * been persisted anywhere durable - and it cannot be backfilled, which is why it is captured at
   * the moment of the bid rather than derived later.
   *
   * engineRevisionsLeft is named for what it is: the ENGINE'S BELIEF, not a platform fact. It is
   * bot-only accounting (seeded from the static cap, decremented on our own accepted bids), so on a
   * shared account it can and does disagree with SuperProcure's real counter - the Tata load proved
   * exactly that. Recording the belief alongside the outcome is what makes the disagreement
   * measurable instead of invisible.
   *
   * @param {Object} monitor - the live monitor, already refreshed by this tick.
   * @returns {{extendsObserved: number, believedCloseAt: number|null, closeModel: string|null,
   *   engineRevisionsLeft: number|null, extendCap: number|null, triggerWindowMs: number|null,
   *   jumpPerRival: number}} - the fire-time context stamped on bid_placed / bid_rejected.
   */
  _budgetContext(monitor) {
    return {
      extendsObserved: monitor.extendsObserved,
      believedCloseAt: monitor.believedCloseAt != null ? monitor.believedCloseAt : null,
      closeModel: monitor.closeModel != null ? monitor.closeModel : null,
      engineRevisionsLeft: monitor.revisionsLeft != null ? monitor.revisionsLeft : null,
      // L3 rank-driven endgame context, stamped alongside the budget context for post-hoc validation of
      // the actual decision environment (the extension cap, the per-load anti-snipe trigger window, and
      // the jumpPerRival knob in force). Additive fields: existing consumers read by name, so nothing
      // that renders or persists a bid record today sees any change.
      extendCap: monitor.extendCap != null ? monitor.extendCap : null,
      triggerWindowMs: monitor.triggerWindowMs != null ? monitor.triggerWindowMs : null,
      jumpPerRival: this.softCfg.jumpPerRival,
    };
  }

  /**
   * FAULT A DETECTION (Tata 2026-07-21, diagnosis section 4) - "the team is bidding from the portal".
   *
   * BRL humans bid MANUALLY on the same SuperProcure account this bot logs in as, and SuperProcure
   * counts those bids against the SAME per-load cap (branchBidCountAllowed). The engine counts only
   * the bids IT places, so on load 23341274 it believed it held 3 revisions while SP's counter was
   * already at 3 - it placed one accepted bid and then walked into two HTTP 400 "Bid limit
   * exceeded" refusals and lost the load.
   *
   * The signal, and its limits. Our OWN rank is the one competitive fact SuperProcure does not mask
   * from us. If the socket reports a non-null rank for this account BEFORE this process has put a
   * single bid on the wire, then a bid we did not place is holding a position on this load - the
   * account has already been used, by a human, from the portal. That is exactly what happened on
   * Tata: the "outbid, now rank 2" alert fired at 10:48, fifty-seven minutes before the bot's first
   * bid, off a manual bid's rank.
   *
   * This is deliberately framed as a DETECTION, not a conclusion. It proves that AT LEAST ONE slot
   * is gone; it can never say how many, because SP publishes no used-count and the socket's `bids`
   * frame is current standings (one active row per carrier), not a revision history. So the
   * response is correspondingly modest: on a LOW-CAP load - where the 3-rung ladder consumes a
   * fresh cap with zero reserve - stop assuming a full budget and give back exactly the one slot
   * we have PROVEN is spent. Clamped to leave at least one revision so the establishing bid always
   * still fires: a detection must never be able to talk the engine out of bidding a load
   * altogether. Above the low-cap threshold the cap absorbs a foreign bid without changing what
   * the ladder can reach, so nothing is deducted and the behaviour is byte-identical to the
   * deployed build.
   *
   * Legal wall (D6): this reads ONLY our own rank and the shipper's own static cap. No competitor
   * amount is read, modelled, or inferred anywhere in this path - none is available to read.
   *
   * Why the discount cannot cost us the floor shot. A standing rank means a bid was PLACED on this
   * account, and SuperProcure counts a bid the moment it is placed - a cap slot cannot be handed
   * back by the bid later going inactive. So a non-null rank before our first bid PROVES the true
   * budget is at most cap-1, and spending as if it were cap would simply produce a refusal at the
   * last rung instead of a bid. The one case where the discount under-spends by one is the very
   * hypothesis this branch's sibling observability exists to test - that SP RESETS the cap on a
   * soft-close extension - and under-spending is the fail-closed side of an open question.
   *
   * Restart safety. ownBidAttempts is per-process, so after a mid-auction restart it is 0 even on a
   * load this bot had already bid - and the bot's own standing rank would then read as foreign.
   * firedRungs closes that hole: rehydrate() restores it from the durable intent before the first
   * tick, so "this bot has already bid on this load" survives the restart even though the in-memory
   * attempt counter does not. Both are checked; either one being non-zero means a rank may be ours.
   *
   * RE-PRICE safety. firedRungs is remapped BY PRICE across a re-arm, so a genuine cost re-price
   * carries none of it forward and the restart guard above silently stops covering the load. The
   * durable `everBid` flag is the price-independent version of the same fact and is what actually
   * holds here; see the note in arm(). All four guards are cheap and independent on purpose - this
   * detection can only ever spend budget, so every one of them fails in the safe direction.
   *
   * @param {Object} monitor - the live monitor; latched via monitor.foreignBidsDetected.
   * @param {Object} state - this tick's auction state; state.myRank is the only signal read.
   * @returns {boolean} - true when a foreign bid was detected on this tick (at most one per load).
   */
  _detectForeignBids(monitor, state) {
    if (monitor.foreignBidsDetected) return false;      // latched: one detection per load
    if (monitor.ownBidAttempts > 0) return false;       // we have bid this process; a rank may be ours
    if (monitor.firedRungs.size > 0) return false;      // we bid BEFORE a restart (durable, via rehydrate)
    if (monitor.currentRungIndex >= 0) return false;    // a rung is already banked on this monitor
    if (monitor.everBid) return false;                  // we bid BEFORE a RE-PRICE (durable, price-independent)
    if (state.myRank == null) return false;             // no standing position on this account
    monitor.foreignBidsDetected = true;

    const cap = state.revisionLimit != null ? Number(state.revisionLimit) : null;
    const lowCap = cap != null && Number.isFinite(cap) && cap <= LOW_CAP_THRESHOLD;
    if (lowCap && monitor.revisionsLeft != null && monitor.revisionsLeft > 1) {
      const before = monitor.revisionsLeft;
      monitor.revisionsLeft = before - 1;
      this.log.warn('standing rank exists before this bot bid: assuming one shared-account revision is already spent', {
        auctionId: monitor.auctionId, myRank: state.myRank, revisionLimit: cap,
        revisionsLeftBefore: before, revisionsLeftAfter: monitor.revisionsLeft });
      // Persist the reduced belief so a restart mid-auction does not re-seed the full static cap and
      // undo the discount (arm() prefers the intent's revisionsLeft over the static cap).
      try {
        this.scheduler.update(monitor.auctionId, { revisionsLeft: monitor.revisionsLeft });
      } catch (err) {
        this._recordWriteFailed(monitor, 'bid_record_failed',
          'A revision count on this load could not be saved to our records. Bidding continues; a restart before it saves could misjudge how many revisions are left.',
          err, { revisionsLeft: monitor.revisionsLeft });
      }
    } else {
      // A cap above LOW_CAP_THRESHOLD absorbs the foreign bid WITHOUT changing what the ladder can
      // reach (see the constant's comment) - unless the hard-close reserve is about to spend down to
      // exactly the last revision, where every slot counts. Flag it here so _hardCloseRevisionsLeft
      // can discount it there, hard close only (a soft load's reserve reads this differently) and
      // only when the budget is this engine's OWN seeded-from-the-cap count: a live revisionsLeft the
      // platform itself reports already reflects the desk bid, and discounting it again would
      // double-count the one slot that is actually gone.
      if (monitor.closeModel !== 'soft' && cap != null && Number.isFinite(cap) && cap > LOW_CAP_THRESHOLD
          && state.revisionsLeft == null) {
        monitor.foreignSlotUncounted = true;
      }
      this.log.info('standing rank exists before this bot bid (budget left at the static cap)', {
        auctionId: monitor.auctionId, myRank: state.myRank, revisionLimit: cap });
    }
    this.emit({ type: 'alert', level: 'warn', kind: 'foreign_bids_detected', auctionId: monitor.auctionId,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName, myRank: state.myRank });
    return true;
  }

  /**
   * L3 extend detection - SOCKET-PRIMARY but CLOSE-TIME-AUTHORITATIVE (D2). The authoritative fact is a
   * forward move of the live close, which the round tracker classifies (ruling 56): a move seen before
   * the old close's trigger window opened is a reschedule, one inside it counts the rounds that fit the
   * increment grid and could have run by this read, and anything else counts one round and makes the
   * round UNCERTAIN. This feeds it one read, mirrors its R, published C and close onto the monitor, and
   * persists its record when it changed. NO competitor modelling: only our own load's close is read
   * (legal wall, D6). Returns true when a round was counted this tick.
   */
  _observeExtension(monitor, state) {
    if (monitor.closeModel !== 'soft') return false;
    const now = Date.now();
    if (!monitor._round) {
      monitor._round = roundTracker.createTracker({ platform: monitor.provisionalClose ? 'gc' : 'sp', closeModel: 'soft',
        softStrategy: monitor.softStrategy, postedCloseAt: numericOrNull(monitor.postedCloseAt),
        capPrior: monitor.provisionalClose ? this._finalAfterExtensions(monitor) : undefined,
        closeAt: numericOrNull(monitor.believedCloseAt), nowMs: now });
    }
    const t = monitor._round;
    const closeAt = plausibleCloseAt(state.closesAtMs, now);
    const mirrors = monitor.provisionalClose || monitor.softStrategy !== 'off';
    if (mirrors) {
      roundTracker.syncMirrors(t, { rounds: monitor.extendsObserved,
        publishedCap: monitor.provisionalClose ? null : monitor.extendCap, closeAt: numericOrNull(monitor.believedCloseAt) });
    }
    // F4: an extension observed AFTER finalize is IGNORED (finalized is terminal; re-arming would
    // resurrect a retired intent). Alert once - it means this customer's finalize-debounce is too short.
    if (monitor.finalized) {
      if (mirrors && !monitor.provisionalClose && closeAt != null && monitor.believedCloseAt != null
          && closeAt - monitor.believedCloseAt >= extendIncrementMs(state) * 0.5 && !monitor._extendAfterFinalizeAlerted) {
        monitor._extendAfterFinalizeAlerted = true;
        this.emit({ type: 'alert', level: 'warn', kind: 'extend_after_finalize', auctionId: monitor.auctionId,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName });
      }
      return false;
    }
    const res = roundTracker.observe(t, { closeAt, closesInMs: state.closesInMs, extendMs: extendIncrementMs(state),
      published: Number.isFinite(state.extendMs),
      triggerWindowMs: Number.isFinite(state.triggerWindowMs) ? state.triggerWindowMs : monitor.triggerWindowMs,
      extendCount: state.extendCount, minCloseJumpMs: state.minCloseJumpMs,
      clockErrorMs: monitor.provisionalClose ? undefined : state.clockErrorMs,
      closeModel: 'soft', zeroSinceMs: numericOrNull(monitor._zeroSince), frozenAfterMs: this.cfg.finalizeDebounceMs }, now);
    if (mirrors && state.restClosesAtMs != null) {
      const r = roundTracker.observeRest(t, { restCloseAt: plausibleCloseAt(state.restClosesAtMs, now),
        restSeenAt: numericOrNull(state.restSeenAt) }, now);
      res.counted += r.counted;
      res.events.push(...r.events);
      if (r.kind) res.kind = r.kind;
    }
    mirrorRound(this, monitor, res);
    this._persistRound(monitor, res.kind != null);
    if (res.counted > 0 && monitor.priceRaiseRefused) {
      monitor.priceRaiseRefused = false;
      monitor.priceRaiseRefusedCap = null;
      if (monitor.noBid && monitor.noBid.reason === 'price_raise_refused') monitor.noBid = null;
      this.log.info('new round: clearing the price-raise stand-down and deciding again', {
        auctionId: monitor.auctionId, rounds: monitor.extendsObserved, standingQuoteAbove: monitor._raiseBelow });
    }
    return mirrors && res.counted > 0;
  }

  // True when no price below `price` can still go out on this load: no unspent band price under it
  // (within our standing bid and a raise-refusal bound), no walk limit bid under it, or no attempt left.
  // The refused-price hold's desk notice says "Not bidding", so it waits for this.
  _nothingSendableBelow(monitor, price) {
    if (monitor.revisionsLeft === 0) return true;
    const excluded = this._selectableExclusions(monitor);
    const mustImprove = this._mustImproveOn(monitor);
    for (let i = 0; i < monitor.ladder.length; i++) {
      const p = monitor.ladder[i];
      if (!(p < price) || excluded.has(i)) continue;
      if (mustImprove != null && p > mustImprove) continue;
      if (monitor._raiseBelow != null && p >= monitor._raiseBelow) continue;
      return false;
    }
    const lim = this._walkOn(monitor) ? this._walkLimitPrice(monitor) : null;
    return !(lim != null && lim < price);
  }

  _noteRaiseBelow(monitor, price) {
    if (!Number.isFinite(price)) return;
    if (monitor._raiseBelow == null || price < monitor._raiseBelow) monitor._raiseBelow = price;
  }

  /**
   * GoComet refused a raise: a quote below `decision.price` stands on this vendor login (ours or
   * another writer's). The next price must be below it (owner ruling 26 Sep, 260925SQRC). The standing
   * quote is read from the refusal where the adapter carries it, else bounded by the refused price.
   * True when a band price below it remains, so the load keeps bidding; false leaves the stand-down.
   */
  _continueBelowStanding(monitor, decision, res, state) {
    const standing = Number(res && res.standingPrice);
    this._noteRaiseBelow(monitor, Number.isFinite(standing) && standing > 0 && standing < decision.price ? standing : decision.price);
    if (decision.rungIndex != null && monitor.unfireableRungs) monitor.unfireableRungs.delete(decision.rungIndex);
    const floor = monitor.ladder[monitor.ladder.length - 1];
    if (!(floor < monitor._raiseBelow)) return false;
    this.log.info('the portal refused a price above the quote standing on this vendor login; continuing below it', {
      auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
      standingQuote: Number.isFinite(standing) && standing > 0 ? standing : null, bidBelow: monitor._raiseBelow,
      floor, revisionsLeft: monitor.revisionsLeft, closesInMs: state ? state.closesInMs : null });
    return true;
  }

  // No band price is below the standing quote: the existing stand-down, with its one notice.
  _standDownOnRaise(monitor, decision, cap, state) {
    if (monitor.priceRaiseRefused) return;
    monitor.priceRaiseRefused = true;
    monitor.priceRaiseRefusedCap = cap;
    this._recordRefusal(monitor, 'price_raise_refused', cap != null ? { amountCap: cap } : {});
    const floor = monitor.ladder[monitor.ladder.length - 1];
    this.log.error('the portal refused the bid because the price may not be raised; standing down rather than walking the ladder down', {
      auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex, amountCap: cap, floor,
      standingQuoteAbove: monitor._raiseBelow, standingBid: monitor.lastBidPrice != null ? monitor.lastBidPrice : null,
      landedBids: monitor.landedBids, closesInMs: state ? state.closesInMs : null });
    // Once per round: a new round clears the stand-down and re-derives it, and the desk hears it again.
    if (monitor._raiseAlertedRound === monitor.extendsObserved) return;
    monitor._raiseAlertedRound = monitor.extendsObserved;
    this.emit({ type: 'alert', level: 'warn', kind: 'bid_price_raise_refused', auctionId: monitor.auctionId,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName, branchName: monitor.meta.branchName || null,
      price: decision.price, amountCap: cap, floor,
      standingBid: monitor.lastBidPrice != null ? monitor.lastBidPrice : null, landedBids: monitor.landedBids,
      standingQuote: monitor._raiseBelow != null ? monitor._raiseBelow : null, round: monitor.extendsObserved });
  }

  /**
   * The countdown to the tracker's close when that close came from a cross-check (a listing or detail
   * read) and the read's own feed still shows another one: a socket frozen at a close the listing
   * says has moved, or a GoComet enquiry the detail read shows reopened.
   */
  _withTrackerClose(monitor, state) {
    const t = monitor._round;
    const at = numericOrNull(state.closesAtMs);
    if (at != null && state.closesInMs > 0) monitor._feedSkewMs = at - state.closesInMs - Date.now();
    if (!t || (t.closeSource !== 'rest' && t.closeSource !== 'reopen') || !Number.isFinite(t.closeAt) || t.closeAt === at) return state;
    if (!monitor.provisionalClose && monitor.softStrategy === 'off') return state;
    const platformNow = Date.now() + (Number.isFinite(state.serverOffsetMs) ? state.serverOffsetMs : (monitor._feedSkewMs || 0));
    return { ...state, closesAtMs: t.closeAt, closesInMs: t.closeAt - platformNow };
  }

  /**
   * A countdown frozen past a close that is not final gets ONE read of the portal, off the money path:
   * SuperProcure's listing, GoComet's enquiry detail. Until it answers nothing is bid; an answer nobody
   * gives within FROZEN_CHECK_TIMEOUT_MS is unanswered, and T4's floor fallback runs (ruling 57). A FINAL
   * round is never checked: its verdict never reads UNCERTAIN_AFTER_CLOSE.
   */
  _checkFrozenClose(monitor) {
    const t = monitor._round;
    if (!t || monitor.finalized || (!monitor.provisionalClose && monitor.softStrategy === 'off')) return;
    const f = roundTracker.frozenCheck(t);
    if (f) {
      if (f.state === 'pending' && Date.now() - f.since >= FROZEN_CHECK_TIMEOUT_MS) {
        this._answerFrozen(monitor, f.closeAt, { kind: 'unanswered' });
      }
      return;
    }
    if (this.roundVerdict(monitor).verdict !== 'UNCERTAIN_AFTER_CLOSE') return;
    const closeAt = t.closeAt;
    roundTracker.startFrozenCheck(t, Date.now());
    const read = monitor.provisionalClose ? this.adapter.closeProbe : this.adapter.listingProbe;
    if (typeof read !== 'function') {
      this._answerFrozen(monitor, closeAt, { kind: 'unanswered' });
      return;
    }
    Promise.resolve().then(() => read.call(this.adapter, monitor.auctionId))
      .then((r) => this._frozenAnswer(monitor, closeAt, r), () => ({ kind: 'unanswered' }))
      .then((ans) => this._answerFrozen(monitor, closeAt, ans))
      .catch((e) => this.log.error('frozen-countdown close check failed; it times out to the floor fallback', {
        auctionId: monitor.auctionId, err: (e && e.message) || String(e) }));
  }

  _frozenAnswer(monitor, closeAt, r) {
    if (!r) return { kind: 'unanswered' };
    if (monitor.provisionalClose) {
      const later = plausibleCloseAt(r.closesAtMs, Date.now());
      if (later != null && later - closeAt >= GC_REOPEN_MIN_MS) return { kind: 'later', closeAt: later, source: 'reopen' };
      return { kind: r.status === 'open' ? 'open' : 'same', source: 'reopen' };
    }
    if (r.stillListed == null) return { kind: 'unanswered' };
    const listed = r.stillListed && r.biddingOn !== false && typeof this.adapter.listedCloseAt === 'function'
      ? this.adapter.listedCloseAt(monitor.auctionId) : null;
    const later = plausibleCloseAt(listed, Date.now());
    const inc = monitor._round.extendMs || UNPUBLISHED_EXTEND_MS;
    if (later != null && later - closeAt >= 0.5 * inc) return { kind: 'later', closeAt: later, source: 'rest' };
    return { kind: 'same' };
  }

  _answerFrozen(monitor, closeAt, ans) {
    const t = monitor._round;
    if (!t || monitor.finalized || this.killed) return;
    const res = roundTracker.answerFrozenCheck(t, closeAt, ans, Date.now());
    if (!res.changed) return;
    this.log.info('frozen-countdown close check answered', { auctionId: monitor.auctionId, answer: ans.kind, closeAt,
      laterCloseAt: ans.closeAt != null ? ans.closeAt : null, rounds: t.rounds });
    mirrorRound(this, monitor, res);
    this._persistRound(monitor, res.kind != null);
  }

  // Frozen countdown with nothing answered: no check was possible, or it failed or timed out.
  _frozenCheckUnanswered(monitor) {
    const f = roundTracker.frozenCheck(monitor._round);
    return !f || f.state === 'unanswered';
  }

  /**
   * GoComet: the held zero is not finalized the first time its detail read said the enquiry
   * is still open at the same close - that restarts the debounce once. A later close already moved the
   * tracker's close, so the countdown is no longer zero.
   */
  _reopenHoldsFinalize(monitor) {
    const f = roundTracker.frozenCheck(monitor._round);
    if (!f) return false;
    if (f.state !== 'open' || f.deferred) return false;
    f.deferred = true;
    monitor._zeroSince = Date.now();
    this.log.info('GoComet detail still shows the enquiry open at its close; finalize held one more window', {
      auctionId: monitor.auctionId, closeAt: f.closeAt });
    return true;
  }

  /**
   * Ruling 60: a published close moving forward past the close in force when submissionClosed
   * latched means the latch's premise no longer holds. Called where the round tracker's close moves the
   * belief forward in _observeExtension; the tracker infers no round from a frozen zero, so it never
   * clears the latch.
   */
  _clearSubmissionClosedOnForwardMove(monitor, closeAt) {
    if (!monitor.submissionClosed) return;
    if (monitor._submissionClosedAtClose == null || !(closeAt > monitor._submissionClosedAtClose)) return;
    monitor.submissionClosed = false;
    monitor._submissionClosedAtClose = null;
    if (monitor.noBid && monitor.noBid.reason === 'submission_window_closed') monitor.noBid = null;
    this.log.info('a published close moved past the submission-closed latch; the load can bid again', {
      auctionId: monitor.auctionId, closeAt, lane: monitor.meta.lane, companyName: monitor.meta.companyName });
  }

  /**
   * The round verdict for this monitor (t9-design s4.1), the one reader of the round state. R and C come
   * from the monitor's mirrors (ruling 56 (a)); the tracker supplies UNCERTAIN, the reason and the roundId.
   */
  roundVerdict(monitor, nowMs = Date.now()) {
    const cap = monitor.provisionalClose ? this._provisionalCap(monitor)
      : (monitor.extendCap == null ? 'unknown' : monitor.extendCap);
    return roundTracker.verdict(monitor._round || null, nowMs, { rounds: Number(monitor.extendsObserved) || 0, cap,
      closeModel: monitor.closeModel, closeAt: numericOrNull(monitor.believedCloseAt) });
  }

  /** A GoComet load's cap: the rounds so far once our own submit showed no extension, else the plant's. */
  _provisionalCap(monitor) {
    const c = monitor._round && monitor._round.cap;
    return c && c.source === 'gc_submit' ? c.value : this._finalAfterExtensions(monitor);
  }

  /** The load's own round cap: null for an uncapped plant, the default when the load carries none. */
  _finalAfterExtensions(monitor) {
    const rp = normaliseRoundPolicy(monitor.meta && monitor.meta.roundPolicy);
    return rp ? rp.finalAfterExtensions : DEFAULT_FINAL_AFTER_EXTENSIONS;
  }

  /** The declared write runway, presence-tested: a portal that declares none keeps the floor window. */
  _writeRunwayMs() {
    const w = this.caps.snipeBudgetMs;
    return ((typeof w === 'number' && Number.isFinite(w) && w >= 0) ? w : this.cfg.floorWindowMs)
      + (this.caps.durableSubmissionTracking ? GC_SUBMISSION_PERSIST_MS : 0);
  }

  /**
   * A provisional-close load's countdown at this instant: its exact close against the server clock
   * now (ruling 52). The countdown the read carried is as old as the read's response and whatever the
   * engine did since, and near the close that age is the difference between the buzzer and after the
   * close. An adapter that publishes no server clock keeps the countdown it read.
   */
  _provisionalRemainingMs(state) {
    const { closesAtMs, serverOffsetMs } = state;
    if (typeof closesAtMs !== 'number' || !Number.isFinite(closesAtMs)
        || typeof serverOffsetMs !== 'number' || !Number.isFinite(serverOffsetMs)) return state.closesInMs;
    return closesAtMs - (Date.now() + serverOffsetMs);
  }

  _buzzerMs() {
    return this._writeRunwayMs() + PROVISIONAL_READ_INTERVAL_MS + PROVISIONAL_COUNTDOWN_QUANTUM_MS;
  }

  /**
   * Piece C: tell the tracker a pre-final shot of ours landed. On GoComet the submit response can open
   * the next round at once, so R and the close are mirrored here, before the next poll.
   */
  _observeOwnWrite(monitor, state, res, decidedAt, acceptedAt, roundId) {
    const t = monitor._round;
    if (!t || monitor.closeModel !== 'soft') return;
    const provisional = monitor.provisionalClose;
    // A decision state from before a round the tracker has since opened times this write against the old
    // close, and the submit response then reads as a second move (260928J43Q's phantom round 4).
    const stateClose = numericOrNull(state.closesAtMs);
    const timedOn = provisional && Number.isFinite(t.closeAt) && stateClose != null && t.closeAt - stateClose >= realCloseMoveMs(state)
      ? { ...state, closesAtMs: t.closeAt } : state;
    const out = roundTracker.observeOwnWrite(t, { acceptedAt, roundId: roundId || this.roundVerdict(monitor, acceptedAt).roundId,
      countdownAtLandMs: provisional ? this._provisionalRemainingMs(timedOn)
        : bidGapsMs({ closesInMs: state.closesInMs, decidedAt, ts: acceptedAt }).landingMs,
      submitResponse: provisional ? { bidClosingInMs: res.bidClosingInMs } : null,
      triggerWindowMs: monitor.triggerWindowMs, extendMs: extendIncrementMs(state) });
    this.log.info('own pre-final shot observed by the round tracker', { auctionId: monitor.auctionId,
      probe: t.probe, counted: out.counted, rounds: t.rounds });
    if (!out.counted) return;
    monitor.extendsObserved = t.rounds;
    if (t.closeAt != null && (monitor.believedCloseAt == null || t.closeAt > monitor.believedCloseAt)) {
      monitor.believedCloseAt = t.closeAt;
      this._clearSubmissionClosedOnForwardMove(monitor, t.closeAt);
    }
    for (const e of out.events) {
      if (e.type !== 'cap_exceeded' || monitor._capExceededAlerted) continue;
      monitor._capExceededAlerted = true;
      this.emit({ type: 'alert', level: 'warn', kind: 'extend_cap_exceeded', auctionId: monitor.auctionId,
        extendsObserved: e.rounds, cap: e.cap, lane: monitor.meta.lane, companyName: monitor.meta.companyName });
    }
  }

  /**
   * Carry the round record and a forward move of the believed close onto the DURABLE intent, so a
   * restart or a re-price resumes the same round count (ruling 41) and the boot supervisor does not
   * retire an auction the engine knows is still running.
   *
   * The close is FORWARD-ONLY and plausibility-bounded, so a stale read can never pull the durable close
   * back into the retire window and a placeholder far-future close is never persisted. One write, only
   * when something durable changed. A failed write is raised to the desk once per window (ruling 18);
   * the tracker stays dirty, so the next tick writes the whole record again.
   */
  _persistRound(monitor, closeMoved) {
    const t = monitor._round;
    const it = this.scheduler.get(monitor.auctionId);
    if (!t || !it) return;
    const at = plausibleCloseAt(monitor.believedCloseAt, Date.now());
    const durableClose = numericOrNull(it.closesAt);
    // A close first seen on a load armed without one is a seed, not a confirmed move.
    const advance = at != null && (durableClose == null ? closeMoved : durableClose < at);
    if (!roundTracker.isDirty(t) && !advance) return;
    const patch = { round: roundTracker.durable(t) };
    if (advance) patch.closesAt = at;
    try {
      this.scheduler.update(monitor.auctionId, patch);
      roundTracker.markClean(t);
    } catch (e) {
      this._recordWriteFailed(monitor, 'round_record_failed',
        'We could not save the round count for this load. Bidding continues; a restart before it saves could misjudge the final round.',
        e, { closesAt: at, rounds: t.rounds });
    }
  }

  /**
   * "Effectively hard" (D1) = the final-window floor snipe is allowed to fire. A capped soft auction
   * becomes hard-close once its round is FINAL. TRUE for: a hard-close load; a soft-off monitor
   * (Module-1 endgame); a soft load with an UNKNOWN cap (D4 fail-closed degrade - treat believed close as
   * final and run the proven hard snipe, never loop chasing phantom extensions); or a known-cap soft load
   * whose round verdict is FINAL. Combined with the live floorWindowMs countdown check in _decide, an
   * unexpected extension (F5) pushes the countdown back up and defers the snipe on its own.
   */
  _effectivelyHard(monitor) {
    if (monitor.closeModel !== 'soft') return true;
    if (monitor.softStrategy === 'off') return true;
    if (monitor.extendCap == null) return true;          // UNKNOWN cap -> fail closed to Module-1 snipe (D4)
    return this.roundVerdict(monitor).verdict === 'FINAL';
  }

  /**
   * Per-load trigger-window telemetry for the R0 shadow phase (design E2e). The trigger window
   * (per-load branchAuctionRemainingTime; per-branch - 100 on most configs, 200 on Shriji, 0 on
   * Havells-hard) is the seconds-remaining threshold at which a bid CAUSES an anti-snipe extension. It
   * is deliberately NOT a money-path decision input: the non-final defend is reserve-gated identically
   * whether it lands inside the window ("knowingly-spent extend") or outside it ("free"), and D6 forbids
   * a competitor-timed branch that would make the two differ. But the shadow harness must RECORD, per
   * would-have-done decision, the window and whether the decision lands inside it, so an operator can
   * validate the causal hypothesis (does a bid inside the window actually extend?) against observed
   * extensions and quantify self-triggered extensions before any live graduation. This is the field's
   * one honest consumer. FAIL CLOSED: an unread window (SP omitted branchAuctionRemainingTime) yields
   * insideTriggerWindow null (unknown) - never a guessed window, never a decision off a fabricated value.
   */
  // A088: `known` now agrees with _softFinalShotBand's own definition of a usable window (w > 0) -
  // a published window of 0 "has no anti-snipe mechanic to dodge" there, so telemetry reporting it
  // as a KNOWN window (and computing insideTriggerWindow off it) disagreed with the rule that
  // actually fires. This is shadow-only (R0), never a money-path input either way.
  _triggerWindowTelemetry(monitor, remaining) {
    const w = monitor.triggerWindowMs;
    const known = w != null && Number.isFinite(w) && w > 0;
    return { triggerWindowMs: known ? w : null, insideTriggerWindow: known ? (remaining <= w) : null };
  }

  /**
   * The soft-close analogue of floorWindowMs: the band in which a decisive shot is both LATE and still
   * FINAL. On a soft branch a bid landing inside the anti-snipe trigger window is precisely what causes
   * the next extension, so the last moment a decisive shot can land AND be the last word is the
   * floorWindowMs-wide band immediately ABOVE the trigger-window boundary.
   *
   * Returns null when the branch publishes no usable window - no window is invented (D6), and a
   * published window of 0 (a hard window wearing a soft close model) has no anti-snipe mechanic to
   * dodge. Both cases fall back to the deployed last-chance answer.
   */
  _softFinalShotBand(monitor) {
    const w = monitor.triggerWindowMs;
    if (w == null || !Number.isFinite(w) || w <= 0) return null;
    return { opensAt: w + this.cfg.floorWindowMs, closesAt: w };
  }

  /**
   * The decisive band for THIS load, but only when it is the rule actually in force - i.e. only when
   * `remaining` falling into it is what releases the reserved rung. Null everywhere else, and null is
   * the answer that leaves every caller on its deployed behaviour.
   *
   * It exists so the SCHEDULER and the DECISION cannot disagree about where the decisive shot goes.
   * They were separate before, and that is the whole of B4: _softEndgameUnlocked returned true inside
   * a 2,500ms band that _cadence's 30-second far poll never offered the engine a tick inside. One
   * predicate, two readers - the poll planner and the rung selector - is the only shape in which
   * "reachable" and "correct" are the same statement.
   *
   *   extensions still remain  -> null. The reserve-gated defend path owns the load; nothing to aim at.
   *   known cap reached, or 0  -> null. No extension is left for a bid to trigger, so the final bid
   *                               goes in the last-chance window like hard close.
   *   no published window      -> null. No window is ever invented (D6).
   *   otherwise                -> the band. Only the unknown-cap (extendCap == null) case gets here,
   *                               which _effectivelyHard fails closed to true (D4): the believed close is
   *                               treated as final, but a bid inside the window might still extend it.
   */
  _decisiveBandFor(monitor) {
    if (!monitor) return null;
    if (monitor.closeModel !== 'soft' || monitor.softStrategy === 'off') return null;
    if (!this._effectivelyHard(monitor)) return null;
    if (monitor.extendCap != null) return null;
    return this._softFinalShotBand(monitor);
  }

  /**
   * May the RESERVED decisive rung (the floor) be spent now, on a soft branch?
   *
   * This is the money-path successor to a bare _effectivelyHard test, and it exists because
   * _effectivelyHard answers a different question than the one the fire point needs. _effectivelyHard
   * says "are extensions exhausted"; releasing the rung also needs "and would this shot actually END
   * the auction". The deployed build conflated the two and released the floor at _isLastChance -
   * floorWindowMs is 2.5s, while every real soft branch publishes a 100-200 SECOND trigger window, so
   * the decisive shot landed ~97s inside the window that re-opens the auction. Observed live on 4 of 4
   * Havells soft auctions (2026-07-25): the floor was spent at 2.2-2.4s against a 100s window, which
   * extended the auction by another 180s with our best price on the board and no rung left to answer.
   *
   *   extensions genuinely remain  -> false. The disciplined reserve-gated defend path, unchanged.
   *   cap UNKNOWN                  -> release in the band ABOVE the trigger window, where the shot
   *                                   cannot start another round.
   *   known cap reached            -> the _isLastChance answer: nothing is left to extend.
   *   published window 0 / unknown -> the deployed _isLastChance answer. No fabricated window (D6).
   *
   * NOTE what this deliberately does NOT do: it never returns a predicate that no countdown value can
   * satisfy. `_isLastChance(remaining) && !_insideTriggerWindow(...)` reads as the natural rule and is
   * the EMPTY SET for every real branch (remaining <= 2_500 AND remaining > 100_000), which would
   * forfeit every soft load instead of self-extending it - strictly worse than the bug. The band is
   * what makes the rule reachable; test-softclose-decisive-shot-timing.js D3 pins that.
   */
  _softEndgameUnlocked(monitor, remaining) {
    // Extensions still outstanding -> hold the reserve. Also short-circuits every hard / soft-off /
    // unknown-cap case to _effectivelyHard's own answer, exactly as before.
    if (!this._effectivelyHard(monitor)) return false;
    // The band, resolved through the SAME predicate the poll planner uses (_decisiveBandFor), so the
    // scheduler cannot aim somewhere the decision does not release, or vice versa. Null means a known
    // cap (0 or reached - nothing left to self-trigger) or an unpublished window (no window is
    // invented, D6); each takes the last-chance answer.
    const band = this._decisiveBandFor(monitor);
    if (band == null) return this._isLastChance(remaining);
    if (remaining <= band.opensAt && remaining > band.closesAt) return true;
    // Already inside the window with the rung unspent (armed late, or the band was missed): the
    // deployed last-chance answer still governs. Such a shot MAY self-extend - accepted deliberately,
    // because forfeiting the load outright is strictly worse than starting one more round at our best
    // price. See _lastResortFloor for the same trade made at the hold sites.
    return this._isLastChance(remaining);
  }

  /**
   * Is the single decisive shot due NOW? Hard-close and non-allowlisted loads keep _isLastChance
   * byte-for-byte (this predicate is the identity function for them); only an allowlisted soft load
   * routes through the trigger-window-aware unlock above.
   */
  _decisiveShotDue(monitor, remaining) {
    if (monitor.closeModel === 'soft' && monitor.softStrategy !== 'off') {
      return this._softEndgameUnlocked(monitor, remaining);
    }
    return this._isLastChance(remaining);
  }

  /**
   * NEVER FORFEIT. The soft-close defend branch has five discretionary HOLD paths - blind rank, no
   * reserve slack, the once-per-round latch, the outside-the-window gate, and selectRung declining -
   * and every one of them returns null. The final-snipe branch sits BELOW that branch in _decide, so a
   * hold landing on the genuinely-last tick forfeited the load with the reserved rung never spent.
   *
   * That is not theoretical. Three Havells Alwar loads (Rs 1,25,000) were lost exactly this way: a
   * REJECTED establish bid banks firedRungs + currentRungIndex and the restore block rolls back only
   * snipeFired and _lastDefendAtExtend, so currentRungIndex stays >= 0 and the establish branch is
   * closed forever. Nothing ever LANDS, so SuperProcure never self-matches us, our own rank stays null
   * for the life of the auction, and the blind-rank guard holds on every one of the ~900 remaining
   * ticks. The in-code claim that "holding can cost margin; it can never cost the auction" was false.
   *
   * So a hold is never the last word WHEN NOTHING IS ON THE BOARD. On the final tick, with zero landed
   * bids and the reserved rung still unspent, the floor fires. A shot here may itself trigger one more
   * extension - that trade is taken knowingly: an extension leaves us leading at our best price,
   * silence leaves us with no bid on this load at all.
   *
   * SCOPE, and the one deliberate BEHAVIOUR CHANGE in this branch. This guard used to fire only at
   * landedBids === 0 - the zero-participation case - and explicitly left the reserve suppression on a
   * load we are already bidding (test-softclose-extend-sequences T1b) untouched, on the grounds that
   * flipping it was a principal's call about reserve strategy rather than something to decide inside a
   * forfeit guard. That call has since been made, and it was made by the loads:
   *
   *   - the reported live symptom is "not bidding properly, only the first being placed" - i.e. the
   *     establish bid LANDS and the engine never fires again. That is landedBids === 1, which the
   *     narrow scope excluded by construction;
   *   - 15 soft loads across three customers (13 Havells, 1 Epack, 1 Shriji) closed with their floor
   *     unspent while armed and priced. These were winnable; we held instead of bidding.
   *
   * The suppression's own reasoning is what fails on the last tick. It holds the floor because "a price
   * spent early can be undercut for the rest of the auction" - which is sound mid-auction and vacuous
   * at the buzzer, where there is no rest of the auction to be undercut in. The choice at
   * _isLastChance, outranked, is not "spend now vs spend later"; it is "spend now vs never spend". A
   * bid there may itself trigger one more round, and that is the trade taken knowingly and for the same
   * reason as before: an extension leaves us LEADING at our best price, silence leaves us beaten with
   * the price unsent. Firing weakly dominates - we cannot go below the floor on either branch, so the
   * hold has no upside it does not also have after firing.
   *
   * WHAT STILL HOLDS THE FLOOR, so this is not a blanket release:
   *   - rank 1. Winning is sacred; an L1 we hold is never given away.
   *   - any tick that is not the last one. _isLastChance is the first line of this function, so the
   *     mid-auction reserve-gated defend (T2, T3's "none before") is untouched.
   *   - a shot already in flight or spent (snipeFired), and the explicit attempt bound below.
   *   - an allowlisted soft load outranked before its cap: _softPreCapBuzzerShot sends the next
   *     middle price instead, and falls back here only when no middle price or no second revision is
   *     left.
   * T1b, D5b and N2 are updated to the new expectation rather than deleted, and each says in its
   * assertion message that this was a deliberate strategy change - so a future reader finds the
   * decision, not a silently different number.
   *
   * Winning is still sacred (rank 1 is never given away).
   *
   * SPENT MEANS LANDED, NOT OFFERED - the contract, stated explicitly because getting it wrong is
   * what made the first version of this guard fail in exactly the way it exists to prevent. It used
   * to also gate on `firedRungs.has(last)`. But firedRungs is a bank of what was OFFERED: the
   * rejection handler adds the rung the moment SuperProcure refuses it, and the nothing-placed
   * restore rolls back only snipeFired. So ONE non-cap refusal of the floor latched this guard off
   * for the rest of the auction, and the load closed with nothing on the board and budget still in
   * hand - the identical forfeit, one level deeper. Simulated over 300 loads: 300 never retried.
   *
   * A refused bid put nothing on the board, so the decisive shot is still owed. The guard therefore
   * reads only facts that mean something LANDED:
   *   landedBids   - the participation fact, incremented only where a bid actually reached the board
   *                  (rejections excluded, uncertain-outcome throws counted fail-closed), durable
   *                  across restart and re-price. Zero here means nothing is standing, full stop.
   *   snipeFired   - true only while a shot is in flight or was consumed by a shadow run; every
   *                  NOTHING-PLACED outcome (429, non-cap reject, throw-proved-not-landed) restores it.
   *
   * ...and it bounds ITSELF. `lastResortFloorAttempts` is an explicit per-load cap on how many times
   * the release may offer the floor. The diagnosis is specific that maxBidsPerMin must not be the
   * only brake - its gate returns BEFORE _decide is called, so a retry loop upstream can consume the
   * budget this shot needs, which is how the cap became the cause of a loss it was cited as the cure
   * for. A guard that can retry needs a bound it owns.
   *
   * WHAT IT NO LONGER DOES: it does not emit the desk notice. That is a MONEY CLAIM ("lowest price
   * sent") and this function only DECIDES - in shadow mode nothing is written to the wire at all, and
   * in live mode the bid can still be refused. The notice is emitted at the fire point, after an
   * accepted response, like every other money claim in this engine. `lastResort: true` on the returned
   * decision is what carries the intent there.
   *
   * @returns {null|{price:number, rungIndex:number, snipe:boolean, lastResort:boolean}} null to hold,
   *   or the reserved floor rung.
   */
  _lastResortFloor(monitor, state, remaining, last) {
    if (!this._isLastChance(remaining)) return null;          // not the last tick -> a hold is just a hold
    if (monitor.snipeFired) return null;                      // a decisive shot is in flight / was spent
    if (state.myRank === 1) return null;                      // leading: never give away an L1 we hold
    // The floor may already be STANDING on the board from an accepted bid, in which case there is
    // nothing left to release and re-sending it would burn a revision to change nothing. This reads
    // the two facts together deliberately: a banked floor index means it was OFFERED, and only a
    // banked index ON a load that has something on the board means it LANDED. Either alone is the
    // read that produced the two defects this guard exists to close.
    if (monitor.landedBids > 0 && monitor.firedRungs.has(last)) return null;
    const attempts = monitor._lastResortFloorAttempts || 0;
    if (attempts >= this.softCfg.lastResortFloorAttempts) {
      this.log.debug('last-resort floor: attempt bound reached, holding', { auctionId: monitor.auctionId,
        attempts, bound: this.softCfg.lastResortFloorAttempts, remainingMs: remaining });
      return null;
    }
    monitor._lastResortFloorAttempts = attempts + 1;
    this.log.debug('last-resort floor: releasing the reserved rung rather than forfeiting the load', {
      auctionId: monitor.auctionId, remainingMs: remaining, myRank: state.myRank,
      attempt: monitor._lastResortFloorAttempts, bound: this.softCfg.lastResortFloorAttempts,
      currentRungIndex: monitor.currentRungIndex, firedRungs: [...monitor.firedRungs],
      revisionsLeft: monitor.revisionsLeft, extendsObserved: monitor.extendsObserved,
      extendCap: monitor.extendCap, price: monitor.ladder[last], rungIndex: last,
      ...this._triggerWindowTelemetry(monitor, remaining) });
    return { price: monitor.ladder[last], rungIndex: last, snipe: true, lastResort: true };
  }

  // Outranked in the last SP_PROBE_LEAD_MS of a round before the cap: one shot at the next unfired
  // middle price, never the floor, which is kept for the final round. The shot lands inside the
  // trigger window, so it is also what carries the auction into the next round if no rival bids, and
  // whether the close moves after it tells the tracker if this round was the last (ruling 40). With no
  // rank, one revision or no middle price left, the never-forfeit floor release decides at the buzzer.
  // An UNCERTAIN round (a probe still pending included) sends the floor at the buzzer if outranked
  // (ruling 47), and so does a countdown frozen past the close with nothing to check it against
  // (ruling 57); an unknown cap keeps the shipped shot (ruling 57).
  _softPreCapBuzzerShot(monitor, state, remaining, last) {
    const v = this.roundVerdict(monitor);
    if (v.verdict === 'UNCERTAIN_AFTER_CLOSE') {
      return this._frozenCheckUnanswered(monitor) ? this._lastResortFloor(monitor, state, remaining, last) : null;
    }
    if (v.verdict === 'UNCERTAIN' && v.reason !== 'uncapped_no_evidence') {
      // Outranked means outranked by a read that can show our probe.
      if (v.reason === 'probe_pending' && !this._ownBidSettled(monitor, state)) return null;
      // Past the close a pending probe is the frozen-zero check's to answer, not a buzzer floor's.
      if (v.reason === 'probe_pending' && !(remaining > 0)) return null;
      return this._lastResortFloor(monitor, state, remaining, last);
    }
    if (monitor._shotRoundId === v.roundId) return null;
    if (state.myRank == null || (monitor.revisionsLeft != null && monitor.revisionsLeft <= 1)) {
      return this._lastResortFloor(monitor, state, remaining, last);
    }
    const spent = this._selectableExclusions(monitor);
    const reachAt = this._reachableAt(monitor, this._minDecrementFor(monitor, state.minDecrement));
    let next = monitor.currentRungIndex + 1;
    while (next < last && (spent.has(next) || (reachAt != null && monitor.ladder[next] > reachAt))) next++;
    if (next >= last) return this._lastResortFloor(monitor, state, remaining, last);
    this.log.debug('rung selected: pre-cap buzzer shot at the next middle price (floor kept for the final round)', {
      auctionId: monitor.auctionId, remainingMs: remaining, rungIndex: next, price: monitor.ladder[next],
      myRank: state.myRank, extendsObserved: monitor.extendsObserved, extendCap: monitor.extendCap,
      revisionsLeft: monitor.revisionsLeft });
    return { price: monitor.ladder[next], rungIndex: next, buzzerShotRoundId: v.roundId, probe: true };
  }

  // After a landed non-floor final shot the floor still goes at the buzzer while we are outranked,
  // bounded by the same attempt cap as the last-resort release. A rank read that may still be the
  // pre-shot rank is not acted on (_ownBidSettled).
  _softFloorAfterFinalShot(monitor, state, remaining, last) {
    if (monitor.closeModel !== 'soft' || monitor.softStrategy === 'off') return null;
    // extendCap 0 is a hard window wearing a soft close model, and hard close keeps its single shot.
    if (monitor.extendCap === 0) return null;
    if (!this._isLastChance(remaining)) return null;
    if (state.myRank == null || state.myRank === 1) return null;
    if (monitor.firedRungs.has(last)) return null;
    if (!this._ownBidSettled(monitor, state)) return null;
    const attempts = monitor._lastResortFloorAttempts || 0;
    if (attempts >= this.softCfg.lastResortFloorAttempts) return null;
    monitor._lastResortFloorAttempts = attempts + 1;
    this.log.debug('rung selected: floor after a non-floor final shot, still outranked', {
      auctionId: monitor.auctionId, remainingMs: remaining, myRank: state.myRank, price: monitor.ladder[last],
      rungIndex: last, currentRungIndex: monitor.currentRungIndex, revisionsLeft: monitor.revisionsLeft,
      attempt: monitor._lastResortFloorAttempts });
    return { price: monitor.ladder[last], rungIndex: last, snipe: true, floorFollowUp: true };
  }

  // Gives back the release attempt _decide spent (the last-resort release or the post-shot floor) when
  // the decision put nothing on the portal (ruling 20). An uncertain outcome keeps it spent.
  /**
   * Watch for our own standing bid at `price` after a write whose transport failed: true when the
   * portal shows it, false when reads answered and never did, null when no read carried the field.
   * Bounded by OWN_BID_CONFIRM_MS and by half the time left, so it cannot eat the close.
   */
  async _confirmOwnBid(monitor, price, closesInMs) {
    const budget = Math.min(OWN_BID_CONFIRM_MS, Number.isFinite(closesInMs) ? Math.max(0, closesInMs / 2) : OWN_BID_CONFIRM_MS);
    // Counted reads, not a wall-clock deadline: a frozen or stepped clock must not stretch the wait.
    const reads = Math.max(1, Math.floor(budget / OWN_BID_POLL_MS) + 1);
    let answered = false;
    for (let i = 0; ; i++) {
      let rb = null;
      try { rb = await this.adapter.getAuctionState(monitor.auctionId); } catch (_) {}
      if (rb && rb.ok && Object.prototype.hasOwnProperty.call(rb, 'myAmount')) {
        answered = true;
        if (rb.myAmount != null && Number(rb.myAmount) === Number(price)) {
          monitor.myRank = rb.myRank;
          return true;
        }
      }
      if (i + 1 >= reads) return answered ? false : null;
      await new Promise((r) => setTimeout(r, OWN_BID_POLL_MS));
    }
  }

  /**
   * P6: mark a just-landed bid as waiting for its rank to become visible. One marker per monitor,
   * always the most recently landed bid - a later landed bid overwrites it, so an earlier one that
   * never got a rank read never has its slot stolen by a later bid's rank (ruling P6: no back-fill).
   * No decidedAt (a caller with nothing to correlate against) arms nothing rather than a marker
   * bidLogger could never match back to the right ourBids entry.
   */
  _armRankWatch(monitor, decidedAt, price) {
    if (monitor && decidedAt != null) monitor._pendingRankStamp = { decidedAt, price };
  }

  // A SuperProcure load whose socket never ranked us (the Epack logins) leaves the walk nothing to hold
  // at L1 on, so after each accepted write in the walk's window the adapter reads our rank once off the
  // OPEN tab. Not awaited: until it lands the rank stays unknown and D-C decides as before.
  _askLiveRank(monitor, state, price) {
    if (typeof this.adapter.requestLiveRank !== 'function' || monitor.provisionalClose || !this._walkOn(monitor)) return;
    if (!(state.closesInMs <= this.walkCfg.sp.maxWalkWindowMs)) return;
    try { this.adapter.requestLiveRank(monitor.auctionId, price); } catch (_) {}
  }

  // Holding L1 on a REST rank, nothing tells us of a rival undercut: one more read per round, asked early
  // enough that its answer can act by the last step's latest start (ruling 28's defence), even queued
  // behind another read on this login. Its answer reaches the walk as an ordinary rank; if it fails or
  // is late, the rank 1 read in this round keeps us holding (one read before it is not a rank here).
  _checkLiveRankHold(monitor, state, remaining, t, roundId) {
    if (!state.rankFromRest || state.myRank !== 1 || monitor._liveRankCheckedRound === roundId
        || typeof this.adapter.requestLiveRank !== 'function') return;
    const deadline = walkMath.stepDeadlineMs(1, t);
    const lead = LIVE_RANK_READ_BUDGET_MS + (Number(this.adapter.liveRankGapMs) || 0);
    if (!(remaining > deadline && remaining <= deadline + lead)) return;
    monitor._liveRankCheckedRound = roundId;
    try { this.adapter.requestLiveRank(monitor.auctionId, monitor.lastBidPrice); } catch (_) {}
  }

  // The rank the walk decides on. A REST rank sent before this round began says nothing about it. A rank 1
  // from before holds until the round's check read has had its chance (the last step's deadline), then
  // is unknown (D-C); any other rank from before is unknown at once. The first round has no known start.
  _walkRank(monitor, state, v, remaining, t) {
    if (!state.rankFromRest) return state.myRank;
    const seen = monitor._walkRoundSeen;
    const since = seen && seen.id === v.roundId ? seen.at : -Infinity;
    if (Number(state.restRankAt) >= since) return state.myRank;
    return state.myRank === 1 && remaining > walkMath.stepDeadlineMs(1, t) ? 1 : null;
  }

  // A round is dated on the clock REST ranks are dated on (send time). One opened by our own write, landed
  // in the ended round inside its trigger window, starts at that write's accept, so the read that reports
  // what the write achieved counts in the round it opened; otherwise it starts when the walk sees it.
  _noteWalkRound(monitor, v) {
    const seen = monitor._walkRoundSeen;
    if (!seen) { monitor._walkRoundSeen = { id: v.roundId, at: -Infinity }; return; }
    if (seen.id === v.roundId) return;
    let at = Date.now();
    const ll = monitor._lastLanded;
    if (ll && ll.roundId === seen.id && monitor._lastLandedAt != null
        && (ll.triggerWindowMs == null || !(ll.countdownMs > ll.triggerWindowMs))) at = Math.min(at, monitor._lastLandedAt);
    monitor._walkRoundSeen = { id: v.roundId, at };
  }

  /** True when a read carries our own standing amount and it is `price`. */
  _showsOwnBid(state, price) {
    return !!state && Object.prototype.hasOwnProperty.call(state, 'myAmount')
      && state.myAmount != null && price != null && Number(state.myAmount) === Number(price);
  }

  /**
   * Whether the rank on `state` can be taken as including our last landed bid: at once when the read
   * shows our own landed amount, otherwise only after rankSettleMs.
   */
  _ownBidSettled(monitor, state) {
    if (monitor._lastLandedAt == null || Date.now() - monitor._lastLandedAt >= this.cfg.rankSettleMs) return true;
    return this._showsOwnBid(state, monitor.lastBidPrice);
  }

  /**
   * After an accepted bid on a push-fed state, re-read the socket cache every rankFollowMs until it
   * shows our own amount, then run the next tick at once instead of when the cadence falls due. Only
   * pulls a tick forward, so the tick chain and every decision on it are unchanged when the frame
   * never arrives, and a state that is not push-fed (a read costing a request) is never followed.
   */
  _followOwnBid(monitor) {
    const every = this.cfg.rankFollowMs;
    const last = monitor._lastOkState;
    const marker = monitor._pendingRankStamp;
    if (!(every > 0) || !last || last.pushFed !== true || !marker) return;
    const landedAt = Date.now();
    const poll = async () => {
      if (monitor._pendingRankStamp !== marker || monitor.finalized || this.killed || this.discarded) return;
      if (Date.now() - landedAt >= this.cfg.rankSettleMs) return;
      if (!monitor._tickInFlight) {
        let st = null;
        try { st = await this.adapter.getAuctionState(monitor.auctionId); } catch (e) {
          if (!monitor._followReadFailLogged) {
            monitor._followReadFailLogged = true;
            this.log.warn('re-read of the socket cache after our bid failed; the next tick decides on the ordinary cadence', {
              auctionId: monitor.auctionId, err: (e && e.message) || String(e) });
          }
        }
        if (monitor._pendingRankStamp !== marker || monitor.finalized || this.killed || this.discarded) return;
        if (st && st.ok && this._showsOwnBid(st, marker.price) && !monitor._tickInFlight) {
          this._schedule(monitor, 0);
          return;
        }
      }
      const t = setTimeout(poll, every);
      if (t.unref) t.unref();
    };
    const t = setTimeout(poll, every);
    if (t.unref) t.unref();
  }

  /**
   * Resolve that marker against a state read that came back after the write landed - the ordinary
   * tick refresh and the one authoritative read at close (_finalize), plus GoComet's submit response
   * at landing (_takeResponseRank), which carries the rank the write produced.
   *
   * On SuperProcure (state carries a `myAmount` key even when null) the read must also show OUR OWN
   * amount at the bid's own price before it counts - otherwise a rank read left over from the
   * PREVIOUS bid, taken before the portal has caught up to this one, would be mistaken for this
   * bid's rank-visible moment. GoComet publishes no such field, so there is nothing to verify against
   * and any rank-carrying read after the marker was armed resolves it (a known precision gap on any
   * platform with no own-amount field to check against).
   */
  _maybeStampRankVisible(monitor, state, at = Date.now()) {
    const marker = monitor._pendingRankStamp;
    // A REST rank's timing is the read's, not the platform's: never a step-time sample.
    if (!marker || !state || state.myRank == null || state.rankFromRest) return;
    if (Object.prototype.hasOwnProperty.call(state, 'myAmount') && !this._showsOwnBid(state, marker.price)) return;
    monitor._pendingRankStamp = null;
    this.emit({ type: 'rank_visible', auctionId: monitor.auctionId, decidedAt: marker.decidedAt, rankVisibleAt: at });
  }

  /**
   * GoComet's accepted submit carries our rank on the price just written (quote_rank), so the rank
   * stamp resolves at landing, and with bid_closing_in the response stands in for the next read. A
   * read that publishes our own amount (SuperProcure's socket) is left to prove the rank itself.
   */
  _takeResponseRank(monitor, state, res, landedAt) {
    if (res.myRank == null || Object.prototype.hasOwnProperty.call(state, 'myAmount')) return;
    this._maybeStampRankVisible(monitor, { myRank: res.myRank }, landedAt);
    const after = this._stateFromResponse(monitor, state, res, landedAt);
    if (!after) return;
    monitor._responseState = { state: after, at: landedAt };
    this._schedule(monitor, 0);
  }

  /**
   * The read a GoComet bidding-data GET would return at landing: the deciding read with the response's
   * rank and the close re-derived from bid_closing_in on the same server clock, snapped to the whole
   * second as the adapter snaps it. Without a server clock or a live countdown there is no close to
   * derive, and the next tick reads as before.
   */
  _stateFromResponse(monitor, state, res, landedAt) {
    if (!monitor.provisionalClose || !(this.cfg.responseStateMaxAgeMs > 0)) return null;
    const inMs = res.bidClosingInMs;
    const offset = state.serverOffsetMs;
    if (!Number.isFinite(inMs) || !(inMs > 0) || !Number.isFinite(offset)) return null;
    const serverNow = landedAt + offset;
    let closesAtMs = inMs % 1000 === 0
      ? Math.ceil((serverNow + inMs) / 1000 - 0.5) * 1000 : serverNow + inMs;
    // bid_closing_in is whole seconds counted before we received it, so this close can read up to about
    // a second late. Short of a real move the deciding read's close stands, or the last step goes late.
    const readClose = numericOrNull(state.closesAtMs);
    if (this._walkOn(monitor) && readClose != null && closesAtMs > readClose && closesAtMs - readClose < realCloseMoveMs(state)) {
      closesAtMs = readClose;
    }
    return { ...state, status: 'live', myRank: res.myRank, closesAtMs, closesInMs: closesAtMs - serverNow,
      revisionsLeft: res.revisionsLeft != null ? res.revisionsLeft : monitor.revisionsLeft };
  }

  /**
   * GoComet: when an accepted write landed against the close the engine believed when it decided, both
   * on the server's clock. Positive means the portal took a bid after our derived close, which is the
   * evidence for or against a bias in the whole-second snap (2026-09-26, 260925NP9V: +2,040 ms).
   */
  _landedVsCloseMs(monitor, state, budgetCtx, landedAt) {
    if (!monitor.provisionalClose || !Number.isFinite(state.serverOffsetMs)) return null;
    const closeAt = numericOrNull(budgetCtx.believedCloseAt);
    return closeAt == null ? null : Math.round(landedAt + state.serverOffsetMs - closeAt);
  }

  /** The response state _takeResponseRank left, re-timed to now, while it is fresher than the bound. */
  _consumeResponseState(monitor) {
    const r = monitor._responseState;
    monitor._responseState = null;
    if (!r || !(Date.now() - r.at < this.cfg.responseStateMaxAgeMs)) return null;
    return { ...r.state, closesInMs: r.state.closesAtMs - (Date.now() + r.state.serverOffsetMs) };
  }

  _refundReleaseAttempt(monitor, decision) {
    if (!decision || !(decision.lastResort || decision.floorFollowUp)) return;
    if (monitor._lastResortFloorAttempts > 0) monitor._lastResortFloorAttempts -= 1;
  }

  _softLastRevision(monitor) {
    return monitor.closeModel === 'soft' && monitor.softStrategy !== 'off'
      && monitor.revisionsLeft != null && monitor.revisionsLeft <= 1;
  }

  // A soft load in its final round keeps its last revision for the buzzer floor, and after a landed
  // final shot the only follow-up is that floor, never a further walk down the middle prices.
  _softStepDownHeld(monitor) {
    if (monitor.closeModel !== 'soft' || monitor.softStrategy === 'off') return false;
    return monitor.snipeFired || this._softLastRevision(monitor);
  }

  // Branches with three bids or fewer keep two back before the cap - one for the pre-cap buzzer shot,
  // one for the final-round floor - so no in-window defend spends either.
  _softReserve(state) {
    const budget = this._attemptBudget(state);
    if (budget != null && budget <= LOW_CAP_THRESHOLD) return Math.max(this.softCfg.reserve, 2);
    return this.softCfg.reserve;
  }

  /**
   * This load's minimum bid decrement, best source first.
   *
   * The live state read wins when it carries one. Below that sits the DURABLE per-load rule -
   * SuperProcure's `loadBidDifference`, which rides `meta.rules` onto the intent and is restored on
   * every re-arm and rehydrate - and only then the platform's static capability default. That
   * ordering is not new; _bidOpts and the payload builders already read `rules.minDecrement` with
   * exactly this fallback. It matters here because the capability default is 100 on SuperProcure
   * while a real load's difference has been observed at 1,500: reading the default on a wide load
   * understates the decrement fifteenfold, and every reachability question below is decided by it.
   * `lastMinDecrement` is in-memory only and is null on a monitor a restart has just rebuilt, which
   * is exactly when a re-price is most likely to be judged against it.
   */
  _minDecrementFor(monitor, stateMinDecrement) {
    if (stateMinDecrement != null) return stateMinDecrement;
    if (monitor.lastMinDecrement != null) return monitor.lastMinDecrement;
    const rules = monitor.meta && monitor.meta.rules;
    if (rules && rules.minDecrement != null) return Number(rules.minDecrement);
    return this.caps.minDecrement;
  }

  /**
   * The highest price a NEW bid on this load may carry, given what we already have standing.
   * Null when nothing stands. One rule (pricing.maxImprovementPrice), asked at two strengths, and
   * the difference between them is deliberate:
   *
   *   _reachableAt(monitor, minDec)  - SELECTION. Prefer a rung that also clears the platform's
   *                                    stated decrement, because that is the one the portal is most
   *                                    likely to take.
   *   _mustImproveOn(monitor)        - REFUSAL. Only what is CERTAIN: a price at or above our own
   *                                    standing bid improves on nothing and cannot be accepted by
   *                                    any reverse auction.
   *
   * Refusals are held to the certain rule on purpose. This engine reserves the floor rung as a
   * decisive final shot and exempts it from the decrement guard so it is never silently dropped -
   * scripts/test-gocomet-close-model.js and test-engine-ladder-invariants.js both pin a floor
   * landing 630 below the previous bid on a load whose stated decrement is larger than that. Widening
   * the refusal to the decrement would drop that shot and forfeit loads this engine currently wins.
   * Whether a portal really enforces its decrement against our OWN previous bid on the floor rung is
   * a separate, open question about rejection handling, and it is not settled here.
   */
  _reachableAt(monitor, minDecrement) {
    return maxImprovementPrice(monitor.lastBidPrice, minDecrement);
  }

  /**
   * The certain half of the rule above: a new price must be strictly below our standing bid.
   *
   * Gated on LANDED evidence for the same reason standingBid() is: shadow sets lastBidPrice without
   * placing anything, and a refusal derived from it would stand a load down - and write
   * `noBid: new_floor_above_standing_bid` onto its receipt - over a board with nothing on it.
   */
  _mustImproveOn(monitor) {
    if (!(monitor.landedBids > 0)) return null;
    return maxImprovementPrice(monitor.lastBidPrice, 1);
  }

  /**
   * Refuse a price the portal cannot take because our own standing bid is already below it, and say
   * so - once per load - on the log and the desk alert.
   *
   * NOT on the close-time receipt, and the docstring used to claim it was. It cannot be: this
   * refusal only exists when landedBids > 0 (see _mustImproveOn), and _finalize nulls noBidReason
   * on exactly that condition, so auction_result carries null for this reason every time. The
   * receipt is right to do that - a load with a bid on the board did not fail to bid - and the fact
   * the receipt actually owes BRL is a different one: the cost was corrected AFTER the standing bid,
   * so the close came in under the corrected number. That needs the corrected cost on record, which
   * is the surface layer's half, not this one's. Stating a delivery channel that does not exist is
   * how a reader stops looking for the one that has to be built.
   *
   * Called from BOTH sites that can reach this state, because they are one refusal seen from two
   * places: _decide when no rung of a re-armed ladder is reachable at all, and the belt in
   * _maybeBid when some other decision path (the reserved floor shot, the rank-driven snipe, a
   * rehydrate or a scheduled wake) produced one anyway. A held bid that nobody is told about is the
   * failure this whole change exists to remove - on 260908LD2Z the desk was told the correction had
   * been applied and then heard nothing for 114 minutes.
   */
  _holdAboveStandingBid(monitor, price, reachAt) {
    this._recordRefusal(monitor, 'new_floor_above_standing_bid',
      { standingBidPrice: monitor.lastBidPrice, floor: monitor.floor });
    if (monitor._unreachableLadderAlerted) return;
    monitor._unreachableLadderAlerted = true;
    // Logged independently of the emit. `emit` only pushes to an in-memory ring and hands the event
    // to onEvent, and whether a NEW alert kind reaches WhatsApp depends on the notify layer's own
    // routing sets - so without this line a refusal on live money could exist on no channel a human
    // reads, `pm2 logs` included.
    this.log.error('holding this load: no price is below our own standing bid, so nothing further can be bid', {
      auctionId: monitor.auctionId, price, reachAt, standingBidPrice: monitor.lastBidPrice,
      floor: monitor.floor, opening: monitor.ladder[0] });
    this.emit({ type: 'alert', level: 'error', kind: 'reprice_unreachable_ladder',
      auctionId: monitor.auctionId, standingBidPrice: monitor.lastBidPrice,
      // The desk's own corrected number, carried so the notice can state the gap the desk cares
      // about (our bid vs their rate) rather than the gap between two prices they never typed.
      correctedCost: (monitor.intent && monitor.intent.cost != null) ? monitor.intent.cost : null,
      // Which desk correction built this monitor, so the notify side can tell whether the page
      // already showed this hold. 0 means none: a first capture or a restart on one.
      repriceEpoch: Number.isInteger(monitor.repriceEpoch) ? monitor.repriceEpoch : 0,
      floor: monitor.floor, opening: monitor.ladder[0], price, reachAt,
      detail: `the lowest price we can now bid (${monitor.floor}) does not improve on our standing bid `
        + `${monitor.lastBidPrice} - this load cannot be bid again and nothing further will be sent`,
      // the scope-routing keys every desk notice needs, or this falls back to the unscoped
      // all-loads recipients (the same miss ceiling_below_floor had).
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      // The lane ends resolved at arm, carried for the same reason the outcome receipts carry them:
      // this notice renders a route line, and on GoComet the raw lane is two postal addresses.
      laneCells: monitor.meta.laneCells || null,
      branchName: monitor.meta.branchName || null });
  }

  /**
   * The re-price left exactly one price on this ladder the portal can still take: its floor.
   *
   * Deliberately NOT _recordRefusal and NOT the reprice_unreachable_ladder alert, which are the
   * sibling guard's and mean something stronger. A refusal record would put "nothing could be bid"
   * on the close-time receipt of a load that may well bid its floor at the buzzer and win, and the
   * alert's own desk copy says the new rate cannot be bid on this load - false here. Telling a human
   * something false on live money is worse than the log line this replaces.
   *
   * So it records the state where an HTTP surface can read it (snapshot), latched once per load,
   * with the log escalated off debug because a hold nobody can see is the failure mode this whole
   * branch exists to remove. The desk-facing rendering of a held load belongs to the surface layer,
   * not here.
   */
  _noteFloorOnlyBiddable(monitor, reachAt) {
    if (monitor.floorOnlyBiddable) return;
    monitor.floorOnlyBiddable = { standingBidPrice: monitor.lastBidPrice, floor: monitor.floor, reachAt };
    this.log.warn('this re-price leaves only the floor below our own standing bid - every rung above it would be refused', {
      auctionId: monitor.auctionId, standingBidPrice: monitor.lastBidPrice, floor: monitor.floor,
      opening: monitor.ladder[0], reachAt });
  }

  /**
   * What this load currently has standing on the portal, for the re-price API's reachability gate.
   * Read off the LIVE monitor before a re-price replaces it. Null when this load has no monitor or
   * has never landed a bid - in which case any ladder is reachable and the gate does not apply.
   */
  standingBid(auctionId) {
    const monitor = this.monitors.get(String(auctionId));
    if (!monitor) return null;
    // LANDED evidence, not the in-memory price. The shadow branch sets lastBidPrice so its trace has
    // a number while placing nothing on the wire, so without this a shadow load reports a standing
    // price for a board that is empty - and the re-price gate then refuses a legitimate desk
    // correction on a load that has never been bid. Same rule priorLandedBidPrice applies durably.
    if (!(monitor.landedBids > 0)) return null;
    const price = Number(monitor.lastBidPrice);
    if (!Number.isFinite(price) || !(price > 0)) return null;
    return { price, minDecrement: this._minDecrementFor(monitor, null) };
  }

  /**
   * Bank a bid that landed after its own monitor was retired.
   *
   * stop() deletes the monitor without waiting on bidInProgress, so a re-price landing mid-flight
   * retires the monitor that fired while its write was still on the wire. The write reached the
   * portal, so the durable facts are persisted here, and where a re-arm has already built the
   * successor they are handed to it as well - it read its standing price from the intent as it
   * stood BEFORE this write, so it is carrying null.
   */
  _recordLandedAfterRetire(monitor, decision, res, decidedAt = null, writeLandedAt = null, confirmFlags = null) {
    const price = decision.price;
    const live = this.monitors.get(monitor.auctionId);
    const reArmed = !!(live && live !== monitor);
    // Read the INTENT, not the retired monitor. A successor can land its own bid and persist it
    // while this write is still on the wire, so the retired monitor's landedBids and revisionsLeft
    // are frozen at the moment it fired and would erase the newer facts.
    const prior = this.scheduler.get(monitor.auctionId) || {};
    const priorLanded = Number(prior.landedBids);
    const landedBids = (Number.isFinite(priorLanded) ? priorLanded : monitor.landedBids) + 1;
    const standing = lowestStandingPrice(prior.landedBidPrice, price);
    let revisionsLeft = monitor.revisionsLeft;
    if (res.revisionsLeft != null) revisionsLeft = res.revisionsLeft;
    else if (revisionsLeft != null) revisionsLeft -= 1;
    // Same staleness, opposite direction: believing we hold revisions the platform has already
    // taken ends in a terminal CAP rejection, so the lower of the two beliefs is the fail-closed one.
    // The null test is explicit and NOT Number.isFinite: Number(null) is 0, which is finite, and
    // `revisionsLeft: null` is the ordinary SuperProcure state (realAdapter reports revisionLimit
    // null), so testing only finiteness reads "unknown" as "none left" and clamps the load to zero
    // revisions - standing it down for the rest of the auction with a green receipt.
    // The mirror case is why `revisionsLeft != null` is NOT a condition on this block: the retired
    // monitor ordinarily carries null on SuperProcure, so gating on it wrote that null over a durable
    // 0 - the terminal exhausted-cap state - and the engine then fired refused writes against a cap
    // the platform had already closed. A known prior always beats an unknown current.
    // THIS write's own spend is not in the intent yet - landedBids composes as priorLanded + 1 for
    // exactly that reason - so the prior belief has to be charged for it before the two are compared.
    // Taking the raw minimum instead discarded the spend whenever the successor had already persisted
    // the lower count, and the engine then believed it held a revision the platform had already
    // taken: one write past the real cap, typically the reserved buzzer shot, refused terminally.
    const priorRev = Number(prior.revisionsLeft);
    if (prior.revisionsLeft != null && Number.isFinite(priorRev)) {
      const priorAfterThisWrite = Math.max(0, priorRev - 1);
      revisionsLeft = revisionsLeft != null ? Math.min(priorAfterThisWrite, revisionsLeft) : priorAfterThisWrite;
    }
    // This landing's facts were never captured, so the last landing is unknown - never the earlier one.
    // foreignSlotUncounted rides the same patch as everBid, for the same reason (see priorForeignSlotUncounted
    // in arm()) - union with the disk value rather than overwrite, so a successor that already
    // detected and persisted it is never undone by this retired monitor's own, possibly-stale belief.
    const foreignSlotUncounted = !!(prior.foreignSlotUncounted || monitor.foreignSlotUncounted);
    const patch = { everBid: true, landedBids, landedBidPrice: standing, revisionsLeft, lastLanded: null, foreignSlotUncounted };
    if (res.gcAttemptId && prior.pendingGcSubmission && prior.pendingGcSubmission.attemptId === res.gcAttemptId) patch.pendingGcSubmission = null;
    // A rung INDEX only means anything against the ladder it was fired on, and landedBidPrice is
    // the ladder-independent fact this branch added for exactly that reason. So the index is
    // persisted only where no re-arm has replaced that ladder on the intent; writing it after one
    // would mark a rung of the NEW ladder spent at a price this bid never offered.
    if (!reArmed && decision.rungIndex != null) {
      const firedRungs = new Set(monitor.firedRungs);
      firedRungs.add(decision.rungIndex);
      patch.firedRungs = [...firedRungs];
    }
    // Both callers sit where a throw is misread (the accepted path's catch is the uncertain-outcome
    // handler) or escapes _maybeBid, and the successor hand-off and bid_placed below must still run.
    try {
      this.scheduler.update(monitor.auctionId, patch);
      if (patch.pendingGcSubmission === null) this._clearGcPending(monitor, res.gcAttemptId);
    } catch (persistErr) {
      this._recordWriteFailed(monitor, 'bid_record_failed',
        'A bid on this load went out just as bidding on it was being changed or stopped, and it could not be saved to our records. Please check this load on the portal.',
        persistErr, { price, rungIndex: decision.rungIndex });
    }
    // Bring the successor up to the durable truth. NOT "only when it carries null": arm() seeds it
    // from the intent as it stood BEFORE this write, so on a load that had already landed a bid the
    // successor starts non-null and STALE-HIGH, and a belt reading that price passes rungs the
    // portal will refuse. Lowest wins here for the same reason it does on the intent.
    // Keyed on `live`, not on reArmed: the caller's bail also fires on this.killed, and kill() leaves
    // the monitor in this.monitors, so on that half live IS this monitor - never retired, still the
    // one resume() ticks. Skipping it there left the live monitor at landedBids 0 with a bid standing
    // on the portal, so standingBid() and _mustImproveOn() both read null and the engine could re-offer
    // above its own live bid, which is the refusal loop this branch exists to end.
    if (live) {
      if (live.lastBidPrice == null || live.lastBidPrice > standing) live.lastBidPrice = standing;
      if (live.landedBids < landedBids) live.landedBids = landedBids;
      live._lastLanded = null;
      // The reconciled count belongs on the live monitor for the same reason the price does, and it
      // has nowhere else to come from: realAdapter.getAuctionState reports revisionLimit null on
      // every tick, so a successor seeded before this write spent its revision stays overstated for
      // the rest of the auction and keeps firing into a cap SuperProcure has already closed - ending
      // in a terminal CAP rejection on live money. Lower wins, the same fail-closed direction the
      // durable reconciliation above takes.
      if (revisionsLeft != null && (live.revisionsLeft == null || live.revisionsLeft > revisionsLeft)) {
        live.revisionsLeft = revisionsLeft;
      }
    }
    // A bid that reached the board is a bid the business has to be able to see. bidLogger._onBid is
    // the only writer of closedBids.ourBids and of the daily bids stream, and it is driven by this
    // event alone - so banking the durable facts without emitting leaves a real bid that BRL's own
    // History panel and day-1 log deny ever happened, and the project treats that record as
    // un-backfillable.
    //
    // The rung index is dropped on a re-arm exactly as the durable firedRungs write drops it: the
    // ladder those indices refer to has been replaced, and the notify layer keys its per-rung dedupe
    // on the number, so carrying a stale one would swallow the successor's own bid line.
    //
    // `establishing: false` is what keeps that dropped index from being read as rung 0. The DM filter
    // in notifier._whatsapp keys the one "First bid" ping on `Number(data.rungIndex) > 0`, and
    // Number(null) is 0 - so without this the banked write pings DMs a SECOND first-bid message, on a
    // load that already had one, quoting cost/openingPct off the RETIRED monitor's intent (the
    // pre-correction rate the desk has just changed). A bid banked after its own monitor was retired
    // is never the establishing bid: either the load was already bid, or the successor is about to
    // place its own opening. The fact is stated here rather than inferred from an index that is
    // deliberately absent.
    const pricing = monitor.intent || {};
    const bandMargins = Array.isArray(pricing.marginsPct) ? pricing.marginsPct.map(Number).filter(Number.isFinite) : [];
    this.emit({ type: 'bid_placed', auctionId: monitor.auctionId, price,
      establishing: false,
      ...(res.unconfirmed ? { landingUnconfirmed: true } : {}),
      rungIndex: (!reArmed && decision.rungIndex != null) ? decision.rungIndex : null,
      rank: res.myRank != null ? res.myRank : null,
      revisionsLeft: res.revisionsLeft != null ? res.revisionsLeft : null,
      socketRank: null,
      closesInMs: null, decidedAt, writeLandedAt, latencyMs: res.latencyMs != null ? res.latencyMs : null,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null,
      cost: pricing.cost != null ? pricing.cost : null,
      openingPct: bandMargins.length ? Math.max(...bandMargins) : null,
      lowestPct: bandMargins.length ? Math.min(...bandMargins) : null,
      ...(confirmFlags || {}),
      ...this._budgetContext(monitor) });
    // P6: whichever monitor keeps ticking this auction is the one that can ever observe the rank
    // this bid produced - never the retired one, since nothing ticks it again.
    this._armRankWatch(live, decidedAt, price);
  }

  /**
   * The refused twin of _recordLandedAfterRetire: a write SuperProcure turned down, resolving after
   * its own monitor was retired.
   *
   * It cannot simply fall into the three-class handler below. That block advances and then restores
   * the retired monitor's own ladder bookkeeping - currentRungIndex, firedRungs, the endgame latches
   * - and none of that is read by anything again, because nobody ticks a retired monitor. What DOES
   * outlive the retire is the durable half, and leaving it out is what made the bare `return` here a
   * money defect rather than an omission: the CAP latch never fired, so the successor kept firing
   * against a per-load budget the platform had already closed, which is terminal for the load.
   */
  _recordRefusedAfterRetire(monitor, decision, res, state, bidOpts, fireToken) {
    const live = this.monitors.get(monitor.auctionId);
    // A refused bid still used the wire and SP may well have counted it against the per-load cap
    // before refusing it, so "we have bid this load" is true here exactly as it is on the ordinary
    // rejection path. Nothing is added to landedBids: a refusal put nothing on the board.
    // foreignSlotUncounted rides along the same write, unioned with disk rather than overwritten -
    // see the identical note in _recordLandedAfterRetire.
    try {
      const priorForeign = (this.scheduler.get(monitor.auctionId) || {}).foreignSlotUncounted;
      this.scheduler.update(monitor.auctionId, { everBid: true,
        foreignSlotUncounted: !!(priorForeign || monitor.foreignSlotUncounted) });
    } catch (err) {
      this._recordWriteFailed(monitor, 'bid_record_failed',
        'A bid on this load went out just as bidding on it was being changed or stopped, and it could not be saved to our records. Please check this load on the portal.',
        err, {});
    }
    this.log.debug('placeBid rejected after its monitor was retired', { auctionId: monitor.auctionId,
      price: decision.price, rungIndex: decision.rungIndex, reason: res.reason });
    this.emit({ type: 'bid_rejected', auctionId: monitor.auctionId, price: decision.price,
      reason: res.reason, status: res.status != null ? res.status : null,
      body: res.text != null ? res.text : (typeof res.raw === 'string' ? res.raw : null),
      carrierSent: res.carrierSent != null ? res.carrierSent : null,
      rungIndex: decision.rungIndex != null ? decision.rungIndex : null,
      closesInMs: state ? state.closesInMs : null,
      lastSeenInListAgoMs: null, biddingOn: null,
      ...this._budgetContext(monitor) });
    // Whatever monitor is live now - after a re-price that is the successor, which is the one that
    // would otherwise spend the rest of the auction firing writes SuperProcure is already refusing
    // on the shared live account. Every stand-down class below latches on it for that reason.
    const target = live || monitor;
    // LOAD-NOT-BIDDABLE: terminal for the LOAD, and it outlives the monitor that happened to be
    // firing exactly as the cap does - the refusal is a property of the load, not of our price, our
    // timing or our session. Left out, this function emitted a bid_rejected with no stand-down
    // anywhere behind it: the successor kept firing (the ~23 refused writes the live path's latch
    // exists to prevent) and _finalize had no reason recorded, so the receipt fell back to the
    // generic "a rate was entered but no bid could be placed before close" - which sends the desk
    // hunting a pricing mistake that does not exist. revisionsLeft is deliberately NOT zeroed, the
    // same as on the live path: the budget genuinely is intact, and zeroing it would hand a later
    // re-price a phantom exhausted load. The live listing probe is not run from here - it is U1
    // telemetry on a path that has a monitor to keep, and this one has already been retired.
    if (!target.loadNotBiddable && isLoadNotBiddableRejection(res)) {
      target.loadNotBiddable = true;
      this._recordRefusal(target, 'load_not_biddable');
      this.log.error('platform refused the bid because the load is not open to bidding; standing down on this load', {
        auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
        reason: res.reason, body: res.text != null ? res.text : null,
        closesInMs: state ? state.closesInMs : null });
      // A finalized (or otherwise retired-with-no-successor) target has nothing left to act on the
      // notice - there is no successor to stand down and the desk already has its close receipt -
      // so the alert would only repeat a decision already made, on a load that is already closed.
      // The re-price door's successor is never finalized here, so it still gets the notice.
      if (!target.finalized) {
        this.emit({ type: 'alert', level: 'warn', kind: 'load_not_biddable', auctionId: monitor.auctionId,
          // The SCOPE keys, as on every desk notice: without a shipper (and a branch where the
          // customer is split by one) no scoped group matches and the notice falls to the unscoped
          // all-loads recipients.
          lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          branchName: monitor.meta.branchName || null });
      }
    }
    // The three remaining stand-down classes, mirrored from the live rejection path onto the same
    // target and for the same reason: each is a property of the load or of what stands on the board,
    // not of the monitor that fired, so a successor left unlatched re-sends what was just refused.
    if (isQuantityRefusedRejection(res)) {
      const vcqSent = (bidOpts && bidOpts.vcq != null) ? bidOpts.vcq : null;
      const unitsOnLoad = (target.meta && target.meta.units != null) ? target.meta.units : null;
      target.quantityRefused = true;
      if (vcqSent != null && (target.quantityRefusedAtVcq == null || vcqSent < target.quantityRefusedAtVcq)) {
        target.quantityRefusedAtVcq = vcqSent;
      }
      this._recordRefusal(target, 'vehicle_count_refused', { vcqSent, units: unitsOnLoad });
      this.log.error('platform refused the bid because the quoted vehicle count exceeds the load total; standing down on this load', {
        auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
        reason: res.reason, body: res.text != null ? res.text : null, vcqSent, units: unitsOnLoad });
      const qtyAlertDue = !target._qtyRefusedAlerted
        || (vcqSent != null && target._qtyRefusedAlertedAtVcq != null && vcqSent < target._qtyRefusedAlertedAtVcq);
      if (qtyAlertDue && !target.finalized) {
        target._qtyRefusedAlerted = true;
        target._qtyRefusedAlertedAtVcq = vcqSent;
        this.emit({ type: 'alert', level: 'warn', kind: 'vehicle_count_refused', auctionId: monitor.auctionId,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          branchName: monitor.meta.branchName || null, vcqSent, units: unitsOnLoad });
      }
    }
    if (!target.priceRaiseRefused) {
      // Judged against the TARGET's floor: after a re-price that is the successor's ladder, and an
      // amount cap it can still meet is an ordinary walk-down, not a stand-down.
      const targetFloor = target.ladder[target.ladder.length - 1];
      const raise = raiseRefusal(res, targetFloor);
      // The unconditional GoComet latch rests on the lower standing quote not being one this monitor
      // sent. Across a retire it can be the successor's own landed bid, because stop() does not wait
      // for a write already on the wire - and latching on that stands the successor down for good.
      // F1: it can also be the successor's own LOWER write still in flight, landed bid or not yet -
      // this compares against both and takes the lower (W1-7 r2 named residual 2).
      const otherInFlight = this._lowestOtherInFlightPrice(monitor.auctionId, fireToken);
      let ourLowest = target.lastBidPrice;
      if (otherInFlight != null && (ourLowest == null || otherInFlight < ourLowest)) ourLowest = otherInFlight;
      if (raise && raise.cap == null && ourLowest != null && ourLowest <= decision.price) {
        this.log.info('a retired write was refused as a price raise over our own standing or in-flight bid; not standing down', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          reason: res.reason, standingBid: target.lastBidPrice, otherInFlight });
      } else if (raise && raise.cap == null && !target.finalized && this._continueBelowStanding(target, decision, res, null)) {
        // The target's next decision bids below the standing quote.
      } else if (raise) {
        if (raise.cap != null) this._noteRaiseBelow(target, raise.cap + 1);
        target.priceRaiseRefused = true;
        target.priceRaiseRefusedCap = raise.cap;
        target._raiseAlertedRound = target.extendsObserved;
        this._recordRefusal(target, 'price_raise_refused', raise.cap != null ? { amountCap: raise.cap } : {});
        this.log.error('the portal refused the bid because the price may not be raised; standing down rather than walking the ladder down', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          reason: res.reason, body: res.text != null ? res.text : null, amountCap: raise.cap, floor: targetFloor,
          standingBid: target.lastBidPrice != null ? target.lastBidPrice : null, landedBids: target.landedBids });
        if (!target.finalized) {
          this.emit({ type: 'alert', level: 'warn', kind: 'bid_price_raise_refused', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            price: decision.price, amountCap: raise.cap, floor: targetFloor,
            standingBid: target.lastBidPrice != null ? target.lastBidPrice : null,
            landedBids: target.landedBids, round: target.extendsObserved,
            standingQuote: target._raiseBelow != null ? target._raiseBelow : null });
        }
      }
    }
    if (!target.submissionClosed && isSubmissionClosedRejection(res)) {
      target.submissionClosed = true;
      target._submissionClosedAtClose = target.believedCloseAt;
      this._recordRefusal(target, 'submission_window_closed');
      this.log.error('the portal refused the bid because the submission window is closed; standing down on this load', {
        auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
        reason: res.reason, body: res.text != null ? res.text : null, closesInMs: state ? state.closesInMs : null,
        believedCloseAt: target.believedCloseAt, landedBids: target.landedBids });
      if (!target.finalized) {
        this.emit({ type: 'alert', level: 'warn', kind: 'submission_window_closed', auctionId: monitor.auctionId,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          branchName: monitor.meta.branchName || null,
          closesInMs: state ? state.closesInMs : null, landedBids: target.landedBids });
      }
    }
    if (!isBidCapRejection(res)) return;
    // Terminal for this load's BUDGET, and the budget is the one belief that survives a re-arm.
    if (target.capExhausted) return;
    target.capExhausted = true;
    target.revisionsLeft = 0;
    target._noRevAlerted = true;
    const reason = (typeof res.reason === 'string' && res.reason)
      || (typeof res.text === 'string' && res.text)
      || (typeof res.body === 'string' && res.body)
      || 'Bid limit exceeded';
    this.log.error('platform refused the bid for an exceeded per-load bid limit; stopping all further bids on this load', {
      auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex, reason });
    this._recordRefusal(target, 'bid_cap_exhausted');
    try {
      this.scheduler.update(monitor.auctionId, { revisionsLeft: 0 });
    } catch (err) {
      this._recordWriteFailed(monitor, 'bid_record_failed',
        'This load reached the portal\'s limit on bids, but that could not be saved to our records. A restart before it saves could try to bid again.',
        err, {});
    }
    // Same finalize door as the load-not-biddable sibling above: the latches and the recorded
    // refusal stay unconditional (the close receipt still needs the reason), but a finalized
    // target has already been reported on and has no successor left to stand down.
    if (!target.finalized) {
      this.emit({ type: 'alert', level: 'error', kind: 'bid_cap_exhausted', auctionId: monitor.auctionId,
        lane: monitor.meta.lane, companyName: monitor.meta.companyName, reason });
    }
  }

  // `detail` is fixed prose: the raw fs error names the data path and this channel reaches the
  // client's Director. The error itself goes to the log only.
  // At most one DELIVERED alert per load and kind per writeFailRealertMs window, whether or not a
  // write succeeded in between. Two things can each drop an alert at delivery and neither retries on
  // its own: the notifier's sender can be down, or its persistent dedupe mark is written to the same
  // volume whose failure raised this alert in the first place, so on a failing or flapping disk it
  // never lands. Ruling 59 (W1-1 V3-F01): INSIDE the window, a fault re-offers the SAME episode once
  // writeFailReofferMs has passed since the last offer - engineAlerts puts the episode in the dedupe
  // key, so once one offer actually delivers, the notifier's own mark absorbs every later offer in
  // this episode without minting a second alert. Only once the whole window elapses does a fault open
  // a NEW episode (a fresh key, a fresh chance to page the desk even if the old one is somehow stuck).
  _recordWriteFailed(monitor, kind, detail, err, facts) {
    this.log.error('a durable write for this load failed', { auctionId: monitor.auctionId, kind, ...facts,
      err: (err && err.message) ? err.message : String(err) });
    if (!monitor._writeFailEpisodes) monitor._writeFailEpisodes = new Map();
    const entry = monitor._writeFailEpisodes.get(kind);
    const now = Date.now();
    let episode;
    if (!entry || now - entry.episode >= this.cfg.writeFailRealertMs) {
      episode = now;
      monitor._writeFailEpisodes.set(kind, { episode, lastOfferAt: now });
    } else if (now - entry.lastOfferAt >= this.cfg.writeFailReofferMs) {
      episode = entry.episode;
      entry.lastOfferAt = now;
    } else {
      return;
    }
    this.emit({ type: 'alert', level: 'error', kind, auctionId: monitor.auctionId, detail, episode,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName || null,
      branchName: monitor.meta.branchName || null });
  }

  _decide(monitor, state) {
    const remaining = state.closesInMs;
    const last = monitor.ladder.length - 1;
    // RANK-DRIVEN gate (the reversibility spine at the DECISION layer). True only for a shipper on the
    // rung-expansion allowlist (softStrategy !== 'off' = soft-close enabled AND this shipper opted in).
    // When true, the engine runs the NEW rank-driven endgame (establish-late, rank-aware snipe, k-driven
    // step-down); when false it runs the DEPLOYED logic (the clock-scheduled step-down via
    // _scheduledRungIndex and the always-floor snipe) behind a softOpenAtMs establish gate. Gated on the
    // ALLOWLIST, NEVER on ladder length - so a non-allowlisted customer with a >3-tier desk band still
    // runs the deployed path, and nothing changes for any existing customer until they are opted in.
    const rankDriven = monitor.softStrategy !== 'off';

    // CEILING below the floor (Module 2 L5): the shipper's cap is under our operating floor, so any
    // bid that respects the ceiling would breach the floor. FAIL CLOSED - never bid. This is not a
    // silent clamp in either direction: we do not bid at the ceiling (that breaches the floor) nor at
    // the floor (that breaches the ceiling) - we stand down and alert once, so the pricer sees the
    // load cannot win profitably. Same shape as stood_down_below_floor (the price-visible analogue).
    if (monitor.ceilingBelowFloor) {
      // Recorded on EVERY tick, not only the first: the alert is latched (once per load) but the
      // refusal is the standing state of this load, and close time must read it whether or not this
      // process is the one that raised the alert (a restart mid-auction re-arms and re-decides, but
      // never re-alerts). Carries the ceiling so the outcome receipt can name the number.
      this._recordRefusal(monitor, 'ceiling_below_floor', { ceiling: monitor.ceiling, floor: monitor.floor });
      if (!monitor._ceilingBlockedAlerted) {
        monitor._ceilingBlockedAlerted = true;
        // cost rides along so the desk notice can name what we actually entered, not just the two
        // derived figures - monitor.intent carries it (pricing.cost) from the arm that set ceilingBelowFloor.
        const enteredCost = (monitor.intent && Number.isFinite(Number(monitor.intent.cost)))
          ? Math.round(Number(monitor.intent.cost)) : null;
        this.emit({ type: 'alert', level: 'error', kind: 'ceiling_below_floor', auctionId: monitor.auctionId,
          ceiling: monitor.ceiling, floor: monitor.floor, cost: enteredCost,
          detail: `shipper ceiling ${monitor.ceiling} is below the cost floor ${monitor.floor} - cannot win profitably, not bidding`,
          // lane/companyName/branchName are the SCOPE-ROUTING keys this alert needs now that it is a
          // desk notice rather than an error: without them no per-customer (or branch-split) group
          // can match it, and it falls back to the unscoped all-loads recipients - which is exactly
          // how it ended up in the Director's DMs instead of the desk's group.
          lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          branchName: monitor.meta.branchName || null });
      }
      return null;
    }

    // PRICE-VISIBLE platforms: undercut the standing L1 by the min decrement.
    if (this.caps.standingPriceVisible && state.standingL1Price != null) {
      if (state.myRank === 1) return null; // holding L1, give away nothing
      const undercut = computeUndercut({
        standingL1Price: state.standingL1Price,
        minDecrement: state.minDecrement != null ? state.minDecrement : this.caps.minDecrement,
        costFloor: monitor.floor,
      });
      if (undercut == null) {
        // The COST-FLOOR refusal: the standing L1 cannot be undercut without going below our floor,
        // so we hold. Deliberate and already stated in its own alert - recorded on every tick it
        // still applies (the alert itself stays once-per-load via stoodDown), same reasoning as the
        // ceiling stand-down above.
        this._recordRefusal(monitor, 'stood_down_below_floor', { floor: monitor.floor });
        if (!monitor.stoodDown) {
          monitor.stoodDown = true;
          this.emit({ type: 'alert', level: 'info', kind: 'stood_down_below_floor', auctionId: monitor.auctionId,
            standingL1Price: state.standingL1Price, floor: monitor.floor });
        }
        return null; // can't win without breaching floor
      }
      if (undercut === monitor.lastBidPrice) return null;
      this.log.debug('rung selected: undercut standing L1', { auctionId: monitor.auctionId,
        standingL1Price: state.standingL1Price, undercut, floor: monitor.floor, remainingMs: remaining });
      return { price: undercut, rungIndex: null };
    }

    // T9: with this platform's walk switched on, the walk owns every decision below this line.
    if (monitor._raiseBelow != null && !(monitor.ladder[last] < monitor._raiseBelow)) {
      this._standDownOnRaise(monitor, { price: monitor.ladder[last], rungIndex: last }, null, state);
      return null;
    }

    if (this._walkOn(monitor)) return this._decideWalk(monitor, state, remaining, last);

    // A provisional-close load bids only at a round's buzzer (and once in its final round's middle
    // band): no establish mark, no step-down walk, no floor-window release.
    if (monitor.provisionalClose) return this._decideProvisional(monitor, state, remaining, last);

    // RANK-ONLY platforms: descending ladder.
    // 1) establish presence so we HAVE a rank. Soft-close: do it EARLY (the close
    //    keeps extending, so waiting for a buzzer means we never get on the board).
    if (monitor.currentRungIndex < 0) {
      // WHAT WE ALREADY HAVE STANDING bounds every rung this branch may pick. currentRungIndex < 0
      // means "this monitor has not bid", which after a re-price is NOT the same as "this load has
      // not been bid": reArmWithNewBand is stop + arm, arm resets the index and firedRungs, and a
      // genuine cost change makes remapFiredRungs carry nothing forward because it matches by price.
      // So the branch used to establish at ladder[0] over a live bid of our own - 260908LD2Z,
      // 2026-09-08: 41,420 offered against our own standing 31,610, refused, 114 minutes before
      // close, and that refusal is what started the walk down to a below-cost price.
      const reachAt = this._reachableAt(monitor, this._minDecrementFor(monitor, state.minDecrement));
      // Not one rung is reachable, floor included: the new ladder prices this load above what the
      // portal will still take from us, so there is nothing left to bid and chasing it only burns
      // refusals. Refuse rather than attempt, and say so. The standing bid stays where it is - a
      // reverse auction has no retract - so this is the safe direction: it adds no new commitment.
      //
      // Judged on the CERTAIN rule, not on the decrement - see _reachableAt. Standing a load down
      // is the strongest thing this branch can do, so it acts only where no price can possibly be
      // accepted; a floor that merely sits inside the decrement still gets its reserved shot.
      const mustImproveOn = this._mustImproveOn(monitor);
      if (mustImproveOn != null && monitor.ladder[last] > mustImproveOn) {
        this._holdAboveStandingBid(monitor, monitor.ladder[last], mustImproveOn);
        return null;
      }
      // A fresh monitor arming inside the genuinely-final snipe window - a late first-cost, or a
      // re-price rebuilt here (reArmWithNewBand does stop + arm, which resets currentRungIndex to
      // -1) - must NOT establish at the opening rung and hope to walk down: there is no time, and on
      // a re-price that would leave us bidding our HIGHEST price at the buzzer (the exact footgun the
      // late-re-price work exists to kill). Go straight to the FLOOR, the price that wins. Gated on
      // _decisiveShotDue so a soft (anti-snipe) load still holding extensions never dumps the floor
      // early (L3) - it establishes instead - AND, once the endgame is open, the shot lands where it
      // can actually be final rather than inside the branch's own anti-snipe trigger window. The
      // latency guard is bypassed for the floor rung in _maybeBid, so this fires best-effort exactly
      // like the deployed final snipe. Hard-close and non-allowlisted loads are unaffected:
      // _decisiveShotDue is _isLastChance for them, and _effectivelyHard was already true.
      // SuperProcure holds at rank 1: a last-revision floor must not undercut the account's own lead.
      if (state.myRank === 1 && this._hardCloseLastRevision(monitor)) {
        // Only a hold taken where the floor was otherwise due explains a zero-bid close.
        monitor.heldLeadAtLastDecision = this._decisiveShotDue(monitor, remaining);
        this.log.debug('holding: the account already leads at rank 1 on its last hard-close revision', {
          auctionId: monitor.auctionId, remainingMs: remaining, revisionsLeft: monitor.revisionsLeft });
        return null;
      }
      if (this._decisiveShotDue(monitor, remaining) && !monitor.firedRungs.has(last)) {
        this.log.debug('rung selected: floor rung on a fresh monitor in the final window (late arm/re-price)', {
          auctionId: monitor.auctionId, remainingMs: remaining, price: monitor.ladder[last], rungIndex: last });
        return { price: monitor.ladder[last], rungIndex: last };
      }
      // WHICH rung establishes. It used to be a hardcoded 0, which was safe only while
      // `currentRungIndex < 0` could ONLY mean "this load has never been bid" - the two meanings were
      // the same fact, so rung 0 was always the untried rung. The D3 restore below splits them:
      // currentRungIndex now answers "where do we stand" and is rolled back on a refusal that placed
      // nothing, while `firedRungs` answers "which rungs have we already tried". A hardcoded 0 reads
      // the first question to answer the second, and re-offers a price SuperProcure has already
      // refused - once per poll, until maxBidsPerMin runs out. Measured on the most common real
      // refusal in the corpus (SP's cap below ladder[0]): 20 attempts, nothing landed, against
      // origin/main's 5 attempts and two landed bids. It lost auctions main was winning.
      //
      // So the establish walks past what is already spent, EXACTLY as selectRung walks
      // (`while (target < last && rungFired(firedRungs, target)) target++`) - one rule for stepping
      // over a spent rung, not two that can disagree. This keeps BOTH properties the D3 repair needs:
      // the establish stays RANK-FREE (it is the only bid allowed to fire without a rank, and placing
      // it is how a rank is acquired - the escape from the blind-rank deadlock), and the ladder still
      // walks DOWN instead of re-offering a refused price.
      //
      // It stops ABOVE the floor. The floor is the reserved decisive shot and is not the establish
      // branch's to spend on an ordinary tick; when everything above it is spent the branch defers to
      // _lastResortFloor, which owns the floor and releases it only at the buzzer, bounded.
      //
      // It also walks past any rung the portal cannot take because our own standing bid is already
      // lower than it - the re-price case above, where the ladder moved up but not so far that the
      // floor is out of reach. Same one rule for stepping over a rung that cannot land, so the
      // establish re-enters the NEW ladder BELOW the standing bid instead of at the top of it.
      let est = 0;
      // WHICH of the two reasons ran the walk off the end, carried out of it rather than re-derived.
      // They are different states with different consequences and the exit used to describe them
      // with one sentence at debug level. "Every rung is spent" is routine - the ladder has been
      // walked and the reserved shot is what remains. "Every rung is above our standing bid" means
      // the correction reduced this load to a single biddable price, its floor, which will not go out
      // until the buzzer and will not go out at all while we hold L1; nothing else about the load
      // changes, so without this the state exists on no channel a human reads.
      let blockedByStandingBid = false;
      while (est < last && (monitor.firedRungs.has(est) || (reachAt != null && monitor.ladder[est] > reachAt))) {
        if (!monitor.firedRungs.has(est)) blockedByStandingBid = true;
        est++;
      }
      if (est >= last) {
        if (blockedByStandingBid) this._noteFloorOnlyBiddable(monitor, reachAt);
        else {
          this.log.debug('establish: every rung above the floor is already spent - deferring to the reserved shot', {
            auctionId: monitor.auctionId, remainingMs: remaining, firedRungs: [...monitor.firedRungs] });
        }
        return this._lastResortFloor(monitor, state, remaining, last);
      }
      // Establish mark. HARD close: at the (jittered) openAtMs mark, unchanged. SOFT close: two paths,
      // split by the ALLOWLIST (rankDriven = softStrategy !== 'off' = the shipper is soft-enabled). This
      // split is the reversibility spine applied to establish TIMING: establish-late (LM#5) is a NEW
      // behavior, so it must be allowlist-gated exactly like the fine ladder and the rank-aware endgame,
      // or it would shift the first-bid timing of EVERY soft-branch load on merge (an existing non-opted
      // customer whose branch runtime-reports soft close). A non-allowlisted soft load establishes at the
      // softOpenAtMs mark (it used to establish at ANY remaining, which is the defect this branch now
      // carries the fix for). An allowlisted soft load establishes LATE, ~
      // establishLeadMs BEFORE the anti-snipe trigger window, so the establishing bid does not itself land
      // inside the window and self-trigger an extension; gated on a FINITE remaining (SP's year-2100
      // placeholder parses as a valid number but is not a real countdown, so it must not trip an early
      // establish - the _establishThreshold backstop still catches it once the countdown is real), with an
      // unknown trigger window falling back to the openAtMs mark (no fabricated window, D6).
      const estThreshold = this._establishThreshold(monitor);
      if (monitor.closeModel === 'soft') {
        if (!rankDriven) {
          // HOLD UNTIL THE CLOSING WINDOW. This branch had no remaining-time test at all, which is
          // why every GoComet load bid on rate entry - see softOpenAtMs for the measurement and for
          // where the mark comes from. Nothing else in this path moved: once the establish lands,
          // the clock-scheduled step-down and the always-floor snipe run exactly as deployed, and
          // because they cannot run before the establish, gating it here holds the WHOLE walk to
          // the closing window rather than only the first bid.
          //
          // A non-finite remaining never reaches this branch: _maybeBid holds an unknown countdown
          // and tells the desk, by owner ruling, rather than establishing on it.
          //
          // A LOAD THAT ALREADY HAS A BID ON THE BOARD is exempt, and that is what makes a desk
          // re-price honest. The re-arm above resets currentRungIndex but carries landedBids across,
          // so a corrected cost arrives here on a load whose OLD price is standing and acceptable -
          // and on GoComet the 299s extension puts it back outside this mark, holding the correction
          // for the difference while the desk has been told the new price is on the wire. The hold
          // exists to stop an UNBID load exposing its opening price early; once a bid has landed
          // that price is exposed already, so the hold protects nothing and costs the correction.
          // Only the ESTABLISH is exempted - the rest of the walk still belongs to the closing
          // window, which the step-down hold in the outranked branch enforces.
          const softOpenAt = this._softEstablishThreshold(monitor);
          if (monitor.landedBids === 0 && Number.isFinite(remaining) && remaining > softOpenAt) {
            this.log.debug('holding the establish: soft close, still outside the closing window', {
              auctionId: monitor.auctionId, remainingMs: remaining, softOpenAt, rungIndex: est,
              price: monitor.ladder[est] });
            // Routed like every other hold in this file: a hold must never be the last word, so the
            // never-forfeit release still owns the final tick.
            return this._lastResortFloor(monitor, state, remaining, last);
          }
          // Banking the rung here is what lets the clock walk start, so a release that happened
          // OUTSIDE the window has to say so: the exemption buys the corrected price a place on the
          // wire, not an early ladder. Read by the step-down hold below; it stops binding on its own
          // once the countdown reaches the mark, so nothing clears it.
          // ASSIGNED, not latched true. _decide reaches this line only when it is about to return an
          // establish, and a refused establish is rolled back to currentRungIndex -1 and re-decided -
          // so assigning keeps the flag equal to the truth of the establish that actually lands,
          // instead of carrying a stale true from an earlier attempt into a load that ended up
          // establishing inside its window. Once the establish lands the branch is unreachable, so
          // the value then freezes, which is what the step-down hold wants to read.
          monitor.establishedBeforeWindow = Number.isFinite(remaining) && remaining > softOpenAt;
          this.log.debug('rung selected: establishing presence (soft)', {
            auctionId: monitor.auctionId, remainingMs: remaining, softOpenAt, rungIndex: est,
            establishedBeforeWindow: !!monitor.establishedBeforeWindow, price: monitor.ladder[est] });
          return { price: monitor.ladder[est], rungIndex: est };
        }
        if (Number.isFinite(remaining)) {
          const softEstablishAt = (monitor.triggerWindowMs != null && Number.isFinite(monitor.triggerWindowMs))
            ? Math.max(estThreshold, monitor.triggerWindowMs + this.softCfg.establishLeadMs)
            : estThreshold;
          if (remaining <= softEstablishAt) {
            this.log.debug('rung selected: establishing presence (soft, ahead of the trigger window)', {
              auctionId: monitor.auctionId, remainingMs: remaining, softEstablishAt, rungIndex: est,
              triggerWindowMs: monitor.triggerWindowMs, price: monitor.ladder[est] });
            return { price: monitor.ladder[est], rungIndex: est };
          }
        }
        // Allowlisted soft: hold until the establish window (or the backstop) - never on a year-2100
        // remaining. Routed through _lastResortFloor for the same reason every hold below it is: a
        // hold must never be the last word. It is a no-op on any tick that is not the last one, and
        // _isLastChance(NaN) is false, so a placeholder countdown still cannot trip it.
        return this._lastResortFloor(monitor, state, remaining, last);
      }
      // No establish on the last revision: the floor path above spends it in the final window.
      if (this._hardCloseLastRevision(monitor)) return this._lastResortFloor(monitor, state, remaining, last);
      if (remaining <= estThreshold) {
        this.log.debug('rung selected: establishing presence', { auctionId: monitor.auctionId,
          closeModel: monitor.closeModel, remainingMs: remaining, rungIndex: est, price: monitor.ladder[est] });
        return { price: monitor.ladder[est], rungIndex: est };
      }
      // hard close: keep margin hidden until the (jittered) establish mark - but a hold is still
      // never the last word. Unreachable on the final tick today (estThreshold is 25-29s, so the
      // branch above has already fired by then); routed anyway so the invariant holds structurally.
      return this._lastResortFloor(monitor, state, remaining, last);
    }
    // 2) winning -> hold (protect margin; never give away an L1 we already hold)
    if (state.myRank === 1) return null;

    // SOFT-CLOSE NON-FINAL WINDOW (L3 G1 fix - the heart of the build). The deployed floor-snipe below
    // fires regardless of close model; on a soft (anti-snipe) load that snipe-dumps INSIDE the trigger
    // window -> triggers an extension -> reveals our floor early AND hands a rival a fresh window to beat
    // it. So while a capped soft auction still has extensions left (NOT effectivelyHard), SUPPRESS the
    // floor snipe. Defend gently instead: step down ONE due rung when outranked, and only while a
    // revision stays in reserve for the eventual final-window snipe (D5). The floor rung is never spent
    // here - it is the reserved decisive shot, fired exactly once in the genuinely-final window. Both the
    // "free" defend (outside the trigger window) and the "knowingly-spent extend" defend (inside it) are
    // the same reserve-gated step-down; the anti-bid-war bound is structural (cost floor + hold-while-L1
    // + extension cap + reserve), never a read of any competitor (D6, legal-independence wall).
    // The ENTRY gate stays _effectivelyHard, deliberately unchanged. An earlier revision of this fix
    // widened it to _softEndgameUnlocked so the engine would stay on the reserve-gated path through the
    // cap boundary; that regressed the cap-0 case (a load publishing extendCount 0 cannot extend at
    // all, so it is a hard window wearing a soft close model and must keep running the deployed
    // step-down - test-softclose-extend-sequences T1a caught it). WHEN the decisive rung is released is
    // fixed at the snipe branch below via _decisiveShotDue; WHICH branch owns the mid-auction decision
    // is left exactly as deployed. The last tick of each round is taken first by
    // _softPreCapBuzzerShot, so a hold here is never the last word.
    if (monitor.softStrategy !== 'off' && monitor.closeModel === 'soft'
        && !this._effectivelyHard(monitor)) {
      // The last SP_PROBE_LEAD_MS belong to the round's pre-cap shot and, at the buzzer, the floor
      // release: a defend here would spend a rung on a rank read that cannot yet show our shot.
      if (remaining <= SP_PROBE_LEAD_MS) return this._softPreCapBuzzerShot(monitor, state, remaining, last);
      // BLIND-RANK GUARD (live-measured on a real Havells soft load): SuperProcure's socket only
      // self-matches the routed carrier once we have bid AS that carrier, so our OWN rank takes
      // about 1.15 SECONDS to appear after the establishing bid. Through that window state.myRank
      // is null.
      //
      // null is not 1, so the hold-while-winning test above does NOT catch it - a null rank falls
      // straight through into this discretionary defend. At the fixed 200ms hot cadence the very
      // next tick lands well inside the blind window, minInterFireMs (150ms) does not block it, and
      // the min-decrement check passes on a normal band. So the engine could spend the opening rung
      // and the next rung within ~400ms of each other, BLIND, quite possibly while it is already
      // winning.
      //
      // On a soft load that is the whole ladder. This branch caps its selection at last-1 (the
      // floor stays reserved for the genuinely-final window, which is only reached once extensions
      // exhaust), so the rungs above the floor are the ONLY usable ones - and burning them blind
      // exhausts the entire reachable ladder before the engine has ever seen a rank.
      //
      // So a DISCRETIONARY step-down requires a KNOWN rank. A rung is scarce and shared with the
      // human desk; spending one on a guess is strictly worse than waiting one poll for a frame.
      // The scope is deliberately narrow - it gates only the two discretionary branches, never the
      // two mandatory ones:
      //   - the ESTABLISH bid is decided ABOVE, before any rank test, and is unaffected. It must
      //     fire with no rank, because placing it is precisely how we come to have one.
      //   - the FINAL FLOOR SNIPE is decided BELOW and never consults rank.
      //
      // *** CORRECTED 2026-07-31. This block used to end "Holding can cost margin; it can never cost
      // the auction." That was FALSE, and it cost three Havells Alwar loads (Rs 1,25,000). The final
      // floor snipe is decided BELOW this branch, so a hold here does not fall through to it - it
      // RETURNS, and the snipe is never reached on that tick. When rank never arrives at all (a
      // rejected establish banks currentRungIndex, so the establish branch is closed and nothing ever
      // LANDS for SuperProcure to self-match), this guard holds on every remaining tick and the load
      // is forfeited with the floor rung unspent. Holding CAN cost the auction.
      //
      // The last tick is therefore taken above this guard by _softPreCapBuzzerShot, which never lets a
      // hold be the last word. The reasoning above still stands for the DISCRETIONARY middle rungs
      // before that tick - those stay withheld without a known rank. ***
      if (state.myRank == null) {
        this.log.debug('holding: rank not yet known (blind window) - no discretionary soft defend', {
          auctionId: monitor.auctionId, remainingMs: remaining, currentRungIndex: monitor.currentRungIndex });
        // ...and once per load, a trace that survives the default LOG_LEVEL. See _alertBlindRankHold
        // for why it is latched (this branch is re-entered every 200ms through the blind window).
        this._alertBlindRankHold(monitor, remaining, 'soft-close defend');
        return this._lastResortFloor(monitor, state, remaining, last);
      }
      // outranked here (rank 1 already returned). A discretionary defend is allowed ONLY with slack
      // above the reserve; else hold and keep the reserved revision for the final snipe (D5, F7).
      const reserve = this._softReserve(state);
      const hasSlack = monitor.revisionsLeft != null && (monitor.revisionsLeft - reserve) > 0;
      if (!hasSlack) return this._lastResortFloor(monitor, state, remaining, last);
      // ONCE-PER-EXTENSION-ROUND latch: defend at most ONE rung per extension round, then HOLD until the
      // next extension advances extendsObserved. Without it, at the 200ms hot cadence a persistent
      // outranked rank would walk the whole reachable ladder in a single round - the rank-driven step is
      // a reaction to a NEW round of competition, not a per-tick behaviour. _lastDefendAtExtend is set at
      // the fire point in _maybeBid (accepted + shadow), so this reflects the last defend that landed.
      if (monitor._lastDefendAtExtend === monitor.extendsObserved) {
        return this._lastResortFloor(monitor, state, remaining, last);
      }
      // INSIDE-TRIGGER-WINDOW gate: while the window is KNOWN and we are still OUTSIDE it (remaining >
      // window), hold - a defend out here is neither forced nor useful yet. Unknown window -> do NOT gate
      // (no fabricated window per D6; no more aggressive than today, which never read the window).
      if (monitor.triggerWindowMs != null && Number.isFinite(monitor.triggerWindowMs)
          && remaining > monitor.triggerWindowMs) {
        return this._lastResortFloor(monitor, state, remaining, last);
      }
      // Rank-driven step: (k-1) x jumpPerRival rungs down, clamped ABOVE the reserved floor (phase
      // 'defend'). selectRung is pure - the engine owns the gates above and the fire-point side effects.
      const next = selectRung({ i: monitor.currentRungIndex, k: state.myRank, last,
        firedRungs: this._selectableExclusions(monitor), phase: 'defend', jumpPerRival: this.softCfg.jumpPerRival });
      // selectRung declined - every rung above the reserved floor is spent or no deeper than where we
      // already stand. On any tick but the last that is a hold; on the last it would be a forfeit.
      if (next == null) return this._lastResortFloor(monitor, state, remaining, last);
      this.log.debug('rung selected: soft-close defend (non-final window; floor held in reserve)', {
        auctionId: monitor.auctionId, rungIndex: next, price: monitor.ladder[next], remainingMs: remaining,
        myRank: state.myRank, jumpPerRival: this.softCfg.jumpPerRival, extendsObserved: monitor.extendsObserved,
        extendCap: monitor.extendCap, revisionsLeft: monitor.revisionsLeft, reserve,
        ...this._triggerWindowTelemetry(monitor, remaining) });
      // defend:true marks this as the once-per-round soft defend so _maybeBid advances _lastDefendAtExtend.
      return { price: monitor.ladder[next], rungIndex: next, defend: true };
    }

    // 3) FINAL SNIPE: inside the closing window, commit our best price (the floor
    //    rung) to steal L1. Holding a higher rung here is what loses come-from-
    //    behind auctions - the floor exists to be spent exactly now, once. For a soft load this is
    //    reached only once the soft endgame is unlocked: the same Module-1 sniper, reused verbatim
    //    into the now genuinely-final window (D1). Fires against the LIVE countdown, so if SP
    //    unexpectedly extends past our believed cap (F5) the countdown jumps back up and this defers.
    //
    //    The gate is _decisiveShotDue, not a bare _isLastChance. For a hard-close or non-allowlisted
    //    load the two are the SAME predicate, so that path is byte-identical to prod. For an
    //    allowlisted soft load the shot is released in the band immediately ABOVE the branch's
    //    anti-snipe trigger window - the last moment a decisive shot can land and still be the last
    //    word, instead of 2.5s out where placing it is what starts the next round.
    if (this._decisiveShotDue(monitor, remaining)) {
      // Hard and non-allowlisted loads keep a single decisive shot; an allowlisted soft load may still
      // follow a non-floor shot with the floor.
      if (monitor.snipeFired) return this._softFloorAfterFinalShot(monitor, state, remaining, last);
      // NON-allowlisted (DEPLOYED): the ALWAYS-FLOOR snipe, byte-for-byte. Single-shot comes from
      // firedRungs.has(last), exactly as the deployed engine; no snipe:true marker (the floor is already
      // exempt from _maybeBid's min-decrement guard via isFloorRung). Gated on the ALLOWLIST, not ladder
      // length, so a non-opted customer with a >3-tier desk band snipes the floor exactly as today.
      if (!rankDriven) {
        if (!monitor.firedRungs.has(last)) {
          this.log.debug('rung selected: floor rung inside the final snipe window (deployed always-floor snipe)', {
            auctionId: monitor.auctionId, remainingMs: remaining, price: monitor.ladder[last], rungIndex: last, myRank: state.myRank });
          return { price: monitor.ladder[last], rungIndex: last };
        }
        // The floor index is BANKED - but banked means offered, not landed. On the deployed path this
        // read `return null`, which is correct when the floor actually went on the board and a silent
        // forfeit when SuperProcure refused it: _decide then returned null for the whole remaining
        // countdown with budget in hand and nothing to show. _lastResortFloor is the fact-based
        // re-test (landedBids / snipeFired, bounded) and returns null in the ordinary spent case.
        return this._lastResortFloor(monitor, state, remaining, last);
      }
      // RANK-AWARE snipe (allowlisted shipper): fire the HIGHEST rung that still wins, not always the floor.
      // selectRung('snipe') still collapses to the floor on an unknown rank and on a coarse (< 3-rung) cap,
      // so an allowlisted shipper on a low-cap load also lands the deployed floor snipe.
      const sel = selectRung({ i: monitor.currentRungIndex, k: state.myRank, last,
        firedRungs: monitor.firedRungs, phase: 'snipe', jumpPerRival: this.softCfg.jumpPerRival });
      // Only reachable when winning (k===1), already held above - defensive. _lastResortFloor holds
      // on rank 1 too, so this stays a hold; it is routed for the same structural reason as the rest.
      if (sel == null) return this._lastResortFloor(monitor, state, remaining, last);
      let rungIndex = sel;
      // DECISIVE-SHOT DECREMENT SAFETY (LM#1, the most dangerous coupling): a non-floor snipe rung within
      // minDecrement of our own last bid would be SILENTLY dropped by _maybeBid's min-decrement guard - the
      // decisive shot would never reach the wire. Fall to the FLOOR instead (the floor always attempts), so
      // the shot is never silently dropped. Do NOT broadly exempt every last-chance rung: a doomed non-floor
      // rung above the decrement is a guaranteed SP rejection; only the too-close case falls to the floor.
      const minDec = state.minDecrement != null ? state.minDecrement : this.caps.minDecrement;
      if (rungIndex !== last && monitor.lastBidPrice != null && minDec
          && monitor.lastBidPrice - monitor.ladder[rungIndex] < minDec) {
        this.log.debug('snipe: rank rung within min-decrement of our last bid - substituting the floor (decisive shot)', {
          auctionId: monitor.auctionId, rankRung: rungIndex, rankPrice: monitor.ladder[rungIndex],
          lastBidPrice: monitor.lastBidPrice, minDecrement: minDec, floorRung: last, floorPrice: monitor.ladder[last] });
        rungIndex = last;
      }
      if (rungIndex !== last && this._softLastRevision(monitor)) rungIndex = last;
      // Already spent (e.g. the late-arm-floor path in the establish branch pre-fired the floor). The
      // OLD `!firedRungs.has(last)` guard lived here; keep that protection so the floor never
      // double-fires. Same correction as the deployed branch above: banked is OFFERED, not landed, so
      // the dead end re-tests the participation facts rather than forfeiting on a refusal.
      if (monitor.firedRungs.has(rungIndex)) return this._lastResortFloor(monitor, state, remaining, last);
      this.log.debug('rung selected: rank-aware final snipe', { auctionId: monitor.auctionId,
        remainingMs: remaining, rungIndex, price: monitor.ladder[rungIndex], myRank: state.myRank,
        jumpPerRival: this.softCfg.jumpPerRival });
      // snipe:true makes the shot floor-equivalent for _maybeBid's min-decrement guard and single-shots it.
      return { price: monitor.ladder[rungIndex], rungIndex, snipe: true };
    }
    // 4) outranked, still early -> step down one due rung, but keep the floor in reserve.
    // BLIND-RANK GUARD, hard-close half - same reasoning as the soft branch above (see the long note
    // there): a null rank is not caught by the `myRank === 1` hold, and stepping down inside the ~1.15s
    // blind window spends a scarce shared-account rung on a guess, possibly while already winning.
    // Reached only OUTSIDE the final window (the snipe branch above already returned), so withholding
    // here can never suppress the floor shot - a load whose rank never comes online still snipes.
    if (state.myRank == null) {
      this.log.debug('holding: rank not yet known (blind window) - no discretionary step-down', {
        auctionId: monitor.auctionId, remainingMs: remaining, currentRungIndex: monitor.currentRungIndex });
      // Same latch as the soft branch above - one alert per load, not one per 200ms tick.
      this._alertBlindRankHold(monitor, remaining, 'step-down');
      return null;
    }
    // Step down when outranked, keeping the floor in reserve for the final window - split by the allowlist.
    // No once-per-round latch on either path: there are no extension rounds left to pace against. Two
    // gates keep the last revision for the final-window floor. A hard close (closeModel not 'soft') with a
    // known budget holds on its last revision, just below. An allowlisted soft load in its final round
    // holds on its last revision or after a landed final shot (_softStepDownHeld, in the rank-driven
    // path). GoComet loads (soft, softStrategy off) have neither gate and step down as deployed.
    // ALLOWLISTED (rankDriven): the rank-driven step, (k-1) x jumpPerRival rungs down. NON-allowlisted
    // (DEPLOYED): the clock-scheduled due rung (deeper as time runs out), at least one step, never the
    // floor - unless a known hard-close budget is short, when _shortBudgetMiddleRung picks the price.
    if (this._hardCloseLastRevision(monitor)) {
      this.log.debug('holding the step-down: last revision kept for the final-window floor', {
        auctionId: monitor.auctionId, remainingMs: remaining, revisionsLeft: monitor.revisionsLeft,
        currentRungIndex: monitor.currentRungIndex, rankDriven });
      return null;
    }
    let next;
    if (rankDriven) {
      if (this._softStepDownHeld(monitor)) return null;
      // A round whose pre-cap shot found it final (probe_no_move): that shot was its middle price, and
      // the rest of it belongs to the decisive shot above.
      if (monitor._shotRoundId != null && monitor._shotRoundId === this.roundVerdict(monitor).roundId) return null;
      next = selectRung({ i: monitor.currentRungIndex, k: state.myRank, last,
        firedRungs: this._selectableExclusions(monitor), phase: 'defend', jumpPerRival: this.softCfg.jumpPerRival });
      if (next == null) return null;
    } else {
      // A re-price released this load's establish OUTSIDE the closing window so the corrected price
      // could reach the wire immediately. Only that bid was exempted. The establish gate is what
      // holds the WHOLE walk for this class - nothing downstream can run before it - so without this
      // the clock walk simply starts at the exempted tick: measured on a re-priced load at 299,000ms
      // remaining, the corrected price survived one 30s poll before a 6.7% step-down committed at
      // 268,875ms, against 127,175ms on the same ladder by design. Binds only on the exempted
      // population and stops binding once the countdown reaches the mark, so an ordinary soft load -
      // which cannot reach here before its mark anyway - is untouched, and hard close never sets the
      // flag at all.
      if (monitor.establishedBeforeWindow && remaining > this._softEstablishThreshold(monitor)) {
        this.log.debug('holding the step-down: established early on a re-price, still outside the closing window', {
          auctionId: monitor.auctionId, remainingMs: remaining, currentRungIndex: monitor.currentRungIndex,
          softOpenAt: this._softEstablishThreshold(monitor) });
        return null;
      }
      next = this._shortBudgetMiddleRung(monitor, last)
        ?? Math.max(monitor.currentRungIndex + 1, this._scheduledRungIndex(monitor, remaining));
      if (next >= last) next = last - 1; // do not burn the floor before the final window
      if (next <= monitor.currentRungIndex) return null;
      // Spent OR already refused for spacing: re-offering either one places nothing, so hold rather
      // than walk the decision all the way to the guard again on every tick.
      if (this._selectableExclusions(monitor).has(next)) return null;
    }
    this.log.debug('rung selected: stepping down, outranked', { auctionId: monitor.auctionId,
      rungIndex: next, price: monitor.ladder[next], remainingMs: remaining, myRank: state.myRank,
      rankDriven, jumpPerRival: this.softCfg.jumpPerRival });
    return { price: monitor.ladder[next], rungIndex: next };
  }

  /**
   * One decision for a provisional-close load. R is the rounds so far, C the load's cap (null =
   * uncapped), A the attempts left; GoComet does not give an attempt back on an extension.
   *   pre-final (R < C): in the middle band or at the buzzer, outranked or unranked, the next
   *     non-floor price while one attempt stays for the final round's floor. One shot per round; its
   *     submit response can make the round final (C := R), and then the floor goes at the buzzer.
   *   final (R >= C, every round past the cap too): in the middle band, outranked or unranked with
   *     A >= 2, one shot at the next non-floor price; at the buzzer the floor whatever the rank.
   *   uncapped: at each buzzer, outranked or unranked, the next price, or the floor with the last
   *     attempt. One shot per round, and rank 1 holds.
   * _maybeBid does not hold a shot decided here for the write runway (ruling 51 (c)): a round decides
   * only at its buzzer or above it, and no later read in the round shows more time.
   */
  _decideProvisional(monitor, state, remaining, last) {
    const mustImproveOn = this._mustImproveOn(monitor);
    if (mustImproveOn != null && monitor.ladder[last] > mustImproveOn) {
      // Our own floor standing is the ladder's end, not a hold: on 260927Q4QF reading it as one sent
      // the desk a false "New rate saved". Only a band wholly above our standing bid is refused aloud.
      if (monitor.ladder[last] > monitor.lastBidPrice) {
        this._holdAboveStandingBid(monitor, monitor.ladder[last], mustImproveOn);
      }
      return null;
    }
    if (!Number.isFinite(remaining)) return null;
    const atBuzzer = remaining <= this._buzzerMs();
    if (!atBuzzer && remaining > PROVISIONAL_MIDDLE_BAND_MS) return null;
    const round = monitor.extendsObserved;
    const cap = this._provisionalCap(monitor);
    const attempts = monitor.revisionsLeft;
    const floorStands = monitor.landedBids > 0 && monitor.firedRungs.has(last);
    const outranked = state.myRank !== 1;
    const v = this.roundVerdict(monitor);
    if (v.verdict === 'UNCERTAIN_AFTER_CLOSE' && !this._frozenCheckUnanswered(monitor)) return null;
    const shotTaken = monitor._shotRoundId === v.roundId;
    const floor = { price: monitor.ladder[last], rungIndex: last };
    const shot = (rungIndex) => (rungIndex == null ? null
      : { price: monitor.ladder[rungIndex], rungIndex, provisionalRoundId: v.roundId });
    const uncertain = v.verdict === 'UNCERTAIN_AFTER_CLOSE'
      || (v.verdict === 'UNCERTAIN' && v.reason !== 'uncapped_no_evidence');
    let decision = null;
    if (uncertain) {
      // Rulings 47 and 57: an UNCERTAIN round sends the floor at the buzzer if outranked, never a middle price.
      if (atBuzzer && outranked && !floorStands && attempts !== 0) decision = floor;
    } else if (cap === null) {
      if (atBuzzer && outranked && !shotTaken && !floorStands) {
        if (attempts === 1) decision = { ...floor, provisionalRoundId: v.roundId };
        else if (attempts >= 2) decision = shot(this._provisionalNextRung(monitor, state, last, true));
      }
    } else if (round >= cap || v.verdict === 'FINAL') {
      if (atBuzzer) {
        if (!floorStands && attempts !== 0) decision = floor;
      } else if (outranked && attempts >= 2 && !floorStands && !shotTaken) {
        decision = shot(this._provisionalNextRung(monitor, state, last, false));
      }
    } else if (outranked && attempts >= 2 && !shotTaken) {
      // Ruling 40: the pre-final shot goes in the middle band, so its submit response shows before the
      // buzzer whether this round is the last.
      decision = shot(this._provisionalNextRung(monitor, state, last, false));
      if (decision) decision.probe = true;
    }
    if (decision) {
      this.log.debug('rung selected: provisional-close round shot', { auctionId: monitor.auctionId,
        remainingMs: remaining, round, cap, verdict: v.verdict, reason: v.reason, attempts, myRank: state.myRank, rungIndex: decision.rungIndex,
        price: decision.price });
    }
    return decision;
  }

  /**
   * The next price: the first rung below where we stand that is unspent, fireable and below our own
   * standing bid. The floor only when `allowFloor` and nothing above it qualifies.
   */
  _provisionalNextRung(monitor, state, last, allowFloor) {
    const reachAt = this._reachableAt(monitor, this._minDecrementFor(monitor, state.minDecrement));
    const excluded = this._selectableExclusions(monitor);
    for (let i = Math.max(0, monitor.currentRungIndex + 1); i < last; i++) {
      if (excluded.has(i)) continue;
      if (reachAt != null && monitor.ladder[i] > reachAt) continue;
      if (monitor._raiseBelow != null && monitor.ladder[i] >= monitor._raiseBelow) continue;
      return i;
    }
    return allowFloor ? last : null;
  }

  _walkPlatform(monitor) {
    return monitor && monitor.provisionalClose ? 'gocomet' : 'sp';
  }

  _walkOn(monitor) {
    const c = this.walkCfg && this.walkCfg[this._walkPlatform(monitor)];
    return !!(c && c.enabled);
  }

  /**
   * The walk's timing for this load: step and landing times (measured or manual), safety =
   * clockErrorMs + safetyMarginMs, the window cap, and one expected tick of slack.
   */
  walkParams(monitor, state = {}) {
    const platform = this._walkPlatform(monitor);
    const cfg = this.walkCfg[platform];
    const eff = walkMath.effectiveTiming(cfg, this.walkTiming && this.walkTiming[platform], this.walkCfg);
    const published = typeof state.clockErrorMs === 'number' && Number.isFinite(state.clockErrorMs) && state.clockErrorMs >= 0
      ? state.clockErrorMs : null;
    if (published != null && published > walkMath.MAX_CLOCK_ERROR_MS) this._warnWalkOnce(`clock:${platform}:${published}`,
      'walk: the portal published a clock error above the walk\'s maximum - using the maximum', { platform, published, usedMs: walkMath.MAX_CLOCK_ERROR_MS });
    const clockErrorMs = published != null ? Math.min(published, walkMath.MAX_CLOCK_ERROR_MS)
      : (platform === 'gocomet' ? cfg.clockErrorMs : SP_UNKNOWN_CLOCK_ERROR_MS);
    const safetyMs = clockErrorMs + cfg.safetyMarginMs;
    let landMs = eff.landMs + (this.caps.durableSubmissionTracking ? GC_SUBMISSION_PERSIST_MS : 0);
    // A landing time that leaves no step inside the window would leave an outranked load with nothing:
    // the last step always fits.
    if (landMs + safetyMs > cfg.maxWalkWindowMs) {
      landMs = Math.max(0, cfg.maxWalkWindowMs - safetyMs);
      this._warnWalkOnce(`land:${platform}:${eff.landMs}:${safetyMs}:${cfg.maxWalkWindowMs}`,
        'walk: the landing time leaves no step inside the window - capped so the last step fits', {
          platform, landMs: eff.landMs, source: eff.source, safetyMs, maxWalkWindowMs: cfg.maxWalkWindowMs, usedLandMs: landMs });
    }
    return { stepTimeMs: eff.stepTimeMs, landMs, source: eff.source, safetyMs,
      maxWalkWindowMs: cfg.maxWalkWindowMs, slackMs: platform === 'gocomet' ? PROVISIONAL_READ_INTERVAL_MS : this.cfg.pollHotMs };
  }

  /** A live load within `windowMs` of its close (either side), or a write in flight: the walk's timing matters now. */
  hasMonitorInFinalWindow(windowMs = 60_000, now = Date.now()) {
    for (const m of this.monitors.values()) {
      if (m.finalized) continue;
      if (m.bidInProgress) return true;
      const closeAt = Number(m.believedCloseAt != null ? m.believedCloseAt : (m.meta && m.meta.closesAt));
      if (Number.isFinite(closeAt) && Math.abs(closeAt - now) < windowMs) return true;
    }
    return false;
  }

  _warnWalkOnce(key, msg, fields) {
    if (!this._walkWarned) this._walkWarned = new Set();
    if (this._walkWarned.has(key)) return;
    this._walkWarned.add(key);
    this.log.warn(msg, fields);
  }

  // A SuperProcure load off the soft-close allowlist keeps no round mirrors on the monitor (ruling 56
  // (d)), so the walk reads the tracker's own count for it.
  _walkVerdict(monitor) {
    if (monitor.provisionalClose || monitor.softStrategy !== 'off' || monitor.closeModel !== 'soft') return this.roundVerdict(monitor);
    return roundTracker.verdict(monitor._round || null, Date.now(), { closeModel: monitor.closeModel });
  }

  /**
   * The band prices the walk may still offer, highest first, as ladder indices: unspent and fireable,
   * below our standing bid (the decrement applies above the lowest price), at or under a limit the
   * portal stated, and never above a price the walk already offered.
   */
  _walkPrices(monitor, state, last) {
    const reachAt = this._reachableAt(monitor, this._minDecrementFor(monitor, state.minDecrement));
    const mustImprove = this._mustImproveOn(monitor);
    const excluded = this._selectableExclusions(monitor);
    const out = [];
    for (let i = 0; i <= last; i++) {
      if (excluded.has(i)) continue;
      const p = monitor.ladder[i];
      if (monitor._walkLimit != null && p > monitor._walkLimit) continue;
      if (monitor._walkOfferedMin != null && p > monitor._walkOfferedMin) continue;
      if (monitor._raiseBelow != null && p >= monitor._raiseBelow) continue;
      if (i < last ? (reachAt != null && p > reachAt) : (mustImprove != null && p > mustImprove)) continue;
      out.push(i);
    }
    return out;
  }

  // SuperProcure names our own amount on the socket, so the walk trusts its rank only when it shows our
  // last landed bid, never on time alone: a stale rank 2 read after 1.2 s once sent a lower price while we
  // held rank 1 (owner ruling 26 Sep). GoComet names none, so it takes #256's settle time.
  _walkRankTrusted(monitor, state) {
    if (Object.prototype.hasOwnProperty.call(state, 'myAmount')) {
      return !(monitor.landedBids > 0) || this._showsOwnBid(state, monitor.lastBidPrice);
    }
    return this._ownBidSettled(monitor, state);
  }

  // One bid at the portal's stated limit (ruling 30's shape) when no band price is at or under it but
  // the limit is still at or above the minimum-margin guard. Once per stated limit.
  _walkLimitPrice(monitor) {
    const lim = monitor._walkLimit;
    if (lim == null || monitor._walkLimitSent === lim) return null;
    if (!(Number.isFinite(monitor.guard) && lim >= monitor.guard)) return null;
    const mustImprove = this._mustImproveOn(monitor);
    if (mustImprove != null && lim > mustImprove) return null;
    if (monitor._raiseBelow != null && lim >= monitor._raiseBelow) return null;
    return lim;
  }

  /**
   * T9 final-window walk (rulings 27, 28, 34-41, 48; owner decisions of 26 Sep). Before the final round
   * the only bid is one probe middle price per round when outranked; in the final round (or one the
   * tracker cannot call) the walk steps down the band from close - steps x stepTime - safety while
   * outranked and holds at rank 1.
   */
  _decideWalk(monitor, state, remaining, last) {
    const mustImproveOn = this._mustImproveOn(monitor);
    if (mustImproveOn != null && monitor.ladder[last] > mustImproveOn) {
      // Our lowest band price standing, or a bid at the portal's limit below it, is the walk's end
      // state; only a band that sits wholly above our standing bid (a re-price) is refused aloud.
      if (monitor.ladder[last] > monitor.lastBidPrice && monitor._walkLimitSent == null) {
        this._holdAboveStandingBid(monitor, monitor.ladder[last], mustImproveOn);
      }
      return null;
    }
    if (!Number.isFinite(remaining) || !(remaining > 0)) return null;
    const v = this._walkVerdict(monitor);
    this._noteWalkRound(monitor, v);
    // W12: a countdown frozen past the believed close sends nothing until the tracker calls the load live.
    if (v.verdict === 'UNCERTAIN_AFTER_CLOSE') return null;
    const gc = !!monitor.provisionalClose;
    const bidsLeft = gc ? monitor.revisionsLeft : this._hardCloseRevisionsLeft(monitor);
    if (bidsLeft != null && bidsLeft <= 0) return null;
    const t = this.walkParams(monitor, state);
    const ctx = { v, t, bidsLeft, gc };
    if (gc && v.verdict === 'UNCERTAIN' && v.reason === 'uncapped_no_evidence') return this._walkUncappedRound(monitor, state, remaining, last, ctx);
    if (v.verdict === 'NOT_FINAL') return this._walkPreFinal(monitor, state, remaining, last, ctx);
    return this._walkFinalRound(monitor, state, remaining, last, ctx);
  }

  // W5 / W7: one middle price per pre-final round, when outranked, at the probe lead. A round that
  // cannot take a probe is never forfeited: outranked at its last-step deadline, the lowest price goes.
  // On GoComet too: a round opens only when someone bids in its window, so a NOT_FINAL round that only
  // our own probes extended ends there, and a last attempt kept back dies with it (260928NXAW).
  _walkPreFinal(monitor, state, remaining, last, { v, t, bidsLeft, gc }) {
    if (!gc) this._checkLiveRankHold(monitor, state, remaining, t, v.roundId);
    const rank = this._walkRank(monitor, state, v, remaining, t);
    if (rank === 1) return null;
    const unbid = !(monitor.landedBids > 0);
    const outranked = rank != null ? rank > 1 : unbid;
    if (remaining > this.walkCfg[this._walkPlatform(monitor)].probeLeadMs) return null;
    const prices = this._walkPrices(monitor, state, last);
    const idx = this._walkProbeIndex(monitor, v, prices, last, outranked, bidsLeft);
    if (idx != null) {
      this.log.debug('walk: pre-final probe at the next middle price', { auctionId: monitor.auctionId, remainingMs: remaining,
        roundId: v.roundId, rungIndex: idx, price: monitor.ladder[idx], myRank: rank, bidsLeft });
      return { price: monitor.ladder[idx], rungIndex: idx, probe: true, buzzerShotRoundId: v.roundId, walk: 'probe',
        walkRoundId: v.roundId };
    }
    if (!prices.includes(last)) return null;
    if (remaining > walkMath.stepDeadlineMs(1, t)) return null;
    this.log.info('walk: pre-final round with no probe left, lowest price at its last-step deadline', {
      auctionId: monitor.auctionId, remainingMs: remaining, roundId: v.roundId, myRank: rank, bidsLeft });
    return { price: monitor.ladder[last], rungIndex: last, walk: 'last', walkRoundId: v.roundId, ...(gc ? { probe: true } : {}) };
  }

  // The middle price a pre-final round's probe takes, or null when no probe can go this round.
  _walkProbeIndex(monitor, v, prices, last, outranked, bidsLeft) {
    if (!outranked || monitor._shotRoundId === v.roundId || !(bidsLeft == null || bidsLeft >= 2)) return null;
    const idx = prices.find((i) => i < last);
    return idx == null ? null : idx;
  }

  // A not-final round whose deadline decision is the lowest price: no probe can go, the lowest is left.
  _walkPreFinalLastDue(monitor, state, v) {
    const last = monitor.ladder.length - 1;
    const prices = this._walkPrices(monitor, state, last);
    if (!prices.includes(last)) return false;
    const bidsLeft = monitor.provisionalClose ? monitor.revisionsLeft : this._hardCloseRevisionsLeft(monitor);
    const outranked = state.myRank != null ? state.myRank > 1 : !(monitor.landedBids > 0);
    return this._walkProbeIndex(monitor, v, prices, last, outranked, bidsLeft) == null;
  }

  // A GoComet plant with no round cap: every round may be the last. One shot per round when outranked,
  // at the single-step start: the next price, or the lowest with the last attempt.
  _walkUncappedRound(monitor, state, remaining, last, { v, t, bidsLeft }) {
    if (state.myRank === 1 || monitor._shotRoundId === v.roundId) return null;
    // Never held for GoComet's write runway (ruling 51 (c)): a late read still sends its shot.
    if (remaining > walkMath.walkStartMs(1, t)) return null;
    const prices = this._walkPrices(monitor, state, last);
    if (!prices.length) return null;
    const idx = bidsLeft === 1 ? (prices.includes(last) ? last : null) : (prices.find((i) => i < last) ?? prices[prices.length - 1]);
    if (idx == null) return null;
    return { price: monitor.ladder[idx], rungIndex: idx, probe: true, buzzerShotRoundId: v.roundId, walk: 'step', walkRoundId: v.roundId };
  }

  _walkFinalRound(monitor, state, remaining, last, { v, t, bidsLeft, gc }) {
    if (!gc) this._checkLiveRankHold(monitor, state, remaining, t, v.roundId);
    const rank = this._walkRank(monitor, state, v, remaining, t);
    if (rank === 1) {
      // W9: a customer switched to it sends the lowest price at the walk's last-step deadline of a
      // CONFIRMED final round.
      if (gc && v.verdict === 'FINAL' && v.confidence === 'HIGH' && monitor.meta && monitor.meta.preEmptiveFloorAtRankOne === true
          && remaining <= walkMath.stepDeadlineMs(1, t, { noReadSlack: this._walkNoRead(monitor, v) })
          && !(monitor.landedBids > 0 && monitor.firedRungs.has(last))
          && this._walkPrices(monitor, state, last).includes(last)) {
        return { price: monitor.ladder[last], rungIndex: last, walk: 'preemptive', walkRoundId: v.roundId, probe: true };
      }
      return null;
    }
    // Our own probe is still being watched for a close move: its answer is worth waiting for, up to the
    // point where the last step would no longer land.
    if (v.reason === 'probe_pending' && remaining - t.safetyMs - t.landMs > t.slackMs) return null;
    const prices = this._walkPrices(monitor, state, last);
    const limit = prices.length ? null : this._walkLimitPrice(monitor);
    if (!prices.length && limit == null) return null;
    const count = prices.length || 1;
    const planned = Math.min(bidsLeft == null ? Infinity : bidsLeft, count, walkMath.maxWalkSteps(t));
    const started = monitor._walkRoundId === v.roundId;
    if (gc && !started) this._walkPrepareQuote(monitor, v, remaining, walkMath.walkStartMs(planned, t));
    if (!started && remaining > walkMath.walkStartMs(planned, t)) return null;
    let steps = Math.min(planned, walkMath.stepsThatFit(remaining, t));
    // Too late for a step to land by the walk's margin: the lowest still goes, best effort - an outranked
    // load with an attempt left is never left with nothing (ruling 51 (c) on GoComet). The miss is marked.
    if (steps < 1) {
      if (monitor._walkTooLateRoundId !== v.roundId) {
        monitor._walkTooLateRoundId = v.roundId;
        this.emit({ type: 'walk_timing_miss', auctionId: monitor.auctionId, remainingMs: remaining, safetyMs: t.safetyMs,
          landMs: t.landMs, myRank: rank, roundId: v.roundId, lane: monitor.meta.lane, companyName: monitor.meta.companyName });
      }
      steps = 1;
    }
    const go = !(monitor.landedBids > 0) || (rank != null && rank > 1 && this._walkRankTrusted(monitor, state))
      || remaining <= walkMath.stepDeadlineMs(steps, t, { noReadSlack: steps === 1 && this._walkNoRead(monitor, v) });
    if (!go) return null;
    if (limit != null) {
      this.log.info('walk: no band price is at or under the portal\'s limit - one bid at the limit', { auctionId: monitor.auctionId,
        limit, guard: monitor.guard, lowestBandPrice: monitor.ladder[last], remainingMs: remaining });
      return { price: limit, rungIndex: null, walk: 'limit', walkLimit: true, walkRoundId: v.roundId };
    }
    const idx = prices[walkMath.spreadFirstIndex(prices.length, steps)];
    this.log.debug('walk: step', { auctionId: monitor.auctionId, remainingMs: remaining, verdict: v.verdict, reason: v.reason,
      steps, prices: prices.length, rungIndex: idx, price: monitor.ladder[idx], myRank: rank, bidsLeft,
      stepTimeMs: t.stepTimeMs, safetyMs: t.safetyMs, landMs: t.landMs, timing: t.source });
    return { price: monitor.ladder[idx], rungIndex: idx, walk: 'step', walkRoundId: v.roundId, ...(gc ? { probe: true } : {}) };
  }

  // Latency-map row 4: in a confirmed GoComet final round the close cannot move, so the last step goes on
  // the clock without waiting for a fresh read.
  _walkNoRead(monitor, v) {
    return !!monitor.provisionalClose && v.verdict === 'FINAL' && v.confidence === 'HIGH'
      && this.walkCfg.gocomet.finalShotWithoutRead === true;
  }

  // Plan H: a prepared quote is trusted for 5 s, so it is prepared once, inside WALK_PREPARE_LEAD_MS of
  // the walk's start, and the first step does not wait on a quote read.
  _walkPrepareQuote(monitor, v, remaining, startMs) {
    if (monitor._walkPreparedRoundId === v.roundId || remaining > startMs + WALK_PREPARE_LEAD_MS) return;
    if (typeof this.adapter.prepareQuote !== 'function') return;
    monitor._walkPreparedRoundId = v.roundId;
    this._walkRequestQuote(monitor);
  }

  _walkRequestQuote(monitor) {
    Promise.resolve().then(() => this.adapter.prepareQuote(monitor.auctionId)).catch(() => {});
  }

  // Never zero on GoComet: its reads of one enquiry are spaced 5 s apart, so the only read inside the
  // last-step window can come back after it. A timer independent of the read decides at the last step's
  // deadline on the last known state. Rank 1 holds; once per round.
  _clearWalkTimers(monitor) {
    if (monitor._walkClockTimer) { clearTimeout(monitor._walkClockTimer); monitor._walkClockTimer = null; }
    if (monitor._walkPrepTimer) { clearTimeout(monitor._walkPrepTimer); monitor._walkPrepTimer = null; }
  }

  _armWalkClockFallback(monitor) {
    this._clearWalkTimers(monitor);
    monitor._walkClockAtMs = null;
    const lastOk = this._walkShotState(monitor);
    if (!monitor.provisionalClose || !lastOk || !this._walkOn(monitor) || monitor.finalized || this.killed) return;
    const v = this._walkVerdict(monitor);
    if (v.verdict === 'UNCERTAIN_AFTER_CLOSE' || monitor._walkClockShotRoundId === v.roundId || lastOk.myRank === 1) return;
    const at = walkMath.walkStartMs(1, this.walkParams(monitor, lastOk));
    const delay = this._provisionalRemainingMs(lastOk) - at;
    if (!(delay > 0)) return;
    monitor._walkClockAtMs = at;
    monitor._walkClockTimer = setTimeout(() => { this._walkClockFire(monitor).catch(() => {}); }, delay);
    if (monitor._walkClockTimer.unref) monitor._walkClockTimer.unref();
    if (delay > WALK_PREPARE_LEAD_MS) {
      monitor._walkPrepTimer = setTimeout(() => { monitor._walkPrepTimer = null; this._walkClockPrepare(monitor); }, delay - WALK_PREPARE_LEAD_MS);
      if (monitor._walkPrepTimer.unref) monitor._walkPrepTimer.unref();
    }
  }

  // The clock-decided step has no time for a cold write's two quote reads, so its quote is prepared
  // ahead of it even when the walk prepared one earlier in the round. Not on a round the tracker calls
  // not final: on replay (Z6HP) those reads cost the read-driven steps more than they gave. The
  // exception is a not-final round whose lowest price goes at this deadline.
  _walkClockPrepare(monitor) {
    const lastOk = monitor._lastOkState;
    if (monitor._walkClockAtMs == null || !lastOk || monitor.finalized || this.killed || this.discarded || !this._walkOn(monitor)) return;
    if (typeof this.adapter.prepareQuote !== 'function') return;
    const v = this._walkVerdict(monitor);
    if (v.verdict === 'NOT_FINAL' && !this._walkPreFinalLastDue(monitor, this._walkShotState(monitor) || lastOk, v)) return;
    this._walkRequestQuote(monitor);
  }

  async _walkClockFire(monitor) {
    monitor._walkClockTimer = null;
    const lastOk = this._walkShotState(monitor);
    if (!lastOk || monitor.finalized || this.killed || this.discarded || monitor.bidInProgress || !this._walkOn(monitor)) return;
    // A queued submit response is newer than any read; the tick scheduled for it decides.
    if (monitor._responseState && Date.now() - monitor._responseState.at < this.cfg.responseStateMaxAgeMs) return;
    const v = this._walkVerdict(monitor);
    if (v.verdict === 'UNCERTAIN_AFTER_CLOSE' || monitor._walkClockShotRoundId === v.roundId || lastOk.myRank === 1) return;
    const remaining = this._provisionalRemainingMs(lastOk);
    if (!(remaining > 0) || remaining > walkMath.walkStartMs(1, this.walkParams(monitor, lastOk)) + PROVISIONAL_READ_INTERVAL_MS) return;
    monitor._walkClockShotRoundId = v.roundId;
    this.log.info('walk: no fresh read by the last-step deadline - deciding on the last known state', {
      auctionId: monitor.auctionId, remainingMs: remaining, verdict: v.verdict, reason: v.reason, myRank: lastOk.myRank });
    await this._attemptBid(monitor, lastOk);
  }

  // The no-read final shot: the tick aimed at the last step's deadline decides on the newest state it has
  // (a queued submit response, else the last read), with the countdown re-timed to now. Once per round;
  // anything that fails a condition reads as usual.
  _walkClockShotDue(monitor, fresh = null) {
    const lastOk = fresh || this._walkShotState(monitor);
    if (!monitor.provisionalClose || !lastOk || !this._walkOn(monitor) || lastOk.myRank === 1) return false;
    const v = this._walkVerdict(monitor);
    if (!this._walkNoRead(monitor, v) || monitor._walkClockShotRoundId === v.roundId) return false;
    const remaining = this._provisionalRemainingMs(lastOk);
    const t = this.walkParams(monitor, lastOk);
    if (!(remaining > 0) || remaining > walkMath.stepDeadlineMs(1, t, { noReadSlack: true })) return false;
    monitor._walkClockShotRoundId = v.roundId;
    return true;
  }

  // The last read, as the no-read shot may use it. A read from before our last accepted write shows
  // neither the rank nor the close that write produced: the rank is the one that write's own response
  // returned until a newer read or response replaces it, else unknown, which D-C treats as outranked at
  // the deadline; a round the tracker has since opened replaces its close (260928J43Q).
  _walkShotState(monitor) {
    const lastOk = monitor._lastOkState;
    if (!lastOk || monitor._lastLandedAt == null || monitor._lastOkAt >= monitor._lastLandedAt) return lastOk;
    const t = monitor._round;
    const readClose = numericOrNull(lastOk.closesAtMs);
    const moved = t && Number.isFinite(t.closeAt) && readClose != null && t.closeAt - readClose >= realCloseMoveMs(lastOk);
    return { ...lastOk, myRank: monitor._lastLandedRank != null ? monitor._lastLandedRank : null, ...(moved ? { closesAtMs: t.closeAt } : {}) };
  }

  // Fire-point bookkeeping for a walk decision, before the write: the walk has started this round, and
  // no later step offers a price above this one.
  _noteWalkFire(monitor, decision) {
    if (decision.walk !== 'probe') monitor._walkRoundId = decision.walkRoundId;
    if (monitor._walkOfferedMin == null || decision.price < monitor._walkOfferedMin) monitor._walkOfferedMin = decision.price;
    if (decision.walkLimit) monitor._walkLimitSent = decision.price;
  }

  // W6: a refusal naming the portal's limit bounds every later walk price by it.
  _noteWalkLimit(monitor, res) {
    const m = rejectionMatch(res, AMOUNT_CAP_RE);
    if (!m) return;
    const digits = String(m[1]).replace(/,/g, '');
    if (!/^\d+$/.test(digits)) return;
    const cap = Number(digits);
    if (monitor._walkLimit == null || cap < monitor._walkLimit) monitor._walkLimit = cap;
  }

  /**
   * FTL multi-vehicle bid plan for a monitor, computed from its persisted meta (quoteType + units).
   * This is the ONE decision point the count fix hangs off. The rule, per the principal's direct
   * instruction, is BID MAX ALWAYS: never bid fewer vehicles than the load's own count.
   *
   *   null            -> NO usable truck count exists to max to, so bid SINGLE. isMultiVehicle
   *                      returns false here for: a single-vehicle FTL load, a PMT load of ANY
   *                      tonnage (its `units` is an MT/KG QUANTITY, not trucks), and a
   *                      missing / -1 / non-finite / <=1 count (there is literally no N - do not
   *                      invent one). The engine passes NO vcq, so the adapter sends its proven
   *                      `vcq:-1` sentinel BYTE-IDENTICALLY to today (SP normalizes -1 to 1 on a
   *                      single-vehicle load). Untouched wire.
   *   { vcq: N }      -> a USABLE count > 1: bid N trucks. `amount` is already PER VEHICLE and
   *                      floor-safe, so ONLY the count changes. N is the load's full truck count
   *                      round(`units`) (the bid-max default) UNLESS the desk lowered it to a
   *                      partial at pricing time (meta.bidVehicleCount, a whole number in
   *                      [1, max]; anything out of range falls back to bid-max). This covers BOTH:
   *                        - a proven, WELL-FORMED FTL multi-vehicle load (recorded non-PMT
   *                          quoteType; proven live 2026-07-23 on load 23423905, vcq:2 recorded
   *                          by SP with zero read-back mismatch), AND
   *                        - an UNKNOWN-BASIS count: units>1 with NO recorded quoteType, seen as
   *                          multi-vehicle only in REAL mode (cfg.failClosedUnknownBasis).
   *                      *** tonnes-vs-trucks: the basis is decided by READING quoteType (the
   *                      backend classifies trucks vs PMT off the SP data, never a human guess).
   *                      A genuine PMT load never reaches here (isMultiVehicle returns false on
   *                      it). The residual is the unknown-basis case (no quoteType, real mode)
   *                      where "max" assumes trucks; the price page surfaces that count as the
   *                      editable "/ N trucks" control the desk sees and can lower, and the
   *                      read-back oracle (vehicle_count_mismatch) is the after-the-fact belt.
   *                      Rare/stale in real SP data (real loads carry quoteType). ***
   *   { hold: true }  -> FAIL CLOSED: _maybeBid refuses before spending any rung and alerts the
   *                      desk. TWO cases hold, and they are not the same event, so _maybeBid
   *                      branches on `reason` to pick the desk copy:
   *                        - the OFF-SWITCH - cfg.multiVehicleBid explicitly false (env
   *                          SP_MULTI_VEHICLE_BID=0), the operator control that disables
   *                          multi-vehicle bidding entirely. Quote it manually.
   *                        - reason 'no_quantity_remaining' - SuperProcure has nothing left open
   *                          on the load. There is no count to quote, so there is nothing to
   *                          quote by hand either, and telling the desk otherwise sends them at
   *                          a load that has already gone.
   *
   * @param {Object} monitor - the armed monitor; only monitor.meta (quoteType, units,
   *   bidVehicleCount) is read.
   * @param {Object} [state] - the CURRENT platform state for this tick; only `remainingQuantity` is
   *   read. OPTIONAL on purpose: absent or null means UNKNOWN and keeps the bid-max behaviour, so
   *   every caller without a live state (mock, sim, an older adapter) is unchanged.
   * @returns {null|{vcq: number}|{hold: true}} - null to bid SINGLE (no vcq on the wire),
   *   { vcq: N } to bid N trucks at the per-vehicle amount, or { hold: true } to fail closed.
   *   Every plan built from the count carries { want, remaining } (remaining null when unknown), a
   *   clamped one adds { clamped: true } and the fully-allotted hold adds
   *   { reason: 'no_quantity_remaining' }, so a caller alerts with the plan's own numbers rather
   *   than recomputing them. The OFF-SWITCH hold is the ONE exception: it returns above the point
   *   where either number is computed, so it carries neither and has no `reason`. A caller reading
   *   want/remaining off a plan must tolerate their absence, and one branching on a hold must test
   *   `reason` rather than assume there is only one kind.
   */
  _multiVehiclePlan(monitor, state) {
    const meta = (monitor && monitor.meta) || {};
    // "Bid max always" is the DEFAULT: any USABLE count > 1 bids the load's full truck count, unless
    // the desk explicitly LOWERED it at pricing time (a partial when BRL can supply fewer trucks) -
    // that chosen count rides meta.bidVehicleCount (price page -> capture -> armFromRequest -> intent).
    // isMultiVehicle already returns false (-> null -> single, the -1 sentinel) for the only cases
    // with no truck count to max to: a missing / -1 / non-finite / <=1 count, and a KNOWN PMT load
    // (units is a tonnage there). In REAL mode failClosedUnknownBasis=true additionally lets an
    // UNKNOWN-basis count (units>1, no quoteType) read as multi-vehicle. The tonnes-vs-trucks basis is
    // resolved by READING quoteType (the backend decides trucks vs PMT), surfaced to the desk as the
    // editable "/ N trucks" count on the price page; the read-back oracle is the after-the-fact belt.
    if (!isMultiVehicle(meta, { strictUnknownBasis: this.cfg.failClosedUnknownBasis })) return null;
    // OFF-SWITCH (SP_MULTI_VEHICLE_BID=0): the operator disabled multi-vehicle bidding entirely ->
    // hold and alert the desk to quote it manually. One of TWO hold paths - the other is the
    // fully-allotted hold below, carrying reason 'no_quantity_remaining'. This one returns ABOVE
    // the want/remaining computation, so it is the bare { hold: true } shape callers have to
    // tolerate and the only hold with no `reason` to branch on.
    if (!this.cfg.multiVehicleBid) return { hold: true };
    // isMultiVehicle already proved units is a finite number > 1; round to the load's full truck count
    // (the bid-max default). The desk's chosen count only ever LOWERS it, and is honoured ONLY when it
    // is a whole number in [1, max] - anything else (absent, 0, NaN, fraction, or ABOVE the load's own
    // count) falls back to bid-max, so a corrupt/legacy/over-total persisted count can never
    // over-commit. Math.max(1, ...) + this clamp keep the vcq invariant (assertValidVcq) safe.
    const max = Math.max(1, Math.round(Number(meta.units)));
    const chosen = Number(meta.bidVehicleCount);
    const want = (Number.isInteger(chosen) && chosen >= 1 && chosen <= max) ? chosen : max;
    // LIVE REMAINING CLAMP. `want` is what the desk committed to; `remaining` is what SuperProcure
    // still has open (see realAdapter's remainingQuantity for where it comes from and why the
    // price-request snapshot is the wrong source). Quoting more than remaining is what SP refuses
    // outright with "Quote quantity is greater than total quantity", so only a genuine shortfall
    // clamps and an unknown remaining keeps today's bid-max rather than inventing a limit.
    //
    // numericOrNull, never a bare Number(): a coerced '', ' ', false or [] is 0, which would read as
    // "this load is fully allotted" off a malformed field. Kept here as the seam's own belt even
    // though the real adapter already applies it, because an adapter that never ran it can still put
    // anything on this field - one shared definition so the two readings cannot disagree.
    // A NEGATIVE reading is unknown, not "fully allotted". SuperProcure has no meaning for a
    // below-zero remaining, so one can only be malformed - and the two readings are not
    // symmetrical: unknown keeps bid-max and makes no claim, while zero holds a winnable load and
    // tells the customer their load was given out. Only the second one can be wrong out loud.
    const numRemaining = numericOrNull(state ? state.remainingQuantity : null);
    const remaining = (numRemaining == null || numRemaining < 0) ? null : Math.floor(numRemaining);
    // `want` and `remaining` ride this plan too, not only the clamped one: the three quantity
    // notices then speak one vocabulary and no caller recomputes a number the plan already holds.
    // Dropping them here to return a bare { vcq } re-splits that vocabulary across the callers.
    if (remaining == null || remaining >= want) return { vcq: want, want, remaining };
    // Nothing left to bid for. Holding is the only honest answer: there is no quantity that can be
    // quoted, so this is not a smaller bid, it is no bid - and the desk needs to know the load went
    // away rather than see a silent zero.
    if (remaining < 1) return { hold: true, reason: 'no_quantity_remaining', want, remaining };
    // A genuine shortfall: bid for what is actually left. Winning fewer trucks beats the guaranteed
    // refusal that bidding `want` produces, and the economics are unchanged because the ladder price
    // is PER VEHICLE - the desk's per-truck cost and floor both still hold at the lower count. The
    // desk is told (see the vehicle_count_clamped alert) because it is their commitment being
    // reduced, and partial supply is already a supported concept - it is the same thing the price
    // page's own count control lets them do by hand.
    return { vcq: remaining, clamped: true, want, remaining };
  }

  /**
   * The opts handed to adapter.placeBid: this load's LoadRules (the per-load facts the payload
   * builder reads) plus the operating floor for the adapter-boundary floor belt. The LoadRules keys
   * are DISTINCT from the createV2 wire keys, so this changes NO wire value today; `floor` is not a
   * wire field either (buildBidPayload ignores it) - it only feeds the belt's assertAboveFloor.
   */
  _bidOpts(monitor) {
    return Object.assign({}, monitor.meta && monitor.meta.rules, { floor: monitor.floor });
  }

  /**
   * CLAMPED: SuperProcure's remaining quantity was below what the desk committed to, so the bid went
   * out for what is actually left. The desk hears it from us rather than discovering it on a win
   * receipt for fewer trucks than they priced. Not an error - this is the engine winning a load it
   * would otherwise have been refused on outright.
   *
   * ONE definition with TWO call sites, and that is the point: both are places the engine concludes a
   * clamped bid is on the board - the accepted response, and the fail-closed arm of the transport
   * -failure handler that counts a landed bid by assumption. A second copy is how an invariant ends
   * up wired to one path and silently missing from its sibling.
   *
   * Called only from those two sites and nowhere upstream: it says "We have bid", a money claim, and
   * a money claim may only be made where money actually moved. Every gate between the plan and a
   * write - revisionsLeft, minInterFireMs, the rate cap, a null decision - can end the tick with no
   * bid at all.
   *
   * Latched on the COUNT, not the fact of clamping: `remaining` only ever falls, so one auction can
   * clamp 5 -> 3 -> 2 and each value really does go on the wire. A boolean latch leaves the desk
   * holding the first number while we bid the third, which is the staleness this notice exists to
   * prevent. The dedupeKey folds the count in for the same reason. Sharing the latch across both
   * sites is also what stops them double-firing on one clamp.
   */
  _maybeAlertVcqClamp(monitor, mvPlan) {
    if (!mvPlan || !mvPlan.clamped || mvPlan.vcq == null) return;
    if (monitor._vcqClampAlertedAtRemaining != null
        && mvPlan.remaining >= monitor._vcqClampAlertedAtRemaining) return;
    monitor._vcqClampAlertedAtRemaining = mvPlan.remaining;
    this.log.warn('SuperProcure remaining quantity was below the count the desk chose; bid placed for what is left', {
      auctionId: monitor.auctionId, units: monitor.meta && monitor.meta.units,
      vcqSent: mvPlan.vcq, want: mvPlan.want, remaining: mvPlan.remaining });
    this.emit({ type: 'alert', level: 'warn', kind: 'vehicle_count_clamped', auctionId: monitor.auctionId,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null,
      units: monitor.meta.units, vcqSent: mvPlan.vcq, want: mvPlan.want, remaining: mvPlan.remaining });
  }

  /**
   * How many writes the PLATFORM allows on this load, or null where it has not said.
   *
   * Read off the seam the engine already reads it from, never from a per-platform test, because a
   * `if (platform === 'gocomet')` encodes today's answer to a question the adapters are already
   * required to answer for themselves:
   *
   *   state.revisionLimit   the LIVE per-load cap. SuperProcure's branchBidCountAllowed rides the
   *                         load (realAdapter._mapLoad -> getAuctionState); GoComet computes
   *                         revisions_left + total_revisions off bidding-data. This wins because it
   *                         is the only one that can be right on a platform whose cap is per-branch.
   *   caps.revisionLimit    the platform-STATIC declaration, bound once at construction. GoComet
   *                         states 3; SuperProcure states null, correctly - at the platform level
   *                         its cap is genuinely unknown.
   *   null                  neither said. NOT coerced to a number in either direction.
   *
   * The null is the load-bearing part. Reading an unpublished cap as tight would retire prices on
   * every adapter that declares none, which is a behaviour change nothing in the record supports;
   * reading it as ample is what already ships. So absence selects today's behaviour, and only a
   * platform positively stating a small number changes anything.
   */
  _attemptBudget(state) {
    // COERCED before the finiteness test, matching the two sibling reads of this same field
    // (_deriveRungCount and the revisions-left check). realAdapter maps it straight off the
    // /sp/loads/v4 wire - `revisionLimit: l.branchBidCountAllowed || l.loadBidCountAllowed || null`
    // - with no coercion, and SuperProcure demonstrably ships other numerics on that payload as
    // quoted strings (ceilingPrice, rules.transitDays). A bare Number.isFinite("3") is false, so a
    // quoted cap would fall through to the platform-static declaration, which SuperProcure states as
    // null - and this whole change would silently no-op on exactly the tight-budget customers it
    // exists for, with no alert to say so. The permissive direction is the dangerous one here.
    const live = this._finiteCap(state && state.revisionLimit);
    if (live != null) return live;
    return this._finiteCap(this.caps && this.caps.revisionLimit);
  }

  // One numeric read for both attempt-budget seams. null for absent, unparseable, or non-finite -
  // never a NaN and never a coerced zero from '' or null, which Number() would otherwise hand back.
  _finiteCap(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * How many times ONE price may go on the wire for this load once the platform has refused it.
   *
   * THE OWNER'S RULING, 2026-09-10: "on 3-attempt auctions don't retry a failed price - retry the
   * NEXT rung. On higher bid budgets we can retry more." The bound shipped as a constant 3, which is
   * defensible against a 30-revision SuperProcure branch and indefensible against a 3-revision one -
   * there, three writes at one price the platform has already answered ARE the whole auction. 7 of
   * 12 active SuperProcure customers sit at branchBidCountAllowed <= 3 and GoComet is 3 per vendor
   * per enquiry platform-wide, shared with BRL's own autopilot on the same vendor identity.
   *
   * THE SECOND CLAUSE NEEDS NO MECHANISM, and that is why this is one number rather than a new
   * control path. The reject path already banks the fired rung and selectRung walks the ladder using
   * firedRungs itself, so banking IS the advance to the next rung. The only price the engine ever
   * re-sent is the FLOOR one, where the nothing-placed restore un-banks it (correctly - a refused
   * write placed nothing) and there is no lower rung to walk to. A bound of 1 closes that loop on the
   * first refusal instead of the third and leaves the restore, and the 360 lines of measured
   * rejection handling around it, untouched.
   *
   * LOW_CAP_THRESHOLD is reused rather than a second threshold invented: it already means exactly
   * this ("at or below this cap there is no slack to absorb a slot a human already spent") and
   * _deriveRungCount already draws the line in the same place. Two numbers meaning one thing drift.
   *
   * THE BOUND DOES NOT KEY ON WHETHER THE REFUSAL WAS RECOGNISED, and that is a correction made
   * against evidence rather than an omission. Tightening an unrecognised shape to 1 at every budget
   * reads as the conservative choice, and it is not: the engine has a NAMED regex only for the five
   * refusals that needed a non-default response, so the whole healthy price/state population -
   * min-decrement mismatches above all, the most common refusal there is - classifies as
   * "unrecognised" and would have had its retry cut on wide-budget branches where the record shows
   * the retry working. The shape decides what the stand-down is CALLED and whether a human is
   * paged; the budget decides how many writes one price may spend.
   */
  _refusedPriceBound(state, monitor = null) {
    const budget = this._attemptBudget(state);
    if (budget != null && budget <= LOW_CAP_THRESHOLD) {
      if (monitor) monitor._refusedBoundTight = true;
      return 1;
    }
    // Latched: a frame that arrives without its cap says nothing new about the load's budget, so it
    // must not loosen a bound the load already stated as tight and re-send a price the desk was told
    // is held (T5 F6).
    if (monitor && monitor._refusedBoundTight) return 1;
    return this.cfg.refusedPriceAttempts;
  }

  /**
   * A REFUSAL THIS ENGINE RE-LEARNS LEAVES NO DURABLE TRACE, and getting that half-right is what
   * turned a restart into a margin concession.
   *
   * loadNotBiddable and quantityRefused are SuperProcure's live state about a load it may since have
   * reopened, so they are deliberately re-learned each lifetime rather than carried on the intent
   * (see the monitor fields). But the rejection handler banks the rung, and the refused-price run
   * records the price, for ANY refusal - so the next lifetime came back with the verdict cleared and
   * both traces intact. selectRung reads firedRungs as the walk, so it stepped PAST the banked rung
   * to the next price down; and the bound the carried run was already at pushed the following
   * lifetime to the floor. Measured on a 5-rung ladder against "Load not available for bidding":
   * 115000, 112000, 109000, 106000 over four lifetimes, a rung of margin per deploy, where the
   * deployed baseline re-offered 115000 each time and stood down again.
   *
   * Both traces are therefore withheld together. Filtered HERE rather than rolled back in the
   * handler because the in-memory run still bounds the retry a quantity clamp is entitled to within
   * this lifetime - it is only its survival into the next one that is wrong.
   */
  _refusalStateOf(monitor, onRecord) {
    const recorded = new Set(onRecord || (this.scheduler.get(monitor.auctionId) || {}).firedRungs || []);
    const relearnedPrices = new Set([...monitor._relearnedRungs].map((i) => monitor.ladder[i]));
    const runRelearned = monitor._refusedPrice != null && relearnedPrices.has(monitor._refusedPrice);
    return {
      // WHICH QUOTE THESE VERDICTS ARE ABOUT. arm() carries them back only onto the same epoch, so a
      // re-price - which bumps it - starts clean however little the ladder moved.
      epoch: Number.isInteger(monitor.repriceEpoch) ? monitor.repriceEpoch : 0,
      priceRaiseRefused: monitor.priceRaiseRefused === true,
      priceRaiseRefusedCap: monitor.priceRaiseRefusedCap != null ? monitor.priceRaiseRefusedCap : null,
      submissionClosed: monitor.submissionClosed === true,
      submissionClosedAtClose: monitor._submissionClosedAtClose != null ? monitor._submissionClosedAtClose : null,
      // The tight refused-price bound (T5 F6): a restart that forgot it would re-send a held price on
      // the first frame that arrives without its cap.
      boundTight: monitor._refusedBoundTight === true,
      refusedPrice: runRelearned ? null : monitor._refusedPrice,
      refusedPriceVcq: runRelearned ? null : monitor._refusedPriceVcq,
      refusedPriceCount: runRelearned ? 0 : monitor._refusedPriceCount,
      refusedPriceUnrecognised: !runRelearned && monitor._refusedPriceUnrecognised === true,
      refusedPriceBody: runRelearned ? null : monitor._refusedPriceBody,
      refusedPriceStatus: runRelearned ? null : monitor._refusedPriceStatus,
      // Only what the durable firedRungs lacks - see carriedOfferedRungs in arm().
      offeredRungs: [...monitor.firedRungs].filter((i) => !monitor._relearnedRungs.has(i) && !recorded.has(i)),
    };
  }

  /**
   * Put the portal's verdicts about the CURRENT ladder on the durable intent, so a pm2 restart
   * resumes knowing which prices have already been answered. arm() carries them back only while the
   * quote it derives is still the same one - see priorRefusal there.
   *
   * Caught here, like the everBid persist on the same path: the caller sits inside the try{} whose
   * catch is the uncertain-outcome handler, which would read a disk error as a bid that may have
   * committed and bank a landed bid that never existed. A failed write costs only the carry - the
   * next lifetime re-learns, as it did before this was persisted - so it is logged, not raised.
   */
  _persistRefusalState(monitor) {
    try {
      this.scheduler.update(monitor.auctionId, { refusalState: this._refusalStateOf(monitor) });
    } catch (e) {
      this.log.warn('could not save the portal refusals for this load; a restart will re-learn them', {
        auctionId: monitor.auctionId, err: (e && e.message) ? e.message : String(e) });
    }
  }

  _addInFlightPrice(auctionId, token, price) {
    let m = this._inFlightPrices.get(auctionId);
    if (!m) { m = new Map(); this._inFlightPrices.set(auctionId, m); }
    m.set(token, price);
  }

  _removeInFlightPrice(auctionId, token) {
    const m = this._inFlightPrices.get(auctionId);
    if (!m) return;
    m.delete(token);
    if (m.size === 0) this._inFlightPrices.delete(auctionId);
  }

  // The lowest price on the wire for this auction right now, EXCLUDING the write identified by
  // excludeToken (its own refusal is being judged, not itself). null when nothing else is in flight.
  _lowestOtherInFlightPrice(auctionId, excludeToken) {
    const m = this._inFlightPrices.get(auctionId);
    if (!m) return null;
    let lowest = null;
    for (const [token, price] of m) {
      if (token === excludeToken) continue;
      if (lowest == null || price < lowest) lowest = price;
    }
    return lowest;
  }

  _clearGcPending(monitor, attemptId) {
    for (const m of new Set([monitor, this.monitors.get(monitor.auctionId)])) {
      if (m && m.pendingGcSubmission && m.pendingGcSubmission.attemptId === attemptId) {
        m.pendingGcSubmission = null;
        m.gcAccountPosition = null;
        m._gcCheckedAt = 0;
      }
    }
  }

  _recordGcUnconfirmed(monitor, attempt, response = {}) {
    const current = this.scheduler.get(monitor.auctionId) || {};
    const entry = { ...attempt, outcome: 'unconfirmed', status: response.status ?? attempt.status ?? null,
      reason: response.reason || attempt.reason || 'Submission response was not durably confirmed' };
    const rows = [...(current.gcUnconfirmedSubmissions || monitor.gcUnconfirmedSubmissions || [])];
    const index = rows.findIndex(r => r.attemptId === entry.attemptId);
    if (index < 0) rows.push(entry); else rows[index] = { ...rows[index], ...entry };
    const pending = current.pendingGcSubmission;
    const patch = { gcUnconfirmedSubmissions: rows };
    if ((pending && pending.attemptId === entry.attemptId)
        || (!pending && !(Number(current.landedBids) > Number(entry.priorLandedBids || 0)))) patch.pendingGcSubmission = entry;
    try {
      if (!this.scheduler.update(monitor.auctionId, patch)) throw new Error('Missing durable intent');
    } catch (err) {
      monitor._gcPersistenceBlocked = true;
      this._recordWriteFailed(monitor, 'bid_record_failed', 'Submission outcome could not be saved. Automatic bidding is held; check GoComet.', err, {});
    }
    for (const m of [monitor, this.monitors.get(monitor.auctionId)].filter(Boolean)) {
      m.gcUnconfirmedSubmissions = rows;
      if ('pendingGcSubmission' in patch) { m.pendingGcSubmission = entry; m.gcAccountPosition = null; m._gcCheckedAt = 0; }
      if (monitor._gcPersistenceBlocked) m._gcPersistenceBlocked = true;
    }
    this.emit({ type: 'bid_unconfirmed', auctionId: monitor.auctionId, submission: entry });
    if (!monitor._gcNoticeSent) {
      monitor._gcNoticeSent = true;
      this.emit({ type: 'alert', kind: 'submission_unconfirmed', level: 'warn', auctionId: monitor.auctionId,
        lane: monitor.meta.lane, companyName: monitor.meta.companyName, branchName: monitor.meta.branchName,
        detail: 'GoComet did not confirm the submission response. We are checking the account quote before another bid; do not repeat it manually.' });
    }
  }

  async _checkGcSubmission(monitor, { atClose = false, deadline = Infinity } = {}) {
    if (monitor._gcPersistenceBlocked) return false;
    const intent = this.scheduler.get(monitor.auctionId);
    const pending = intent && Object.prototype.hasOwnProperty.call(intent, 'pendingGcSubmission')
      ? intent.pendingGcSubmission : monitor.pendingGcSubmission;
    if (!pending && monitor.pendingGcSubmission) this._clearGcPending(monitor, monitor.pendingGcSubmission.attemptId);
    if (!pending) return true;
    monitor.pendingGcSubmission = pending;
    if (this._gcActiveAttempts && this._gcActiveAttempts.has(pending.attemptId)) return false;
    if (monitor._gcChecking) return false;
    if (!atClose && monitor._gcCheckedAt && Date.now() - monitor._gcCheckedAt < 5000) return !!monitor.gcAccountPosition;
    monitor._gcChecking = true;
    try {
      const position = typeof this.adapter.readSubmissionPosition === 'function'
        ? await this.adapter.readSubmissionPosition(monitor.auctionId, pending) : null;
      if ((monitor.finalized && !atClose) || Date.now() >= deadline
          || this.killed || this.monitors.get(monitor.auctionId) !== monitor) return false;
      monitor.gcAccountPosition = position && position.verified ? position : null;
      if (monitor.gcAccountPosition) {
        const current = this.scheduler.get(monitor.auctionId);
        if (!current || !current.pendingGcSubmission || current.pendingGcSubmission.attemptId !== pending.attemptId) return false;
        const submission = { ...pending, accountQuoteVerified: position };
        const rows = (current.gcUnconfirmedSubmissions || []).map(r => r.attemptId === pending.attemptId ? { ...r, ...submission } : r);
        try {
          this.scheduler.update(monitor.auctionId, { pendingGcSubmission: submission, gcUnconfirmedSubmissions: rows });
        } catch (err) {
          monitor._gcPersistenceBlocked = true;
          this._recordWriteFailed(monitor, 'bid_record_failed', 'Account quote verification could not be saved. Automatic bidding is held.', err, {});
          return false;
        }
        monitor.pendingGcSubmission = submission;
        monitor.gcUnconfirmedSubmissions = rows;
        monitor.revisionsLeft = position.revisionsLeft;
        this.emit({ type: 'bid_unconfirmed', auctionId: monitor.auctionId,
          submission });
      }
      return !!monitor.gcAccountPosition;
    } catch (_) { monitor.gcAccountPosition = null; return false; }
    finally { monitor._gcCheckedAt = Date.now(); monitor._gcChecking = false; }
  }

  async _maybeBid(monitor, state) {
    // Describes this tick's decision only; the rank-1 hold in _decide sets it again if it holds.
    monitor.heldLeadAtLastDecision = false;
    if (monitor.bidInProgress) return;
    if (this.caps.durableSubmissionTracking && !(await this._checkGcSubmission(monitor))) return;
    if (monitor.finalized || this.killed || monitor.bidInProgress) return;
    if (monitor.provisionalClose) state = { ...state, closesInMs: this._provisionalRemainingMs(state) };
    if (monitor.pendingGcSubmission) {
      const p = monitor.gcAccountPosition;
      const remaining = p && p.closesInMs - Math.max(0, Date.now() - p.verifiedAt);
      if (!p || p.biddingOpen !== true || !Number.isFinite(remaining) || remaining <= 0) return;
      state = { ...state, closesInMs: Math.min(state.closesInMs, remaining) };
    }
    if (!Number.isFinite(state.closesInMs)) { this._holdUnknownCountdown(monitor); return; }
    // STAND DOWN: SuperProcure has told us this load is not biddable (see isLoadNotBiddableRejection
    // for the evidence that this is a per-load state and a persistent one). Placed FIRST, above every
    // other gate, because the thing being stopped is not one rung but the whole load - no retry, no
    // rung walk-down, and in particular no last-chance FLOOR SNIPE, which sits below the ladder gates
    // and would otherwise still fire into a load that structurally cannot take a bid. The alert and
    // the recorded refusal were both raised at the moment the platform said so, so this is a silent
    // return by design: it must not re-alert once per 200 ms poll for the rest of the auction. The ONE
    // thing that still runs is the retraction, because this gate sits above the auth branch that would
    // otherwise reach it: a load told to be hand-bid and THEN refused as not-biddable could never be
    // told to stop. It is liveness-gated, episode-gated and bounded to 10 offers, so it cannot become
    // the per-tick alert this return exists to prevent, and - because this is one of the two sites
    // that reach it with the account DEAD - it cannot all-clear into a live outage either.
    if (monitor.loadNotBiddable) { this._maybeAlertAuthCleared(monitor); return; }
    // STAND DOWN: the portal will not take an upward revision on this load (see raiseRefusal), or it
    // has said the submission window is over (see isSubmissionClosedRejection). Placed beside the
    // not-biddable gate and above every ladder gate for the identical reason - what is being stopped
    // is the whole load rather than one rung, and in particular the last-chance floor snipe, which
    // lives below the ladder gates and would otherwise keep offering a price the portal has already
    // ruled on. Silent by design: the alert and the recorded refusal were both raised at the refusal
    // itself, and re-raising them once per 200 ms poll is the flood these returns exist to prevent.
    //
    // Neither latch zeroes the budget and neither is persisted, so the desk's own re-price is the
    // reversal: it rebuilds the monitor and the next attempt re-learns the platform's answer.
    //
    // The retraction runs for the same reason it runs on the gate above, and it is not optional
    // here: this return sits above the auth branch that would otherwise reach it, so a load the desk
    // was told to bid by hand during an outage and which then hit one of these refusals could never
    // be told to stop hand-bidding it. A pre-wire stand-down (prewireStoodDown) is the same shape.
    if (monitor.priceRaiseRefused || monitor.submissionClosed || monitor.prewireStoodDown) {
      this._maybeAlertAuthCleared(monitor); return;
    }
    // STAND DOWN, ACCOUNT-WIDE: SuperProcure has ended this login's session, so no write on this
    // account can be accepted. Placed here - above every ladder, budget and cadence gate - because
    // by the time placeBid is reached the engine has ALREADY, and before the await, pushed a
    // bidTimes slot, incremented ownBidAttempts, set everBid and advanced both endgame latches
    // optimistically. A gate that lived only inside the adapter would still churn all of that on
    // every 200 ms hot tick for the whole outage and emit one bid_rejected per tick per load: the
    // 360 records of 2026-08-04 would have become 360 records of a different colour, not ~1.
    //
    // It reads the LIVE ADAPTER PREDICATE, never a monitor field, and that is the single most
    // important property of this gate. The monitor flags are HISTORY ("this load hit the wall");
    // the adapter's latch is STATE ("the account cannot bid right now"). Reading the history would
    // convert a transient outage into a permanent one for every load that touched it. Reading the
    // state IS the self-resume mechanism: there is no timer and no retry loop, the monitor simply
    // keeps ticking at its normal cadence and the first tick after the latch clears passes straight
    // through and bids.
    //
    // Feature-detected because isAuthDead is a SuperProcure-only capability - the mock, sim and
    // GoComet adapters do not have it, and every engine test that hand-rolls a stub adapter must
    // stay byte-identical. Do not remove the typeof guard.
    //
    // TWO PREDICATES, NOT ONE, and conflating them is a bug in both directions. `authDead` is the
    // account FACT that explains this load's silence and gates the close-time alarm. `authWriteHeld`
    // is the narrower question of whether THIS tick may use the wire, and it is false for the one
    // trial write per interval a latched adapter still permits in order to find out whether its
    // write scope is back. An adapter that has isAuthDead but not authWriteHeld (every hand-rolled
    // test stub) falls back to a hard hold - byte-identical to the previous behaviour.
    const authDead = this._authDeadNow();
    // SHADOW MONITORS ARE NOT SUBJECT TO THIS GATE AT ALL. A shadow monitor performs zero wire writes
    // by construction, so an account-wide WRITE latch says nothing about it: holding it corrupts the
    // soft-close validation data during exactly the window an operator later reads, and marking it
    // leaves a permanently stale `session_logged_out` on a monitor that returns out of the shadow
    // branch below (the `return` that ends it, ~2549) and can never reach the fire point where that
    // record is cleared. That stale reason then wins at close,
    // because _refusalAtClose checks monitor.noBid before the shadow_strategy fallback - which is the
    // exact bug class PR #115 (SIKA 23534893) was built to close.
    if (authDead && monitor.softStrategy !== 'shadow') {
      // ONE PREDICATE decides BOTH the suppression flag and the recorded reason - see
      // _markAuthBlocked. They encode a single judgement ("this load's silence is explained by the
      // account-wide auth wall") and writing them under different conditions is what let a load carry
      // a correct non-auth receipt while its alarm was silenced anyway.
      //
      // INFERRED evidence, so it yields to any load-specific history: a load that already used the
      // wire, or that already recorded a terminal refusal, owns a better explanation of its own
      // silence than an account-wide guess, and must keep alarming on its own merits.
      // The notice rides on the HOLD, not on the mark. When the write is held this tick is the end of
      // the road for the load and the desk needs to hear it; when a trial write is due the tick
      // continues to the fire point and may land a bid, and "go bid it on the portal" sent one line
      // above that is a duplicate manual bid against SuperProcure's shared per-load cap. Marks still
      // apply either way - they are reversible, the message is not.
      const writeHeld = this._authWriteHeldNow();
      this._markAuthBlocked(monitor, { direct: false, notice: writeHeld });
      if (writeHeld) return;
    } else {
      if (monitor.authBlockedLast === true) {
        // THE ACCOUNT IS DEMONSTRABLY ALIVE AGAIN, so the auth facts this load is carrying are stale -
        // dropped HERE, at the top, and not only at the fire point far below. A load reaching the fire
        // point is one specific way out of this method; there are at least four intervening returns
        // (no revisions left, the inter-fire interval, the rate cap, _decide declining) that a load can
        // legitimately take for the rest of its life. Clearing only at the fire point meant a 90-second
        // outage silenced an unrelated load's zero-bid alarm for the full two-hour bound and put
        // "our SuperProcure login was logged out" on the receipt of a load that closed for an entirely
        // different reason. Only the auth record is dropped - a terminal price refusal is not ours.
        //
        // `_authNotice` is deliberately NOT dropped with it. It is the retraction DEBT - a message
        // went to the desk and has not been closed - and this line runs ~3 minutes before that debt
        // can be discharged (see _maybeAlertAuthCleared), so clearing it here destroys the retraction
        // before recovery is even observable. The two facts are not the same fact: this flag says
        // "the last thing that happened to this load's bidding was the auth wall", the record says
        // "somebody was told to go bid this load by hand".
        monitor.authBlockedLast = false;
        if (monitor.noBid && monitor.noBid.reason === 'session_logged_out') monitor.noBid = null;
      }
      // OUTSIDE the clear above, and that placement is the whole fix. The clear runs at most once -
      // it guards on a flag it immediately falsifies - and it runs on the FIRST tick the account
      // reads alive, which is minutes before the episode closes. A retraction attempted from inside
      // it therefore finds the episode still open at the one instant it is reached, and is never
      // reached again. Out here it is re-evaluated on every alive tick, which is what lets it wait
      // for the episode to close and then carry its own bounded re-offer.
      this._maybeAlertAuthCleared(monitor);
    }
    // NO CLOCK-BASED POST-CLOSE GATE LIVES HERE, and that is a deliberate deletion rather than an
    // omission. One was written and removed: every shipped adapter floors the countdown at zero
    // (spSocket `Math.max(0, end - serverNow())`, realAdapter the same on both branches, gocomet
    // `closed ? 0 : ...`), so a guard keyed on the countdown running NEGATIVE can never fire in
    // production, and the only alternative - comparing the platform's close epoch against this box's
    // wall clock - measures clock skew as well as elapsed time and was measured holding a live
    // auction for up to one full extension round on a fast box.
    //
    // What actually delivers "no submission after close" is the platform saying so:
    // isSubmissionClosedRejection latches on "Auction has already ended for this load" after exactly
    // ONE refused write, which is skew-free, clock-free, and cannot be defeated by a year-2100
    // placeholder because it reads no timestamp at all. _tick's own sustained-zero finalize retires
    // the monitor on top of that. A clock the engine cannot trust has nothing to add to either.
    // Layer A - FTL multi-vehicle hold guard. BEFORE any rung is considered/spent: under bid-max-always
    // a load with a usable count > 1 auto-bids vcq:N (the well-formed AND the unknown-basis case alike),
    // so it does not reach here. A multi-vehicle load holds here in the TWO fail-closed cases
    // _multiVehiclePlan keeps closed: the OFF-switch (SP_MULTI_VEHICLE_BID=0), the operator control that
    // disables multi-vehicle bidding entirely, and reason 'no_quantity_remaining', SuperProcure having
    // nothing left open on the load. Both refuse to bid, but only the off-switch can be cleared by
    // quoting manually - which is why the block below branches on `reason` instead of sharing one copy.
    // Deduped per monitor (the alert's own dedupeKey collapses it per load on WhatsApp too).
    const mvPlan = this._multiVehiclePlan(monitor, state);
    // STAND DOWN: SuperProcure refused the vehicle COUNT (see isQuantityRefusedRejection). Above
    // every ladder gate, including the last-chance floor snipe that lives below them and would
    // otherwise fire one more refused write into a load whose quantity SP has already rejected.
    // Silent by design - the alert and the recorded refusal were raised at the refusal itself.
    // BELOW the plan, not above it, and that ordering is the whole guard: remainingQuantity is
    // served off a ~30s listing poll, so the tick that fires after a partial allotment still bids
    // the stale full count and is refused, and the clamp that would have saved the load only appears
    // on the NEXT poll. A gate above the plan returns before that clamp can ever run, i.e. it
    // pre-empts the fix on exactly the loads the fix exists for.
    if (monitor.quantityRefused) {
      const vcqNow = (mvPlan && mvPlan.vcq != null) ? mvPlan.vcq : null;
      if (vcqNow == null || monitor.quantityRefusedAtVcq == null
          || vcqNow >= monitor.quantityRefusedAtVcq) return;
    }
    if (mvPlan && mvPlan.hold) {
      if (!monitor._multiVehicleAlerted) {
        monitor._multiVehicleAlerted = true;
        // TWO hold reasons now, and they are not the same event. The OFF-SWITCH is an operator
        // setting; NO QUANTITY REMAINING is the platform saying the load has been fully allotted out
        // from under us while we were armed. Folding the second into the first's copy would tell the
        // desk to go quote a load by hand that has nothing left to quote for.
        if (mvPlan.reason === 'no_quantity_remaining') {
          // Remaining reaching zero BECAUSE the shipper allotted the load is the expected way for it
          // to reach zero, and the allotment may be OURS. So a load carrying a landed bid is not a
          // no-bid load: recording the refusal would put a false cause on the close-time receipt, and
          // the unconditional copy tells the customer's own group "No bid was placed" while our bid
          // stands on the board. Same guard _finalize already applies to noBidWhy; the count rides
          // the alert so the desk copy can say which of the two happened.
          //
          // And only where NOTHING is already recorded - the guard is on the PRESENCE of a record,
          // not on its being terminal. _recordRefusal is last-writer-wins, and this branch RETURNS
          // above _decide, the one site that re-asserts ceiling_below_floor on every tick precisely
          // so close time can read it; a ceiling-blocked load later allotted out would otherwise
          // lose its ceiling and floor and tell the customer's own group the rate was not the
          // problem. Being blanket, a TRANSIENT record (session_logged_out) blocks it too - and not
          // merely until the engine next fires: the fire point that clears a stale logout sits below
          // this return, which every later tick takes once remaining reads below 1. The alert below
          // still fires either way.
          if (monitor.landedBids === 0 && !monitor.noBid) {
            this._recordRefusal(monitor, 'no_quantity_remaining', { want: mvPlan.want, remaining: mvPlan.remaining });
          }
          this.log.warn('holding multi-vehicle load: SuperProcure reports no quantity remaining on it', {
            auctionId: monitor.auctionId, units: monitor.meta && monitor.meta.units,
            want: mvPlan.want, remaining: mvPlan.remaining, landedBids: monitor.landedBids });
          this.emit({ type: 'alert', level: 'warn', kind: 'no_quantity_remaining', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            units: monitor.meta.units, want: mvPlan.want, remaining: mvPlan.remaining,
            landedBids: monitor.landedBids });
          return;
        }
        this.log.warn('holding FTL multi-vehicle load: multi-vehicle bidding is switched off (SP_MULTI_VEHICLE_BID=0); quote it manually', {
          auctionId: monitor.auctionId, units: monitor.meta && monitor.meta.units, quoteType: monitor.meta && monitor.meta.quoteType });
        this.emit({ type: 'alert', level: 'error', kind: 'multi_vehicle_held', auctionId: monitor.auctionId,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName, units: monitor.meta.units,
          detail: `needs ${monitor.meta.units} vehicles. This multi-vehicle load was NOT auto-bid because multi-vehicle bidding is switched off - quote this one manually on SuperProcure` });
      }
      return;
    }
    // Budget exhausted -> spend no further rung. capExhausted (the platform's own "Bid limit
    // exceeded") drives revisionsLeft to 0, so it lands here too; its own bid_cap_exhausted alert
    // already named the cause with the platform's reason string, and _noRevAlerted is pre-latched
    // at that point so this does not also fire the vaguer no_revisions_left on the same load.
    if (monitor.revisionsLeft != null && monitor.revisionsLeft <= 0) {
      if (!monitor._noRevAlerted) {
        monitor._noRevAlerted = true;
        this.emit({ type: 'alert', level: 'warn', kind: 'no_revisions_left', auctionId: monitor.auctionId });
      }
      return;
    }
    if (Date.now() - monitor.lastFireAt < this.cfg.minInterFireMs) return;

    // bids/min cap — a soft runaway guard sitting under the hard kill-switch. A real
    // 3-bid auction never nears it; a bug re-firing in a loop trips it and stops.
    const nowTs = Date.now();
    monitor.bidTimes = monitor.bidTimes.filter((t) => nowTs - t < 60_000);
    // THE DECISIVE-SHOT RESERVATION. maxBidsPerMin was doing two unrelated jobs: a runaway rate limit,
    // AND - by accident, never by design - the only thing standing between a retry loop and the write
    // budget the final floor shot needs. Those are not the same budget, and this gate returns BEFORE
    // _decide is ever called, so whichever path spends first simply wins. A retry loop always spends
    // first: it runs for the whole auction, while the decisive shot has one 2.5s window at the end.
    // That is how the cap became the CAUSE of a loss it was being cited as the cure for - 20 refused
    // establish writes exhausted it, and the floor snipe was starved by a guard that never even
    // reached the decision.
    //
    // Split the budget instead. Ordinary traffic stops floorSnipeReservedSlots short of the cap; only
    // a decision that is (or is about to be) the decisive shot may spend into the reserve. The full
    // cap still bounds everything, so the runaway guard is intact - what changes is WHO gets the last
    // few slots, and the answer is the shot that ends the auction.
    // NEVER MORE THAN A QUARTER of the budget, whatever floorSnipeReservedSlots says. The reservation
    // is meaningful because the production cap (20) is far above what a real auction uses (3), so
    // holding 4 back costs nothing. On a deliberately TIGHT cap the same 4 would be most of the
    // budget, and a guard that reserves the majority of the allowance has stopped being a reservation
    // and become the rate limit - it would throttle ordinary bidding to buy protection for a shot that
    // is not due yet. A small cap therefore reserves proportionally, down to nothing.
    const decisiveDue = this._isLastChance(state.closesInMs) || this._decisiveShotDue(monitor, state.closesInMs)
      || (this._walkOn(monitor) && state.closesInMs <= this.walkCfg[this._walkPlatform(monitor)].maxWalkWindowMs);
    const reservedSlots = Math.max(0, Math.min(this.cfg.floorSnipeReservedSlots,
      Math.floor(this.cfg.maxBidsPerMin / 4)));
    const effectiveCap = decisiveDue ? this.cfg.maxBidsPerMin : (this.cfg.maxBidsPerMin - reservedSlots);
    if (monitor.bidTimes.length >= effectiveCap) {
      if (!monitor._rateCapAlerted) {
        monitor._rateCapAlerted = true;
        this.emit({ type: 'alert', level: 'warn', kind: 'bids_per_min_cap', auctionId: monitor.auctionId,
          // `cap` keeps its meaning for every existing consumer - the configured per-minute maximum.
          // effectiveCap/reservedSlots say which of the two budgets actually stopped this tick, so an
          // operator reading the alert is not left comparing a count against a number it never hit.
          cap: this.cfg.maxBidsPerMin, effectiveCap, reservedSlots,
          decisiveShotDue: decisiveDue, placedInWindow: monitor.bidTimes.length });
      }
      return;
    }

    let decision;
    const botPrice = monitor.lastBidPrice;
    try {
      if (monitor.gcAccountPosition) {
        monitor.lastBidPrice = botPrice == null ? monitor.gcAccountPosition.price : Math.min(botPrice, monitor.gcAccountPosition.price);
        if (state.myRank == null) state = { ...state, myRank: monitor.gcAccountPosition.rank };
      }
      decision = this._decide(monitor, state);
    } finally { monitor.lastBidPrice = botPrice; }
    if (!decision) return;
    if (monitor.pendingGcSubmission && (!monitor.gcAccountPosition || !(decision.price < monitor.gcAccountPosition.price))) return;

    // latency guard: don't fire so late the bid can't physically arrive before close,
    // UNLESS this is the last-chance floor rung (then fire anyway — best effort). The
    // countdown timed against is always the platform's own; RTT compensation is what
    // keeps this guard honest against a slow link instead of assuming a fast one.
    const oneway = (state.measuredRttMs || 80) / 2;
    const isFloorRung = decision.rungIndex === monitor.ladder.length - 1 || decision.rungIndex === null;
    // Last-chance override: once remaining time is inside the fixed floor window, ANY decision
    // fires best-effort, ignoring the RTT-compensated lead — without this, a load armed so late
    // that the establish decision is due but remaining is already under the lead sits in
    // _decide's currentRungIndex<0 branch forever (step-3's final-snipe branch is gated on
    // currentRungIndex>=0, so it's unreachable) -> zero bids, silently. Deliberately kept
    // SEPARATE from isFloorRung: isFloorRung also exempts the min-decrement check below, and
    // that exemption must not widen just because we're in the last-chance window.
    const lastChance = this._isLastChance(state.closesInMs);
    this.log.debug('latency-compensated fire check', { auctionId: monitor.auctionId,
      measuredRttMs: state.measuredRttMs, onewayMs: oneway, minLeadMs: this.cfg.minLeadMs,
      remainingMs: state.closesInMs, isFloorRung, lastChance });
    // Never on a provisional-close load: it decides only at a round's buzzer or above it, and no later
    // read in that round shows more time, so a held shot is the round lost, not a shot sent later.
    const requiredLeadMs = oneway + this.cfg.minLeadMs;
    if (!monitor.provisionalClose && state.closesInMs < requiredLeadMs && !isFloorRung && !lastChance) {
      this.log.debug('holding fire: remaining time does not clear the RTT-compensated lead', {
        auctionId: monitor.auctionId, remainingMs: state.closesInMs, requiredLeadMs });
      return;
    }

    // min decrement: a non-floor step must sit >= minDecrement below our last bid or SP rejects
    // it. Prefer the per-load value (SP Bid Difference varies: 100 and 1500 seen); static cap is
    // the fallback. The floor rung always attempts - and so does the decisive final SNIPE (LM#1): the
    // snipe is the shot we must never silently drop, and _decide already fell it to the floor if its
    // rank-selected rung sat within minDecrement of our last bid, so `!decision.snipe` makes it
    // floor-equivalent for this guard rather than being dropped here.
    const minDec = this._minDecrementFor(monitor, state.minDecrement);
    if (!isFloorRung && !decision.snipe && monitor.lastBidPrice != null && minDec
        && monitor.lastBidPrice - decision.price < minDec) {
      return this._recordRungDiscard(monitor, decision, minDec);
    }

    // STANDING-BID invariant - the belt, covering every decision path _decide's establish branch
    // does not own: _lastResortFloor, the rank-driven snipe, a rehydrate, a scheduled wake.
    //
    // It applies to the floor rung and the decisive snipe, which the decrement rule directly above
    // exempts, and it is deliberately the WEAKER rule so that it can. That exemption exists so a
    // shot we must never SILENTLY DROP is not lost to a rung sitting a little too close to our last
    // price, and this must not undo it - so it holds only what is certain: a price at or above our
    // own standing bid, which improves on nothing and no reverse auction can accept.
    const mustImproveOn = this._mustImproveOn(monitor);
    if (mustImproveOn != null && decision.price > mustImproveOn) {
      this._holdAboveStandingBid(monitor, decision.price, mustImproveOn);
      this._refundReleaseAttempt(monitor, decision); // dropped before the wire: nothing was offered
      return;
    }
    if (monitor._raiseBelow != null && decision.price >= monitor._raiseBelow) {
      if (!(monitor.ladder[monitor.ladder.length - 1] < monitor._raiseBelow)) this._standDownOnRaise(monitor, decision, null, state);
      this._refundReleaseAttempt(monitor, decision); // dropped before the wire: nothing was offered
      return;
    }

    // hard floor invariant — a sub-floor bid can never leave the building.
    // A walk bid at the portal's stated limit sits between the guard and the lowest band price (ruling 30).
    assertAboveFloor(decision.price, decision.walkLimit ? monitor.guard : monitor.floor);

    // fail CLOSED on an unbuilt mechanic — a load carrying a rule flag we have not built for is
    // refused here (BEFORE the write block, so no rung is spent) and surfaced as an alert by
    // _tick's catch, never bid blind. Belt-and-suspenders with the same assert inside
    // buildBidPayload (the adapter boundary). No-op for today's loads (empty requires, flat mode).
    assertRulesSupported(monitor.meta && monitor.meta.rules);
    // fail CLOSED on a transit-required load whose transit days were never captured — bidding it
    // anyway would send transitTime:null, which SuperProcure 400s (proven live on SIKA): a silent
    // miss on live money. Same refuse-BEFORE-the-write-block posture as the guard above; _tick's
    // catch turns the MISSING_TRANSIT_TIME code into its own operator alert. capture() normally
    // makes this unreachable (a transit load cannot be priced without days); it fires for loads
    // armed around that gate, e.g. a request captured before the transit build deployed.
    assertTransitSatisfied(monitor.meta && monitor.meta.rules);

    // never fire while killed or on a retired monitor (belt-and-suspenders; _tick also guards).
    if (this.killed || monitor.finalized) return;

    // SHADOW MODE (L3 D8): soft-close validation WITHOUT money. Record the would-have-done decision
    // (and the snipe timing / extend state R0 validates) and ADVANCE the rung + revision state as if it
    // landed - but place NO bid. Zero wire writes on soft loads. This is the read-only observation harness
    // folded into the always-live engine WITHOUT a global dry-run mode (the removed dry-run/go-live must
    // never return - CLAUDE.local safety item 2): it is gated per-monitor and only on soft-strategy
    // monitors, so a hard-close / soft-off load never reaches it.
    //
    // WHAT SHADOW DOES AND DOES NOT SHOW (blind-rank guard interaction, verified live). Shadow never
    // places a bid, so the socket never self-matches our carrier and myRank stays null for the whole
    // auction. The blind-rank guard in _decide holds every discretionary step-down while rank is unknown,
    // so in shadow the DEFEND rung is never selected and NEVER appears in the observed sequence - only the
    // establish rung (rank-independent) and the final floor snipe (fires on _effectivelyHard, also
    // rank-independent) do. Shadow's value is extend detection + snipe timing, NOT the rank-dependent
    // defend; shadow cannot validate rank-dependent behaviour at all, because acquiring a rank
    // structurally requires having bid. Do NOT read "no defend in the shadow log" as the engine failing
    // to defend live - live acquires a rank ~1.15s after its first bid and defends normally from there.
    if (monitor.softStrategy === 'shadow') {
      const isFloorRung = decision.rungIndex === monitor.ladder.length - 1 || decision.rungIndex === null;
      monitor.lastFireAt = Date.now();
      monitor.bidTimes.push(monitor.lastFireAt);
      this.emit({ type: 'shadow_decision', auctionId: monitor.auctionId, price: decision.price,
        // wouldSnipe = this would-have-done decision is the decisive final-window shot. Keys off the
        // authoritative decision.snipe marker (a rank-aware snipe on a fine ladder is NOT the floor rung,
        // so the old isFloorRung test would miss it); keeps the isFloorRung fallback for the late-arm
        // floor path, which fires the floor in the final window without going through the snipe branch.
        rungIndex: decision.rungIndex, wouldSnipe: !!decision.snipe || (isFloorRung && this._effectivelyHard(monitor)),
        effectivelyHard: this._effectivelyHard(monitor), extendsObserved: monitor.extendsObserved,
        extendCap: monitor.extendCap, believedCloseAt: monitor.believedCloseAt,
        closesInMs: state.closesInMs, revisionsLeft: monitor.revisionsLeft,
        jumpPerRival: this.softCfg.jumpPerRival, // the rank-driven knob in force, for post-hoc shadow analysis

        // R0 (E2e): record the per-load trigger window + whether this would-have-done decision lands
        // inside it, so shadow can validate "a bid inside the window extends" against observed extends.
        ...this._triggerWindowTelemetry(monitor, state.closesInMs),
        lane: monitor.meta.lane, companyName: monitor.meta.companyName });
      // lastBidPrice records the would-have-placed price so the shadow trace has a number.
      // landedBids is DELIBERATELY not incremented here: shadow places nothing, so nothing is on the
      // board. Counting it would render a shadow close as the full LOST receipt with a dangling
      // "Our Final Ranking - -" (shadow never bids, so the socket never self-matches our carrier and
      // rank stays null all auction) - verbatim the desk complaint this participation fact exists to
      // remove - while the funnel, which only ever sees a bid_placed, calls the same close no_bid.
      // A shadow close is a NO-BID close, and both classifiers now say so.
      monitor.lastBidPrice = decision.price;
      if (decision.rungIndex != null) {
        monitor.currentRungIndex = Math.max(monitor.currentRungIndex, decision.rungIndex);
        monitor.firedRungs.add(decision.rungIndex);
      }
      // Advance the rank-driven endgame latches as if the shot landed, so a shadow run single-shots the
      // snipe and paces the defend once-per-round exactly as a live run would. Neither is persisted on
      // the durable intent (a re-arm resets both, which is safe).
      if (decision.snipe) monitor.snipeFired = true;
      if (decision.defend) monitor._lastDefendAtExtend = monitor.extendsObserved;
      if (decision.buzzerShotRoundId != null) monitor._shotRoundId = decision.buzzerShotRoundId;
      if (decision.walk) this._noteWalkFire(monitor, decision);
      if (monitor.revisionsLeft != null) monitor.revisionsLeft -= 1; // would-have-spent a revision
      return;
    }

    // THE REFUSED-PRICE BOUND. The platform has already answered this exact price, more times than
    // cfg.refusedPriceAttempts allows, and nothing about the load has changed since - so this write
    // can only produce the same answer again on a shared live vendor account.
    //
    // WHY A BOUND WAS NEEDED AT ALL, rather than the rung bookkeeping being enough: the nothing-placed
    // restore below un-banks the floor rung on every non-cap refusal, which is correct (a refused bid
    // put nothing on the board, so the decisive shot is still owed) and which reopens the always-floor
    // snipe gate on the next tick. At the floor there is no lower rung to walk to, so the pair is a
    // loop, and its only brake was maxBidsPerMin - a RATE limit, which bounds writes per minute and
    // not writes per auction. 42 identical refused submissions of 38,684 over 304 seconds.
    //
    // Counted per DISTINCT price, so it cannot touch a healthy load: every rung of an ordinary
    // walk-down is a new price and resets the count, an accepted bid resets it, and the count only
    // reaches the bound where the SAME price is refused over and over - which is the wall itself.
    // Placed at the fire point rather than inside the restore so it bounds every path that can reach
    // the wire, the last-resort floor release included, instead of the one that happened to loop.
    //
    // THE BOUND IS THE AUCTION'S, NOT A CONSTANT. It is derived per tick from the attempt budget the
    // platform states for this load - see _refusedPriceBound. On a 3-revision auction it is 1 (a
    // refused price is never re-sent; the ladder advances instead), on a wider one it stays the
    // shipped 3, and where no cap is published it stays 3 as well.
    const refusedBound = this._refusedPriceBound(state, monitor);
    if (monitor._refusedPrice === decision.price
        && monitor._refusedPriceVcq === ((mvPlan && mvPlan.vcq != null) ? mvPlan.vcq : null)
        && monitor._refusedPriceCount >= refusedBound) {
      if (!monitor._refusedPriceHeld) {
        monitor._refusedPriceHeld = true;
        const attemptBudget = this._attemptBudget(state);
        this.log.warn('the platform has refused this exact price its allowed number of times; holding it rather than re-sending', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          refusals: monitor._refusedPriceCount, bound: refusedBound,
          attemptBudget, unrecognised: monitor._refusedPriceUnrecognised === true,
          closesInMs: state.closesInMs });
        // RECORDED, not only logged, because the log line is pm2-only and this fact needs to outlive
        // the process. On the measured population this is the COMMON shape of SuperProcure's
        // monotonicity refusal (126 of 140), so it is the likeliest reason a load closes silent.
        //
        // WHAT THIS BUYS: it sets monitor.noBid, which reaches _refusalAtClose and the outcome event
        // and takes precedence over the shadow_strategy fallback, AND renders on the close-time
        // receipt (waTemplates.js's `refused_price_bound` / `refusal_unrecognised` noBidWhy branches)
        // instead of the generic "a rate was entered but no bid could be placed before close".
        //
        // BOTH REASONS WRITTEN HERE ARE FIRST-WRITER-WINS' DOCUMENTED EXCEPTIONS - see _recordRefusal.
        // They are the two weakest true statements this engine can make ("we hit a repeated wall" and
        // "we could not read the answer"), written as placeholders pending a sharper verdict, so a
        // later DIFFERENT terminal class is allowed to replace either of them. Neither may displace an
        // existing different reason. Written once per run, under the same latch as the log line, so a
        // bounded price cannot rewrite the record every tick.
        //
        // THE DESK-FACING SENTENCE NOW EXISTS. This paragraph used to end by naming its own gap -
        // waTemplates.js had no `refused_price_bound` branch, so the close receipt still rendered the
        // generic "a rate was entered but no bid could be placed before close", which points the desk
        // at a pricing mistake that does not exist. Both branches below are added with this change.
        //
        // TWO REASONS, chosen by whether any classifier could NAME the refusal that built this run.
        // Both stand the price down identically; what differs is what the desk is told and who is
        // paged. A recognised wall is a decision the engine understood, and the close receipt states
        // it. An UNRECOGNISED one is the platform saying something no classifier has seen, and until
        // a human reads it every load hitting that wording is handled by a fail-safe rather than a
        // decision - so it carries the portal's verbatim words on the event, which is what the next
        // classifier gets written from.
        //
        // GATED HERE RATHER THAN AT THE REFUSAL, and the placement is the whole safety of it. Only
        // five refusals have a named regex, because only five needed a non-default response - so the
        // entire healthy price/state population reads as "unrecognised" at the refusal site, and
        // alarming there would page ops on an ordinary walk-down. At the HOLD the load has actually
        // stopped, which is both rare and the moment a human can still act.
        //
        // The numbers ride the record because "why did it stop after one attempt?" is the first
        // question anyone asks of a hold on a tight budget, and none of them is reconstructable later
        // from the bare reason.
        const unrecognised = monitor._refusedPriceUnrecognised === true;
        this._recordRefusal(monitor, unrecognised ? 'refusal_unrecognised' : 'refused_price_bound',
          { price: decision.price, refusals: monitor._refusedPriceCount,
            attemptBudget, bound: refusedBound });
      }
      // LOUD, not a log line: the price-page gate puts a runtime-only refusal in bucket 2, and this hold
      // is exactly that. Both kinds are desk notices to the customer's group (engineAlerts
      // DESK_NOTICE_KINDS) so the desk can bid by hand, once per load per round; neither is an error
      // kind. The WhatsApp line carries the portal's words cut short (`refusal`).
      // A refused rung above the floor stays marked tried, as a live refusal leaves it: a restart restores
      // the refused price but not that mark, and without it the selector re-picks this rung every tick
      // and the lower rungs never go out. The ladder position is NOT advanced - a live refusal rolls it
      // back (the D3 repair below), and advancing it here skips rungs and moves the timing.
      if (decision.rungIndex != null && decision.rungIndex !== monitor.ladder.length - 1) monitor.firedRungs.add(decision.rungIndex);
      // Likewise a held walk step leaves the walk started, as the refused step did when it went out
      // live (_noteWalkFire; the refusal gives back only the price latches). The latch is in memory, so
      // without this a restored hold re-plans the walk and its remaining steps start later than live.
      if (decision.walk && decision.walk !== 'probe') monitor._walkRoundId = decision.walkRoundId;
      // Our bid leading at rank 1: telling the desk to bid by hand would have it undercut our own L1.
      const ourLead = monitor.landedBids > 0 && state.myRank === 1;
      if (monitor._refusedHoldAlertRound !== monitor.extendsObserved && !ourLead && this._nothingSendableBelow(monitor, decision.price)) {
        monitor._refusedHoldAlertRound = monitor.extendsObserved;
        const unrecognised = monitor._refusedPriceUnrecognised === true;
        const attemptBudget = this._attemptBudget(state);
        const refusal = monitor._refusedPriceBody || null;
        this.emit(unrecognised
          ? { type: 'alert', level: 'error', kind: 'refusal_unrecognised', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            price: decision.price, status: monitor._refusedPriceStatus || null,
            body: monitor._refusedPriceBody || null,
            refusals: monitor._refusedPriceCount, bound: refusedBound, attemptBudget,
            closesInMs: state.closesInMs, round: monitor.extendsObserved, refusal,
            landedBids: monitor.landedBids, myRank: state.myRank != null ? state.myRank : null,
            // Bound-aware for the same reason the close receipt is: at a bound of 1 the price went out
            // once and was never re-sent, so "stopped re-sending" describes a repetition that did not
            // happen and misstates how much of the budget this load spent.
            detail: 'the portal refused this bid with a message the bidder does not recognise, so it '
              + (refusedBound > 1 ? 'stopped re-sending' : 'did not send that price again')
              + ' - please check this load on the portal' }
          : { type: 'alert', level: 'warn', kind: 'refused_price_bound', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            price: decision.price, refusals: monitor._refusedPriceCount,
            bound: refusedBound, attemptBudget, closesInMs: state.closesInMs,
            round: monitor.extendsObserved, refusal,
            landedBids: monitor.landedBids, myRank: state.myRank != null ? state.myRank : null });
      }
      this._refundReleaseAttempt(monitor, decision); // held before the wire: nothing was sent (F10)
      return;
    }
    // ONE SNAPSHOT OF EVERYTHING THE FIRE POINT IS ABOUT TO ADVANCE, taken BEFORE the first of those
    // advances and passed WHOLE to the undo - see _captureFirePriors for why it is one object rather
    // than loose consts. Safe to take here because bidInProgress makes this monitor's fire path
    // non-reentrant, so nothing else can move any of these between this line and the restore.
    const _firePriors = this._captureFirePriors(monitor);
    // The five NON-auth restore sites (429, non-cap reject, transport-throw-not-landed, and the two
    // pre-wire arms: COST_TYPE_UNMATCHED and any throw the adapter marks placed:false) restore a
    // strict SUBSET - they must NOT give back ownBidAttempts/everBid/lastFireAt. On the first three
    // the wire genuinely was used and the attempt genuinely happened; on the pre-wire two it was
    // not, and the attempt is held anyway to keep never_bid_before_close firing on the close (see
    // those sites). They read these aliases; only the
    // auth path, where the write provably never reached SuperProcure, restores everything.
    const _priorSnipeFired = _firePriors.snipeFired;
    const _priorLastDefendAtExtend = _firePriors.lastDefendAtExtend;
    const _priorFiredRungs = _firePriors.firedRungs;
    const _priorCurrentRungIndex = _firePriors.currentRungIndex;
    // W1-7 F1: this write is on the wire from here until the finally below, whatever monitor object
    // ends up resolving it (this one, live, or retired) - see _addInFlightPrice / _removeInFlightPrice.
    const _inFlightToken = {};
    this._addInFlightPrice(monitor.auctionId, _inFlightToken, decision.price);
    monitor.bidInProgress = true;
    monitor.lastFireAt = Date.now();
    monitor.bidTimes.push(monitor.lastFireAt);
    // This process is about to use the wire for this load. Counted BEFORE the send, not after the
    // response, because the question ownBidAttempts answers is "could the rank we see plausibly be
    // ours?" - and a bid that was sent and then rejected, or whose transport threw with an uncertain
    // outcome, may still have landed. Counting at the fire point is the fail-closed reading.
    monitor.ownBidAttempts += 1;
    // The FIRE-POINT clear of the auth fact _finalize reads - the second of exactly two, the other
    // being the account-alive branch at the top of this method. Both drop the same pair (this flag
    // and a session_logged_out record) and they are deliberately not merged: this one fires because
    // the wire is about to be used, that one because the account is alive on a tick that may never
    // reach here at all. Neither touches `_authNotice`: that is the retraction debt owed to the desk,
    // it is discharged by _maybeAlertAuthCleared alone, and dropping it at either clear site is what
    // left a desk hand-quoting a load the bot had already resumed bidding.
    //
    // Set FALSE here, before the await, and set true again only by the AUTH
    // rejection arm below or the account gate at the top. So after any accepted / 429 / price-state /
    // not-biddable / cap / transport-throw outcome it is false, and after any auth outcome it is
    // true - "the most recent thing that happened to this load's bidding was the auth wall".
    monitor.authBlockedLast = false;
    // ...and the recorded refusal that went with it. Reaching this line means the account gate at the
    // top of _maybeBid let this tick through, i.e. the session is back and this load is about to bid,
    // so a session_logged_out left over from an earlier tick is now false. Without this the record is
    // STICKY: a load that touched the outage once, recovered, and then closed refused purely on price
    // would report session_logged_out at close and nobody would re-price a load that needed it. Only
    // the auth record is cleared - a terminal price refusal is not this line's to discard.
    if (monitor.noBid && monitor.noBid.reason === 'session_logged_out') monitor.noBid = null;
    // Same fail-closed reading, in the form that survives a re-price. Set in memory here (the wire
    // is about to be used); persisted on the outcome paths below. GoComet additionally journals
    // the exact pending attempt in beforeSubmit, with its storage allowance included in timing.
    monitor.everBid = true;
    // Advance the rank-driven endgame latches OPTIMISTICALLY at the fire point, mirroring bidTimes: the
    // decisive snipe becomes single-shot and the soft defend advances its once-per-round cadence the
    // moment the wire is used. They are HELD only on the outcomes where no retry should happen - a bid
    // that actually LANDED (accepted, or a transport throw that read-back proves committed) or the
    // per-load budget is terminally GONE (a cap rejection). They are RESTORED on every NOTHING-PLACED
    // outcome, so the decisive shot is never abandoned with budget in hand: a transient 429, a NON-CAP
    // rejection (the rung was refused for price/state, nothing stands - the shot must be able to fall to
    // the floor / a fireable rung next tick, not be swallowed), and a transport throw that read-back
    // proves did NOT land. This is what both closes the "lost a winnable auction after a non-cap reject"
    // hole and keeps the coarse always-floor snipe BYTE-IDENTICAL: that snipe's single-shot came from
    // firedRungs, which is likewise advanced only on landed/rejected and left clear on 429/not-landed, so
    // the latches now track it exactly. Neither latch is persisted on the durable intent - a re-arm
    // resets both, which is the safe direction. The three restore sites (429, non-cap reject, not-landed)
    // undo to the priors captured above, the same shape as the bidTimes refund.
    //
    // ...and the LADDER POSITION, carried by that same snapshot and restored at the same site (D3, the cause
    // of the 2026-07-25..28 soft-close retry deadlock - 13 loads, Rs 3,10,000). The rejection branch
    // banks currentRungIndex the moment SP refuses, which is right for a terminal CAP rejection and
    // wrong for every other one: a non-cap refusal put no standing bid on the board, so the ladder
    // never actually advanced. Leaving currentRungIndex advanced permanently closes _decide's
    // `currentRungIndex < 0` ESTABLISH branch, and on a soft load that is terminal - the establish is
    // the one bid allowed to fire without a rank, placing it is precisely how a rank is acquired, and
    // with it gone the blind-rank guard holds every discretionary rung for the rest of the auction on
    // grounds the rejection itself created (23700092: one refused establish at 126.7 s out, then 962
    // blind-rank holds at ~200 ms, then close with zero landed bids on a load the desk had priced).
    //
    // firedRungs rides the same snapshot but is restored ONLY at the floor - see the restore block for
    // why the two markers split, and _captureFirePriors for why it travels as membership rather than
    // as the Set object.
    if (decision.snipe) monitor.snipeFired = true;
    if (decision.defend) monitor._lastDefendAtExtend = monitor.extendsObserved;
    if (decision.buzzerShotRoundId != null) monitor._shotRoundId = decision.buzzerShotRoundId;
    if (decision.walk) this._noteWalkFire(monitor, decision);
    // ONE snapshot of the engine's extension/budget belief, taken at the moment of the decision and
    // reused on BOTH outcome paths, so accepted and rejected records carry the same semantics: what
    // the engine believed WHEN IT FIRED. Taking it here rather than at each emit matters twice over.
    // On the accepted path monitor.revisionsLeft is decremented before the emit; on the rejected
    // path the cap-exhaustion handling below drives it to 0 - reading it at emit time would report
    // the consequence of the bid instead of the belief that authorised it, and on a cap rejection it
    // would report "0 left" for a bid the engine fired precisely because it thought it had budget,
    // erasing the disagreement between our belief and SP's counter that this capture exists to
    // measure. Pure in-memory field reads: no I/O, nothing new computed, nothing added to the
    // latency of the wire-send that follows.
    const budgetCtx = this._budgetContext(monitor);
    let decidedAt = null;
    let gcAttempt = null;
    try {
      // Layer B: on a genuine FTL multi-vehicle load with the count fix enabled, send vcq = the
      // required truck count. Every other load passes NO vcq, so the adapter's proven `vcq:-1`
      // sentinel goes out byte-identically to today (single-vehicle FTL and PMT wire unchanged).
      // Also hand down this load's LoadRules + operating floor (the buildBidPayload seam + floor belt);
      // LoadRules keys are DISTINCT from the createV2 wire keys, so they change no wire value today.
      const bidOpts = Object.assign(this._bidOpts(monitor), (mvPlan && mvPlan.vcq != null) ? { vcq: mvPlan.vcq } : {});
      if (this.caps.durableSubmissionTracking) {
        bidOpts.unconfirmedSubmission = monitor.pendingGcSubmission;
        bidOpts.beforeSubmit = evidence => {
          if (monitor.finalized || this.killed || this.monitors.get(monitor.auctionId) !== monitor) {
            const err = new Error('Load stopped before submit'); err.code = 'WRITE_DISABLED'; throw err;
          }
          gcAttempt = { ...evidence, attemptId: randomUUID(), decidedAt, rungIndex: decision.rungIndex,
            priorLandedBids: Number((this.scheduler.get(monitor.auctionId) || {}).landedBids) || 0, outcome: 'pending' };
          try {
            if (!this.scheduler.update(monitor.auctionId, { pendingGcSubmission: gcAttempt, everBid: true })) throw new Error('Missing durable intent');
          } catch (err) { monitor._gcPersistenceBlocked = true; err.code = 'SUBMIT_RECORD_FAILED'; throw err; }
          monitor.pendingGcSubmission = gcAttempt;
          if (!this._gcActiveAttempts) this._gcActiveAttempts = new Set();
          this._gcActiveAttempts.add(gcAttempt.attemptId);
        };
      }
      if (decision.walkLimit) bidOpts.floor = monitor.guard;
      decidedAt = Date.now();
      const res = await this.adapter.placeBid(monitor.auctionId, decision.price, bidOpts);
      if (gcAttempt) {
        res.gcAttemptId = gcAttempt.attemptId;
        if (res.submissionOutcome === 'unconfirmed') {
          this._recordGcUnconfirmed(monitor, gcAttempt, res);
          return;
        }
        try {
          const current = this.scheduler.get(monitor.auctionId);
          if (!res.accepted && current && current.pendingGcSubmission && current.pendingGcSubmission.attemptId === gcAttempt.attemptId) {
            this.scheduler.update(monitor.auctionId, { pendingGcSubmission: bidOpts.unconfirmedSubmission || null });
            monitor.pendingGcSubmission = bidOpts.unconfirmedSubmission || null;
            monitor.gcAccountPosition = null;
          }
        } catch (err) { monitor._gcPersistenceBlocked = true; }
      }
      // The moment the submit response returned and, on acceptance, is trusted as landed (P6
      // writeLandedAt) - taken here, once, for both the accepted-and-live and accepted-but-retired
      // branches below, rather than separately at each emit, so neither can drift from the other.
      const writeLandedAt = Date.now();
      // The auction may have finalized (close) or been stopped/killed while this write was
      // in flight. Don't mutate a retired monitor or resurrect its intent on a late resolve.
      if (monitor.finalized || this.killed) {
        // ...except the facts about a bid that DID land. stop() never consults bidInProgress, so a
        // re-price (stop + armFromRequest) resolving into this window used to discard the accept
        // whole: nothing persisted, and every later guard then judged the new ladder against a board
        // it believed was empty.
        //
        // The transport-throw handler below routes its own uncertain-but-counted write through the
        // same banker for the same reason, so the two paths cannot disagree about what a late
        // resolve does to the durable record.
        if (res.accepted) this._recordLandedAfterRetire(monitor, decision, res, decidedAt, writeLandedAt);
        else this._recordRefusedAfterRetire(monitor, decision, res, state, bidOpts, _inFlightToken);
        return;
      }
      if (res.accepted) {
        const landedVsCloseMs = this._landedVsCloseMs(monitor, state, budgetCtx, writeLandedAt);
        if (landedVsCloseMs != null && !(monitor._latestAcceptedVsCloseMs >= landedVsCloseMs)) {
          monitor._latestAcceptedVsCloseMs = landedVsCloseMs;
        }
        monitor.myRank = res.myRank;
        // authoritative remaining if the response carries one; else a bid spends one.
        if (res.revisionsLeft != null) monitor.revisionsLeft = res.revisionsLeft;
        else if (monitor.revisionsLeft != null) monitor.revisionsLeft -= 1;
        // Same lowest-wins rule the retired-monitor writer applies, and for the same reason: two
        // writes for one load can be on the wire across a re-price, and whichever resolves LAST is
        // not necessarily the one the board holds. Reading the intent here is what makes this
        // monitor's own write compose with a sibling's instead of overwriting it.
        const standing = lowestStandingPrice((this.scheduler.get(monitor.auctionId) || {}).landedBidPrice, decision.price);
        if (monitor.lastBidPrice == null || monitor.lastBidPrice > standing) monitor.lastBidPrice = standing;
        monitor.landedBids += 1; // ON THE BOARD - the same event that makes bidLogger append to ourBids
        monitor._lastLanded = {
          closeAt: budgetCtx.believedCloseAt,
          extendsObserved: budgetCtx.extendsObserved,
          roundId: this.roundVerdict(monitor).roundId,
          shotRoundId: decision.buzzerShotRoundId || decision.provisionalRoundId || null,
          landingMs: bidGapsMs({ closesInMs: state.closesInMs, decidedAt, ts: Date.now() }).landingMs,
          triggerWindowMs: monitor.triggerWindowMs,
          incrementMs: extendIncrementMs(state),
          countdownMs: state.closesInMs,
          heldRank1: res.myRank === 1,
        };
        if (decision.provisionalRoundId != null) monitor._shotRoundId = decision.provisionalRoundId;
        monitor._lastLandedAt = Date.now();
        monitor._lastLandedRank = res.myRank != null ? res.myRank : null;
        if (decision.probe) this._observeOwnWrite(monitor, state, res, decidedAt, writeLandedAt, decision.walkRoundId);
        // The platform just took a bid on this load, so no price is standing refused any more. Same
        // discipline as the quantity stand-down's clear below: a bound left engaged behind a verdict
        // the platform has itself contradicted freezes the ladder on a load that is bidding fine.
        monitor._refusedPrice = null;
        monitor._refusedPriceVcq = null;
        monitor._refusedPriceCount = 0;
        monitor._refusedPriceHeld = false;
        // The rung the platform just took is SPENT, whatever it said about an earlier attempt at it.
        // Held out of this set so the accept below persists it as offered, rather than withholding a
        // rung that is now on the board and letting a restart re-offer it.
        monitor._relearnedRungs.clear();
        if (decision.rungIndex != null) {
          monitor.currentRungIndex = Math.max(monitor.currentRungIndex, decision.rungIndex);
          monitor.firedRungs.add(decision.rungIndex);
        }
        // The probe rides this write (no extra write on the money path), so a restart inside its
        // observe window resolves it from disk.
        const roundPatch = roundTracker.isDirty(monitor._round) ? { round: roundTracker.durable(monitor._round) } : {};
        // Wrapped because this try's catch is the uncertain-outcome handler: a disk fault here would
        // be read as a failed submit and the same accepted bid booked a second time.
        try {
          this.scheduler.update(monitor.auctionId, {
            ...roundPatch,
            status: 'bidding', firedRungs: [...monitor.firedRungs], revisionsLeft: monitor.revisionsLeft,
            everBid: true, foreignSlotUncounted: !!monitor.foreignSlotUncounted,
            // The participation fact goes to disk on the SAME write that already persists the accept,
            // so a restart mid-auction rehydrates a monitor that knows this bid is on the board. No
            // extra disk write is added on the money path - this update already ran.
            landedBids: monitor.landedBids,
            landedBidPrice: standing, // the standing price a later re-arm has to bid below
            ...(gcAttempt ? { pendingGcSubmission: null } : {}),
            // Same write, same reason: this is what stops a restart re-opening the early ladder walk
            // on a re-priced load whose establish was released outside the closing window.
            establishedBeforeWindow: !!monitor.establishedBeforeWindow,
            // The cleared refused-price run, on the write that already runs - a bound left engaged on
            // disk behind a verdict the platform has just contradicted would freeze the ladder after a
            // restart on a load that is bidding fine.
            refusalState: this._refusalStateOf(monitor, monitor.firedRungs),
            // Same write: without it a restart or re-price cannot tell a known close from an unknown one.
            lastLanded: durableLastLanded(monitor._lastLanded),
          });
          if (roundPatch.round) roundTracker.markClean(monitor._round);
          if (gcAttempt) this._clearGcPending(monitor, gcAttempt.attemptId);
        } catch (persistErr) {
          this._recordWriteFailed(monitor, 'bid_record_failed',
            'Our latest bid on this load was accepted by the portal but could not be saved to our records. Please check this load on the portal.',
            persistErr, { price: decision.price, rungIndex: decision.rungIndex });
        }
        this.log.debug('placeBid accepted', { auctionId: monitor.auctionId, price: decision.price,
          rungIndex: decision.rungIndex, rank: res.myRank, revisionsLeft: res.revisionsLeft });
        // The entered rate + the band's opening margin travel onto the event so the bid_live alert
        // can frame the first bid against the operator's own number ("First bid X - your rate Y +
        // Z%"). Both come off the durable intent's pricing (band model only); a rate-model / mock
        // arm carries neither, leaving them null so the alert keeps its rate-agnostic copy.
        const pricing = monitor.intent || {};
        const bandMargins = Array.isArray(pricing.marginsPct) ? pricing.marginsPct.map(Number).filter(Number.isFinite) : [];
        this.emit({ type: 'bid_placed', auctionId: monitor.auctionId, price: decision.price,
          ...(decision.walk ? { walk: decision.walk } : {}),
          rungIndex: decision.rungIndex, rank: res.myRank, revisionsLeft: res.revisionsLeft,
          // A1 (capture-only): the REST createV2 `rank` (res.myRank) is null on every SP response,
          // so `rank` above stays null (left untouched for byte-compat). Stamp the LIVE SOCKET rank
          // as a NEW field alongside it: state.myRank is this tick's socket read, the rank we held
          // WHEN we fired (monitor.myRank was just overwritten with the null REST rank above, so it
          // is not the value to use here). Additive - our own rank, inside the legal wall.
          socketRank: state.myRank != null && !state.rankFromRest ? state.myRank : null,
          ...(state.rankFromRest ? { restRank: state.myRank } : {}),
          closesInMs: state.closesInMs, decidedAt, writeLandedAt, latencyMs: res.latencyMs,
          ...(landedVsCloseMs != null ? { landedVsCloseMs, closeSnapped: state.closeSnapped === true,
            submitStartVsCloseMs: Number.isFinite(res.submitStartedAt)
              ? landedVsCloseMs - (writeLandedAt - res.submitStartedAt) : null } : {}),
          lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          // ROUTING key, alongside companyName: a branch-scoped WhatsApp group matches on the branch
          // label and treats an ABSENT one as no-match, so without this the bid_live alert resolves
          // to the customer's general group - away from the ask thread it must edit - and is skipped.
          branchName: monitor.meta.branchName || null,
          cost: pricing.cost != null ? pricing.cost : null,
          // The operating floor that authorised THIS price, carried so a receipt judging the bid
          // against its bid-time cost judges it against the bid-time floor too. Both come off the
          // same intent, so they can never describe different re-prices.
          minMarginPct: pricing.minMarginPct != null ? pricing.minMarginPct : null,
          // The desk's rate PER TRUCK TYPE, where it gave one. `cost` above is the blended mean the
          // ladder was built from, and the alert that renders it calls it "your rate" - a number
          // nobody typed on a multi-type load (CW-213). Read off meta.rules, which round-trips on the
          // durable intent, so a scheduled wake or a post-restart re-arm carries it too. Null on every
          // single-type load, which is what keeps those payloads byte-identical.
          costByType: (monitor.meta.rules && monitor.meta.rules.costByType) || null,
          openingPct: bandMargins.length ? Math.max(...bandMargins) : null,
          // The lowest band margin, so a won receipt judges a thin win against the lowest bid
          // this load's plan allowed rather than against the minimum, which is never bid.
          lowestPct: bandMargins.length ? Math.min(...bandMargins) : null,
          // Soft-close / budget context as believed at fire time (see _budgetContext). Additive
          // fields on an existing event: every current consumer reads by name, so nothing that
          // renders or persists a bid_placed today sees any change.
          ...budgetCtx });
        this._armRankWatch(monitor, decidedAt, decision.price);
        this._askLiveRank(monitor, state, decision.price);
        this._followOwnBid(monitor);
        this._takeResponseRank(monitor, state, res, writeLandedAt);
        // Which wire branch buildBidPayload took for THIS bid. Read off the opts we actually handed
        // placeBid (not the monitor's rules), so it can never disagree with the branch that ran.
        // Hoisted above the vehicle-count oracle because BOTH read-back belts below are mode-aware.
        const sentPerTonne = !!(bidOpts && bidOpts.pricingMode === 'per_tonne');
        // READ-BACK ORACLE (the missing allotment detector). SuperProcure echoes the vehicle count
        // it actually RECORDED as `bidVehicleCount`. Compare it to what we EXPECT recorded - and
        // what that is depends on the branch, because the two branches mean different things by -1:
        //
        //   FLAT     we send vcq:-1 as a sentinel SP normalizes to 1 on a single-vehicle bid, so we
        //            expect 1; on a Layer-B multi-vehicle bid we send vcq:N and expect N. A mismatch
        //            means SP did NOT record our count - it kept -1 on a multi-vehicle load (the
        //            invisible 23167278 "-1 vehicles" failure), or Layer B's vcq:N did not take.
        //   PER-TONNE we send NO count at all. vcq:-1 on a PMT load is not "one vehicle": the
        //            2026-08-05 capture (load 23828313) sent -1 and SP recorded bidVehicleCount 2,
        //            derived from the load. Expecting 1 here is simply wrong, and it fires on every
        //            correct multi-truck PMT bid - a false page on live money, on the exact class
        //            (3 of 5 live Vishal Pipes PMT loads) this build is meant to start bidding.
        //            What we expect instead is rules.pmtVehicleCount, the truck count the price page
        //            told the desk this bid commits to. When that is null SuperProcure's own figures
        //            never settled the count, there is nothing to compare against, and the check is
        //            SKIPPED rather than guessed - a substituted 1 is how this defect arose. What is
        //            NOT skipped is the structural arm below: a recorded count under 1 is invalid
        //            against every expectation, so it pages whether or not we could derive one.
        // Gated on a non-null read-back too, so the mock adapter (no bidVehicleCount) and rejected
        // bids never trip it. One alert per load.
        const sentVcq = (bidOpts && bidOpts.vcq != null) ? bidOpts.vcq : -1;
        const pmtTrucks = (bidOpts && Number.isInteger(bidOpts.pmtVehicleCount) && bidOpts.pmtVehicleCount > 0)
          ? bidOpts.pmtVehicleCount : null;
        const expectedCount = sentPerTonne ? pmtTrucks : (sentVcq === -1 ? 1 : sentVcq);
        // THE UNCONDITIONAL ARM, and the reason the `expectedCount != null` skip below is safe.
        // "We cannot derive the expected count" is NOT the same claim as "there is nothing worth
        // checking", and collapsing the two is how the previous version of this belt went dark.
        // A recorded count below 1 - the invisible 23167278 "-1 vehicles" failure this whole oracle
        // was built for, or a 0 - is invalid against EVERY possible expectation, so it needs no
        // expectation to judge it. Negated (`!(n >= 1)`) so a present-but-unparseable count is NaN
        // and still trips, matching the fail-closed polarity of the rate oracle below.
        // Deliberately still gated on a non-null read-back, so the mock adapter and rejected bids
        // stay silent, and it shares the one-shot latch so a load pages once, not per 200ms tick.
        const recordedCount = res.bidVehicleCount != null ? Number(res.bidVehicleCount) : null;
        const countStructurallyInvalid = recordedCount != null && !(recordedCount >= 1);
        if (countStructurallyInvalid && !monitor._countMismatchAlerted) {
          monitor._countMismatchAlerted = true;
          this.log.error('vehicle-count read-back invalid: SuperProcure recorded a count no bid can be allotted against', {
            auctionId: monitor.auctionId, sentVcq, sentPerTonne, expectedCount, recorded: res.bidVehicleCount,
            requiredUnits: monitor.meta && monitor.meta.units });
          this.emit({ type: 'alert', level: 'error', kind: 'vehicle_count_mismatch', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName, units: monitor.meta.units,
            detail: `SuperProcure recorded ${res.bidVehicleCount} vehicle(s) against this bid, which is not a count it can be`
              + ' allotted against - the bid will not convert; check this load on SuperProcure' });
        } else if (expectedCount != null && res.bidVehicleCount != null
            && Number(res.bidVehicleCount) !== expectedCount && !monitor._countMismatchAlerted) {
          monitor._countMismatchAlerted = true;
          this.log.error('vehicle-count read-back mismatch: SuperProcure recorded a different count than we bid for', {
            auctionId: monitor.auctionId, sentVcq, sentPerTonne, expectedCount, recorded: res.bidVehicleCount,
            requiredUnits: monitor.meta && monitor.meta.units });
          this.emit({ type: 'alert', level: 'error', kind: 'vehicle_count_mismatch', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName, units: monitor.meta.units,
            // Per-tonne wording differs because the failure differs: we did not "bid for" a count
            // there, we were TOLD one by the load and SuperProcure used another - which means the
            // truck commitment on the pricing page was wrong, not that the bid is unallottable.
            detail: sentPerTonne
              ? `SuperProcure recorded ${res.bidVehicleCount} truck(s) on this per-tonne bid, but this load's own figures said ${expectedCount}`
                + ' - the truck commitment shown on the pricing page was wrong; check this load on SuperProcure'
              : `SuperProcure recorded ${res.bidVehicleCount} vehicle(s), but we bid for ${expectedCount}${monitor.meta && monitor.meta.units ? ` (load needs ${monitor.meta.units})` : ''} - the bid may not be allottable; check this load on SuperProcure` });
        }
        // AN UNRUNNABLE CHECK MUST NOT LOOK LIKE A PASSING ONE. When the count is plausible but we
        // have no expectation to judge it against, the comparison above is skipped - correctly, a
        // substituted 1 is the defect this replaces - but silence then means two different things.
        // Say which one it is, ONCE per load.
        //
        // The main way to land here is a LoadRules snapshot that predates this build: the persisted
        // intent carries `units` but never `weight` (see _intentToArm), so pmtVehicleCount cannot be
        // re-derived from a snapshot at all - reconcilePricingMode heals the pricingMode and cannot
        // heal this. That is a real transitional gap and this line is what makes it observable.
        //
        // A LOG LINE, deliberately not an alert kind: nothing here is wrong with the bid, and a new
        // alert kind would route to the WhatsApp groups on a live-money path for a diagnostic. The
        // structural arm above still pages if the recorded count is actually invalid.
        // Suppressed when the structural arm already paged: "we could not check this" beside "this
        // count is invalid" is two contradictory statements about one bid in the same log.
        if (sentPerTonne && expectedCount == null && recordedCount != null
            && !countStructurallyInvalid && !monitor._countUncheckedLogged) {
          monitor._countUncheckedLogged = true;
          this.log.warn('per-tonne vehicle-count read-back NOT checked: this load\'s own figures never settled a truck count', {
            auctionId: monitor.auctionId, recorded: res.bidVehicleCount,
            pmtVehicleCount: bidOpts ? bidOpts.pmtVehicleCount : undefined,
            requiredUnits: monitor.meta && monitor.meta.units });
        }
        // SuperProcure just took a count on this load, so no count is refused any more. Without the
        // clear the stand-down gate freezes the ladder behind a verdict the platform itself has
        // contradicted, and the bid that cleared it becomes the last bid of the auction.
        monitor.quantityRefused = false;
        monitor.quantityRefusedAtVcq = null;
        this._maybeAlertVcqClamp(monitor, mvPlan);
        // PER-TONNE READ-BACK ORACLE - the same belt as vehicle_count_mismatch above, for the other
        // thing a per-tonne bid depends on: did our per-MT RATE land verbatim?
        //
        // Under the settled wire contract (_research/2026-08-05_pmt-createv2-capture-SETTLED.md) we
        // send the bare per-MT rate as `amount`, and SuperProcure echoes that exact number back on
        // BOTH `amountPMT` and `bidRate` while storing its own multiplied figure on `amount`
        // (captured: sent 2240 -> amountPMT 2240, bidRate 2240, amount 33600, bidQuantity 30). So the
        // check is an identity, not an arithmetic reconstruction: the number we put on the wire must
        // come back unchanged. Both echo fields are compared, independently - either one diverging
        // means SP did not take our rate as given, whatever the reason, and that is exactly what we
        // want paged. bidQuantity is NOT part of the verdict any more (it is SP's own per-load
        // quantity, nothing we send); it rides along in the alert as context for the human.
        //
        // THIS BELT WOULD HAVE CAUGHT #88. Know that before trimming it.
        // #88 sent amount = rate x pmtQuantity. SuperProcure does NOT derive the echo by dividing -
        // it hands our number straight back (the "SP divides the echo" reading is the one the capture
        // refuted) - so it would have echoed rate x pmtQuantity against a rung of rate: a divergence
        // of rate x (pmtQuantity - 1), which on the evidence doc's 22 MT example is 2240 x 21 =
        // 47,040 rupees against a 1-rupee tolerance. Robust to the one thing the capture cannot
        // distinguish, too: if the echo is instead stored/perVehicleTonnage, that is
        // (rate x qty x T)/T = rate x qty, the identical divergence. Silence would need a divisor of
        // qty x T, a number on no field, which SP cannot construct because it never knew we
        // multiplied. The oracle never fired for one reason only - SP_PMT_BID has never been set, so
        // the bot has never placed a PMT bid at all. It was UNEXERCISED, not blind.
        // Pinned by scripts/test-pmt-amount-readback.js, which replays #88's echo and asserts it trips.
        //
        // What it is NOT: a pre-send check. It reads back AFTER the money moved, once per load, so it
        // catches a wrong wire on the first bid rather than preventing that bid. It detects SP-side
        // divergence from what we sent; it is not a substitute for having observed the wire.
        //
        // STRICTLY per-tonne: SP returns amountPMT on FLAT bids too (SIKA is an FTL load and still
        // returned 3828), where it is a whole-load rate divided by a quantity and bears no relation
        // to the per-truck amount we bid - so running this unconditionally would false-alarm on every
        // single FTL bid. Gated on the pricingMode we actually SENT, not on the monitor's rules, so
        // it can never disagree with the branch buildBidPayload took. Gated on a non-null read-back
        // as well, so a mock adapter or an older response shape never trips it. One alert per load.
        // Compared against Math.round(decision.price) - byte-for-byte the `amount` buildBidPayload
        // put on the wire - with a 1-rupee tolerance for any formatting slack in SP's echo.
        // ALERT-ONLY, one-shot per load: it never throws, never kills, never spends or holds a rung.
        const sentAmount = Math.round(decision.price); // the exact wire `amount` for this rung
        // WHAT SUPERPROCURE ACTUALLY MULTIPLIED BY: bidQuantity / bidVehicleCount, the PER-VEHICLE
        // tonnage - NOT bidQuantity, which is the load TOTAL. The capture is unambiguous
        // (_research/2026-08-05_pmt-createv2-capture-SETTLED.md): amount 33600 = 2240 x 15, where
        // 15 = bidQuantity 30 / bidVehicleCount 2. The two coincide only on a one-truck load, so
        // naming bidQuantity in the alert is a factor-of-vehicleCount lie on exactly the multi-truck
        // loads this build starts bidding - and this alert exists to be reconciled by hand against
        // SuperProcure's screen, so a wrong multiplier in it sends the operator to the wrong answer.
        // Null when either field is missing or the count is unusable; the alert then names only what
        // it can prove rather than dividing by an assumed 1.
        const perVehicleMt = (res.bidQuantity != null && res.bidVehicleCount != null
          && Number.isFinite(Number(res.bidQuantity)) && Number(res.bidVehicleCount) > 0)
          ? (Number(res.bidQuantity) / Number(res.bidVehicleCount)) : null;
        // Displayed to 3dp. Every observed split divides exactly (30/2 = 15, 20/2 = 10), but this is
        // float division on numbers SuperProcure chooses, and "4.285714285714286 MT per truck" in a
        // WhatsApp alert is noise a human has to parse past. The raw value stays on the log line.
        const perVehicleMtStr = perVehicleMt != null ? String(Math.round(perVehicleMt * 1000) / 1000) : null;
        // Built only on the per-tonne path, so a flat bid does no extra work on the money path.
        //
        // THE COMPARISON IS NEGATED ON PURPOSE - `!(diff <= 1)`, never `diff > 1`. The adapter
        // coerces with a bare `Number(d.amountPMT)` (realAdapter's read-back block), which yields
        // NaN, not null, for a field that is PRESENT but unparseable. NaN clears the `!= null` gate,
        // and `Math.abs(NaN) > 1` is FALSE - so the positive form reads a value we cannot interpret
        // as AGREEING with us and the oracle goes silent on every bid of that response shape. The
        // negated form puts NaN in `echoes` and pages, because `NaN <= 1` is false.
        // Not hypothetical: SuperProcure ships numeric fields as formatted strings elsewhere
        // (ceilingPrice arrives as "90000.00") and ships "-" as a placeholder on adjacent numeric
        // wire fields. This is the same fail-closed idiom assertBelowCeiling documents in
        // src/engine/pricing.js, and the same polarity the vehicle-count oracle above gets from
        // `!==`. Do not "simplify" it back to `> 1`.
        const echoes = sentPerTonne
          ? [['amountPMT', res.amountPMT], ['bidRate', res.bidRate]]
            .filter(([, v]) => v != null && !(Math.abs(Number(v) - sentAmount) <= 1))
          : [];
        if (echoes.length && !monitor._pmtAmountMismatchAlerted) {
          monitor._pmtAmountMismatchAlerted = true;
          // The raw value when it will not parse, so an unreadable echo reads as itself in the alert
          // ("SuperProcure recorded Rs - /MT") instead of the "Rs NaN/MT" a bare Number() would print.
          const recordedNum = Number(echoes[0][1]);
          const recorded = Number.isFinite(recordedNum) ? recordedNum : String(echoes[0][1]);
          this.log.error('per-tonne read-back mismatch: SuperProcure echoed a different per-MT rate than we sent', {
            auctionId: monitor.auctionId, sentPerMt: sentAmount, rungPrice: decision.price,
            divergedFields: echoes.map(([k]) => k), amountPMT: res.amountPMT, bidRate: res.bidRate,
            // recordedQuantity is SP's LOAD TOTAL; perVehicleMt is the number it actually multiplied
            // by. Both are logged because reconciling the stored `amount` needs the count as well.
            recordedQuantity: res.bidQuantity, recordedVehicleCount: res.bidVehicleCount, perVehicleMt });
          this.emit({ type: 'alert', level: 'error', kind: 'pmt_amount_mismatch', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            detail: `SuperProcure recorded Rs ${recorded}/MT, but we bid Rs ${sentAmount}/MT`
              + (perVehicleMt != null
                ? ` (SuperProcure charged on ${perVehicleMtStr} MT per truck - ${res.bidQuantity} MT across ${res.bidVehicleCount} truck(s))`
                : (res.bidQuantity != null ? ` (SuperProcure states ${res.bidQuantity} MT for the whole load)` : ''))
              + ' - our rate did not land as sent; check this load on SuperProcure' });
        }
        // THE NEVER-FORFEIT NOTICE, emitted HERE and only here. It tells the desk "we sent our lowest
        // price", which is a money claim, so it may only be made where money actually moved: on an
        // ACCEPTED response, on the live path. It used to be emitted at DECISION time inside
        // _lastResortFloor, which put it one branch upstream of both places the bid can fail to
        // happen - shadow mode (contract: zero wire writes) sent the desk "Lowest price sent -
        // nothing left in reserve, Rs 74,410" against placeBid calls: 0, and a live bid the platform
        // then refused made the same claim. Every other money claim in this engine emits at the fire
        // point; this one now does too. Shadow needs no explicit suppression any more - the shadow
        // branch returns long before this line - which is the point of moving it rather than adding
        // a mode check to the old site.
        if (decision.lastResort || decision.floorFollowUp) {
          this.log.warn(decision.lastResort
            ? 'last-resort floor: a soft-close hold would have forfeited this load on the final tick'
            : 'follow-up floor: still outranked after a non-floor final shot, with budget left (ruling F2)', {
            auctionId: monitor.auctionId, remainingMs: state.closesInMs, myRank: state.myRank,
            price: decision.price, rungIndex: decision.rungIndex, rank: res.myRank,
            extendsObserved: monitor.extendsObserved, extendCap: monitor.extendCap,
            ...this._triggerWindowTelemetry(monitor, state.closesInMs) });
          // Ruling 62: a landed follow-up floor (ruling F2's _softFloorAfterFinalShot) is the same
          // fact as a last-resort floor - our lowest price, just spent, nothing more goes out - so it
          // gets the same desk notice. W1-9's refund already treats the two markers alike
          // (`lastResort || floorFollowUp`); this notice was the one consumer that did not.
          this.emit({ type: 'alert', level: 'warn', kind: 'last_resort_floor_fired', auctionId: monitor.auctionId,
            // THE RANK THE BID EARNED, not the one it was decided from. res.myRank is the platform's
            // answer to the write that just landed; state.myRank is the read that preceded it and is
            // by definition one bid out of date on the only bid this notice is about. On 25118167 the
            // response carried 9 and the desk was shown nothing. Falls back to the pre-bid read, then
            // to null - a rank the platform did not send is omitted, never invented.
            remainingMs: state.closesInMs,
            myRank: res.myRank != null ? res.myRank : (state.myRank != null ? state.myRank : null),
            // How many of our bids are on the board INCLUDING this one. The desk's other surface for
            // this load is a growing bid log, and without the count this notice could not be lined up
            // against it - which is exactly how one bid came to read as two conflicting statuses.
            // Incremented on the accepted-bid path above, so it already counts this bid.
            landedBids: monitor.landedBids,
            triggerWindowMs: monitor.triggerWindowMs, extendsObserved: monitor.extendsObserved,
            extendCap: monitor.extendCap,
            // The price that actually WENT, on the field the desk-notice template reads for money.
            // decision.price, not ladder[last]: the two agree today, and reading the value we sent is
            // what keeps them unable to disagree. The surface it lands on is a "BRL Bids" group -
            // BRL staff only, already carrying cost, bid and margin per load - so naming the number
            // there is consistent with what the desk already sees, and is what makes it actionable.
            floor: decision.price,
            detail: decision.lastResort
              ? `every soft-close defend path held on the final tick with the floor rung unspent - sent ${decision.price} rather than forfeiting the load`
              : `still outranked after a non-floor final shot with budget left - sent the floor ${decision.price} rather than forfeiting the load`,
            // lane/companyName/branchName are the SCOPE-ROUTING keys the desk-notice channel matches
            // on. Without branchName a branch-split load's notice falls back to the unscoped all-loads
            // recipients instead of the branch group that holds the ask - the same defect the
            // ceiling_below_floor emit fixed when it moved onto this channel.
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null });
        }
        // floor rung spent and still not L1 -> we've done all we profitably can.
        if (decision.rungIndex === monitor.ladder.length - 1 && res.myRank !== 1 && !monitor.stoodDown) {
          monitor.stoodDown = true;
          this.emit({ type: 'alert', level: 'info', kind: 'stood_down_at_floor', auctionId: monitor.auctionId,
            floor: monitor.floor, finalRankSoFar: res.myRank });
        }
      } else if (res.reason === 'rate_limited') {
        // throttled on the write (HTTP 429) -> keep the rung UNSPENT and re-attempt
        // next tick off last-known state. Never consume the ladder on a 429.
        // Refund the runaway-cap slot: a throttled attempt placed nothing, so it must not count
        // toward maxBidsPerMin (else a 429 storm fills the cap and starves the floor snipe).
        monitor.bidTimes.pop();
        // A 429 placed nothing, so the rung is held open for retry - restore the endgame latches to
        // their pre-fire values (same undo as bidTimes.pop above), or a throttled snipe/defend would be
        // wrongly consumed and never retried.
        monitor.snipeFired = _priorSnipeFired;
        monitor._lastDefendAtExtend = _priorLastDefendAtExtend;
        monitor._shotRoundId = _firePriors.shotRoundId;
        this._restoreWalkPriors(monitor, _firePriors);
        this._refundReleaseAttempt(monitor, decision);
        this.log.error('placeBid rate-limited by the platform; rung held open for retry', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          retryAfterMs: res.retryAfterMs });
        this.emit({ type: 'alert', level: 'warn', kind: 'bid_rate_limited', auctionId: monitor.auctionId,
          retryAfterMs: res.retryAfterMs, closesInMs: state.closesInMs });
      } else if (isAuthRejection(res)) {
        // SESSION LOGGED OUT (HTTP 401/403). A SIBLING arm, deliberately - not a branch inside the
        // three-class block below. Both shapes would stop the optimistic bank at the head of that
        // block; this one needs ZERO edits inside it. That block is 360 lines of measured,
        // incident-derived behaviour whose exact ordering its own D3 comment describes, and three
        // test files pin it. A sibling arm cannot perturb it at all, so the diff is provably
        // additive to the code we most want left alone.
        //
        // Nothing was placed and the price was never the problem, so EVERYTHING the fire point spent
        // is given back and the auction is left exactly as _decide would have found it a tick
        // earlier. That is the whole behaviour of this class: the ladder, both endgame latches and
        // the runaway-cap slot all survive, so when the session comes back the decisive shot is
        // still available at the rung the auction actually deserves.
        //
        // Deliberately NOT done here: revisionsLeft is untouched (the per-load budget is intact -
        // zeroing it the way the cap class does would hand a later re-price a phantom exhausted
        // load), no terminal latch is set, and there is no stand-down. Auth is account-wide and
        // TRANSIENT; the account gate at the top of _maybeBid is what stops the other armed loads,
        // and it clears itself the moment the adapter's latch does.
        this._undoAuthRefusedFire(monitor, _firePriors, { graceBand: this._isGraceBandRefusal(res.authReason) });
        this._refundReleaseAttempt(monitor, decision);
        this.log.error('SuperProcure refused the bid because this login is logged out; nothing was placed and the ladder is held', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          status: res.status != null ? res.status : null });
        // The forensic record, same spine as the reject path's. `status` is carried because it is
        // exactly what made 2026-08-04 diagnosable after the fact from bids-2026-08-04.jsonl - the
        // AUTH class must never go dark in the durable log. The listing-trace fields are null: that
        // telemetry lives inside the three-class block and is not reached from here, and it answers
        // a question (is SP still listing this load) that has nothing to do with our session.
        //
        // A per-load desk notice IS raised from here, via _undoAuthRefusedFire -> _markAuthBlocked ->
        // _alertAuthBlocked. The flood this comment used to forbid is bounded three ways: once per
        // load per OUTAGE (keyed on the episode, so a flapping latch cannot re-mint it), never before
        // the adapter has actually latched, and never on a tick that still has a trial write to spend.
        // The volume ceiling is therefore the count of ARMED loads - exactly the set a human now has
        // to bid by hand. The single account_auth_dead message is still separate: raised once by the
        // adapter, edge-triggered on its own latch (src/notify/authAlert.js). Do not merge the two.
        this.emit({ type: 'bid_rejected', auctionId: monitor.auctionId, price: decision.price,
          reason: res.reason, status: res.status != null ? res.status : null,
          body: res.text != null ? res.text : (typeof res.raw === 'string' ? res.raw : null),
          carrierSent: res.carrierSent != null ? res.carrierSent : null,
          rungIndex: decision.rungIndex != null ? decision.rungIndex : null,
          closesInMs: state.closesInMs,
          lastSeenInListAgoMs: null, biddingOn: null,
          ...budgetCtx });
      } else {
        // rejected — react to why. THREE CLASSES, three behaviours (2026-08-01 taxonomy):
        //   CAP ("Bid limit exceeded")           -> terminal for the BUDGET. Bank everything, stop.
        //   LOAD-NOT-BIDDABLE                    -> terminal for the LOAD. Stand down, roll the ladder back.
        //   PRICE/STATE (everything else)        -> this PRICE was refused. Walk the ladder down and retry.
        // Both markers are banked OPTIMISTICALLY here, exactly as the endgame latches are banked at
        // the fire point and for the same reason: at this line we do not yet know which class this
        // refusal belongs to. The nothing-placed restore below un-banks what the class did not spend.
        //
        // The refused-price run is counted alongside them, but on a NARROWER rule than "the wire was
        // used", and the narrowing is the whole safety of the bound.
        //
        // A SERVER FAULT IS NOT A VERDICT, and it is the ONLY thing excluded here. realAdapter.placeBid
        // funnels every non-2xx that is not 401/403/429 into this one branch, so a 5xx arrives looking
        // exactly like a refusal. Counting those would let three transient 502s at one price retire
        // that price for the rest of the auction - measured against origin/main, where the same
        // sequence was followed by the bid LANDING. A bound built to stop the engine arguing with a
        // wall must not stop it recovering from a hiccup.
        //
        // EXCLUDED BY 5xx SPECIFICALLY, not gated on "is a 4xx", and the difference is not pedantry.
        // Both production adapters stamp a status on every rejection envelope, but mockAdapter's does
        // not carry one at all - so a 4xx-only test silently made the bound unobservable in the
        // simulator, where a refusal is a modelled verdict and ought to count. Excluding only what is
        // positively identified as a server fault keeps the live-money behaviour identical and leaves
        // the sim honest.
        //
        // THE RUN IS ALSO KEYED ON THE COUNT, not the price alone. The vcq clamp path deliberately
        // re-sends the SAME price with a corrected vehicle count once SuperProcure's remaining
        // quantity drops, and that is a quote the platform has not ruled on. Keying on the pair means
        // the corrected count starts a fresh run instead of inheriting the refused one's tally.
        //
        // THE SHAPE OF THE REFUSAL IS LATCHED ALONGSIDE THE RUN, because the stand-down that may
        // follow happens at the FIRE point, one tick later, where the rejection envelope no longer
        // exists. The shape decides only what that stand-down is CALLED and whether ops is paged -
        // never how many attempts the price gets (see _refusedPriceBound for why). It rides the run
        // rather than the load, so a refusal at a different price starts a fresh, unprejudiced one.
        if (!(Number.isFinite(res.status) && res.status >= 500)) {
          const vcqSentNow = (bidOpts && bidOpts.vcq != null) ? bidOpts.vcq : null;
          const recognised = isRecognisedRefusal(res);
          if (monitor._refusedPrice === decision.price && monitor._refusedPriceVcq === vcqSentNow) {
            monitor._refusedPriceCount += 1;
          } else {
            monitor._refusedPrice = decision.price;
            monitor._refusedPriceVcq = vcqSentNow;
            monitor._refusedPriceCount = 1;
            monitor._refusedPriceHeld = false;
          }
          monitor._refusedPriceUnrecognised = !recognised;
          // The platform's OWN WORDS, carried forward for the stand-down that may follow. Captured
          // here because this is the only place the rejection envelope exists; read at the hold,
          // which is the one moment the fact is worth a human's attention.
          //
          // NOTHING IS RECORDED OR ALERTED FROM HERE, and that is a hard invariant rather than a
          // stylistic choice. A price/state refusal leaves the load STILL BIDDABLE - the ladder walks
          // down and the next rung may land - so writing monitor.noBid here would put a terminal-
          // sounding cause on a load that goes on to win, and would survive as the close receipt's
          // explanation. Four test files assert exactly this ("a 400 records NO refusal - the load may
          // still be bid"), and they are right. The unmapped remainder earns its alarm at the
          // stand-down, not at the refusal.
          monitor._refusedPriceBody = (typeof res.reason === 'string' && res.reason)
            || (typeof res.text === 'string' && res.text)
            || (typeof res.body === 'string' && res.body)
            || null;
          monitor._refusedPriceStatus = Number.isFinite(res.status) ? res.status : null;
        }
        if (decision.rungIndex != null) monitor.firedRungs.add(decision.rungIndex);
        if (decision.rungIndex != null) monitor.currentRungIndex = Math.max(monitor.currentRungIndex, decision.rungIndex);
        // U1 INSTRUMENTATION, read from the adapter's OWN cache - a Map lookup, no extra request on
        // the money path. The open question is whether SuperProcure DROPPED these loads from its
        // listing or kept listing them as open while refusing every bid, and nothing in the record
        // could answer it: the engine's countdown comes from a loadMeta entry that is written once
        // and never evicted, so a load SP stopped returning keeps a healthy local countdown forever
        // and looks identical to a live one. Carried on EVERY rejection (not just the not-biddable
        // class) so the two populations can be compared against each other. `listingTrace` is a
        // SuperProcure-only capability - the mock, sim and GoComet adapters do not have it - so it
        // is feature-detected and degrades to nulls rather than being assumed.
        //
        // WRAPPED, and the wrap is load-bearing rather than defensive habit. This block sits inside
        // the try{} whose catch is the UNCERTAIN-OUTCOME handler ("adapter.placeBid threw - the
        // write may have COMMITTED"). An adapter whose listingTrace threw would be routed into that
        // handler, which runs the read-back oracle and, failing to disprove a commit, banks the rung
        // and increments landedBids - fabricating a LANDED bid out of a response we are holding and
        // know was REJECTED. Telemetry must never be able to rewrite a money outcome, so a failed
        // trace degrades to nulls exactly like an adapter that has no trace at all.
        let lastSeenInListAgoMs = null;
        let cachedBiddingOn = null;
        try {
          if (this.adapter && typeof this.adapter.listingTrace === 'function') {
            const listing = this.adapter.listingTrace(monitor.auctionId) || null;
            if (listing) {
              if (listing.lastSeenInListAgoMs != null) lastSeenInListAgoMs = listing.lastSeenInListAgoMs;
              if (listing.biddingOn != null) cachedBiddingOn = listing.biddingOn;
            }
          }
        } catch (_) { lastSeenInListAgoMs = null; cachedBiddingOn = null; }
        // A REJECTED bid still used the wire, and SuperProcure may well have counted it against the
        // per-load cap before refusing it - so "we have bid this load" is true here too. Persist it
        // (post-response, off the send path) or a re-price after a rejection would re-open the hole.
        try {
          this.scheduler.update(monitor.auctionId, { everBid: true, foreignSlotUncounted: !!monitor.foreignSlotUncounted });
        } catch (err) {
          this._recordWriteFailed(monitor, 'bid_record_failed',
            'A bid on this load was refused by the portal, and that could not be saved to our records. A restart before it saves could re-send the same bid.',
            err, {});
        }
        this.log.debug('placeBid rejected', { auctionId: monitor.auctionId, price: decision.price,
          rungIndex: decision.rungIndex, reason: res.reason });
        this.emit({ type: 'bid_rejected', auctionId: monitor.auctionId, price: decision.price,
          reason: res.reason, status: res.status != null ? res.status : null,
          // raw platform body (SP rejections are plaintext, carried on res.text) + the carrier
          // we actually sent, so BidLogger can persist a self-documenting rejection record.
          body: res.text != null ? res.text : (typeof res.raw === 'string' ? res.raw : null),
          carrierSent: res.carrierSent != null ? res.carrierSent : null,
          rungIndex: decision.rungIndex != null ? decision.rungIndex : null,
          closesInMs: state.closesInMs,
          // How long ago this load was last seen in a /sp/loads/v4 listing, and the biddingOn that
          // listing carried. Together with the raw `body` above these are what settle U1: a refused
          // load still appearing in fresh listings means SP is listing it as open while refusing it;
          // a listing age that stops advancing means SP dropped it and our cache is the only thing
          // still claiming it is live. null on any adapter without a listing cache.
          lastSeenInListAgoMs, biddingOn: cachedBiddingOn,
          // Same fire-time context the accepted path stamps. This is the half that actually answers
          // the cap-reset question: a rejection carrying "Bid limit exceeded" at extendsObserved N is
          // the negative observation, and an ACCEPTED bid past the static cap at extendsObserved N+1
          // would be the positive one. Neither is reconstructable without both records carrying it.
          ...budgetCtx });
        // FAULT B (Tata 2026-07-21, diagnosis section 4). Before this, the reject branch recorded the
        // fired rung and advanced the ladder but never touched revisionsLeft - so after SuperProcure
        // refused rung 1 for "Bid limit exceeded" the engine still believed it had budget and fired
        // rung 2 into the identical wall 21 seconds later. That second attempt could never have
        // landed: the refusal is the platform stating the per-load budget is GONE, and no ladder
        // position, price, or later moment changes that.
        //
        // Treat it as terminal for this load's budget: drive revisionsLeft to 0 so the existing
        // stand-down guard at the top of _maybeBid stops every subsequent rung, latch capExhausted
        // so no later state read can raise the belief back up (see the fail-closed override in
        // _tick), and alert ONCE carrying the platform's own reason string. The monitor keeps
        // polling and still finalizes normally - this stops SPENDING, it does not stop watching, so
        // the auction_result / rank trail for the load stays complete.
        //
        // Scope is deliberately this load only. A cap is per-load, so nothing here touches any other
        // monitor, and no rung is un-fired: what already went out stays recorded exactly as it was.
        if (!monitor.capExhausted && isBidCapRejection(res)) {
          monitor.capExhausted = true;
          monitor.revisionsLeft = 0;
          monitor._noRevAlerted = true; // this alert supersedes the vaguer no_revisions_left
          const reason = (typeof res.reason === 'string' && res.reason)
            || (typeof res.text === 'string' && res.text)
            || (typeof res.body === 'string' && res.body)
            || 'Bid limit exceeded';
          this.log.error('platform refused the bid for an exceeded per-load bid limit; stopping all further bids on this load', {
            auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
            reason, engineRevisionsLeftAtFire: budgetCtx.engineRevisionsLeft });
          // RECORDED, like the load_not_biddable sibling below and for the identical reason. Without
          // this the close-time receipt's `bid_cap_exhausted` branch was unreachable: monitor.noBid
          // is written only by _recordRefusal, nothing called it with this reason, and the
          // revisionsLeft: 0 driven one line above sends every later tick out through the stand-down
          // guard at the top of _maybeBid before any other _recordRefusal site can run. So the class
          // this change names as fixed still closed with the generic "a rate was entered but no bid
          // could be placed before close" on exactly the shared-account cap-exhaustion loads the
          // branch was written for - the misleading wording load_not_biddable was added to kill.
          //
          // The portal's `reason` string is deliberately NOT put on the facts: this rides all the way
          // onto WhatsApp, and the receipt renders its own plain-English sentence. The raw string is
          // already on the log line and the alert below, which is where an operator reads it.
          this._recordRefusal(monitor, 'bid_cap_exhausted');
          try {
            this.scheduler.update(monitor.auctionId, { revisionsLeft: 0 });
          } catch (err) {
            this._recordWriteFailed(monitor, 'bid_record_failed',
              'This load reached the portal\'s limit on bids, but that could not be saved to our records. A restart before it saves could try to bid again.',
              err, {});
          }
          this.emit({ type: 'alert', level: 'error', kind: 'bid_cap_exhausted', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName, reason });
        }
        // LOAD-NOT-BIDDABLE: SuperProcure is not accepting bids on this load AT ALL. Distinct from the
        // cap above in both cause and consequence - the budget is untouched, there is simply nothing
        // here to bid into - so it gets its own latch, its own alert and its own desk copy rather than
        // being folded into a class it would misdescribe.
        //
        // WHY STANDING DOWN IS THE RIGHT RESPONSE and not a retry: the refusal is a per-load state and
        // a persistent one (isLoadNotBiddableRejection carries the evidence - 14/14 such loads never
        // landed a bid at any point, retries minutes apart refused alike, and no bid from ANYONE ever
        // reached the live feed on them). Retrying cannot win the load; all it can still do is put ~23
        // refused writes on a shared live account instead of 1. `revisionsLeft` is deliberately NOT
        // driven to 0 the way the cap path drives it: the budget genuinely is intact, and zeroing it
        // would hand a later re-price a phantom exhausted load.
        //
        // The refusal is RECORDED (same _recordRefusal spine the ceiling stand-down uses) so the
        // close-time receipt states this reason itself, instead of falling back to the generic "a rate
        // was entered but no bid could be placed before close" - which is not merely vague here, it is
        // actively misleading: it sends the desk to hunt a pricing mistake that does not exist.
        if (!monitor.loadNotBiddable && isLoadNotBiddableRejection(res)) {
          monitor.loadNotBiddable = true;
          if (decision.rungIndex != null) monitor._relearnedRungs.add(decision.rungIndex);
          this._recordRefusal(monitor, 'load_not_biddable');
          // THE LIVE LISTING PROBE - one extra read, on this path only, and it is what settles U1.
          // The cached age above discriminates only at discovery-interval granularity (~30s) and
          // answers "when did we last see it", not "is it there now". Re-running the listing answers
          // the question outright: still listed with biddingOn 1 means SuperProcure is listing the
          // load as open and refusing bids on it anyway (a vendor question); absent from the listing
          // means SP delisted it and our never-evicted loadMeta entry is the only thing still
          // claiming it is live (cache invalidation is then ours to build).
          //
          // Only here. This load is being stood down permanently, so nothing is waiting on the read -
          // no bid in flight, no countdown being raced. It is deliberately NOT on the ordinary
          // price-class rejection path, which retries and does have a clock to beat.
          //
          // Wrapped, and the wrap is load-bearing exactly as it is for listingTrace above: this block
          // sits inside the try{} whose catch is the UNCERTAIN-OUTCOME handler, which runs the
          // read-back oracle and, failing to disprove a commit, banks the rung and increments
          // landedBids. A throwing probe would fabricate a LANDED bid out of a response we are
          // holding and know was REJECTED. Telemetry must never rewrite a money outcome.
          let probe = null;
          try {
            if (this.adapter && typeof this.adapter.listingProbe === 'function') {
              probe = await this.adapter.listingProbe(monitor.auctionId);
            }
          } catch (_) { probe = null; }
          // The monitor may have finalized while that read was in flight; do not resurrect it.
          if (monitor.finalized || this.killed) return;
          this.log.error('platform refused the bid because the load is not open to bidding; standing down on this load', {
            auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
            reason: res.reason, body: res.text != null ? res.text : null,
            // The two U1 facts, in the log as well as on the record: the log is what a human reads
            // while the auction is still open, and a listing age that has stopped advancing is the
            // single most diagnostic thing on this line.
            lastSeenInListAgoMs, biddingOn: cachedBiddingOn, closesInMs: state.closesInMs,
            // The live read, and the two values that separate the hypotheses outright.
            stillListed: probe ? probe.stillListed : null,
            listedBiddingOn: probe ? probe.biddingOn : null,
            listedCloseTime: probe ? probe.biddingCloseTime : null });
          // This emit is now the FALLBACK, not the discovery point. _checkDelisted calls the same
          // load off the listing cache at arm time and on every tick, so by the time the platform
          // refuses a snipe the desk has usually already been told - and a second message about one
          // load reads as two conflicting statuses, which is the exact complaint this reporting layer
          // is being cleaned up for. The refusal is still RECORDED above either way, so the
          // close-time receipt states this reason whether or not the notice repeats here.
          // Except after the early notice: that one says we are still watching and will bid, so
          // the stand-down is a new status and is sent.
          if (monitor._delistedNoticed !== 'refused') {
            monitor._delistedNoticed = 'refused';
            this.emit({ type: 'alert', level: 'warn', kind: 'load_not_biddable', auctionId: monitor.auctionId,
              // lane/companyName/branchName are the SCOPE keys - a desk notice has to resolve to the
              // customer's own group, and without a shipper on the payload no scoped group can match.
              lane: monitor.meta.lane, companyName: monitor.meta.companyName,
              branchName: monitor.meta.branchName || null,
              lastSeenInListAgoMs, biddingOn: cachedBiddingOn,
              stillListed: probe ? probe.stillListed : null,
              listedBiddingOn: probe ? probe.biddingOn : null });
          }
        }
        // QUANTITY REFUSED: SuperProcure will not take the vehicle COUNT we quoted. Its own class
        // rather than folded into either neighbour: the budget is intact (unlike the cap) and the
        // load IS open to bidding (unlike load_not_biddable) - it is the quantity alone that is
        // refused, and that is what the desk has to be told, because the desk is the only party who
        // can act on it. The price page's count control is the remedy: the desk lowers "how many
        // trucks to bid for" and re-prices.
        //
        // Why standing down rather than walking the ladder, and why the stand-down binds the COUNT
        // rather than the load: isQuantityRefusedRejection.
        //
        // revisionsLeft is deliberately NOT zeroed, exactly as on the load_not_biddable path: the
        // per-load budget genuinely is intact, and zeroing it would hand a later re-price - the very
        // action this alert is asking the desk to take - a phantom exhausted load.
        //
        // The vcq we actually sent rides both the log and the alert. Without it the record cannot
        // answer the first question anyone asks of this refusal: how many did we ask for?
        if (isQuantityRefusedRejection(res)) {
          // Read off the opts actually handed to placeBid, exactly as the accepted path reads them
          // for the read-back oracle, so the number in the desk's alert is structurally the number
          // that went on the wire rather than a recomputation that agrees with it today.
          const vcqSent = (bidOpts && bidOpts.vcq != null) ? bidOpts.vcq : null;
          const unitsOnLoad = (monitor.meta && monitor.meta.units != null) ? monitor.meta.units : null;
          monitor.quantityRefused = true;
          if (decision.rungIndex != null) monitor._relearnedRungs.add(decision.rungIndex);
          // Latched at the LOWEST count refused so far: a clamp that later lowers the count further
          // still earns its one attempt, while the count just refused can never be re-sent.
          if (vcqSent != null && (monitor.quantityRefusedAtVcq == null || vcqSent < monitor.quantityRefusedAtVcq)) {
            monitor.quantityRefusedAtVcq = vcqSent;
          }
          // Re-recorded on every refusal (last-writer-wins) so the close-time receipt names the most
          // recent count refused, and ALERTED on the same rule - the first refusal, then every
          // strictly lower count - so the desk's two surfaces can never name different numbers for
          // one auction. A fact-latch here leaves the real-time alert holding 5 while the record
          // (and the close receipt) names 3, and it hides the count walk-down the retry exists to
          // perform. Same latch-on-the-count discipline as vehicle_count_clamped, dedupeKey included.
          // A refusal that carried no count cannot be compared, and the stand-down gate above stops
          // such a load outright, so that case alerts exactly once.
          this._recordRefusal(monitor, 'vehicle_count_refused', { vcqSent, units: unitsOnLoad });
          // OUTSIDE the alert latch: every refused write has to be traceable in production logs. Held
          // inside it, the whole retry sequence this stand-down deliberately allows wrote one line.
          this.log.error('platform refused the bid because the quoted vehicle count exceeds the load total; standing down on this load', {
            auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
            reason: res.reason, body: res.text != null ? res.text : null,
            // The numbers that make this refusal diagnosable after the fact. deskChoseCount is the
            // RAW price-page number and is the one thing `want` cannot show: they diverge exactly
            // when the desk's count was rejected as out-of-range and bid-max took over.
            vcqSent, units: unitsOnLoad,
            want: mvPlan ? mvPlan.want : null, remaining: mvPlan ? mvPlan.remaining : null,
            deskChoseCount: (monitor.meta && monitor.meta.bidVehicleCount != null) ? monitor.meta.bidVehicleCount : null,
            quoteType: (monitor.meta && monitor.meta.quoteType) || null,
            closesInMs: state.closesInMs });
          const qtyAlertDue = !monitor._qtyRefusedAlerted
            || (vcqSent != null && monitor._qtyRefusedAlertedAtVcq != null
                && vcqSent < monitor._qtyRefusedAlertedAtVcq);
          if (qtyAlertDue) {
            monitor._qtyRefusedAlerted = true;
            monitor._qtyRefusedAlertedAtVcq = vcqSent;
            this.emit({ type: 'alert', level: 'warn', kind: 'vehicle_count_refused', auctionId: monitor.auctionId,
              // lane/companyName/branchName are the SCOPE keys - a desk notice has to resolve to the
              // customer's own group, and without a shipper on the payload no scoped group can match.
              lane: monitor.meta.lane, companyName: monitor.meta.companyName,
              branchName: monitor.meta.branchName || null,
              vcqSent, units: unitsOnLoad,
              want: mvPlan ? mvPlan.want : null, remaining: mvPlan ? mvPlan.remaining : null });
          }
        }
        // RAISE REFUSED: the portal will not take this price because it is ABOVE what already stands.
        // Its own class rather than folded into any neighbour, because it is the one refusal whose
        // answer is not the price/state walk-down: what is refused is the DIRECTION. GoComet's form is
        // answered below the standing quote the refusal carries while a band price below it remains,
        // and stands down only when none does (owner ruling 26 Sep, 260925SQRC); SuperProcure's form is
        // conditional on its cap (raiseRefusal).
        //
        // revisionsLeft is deliberately NOT zeroed, exactly as on the two stand-down paths above: the
        // per-load budget genuinely is intact, and zeroing it would hand a later re-price - the one
        // action that can actually resolve this - a phantom exhausted load.
        //
        // The stand-down is a desk notice on WhatsApp (engineAlerts DESK_NOTICE_KINDS), once per load
        // per round, and the close-time receipt names it too (waTemplates `price_raise_refused`).
        if (!monitor.priceRaiseRefused) {
          // With the walk on, a limit at or above the minimum-margin guard is a price to bid (W6,
          // ruling 30), so only a limit below the guard is terminal.
          const walkOn = this._walkOn(monitor);
          if (walkOn) this._noteWalkLimit(monitor, res);
          const raise = raiseRefusal(res, walkOn && Number.isFinite(monitor.guard) ? monitor.guard
            : monitor.ladder[monitor.ladder.length - 1]);
          // F1 live mirror: the same non-latch the retired door already has (R1-F01), extended to an
          // OTHER write of ours still in flight on this auction - a predecessor's late write landing,
          // or a predecessor's write not yet resolved, can each make this refusal mean nothing more
          // than "your own lower price is about to stand, or already does" (W1-7 r2 :86, ruling 26).
          const otherInFlight = raise ? this._lowestOtherInFlightPrice(monitor.auctionId, _inFlightToken) : null;
          let ourLowest = monitor.lastBidPrice;
          if (otherInFlight != null && (ourLowest == null || otherInFlight < ourLowest)) ourLowest = otherInFlight;
          if (raise && raise.cap == null && ourLowest != null && ourLowest <= decision.price) {
            this.log.info('a price raise was refused over our own standing or in-flight bid; not standing down', {
              auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
              reason: res.reason, standingBid: monitor.lastBidPrice, otherInFlight });
          } else if (raise && raise.cap == null && this._continueBelowStanding(monitor, decision, res, state)) {
            // A lower band price remains below the quote standing on this login: the next decision bids it.
          } else if (raise) {
            if (raise.cap != null) this._noteRaiseBelow(monitor, raise.cap + 1);
            monitor.priceRaiseRefused = true;
            monitor.priceRaiseRefusedCap = raise.cap;
            monitor._raiseAlertedRound = monitor.extendsObserved;
            this._recordRefusal(monitor, 'price_raise_refused',
              raise.cap != null ? { amountCap: raise.cap } : {});
            this.log.error('the portal refused the bid because the price may not be raised; standing down rather than walking the ladder down', {
              auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
              reason: res.reason, body: res.text != null ? res.text : null,
              // The three numbers that make this refusal diagnosable after the fact: what the portal
              // will accept (where it named a figure), the lowest price this ladder could ever offer,
              // and what is actually standing on the board.
              amountCap: raise.cap, floor: monitor.ladder[monitor.ladder.length - 1],
              standingBid: monitor.lastBidPrice != null ? monitor.lastBidPrice : null,
              landedBids: monitor.landedBids, closesInMs: state.closesInMs });
            this.emit({ type: 'alert', level: 'warn', kind: 'bid_price_raise_refused', auctionId: monitor.auctionId,
              // lane/companyName/branchName are the SCOPE keys - a desk notice has to resolve to the
              // customer's own group, and without a shipper on the payload no scoped group can match.
              lane: monitor.meta.lane, companyName: monitor.meta.companyName,
              branchName: monitor.meta.branchName || null,
              price: decision.price, amountCap: raise.cap,
              floor: monitor.ladder[monitor.ladder.length - 1],
              standingBid: monitor.lastBidPrice != null ? monitor.lastBidPrice : null,
              landedBids: monitor.landedBids, round: monitor.extendsObserved,
              standingQuote: monitor._raiseBelow != null ? monitor._raiseBelow : null });
          }
        }
        // SUBMISSION WINDOW CLOSED: the portal says the auction has ended, or (GoComet, inseparably)
        // that the enquiry is closed or the revisions are spent. Terminal for submission only - see
        // isSubmissionClosedRejection for what the conflated string does and does not license.
        //
        // The value here is entirely in the SECOND write never happening. One refused write is how
        // the engine learns the answer and is unavoidable; the ~45 per load that followed it were
        // the cost of having no class to put the answer in. That value does not depend on anyone
        // being told, which is what separates this class from the one above.
        //
        // Same routing caveat as the raise refusal: `submission_window_closed` is in neither routing
        // set in engineAlerts.js, so this is a classification on the record and the event ring, not a
        // delivered OPEN-time notice - but it DOES have a waTemplates `submission_window_closed`
        // noBidWhy branch, so the close-time receipt names it.
        if (!monitor.submissionClosed && isSubmissionClosedRejection(res)) {
          monitor.submissionClosed = true;
          monitor._submissionClosedAtClose = monitor.believedCloseAt;
          this._recordRefusal(monitor, 'submission_window_closed');
          this.log.error('the portal refused the bid because the submission window is closed; standing down on this load', {
            auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
            reason: res.reason, body: res.text != null ? res.text : null,
            // The engine's own belief about the clock, alongside the portal's verdict on it. Where
            // these two disagree - a healthy countdown against a closed auction - the disagreement
            // IS the finding, and it is not reconstructable later without both numbers on one line.
            closesInMs: state.closesInMs, believedCloseAt: monitor.believedCloseAt,
            landedBids: monitor.landedBids });
          this.emit({ type: 'alert', level: 'warn', kind: 'submission_window_closed', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            closesInMs: state.closesInMs, landedBids: monitor.landedBids });
        }
        // NOTHING-PLACED restore (see the fire-point note above). A NON-CAP rejection put no standing
        // bid on the board FROM THIS ATTEMPT - the rung was refused for price/state (e.g.
        // min-decrement mismatch, "load under approval"), not budget - so the decisive shot must be
        // able to retry / fall to the floor next tick. Restore the endgame latches (same undo as the
        // 429 path). A CAP rejection is terminal (capExhausted + revisionsLeft 0 stop every further
        // rung), so it deliberately does NOT restore: the shot stops, exactly as the deployed floor
        // snipe stopped on a cap reject.
        //
        // "THIS ATTEMPT" is a correction, and the qualifier is load-bearing. This premise used to be
        // written as "a non-cap rejection put no standing bid on the board", full stop, and on the
        // raise refusal that sentence is simply false: a bid of OURS is on the board, and it is the
        // reason the revision was refused. The restore is still right - the refused write placed
        // nothing, so the rung is genuinely unspent - but what makes it safe on that refusal is the
        // stand-down latched above, not this premise. Without the latch the restore is exactly the
        // loop that re-offered one refused floor price 42 times.
        if (!isBidCapRejection(res)) {
          monitor.snipeFired = _priorSnipeFired;
          monitor._lastDefendAtExtend = _priorLastDefendAtExtend;
          monitor._shotRoundId = _firePriors.shotRoundId;
          this._restoreWalkPriors(monitor, _firePriors);
          // D3, in the shape a measured audit settled on. The two rung markers are NOT symmetric, and
          // rolling both back - the obvious reading, and the one first implemented - is REGRESSIVE.
          //
          // selectRung walks the ladder using firedRungs ITSELF:
          //     while (target < last && rungFired(firedRungs, target)) target++;
          // so THE FIRED-RUNG HISTORY *IS* THE WALK-DOWN. Un-banking it pins selectRung on one rung.
          // Probed on a persistent non-cap rejection, ladder [10000, 9700, 9400, 9100, 8000]:
          //     origin/main (no rollback)   9700, 9400, 9100, 8000              floor in 4 polls
          //     blanket rollback of both    9700 x 12                           FLOOR NEVER REACHED
          //     this shape                  9700, 9400, 9100, 8000, 8000, ...   walk-down AND retry
          //
          // So the split is by RUNG POSITION, not by rejection reason (the reason is not reliably
          // available - U1 - and this shape does not need it):
          //
          //   currentRungIndex - rolled back on EVERY non-cap rejection. This is the actual D3 repair.
          //     It is what reopens _decide's establish branch on a load whose first bid was refused,
          //     and it is sound precisely BECAUSE it is not what selectRung walks on: the walk reads
          //     firedRungs, so restoring the position costs no ladder progress.
          //
          //   firedRungs - rolled back ONLY when the refused rung is the FLOOR. Everywhere above the
          //     floor the banked rung is the walk-down and must stay banked. AT the floor there is
          //     nothing lower to walk to, so banking is pure loss: both snipe paths gate on firedRungs
          //     (the deployed always-floor snipe on `!firedRungs.has(last)`, the rank-aware one on
          //     `firedRungs.has(rungIndex)`), and a refused floor left banked abandons the single
          //     decisive shot of the auction with seconds and budget still in hand.
          //
          // Restored BY MEMBERSHIP into the SAME Set (clear + re-add), never by assigning a fresh one:
          // selectRung holds it by reference and priceRequests.js mutates it, so the object identity
          // has to survive. Restoring the captured PRIOR rather than deleting the refused index also
          // means a rung that genuinely LANDED earlier is re-added untouched - nothing spent is ever
          // resurrected.
          //
          // DISK ALREADY AGREES, which is why no write is added on the money path. This branch's only
          // persist is the `{ everBid: true }` above; firedRungs reaches the durable intent at exactly
          // two sites, both of them LANDED. So the bank was in-memory ONLY, and before this restore a
          // refused load's monitor disagreed with its own intent about which rungs were spent - a
          // mid-auction `pm2 restart bid-command` (this project's own deploy step) would rehydrate the
          // load straight back out of the deadlock. The restore REMOVES that disagreement.
          //
          // The ATTEMPT facts are deliberately NOT rolled back with it. ownBidAttempts and everBid are
          // counted at the fire point precisely because SuperProcure may have registered the bid
          // against its own per-load cap before refusing it, so "have we touched this load" stays true
          // and _detectForeignBids stays closed. bidTimes is not popped either (unlike the 429 path):
          // the wire really was used, and leaving the attempt counted is what keeps maxBidsPerMin
          // bounding a load SP refuses over and over - the explicit brake this retry needs, since the
          // floor snipe is NOT exempt from that cap (its gate returns before _decide is ever called).
          monitor.currentRungIndex = _priorCurrentRungIndex;
          if (decision.rungIndex != null && decision.rungIndex === monitor.ladder.length - 1) {
            monitor.firedRungs.clear();
            for (const r of _priorFiredRungs) monitor.firedRungs.add(r);
          }
        }
        // After the restore, so the un-banked floor rung is recorded as still offerable.
        this._persistRefusalState(monitor);
        if (res.reason === 'auth') { try { await this.adapter.ensureSession(); } catch (_) {} }
      }
    } catch (e) {
      // AUTH IS NOT AN UNCERTAIN OUTCOME, and it must leave before the handler below can treat it as
      // one. A 401/403 is refused at SuperProcure's edge BEFORE the request is processed, so the bid
      // provably did not commit - while the handler below assumes the opposite and, on the real
      // adapter, ALWAYS acts on that assumption: `landed` initialises true (see below) and the only
      // expression that can falsify it needs rb.revisionsLeft != null, which realAdapter.getAuctionState
      // hardcodes to null. So a thrown auth error would record a LANDED bid that never existed, and
      // the fabrication is DURABLE (persisted onto the intent and restored by arm()), it SILENCES the
      // never_bid_before_close alarm through everLanded, and it disables the last-resort floor shot.
      // That is correct fail-closed behaviour for a genuine TRANSPORT failure and exactly wrong here.
      //
      // Matched on an exact e.code sentinel, never a message substring - the same discipline the
      // adapter's own NETWORK code uses. realAdapter.placeBid RETURNS auth rejections rather than
      // throwing them, so in normal operation this branch is the belt; it still has a live producer,
      // because ensureSession throws code AUTH when the token is inside 60s of its own expiry.
      //
      // Placed as the FIRST statement in the handler, above the log and the bid_submit_error emit: a
      // bid_submit_error per tick per load is a second flood under a misleading name.
      if (e && e.code === 'AUTH') {
        this._undoAuthRefusedFire(monitor, _firePriors, { graceBand: this._isGraceBandRefusal(e.authReason) });
        this._refundReleaseAttempt(monitor, decision);
        this.log.error('adapter.placeBid threw for a dead session; nothing was placed and the ladder is held', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          detail: String(e && e.message) });
        return;
      }
      // ALSO NOT AN UNCERTAIN OUTCOME, and provably so: resolvePerTypePrices refuses at
      // gocometAdapter.js:2240, above both the confirming read and the PUT, so no byte of this bid
      // left the box. The handler below assumes the opposite and on GoComet can never falsify it -
      // getAuctionState exposes no revisionsLeft, so `landed` stays true - and would book a landed
      // bid that does not exist, spend the rung and persist everBid onto the intent.
      //
      // ownBidAttempts and everBid are deliberately NOT given back, unlike the auth path above. They
      // are what holds deliberateZeroBid false in _finalize, so this close still raises
      // never_bid_before_close instead of reading as a decision nobody needs to look at. The throttle
      // is left spent for the same reason auth leaves it.
      //
      // The refusal is deterministic against the armed per-type rates and this quote, so it would
      // re-throw on every attempt until the desk re-prices: the load stands down at once and the desk
      // is told once to bid it by hand (ruling 47), through the same latch and the same notice the
      // placed:false arm below raises for its own repeat codes. Before this, the rung was held and the
      // same refused bid re-sent until the per-load throttle stopped it, and the desk heard nothing
      // until the close receipt.
      //
      // Every other pre-wire refusal, PARTIAL_VEHICLE_COUNT and QUOTE_CHANGED included, takes the
      // placed:false arm below instead; this one keeps its own arm for the refusal it records, whose
      // receipt wording names the per-type rates rather than the generic hand-off.
      if (e && e.code === 'COST_TYPE_UNMATCHED') {
        monitor.firedRungs.clear();
        for (const r of _priorFiredRungs) monitor.firedRungs.add(r);
        monitor.currentRungIndex = _priorCurrentRungIndex;
        monitor.snipeFired = _priorSnipeFired;
        monitor._lastDefendAtExtend = _priorLastDefendAtExtend;
        monitor._shotRoundId = _firePriors.shotRoundId;
        this._restoreWalkPriors(monitor, _firePriors);
        this._refundReleaseAttempt(monitor, decision);
        // No facts recorded with it: the refusal message names freight-line tokens and match keys,
        // and _recordRefusal's payload rides all the way onto WhatsApp.
        this._recordRefusal(monitor, 'per_type_rates_unmatched');
        this.log.error('the per-truck-type rates could not be routed to this load\'s freight lines; nothing was placed, standing down on this load', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          detail: String(e && e.message) });
        // Not latched or told on a killed engine or a finalized monitor, as in the placed:false arm
        // below: resume must find the load biddable (its first attempt re-learns the refusal and
        // stands down then), and a finalized monitor has closed or been replaced by a re-price whose
        // own attempt answers for the new rates.
        if (monitor.finalized || this.killed) return;
        monitor.prewireStoodDown = true;
        // standDownAt names WHICH stand-down this is: a re-price stops this monitor and rebuilds a
        // new one (server.js's reArmWithNewBand), and if the same refusal repeats on the rebuilt
        // monitor the desk must hear it again - a load-only key would read the first stand-down's
        // dedupe mark as covering the second.
        this.emit({ type: 'alert', level: 'warn', kind: 'bid_not_sent', byHand: true, standDownAt: Date.now(),
          auctionId: monitor.auctionId, lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          branchName: monitor.meta.branchName || null,
          price: decision.price, landedBids: monitor.landedBids,
          detail: 'the per-truck-type rates could not be matched to this load\'s freight lines, so the bid was stopped before it was sent and the load was handed to the desk' });
        return;
      }
      // The adapter marks a throw placed:false only when it was raised before the write request was
      // issued. Keyed on that call-site mark, never on the code: NETWORK is thrown on both sides of
      // the wire, and the dispatched one must still fall through to the handler below. Same give-back
      // as the arm above, and for the same reasons: ownBidAttempts, everBid and lastFireAt stay spent,
      // so the retry is paced and a close with nothing landed still raises never_bid_before_close.
      if (e && e.placed === false) {
        monitor.firedRungs.clear();
        for (const r of _priorFiredRungs) monitor.firedRungs.add(r);
        monitor.currentRungIndex = _priorCurrentRungIndex;
        monitor.snipeFired = _priorSnipeFired;
        monitor._lastDefendAtExtend = _priorLastDefendAtExtend;
        monitor._shotRoundId = _firePriors.shotRoundId;
        this._restoreWalkPriors(monitor, _firePriors);
        this._refundReleaseAttempt(monitor, decision);
        // A throttle is the one member that must not spend the runaway cap, for the reason the
        // rate_limited arm refunds it: a GoComet cooldown lasts a minute and would otherwise fill the
        // cap and starve the floor shot. The rest either re-throw deterministically or put a real
        // request on the wire each time, and the cap is what bounds that loop.
        if (e.code === 'RATE_LIMITED') monitor.bidTimes.length = _firePriors.bidTimesLength;
        // A refusal that repeats on every attempt stands the load down at once and hands it to the
        // desk. Not latched on a killed engine: a kill drops the write backstop, so WRITE_DISABLED
        // there says nothing about the load, and resume must find it biddable.
        if (!PREWIRE_RETRY_CODES.has(e.code)) {
          this.log.error('the bid was refused before it was sent, and would be refused the same way on every attempt; standing down on this load', {
            auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
            code: e.code || null, detail: String(e.message) });
          if (monitor.finalized || this.killed) return;
          monitor.prewireStoodDown = true;
          this._recordRefusal(monitor, 'bid_not_sent_by_hand');
          // Emitted whatever _bidNotSentAlerted says: an earlier notice on this load promised a retry,
          // and a stand-down the desk never hears about is the silent failure this notice exists for.
          // standDownAt: see the COST_TYPE_UNMATCHED arm above - same reason, same field.
          this.emit({ type: 'alert', level: 'warn', kind: 'bid_not_sent', byHand: true, standDownAt: Date.now(),
            auctionId: monitor.auctionId, lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            price: decision.price, landedBids: monitor.landedBids,
            detail: 'a bid was stopped before it was sent and would be stopped again on every try, so the load was handed to the desk' });
          return;
        }
        this.log.warn('the bid was refused before it was sent; nothing was placed and the rung is held', {
          auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex,
          code: e.code || null, detail: String(e.message) });
        // No _recordRefusal on a retry: a recorded refusal is terminal on the console and
        // first-writer-wins at close, so it would outlive a retry that lands.
        if (!monitor._bidNotSentAlerted && !monitor.finalized && !this.killed) {
          monitor._bidNotSentAlerted = true;
          // A throttle is adapter-wide: one GoComet cooldown refuses every load it holds off, and a
          // per-load notice then tells a customer's desk the same thing once per load. The cooldown's
          // identity rides the event so the notice is keyed per customer and cooldown instead
          // (engineAlerts), one per cooldown (ruling 47). Absent it, the notice stays per load.
          const rateLimitEpisode = e.code === 'RATE_LIMITED' && e.cooldownSince != null ? e.cooldownSince : null;
          this.emit({ type: 'alert', level: 'warn', kind: 'bid_not_sent', auctionId: monitor.auctionId,
            lane: monitor.meta.lane, companyName: monitor.meta.companyName,
            branchName: monitor.meta.branchName || null,
            price: decision.price, landedBids: monitor.landedBids, rateLimitEpisode,
            detail: 'a bid was stopped before it was sent, so nothing was placed on the portal' });
        }
        return;
      }
      // WARNING: uncertain outcome - the write may have COMMITTED before the transport failed.
      if (this.caps.durableSubmissionTracking && monitor.pendingGcSubmission) {
        this._recordGcUnconfirmed(monitor, monitor.pendingGcSubmission, { reason: 'Submit connection failed; the quote may have been saved' });
        return;
      }
      // A blind same-price re-fire double-submits (burns a revision + double-commits money), so
      // spend the rung unless a dropped revisionsLeft proves it never landed. SP exposes none,
      // so assume it may have landed (floor-safe: at worst gives a rung early).
      this.log.error('adapter.placeBid threw; verifying whether the bid landed before allowing a retry', {
        auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex, err: e });
      this.emit({ type: 'alert', level: 'warn', kind: 'bid_submit_error', auctionId: monitor.auctionId,
        detail: String(e && e.message) });
      const prevRev = monitor.revisionsLeft;
      let landed = true;
      let revFromReadBack = false;
      let ownAmountPublished = false;
      try {
        const rb = await this.adapter.getAuctionState(monitor.auctionId);
        if (rb.ok) {
          ownAmountPublished = Object.prototype.hasOwnProperty.call(rb, 'myAmount');
          monitor.myRank = rb.myRank;
          if (rb.revisionsLeft != null) {
            landed = prevRev == null ? true : rb.revisionsLeft < prevRev;
            monitor.revisionsLeft = rb.revisionsLeft;
            revFromReadBack = true;
          }
        }
      } catch (_) {}
      // A portal that shows our own standing bid can PROVE the landing instead of it being assumed
      // (BC-15 Fix A). Seen at our price: landed, and recorded as confirmed. Reads that answered but
      // never showed it: not landed, so the rung stays unspent and can re-fire. No read that carried
      // the field: no evidence either way, so the fail-closed assumption stands.
      let confirmedBy = null;
      let disprovedOnPortal = false;
      if (landed && !revFromReadBack && ownAmountPublished) {
        const seen = await this._confirmOwnBid(monitor, decision.price, state.closesInMs);
        if (seen === true) confirmedBy = 'portal';
        else if (seen === false) { landed = false; disprovedOnPortal = true; }
      }
      this.log.debug('placeBid outcome resolved after transport failure', {
        auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex, landed });
      if (landed) {
        // The moment the landing was concluded - confirmed on the portal, or (no own-amount evidence
        // either way) fail-closed assumed - is what P6 stamps as writeLandedAt for this path; say
        // which by the same confirmedBy/unconfirmed flags the emit below already carries.
        const writeLandedAt = Date.now();
        const confirmFlags = confirmedBy ? { confirmedBy } : { unconfirmed: true };
        // The retire window the accepted path already handles, reached by the other door. stop()
        // never consults bidInProgress, so a re-price can retire this monitor while its write is on
        // the wire and the throw resolves against a monitor whose counts are frozen and whose
        // successor has since landed its own, lower bid. Banking through the same writer is what
        // makes this compose with the intent (lowest price wins, counts add) instead of overwriting
        // it, and what hands the correction to the live successor.
        if (monitor.finalized || this.killed) {
          // Only a read-back whose counter dropped proves this write reached the portal; anything
          // else is counted against the budget but must not be booked as a landed bid on the record.
          this._recordLandedAfterRetire(monitor, decision,
            { revisionsLeft: revFromReadBack ? monitor.revisionsLeft : null,
              unconfirmed: !(revFromReadBack && prevRev != null) },
            decidedAt, writeLandedAt, confirmFlags);
          return;
        }
        // Same lowest-wins rule as the accepted path: a write counted on the board must never raise
        // the standing price above what the board really holds.
        const standing = lowestStandingPrice((this.scheduler.get(monitor.auctionId) || {}).landedBidPrice, decision.price);
        if (monitor.lastBidPrice == null || monitor.lastBidPrice > standing) monitor.lastBidPrice = standing;
        // Read-back could not disprove the write committed, so treat it as ON THE BOARD - the
        // fail-closed side: never shout "no bid was placed" over money that may be committed.
        monitor.landedBids += 1;
        if (decision.provisionalRoundId != null) monitor._shotRoundId = decision.provisionalRoundId;
        monitor._lastLandedAt = Date.now();
        monitor._lastLandedRank = null;
        // A write counted as on the board spends its revision, exactly as the accepted path spends
        // one. Skipping it leaves the engine believing it has budget SuperProcure's own counter has
        // already taken, and that disagreement does not end in an extra rung - it ends in a CAP
        // rejection, which is terminal and abandons the rest of the ladder. Only where the read-back
        // gave no authoritative count; where it did, that number is in place and is the better one.
        if (!revFromReadBack && monitor.revisionsLeft != null) monitor.revisionsLeft -= 1;
        if (decision.rungIndex != null) {
          monitor.currentRungIndex = Math.max(monitor.currentRungIndex, decision.rungIndex);
          monitor.firedRungs.add(decision.rungIndex);
        }
        // Persist UNCONDITIONALLY. The rung write this replaces was inside the rungIndex guard, so a
        // landed bid on a price-visible/undercut platform (where _decide always returns rungIndex
        // null) left NO durable trace at all. A transport failure is also exactly the moment a
        // restart is most likely to follow, which is when the participation fact matters most.
        // firedRungs rides along unchanged when no rung advanced - a no-op write, same value.
        // revisionsLeft rides along for the same reason it is decremented above: the spend is
        // otherwise in-memory only, and a restart re-arms off this intent believing it holds a
        // revision the platform's own counter has already taken.
        // The in-memory booking above stands if this write fails: un-booking a bid that may be on the
        // board would re-fire it.
        try {
          this.scheduler.update(monitor.auctionId, {
            firedRungs: [...monitor.firedRungs], everBid: true, foreignSlotUncounted: !!monitor.foreignSlotUncounted,
            landedBids: monitor.landedBids,
            revisionsLeft: monitor.revisionsLeft,
            landedBidPrice: standing, // treated as ON THE BOARD above, so it is the standing price too
            // Rides along for the same reason the rest of this write does, and it matters MORE here
            // than on the accepted path: this branch banks firedRungs, so rehydrate rebuilds
            // currentRungIndex and skips the establish branch - the only place that sets the flag - and
            // the comment above says a restart is most likely exactly here. Without it a transport
            // failure plus a deploy re-opens the early ladder walk on a re-priced load.
            establishedBeforeWindow: !!monitor.establishedBeforeWindow });
        } catch (persistErr) {
          this._recordWriteFailed(monitor, 'bid_record_failed',
            'The portal did not confirm our latest bid on this load, and it could not be saved to our records. We are treating it as placed. Please check this load on the portal.',
            persistErr, { price: decision.price, rungIndex: decision.rungIndex });
        }
        // The same two consequences the accepted path draws from a landed bid, drawn here from the
        // same conclusion reached by assumption. This branch has already declared the write ON THE
        // BOARD - landedBids counted, the rung banked, everBid persisted - so a stand-down left
        // engaged here freezes the ladder behind a verdict on a load we just counted a bid for, and
        // a clamp notice left unsent hides a reduced commitment the desk is owed. bidOpts is const
        // inside the try and invisible from here; mvPlan is the source it was built from and is in
        // scope, so the count is read off the plan.
        // The bid is on the board as far as anyone can tell, so it is recorded like one (PR-T7): without
        // this the closed record, the receipt's last-bid line and the exports never saw it.
        monitor._lastLanded = {
          closeAt: budgetCtx.believedCloseAt, extendsObserved: budgetCtx.extendsObserved,
          roundId: this.roundVerdict(monitor).roundId,
          shotRoundId: decision.buzzerShotRoundId || decision.provisionalRoundId || null,
          landingMs: bidGapsMs({ closesInMs: state.closesInMs, decidedAt, ts: Date.now() }).landingMs,
          triggerWindowMs: monitor.triggerWindowMs, incrementMs: extendIncrementMs(state),
          countdownMs: state.closesInMs, heldRank1: null,
        };
        const uPricing = monitor.intent || {};
        const uBand = Array.isArray(uPricing.marginsPct) ? uPricing.marginsPct.map(Number).filter(Number.isFinite) : [];
        this.emit({ type: 'bid_placed', auctionId: monitor.auctionId, price: decision.price,
          ...(decision.walk ? { walk: decision.walk } : {}),
          rungIndex: decision.rungIndex, rank: null, revisionsLeft: monitor.revisionsLeft,
          socketRank: state.myRank != null ? state.myRank : null,
          closesInMs: state.closesInMs, decidedAt, writeLandedAt, latencyMs: null,
          lane: monitor.meta.lane, companyName: monitor.meta.companyName,
          branchName: monitor.meta.branchName || null,
          cost: uPricing.cost != null ? uPricing.cost : null,
          minMarginPct: uPricing.minMarginPct != null ? uPricing.minMarginPct : null,
          costByType: (monitor.meta.rules && monitor.meta.rules.costByType) || null,
          openingPct: uBand.length ? Math.max(...uBand) : null,
          lowestPct: uBand.length ? Math.min(...uBand) : null,
          ...confirmFlags,
          ...budgetCtx });
        this._armRankWatch(monitor, decidedAt, decision.price);
        monitor.quantityRefused = false;
        monitor.quantityRefusedAtVcq = null;
        this._maybeAlertVcqClamp(monitor, mvPlan);
      } else {
        // Read-back PROVED the bid did not land (revisionsLeft unchanged), so the rung stays unspent for
        // retry (firedRungs left untouched above) AND the endgame latches must be restored - else a
        // decisive snipe that threw-but-didn't-land would be swallowed and never retried. The coarse
        // floor snipe re-fired here (its firedRungs stayed clear); the latch restore keeps that
        // byte-identical. NOTHING-PLACED restore, same as the 429 and non-cap-reject sites.
        monitor.snipeFired = _priorSnipeFired;
        monitor._lastDefendAtExtend = _priorLastDefendAtExtend;
        monitor._shotRoundId = _firePriors.shotRoundId;
        this._restoreWalkPriors(monitor, _firePriors);
        this._refundReleaseAttempt(monitor, decision);
        // Not seen on the portal is strong evidence, not proof: a write SuperProcure did receive would
        // have cost a revision, so the budget stays spent (fail-closed on the cap).
        if (disprovedOnPortal && monitor.revisionsLeft != null) {
          monitor.revisionsLeft -= 1;
          try { this.scheduler.update(monitor.auctionId, { revisionsLeft: monitor.revisionsLeft }); } catch (persistErr) {
            this._recordWriteFailed(monitor, 'bid_record_failed',
              'We could not save an attempt used on this load. Bidding continues; a restart before it saves could try one attempt too many.',
              persistErr, { revisionsLeft: monitor.revisionsLeft });
          }
          this.log.warn('a write whose transport failed never showed on the portal as our bid; the rung is held for a retry', {
            auctionId: monitor.auctionId, price: decision.price, rungIndex: decision.rungIndex });
        }
      }
    } finally {
      monitor.bidInProgress = false;
      this._removeInFlightPrice(monitor.auctionId, _inFlightToken);
      if (gcAttempt && this._gcActiveAttempts) this._gcActiveAttempts.delete(gcAttempt.attemptId);
    }
  }

  /**
   * Everything the fire point is about to advance, captured as ONE object so the undo can be TOTAL.
   *
   * The set is exhaustive by construction and pinned as such: scripts/test-auth-reversibility.js
   * deep-equals the monitor's whole bookkeeping surface across a refused write, so a ninth fact added
   * to the fire point without a matching entry here fails a test rather than shipping as a silent
   * partial restore. That is the point of the object - the previous shape captured four facts in four
   * loose consts and the two that were missing (ownBidAttempts, everBid) permanently disabled
   * foreign-bid detection on the load, during exactly the window the alert told the desk to hand-quote
   * it.
   */
  _captureFirePriors(monitor) {
    return {
      // BY MEMBERSHIP, never the Set object: selectRung is handed this Set by reference and the
      // priceRungs path mutates it, so the identity has to survive the restore.
      firedRungs: [...monitor.firedRungs],
      currentRungIndex: monitor.currentRungIndex,
      snipeFired: monitor.snipeFired,
      lastDefendAtExtend: monitor._lastDefendAtExtend,
      shotRoundId: monitor._shotRoundId,
      lastFireAt: monitor.lastFireAt,
      bidTimesLength: monitor.bidTimes.length,
      ownBidAttempts: monitor.ownBidAttempts,
      everBid: monitor.everBid,
      walkOfferedMin: monitor._walkOfferedMin,
      walkLimitSent: monitor._walkLimitSent,
    };
  }

  // The walk stays started: a refused step is re-derived at once (W6); only its price latches are given back.
  _restoreWalkPriors(monitor, priors) {
    monitor._walkOfferedMin = priors.walkOfferedMin;
    monitor._walkLimitSent = priors.walkLimitSent;
  }

  /**
   * Give back everything the fire point spent, for the one outcome where the write PROVABLY never
   * reached SuperProcure: the session was logged out.
   *
   * Two call sites - the AUTH rejection arm and the AUTH sentinel at the head of the uncertain-outcome
   * handler - and they must never drift, which is why both pass the captured object whole rather than
   * naming fields at the call site.
   *
   * Why each fact has to come back:
   *   - firedRungs, restored BY MEMBERSHIP into the SAME Set object (clear + re-add).
   *   - currentRungIndex, which if left advanced permanently closes _decide's establish branch.
   *   - snipeFired, _lastDefendAtExtend and _shotRoundId, advanced OPTIMISTICALLY before the
   *     await. Missing these is how a 401 on the decisive snipe leaves a pristine ladder and still
   *     loses the auction.
   *   - the bidTimes slot, restored BY LENGTH rather than a single pop(). A refused write placed
   *     nothing, so it must not eat into the runaway cap the decisive floor shot draws its reserve
   *     from - and a length restore is total where a pop is a guess about how many were pushed.
   *   - ownBidAttempts and everBid. These are the two the previous shape missed, and they are not
   *     cosmetic: _detectForeignBids reads ownBidAttempts to decide whether a rank it sees could be
   *     ours, so an attempt that never reached the platform permanently stops that load being
   *     checked for desk/competitor activity. everBid is the same fact in the form that survives a
   *     re-price.
   *   - lastFireAt, which gates the inter-fire interval. A write that never left the box must not
   *     consume the load's next cadence slot.
   *
   * REVISIONS ARE DELIBERATELY NOT RESTORED because the fire point never spends one - revisionsLeft
   * moves on the accepted and cap paths only. Adding it here would hand a later re-price a phantom.
   *
   * THE TWO THROTTLE FACTS ARE CONDITIONAL, and this is the one asymmetry in an otherwise total undo.
   * `lastFireAt` and the bidTimes slot are not just bookkeeping - between them they ARE the per-load
   * write throttle (the minInterFireMs gate and the runaway cap). Handing them back is only safe when
   * something ELSE bounds the retry, and on a genuine account-wide refusal something does: the
   * adapter is out of CLEAR, so the account gate at the top of _maybeBid holds every following tick
   * and the load stops of its own accord.
   *
   * The token_expiring GRACE BAND has no such bound. It refuses the write while deliberately leaving
   * the account CLEAR (counting it would seal the account off two ordinary attempts inside a token's
   * final minute - a confirmed defect in the other direction), so the account gate never engages,
   * every hot tick reaches the fire point, and a total undo rolls back its own throttle every cycle:
   * ~300 refused attempts per armed load per token rollover, each a synchronous JSONL append on the
   * snipe-timing-critical path, entirely self-inflicted. So on that path alone the two throttle facts
   * are LEFT SPENT and everything else still comes back - the ladder, both endgame latches and both
   * attempt facts, which are what the money case and the foreign-bid guard actually need.
   *
   * The auth marks are then applied through the SAME predicate the account gate uses, with direct
   * evidence: this load's own write was refused at the auth wall, which outranks any inference.
   */
  _undoAuthRefusedFire(monitor, priors, { graceBand = false } = {}) {
    monitor.firedRungs.clear();
    for (const r of priors.firedRungs) monitor.firedRungs.add(r);
    monitor.currentRungIndex = priors.currentRungIndex;
    monitor.snipeFired = priors.snipeFired;
    monitor._lastDefendAtExtend = priors.lastDefendAtExtend;
    monitor._shotRoundId = priors.shotRoundId;
    this._restoreWalkPriors(monitor, priors);
    monitor.ownBidAttempts = priors.ownBidAttempts;
    monitor.everBid = priors.everBid;
    if (!graceBand) {
      monitor.bidTimes.length = priors.bidTimesLength;
      monitor.lastFireAt = priors.lastFireAt;
    }
    this._markAuthBlocked(monitor, { direct: true, graceBand });
  }

  /**
   * Was this auth refusal the token_expiring GRACE-BAND exemption rather than a genuine account-wide
   * refusal? The ONE question _undoAuthRefusedFire's throttle asymmetry turns on - see it for why.
   *
   * `authReasonHint` is the adapter's own label when one travelled with the refusal (ensureSession
   * stamps `authReason` on the error it throws); the returned-rejection envelope carries no such
   * field by contract (PLACE_BID_ENVELOPE_KEYS is pinned with deepStrictEqual and tolerates no extra
   * key), so that path asks the adapter instead.
   *
   * TWO CONDITIONS, and the isAuthDead one is not redundant. A token can cross its own exp between
   * the refusal and this read; the account is then EXPIRED, the account gate holds every following
   * tick, and the full reversible restore is both correct and safe. Only a refusal that leaves the
   * account CLEAR is unthrottled by anything else.
   *
   * Feature-detected, like every other adapter-capability read in this engine: the mock, sim and
   * GoComet adapters have no token phase, and every hand-rolled test stub must keep reading false
   * here so its assertions are unchanged.
   */
  _isGraceBandRefusal(authReasonHint) {
    if (authReasonHint === 'token_expiring') return true;
    const a = this.adapter;
    if (!a || typeof a.authTokenGrace !== 'function') return false;
    if (this._authDeadNow()) return false;
    return a.authTokenGrace() === true;
  }

  /**
   * THE ONE ATTRIBUTION PREDICATE: is this load's silence explained by the account-wide auth wall?
   *
   * `direct` is the EVIDENCE CLASS, not a second condition. A write of this load's own that came back
   * 401/403 is per-load proof and always attributes. Everything else is INFERENCE from the account
   * being latched, and inference yields to any better load-specific explanation:
   *   - `!monitor.noBid`: a terminal refusal already recorded (ceiling_below_floor,
   *     stood_down_below_floor, the fail-closed rule guards) carries the ceiling/floor facts the desk
   *     receipt needs, and an outage outlasting that load must not erase them.
   *   - `ownBidAttempts === 0`: a load that already used the wire has real history, and ordinary
   *     price/state rejections (HTTP 400) never record a refusal at all - so `!monitor.noBid` alone
   *     does not protect them. Telling the desk "the rate was not the problem" about a load refused
   *     twenty times on price is exactly backwards.
   */
  _authAttributable(monitor, { direct = false } = {}) {
    if (direct) return true;
    // OUR OWN auth record is not a competing explanation, it is this one, so it must not lock the
    // load out of being re-marked. The refusals this guard exists to protect are the terminal ones
    // that carry ceiling/floor facts (ceiling_below_floor, stood_down_below_floor, the fail-closed
    // guards); session_logged_out carries none, and re-marking it is idempotent. Without this
    // exemption a grace-band decline - which records the reason but deliberately sends no notice -
    // leaves a record that refuses every later mark, so a token that then genuinely EXPIRES produces
    // no open-time notice at all for that load, on the one path this feature special-cases.
    const ownAuthRecord = !!(monitor.noBid && monitor.noBid.reason === 'session_logged_out');
    return (!monitor.noBid || ownAuthRecord) && monitor.ownBidAttempts === 0;
  }

  /**
   * Apply the auth marks. BOTH FIELDS, UNDER ONE CONDITION, AT EVERY SITE.
   *
   * `authBlockedLast` gates the zero-bid alarm's suppression and `noBid` names the cause on the desk
   * receipt; they encode one judgement, so writing them under different conditions makes a load's
   * alarm and its receipt disagree about the same load - which is precisely the defect this replaces
   * (the record was guarded on ownBidAttempts while the suppression flag was not, so a load with a
   * correct non-auth receipt had its alarm silenced anyway).
   */
  _markAuthBlocked(monitor, { direct = false, graceBand = false, notice = true } = {}) {
    if (!this._authAttributable(monitor, { direct })) return false;
    monitor.authBlockedLast = true;
    // The reason literal is load-bearing: the notify layer's noBidWhy branch keys on this exact
    // string, and it is deliberately NOT the mock adapter's `auth`, so the real path can never
    // inherit the mock's re-auth behaviour.
    this._recordRefusal(monitor, 'session_logged_out');
    // THE MARKS APPLY ON THE GRACE BAND; THE OUTBOUND NOTICE MUST NOT. A grace-band decline is not an
    // auth failure - realAdapter._tokenPhase documents it as "the session is still valid; we simply
    // decline to start a write we may not be able to finish", and it has its own alert path in
    // tokenExpiry.js. The marks are internal and reversible (authBlockedLast is dropped the moment
    // the account reads alive again), so carrying them through a rollover costs nothing. A WhatsApp
    // message to the customer's own group is neither: telling a customer our login is logged out, on
    // every token rollover, when nothing is logged out, is a false statement about the account. The
    // retraction withdraws the hand-bid instruction; it cannot make the claim have been true. Nor is
    // it reachable from a rollover, which opens no episode and so leaves no record for it to close.
    if (!graceBand && notice) this._alertAuthBlocked(monitor);
    return true;
  }

  /**
   * Tell the desk, WHILE THE LOAD IS STILL OPEN, that this load cannot be bid because the account's
   * session is dead. It is the only one of the three auth messages that arrives while a human can
   * still act on it, by bidding the load on the portal; the other two are the account-wide
   * account_auth_dead alert and the close-time receipt in noBidWhy.
   *
   * THE KIND IS `session_logged_out` DELIBERATELY. Every desk_notice here pairs its open-time notice
   * and its close-time receipt under ONE reason literal, and deskNoticeHeadline, deskNoticeAction
   * and noBidWhy all dispatch on that single value - a parallel kind for the same story would have
   * to be kept in sync across all three.
   *
   * ONE MESSAGE PER (LOAD, EPISODE, STATE), not one per load-lifetime and not one per tick, because
   * the auth gate is re-entered on every tick while an outage lasts. Volume is bounded by the number
   * of ARMED loads - exactly the set a human now has to bid by hand - times at most two states, and
   * never by outage length or tick rate.
   *
   * THE STATE IS PART OF THE IDENTITY, and that is what the plain boolean latch got wrong. The copy
   * branches on landedBids: with no bid of ours standing it says "go bid this on the portal", and
   * with one standing it says "our bid stands, do NOT bid it again". A trial write that lands
   * mid-episode moves a load from the first to the second, and under a boolean latch the corrected
   * copy carried an identical dedupe key and was dropped by the notifier - leaving the desk acting on
   * "go bid it by hand" for a load we were already holding, against the shared per-load bid cap.
   * The transition is MONOTONIC (landedBids only ever increments), so held -> standing can happen at
   * most once and standing -> held can never happen: two messages per episode is a ceiling, not an
   * estimate. `_authNotice` survives both authBlockedLast clears on purpose - see _maybeAlertAuthCleared.
   *
   * TWO SUPPRESSION LAYERS HAVE TO AGREE, and the in-memory record is only the near one. The
   * notifier's sent-mark has no TTL - it is evicted only when the 1000-entry LRU cap pushes it out - so a bare
   * `<auctionId>_notice_session_logged_out` would deliver once per load EVER. `authSince` rides the
   * payload so engineAlerts can key the outage into the dedupe key, exactly as the account-level
   * alert does.
   *
   * THE IDENTITY IS THE EPISODE, AND NO EPISODE MEANS NO MESSAGE. Both halves are load-bearing and
   * both are read off _authOutageIdentity. Keying on the LATCH instant instead re-mints the key on
   * every clear -> re-latch cycle inside one outage, which is what put ~60 alternating messages into
   * a group in 95 minutes (authAlert.js) - realAdapter.authDeadSince says so in its own docstring.
   * And a null identity means the adapter has NOT yet corroborated the failure (it latches at a
   * streak of 2), so emitting there would both cry wolf on one transient 401 and write a permanent
   * outage-less key that swallows every later outage for this load. Returning early instead costs
   * one tick: the gate is re-entered until the account latches, and the latch supplies the identity.
   * The record is written only once a message actually goes out, or the load is latched out of ever
   * getting one.
   */
  _alertAuthBlocked(monitor) {
    const authSince = this._authOutageIdentity();
    // Nothing is RECORDED on this path either. Writing a record here would claim the desk had been
    // told about an episode that does not exist yet, and _maybeAlertAuthCleared would then owe a
    // retraction for a message nobody received.
    if (authSince == null) return;
    const desired = monitor.landedBids > 0 ? 'standing' : 'held';
    const prior = monitor._authNotice;
    if (prior && prior.episode === authSince && prior.state === desired) return;
    monitor._authNotice = { episode: authSince, state: desired };
    this.emit({ type: 'alert', level: 'warn', kind: 'session_logged_out', auctionId: monitor.auctionId,
      // Scope keys - a desk notice has to resolve to the customer's own group, and without a
      // shipper on the payload no scoped group can match. Same three keys load_not_biddable sends.
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null,
      // Without this the copy claims "not bidding" on a load that already has one of our bids on the
      // board, and tells the desk to go place a second one against SuperProcure's shared per-load cap.
      landedBids: monitor.landedBids,
      // The instruction to go bid this by hand is only good while the load is open, so the copy
      // prints the close time and expires on its own terms rather than standing until somebody
      // retracts it. A retraction is not guaranteed to arrive: it needs the load still armed when
      // the account recovers, and a load that closes mid-outage never gets one.
      //
      // believedCloseAt FIRST, because meta.closesAt is the ARM-time close and a confirmed extension
      // moves only believedCloseAt. Havells runs soft-close branches, so on an extended load meta is
      // stale in the one direction that hurts: it names a time already past, the desk reads the window
      // as shut, and stops hand-bidding a live unbid load during the only window a hand bid can win it.
      // believedCloseAt is seeded FROM meta.closesAt at arm and only ever moves forward, so it is a
      // strict superset and the fallback is for a monitor shape that predates it.
      closesAt: monitor.believedCloseAt || (monitor.meta && monitor.meta.closesAt) || null,
      authSince });
  }

  /**
   * THE ALL-CLEAR ON THE DESK'S OWN CHANNEL - "the login is back, stop hand-bidding this load".
   *
   * It exists because the account-wide all-clear (authAlert.raiseAuthRestored) carries no shipper, and
   * scopeMatches requires one, so no shipper-scoped recipient can ever match it. Every group that was
   * told to hand-bid a load is shipper-scoped. Without this the instruction stands forever, and a desk
   * still hand-quoting after the bot resumes double-counts against SuperProcure's shared per-load bid
   * cap and starts costing the bot its own bids.
   *
   * THE TIMING TRAP, and it is the reason this is a separate method called unconditionally rather
   * than a few lines inside the account-alive clear. realAdapter._noteWriteSuccess unlatches on an
   * accepted write and only THEN arms the authSettleMs (180s) settle timer; _emitAllClear, which runs
   * when that timer fires, is the one site that closes the episode. So the account reads ALIVE for
   * about three minutes before the episode ends. The account-alive clear runs exactly once inside
   * that window - it guards on a flag it immediately falsifies - so any retraction conditioned on
   * "the episode I spoke under has ended" and evaluated there finds it still open, and is never
   * evaluated again. Re-entered every alive tick, this simply waits the window out.
   *
   * THE EPISODE IS THE PROOF, not the latch. `_authOutageIdentity() !== episode` is true only once the
   * adapter has closed the episode it spoke under, which happens on the ONE recovery standard in this
   * system - an accepted bid, held clear for the settle window. Reading the latch instead would
   * retract on a flap: the latch clears and re-latches repeatedly inside one outage, and a retraction
   * per flap is the ~60-messages-in-95-minutes shape authAlert.js records.
   *
   * TWO CONDITIONS, AND THE LIVENESS ONE IS NOT REDUNDANT WITH THE EPISODE ONE. "The identity differs
   * from the episode I spoke under" is not the claim "the account recovered" - a NEW OUTAGE moves it
   * too. This IS reached with the account dead, on three call sites that sit above or past the auth
   * branch by design: the loadNotBiddable stand-down, the priceRaiseRefused / submissionClosed
   * stand-down beside it, and a shadow monitor. None runs
   * _alertAuthBlocked, so nothing overwrites the record with the new episode's own and the identity is
   * free to move under it - either to a second episode's own instant, or to NULL, because
   * realAdapter.authState() derives EXPIRED from (tokenExp, now) alone while _episodeSince is opened
   * only when something actually touches the wire (_noteTokenExpired), so a lapsed token reads dead
   * with no identity at all until the next call observes it. Either shape alone emits "the login is
   * back, stop hand-bidding" at the moment the bot cannot bid, which is strictly worse than never
   * retracting at all. _authDeadNow() is the gate rather than a null-identity test because it is the
   * same predicate that routes the tick into the outage branch. It is deliberately WIDER than
   * _authWriteHeldNow(), which is what actually decides whether a given tick may bid: on a tick with
   * a trial write due the account still reads dead, so the retraction stays suppressed while the
   * engine may in fact bid. That errs toward retracting a tick late, never toward retracting into a
   * live outage. And authState() is derived on every read rather than stored, so it cannot be left
   * stale by a missed transition. It composes with the episode check and does not
   * replace it - the latch alone would retract on a flap, per the paragraph above.
   *
   * A SUPERSEDED DEBT IS DISCARDED RATHER THAN OWED. On the biddable path a re-latched account routes
   * the tick into the auth branch, and that branch's _alertAuthBlocked OVERWRITES the record with the
   * new episode's own: a new outage means the hand-bid instruction is live again, so there is nothing
   * left to retract. On the two dead-account paths the record simply keeps naming the old episode
   * until the account is alive again, which reaches the same place one episode later.
   */
  _maybeAlertAuthCleared(monitor, now = Date.now()) {
    const notice = monitor._authNotice;
    if (!notice) return;
    if (this._authDeadNow()) return;
    if (this._authOutageIdentity() === notice.episode) return;
    if (notice.state === 'clear') {
      if (notice.offers >= AUTH_CLEARED_MAX_OFFERS) return;
      if (now - notice.offeredAt < AUTH_CLEARED_REOFFER_MS) return;
    }
    // Mutated in place rather than replaced, so `episode` keeps naming the episode the desk was told
    // about. It is what the retraction is keyed on, and _authOutageIdentity() is already null by now.
    notice.state = 'clear';
    notice.offeredAt = now;
    notice.offers = (notice.offers || 0) + 1;
    this.emit({ type: 'alert', level: 'info', kind: 'session_logged_out', auctionId: monitor.auctionId,
      lane: monitor.meta.lane, companyName: monitor.meta.companyName,
      branchName: monitor.meta.branchName || null,
      landedBids: monitor.landedBids,
      authSince: notice.episode, authCleared: true });
  }

  /**
   * THE OUTAGE'S identity - the value both the alert dedupe key and the suppression clock must use.
   * authDeadSince is the feature-detect key and the last fallback, so a hand-rolled stub predating
   * the episode accessors behaves exactly as it did before.
   */
  _authOutageIdentity() {
    const a = this.adapter;
    if (!a || typeof a.authDeadSince !== 'function') return null;
    let since = (typeof a.authEpisodeSince === 'function') ? a.authEpisodeSince() : null;
    if (!Number.isFinite(since) && typeof a.authOutageSince === 'function') since = a.authOutageSince();
    if (!Number.isFinite(since)) since = a.authDeadSince();
    return Number.isFinite(since) ? since : null;
  }

  /**
   * Is the account's SuperProcure session dead right now? Feature-detected: the mock, sim and GoComet
   * adapters have no such method, and every engine test that hand-rolls a stub adapter must keep
   * reading false here so its assertions are unchanged.
   */
  _authDeadNow() {
    const a = this.adapter;
    return !!(a && typeof a.isAuthDead === 'function' && a.isAuthDead());
  }

  /**
   * Must THIS tick hold rather than use the wire?
   *
   * Narrower than _authDeadNow: a latched adapter still lets one trial write per interval through, so
   * that an accepted bid can prove write scope is back - the only observation that clears the latch.
   * An adapter exposing isAuthDead but not authWriteHeld (every hand-rolled stub in the suite) falls
   * back to a hard hold, which is byte-identical to the behaviour before the trial existed.
   */
  _authWriteHeldNow() {
    const a = this.adapter;
    if (a && typeof a.authWriteHeld === 'function') return !!a.authWriteHeld();
    return this._authDeadNow();
  }

  /**
   * Has the current outage run for LESS than the suppression bound?
   *
   * The TIME BOUND is the one un-suppress trigger that is ours rather than someone else's: the other
   * three (the adapter clears its latch, a console reconnect builds a fresh adapter, a process
   * restart) are all "somebody else did something right". Past authAlarmSuppressMaxMs the alarm
   * resumes even with the latch still set, so a stuck latch degrades to noise and never to silence.
   *
   * THE CLOCK IS THE EPISODE, never the latch instant, and that is the difference between a bound and
   * a permanent suppression. The latch instant moves on every clear -> re-latch transition, so a
   * flapping session restarts the clock before it can elapse and the alarm never resumes - exactly
   * the 2026-07-13 silent-zero-bid class this bound exists to prevent. The episode survives an
   * arbitrary number of those cycles, so nothing the adapter does can rewind it; and because a
   * genuinely later outage opens a NEW episode, a fresh revocation gets a fresh full budget rather
   * than inheriting a spent one. authDeadSince stays the feature-detect key and the last fallback,
   * so a hand-rolled stub that predates the episode accessors behaves as before.
   *
   * DELIBERATELY NOT A LIVENESS CHECK. This answers "how long", and its caller composes it with
   * _authDeadNow() for "is it still true" - see authSuppressed. Merging the two here would hide the
   * fact that BOTH are required, which is how a pure time check ended up suppressing alarms on a
   * demonstrably healthy account for two hours after a 90-second outage.
   */
  _authDeadWithinBound() {
    const since = this._authOutageIdentity();
    if (since == null) return false;
    return (Date.now() - since) < this.cfg.authAlarmSuppressMaxMs;
  }

  /**
   * Record that this load was DELIBERATELY not bid, at the moment the refusal was taken.
   *
   * Every call site here is a refusal we take KNOWINGLY and already raise our own operator alert
   * for, with its own reason string - the ceiling-below-floor stand-down, the unsupported-rule and
   * missing-transit fail-closed guards, and the price-visible below-floor stand-down. Recording it
   * on the monitor is what lets close time tell an intentional zero-bid from a broken one WITHOUT
   * inferring it from "no bids landed", which is the symptom a decision and a fault share.
   *
   * FIRST WRITER WINS, deliberately: the reason that actually STOPPED the load is the honest answer
   * to "why is there nothing on the board", and a later, more generic classification of the same
   * load's silence is not a correction of it - it is a different, weaker true statement about the
   * same silence. Concretely: main already writes `vehicle_count_refused` here, and this reason
   * classifier taxonomy adds `refused_price_bound`, `price_raise_refused` and
   * `submission_window_closed` onto the same field - all four are terminal stand-downs a load can
   * reach independently, so whichever fires FIRST is preserved rather than being clobbered by
   * whichever fires last.
   *
   * Re-recording the SAME reason is not an overwrite and is unaffected by this rule - it is how
   * `vehicle_count_refused` keeps naming the most recently refused count, and how
   * `ceiling_below_floor` / `stood_down_below_floor` re-assert their ceiling/floor facts on every
   * tick they are still true (see those call sites).
   *
   * TWO DOCUMENTED EXCEPTIONS, and they are the SAME exception twice: `refused_price_bound` and
   * `refusal_unrecognised` are the two weakest true statements this engine can make, written as
   * placeholders pending a sharper verdict rather than as terminal findings in their own right.
   * `refused_price_bound` says "we hit a repeated wall"; `refusal_unrecognised` says strictly less
   * than that - "no classifier could even name the wall" - so leaving it out would let the WEAKER
   * of the two latch where the stronger one yields, which inverts the rule. They are the two arms of
   * one ternary at one call site (the refused-price hold), chosen by whether any regex matched, so a
   * rule that covers one and not the other is decided by a coin the precedence rule does not care
   * about. Any DIFFERENT reason recorded after either is by construction the sharper verdict, so it
   * replaces it. No other reason gets this privilege, and neither placeholder may displace an
   * existing different reason (a weak reason cannot un-happen a strong one just by arriving late) -
   * including each other, since neither is sharper than the other.
   *
   * The account-wide `session_logged_out` sites carry their own discipline on top of this: the
   * INFERRED site (`_authAttributable` with `direct: false`) never even calls this function unless
   * nothing is recorded yet or the existing record is already its own, so first-writer-wins is
   * enforced a second time at the call site for that reason specifically. The DIRECT site (a 401/403
   * on this load's own write) calls unconditionally, but is only reachable with something else
   * already recorded via the narrow quantity-refused retry path (a desk-lowered count re-attempting
   * after a stand-down) - untested and unencountered in production; a future need to make direct
   * auth evidence win there too is a second documented exception, not a reason to weaken this one.
   *
   * `facts` carries the numbers the desk-facing receipt renders (today: the ceiling). It is NEVER
   * the place to put anything a human should not read - this rides all the way onto WhatsApp.
   */
  _recordRefusal(monitor, reason, facts = {}) {
    if (!monitor) return;
    const existing = monitor.noBid;
    // A placeholder yields only to a SHARPER verdict, and the other placeholder is not one - so the
    // incoming reason has to be a non-placeholder for the replacement to be allowed.
    if (existing && existing.reason !== reason
        && !(REPLACEABLE_PLACEHOLDER_REASONS.has(existing.reason)
          && !REPLACEABLE_PLACEHOLDER_REASONS.has(reason))) return;
    monitor.noBid = { reason, ...facts };
  }

  /**
   * The refusal that explains a zero-bid close, or null if none was ever recorded.
   *
   * Shadow is folded in HERE rather than at the recording sites because it is not a refusal anyone
   * took - it is a strategy that performs zero wire writes by construction, so there is no decision
   * point to hang a record on. Reading it as one more member of the deliberate set keeps close-time
   * logic reading a single fact instead of special-casing the strategy, which is what the previous
   * `softStrategy === 'shadow'` test did and is exactly the framing this change removes.
   */
  _refusalAtClose(monitor) {
    if (!monitor) return null;
    if (monitor.noBid) return monitor.noBid;
    // A RESTORED LATCH IS STILL A REASON, and without this the desk loses one across a deploy.
    // noBid is per-monitor and is deliberately never persisted, on the premise that "a refusal that
    // still applies re-records itself on the next tick" (see the field). That premise holds for every
    // class the engine re-learns, and fails for exactly the two it now carries: a restored
    // priceRaiseRefused or submissionClosed sends every later tick out through the stand-down gate at
    // the top of _maybeBid, so the classification block that would call _recordRefusal is never
    // reached again. The receipt then read a generic LOST, and the desk can reasonably conclude the
    // bot broke rather than that the portal terminally refused the raise.
    //
    // Derived here rather than persisted alongside refusalState so there is one source for the
    // reason: the latch. The facts match the recording site's - amountCap only where the portal named
    // a figure - so waTemplates renders the identical sentence either way.
    if (monitor.priceRaiseRefused) {
      return monitor.priceRaiseRefusedCap != null
        ? { reason: 'price_raise_refused', amountCap: monitor.priceRaiseRefusedCap }
        : { reason: 'price_raise_refused' };
    }
    if (monitor.submissionClosed) return { reason: 'submission_window_closed' };
    if (monitor.softStrategy === 'shadow') return { reason: 'shadow_strategy' };
    // Folded in here rather than recorded with _recordRefusal: a recorded noBid is first-writer-wins
    // and would outrank every later, sharper reason and the inferred session_logged_out attribution.
    if (monitor.heldLeadAtLastDecision) return { reason: 'held_lead_last_revision' };
    if (monitor._notOpenAtArm && !(monitor.landedBids > 0)) return { reason: 'not_open_on_portal' };
    return null;
  }

  /**
   * What a result can truthfully say about the close relative to our last landed bid.
   *
   * finalCloseUnknown: an unpublished round was possible after our last bid, so the close we hold is
   * not known to be final. On an allowlisted soft load that finalizes from a frozen countdown the
   * round verdict reads UNCERTAIN_AFTER_CLOSE with nothing to check it against, and that alone cannot
   * be the test. So it is unknown only when the frozen close is the very close our last bid was
   * measured against, our bid landed inside that close's trigger window (or the window never
   * surfaced), and published rounds had not already used the cap (or it is unknown). Otherwise the
   * last published close stands and the possible terminal round is not counted.
   *
   * extensionsAfterLastBid: a soft-off load counts no rounds, so its count is how far the close moved
   * in increments, which also counts one read spanning two rounds as two.
   */
  _closeAfterLastBid(monitor, state) {
    const last = monitor._lastLanded;
    const inferred = !monitor.provisionalClose && monitor.softStrategy !== 'off'
      && this.roundVerdict(monitor).verdict === 'UNCERTAIN_AFTER_CLOSE';
    const published = monitor.extendsObserved;
    const capUsed = monitor.extendCap != null && published >= monitor.extendCap;
    let unknown = false;
    if (inferred && monitor.landedBids > 0 && !capUsed) {
      const w = monitor.triggerWindowMs;
      const inWindow = !last || !Number.isFinite(w) || last.landingMs == null || last.landingMs <= w;
      unknown = !last || (monitor.believedCloseAt === last.closeAt && inWindow);
    }
    let extensions = null;
    if (last && (monitor.softStrategy === 'off' || monitor.closeModel !== 'soft')) {
      const finalAt = numericOrNull(monitor.believedCloseAt);
      const at = numericOrNull(last.closeAt);
      const inc = extendIncrementMs(state);
      // A published 0 means no extension mechanic: an unmoved close had none, a moved one cannot be counted.
      if (finalAt != null && at != null) extensions = inc > 0 ? Math.max(0, Math.round((finalAt - at) / inc)) : (finalAt <= at ? 0 : null);
    } else if (last && last.extendsObserved != null) {
      extensions = Math.max(0, monitor.extendsObserved - last.extendsObserved + (unknown ? 1 : 0));
    }
    // True only when our last bid landed with more left than both the trigger window and one
    // increment, so it cannot have caused an extension itself: every later one was someone else's.
    let before = null;
    if (last && last.landingMs != null && last.incrementMs > 0) {
      before = last.landingMs > Math.max(Number.isFinite(last.triggerWindowMs) ? last.triggerWindowMs : 0, last.incrementMs);
    }
    // The final window is the one the engine itself fires its last-chance shot in; a bid inside it that
    // the close then moved past was not in the final round.
    const inFinal = last && last.countdownMs != null && extensions != null
      ? last.countdownMs <= this.cfg.floorWindowMs && extensions === 0 : null;
    return { extensionsAfterLastBid: extensions, finalCloseUnknown: unknown, lastBidBeforeTriggerWindow: before,
      leadAfterLastBid: !last ? null : (last.heldRank1 === true || monitor.won === true) ? true : (last.heldRank1 === false ? false : null),
      lastBidInFinalSeconds: inFinal };
  }

  // What the round tracker believed at the close, for the closed record (ruling 57).
  //
  // rounds (review correction, 26 Sep) comes from the tracker directly, NOT from roundVerdict's
  // `v.rounds` - that value is Number(monitor.extendsObserved) || 0, and extendsObserved is the
  // LIVE-decision mirror mirrorRound only populates when provisionalClose || softStrategy !== 'off'
  // (ruling 56 (a)), deliberately, so the bidding strategy never acts on rounds it isn't tracking
  // FOR. An ordinary SP soft load (softStrategy 'off' is the common case) therefore always reported
  // 0 rounds here regardless of what the auction actually did - the round TRACKER itself
  // (monitor._round.rounds) keeps counting real extensions the whole time for exactly this purpose
  // (ruling 56 (d): "tracked for the closed record only"). A monitor with no tracker at all reports
  // UNKNOWN (null), never a fabricated 0 - waTemplates.closeTypeLine drops the "extended Nx" clause
  // entirely on null rather than print a count the engine never actually observed.
  _roundRecord(monitor) {
    const v = this.roundVerdict(monitor);
    const t = monitor._round;
    const rounds = (t && Number.isFinite(Number(t.rounds)) && Number(t.rounds) >= 0) ? Number(t.rounds) : null;
    return { rounds, cap: v.cap, verdict: v.verdict, reason: v.reason };
  }

  async _finalize(monitor, state) {
    if (monitor.finalized) return;
    monitor.finalized = true;
    monitor.finalizedAt = Date.now(); // A091: starts this monitor's retention clock (see snapshot())
    if (monitor.timer) clearTimeout(monitor.timer);
    this._clearWalkTimers(monitor);

    if (this.caps.durableSubmissionTracking && monitor.pendingGcSubmission) {
      // Give the portal a short settling window. A late read cannot alter the closed receipt or credit a bot bid.
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (this.killed || this.monitors.get(monitor.auctionId) !== monitor) return;
      let timeout;
      try {
        await Promise.race([
          this._checkGcSubmission(monitor, { atClose: true, deadline: Date.now() + 8000 }),
          new Promise(resolve => { timeout = setTimeout(resolve, 8000); }),
        ]);
      } finally { clearTimeout(timeout); }
      if (this.killed || this.monitors.get(monitor.auctionId) !== monitor) return;
    }

    // Last live observation; adapters may require a separate closed-result verification.
    let finalRank = state.myRank;
    try {
      const rb = await this.adapter.getAuctionState(monitor.auctionId);
      if (rb.ok) { finalRank = rb.myRank; this._maybeStampRankVisible(monitor, rb); }
    } catch (_) {}

    let won = finalRank === 1;
    const requiresOwnPosition = this.caps && this.caps.settledOutcomeRequiresOwnPosition === true;
    const participated = monitor.landedBids > 0 || monitor.everBid === true;
    const resultMeta = requiresOwnPosition ? { resultBasis: 'socket_rank_unverified',
      resultObservedRank: finalRank, resultTab: null, resultVerifiedAt: null, awardConfirmed: null } : {};
    // SP verifies bot bids and observed shared-login positions. GoComet
    // continues to ask its own settled-result endpoint even without a bot submission.
    const rankUnknownOnly = this.caps && this.caps.settledOutcomeWhenRankUnknownOnly === true;
    const readSettled = typeof this.adapter.readSettledOutcome === 'function'
      && (requiresOwnPosition ? (participated || finalRank != null) : (!rankUnknownOnly || (finalRank == null && participated)));
    if (readSettled) {
      let settled = null;
      try {
        settled = await this.adapter.readSettledOutcome(monitor.auctionId, requiresOwnPosition
          ? { expectedAmount: participated ? monitor.lastBidPrice : null, pricingMode: monitor.meta.rules && monitor.meta.rules.pricingMode }
          : undefined);
      } catch (_) {}
      if (settled && settled.settled) {
        finalRank = settled.rank;
        won = settled.rank === 1;
        if (requiresOwnPosition) Object.assign(resultMeta, { resultBasis: 'verified_closed_portal_rank',
          resultTab: settled.tab, resultVerifiedAt: settled.verifiedAt, awardConfirmed: settled.awardConfirmed });
      } else {
        won = null;
        if (requiresOwnPosition) finalRank = null;
        this.log.warn('portal had not confirmed the result at finalize - booked as not known', {
          auctionId: monitor.auctionId, liveRank: requiresOwnPosition ? resultMeta.resultObservedRank : finalRank,
          readLanded: settled != null, resultReason: settled && settled.reason });
      }
    } else if (requiresOwnPosition) {
      won = null;
      finalRank = null;
    }
    monitor.status = 'closed';
    monitor.myRank = finalRank;
    monitor.won = won;
    // Nothing above catches a throw here (_tick reaches _finalize outside its try blocks), and the
    // receipt below must still go out.
    try {
      this.scheduler.update(monitor.auctionId, { status: 'closed', finalRank, won, ...resultMeta });
    } catch (persistErr) {
      this._recordWriteFailed(monitor, 'close_record_failed',
        'This auction has closed, but its result could not be saved to our records. Please check this load on the portal.',
        persistErr, { finalRank, won });
    }
    // landedBids is the PARTICIPATION FACT the outcome message needs: won/finalRank alone cannot
    // tell "we bid and lost" from "nothing of ours ever reached the board", so the notify layer
    // used to collapse both to the LOST template and told the desk it had lost an auction it never
    // actually entered (load 23484018, 2026-07-25 - both attempts refused with HTTP 400, rank null,
    // message read "LOST ... Our Final Ranking - -"). Carrying the count here lets engineAlerts
    // pick a different TEMPLATE without minting a new subscription kind, and it is the same fact
    // the funnel reads (exportModel.deriveStatus: ourBids.length === 0 -> 'no_bid'), so the two
    // classifiers now agree about one close instead of contradicting each other.
    //
    // WHY nothing was bid, when nothing was. `monitor.noBid` is the refusal this load actually took,
    // RECORDED at the site that took it (see _recordRefusal) - not re-derived here from the absence
    // of bids, which cannot tell a decision apart from a fault. It rides the outcome so the receipt
    // can state the reason itself instead of leaving the desk to join it to a separate alert sent
    // 47 minutes earlier (SIKA 23534893, 2026-07-27: ceiling 26,000 against a 27,000 cost - the
    // refusal was correct and the outcome message said only "no bid could be placed before close").
    // Attached ONLY on a close that landed nothing, so a fought loss can never carry a stale reason -
    // EXCEPT for the three classes in REASONS_SURVIVING_A_LANDED_BID, where a standing bid of ours is
    // expected rather than contradictory. price_raise_refused fires by its own definition when a quote
    // of ours is still on the board, so the landedBids gate suppressed the receipt on precisely every
    // close the class exists to explain, and the desk read an ordinary LOST while believing its
    // corrected higher rate had gone in. The reason rides the outcome for those three; templateFor
    // still picks lost/lost_short off landedBids exactly as before, and the clause is rendered there.
    const lastReadBeforeCloseMs = monitor._lastLiveRead ? Math.round(monitor._lastLiveRead.closesInMs) : null;
    const refusal = this._refusalAtClose(monitor);
    const noBidWhy = (!refusal
      || (monitor.landedBids > 0 && !REASONS_SURVIVING_A_LANDED_BID.has(refusal.reason))) ? null : refusal;
    this.emit({ type: 'auction_result', auctionId: monitor.auctionId, won, finalRank, ...resultMeta,
      lane: monitor.meta.lane, equipment: monitor.meta.equipment, companyName: monitor.meta.companyName,
      // branch rides as a routing key so a branch-split load's OUTCOME replies under the ask it
      // actually hangs off, instead of landing in the customer's general group (lifecycle split).
      branchName: monitor.meta.branchName || null,
      // the shipper-side contact rides the OUTCOME so the won receipt can name who to ring to get the
      // vehicle placed. Display-only: it is never read for routing, scope-matching or dedupe.
      poster: monitor.meta.poster || null,
      // the shipper's OWN enquiry reference (the OA number) rides the OUTCOME so the loss receipt
      // can name it. Display-only, exactly like poster - never read for routing or dedupe.
      shipperRef: monitor.meta.shipperRef || null,
      // the lane cells as ARMED - already resolved from the full snapshot, so the receipt renders
      // the identical string the ask did rather than re-deriving it from this event's raw lane.
      points: monitor.meta.points || null, laneCells: monitor.meta.laneCells || null,
      closeModel: monitor.closeModel,
      landedBids: monitor.landedBids,
      noBidReason: noBidWhy ? noBidWhy.reason : null,
      gcUnconfirmedSubmissions: monitor.gcUnconfirmedSubmissions || [],
      noBidCeiling: (noBidWhy && noBidWhy.ceiling != null) ? noBidWhy.ceiling : null,
      // The FLOOR the ceiling was actually compared against. _recordRefusal has always captured it
      // (ceiling_below_floor records both), but it stopped there - so the receipt could only name
      // the ceiling and had to describe the gap as "below our cost". That is only true when the
      // ceiling is under the COST; when it sits between the cost and the operating floor the cost
      // fits and the MARGIN is the blocker. Carrying the floor is what lets the message say which.
      noBidFloor: (noBidWhy && noBidWhy.floor != null) ? noBidWhy.floor : null,
      // The vehicle count we actually sent, for the vehicle_count_refused receipt. Same shape and
      // same reason as the two above: _recordRefusal captured it at the refusal, and without it
      // reaching the outcome the close-time message could not name the number the desk has to lower.
      noBidVcqSent: (noBidWhy && noBidWhy.vcqSent != null) ? noBidWhy.vcqSent : null,
      // The auction's own closing time, on the PLATFORM's clock - seeded from the arm-time close and
      // moved forward by every confirmed extension, so on a soft close it is the last deadline the
      // portal actually published. Distinct from the record's `closedAt`, which is when THIS process
      // finalized: that lands after the real close by the finalize debounce and is stamped off the
      // local machine clock, which drifts here by hundreds of ms in either direction. Reporting a
      // close time, or any gap measured against one, needs the portal's number rather than ours.
      // Through the same plausibility bound every other consumer of this field applies
      // (_persistRound does the identical wrap): a bare null-check is not enough, because
      // Number(null) is a finite 0 that reads as 1 Jan 1970 and SP's year-2100 placeholder is a
      // valid number that reads as a 74-year runway. Both have cost real bids, and both would
      // otherwise survive every `!= null` on the way to a date printed for the client. null for
      // either sentinel and when nothing ever published a close, which the record and the receipt
      // already treat as "no portal close" and degrade to closedAt.
      finalCloseAt: plausibleCloseAt(monitor.believedCloseAt, Date.now()),
      // Always present, null when unknown: their presence is what tells the receipt this result
      // carries attempts and close provenance (reportedClose.hasResultFacts).
      attemptsAllowed: this._attemptBudget(state),
      postedCloseAt: plausibleCloseAt(monitor.postedCloseAt, Date.now()),
      ...this._closeAfterLastBid(monitor, state),
      round: this._roundRecord(monitor),
      // The cap the PORTAL named on a raise refusal, for the price_raise_refused receipt. Kept
      // separate from noBidCeiling rather than folded into it: that field means the SHIPPER's price
      // ceiling, and on the SuperProcure form of this refusal the number is usually our own standing
      // bid minus the branch decrement instead. Two different facts, and the receipt says different
      // things about them, so one field cannot carry both.
      noBidAmountCap: (noBidWhy && noBidWhy.amountCap != null) ? noBidWhy.amountCap : null,
      // How many writes ONE price was allowed before the refused-price hold took it (_refusedPriceBound).
      // The receipt needs it because the bound decides whether the sentence is true: at a bound of 1 -
      // every tight-budget load, which is 7 of 12 active SuperProcure customers and all of GoComet -
      // exactly one write goes out and nothing is ever re-sent, so copy saying the portal "kept
      // refusing" and we "stopped re-sending" describes an auction that did not happen. Absent on
      // every other reason and on every pre-fix persisted event; the receipt drops the clause rather
      // than assuming a count.
      noBidBound: (noBidWhy && noBidWhy.bound != null) ? noBidWhy.bound : null,
      // How long before close our last live read was. Over STALE_READ_AT_CLOSE_MS the last seconds
      // went unseen, which is a timing defect of ours whatever the result, so it is also alerted.
      lastReadBeforeCloseMs,
      ...(monitor.provisionalClose ? { latestAcceptedVsCloseMs: monitor._latestAcceptedVsCloseMs != null
        ? monitor._latestAcceptedVsCloseMs : null } : {}) });
    if (lastReadBeforeCloseMs != null && lastReadBeforeCloseMs > STALE_READ_AT_CLOSE_MS) {
      this.log.warn('last live read before close was stale', { auctionId: monitor.auctionId, lastReadBeforeCloseMs });
      this.emit({ type: 'alert', level: 'error', kind: 'stale_read_at_close', auctionId: monitor.auctionId,
        lane: monitor.meta.lane, companyName: monitor.meta.companyName, branchName: monitor.meta.branchName || null,
        lastReadBeforeCloseMs,
        detail: `Stale read: last look was ${Math.round(lastReadBeforeCloseMs / 1000)} s before close. Check the result on the portal.` });
    }    // "Never bid" signal, derived from LANDED evidence ONLY.
    //
    // This used to read `currentRungIndex >= 0 || lastBidPrice != null`, and the currentRungIndex
    // half is what broke it: the rejection handler advances currentRungIndex (and firedRungs) on a
    // REFUSED bid, deliberately, so a rejected rung cannot re-fire. That bookkeeping is correct and
    // stays - but it meant an auction where SuperProcure refused EVERY attempt looked like one that
    // had bid, so this alarm was suppressed and the info-only lost_after_bidding fired instead
    // (load 23484018, 2026-07-25: two attempts, both HTTP 400, zero bids on the board, no alarm).
    // landedBids is incremented only where a bid actually reached the board, on every platform
    // type - including the price-visible/undercut path, where _decide always returns rungIndex
    // null and currentRungIndex therefore stays -1 (the reason the old condition had two halves
    // at all; the landed half was always the one doing the real work). See
    // docs/diagnoses/2026-07-13_zero-bid-silent-miss-and-placeholder-cleanup.md, Class B.
    //
    // ONE fact, and it is DURABLE. currentRungIndex was not just wrong here (the rejection handler
    // advances it) - it was also the half that survived a restart, rebuilt by rehydrate() from the
    // persisted firedRungs. Dropping it without replacing that durability would have re-created
    // this very bug through a different trigger: `sh scripts/deploy.sh` restarts pm2 mid-auction,
    // the monitor comes back with a per-process counter at 0, and a load carrying three real bids
    // closes as "NO BID PLACED". So landedBids is now persisted on the intent at each landed site
    // and restored in arm() (see the note there) - the same durable treatment
    // firedRungs/revisionsLeft/everBid already get, and the pattern _detectForeignBids' docblock
    // spells out for this class of hole. The notify layer applies a SECOND, independent guard on
    // top: it folds in ourBids.length off the durable closed-bids record
    // (engineAlerts.landedEvidence), which is the exact source exportModel.deriveStatus reads - so
    // the two classifiers agree by construction, not by promise.
    //
    // lastBidPrice is DELIBERATELY no longer OR'd in. It is set on the shadow path too, where zero
    // wire writes happen by construction, so it means "a price we decided on", not "a bid on the
    // board" - and a shadow close reporting a fought loss with a blank rank is the same wrong
    // report this fix exists to remove. It also never survived a restart, so it contributed no
    // durability.
    //
    // DELIBERATELY NOT monitor.everBid, which answers a DIFFERENT question. That flag is durable
    // and ATTEMPT-based (set at the fire point, persisted on the rejected path too) because its
    // consumer - _detectForeignBids - asks "could a standing rank on this shared account be
    // OURS?", where a refused attempt still counts: SuperProcure may have registered the bid
    // against the per-load cap before refusing it. Fail-closed there means counting attempts;
    // fail-closed HERE means counting only what landed, or we go quiet about a load we never
    // actually entered. Same word, opposite safe direction - so the two must not be merged.
    const everLanded = monitor.landedBids > 0;
    // D012 (redesigned 26 Sep after review): count only a run of GENUINE silent failures - zero
    // landed bids with no reason recorded at all. `refusal` already covers stood-down
    // (stood_down_below_floor) and ceiling-below-floor (ceiling_below_floor), both written by
    // _recordRefusal, so excluding "any recorded reason" excludes those two by construction. A held
    // load (_holdUnknownClose) never arms and never reaches _finalize at all, so it cannot inflate
    // this counter either. Any close that landed a bid, or has an explained zero, resets the streak -
    // "consecutive" is the whole point: a real failure run must not survive being interleaved with
    // ordinary closes.
    // Nor does a close our LOGIN led: rank 1 on the final read (finalRank, also monitor.myRank) with
    // nothing of ours landed is another writer's quote on the shared login leading, not a silent failure
    // (owner ruling 26 Sep). Counting only - the record and the close receipt are unchanged.
    const hasUnconfirmedSubmission = this.caps.durableSubmissionTracking
      && (monitor.gcUnconfirmedSubmissions || []).length > 0;
    const wasSilentFailure = !everLanded && !hasUnconfirmedSubmission && refusal == null && finalRank !== 1;
    this._silentNoBidStreak = wasSilentFailure ? (this._silentNoBidStreak || 0) + 1 : 0;
    if (wasSilentFailure && this._silentNoBidStreak === 1) this._silentNoBidStreakStart = monitor.auctionId;
    // The streak resetting (a landed bid, or an explained close) re-arms the one-shot latch below -
    // the NEXT run of silent failures gets its own alert once it crosses threshold again.
    if (!wasSilentFailure) this._silentNoBidStreakAlerted = false;
    // The ALARM is for UNINTENDED zero-bids, and "unintended" is decided by a RECORDED REASON - never
    // by the absence of bids, which is the symptom both a decision and a fault share.
    //
    // This used to read `monitor.softStrategy === 'shadow'`, i.e. the shadow strategy was the only
    // case treated as "we meant to place nothing". Every OTHER deliberate refusal - a shipper ceiling
    // below our cost floor, a rule mechanic we have not built, a transit-required load with no days
    // captured, a stand-down because winning would breach the floor - fell through and raised
    // never_bid_before_close, an error-class alarm, for a decision that was correct, intentional, and
    // ALREADY explained to the desk in its own alert minutes earlier. That is what put an unexplained
    // "NO BID PLACED" in front of the client's Director on SIKA 23534893 (2026-07-27). Shadow is one
    // member of the deliberate set, not the definition of it.
    //
    // TWO conditions, and the second is the guard-rail, not a formality:
    //   1. a refusal was RECORDED (_recordRefusal at the site that took it, or the shadow strategy,
    //      which places nothing by construction). No reason recorded => armed and never fired for a
    //      reason nobody wrote down => still a GENUINE failure, still alarms.
    //   2. this load never used the wire (ownBidAttempts === 0). "Armed, tried, and never landed a
    //      bid" - every attempt refused by SuperProcure - is a GENUINE failure and must keep
    //      alarming even if a refusal was recorded earlier in the same auction (e.g. the transit
    //      days arrived, we bid, and every bid was rejected). ownBidAttempts is exactly the fact
    //      that separates refused-every-time from never-fired, so it is what gates this.
    // These two conditions only ever move the alarm toward FIRING, never toward silence: they can
    // suppress strictly fewer closes than "no bids landed" would.
    //
    // `session_logged_out` is EXCLUDED from them, and the exclusion is what keeps this log line
    // honest. A load armed while the account was already logged out never reaches the wire, so it
    // closes with a recorded refusal and ownBidAttempts 0 - which would make it "deliberate" and drop
    // the line below to info. A platform outage logged at info is the opposite of what we want. Its
    // OWN gate is authSuppressed, immediately below, which silences the WhatsApp fan-out without
    // touching the log at all.
    const deliberateZeroBid = refusal != null && refusal.reason !== 'session_logged_out'
      && monitor.ownBidAttempts === 0;
    // THE ONE TERM IN THIS BLOCK THAT MOVES THE ALARM TOWARD SILENCE, which is why it is argued
    // rather than merely written. On 2026-08-04 this emit fired 41 times and produced 56 WhatsApp
    // messages to ~7 recipients, every one of them a symptom of a single cause nobody had been told.
    // Note that recording a refusal alone does NOT suppress it: deliberateZeroBid requires
    // ownBidAttempts === 0, and the loads in that incident had up to 88.
    //
    // Why this is not the blanket silence the comment in engineAlerts.js warns against:
    //   1. It is conditioned on a POSITIVELY DETECTED platform state, not on the absence of
    //      evidence, and it self-clears the moment any non-auth fire outcome occurs on the load.
    //   2. The cause has its own error-class alarm - one account_auth_dead message per account per
    //      outage, naming the account and what to do. Ops learns SOONER and more actionably.
    //   3. THE DESK IS NOT SILENCED. never_bid_before_close is PAIRED_WITH_OUTCOME -> 'lost', and the
    //      auction_result for this load still fires with landedBids 0 and noBidReason
    //      'session_logged_out', which renders the no_bid template with wording that names the real
    //      cause. Every load still gets its per-load receipt on its own thread. What is suppressed is
    //      only the error-kind fan-out to individual ops recipients.
    //   4. It is bounded in time (see _authDeadWithinBound), so a stuck latch degrades to the old
    //      noise rather than to the 2026-07-13 silence.
    // Per-account by construction, not by a filter: one engine is built per stack and each holds its
    // own adapter, so a dead master account cannot silence a healthy primary's alarms.
    //
    // THREE conjuncts, and the middle one is a LIVENESS check that was missing. monitor.authBlockedLast
    // is history ("this load hit the wall at some point") and the time bound is arithmetic; neither
    // asks whether the account is still dead NOW. Without _authDeadNow() a 90-second outage bought a
    // two-hour alarm blackout for every load that happened to tick during it, on an account that had
    // been demonstrably healthy for the whole of the remaining time - silencing zero-bid closes that
    // had nothing to do with auth and putting a false cause on their receipts. The monitor flag is
    // additionally dropped at the top of _maybeBid on any tick where the account is alive, so the two
    // halves agree instead of drifting.
    const authSuppressed = monitor.authBlockedLast === true && this._authDeadNow()
      && this._authDeadWithinBound();
    if (!won && !everLanded) {
      // Loud in the log regardless of who is subscribed to what on WhatsApp: this is a load the desk
      // priced and we armed, that closed with nothing of ours on the board. ownBidAttempts
      // separates "tried and was refused every time" from "never even fired". noBidReason/softStrategy
      // are on the payload so a deliberate close, logged at info, still says why it placed nothing.
      this.log[deliberateZeroBid ? 'info' : 'error']('auction closed with ZERO landed bids on a load we armed', {
        auctionId: monitor.auctionId, attempts: monitor.ownBidAttempts, landedBids: monitor.landedBids,
        softStrategy: monitor.softStrategy, noBidReason: refusal ? refusal.reason : null,
        // The suppression is AUDITABLE from the log alone: pm2 logs is the one channel that must
        // never go quiet, so a close whose WhatsApp alarm was held back says so on its own line.
        authDeadSuppressed: authSuppressed,
        finalRank, floor: monitor.floor, closeModel: monitor.closeModel });
      if (!deliberateZeroBid && !authSuppressed && !hasUnconfirmedSubmission) {
        this.emit({ type: 'alert', level: 'warn', kind: 'never_bid_before_close', auctionId: monitor.auctionId,
          finalRank, floor: monitor.floor, closeModel: monitor.closeModel,
          // lane/companyName so the alert can name the load (the error template renders the lane, and
          // every other error-class emit already carries them); attempts distinguishes refused-every-time
          // from never-fired for whoever reads it.
          lane: monitor.meta.lane, companyName: monitor.meta.companyName, attempts: monitor.ownBidAttempts });
      }
    } else if (won === false) {
      this.emit({ type: 'alert', level: 'info', kind: 'lost_after_bidding', auctionId: monitor.auctionId,
        finalRank, lastBidPrice: monitor.lastBidPrice, floor: monitor.floor });
    }
  }

  stop(auctionId) {
    const t = this.scheduledTimers.get(auctionId); // cancel a pending pre-start wake too
    if (t) { clearTimeout(t); this.scheduledTimers.delete(auctionId); }
    if (this.adapter && typeof this.adapter.cancelShotRefresh === 'function') this.adapter.cancelShotRefresh(auctionId);
    const m = this.monitors.get(auctionId);
    if (!m) return;
    m.finalized = true;
    if (m.timer) clearTimeout(m.timer);
    this._clearWalkTimers(m);
    // The retraction debt outlives this monitor: it was sent about the LOAD, and a re-price rebuilds
    // the monitor under it. arm() picks it up from here. Oldest-first eviction, because the entry a
    // re-price collects is the one just written. A re-write of an existing key keeps its ORIGINAL
    // insertion slot, so a refreshed debt could in principle be evicted as though it were old; that
    // is unreachable here because arm() deletes the entry before rebuilding the monitor, so no live
    // re-price ever leaves a stale key behind to refresh.
    if (m._authNotice) {
      this._authNoticeCarry.set(auctionId, m._authNotice);
      while (this._authNoticeCarry.size > AUTH_NOTICE_CARRY_MAX) {
        this._authNoticeCarry.delete(this._authNoticeCarry.keys().next().value);
      }
    }
    this.monitors.delete(auctionId);
  }

  // A091: sweep expired finalized monitors here, at the one place every consumer of this.monitors
  // (dashboard, /price, /track, EOD, scopeRefresh's armedCount) actually reads them - so there is
  // exactly one place this retention policy can drift from what readers see. A monitor still inside
  // its retention window is untouched either way.
  _pruneFinalizedMonitors(now = Date.now()) {
    for (const [id, m] of this.monitors) {
      if (m.finalized && m.finalizedAt != null && (now - m.finalizedAt) > CLOSED_MONITOR_RETENTION_MS) {
        this.monitors.delete(id);
      }
    }
  }

  /**
   * D012 (redesigned 26 Sep after review): account-level detector for a wedged bidding pipeline.
   * Distinct from the per-load never_bid_before_close/zero-landed-bids signal, which only reports
   * AFTER a load closes: this can catch a stuck write path (or a wedged tick loop) across several
   * closes, not one load's own postmortem.
   *
   * The original version measured elapsed time ("armed loads but no bid landed for N minutes"),
   * which cannot tell a wedged pipeline from an ordinary quiet stretch - replayed on the 24 Sep
   * snapshot it would have fired roughly 150 times across 35 of 42 days, because a load legitimately
   * armed far from its close, or held, stood down, or ceiling-below-floor, looks identical to a
   * stall under a pure elapsed-time measure. Replaced with a streak: `threshold` CONSECUTIVE closes
   * on this account that landed zero bids with no recorded reason (see _finalize, where the streak
   * is actually kept - held/stood-down/ceiling-below-floor closes are excluded there and can only
   * ever reset it, never extend it, and a held load never reaches a close at all).
   *
   * Review correction (26 Sep): this is a ONE-SHOT LATCH, not a level query. Without it, an account
   * with nothing armed and no new closes at all - a wedged pipeline sitting completely idle
   * overnight, the review's exact repro - still calls this every tick, and the streak (having
   * nothing to reset it either) stays at or above threshold forever, so the caller's alert fired
   * every single tick it asked. Reports ONCE when the streak crosses threshold, then stays quiet
   * (returns null) even though the streak is still at or above it, until _finalize resets the streak
   * (a landed bid or an explained close) and re-arms the latch for the next run.
   *
   * streakId is the auctionId of the streak's first close, so each streak carries its own notifier
   * dedupe key: a fixed key made the notifier drop every streak after the first.
   *
   * Returns null when there is nothing NEW to report.
   */
  noLandingReport(threshold = SILENT_NO_BID_STREAK_THRESHOLD) {
    const streak = this._silentNoBidStreak || 0;
    if (streak < threshold || this._silentNoBidStreakAlerted) return null;
    this._silentNoBidStreakAlerted = true;
    return { streak, streakId: this._silentNoBidStreakStart };
  }

  // The offer met a down sender and was not sent: re-arm the latch so the next tick offers the same
  // streak again. Ignored once that streak has ended or been replaced.
  noLandingUndelivered(streakId) {
    if (this._silentNoBidStreak > 0 && this._silentNoBidStreakStart === streakId) this._silentNoBidStreakAlerted = false;
  }

  snapshot() {
    this._pruneFinalizedMonitors();
    return [...this.monitors.values()].map(m => ({
      auctionId: m.auctionId,
      lane: m.meta.lane,
      points: m.meta.points || null,
      equipment: m.meta.equipment,
      units: m.meta.units,
      companyName: m.meta.companyName,
      closesAt: m.meta.closesAt,
      status: m.status,
      myRank: m.myRank,
      totalBidders: m.totalBidders,
      revisionsLeft: m.revisionsLeft,
      closesInMs: m.closesInMs,
      closeModel: m.closeModel,
      ladder: m.ladder,
      floor: m.floor,
      currentRungIndex: m.currentRungIndex,
      firedRungs: [...m.firedRungs],
      lastBidPrice: m.lastBidPrice,
      landedBids: m.landedBids, // bids actually ON THE BOARD (rejections excluded) - the participation fact
      // WHY this load is not bidding, when it is not. status is derived from the clock alone
      // (_phase), so a load the engine has permanently stood down keeps reporting `monitoring` and
      // every HTTP surface built on this snapshot reports a held load as an active one. These
      // carry the refusal itself: noBid is the terminal one, floorOnlyBiddable the reduced-to-its-
      // floor one. Additive - every consumer reads by name.
      noBid: m.noBid || null,
      floorOnlyBiddable: m.floorOnlyBiddable || null,
      // HELD: this monitor has stood the load down because no price it can build improves on our own
      // standing bid. The console renders off this flag; it reads the same latch
      // _holdAboveStandingBid sets, so the two cannot disagree.
      held: !!m._unreachableLadderAlerted,
      stoodDown: m.stoodDown,
      won: m.won ?? null,
      finalized: m.finalized,
      // L3 soft-close visibility for the supervised dashboard (extendsRemaining derived from the cap;
      // UNKNOWN when the cap was never surfaced). Inert (all defaults) on hard-close / soft-off monitors.
      softStrategy: m.softStrategy,
      extendsObserved: m.extendsObserved,
      extendCap: m.extendCap,
      extendsRemaining: m.extendCap != null ? Math.max(0, m.extendCap - m.extendsObserved) : null,
      effectivelyHard: this._effectivelyHard(m),
      believedCloseAt: m.believedCloseAt,
      // Shared-account bid-budget state, so the console shows WHY a load stopped bidding with
      // revisions apparently in hand (capExhausted) or started with fewer than the static cap
      // (foreignBidsDetected). Additive fields; every existing key above is untouched.
      capExhausted: m.capExhausted,
      // The OTHER terminal state, and the console needs it for the same reason it needs
      // capExhausted: both show a load sitting armed, with budget and time in hand, placing nothing.
      // Without this the two are indistinguishable on screen, and they have opposite answers - one
      // is "the budget is gone", the other "SuperProcure will not take a bid on this load at all".
      loadNotBiddable: m.loadNotBiddable,
      // The THIRD stand-down state, same argument again: armed, budget intact, time on the clock,
      // placing nothing - and its answer is different from both neighbours. "The count was refused"
      // is the only one of the three the desk can clear themselves, so the console showing it is
      // what turns a silent stall into a one-step fix.
      quantityRefused: m.quantityRefused,
      foreignBidsDetected: m.foreignBidsDetected,
      ownBidAttempts: m.ownBidAttempts,
      everBid: m.everBid, // durable across re-price/restart, unlike the two above
      // CW-229: display-only wall-clock mark for /track's pre-first-bid state. See
      // _pendingFirstBidAtMs - null for every monitor this fix does not hold.
      firstBidByMs: this._pendingFirstBidAtMs(m),
      lastSecondsCloseMs: this._lastSecondsCloseMs(m),
    }));
  }

  /**
   * The loads this engine OWNS but is not yet watching: priced, scheduled, wake timer set,
   * no monitor until startsAt - armLeadMs. schedule() deliberately creates no monitor (see
   * above), so snapshot() - which maps this.monitors - structurally cannot show them, and an
   * operator who has just priced a not-yet-open load sees it on NEITHER console tab: the
   * price-request row is 'armed' so the worklist filters it out, and Live Bids renders only
   * snapshot(). That gap between "operator prices it" and "window opens" is a median ~24
   * minutes of no confirmation the bot will fire, which invites a manual duplicate bid.
   *
   * Deliberately a SEPARATE method rather than folding these rows into snapshot(): snapshot()
   * is not merely presentational. It drives teardownStack()'s and /api/sim/reset's stop-all
   * loops, the /api/auctions/:loadId/stop 404 gate (hasMonitor), engineStatus().armed, and the
   * public /track page's bot state. Widening it would quietly change all five. Callers that
   * want the pre-start rows opt in; every existing caller keeps identical semantics.
   *
   * Read-only: builds display rows from the durable intents, arms nothing, cancels nothing.
   */
  scheduledSnapshot() {
    const now = Date.now();
    const out = [];
    for (const it of this.scheduler.activeIntents()) {
      if (it.status !== 'scheduled') continue;       // armed/bidding are snapshot()'s
      if (this.monitors.has(it.auctionId)) continue; // the wake already fired -> snapshot() owns it
      if (this.closeUnknownHeld.has(it.auctionId)) continue; // no wake will fire; the desk was told to quote it by hand
      const ladder = Array.isArray(it.ladder) ? it.ladder : [];
      out.push({
        auctionId: it.auctionId,
        lane: it.lane,
        points: it.points || null,
        equipment: it.equipment,
        units: it.units,
        companyName: it.companyName,
        startsAt: it.startsAt != null ? it.startsAt : null,
        closesAt: it.closesAt,
        status: 'scheduled',
        scheduled: true, // the discriminator the console renders on; monitor rows never carry it
        startsInMs: it.startsAt != null ? Math.max(0, it.startsAt - now) : null,
        closesInMs: it.closesAt != null ? Math.max(0, it.closesAt - now) : null,
        // No monitor yet, so there is genuinely nothing observed to report. These stay null/empty
        // rather than being omitted, so a scheduled row is shape-compatible with a monitor row and
        // the console can render one table over both.
        myRank: null,
        totalBidders: 0,
        revisionsLeft: null,
        ladder,
        floor: ladder.length ? ladder[ladder.length - 1] : null,
        currentRungIndex: -1,
        firedRungs: [],
        lastBidPrice: null,
        stoodDown: false,
        won: null,
        finalized: false,
      });
    }
    return out;
  }
}

// decrementViolations is re-exported, not defined here - it lives in ./pricing with the rest of the
// descending-ladder maths (the boundary CLAUDE.md states). The re-export is kept so existing
// importers that reach for it through the engine keep working after the move.
// DEFAULT_SOFT is exported for ONE reason: scripts/test-softclose-config-roundtrip.js reads its key
// list at runtime to assert that setSoftClose's object literal lists every one of them. Hardcoding
// that list in the test would defeat the point - the invariant has to notice a field added here and
// forgotten there, which is exactly how lastResortFloorAttempts went missing. Nothing in src/ reads
// this export; it is not a config seam.
module.exports = { BidEngine, DEFAULTS, DEFAULT_SOFT, decrementViolations };
