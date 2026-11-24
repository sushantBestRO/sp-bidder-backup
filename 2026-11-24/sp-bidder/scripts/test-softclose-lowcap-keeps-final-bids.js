'use strict';
/**
 * SOFT-CLOSE LOW-CAP BRANCH KEEPS BIDS FOR THE FINAL ROUND - regression for rulings F3 + Q5/Q3.
 *
 * Regression target: on a 3-bid SuperProcure soft branch with one extension (Dynamic Cables:
 * trigger 100 s, extension 300 s, cap 1; Vishal Pipes: extension 120 s, same caps) the bot spent all
 * three bids in round 0 - the establish, an in-window defend (the reserve-1 gate in the soft defend
 * branch lets it through with two revisions left), and the floor at round 0's buzzer
 * (_lastResortFloor releases it before the cap). Dynamic Cables 4 of 4 loads. When the auction ran on
 * into its final round there was nothing left to bid.
 *
 * Rulings (2026-09-24): keep bids for the final round. On a branch whose bid cap is <= 3 with at
 * least one extension there is no in-window defend before the cap (reserve 2, derived from the
 * branch). At a pre-cap buzzer while outranked send the next middle price, never the floor. In the
 * final round the last bid is the floor at <= 2,500 ms and is not spent earlier in that round.
 *
 * One continuous drive per scenario through the real _tick -> _observeExtension -> _maybeBid path at
 * production cadence on a virtual clock (rand stubbed), a fake adapter that accepts every bid, rank 3
 * once our establish has landed. At round 0's close the published close moves forward by one
 * extension increment; the engine counts it itself.
 *
 * What must NOT move (in-file controls): rank 1 at a pre-cap buzzer still holds, and a 10-bid branch
 * still places its one in-window defend - the reserve comes from the branch, it is not raised for
 * everyone.
 *
 *   node scripts/test-softclose-lowcap-keeps-final-bids.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const TRIGGER_MS = 100_000;
const FLOOR_WINDOW_MS = 2_500;
const DYNAMIC_EXTEND_MS = 300_000;
const VISHAL_EXTEND_MS = 120_000;
const START_MS = 400_000;
// A bid lands in the window with 1 s left on round 0, so the platform moves the close by one increment.
const EXTEND_AT_MS = 1_000;
// named re-pin: round tracker piece C, rulings 40 and 56 - round 0's pre-cap shot goes in its last 6 s
// (the probe lead), and the frame showing the extension that shot causes arrives about 1.2 s after it.
const PROBE_LEAD_MS = 6_000;
const FRAME_AFTER_SHOT_MS = 1_200;

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `sc-lowcap-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 8;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close low-cap keeps final bids: ${pass}/${EXPECTED_CASES} cases passed`);
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

async function driveLoad({ companyName, extendMs, revisionLimit = 3, extendCount = 1, rankAt }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let closeAt = vnow + START_MS;
    let extended = false;
    let landed = 0;
    let shotAt = null;
    let m = null;
    const bids = [];
    const ticks = [];
    const remainingNow = () => closeAt - vnow;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => {
        if (!extended && (remainingNow() <= EXTEND_AT_MS || (shotAt != null && vnow - shotAt >= FRAME_AFTER_SHOT_MS))) {
          closeAt += extendMs; extended = true;
        }
        const round = extended ? 1 : 0;
        const remaining = remainingNow();
        return { ok: true, status: 'live',
          myRank: rankAt({ landed, round, remaining }), totalBidders: 5, standingL1Price: null,
          closesInMs: remaining, closesAtMs: closeAt, revisionLimit, revisionsLeft: null, minDecrement: 100,
          closeModel: 'soft', extendMs, extendCount, triggerWindowMs: TRIGGER_MS, measuredRttMs: 80 };
      },
      placeBid: async (_id, price) => {
        bids.push({ price, rung: m.ladder.indexOf(price), remaining: remainingNow(), round: extended ? 1 : 0 });
        if (!extended && shotAt == null && remainingNow() <= PROBE_LEAD_MS) shotAt = vnow;
        landed++;
        return { accepted: true, status: 201, myRank: null, revisionsLeft: null };
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      softClose: { enabled: true, shippers: ['Dynamic Cables', 'Vishal Pipes'], mode: 'live', reserve: 1 },
      rand: () => 0.5,
      onEvent: () => {},
    });
    ENGINES.push(eng);
    let nextDelay = null;
    eng._schedule = (_mon, d) => { nextDelay = d; };
    m = eng.arm({ id: `LC-${seq++}`, lane: { origin: 'Vadodara', destination: 'Pune' }, units: 1, quoteType: 'FTL',
      companyName, closesAt: closeAt, rules: { revisionLimit, minDecrement: 100 } },
    { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    let guard = 0;
    while (guard++ < 5_000) {
      nextDelay = null;
      await eng._tick(m);
      ticks.push({ remaining: m.closesInMs, round: extended ? 1 : 0 });
      if (m.finalized) break;
      if (nextDelay == null) throw new Error('PRECONDITION: _tick did not reschedule the monitor - dead harness');
      vnow += Math.max(1, nextDelay);
      if (extended && remainingNow() <= 0) break;
    }
    return { eng, m, bids, ticks, extended };
  } finally { Date.now = REAL_NOW; }
}

const outrankedAfterEstablish = ({ landed }) => (landed > 0 ? 3 : null);

function describe(bids) {
  return '[' + bids.map((b) => `r${b.rung}@${b.remaining}ms/round${b.round}`).join(', ') + ']';
}

function need(d) {
  if (d.error) throw new Error('PRECONDITION: the drive threw - ' + d.error);
  const { m, bids, ticks } = d;
  assert.strictEqual(m.softStrategy, 'live', 'PRECONDITION: fixture must be an allowlisted live soft load');
  assert.strictEqual(m.closeModel, 'soft', 'PRECONDITION: the load must read soft from the state');
  assert.strictEqual(m.extendCap, 1, 'PRECONDITION: the engine must have surfaced the branch extension cap of 1');
  assert.ok(d.extended, 'PRECONDITION: the scripted extension at round 0\'s close never happened');
  assert.strictEqual(m.extendsObserved, 1,
    `PRECONDITION: the engine's own _observeExtension must count exactly one round (got ${m.extendsObserved})`);
  assert.ok(ticks.some((t) => t.round === 0 && t.remaining <= PROBE_LEAD_MS && t.remaining > EXTEND_AT_MS),
    'PRECONDITION: the drive never ticked inside round 0\'s last 6,000 ms');
  assert.ok(ticks.some((t) => t.round === 1 && t.remaining > 0 && t.remaining <= FLOOR_WINDOW_MS),
    'PRECONDITION: the drive never ticked inside the final round\'s last 2,500 ms');
  assert.ok(bids.length >= 1 && bids[0].rung === 0 && bids[0].round === 0 && bids[0].remaining > TRIGGER_MS,
    `PRECONDITION: the establish (r0, round 0, before the trigger window) must be the first bid - got ${describe(bids)}`);
}

// Behaviours 2-5 as one list of violations, so the Vishal variant can report them together.
function lowCapViolations(d) {
  const { m, bids } = d;
  const last = m.ladder.length - 1;
  const r0 = bids.filter((b) => b.round === 0);
  const fin = bids.filter((b) => b.round === 1);
  const out = {};
  const inWindow = r0.filter((b) => b.remaining > PROBE_LEAD_MS && b.remaining <= TRIGGER_MS);
  if (inWindow.length) {
    out.noInWindowDefend = `in-window defend before the cap: ${describe(inWindow)} - ruling F3: on a bid cap <= 3 `
      + 'branch with an extension there is no in-window defend before the cap (reserve 2), the bid is kept for the final round';
  }
  const buzzer = r0.filter((b) => b.remaining <= PROBE_LEAD_MS && b.remaining > FLOOR_WINDOW_MS);
  if (buzzer.length !== 1 || buzzer[0].rung !== 1) {
    out.precapBuzzerMiddle = `round 0 buzzer sent ${describe(buzzer)} (floor is r${last}) - ruling Q5/Q3: outranked at a `
      + 'pre-cap buzzer send the next middle price (r1) once, keep the floor for the final round';
  }
  const leftForFinal = 3 - r0.length;
  const early = fin.filter((b) => b.remaining > FLOOR_WINDOW_MS);
  if (leftForFinal < 1 || early.length) {
    out.finalHoldsLastBid = `entered the final round with ${leftForFinal} of 3 bids left (round 0: ${describe(r0)}), `
      + `final-round bids above 2,500 ms: ${describe(early)} - ruling F3: keep the last bid for the final round and do `
      + 'not spend it before the last 2,500 ms';
  }
  const finalFloor = fin.filter((b) => b.rung === last && b.remaining <= FLOOR_WINDOW_MS);
  if (finalFloor.length !== 1 || bids.length !== 3) {
    out.finalRoundFloor = `final-round floor bids at <= 2,500 ms: ${describe(finalFloor)}, all bids ${describe(bids)} `
      + '(want exactly 3) - ruling F3: the last bid is the floor at <= 2,500 ms of the final round';
  }
  return out;
}

async function drive(opts) {
  try { return await driveLoad(opts); } catch (e) { return { error: (e && e.stack) || String(e) }; }
}

(async () => {
  console.log('soft-close low-cap branch keeps bids for the final round');

  const dc = await drive({ companyName: 'Dynamic Cables Ltd', extendMs: DYNAMIC_EXTEND_MS, rankAt: outrankedAfterEstablish });

  await runAsync('1 establish-lands (setup sanity, green on base): r0 placed before the trigger window', async () => {
    need(dc);
  });

  await runAsync('2 no-inwindow-defend-precap: no round-0 bid with remaining in (6,000, 100,000] ms', async () => {
    need(dc);
    const v = lowCapViolations(dc);
    assert.ok(!v.noInWindowDefend, v.noInWindowDefend);
  });

  await runAsync('3 precap-buzzer-middle: exactly one bid in round 0\'s last 6,000 ms, before its 2,500 ms buzzer, and it is r1 not the floor', async () => {
    need(dc);
    const v = lowCapViolations(dc);
    assert.ok(!v.precapBuzzerMiddle, v.precapBuzzerMiddle);
  });

  await runAsync('4 final-round-holds-last-bid: a bid is left for the final round and none goes above 2,500 ms', async () => {
    need(dc);
    const v = lowCapViolations(dc);
    assert.ok(!v.finalHoldsLastBid, v.finalHoldsLastBid);
  });

  await runAsync('5 final-round-floor: the floor goes at <= 2,500 ms of the final round; 3 bids in total', async () => {
    need(dc);
    const v = lowCapViolations(dc);
    assert.ok(!v.finalRoundFloor, v.finalRoundFloor);
  });

  await runAsync('6 vishal-variant (extension 120 s): behaviours 2-5 hold', async () => {
    const vp = await drive({ companyName: 'Vishal Pipes Ltd', extendMs: VISHAL_EXTEND_MS, rankAt: outrankedAfterEstablish });
    need(vp);
    const v = lowCapViolations(vp);
    const msgs = Object.values(v);
    assert.ok(!msgs.length, `Vishal Pipes shape: ${msgs.join(' | ')}`);
  });

  await runAsync('C1 control: rank 1 in round 0\'s last 6,000 ms - nothing is sent there', async () => {
    const d = await drive({ companyName: 'Dynamic Cables Ltd', extendMs: DYNAMIC_EXTEND_MS,
      rankAt: ({ landed, round, remaining }) => {
        if (!landed) return null;
        return (round === 0 && remaining <= PROBE_LEAD_MS) ? 1 : 3;
      } });
    need(d);
    const buzzer = d.bids.filter((b) => b.round === 0 && b.remaining <= PROBE_LEAD_MS);
    assert.strictEqual(buzzer.length, 0, `bid at round 0's buzzer while rank 1: ${describe(buzzer)} - SP holds at rank 1`);
  });

  await runAsync('C2 control: a 10-bid branch outranked in round 0 still places one in-window defend', async () => {
    const d = await drive({ companyName: 'Dynamic Cables Ltd', extendMs: DYNAMIC_EXTEND_MS, revisionLimit: 10,
      rankAt: outrankedAfterEstablish });
    need(d);
    const last = d.m.ladder.length - 1;
    assert.ok(d.m.ladder.length >= 5, `PRECONDITION: the 10-bid branch must arm a >= 5-rung ladder (got ${d.m.ladder.length})`);
    const inWindow = d.bids.filter((b) => b.round === 0 && b.remaining > PROBE_LEAD_MS && b.remaining <= TRIGGER_MS);
    assert.strictEqual(inWindow.length, 1,
      `10-bid branch in-window defends: ${describe(inWindow)} - with a bid cap > 3 the reserve stays 1 and one defend goes`);
    assert.ok(inWindow[0].rung > 0 && inWindow[0].rung < last,
      `the in-window defend must be a middle rung, got r${inWindow[0].rung} of ${last}`);
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
