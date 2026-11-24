'use strict';
/**
 * SOFT-CLOSE: THE FLOOR STILL GOES AFTER A NON-FLOOR FINAL SHOT (ruling F2).
 *
 * Regression target: Transrail 25513929, 25619430, 25677493 (trigger 100s, extension 120s, cap 3,
 * 10 bids). On an allowlisted soft load the rank-aware snipe (`selectRung('snipe')`) picked a
 * NON-floor rung at ~2s, and then the bot went silent: `if (monitor.snipeFired) return null` in
 * `_decide`'s snipe branch and the same test in `_lastResortFloor` make the final shot single-shot.
 * The loads closed outranked at rank 2 with the floor unspent and 6-7 of 10 bids unused.
 *
 * Ruling F2 (2026-09-24): no single-shot latch on soft close. After a non-floor final shot has
 * LANDED, if a rank read after it is worse than 1 and budget remains, the floor still goes before the
 * close, bounded by `lastResortFloorAttempts`. Rank 1 holds. Applies to the post-cap buzzer shot and to
 * an unknown-cap band shot alike.
 *
 * What must NOT move: rank 1 holds after the shot (SP holds at rank 1); the single-shot latch on an
 * ALLOWLISTED HARD load stays in this PR (ruling Q6); the floor retry is bounded.
 *
 * Driven through the REAL `_maybeBid` on a virtual clock at the engine's own cadence, with a fake
 * adapter that records every price that reaches the wire. States are modelled the way SuperProcure's
 * adapter sends them (revisionLimit set, revisionsLeft null). Offline, deterministic, jitter stubbed.
 *
 *   node scripts/test-softclose-floor-after-nonfloor-snipe.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const TRIGGER_MS = 100_000;
const EXTEND_MS = 120_000;
const REVISION_LIMIT = 10;
const MIN_DEC = 100;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-f2-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 5;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close floor after a non-floor final shot: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function runAsync(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

// `respond(price, wire)` decides the platform's answer; `wire` is every write so far, each tagged with
// the countdown it went out at.
function mkRig(respond) {
  const wire = [];
  const clock = { remaining: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: MIN_DEC, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => { wire.push({ price, remaining: clock.remaining }); return respond(price, wire); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500 },
    softClose: { enabled: true, shippers: ['Transrail'], mode: 'live', reserve: 1 },
    onEvent: () => {},
    rand: () => 0,
  });
  ENGINES.push(eng);
  return { eng, wire, clock };
}
const accept = () => ({ accepted: true, status: 201, myRank: null, revisionsLeft: null });

// A Transrail-shaped load already on the board: rungs 0..standAt landed (establish + defends).
function armLoad(eng, { closeModel = 'soft', extendCap = 3, extendsObserved = 3, standAt = 1 } = {}) {
  const meta = { id: String(25_600_000 + (++seq)), lane: { origin: 'NAGPUR', destination: 'BHOPAL' }, units: 1,
    companyName: 'Transrail Lighting Ltd', branchName: 'NAGPUR', closesAt: Date.now() + 900_000,
    rules: { revisionLimit: REVISION_LIMIT, minDecrement: MIN_DEC } };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.extendCap = extendCap;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = closeModel === 'soft' ? TRIGGER_MS : null;
  m.extendMs = closeModel === 'soft' ? EXTEND_MS : null;
  for (let i = 0; i <= standAt; i++) m.firedRungs.add(i);
  m.currentRungIndex = standAt;
  m.lastBidPrice = m.ladder[standAt];
  m.landedBids = standAt + 1;
  m.revisionsLeft = REVISION_LIMIT - (standAt + 1);
  m._lastDefendAtExtend = extendsObserved;
  assert.notStrictEqual(m.softStrategy, 'off', 'PRECONDITION: the fixture must be an allowlisted (rank-driven) load');
  assert.ok(m.ladder.length >= 6, `PRECONDITION: fine ladder expected (>= 6 rungs), got ${m.ladder.length}`);
  return m;
}

const spState = (m, remaining, myRank) => ({
  ok: true, status: remaining > 0 ? 'live' : 'closed', myRank, totalBidders: 5, standingL1Price: null,
  closesInMs: remaining, revisionLimit: REVISION_LIMIT, revisionsLeft: null, minDecrement: MIN_DEC,
  closeModel: m.closeModel, extendMs: m.extendMs, extendCount: m.extendCap, triggerWindowMs: m.triggerWindowMs,
  measuredRttMs: 80,
});

// The real _maybeBid down the countdown at the cadence the engine schedules, on a virtual clock
// (minInterFireMs and maxBidsPerMin are measured against Date.now).
async function drive(rig, m, { from, to = 0, rank }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < 20_000) {
      rig.clock.remaining = r;
      await rig.eng._maybeBid(m, spState(m, r, rank(rig.wire)));
      const step = Math.max(1, rig.eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

// Our own rank only: 3 before our shot, `after` on every read once the shot is on the wire.
const rankAfterShot = (after) => (wire) => (wire.length ? after : 3);

function firstShotIsNonFloor(m, wire, label) {
  const floor = m.ladder[m.ladder.length - 1];
  assert.ok(wire.length >= 1, `PRECONDITION (${label}): no final shot reached the wire at all`);
  assert.notStrictEqual(wire[0].price, floor,
    `PRECONDITION (${label}): the first final shot was the floor ${floor}, so there is no non-floor shot to follow up`);
  return floor;
}

(async () => {
  console.log('soft-close floor after a non-floor final shot (ruling F2)');

  await runAsync('1 post-cap (3 of 3): non-floor buzzer shot, rank 2 read after it -> the floor goes before the close', async () => {
    const rig = mkRig(accept);
    const m = armLoad(rig.eng, { extendCap: 3, extendsObserved: 3, standAt: 1 });
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(2) });
    const floor = firstShotIsNonFloor(m, rig.wire, 'case 1');
    const after = rig.wire.slice(1);
    const floorShot = after.find((w) => w.price === floor && w.remaining > 0);
    assert.ok(floorShot,
      `after the non-floor final shot ${rig.wire[0].price} at ${rig.wire[0].remaining}ms landed and rank read 2, `
      + `the floor ${floor} never reached the wire before the close (wire after the shot: `
      + `[${after.map((w) => `${w.price}@${w.remaining}`).join(', ')}]; revisionsLeft ${m.revisionsLeft}) - `
      + 'ruling F2: no single-shot latch on soft close; outranked after a non-floor final shot with budget left, '
      + 'the floor still goes before the close (the snipeFired latch is holding it)');
  });

  await runAsync('2 unknown cap: non-floor band shot, rank 2 read after it -> the floor goes at <= 2,500ms', async () => {
    const rig = mkRig(accept);
    const m = armLoad(rig.eng, { extendCap: null, extendsObserved: 0, standAt: 1 });
    const band = rig.eng._decisiveBandFor(m);
    assert.ok(band, 'PRECONDITION: an unknown-cap allowlisted soft load must resolve to the decisive band');
    // Start where _cadence aims the poll: opensAt - width/4.
    const aim = band.opensAt - Math.floor((band.opensAt - band.closesAt) / 4);
    await drive(rig, m, { from: aim, rank: rankAfterShot(2) });
    const floor = firstShotIsNonFloor(m, rig.wire, 'case 2');
    assert.ok(rig.wire[0].remaining <= band.opensAt && rig.wire[0].remaining > band.closesAt,
      `PRECONDITION (case 2): the first shot went at ${rig.wire[0].remaining}ms, not in the band (${band.closesAt}, ${band.opensAt}]`);
    const after = rig.wire.slice(1);
    const floorShot = after.find((w) => w.price === floor && w.remaining <= 2_500 && w.remaining > 0);
    assert.ok(floorShot,
      `after the non-floor band shot ${rig.wire[0].price} at ${rig.wire[0].remaining}ms landed and rank read 2 to the close, `
      + `the floor ${floor} never went at <= 2,500ms (wire after the shot: `
      + `[${after.map((w) => `${w.price}@${w.remaining}`).join(', ')}]; revisionsLeft ${m.revisionsLeft}) - `
      + 'ruling F2: the unknown-cap band shot is not the last word either; outranked with budget left, the floor '
      + 'still goes before the close (the snipeFired latch is holding it)');
  });

  await runAsync('3 GUARD: every floor attempt refused -> offered at most lastResortFloorAttempts times', async () => {
    let cap = null;
    const rig = mkRig((price, wire) => {
      if (wire.length === 1) { cap = price - MIN_DEC; return accept(); }
      const text = `Amount is invalid. Amount should be less than or equal to ${cap}`;
      return { accepted: false, ok: false, status: 400, reason: text, text, raw: text };
    });
    const m = armLoad(rig.eng, { extendCap: 3, extendsObserved: 3, standAt: 1 });
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(2) });
    const floor = firstShotIsNonFloor(m, rig.wire, 'case 3');
    const bound = rig.eng.softCfg.lastResortFloorAttempts;
    const offers = rig.wire.filter((w) => w.price === floor).length;
    assert.ok(offers <= bound,
      `the floor was offered ${offers} times against a bound of ${bound} - a refused floor must not become an unbounded retry `
      + 'on a shared live account');
  });

  await runAsync('C1 CONTROL: rank 1 read after the non-floor shot -> nothing more goes (SP holds at rank 1)', async () => {
    const rig = mkRig(accept);
    const m = armLoad(rig.eng, { extendCap: 3, extendsObserved: 3, standAt: 1 });
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(1) });
    firstShotIsNonFloor(m, rig.wire, 'C1');
    assert.strictEqual(rig.wire.length, 1,
      `a bid went out while we held rank 1: [${rig.wire.map((w) => `${w.price}@${w.remaining}`).join(', ')}] - rank 1 holds`);
  });

  await runAsync('C2 CONTROL: allowlisted HARD load, rank 2 after the non-floor snipe -> no further bid (Q6)', async () => {
    const rig = mkRig(accept);
    const m = armLoad(rig.eng, { closeModel: 'hard', extendCap: null, extendsObserved: 0, standAt: 1 });
    await drive(rig, m, { from: 2_400, rank: rankAfterShot(2) });
    firstShotIsNonFloor(m, rig.wire, 'C2');
    assert.strictEqual(rig.wire.length, 1,
      `the hard-close single-shot latch moved: [${rig.wire.map((w) => `${w.price}@${w.remaining}`).join(', ')}] - `
      + 'ruling Q6 keeps it on allowlisted hard close in this PR');
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
