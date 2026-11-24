'use strict';
/**
 * PR-T5 SHORT-BUDGET SELECTOR GATES - where the Q3 middle-price selector must NOT decide.
 *
 * Regression target: PR-T5 Phase TC (TC validator G1-G3 and the critic's surviving mutants M22, M26,
 * M27, M32). The fix added `_shortBudgetMiddleRung`, which picks the middle price on a SuperProcure
 * hard close when the known budget cannot fund every unspent middle plus the floor. Four of its edges
 * could be deleted without any test noticing, and each one moves live money on a population the fix
 * must leave alone:
 *
 *   1 (M22) a middle rung the platform's minimum decrement already refused must stay excluded, or
 *     the selector keeps choosing a price that can never be sent and the next middle is never offered;
 *   2 (M26) GoComet (soft close, not allowlisted) keeps the deployed clock walk - PR-T2a owns it;
 *   3 (M27) an unknown budget behaves exactly as today (the deployed clock walk);
 *   4 (M32) the allowlisted (rank-driven) hard arm keeps its rank-driven defend.
 *
 * These are POSITIVE pins: base (11d9fb6) and fix (afef2fd) write the same sequence on each shape,
 * and each check goes red only under its named mutant. None of them is a Q3 pin - on each shape a
 * spacing refusal, the clock walk or the rank-driven defend decides the middle price, never the
 * owner's open "next vs lowest middle" answer.
 *
 * Expected prices by hand, cost 87,400 x (1 + pct/100), rounded:
 *   15.3% -> 100772, 10.8% -> 96839, 4.5% -> 91333, 3% (4th band margin) -> 90022.
 * Ruling 27: the minimum margin is a guard, never a bid, so the 4th rung is a 3% band margin.
 *
 * Offline and deterministic: fake adapter (rank null until our first bid, cap enforced when
 * published, REST rank null), real BidEngine, real DurableScheduler on a temp file, the real
 * _tick -> _maybeBid path stepped at the engine's own cadence on a virtual clock. No network, no
 * real waits, jitter pinned.
 *
 *   node scripts/test-hardclose-short-budget-selector-gates.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 87_400;
const MARGINS = [15.3, 10.8, 4.5, 3];
const LADDER_4 = [100772, 96839, 91333, 90022];

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-selgates-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// `revs` null = no published cap (unlimited on the platform side too). `rank(ourLanded, remainingMs)`.
function account({ closesAt, closeModel, revs, revisionLimit, rank, minDecrement }) {
  let ours = 0;
  return {
    writes: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      const closesInMs = Math.max(0, closesAt - Date.now());
      return {
        ok: true, status: 'live', myRank: ours > 0 ? rank(ours, closesInMs) : null, totalBidders: 6, standingL1Price: null,
        closesInMs, closesAtMs: closesAt, revisionLimit, revisionsLeft: null,
        minDecrement, closeModel, measuredRttMs: 120,
      };
    },
    async placeBid(_id, price) {
      const closesInMs = closesAt - Date.now();
      if (revs != null && revs <= 0) {
        this.writes.push({ price, closesInMs, refused: true });
        const r = 'Bid limit exceeded';
        return { accepted: false, ok: false, status: 400, reason: r, text: r, raw: r };
      }
      if (revs != null) revs -= 1;
      ours += 1;
      this.writes.push({ price, closesInMs, refused: false });
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 100 };
    },
  };
}

async function runLoad({ closeModel = 'hard', companyName = 'Borosil', allowlisted = false, startMs = 40_000,
  revs, revisionLimit, rank, minDecrement = 100 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  const events = [];
  try {
    const closesAt = vnow + startMs;
    const adapter = account({ closesAt, closeModel, revs, revisionLimit, rank, minDecrement });
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: 2_500, softOpenAtMs: 150_000, softOpenJitterMs: 0 },
      softClose: { enabled: true, shippers: [allowlisted ? companyName : 'Havells'], mode: 'live' },
      rand: () => 0,
      onEvent: (e) => events.push(e),
    });
    ENGINES.push(eng);
    const m = eng.arm({ id: String(91_000_000 + seq), lane: { origin: 'Govindgarh', destination: 'Jaipur' }, equipment: '19ft',
      units: 1, closesAt, companyName }, { cost: COST, marginsPct: MARGINS, minMarginPct: 3 });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    let budgetAfterFirstTick;
    let lastTickMs;
    let ticks = 0;
    while (closesAt - vnow > 0 && ticks++ < 5_000) {
      lastTickMs = closesAt - vnow;
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      if (budgetAfterFirstTick === undefined) budgetAfterFirstTick = m.revisionsLeft;
      vnow += Math.max(1, eng._cadence(closesAt - vnow, m));
    }
    return { m, writes: adapter.writes, events, budgetAfterFirstTick, lastTickMs };
  } finally { Date.now = REAL_NOW; }
}

const seqOf = (writes) => writes.map((w) => `${w.price}@${w.closesInMs}${w.refused ? '(refused)' : ''}`);

function assertSetup(run, { softStrategy, closeModel, budget }) {
  assert.deepStrictEqual(run.m.ladder, LADDER_4, 'setup: the ladder must be the hand-computed Borosil 4-rung ladder (ruling 27: the 4th rung is a 3% band margin, not the minimum appended as a rung)');
  assert.strictEqual(run.m.softStrategy, softStrategy, `setup: softStrategy must be '${softStrategy}'`);
  assert.strictEqual(run.m.closeModel, closeModel, `setup: closeModel must be '${closeModel}'`);
  assert.strictEqual(run.budgetAfterFirstTick, budget, `setup: the engine must read a budget of ${budget}, read ${run.budgetAfterFirstTick}`);
  assert.ok(run.lastTickMs <= 2_500, `setup: the driver stopped at ${run.lastTickMs}ms, before the final window`);
}

let ran = 0;
let pass = 0;
const FAILURES = [];
const EXPECTED_CHECKS = 4;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nshort-budget selector gates: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nFAILED - the short-budget middle-price selector decided where it must not: ${bad.join('; ')}`);
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
  console.log('hard-close short-budget selector gates (PR-T5)');

  await check('1 hard, cap 3, outranked, live minDecrement 4000: the spacing-refused rung stays excluded, 91333 still goes (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ revs: 3, revisionLimit: 3, rank: () => 4, minDecrement: 4_000 });
    // Assert
    assertSetup(run, { softStrategy: 'off', closeModel: 'hard', budget: 3 });
    const discards = run.events.filter((e) => e.kind === 'rung_discarded_min_decrement');
    assert.deepStrictEqual(seqOf(run.writes), ['100772@25000', '91333@13000', '90022@2400'],
      'the short-budget selector re-chose a middle rung the minimum decrement had already refused, so the next middle '
      + `price was never offered; writes [${seqOf(run.writes).join(', ')}]`);
    assert.deepStrictEqual(discards.map((e) => [e.rungIndex, e.price]), [[1, LADDER_4[1]]],
      `expected exactly one rung_discarded_min_decrement, for rung 1 / ${LADDER_4[1]}`);
  });

  await check('2 GoComet shape (soft, not allowlisted), 3 attempts, L1 then overtaken at 11 s: deployed clock walk unchanged (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ closeModel: 'soft', companyName: 'Waaree', startMs: 200_000, revs: 3, revisionLimit: 3,
      rank: (_ours, r) => (r > 11_000 ? 1 : 4) });
    // Assert
    assertSetup(run, { softStrategy: 'off', closeModel: 'soft', budget: 3 });
    assert.deepStrictEqual(seqOf(run.writes), ['100772@149800', '91333@10800', '90022@2400'],
      'PR-T5 moved the GoComet population: the short-budget selector engaged on a soft-close load, which is PR-T2a\'s to '
      + `change, not PR-T5's; writes [${seqOf(run.writes).join(', ')}]`);
  });

  await check('3 hard, budget UNKNOWN, L1 then overtaken at 11 s: exactly as today (deployed clock walk) (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ revs: null, revisionLimit: null, rank: (_ours, r) => (r > 11_000 ? 1 : 4) });
    // Assert
    assertSetup(run, { softStrategy: 'off', closeModel: 'hard', budget: null });
    assert.deepStrictEqual(seqOf(run.writes), ['100772@25000', '91333@11000', '90022@2400'],
      'an unknown budget must behave exactly as today, but the short-budget selector engaged without a known budget; '
      + `writes [${seqOf(run.writes).join(', ')}]`);
  });

  await check('4 allowlisted (rank-driven) hard, cap 3, outranked at rank 4: rank-driven defend unchanged (ruling 27 fixture)', async () => {
    // Arrange / Act
    const run = await runLoad({ allowlisted: true, revs: 3, revisionLimit: 3, rank: () => 4 });
    // Assert
    assertSetup(run, { softStrategy: 'live', closeModel: 'hard', budget: 3 });
    assert.deepStrictEqual(seqOf(run.writes), ['100772@25000', '91333@24000', '90022@2400'],
      'the allowlisted hard arm must keep its rank-driven defend (rank 4 jumps rung 0 -> rung 2); the deployed '
      + `short-budget selector was consulted there instead; writes [${seqOf(run.writes).join(', ')}]`);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
