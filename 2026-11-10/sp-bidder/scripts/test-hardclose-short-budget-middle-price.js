'use strict';
/**
 * SP HARD CLOSE, DEPLOYED PATH: which middle price goes out when the budget cannot fund them all.
 *
 * Regression target: PR-T5 (SP hard close keeps the last bid for the floor), owner question Q3.
 *
 * Q3 IS AN OPEN OWNER QUESTION. When the revisions left cannot fund every unspent middle price plus
 * the floor, which one middle price goes out? This file pins the plan's DEFAULT - the NEXT price below
 * where we stand (Borosil: 96,839 = 10.8%) - in ONE named constant, Q3_MIDDLE. If the owner answers
 * "lowest middle" (91,333 = 4.5%), change Q3_MIDDLE in this file and nothing else: it moves checks 1
 * (late overtake) and 3 (the common Borosil timeline) together. scripts/test-hardclose-4rung-cap3-floor.js
 * deliberately asserts only "one middle price" so it does not move with the answer. Check 2 (budget
 * fits) is not a Q3 case and does not move either. In the engine the choice must live in one clearly
 * named place on the _decide branch-4 non-allowlisted arm.
 *
 * Mechanism on base: the deployed step-down picks `max(current + 1, _scheduledRungIndex(remaining))`,
 * a clock walk that goes deeper as time runs out, with no revision reserve. Overtaken late (~11 s out)
 * after holding L1, the clock index is already 2, so base spends its one affordable middle revision on
 * 91,333. Outranked right after the establish, base walks 96,839 then 91,333 and the floor never goes.
 *
 * Checks:
 *   1  late overtake, cap 3 (budget short): [100772, Q3_MIDDLE, 90022], floor on the first window tick
 *   2  CONTROL, late overtake, cap 4 (budget fits): the deployed clock walk is unchanged,
 *      [100772, 91333, 90022] (hand-simulated from the clock walk, confirmed on base)
 *   3  common timeline, outranked right after the establish, cap 3: [100772, Q3_MIDDLE, 90022],
 *      floor on the first window tick
 *
 * WHAT MUST NOT MOVE: check 2 - a budget that funds every middle price keeps the deployed clock walk.
 *
 * Offline and deterministic: fake SuperProcure adapter, real BidEngine + DurableScheduler on a temp
 * file, the REAL _tick -> _maybeBid path driven on a virtual clock at the engine's own cadence. No
 * network, no real waits, jitter pinned to 0. Expected prices are cost x (1 + pct/100), by hand.
 *
 *   node scripts/test-hardclose-short-budget-middle-price.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 87_400;
// Ruling 27: the minimum margin is a guard, never a bid, so the 4th rung is a 3% band margin.
const MARGINS = [15.3, 10.8, 4.5, 3];
const MIN_MARGIN = 3;
// 87,400 x 1.153 / 1.108 / 1.045 / 1.03
const R0 = 100_772;
const R1 = 96_839;
const R2 = 91_333;
const FLOOR = 90_022;
const WINDOW_MS = 2_500;
const OVERTAKEN_AT_MS = 11_000;

// Q3 (OPEN owner question): the one middle price a short budget sends. Default = the NEXT price (R1).
// The alternative answer, "lowest middle", is R2. This is the only line that changes.
const Q3_MIDDLE = R1;

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-q3-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// Own rank null until our first bid lands, then rankAfterBid(countdown). revisionsLeft is null on
// every read (SP publishes none); the cap is the published limit.
function spAdapter({ closesAt, cap, rankAfterBid }) {
  let revs = cap;
  let landed = 0;
  const writes = [];
  return {
    writes,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      const closesInMs = Math.max(0, closesAt - Date.now());
      return {
        ok: true, status: closesInMs <= 0 ? 'closed' : 'live',
        myRank: landed === 0 ? null : rankAfterBid(closesInMs), totalBidders: 6, standingL1Price: null,
        closesInMs, revisionLimit: cap, revisionsLeft: null,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 120,
      };
    },
    async placeBid(_id, price) {
      const closesInMs = closesAt - Date.now();
      if (revs <= 0) {
        writes.push({ price, closesInMs, accepted: false });
        return { accepted: false, reason: 'Bid limit exceeded' };
      }
      revs -= 1;
      landed += 1;
      writes.push({ price, closesInMs, accepted: true });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 100 };
    },
  };
}

const lateOvertake = (closesInMs) => (closesInMs > OVERTAKEN_AT_MS ? 1 : 4);
const outrankedThroughout = () => 4;

async function runAuction({ cap, rankAfterBid }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  let eng;
  try {
    const closesAt = vnow + 30_000;
    const adapter = spAdapter({ closesAt, cap, rankAfterBid });
    eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: WINDOW_MS, cadenceJitterMs: 0 },
      rand: () => 0,
    });
    const m = eng.arm(
      { id: `bg-q3-${seq}`, lane: { origin: 'Govindgarh', destination: 'X' }, equipment: '19ft', units: 1, closesAt, companyName: 'BG' },
      { cost: COST, marginsPct: MARGINS, minMarginPct: MIN_MARGIN });
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    let ticks = 0;
    while (closesAt - vnow > 0 && ticks++ < 2_000) {
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      vnow += Math.max(1, eng._cadence(m.closesInMs, m));
    }
    return { ladder: m.ladder.slice(), softStrategy: m.softStrategy, writes: adapter.writes, hotMs: eng.cfg.pollHotMs };
  } finally {
    Date.now = REAL_NOW;
    if (eng) { try { eng.kill('test done'); } catch (_) {} }
  }
}

const fmt = (writes) => '[' + writes.map((w) => `${w.price}@${w.closesInMs}ms${w.accepted ? '' : '(REFUSED)'}`).join(', ') + ']';

// First hot tick inside the window: (WINDOW - hot poll, WINDOW]. An upper bound alone would pass a fix
// that releases the kept floor seconds later.
function assertFirstWindowTick(write, hotMs, all) {
  assert.ok(write.closesInMs <= WINDOW_MS && write.closesInMs > WINDOW_MS - hotMs,
    `the floor went out at ${write.closesInMs}ms, not on the first final-window tick (${WINDOW_MS - hotMs}, ${WINDOW_MS}]ms. `
    + `Writes: ${fmt(all)}`);
}

function assertShortBudgetSequence(run) {
  const w = run.writes;
  assert.deepStrictEqual(run.ladder, [R0, R1, R2, FLOOR], 'precondition (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
  assert.strictEqual(run.softStrategy, 'off', 'precondition: non-allowlisted (deployed) path');
  assert.ok(w.length >= 1 && w[0].price === R0, `precondition: the establish 100772 did not go first: ${fmt(w)}`);
  assert.ok(w.length >= 2, `nothing was written after the establish: ${fmt(w)}`);
  assert.strictEqual(w[1].price, Q3_MIDDLE,
    `the one affordable middle revision went on ${w[1].price} at ${w[1].closesInMs}ms, not the Q3 price ${Q3_MIDDLE} - the `
    + `deployed clock walk (_scheduledRungIndex, deeper as time runs out) chose it. Writes: ${fmt(w)}`);
  assert.deepStrictEqual(w.map((x) => x.price), [R0, Q3_MIDDLE, FLOOR],
    `writes were ${fmt(w)} - the floor did not take the last revision`);
  assertFirstWindowTick(w[2], run.hotMs, w);
  assert.ok(w.every((x) => x.accepted), `a write was refused for the cap: ${fmt(w)}`);
}

let pass = 0;
const FAILURES = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push(name);
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

const EXPECTED = 3;
process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

(async () => {
  console.log(`hard close, short budget: which middle price goes out (Q3 OPEN; pinned default Q3_MIDDLE = ${Q3_MIDDLE})`);

  const late = await runAuction({ cap: 3, rankAfterBid: lateOvertake });
  check('1 late overtake, cap 3 (budget short): [100772, Q3_MIDDLE, 90022], floor on the first window tick (ruling 27 fixture)', () => {
    assertShortBudgetSequence(late);
  });

  const fits = await runAuction({ cap: 4, rankAfterBid: lateOvertake });
  const f = fits.writes;
  check('2 CONTROL late overtake, cap 4 (budget fits): the deployed clock walk is unchanged, [100772, 91333, 90022] (ruling 27 fixture)', () => {
    assert.deepStrictEqual(f.map((x) => x.price), [R0, R2, FLOOR], `writes were ${fmt(f)}`);
    assert.ok(f[1].closesInMs === OVERTAKEN_AT_MS, `the step-down moved off the first outranked tick: ${fmt(f)}`);
    assertFirstWindowTick(f[2], fits.hotMs, f);
    assert.ok(f.every((x) => x.accepted), `a write was refused: ${fmt(f)}`);
  });

  const common = await runAuction({ cap: 3, rankAfterBid: outrankedThroughout });
  check('3 common timeline, outranked after the establish, cap 3: [100772, Q3_MIDDLE, 90022], floor on the first window tick (ruling 27 fixture)', () => {
    assertShortBudgetSequence(common);
  });

  if (pass !== EXPECTED || FAILURES.length) {
    console.error(`\nFAILED ${FAILURES.length} of ${EXPECTED}: ${FAILURES.join(' | ')}`);
    process.exit(1);
  }
  console.log(`\nPASS hardclose-short-budget-middle-price: ${pass}/${EXPECTED} checks`);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
