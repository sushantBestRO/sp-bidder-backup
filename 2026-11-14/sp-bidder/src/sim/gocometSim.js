'use strict';

const { PlatformAdapter } = require('../platform/adapter');
const { assertAboveFloor } = require('../engine/pricing');

/**
 * GoCometSim - a minimal GoComet reverse auction, offline and deterministic.
 *
 * AuctionSim (src/sim/auctionSim.js) models SuperProcure; this models the three things that make
 * GoComet a different animal and that no other offline test can reach:
 *
 *   1. REACTIVE CLOSE. A bid landing inside the reactive window pushes the deadline out by one
 *      extension increment - including OUR OWN bid. Roughly two in three real auctions extend at
 *      least once; one observed load extended 22 times and closed nearly two hours past its posted
 *      time. This is the only place the engine's own floor snipe can be watched causing the
 *      extension that then outlives it.
 *   2. THREE REVISIONS PER VENDOR PER ENQUIRY, and they do not reset when the auction extends. So
 *      ammunition, not speed, is the binding constraint, and a 22-round auction is fought with the
 *      same three bids a one-round auction gets.
 *   3. THE AMBIGUOUS ZERO. `settleMs` models the interval in which the countdown reads zero while
 *      the platform is still writing the new deadline - the instant that silently abandoned live
 *      auctions before the adapter published `extendMs`.
 *
 * Time comes from an injected clock and nothing else: no wall-clock reads, no timers.
 */

// The MEASURED per-round step, read off bid_close_timestamp. gocometAdapter publishes 300_000 -
// 299s rounded UP - and the two differ on purpose, so the sim reproduces that gap rather than
// hiding it: the published number only ever lengthens the engine's finalize debounce.
const EXTEND_STEP_MS = 299_000;
const PUBLISHED_EXTEND_MS = 300_000;

class GoCometSim {
  constructor({
    clock, closesInMs = 600_000, revisionLimit = 3, extendStepMs = EXTEND_STEP_MS,
    reactiveWindowMs = 10_000, settleMs = 0, minDecrement = 1000,
  } = {}) {
    if (typeof clock !== 'function') throw new Error('gocometSim: an injectable clock is required');
    this.clock = clock;
    this.closesAt = clock() + closesInMs;
    this.postedCloseAt = this.closesAt;
    this.revisionLimit = revisionLimit;
    this.extendStepMs = extendStepMs;
    this.reactiveWindowMs = reactiveWindowMs;
    this.settleMs = settleMs;
    this.minDecrement = minDecrement;
    this.participants = new Map(); // id -> { bid, revisionsLeft }
    this.extensions = [];          // { at, by, causedBy }
    this.bids = [];                // { who, price, at, rank, extended }
  }

  now() { return this.clock(); }
  remainingMs() { return Math.max(0, this.closesAt - this.now()); }

  /** Bidding is genuinely over only once the settle interval past the close has also elapsed. */
  isOver() { return this.now() >= this.closesAt + this.settleMs; }

  _participant(who) {
    if (!this.participants.has(who)) {
      this.participants.set(who, { bid: null, revisionsLeft: this.revisionLimit });
    }
    return this.participants.get(who);
  }

  /** 1 = lowest = winning. null until this participant has a standing bid. */
  rankOf(who) {
    const mine = this._participant(who).bid;
    if (mine == null) return null;
    let lower = 0;
    for (const [id, p] of this.participants) {
      if (id !== who && p.bid != null && p.bid < mine) lower += 1;
    }
    return lower + 1;
  }

  /** Push the close out one increment. The only thing that moves a deadline in this model. */
  extend(causedBy = 'platform') {
    this.closesAt += this.extendStepMs;
    this.extensions.push({ at: this.now(), by: this.extendStepMs, causedBy });
    return this.closesAt;
  }

  submitBid(who, price) {
    if (this.isOver()) return { accepted: false, reason: 'closed' };
    const p = this._participant(who);
    if (p.revisionsLeft <= 0) return { accepted: false, reason: 'no_revisions_left', revisionsLeft: 0 };
    const amount = Math.round(price);
    if (!(amount > 0)) return { accepted: false, reason: 'invalid_price', revisionsLeft: p.revisionsLeft };
    // A revision may only go DOWN. A refused revision still costs the round trip but not a
    // revision, which is why the engine's min-decrement guard matters more here than on SP.
    if (p.bid != null && amount >= p.bid) {
      return { accepted: false, reason: 'not_a_reduction', revisionsLeft: p.revisionsLeft };
    }

    p.bid = amount;
    p.revisionsLeft -= 1;
    // THE ANTI-SNIPE RULE. Measured against the deadline as it stood BEFORE this bid, so one bid
    // can only ever buy one extension. A bid at a countdown already reading zero does not extend:
    // there is no runway left for the platform to add to.
    const inWindow = this.remainingMs() > 0 && this.remainingMs() <= this.reactiveWindowMs;
    if (inWindow) this.extend(who);
    const rank = this.rankOf(who);
    this.bids.push({ who, price: amount, at: this.now(), rank, extended: inWindow });
    return { accepted: true, rank, revisionsLeft: p.revisionsLeft, extended: inWindow };
  }

  /** A scripted rival. Goes through the same rules we do - including the anti-snipe rule. */
  rivalBid(id, price) { return this.submitBid(id, price); }

  ourBids() { return this.bids.filter((b) => b.who === 'US'); }
}

/**
 * GoCometSimAdapter - the sim behind the PlatformAdapter seam, in the SAME shape gocometAdapter
 * presents to the engine. The key fields are copied deliberately, not approximated:
 *
 *   extendCount: null      GoComet publishes no cap, so _effectivelyHard fails closed to the proven
 *                          hard-close snipe rather than looping after phantom extensions.
 *   triggerWindowMs        ABSENT, exactly as the real adapter leaves it - GoComet does not publish
 *                          its reactive window. The engine therefore has no model of it.
 *   closesAtMs: null       once the countdown reads zero, so a dead auction cannot manufacture a
 *                          forward jump on every poll.
 *   measuredRttMs          the WRITE latency proxy, never this read's own span.
 */
class GoCometSimAdapter extends PlatformAdapter {
  constructor(sim, {
    auctionId = 'GC-SIM-1', companyName = 'Waaree Energies', equipment = '32ft SXL',
    publishedExtendMs = PUBLISHED_EXTEND_MS, assumedRttMs = 1100,
  } = {}) {
    super();
    this.sim = sim;
    this.auctionId = String(auctionId);
    this.companyName = companyName;
    this.equipment = equipment;
    this.publishedExtendMs = publishedExtendMs;
    this.assumedRttMs = assumedRttMs;
    this.writeEnabled = true;
  }

  capabilities() {
    return {
      standingPriceVisible: false,
      minDecrement: this.sim.minDecrement,
      allowsTieRate: false,
      revisionLimit: this.sim.revisionLimit,
      closeModel: 'soft',
      reactiveClose: true,
      snipeBudgetMs: 3000,
    };
  }

  async login() { return { userId: 'sim-vendor' }; }
  async ensureSession() { return { userId: 'sim-vendor' }; }

  async listAuctions() {
    if (this.sim.isOver()) return [];
    return [{
      id: this.auctionId,
      lane: { origin: 'Bhiwandi', destination: 'Hosur' },
      equipment: this.equipment,
      units: 1,
      quoteType: 'FTL',
      status: 'open',
      closesAt: this.sim.closesAt,
      companyName: this.companyName,
      showsL1: false,
      rules: { minDecrement: this.sim.minDecrement },
      minDecrement: this.sim.minDecrement,
      softClose: true,
      closeModelKnown: true,
      closeModel: 'soft',
    }];
  }

  async getAuctionState(auctionId) {
    if (String(auctionId) !== this.auctionId) return { ok: false, measuredRttMs: this.assumedRttMs };
    const closesInMs = this.sim.remainingMs();
    const closed = closesInMs <= 0;
    return {
      ok: true,
      status: closed ? 'closed' : 'live',
      myRank: this.sim.rankOf('US'),
      totalBidders: null,
      standingL1Price: null,
      closesInMs,
      revisionsLeft: this.sim._participant('US').revisionsLeft,
      revisionLimit: this.sim.revisionLimit,
      minDecrement: this.sim.minDecrement,
      closeModel: 'soft',
      extendMs: this.publishedExtendMs,
      closesAtMs: closed ? null : this.sim.closesAt,
      extendCount: null,
      extensionCeiling: null,
      biddingClosed: this.sim.isOver(),
      measuredRttMs: this.assumedRttMs,
    };
  }

  async placeBid(auctionId, price, opts = {}) {
    if (!this.writeEnabled) {
      const e = new Error('gocomet-sim: writeEnabled backstop is down'); e.code = 'WRITE_DISABLED'; throw e;
    }
    const amount = Math.round(price);
    if (opts && Number.isFinite(opts.floor)) assertAboveFloor(amount, opts.floor);
    const res = this.sim.submitBid('US', amount);
    return {
      accepted: !!res.accepted,
      myRank: res.rank != null ? res.rank : null,
      revisionsLeft: res.revisionsLeft != null ? res.revisionsLeft : null,
      reason: res.accepted ? null : res.reason,
      latencyMs: this.assumedRttMs,
    };
  }
}

module.exports = { GoCometSim, GoCometSimAdapter, EXTEND_STEP_MS, PUBLISHED_EXTEND_MS };
