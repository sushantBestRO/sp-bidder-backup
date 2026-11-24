'use strict';
/**
 * In a provisional-close (GoComet) load's final round the buzzer sends the floor even at rank 1;
 * SuperProcure keeps holding at rank 1.
 *
 * Regression target: PR-T2a contract section 5b, owner ruling 2026-09-24: "Buzzer: send
 * the floor whatever the rank, including rank 1, unless the floor already stands or A == 0". Rank is
 * read at least 5 s before a GoComet close and the round's last bids are invisible until after it, so
 * leading at the buzzer is not leading at the close: 11 Waaree loads were lost after leading into the
 * last seconds. Section 6: every SuperProcure decision, including hold-while-winning, must not move.
 *
 * THE DEFECT. Every rank-1 exit in _decide holds unconditionally:
 *   - step 2, `if (state.myRank === 1) return null;`, sits above every snipe branch;
 *   - _lastResortFloor's `if (state.myRank === 1) return null;` guards the never-forfeit release;
 * and softStrategy 'off' counts no rounds, so no final-round predicate exists that could exempt a
 * GoComet load from either. A load leading at the final buzzer keeps its standing non-floor rung
 * and closes with the floor unsent.
 *
 * ISOLATION. Each leg starts from the same state on both trees, reached through the public restore
 * path: arm() (a fixed engine persists the default round policy) writes the durable intent, the intent
 * is updated to the landed state the leg needs, and a new BidEngine over the same DurableScheduler
 * file rehydrate()s it before the posted close. Extensions are then observed live (each frame arrives
 * as the previous close passes, showing the close 299,000 ms later; SuperProcure: 180,000 ms, cap 3,
 * trigger window 100 s). myRank is 1 on every frame.
 *
 * CHECKS
 *   1. control (green on both trees): an SP allowlisted soft-close load (adapter capabilities with NO
 *      extensionCeiling key, as the real SP adapter declares), rung 0 standing, cap reached, rank 1 at
 *      101,000 ms (inside its decisive band) and at 2,000 ms -> no bid. Liveness half: the same load
 *      at rank 2 in the band -> exactly one placeBid, so the hold is the rank guard, not a dead path.
 *   2. control (green on both trees): an SP hard-close load, rank 1 at 2,000 ms -> no bid. Liveness
 *      half: rank 2 at 2,000 ms -> exactly one placeBid at the floor.
 *   3. mechanism: GoComet final round (default cap 3, 3 extensions), rungs 0 and 1 standing, A = 1,
 *      rank 1 at 5,000 ms -> exactly one placeBid: the floor.
 *   4. mechanism: GoComet final round, rung 0 standing, A = 2, rank 1 -> nothing at 10,500 ms (no
 *      middle shot at rank 1), then exactly one placeBid at 5,000 ms: the floor.
 *   5. pin (green on both trees): GoComet final round, our floor already landed and standing, A = 1,
 *      rank 1 at 5,000 ms -> no bid.
 *   6. pin (green on both trees): GoComet round 1 of 3 (pre-final), rung 0 standing, A = 2, rank 1 at
 *      5,000 ms -> no bid.
 *
 * Offline and deterministic: fake adapters (GoComet capabilities mirror the real gocometAdapter),
 * temp-file DurableScheduler under os.tmpdir(), stubbed clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-final-floor-at-rank1.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 6;
const BUZZER = 5_000;
const MIDDLE = 10_500;
const COST = 50_000;
const MARGINS = [9, 7.2, 1.8, 1];
const CHIKHLI = 'Degam (Survey No. 1934, NH-48, Chikhli)';
const CAUSE = "_decide holds at rank 1 before any snipe branch (step 2) and _lastResortFloor refuses at rank 1, "
  + "and softStrategy 'off' counts no rounds, so a GoComet load leading at its final-round buzzer never sends "
  + 'the floor';

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };
const PLATFORMS = {
  gocomet: { caps: GOCOMET_CAPS, stepMs: 299_000, key: 'gocomet' },
  spSoft: { caps: SP_CAPS, stepMs: 180_000, key: 'superprocure' },
  spHard: { caps: SP_CAPS, stepMs: null, key: 'superprocure' },
};

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ENGINE_OPTS = {
  config: { openAtMs: 25_000, floorWindowMs: 2_500, softOpenAtMs: 150_000, softOpenJitterMs: 0,
    openJitterMs: 0, cadenceJitterMs: 0 },
  softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
  rand: () => 0,
  log: quiet,
};

async function restoredLoad({ id, platform, firedRungs, revisionsLeft = null, companyName = 'Waaree Energies Ltd',
  origin = CHIKHLI }) {
  const p = PLATFORMS[platform];
  const gc = platform === 'gocomet';
  const file = path.join(os.tmpdir(), `gc-final-rank1-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const ctrl = { close: null, rank: null, revisionsLeft: gc ? revisionsLeft : null };
  const bids = [];
  const frame = () => {
    const base = { ok: true, status: 'live', closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
      myRank: ctrl.rank, totalBidders: null, standingL1Price: null, minDecrement: 500, measuredRttMs: 20 };
    if (gc) {
      return { ...base, closeModel: 'soft', extendMs: 300_000, extendCount: null, extensionCeiling: null,
        revisionsLeft: ctrl.revisionsLeft, revisionLimit: 3 };
    }
    if (platform === 'spSoft') {
      return { ...base, closeModel: 'soft', extendMs: 180_000, extendCount: 3, triggerWindowMs: 100_000,
        revisionsLeft: null, revisionLimit: null };
    }
    return { ...base, closeModel: 'hard', revisionsLeft: null, revisionLimit: null };
  };
  const adapter = {
    capabilities: () => ({ ...p.caps }),
    async getAuctionState() { return frame(); },
    async placeBid(auctionId, price) {
      bids.push({ price, closesInMs: ctrl.close - Date.now() });
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      return { accepted: true, myRank: ctrl.rank, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const posted = REAL_NOW() + 3_600_000;
  ctrl.close = posted;
  vnow = posted - 600_000;
  const meta = { id, lane: { origin, destination: 'Hosur' }, equipment: '32ft SXL', units: 1, quoteType: 'FTL',
    companyName, closesAt: posted, platformKey: p.key, rules: { revisionLimit: 3, minDecrement: 500 } };
  const first = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  const ladder = first.arm(meta, { cost: COST, marginsPct: MARGINS }).ladder.slice();
  first.kill('test: process restart');
  first.scheduler.update(id, { status: 'bidding', firedRungs, landedBids: firedRungs.length, everBid: true,
    landedBidPrice: ladder[Math.max(...firedRungs)], ...(gc ? { revisionsLeft } : {}) });

  const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  await eng.rehydrate();
  const m = eng.monitors.get(id);
  if (m && m.timer) { clearTimeout(m.timer); m.timer = null; }
  const tick = async () => {
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const extend = async (n, rank) => {
    for (let i = 0; i < n; i++) {
      vnow = ctrl.close;
      ctrl.close += p.stepMs;
      ctrl.rank = rank;
      await tick();
    }
    if (gc && m.believedCloseAt !== ctrl.close) {
      return `HARNESS: the extension frames did not reach the engine (believedCloseAt ${m.believedCloseAt}, live close ${ctrl.close})`;
    }
    if (platform === 'spSoft' && (m.extendsObserved !== n || m.extendCap !== 3 || m.triggerWindowMs !== 100_000)) {
      return `HARNESS: SP soft load observed ${m.extendsObserved} of ${n} extensions (cap ${m.extendCap}, window ${m.triggerWindowMs})`;
    }
    return null;
  };
  const at = async (countdown, rank) => {
    vnow = ctrl.close - countdown;
    ctrl.rank = rank;
    await tick();
  };
  const harness = () => {
    if (!m) return `HARNESS: rehydrate() did not re-arm '${id}'`;
    const bad = [];
    const want = Math.max(...firedRungs);
    if ([...m.firedRungs].sort().join() !== [...firedRungs].sort().join() || m.currentRungIndex !== want) {
      bad.push(`restored rungs ${JSON.stringify([...m.firedRungs])} / currentRungIndex ${m.currentRungIndex}, `
        + `expected ${JSON.stringify(firedRungs)} / ${want}`);
    }
    if (m.landedBids !== firedRungs.length) bad.push(`landedBids ${m.landedBids}, expected ${firedRungs.length}`);
    if (gc && m.revisionsLeft !== revisionsLeft) bad.push(`revisionsLeft ${m.revisionsLeft}, expected ${revisionsLeft}`);
    const strategy = platform === 'spSoft' ? 'live' : 'off';
    if (m.softStrategy !== strategy) bad.push(`softStrategy '${m.softStrategy}', expected '${strategy}'`);
    if (m.ladder.join() !== ladder.join()) bad.push(`ladder ${m.ladder}, expected ${ladder}`);
    if (gc && ladder.length !== 4) bad.push(`GoComet ladder ${ladder}, expected the 4-rung band`);
    if (closeIsProvisional(p.caps) !== gc) bad.push(`closeIsProvisional(${platform} caps) is ${!gc}`);
    return bad.length ? `HARNESS: restored state is wrong: ${bad.join('; ')}` : null;
  };
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { m, ladder, bids, extend, at, harness, done };
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

async function main() {
  await check(1, 'control_sp_allowlisted_soft_holds_at_rank1_in_its_final_window', 'control', async () => {
    const r = await restoredLoad({ id: 'SP-SOFT-R1', platform: 'spSoft', firedRungs: [0], companyName: 'Havells India Ltd',
      origin: 'Alwar' });
    const live = await restoredLoad({ id: 'SP-SOFT-R2', platform: 'spSoft', firedRungs: [0], companyName: 'Havells India Ltd',
      origin: 'Alwar' });
    try {
      const h = r.harness() || live.harness() || await r.extend(3, 1) || await live.extend(3, 1);
      if (h) return h;
      await live.at(101_000, 2);
      if (live.bids.length !== 1) {
        return `HARNESS DEAD: the SP allowlisted soft load at rank 2 inside its decisive band placed `
          + `${describe(live.bids, live.ladder)}, expected exactly one placeBid - the harness is not reaching the SP snipe`;
      }
      await r.at(101_000, 1);
      await r.at(2_000, 1);
      if (r.bids.length === 0) return null;
      return `SP allowlisted soft load leading (rank 1) in its final window placed ${describe(r.bids, r.ladder)}; `
        + 'SuperProcure hold-while-winning must not move (contract section 6)';
    } finally { r.done(); live.done(); }
  });

  await check(2, 'control_sp_hard_close_holds_at_rank1_at_2000ms', 'control', async () => {
    const r = await restoredLoad({ id: 'SP-HARD-R1', platform: 'spHard', firedRungs: [0], companyName: 'Tata Steel',
      origin: 'Bhiwandi' });
    const live = await restoredLoad({ id: 'SP-HARD-R2', platform: 'spHard', firedRungs: [0], companyName: 'Tata Steel',
      origin: 'Bhiwandi' });
    try {
      const h = r.harness() || live.harness();
      if (h) return h;
      await live.at(2_000, 2);
      const floor = live.ladder[live.ladder.length - 1];
      if (live.bids.length !== 1 || live.bids[0].price !== floor) {
        return `HARNESS DEAD: the SP hard-close load at rank 2 at 2,000 ms placed ${describe(live.bids, live.ladder)}, `
          + `expected exactly one placeBid at the floor ${floor}`;
      }
      await r.at(2_000, 1);
      if (r.bids.length === 0) return null;
      return `SP hard-close load leading (rank 1) at 2,000 ms placed ${describe(r.bids, r.ladder)}; SuperProcure `
        + 'hold-while-winning must not move (contract section 6)';
    } finally { r.done(); live.done(); }
  });

  await check(3, 'gocomet_final_round_sends_the_floor_at_rank1_with_one_attempt', 'mechanism', async () => {
    const r = await restoredLoad({ id: 'GC-FINAL-R1-A1', platform: 'gocomet', firedRungs: [0, 1], revisionsLeft: 1 });
    try {
      const h = r.harness() || await r.extend(3, 1);
      if (h) return h;
      const between = r.bids.length;
      await r.at(BUZZER, 1);
      const floor = r.ladder[r.ladder.length - 1];
      if (between === 0 && r.bids.length === 1 && r.bids[0].price === floor) return null;
      return `final round (default cap 3, 3 extensions), rungs 0 and 1 standing, A = 1, rank 1: placed `
        + `${describe(r.bids, r.ladder)} by the ${BUZZER} ms buzzer; expected exactly one placeBid at the floor ${floor}, `
        + `at the buzzer - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(4, 'gocomet_final_round_no_middle_at_rank1_then_the_floor_with_two_attempts', 'mechanism', async () => {
    const r = await restoredLoad({ id: 'GC-FINAL-R1-A2', platform: 'gocomet', firedRungs: [0], revisionsLeft: 2 });
    try {
      const h = r.harness() || await r.extend(3, 1);
      if (h) return h;
      const floor = r.ladder[r.ladder.length - 1];
      await r.at(MIDDLE, 1);
      const middle = r.bids.slice();
      await r.at(BUZZER, 1);
      const buzzer = r.bids.slice(middle.length);
      if (middle.length === 0 && buzzer.length === 1 && buzzer[0].price === floor) return null;
      return `final round (default cap 3, 3 extensions), rung 0 standing, A = 2, rank 1: placed ${describe(middle, r.ladder)} `
        + `up to ${MIDDLE} ms (expected nothing: no middle shot at rank 1) and ${describe(buzzer, r.ladder)} at the `
        + `${BUZZER} ms buzzer (expected exactly one placeBid at the floor ${floor}) - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(5, 'gocomet_final_round_floor_already_standing_holds_at_rank1', 'pin', async () => {
    const r = await restoredLoad({ id: 'GC-FINAL-FLOOR-STANDS', platform: 'gocomet', firedRungs: [0, 3], revisionsLeft: 1 });
    try {
      const h = r.harness() || await r.extend(3, 1);
      if (h) return h;
      await r.at(BUZZER, 1);
      if (r.bids.length === 0) return null;
      return `final round, our floor already landed and standing, A = 1, rank 1: placed ${describe(r.bids, r.ladder)}; `
        + 'expected no bid - re-sending a standing floor burns the last attempt to change nothing (contract 5b)';
    } finally { r.done(); }
  });

  await check(6, 'gocomet_pre_final_round_holds_at_rank1', 'pin', async () => {
    const r = await restoredLoad({ id: 'GC-R1-RANK1', platform: 'gocomet', firedRungs: [0], revisionsLeft: 2 });
    try {
      const h = r.harness() || await r.extend(1, 1);
      if (h) return h;
      await r.at(BUZZER, 1);
      if (r.bids.length === 0) return null;
      return `round 1 of 3 (pre-final), rung 0 standing, A = 2, rank 1: placed ${describe(r.bids, r.ladder)} at the `
        + `${BUZZER} ms buzzer; expected no bid - rank 1 holds before the final round (contract 5a)`;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const isHarness = (x) => x.failure && (x.kind === 'control' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS/CONTROL: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the SuperProcure controls or the harness are broken, so the `
      + 'mechanism results above are not trustworthy');
    process.exit(1);
  }
  if (mech.length) {
    const pins = mech.filter((x) => x.kind === 'pin');
    const causes = [];
    if (mech.some((x) => x.kind === 'mechanism')) causes.push(CAUSE);
    if (pins.length) causes.push(`pin(s) ${pins.map((x) => x.n).join(', ')} moved: the final-round floor fires where it must not`);
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${causes.join('; ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: the GoComet final-round buzzer sends the floor at rank 1; SuperProcure still holds`);
});
