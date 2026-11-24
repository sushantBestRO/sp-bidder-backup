'use strict';
/**
 * SuperProcure bidding decisions must not move when GoComet gets its final-round timing.
 *
 * Positive pin for PR-T2a (GoComet final-round timing), contract section 6.
 * GREEN ON BASE by design. Every golden below was recorded on base d3bf803 (timing/base = main
 * f1b2066 + W1-6 5be1257 + W1-7 7c41153) and is SuperProcure behaviour T2a must not move.
 *
 * THE RISK. T2a selects its population by closeIsProvisional(caps): closeModel 'soft' AND
 * extensionCeiling PRESENT and null. SuperProcure adapters declare closeModel 'unknown' and no
 * extensionCeiling key, and their frames carry 'soft' or 'hard' per load. An implementation keyed
 * on softStrategy 'off', on a 'soft' close model, or on a truthiness test of extensionCeiling
 * would also capture SP loads - above all non-allowlisted SP soft loads, which share softStrategy
 * 'off' with GoComet. Checks:
 *   1. SP non-allowlisted soft ('off'), 200 s published trigger window, known cap 3, bid cap 10,
 *      5-rung ladder, one extension: the establish mark raised clear of the window (247,500), the
 *      branch-4 walk, the 2.5 s floor.
 *   2. SP allowlisted soft ('live'), known cap 3, rank 1 held through the window and an extension.
 *   3. SP allowlisted soft, UNKNOWN cap: the decisive band (100,000, 102,500] keeps the floor shot.
 *   4. SP hard close, 3 rungs, bid cap 3, outranked into the final window (the Durian shape).
 *   5. _effectivelyHard's truth table.
 *   6. extensionCeiling ABSENT is not provisional: a GoComet-shaped career (closeModel 'soft' caps,
 *      softStrategy 'off', 299 s rounds, 3 attempts) on an adapter declaring no ceiling key decides
 *      exactly as base. A truthiness test on the ceiling gets this one wrong.
 *
 * SIBLING PRs (merge order T1 -> T5 -> T4 -> T2a). The scenarios avoid what T5 and T4 change: hard
 * close uses 3 rungs / cap 3 (T5 changes only ladders longer than the cap); allowlisted soft uses
 * rank-1 holds and the unknown-cap band (T4 changes known-cap-exhausted bands, the latch after a
 * non-floor final shot, and pre-cap in-window defends on bid caps <= 3); the non-allowlisted case
 * uses bid cap 10 and never exhausts its known cap. Check 6 is the shape T5's own pin 1 keeps.
 *
 * DRIVE. Scripted frames reach the real BidEngine through _tick, the production path, with a fake
 * adapter, the real DurableScheduler on a temp file, and Date.now stubbed so closesInMs =
 * closesAtMs - now, exactly as the adapters derive it. Each frame's golden is its countdown and
 * the price sent on it ('-' = no bid); every scenario also asserts the full placeBid sequence.
 * Engine config mirrors src/config.js (openAtMs 25,000, softOpenAtMs 150,000, softOpenJitterMs
 * 15,000, floorWindowMs 2,500) with openJitterMs and cadenceJitterMs 0 and rand fixed at 0.5.
 * Offline and deterministic: no network, no sleeps, the engine's own timers cleared after every
 * tick, temp files removed on exit.
 *
 *   node scripts/test-timing-sp-decisions-unchanged.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 6;
const OWNER = 'PR-T2a (GoComet final-round timing) must not move SuperProcure decisions';

// Borosil band, cost 87,400. 4.5% operating floor gives 3 rungs, 3% gives 4.
const COST = 87_400;
const R0 = 100_772;
const R1 = 96_839;
const R2 = 91_333;
const F3 = 90_022;
const R12 = 98_675; // 12.9%
const BAND3 = { cost: COST, marginsPct: [15.3, 10.8, 4.5], minMarginPct: 4.5 };
// Ruling 27: the minimum margin is a guard, never a bid, so the floor rung is carried as the lowest band margin.
const BAND4 = { cost: COST, marginsPct: [15.3, 10.8, 4.5, 3], minMarginPct: 3 };
const BAND5 = { cost: COST, marginsPct: [15.3, 12.9, 10.8, 4.5, 3], minMarginPct: 3 };

const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };
// The real gocometAdapter.capabilities() minus the extensionCeiling key.
const NO_CEILING_SOFT_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
  revisionLimit: 3, closeModel: 'soft', reactiveClose: true, extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 };

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
const ENGINES = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `sp-decisions-pin-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

let ran = 0;
let pass = 0;
const FAILURES = [];
process.on('exit', (code) => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran === EXPECTED_CHECKS && pass === EXPECTED_CHECKS) {
    if (code === 0) console.log(`\nPASS - ${pass} checks: SuperProcure decisions unchanged (goldens recorded on d3bf803)`);
    return;
  }
  console.error(`\nFAIL - ${pass}/${EXPECTED_CHECKS} checks passed, ${ran} ran. ${OWNER}:`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

async function check(name, fn) {
  ran++;
  try {
    await fn();
    pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    const message = (e && e.message) || String(e);
    FAILURES.push({ name, message });
    console.log(`  FAIL  ${name}\n        ${message}`);
  }
}

// frame(close, now) builds the platform's state for one read; `attempts` is the accepted-bid count so far.
function rig({ caps, softClose, companyName, band, rules, postedCloseAt, frame }) {
  const writes = [];
  const ctx = { close: postedCloseAt, rank: null, cd: null };
  const adapter = {
    capabilities: () => ({ ...caps }),
    ensureSession: async () => ({}),
    getAuctionState: async () => frame(ctx, writes.length),
    placeBid: async (_id, price) => {
      writes.push({ price, cd: ctx.cd });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 40 };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, openJitterMs: 0, softOpenAtMs: 150_000, softOpenJitterMs: 15_000,
      floorWindowMs: 2_500, cadenceJitterMs: 0 },
    softClose: softClose || { enabled: false },
    rand: () => 0.5,
    onEvent: () => {},
    log: quiet,
  });
  ENGINES.push(eng);
  vnow = postedCloseAt - 900_000;
  const m = eng.arm({ id: `PIN-${seq++}`, lane: { origin: 'Govindgarh', destination: 'Hapur' }, equipment: '19ft',
    units: 1, quoteType: 'FTL', companyName, closesAt: postedCloseAt,
    rules }, band);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }

  // steps: { cd, rank, extendBy? } - extendBy moves the close forward before this read.
  const run = async (steps) => {
    const trace = [];
    for (const s of steps) {
      if (s.extendBy) ctx.close += s.extendBy;
      vnow = ctx.close - s.cd;
      ctx.rank = s.rank;
      ctx.cd = s.cd;
      const before = writes.length;
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      const sent = writes.slice(before).map((w) => w.price);
      trace.push(`${s.cd}:${sent.length ? sent.join('+') : '-'}`);
    }
    return { trace, sequence: writes.map((w) => `${w.price}@${w.cd}`) };
  };
  return { eng, m, run };
}

const spFrame = ({ closeModel, extendMs, extendCount, triggerWindowMs, revisionLimit }) => (ctx) => ({
  ok: true, status: 'live', myRank: ctx.rank, totalBidders: 4, standingL1Price: null,
  closesAtMs: ctx.close, closesInMs: ctx.close - Date.now(), revisionLimit, revisionsLeft: null,
  minDecrement: 100, closeModel, extendMs, extendCount, triggerWindowMs, measuredRttMs: 40 });

function preconditions(r, { ladder, softStrategy }) {
  const bad = [];
  if (closeIsProvisional(r.eng.caps)) bad.push('closeIsProvisional(caps) is true for this adapter');
  if (JSON.stringify(r.m.ladder) !== JSON.stringify(ladder)) bad.push(`ladder ${JSON.stringify(r.m.ladder)}, expected ${JSON.stringify(ladder)}`);
  if (r.m.softStrategy !== softStrategy) bad.push(`softStrategy '${r.m.softStrategy}', expected '${softStrategy}'`);
  if (bad.length) throw new Error(`HARNESS: fixture drifted: ${bad.join('; ')}`);
}

function assertGolden(label, got, golden) {
  const diffs = [];
  golden.trace.forEach((g, i) => { if (got.trace[i] !== g) diffs.push(`frame ${i + 1} base ${g}, now ${got.trace[i]}`); });
  if (got.trace.length !== golden.trace.length) diffs.push(`${got.trace.length} frames traced, base ${golden.trace.length}`);
  const seqMoved = JSON.stringify(got.sequence) !== JSON.stringify(golden.sequence);
  if (!diffs.length && !seqMoved) return;
  throw new Error(`${label} moved: ${diffs.join('; ') || 'per-frame trace equal'}; placeBid base `
    + `[${golden.sequence.join(', ')}], now [${got.sequence.join(', ')}] (countdown:price per frame, '-' = no bid)`);
}

// Recorded on d3bf803. Frame goldens are countdown:price sent on that read ('-' = no bid).
const GOLDEN = {
  // mark 247,500; establish 245,000; walk one rung per outranked read (rank 1 holds, window or not);
  // after the extension one more walk step, then nothing until the floor at 2,400.
  offSoft: {
    trace: ['400000:-', '300000:-', '250000:-', '245000:100772', '230000:-', '215000:98675', '190000:96839',
      '170000:-', '340000:91333', '250000:-', '60000:-', '10000:-', '3000:-', '2400:90022', '1000:-'],
    sequence: ['100772@245000', '98675@215000', '96839@190000', '91333@340000', '90022@2400'],
  },
  // establish at max(openAtMs, window + 40 s) = 140,000, then rank 1 holds everything, floor included.
  liveRank1: {
    trace: ['200000:-', '140000:100772', '130000:-', '90000:-', '250000:-', '101500:-', '60000:-', '10000:-',
      '2400:-', '1000:-'],
    sequence: ['100772@140000'],
  },
  // unknown cap fails closed to effectively hard; the floor goes in the band above the 100 s window.
  liveUnknownCap: {
    trace: ['200000:-', '140000:100772', '125000:-', '101500:91333', '60000:-', '2400:-', '1000:-'],
    sequence: ['100772@140000', '91333@101500'],
  },
  hardDurian: {
    trace: ['40000:-', '25000:100772', '24000:96839', '10000:-', '3000:-', '2400:91333', '1000:-'],
    sequence: ['100772@25000', '96839@24000', '91333@2400'],
  },
  // mark 157,500 (no window published); the walk spends the other two attempts at 424 s and 300 s of
  // the next round and the floor is never offered.
  noCeiling: {
    trace: ['424000:-', '300000:-', '150000:100772', '60000:-', '424000:96839', '300000:91333', '150000:-',
      '424000:-', '30000:-', '10500:-', '5000:-', '2400:-'],
    sequence: ['100772@150000', '96839@424000', '91333@300000'],
  },
};

(async () => {
  console.log('SuperProcure decisions unchanged by GoComet final-round timing (PR-T2a positive pin)');
  const posted = REAL_NOW() + 3_600_000;

  await check('1 SP non-allowlisted soft (off), 200 s window, known cap 3, bid cap 10: establish mark, branch-4 walk, 2.5 s floor (ruling 27 fixture)', async () => {
    const r = rig({ caps: SP_CAPS, softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
      companyName: 'Shriji Polymers', band: BAND5, rules: { revisionLimit: 10, minDecrement: 100 }, postedCloseAt: posted,
      frame: spFrame({ closeModel: 'soft', extendMs: 180_000, extendCount: 3, triggerWindowMs: 200_000, revisionLimit: 10 }) });
    preconditions(r, { ladder: [R0, R12, R1, R2, F3], softStrategy: 'off' });
    const got = await r.run([
      { cd: 400_000, rank: null }, { cd: 300_000, rank: null }, { cd: 250_000, rank: null },
      { cd: 245_000, rank: null }, { cd: 230_000, rank: null }, { cd: 215_000, rank: 3 },
      { cd: 190_000, rank: 2 }, { cd: 170_000, rank: 1 },
      { cd: 340_000, rank: 2, extendBy: 180_000 }, { cd: 250_000, rank: 1 }, { cd: 60_000, rank: 2 },
      { cd: 10_000, rank: 2 }, { cd: 3_000, rank: 2 }, { cd: 2_400, rank: 2 }, { cd: 1_000, rank: 2 },
    ]);
    assertGolden('SP non-allowlisted soft decisions', got, GOLDEN.offSoft);
    const mark = r.eng._softEstablishThreshold(r.m);
    if (mark !== 247_500) throw new Error(`establish mark moved: base 247500 (200 s window + 40 s lead + 7,500 jitter), now ${mark}`);
  });

  await check('2 SP allowlisted soft (live), known cap 3: rank 1 held through the window and an extension', async () => {
    const r = rig({ caps: SP_CAPS, softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
      companyName: 'Havells India', band: BAND3, rules: { minDecrement: 100 }, postedCloseAt: posted,
      frame: spFrame({ closeModel: 'soft', extendMs: 180_000, extendCount: 3, triggerWindowMs: 100_000, revisionLimit: 10 }) });
    preconditions(r, { ladder: [R0, R1, R2], softStrategy: 'live' });
    const got = await r.run([
      { cd: 200_000, rank: null }, { cd: 140_000, rank: null }, { cd: 130_000, rank: null },
      { cd: 90_000, rank: 1 }, { cd: 250_000, rank: 1, extendBy: 180_000 }, { cd: 101_500, rank: 1 },
      { cd: 60_000, rank: 1 }, { cd: 10_000, rank: 1 }, { cd: 2_400, rank: 1 }, { cd: 1_000, rank: 1 },
    ]);
    assertGolden('SP allowlisted soft rank-1 hold', got, GOLDEN.liveRank1);
  });

  await check('3 SP allowlisted soft (live), unknown cap: the decisive band keeps the floor shot', async () => {
    const r = rig({ caps: SP_CAPS, softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
      companyName: 'Havells India', band: BAND3, rules: { minDecrement: 100 }, postedCloseAt: posted,
      frame: spFrame({ closeModel: 'soft', extendMs: 180_000, extendCount: null, triggerWindowMs: 100_000, revisionLimit: 10 }) });
    preconditions(r, { ladder: [R0, R1, R2], softStrategy: 'live' });
    const got = await r.run([
      { cd: 200_000, rank: null }, { cd: 140_000, rank: null }, { cd: 125_000, rank: 1 },
      { cd: 101_500, rank: 3 }, { cd: 60_000, rank: 1 }, { cd: 2_400, rank: 1 }, { cd: 1_000, rank: 1 },
    ]);
    assertGolden('SP allowlisted soft unknown-cap band', got, GOLDEN.liveUnknownCap);
  });

  await check('4 SP hard close, 3 rungs, bid cap 3, outranked into the final window (Durian shape)', async () => {
    const r = rig({ caps: SP_CAPS, companyName: 'Durian Industries', band: BAND3, rules: { revisionLimit: 3, minDecrement: 100 }, postedCloseAt: posted,
      frame: spFrame({ closeModel: 'hard', extendMs: null, extendCount: null, triggerWindowMs: null, revisionLimit: 3 }) });
    preconditions(r, { ladder: [R0, R1, R2], softStrategy: 'off' });
    const got = await r.run([
      { cd: 40_000, rank: null }, { cd: 25_000, rank: null }, { cd: 24_000, rank: 3 }, { cd: 10_000, rank: 2 },
      { cd: 3_000, rank: 2 }, { cd: 2_400, rank: 2 }, { cd: 1_000, rank: 2 },
    ]);
    assertGolden('SP hard close decisions', got, GOLDEN.hardDurian);
  });

  await check('5 _effectivelyHard truth table', async () => {
    const eng = new BidEngine({ capabilities: () => ({ ...SP_CAPS }) }, new DurableScheduler(tmp()), { log: quiet });
    ENGINES.push(eng);
    const rows = [
      ['hard', 'off', null, 0, true],
      ['hard', 'live', 3, 0, true],
      ['soft', 'off', null, 0, true],
      ['soft', 'off', 3, 0, true],
      ['soft', 'live', null, 0, true],
      ['soft', 'live', 3, 2, false],
      ['soft', 'live', 3, 3, true],
      ['soft', 'live', 2, 3, true],
    ];
    const moved = rows.filter(([closeModel, softStrategy, extendCap, extendsObserved, want]) =>
      eng._effectivelyHard({ closeModel, softStrategy, extendCap, extendsObserved }) !== want)
      .map(([c, s, cap, obs, want]) => `${c}/${s}/cap ${cap}/observed ${obs}: base ${want}`);
    if (moved.length) throw new Error(`_effectivelyHard truth table moved: ${moved.join('; ')}`);
  });

  await check('6 extensionCeiling ABSENT is not provisional: GoComet-shaped soft off career decides as base (ruling 27 fixture)', async () => {
    const r = rig({ caps: NO_CEILING_SOFT_CAPS, companyName: 'Waaree Energies', band: BAND4, rules: { revisionLimit: 3, minDecrement: 500 },
      postedCloseAt: posted,
      frame: (ctx, attempts) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: ctx.close,
        closesInMs: ctx.close - Date.now(), extendMs: 300_000, extendCount: null, myRank: ctx.rank,
        totalBidders: null, standingL1Price: null, revisionsLeft: Math.max(0, 3 - attempts), revisionLimit: 3,
        minDecrement: 500, measuredRttMs: 40 }) });
    preconditions(r, { ladder: [R0, R1, R2, F3], softStrategy: 'off' });
    if (!Object.prototype.hasOwnProperty.call(r.eng.caps, 'closeModel') || 'extensionCeiling' in r.eng.caps) {
      throw new Error('HARNESS: the adapter must declare closeModel and omit extensionCeiling');
    }
    const got = await r.run([
      { cd: 424_000, rank: null }, { cd: 300_000, rank: null }, { cd: 150_000, rank: null }, { cd: 60_000, rank: null },
      { cd: 424_000, rank: 2, extendBy: 299_000 }, { cd: 300_000, rank: 2 }, { cd: 150_000, rank: 2 },
      { cd: 424_000, rank: 2, extendBy: 299_000 }, { cd: 30_000, rank: 2 }, { cd: 10_500, rank: 2 },
      { cd: 5_000, rank: 2 }, { cd: 2_400, rank: 2 },
    ]);
    assertGolden('extensionCeiling-absent soft career', got, GOLDEN.noCeiling);
  });
})().catch((e) => {
  FAILURES.push({ name: 'harness', message: `threw: ${e && e.stack ? e.stack : e}` });
  process.exitCode = 1;
});
