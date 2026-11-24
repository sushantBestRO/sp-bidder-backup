'use strict';
/**
 * T5 R1-F01 - SuperProcure hard close, the foreign-slot reserve on a cap ABOVE the low-cap threshold.
 *
 * Regression target: on SuperProcure the platform never reports a live remaining revision count
 * (revisionsLeft is null); the engine seeds its own belief from the static per-load cap and counts
 * down locally. _detectForeignBids proves a standing rank on the shared account BEFORE this bot's
 * first bid means a human already spent one slot - but it only takes that slot off the local belief
 * when the cap is at or below LOW_CAP_THRESHOLD (3). Above the threshold it leaves the belief at the
 * full cap "budget left at the static cap" - so the hard-close reserve (_hardCloseLastRevision,
 * _shortBudgetMiddleRung) spends the local count down to what it thinks is the last revision and
 * fires the floor as the account's real revision ONE PAST the true remaining budget. SuperProcure
 * refuses it ("Bid limit exceeded") and the load's decisive floor bid never lands.
 *
 * The mechanism: cap 5 (above LOW_CAP_THRESHOLD), a 5-rung ladder, one hand bid landed on the shared
 * account before the monitor's first tick (true remaining = 4, not 5). The fix reads a
 * foreignSlotUncounted flag off _detectForeignBids' not-discounted branch (hard close only, cap
 * known and above the threshold, and the budget genuinely the engine's own local count - not a live
 * platform read that already reflects the desk bid) and has _hardCloseLastRevision /
 * _shortBudgetMiddleRung read one less than the raw local count wherever they decide whether the
 * reserve is exhausted.
 *
 * WHAT MUST NOT MOVE:
 *   - check 0 (control, runs first, gates the rest): the SAME cap-5, 5-rung ladder with no foreign
 *     bid on the account sends all five prices (establish, three middles, floor) untouched, and the
 *     floor lands. It proves the driver reaches the final window and that an undetected load is
 *     byte-identical to today.
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on a temp file, the
 * real _tick -> _maybeBid path stepped at the engine's own cadence on a virtual clock. No network, no
 * real waits, jitter pinned, no RNG on the asserted path.
 *
 *   node scripts/test-hardclose-foreign-slot-reserve.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const COST = 200_000;
const MARGINS = [15, 11, 8, 5, 3];
const LADDER = [230_000, 222_000, 216_000, 210_000, 206_000];
const OPEN_AT_MS = 25_000;
const FLOOR_WINDOW_MS = 2_500;
const START_MS = 40_000;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-foreign-slot-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// A SuperProcure-shaped shared account, revisionLimit above LOW_CAP_THRESHOLD. `revs` is the
// PLATFORM's own true remaining count (what actually gates acceptance); `standingRank` is a desk
// bid already on the account until one of OUR bids lands, after which `rankAfterOurBid` applies.
// revisionsLeft is never reported live (SuperProcure reality) - the engine seeds and counts locally.
function spAccount({ revs, revisionLimit, standingRank = null, rankAfterOurBid = 4, closesAt }) {
  let ours = 0;
  return {
    writes: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return {
        ok: true, status: 'live',
        myRank: ours > 0 ? rankAfterOurBid : standingRank,
        totalBidders: 6, standingL1Price: null,
        closesInMs: Math.max(0, closesAt - Date.now()), closesAtMs: closesAt,
        revisionLimit, revisionsLeft: null,
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

// Arms a non-allowlisted hard-close load and drives the REAL _tick (state read, revision intake,
// foreign-bid detection, then _maybeBid) at the engine's own cadence on a virtual clock.
async function runLoad(acct) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  const events = [];
  try {
    const closesAt = vnow + START_MS;
    const adapter = spAccount({ ...acct, closesAt });
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: OPEN_AT_MS, openJitterMs: 0, floorWindowMs: FLOOR_WINDOW_MS },
      softClose: { enabled: true, shippers: [] },
      rand: () => 0,
      onEvent: (e) => events.push(e),
    });
    ENGINES.push(eng);
    const meta = { id: String(91_000_000 + seq), lane: { origin: 'Neemrana', destination: 'Chennai' }, equipment: '32ft',
      units: 1, closesAt, companyName: 'Ashirvad' };
    let m = eng.arm(meta, { cost: COST, marginsPct: MARGINS, minMarginPct: 3 });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    const tickedAt = [];
    let budgetAfterFirstTick;
    while (closesAt - vnow > 0 && tickedAt.length < 5_000) {
      tickedAt.push(closesAt - vnow);
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
      if (budgetAfterFirstTick === undefined) budgetAfterFirstTick = m.revisionsLeft;
      vnow += Math.max(1, eng._cadence(closesAt - vnow, m));
    }
    return { m, writes: adapter.writes, events, budgetAfterFirstTick, lastTickMs: tickedAt[tickedAt.length - 1] };
  } finally { Date.now = REAL_NOW; }
}

const fmt = (writes) => '[' + writes.map((w) => `${w.price}@${w.closesInMs}ms${w.refused ? '(refused)' : ''}`).join(', ') + ']';

function assertDriverReachedWindow(run) {
  assert.ok(run.lastTickMs <= FLOOR_WINDOW_MS,
    `setup: the driver stopped at ${run.lastTickMs}ms, before the ${FLOOR_WINDOW_MS}ms window - a zero-write outcome proves nothing`);
}

let ran = 0;
let pass = 0;
let gated = false;
const FAILURES = [];
const EXPECTED_CHECKS = 2;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (gated) {
    console.error('\nCONTROL FAILED (check 0): the driver never reached the final window, OR the undetected cap-5 '
      + 'sequence moved. Check 1 was NOT run - this is not a pass and not a mechanism result.');
    for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
    process.exitCode = 1;
    return;
  }
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nhard-close foreign-slot reserve: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nFAILED - the hard-close reserve did not discount a detected foreign slot above the low-cap threshold: ${bad.join('; ')}`);
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
  console.log('hard-close foreign-slot reserve (T5 R1-F01)');

  const controlOk = await check('0 CONTROL cap 5, 5-rung, no foreign bid: all five prices land, floor included', async () => {
    // Arrange / Act - full true budget of 5, no standing rank before our first bid.
    const run = await runLoad({ revs: 5, revisionLimit: 5, standingRank: null });
    // Assert
    assert.deepStrictEqual(run.m.ladder, LADDER, 'setup: the ladder must be the hand-computed 5-rung ladder');
    assert.ok(!run.events.some((e) => e.kind === 'foreign_bids_detected'), 'setup: no foreign bid must be detected on an undetected account');
    assertDriverReachedWindow(run);
    const refused = run.writes.filter((w) => w.refused);
    assert.strictEqual(refused.length, 0, `an undetected full-budget load must refuse nothing; writes ${fmt(run.writes)}`);
    assert.deepStrictEqual(run.writes.map((w) => w.price), LADDER,
      `an undetected full-budget load must send all five prices in order; writes ${fmt(run.writes)}`);
  });
  if (!controlOk) { gated = true; return; }

  await check('1 cap 5, 5-rung, one hand bid on the shared account before our first tick (true remaining 4): the floor lands, not refused', async () => {
    // Arrange / Act - the published cap is 5, but the account's TRUE remaining is 4 (one hand bid
    // already spent it). standingRank makes _detectForeignBids fire on the very first tick.
    const run = await runLoad({ revs: 4, revisionLimit: 5, standingRank: 3, rankAfterOurBid: 4 });
    // Assert - setup
    const detected = run.events.filter((e) => e.kind === 'foreign_bids_detected');
    assert.strictEqual(detected.length, 1, `setup: foreign_bids_detected must fire exactly once, fired ${detected.length}`);
    assert.strictEqual(run.budgetAfterFirstTick, 5,
      `setup: on a cap above LOW_CAP_THRESHOLD the raw local count is seeded at the static cap unchanged, read ${run.budgetAfterFirstTick}`);
    assertDriverReachedWindow(run);
    // Assert - the mechanism itself
    const refused = run.writes.filter((w) => w.refused);
    assert.strictEqual(refused.length, 0,
      `the floor must never be attempted as the account's real 6th revision against a true remaining of 4; writes ${fmt(run.writes)}`);
    const accepted = run.writes.filter((w) => !w.refused).map((w) => w.price);
    assert.deepStrictEqual(accepted, [LADDER[0], LADDER[1], LADDER[2], LADDER[4]],
      `the reserve must hold back one middle price (${LADDER[3]}) to keep the floor reachable inside the true budget of 4; writes ${fmt(run.writes)}`);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
