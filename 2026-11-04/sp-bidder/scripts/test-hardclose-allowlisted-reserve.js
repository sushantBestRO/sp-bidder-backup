'use strict';
/**
 * ALLOWLISTED HARD CLOSE KEEPS THE LAST REVISION FOR THE DECISIVE SHOT (PR-T5, rank-driven arm).
 *
 * Regression target: timing lane C (pattern
 * row "bidEngine.js:4457-4460 rankDriven hard step-down, no reserve") and the owner ruling of
 * 2026-09-24 "hard close ALWAYS keeps the last bid for the floor", applied to allowlisted hard loads
 * (Havells hard branches, KEI 25413420: cap 2, 3 rungs).
 *
 * The mechanism: on an allowlisted (softStrategy !== 'off') SuperProcure load that closes HARD,
 * `_decide` branch 4 steps down through selectRung phase 'defend' on every outranked tick with no
 * revision reserve. When the ladder has more rungs than the load's revision cap, the defend steps
 * spend the whole budget ~20 s before close, `_maybeBid`'s `revisionsLeft <= 0` gate then returns
 * before `_decide` runs, and the final-window decisive shot is never sent.
 *
 * What must NOT move: a 3-rung / cap-3 allowlisted hard load (check 0, the in-file control) already
 * keeps its last revision for the final window, because its defend clamps at last - 1.
 *
 * The kept shot must go out on the FIRST tick at or under 2,500 ms, not merely somewhere under it: a
 * fix that released it later (say at 1,000 ms) would still keep the budget but hand back the margin
 * the window exists for.
 *
 * OPEN OWNER QUESTION: checks 1 and 3 pin the EXISTING rank-aware snipe's pick (91,333 / 96,839),
 * which PR-T5 does not change. Whether an allowlisted hard load should send the 3% floor (90,022)
 * with its kept revision instead is the owner's call; if the ruling is "floor", only those expected
 * prices change - the timing and count assertions stay.
 *
 * Driven through the REAL `_tick` (live-read revision intake + `_maybeBid` + `_decide`) on a virtual
 * clock at the engine's own cadence. Fake adapter, temp-file scheduler, no network, no real waits.
 *
 *   node scripts/test-hardclose-allowlisted-reserve.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 87_400;
// cost x (1 + pct/100), rounded - by hand, not via the engine's ladder builder.
const P153 = 100_772; // 87,400 x 1.153 = 100,772.2
const P108 = 96_839;  // 87,400 x 1.108 =  96,839.2
const P45 = 91_333;   // 87,400 x 1.045 =  91,333.0
const P3 = 90_022;    // 87,400 x 1.030 =  90,022.0
const WINDOW_MS = 2_500;
// Rank 2 is the only outranked rank that exposes the defect on the 4-rung / cap-3 ladder: at k >= 3
// selectRung('defend') jumps straight from rung 0 to rung 2 and then holds, leaving one revision.
const OUTRANKED = 2;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-allow-reserve-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// SuperProcure-shaped: the cap is enforced ("Bid limit exceeded" once spent), the write response
// carries no rank (rank arrives on the next read), and our rank reads null until a write lands.
// revisionsLeftAfterEstablish models a human on the shared account spending slots right after our
// establish; only then does the read publish a remaining count.
function hardAdapter({ revisionLimit, revisionsLeftAfterEstablish = null }) {
  let left = revisionLimit;
  let landed = 0;
  const a = {
    closesAt: null,
    writes: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return {
        ok: true, status: 'live', myRank: landed ? OUTRANKED : null, totalBidders: 6, standingL1Price: null,
        closesInMs: Math.max(0, a.closesAt - Date.now()),
        revisionLimit, revisionsLeft: landed && revisionsLeftAfterEstablish != null ? left : null,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 120,
      };
    },
    async placeBid(_id, price) {
      const countdown = a.closesAt - Date.now();
      if (left <= 0) {
        a.writes.push({ price, countdown, refused: true });
        return { accepted: false, ok: false, status: 400, reason: 'Bid limit exceeded', text: 'Bid limit exceeded' };
      }
      left -= 1;
      landed += 1;
      if (landed === 1 && revisionsLeftAfterEstablish != null) left = Math.min(left, revisionsLeftAfterEstablish);
      a.writes.push({ price, countdown });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 100 };
    },
  };
  return a;
}

async function runLoad({ companyName, marginsPct, minMarginPct, revisionLimit, revisionsLeftAfterEstablish, from = 40_000, to = 300 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    const adapter = hardAdapter({ revisionLimit, revisionsLeftAfterEstablish });
    adapter.closesAt = vnow + from;
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: WINDOW_MS },
      softClose: { enabled: true, shippers: ['Havells', 'KEI'], mode: 'live', reserve: 1 },
      rand: () => 0,
      live: true,
    });
    const m = eng.arm(
      { id: String(++seq), lane: { origin: 'Alwar', destination: 'X' }, equipment: '19ft', units: 1,
        closesAt: adapter.closesAt, companyName, rules: { revisionLimit } },
      { cost: COST, marginsPct, minMarginPct });
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    // _tick re-arms its own real setTimeout; clearing it after each awaited tick leaves the virtual
    // clock as the only driver.
    const ticks = [];
    let r = from;
    while (r >= to) {
      ticks.push(r);
      await eng._tick(m);
      if (m.timer) clearTimeout(m.timer);
      m.timer = null;
      vnow += Math.max(1, eng._cadence(r, m));
      r = adapter.closesAt - vnow;
    }
    const firstWindowTick = ticks.find((t) => t <= WINDOW_MS);
    return { m, writes: adapter.writes, firstWindowTick };
  } finally { Date.now = REAL_NOW; }
}

const fmt = (ws) => ws.map((w) => `${w.price}@${w.countdown}ms${w.refused ? '(refused)' : ''}`).join(', ');

function assertShotOnFirstWindowTick(writes, firstWindowTick) {
  const shot = writes.find((w) => w.countdown <= WINDOW_MS);
  assert.strictEqual(shot.countdown, firstWindowTick,
    `the kept shot went out at ${shot.countdown}ms, not on the first tick inside the window (${firstWindowTick}ms). `
    + `Writes: [${fmt(writes)}]`);
}
const assertNoneRefused = (writes) => assert.ok(writes.every((w) => !w.refused),
  `a write was refused by the platform: [${fmt(writes)}]`);

let ran = 0, pass = 0;
const FAILURES = [];
async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { FAILURES.push(name); console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

(async () => {
  // 0. CONTROL - runs first, must pass on base.
  await check('0 control: allowlisted hard 3-rung / cap 3, outranked -> 3 writes, last in the final window', async () => {
    const { m, writes, firstWindowTick } = await runLoad({ companyName: 'Havells India', marginsPct: [15.3, 10.8, 4.5], minMarginPct: 4.5, revisionLimit: 3 });
    assert.strictEqual(m.softStrategy, 'live', 'fixture must be allowlisted (rankDriven)');
    assert.deepStrictEqual(m.ladder, [P153, P108, P45], 'fixture ladder');
    assert.strictEqual(writes.length, 3, `expected 3 writes, got [${fmt(writes)}]`);
    assert.ok(writes[2].countdown <= WINDOW_MS && writes[2].price === P45,
      `the harness did not reach the final window on an allowlisted hard load: [${fmt(writes)}]`);
    assertShotOnFirstWindowTick(writes, firstWindowTick);
    assertNoneRefused(writes);
  });

  // 1. 4-rung / cap 3.
  await check('1 allowlisted hard 4-rung / cap 3, outranked: the 3rd write is the decisive shot at <= 2,500 ms (ruling 27 fixture)', async () => {
    const { m, writes, firstWindowTick } = await runLoad({ companyName: 'Havells India', marginsPct: [15.3, 10.8, 4.5, 3], minMarginPct: 3, revisionLimit: 3 });
    assert.strictEqual(m.softStrategy, 'live', 'fixture must be allowlisted (rankDriven)');
    assert.deepStrictEqual(m.ladder, [P153, P108, P45, P3], 'fixture ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.ok(writes.length >= 1 && writes[0].price === P153 && writes[0].countdown > WINDOW_MS,
      `precondition: the establish lands above the window: [${fmt(writes)}]`);
    const inWindow = writes.filter((w) => w.countdown <= WINDOW_MS);
    assert.strictEqual(inWindow.length, 1,
      `no decisive shot in the final window: the rank-driven defend steps spent the whole cap-3 budget before `
      + `${WINDOW_MS}ms and the revisionsLeft<=0 gate blocked the shot (revisionsLeft at close: ${m.revisionsLeft}). Writes: [${fmt(writes)}]`);
    assertShotOnFirstWindowTick(writes, firstWindowTick);
    assertNoneRefused(writes);
    assert.strictEqual(writes.length, 3, `expected exactly 3 writes, got [${fmt(writes)}]`);
    // Rank-aware snipe from rung 1 at k = 2: target = 1 + (2 - 1) = rung 2 (10.8% -> 4.5%), unfired -> 91,333.
    assert.deepStrictEqual(writes.map((w) => w.price), [P153, P108, P45], `write prices: [${fmt(writes)}]`);
  });

  // 2. KEI shape: 3-rung / cap 2.
  await check('2 allowlisted hard 3-rung / cap 2 (KEI): establish, then the decisive shot at <= 2,500 ms', async () => {
    const { m, writes, firstWindowTick } = await runLoad({ companyName: 'KEI Industries', marginsPct: [15.3, 10.8, 4.5], minMarginPct: 4.5, revisionLimit: 2 });
    assert.strictEqual(m.softStrategy, 'live', 'fixture must be allowlisted (rankDriven)');
    assert.deepStrictEqual(m.ladder, [P153, P108, P45], 'fixture ladder');
    assert.ok(writes.length >= 1 && writes[0].price === P153 && writes[0].countdown > WINDOW_MS,
      `precondition: the establish lands above the window: [${fmt(writes)}]`);
    const inWindow = writes.filter((w) => w.countdown <= WINDOW_MS);
    assert.strictEqual(inWindow.length, 1,
      `no decisive shot in the final window: the rank-driven defend step spent the last of the cap-2 budget before `
      + `${WINDOW_MS}ms and the revisionsLeft<=0 gate blocked the shot (revisionsLeft at close: ${m.revisionsLeft}). Writes: [${fmt(writes)}]`);
    assertShotOnFirstWindowTick(writes, firstWindowTick);
    assertNoneRefused(writes);
    assert.strictEqual(writes.length, 2, `expected exactly 2 writes, got [${fmt(writes)}]`);
    // 3-rung ladder (last = 2 < 3): the snipe collapses to the floor, 91,333.
    assert.deepStrictEqual(writes.map((w) => w.price), [P153, P45], `write prices: [${fmt(writes)}]`);
  });

  // 3. Shared-slot spend mid-auction.
  await check('3 allowlisted hard 4-rung / cap 3, live read drops revisionsLeft to 1 after the establish: no defend, decisive shot at <= 2,500 ms (ruling 27 fixture)', async () => {
    const { m, writes, firstWindowTick } = await runLoad({ companyName: 'Havells India', marginsPct: [15.3, 10.8, 4.5, 3], minMarginPct: 3,
      revisionLimit: 3, revisionsLeftAfterEstablish: 1 });
    assert.strictEqual(m.softStrategy, 'live', 'fixture must be allowlisted (rankDriven)');
    assert.deepStrictEqual(m.ladder, [P153, P108, P45, P3], 'fixture ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.ok(writes.length >= 1 && writes[0].price === P153 && writes[0].countdown > WINDOW_MS,
      `precondition: the establish lands above the window: [${fmt(writes)}]`);
    const inWindow = writes.filter((w) => w.countdown <= WINDOW_MS);
    assert.strictEqual(inWindow.length, 1,
      `no decisive shot in the final window: with 1 revision left the rank-driven defend step spent it before `
      + `${WINDOW_MS}ms and the revisionsLeft<=0 gate blocked the shot (revisionsLeft at close: ${m.revisionsLeft}). Writes: [${fmt(writes)}]`);
    assertShotOnFirstWindowTick(writes, firstWindowTick);
    assertNoneRefused(writes);
    assert.strictEqual(writes.length, 2, `expected exactly 2 writes, got [${fmt(writes)}]`);
    // Rank-aware snipe from rung 0 at k = 2: target = 0 + (2 - 1) = rung 1, unfired -> 96,839.
    assert.deepStrictEqual(writes.map((w) => w.price), [P153, P108], `write prices: [${fmt(writes)}]`);
  });

  cleanup();
  if (FAILURES.length || pass !== ran || ran !== 4) {
    console.error(`FAIL: ${FAILURES.length} of ${ran} checks failed (${FAILURES.join(' | ')}) - allowlisted hard close `
      + 'spends its last revision on a defend step before the final window');
    process.exit(1);
  }
  console.log(`PASS: ${pass} checks`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('FAIL:', e && e.stack); process.exit(1); });
