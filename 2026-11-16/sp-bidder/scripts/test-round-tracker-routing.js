'use strict';
/**
 * Round tracker piece A: what the buzzer does with the verdict and our rank (rulings 39, 47 bullet 1,
 * 57; T2a for GoComet's final round; ruling 28 for SuperProcure rank 1; round-tracker spec s1.6 and
 * s4.1; round-detection map s4 tests 18-20 and 22).
 *
 *   UNCERTAIN, outranked      -> the floor at the buzzer, never a middle price (ruling 47).
 *   UNCERTAIN, rank 1         -> hold, and no desk notice (ruling 39).
 *   FINAL HIGH, rank 1        -> GoComet: the floor at the buzzer (T2a, unchanged); SuperProcure: hold.
 *   hard close, extendCap 0   -> unchanged. Hard close is pinned by scripts/test-timing-sp-decisions-
 *                                unchanged.js check 4 (Durian shape) and check 5 (_effectivelyHard's
 *                                truth table), not duplicated here; no pin drove an extendCap-0 load
 *                                through _tick, so check 7 records one.
 *
 * Every read goes through _tick with a scripted fake adapter on a virtual clock (lib/round-tracker-
 * harness.js). SuperProcure: allowlisted soft, window 100 s, cap 3, rung 0 standing. GoComet: 300 s
 * increment, cap 3, 2 attempts left, rung 0 standing.
 *
 *   node scripts/test-round-tracker-routing.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');

const EXPECTED_CHECKS = 7;
const W = 100_000;
const STEP = 299_000;
const SP_APPROACH = [60_000, 30_000, 10_000, 6_000, 4_000, 2_400, 2_000, 1_600, 1_200, 800, 400];
const GC_APPROACH = [12_000, 10_500, 5_000];
const P = Date.now() + 3_600_000;
let n = 0;

async function spLoad(frame) {
  const load = await H.openLoad({ portal: 'sp', id: `RTR-SP-${n++}`, posted: P, armAt: P - 900_000,
    frame: Object.assign({ extendMs: 120_000, cap: 3, window: W }, frame), seed: { fired: [0], revisionsLeft: 8 } });
  await H.read(load, { at: P - 300_000, close: P, rank: 1 });
  return load;
}

async function gcLoad() {
  const load = await H.openLoad({ portal: 'gc', id: `RTR-GC-${n++}`, posted: P, armAt: P - 900_000,
    seed: { fired: [0], revisionsLeft: 2 } });
  await H.read(load, { at: P - 600_000, close: P, rank: 1, attempts: 2 });
  return load;
}

const floorOf = (load) => load.ladder[load.ladder.length - 1];

// Alerts raised while the approach ran: ruling 39 allows none for an UNCERTAIN rank-1 hold.
async function approachCollectingAlerts(load, opts) {
  const before = load.events.length;
  const bids = await H.approach(load, opts);
  const raised = load.events.slice(before).filter((e) => e.type === 'alert').map((e) => e.kind);
  return { bids, raised };
}

// Recorded at 2811aa7: countdown:rung sent on each read ('-' = no bid, F = the floor).
const CAP0_GOLDEN = ['200000:-', '150000:-', '140000:R0', '60000:R2', '25000:R3', '10000:R4', '3000:R5', '2400:R6', '1000:-'];

(async () => {
  const { check, done } = H.runner('Round tracker piece A: routing by verdict and rank (rulings 39, 47, 57)', EXPECTED_CHECKS);

  await check('1 map 18 SP: unpublished increment, a real 300 s round read at countdown 60 s -> UNCERTAIN, outranked -> floor', 'red', async () => {
    const load = await spLoad({ extendMs: null });
    await H.read(load, { at: P - 60_000, close: P + 300_000, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 1, `HARNESS: the 300 s round counted as ${load.m.extendsObserved}`);
    const bids = await H.approach(load, { close: P + 300_000, rank: 2, countdowns: SP_APPROACH });
    const late = bids.filter((b) => b.countdown <= 2_500);
    assert.ok(late.some((b) => b.price === floorOf(load)),
      `a round whose 300 s move is off the 180 s fallback grid is UNCERTAIN; outranked at its buzzer the floor must go `
      + `(ruling 47), sent ${H.fmtBids(load, late)} at <= 2,500 ms: the pre-cap buzzer shot treats it as a known pre-final round`);
    const v = H.verdictOf(load);
    assert.strictEqual(v.verdict, 'UNCERTAIN', `verdict ${v.verdict} (${v.reason}), expected UNCERTAIN`);
  });

  await check('2 map 18 GoComet: 121 s round in the window, outranked at the buzzer with 2 attempts -> floor, not a middle price', 'red', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 60_000, close: P + 121_000, rank: 1, attempts: 2 });
    const bids = await H.approach(load, { close: P + 121_000, rank: 2, attempts: 2, countdowns: GC_APPROACH });
    const buzzer = bids.filter((b) => b.countdown <= 6_500);
    assert.ok(buzzer.length === 1 && buzzer[0].price === floorOf(load),
      `UNCERTAIN round (a 121 s move, off the 300 s grid), outranked at the buzzer: expected exactly the floor `
      + `(ruling 47), sent ${H.fmtBids(load, buzzer)}: the round reads as pre-final round 0, which keeps the floor`);
    assert.ok(!bids.some((b) => b.countdown > 6_500), `a bid went before the buzzer: ${H.fmtBids(load, bids)}`);
  });

  await check('3 map 19 SP: UNCERTAIN (published 60 s, 300 s moves) at rank 1 -> hold through the close, no desk notice', 'positive', async () => {
    const load = await spLoad({ extendMs: 60_000, cap: 5 });
    await H.read(load, { at: P - 95_000, close: P + 300_000, rank: 1 });
    await H.read(load, { at: P + 300_000 - 95_000, close: P + 600_000, rank: 1 });
    const { bids, raised } = await approachCollectingAlerts(load, { close: P + 600_000, rank: 1, countdowns: SP_APPROACH });
    assert.strictEqual(bids.length, 0, `rank 1 in an UNCERTAIN round placed ${H.fmtBids(load, bids)}`);
    assert.strictEqual(raised.length, 0, `rank 1 in an UNCERTAIN round raised ${raised.join(', ')} (ruling 39: no notice)`);
  });

  await check('4 map 19 GoComet: +2 h close edit in the window, rank 1 at the next buzzer -> hold, no desk notice', 'red', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 100_000, close: P + 7_200_000, rank: 1, attempts: 2 });
    const { bids, raised } = await approachCollectingAlerts(load,
      { close: P + 7_200_000, rank: 1, attempts: 2, countdowns: GC_APPROACH });
    assert.strictEqual(bids.length, 0,
      `after a +2 h close edit (UNCERTAIN, not 24 rounds) the load at rank 1 sent ${H.fmtBids(load, bids)}: `
      + 'the edit was counted as rounds past the cap, so the rank-1 final-round floor fired');
    assert.strictEqual(raised.length, 0, `rank 1 in an UNCERTAIN round raised ${raised.join(', ')} (ruling 39: no notice)`);
  });

  await check('5 map 20 GoComet: FINAL HIGH (3 on-grid rounds) at rank 1 -> floor at the buzzer', 'positive', async () => {
    const load = await gcLoad();
    for (let i = 1; i <= 3; i++) {
      await H.read(load, { at: P + (i - 1) * STEP - 60_000, close: P + i * STEP, rank: 1, attempts: 2 });
    }
    const bids = await H.approach(load, { close: P + 3 * STEP, rank: 1, attempts: 2, countdowns: GC_APPROACH });
    assert.ok(bids.length === 1 && bids[0].price === floorOf(load) && bids[0].countdown <= 6_500,
      `confirmed final round at rank 1: expected exactly the floor at the buzzer (T2a), sent ${H.fmtBids(load, bids)}`);
  });

  await check('6 map 20 SP: FINAL HIGH (3 on-grid rounds) at rank 1 -> hold through the close', 'positive', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 30_000, close: P + 120_000, rank: 1 });
    await H.read(load, { at: P + 120_000 - 30_000, close: P + 240_000, rank: 1 });
    await H.read(load, { at: P + 240_000 - 30_000, close: P + 360_000, rank: 1 });
    const bids = await H.approach(load, { close: P + 360_000, rank: 1, countdowns: SP_APPROACH });
    assert.strictEqual(bids.length, 0, `SuperProcure at rank 1 in its final round placed ${H.fmtBids(load, bids)} (ruling 28: hold)`);
  });

  await check('7 map 22 SP extendCap 0 (allowlisted soft, no anti-snipe round possible): decisions unchanged', 'positive', async () => {
    const load = await H.openLoad({ portal: 'sp', id: `RTR-SP-${n++}`, posted: P, armAt: P - 900_000,
      frame: { extendMs: 180_000, cap: 0, window: W } });
    const steps = [[200_000, null], [150_000, null], [140_000, null], [60_000, 3], [25_000, 2], [10_000, 2],
      [3_000, 2], [2_400, 2], [1_000, 2]];
    const trace = [];
    for (const [cd, rank] of steps) {
      const sent = await H.read(load, { at: P - cd, close: P, rank });
      const rung = (b) => (load.ladder.indexOf(b.price) === load.ladder.length - 1 ? 'F' : `R${load.ladder.indexOf(b.price)}`);
      trace.push(`${cd}:${sent.length ? sent.map(rung).join('+') : '-'}`);
    }
    assert.deepStrictEqual(trace, CAP0_GOLDEN,
      `extendCap-0 decisions moved: got [${trace.join(', ')}], recorded [${CAP0_GOLDEN.join(', ')}]`);
  });

  done();
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
