'use strict';
/**
 * GoComet EXTENSION SEQUENCES - a real BidEngine driven against the GoComet simulator.
 *
 * GoComet is a reactive-countdown reverse auction: a bid inside the reactive window pushes the
 * deadline out, roughly two in three auctions extend at least once, one observed load extended 22
 * times - and every vendor gets THREE revisions per enquiry, which do not reset on an extension.
 * So the thing that has to be pinned is not "does it survive an extension" alone, it is "does it
 * survive an extension WITH ammunition left", and both are asserted in every sequence below.
 *
 *   S1  zero extensions - the baseline arc, three bids, floor last, auction resolves
 *   S2  one extension via a forward countdown jump (30s -> 329s)
 *   S3  one extension behind a countdown that reads zero and is HELD there ~8s
 *       S3c the control: the same run with the increment published as ZERO - it MUST finalize
 *   S4  22 consecutive extensions - alive at the end, never more than 3 bids, last one the floor
 *   S5  OUR OWN floor bid causes the extension
 *
 * DETERMINISM, and the one place it is not free. The simulator's clock is injected and moves only
 * when this file moves it. The ENGINE has no clock seam - _tick reads Date.now() directly for the
 * sustained-zero finalize debounce (bidEngine.js:1351, :1404) and for the inter-fire gate. Both are
 * handled without a real sleep: minInterFireMs is configured to 0, and where wall-clock passage
 * must be simulated the monitor's _zeroSince is backdated explicitly (see elapseWallClock). Every
 * tick is invoked by hand and its self-rescheduled timer cleared, so no timer outlives the file.
 *
 *   node scripts/test-gocomet-extension-sequences.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometSim, GoCometSimAdapter, EXTEND_STEP_MS } = require('../src/sim/gocometSim');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The runner grades by EXIT CODE only, so a file that returns early or never awaits its async work
// exits 0 having asserted nothing and reads as a silent green. The sentinel at the bottom pins the
// exact number of checks that ran.
const EXPECTED_CHECKS = 40;

let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-ext-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// The desk band. buildBandLadder -> [78820, 75040, 74410]; the floor rung is the last.
const COST = 70_000;
const MARGINS = [12.6, 7.2, 6.3];

const detach = (m) => { if (m.timer) { clearTimeout(m.timer); m.timer = null; } };

/**
 * A live GoComet monitor on the simulator.
 *
 * finalizeDebounceMs is 0 DELIBERATELY - the most hostile setting available. It removes the base
 * clock-skew guard entirely, so across a zeroed countdown the ONLY thing that can keep the monitor
 * alive is a POSITIVE state.extendMs. That is what makes S3's control (S3c) a genuine falsifier
 * rather than a test of a generous timeout: S3c publishes the increment as ZERO - the platform
 * stating it runs no anti-snipe rounds - which is the one value that legitimately leaves the settle
 * window at the bare debounce. An ABSENT increment is a different fact and no longer collapses to it.
 */
function harness({
  closesInMs = 600_000, reactiveWindowMs = 0, settleMs = 0, zeroExtendMs = false,
} = {}) {
  let t = Date.now();
  const sim = new GoCometSim({ clock: () => t, closesInMs, reactiveWindowMs, settleMs });
  const adapter = new GoCometSimAdapter(sim);
  if (zeroExtendMs) {
    const inner = adapter.getAuctionState.bind(adapter);
    adapter.getAuctionState = async (id) => { const s = await inner(id); s.extendMs = 0; return s; };
  }
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: {
      openAtMs: 15_000, floorWindowMs: 2_500, finalizeDebounceMs: 0,
      minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0,
    },
    softClose: { enabled: true, shippers: ['Waaree'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
  });
  const m = eng.arm({
    id: 'GC-SIM-1', lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL',
    units: 1, quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: sim.closesAt,
    rules: { revisionLimit: 3, minDecrement: sim.minDecrement },
  }, { cost: COST, marginsPct: MARGINS });
  detach(m); // arm() self-schedules at 0ms; every tick in this file is invoked by hand

  // Move the sim clock so the countdown reads `ms`. Forward-only: a deadline that has already been
  // extended can never be rewound, and a test that silently moved time backwards would be lying.
  const advanceTo = (ms) => {
    const target = sim.closesAt - ms;
    if (target < t) throw new Error(`advanceTo(${ms}) would move the sim clock backwards`);
    t = target;
  };
  const advance = (ms) => { t += ms; };
  const tick = async () => { await eng._tick(m); detach(m); };
  return { sim, adapter, eng, m, events, advanceTo, advance, tick };
}

/**
 * Simulate wall-clock passage on the ONE gate the engine reads off Date.now() and that has no
 * clock seam: the sustained-zero finalize debounce. Backdating _zeroSince is exactly what a real
 * sleep would achieve, minus the sleep.
 */
const elapseWallClock = (m, ms) => { if (m._zeroSince != null) m._zeroSince -= ms; };

const floorOf = (m) => m.ladder[m.ladder.length - 1];

(async () => {
  // ---- S1. ZERO EXTENSIONS: the baseline arc ---------------------------------------------------
  // reactiveWindowMs 0 models the third of GoComet auctions that never extend. It is also the ONLY
  // shape in which this engine can currently run a GoComet auction without self-extending it - see
  // S5 for why.
  {
    const h = harness({ reactiveWindowMs: 0 });
    const last = h.m.ladder.length - 1;

    h.advanceTo(20_000);
    await h.tick();
    ok(h.sim.ourBids().length === 0, 'S1: nothing bid above the establish mark (soft loads establish late)');

    h.advanceTo(12_000);
    await h.tick();
    ok(h.sim.ourBids().length === 1 && h.m.firedRungs.has(0)
      && h.sim.ourBids()[0].price === h.m.ladder[0], 'S1: establish places rung 0 at the opening price');
    ok(h.m.revisionsLeft === 2, 'S1: the establish spent exactly one of three revisions');

    h.sim.rivalBid('RIVAL-1', 76_000);
    h.advanceTo(8_000);
    await h.tick();
    ok(h.sim.ourBids().length === 2 && h.m.firedRungs.has(1)
      && h.sim.ourBids()[1].price === h.m.ladder[1], 'S1: outranked outside the final window -> defends one rung, floor held');

    h.sim.rivalBid('RIVAL-1', 74_800);
    h.advanceTo(2_000);
    await h.tick();
    const ours = h.sim.ourBids();
    ok(ours.length === 3 && ours[2].price === floorOf(h.m) && h.m.firedRungs.has(last),
      'S1: the floor lands as the third and final bid');
    ok(h.m.revisionsLeft === 0 && h.sim.extensions.length === 0,
      'S1: all three revisions spent and the auction never extended');

    h.advanceTo(0);
    await h.tick();
    ok(h.m.finalized === false, 'S1: a single zeroed read does not finalize a soft load');
    elapseWallClock(h.m, 400_000); // > extendMs + finalizeDebounceMs
    await h.tick();
    ok(h.m.finalized === true && h.m.won === true && h.m.myRank === 1,
      'S1: the auction resolves cleanly once the zero is sustained past extendMs - we hold L1 at the floor');
  }

  // ---- S2. ONE EXTENSION VIA A FORWARD COUNTDOWN JUMP (30s -> 329s) ----------------------------
  {
    const h = harness({ reactiveWindowMs: 0 });
    h.advanceTo(30_000);
    await h.tick();
    ok(h.m.extendsObserved === 0 && h.m.believedCloseAt === h.sim.closesAt,
      'S2: the first tick adopts the published close and counts no extension');
    ok(h.m.closesInMs === 30_000 && h.m.revisionsLeft === 3, 'S2: 30s remaining, full revision budget');

    const closeBefore = h.sim.closesAt;
    h.sim.extend('platform');
    await h.tick();
    ok(h.m.finalized === false, 'S2: the monitor survives the extension - it does NOT finalize');
    ok(h.m.closesInMs === 30_000 + EXTEND_STEP_MS,
      'S2: the countdown jumped forward to 329s and the engine is reasoning against the new one');
    ok(h.m.extendsObserved === 1 && h.m.believedCloseAt === closeBefore + EXTEND_STEP_MS,
      'S2: the forward jump is counted once and the believed close moves with it');
    ok(h.m.revisionsLeft === 3 && h.sim.ourBids().length === 0,
      'S2: ammunition intact - an extension costs no revision');
    const ext = h.events.filter((e) => e.type === 'extension_observed');
    ok(ext.length === 1 && !ext[0].inferred,
      'S2: exactly one extension_observed, from the published jump rather than inferred');
  }

  // ---- S3. THE AMBIGUOUS ZERO: countdown reads 0 and is HELD there ~8s -------------------------
  // settleMs 30s means the platform has NOT declared bidding over; the countdown is simply at zero
  // while the new deadline is written. This is the instant that used to abandon live auctions.
  {
    const h = harness({ reactiveWindowMs: 0, settleMs: 30_000 });
    h.advanceTo(12_000);
    await h.tick();
    ok(h.sim.ourBids().length === 1 && h.m.revisionsLeft === 2, 'S3: established before the close, two revisions left');

    h.advanceTo(0);
    let heldAlive = true;
    for (let i = 0; i < 4; i += 1) { // 4 ticks spanning 8s of held zero
      await h.tick();
      if (h.m.finalized) heldAlive = false;
      h.advance(2_000);
    }
    ok(heldAlive, 'S3: the monitor does NOT finalize across ~8s of a countdown held at zero');
    ok(h.m.extendsObserved === 0,
      'S3: no extension is inferred from the zero run - the adapter nulls closesAtMs at zero, so the '
      + "engine's zero-run inference is structurally unreachable on GoComet");
    ok(h.sim.isOver() === false, 'S3: the auction really was still live throughout the zero run');

    const closeBefore = h.sim.closesAt;
    h.sim.extend('platform');
    await h.tick();
    ok(h.m.finalized === false, 'S3: still alive once the new deadline lands');
    ok(h.m.extendsObserved === 1 && h.m.believedCloseAt === closeBefore + EXTEND_STEP_MS,
      'S3: the extension behind the zero is counted when the close is finally published');
    ok(h.m.closesInMs === EXTEND_STEP_MS - 8_000 && h.m.revisionsLeft === 2,
      'S3: the countdown resumes at the new deadline with both remaining revisions intact');
  }

  // ---- S3c. THE CONTROL: the identical run with the increment published as ZERO -----------------
  // On a branch that declares no anti-snipe rounds the finalize debounce is the bare
  // finalizeDebounceMs (0 here), so the FIRST zeroed read finalizes - permanently, since _finalize is
  // terminal. If this ever stops failing, S3 above has stopped testing anything.
  {
    const h = harness({ reactiveWindowMs: 0, settleMs: 30_000, zeroExtendMs: true });
    h.advanceTo(12_000);
    await h.tick();
    ok(h.m.finalized === false, 'S3c: alive while the countdown is still running');
    h.advanceTo(0);
    await h.tick();
    ok(h.m.finalized === true,
      'S3c: with the increment published as ZERO the very first zeroed read finalizes the monitor - S3 is non-vacuous');
    ok(h.sim.isOver() === false,
      'S3c: ...and it did so while the auction was still live, i.e. abandoned it');
  }

  // ---- S4. 22 CONSECUTIVE EXTENSIONS ------------------------------------------------------------
  // The observed worst case. The point of the sequence is the ammunition: 22 rounds are fought with
  // the same three revisions a single-round auction gets, and they are all gone after round one.
  {
    const h = harness({ reactiveWindowMs: 0 });
    const last = h.m.ladder.length - 1;
    const postedClose = h.sim.postedCloseAt;

    for (let round = 1; round <= 22; round += 1) {
      h.advanceTo(12_000);
      await h.tick();
      if (round === 1) h.sim.rivalBid('RIVAL-1', 76_000);
      h.advanceTo(6_000);
      await h.tick();
      if (round === 1) h.sim.rivalBid('RIVAL-1', 74_800);
      h.advanceTo(2_000);
      await h.tick();
      h.sim.extend('platform');
    }
    h.advanceTo(12_000);
    await h.tick(); // observe the 22nd extension

    ok(h.m.finalized === false, 'S4: the monitor is still alive after 22 extensions');
    ok(h.m.extendsObserved === 22 && h.sim.extensions.length === 22, 'S4: all 22 extensions counted');
    const ours = h.sim.ourBids();
    ok(ours.length === 3, 'S4: never more than 3 bids were placed across 22 rounds');
    ok(ours[ours.length - 1].price === floorOf(h.m) && h.m.firedRungs.has(last),
      'S4: the last bid placed is the floor');
    ok(h.m.revisionsLeft === 0, 'S4: the revision budget is exhausted and does not reset on an extension');
    ok(h.sim.closesAt - postedClose >= 22 * EXTEND_STEP_MS,
      'S4: the auction ran more than 90 minutes past its posted close');
    const noRev = h.events.filter((e) => e.kind === 'no_revisions_left');
    ok(noRev.length === 1, 'S4: the exhausted-budget alert fires once, not once per tick');
    ok(ours.every((b) => b.extended === false),
      'S4: none of our own three bids caused an extension on this load (reactive window 0)');
  }

  // ---- S5. OUR OWN FLOOR BID CAUSES AN EXTENSION -----------------------------------------------
  // The sequence only the simulator can give, and the central strategic claim about this platform.
  // The establish at 12s sits OUTSIDE the 10s reactive window and does not extend; the floor snipe
  // at 2s sits inside it and does. The engine fires there because gocometAdapter publishes no
  // triggerWindowMs, so _decisiveBandFor is null and the shot falls back to _isLastChance (2.5s).
  {
    const h = harness({ reactiveWindowMs: 10_000 });
    const last = h.m.ladder.length - 1;

    h.advanceTo(12_000);
    await h.tick();
    ok(h.sim.ourBids().length === 1 && h.sim.extensions.length === 0,
      'S5: the establish lands outside the reactive window and extends nothing (the control)');

    h.sim.rivalBid('RIVAL-1', 76_000);
    const closeBefore = h.sim.closesAt;
    h.advanceTo(2_000);
    await h.tick();

    const ours = h.sim.ourBids();
    ok(ours.length === 2 && ours[1].price === floorOf(h.m) && h.m.firedRungs.has(last),
      'S5: the engine spends the floor inside the final window');
    ok(h.sim.extensions.length === 1 && h.sim.extensions[0].causedBy === 'US',
      'S5: the extension was caused by OUR OWN bid, not by a rival and not by the platform');
    ok(h.sim.closesAt === closeBefore + EXTEND_STEP_MS && ours[1].extended === true,
      'S5: the close moved forward one full extension increment on our floor bid');
    ok(h.m.triggerWindowMs == null && h.eng._decisiveBandFor(h.m) === null,
      'S5: the engine had NO model of the reactive window - GoComet publishes no triggerWindowMs, so '
      + 'the decisive band is null and the shot falls back to the 2.5s last-chance answer');
    ok(h.m.snipeFired === true && h.m.revisionsLeft === 1,
      'S5: our best price is on the board with a whole extension still to run, and the decisive rung '
      + 'is spent - one revision left but nothing lower to answer with');

    await h.tick();
    ok(h.m.finalized === false && h.sim.ourBids().length === 2,
      'S5: the monitor keeps running into the extension it caused, placing nothing further');
  }

  // ---- completion sentinel ---------------------------------------------------------------------
  assert.strictEqual(fail, 0, `${fail} GoComet extension-sequence checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('test crashed:', e && e.stack || e); process.exit(1); });
