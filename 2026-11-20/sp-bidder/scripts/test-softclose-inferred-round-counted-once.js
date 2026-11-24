'use strict';
/**
 * One anti-snipe round hidden behind a sustained zeroed countdown, then published late by the platform,
 * is ONE round - it must be counted once (BH-STATE-1, T7 E4).
 *
 * named re-pin: round tracker, ruling 56. This file pinned the frozen-zero inference: a sustained zero
 * counted a round and latched _zeroRunExtendAt, and the late-published close was then adopted without a
 * second count. The round tracker retired the inference, so the same property is now pinned on the
 * published moves: the frozen zero counts nothing (the round reads UNCERTAIN_AFTER_CLOSE), and the late
 * close counts exactly the rounds that could have run by the read - one, even when the move is 1.67x or
 * 3x the 180 s fallback increment. The defect this file exists for (one round counted twice, the floor
 * released a round early at cap 2) must stay impossible.
 *
 * Must NOT move: a genuine next round, read inside its own trigger window, is still counted (bound).
 *
 * Virtual clock; SuperProcure publishes the 100 s trigger window and, here, no increment.
 *
 *   node scripts/test-softclose-inferred-round-counted-once.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 11;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const FALLBACK_EXTEND_MS = 180_000;
const REAL_EXTEND_MS = 300_000;
const EXTEND_CAP = 2;
const TRIGGER_WINDOW_MS = 100_000;

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const STORES = [];
const ENGINES = [];
const cleanup = () => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of STORES) { try { fs.unlinkSync(f); } catch (_) {} }
};

function mkLoad(tag) {
  const store = path.join(os.tmpdir(), `sc-inferred-once-${tag}-${process.pid}.json`);
  STORES.push(store);
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('no wire write may happen in this test'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(store), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
  });
  ENGINES.push(eng);
  const T = vnow + 600_000;
  const m = eng.arm({ id: `E4-${tag}`, lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName: 'Havells', branchName: 'ALWAR', closesAt: T }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  const extensions = () => events.filter((e) => e.type === 'extension_observed' && e.auctionId === m.auctionId).length;
  return { eng, m, T, extensions };
}

// extendMs deliberately absent: the platform publishes no increment, so the engine sizes against 180 s.
const frame = (closesAtMs, closesInMs = closesAtMs - vnow) => ({ ok: true, closesAtMs, closesInMs,
  extendCount: EXTEND_CAP, triggerWindowMs: TRIGGER_WINDOW_MS, myRank: 3, totalBidders: 4, minDecrement: 100 });

// Seed the belief 300 s out, then a zero run longer than finalizeDebounceMs past the close with the
// close frozen, stamped the way _tick stamps _zeroSince. Returns what the frozen read counted.
function freezeAtClose({ eng, m, T }) {
  vnow = T - 300_000;
  eng._observeExtension(m, frame(T));
  vnow = T + eng.cfg.finalizeDebounceMs + 1_000;
  m._zeroSince = T;
  return eng._observeExtension(m, frame(T, 0));
}

// The platform publishes the close a moment later; the countdown is live again, as _tick leaves it.
function publishLate({ eng, m }, closeAt) {
  vnow += 1_000;
  m._zeroSince = null;
  return eng._observeExtension(m, frame(closeAt));
}

// A genuine next round, read 60 s before the close it extends (inside its trigger window).
function nextRound({ eng, m }, closeAt) {
  vnow = m.believedCloseAt - 60_000;
  return eng._observeExtension(m, frame(closeAt));
}

try {
  // ---- CONTROL: late frame at +180 s (1.0x) -----------------------------------------------------
  const c = mkLoad('control');
  assert.notStrictEqual(c.m.softStrategy, 'off', 'fixture: softStrategy off short-circuits _observeExtension');
  assert.strictEqual(freezeAtClose(c), false, 'fixture: the frozen zero counted a round');
  assert.strictEqual(c.m.extendsObserved, 0, 'fixture: the frozen zero must count nothing');
  assert.strictEqual(c.eng.roundVerdict(c.m).verdict, 'UNCERTAIN_AFTER_CLOSE', 'fixture: the frozen zero must make the round uncertain');
  ok('1 control fixture: a frozen zero counts nothing and makes the round UNCERTAIN_AFTER_CLOSE');

  assert.strictEqual(publishLate(c, c.T + FALLBACK_EXTEND_MS), true, 'control: the published 1.0x close was not counted');
  assert.strictEqual(c.m.extendsObserved, 1, 'control: a 1.0x late frame for the hidden round was not counted once');
  assert.strictEqual(c.m.believedCloseAt, c.T + FALLBACK_EXTEND_MS, 'control: the late frame did not move the belief');
  ok('2 control: a 1.0x late frame is the one round, counted once');

  nextRound(c, c.T + 2 * FALLBACK_EXTEND_MS);
  assert.strictEqual(c.m.extendsObserved, 2, 'bound: a genuine next round was not counted');
  assert.strictEqual(c.eng._effectivelyHard(c.m), true, 'bound: cap 2 reached but _effectivelyHard is false');
  ok('3 bound (control fixture): a genuine next round is counted, hard at cap 2');

  // ---- THE DEFECT: late frame at +300 s (1.67x of the 180 s fallback) --------------------------
  const d = mkLoad('late300');
  assert.strictEqual(freezeAtClose(d), false, 'fixture: the frozen zero counted a round');
  assert.strictEqual(d.m.extendsObserved, 0, 'fixture: the frozen zero must count nothing');
  assert.strictEqual(d.extensions(), 0, 'fixture: the frozen zero emitted extension_observed');
  assert.strictEqual(d.m.extendCap, EXTEND_CAP, 'fixture: extendCap not surfaced from the frame');
  ok('4 fixture: nothing counted at the frozen close, cap 2 known');

  publishLate(d, d.T + REAL_EXTEND_MS);
  assert.strictEqual(d.m.extendsObserved, 1,
    `ONE anti-snipe round counted as ${d.m.extendsObserved}: the late frame publishing it moved the close `
    + `${REAL_EXTEND_MS}ms against the ${FALLBACK_EXTEND_MS}ms fallback increment, and only one round could have run by the read`);
  ok('5 mechanism: the late-published close of the hidden round is counted exactly once');

  assert.strictEqual(d.extensions(), 1, `the same round emitted ${d.extensions()} extension_observed events`);
  ok('6 one extension_observed event for the one round');

  assert.strictEqual(d.m.believedCloseAt, d.T + REAL_EXTEND_MS, 'the published close was not adopted into belief');
  assert.strictEqual(d.eng.scheduler.get(d.m.auctionId).closesAt, d.T + REAL_EXTEND_MS,
    'the adopted close did not reach the durable intent');
  ok('7 belief and durable intent adopt the published close');

  const v = d.eng.roundVerdict(d.m);
  assert.deepStrictEqual([v.verdict, v.reason], ['UNCERTAIN', 'off_grid_move'],
    `a 1.67x move on the fallback grid reads ${v.verdict} ${v.reason}, expected UNCERTAIN off_grid_move`);
  ok('8 the off-grid round reads UNCERTAIN off_grid_move');

  assert.strictEqual(d.eng._effectivelyHard(d.m), false,
    `_effectivelyHard is true after ONE of ${EXTEND_CAP} rounds: the reserved floor rung is released early`);
  ok('9 one of two rounds used - not effectively hard, floor stays reserved');

  nextRound(d, d.T + 2 * REAL_EXTEND_MS);
  assert.strictEqual(d.m.extendsObserved, 2, 'bound: a genuine next round was not counted');
  assert.strictEqual(d.extensions(), 2, 'bound: the genuine next round did not emit extension_observed');
  assert.strictEqual(d.eng.roundVerdict(d.m).verdict, 'UNCERTAIN',
    'bound: a second off-grid round at cap 2 must stay UNCERTAIN (the floor goes at the buzzer, ruling 47)');
  ok('10 bound: the genuine next round is counted; off the fallback grid it stays UNCERTAIN');

  // A published close far past the frozen one is still bounded by the rounds that could have run by the
  // read: 3x the fallback, one round.
  const w = mkLoad('late540');
  assert.strictEqual(freezeAtClose(w), false, 'fixture: the frozen zero counted a round');
  publishLate(w, w.T + 3 * FALLBACK_EXTEND_MS);
  assert.strictEqual(w.m.extendsObserved, 1,
    `a 3x late frame for the hidden round counted ${w.m.extendsObserved} rounds`);
  assert.strictEqual(w.extensions(), 1, `the same round emitted ${w.extensions()} extension_observed events`);
  assert.strictEqual(w.m.believedCloseAt, w.T + 3 * FALLBACK_EXTEND_MS, '3x: the published close was not adopted');
  assert.strictEqual(w.eng.scheduler.get(w.m.auctionId).closesAt, w.T + 3 * FALLBACK_EXTEND_MS,
    '3x: the adopted close did not reach the durable intent');
  assert.strictEqual(w.eng._effectivelyHard(w.m), false, '3x: _effectivelyHard true after ONE of 2 rounds');
  ok('11 any-size late frame for the hidden round counts one round (3x)');

  assert.strictEqual(pass, EXPECTED_CHECKS);
  console.log(`\nPASS - ${pass}/${EXPECTED_CHECKS} checks`);
  cleanup();
} catch (e) {
  console.error(`\nFAIL after ${pass}/${EXPECTED_CHECKS} checks - ${e.message}`);
  cleanup();
  process.exit(1);
}
