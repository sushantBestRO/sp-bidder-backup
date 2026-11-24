'use strict';

/**
 * PlatformAdapter — THE SEAM.
 *
 * This is the only part of the system that knows anything platform-specific. The bidding engine,
 * scheduler, pricing and dashboard all talk to this interface and nothing else. Today it is backed
 * by MockSuperProcureAdapter (a faithful reverse-auction simulator). When we have the captured
 * HAR from a real SuperProcure account, we write RealSuperProcureAdapter against the same five
 * methods and swap it in `src/config.js` — the engine does not change.
 *
 * Everything we flagged as "unknown until we're inside the account" lives behind this interface:
 *   - login/session model            -> login() / ensureSession()
 *   - the load/enquiry list endpoint -> listAuctions()
 *   - live rank + countdown endpoint -> getAuctionState()
 *   - bid-write + min-decrement rule -> placeBid() + capabilities.minDecrement
 *   - rank-only vs L1-visible        -> capabilities.standingPriceVisible
 *   - hard vs soft (anti-snipe) close-> reported per-auction in getAuctionState()
 *
 * A reverse auction here means: LOWEST price wins. Rank 1 (L1) = current lowest = winning. The
 * engine's whole job is to be L1 at close without going below the operator's cost floor.
 */
class PlatformAdapter {
  /**
   * capabilities — static facts about the platform the engine needs in order
   * to choose a strategy. The real adapter fills these in from what the HAR /
   * live recon tells us.
   *
   * @returns {{
   *   standingPriceVisible: boolean, // can we read the current L1 *price*, or only our own rank?
   *   minDecrement: number,          // smallest legal amount below standing best (0 if unknown / not enforced)
   *   allowsTieRate: boolean,        // SuperProcure forbids equal rates -> false
   *   revisionLimit: number|null,    // max bid revisions per auction (null = unknown/unlimited)
   *   closeModel: 'hard'|'soft'|'unknown', // soft = anti-snipe auto-extension
   *   biddingEnabled: boolean,       // is this adapter configured to place bids AT ALL?
   *   settledOutcomeRequiresOwnPosition?: boolean // verify bot bids and observed shared-login positions
   * }}
   *
   * `biddingEnabled: false` means placeBid refuses before any network call, for the whole process
   * lifetime — a portal wired for discovery before its write path is turned on. It is NOT the
   * kill-switch's `writeEnabled` backstop, which is runtime state and resumable. The distinction
   * matters upstream: arming a load on an adapter that cannot bid tells the desk the load is being bid
   * when it never will, so armFromRequest refuses the arm rather than letting a monitor walk a
   * ladder every rung of which throws. Absent is read as TRUE, so an adapter predating this field
   * (and every hand-rolled test double) behaves exactly as before.
   */
  capabilities() {
    throw new Error('not implemented');
  }

  /** Establish a session (may trigger OTP). Returns a Session-shaped object. */
  async login() { throw new Error('not implemented'); }

  /** Refresh/re-auth proactively if the session is near expiry. Idempotent. */
  async ensureSession() { throw new Error('not implemented'); }

  /**
   * List auctions/loads currently open to this transporter.
   *
   * CLOSE MODEL IS PART OF THIS CONTRACT, and it is stated with the two BOOLEANS below — not with
   * the `closeModel` string that capabilities() and getAuctionState() use. Those are adapter- and
   * state-level vocabulary; on a LOAD the scope gate (discovery.isOutOfHardCloseScope), the
   * persisted price-request snapshot, and snipeHarness all read `softClose` + `closeModelKnown`.
   * An adapter that omits them leaves the gate comparing `undefined`, which reads as "hard close,
   * in scope" — a soft/extending auction admitted onto a hard-close-only deployment. Set both on
   * every mapped load: `closeModelKnown` false whenever the platform did not let you establish the
   * model, so the gate can fail closed instead of guessing.
   *
   * @returns {Promise<Array<{
   *   id: string,
   *   lane: { origin: string, destination: string },
   *   equipment: string,        // e.g. "32ft SXL", "20ft container"
   *   units: number,
   *   status: 'open'|'closed',
   *   closesAt: number,         // epoch ms (the platform's own deadline)
   *   softClose: boolean,       // true = the deadline can auto-extend (anti-snipe / reactive countdown)
   *   closeModelKnown: boolean  // false = could not be established -> held OUT of scope, never guessed
   * }>>}
   */
  async listAuctions() { throw new Error('not implemented'); }

  /**
   * Live state for one auction. This is the hot-path poll target.
   * `closesInMs` is the platform's own relative countdown — the engine fires
   * off THIS, latency-compensated, never off the local wall clock (clock-skew
   * is what kills snipers; trusting the server countdown dissolves it).
   *
   * @param {string} auctionId
   * @returns {Promise<{
   *   myRank: number|null,         // our current rank; 1 = winning, null = no bid yet
   *   totalBidders: number,        // how contested (for the dashboard / strategy)
   *   standingL1Price: number|null,// current lowest price IF the platform exposes it, else null
   *   closesInMs: number,          // server's relative countdown, ms
   *   revisionsLeft: number|null,  // remaining bid revisions, null if not tracked
   *   closeModel: 'hard'|'soft',   // observed close behaviour for this auction
   *   ok: boolean,                 // false on transient fetch failure (engine skips the tick, no crash)
   *   measuredRttMs: number        // round-trip of this very call, for latency compensation
   * }>}
   */
  async getAuctionState(auctionId) { throw new Error('not implemented'); }

  /**
   * Place (or revise) a bid. MUST be safe to call; the engine guards against
   * double-fire but the adapter should also reject an out-of-policy price.
   *
   * @param {string} auctionId
   * @param {number} price   per-unit price the engine decided
   * @returns {Promise<{
   *   accepted: boolean,
   *   myRank: number|null,
   *   revisionsLeft: number|null,
   *   reason: string|null,     // why rejected (e.g. 'not_below_standing', 'below_min_decrement', 'closed')
   *   latencyMs: number
   * }>}
   */
  async placeBid(auctionId, price) { throw new Error('not implemented'); }
}

/**
 * Is a load's POSTED close time provisional - a number this portal may move forward again, with
 * nothing bounding how many times? A portal that says yes has no final deadline until the auction
 * actually stops, so any record keyed on the close captured at discovery is keyed on a guess.
 *
 * Read as a DECLARATION, never inferred from a platform name (MULTI_PLATFORM_ARCHITECTURE.md
 * invariants 2 and 7): a soft close whose ceiling is declared `null` - "no cap exists". The
 * null-vs-omitted doctrine the capability itself carries is what makes this precise, and it is why
 * an absent key must NOT satisfy it: absent means the ceiling is simply unknown, which is a
 * different fact from "there is no ceiling", and collapsing the two is what makes a capped soft
 * close and an uncapped one read identically. SuperProcure's cap is a per-BRANCH number that rides
 * the load, so its adapters declare closeModel 'unknown' and no ceiling key - they are excluded
 * structurally rather than by an exemption someone can later delete.
 */
function closeIsProvisional(caps) {
  return !!caps && caps.closeModel === 'soft' && caps.extensionCeiling === null;
}

// Widest single forward close-time move any declaration may buy, in ms. The declared increment is
// an adapter-owned number that grows: it can be seeded from operator config and raised again as a
// portal is observed, so treating it as the bound unclamped lets config or a learned value widen
// the one wall standing between a real extension and a corrupt close. An hour is over half the
// entire extension career of the worst load on record (22 rounds, ~1h50m past its posted close), so
// a SINGLE observation claiming more than this is not an extension. Clamping rather than refusing
// keeps the tight direction: a genuine move wider than this is simply not rescued, which is exactly
// what happens today.
const MAX_HONOURED_EXTENSION_MS = 3_600_000;

/**
 * The portal's own declared per-round extension increment, in ms, clamped to what a single refresh
 * may honour; null when it declares none. This is the only thing that can bound how far one refresh
 * pushes a close, so a portal that declares no increment gets no refresh at all rather than an
 * invented bound.
 */
function declaredExtensionIncrementMs(caps) {
  const ms = caps && Number(caps.extensionIncrementMs);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_HONOURED_EXTENSION_MS) : null;
}

module.exports = { PlatformAdapter, closeIsProvisional, declaredExtensionIncrementMs, MAX_HONOURED_EXTENSION_MS };
