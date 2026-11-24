'use strict';
/**
 * In a provisional-close (GoComet) load's final round with two or more attempts left: one middle shot
 * at ~11 s at the next price, only if outranked or unranked, then the floor at the buzzer.
 *
 * Regression target: PR-T2a contract section 5b, owner rulings Q2 and Q3 of 2026-09-24:
 *   - middle band, countdown in (5,500, 12,000], final round only, only if A >= 2 and the floor does
 *     not stand: unranked or outranked -> the NEXT price (the first unfired rung below the standing
 *     one, rung 0 if none, never the floor); rank 1 -> no middle shot;
 *   - buzzer: the floor, whatever rank the middle shot returned; a middle shot still in flight at the
 *     buzzer defers the floor to the first tick after it resolves.
 *
 * THE DEFECT. softStrategy 'off' counts no rounds, so there is no final round, no middle band and no
 * buzzer. An outranked load at 10,500 ms falls to _decide branch 4, the clock step-down
 *   next = Math.max(monitor.currentRungIndex + 1, this._scheduledRungIndex(monitor, remaining));
 * which jumps past the next price to the deepest non-floor rung, and at 5,000 ms has nothing left to
 * step to: the floor is only released inside floorWindowMs (2,500 ms, _isLastChance), and never at
 * rank 1 (step 2 and _lastResortFloor both hold).
 *
 * ISOLATION. Each leg starts from the same state on both trees, reached through the public restore
 * path: arm() writes the durable intent, the intent is updated to the leg's landed state (none, for
 * the unbid leg), and a new BidEngine over the same DurableScheduler file rehydrate()s it before the
 * posted close. The extensions are then observed live (each frame arrives as the previous close passes
 * and shows the close 299,000 ms later), at rank 1 (rank null for the unbid leg) so neither tree bids
 * between rounds. No meta.roundPolicy: the default cap 3 applies. Ladder: the Waaree band 9 / 7.2 /
 * 1.8 / 1 %, so rung 1 is the next price below rung 0 (Q3) and rung 3 is the floor.
 *
 * CHECKS
 *   1. control (green on both trees): an SP hard-close load, rung 0 standing, rank 3 at 10,500 ms
 *      steps down one non-floor rung, and at rank 2 at 2,000 ms fires the floor.
 *   2. mechanism: final round, rung 0 standing, A = 2, rank 3 at 10,500 ms -> exactly one placeBid,
 *      at rung 1.
 *   3. mechanism: the same load, the middle shot having returned rank 2 -> exactly one placeBid at
 *      5,000 ms: the floor.
 *   4. mechanism: as 2-3, but the middle shot returns rank 1 -> the floor still goes at 5,000 ms.
 *   5. mechanism: final, A = 2, rank 1 at 10,500 ms -> nothing; the floor at 5,000 ms.
 *   6. mechanism: final, rungs 0 and 1 standing, A = 1, rank 3 at 10,500 ms -> nothing; the floor at
 *      5,000 ms.
 *   7. mechanism: round 1 of 3 (pre-final), rung 0 standing, A = 2, rank 3 at 10,500 ms -> exactly one
 *      placeBid, at rung 1: the pre-final shot now goes in the middle band (rulings 40 and 56).
 *   8. mechanism: final round, never bid, A = 3, unranked -> rung 0 at 10,500 ms, the floor at 5,000 ms.
 *   9. mechanism: final, rung 0 standing, A = 2, rank 3: the middle placeBid is still unresolved when
 *      the 5,000 ms tick arrives -> no second write while it is in flight; once it resolves, the
 *      floor on the next tick (4,000 ms). Driven with a deferred promise, no timers.
 *
 * Offline and deterministic: fake adapter mirroring the real gocometAdapter capabilities, temp-file
 * DurableScheduler under os.tmpdir(), stubbed clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-final-two-shots.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 9;
const GC_STEP_MS = 299_000;
const BUZZER = 5_000;
const MIDDLE = 10_500;
const COST = 50_000;
const MARGINS = [9, 7.2, 1.8, 1];
const CHIKHLI = 'Degam (Survey No. 1934, NH-48, Chikhli)';
const CAUSE = "softStrategy 'off' counts no rounds, so there is no final-round middle band or buzzer: an outranked "
  + 'tick falls to _decide branch 4 (next = max(currentRungIndex + 1, _scheduledRungIndex)), which skips the next '
  + 'price and leaves nothing for the buzzer, and the floor waits for the 2,500 ms floorWindowMs (never at rank 1)';

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ENGINE_OPTS = {
  config: { openAtMs: 25_000, floorWindowMs: 2_500, softOpenAtMs: 150_000, softOpenJitterMs: 0,
    openJitterMs: 0, cadenceJitterMs: 0 },
  softClose: { enabled: false, shippers: [], mode: 'live' },
  rand: () => 0,
  log: quiet,
};

async function restoredLoad({ id, sp = false, firedRungs = [0], revisionsLeft = 2 }) {
  const file = path.join(os.tmpdir(), `gc-final-two-shots-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const ctrl = { close: null, rank: null, rankAfterBid: null, revisionsLeft: sp ? null : revisionsLeft,
    defer: false, release: null };
  const bids = [];
  const flight = { now: 0, max: 0 };
  const frame = () => (sp
    ? { ok: true, status: 'live', closeModel: 'hard', closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
      myRank: ctrl.rank, totalBidders: null, standingL1Price: null, revisionsLeft: null, revisionLimit: null,
      minDecrement: 500, measuredRttMs: 20 }
    : { ok: true, status: 'live', closeModel: 'soft', closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
      extendMs: 300_000, extendCount: null, extensionCeiling: null, myRank: ctrl.rank, totalBidders: null,
      standingL1Price: null, revisionsLeft: ctrl.revisionsLeft, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 });
  const adapter = {
    capabilities: () => ({ ...(sp ? SP_CAPS : GOCOMET_CAPS) }),
    async getAuctionState() { return frame(); },
    async placeBid(auctionId, price) {
      bids.push({ price, closesInMs: ctrl.close - Date.now() });
      flight.now += 1;
      flight.max = Math.max(flight.max, flight.now);
      if (ctrl.defer) await new Promise((resolve) => { ctrl.release = resolve; });
      flight.now -= 1;
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      if (ctrl.rankAfterBid != null) ctrl.rank = ctrl.rankAfterBid;
      return { accepted: true, myRank: ctrl.rank, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const posted = REAL_NOW() + 3_600_000;
  ctrl.close = posted;
  vnow = posted - 600_000;
  const meta = { id, lane: { origin: sp ? 'Bhiwandi' : CHIKHLI, destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName: sp ? 'Tata Steel' : 'Waaree Energies Ltd', closesAt: posted,
    platformKey: sp ? 'superprocure' : 'gocomet', rules: { revisionLimit: 3, minDecrement: 500 } };
  const first = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  const ladder = first.arm(meta, { cost: COST, marginsPct: MARGINS }).ladder.slice();
  first.kill('test: process restart');
  if (firedRungs.length) {
    first.scheduler.update(id, { status: 'bidding', firedRungs, landedBids: firedRungs.length, everBid: true,
      landedBidPrice: ladder[Math.max(...firedRungs)], ...(sp ? {} : { revisionsLeft }) });
  }

  const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  await eng.rehydrate();
  const m = eng.monitors.get(id);
  const clear = () => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };
  clear();
  const tick = async () => { await eng._tick(m); clear(); };
  const extend = async (n, rank) => {
    for (let i = 0; i < n; i++) {
      vnow = ctrl.close;
      ctrl.close += GC_STEP_MS;
      ctrl.rank = rank;
      await tick();
    }
    return m.believedCloseAt === ctrl.close ? null
      : `HARNESS: the extension frames did not reach the engine (believedCloseAt ${m.believedCloseAt}, live close ${ctrl.close})`;
  };
  const at = async (countdown, rank) => {
    vnow = ctrl.close - countdown;
    ctrl.rank = rank;
    await tick();
  };
  const harness = () => {
    if (!m) return `HARNESS: rehydrate() did not re-arm '${id}'`;
    const bad = [];
    const want = firedRungs.length ? Math.max(...firedRungs) : -1;
    if ([...m.firedRungs].sort().join() !== firedRungs.join() || m.currentRungIndex !== want) {
      bad.push(`restored rungs ${JSON.stringify([...m.firedRungs])} / currentRungIndex ${m.currentRungIndex}, `
        + `expected ${JSON.stringify(firedRungs)} / ${want}`);
    }
    if (m.landedBids !== firedRungs.length) bad.push(`landedBids ${m.landedBids}, expected ${firedRungs.length}`);
    if (!sp && m.revisionsLeft !== revisionsLeft) bad.push(`revisionsLeft ${m.revisionsLeft}, expected ${revisionsLeft}`);
    if (m.softStrategy !== 'off') bad.push(`softStrategy '${m.softStrategy}', expected 'off'`);
    if (ladder.length !== 4 || m.ladder.join() !== ladder.join()) bad.push(`ladder ${m.ladder}, expected the 4-rung band ${ladder}`);
    if (closeIsProvisional(sp ? SP_CAPS : GOCOMET_CAPS) === sp) bad.push('closeIsProvisional does not split the two cap shapes');
    return bad.length ? `HARNESS: restored state is wrong: ${bad.join('; ')}` : null;
  };
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, ctrl, ladder, bids, flight, tick, clear, extend, at, harness, done };
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

const describe = (bids, ladder) => `[${bids.map((b) => `${b.price} (rung ${ladder.indexOf(b.price)}) at ${b.closesInMs} ms`).join(', ')}]`;
const floorOf = (r) => r.ladder[r.ladder.length - 1];
const oneAt = (shots, price) => shots.length === 1 && shots[0].price === price;

// Restore, observe `extensions` rounds, then the middle-band tick. Returns the load and what it placed.
async function toMiddle({ id, firedRungs = [0], revisionsLeft = 2, extensions = 3, careerRank = 1, middleRank,
  rankAfterBid = null }) {
  const r = await restoredLoad({ id, firedRungs, revisionsLeft });
  const h = r.harness() || await r.extend(extensions, careerRank);
  if (h) return { r, harness: h };
  const between = r.bids.slice();
  if (between.length) return { r, harness: `HARNESS: bid between rounds while leading/unranked ${describe(between, r.ladder)}` };
  r.ctrl.rankAfterBid = rankAfterBid;
  await r.at(MIDDLE, middleRank);
  return { r, middle: r.bids.slice() };
}

async function main() {
  await check(1, 'control_sp_hard_close_steps_down_then_fires_the_floor', 'control', async () => {
    const r = await restoredLoad({ id: 'SP-HARD-CTL', sp: true });
    try {
      const h = r.harness();
      if (h) return h;
      await r.at(MIDDLE, 3);
      const step = r.bids.slice();
      await r.at(2_000, 2);
      const snipe = r.bids.slice(step.length);
      const stepped = step.length === 1 && r.ladder.indexOf(step[0].price) > 0 && step[0].price !== floorOf(r);
      if (stepped && oneAt(snipe, floorOf(r))) return null;
      return `HARNESS DEAD: an SP hard-close load placed ${describe(step, r.ladder)} outranked at ${MIDDLE} ms and `
        + `${describe(snipe, r.ladder)} at 2,000 ms, expected one non-floor step then one floor - the harness is not `
        + 'reaching _decide or placeBid';
    } finally { r.done(); }
  });

  let twoShot = null;
  await check(2, 'final_round_middle_shot_is_the_next_price_when_outranked', 'mechanism', async () => {
    twoShot = await toMiddle({ id: 'GC-TWO-SHOTS', middleRank: 3, rankAfterBid: 2 });
    if (twoShot.harness) return twoShot.harness;
    const { r, middle } = twoShot;
    if (oneAt(middle, r.ladder[1])) return null;
    return `final round (default cap 3, 3 extensions), rung 0 standing, A = 2, rank 3: at ${MIDDLE} ms placed `
      + `${describe(middle, r.ladder)}; expected exactly one placeBid at the next price ${r.ladder[1]} (rung 1) - ${CAUSE}`;
  });

  await check(3, 'final_round_floor_at_the_buzzer_after_the_middle_shot', 'mechanism', async () => {
    if (!twoShot || twoShot.harness) return 'HARNESS: check 2 did not build the load';
    const { r, middle } = twoShot;
    try {
      await r.at(BUZZER, 2);
      const shots = r.bids.slice(middle.length);
      if (oneAt(shots, floorOf(r))) return null;
      return `final round, after the middle shot ${describe(middle, r.ladder)} returned rank 2 (A = ${r.m.revisionsLeft + shots.length} `
        + `before the buzzer): at ${BUZZER} ms placed ${describe(shots, r.ladder)}; expected exactly one placeBid at the floor `
        + `${floorOf(r)} - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(4, 'final_round_floor_at_the_buzzer_even_when_the_middle_shot_took_rank1', 'mechanism', async () => {
    const leg = await toMiddle({ id: 'GC-TWO-SHOTS-R1', middleRank: 3, rankAfterBid: 1 });
    const { r } = leg;
    try {
      if (leg.harness) return leg.harness;
      await r.at(BUZZER, 1);
      const shots = r.bids.slice(leg.middle.length);
      if (oneAt(leg.middle, r.ladder[1]) && oneAt(shots, floorOf(r))) return null;
      return `final round, rung 0 standing, A = 2, rank 3 at ${MIDDLE} ms placed ${describe(leg.middle, r.ladder)} (expected `
        + `rung 1), then leading (rank 1) at ${BUZZER} ms placed ${describe(shots, r.ladder)} (expected exactly one `
        + `placeBid at the floor ${floorOf(r)}) - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(5, 'final_round_no_middle_shot_at_rank1_then_the_floor', 'mechanism', async () => {
    const leg = await toMiddle({ id: 'GC-NOMID-RANK1', middleRank: 1 });
    const { r } = leg;
    try {
      if (leg.harness) return leg.harness;
      await r.at(BUZZER, 1);
      const shots = r.bids.slice(leg.middle.length);
      if (leg.middle.length === 0 && oneAt(shots, floorOf(r))) return null;
      return `final round, rung 0 standing, A = 2, rank 1: placed ${describe(leg.middle, r.ladder)} at ${MIDDLE} ms `
        + `(expected nothing) and ${describe(shots, r.ladder)} at ${BUZZER} ms (expected exactly one placeBid at the `
        + `floor ${floorOf(r)}) - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(6, 'final_round_no_middle_shot_with_one_attempt_then_the_floor', 'mechanism', async () => {
    const leg = await toMiddle({ id: 'GC-NOMID-A1', firedRungs: [0, 1], revisionsLeft: 1, middleRank: 3 });
    const { r } = leg;
    try {
      if (leg.harness) return leg.harness;
      await r.at(BUZZER, 3);
      const shots = r.bids.slice(leg.middle.length);
      if (leg.middle.length === 0 && oneAt(shots, floorOf(r))) return null;
      return `final round, rungs 0 and 1 standing, A = 1, rank 3: placed ${describe(leg.middle, r.ladder)} at ${MIDDLE} ms `
        + `(expected nothing: the one attempt is the floor's) and ${describe(shots, r.ladder)} at ${BUZZER} ms (expected `
        + `exactly one placeBid at the floor ${floorOf(r)}) - ${CAUSE}`;
    } finally { r.done(); }
  });

  // named re-pin: round tracker piece C, rulings 40 and 56 - the pre-final shot moved from the buzzer
  // into the 12 s middle band, so a pre-final round now takes its one next-price shot here.
  await check(7, 'pre_final_round_shot_in_the_middle_band', 'mechanism', async () => {
    const leg = await toMiddle({ id: 'GC-NOMID-PREFINAL', extensions: 1, middleRank: 3 });
    const { r } = leg;
    try {
      if (leg.harness) return leg.harness;
      if (oneAt(leg.middle, r.ladder[1])) return null;
      return `round 1 of 3 (pre-final), rung 0 standing, A = 2, rank 3: placed ${describe(leg.middle, r.ladder)} at `
        + `${MIDDLE} ms; expected exactly one placeBid at the next price ${r.ladder[1]} (the pre-final shot goes in the `
        + 'middle band, rulings 40 and 56)';
    } finally { r.done(); }
  });

  await check(8, 'unbid_final_round_rung0_in_the_middle_then_the_floor', 'mechanism', async () => {
    const leg = await toMiddle({ id: 'GC-UNBID-FINAL', firedRungs: [], revisionsLeft: 3, careerRank: null,
      middleRank: null, rankAfterBid: 2 });
    const { r } = leg;
    try {
      if (leg.harness) return leg.harness;
      await r.at(BUZZER, 2);
      const shots = r.bids.slice(leg.middle.length);
      if (oneAt(leg.middle, r.ladder[0]) && oneAt(shots, floorOf(r))) return null;
      return `final round, never bid, A = 3, unranked: placed ${describe(leg.middle, r.ladder)} at ${MIDDLE} ms (expected `
        + `exactly rung 0 ${r.ladder[0]}) and ${describe(shots, r.ladder)} at ${BUZZER} ms after it returned rank 2 `
        + `(expected exactly one placeBid at the floor ${floorOf(r)}) - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(9, 'middle_shot_in_flight_at_the_buzzer_defers_the_floor_to_the_next_tick', 'mechanism', async () => {
    const r = await restoredLoad({ id: 'GC-INFLIGHT' });
    try {
      const h = r.harness() || await r.extend(3, 1);
      if (h) return h;
      r.ctrl.defer = true;
      r.ctrl.rankAfterBid = 2;
      vnow = r.ctrl.close - MIDDLE;
      r.ctrl.rank = 3;
      const middleTick = r.eng._tick(r.m);
      for (let i = 0; i < 50 && !r.ctrl.release; i++) await new Promise((resolve) => setImmediate(resolve));
      const middle = r.bids.slice();
      vnow = r.ctrl.close - BUZZER;
      await r.eng._tick(r.m);
      r.clear();
      const duringFlight = r.bids.slice(middle.length);
      if (r.ctrl.release) r.ctrl.release();
      r.ctrl.defer = false;
      await middleTick;
      r.clear();
      await r.at(4_000, 2);
      const after = r.bids.slice(middle.length + duringFlight.length);
      const bad = [];
      if (!oneAt(middle, r.ladder[1])) bad.push(`middle band ${MIDDLE} ms placed ${describe(middle, r.ladder)} (expected rung 1)`);
      if (duringFlight.length) bad.push(`the ${BUZZER} ms tick wrote ${describe(duringFlight, r.ladder)} with the middle shot in flight`);
      if (r.flight.max > 1) bad.push(`${r.flight.max} writes were in flight at once`);
      if (!oneAt(after, floorOf(r))) bad.push(`the first tick after it resolved (4,000 ms) placed ${describe(after, r.ladder)} (expected exactly one placeBid at the floor ${floorOf(r)})`);
      if (!bad.length) return null;
      return `final round, rung 0 standing, A = 2, rank 3, middle placeBid unresolved at the buzzer: ${bad.join('; ')} - ${CAUSE}`;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const isHarness = (x) => x.failure && (x.kind !== 'mechanism' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the mechanism results above are not trustworthy`);
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${CAUSE}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: the GoComet final round takes one middle shot when outranked, then the floor`);
});
