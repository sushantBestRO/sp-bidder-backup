'use strict';
/**
 * CONTRACT: the round tracker's verdict interface, as PR-4's final-window walk reads it
 * (t9-design s4.1-s4.3), on the pure module src/engine/roundTracker.js with the API of the
 * round-tracker spec s1.1:
 *
 *   createTracker({ platform, closeModel, softStrategy, postedCloseAt, restored, capPrior, nowMs })
 *   observe(tracker, obs, nowMs)      obs = { closeAt, closesInMs, extendMs, published, triggerWindowMs,
 *                                             extendCount, minCloseJumpMs, clockErrorMs, readGapMs }
 *   verdict(tracker, nowMs) -> RoundVerdict
 *   durable(tracker), isDirty(tracker), markClean(tracker)
 *
 * The module does not exist before the tracker lands, so every check fails by absence until then
 * (kind: contract). Checks:
 *   1  the RoundVerdict field set and types of s4.1, and verdict() is pure.
 *   2  contract point 1: hard close and an SP extendCap-0 load answer FINAL HIGH hard_close, rounds 0,
 *      cap 0, closeAt from the live read.
 *   3  contract point 2 and the verdict/confidence pairing of spec s1.5: FINAL and NOT_FINAL are HIGH,
 *      UNCERTAIN and UNCERTAIN_AFTER_CLOSE are LOW; cap reached reads FINAL HIGH cap_reached.
 *   4  contract point 3 and s4.2: verdict, rounds, roundId and closeAt are equal after a restart or a
 *      stop + arm (both restore from durable(), JSON round-tripped as the intent file stores it).
 *   5  contract point 4: inside one roundId FINAL never goes back to NOT_FINAL; a genuine new round
 *      changes the roundId (here R > C: FINAL r_exceeds_cap, cap null).
 *   6  contract point 5 and s4.2: closeAt is the tracker close; roundId changes exactly when rounds
 *      change or a reschedule re-anchors, and not on a repeated read or a move under the threshold.
 *   7  s4.3: every reason produced across the scenarios is one the walk distinguishes, for its verdict.
 *   8  spec s2.2: the tracker is dirty only when something durable changed, never per read.
 *
 * Scenario defaults: SuperProcure soft, increment 120 s published, window 100 s, cap 3 published;
 * GoComet increment 300 s, 299 s rounds, minCloseJumpMs 30 s, no roundPolicy (cap 3 by default).
 *
 *   node scripts/test-round-tracker-contract.js
 */
const assert = require('assert');

const EXPECTED_CHECKS = 8;
const FIELDS = ['verdict', 'confidence', 'reason', 'roundId', 'rounds', 'cap', 'closeAt', 'closeSource', 'asOf',
  'triggerWindowMs', 'extendMs', 'probe'].sort();
const REASONS = {
  FINAL: ['hard_close', 'cap_reached', 'probe_no_move', 'gc_submit_no_move', 'backward_move', 'r_exceeds_cap'],
  NOT_FINAL: ['below_cap', 'probe_moved', 'gc_submit_moved'],
  UNCERTAIN: ['probe_pending', 'sources_disagree', 'read_gap', 'restart_gap', 'late_arm', 'off_grid_move',
    'uncapped_no_evidence'],
  UNCERTAIN_AFTER_CLOSE: ['frozen_zero', 'rest_check_pending'],
};
const CONFIDENCE = { FINAL: 'HIGH', NOT_FINAL: 'HIGH', UNCERTAIN: 'LOW', UNCERTAIN_AFTER_CLOSE: 'LOW' };
const CLOSE_SOURCES = ['socket', 'rest', 'gc_countdown', 'submit_response', 'posted'];

const P = Date.UTC(2026, 8, 25, 6, 0, 0);
const INC = 120_000;
const W = 100_000;
const GC_STEP = 299_000;

let rt = null;
let absent = null;
try { rt = require('../src/engine/roundTracker'); } catch (e) { absent = e; }

const seen = [];
function sp(extra) {
  return rt.createTracker(Object.assign({ platform: 'sp', closeModel: 'soft', softStrategy: 'live', postedCloseAt: P,
    restored: undefined, nowMs: P - 900_000 }, extra));
}
function gc(extra) {
  return rt.createTracker(Object.assign({ platform: 'gc', closeModel: 'soft', softStrategy: 'off', postedCloseAt: P,
    restored: undefined, nowMs: P - 900_000 }, extra));
}

const lastAt = new WeakMap();
function spObs(t, closeAt, now, over) {
  const prev = lastAt.get(t);
  lastAt.set(t, now);
  const obs = Object.assign({ closeAt, closesInMs: closeAt - now, extendMs: INC, published: true, triggerWindowMs: W,
    extendCount: 3, minCloseJumpMs: undefined, clockErrorMs: 0, readGapMs: prev == null ? 0 : now - prev }, over);
  return rt.observe(t, obs, now);
}
function gcObs(t, closeAt, now) {
  const prev = lastAt.get(t);
  lastAt.set(t, now);
  return rt.observe(t, { closeAt, closesInMs: closeAt - now, extendMs: 300_000, published: true, triggerWindowMs: null,
    extendCount: null, minCloseJumpMs: 30_000, clockErrorMs: 0, readGapMs: prev == null ? 0 : now - prev }, now);
}
function v(t, now) {
  const out = rt.verdict(t, now);
  seen.push(out);
  return out;
}
const brief = (x) => JSON.stringify({ verdict: x.verdict, confidence: x.confidence, reason: x.reason, rounds: x.rounds,
  cap: x.cap, roundId: x.roundId, closeAt: x.closeAt });

// Three SuperProcure rounds, each read 30 s before the close it extends. Returns the read times.
function spThreeRounds(t, over) {
  spObs(t, P, P - 300_000, over);
  const at = [P - 30_000, P + INC - 30_000, P + 2 * INC - 30_000];
  at.forEach((now, i) => spObs(t, P + (i + 1) * INC, now, over));
  return at;
}

const results = [];
function check(name, fn) {
  let failure = null;
  if (absent) failure = `src/engine/roundTracker.js is absent (${absent.code || absent.message}): the round tracker module has not landed`;
  else { try { fn(); } catch (e) { failure = (e && e.message) || String(e); } }
  results.push({ name, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${name} [contract]`);
  if (failure) console.log(`        ${failure.split('\n')[0]}`);
}

console.log('Round tracker verdict interface (t9-design s4, round-tracker spec s1.1)\n');

check('1 s4.1: RoundVerdict carries exactly the twelve fields, typed as the walk reads them; verdict() is pure', () => {
  const t = sp();
  spThreeRounds(t);
  const now = P + 3 * INC - 20_000;
  const before = JSON.stringify(rt.durable(t));
  const dirty = rt.isDirty(t);
  const a = v(t, now);
  const b = v(t, now);
  assert.deepStrictEqual(Object.keys(a).sort(), FIELDS, `field set ${JSON.stringify(Object.keys(a).sort())}`);
  assert.ok(Object.keys(REASONS).includes(a.verdict), `verdict ${a.verdict}`);
  assert.ok(['HIGH', 'LOW'].includes(a.confidence), `confidence ${a.confidence}`);
  assert.ok(typeof a.reason === 'string' && a.reason, `reason ${a.reason}`);
  assert.ok(typeof a.roundId === 'string' && a.roundId, `roundId ${a.roundId}`);
  assert.ok(Number.isInteger(a.rounds) && a.rounds >= 0, `rounds ${a.rounds}`);
  assert.ok(a.cap === null || a.cap === 'unknown' || Number.isInteger(a.cap), `cap ${a.cap}`);
  assert.ok(a.closeAt === null || Number.isFinite(a.closeAt), `closeAt ${a.closeAt}`);
  assert.ok(CLOSE_SOURCES.includes(a.closeSource), `closeSource ${a.closeSource}`);
  assert.strictEqual(a.asOf, P + 2 * INC - 30_000, `asOf ${a.asOf}, expected the newest observation's time`);
  assert.strictEqual(a.triggerWindowMs, W, `triggerWindowMs ${a.triggerWindowMs}, expected the published ${W}`);
  assert.strictEqual(a.extendMs, INC, `extendMs ${a.extendMs}, expected the increment the grid test used`);
  assert.strictEqual(a.probe, null, `probe ${JSON.stringify(a.probe)}: no probe runs in piece A`);
  assert.deepStrictEqual(b, a, 'two verdict() calls at the same instant disagree');
  assert.strictEqual(JSON.stringify(rt.durable(t)), before, 'verdict() changed the durable record');
  assert.strictEqual(rt.isDirty(t), dirty, 'verdict() changed the dirty flag');
  const g = gc();
  gcObs(g, P, P - 600_000);
  gcObs(g, P + GC_STEP, P - 60_000);
  const gv = v(g, P - 50_000);
  assert.strictEqual(gv.triggerWindowMs, 300_000, `GoComet triggerWindowMs ${gv.triggerWindowMs}, expected one increment (300000)`);
});

check('2 contract point 1: hard close and SP extendCap 0 answer FINAL HIGH hard_close, rounds 0, cap 0, closeAt live', () => {
  const h = sp({ closeModel: 'hard', softStrategy: 'off' });
  spObs(h, P + 5_000, P - 60_000, { extendMs: null, published: false, triggerWindowMs: null, extendCount: null });
  const hv = v(h, P - 60_000);
  assert.deepStrictEqual({ verdict: hv.verdict, confidence: hv.confidence, reason: hv.reason, rounds: hv.rounds, cap: hv.cap },
    { verdict: 'FINAL', confidence: 'HIGH', reason: 'hard_close', rounds: 0, cap: 0 }, `hard close: ${brief(hv)}`);
  assert.strictEqual(hv.closeAt, P + 5_000, `hard close closeAt ${hv.closeAt}, expected the live read ${P + 5_000}`);
  const z = sp();
  spObs(z, P, P - 60_000, { extendCount: 0 });
  const zv = v(z, P - 60_000);
  assert.deepStrictEqual({ verdict: zv.verdict, confidence: zv.confidence, reason: zv.reason, rounds: zv.rounds, cap: zv.cap },
    { verdict: 'FINAL', confidence: 'HIGH', reason: 'hard_close', rounds: 0, cap: 0 }, `extendCap 0: ${brief(zv)}`);
  assert.strictEqual(zv.closeAt, P, `extendCap 0 closeAt ${zv.closeAt}`);
});

check('3 contract point 2: cap reached is FINAL HIGH cap_reached; every verdict carries its s1.5 confidence', () => {
  const t = sp();
  spObs(t, P, P - 300_000);
  spObs(t, P + INC, P - 30_000);
  const one = v(t, P - 20_000);
  assert.deepStrictEqual([one.verdict, one.confidence, one.reason, one.rounds], ['NOT_FINAL', 'HIGH', 'below_cap', 1],
    `after round 1 of 3: ${brief(one)}`);
  spObs(t, P + 2 * INC, P + INC - 30_000);
  spObs(t, P + 3 * INC, P + 2 * INC - 30_000);
  const fin = v(t, P + 3 * INC - 20_000);
  assert.deepStrictEqual([fin.verdict, fin.confidence, fin.reason, fin.rounds, fin.cap], ['FINAL', 'HIGH', 'cap_reached', 3, 3],
    `after round 3 of 3: ${brief(fin)}`);
  const g = gc();
  gcObs(g, P, P - 600_000);
  for (let i = 1; i <= 3; i++) gcObs(g, P + i * GC_STEP, P + (i - 1) * GC_STEP - 60_000);
  const gv = v(g, P + 3 * GC_STEP - 30_000);
  assert.deepStrictEqual([gv.verdict, gv.confidence, gv.reason, gv.rounds, gv.cap], ['FINAL', 'HIGH', 'cap_reached', 3, 3],
    `GoComet after three 299 s rounds with no roundPolicy (default cap 3): ${brief(gv)}`);
  const off = sp();
  spObs(off, P, P - 300_000);
  spObs(off, P + 2 * INC, P - 50_000);
  const u = v(off, P - 40_000);
  assert.strictEqual(u.verdict, 'UNCERTAIN', `an in-window +240 s move read at countdown 50 s: ${brief(u)}`);
  const unk = sp();
  spObs(unk, P, P - 300_000, { extendCount: null });
  const uv = v(unk, P - 300_000);
  assert.deepStrictEqual([uv.verdict, uv.reason, uv.cap], ['UNCERTAIN', 'uncapped_no_evidence', 'unknown'],
    `SP with no published cap: ${brief(uv)}`);
  for (const x of seen) {
    assert.strictEqual(x.confidence, CONFIDENCE[x.verdict], `${x.verdict} carried confidence ${x.confidence}: ${brief(x)}`);
  }
});

check('4 contract point 3 / s4.2: verdict, rounds, roundId and closeAt survive a restart and a stop + arm', () => {
  const states = [];
  const a = sp();
  spObs(a, P, P - 300_000);
  spObs(a, P + INC, P - 30_000);
  states.push(['mid-war NOT_FINAL', a, P - 10_000]);
  const b = sp();
  spThreeRounds(b);
  states.push(['cap reached FINAL', b, P + 3 * INC - 10_000]);
  const c = sp();
  spObs(c, P, P - 300_000);
  spObs(c, P + 2 * INC, P - 50_000);
  states.push(['off-grid UNCERTAIN', c, P - 40_000]);
  const g = gc();
  gcObs(g, P, P - 600_000);
  gcObs(g, P + GC_STEP, P - 60_000);
  gcObs(g, P + 2 * GC_STEP, P + GC_STEP - 60_000);
  states.push(['GoComet round 2', g, P + 2 * GC_STEP - 30_000]);
  for (const [label, t, now] of states) {
    const pre = v(t, now);
    const blob = JSON.parse(JSON.stringify(rt.durable(t)));
    assert.deepStrictEqual(blob, rt.durable(t), `${label}: durable() does not survive a JSON round trip`);
    const again = rt.createTracker({ platform: t === g ? 'gc' : 'sp', closeModel: 'soft',
      softStrategy: t === g ? 'off' : 'live', postedCloseAt: P, restored: blob, nowMs: now });
    const post = v(again, now);
    for (const k of ['verdict', 'rounds', 'roundId', 'closeAt']) {
      assert.deepStrictEqual(post[k], pre[k], `${label}: ${k} was ${JSON.stringify(pre[k])} before the restore, `
        + `${JSON.stringify(post[k])} after`);
    }
  }
});

check('5 contract point 4: FINAL never returns to NOT_FINAL inside one roundId; a new round changes the roundId', () => {
  const t = sp();
  const trail = [];
  const note = (now) => { const x = v(t, now); trail.push(x); return x; };
  spObs(t, P, P - 300_000); note(P - 300_000);
  spObs(t, P + INC, P - 30_000); note(P - 30_000);
  spObs(t, P + 2 * INC, P + INC - 30_000); note(P + INC - 30_000);
  spObs(t, P + 3 * INC, P + 2 * INC - 30_000);
  const fin = note(P + 2 * INC - 30_000);
  assert.strictEqual(fin.verdict, 'FINAL', `round 3 of 3: ${brief(fin)}`);
  for (const [close, now] of [[P + 3 * INC, P + 3 * INC - 20_000], [P + 3 * INC + 1_500, P + 3 * INC - 10_000],
    [P + 3 * INC + 1_500, P + 3 * INC - 2_000]]) {
    spObs(t, close, now);
    const x = note(now);
    assert.strictEqual(x.roundId, fin.roundId, `a read with no new round changed the roundId: ${brief(x)}`);
    assert.strictEqual(x.verdict, 'FINAL', `inside the final roundId the verdict went to ${x.verdict}: ${brief(x)}`);
  }
  spObs(t, P + 4 * INC, P + 3 * INC - 1_000);
  const past = note(P + 3 * INC - 1_000);
  assert.notStrictEqual(past.roundId, fin.roundId, `a genuine round 4 kept the roundId ${past.roundId}`);
  assert.deepStrictEqual([past.verdict, past.confidence, past.reason, past.cap, past.rounds],
    ['FINAL', 'HIGH', 'r_exceeds_cap', null, 4], `round 4 on a published cap of 3: ${brief(past)}`);
  const byId = new Map();
  for (const x of trail) {
    if (byId.get(x.roundId) === 'FINAL' && x.verdict === 'NOT_FINAL') {
      throw new Error(`roundId ${x.roundId} went FINAL -> NOT_FINAL: ${brief(x)}`);
    }
    if (x.verdict === 'FINAL') byId.set(x.roundId, 'FINAL');
  }
});

check('6 contract point 5 / s4.2: closeAt is the tracker close; roundId moves with rounds and reschedules only', () => {
  const t = sp();
  spObs(t, P, P - 1_800_000);
  const start = v(t, P - 1_800_000);
  assert.strictEqual(start.closeAt, P, `closeAt ${start.closeAt}, expected the observed close`);
  spObs(t, P, P - 1_700_000);
  const same = v(t, P - 1_700_000);
  assert.strictEqual(same.roundId, start.roundId, 'a repeated read of the same close changed the roundId');
  spObs(t, P + 30_000, P - 1_600_000);
  const small = v(t, P - 1_600_000);
  assert.strictEqual(small.closeAt, P, `a +30 s move (under half the 120 s increment) moved closeAt to ${small.closeAt}`);
  assert.strictEqual(small.roundId, start.roundId, 'a move under the threshold changed the roundId');
  spObs(t, P + 600_000, P - 1_500_000);
  const moved = v(t, P - 1_500_000);
  assert.strictEqual(moved.closeAt, P + 600_000, `a reschedule left closeAt at ${moved.closeAt}`);
  assert.strictEqual(moved.rounds, 0, `a reschedule counted ${moved.rounds} round(s)`);
  assert.notStrictEqual(moved.roundId, start.roundId, 'a reschedule re-anchors the round but kept the roundId');
  const b = P + 600_000;
  spObs(t, b + INC, b - 30_000);
  const r1 = v(t, b - 30_000);
  assert.strictEqual(r1.closeAt, b + INC, `a counted round left closeAt at ${r1.closeAt}`);
  assert.strictEqual(r1.rounds, 1, `a counted round reads rounds ${r1.rounds}`);
  assert.notStrictEqual(r1.roundId, moved.roundId, 'a counted round kept the roundId');
});

check('7 s4.3: every reason produced is one the walk distinguishes, for its own verdict', () => {
  const t = sp();
  spThreeRounds(t);
  v(t, P + 3 * INC - 1_000);
  const g = gc();
  gcObs(g, P, P - 600_000);
  gcObs(g, P + 7_200_000, P - 100_000);
  v(g, P - 90_000);
  const c = gc();
  gcObs(c, P, P - 600_000);
  gcObs(c, P + 121_000, P - 60_000);
  v(c, P - 50_000);
  assert.ok(seen.length >= 3, 'HARNESS: no verdicts were produced');
  for (const x of seen) {
    assert.ok(REASONS[x.verdict], `verdict ${x.verdict} is not one of ${Object.keys(REASONS).join(', ')}`);
    assert.ok(REASONS[x.verdict].includes(x.reason), `${x.verdict} carried reason '${x.reason}', not in s4.3's `
      + `${JSON.stringify(REASONS[x.verdict])}`);
  }
});

check('8 spec s2.2: dirty only when something durable changed, never per read', () => {
  const t = sp();
  spObs(t, P, P - 300_000);
  rt.markClean(t);
  assert.strictEqual(rt.isDirty(t), false, 'markClean() left the tracker dirty');
  spObs(t, P, P - 200_000);
  spObs(t, P, P - 100_000);
  assert.strictEqual(rt.isDirty(t), false, 'reads of an unchanged close made the tracker dirty');
  spObs(t, P + INC, P - 30_000);
  assert.strictEqual(rt.isDirty(t), true, 'a counted round did not make the tracker dirty');
  rt.markClean(t);
  spObs(t, P + INC, P - 20_000);
  assert.strictEqual(rt.isDirty(t), false, 'a read after the round was recorded made the tracker dirty again');
});

const failed = results.filter((r) => r.failure);
if (results.length !== EXPECTED_CHECKS || failed.length) {
  console.log(`\nFAIL - ${results.length - failed.length}/${EXPECTED_CHECKS} contract checks passed (${results.length} ran)`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS - ${EXPECTED_CHECKS} contract checks: the round tracker verdict interface`);
}
