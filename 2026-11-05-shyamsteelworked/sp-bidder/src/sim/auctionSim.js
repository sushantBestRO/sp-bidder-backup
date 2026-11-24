'use strict';

/**
 * AuctionSim — a faithful reverse-auction simulator for freight spot bids.
 *
 * Models what we know about SuperProcure / GoComet spot auctions:
 *  - Shipper posts a load; invited transporters bid a per-unit rate.
 *  - LOWEST price ranks L1 (winning). Bidders see their RANK, not rivals' prices
 *    (rank-only visibility — configurable).
 *  - Strictly-lower rule: a new bid must beat the standing best by at least
 *    minDecrement (SuperProcure forbids equal rates).
 *  - A countdown to close. Hard close = fixed end. Soft close = a bid inside the
 *    last `softExtendWindowMs` pushes the deadline out by `softExtendByMs`
 *    (the standard B2B anti-snipe defence).
 *  - Competitor transporters are bots with their own hidden floors who bid down,
 *    getting more aggressive near close.
 *
 * The bot under test is just another participant (id = 'US'). The MockAdapter
 * reads/writes this sim; the engine never sees the sim directly.
 *
 * Time: every method takes/uses epoch ms via the injected clock so the whole
 * thing is deterministic and testable. Real wall clock by default.
 */

let _seq = 1;
function nextId(prefix) { return `${prefix}-${String(_seq++).padStart(4, '0')}`; }

const LANES = [
  { origin: 'Bhiwandi, MH', destination: 'Hosur, TN', equipment: '32ft SXL', weight: 15, baseRate: 48000 },
  { origin: 'Chakan, MH', destination: 'Bawal, HR', equipment: '20ft container', weight: 24, baseRate: 39000 },
  { origin: 'Mundra, GJ', destination: 'Bhiwandi, MH', equipment: '40ft container', weight: 26, baseRate: 71500 },
  { origin: 'Hosur, TN', destination: 'Pantnagar, UK', equipment: '32ft MXL', weight: 18, baseRate: 86000 },
  { origin: 'Sanand, GJ', destination: 'Nagpur, MH', equipment: '22ft truck', weight: 9, baseRate: 33000 },
];

class AuctionSim {
  constructor(opts = {}) {
    this.clock = opts.clock || (() => Date.now());
    this.auctions = new Map();
    this.onEvent = opts.onEvent || (() => {});
    this._tickHandle = null;
  }

  now() { return this.clock(); }

  /**
   * Spawn an auction.
   * @param {object} cfg
   *   durationMs        - time from now to close (default 90s)
   *   competitors       - number of rival transporters (default 3)
   *   closeModel        - 'hard' | 'soft' (default 'hard')
   *   standingPriceVisible - whether rivals'/L1 price is readable (default false = rank-only)
   *   minDecrement      - strictly-lower step (default 100)
   *   revisionLimit     - max revisions per bidder (default 6)
   *   extendCap         - max soft-close extensions before the close stops moving
   *                       (default null = unlimited = today's behaviour). Mirrors the
   *                       real branchExtendAuctionCount so the engine's soft-close endgame
   *                       (defend then snipe) actually engages in the sim.
   */
  spawn(cfg = {}) {
    const lane = cfg.lane || LANES[(_seq) % LANES.length];
    const ceiling = Math.round(lane.baseRate * (1 + 0.18 + Math.random() * 0.08)); // shipper's published ceiling
    const now = this.now();
    const durationMs = cfg.durationMs ?? 90_000;

    const competitors = [];
    const n = cfg.competitors ?? 3;
    for (let i = 0; i < n; i++) {
      // Each rival has a hidden floor (their true cost+margin) somewhere below ceiling.
      // cfg.rivalFloorFrac = [lo, hi] band of base rate; higher band = weaker rivals.
      const [ffLo, ffHi] = cfg.rivalFloorFrac || [0.86, 0.97];
      const floorFrac = ffLo + Math.random() * (ffHi - ffLo);
      competitors.push({
        id: `RIVAL-${i + 1}`,
        floor: Math.round(lane.baseRate * floorFrac),
        aggression: 0.4 + Math.random() * 0.5, // how soon/eager they start cutting
        lastBidAt: 0,
        currentBid: null,
        revisionsLeft: cfg.revisionLimit ?? 6,
      });
    }

    const a = {
      id: nextId('SPA'),
      lane: { origin: lane.origin, destination: lane.destination },
      equipment: lane.equipment,
      weight: lane.weight ?? null,
      units: cfg.units ?? (1 + Math.floor(Math.random() * 3)),
      ceiling,
      status: 'open',
      createdAt: now,
      closesAt: now + durationMs,
      closeModel: cfg.closeModel ?? 'hard',
      softExtendWindowMs: cfg.softExtendWindowMs ?? 15_000,
      softExtendByMs: cfg.softExtendByMs ?? 20_000,
      standingPriceVisible: cfg.standingPriceVisible ?? false,
      minDecrement: cfg.minDecrement ?? 100,
      revisionLimit: cfg.revisionLimit ?? 6,
      // Anti-snipe extension cap. null = unlimited (a late bid always extends -
      // today's behaviour, so existing demo/tests are unchanged). A number caps
      // how many times the close can be pushed out; extendsUsed tracks how many
      // have fired so far on THIS auction.
      extendCap: cfg.extendCap ?? null,
      extendsUsed: 0,
      competitors,
      // our bot's participation:
      us: { currentBid: null, revisionsLeft: cfg.revisionLimit ?? 6, bidCount: 0 },
      winner: null,
      bids: [], // full history for the dashboard timeline
    };
    this.auctions.set(a.id, a);
    this.onEvent({ type: 'auction_spawned', auctionId: a.id, lane: a.lane, equipment: a.equipment,
      closesInMs: durationMs, competitors: n, closeModel: a.closeModel });
    return a;
  }

  get(id) { return this.auctions.get(id); }

  listOpen() {
    return [...this.auctions.values()].filter(a => a.status === 'open');
  }

  /** Standing best (lowest) across all participants who have bid. */
  _standing(a) {
    let best = null;
    const consider = (id, bid) => {
      if (bid == null) return;
      if (best == null || bid < best.price) best = { id, price: bid };
    };
    for (const c of a.competitors) consider(c.id, c.currentBid);
    consider('US', a.us.currentBid);
    return best; // {id, price} or null
  }

  /** Rank of a participant: 1 = lowest. Only ranks those who have bid. */
  _rankOf(a, who) {
    const myBid = who === 'US' ? a.us.currentBid : a.competitors.find(c => c.id === who)?.currentBid;
    if (myBid == null) return null;
    const allBids = a.competitors.filter(c => c.currentBid != null).map(c => c.currentBid);
    if (a.us.currentBid != null) allBids.push(a.us.currentBid);
    // rank = 1 + number of strictly-lower bids
    const lower = allBids.filter(b => b < myBid).length;
    return lower + 1;
  }

  _activeBidders(a) {
    let n = a.competitors.filter(c => c.currentBid != null).length;
    if (a.us.currentBid != null) n += 1;
    return n;
  }

  /** Place a bid for a participant. Enforces strictly-lower + min decrement + revision cap + closed. */
  submitBid(auctionId, who, price) {
    const a = this.auctions.get(auctionId);
    if (!a) return { accepted: false, reason: 'no_such_auction' };
    if (a.status !== 'open') return { accepted: false, reason: 'closed' };

    const participant = who === 'US' ? a.us : a.competitors.find(c => c.id === who);
    if (!participant) return { accepted: false, reason: 'not_a_participant' };
    if (participant.revisionsLeft <= 0) return { accepted: false, reason: 'no_revisions_left' };

    price = Math.round(price);
    if (price <= 0) return { accepted: false, reason: 'invalid_price' };
    if (price > a.ceiling) return { accepted: false, reason: 'above_ceiling' };

    // No-tie / minimum-decrement spacing rule (matches GoComet/SuperProcure):
    // a bid may NOT equal or sit within the minimum decrement of ANOTHER
    // participant's current bid. A HIGHER bid is allowed — it simply ranks worse
    // (L2/L3...). Only ties / sub-decrement collisions are rejected. To TAKE L1
    // you must therefore land at least minDecrement below the current lowest.
    for (const other of a.competitors) {
      if (other.id === who || other.currentBid == null) continue;
      if (Math.abs(price - other.currentBid) < a.minDecrement) {
        return { accepted: false, reason: 'tie_or_too_close' };
      }
    }
    if (who !== 'US' && a.us.currentBid != null && Math.abs(price - a.us.currentBid) < a.minDecrement) {
      return { accepted: false, reason: 'tie_or_too_close' };
    }

    participant.currentBid = price;
    participant.revisionsLeft -= 1;
    if (who === 'US') a.us.bidCount += 1;

    // Soft close / anti-snipe: a late bid extends the deadline - but only while the
    // per-branch extension cap has room. extendCap null = unlimited (extend forever,
    // today's behaviour); a number lets the close move only while extendsUsed < cap,
    // so once the cap is reached a late bid no longer pushes the clock and the auction
    // becomes genuinely final (the endgame the real branchExtendAuctionCount produces).
    let extended = false;
    if (a.closeModel === 'soft') {
      const remaining = a.closesAt - this.now();
      const capHasRoom = a.extendCap == null || a.extendsUsed < a.extendCap;
      if (remaining > 0 && remaining <= a.softExtendWindowMs && capHasRoom) {
        a.closesAt += a.softExtendByMs;
        a.extendsUsed += 1;
        extended = true;
        this.onEvent({ type: 'auction_extended', auctionId: a.id, by: a.softExtendByMs, newClosesInMs: a.closesAt - this.now() });
      }
    }

    const rank = this._rankOf(a, who);
    a.bids.push({ who, price, at: this.now(), rank });
    if (who === 'US') {
      this.onEvent({ type: 'our_bid_accepted', auctionId: a.id, price, rank,
        revisionsLeft: participant.revisionsLeft, extended });
    }
    return { accepted: true, rank, revisionsLeft: participant.revisionsLeft, extended };
  }

  /** Read state as a participant would see it (rank-only unless standingPriceVisible). */
  observe(auctionId, who = 'US') {
    const a = this.auctions.get(auctionId);
    if (!a) return null;
    const participant = who === 'US' ? a.us : a.competitors.find(c => c.id === who);
    return {
      myRank: this._rankOf(a, who),
      totalBidders: this._activeBidders(a),
      standingL1Price: a.standingPriceVisible ? (this._standing(a)?.price ?? null) : null,
      closesInMs: Math.max(0, a.closesAt - this.now()),
      revisionsLeft: participant ? participant.revisionsLeft : null,
      closeModel: a.closeModel,
      status: a.status,
      // Soft-close endgame inputs the real adapter surfaces (realAdapter.js:697-715).
      // Without these the engine's _observeExtension always returns false, extendCap
      // stays null, and every soft sim auction is treated as effectively-hard - so the
      // defend/snipe arc never occurs. Forward them so the sim exercises it faithfully.
      revisionLimit: a.revisionLimit,           // static per-load cap on our revisions
      minDecrement: a.minDecrement,             // per-load "Bid Difference"
      extendMs: a.softExtendByMs,               // anti-snipe extension interval (ms)
      extendCount: a.extendCap,                 // MAX extensions (branchExtendAuctionCount); null = unknown
      triggerWindowMs: a.softExtendWindowMs,    // seconds-remaining threshold that triggers an extension
      closesAtMs: a.closesAt,                   // ABSOLUTE server-epoch close (reflects live extensions)
    };
  }

  /**
   * Advance competitor behaviour and close expired auctions. Call frequently
   * (e.g. every 250ms). Competitors bid down toward their floors, more eagerly
   * as the clock runs out, always respecting the strictly-lower rule.
   */
  step() {
    const now = this.now();
    for (const a of this.auctions.values()) {
      if (a.status !== 'open') continue;

      // close?
      if (now >= a.closesAt) {
        a.status = 'closed';
        const standing = this._standing(a);
        a.winner = standing ? standing.id : null;
        a.finalUsRank = this._rankOf(a, 'US');
        this.onEvent({ type: 'auction_closed', auctionId: a.id, winner: a.winner,
          ourFinalRank: a.finalUsRank, won: a.winner === 'US' });
        continue;
      }

      const remaining = a.closesAt - now;
      const standing = this._standing(a);

      for (const c of a.competitors) {
        if (c.revisionsLeft <= 0) continue;
        // pacing: rivals act on intervals that shorten near close
        const minGap = remaining > 30_000 ? 8000 : remaining > 10_000 ? 3000 : 1200;
        if (now - c.lastBidAt < minGap) continue;
        // probability of acting this step rises with aggression and as time runs out
        const urgency = remaining < 12_000 ? 0.55 : remaining < 30_000 ? 0.28 : 0.12;
        if (Math.random() > urgency * c.aggression + 0.05) continue;

        // target: undercut the standing best if it's not them, else nudge toward floor
        let target;
        if (standing && standing.id !== c.id) {
          target = standing.price - a.minDecrement - Math.floor(Math.random() * 300);
        } else {
          // they're already best (or no standing) -> ease down toward floor slowly
          const cur = c.currentBid ?? a.ceiling;
          target = cur - Math.floor((cur - c.floor) * (0.15 + Math.random() * 0.2));
        }
        target = Math.max(target, c.floor); // never below their own floor
        if (c.currentBid != null && target >= c.currentBid) continue; // only improve
        const res = this.submitBid(a.id, c.id, target);
        if (res.accepted) c.lastBidAt = now;
      }
    }
  }

  /**
   * God-view of one auction for the control dashboard (simulator truth — more
   * than the bot itself can see). Lets the operator watch the bot climb to L1.
   */
  detail(id) {
    const a = this.auctions.get(id);
    if (!a) return null;
    const standing = this._standing(a);
    const participants = a.competitors.map(c => ({
      id: c.id, bid: c.currentBid, rank: this._rankOf(a, c.id), revisionsLeft: c.revisionsLeft,
    }));
    participants.push({ id: 'US', bid: a.us.currentBid, rank: this._rankOf(a, 'US'),
      revisionsLeft: a.us.revisionsLeft, isUs: true });
    participants.sort((x, y) => (x.bid ?? Infinity) - (y.bid ?? Infinity));
    return {
      id: a.id, lane: a.lane, equipment: a.equipment, units: a.units,
      ceiling: a.ceiling, status: a.status, closeModel: a.closeModel,
      standingPriceVisible: a.standingPriceVisible, minDecrement: a.minDecrement,
      closesInMs: Math.max(0, a.closesAt - this.now()),
      totalBidders: this._activeBidders(a),
      standingL1: standing ? { id: standing.id, price: standing.price } : null,
      ourRank: this._rankOf(a, 'US'),
      ourBid: a.us.currentBid,
      ourBidCount: a.us.bidCount,
      winner: a.winner, finalUsRank: a.finalUsRank ?? null, won: a.winner === 'US',
      participants,
      bids: a.bids.slice(-40),
    };
  }

  detailAll() { return [...this.auctions.values()].map(a => this.detail(a.id)); }

  startAutoStep(intervalMs = 250) {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => this.step(), intervalMs);
    if (this._tickHandle.unref) this._tickHandle.unref();
  }

  stopAutoStep() {
    if (this._tickHandle) { clearInterval(this._tickHandle); this._tickHandle = null; }
  }
}

module.exports = { AuctionSim, LANES };
