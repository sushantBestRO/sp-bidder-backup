'use strict';
/**
 * SP HARD CLOSE, LOW REVISION BUDGET - the establish must not spend the floor's revision.
 *
 * Regression target: PR-T5 (timing lane C, 2026-09-24 diagnosis of Borosil hard-close loads; pattern
 * row "establish spends a revision regardless of budget"). Live shape: Borosil 25679309 (23 Sep)
 * started with a budget of 2 on a 4-rung ladder and closed with the floor never offered.
 *
 * The mechanism: on a SuperProcure hard-close load that is NOT on the soft-close allowlist, the
 * establish bid goes out at the openAtMs mark whatever the remaining revision budget is, and the
 * step-down that follows spends revisions with no reserve. When the budget is already low at the
 * first decision (a shared-account slot a human spent, or the foreign-bid discount), the budget is
 * gone before the final window and _maybeBid's revisionsLeft <= 0 gate returns before _decide can
 * send the floor. A re-price re-arm (stop + arm) resets the monitor to "not yet established", so the
 * same establish spends the last revision on a load already on the board too (check 7: holding L1
 * with 1 revision left, re-priced at 15 s, then overtaken - base re-establishes at 95,288).
 *
 * The contract pinned here (owner ruling 2026-09-24): hard close always keeps the last revision for
 * the floor. Budget 2 -> establish, then the floor. Budget 1 -> no establish, only the floor. The
 * floor goes on the FIRST tick inside the final window (countdown <= floorWindowMs, 2,500 ms) - not
 * later. Budget known only. Check 6 pins the owner ruling "SuperProcure holds at rank 1": a budget-1
 * load whose shared account already leads sends nothing, so the floor never undercuts a bid the
 * account already leads with.
 *
 * WHAT MUST NOT MOVE:
 *   - check 0 (control, runs first, gates the rest): a full budget of 3 on the 3-rung ladder
 *     establishes at the mark, steps once, and sends the floor on the first in-window tick. It proves
 *     the driver reaches the final window; a dead driver fails it instead of faking checks 1-7.
 *   - check 5: a budget of 0 sends nothing and raises no_revisions_left once.
 *   Out of scope here, pinned elsewhere: full-budget step-down reserve, the allowlisted arm.
 *
 * Expected prices are computed by hand, cost x (1 + pct/100), rounded:
 *   cost 87,400: 15.3% -> 100772, 10.8% -> 96839, 4.5% -> 91333, 3% (4th band margin) -> 90022.
 *   cost 86,000: 15.3% -> 99158,  10.8% -> 95288, 4.5% -> 89870, 3% (4th band margin) -> 88580.
 * Ruling 27: the minimum margin is a guard, never a bid, so the 4-rung ladder carries 3% as a band margin.
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on a temp file,
 * the real _tick -> _maybeBid path stepped at the engine's own cadence on a virtual clock. No
 * network, no real waits, jitter pinned.
 *
 *   node scripts/test-hardclose-low-budget.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 87_400;
const REPRICED_COST = 86_000;
const MARGINS = [15.3, 10.8, 4.5];
const MARGINS_4 = [15.3, 10.8, 4.5, 3];
const LADDER_4 = [100772, 96839, 91333, 90022];
const LADDER_3 = [100772, 96839, 91333];
const REPRICED_LADDER_4 = [99158, 95288, 89870, 88580];
const OPEN_AT_MS = 25_000;
const FLOOR_WINDOW_MS = 2_500;
const START_MS = 40_000;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-lowbudget-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// A SuperProcure-shaped shared account. `revs` is the platform's own remaining count; our rank is
// `standingRank` (null, or a desk bid already on the account) until one of our bids lands, then
// `rankAfterOurBid` - a number, or (landedCount, remainingMs) => rank.
function spAccount({ revs, revisionLimit, reportRevisionsLeft = true, standingRank = null, rankAfterOurBid = 4, closesAt }) {
  let ours = 0;
  return {
    writes: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return {
        ok: true, status: 'live',
        myRank: ours > 0 ? (typeof rankAfterOurBid === 'function' ? rankAfterOurBid(ours, closesAt - Date.now()) : rankAfterOurBid)
          : standingRank,
        totalBidders: 6, standingL1Price: null,
        closesInMs: Math.max(0, closesAt - Date.now()), closesAtMs: closesAt,
        revisionLimit, revisionsLeft: reportRevisionsLeft ? revs : null,
        minDecrement: 100, closeModel: 'hard', measuredRttMs: 120,
      };
    },
    async placeBid(_id, price) {
      const closesInMs = closesAt - Date.now();
      if (revs <= 0) {
        this.writes.push({ price, closesInMs, refused: true });
        const r = 'Bid limit exceeded';
        return { accepted: false, ok: false, status: 400, reason: r, text: r, raw: r };
      }
      revs -= 1;
      ours += 1;
      this.writes.push({ price, closesInMs, refused: false });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 100 };
    },
  };
}

// Arms a non-allowlisted Borosil hard-close load and drives the REAL _tick (state read, revision
// intake, foreign-bid discount, then _maybeBid) at the engine's own cadence on a virtual clock.
// `reprice` = { atMs, cost }: after the first tick at or under atMs, stop + arm at the new cost, as
// the desk's re-price does.
async function runLoad({ marginsPct = MARGINS, minMarginPct = 3, reprice = null, ...acct }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  const events = [];
  try {
    const closesAt = vnow + START_MS;
    const adapter = spAccount({ ...acct, closesAt });
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: OPEN_AT_MS, openJitterMs: 0, floorWindowMs: FLOOR_WINDOW_MS },
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live' },
      rand: () => 0,
      onEvent: (e) => events.push(e),
    });
    ENGINES.push(eng);
    const meta = { id: String(90_000_000 + seq), lane: { origin: 'Govindgarh', destination: 'Jaipur' }, equipment: '19ft',
      units: 1, closesAt, companyName: 'Borosil' };
    let m = eng.arm(meta, { cost: COST, marginsPct, minMarginPct });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    const tickedAt = [];
    let budgetAfterFirstTick;
    let rearm = null;
    while (closesAt - vnow > 0 && tickedAt.length < 5_000) {
      tickedAt.push(closesAt - vnow);
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      if (budgetAfterFirstTick === undefined) budgetAfterFirstTick = m.revisionsLeft;
      if (reprice && !rearm && closesAt - vnow <= reprice.atMs) {
        const writesBefore = adapter.writes.slice();
        eng.stop(meta.id);
        m = eng.arm(meta, { cost: reprice.cost, marginsPct, minMarginPct });
        if (m.timer) { clearTimeout(m.timer); m.timer = null; }
        rearm = { writesBefore, ladder: m.ladder.slice(), revisionsLeft: m.revisionsLeft };
      }
      vnow += Math.max(1, eng._cadence(closesAt - vnow, m));
    }
    return {
      m, writes: adapter.writes, events, budgetAfterFirstTick, rearm,
      firstInWindowMs: tickedAt.find((r) => r <= FLOOR_WINDOW_MS),
      lastTickMs: tickedAt[tickedAt.length - 1],
    };
  } finally { Date.now = REAL_NOW; }
}

const fmt = (writes) => '[' + writes.map((w) => `${w.price}@${w.closesInMs}ms${w.refused ? '(refused)' : ''}`).join(', ') + ']';

function assertEstablishAtMark(writes) {
  const w = writes[0];
  assert.ok(w.price === LADDER_4[0], `the establish must be the opening rung ${LADDER_4[0]}, got ${w.price}; writes ${fmt(writes)}`);
  assert.ok(w.closesInMs <= OPEN_AT_MS && w.closesInMs > OPEN_AT_MS - 1_000,
    `the establish went out at ${w.closesInMs}ms, not at the ${OPEN_AT_MS}ms mark; writes ${fmt(writes)}`);
}

// Exact, not an upper bound: the floor goes on the first tick at or under floorWindowMs.
function assertFloorOnFirstWindowTick(run, floor) {
  const { writes, firstInWindowMs } = run;
  const w = writes[writes.length - 1];
  assert.ok(w.price === floor, `the last write must be the floor ${floor}, got ${w.price}; writes ${fmt(writes)}`);
  assert.ok(firstInWindowMs != null, 'setup: the driver never ticked inside the final window');
  assert.ok(w.closesInMs === firstInWindowMs,
    `the floor went out at ${w.closesInMs}ms, not on the first in-window tick (${firstInWindowMs}ms <= ${FLOOR_WINDOW_MS}ms); `
    + `writes ${fmt(writes)}`);
}

function assertDriverReachedWindow(run) {
  assert.ok(run.lastTickMs <= FLOOR_WINDOW_MS,
    `setup: the driver stopped at ${run.lastTickMs}ms, before the ${FLOOR_WINDOW_MS}ms window - a zero-write outcome proves nothing`);
}

let ran = 0;
let pass = 0;
let gated = false;
const FAILURES = [];
const EXPECTED_CHECKS = 8;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (gated) {
    console.error('\nCONTROL FAILED (check 0): the driver never reached the final window, OR the change moved the '
      + 'full-budget 3-rung sequence. Checks 1-7 were NOT run - this is not a pass and not a mechanism result.');
    for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
    process.exitCode = 1;
    return;
  }
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nhard-close low budget: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nFAILED - hard close spent the floor's revision on a low budget: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); return true; } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
    return false;
  }
}

(async () => {
  console.log('hard-close low revision budget (PR-T5)');

  const controlOk = await check('0 CONTROL full budget 3, 3-rung, outranked: establish, one step, floor on the first in-window tick', async () => {
    // Arrange / Act
    const run = await runLoad({ revs: 3, revisionLimit: 3, minMarginPct: 4.5 });
    // Assert
    assert.strictEqual(run.m.softStrategy, 'off', 'setup: the load must be on the deployed (non-allowlisted) path');
    assert.strictEqual(run.m.closeModel, 'hard', 'setup: the load must be hard close');
    assert.deepStrictEqual(run.m.ladder, LADDER_3, 'setup: the ladder must be the hand-computed 3-rung ladder');
    assert.deepStrictEqual(run.writes.map((w) => w.price), LADDER_3,
      `a full budget must send all three rungs in order; writes ${fmt(run.writes)}`);
    assertEstablishAtMark(run.writes);
    assertFloorOnFirstWindowTick(run, LADDER_3[2]);
  });
  if (!controlOk) { gated = true; return; }

  await check('1 budget 2, 4-rung, outranked: establish at the mark, then the floor 90022 on the first in-window tick (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ marginsPct: MARGINS_4, revs: 2, revisionLimit: 3 });
    // Assert
    assert.deepStrictEqual(run.m.ladder, LADDER_4, 'setup: ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.strictEqual(run.budgetAfterFirstTick, 2, `setup: the engine must read a budget of 2, read ${run.budgetAfterFirstTick}`);
    assert.strictEqual(run.writes.length, 2, `expected exactly 2 writes (establish, floor), got ${fmt(run.writes)}`);
    assertEstablishAtMark(run.writes);
    assertFloorOnFirstWindowTick(run, LADDER_4[3]);
  });

  await check('2 budget 2, 3-rung (Durian shape, one slot pre-spent): establish, then the floor 91333 on the first in-window tick', async () => {
    // Arrange / Act
    const run = await runLoad({ revs: 2, revisionLimit: 3, minMarginPct: 4.5 });
    // Assert
    assert.deepStrictEqual(run.m.ladder, LADDER_3, 'setup: ladder');
    assert.strictEqual(run.budgetAfterFirstTick, 2, `setup: the engine must read a budget of 2, read ${run.budgetAfterFirstTick}`);
    assert.strictEqual(run.writes.length, 2, `expected exactly 2 writes (establish, floor), got ${fmt(run.writes)}`);
    assertEstablishAtMark(run.writes);
    assertFloorOnFirstWindowTick(run, LADDER_3[2]);
  });

  await check('3 budget 1, 4-rung, outranked: no establish, only the floor 90022 on the first in-window tick (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ marginsPct: MARGINS_4, revs: 1, revisionLimit: 3, rankAfterOurBid: 2 });
    // Assert
    assert.deepStrictEqual(run.m.ladder, LADDER_4, 'setup: ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.strictEqual(run.budgetAfterFirstTick, 1, `setup: the engine must read a budget of 1, read ${run.budgetAfterFirstTick}`);
    assert.strictEqual(run.writes.length, 1, `expected exactly 1 write (the floor), got ${fmt(run.writes)}`);
    assertFloorOnFirstWindowTick(run, LADDER_4[3]);
  });

  await check('4 budget 1 via the LOW_CAP shared-account discount (cap 2 published, desk rank 3 standing): only the floor (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ marginsPct: MARGINS_4, revs: 1, revisionLimit: 2, reportRevisionsLeft: false, standingRank: 3, rankAfterOurBid: 4 });
    // Assert
    assert.deepStrictEqual(run.m.ladder, LADDER_4, 'setup: ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.ok(run.events.some((e) => e.kind === 'foreign_bids_detected'), 'setup: the foreign-bid detection did not fire');
    assert.strictEqual(run.budgetAfterFirstTick, 1,
      `setup: the discount must take the published cap 2 to a budget of 1, read ${run.budgetAfterFirstTick}`);
    assert.strictEqual(run.writes.length, 1, `expected exactly 1 write (the floor), got ${fmt(run.writes)}`);
    assertFloorOnFirstWindowTick(run, LADDER_4[3]);
  });

  await check('5 budget 0: nothing is sent and no_revisions_left fires once (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ marginsPct: MARGINS_4, revs: 0, revisionLimit: 3 });
    // Assert
    assertDriverReachedWindow(run);
    assert.strictEqual(run.writes.length, 0, `a budget of 0 must send nothing, got ${fmt(run.writes)}`);
    const alerts = run.events.filter((e) => e.kind === 'no_revisions_left');
    assert.strictEqual(alerts.length, 1, `no_revisions_left must fire exactly once, fired ${alerts.length} times`);
  });

  await check('6 budget 1 via the LOW_CAP discount, shared account leads at rank 1 throughout: zero writes (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ marginsPct: MARGINS_4, revs: 1, revisionLimit: 2, reportRevisionsLeft: false, standingRank: 1, rankAfterOurBid: 1 });
    // Assert
    assert.deepStrictEqual(run.m.ladder, LADDER_4, 'setup: ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.ok(run.events.some((e) => e.kind === 'foreign_bids_detected'), 'setup: the foreign-bid detection did not fire');
    assert.strictEqual(run.budgetAfterFirstTick, 1,
      `setup: the discount must take the published cap 2 to a budget of 1, read ${run.budgetAfterFirstTick}`);
    assertDriverReachedWindow(run);
    assert.strictEqual(run.writes.length, 0,
      'SuperProcure holds at rank 1: no establish and no buzzer floor may go out while the account already leads - '
      + `the floor must never undercut a bid the account already leads with; got ${fmt(run.writes)}`);
  });

  await check('7 re-price re-arm with 1 revision left (4-rung / cap 3): no re-establish, only the new floor 88580 (ruling 27 fixture)', async () => {
    // Arrange: outranked after the establish, L1 after the step (so the walk stops with 1 revision on
    // base and fix alike), the desk re-prices at 15 s, and a rival takes L1 from the next read on.
    const rank = (ours, remainingMs) => (ours >= 2 && remainingMs >= 15_000 ? 1 : 4);
    // Act
    const run = await runLoad({ marginsPct: MARGINS_4, revs: 3, revisionLimit: 3, reportRevisionsLeft: false, rankAfterOurBid: rank,
      reprice: { atMs: 15_000, cost: REPRICED_COST } });
    // Assert
    assert.ok(run.rearm, 'setup: the re-price never happened');
    // Which middle price goes at 24,000 is the owner's open Q3 answer, so only its band is pinned here.
    const before = run.rearm.writesBefore;
    assert.ok(before.length === 2 && before[0].price === LADDER_4[0] && before[0].closesInMs === 25_000
      && before[1].closesInMs === 24_000 && before[1].price < LADDER_4[0] && before[1].price > LADDER_4[3],
    `setup: before the re-price the load must have sent 100772@25000 and one middle price at 24000; writes ${fmt(before)}`);
    assert.deepStrictEqual(run.rearm.ladder, REPRICED_LADDER_4, 'setup: the re-armed ladder must be the hand-computed 86,000 ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
    assert.strictEqual(run.rearm.revisionsLeft, 1, `setup: the re-armed monitor must carry 1 revision, carried ${run.rearm.revisionsLeft}`);
    const accepted = run.writes.filter((w) => !w.refused);
    const spent = run.writes.filter((w) => REPRICED_LADDER_4.slice(0, 3).includes(w.price));
    assert.strictEqual(spent.length, 0,
      `the re-armed monitor re-established with its last revision instead of keeping it for the floor; writes ${fmt(run.writes)}`);
    assert.strictEqual(accepted.length, 3, `expected exactly 3 accepted writes in total, got ${fmt(run.writes)}`);
    assertFloorOnFirstWindowTick({ ...run, writes: accepted }, REPRICED_LADDER_4[3]);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
