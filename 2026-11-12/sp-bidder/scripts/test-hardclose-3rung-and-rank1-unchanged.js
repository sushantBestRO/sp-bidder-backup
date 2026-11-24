'use strict';
/**
 * PR-T5 POSITIVE PINS - what the hard-close floor reserve must NOT change.
 *
 * Regression target: PR-T5 (SP hard close keeps the last bid for the floor; diagnosis
 * 2026-09-24_timing-C-sp-hardclose). The fix reserves the final revision for the floor on a
 * SuperProcure hard-close load whose ladder has more rungs than its revision cap (Borosil: 4 rungs,
 * cap 3). These checks PASS on the unfixed engine and must stay green after it.
 *
 * Mechanism pinned: on a 3-rung / cap-3 ladder (Durian, Syngenta, ADAMA, SIKA, Kingspan) the deployed
 * step-down already stops at last-1 with one revision left, so the floor fires at <= 2,500 ms without
 * any reserve. And a load at rank 1 holds (`_decide`, `if (state.myRank === 1) return null;`) - the
 * "early" last bids on Durian 25599675 / 25747721 / 25682198 and Syngenta 25421937 / 25713240 are
 * those holds, and they were won. A fix that reserves a revision on these loads, or that spends one
 * while holding L1, moves real money and goes red here.
 *
 * Drives the REAL `_maybeBid` (revision gate included) down a countdown on a virtual clock at the
 * engine's own cadence. Fake adapter, temp-file scheduler, no network, no waits, no RNG.
 *
 *   node scripts/test-hardclose-3rung-and-rank1-unchanged.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// Borosil band, cost 87,400, marginsPct [15.3, 10.8, 4.5]: cost x (1 + pct/100), rounded.
//   15.3% -> 100,772.2 -> 100772 ; 10.8% -> 96,839.2 -> 96839 ; 4.5% -> 91,333.0 -> 91333
//   the 4-rung ladder adds a 3% band margin -> 90,022.0 -> 90022 (ruling 27: the minimum is never a rung)
const COST = 87_400;
const MARGINS = [15.3, 10.8, 4.5];
const MARGINS_4 = [15.3, 10.8, 4.5, 3];
const R0 = 100_772;
const R1 = 96_839;
const R2 = 91_333;
const FLOOR4 = 90_022;

// Exact countdowns on the virtual clock, driven from 40,000 at the engine's cadence (1,000 ms mid poll
// above 10,000, 200 ms hot poll at or below it, no jitter):
//   establish   25,000 - the first tick at or under openAtMs 25,000 (openJitterMs 0)
//   nextTick    24,000 - one mid poll later
//   lateStep     6,000 - the first hot tick at which the ~6 s overtake is seen
//   floorShot    2,400 - the first hot tick at or under floorWindowMs 2,500 (10,000 - 38 x 200)
const AT = {
  establish: 25_000,
  nextTick: 24_000,
  lateStep: 6_000,
  floorShot: 2_400,
};

let seq = 0;
const TMP = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-pins1-${process.pid}-${seq++}.json`); TMP.push(f); return f; };

function mkAdapter(clock, revisionLimit) {
  let revs = revisionLimit;
  const writes = [];
  return {
    writes,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit, closeModel: 'hard' }),
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

function mkLoad({ companyName, marginsPct = MARGINS, minMarginPct, revisionLimit }) {
  const clock = { remaining: null };
  const adapter = mkAdapter(clock, revisionLimit);
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: 2_500, cadenceJitterMs: 0 },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  const m = eng.arm(
    { id: String(900_000 + seq++), lane: { origin: 'Govindgarh', destination: 'X' }, equipment: '19ft', units: 1,
      closesAt: Date.now() + 40_000, companyName },
    { cost: COST, marginsPct, minMarginPct }
  );
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'hard';
  m.revisionsLeft = revisionLimit;
  return { eng, m, adapter, clock };
}

// Copied from scripts/test-softclose-floor-reachability.js driveMaybeBid, plus the clock hand-off so
// the adapter can record the countdown each write went out at.
async function driveMaybeBid(eng, m, clock, { from, to = 0, rank }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < 20_000) {
      const k = m.landedBids === 0 ? null : rank(m, r);
      clock.remaining = r;
      await eng._maybeBid(m, { closesInMs: r, myRank: k, minDecrement: 100, standingL1Price: null });
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

const fmt = (ws) => '[' + ws.map((w) => `${w.price}@${w.countdown}${w.refused ? '(refused)' : ''}`).join(', ') + ']';

function assertWrites(writes, expected, why) {
  const got = fmt(writes);
  assert.strictEqual(writes.length, expected.length,
    `${why}: expected ${expected.length} write(s), got ${writes.length} ${got}`);
  expected.forEach(([price, at], i) => {
    const w = writes[i];
    assert.ok(!w.refused, `${why}: write ${i + 1} was refused by the platform ${got}`);
    assert.strictEqual(w.price, price, `${why}: write ${i + 1} was ${w.price}, expected ${price} ${got}`);
    assert.strictEqual(w.countdown, at,
      `${why}: write ${i + 1} (${price}) went out at countdown ${w.countdown}, base sent it at ${at} ${got}`);
  });
  console.log('       writes ' + got);
}

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED = 6;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of TMP) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran === EXPECTED && pass === EXPECTED) {
    console.log(`\nhard-close 3-rung and rank-1 pins: ${pass}/${EXPECTED} checks passed`);
    return;
  }
  console.error(`\nFAILED: ${pass}/${EXPECTED} checks passed, ${ran} ran. PR-T5 must leave 3-rung / cap-3 ladders and rank-1 holds byte-identical.`);
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
  console.log('hard-close 3-rung ladders and rank-1 holds (PR-T5 positive pins)');

  await check('1 3-rung / cap 3, outranked throughout: establish, next rung, floor at <= 2,500 - exactly 3 writes', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Durian', minMarginPct: 4.5, revisionLimit: 3 });
    assert.deepStrictEqual(m.ladder, [R0, R1, R2], 'fixture: the 4.5% band must build the 3-rung ladder');
    await driveMaybeBid(eng, m, clock, { from: 40_000, rank: () => 4 });
    assertWrites(adapter.writes,
      [[R0, AT.establish], [R1, AT.nextTick], [R2, AT.floorShot]],
      'a 3-rung / cap-3 load already keeps its last revision for the floor; PR-T5 must not move it');
  });

  await check('2 rank 1 from the establish, held to the close (Durian 25599675, Syngenta 25421937) - exactly 1 write', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Durian', minMarginPct: 4.5, revisionLimit: 3 });
    await driveMaybeBid(eng, m, clock, { from: 40_000, rank: () => 1 });
    assertWrites(adapter.writes, [[R0, AT.establish]],
      'rank 1 must hold: no step-down and no floor while we lead (the rank-1 hold in _decide)');
  });

  await check('3 rank 3 after the establish, rung 1 takes L1 and holds (Durian 25747721) - exactly 2 writes', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Durian', minMarginPct: 4.5, revisionLimit: 3 });
    await driveMaybeBid(eng, m, clock, { from: 40_000, rank: (mon) => (mon.landedBids >= 2 ? 1 : 3) });
    assertWrites(adapter.writes, [[R0, AT.establish], [R1, AT.nextTick]],
      'once rung 1 holds L1 nothing else may go out - no floor on a load we are winning');
  });

  await check('4 held L1, overtaken at ~6 s, steps once, back to L1 (Syngenta 25713240, Durian 25682198) - exactly 2 writes', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Syngenta', minMarginPct: 4.5, revisionLimit: 3 });
    await driveMaybeBid(eng, m, clock, {
      from: 40_000,
      rank: (mon, r) => (mon.landedBids >= 2 ? 1 : (r > 6_000 ? 1 : 2)),
    });
    assertWrites(adapter.writes, [[R0, AT.establish], [R1, AT.lateStep]],
      'a late overtake gets exactly one step, at the overtake tick, then the regained L1 holds with no floor');
  });

  await check('5 held L1 after rung 1, overtaken at ~5 s: floor at <= 2,500 - exactly 3 writes', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Syngenta', minMarginPct: 4.5, revisionLimit: 3 });
    await driveMaybeBid(eng, m, clock, {
      from: 40_000,
      rank: (mon, r) => {
        if (mon.landedBids === 1) return 3;
        if (mon.landedBids === 2) return r > 5_000 ? 1 : 2;
        return 2;
      },
    });
    assertWrites(adapter.writes, [[R0, AT.establish], [R1, AT.nextTick], [R2, AT.floorShot]],
      'overtaken after rung 1 already sits at last-1, so the next write is the floor in the final window');
  });

  await check('6 4-rung Borosil ladder, cap 3, rank 1 from the establish (Borosil 25622065, won) - exactly 1 write (ruling 27 fixture)', async () => {
    const { eng, m, adapter, clock } = mkLoad({ companyName: 'Borosil', marginsPct: MARGINS_4, minMarginPct: 3, revisionLimit: 3 });
    assert.deepStrictEqual(m.ladder, [R0, R1, R2, FLOOR4], 'fixture (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung) must build the 4-rung ladder');
    await driveMaybeBid(eng, m, clock, { from: 40_000, rank: () => 1 });
    assertWrites(adapter.writes, [[R0, AT.establish]],
      'a budget-short ladder still holds at rank 1 - the PR-T5 reserve must not turn a won L1 hold into a floor shot');
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
