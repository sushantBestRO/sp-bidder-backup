'use strict';
/**
 * PR-T5 SCOPE PINS - the populations a hard-close floor reserve must leave byte-identical.
 *
 * Regression target: PR-T5 (SP hard close keeps the last bid for the floor; diagnosis
 * 2026-09-24_timing-C-sp-hardclose). The reserve belongs to SuperProcure HARD close with a KNOWN
 * revision budget. Three other populations reach the same `_decide` branch-4 step-down and are owned by
 * other PRs, so PR-T5 must not move them:
 *   - GoComet (closeModel 'soft', softStrategy 'off' - the deployed arm): PR-T2a. On base it spends all
 *     3 attempts above the floor; that is PR-T2a's defect and is pinned here as today's behaviour.
 *   - allowlisted SP soft once `_effectivelyHard` (extensions used up): PR-T4.
 *   - hard close with an UNKNOWN budget (revisionsLeft null): the owner ruling keeps it exactly as today.
 * And hard close whose budget fits its ladder (4 rungs, cap 4) needs no reserve at all. The low-budget
 * half of the fix (skip the establish at budget <= 1) is SP hard close only too: a GoComet load at budget 1
 * or 2 still establishes exactly as today (checks 5a, 5b; PR-T2a).
 *
 * Each check records the exact wire sequence on the unfixed engine (price @ countdown ms) and pins it.
 * An over-broad reserve (every close model, or the rank-driven arm too) goes red here.
 *
 * Drives the REAL `_maybeBid` (revision gate included) down a countdown on a virtual clock at the
 * engine's own cadence. Fake adapter, temp-file scheduler, no network, no waits, no RNG.
 *
 *   node scripts/test-hardclose-reserve-scope.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// Borosil band, cost 87,400, marginsPct [15.3, 10.8, 4.5, 3], minMarginPct 3: cost x (1 + pct/100), rounded.
//   100,772.2 -> 100772 ; 96,839.2 -> 96839 ; 91,333.0 -> 91333 ; 3% 90,022.0 -> 90022
// Ruling 27: the minimum margin is a guard, never a bid, so the 4th rung is a 3% band margin.
const COST = 87_400;
const MARGINS = [15.3, 10.8, 4.5, 3];
const LADDER4 = [100_772, 96_839, 91_333, 90_022];

// The Havells ALWAR soft-branch mechanics as read off the live load object.
const TRIGGER_MS = 100_000;
const EXTEND_MS = 180_000;

let seq = 0;
const TMP = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-scope-${process.pid}-${seq++}.json`); TMP.push(f); return f; };

function mkAdapter(clock, revisionLimit, closeModel) {
  let revs = revisionLimit;
  const writes = [];
  return {
    writes,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit, closeModel }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    async placeBid(_id, price) {
      if (revs != null && revs <= 0) {
        writes.push({ price, countdown: clock.remaining, refused: true });
        return { accepted: false, reason: 'Bid limit exceeded' };
      }
      if (revs != null) revs -= 1;
      writes.push({ price, countdown: clock.remaining });
      return { accepted: true, myRank: null, revisionsLeft: revs, latencyMs: 100 };
    },
  };
}

function mkLoad({ companyName, closeModel, revisionLimit, softClose, branchName = null }) {
  const clock = { remaining: null };
  const adapter = mkAdapter(clock, revisionLimit, closeModel);
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: 2_500, cadenceJitterMs: 0,
      softOpenAtMs: 150_000, softOpenJitterMs: 0 },
    softClose,
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  const m = eng.arm(
    { id: String(800_000 + seq++), lane: { origin: 'ALWAR', destination: 'X' }, equipment: '19ft', units: 1,
      closesAt: Date.now() + 200_000, companyName, branchName },
    { cost: COST, marginsPct: MARGINS, minMarginPct: 3 }
  );
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.revisionsLeft = revisionLimit;
  assert.deepStrictEqual(m.ladder, LADDER4, 'fixture (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung) must build the 4-rung ladder');
  return { eng, m, adapter, clock };
}

// Copied from scripts/test-softclose-floor-reachability.js driveMaybeBid, plus the clock hand-off so
// the adapter can record the countdown each write went out at. Our rank is null until a bid lands.
async function driveMaybeBid(eng, m, clock, { from, to = 0, rank }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < 20_000) {
      const k = m.landedBids === 0 ? null : rank;
      clock.remaining = r;
      await eng._maybeBid(m, { closesInMs: r, myRank: k, minDecrement: 100, standingL1Price: null });
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

const fmt = (ws) => '[' + ws.map((w) => `${w.price}@${w.countdown}${w.refused ? '(refused)' : ''}`).join(', ') + ']';

function assertExact(writes, expected, owner, baseLabel = 'Base') {
  const got = fmt(writes);
  const want = fmt(expected);
  assert.strictEqual(got, want,
    `${owner} owns this population and a PR-T5 change must not move it. ${baseLabel} wrote ${want}, now ${got}`);
  console.log('       writes ' + got);
}

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED = 7;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of TMP) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran === EXPECTED && pass === EXPECTED) {
    console.log(`\nhard-close reserve scope pins: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${pass}/${EXPECTED} checks passed, ${ran} ran. The PR-T5 reserve leaked outside SP hard close with a known budget.`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

(async () => {
  console.log('hard-close reserve scope (PR-T5 must not move these)');

  await check('1 GoComet-shaped (soft, softStrategy off), 4 rungs, 3 attempts, outranked - today\'s writes exactly (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Waaree', closeModel: 'soft', revisionLimit: 3 });
    assert.strictEqual(m.softStrategy, 'off', 'fixture: a GoComet load is never allowlisted');
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 149_800 },
      { price: 96_839, countdown: 119_800 },
      { price: 91_333, countdown: 89_800 },
    ], 'PR-T2a (GoComet timing)');
  });

  await check('2a allowlisted SP soft past its extension cap (window 100 s), 4 rungs, cap 3, outranked - T4\'s writes exactly (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Havells', branchName: 'ALWAR', closeModel: 'soft', revisionLimit: 3,
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } });
    m.extendCap = 3;
    m.extendsObserved = 3;
    m.triggerWindowMs = TRIGGER_MS;
    m.extendMs = EXTEND_MS;
    assert.strictEqual(m.softStrategy, 'live', 'fixture: Havells must resolve to the allowlisted live strategy');
    assert.strictEqual(eng._effectivelyHard(m), true, 'fixture: extendsObserved >= extendCap must make the load effectively hard');
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 140_000 },
      { price: 96_839, countdown: 110_000 },
      { price: 90_022, countdown: 2_400 },
    ], 'PR-T4 (SP soft after the cap; owner ruling 24 Sep: final bids in the last seconds, like hard close)',
    'T4 alone');
  });

  await check('2b allowlisted SP soft past its extension cap (window unknown), 4 rungs, cap 3, outranked - T4\'s writes exactly (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Havells', branchName: 'ALWAR', closeModel: 'soft', revisionLimit: 3,
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 } });
    m.extendCap = 3;
    m.extendsObserved = 3;
    assert.strictEqual(m.triggerWindowMs, null, 'fixture: no trigger window surfaced');
    assert.strictEqual(eng._effectivelyHard(m), true, 'fixture: extendsObserved >= extendCap must make the load effectively hard');
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 25_000 },
      { price: 96_839, countdown: 24_000 },
      { price: 90_022, countdown: 2_400 },
    ], 'PR-T4 (SP soft after the cap; owner ruling 24 Sep: final bids in the last seconds, like hard close)',
    'T4 alone');
  });

  await check('3 hard close, budget UNKNOWN (revisionsLeft null), 4 rungs, outranked - today\'s writes exactly (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Borosil', closeModel: 'hard', revisionLimit: null });
    assert.strictEqual(m.revisionsLeft, null, 'fixture: the budget must be unknown');
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 25_000 },
      { price: 96_839, countdown: 24_000 },
      { price: 91_333, countdown: 23_000 },
      { price: 90_022, countdown: 2_400 },
    ], 'The owner ruling (unknown budget -> exactly as today, not PR-T5)');
  });

  await check('4 hard close, 4 rungs, cap 4 (budget fits the ladder), outranked - today\'s writes exactly (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Borosil', closeModel: 'hard', revisionLimit: 4 });
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 25_000 },
      { price: 96_839, countdown: 24_000 },
      { price: 91_333, countdown: 23_000 },
      { price: 90_022, countdown: 2_400 },
    ], 'The deployed hard-close walk (a budget that fits the ladder needs no reserve; PR-T5 scope ends there)');
  });
  await check('5a GoComet-shaped (soft, softStrategy off), 4 rungs, budget 1, outranked - still establishes exactly as today (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Waaree', closeModel: 'soft', revisionLimit: 1 });
    assert.strictEqual(m.softStrategy, 'off', 'fixture: a GoComet load is never allowlisted');
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 149_800 },
    ], 'PR-T2a (GoComet timing; the PR-T5 skip-the-establish-at-budget-1 rule is SP hard close only)');
  });

  await check('5b GoComet-shaped (soft, softStrategy off), 4 rungs, budget 2, outranked - today\'s writes exactly (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Waaree', closeModel: 'soft', revisionLimit: 2 });
    await driveMaybeBid(eng, m, clock, { from: 200_000, rank: 2 });
    assertExact(adapter.writes, [
      { price: 100_772, countdown: 149_800 },
      { price: 96_839, countdown: 119_800 },
    ], 'PR-T2a (GoComet timing; the PR-T5 last-revision reserve is SP hard close only)');
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
