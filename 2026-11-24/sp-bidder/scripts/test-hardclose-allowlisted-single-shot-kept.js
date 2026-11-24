'use strict';
/**
 * ALLOWLISTED HARD CLOSE KEEPS ITS SINGLE-SHOT LATCH - positive pin for ruling Q6.
 *
 * The soft-close fix lifts the single-shot latch on allowlisted SOFT close: after a non-floor final shot lands and
 * a later read says we are still outranked, the floor still goes before the close. Ruling Q6
 * (2026-09-24) keeps the latch on allowlisted HARD close (Havells hard branches, KEI) for this PR,
 * pending a week of soft-close data. So on a hard close the rank-aware final snipe is still ONE shot:
 * if it picks a middle price, lands, and we read rank 2 afterwards, nothing more is sent.
 *
 *   1. allowlisted hard, fine ladder, rank 3 into the last 2.5 s: exactly one final-window bid, a
 *      non-floor rung; rank 2 after it through the close; no further bid.
 *   2. non-allowlisted hard, same budget: the always-floor snipe places the floor once; nothing after.
 *   3. CONTROL: the case-1 fixture with that first final-window write REFUSED sends again, so the
 *      single bid in case 1 is the latch and not a harness that cannot place a second one.
 *
 * The budget is 10 bids with 7 left, so the hard-close floor reserve (step down only while two
 * revisions remain) cannot bind anywhere in these countdowns.
 *
 * Mechanism: the REAL _maybeBid is driven from 2,400 ms to the close on a virtual clock at the
 * engine's own hot cadence (200 ms), production timing knobs, `rand` stubbed, fake adapter. Offline,
 * no network, no wall-clock waits.
 *
 *   node scripts/test-hardclose-allowlisted-single-shot-kept.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const PROD = { openAtMs: 25_000, openJitterMs: 4_000, floorWindowMs: 2_500, cadenceJitterMs: 250,
  minInterFireMs: 150, maxBidsPerMin: 20, rungs: 6, rungCap: 0 };
const REVISION_LIMIT = 10;
const FLOOR_WINDOW = 2_500;
const CLOCK_EPOCH = 1_790_000_000_000;
// A plain price-class refusal: no stand-down classifier matches it, so the engine treats it as
// nothing-placed and restores the endgame latches.
const PLAIN_REJECT = 'Bid amount is not valid for this load';

const PREFIX = `t4-pins-latch-${process.pid}-`;
let seq = 0;
const tmp = () => path.join(os.tmpdir(), `${PREFIX}${seq++}.json`);
const cleanup = () => {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch (_) {}
  for (const n of names) if (n.startsWith(PREFIX)) { try { fs.unlinkSync(path.join(os.tmpdir(), n)); } catch (_) {} }
};

const ENGINES = [];
let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 3;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nallowlisted hard close keeps its single shot: ${pass}/${EXPECTED_CASES} cases passed`);
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

function mkEngine({ allowlist, rejectFirst = false }) {
  const sends = [];
  const clock = { remaining: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => {
      sends.push({ price, remaining: clock.remaining });
      if (rejectFirst && sends.length === 1) {
        return { accepted: false, ok: false, status: 400, reason: PLAIN_REJECT, text: PLAIN_REJECT, raw: PLAIN_REJECT };
      }
      return { accepted: true, status: 201, myRank: null, revisionsLeft: null };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: PROD,
    softClose: { enabled: true, shippers: allowlist, mode: 'live', reserve: 1 },
    rand: () => 0.5,
    onEvent: () => {},
  });
  eng._sends = sends;
  eng._clock = clock;
  eng._vnow = CLOCK_EPOCH;
  ENGINES.push(eng);
  return eng;
}

// A hard load already on the board at `standOn`, every rung down to it landed, 3 of 10 bids spent
// (so 7 left - well clear of any two-revision reserve).
function armStanding(eng, { companyName, standOn }) {
  const meta = { id: String(800_000 + ++seq), lane: { origin: 'Alwar', destination: 'Manimajra' }, units: 1,
    companyName, branchName: 'ALWAR', closesAt: Date.now() + 900_000,
    rules: { revisionLimit: REVISION_LIMIT, minDecrement: 100 } };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'hard';
  for (let i = 0; i <= standOn; i++) m.firedRungs.add(i);
  m.currentRungIndex = standOn;
  m.lastBidPrice = m.ladder[standOn];
  m.landedBids = 3;
  m.everBid = true;
  m.revisionsLeft = REVISION_LIMIT - 3;
  return m;
}

const spState = (m, remaining, myRank) => ({
  ok: true, status: 'live', myRank, totalBidders: 5, standingL1Price: null, closesInMs: remaining,
  revisionLimit: REVISION_LIMIT, revisionsLeft: null, minDecrement: 100, closeModel: 'hard',
  extendMs: 0, extendCount: 0, triggerWindowMs: 0, measuredRttMs: 80,
});

async function drive(eng, m, { from, to = 0, rank, maxTicks = 1_000 }) {
  const REAL_NOW = Date.now;
  Date.now = () => eng._vnow;
  const ticks = [];
  try {
    let r = from;
    while (r >= to && ticks.length < maxTicks) {
      eng._clock.remaining = r;
      const k = typeof rank === 'function' ? rank(m, r) : rank;
      ticks.push({ remaining: r, rank: k });
      await eng._maybeBid(m, spState(m, r, k));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      eng._vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
  assert.ok(ticks.length < maxTicks, 'PRECONDITION: the drive hit its tick guard - the cadence stopped advancing');
  const sends = eng._sends.map((s) => ({ rungIndex: m.ladder.indexOf(s.price), price: s.price, remaining: s.remaining }));
  return { sends, ticks };
}

const fmt = (sends) => '[' + sends.map((s) => `rung ${s.rungIndex} @ ${s.remaining}ms`).join(', ') + ']';
// Rank 3 until our final-window bid has gone out, rank 2 on every read after it.
const rank3ThenRank2 = (eng) => () => (eng._sends.length ? 2 : 3);

function assertRanThroughClose(label, first, ticks) {
  const after = ticks.filter((t) => t.remaining < first.remaining);
  assert.ok(after.length >= 10 && after[after.length - 1].remaining === 0,
    `PRECONDITION ${label}: the drive must keep offering decisions from the final bid to the close (${after.length} ticks after it)`);
  assert.ok(after.every((t) => t.rank === 2), `PRECONDITION ${label}: every read after the final bid must be rank 2`);
}

(async () => {
  console.log('allowlisted hard close keeps its single shot');

  await runAsync('1 allowlisted-hard-latch: one non-floor final shot, rank 2 after it, no further bid', async () => {
    const eng = mkEngine({ allowlist: ['Havells'] });
    const m = armStanding(eng, { companyName: 'Havells India', standOn: 2 });
    const last = m.ladder.length - 1;
    assert.strictEqual(m.softStrategy, 'live', 'PRECONDITION: the shipper must be allowlisted (rank-driven)');
    assert.ok(m.ladder.length >= 6, `PRECONDITION: a fine ladder (>= 6 prices) is needed for the rank-aware snipe; armed ${m.ladder.length}`);
    const { sends, ticks } = await drive(eng, m, { from: 2_400, rank: rank3ThenRank2(eng) });
    assert.ok(sends.length >= 1, 'PRECONDITION: the rank-aware final snipe must fire at rank 3 in the last 2.5 s');
    const shot = sends[0];
    assert.ok(shot.remaining <= FLOOR_WINDOW, `PRECONDITION: the final shot went at ${shot.remaining}ms, outside the final window`);
    assert.ok(shot.rungIndex > 2 && shot.rungIndex < last,
      `PRECONDITION: the final shot must be a middle price below where we stood; it was rung ${shot.rungIndex} of 0-${last}`);
    assertRanThroughClose('case 1', shot, ticks);
    assert.strictEqual(sends.length, 1,
      `allowlisted HARD close sent ${sends.length} bids in the final window ${fmt(sends)} after landing a middle price `
      + 'and reading rank 2 - ruling Q6: the single-shot latch on allowlisted hard close is NOT lifted in this PR, '
      + 'only soft close gets the floor after a landed non-floor shot');
    assert.strictEqual(m.revisionsLeft, REVISION_LIMIT - 4, 'the one shot must have spent exactly one revision');
  });

  await runAsync('2 nonallowlisted-hard-floor-once: the always-floor snipe places the floor once, nothing after', async () => {
    const eng = mkEngine({ allowlist: ['SomeoneElse'] });
    const m = armStanding(eng, { companyName: 'Havells India', standOn: 1 });
    const last = m.ladder.length - 1;
    assert.strictEqual(m.softStrategy, 'off', 'PRECONDITION: the shipper must not be allowlisted');
    const { sends, ticks } = await drive(eng, m, { from: 2_400, rank: rank3ThenRank2(eng) });
    assert.ok(sends.length >= 1, 'PRECONDITION: the deployed snipe must fire at rank 3 in the last 2.5 s');
    assertRanThroughClose('case 2', sends[0], ticks);
    assert.strictEqual(sends[0].rungIndex, last,
      `the non-allowlisted hard snipe sent rung ${sends[0].rungIndex}, not the floor rung ${last} - the deployed always-floor snipe moved`);
    assert.strictEqual(sends[0].remaining, 2_400, 'the floor must go on the first final-window tick (2,400 ms)');
    assert.strictEqual(sends.length, 1,
      `the non-allowlisted hard load sent ${sends.length} bids ${fmt(sends)} - the floor goes once and the load then holds to the close`);
  });

  await runAsync('3 CONTROL: the case-1 shot refused -> the harness sees the engine bid again', async () => {
    const eng = mkEngine({ allowlist: ['Havells'], rejectFirst: true });
    const m = armStanding(eng, { companyName: 'Havells India', standOn: 2 });
    const { sends } = await drive(eng, m, { from: 2_400, rank: 3 });
    assert.ok(sends.length >= 2,
      `CONTROL: with the first final-window write refused, only ${fmt(sends)} went out - the harness cannot see a `
      + 'second bid, so the single bid in case 1 proves nothing about the latch');
    assert.ok(sends[0].rungIndex < m.ladder.length - 1, 'CONTROL: the refused first shot must be the same middle price case 1 lands');
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
