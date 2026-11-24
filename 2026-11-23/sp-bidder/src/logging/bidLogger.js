'use strict';

/**
 * BidLogger - Phase-5 BASE operational logging (Module 1, our-side only).
 *
 * Subscribes to the engine's event stream and persists, through the store seam:
 *   - a queryable `closedBids` collection (one doc per auction we armed), holding
 *     OUR bids (price/rung/rank/ts/latency), the final rank + won/lost outcome,
 *     and the load meta. This is what the History panel reads + the restart-safe
 *     operational record.
 *   - an append-daily `bids` JSONL stream (the un-backfillable day-1 operational
 *     log) carrying the same our-side events.
 *
 * SCOPE (do not cross): this records OUR bids + outcomes ONLY. The full competitor
 * ladder (`ladder_frame`) is the +60k winner-foundation slice and is deliberately
 * NOT captured here (see docs/MODULE_1_BUILD_PLAN.md Phase 5). Keep base base.
 *
 * Writes are serialized through a single tail promise so a burst of bid_placed
 * events can't race a read-modify-write on the same doc.
 */

// ownedBy is the ONE portal-ownership predicate (priceRequests.js). It reads only `.platformKey`,
// so it applies unchanged to a closedBids record, and reusing it is what keeps "which portal owns
// this row" to a single definition across two collections rather than two drifting ones.
const { ownedBy, platformOf } = require('../pricing/priceRequests');
const { RESULT_FACT_KEYS, lastBidAtLowestMargin, resultReasonOf } = require('../util/reportedClose');
const { closedOutcome } = require('../util/closedOutcome');

const COLLECTION = 'closedBids';
const STREAM = 'bids';

class BidLogger {
  constructor({ store, log = () => {} }) {
    this.store = store;
    this.log = log;
    this._tail = Promise.resolve(); // serializes handle() so concurrent events don't clobber a doc
  }

  /** Enqueue an engine event. Fire-and-forget from the engine's onEvent; ordered + crash-safe here. */
  handle(evt) {
    this._tail = this._tail.then(() => this._handle(evt)).catch((e) => {
      this.log(`[bidlog] handle ${evt && evt.type} failed: ${e && e.message}`);
    });
    return this._tail;
  }

  /**
   * The desk's upward cost correction, against the load it corrects.
   *
   * Goes through the same serializing tail as the engine events, because the re-price that produces
   * it also emits an 'armed' whose _onArmed is a full putDoc replace - written off the tail this
   * would race that replace and be lost about half the time.
   */
  noteCostCorrection(auctionId, info) {
    this._tail = this._tail.then(() => this._noteCostCorrection(auctionId, info)).catch((e) => {
      this.log(`[bidlog] cost correction on ${auctionId} failed: ${e && e.message}`);
    });
    return this._tail;
  }

  async _noteCostCorrection(auctionId, { from, to, standingBidPrice, resumed = false, reason = null } = {}) {
    const id = String(auctionId);
    const rec = await this.store.getDoc(COLLECTION, id);
    if (!rec || rec.status === 'closed') return null;
    const entry = { from, to, standingBidPrice, at: Date.now() };
    // `reason` is the ONLY thing that marks this as a genuine hold-lifecycle event (entering a
    // hold, or resuming from one) rather than an ordinary correction on a load that was never
    // held (e.g. an unheld downward re-price) - callers that are not the hold path pass no reason
    // at all, and B112's hold-undercut classifier reads exactly this field, never bare presence in
    // the trail.
    if (resumed) entry.reason = 'resumed_by_desk';
    else if (reason) entry.reason = reason;
    const trail = Array.isArray(rec.costCorrections) ? rec.costCorrections : [];
    return this.store.patchDoc(COLLECTION, id, {
      // `costCorrection` is the LIVE override notify/bidTimeCost reads as "the cost that priced the
      // bid" on a record whose last bid carries no bidTimeCost snapshot - the per-bid snapshot wins
      // where it exists. A resume puts the original cost back on the plan, so that cost IS rec.cost
      // again and the override has to go - leaving it would make the close receipt divide the
      // landed bid by a number the desk had already withdrawn. The trail beside it is append-only,
      // so retiring the override never costs the record a correction that really happened.
      costCorrection: resumed ? null : entry,
      costCorrections: trail.concat([entry]),
    });
  }

  async _handle(evt) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case 'armed': return this._onArmed(evt);
      case 'bid_placed': return this._onBid(evt);
      case 'bid_rejected': return this._onRejected(evt);
      case 'bid_unconfirmed': return this._onUnconfirmed(evt);
      case 'rung_discarded': return this._onRungDiscarded(evt);
      case 'auction_result': return this._onResult(evt);
      case 'closed_while_down': return this._onClosedWhileDown(evt);
      case 'rank_visible': return this._onRankVisible(evt);
      case 'walk_timing_miss': return this._onWalkTimingMiss(evt);
      default: return;
    }
  }

  async _onArmed(e) {
    const id = String(e.auctionId);
    const existing = await this.store.getDoc(COLLECTION, id);
    // A REAL result is final; an unknown close is only a doubt-stamp, and a re-arm outranks it.
    // _onClosedWhileDown closes the record, which is new - and the desk is told to go look at exactly
    // those loads, so re-pricing one is the expected next step. That path is stop() + a fresh monitor
    // + a fresh 'armed', and without this the rebuild was skipped and _onBid then dropped every
    // bid_placed of the new ladder: the auction could be won at a price the ledger never recorded,
    // with History, both exports and Realized Margin % all reading the pre-retirement bid. The
    // rebuild below writes status 'open' and omits closedWhileDown, so the reopen clears the doubt.
    if (existing && existing.status === 'closed' && existing.closedWhileDown !== true) {
      this.log(`[bidlog] armed for ${id} ignored - the record already carries a final result`);
      return;
    }
    const rec = {
      auctionId: id,
      // owning SP account ({accountId, label}); only set when >1 account runs, so
      // single-account records stay byte-identical to today.
      account: e.account || (existing && existing.account) || null,
      lane: e.lane || (existing && existing.lane) || null,
      points: e.points || (existing && existing.points) || null, // full pickup/drop addresses
      equipment: e.equipment || (existing && existing.equipment) || null,
      units: e.units != null ? e.units : (existing && existing.units != null ? existing.units : null),
      shipper: e.companyName || (existing && existing.shipper) || null,
      // which portal this auction came from (carried from the price request via armFromRequest's
      // meta -> the engine's 'armed' event); absent here means SP by the same construction argument
      // as priceRequests.platformOf - see that function's comment for why the fallback is safe.
      platformKey: e.platformKey || (existing && existing.platformKey) || null,
      // D038: the branch ROUTING key rides several other engine events already (see bidEngine.js)
      // but never reached the 'armed' event, so closedBids never carried it - the durable record
      // could not say which branch a load belonged to once its price request was pruned.
      branchName: e.branchName || (existing && existing.branchName) || null,
      cost: e.cost != null ? e.cost : null,
      costFloor: e.costFloor != null ? e.costFloor : null,
      floor: e.floor != null ? e.floor : null,
      ladder: e.ladder || null,
      // A3: SP's OWN published lane-freight anchor ({ftl, pmt, freightRate}). Carried forward from
      // an existing doc when a rehydrate/re-arm emits an armed event without it (same lazy
      // carry-forward discipline as shipper/points above), so a mid-auction restart never wipes a
      // captured anchor. Absent on the 172 pre-existing records -> null (additive, byte-safe).
      laneFreight: e.laneFreight || (existing && existing.laneFreight) || null,
      // BC-28: the truck-vs-PMT basis, carried the same lazy way (a rehydrate/re-arm's event may
      // omit it, and a mid-auction restart must not wipe a value the first arm already captured).
      // Absent on every pre-existing record -> null (additive, byte-safe) - a report reading this
      // doc after its price request has aged out then has no basis to scale a per-vehicle figure
      // by, and must count the load as having no value rather than guess one.
      quoteType: e.quoteType || (existing && existing.quoteType) || null,
      // D038: the seven fields the durable outcomes store never carried because they only ever
      // lived on the short-retention price-request store - once that record was pruned (~7 days
      // after close), an export or reconciliation for an older load was permanently missing them.
      // Carried forward from an existing doc the same lazy way as laneFreight/shipper above, so a
      // mid-auction restart or re-price never wipes a value the FIRST arm already captured.
      loadCode: e.loadCode != null ? e.loadCode : ((existing && existing.loadCode != null) ? existing.loadCode : null),
      distanceKm: e.distanceKm != null ? e.distanceKm : ((existing && existing.distanceKm != null) ? existing.distanceKm : null),
      weight: e.weight != null ? e.weight : ((existing && existing.weight != null) ? existing.weight : null),
      weightUnit: e.weightUnit || (existing && existing.weightUnit) || null,
      capturedAt: e.capturedAt != null ? e.capturedAt : ((existing && existing.capturedAt != null) ? existing.capturedAt : null),
      marginSource: e.marginSource || (existing && existing.marginSource) || null,
      marginsPct: e.marginsPct || null,
      minMarginPct: e.minMarginPct != null ? e.minMarginPct : null,
      armedAt: (existing && existing.armedAt) || e.ts || Date.now(),
      ourBids: existing && Array.isArray(existing.ourBids) ? existing.ourBids : [],
      gcUnconfirmedSubmissions: e.gcUnconfirmedSubmissions || (existing && existing.gcUnconfirmedSubmissions) || [],
      lastBidPrice: existing && existing.lastBidPrice != null ? existing.lastBidPrice : null,
      finalRank: null,
      won: null,
      closeModel: (existing && existing.closeModel) || null,
      closedAt: null,
      status: 'open',
    };
    // A restart re-enters arm() for every still-live auction (rehydrate -> arm -> emit 'armed'),
    // so _onArmed rebuilds the open doc. putDoc is a full replace and the literal above omits
    // rejectedBids to stay byte-identical when there are none - carry it forward lazily (same as
    // ourBids/lastBidPrice) so a deploy mid-auction doesn't wipe a doc-level rejection trace.
    if (existing && Array.isArray(existing.rejectedBids) && existing.rejectedBids.length) {
      rec.rejectedBids = existing.rejectedBids;
    }
    if (existing && Array.isArray(existing.skippedRungs) && existing.skippedRungs.length) {
      rec.skippedRungs = existing.skippedRungs;
    }
    // A RE-PRICE MUST NOT LEAVE A RECORD THAT CONTRADICTS ITSELF. putDoc is a full replace, so the
    // superseded cost/ladder/band were simply gone while ourBids - placed against them - carried
    // forward. That produced rows whose winning bid is not on their own ladder at all (260908LD2Z:
    // cost 38000, ladder [41420,40736,38684], winning bid 31610), and it is structural rather than
    // a loss-case artefact (260908A2W4: cost 90000, first bid 130800). The bids were correct for
    // the ladder that existed when they fired; only the record of that ladder was destroyed.
    //
    // So each superseded pricing epoch is kept beside the current one, and the reader never has to
    // divide a bid by a margin to recover what it was priced from - which is what the 2026-09-08
    // forensic reconstruction had to do.
    //
    // The trigger is the PRICED PLAN changing, not the cost. Gating on cost alone leaves the two
    // re-price shapes that rebuild the ladder at an unchanged cost - "Revert to standard margins"
    // (clearBidOverride) and a margin-only override - producing exactly the contradictory row this
    // block exists to prevent, and an absent costHistory would then read as "never re-priced",
    // which is a false claim rather than a silent one. A restart or scheduled re-arm re-emits an
    // identical plan, so it still records nothing, and a load that was never re-priced stays
    // byte-identical to today - the field is absent, not an empty array.
    //
    // `ourBidsBefore` is the join, and it is CUMULATIVE: it counts every bid placed before this
    // epoch ended, not the bids placed under it. So epoch i owns
    // ourBids[epochs[i-1].ourBidsBefore .. epochs[i].ourBidsBefore - 1] (from 0 for the first
    // epoch), and the current plan owns ourBids[last.ourBidsBefore ..].
    const priorEpochs = (existing && Array.isArray(existing.costHistory)) ? existing.costHistory : [];
    const samePlan = existing
      && existing.cost === rec.cost
      && existing.floor === rec.floor
      && JSON.stringify(existing.ladder || null) === JSON.stringify(rec.ladder || null);
    const planChanged = !!existing && !samePlan;
    if (priorEpochs.length || planChanged) {
      rec.costHistory = planChanged
        ? priorEpochs.concat([{
          cost: existing.cost != null ? existing.cost : null,
          costFloor: existing.costFloor != null ? existing.costFloor : null,
          floor: existing.floor != null ? existing.floor : null,
          ladder: existing.ladder || null,
          marginsPct: existing.marginsPct || null,
          minMarginPct: existing.minMarginPct != null ? existing.minMarginPct : null,
          ourBidsBefore: Array.isArray(existing.ourBids) ? existing.ourBids.length : 0,
          supersededAt: e.ts || Date.now(),
        }])
        : priorEpochs;
    }
    // Same lazy carry-forward, and load-bearing here: the re-arm that follows a correction emits the
    // 'armed' this replaces the doc from, so without it the correction is erased by the very event
    // it caused - and the close receipt goes back to reporting the corrected rate as the bid's own.
    if (existing && existing.costCorrection) rec.costCorrection = existing.costCorrection;
    // The append-only trail carries forward independently of the live override above, because a
    // resume NULLS that override and would otherwise take every earlier correction with it.
    if (existing && Array.isArray(existing.costCorrections) && existing.costCorrections.length) {
      rec.costCorrections = existing.costCorrections;
    }
    await this.store.putDoc(COLLECTION, id, rec);
  }

  async _onUnconfirmed(e) {
    const rec = await this.store.getDoc(COLLECTION, String(e.auctionId));
    if (!rec || !e.submission || !e.submission.attemptId) return;
    const rows = [...(rec.gcUnconfirmedSubmissions || [])];
    const i = rows.findIndex(r => r.attemptId === e.submission.attemptId);
    if (i < 0) rows.push(e.submission); else rows[i] = { ...rows[i], ...e.submission };
    rec.gcUnconfirmedSubmissions = rows;
    await this.store.putDoc(COLLECTION, String(e.auctionId), rec);
    if (i < 0) await this.store.appendEvent('bids', { kind: 'bid_unconfirmed', auctionId: String(e.auctionId), ...e.submission });
  }

  async _onBid(e) {
    const id = String(e.auctionId);
    const rec = await this.store.getDoc(COLLECTION, id);
    // `establishing: false` is the engine's own late-bank marker (_recordLandedAfterRetire): a write
    // that was on the wire when the result was finalized and landed after it. It is on the board, so
    // it belongs on the closed record too (T6 D9); any other post-close bid is still dropped. A late
    // bank the engine marks landingUnconfirmed (a write that threw, nothing proving it landed) is
    // dropped too: booking it would turn a no-bid into a won load on a price the portal may not hold.
    if (!rec || (rec.status === 'closed' && (e.establishing !== false || e.landingUnconfirmed))) {
      // Never a bare drop on the post-price-page path. After _onArmed's reopen the only record still
      // closed here is one carrying a real result, so a bid arriving now is a genuine anomaly.
      const why = !rec ? 'no armed record exists'
        : e.establishing === false ? 'a write after the result that was not confirmed to have reached the portal'
          : 'the record already carries a final result';
      this.log(`[bidlog] bid_placed for ${id} dropped - ${why}`);
      return;
    }
    const bid = { price: e.price, rungIndex: e.rungIndex != null ? e.rungIndex : null, rank: e.rank != null ? e.rank : null, ts: e.ts || Date.now() };
    // A1: the existing `rank` above is the createV2 REST rank, which SP returns null on every bid.
    // `socketRank` is the LIVE socket rank we held when the bid fired (bidEngine stamps state.myRank).
    // Kept as a SEPARATE additive field - `rank` stays exactly as-is for byte-compat with the 380
    // existing entries; socketRank fills the column that was null everywhere. Our own rank only.
    bid.socketRank = e.socketRank != null ? e.socketRank : null;
    if (e.latencyMs != null) bid.latencyMs = e.latencyMs;
    // Which final-window walk decision sent it; absent with the walk off, so those records are unchanged.
    if (e.walk != null) bid.walk = e.walk;
    // P6: which of the two ways writeLandedAt (below) was reached, for the uncertain-outcome path
    // only - an ordinary accepted write carries neither. Lazily added, same as latencyMs above, so
    // every accepted-write record stays byte-identical to today.
    if (e.confirmedBy != null) bid.confirmedBy = e.confirmedBy;
    else if (e.unconfirmed) bid.unconfirmed = true;
    // The desk cost this bid's ladder was built from, stamped at fire time. The doc-level `cost` is
    // last-writer-wins, so after a re-price it holds a number this bid was never priced against -
    // which is how a bid placed at +9% came to be reported as a 16.82% loss (load 260908LD2Z).
    // null on a rate-model or mock arm, which carries no cost; consumers fall back to doc-level.
    bid.bidTimeCost = e.cost != null ? Number(e.cost) : null;
    // The floor that went with that cost. Stamped together so a reader can never pair one re-price's
    // cost with another's floor.
    bid.bidTimeMinMarginPct = e.minMarginPct != null ? Number(e.minMarginPct) : null;
    bid.bidTimeLowestMarginPct = e.lowestPct != null ? Number(e.lowestPct) : null;
    // How much of the auction was left when this bid went on the wire - the engine has always
    // emitted it and this record has always dropped it. It is the "gap between our last bid and the
    // close" the desk reads, and it is better than subtracting `ts` from a stored close, because
    // `ts` is this machine's clock and the close is the portal's, so that subtraction carries the
    // offset between the two.
    //
    // How much better depends on the platform, and the difference is worth knowing before building
    // on it. On GoComet this is the portal's own published countdown (`bid_closing_in`, read
    // straight off the body) and carries no local clock at all. On SuperProcure it is
    // spSocket.closesInMs, which computes `loadEndTime - serverNow()` where serverNow() is the local
    // clock plus a server offset - and that offset starts at zero and is REFUSED once the skew
    // reaches 90s, so a badly skewed box gets no correction and the skew rides in. So: clock-free on
    // GoComet, clock-corrected-but-not-clock-free on SuperProcure. Still the better of the two
    // available numbers on both, and the only one available at all on GoComet.
    bid.closesInMs = e.closesInMs != null ? Number(e.closesInMs) : null;
    const decidedAt = e.decidedAt != null ? Number(e.decidedAt) : null;
    if (decidedAt != null) bid.decidedAt = decidedAt;
    // P6 telemetry (rulings 35/48): the write-landed stamp travels with every bid_placed, so it is
    // set here like decidedAt above. rankVisibleAt is NOT - it is observed on a later tick, after
    // this bid is already on the record, and arrives through its own event (_onRankVisible) matched
    // back onto this same entry by decidedAt.
    const writeLandedAt = e.writeLandedAt != null ? Number(e.writeLandedAt) : null;
    if (writeLandedAt != null) bid.writeLandedAt = writeLandedAt;
    Object.assign(bid, budgetContext(e));
    // T6 BH-STATE-4: bid_placed carried no idempotency key, so a re-emitted event (an at-least-once
    // retry path, a replayed durable event) double-logged the same bid - inflating ourBids/attempts
    // and double-counting the participation fact exportModel/funnel both read off this array.
    // decidedAt alone is a millisecond clock stamp, not a fire identity: two genuine bids decided in
    // the same millisecond share it, and matching on it dropped a landed write. A repeat has to
    // match the whole fire - decision time, price, rung and landing time. Bids that carry no
    // decidedAt (an older/rate-model path) are not deduped.
    const alreadyLogged = decidedAt != null && (rec.ourBids || []).some((b) => b
      && b.decidedAt === decidedAt && b.price === bid.price && b.rungIndex === bid.rungIndex
      && (b.writeLandedAt != null ? b.writeLandedAt : null) === writeLandedAt);
    if (alreadyLogged) {
      this.log(`[bidlog] bid_placed for ${id} dropped - a bid decided at ${decidedAt} is already recorded (re-emitted event)`);
      return;
    }
    if (e.landedVsCloseMs != null) {
      bid.landedVsCloseMs = e.landedVsCloseMs;
      bid.closeSnapped = e.closeSnapped === true;
      bid.submitStartVsCloseMs = e.submitStartVsCloseMs != null ? e.submitStartVsCloseMs : null;
    }
    rec.ourBids = (rec.ourBids || []).concat(bid);
    // LOWEST WINS, the same rule the engine applies to the intent's landedBidPrice. ourBids keeps
    // every write at the price that really went on the wire; lastBidPrice is read as the price
    // STANDING on the board - directorEod's won value, eodReport's finalBid, the CSV exports - and a
    // write resolving out of send order (a bid banked after a re-price retired its monitor) would
    // otherwise raise that business record above what the portal holds, overstating a won load. The
    // ladder descends and each landed bid replaces the last, so on every in-order sequence the
    // lowest IS the latest and this changes nothing.
    const priorPrice = Number(rec.lastBidPrice);
    rec.lastBidPrice = (Number.isFinite(priorPrice) && priorPrice > 0 && priorPrice < e.price)
      ? priorPrice : e.price;
    await this.store.putDoc(COLLECTION, id, rec);
    await this.store.appendEvent(STREAM, {
      kind: 'bid_placed', auctionId: id,
      price: e.price, rungIndex: bid.rungIndex, rank: bid.rank, socketRank: bid.socketRank, latencyMs: e.latencyMs != null ? e.latencyMs : null,
      bidTimeCost: bid.bidTimeCost, bidTimeMinMarginPct: bid.bidTimeMinMarginPct, bidTimeLowestMarginPct: bid.bidTimeLowestMarginPct,
      ts: bid.ts, closesInMs: bid.closesInMs,
      ...(decidedAt != null ? { decidedAt } : {}),
      ...(writeLandedAt != null ? { writeLandedAt } : {}),
      ...budgetContext(e),
    });
  }

  /**
   * P6 telemetry: the rank this bid produced became visible on a later tick (bidEngine's
   * _maybeStampRankVisible). Matched back onto the ourBids entry sharing this event's decidedAt -
   * the same correlation key _onBid already stamped on that entry - and only when that entry has
   * no rankVisibleAt yet, so a marker resolved after a NEWER bid has already landed (and taken over
   * the monitor's one pending-rank slot) can never be misapplied here.
   *
   * Searched from the END: decidedAt is millisecond-resolution, and the marker always watches the
   * MOST RECENTLY landed bid, so two bids landed in the same millisecond must resolve onto the
   * later ourBids entry, never the earlier one a plain first-match find() would hit.
   */
  /** A walk that was outranked too late for a step to land: a timing loss if the load is lost. First one per load stands. */
  async _onWalkTimingMiss(e) {
    const id = String(e.auctionId);
    const rec = await this.store.getDoc(COLLECTION, id);
    if (!rec || rec.walkTimingMiss) return;
    await this.store.patchDoc(COLLECTION, id, { walkTimingMiss: { remainingMs: e.remainingMs, roundId: e.roundId || null,
      myRank: e.myRank != null ? e.myRank : null, at: e.ts || Date.now() } });
  }

  async _onRankVisible(e) {
    const id = String(e.auctionId);
    const rec = await this.store.getDoc(COLLECTION, id);
    if (!rec || !Array.isArray(rec.ourBids)) return;
    let bid = null;
    for (let i = rec.ourBids.length - 1; i >= 0; i--) {
      const b = rec.ourBids[i];
      if (b && b.decidedAt === e.decidedAt && b.rankVisibleAt == null) { bid = b; break; }
    }
    if (!bid) return;
    bid.rankVisibleAt = e.rankVisibleAt != null ? Number(e.rankVisibleAt) : Date.now();
    await this.store.putDoc(COLLECTION, id, rec);
  }

  /**
   * A bid that FIRED but SuperProcure REFUSED (HTTP 400/403/...). Before this handler existed a
   * rejection left no durable trace at all: it fell through _handle's default, so a
   * fired-and-rejected bid was byte-identical to a never-fired one (won:false, finalRank:null,
   * ourBids:[]) - which is exactly why a day of live 400s was indistinguishable from silence in
   * the jsonl. Record it two ways: a rejectedBids[] on the closedBids doc (so History can tell
   * "fired-and-rejected" from "never-fired"), and an un-backfillable line on the daily `bids`
   * stream (durable even when no armed record exists). carrierSent + httpStatus + the raw
   * platform body are captured so any future refusal self-documents from persisted data.
   *
   * rejectedBids[] is added lazily (only once a rejection actually occurs), so an auction that
   * never had one stays byte-identical to today's record - same discipline as _onArmed's meta.
   */
  async _onRejected(e) {
    const id = String(e.auctionId);
    const rejection = {
      price: e.price != null ? e.price : null,
      carrierSent: e.carrierSent != null ? e.carrierSent : null,
      httpStatus: e.status != null ? e.status : (e.httpStatus != null ? e.httpStatus : null),
      reason: e.reason != null ? e.reason : null,
      body: e.body != null ? e.body : null,
      rungIndex: e.rungIndex != null ? e.rungIndex : null,
      ts: e.ts || Date.now(),
      ...budgetContext(e),
    };
    // Attach to the armed doc only while it's still open (mirrors _onBid); a rejection that
    // arrives after close still lands on the jsonl below but never reopens a finalized record.
    const rec = await this.store.getDoc(COLLECTION, id);
    if (rec && rec.status !== 'closed') {
      rec.rejectedBids = (rec.rejectedBids || []).concat(rejection);
      await this.store.putDoc(COLLECTION, id, rec);
    }
    // Always append to the un-backfillable stream - a rejection must leave a trace regardless.
    // rungIndex rides the STREAM as well as the doc above. The stream is the un-backfillable half,
    // so a refusal that lands here without its ladder position can never be tied to one afterwards -
    // repeats of a single rung become indistinguishable attempts. `httpStatus` is the same
    // normalisation the doc uses (the engine emits `status`).
    await this.store.appendEvent(STREAM, {
      kind: 'bid_rejected', auctionId: id,
      price: rejection.price, carrierSent: rejection.carrierSent, httpStatus: rejection.httpStatus,
      reason: rejection.reason, body: rejection.body, rungIndex: rejection.rungIndex, ts: rejection.ts,
      ...budgetContext(e),
    });
  }

  /**
   * A rung the engine REFUSED TO SEND because the step sat under the load's minimum bid difference
   * and the portal would have rejected it. Never on the wire, so it is neither a bid nor a rejection
   * - and until this handler it was nothing at all: the guard returned bare, so a load that ran on
   * two of its three prices looked exactly like one that ran on three. That is the same blindness
   * rejectedBids[] exists to fix on the write side, and it gets the same two-sided treatment here.
   *
   * skippedRungs[] is added LAZILY, so a load that never discarded a rung stays byte-identical to
   * today's record - the same discipline _onArmed follows for rejectedBids.
   */
  async _onRungDiscarded(e) {
    const id = String(e.auctionId);
    const skipped = {
      price: e.price != null ? e.price : null,
      rungIndex: e.rungIndex != null ? e.rungIndex : null,
      lastBidPrice: e.lastBidPrice != null ? e.lastBidPrice : null,
      minDecrement: e.minDecrement != null ? e.minDecrement : null,
      gap: e.gap != null ? e.gap : null,
      reason: e.reason || 'min_decrement',
      ts: e.ts || Date.now(),
      ...budgetContext(e),
    };
    const rec = await this.store.getDoc(COLLECTION, id);
    if (rec && rec.status !== 'closed') {
      rec.skippedRungs = (rec.skippedRungs || []).concat(skipped);
      await this.store.putDoc(COLLECTION, id, rec);
    }
    await this.store.appendEvent(STREAM, {
      kind: 'rung_discarded', auctionId: id,
      price: skipped.price, rungIndex: skipped.rungIndex, lastBidPrice: skipped.lastBidPrice,
      minDecrement: skipped.minDecrement, gap: skipped.gap, reason: skipped.reason, ts: skipped.ts,
      ...budgetContext(e),
    });
  }

  async _onResult(e) {
    const id = String(e.auctionId);
    const rec = (await this.store.getDoc(COLLECTION, id)) || {
      auctionId: id, account: e.account || null, lane: e.lane || null, points: e.points || null,
      equipment: e.equipment || null, units: null,
      shipper: null, ourBids: [], lastBidPrice: null,
    };
    rec.finalRank = e.finalRank != null ? e.finalRank : null;
    // null is the engine saying the portal had not confirmed the result; false would say we lost.
    rec.won = e.won === null ? null : !!e.won;
    if (Array.isArray(e.gcUnconfirmedSubmissions) && e.gcUnconfirmedSubmissions.length) {
      const rows = new Map((rec.gcUnconfirmedSubmissions || []).map(r => [r.attemptId, r]));
      for (const row of e.gcUnconfirmedSubmissions) rows.set(row.attemptId, { ...row, ...(rows.get(row.attemptId) || {}) });
      rec.gcUnconfirmedSubmissions = [...rows.values()];
    }
    const verification = {};
    for (const key of ['resultBasis', 'resultObservedRank', 'resultTab', 'resultVerifiedAt', 'awardConfirmed']) {
      if (e[key] !== undefined) { rec[key] = e[key]; verification[key] = e[key]; }
    }
    rec.closeModel = e.closeModel || rec.closeModel || null;
    rec.closedAt = e.ts || Date.now();
    // The auction's OWN closing time, on the platform's clock (see the engine's _finalize emit).
    // `closedAt` above stays exactly as it was - it answers "when did we finalize", stamped off the
    // local machine clock and later than the real close by the finalize debounce. Two different
    // facts, so two fields rather than a redefinition of one every existing consumer already reads.
    // Carried forward when a result arrives without it, so a rate-model close cannot blank a value
    // an earlier result already established. Absent on every record predating this -> null.
    rec.finalCloseAt = e.finalCloseAt != null ? e.finalCloseAt
      : (rec.finalCloseAt != null ? rec.finalCloseAt : null);
    for (const k of RESULT_FACT_KEYS) if (e[k] !== undefined) rec[k] = e[k];
    if (e.round !== undefined) rec.round = e.round;
    if (e.lastReadBeforeCloseMs !== undefined) rec.lastReadBeforeCloseMs = e.lastReadBeforeCloseMs;
    if (e.latestAcceptedVsCloseMs !== undefined) rec.latestAcceptedVsCloseMs = e.latestAcceptedVsCloseMs;
    // A fought loss with attempts to spare and a last bid above the lowest band margin is a timing
    // defect signal, not a pricing one: kept on the record for ops and never put on a receipt.
    if (e.won === false && Number(e.landedBids) > 0 && e.attemptsAllowed != null
        && Number(e.landedBids) < Number(e.attemptsAllowed) && lastBidAtLowestMargin(rec) === false) {
      rec.lostWithAttemptsLeft = true;
      this.log(`[bidlog] ${id} lost with attempts left (${e.landedBids} of ${e.attemptsAllowed} used, last bid above the lowest band margin)`);
    }
    rec.resultReason = resultReasonOf(rec, { landedBids: e.landedBids, noBidReason: e.noBidReason });
    rec.status = 'closed';
    // An AUTHORITATIVE result outranks an earlier "we never saw the end" sweep, so the flag has to be
    // cleared here and not merely not-set. It is reachable in the direction that matters: a load the
    // sweep retired while the auction was in fact still running (the whole premise of the unreadable
    // retire - we cannot see it, and the alert tells the desk to go look) can be re-priced, which is
    // stop() + a fresh monitor, and then genuinely finalize. deriveStatus keys on the flag plus a
    // null rank, and _finalize writes a null rank whenever the last read fails - so a stale flag
    // would turn a real, fought close back into "unknown" and drop it out of the win-rate denominator.
    rec.closedWhileDown = false;
    if (rec.lane == null && e.lane) rec.lane = e.lane;
    if (rec.points == null && e.points) rec.points = e.points;
    if (rec.equipment == null && e.equipment) rec.equipment = e.equipment;
    await this.store.putDoc(COLLECTION, id, rec);
    await this.store.appendEvent(STREAM, { kind: 'auction_result', auctionId: id, won: rec.won, finalRank: rec.finalRank, ...verification,
      ...(e.lastReadBeforeCloseMs !== undefined ? { lastReadBeforeCloseMs: e.lastReadBeforeCloseMs } : {}) });
  }

  /**
   * Close a record whose OUTCOME was never observed - the auction ended while the process was down,
   * or the portal stopped answering for it long past the close.
   *
   * The flag has to reach THIS store, not just the scheduler's intents file, because this is the
   * document exportModel joins against: an orphan keeps landed bids and a null rank, and that shape
   * is indistinguishable from a fought loss without it. That is what put 52 GoComet auctions in the
   * loss column.
   *
   * `won` is written THROUGH, never coerced - the opposite of _onResult's `!!e.won` - because null
   * here means "not known" and false would mean "we lost", which is the assertion the whole path
   * exists to avoid making. A record that already settled is left exactly as it is: a real result
   * outranks a late sweep, and re-opening a closed record to stamp doubt on it would lose the truth.
   */
  async _onClosedWhileDown(e) {
    const id = String(e.auctionId);
    const rec = await this.store.getDoc(COLLECTION, id);
    // No record means this load never armed far enough to be logged, so there is nothing on any
    // reporting surface to correct. Creating a skeleton would invent a row for a load that has none.
    if (!rec) {
      this.log(`[bidlog] closed_while_down for ${id} has no closed-bids record - nothing to mark`);
      return;
    }
    // T6 BH-STATE-3: the old guard (`closed && closedWhileDown !== true`) only protected a REAL
    // settled result from a late sweep - it let a SECOND closedWhileDown event re-stamp a record
    // this same mechanism had already closed once, so a re-emitted/replayed sweep (a restart
    // replaying a durable intent, an overlapping late-detection) could blank a won/finalRank the
    // first sweep had already recorded. Once closed by ANY path, the record is left exactly as it
    // is - first close wins, matching the doc comment's own intent above.
    if (rec.status === 'closed') return;
    rec.status = 'closed';
    rec.closedWhileDown = true;
    rec.resultReason = e.won === true ? 'won' : 'unknown';
    rec.won = e.won != null ? e.won : null;
    rec.finalRank = e.finalRank != null ? e.finalRank : null;
    // The AUCTION'S close, not the moment we swept it. _onArmed initialises closedAt null, so for
    // exactly this population - armed, bid, never finalized - the old `|| e.ts` fell through to the
    // emit instant. Downstream that field IS the auction close (exportModel's auctionCloseAt, the
    // default date-filter basis and the Auction Date column), so a boot sweep would stamp every
    // orphan with the restart time and drop it out of a filter for the week it really ran. The
    // retirement instant survives only as the last resort, for a load whose close was never known.
    rec.closedAt = rec.closedAt || e.closesAt || e.ts || Date.now();
    await this.store.putDoc(COLLECTION, id, rec);
    await this.store.appendEvent(STREAM, { kind: 'closed_while_down', auctionId: id, won: rec.won, finalRank: rec.finalRank });
  }

  /**
   * A2 - append ONE rank/density trajectory sample to the append-only `bids` stream: our rank, the
   * bidder COUNT (never any competitor amount - inside the legal wall), and the countdown at this
   * monitor tick. The engine calls this once per tick off its existing poll cadence (via onSample,
   * NOT the emit bus), so the rank-over-time and contestedness-over-time shape a winning-engine
   * learns from is captured for every armed auction. All our-side data.
   *
   * Deliberately NOT routed through the serialized _tail and NOT written onto the closedBids doc:
   *   - it is a pure append to a DIFFERENT file, so it needs no read-modify-write serialization and
   *     never queues ahead of / delays a money-path bid record write on the tail;
   *   - a per-tick trace on the full-replace closedBids doc would rewrite the ENTIRE collection
   *     (172+ records) every ~200ms - the jsonl stream is exactly the append-only sink built for
   *     this "day-1 rank log that cannot be backfilled".
   * The append underneath is a NON-BLOCKING async write (appendEventAsync -> fs.promises.appendFile
   * on libuv's threadpool), so no synchronous fs I/O ever lands on the bid-fire path. This matters
   * because onSample is called before placeBid on a fire tick and microtasks are FIFO, so the sample
   * is reached BEFORE the wire-send - but an async append only schedules threadpool work and returns
   * immediately, so it cannot block or delay the actual bid dispatch (an appendFileSync here could,
   * under a disk stall). It is NOT the microtask deferral that keeps disk I/O off the snipe path -
   * it is the append being off-thread. The Promise.resolve().then wrapper only keeps the (cheap,
   * non-blocking) dispatch off the synchronous portion of the tick and turns any synchronous throw
   * into a caught rejection. Downstream, samples and per-event lines are ordered by each record's
   * own `ts`, never by append/write order (see N3). Fire-and-forget with an internal catch: a disk
   * hiccup on a telemetry sample must never surface as an unhandled rejection or disturb the bid loop.
   */
  sampleRank(e) {
    if (!e || e.auctionId == null) return Promise.resolve();
    const rec = {
      kind: 'rank_sample',
      auctionId: String(e.auctionId),
      myRank: e.myRank != null ? e.myRank : null,
      totalBidders: e.totalBidders != null ? e.totalBidders : null,
      closesInMs: e.closesInMs != null ? e.closesInMs : null,
      // Continuous extension/budget trajectory, so a bid record's stamped context can be placed
      // inside a timeline rather than interpolated between two bids. believedCloseAt is deliberately
      // omitted per tick - closesInMs above is its derivative and the absolute value rides every bid
      // record, which is where the cap-reset correlation is actually made.
      extendsObserved: e.extendsObserved != null ? e.extendsObserved : null,
      closeModel: e.closeModel != null ? e.closeModel : null,
      engineRevisionsLeft: e.engineRevisionsLeft != null ? e.engineRevisionsLeft : null,
    };
    // owning account only when multi-account is running (mirrors the byte-identical-for-single-
    // account discipline used across events/records); the loadId->account join also lives on the
    // closedBids doc, so single-account samples stay minimal.
    if (e.account) rec.account = e.account;
    // preserve the tick's own timestamp (appendEvent would otherwise stamp append-time); the
    // record-supplied ts wins the Object.assign in store.appendEvent.
    if (e.ts != null) rec.ts = e.ts;
    return Promise.resolve()
      .then(() => this.store.appendEventAsync(STREAM, rec))
      .catch((err) => { this.log(`[bidlog] rank_sample append failed: ${err && err.message}`); });
  }

  /** One auction's History record (open or closed), or null. */
  async getRecord(auctionId) {
    if (auctionId == null) return null;
    return this.store.getDoc(COLLECTION, String(auctionId));
  }

  /**
   * Closed auctions, newest first, optionally bounded by closedAt [from,to] and scoped to one
   * portal.
   *
   * `platformKey` is the closedBids twin of PriceRequestStore.listFor, and it exists because the
   * absence of this seam is what let the closed side go half-filtered while the request side was
   * scoped thoroughly: with no parameter to opt into, every caller that wanted a scoped read had to
   * hand-roll the filter, and the two callers that forgot were indistinguishable from the ones that
   * decided not to. The filter now lives once, in the class that owns the collection.
   *
   * OMITTING IT MEANS EVERY PORTAL, and that is a deliberate default, not an oversight. Rows a
   * human reads (the CSV/xlsx downloads, /api/closed-bids, the History table) carry an explicit
   * platform column, so a mixed result is visible and cannot silently corrupt anything; an
   * aggregate a client reads (a participation or win percentage) has no such column and must pass
   * a key. Callers therefore state which of the two they are, rather than inheriting a default
   * that is wrong for half of them.
   */
  /** Closed records split by platform from ONE read of the collection: { [platformKey]: records }. */
  async listClosedSplit({ platformKeys }) {
    const closed = (await this.store.listDocs(COLLECTION)).filter((r) => r && r.status === 'closed');
    const out = {};
    for (const k of platformKeys) out[k] = closed.filter((r) => ownedBy(r, k));
    return out;
  }

  async listClosed({ from, to, platformKey } = {}) {
    const all = await this.store.listDocs(COLLECTION);
    let closed = all.filter((r) => r && r.status === 'closed');
    if (platformKey) closed = closed.filter((r) => ownedBy(r, platformKey));
    if (from != null) closed = closed.filter((r) => (r.closedAt || 0) >= Number(from));
    if (to != null) closed = closed.filter((r) => (r.closedAt || 0) <= Number(to));
    closed.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    return closed;
  }

  /**
   * Recent closed quotes on the SAME route AND the SAME vehicle type (our own prior bids),
   * newest first - the "previous quotes on this route" block the pricing team sees on a new
   * price ask. Base data only (our cost / our bid), never a competitor number. amount = our
   * last placed bid if we bid, else the entered cost (so a never-bid load still contributes
   * its quoted number). The current load is excluded so a re-ask doesn't cite itself.
   *
   * Two match keys, both HARD:
   *   - lane: the normalized origin->destination city pair (laneKey).
   *   - equipment (opts.equipment): the normalized vehicle type (equipKey). This is the fix
   *     for the Director's 2026-07-16 report - Rs 48,692/48,240 quotes from 20ft-container
   *     loads were surfacing as references on a 32-feet load: same city pair, wrong vehicle.
   *     A 20ft-container rate is meaningless when pricing a 32ft trailer, so equipment is a
   *     hard match key, never borrowed across types to pad a thin sample (the same way
   *     DAT/Xeneta freight benchmarks never mix equipment classes).
   *
   * Fail-closed on unknown equipment, in BOTH directions:
   *   - a STORED row with null/empty equipment (equipKey '') never matches a load whose
   *     equipment IS known - we can't prove it's the same vehicle, so we don't surface it.
   *   - if the INCOMING load's equipment is unknown (opts.equipment null/empty/absent), we
   *     return NOTHING rather than fall back to route-only matching and leak cross-type rows.
   * A dropped history block is a safe degrade (the desk just prices without a reference);
   * a wrong-vehicle reference is not, which is why both unknowns resolve to empty.
   */
  async routeHistory(lane, { limit = 3, excludeLoadId = null, equipment, platformKey } = {}) {
    const key = laneKey(lane);
    if (!key) return [];
    const eqKey = equipKey(equipment);
    if (!eqKey) return []; // incoming equipment unknown -> fail closed (never cross-type)
    // Scoped to the ASKING load's own platform (C071) - a reference must never be presented as
    // "our previous quote on this route" when it could be a different platform's quote on a
    // nominally-identical lane, which carries a different customer relationship, revision budget
    // and price basis. platformOf resolves an absent stored platformKey to SuperProcure, the same
    // fallback every other portal-scoped reader uses.
    const scopePlatform = platformOf({ platformKey });
    const all = await this.store.listDocs(COLLECTION);
    const rows = all.filter((r) =>
      r && r.status === 'closed'
      && laneKey(r.lane) === key
      && equipKey(r.equipment) === eqKey // '' (stored equipment unknown) can never equal a known eqKey
      && ownedBy(r, scopePlatform)
      && String(r.auctionId) !== String(excludeLoadId == null ? '' : excludeLoadId)
      && (r.lastBidPrice != null || r.cost != null));
    rows.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
    return rows.slice(0, Math.max(0, limit)).map((r) => ({
      // `amount` is kept exactly as before (last placed bid, else the entered cost) so every
      // existing consumer stays byte-identical. `rate` (the entered cost) and `bid` (our last
      // placed bid) are carried separately so the message can lead with the operator's own number
      // when both exist - "₹45,000 -> bid ₹48,692" - and collapse to `amount` when only one does.
      amount: r.lastBidPrice != null ? r.lastBidPrice : r.cost,
      rate: r.cost != null ? r.cost : null,
      bid: r.lastBidPrice != null ? r.lastBidPrice : null,
      rank: r.finalRank != null ? r.finalRank : null,
      at: r.closedAt || null,
      // the row's own vehicle, so the rendered reference is self-describing (the raw stored
      // string + count; the template formats it). Kept verbatim - only the MATCH key is
      // normalized, never the display value.
      equipment: r.equipment != null ? r.equipment : null,
      units: r.units != null ? r.units : null,
    }));
  }
}

/**
 * The engine's soft-close / bid-budget context, normalized off a bid_placed or bid_rejected event
 * for persistence. Four fields, all computed by the engine before the bid left the building and
 * carried on the event verbatim (bidEngine._budgetContext) - nothing is derived or inferred here.
 *
 * WHY it must land on disk. SuperProcure exposes no remaining-bid count on any surface: the REST
 * state hardcodes revisionsLeft null and every candidate count field was null across all 339 open
 * rows in the 2026-07-21 probe. So there is exactly one way to ever witness whether SP RESETS a
 * load's bid-revision cap when a soft-close auction auto-extends - correlate a bid's accept/reject
 * outcome against how many extensions had been observed at that moment. A reset appears as a bid
 * that should have exceeded the static cap coming back ACCEPTED after an extension, rather than
 * rejected with "Bid limit exceeded". Extension state has never been persisted anywhere durable, so
 * that correlation is impossible against today's logs and cannot be backfilled later - it has to be
 * stamped when the bid happens or it is gone.
 *
 * All four are OUR-SIDE facts (our extension count, our believed close, our close model, our own
 * budget belief). No competitor amount is recorded here; none is available to record.
 *
 * Absent on every event that predates this capture and on any adapter/harness that does not supply
 * them -> null, matching the lazy-null discipline the rest of this file uses, so the existing
 * records and their consumers are unaffected.
 */
function budgetContext(e) {
  if (!e) return { extendsObserved: null, believedCloseAt: null, closeModel: null, engineRevisionsLeft: null };
  return {
    extendsObserved: e.extendsObserved != null ? e.extendsObserved : null,
    believedCloseAt: e.believedCloseAt != null ? e.believedCloseAt : null,
    closeModel: e.closeModel != null ? e.closeModel : null,
    engineRevisionsLeft: e.engineRevisionsLeft != null ? e.engineRevisionsLeft : null,
  };
}

/** Normalize a lane ({origin,destination} or "A->B" string) to a comparable key. */
function laneKey(lane) {
  if (!lane) return '';
  if (typeof lane === 'string') return lane.trim().toLowerCase();
  if (lane.origin || lane.destination) return `${lane.origin || ''}->${lane.destination || ''}`.trim().toLowerCase();
  return '';
}

/**
 * Normalize an equipment/vehicle string to a comparable key. Trim, lowercase, and collapse
 * internal whitespace runs to a single space so "32FT", "32ft", and " 32ft " compare equal -
 * but NOTHING beyond that: sizes and subtypes stay DISTINCT keys ("32ft" != "32ft mxl" !=
 * "20ft container"), because borrowing a 20ft-container rate onto a 32ft trailer is exactly
 * the bug this guards. null/empty/whitespace-only -> '' (an unknown that never matches, which
 * is what makes both the stored-side and incoming-side unknowns fail closed above).
 */
function equipKey(equipment) {
  if (equipment == null) return '';
  return String(equipment).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Win/loss roll-up for the closed-auction feed. Every row goes through util/closedOutcome, the rule
 * the export, both EODs and the heartbeat read, so the console cannot report a second win rate.
 * winRate is over DECIDED auctions (won + lost); `total` also counts the no-bid and unknown rows.
 */
function summarizeClosed(rows) {
  const counts = { won: 0, lost: 0, no_bid: 0, closed_unknown: 0 };
  for (const r of rows) counts[closedOutcome(r)] += 1;
  const decided = counts.won + counts.lost;
  return { total: rows.length, won: counts.won, lost: counts.lost, noBid: counts.no_bid,
    closedUnknown: counts.closed_unknown, winRate: decided ? Math.round((counts.won / decided) * 100) : 0 };
}

module.exports = { BidLogger, summarizeClosed, COLLECTION, STREAM };
