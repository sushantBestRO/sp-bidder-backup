'use strict';
/**
 * Round tracker piece C: probe-and-confirm (ruling 40; ruling 56's spans: SuperProcure lead 6 s and
 * observe 2,500 ms, GoComet lead 12 s; round-tracker spec s1.1, s1.5 rows 3, 4, 10, s2.1, s4.1;
 * round-detection map s4 tests 15, 16, 17, 21; t9-design s4.4).
 *
 * The pre-final shot we already send in a round before the cap moves a few seconds earlier, so its own
 * effect on the close shows before the real buzzer whether this round is the last:
 *   - the close moves after it: the round was not final, R+1, the floor is kept;
 *   - an in-window shot is accepted and nothing moves: the round is final, and the floor goes at the
 *     buzzer in the same round while we are outranked;
 *   - still unanswered at the buzzer while outranked: the floor (ruling 47).
 * No extra attempt is spent (the shot existed), and rank 1 sends nothing (ruling 28, T2a).
 *
 * Every read goes through _tick with a scripted fake adapter on a virtual clock (lib/round-tracker-
 * harness.js). SuperProcure: allowlisted soft, window 100 s, increment 120 s, cap 3, rung 0 standing,
 * 8 revisions. GoComet: 300 s increment, cap 3, 2 attempts, rung 0 standing; its submit response carries
 * bid_closing_in as the real adapter publishes it (bidClosingInMs).
 *
 *   node scripts/test-round-tracker-probe.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');

const EXPECTED_CHECKS = 10;
const W = 100_000;
const INC = 120_000;
const STEP = 299_000;
const P = Date.now() + 3_600_000;
let n = 0;

// `defended`: outranked at 60 s, so the round's one in-window defend (rung 2) is already spent and the
// only shot left before the buzzer is the pre-cap shot this file pins.
async function spLoad({ defended = true } = {}) {
  const load = await H.openLoad({ portal: 'sp', id: `RTP-SP-${n++}`, posted: P, armAt: P - 900_000,
    frame: { extendMs: INC, cap: 3, window: W }, seed: { fired: [0], revisionsLeft: 8 } });
  await H.read(load, { at: P - 300_000, close: P, rank: 1 });
  if (defended) {
    const d = await H.read(load, { at: P - 60_000, close: P, rank: 3 });
    if (d.length !== 1 || d[0].price !== load.ladder[2]) throw new Error(`HARNESS: the 60 s defend sent ${H.fmtBids(load, d)}`);
  }
  await H.read(load, { at: P - 30_000, close: P, rank: defended ? 3 : 1 });
  await H.read(load, { at: P - 10_000, close: P, rank: defended ? 3 : 1 });
  return load;
}

// GoComet's submit response: the countdown after our write, moved by one increment when `extends`.
function gcSubmit(load, { extendsClose }) {
  const inner = load.eng.adapter.placeBid.bind(load.eng.adapter);
  load.eng.adapter.placeBid = async (id, price, opts) => {
    const res = await inner(id, price, opts);
    if (extendsClose) load.frame.close += STEP;
    return Object.assign({}, res, { bidClosingInMs: load.frame.close - Date.now() });
  };
}

async function gcLoad({ extendsClose }) {
  const load = await H.openLoad({ portal: 'gc', id: `RTP-GC-${n++}`, posted: P, armAt: P - 900_000,
    seed: { fired: [0], revisionsLeft: 2 } });
  gcSubmit(load, { extendsClose });
  await H.read(load, { at: P - 600_000, close: P, rank: 1, attempts: 2 });
  await H.read(load, { at: P - 30_000, close: P, rank: 1, attempts: 2 });
  return load;
}

const floorOf = (load) => load.ladder[load.ladder.length - 1];
const isFloor = (load, b) => b.price === floorOf(load);

(async () => {
  const { check, done } = H.runner('Round tracker piece C: probe-and-confirm (rulings 40, 47, 56)', EXPECTED_CHECKS);

  await check('1 map 21 SP: NOT_FINAL, outranked -> one middle price at <= 6,000 ms, early enough to observe; the close moves -> R+1 probe_moved, floor kept', 'red', async () => {
    const load = await spLoad();
    const bids = [];
    let close = P;
    for (const cd of [6_000, 4_000, 2_400, 1_200, 400]) {
      const at = P - cd;
      bids.push(...await H.read(load, { at, close, rank: 3 }));
      if (bids.length && close === P) close = P + INC;
    }
    assert.ok(bids.length >= 1 && bids[0].countdown <= 6_000 && bids[0].countdown > 2_500,
      `the pre-cap shot must go at <= 6,000 ms and before the 2,500 ms buzzer so its effect on the close shows first `
      + `(ruling 40; ruling 56: SuperProcure lead 6 s); sent ${H.fmtBids(load, bids)}`);
    assert.ok(!bids.some((b) => isFloor(load, b)), `the floor went in a pre-cap round: ${H.fmtBids(load, bids)}`);
    assert.strictEqual(bids.length, 1, `one shot per pre-cap round, sent ${H.fmtBids(load, bids)}`);
    assert.strictEqual(load.m.extendsObserved, 1, `the close moved after our shot: R ${load.m.extendsObserved}, expected 1`);
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'NOT_FINAL' && v.reason === 'probe_moved',
      `after our shot moved the close: ${v.verdict} (${v.reason}), expected NOT_FINAL probe_moved`);
  });

  await check('2 map 21 GoComet: NOT_FINAL, outranked -> one middle price in the 12 s band, not at the buzzer', 'red', async () => {
    const load = await gcLoad({ extendsClose: true });
    const bids = await H.approach(load, { close: P, rank: 3, attempts: 2, countdowns: [12_000, 10_500, 5_000] });
    assert.ok(bids.length === 1 && bids[0].countdown <= 12_000 && bids[0].countdown > 6_500 && !isFloor(load, bids[0]),
      `the pre-final shot must go in the middle band (<= 12,000 ms, above the 6,500 ms buzzer) at a middle price `
      + `(ruling 40; ruling 56: GoComet lead 12 s); sent ${H.fmtBids(load, bids)}`);
  });

  await check('3 map 16 GoComet: submit bid_closing_in +299 s -> R+1 from our own response, before the next poll', 'red', async () => {
    const load = await gcLoad({ extendsClose: true });
    let shotAt = null;
    for (const cd of [12_000, 10_500, 5_000]) {
      const sent = await H.read(load, { at: P - cd, close: P, rank: 3, attempts: 2 });
      if (sent.length) { shotAt = cd; break; }
    }
    assert.ok(shotAt != null, 'HARNESS: no pre-final shot was placed');
    assert.strictEqual(load.m.extendsObserved, 1,
      `our accepted shot's submit response showed the close +299 s; R is ${load.m.extendsObserved} before the next poll, `
      + 'expected 1 (the engine never read bidClosingInMs)');
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'NOT_FINAL' && v.reason === 'gc_submit_moved',
      `after our own submit moved the close: ${v.verdict} (${v.reason}), expected NOT_FINAL gc_submit_moved`);
    const next = await H.read(load, { at: P - shotAt + 1_000, close: load.frame.close, rank: 3, attempts: 1 });
    assert.strictEqual(load.m.extendsObserved, 1, `the next poll counted the same round again: R ${load.m.extendsObserved}`);
    assert.strictEqual(next.length, 0, `a bid went on the next poll: ${H.fmtBids(load, next)}`);
  });

  await check('4 map 15 GoComet: probe accepted, bid_closing_in unchanged -> C := R, FINAL, floor at the buzzer the same round', 'red', async () => {
    const load = await gcLoad({ extendsClose: false });
    const bids = await H.approach(load, { close: P, rank: 3, attempts: 2, countdowns: [12_000, 10_500, 5_000, 3_000] });
    const probe = bids.filter((b) => b.countdown > 6_500);
    const buzzer = bids.filter((b) => b.countdown <= 6_500);
    assert.ok(probe.length === 1 && !isFloor(load, probe[0]),
      `expected the pre-final shot at a middle price in the middle band, sent ${H.fmtBids(load, bids)}`);
    assert.ok(buzzer.length === 1 && isFloor(load, buzzer[0]),
      `our in-window shot did not extend the close, so this round is final (the per-enquiry allowance, map U8): `
      + `the floor must go at the buzzer the same round, sent ${H.fmtBids(load, buzzer)} at <= 6,500 ms`);
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'FINAL' && v.confidence === 'HIGH' && v.reason === 'gc_submit_no_move' && v.cap === 0,
      `verdict ${v.verdict} ${v.confidence} (${v.reason}) cap ${v.cap}, expected FINAL HIGH gc_submit_no_move cap 0`);
  });

  await check('5 map 17 SP: probe at ~6 s, no close move by 2.5 s later -> FINAL probe_no_move, the floor at the buzzer', 'red', async () => {
    const load = await spLoad();
    const bids = await H.approach(load, { close: P, rank: 9, countdowns: [6_000, 4_000, 3_400, 2_400, 1_200, 400] });
    const early = bids.filter((b) => b.countdown > 2_500);
    const late = bids.filter((b) => b.countdown <= 2_500);
    assert.ok(early.length === 1 && early[0].countdown <= 6_000 && !isFloor(load, early[0]),
      `expected one middle-price probe at <= 6,000 ms, sent ${H.fmtBids(load, bids)}`);
    assert.ok(late.length === 1 && isFloor(load, late[0]),
      `the probe landed in the window and the close did not move, so the round is final: the floor must go at the `
      + `buzzer while outranked, sent ${H.fmtBids(load, late)} at <= 2,500 ms`);
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'FINAL' && v.confidence === 'HIGH' && v.reason === 'probe_no_move',
      `verdict ${v.verdict} ${v.confidence} (${v.reason}), expected FINAL HIGH probe_no_move`);
  });

  await check('6 SP: probe still pending at the buzzer while outranked -> the floor (ruling 47)', 'red', async () => {
    const load = await spLoad();
    // A slow accept: the probe lands 2,500 ms after it was sent, so its observe window runs past the buzzer.
    const inner = load.eng.adapter.placeBid.bind(load.eng.adapter);
    let slow = true;
    load.eng.adapter.placeBid = async (...args) => {
      const res = await inner(...args);
      if (slow) { slow = false; H.clock.now += 2_500; }
      return res;
    };
    const bids = await H.approach(load, { close: P, rank: 3, countdowns: [6_000, 2_400, 1_200] });
    const early = bids.filter((b) => b.countdown > 2_500);
    const late = bids.filter((b) => b.countdown <= 2_500);
    assert.ok(early.length === 1 && !isFloor(load, early[0]), `expected one middle-price probe above the buzzer, sent ${H.fmtBids(load, bids)}`);
    assert.ok(late.length === 1 && isFloor(load, late[0]),
      `the probe is still unanswered at the buzzer and we are outranked: the floor must go (ruling 47), sent ${H.fmtBids(load, late)}`);
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'UNCERTAIN' && v.reason === 'probe_pending', `verdict ${v.verdict} (${v.reason}), expected UNCERTAIN probe_pending`);
  });

  await check('7 SP: restart inside the observe window resolves from the persisted probe -> no second probe, the floor at the buzzer', 'red', async () => {
    const load = await spLoad();
    const before = await H.approach(load, { close: P, rank: 9, countdowns: [6_000] });
    assert.ok(before.length === 1 && !isFloor(load, before[0]),
      `expected the middle-price probe at 6,000 ms before the restart, sent ${H.fmtBids(load, before)}`);
    const m = await H.restart(load, P - 5_000);
    assert.ok(m, 'HARNESS: the load was not re-armed after the restart');
    const after = await H.approach(load, { close: P, rank: 9, countdowns: [4_000, 3_000, 2_400, 1_200] });
    assert.ok(!after.some((b) => !isFloor(load, b)), `a second middle price went in the same round after the restart: ${H.fmtBids(load, after)}`);
    assert.ok(after.length === 1 && after[0].countdown <= 2_500 && isFloor(load, after[0]),
      `the persisted probe saw no move by its deadline, so the round is final: the floor must go at the buzzer, `
      + `sent ${H.fmtBids(load, after)} after the restart`);
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'FINAL' && v.reason === 'probe_no_move', `verdict ${v.verdict} (${v.reason}), expected FINAL probe_no_move`);
    const round = (H.diskIntent(load) || {}).round || {};
    assert.ok(round.probe && round.probe.roundId === v.roundId, `the probe is not on the durable intent: ${JSON.stringify(round.probe)}`);
  });

  await check('8 SP: the probe rides the accepted-path write (restart reads it from disk)', 'red', async () => {
    const load = await spLoad();
    const before = await H.approach(load, { close: P, rank: 3, countdowns: [6_000] });
    assert.strictEqual(before.length, 1, `expected the probe at 6,000 ms, sent ${H.fmtBids(load, before)}`);
    const round = (H.diskIntent(load) || {}).round || {};
    assert.ok(round.probe && round.probe.state === 'pending' && round.probe.observeUntil === before[0].at + 2_500,
      `right after the accepted probe the intent must hold it pending until acceptance + 2,500 ms, got ${JSON.stringify(round.probe)}`);
  });

  await check('9 SP rank 1 through a pre-cap round -> no probe, nothing sent', 'positive', async () => {
    const load = await spLoad({ defended: false });
    const bids = await H.approach(load, { close: P, rank: 1, countdowns: [6_000, 4_000, 3_400, 2_400, 1_200, 400] });
    assert.strictEqual(bids.length, 0, `rank 1 in a pre-cap round sent ${H.fmtBids(load, bids)} (ruling 28: hold)`);
    assert.strictEqual(H.verdictOf(load).probe, null, 'a probe was started at rank 1');
  });

  await check('10 GoComet rank 1 through a pre-final round -> no probe, nothing sent', 'positive', async () => {
    const load = await gcLoad({ extendsClose: false });
    const bids = await H.approach(load, { close: P, rank: 1, attempts: 2, countdowns: [12_000, 10_500, 5_000, 3_000] });
    assert.strictEqual(bids.length, 0, `rank 1 in a pre-final round sent ${H.fmtBids(load, bids)} (T2a: hold)`);
    assert.strictEqual(H.verdictOf(load).probe, null, 'a probe was started at rank 1');
  });

  done();
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
