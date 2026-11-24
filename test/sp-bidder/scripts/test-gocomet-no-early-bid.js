'use strict';
/**
 * No early bid on GoComet: an unbid provisional-close load places nothing before the round-0 buzzer.
 *
 * Regression target: PR-T2a "GoComet final-round timing", owner ruling "No early bid on GoComet"
 * (UPDATE 2026-09-24), contract
 * sections 5 "Never" and 5a. Base d3bf803.
 *
 * THE DEFECT. _decide's soft 'off' establish hold releases rung 0 once the countdown reaches
 * _softEstablishThreshold (softOpenAtMs 150,000 plus up to 15,000 one-sided jitter). Every GoComet
 * load takes that branch, so its first bid goes out ~150-165 s before close. Timing-E measured that a
 * bid 180-300 s out is followed by an extension 85% of the time (0 of 1,194 bids placed >300 s out
 * extended): the establish extends the auction itself and spends one of 3 non-renewing attempts.
 *
 * CHECKS
 *   1. control: an SP-shaped hard-close load on the same harness establishes rung 0 at its openAtMs
 *      mark. Green on base; if it fails the harness is not reaching the bid path.
 *   2. mechanism: a fresh P-load, round 0, A=3, unranked, ticked at 600,000 ... 15,000 places nothing.
 *   3. mechanism: the same load at countdown 10,500 (round 0's middle band, where its pre-final shot
 *      goes since rulings 40 and 56), unranked, places exactly one bid, at rung 0.
 *   4. mechanism: the career repeated across loads whose per-load jitter roll differs never bids above
 *      the middle band.
 *
 * Frames reach the engine through the real _tick via a fake adapter whose capabilities mirror the
 * real gocometAdapter (extensionCeiling: null, snipeBudgetMs 4500). Offline and deterministic:
 * stubbed Date.now, injected rand, temp-file DurableScheduler under os.tmpdir(), no network, no sleeps.
 *
 *   node scripts/test-gocomet-no-early-bid.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 4;
const EXTEND_MS = 300_000;
// named re-pin: round tracker piece C, rulings 40 and 56 - round 0's shot moved from the buzzer (5,000 ms)
// into the 12 s middle band, so the first bid is due at the 10,500 ms read and nothing may go above 12 s.
const BUZZER_TICK = 10_500;
const PRE_BUZZER_TICKS = [600_000, 300_000, 165_000, 150_000, 120_000, 60_000, 30_000, 15_000];
const MECHANISM = "the soft 'off' establish hold in _decide releases rung 0 at _softEstablishThreshold "
  + '(softOpenAtMs 150,000 + up to 15,000 jitter) on a provisional-close GoComet load, so its first bid goes '
  + 'out ~150-165 s before close, extends the auction and spends one of 3 non-renewing attempts';

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-no-early-bid-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: EXTEND_MS,
  snipeBudgetMs: 4500 };
const SP_HARD_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'hard' };

function rig(caps, { rand = () => 0.5 } = {}) {
  const bids = [];
  const ctrl = { frame: null };
  const adapter = {
    capabilities: () => ({ ...caps }),
    ensureSession: async () => ({}),
    async getAuctionState() { return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' }; },
    async placeBid(id, price) {
      bids.push({ id, price, countdown: ctrl.frame ? ctrl.frame.closesInMs : null });
      return { accepted: true, myRank: 2, latencyMs: 20 };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0 },
    softClose: { enabled: false, shippers: [], mode: 'live' },
    rand,
    onEvent: () => {},
    log: quiet,
  });
  const arm = (id, closesAt, platformKey) => {
    vnow = closesAt - 600_000;
    const m = eng.arm({
      id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' }, equipment: '32ft SXL',
      units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt, platformKey,
      rules: { revisionLimit: 3, minDecrement: 500 },
    }, { cost: 70_000, marginsPct: [9, 7.2, 1.8, 1] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    return m;
  };
  const goFrame = (closesAtMs, myRank) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs,
    closesInMs: closesAtMs - Date.now(), extendMs: EXTEND_MS, extendCount: null, extensionCeiling: null, myRank,
    totalBidders: null, standingL1Price: null, revisionsLeft: 3, revisionLimit: 3, minDecrement: 500,
    measuredRttMs: 20 });
  const spFrame = (closesAtMs, myRank) => ({ ok: true, status: 'live', closeModel: 'hard', closesAtMs,
    closesInMs: closesAtMs - Date.now(), myRank, totalBidders: 3, standingL1Price: null, revisionsLeft: 3,
    minDecrement: 500, measuredRttMs: 20 });
  const tickAt = async (m, close, countdown, frameFn, myRank = null) => {
    vnow = close - countdown;
    ctrl.frame = frameFn(close, myRank);
    const before = bids.length;
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    return bids.slice(before);
  };
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, bids, arm, goFrame, spFrame, tickAt, done };
}

// Runs the pre-buzzer career on a fresh round-0 P-load; returns every bid placed above the buzzer.
async function preBuzzerCareer(r, id) {
  const close = REAL_NOW() + 600_000;
  const m = r.arm(id, close, 'gocomet');
  const early = [];
  for (const cd of PRE_BUZZER_TICKS) {
    for (const b of await r.tickAt(m, close, cd, r.goFrame)) early.push({ at: cd, price: b.price });
  }
  return { m, close, early };
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  console.log('\nGoComet: no early bid on an unbid provisional-close load (PR-T2a, contract 5 / 5a)\n');

  await check(1, 'control_sp_hard_close_establishes_at_openAt_mark', 'control', async () => {
    if (closeIsProvisional(SP_HARD_CAPS)) return 'HARNESS: the SP hard-close caps read as provisional';
    const r = rig(SP_HARD_CAPS);
    try {
      const close = REAL_NOW() + 600_000;
      const m = r.arm('SP-HARD-CTL', close, 'superprocure');
      const early = [];
      for (const cd of [600_000, 300_000, 150_000, 60_000, 30_000]) {
        for (const b of await r.tickAt(m, close, cd, r.spFrame)) early.push({ at: cd, price: b.price });
      }
      if (early.length) return `HARNESS: SP hard-close bid above its 25,000 ms openAtMs mark: ${JSON.stringify(early)}`;
      const atMark = await r.tickAt(m, close, 15_000, r.spFrame);
      if (atMark.length !== 1 || atMark[0].price !== m.ladder[0]) {
        return `HARNESS: SP hard-close did not establish rung 0 (${m.ladder[0]}) at countdown 15,000 - placed `
          + `${JSON.stringify(atMark)}; the harness is not driving _decide into the bid path`;
      }
      return null;
    } finally { r.done(); }
  });

  let careerRig = null;
  let career = null;
  await check(2, 'no_bid_above_the_buzzer_on_round0_unbid_load', 'mechanism', async () => {
    if (!closeIsProvisional(GOCOMET_CAPS)) return 'HARNESS: the GoComet caps do not read as provisional-close';
    careerRig = rig(GOCOMET_CAPS);
    career = await preBuzzerCareer(careerRig, 'GC-NOEARLY-1');
    if (!career.early.length) return null;
    return `round-0 unbid P-load (A=3, unranked) placed ${career.early.length} bid(s) above the 12,000 ms `
      + `middle band: ${JSON.stringify(career.early)} - expected none`;
  });

  await check(3, 'first_bid_is_rung0_at_the_round0_buzzer_unranked', 'mechanism', async () => {
    if (!career) return 'HARNESS: check 2 produced no career to continue';
    try {
      const { m, close } = career;
      const atBuzzer = await careerRig.tickAt(m, close, BUZZER_TICK, careerRig.goFrame, null);
      if (atBuzzer.length === 1 && atBuzzer[0].price === m.ladder[0] && careerRig.bids.length === 1) return null;
      return `at countdown ${BUZZER_TICK} (round 0's middle band, unranked, A=3) expected exactly one bid at rung 0 `
        + `(${m.ladder[0]}) and it being the load's only bid; buzzer tick placed ${JSON.stringify(atBuzzer)}, `
        + `career total ${careerRig.bids.length}`;
    } finally { careerRig.done(); }
  });

  await check(4, 'per_load_jitter_never_pulls_a_bid_above_the_buzzer', 'mechanism', async () => {
    const rolls = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.9999];
    const offenders = [];
    for (let i = 0; i < rolls.length; i++) {
      const r = rig(GOCOMET_CAPS, { rand: () => rolls[i] });
      try {
        const { early } = await preBuzzerCareer(r, `GC-NOEARLY-J${i}`);
        if (early.length) offenders.push({ roll: rolls[i], firstAt: early[0].at, bids: early.length });
      } finally { r.done(); }
    }
    if (!offenders.length) return null;
    return `${offenders.length} of ${rolls.length} loads bid above the middle band: ${JSON.stringify(offenders)}`;
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
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${MECHANISM}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: an unbid GoComet load bids first at the round-0 buzzer, never earlier`);
});
