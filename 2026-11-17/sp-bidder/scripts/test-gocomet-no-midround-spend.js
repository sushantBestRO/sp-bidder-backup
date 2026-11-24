'use strict';
/**
 * A provisional-close (GoComet) load that is outranked between buzzers must not bid until the buzzer.
 *
 * Regression target: finding R1 of the 2026-09-24 timing diagnosis (66 of 99 Waaree loads spent
 * rungs at ~424 s and ~390 s before close), pinned against the PR-T2a behaviour contract, section 5
 * "Never": no bid at any countdown above the middle band, and in a non-final round no bid above the
 * buzzer B = snipeBudgetMs + one read interval = 5,500 ms. Owner ruling: "Bid only in the last
 * seconds of a round, and only when outranked or unranked".
 *
 * THE DEFECT. _decide branch 4, the non-allowlisted step-down,
 *   next = Math.max(monitor.currentRungIndex + 1, this._scheduledRungIndex(monitor, remaining));
 * runs on every outranked tick with no lower bound on the countdown and no per-round latch.
 * _scheduledRungIndex clamps to 0 above openAtMs, so on a P-load it collapses to "the next rung,
 * now": rung 1 on the first outranked read, rung 2 on the next, each minutes before a close that
 * any late bid will push out by another 299 s anyway.
 *
 * ISOLATION. An unbid P-load establishes at ~150 s on the unfixed tree, which is a different
 * mechanism. Both trees therefore start from the SAME already-established state, reached through
 * the public restore path: a first arm writes the durable intent, the intent is updated to the
 * state after rung 0 landed (firedRungs [0], landedBids 1, revisionsLeft 2), and a new BidEngine over
 * the same DurableScheduler file rehydrate()s it. From there the only rule that can fire mid-round is
 * branch 4.
 *
 * THE LOAD. Adapter capabilities mirror the real gocometAdapter (extensionCeiling null, so
 * closeIsProvisional holds; snipeBudgetMs 4500). The posted close is P; our rung 0 landed inside the
 * ~300 s trigger window and pushed the close to P + 299,000, so every frame shows one extension
 * (R = 1 of the default cap 3: a pre-final round) and A = 2. myRank is 3 on every frame. Frames
 * carry closesAtMs = P + 299,000 and closesInMs = closesAtMs - now, with Date.now stubbed to each
 * countdown in turn.
 *
 * CHECKS
 *   1. control: an SP-shaped hard-close load, rehydrated from the same state and outranked at
 *      10,500 ms, still steps down through placeBid. Green on both trees; if it fails the harness
 *      is not reaching _decide or the bid path and nothing else here means anything.
 *   2. mechanism: the P-load, rank 3 at 424,000 / 390,000 / 300,000 / 150,000 / 60,000 / 30,000 /
 *      15,000 ms -> zero placeBid calls.
 *   3. mechanism: the same load at 10,500 ms (the middle band, where a pre-final round's shot goes since
 *      rulings 40 and 56), still rank 3 -> exactly one placeBid, at the next price (rung 1), not the
 *      floor (contract 5a, A = 2).
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-no-midround-spend.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 3;
const EXTEND_MS = 299_000;
// named re-pin: round tracker piece C, rulings 40 and 56 - the pre-final shot moved from the 5,000 ms
// buzzer into the 12 s middle band, so the round's one shot is due at the 10,500 ms read.
const MID_ROUND = [424_000, 390_000, 300_000, 150_000, 60_000, 30_000, 15_000];
const BUZZER = 10_500;
const COST = 50_000;
const MARGINS = [9, 7.2, 1.8, 1];
const CAUSE = "_decide branch 4 (the non-allowlisted step-down, next = max(currentRungIndex + 1, "
  + "_scheduledRungIndex)) spends a rung on the first outranked tick of a provisional-close load, with no "
  + 'lower bound on the countdown and no per-round latch';

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown' };

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

async function restoredLoad({ caps, closeModel, id, platformKey, companyName }) {
  const file = path.join(os.tmpdir(), `gc-no-midround-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const ctrl = { frame: null, revisionsLeft: 2 };
  const bids = [];
  const adapter = {
    capabilities: () => ({ ...caps }),
    async getAuctionState() { return { ...ctrl.frame, revisionsLeft: ctrl.revisionsLeft }; },
    async placeBid(auctionId, price) {
      bids.push({ price, closesInMs: ctrl.frame.closesInMs });
      ctrl.revisionsLeft -= 1;
      return { accepted: true, myRank: ctrl.frame.myRank, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 600_000;
  const first = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  const m0 = first.arm({
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName, closesAt: posted,
    platformKey, rules: { revisionLimit: 3, minDecrement: 500 },
  }, { cost: COST, marginsPct: MARGINS });
  const ladder = m0.ladder.slice();
  first.kill('test: process restart');
  first.scheduler.update(id, { status: 'bidding', firedRungs: [0], landedBids: 1, everBid: true,
    revisionsLeft: 2, landedBidPrice: ladder[0] });

  const close = posted + EXTEND_MS;
  vnow = close - MID_ROUND[0];
  const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  await eng.rehydrate();
  const m = eng.monitors.get(id);
  if (m && m.timer) { clearTimeout(m.timer); m.timer = null; }
  const at = async (countdown) => {
    vnow = close - countdown;
    ctrl.frame = { ok: true, status: 'live', closeModel, closesAtMs: close, closesInMs: close - Date.now(),
      extendMs: 300_000, extendCount: null, extensionCeiling: null, myRank: 3, totalBidders: null,
      standingL1Price: null, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 };
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const harness = () => {
    const bad = [];
    if (!m) return `HARNESS: rehydrate() did not re-arm '${id}'`;
    if (!m.firedRungs.has(0) || m.currentRungIndex !== 0) {
      bad.push(`restored rungs ${JSON.stringify([...m.firedRungs])} / currentRungIndex ${m.currentRungIndex}, expected [0] / 0`);
    }
    if (m.landedBids !== 1) bad.push(`landedBids ${m.landedBids}, expected 1`);
    if (m.revisionsLeft !== 2) bad.push(`revisionsLeft ${m.revisionsLeft}, expected 2`);
    if (m.softStrategy !== 'off') bad.push(`softStrategy '${m.softStrategy}', expected 'off'`);
    if (ladder.length !== 4 || m.ladder.join() !== ladder.join()) bad.push(`ladder ${m.ladder}, expected the 4-rung band ${ladder}`);
    return bad.length ? `HARNESS: restored state is wrong: ${bad.join('; ')}` : null;
  };
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, ladder, bids, at, harness, done };
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

const describe = (bids, ladder) => bids.map((b) => `${b.price} (rung ${ladder.indexOf(b.price)}) at ${b.closesInMs} ms`).join(', ');

async function main() {
  await check(1, 'control_sp_hard_close_outranked_in_window_still_steps_down', 'control', async () => {
    const r = await restoredLoad({ caps: SP_CAPS, closeModel: 'hard', id: 'SP-HARD-CTL', platformKey: null,
      companyName: 'Havells India' });
    try {
      const h = r.harness();
      if (h) return h;
      if (closeIsProvisional(SP_CAPS)) return 'HARNESS: the SP control reads as provisional-close';
      await r.at(10_500);
      const stepped = r.bids.length === 1 && r.ladder.indexOf(r.bids[0].price) > 0
        && r.bids[0].price !== r.ladder[r.ladder.length - 1];
      if (stepped) return null;
      return `HARNESS DEAD: an SP hard-close load outranked at 10,500 ms placed [${describe(r.bids, r.ladder)}], `
        + 'expected exactly one non-floor step-down - the harness is not reaching _decide or placeBid';
    } finally { r.done(); }
  });

  let pLoad = null;
  await check(2, 'no_placebid_between_buzzers_when_outranked_mid_round', 'mechanism', async () => {
    pLoad = await restoredLoad({ caps: GOCOMET_CAPS, closeModel: 'soft', id: 'GC-P-MIDROUND', platformKey: 'gocomet',
      companyName: 'Waaree Energies' });
    const h = pLoad.harness();
    if (h) return h;
    if (!closeIsProvisional(GOCOMET_CAPS)) return 'HARNESS: the GoComet capabilities do not satisfy closeIsProvisional';
    for (const c of MID_ROUND) await pLoad.at(c);
    if (pLoad.bids.length === 0) return null;
    return `provisional-close load, rung 0 standing, outranked (rank 3) in round 1 of 3 with 2 attempts left, `
      + `placed ${pLoad.bids.length} bid(s) between buzzers: ${describe(pLoad.bids, pLoad.ladder)} - ${CAUSE}`;
  });

  await check(3, 'next_price_goes_at_the_buzzer_not_the_floor', 'mechanism', async () => {
    if (!pLoad || !pLoad.m) return 'HARNESS: check 2 did not build the load';
    try {
      const before = pLoad.bids.length;
      await pLoad.at(BUZZER);
      const shots = pLoad.bids.slice(before);
      if (shots.length === 1 && shots[0].price === pLoad.ladder[1]) return null;
      return `at the ${BUZZER} ms buzzer, outranked with A = ${2 - before} before it, the load placed `
        + `[${describe(shots, pLoad.ladder)}]; expected exactly one bid at the next price ${pLoad.ladder[1]} (rung 1), `
        + `not the floor ${pLoad.ladder[pLoad.ladder.length - 1]}`
        + (before ? ` - the rungs were already spent mid-round by ${CAUSE}` : '');
    } finally { pLoad.done(); }
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
  console.log(`\nPASS - ${results.length} checks: a provisional-close load outranked between buzzers holds until the buzzer`);
});
