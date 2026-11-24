'use strict';
/**
 * Round tracker piece A: how a forward move of the close is counted (ruling 56; round-tracker spec
 * s1.3; round-detection map s4 tests 1-5, 9, 11, 12, 14).
 *
 * ONE rule for both portals replaces W1-7's 1.5x reschedule bound, T2a's 150 s count threshold and
 * derived count: a move seen before the old close's trigger window opened is a reschedule whatever
 * its size; inside the window it counts the rounds that fit the increment grid AND could physically
 * have run by the time of the read, and a move that fails either test counts one round and makes the
 * round UNCERTAIN (off_grid_move).
 *
 * Every read goes through _tick with a scripted fake adapter on a virtual clock (lib/round-tracker-
 * harness.js). SuperProcure: allowlisted soft load, published increment 120 s, cap 3, trigger window
 * 100 s unless a check says otherwise, our rung 0 standing. GoComet: 299 s rounds on a 300 s
 * increment, cap 3, minCloseJumpMs 30 s as the adapter publishes it, 2 attempts left.
 *
 * Kinds: red = fails at 2811aa7 on the defect's own mechanism; positive = green before and after by
 * design. A verdict read (engine.roundVerdict) always comes after the behavioural assertions.
 *
 *   node scripts/test-round-tracker-counting.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');

const EXPECTED_CHECKS = 13;
const INC = 120_000;
const W = 100_000;
const GC_STEP = 299_000;
const SP_APPROACH = [60_000, 30_000, 10_000, 6_000, 4_000, 2_400, 2_000, 1_600, 1_200, 800, 400];
const P = Date.now() + 3_600_000;
let n = 0;

async function spLoad({ extendMs = INC, cap = 3, window = W } = {}) {
  const load = await H.openLoad({ portal: 'sp', id: `RTC-SP-${n++}`, posted: P, armAt: P - 900_000,
    frame: { extendMs, cap, window }, seed: { fired: [0], revisionsLeft: 8 } });
  await H.read(load, { at: P - 300_000, close: P, rank: 1 });
  return load;
}

async function gcLoad() {
  const load = await H.openLoad({ portal: 'gc', id: `RTC-GC-${n++}`, posted: P, armAt: P - 900_000,
    seed: { fired: [0], revisionsLeft: 2 } });
  await H.read(load, { at: P - 600_000, close: P, rank: 1, attempts: 2 });
  return load;
}

const rounds = (load) => load.events.filter((e) => e.type === 'extension_observed').length;

function assertFloorAtBuzzer(load, bids, story) {
  const floor = load.ladder[load.ladder.length - 1];
  assert.ok(bids.some((b) => b.price === floor && b.countdown <= 2_500),
    `${story}: outranked to the close, no floor went at <= 2,500 ms; sent ${H.fmtBids(load, bids)}`);
}

function assertVerdict(load, want) {
  const v = H.verdictOf(load);
  for (const k of Object.keys(want)) {
    assert.deepStrictEqual(v[k], want[k], `verdict.${k} is ${JSON.stringify(v[k])}, expected ${JSON.stringify(want[k])} `
      + `(verdict ${JSON.stringify({ verdict: v.verdict, confidence: v.confidence, reason: v.reason, rounds: v.rounds, cap: v.cap })})`);
  }
}

(async () => {
  const { check, done } = H.runner('Round tracker piece A: counting forward close moves (ruling 56)', EXPECTED_CHECKS);

  await check('1 map 1: SP three +120 s moves, each seen inside the window -> R 3, floor at the final buzzer', 'positive', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 30_000, close: P + INC, rank: 1 });
    await H.read(load, { at: P + INC - 40_000, close: P + 2 * INC, rank: 1 });
    await H.read(load, { at: P + 2 * INC - 10_000, close: P + 3 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 3, `three in-window on-grid rounds counted as ${load.m.extendsObserved}`);
    assert.strictEqual(rounds(load), 3, `${rounds(load)} extension_observed events for three rounds`);
    const bids = await H.approach(load, { close: P + 3 * INC, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'round 3 of cap 3');
  });

  await check('2 map 2 (spec 1.3): read at b-90 s, next read at b+30 s shows +240 s -> R 2 HIGH; round 3 -> floor', 'red', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 90_000, close: P, rank: 1 });
    await H.read(load, { at: P + 30_000, close: P + 2 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 2,
      `a +240,000 ms move read at b+30 s, 120 s after a read at b-90 s inside the 100 s window, counted as `
      + `${load.m.extendsObserved} round(s), expected 2 (both rounds were feasible by the read; not a reschedule)`);
    await H.read(load, { at: P + 3 * INC - 20_000, close: P + 3 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 3, `round 3 counted to ${load.m.extendsObserved}, expected 3`);
    const bids = await H.approach(load, { close: P + 3 * INC, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'real round 3 of cap 3 after a two-round read');
    assertVerdict(load, { verdict: 'FINAL', confidence: 'HIGH', reason: 'cap_reached', rounds: 3, cap: 3 });
  });

  await check('3 map 2 negative (spec 1.3): a read at b-50 s showing +240 s -> R 1, UNCERTAIN off_grid_move', 'red', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 50_000, close: P + 2 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 1,
      `a +240,000 ms move read at countdown 50 s (only one round feasible by then) counted as `
      + `${load.m.extendsObserved} round(s), expected 1`);
    assertVerdict(load, { verdict: 'UNCERTAIN', confidence: 'LOW', reason: 'off_grid_move', rounds: 1 });
  });

  await check('4 map 3: +300 s on a 120 s branch seen at countdown 25 min -> R 0, belief and durable close follow', 'positive', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 1_500_000, close: P + 300_000, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 0, `a reschedule counted as ${load.m.extendsObserved} round(s)`);
    assert.strictEqual(rounds(load), 0, 'a reschedule emitted extension_observed');
    assert.strictEqual(load.m.believedCloseAt, P + 300_000, 'the belief did not follow the reschedule');
    assert.strictEqual(H.diskIntent(load).closesAt, P + 300_000, 'the reschedule did not reach the durable intent');
  });

  await check('5 map 4: +150 s (1.25x) seen at countdown 20 min -> R 0 (outside the window, a reschedule)', 'red', async () => {
    const load = await spLoad();
    await H.read(load, { at: P - 1_200_000, close: P + 150_000, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 0,
      `a +150,000 ms move read 20 min before the close (the window opens at 100 s) counted as `
      + `${load.m.extendsObserved} round(s): W1-7's 1.5x bound counts any move of 1.5x or less`);
    assert.strictEqual(rounds(load), 0, 'a reschedule emitted extension_observed');
    assert.strictEqual(load.m.believedCloseAt, P + 150_000, 'the belief did not follow the reschedule');
    assert.strictEqual(H.diskIntent(load).closesAt, P + 150_000, 'the reschedule did not reach the durable intent');
  });

  await check('6 map 5 (spec 1.3): published 60 s, cap 5, two +300 s moves seen at countdown 95 s -> R 2 UNCERTAIN, floor at the buzzer', 'red', async () => {
    const load = await spLoad({ extendMs: 60_000, cap: 5 });
    await H.read(load, { at: P - 95_000, close: P + 300_000, rank: 1 });
    await H.read(load, { at: P + 300_000 - 95_000, close: P + 600_000, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 2,
      `two +300,000 ms moves on a published 60,000 ms increment, each read at countdown 95 s, counted as `
      + `${load.m.extendsObserved} round(s), expected 2 (one round each, off the feasible grid): W1-7 reads each as a reschedule`);
    const bids = await H.approach(load, { close: P + 600_000, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'UNCERTAIN round, outranked (ruling 47)');
    assertVerdict(load, { verdict: 'UNCERTAIN', confidence: 'LOW', reason: 'off_grid_move', rounds: 2, cap: 5 });
  });

  await check('7 map 9: late arm, posted P, armed at P+420 s with close P+540 s on a 180 s branch -> R 3 FINAL, floor', 'red', async () => {
    const load = await H.openLoad({ portal: 'sp', id: `RTC-SP-${n++}`, posted: P, closesAt: P + 540_000, postedCloseAt: P,
      armAt: P + 420_000, frame: { extendMs: 180_000, cap: 3, window: W } });
    await H.read(load, { at: P + 420_000, close: P + 540_000, rank: null });
    assert.strictEqual(load.m.extendsObserved, 3,
      `armed 540,000 ms past the posted close on a 180,000 ms increment (3 whole rounds), counted as `
      + `${load.m.extendsObserved} round(s): the count starts at 0 on every arm`);
    const bids = await H.approach(load, { close: P + 540_000, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'late arm into round 3 of cap 3');
    assertVerdict(load, { verdict: 'FINAL', confidence: 'HIGH', reason: 'cap_reached', rounds: 3, cap: 3 });
  });

  await check('8 map 14: SP cap 1, three in-window rounds -> R 3, one extend_cap_exceeded alert, floor at the buzzer', 'positive', async () => {
    const load = await spLoad({ cap: 1 });
    await H.read(load, { at: P - 30_000, close: P + INC, rank: 1 });
    await H.read(load, { at: P + INC - 30_000, close: P + 2 * INC, rank: 1 });
    await H.read(load, { at: P + 2 * INC - 30_000, close: P + 3 * INC, rank: 1 });
    assert.strictEqual(load.m.extendsObserved, 3, `three rounds counted as ${load.m.extendsObserved}`);
    const exceeded = H.alerts(load, 'extend_cap_exceeded');
    assert.strictEqual(exceeded.length, 1, `${exceeded.length} extend_cap_exceeded alerts, expected exactly one`);
    const bids = await H.approach(load, { close: P + 3 * INC, rank: 2, countdowns: SP_APPROACH });
    assertFloorAtBuzzer(load, bids, 'a round past the published cap');
  });

  await check('9 map 11: GoComet 121 s move inside the window -> R 1 (UNCERTAIN off_grid_move)', 'red', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 60_000, close: P + 121_000, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.believedCloseAt, P + 121_000, 'the belief did not follow a 121 s move');
    assert.strictEqual(load.m.extendsObserved, 1,
      `a 121,000 ms move read at countdown 60 s counted as ${load.m.extendsObserved} round(s), expected 1: `
      + 'T2a counts only moves of 150 s or more and derives round(121/300) = 0');
    assertVerdict(load, { verdict: 'UNCERTAIN', confidence: 'LOW', reason: 'off_grid_move', rounds: 1, cap: 3 });
  });

  await check('10 map 12: GoComet close edit of +2 h inside the window -> R unchanged, no cap alert, UNCERTAIN', 'red', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 100_000, close: P + 7_200_000, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.extendsObserved, 0,
      `a +7,200,000 ms close edit counted as ${load.m.extendsObserved} round(s), expected 0 (over the 60 min `
      + 'bound: a reschedule during the war): T2a derives round(7200/300)');
    assert.strictEqual(H.alerts(load, 'extend_cap_exceeded').length, 0, 'a close edit raised extend_cap_exceeded');
    assert.strictEqual(load.m.believedCloseAt, P + 7_200_000, 'the belief did not follow the close edit');
    assertVerdict(load, { verdict: 'UNCERTAIN', confidence: 'LOW', reason: 'off_grid_move', rounds: 0, cap: 3 });
  });

  await check('11 one threshold (spec 1.3 rule 1): GoComet 40 s move in the window moves the belief AND counts', 'red', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 100_000, close: P + 40_000, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.believedCloseAt, P + 40_000, 'the belief did not follow a 40 s move (minCloseJumpMs 30 s)');
    assert.strictEqual(load.m.extendsObserved, 1,
      `a 40,000 ms move the belief followed counted as ${load.m.extendsObserved} round(s), expected 1: `
      + 'the belief follows at 30 s but T2a counts only at 150 s, two thresholds');
    assertVerdict(load, { verdict: 'UNCERTAIN', reason: 'off_grid_move', rounds: 1 });
  });

  await check('12 one threshold guard: GoComet 20 s move (under minCloseJumpMs) moves neither belief nor count', 'positive', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 100_000, close: P + 20_000, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.believedCloseAt, P, `a 20 s move moved the belief to ${load.m.believedCloseAt - P} ms past P`);
    assert.strictEqual(load.m.extendsObserved, 0, `a 20 s move counted as ${load.m.extendsObserved} round(s)`);
  });

  await check('13 one threshold guard: GoComet 40 s move at countdown 20 min is a reschedule (belief follows, R 0)', 'positive', async () => {
    const load = await gcLoad();
    await H.read(load, { at: P - 1_200_000, close: P + 40_000, rank: 1, attempts: 2 });
    assert.strictEqual(load.m.believedCloseAt, P + 40_000, 'the belief did not follow a 40 s reschedule');
    assert.strictEqual(load.m.extendsObserved, 0, `a 40 s move 20 min out counted as ${load.m.extendsObserved} round(s)`);
  });

  done();
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
