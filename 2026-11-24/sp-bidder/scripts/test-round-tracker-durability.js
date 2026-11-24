'use strict';
/**
 * Round tracker piece A: the round count survives what the process does to it (ruling 41 "restarts
 * must not affect bidding"; ruling 44 bullet 2; ruling 18 re-homed by spec s2.2; round-tracker spec
 * s2 and s5.3; round-detection map s4 tests 7 and 8).
 *
 *   1-2  map 7, SuperProcure: restart inside round 3 of 3, whether the engine saw the three rounds or
 *        was down for all of them. The first buzzer after the restart sends the floor.
 *        (map 7 on GoComet is already pinned, green by design, by
 *        scripts/test-gocomet-round-count-restart-safe.js checks 2 and 3; not duplicated here.)
 *   3    map 8: a desk re-price (stop + arm) inside round 2 carries R, and the one pre-cap shot per
 *        round already spent in round 2 is not spent again.
 *   4-6  ruling 44: a GoComet load down across three extensions and restarted more than 600 s past its
 *        saved close is re-armed, not retired closed_while_down, while rounds are left; one whose cap
 *        was already reached still retires.
 *   7    a failed round-record write raises one alert and the next tick writes it (ruling 18's
 *        swallowed warn at _persistBelievedClose is the mechanism).
 *
 * Restart = kill() plus a NEW BidEngine over a NEW DurableScheduler on the same file, then
 * rehydrate(), on a virtual clock (lib/round-tracker-harness.js). SuperProcure: allowlisted soft,
 * increment 120 s, cap 3, window 100 s, rung 0 standing. GoComet: 299 s rounds on 300 s, cap 3
 * unless the load's roundPolicy says otherwise, 2 attempts left.
 *
 *   node scripts/test-round-tracker-durability.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');

const EXPECTED_CHECKS = 7;
const INC = 120_000;
const W = 100_000;
const STEP = 299_000;
const SP_APPROACH = [60_000, 30_000, 10_000, 6_000, 4_000, 2_400, 2_000, 1_600, 1_200, 800, 400];
const GC_APPROACH = [12_000, 10_500, 5_000];
const P = Date.now() + 3_600_000;
let n = 0;

async function spLoad() {
  const load = await H.openLoad({ portal: 'sp', id: `RTD-SP-${n++}`, posted: P, armAt: P - 900_000,
    frame: { extendMs: INC, cap: 3, window: W }, seed: { fired: [0], revisionsLeft: 8 } });
  await H.read(load, { at: P - 300_000, close: P, rank: 1 });
  return load;
}

async function gcLoad(roundPolicy) {
  const load = await H.openLoad({ portal: 'gc', id: `RTD-GC-${n++}`, posted: P, armAt: P - 900_000, roundPolicy,
    seed: { fired: [0], revisionsLeft: 2 } });
  await H.read(load, { at: P - 600_000, close: P, rank: 1, attempts: 2 });
  return load;
}

// Rounds 1..k of a GoComet load, each read 60 s before the close it extends (inside the window).
async function gcRounds(load, k) {
  for (let i = 1; i <= k; i++) {
    await H.read(load, { at: P + (i - 1) * STEP - 60_000, close: P + i * STEP, rank: 1, attempts: 2 });
  }
}

function assertFloorAtBuzzer(load, bids, story, windowMs = 2_500) {
  const floor = load.ladder[load.ladder.length - 1];
  assert.ok(bids.some((b) => b.price === floor && b.countdown <= windowMs),
    `${story}: outranked at the buzzer, no floor went at <= ${windowMs} ms; sent ${H.fmtBids(load, bids)}`);
}

(async () => {
  const { check, done } = H.runner('Round tracker piece A: durable round count (rulings 41, 44, 18)', EXPECTED_CHECKS);

  await check('1 map 7 SP: three rounds seen, restart inside round 3 of 3 -> R 3, floor at the first buzzer', 'red', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 30_000, close: P + INC, rank: 1 });
    await H.read(load, { at: P + INC - 30_000, close: P + 2 * INC, rank: 1 });
    await H.read(load, { at: P + 2 * INC - 30_000, close: P + 3 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 3, `HARNESS: process 1 counted ${load.m.extendsObserved} of 3 rounds`);
    const m = await H.restart(load, P + 3 * INC - 200_000);
    assert.ok(m, 'HARNESS: the load was not re-armed after the restart');
    await H.read(load, { at: P + 3 * INC - 150_000, close: P + 3 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 3,
      `after a restart inside round 3 of 3 the count is ${load.m.extendsObserved}: extendsObserved is in memory only `
      + 'and nothing durable restores it');
    const bids = await H.approach(load, { close: P + 3 * INC, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'restarted final round');
  });

  await check('2 map 7 SP: down for all three rounds, restart 300 s past the saved close, first read +360 s -> R 3, floor', 'red', async () => {
    const load = await spLoad();
    const m = await H.restart(load, P + 300_000);
    assert.ok(m, 'HARNESS: the load was not re-armed 300 s past its saved close (inside the 600 s grace)');
    await H.read(load, { at: P + 300_000, close: P + 3 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 3,
      `the first read after the restart moved the close +360,000 ms against the saved close; counted as `
      + `${load.m.extendsObserved} round(s), expected 3 (three on-grid rounds were feasible while down)`);
    const bids = await H.approach(load, { close: P + 3 * INC, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'final round reached while the engine was down');
  });

  await check('3 map 8 SP: re-price inside round 2 after its pre-cap shot -> R carries, no second shot that round', 'red', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 30_000, close: P + INC, rank: 1 });
    await H.read(load, { at: P + INC - 30_000, close: P + 2 * INC, rank: 1 });
    const close = P + 2 * INC;
    // named re-pin: round tracker piece C, rulings 40 and 56 - the pre-cap shot now goes at <= 6,000 ms
    // (it was <= 2,500), and a round whose shot sees no close move 2,500 ms later is final, where the
    // buzzer's floor is owed (test-round-tracker-probe.js). The re-price and the reads after it therefore
    // sit inside the shot's observe window, where a second middle price would be the latch failing.
    const round2 = await H.approach(load, { close, rank: 2, countdowns: [60_000, 30_000, 10_000, 6_000] });
    const shot = round2.filter((b) => b.countdown <= 6_000);
    const floor = load.ladder[load.ladder.length - 1];
    if (shot.length !== 1 || shot[0].price === floor) {
      throw new Error(`HARNESS: round 2's pre-cap shot did not take exactly one middle price (sent ${H.fmtBids(load, round2)})`);
    }
    H.reprice(load, close - 5_500, close);
    const after = await H.approach(load, { close, rank: 2, countdowns: [5_000] });
    assert.strictEqual(load.m.extendsObserved, 2,
      `a re-price (stop + arm) inside round 2 left the count at ${load.m.extendsObserved}: the re-armed monitor starts at 0`);
    after.push(...await H.approach(load, { close, rank: 2, countdowns: [4_600, 4_000] }));
    assert.strictEqual(after.length, 0,
      `round 2's one pre-cap shot (${H.fmtBids(load, shot)}) was already spent, yet the re-armed monitor sent `
      + `${H.fmtBids(load, after)} in the same round: the same-round latch is in memory only`);
  });

  await check('4 ruling 44 GoComet cap 4: R 1 saved, down across 3 rounds, restart 651 s past the saved close -> re-armed, floor', 'red', async () => {
    const load = await gcLoad({ finalAfterExtensions: 4 });
    await gcRounds(load, 1);
    assert.strictEqual(H.diskIntent(load).closesAt, P + STEP, 'HARNESS: round 1 did not reach the durable close');
    const at = P + STEP + 651_000;
    const m = await H.restart(load, at);
    const it = H.diskIntent(load);
    assert.ok(m && it.status !== 'closed',
      `restarted 651,000 ms past the saved close with 3 of 4 rounds left, the load was retired `
      + `(status ${it.status}, closedWhileDown ${it.closedWhileDown}) before any read: the grace is a flat 600,000 ms`);
    const liveClose = P + 4 * STEP;
    await H.read(load, { at, close: liveClose, rank: 2, attempts: 2 });
    assert.strictEqual(load.m.extendsObserved, 4, `the first read after the restart counted ${load.m.extendsObserved} of 4 rounds`);
    const bids = await H.approach(load, { close: liveClose, rank: 2, attempts: 2, countdowns: GC_APPROACH });
    assertFloorAtBuzzer(load, bids, 'final round 4 after a long restart', 6_500);
  });

  await check('5 ruling 44 GoComet uncapped: R 1 saved, down across 3 rounds, restart 651 s past the saved close -> re-armed', 'red', async () => {
    const load = await gcLoad({ finalAfterExtensions: null });
    await gcRounds(load, 1);
    const at = P + STEP + 651_000;
    const m = await H.restart(load, at);
    const it = H.diskIntent(load);
    assert.ok(m && it.status !== 'closed',
      `an uncapped load restarted 651,000 ms past its saved close was retired (status ${it.status}, closedWhileDown `
      + `${it.closedWhileDown}): the grace is a flat 600,000 ms, not the uncapped restart grace`);
    await H.read(load, { at, close: P + 4 * STEP, rank: 2, attempts: 2 });
    assert.strictEqual(load.m.extendsObserved, 4, `the first read after the restart counted ${load.m.extendsObserved} of 4 rounds`);
  });

  await check('6 ruling 44 guard: GoComet cap 3 reached before the restart, 651 s past the saved close -> still retired', 'positive', async () => {
    const load = await gcLoad();
    await gcRounds(load, 3);
    assert.strictEqual(H.diskIntent(load).closesAt, P + 3 * STEP, 'HARNESS: round 3 did not reach the durable close');
    const m = await H.restart(load, P + 3 * STEP + 651_000);
    const it = H.diskIntent(load);
    assert.ok(!m, 'a load past its cap and 651 s past its saved close was re-armed');
    assert.strictEqual(it.status, 'closed', `the retired intent reads status ${it.status}`);
    assert.strictEqual(it.closedWhileDown, true, 'the retired intent is not marked closedWhileDown');
  });

  await check('7 ruling 18 re-home: a failed round write alerts once and heals on the next tick', 'red', async () => {
    const load = await spLoad();
    const sched = load.eng.scheduler;
    const persist = sched._persist.bind(sched);
    let faulted = true;
    sched._persist = () => { if (faulted) throw new Error('EIO: simulated disk fault'); return persist(); };
    await H.read(load, { at: P - 30_000, close: P + INC, rank: 1 });
    await H.read(load, { at: P - 20_000, close: P + INC, rank: 1 });
    await H.read(load, { at: P - 10_000, close: P + INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 1, `HARNESS: the round was counted as ${load.m.extendsObserved}`);
    const raised = H.alerts(load, 'round_record_failed');
    assert.strictEqual(raised.length, 1,
      `${raised.length} round_record_failed alerts across three ticks of a failing round write, expected exactly one: `
      + '_persistBelievedClose swallows the failure with a warn log');
    assert.strictEqual(raised[0].level, 'error', `the alert is level ${raised[0].level}, expected error`);
    faulted = false;
    await H.read(load, { at: P - 5_000, close: P + INC, rank: 1 });
    const it = H.diskIntent(load);
    assert.strictEqual(it.closesAt, P + INC,
      `after the disk recovered, the next tick left the durable close ${it.closesAt - P} ms past P, expected +${INC}`);
    assert.ok(it.round && it.round.rounds === 1, `the durable round record reads ${JSON.stringify(it.round)}, expected rounds 1`);
  });

  done();
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
