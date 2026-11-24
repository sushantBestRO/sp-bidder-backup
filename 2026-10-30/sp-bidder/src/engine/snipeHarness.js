'use strict';

/**
 * LEGACY / pre-unification — NOT kept in sync with the production engine.
 *
 * This file holds a second, independent `_decide` that predates the rank-driven rung
 * unification. The production rung rule now lives in `pricing.selectRung`, wired into
 * `bidEngine._decide` (soft defend, hard step-down, and the rank-aware single-shot snipe).
 * `SnipeHarness._decide` below still does the OLD clock-driven walk (soft: always step one
 * rung down when outranked, never dump the floor; hard: gradual step then floor-snipe in the
 * final window) - it does NOT skip rungs by rank the way the live engine does.
 *
 * This class is a standalone manual smoke tool for bidding ONE live load from the command line
 * (`scripts/snipe.js`) - not part of the armed/engine path real requests run through. Its DECISION
 * logic is untested by design (see above); its WIRE seam is not - `scripts/test-snipe-harness-opts.js`
 * pins the opts `_fire` hands placeBid, because this is a sanctioned live-bid caller and a wrong
 * payload here spends real money. Do not extend its decision logic to match new engine behavior;
 * if it needs to reflect the current rule, prefer switching it to call `pricing.selectRung`
 * directly instead of re-deriving the walk here.
 */

const { buildMarginLadder, assertAboveFloor } = require('./pricing');
const { createLogger } = require('../logging/logger');

/**
 * SnipeHarness — runs the real SuperProcure bidding strategy on ONE live load.
 * Margin-band model: bid = cost x (1 + margin); open at maxMargin, ladder down to
 * the floor (minMargin), never below. Strategy depends on the close model:
 *   HARD close (Syngenta): establish -> hold L1 -> snipe the floor rung in the
 *     final seconds if not L1. (The classic 3-bid model.)
 *   SOFT close (Renewsys): hold L1 on the thinnest margin; only step down when
 *     actually outranked; never dump at the buzzer (it just extends).
 *
 * Places real bids ONLY when armed with `live: true`. That flag is the whole safety
 * contract with snipe.js, which offers the operator a DRY-RUN and an explicit "type yes to
 * confirm" gate before a live run. It used to be accepted and silently dropped on the floor:
 * arm() destructured only cost/margins, so `live` never landed anywhere, the write backstop
 * was raised unconditionally, and _fire called placeBid on EVERY run. An operator who
 * declined the confirmation was told "not confirmed - running DRY-RUN" and then placed real
 * bids anyway - the prompt was theatre and the log line was a lie.
 *
 * `live` therefore defaults to FALSE, the fail-safe direction and the repo's usual posture: a
 * caller that forgets the flag gets a dry run, never an unintended live bid. Strict `=== true`
 * so no truthy near-miss ('false', 0, 'no') can arm it. In dry-run the backstop stays down and
 * placeBid is never reached, so the run is inert at the wire while still exercising the full
 * ladder, rank and countdown logic - which is exactly what a dry run is for.
 *
 * For a SAFE live test, arm with `live: true` AND a high cost so even the floor margin loses
 * -> it bids for real but can't win.
 */

const CFG = {
  openAtMs: 20_000,    // establish a bid (presence) this far before close
  floorWindowMs: 3_000, // hard-close: the floor rung may fire inside the last 3s
  minLeadMs: 600,      // don't fire so late it can't arrive
  minInterFireMs: 300,
  pollFarMs: 5_000, pollMidMs: 1_000, pollHotMs: 200,
  farMs: 60_000, hotMs: 10_000,
};

class SnipeHarness {
  constructor({ realAdapter, sock, log = createLogger('snipeHarness') }) {
    this.adapter = realAdapter;
    this.sock = sock;
    this.log = log;
  }

  arm(load, { cost, maxMarginPct = 12, minMarginPct = 6, live = false }) {
    const bidLimit = load.revisionLimit ?? 3;
    const rungs = Math.max(3, Math.min(bidLimit, 8)); // coarse on 3-bid loads, fine (capped) on 30-bid
    // Strict === true: only the real boolean arms live bidding, so a stray 'false'/0/'no' from a
    // future CLI flag parser reads as dry-run rather than silently going live (see class doc).
    this.live = live === true;
    // Open the write backstop once, remembering the prior state; _finalize/stop restore it.
    // Leaving it raised would hand a later user of the shared adapter an open gate 2.
    // In dry-run it is never raised at all - the adapter's own backstop then stands as a second
    // belt behind the _fire check below, so a dry run cannot reach the wire even if _fire changed.
    this._priorWriteEnabled = this.adapter.writeEnabled;
    if (this.live) this.adapter.writeEnabled = true;
    this.load = load;
    this.cost = cost;
    this.plan = buildMarginLadder({ cost, maxMarginPct, minMarginPct, rungs });
    this.closeModel = load.softClose ? 'soft' : 'hard';
    this.currentRung = -1;
    this.firedRungs = new Set();
    this.bidsUsed = 0;
    this.bidLimit = bidLimit;
    this.lastFireAt = 0;
    this.inFlight = false;
    this.done = false;
    this.stoodDown = false;

    const m = (p) => ((p / cost - 1) * 100).toFixed(1);
    this.log(`\n[arm] load ${load.id} ${load.lane.origin}->${load.lane.destination} | ${load.equipment} | ${load.companyName}`);
    this.log(`[arm] cost Rs${cost} | margins ${maxMarginPct}% -> ${minMarginPct}% | bids allowed ${bidLimit} | close=${this.closeModel}`);
    this.log(`[arm] ladder: ${this.plan.ladder.map((p) => `Rs${p}(${m(p)}%)`).join(' -> ')} | floor Rs${this.plan.floor}`);

    this.sock.watch(load.id, load.isOpenAuction ? 1 : 0);
    this._tick();
  }

  _closesInMs() { return this.sock.closesInMs(this.load.id, this.load.closesAt); }
  _state() { return this.sock.state(this.load.id) || {}; }

  _cadence(ms) { return ms > CFG.farMs ? CFG.pollFarMs : ms > CFG.hotMs ? CFG.pollMidMs : CFG.pollHotMs; }

  _decide(rank, closesInMs) {
    const last = this.plan.ladder.length - 1;
    // 1) establish a bid so we have a rank. Soft-close: do it EARLY (the close
    //    keeps extending, so waiting for the buzzer means we never get on the board).
    if (this.currentRung < 0) {
      if (this.closeModel === 'soft' || closesInMs <= CFG.openAtMs) {
        return { rung: 0, price: this.plan.ladder[0], why: this.closeModel === 'soft' ? 'establish early (soft close)' : 'establish (open margin)' };
      }
      return null;
    }
    // 2) winning -> hold (give nothing away)
    if (rank === 1) return null;
    // 3) SOFT close: defend by stepping one rung down when outranked; never snipe-dump (it extends)
    if (this.closeModel === 'soft') {
      const next = this.currentRung + 1;
      if (next > last) { this._standDown(); return null; }
      return { rung: next, price: this.plan.ladder[next], why: 'soft: step down, outranked' };
    }
    // 4) HARD close: snipe the floor in the final window; otherwise step gradually
    if (closesInMs <= CFG.floorWindowMs) {
      if (!this.firedRungs.has(last)) return { rung: last, price: this.plan.ladder[last], why: 'HARD: floor snipe' };
      this._standDown(); return null;
    }
    let next = this.currentRung + 1;
    if (next >= last) next = last - 1; // keep the floor for the snipe window
    if (next <= this.currentRung || this.firedRungs.has(next)) return null;
    return { rung: next, price: this.plan.ladder[next], why: 'HARD: gradual step' };
  }

  _standDown() {
    if (!this.stoodDown) { this.stoodDown = true; this.log(`[stand-down] floor reached and not L1 -> walking away (load not profitable)`); }
  }

  async _tick() {
    if (this.done) return;
    const st = this._state();
    const closesInMs = this._closesInMs();
    const rank = st.myRank ?? null;
    if (st.extended) this.closeModel = 'soft'; // live truth: it extended -> soft

    if (closesInMs != null && closesInMs <= 0) return this._finalize(rank);

    if (!this.inFlight && this.bidsUsed < this.bidLimit && Date.now() - this.lastFireAt > CFG.minInterFireMs) {
      const d = closesInMs == null ? null : this._decide(rank, closesInMs);
      if (d && !this.firedRungs.has(d.rung)) {
        const isFloor = d.rung === this.plan.ladder.length - 1;
        const oneway = 80;
        if (isFloor || closesInMs > oneway + CFG.minLeadMs) {
          await this._fire(d, rank, closesInMs);
        }
      }
    }
    const delay = closesInMs == null ? 2000 : this._cadence(closesInMs);
    this._timer = setTimeout(() => this._tick(), delay);
  }

  async _fire(d, rank, closesInMs) {
    assertAboveFloor(d.price, this.plan.floor);
    const m = ((d.price / this.cost - 1) * 100).toFixed(1);
    this.log(`[BID] Rs${d.price} (${m}% margin, rung ${d.rung}) | rank ${rank ?? '-'} | ${(closesInMs / 1000).toFixed(1)}s left | ${d.why}`);
    this.firedRungs.add(d.rung);
    this.currentRung = Math.max(this.currentRung, d.rung);
    this.bidsUsed += 1;
    this.lastFireAt = Date.now();

    this.inFlight = true;
    try {
      // THE SAME payload seam the engine crosses. This harness places REAL bids (`snipe.js --live`)
      // on ANY load the operator picks off listAuctions() - including a PMT one - so it must hand
      // placeBid the load's own LoadRules, not a bare shipmentType bag. Without them
      // `o.pricingMode` is undefined and buildBidPayload takes the FLAT branch. Since the 2026-08-05
      // wire fix that no longer changes the rupee amount (both branches send Math.round(price)), but
      // it does strip every per-tonne GUARD from a harness bid: the SP_PMT_BID gate, the MT-only
      // refusal, the ceiling refusal, and the true in:"PMT" basis on the wire. Carrying the rules
      // routes this harness through the same classification the engine uses (a PMT load is REFUSED
      // while SP_PMT_BID is off), the ceiling belt, and the transit-days refusal - each strictly
      // safer than the silent bid-and-400 it sent before.
      // `floor` is the belt's second operand: buildBidPayload returns no wireFloor without it, so
      // NO floor was asserted at the wire on any harness bid at all. It is the plan floor, the same
      // per-MT number _fire's own assertAboveFloor above compares against, and the adapter now
      // asserts it unscaled against an unscaled amount - per-MT against per-MT.
      // shipmentType is kept last so the legacy passthrough still wins on a flat load: LoadRules
      // keys are disjoint from the createV2 wire keys and `floor` is not a wire field, so a
      // same-carrier FTL bid stays BYTE-IDENTICAL to what this line sent before.
      const opts = Object.assign({}, this.load.rules,
        { shipmentType: this.load.shipmentType, floor: this.plan.floor });
      // The dry-run cutoff sits HERE, after the payload is assembled, so a dry run still proves
      // the opts seam it would have crossed (and still surfaces a floor/classification throw from
      // the lines above) - it just never hands them to the wire.
      if (!this.live) {
        this.log(`   -> DRY-RUN: no bid placed (would have sent Rs${d.price} for load ${this.load.id})`);
        return;
      }
      const res = await this.adapter.placeBid(this.load.id, d.price, opts);
      this.log(`   -> ${res.accepted ? 'ACCEPTED' : 'REJECTED'} status=${res.status} rank=${res.myRank ?? '?'} ${res.reason ? '(' + res.reason + ')' : ''}`);
    } catch (e) {
      this.log(`   -> error: ${e.message}`);
    } finally {
      this.inFlight = false;
    }
  }

  _lowerBackstop() {
    if (this._priorWriteEnabled !== undefined) this.adapter.writeEnabled = this._priorWriteEnabled;
  }

  _finalize(rank) {
    if (this.done) return;
    this.done = true;
    if (this._timer) clearTimeout(this._timer);
    this._lowerBackstop();
    const won = rank === 1;
    this.log(`\n[closed] load ${this.load.id} | final rank ${rank ?? '-'} | ${won ? 'WON (L1)' : 'not L1'} | bids used ${this.bidsUsed}/${this.bidLimit} | close=${this.closeModel}`);
  }

  stop() { this.done = true; if (this._timer) clearTimeout(this._timer); this._lowerBackstop(); }
}

module.exports = { SnipeHarness };
