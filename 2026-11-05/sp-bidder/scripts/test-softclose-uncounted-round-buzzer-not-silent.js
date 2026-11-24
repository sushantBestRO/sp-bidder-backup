'use strict';
/**
 * SOFT-CLOSE PRE-CAP BUZZER, ONE SHOT PER REAL ROUND - regression for the soft-close fix after the
 * extension cap. Introduced by b25d194; base d3bf803 floored at round 0.
 *
 * Rulings (2026-09-24): never a silent hold on a final tick with budget in hand; one shot per
 * pre-cap buzzer (Q5) - per REAL buzzer, not per counted round.
 *
 * Mechanism: the pre-cap buzzer shot is latched by `_buzzerShotAtExtend === extendsObserved`. When the
 * engine fails to count a real extension while the countdown keeps running (the close moves on every
 * round), every later real round inherits round 0's latch and its buzzer returns null: outranked, with
 * revisions left and lower prices unsent, the bot holds silently on the last tick. That is the signature
 * of the 64-load production incident (scripts/test-softclose-fine-ladder-silence.js header).
 *
 * Driven through the REAL `_tick` on a virtual clock, so `_observeExtension` classifies each close move
 * itself, with a fake adapter that records every price reaching the wire. Allowlisted Transrail soft
 * branch, bid cap 10 (fine 10-rung ladder via meta.rules), extension cap 3, 4 real rounds, rank 3 after
 * the establish.
 *   1 uncounted-reschedule-shape: published increment 60 s, real move 180 s (each move read as a
 *     reschedule, so the count stays 0).
 *   2 uncounted-small-move-shape: published 300 s, real move 120 s (each move under half an increment).
 *   C control: the shape of 1 at rank 1 throughout - nothing goes after the establish.
 *
 * Must NOT move: rank 1 holds; which price goes at a buzzer is not pinned beyond "lower than where we
 * stand".
 *
 *   node scripts/test-softclose-uncounted-round-buzzer-not-silent.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
let ran = 0;
let seq = 0;
const CLEAN = [];
const ENGINES = [];
const FAILURES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-uncounted-buzzer-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const EXPECTED_CASES = 3;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close uncounted-round buzzer: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

const REVISION_LIMIT = 10;
const EXTEND_CAP = 3;
const TRIGGER_MS = 100_000;
const START_MS = 400_000;
const ROUNDS = 4;
// named re-pin: round tracker piece C, rulings 40 and 56 - a pre-cap round's one shot now goes in its
// last 6 s (the probe lead), not its last 2.5 s, so that is the window a round's shot is counted in.
const BUZZER_MS = 6_000;
// named re-pin: round tracker piece C, rulings 40 and 56 - our in-window shot extends a pre-cap round,
// and the frame showing it arrives about 1.2 s later; without that move the probe reads the round final.
const FRAME_AFTER_SHOT_MS = 1_200;

async function driveRealRounds({ publishedExtendMs, realMoveMs, rankAfterEstablish }) {
  const REAL_NOW = Date.now;
  let vnow = 1_800_000_000_000;
  Date.now = () => vnow;
  const t0 = vnow;
  const closes = [t0 + START_MS];
  let round = 0;
  let accepted = 0;
  let shotAt = null;
  let lastState = null;
  let m = null;
  const wire = [];
  const buzzers = [];
  const trace = [];
  try {
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => {
        // SP moves the close in the last second of every round but the final one, or once our own shot in
        // the round's last 6 s has shown on the frame.
        if (round < ROUNDS - 1 && (closes[round] - vnow <= 1_000 || (shotAt != null && vnow - shotAt >= FRAME_AFTER_SHOT_MS))) {
          closes.push(closes[round] + realMoveMs); round++; shotAt = null;
        }
        const remaining = closes[round] - vnow;
        const rank = accepted ? rankAfterEstablish : null;
        if (remaining > 0 && remaining <= BUZZER_MS && !buzzers[round]) {
          const prices = wire.filter((w) => w.accepted).map((w) => w.price);
          const standing = prices.length ? prices[prices.length - 1] : null;
          buzzers[round] = { rank, remaining, extendsObserved: m.extendsObserved, revisionsLeft: REVISION_LIMIT - accepted,
            unsentBelow: standing == null ? [] : m.ladder.filter((p) => p < standing && !prices.includes(p)) };
        }
        lastState = { ok: true, status: 'live', myRank: rank, totalBidders: 5, standingL1Price: null,
          closesInMs: remaining, closesAtMs: closes[round], revisionLimit: REVISION_LIMIT, revisionsLeft: null,
          minDecrement: 100, closeModel: 'soft', extendMs: publishedExtendMs, extendCount: EXTEND_CAP,
          triggerWindowMs: TRIGGER_MS, measuredRttMs: 80 };
        return lastState;
      },
      placeBid: async (_id, price) => {
        wire.push({ price, rung: m.ladder.indexOf(price), round, remaining: lastState.closesInMs, t: vnow - t0, accepted: true });
        if (lastState.closesInMs <= BUZZER_MS) shotAt = vnow;
        accepted++;
        return { accepted: true, status: 201, myRank: null, revisionsLeft: null };
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, floorWindowMs: 2_500 },
      softClose: { enabled: true, shippers: ['Transrail'], mode: 'live', reserve: 1 },
      onEvent: () => {},
      rand: () => 0.5,
    });
    eng.log = { debug() {}, info() {}, warn() {}, error() {} };
    ENGINES.push(eng);
    let nextDelay = null;
    eng._schedule = (_mon, d) => { nextDelay = d; };
    m = eng.arm({ id: `UB-${seq++}`, lane: { origin: 'NAGPUR', destination: 'BHOPAL' }, units: 1, quoteType: 'FTL',
      companyName: 'Transrail Lighting Ltd', closesAt: vnow + START_MS,
      rules: { revisionLimit: REVISION_LIMIT, minDecrement: 100 } }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    for (let guard = 0; guard < 20_000; guard++) {
      nextDelay = null;
      await eng._tick(m);
      trace.push({ vnow, round, extendsObserved: m.extendsObserved });
      if (m.finalized) break;
      if (nextDelay == null) throw new Error('harness: _tick did not reschedule');
      vnow += Math.max(1, nextDelay);
      if (round === ROUNDS - 1 && vnow > closes[round] + 5_000) break;
    }
    return { m, wire, buzzers, closes, trace };
  } finally { Date.now = REAL_NOW; }
}

const fmtWire = (wire) => '[' + wire.map((w) => `r${w.rung}:${w.price}@${w.remaining}ms/round${w.round}`).join(', ') + ']';

function checkBuzzerPreconditions(d) {
  assert.ok(d.wire.length >= 1 && d.wire[0].round === 0 && d.wire[0].rung === 0,
    `PRECONDITION: the establish (rung 0) must land in round 0; wire ${fmtWire(d.wire)}`);
  assert.strictEqual(d.m.ladder.length, REVISION_LIMIT,
    `PRECONDITION: fine ladder of ${REVISION_LIMIT} rungs expected, got ${d.m.ladder.length}`);
  for (let k = 0; k < ROUNDS; k++) {
    assert.ok(d.buzzers[k], `PRECONDITION: the engine never polled inside the last ${BUZZER_MS} ms of real round ${k}`);
  }
}

function assertOneShotPerRealBuzzer(d) {
  const wrong = [];
  for (let k = 0; k < ROUNDS; k++) {
    const b = d.buzzers[k];
    if (!(b.rank > 1 && b.revisionsLeft > 0 && b.unsentBelow.length > 0)) continue;
    const shots = d.wire.filter((w) => w.round === k && w.remaining > 0 && w.remaining <= BUZZER_MS);
    if (shots.length !== 1) {
      wrong.push(`real round ${k} of ${ROUNDS - 1} (extendsObserved ${b.extendsObserved}): outranked (rank ${b.rank}) at the `
        + `buzzer with ${b.revisionsLeft} revisions left and ${b.unsentBelow.length} lower prices unsent, `
        + `${shots.length} bids reached the wire in its last ${BUZZER_MS} ms`);
    }
  }
  // named re-pin: round tracker piece C, rulings 40 and 56 - round 0 is a known pre-cap round, so its one
  // shot goes at the probe lead, ahead of the 2,500 ms buzzer, where the move it causes can show.
  const r0 = d.wire.filter((w) => w.round === 0 && w.remaining > 0 && w.remaining <= BUZZER_MS);
  if (d.buzzers[0].rank > 1 && !(r0.length === 1 && r0[0].remaining > 2_500)) {
    wrong.push(`real round 0 (pre-cap): its shot went at ${r0.map((w) => w.remaining).join(', ') || 'no time'} ms, `
      + 'expected one shot above the 2,500 ms buzzer');
  }
  assert.ok(!wrong.length, `${wrong.join('; ')} - ruling: one shot per REAL pre-cap buzzer, never a silent hold on a `
    + `final tick; the buzzer latch is keyed on the counted round (wire ${fmtWire(d.wire)})`);
}

async function tcase(name, fn) {
  ran++;
  try { await fn(); console.log('  ok  ' + name); pass++; } catch (e) {
    FAILURES.push({ name, message: e.message });
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

(async () => {
  console.log('soft-close pre-cap buzzer: one shot per real round when the round count falls behind\n');

  await tcase('1 uncounted-reschedule-shape (published 60 s, real 180 s)', async () => {
    const d = await driveRealRounds({ publishedExtendMs: 60_000, realMoveMs: 180_000, rankAfterEstablish: 3 });
    checkBuzzerPreconditions(d);
    const lastClose = d.closes[ROUNDS - 1];
    const counted = Math.max(...d.trace.filter((x) => x.vnow < lastClose).map((x) => x.extendsObserved));
    // named re-pin: round tracker, ruling 56 - a 180 s move read inside the window on a published 60 s
    // increment is one round off the feasible grid (UNCERTAIN), no longer a reschedule.
    assert.strictEqual(counted, ROUNDS - 1,
      `PRECONDITION: each 180 s move read inside the window must count one round, counted ${counted}`);
    assertOneShotPerRealBuzzer(d);
  });

  await tcase('2 uncounted-small-move-shape (published 300 s, real 120 s)', async () => {
    const d = await driveRealRounds({ publishedExtendMs: 300_000, realMoveMs: 120_000, rankAfterEstablish: 3 });
    checkBuzzerPreconditions(d);
    const atLast = d.buzzers[ROUNDS - 1].extendsObserved;
    // named re-pin: round tracker, ruling 56 (b) - a 120 s move inside the window counts one round even
    // under half the published 300 s increment, so the count keeps up with the real moves.
    assert.strictEqual(atLast, ROUNDS - 1,
      `PRECONDITION: each 120 s move read inside the window must count one round by the last buzzer, counted ${atLast}`);
    assertOneShotPerRealBuzzer(d);
  });

  await tcase('C control: rank 1 at every buzzer, nothing after the establish', async () => {
    const d = await driveRealRounds({ publishedExtendMs: 60_000, realMoveMs: 180_000, rankAfterEstablish: 1 });
    checkBuzzerPreconditions(d);
    assert.strictEqual(d.wire.length, 1, `rank 1 holds: only the establish may reach the wire, got ${fmtWire(d.wire)}`);
  });
})().catch((e) => { console.error(e); process.exitCode = 1; });
