'use strict';
/**
 * The revision budget is a ONE-WAY belief: platform state may lower it, never raise it.
 *
 * THE DEFECT this pins against. _tick re-seeded monitor.revisionsLeft from state.revisionsLeft on
 * EVERY tick, so an adapter that publishes a per-load remaining count on getAuctionState but does
 * not echo one back on placeBid handed the budget straight back after every accepted bid. The
 * `revisionsLeft <= 0` stand-down in _maybeBid then became unreachable and the engine spent past
 * the platform's own per-load cap - and a cap refusal is TERMINAL for the load here (capExhausted
 * + revisionsLeft 0), so the overspend abandons the rest of the ladder and the floor shot with it.
 * The same re-seed undid _detectForeignBids' shared-account discount on the very next tick.
 *
 * SuperProcure never reached it - realAdapter.getAuctionState hardcodes revisionsLeft null - but
 * gocometAdapter publishes it off bidding-data, and GoComet caps revisions at 3 per vendor per
 * enquiry while BRL's other bot bids the SAME vendor identity. So the defect arms on the first
 * GoComet load another bot has already bid.
 *
 * WHAT THIS PINS:
 *   A. the engine stops at the platform cap when the platform keeps republishing a full budget.
 *   B. the foreign-bid discount survives subsequent ticks.
 *   C. the direction the original re-seed existed to serve STILL WORKS - a remaining count that
 *      DROPS between our ticks (a human or another bot spent one) lowers the engine's belief.
 *   D. seeding is unchanged where the engine holds no belief yet, from either state field.
 *   E. an exhausted budget carried on the durable intent survives a re-arm, where capExhausted -
 *      which is per-monitor and reset to false by arm() - can no longer hold the line.
 *   F. the transport-landed persist carries revisionsLeft, so a restart does not resurrect a
 *      revision that write already spent.
 *
 * Offline and deterministic: fake adapters, no token, no network.
 *
 *   node scripts/test-revisions-budget-monotonic.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const EXPECTED_CHECKS = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (n) => path.join(os.tmpdir(), `rbm-${n}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
const cleanup = (f) => { try { fs.unlinkSync(f); } catch (_) {} };

const CAP = 3;                            // GoComet: 3 revisions per vendor per enquiry
const META = (id, closesAt) => ({ id, lane: { origin: 'Bhiwandi', destination: 'Hyderabad' },
  equipment: '32ft', units: 1, companyName: 'Waaree Energies', closesAt });
const INPUTS = { cost: 40_000, marginsPct: [22, 16, 10] };

/**
 * A rank-only portal that publishes a live remaining count, shaped like gocometAdapter: the count
 * comes off the read (`revisions_left` on bidding-data) and the write echoes none, so the engine
 * has to do its own decrementing. `remaining` is a function of the tick index so a scenario can
 * script what the portal reports and when.
 */
function portal({ remaining = () => CAP, revisionLimit = CAP, rank = (placed) => (placed > 0 ? 2 : null),
                  closesInMs = 600_000, standingFrom = null, capabilities = null } = {}) {
  return {
    placed: [], refusedOverCap: 0, ticks: 0, _standing: standingFrom,
    capabilities: () => capabilities || ({ standingPriceVisible: standingFrom != null, minDecrement: 100,
      allowsTieRate: false, revisionLimit, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      this.ticks += 1;
      if (this._standing != null) this._standing -= 300;
      return {
        ok: true, status: 'live', myRank: rank(this.placed.length), totalBidders: 4,
        standingL1Price: this._standing,
        closesInMs,
        revisionsLeft: remaining(this.ticks, this.placed.length),
        revisionLimit,
        closeModel: 'hard', measuredRttMs: 30,
      };
    },
    async placeBid(id, price) {
      this.placed.push(price);
      if (this.placed.length > CAP) {
        this.refusedOverCap += 1;
        return { accepted: false, reason: 'Bid limit exceeded', status: 400, text: 'Bid limit exceeded', latencyMs: 20 };
      }
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    },
  };
}

/** Arm one load, let it tick, snapshot before stop (stop deletes the monitor). */
async function observe(a, { id, waitMs, config = {}, closesAt = Date.now() + 600_000 } = {}) {
  const f = tmp(id);
  const events = [];
  const engine = new BidEngine(a, new DurableScheduler(f), {
    config: Object.assign({ cadenceJitterMs: 0, pollFarMs: 60, pollMidMs: 60 }, config),
    onEvent: (e) => events.push(e), rand: () => 0,
  });
  engine.arm(META(id, closesAt), INPUTS);
  await sleep(waitMs);
  const snap = engine.snapshot().find((m) => m.auctionId === id) || null;
  const intent = engine.scheduler.get(id) || null;
  engine.kill('test'); engine.stop(id); cleanup(f);
  return { events, snap, intent };
}

const alerts = (events, kind) => events.filter((e) => e.type === 'alert' && e.kind === kind);

(async () => {
  // ==========================================================================================
  // A. THE HEADLINE. The portal republishes a full budget on every read while the write echoes
  //    none. The engine must still stop at the cap - every bid past it is a "Bid limit exceeded"
  //    refusal on a shared live vendor identity, and this engine treats that as terminal.
  // ==========================================================================================
  {
    const a = portal({ standingFrom: 68_000, closesInMs: 8_000 });
    const { snap } = await observe(a, { id: 'GC-CAP', waitMs: 2_500,
      config: { maxBidsPerMin: 60 } }); // out of the way: revisionsLeft is the guard under test

    ok(a.placed.length >= 2, `A precondition: the engine really walked the ladder (got ${a.placed.length} bids)`);
    ok(a.placed.length <= CAP, `A the engine placed at most the platform cap of ${CAP} (got ${a.placed.length})`);
    ok(a.refusedOverCap === 0,
      `A no bid was spent past the platform cap (got ${a.refusedOverCap} "Bid limit exceeded" refusals)`);
    ok(snap && snap.revisionsLeft === 0,
      `A the belief reached 0, so the stand-down guard is reachable (got ${snap && snap.revisionsLeft})`);
  }

  // ==========================================================================================
  // B. The shared-account discount must survive the ticks that follow it. _detectForeignBids
  //    gives back the one slot a standing pre-existing rank PROVES is spent; a re-seed from the
  //    portal's own (lagging) count hands it straight back.
  // ==========================================================================================
  {
    const a = portal({ rank: () => 2 });   // a rank exists before this bot has bid at all
    const { events, snap } = await observe(a, { id: 'GC-FGN', waitMs: 400 });

    ok(a.ticks >= 3, `B precondition: several ticks ran after the detection (got ${a.ticks})`);
    ok(a.placed.length === 0, 'B precondition: no bid fired, so the belief reflects the discount alone');
    ok(alerts(events, 'foreign_bids_detected').length === 1, 'B the foreign-bid detection fired once');
    ok(snap && snap.revisionsLeft === CAP - 1,
      `B the discounted budget survives later ticks (got ${snap && snap.revisionsLeft}, want ${CAP - 1})`);
  }

  // ==========================================================================================
  // C. THE DIRECTION THAT MUST KEEP WORKING. A remaining count that DROPS between our ticks is
  //    a revision someone else spent, and the engine must take it. This is the case the original
  //    unconditional re-seed was serving, and losing it would trade one overspend for another.
  // ==========================================================================================
  {
    const a = portal({ rank: () => null, remaining: (t) => (t >= 3 ? 1 : CAP) });
    const { snap } = await observe(a, { id: 'GC-DROP', waitMs: 400 });

    ok(a.ticks >= 4, `C precondition: the drop was published and re-read (got ${a.ticks} ticks)`);
    ok(a.placed.length === 0, 'C precondition: no bid of ours moved the belief');
    ok(snap && snap.revisionsLeft === 1,
      `C a lower live remaining still lowers the engine's belief (got ${snap && snap.revisionsLeft})`);
  }

  // ==========================================================================================
  // D. Seeding where the engine holds NO belief yet is unchanged, from either state field.
  // ==========================================================================================
  {
    // D1: the portal publishes a live remaining and capabilities() carries no static cap.
    const caps = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'hard' };
    const a = portal({ rank: () => null, remaining: () => 2, revisionLimit: null, capabilities: caps });
    const { snap } = await observe(a, { id: 'GC-SEED', waitMs: 250 });
    ok(snap && snap.revisionsLeft === 2,
      `D a null belief is still seeded from the live remaining (got ${snap && snap.revisionsLeft})`);
  }
  {
    // D2: the SuperProcure shape - no live remaining anywhere, only the static per-load cap.
    const caps = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'hard' };
    const a = portal({ rank: () => null, remaining: () => null, revisionLimit: CAP, capabilities: caps });
    const { snap } = await observe(a, { id: 'SP-SEED', waitMs: 250 });
    ok(snap && snap.revisionsLeft === CAP,
      `D a null belief still seeds from the static revisionLimit (got ${snap && snap.revisionsLeft})`);
  }

  // ==========================================================================================
  // E. An exhausted budget on the durable intent survives a RE-ARM. capExhausted is per-monitor
  //    and arm() rebuilds it as false, so the latch cannot hold this line - only the one-way
  //    clamp can. The re-price path (stop + arm) and the boot supervisor both land here.
  // ==========================================================================================
  {
    const f = tmp('EXH');
    const closesAt = Date.now() + 600_000;
    const a = portal({ rank: () => null });          // portal insists CAP remain, every tick
    const engine = new BidEngine(a, new DurableScheduler(f), {
      config: { cadenceJitterMs: 0, pollFarMs: 60, pollMidMs: 60 }, rand: () => 0 });

    engine.arm(META('EXH', closesAt), INPUTS);
    engine.scheduler.update('EXH', { revisionsLeft: 0 });  // what a cap rejection persists
    engine.stop('EXH');
    engine.arm(META('EXH', closesAt), INPUTS);             // the re-arm
    await sleep(300);
    const snap = engine.snapshot().find((m) => m.auctionId === 'EXH') || null;
    engine.kill('test'); engine.stop('EXH'); cleanup(f);

    ok(snap && snap.capExhausted === false,
      'E precondition: the re-armed monitor lost the capExhausted latch, as arm() always rebuilds it');
    ok(a.ticks >= 2, `E precondition: the portal re-published a full budget across ticks (got ${a.ticks})`);
    ok(snap && snap.revisionsLeft === 0,
      `E the spent budget carried on the intent is not un-spent by the portal (got ${snap && snap.revisionsLeft})`);
    ok(a.placed.length === 0, 'E and nothing reached the wire on an exhausted load');
  }

  // ==========================================================================================
  // F. The sibling: a write counted as LANDED after a transport failure spends a revision, and
  //    that spend must reach the durable intent. Without it a restart mid-auction rehydrates the
  //    load believing it still holds a revision SuperProcure's own counter has already taken -
  //    which does not end in an extra rung, it ends in a terminal cap rejection.
  // ==========================================================================================
  {
    const f = tmp('THROW');
    const closesAt = Date.now() + 12_000;   // inside openAtMs, so the establishing rung fires
    // The SuperProcure shape: no live remaining anywhere, so the read-back cannot disprove the
    // write and the engine's own decrement is the only record of the spend.
    const a = {
      placed: [], calls: 0,
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
        revisionLimit: CAP, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        return { ok: true, status: 'live', myRank: null, totalBidders: 2, standingL1Price: null,
          closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: null, revisionLimit: CAP,
          closeModel: 'hard', measuredRttMs: 30 };
      },
      async placeBid(id, price) {
        this.calls += 1; this.placed.push(price);
        const e = new Error('socket hang up'); e.code = 'NETWORK'; throw e;
      },
    };
    const engine = new BidEngine(a, new DurableScheduler(f), {
      config: { cadenceJitterMs: 0, pollHotMs: 60, maxBidsPerMin: 1 }, rand: () => 0 });
    engine.arm(META('THROW', closesAt), INPUTS);
    await sleep(600);
    const snap = engine.snapshot().find((m) => m.auctionId === 'THROW') || null;
    engine.kill('test'); engine.stop('THROW');

    ok(a.calls >= 1, `F precondition: a write reached the wire and threw (got ${a.calls})`);
    ok(snap && snap.revisionsLeft === CAP - 1,
      `F the landed-but-unconfirmed write spent a revision in memory (got ${snap && snap.revisionsLeft})`);

    // The restart: a fresh engine reading the same intents file must inherit the spend.
    const a2 = {
      placed: [], capabilities: a.capabilities, ensureSession: async () => ({}),
      getAuctionState: a.getAuctionState,
      async placeBid(id, price) { this.placed.push(price); return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }; },
    };
    const engine2 = new BidEngine(a2, new DurableScheduler(f), {
      config: { cadenceJitterMs: 0, pollHotMs: 60, maxBidsPerMin: 1 }, rand: () => 0 });
    await engine2.rehydrate();
    const snap2 = engine2.snapshot().find((m) => m.auctionId === 'THROW') || null;
    engine2.kill('test'); engine2.stop('THROW'); cleanup(f);

    ok(snap2 && snap2.revisionsLeft === CAP - 1,
      `F the spend survives the restart, so the budget is not resurrected (got ${snap2 && snap2.revisionsLeft})`);
  }

  // ---- completion sentinel ----
  // The runner grades by EXIT CODE, so an early return or a swallowed throw would otherwise exit 0
  // as a green zero-assertion run. Assert the full check count actually executed.
  assert.strictEqual(fail, 0, `${fail} revision-budget checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
