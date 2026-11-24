'use strict';
/**
 * Driver for the production SuperProcure engine (src/engine/bidEngine.js).
 *
 * WHY IT DRIVES `_decide` DIRECTLY RATHER THAN `_tick`
 * BidEngine has no clock injection seam. `_tick` reschedules itself with setTimeout and stamps
 * events with Date.now(), so letting the timer chain run would make every replay depend on this
 * machine's wall clock — the exact non-determinism this harness exists to eliminate (and this
 * machine's clock drift flips sign day to day).
 *
 * The decision logic reads the auction clock ONLY from the state object the adapter hands it
 * (`closesInMs` / `closesAtMs`), so a replay driven off harness-built states is DETERMINISTIC:
 * the same auction produces byte-identical output every run. That determinism — not a
 * zero-wall-clock-read count — is what the suite actually asserts (two real-driver runs compared
 * byte-for-byte in scripts/test-replay-harness.js > "SP engine driver, real BidEngine"). The
 * engine's `emit()` stamps some alert events with Date.now(), so a clock read can happen without
 * ever influencing a decision or reaching a reported field; the determinism check is therefore on
 * the OUTPUT, not on a global read count. Driving `_decide` exercises the REAL production decision
 * path, the same idiom the existing suite uses (scripts/test-softclose-extend-sequences.js).
 *
 * WHAT IS NOT EXERCISED, and must not be claimed as covered: `_tick`'s polling cadence, the
 * finalize debounce, the inter-fire rate gate and the min-decrement guard in `_maybeBid`, wake
 * scheduling, and rehydrate. Those are timer-domain and wire-domain behaviours; this harness covers
 * the decision domain — so accepted-bid counts here are LOOSER than the platform's, which enforces
 * min-decrement on the wire.
 */
const { BidEngine } = require('../../src/engine/bidEngine');

/**
 * In-memory stand-in for DurableScheduler. arm() reads and writes the scheduler for its restart
 * bookkeeping, but a replay never depends on that bookkeeping and never restarts. Keeping it in
 * memory — one fresh store per driver instance — is what makes the replay both SAFE and CORRECT:
 *   - SAFE: the production scheduler persists the full intent (pricing cost/margins, the rung
 *     ladder, companyName, pickup/drop addresses and the real load id) to a file in os.tmpdir().
 *     A stub writes nothing to disk, so no pricing ever leaves the process and there is no
 *     world-readable temp file and no interrupted-run cleanup to get wrong.
 *   - CORRECT: DurableScheduler._load() rehydrates whatever the file holds on construction, so a
 *     shared file leaked one run's `everBid`/intent into the next. A per-instance in-memory store
 *     cannot contaminate a sibling run.
 */
class StubScheduler {
  constructor() {
    this.intents = new Map();
    this.loadCorrupted = false;
  }
  hadLoadError() { return false; }
  get(auctionId) { return this.intents.get(auctionId); }
  upsert(intent) {
    const now = Date.now();
    const existing = this.intents.get(intent.auctionId);
    const merged = Object.assign({ createdAt: now }, existing, intent, { updatedAt: now });
    this.intents.set(intent.auctionId, merged);
    return merged;
  }
  update(auctionId, patch) {
    const existing = this.intents.get(auctionId);
    if (!existing) return null;
    Object.assign(existing, patch, { updatedAt: Date.now() });
    return existing;
  }
  get_all() { return [...this.intents.values()]; }
  all() { return [...this.intents.values()]; }
  activeIntents() {
    return [...this.intents.values()].filter((i) => i.status !== 'closed' && i.status !== 'stopped');
  }
  remove(auctionId) { this.intents.delete(auctionId); }
}

/** No-op retained for the run-replay.js call sites. The stub scheduler writes no files to clean. */
function cleanup() { /* nothing to remove — the scheduler is in-memory */ }

/**
 * @param {object} opts
 *   softClose   {enabled, shippers, mode, reserve} — passed straight to BidEngine
 *   config      engine config overrides
 *   companyName shipper name used for the soft-close allowlist gate
 *   cost        cost basis for the margin-band ladder
 *   marginsPct  margin band
 */
function createSpEngineDriver(opts = {}) {
  const name = opts.name || 'sp-bidEngine';
  return {
    name,

    init(ctx) {
      // The engine and its scheduler log to stdout with WALL-CLOCK timestamps, which would both
      // pollute the report and destroy its byte-for-byte reproducibility. The logger re-reads this
      // on every call, so setting it here is sufficient and takes effect immediately.
      process.env.LOG_LEVEL = 'silent';

      // A stub adapter: the harness owns all state, so no adapter method may be reached. placeBid
      // throwing is deliberate — if the engine ever routes a write through the adapter during a
      // replay we want a loud failure, not a silent live-money path.
      const adapter = {
        capabilities: () => ({
          standingPriceVisible: false,
          minDecrement: ctx.limits.minDecrement || 100,
          revisionLimit: ctx.limits.revisionLimit || 30,
          closeModel: 'unknown',
        }),
        ensureSession: async () => ({}),
        getAuctionState: async () => ({ ok: false }),
        placeBid: async () => { throw new Error('replay: placeBid must never be reached'); },
      };

      const eng = new BidEngine(adapter, new StubScheduler(), {
        config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 }, opts.config || {}),
        softClose: Object.assign(
          { enabled: true, shippers: [opts.companyName || 'Havells'], mode: 'live', reserve: 1 },
          opts.softClose || {},
        ),
        onEvent: () => {},
      });

      const cost = opts.cost != null ? opts.cost : ctx.floor;
      const marginsPct = opts.marginsPct || [12.6, 7.2, 6.3];

      const meta = {
        // True auction identity — segment for a reconstructed GoComet timeline, the scenario id for
        // an SP scenario — so two segments of one enquiry, or the two policy passes over one
        // auction, never share an intent key.
        id: String(
          ctx.auction.scenarioId
          || (ctx.auction.enquiryKey != null ? `${ctx.auction.enquiryKey}#${ctx.auction.segment}` : null)
          || ctx.auction.loadId
          || 'replay',
        ),
        lane: { origin: 'REPLAY', destination: 'REPLAY' },
        units: (ctx.auction.limits && ctx.auction.limits.units) || 1,
        companyName: opts.companyName || ctx.auction.companyName || 'Havells',
        branchName: ctx.auction.branchName || null,
        // Seed the close belief at the ORIGINAL close, not the final one. arm() copies meta.closesAt
        // into monitor.believedCloseAt, and _observeExtension counts a real extension only when the
        // live close jumps FORWARD past that belief. Seeding it at finalCloseMs would make every
        // jump <= 0, so no extension is ever counted and the snipe gate the replay measures never
        // arms. (closesInMs, also seeded from this, is overwritten on the first tick.)
        closesAt: ctx.auction.originalCloseMs != null ? ctx.auction.originalCloseMs : ctx.auction.finalCloseMs,
      };

      const monitor = eng.arm(meta, { cost, marginsPct });

      // Detach the self-rescheduling tick chain. Without this the engine drives itself off the
      // real clock in the background and the replay is no longer deterministic.
      if (monitor.timer) clearTimeout(monitor.timer);
      monitor.timer = null;

      // Anchor the extension-detection belief at the original close explicitly (belt-and-suspenders
      // against any future change to how arm() seeds believedCloseAt).
      monitor.believedCloseAt = meta.closesAt;

      monitor.closeModel = ctx.limits.closeModel === 'unknown' ? 'soft' : ctx.limits.closeModel;
      monitor.revisionsLeft = ctx.limits.revisionLimit;

      return { eng, monitor };
    },

    onTick(state, obs) {
      const { eng, monitor } = state;

      // Mirror the order _tick uses: surface extension state first, then decide.
      eng._observeExtension(monitor, obs);

      monitor.closeModel = obs.closeModel === 'unknown' ? monitor.closeModel : obs.closeModel;
      monitor.myRank = obs.myRank;
      monitor.totalBidders = obs.totalBidders;
      monitor.revisionsLeft = obs.revisionsLeft;
      monitor.closesInMs = obs.closesInMs;

      return eng._decide(monitor, obs);
    },

    onResult(state, result) {
      if (!result.accepted) return;
      // Advance monitor state exactly as _maybeBid's accepted-bid path does (bidEngine.js ~1890),
      // so the rung ladder actually progresses across ticks. Without the rung/snipe/defend advance
      // below, monitor.currentRungIndex stays -1 forever and _decide is pinned in its establish
      // branch — the defend and snipe paths the replay exists to measure are never reached.
      const m = state.monitor;
      const d = result.decision || {};
      m.lastBidPrice = result.price;
      m.everBid = true;
      m.landedBids = (m.landedBids || 0) + 1;
      if (d.rungIndex != null) {
        m.currentRungIndex = Math.max(m.currentRungIndex, d.rungIndex);
        m.firedRungs.add(d.rungIndex);
      }
      if (d.snipe) m.snipeFired = true;
      if (d.defend) m._lastDefendAtExtend = m.extendsObserved;
      // NB: monitor.revisionsLeft is re-seeded from obs on every onTick, so a decrement here would
      // be a dead write. The harness owns the revision budget (see harness.js run()).
    },

    finalize() { /* nothing to tear down per-run; the scheduler is in-memory */ },
  };
}

module.exports = { createSpEngineDriver, cleanup };
