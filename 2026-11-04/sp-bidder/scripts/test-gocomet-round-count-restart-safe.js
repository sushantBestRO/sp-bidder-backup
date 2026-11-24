'use strict';
/**
 * A restart mid-auction must not lose a GoComet load's round count.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract section 3 ("A restart mid-auction
 * ... must derive the same R from the persisted posted close and the first live read") and section 4
 * ("roundPolicy persisted on the durable intent and restored on rehydrate").
 * Base d3bf803. `sh scripts/deploy.sh` restarts pm2 mid-auction routinely.
 *
 * THE DEFECT. _observeExtension's softStrategy 'off' branch (every GoComet enquiry) lets the believed
 * close follow the published close but counts no rounds; extendsObserved is in-memory only and starts
 * at 0 on every arm, rehydrate included; nothing persists the POSTED close separately (the intent's
 * closesAt is advanced by _persistBelievedClose), so after a restart the only close the engine sees is
 * the extended one. Nothing marks round 3 as final, and a final round's floor never goes out at the
 * 5,000 ms buzzer (base releases it only at floorWindowMs 2,500).
 *
 * CHECKS
 *   1. control: the same restart path with A=2, rung 0 standing, restarted inside round 1, outranked at
 *      the buzzer, sends exactly one bid at rung 1 on base and on the fix. Proves the rehydrated monitor
 *      reaches placeBid at a 5,000 ms tick; if it fails nothing below means anything.
 *   2. mechanism: 3 extensions observed in-process, restart inside round 3 -> floor at 5,000.
 *   3. mechanism: engine down for all 3 extensions, restart inside round 3 -> floor at 5,000.
 *   4. guard (green on base): restart inside round 2 holds at 5,000 with A=1.
 *   5. guard (green on base): the load's own cap 4 survives the restart -> round 3 is not final.
 *
 * Starting state is a seeded durable intent (arm, then status/firedRungs/revisionsLeft/landedBids as
 * the accepted-bid path writes them, then rehydrate): A=1 with rung last-1 standing. Restart = kill()
 * plus a NEW BidEngine over a NEW DurableScheduler reading the SAME file, then rehydrate().
 *
 * Offline and deterministic: fake adapter mirroring the real gocometAdapter capabilities
 * (extensionCeiling null, snipeBudgetMs 4500), stubbed Date.now, jitter off, temp-file intents
 * under os.tmpdir(), no network, no sleeps.
 *
 *   node scripts/test-gocomet-round-count-restart-safe.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 5;
const STEP = 299_000;
const EXTEND_MS = 300_000;
const MECHANISM = "round count lost across a restart: _observeExtension's 'off' branch counts no GoComet "
  + 'rounds, extendsObserved is in-memory only and no posted close is persisted, so a rehydrated final '
  + 'round is not recognised and no floor goes out at the 5,000 ms buzzer';

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-round-restart-${process.pid}-${seq++}.json`);
  CLEAN.push(f, `${f}.tmp`);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: EXTEND_MS,
  snipeBudgetMs: 4500 };
const INPUTS = { cost: 70_000, marginsPct: [9, 7.2, 1] };
const CFG = { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0, minInterFireMs: 0 };

function engineOn(file, ctrl) {
  const adapter = {
    capabilities: () => ({ ...GOCOMET_CAPS }),
    ensureSession: async () => ({}),
    async getAuctionState() { return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' }; },
    async placeBid(id, price) {
      ctrl.bids.push({ id, price, countdown: ctrl.frame ? ctrl.frame.closesInMs : null });
      return { accepted: true, myRank: 2, latencyMs: 20 };
    },
  };
  return new BidEngine(adapter, new DurableScheduler(file), {
    config: CFG, softClose: { enabled: false, shippers: [], mode: 'live' },
    rand: () => 0.5, onEvent: () => {}, log: quiet,
  });
}

const frame = (closesAtMs, myRank, revisionsLeft) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs,
  closesInMs: closesAtMs - Date.now(), extendMs: EXTEND_MS, extendCount: null, extensionCeiling: null, myRank,
  totalBidders: null, standingL1Price: null, revisionsLeft, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 });

async function tick(eng, m, ctrl, closesAtMs, myRank, revisionsLeft) {
  ctrl.frame = frame(closesAtMs, myRank, revisionsLeft);
  const before = ctrl.bids.length;
  await eng._tick(m);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  return ctrl.bids.slice(before);
}

async function rehydrated(file, ctrl, id) {
  const eng = engineOn(file, ctrl);
  await eng.rehydrate();
  for (const mm of eng.monitors.values()) { if (mm.timer) { clearTimeout(mm.timer); mm.timer = null; } }
  const m = eng.monitors.get(id);
  if (!m) throw new Error(`HARNESS: ${id} was not re-armed by rehydrate()`);
  return { eng, m };
}

/**
 * Seeds the durable intent, runs process 1 through `observed` extensions, restarts at `restartAt`
 * (relative to the posted close) and returns the rehydrated process-2 monitor.
 * observeRank = our rank on the process-1 frames and the first process-2 read.
 */
async function restartCareer({ id, roundPolicy, fired, A, observed, restartAt, observeRank }) {
  const ctrl = { frame: null, bids: [] };
  const file = tmp();
  const posted = REAL_NOW() + 3_600_000;

  vnow = posted - 600_000;
  const e0 = engineOn(file, ctrl);
  const meta = { id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: posted,
    platformKey: 'gocomet', rules: { revisionLimit: 3, minDecrement: 500 } };
  if (roundPolicy !== undefined) meta.roundPolicy = roundPolicy;
  const m0 = e0.arm(meta, INPUTS);
  if (m0.timer) { clearTimeout(m0.timer); m0.timer = null; }
  const ladder = m0.ladder.slice();
  if (ladder.length !== 3) throw new Error(`HARNESS: expected a 3-rung ladder, got ${JSON.stringify(ladder)}`);
  e0.scheduler.update(id, { status: 'bidding', firedRungs: fired, revisionsLeft: A, landedBids: fired.length,
    landedBidPrice: ladder[Math.max(...fired)], everBid: true });
  e0.kill('seeded');

  const p1 = await rehydrated(file, ctrl, id);
  if (p1.m.revisionsLeft !== A || p1.m.currentRungIndex !== Math.max(...fired)) {
    throw new Error(`HARNESS: seeded state not restored (revisionsLeft ${p1.m.revisionsLeft}, rung ${p1.m.currentRungIndex})`);
  }
  let close = posted;
  for (let i = 0; i < observed; i++) {
    vnow = close;
    close += STEP;
    await tick(p1.eng, p1.m, ctrl, close, observeRank, A);
  }
  p1.eng.kill('deploy restart');

  vnow = posted + restartAt;
  const p2 = await rehydrated(file, ctrl, id);
  const preBuzzerBids = ctrl.bids.length;
  return { ...p2, ctrl, ladder, posted, preBuzzerBids };
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

const rungOf = (ladder, price) => {
  const i = ladder.indexOf(price);
  return i < 0 ? `off-ladder ${price}` : (i === ladder.length - 1 ? `FLOOR (${price})` : `rung ${i} (${price})`);
};

// Drives the rehydrated load: first read at the restart instant, then 10,500, then 5,000.
async function driveToBuzzer(r, liveClose, rank, A) {
  const first = await tick(r.eng, r.m, r.ctrl, liveClose, rank, A);
  vnow = liveClose - 10_500;
  const middle = await tick(r.eng, r.m, r.ctrl, liveClose, rank, A);
  vnow = liveClose - 5_000;
  const buzzer = await tick(r.eng, r.m, r.ctrl, liveClose, rank, A);
  return { first, middle, buzzer };
}

async function floorAtBuzzerAfterRestart(opts, story) {
  const r = await restartCareer(opts);
  try {
    if (r.preBuzzerBids !== 0) return `HARNESS: ${r.preBuzzerBids} bid(s) before the restart`;
    const { first, middle, buzzer } = await driveToBuzzer(r, r.posted + opts.liveClose, 2, 1);
    const bad = [];
    if (first.length) bad.push(`first read after restart placed ${first.map((b) => rungOf(r.ladder, b.price)).join(', ')}`);
    if (middle.length) bad.push(`10,500 placed ${middle.map((b) => rungOf(r.ladder, b.price)).join(', ')} (A=1: no middle shot)`);
    if (buzzer.length !== 1 || buzzer[0].price !== r.ladder[2]) {
      bad.push(`5,000 placed [${buzzer.map((b) => rungOf(r.ladder, b.price)).join(', ') || 'nothing'}], expected exactly the FLOOR (${r.ladder[2]})`);
    }
    if (!bad.length) return null;
    return `${story}: ${bad.join('; ')} - ${MECHANISM}`;
  } finally { r.eng.kill('done'); }
}

async function holdsAtBuzzerAfterRestart(opts, story) {
  const r = await restartCareer(opts);
  try {
    if (r.preBuzzerBids !== 0) return `HARNESS: ${r.preBuzzerBids} bid(s) before the restart`;
    const { first, middle, buzzer } = await driveToBuzzer(r, r.posted + opts.liveClose, 2, 1);
    const all = [...first, ...middle, ...buzzer];
    if (!all.length) return null;
    return `${story}: placed ${all.map((b) => `${rungOf(r.ladder, b.price)} at ${b.countdown}`).join(', ')}, expected nothing `
      + '(pre-final round, A=1 keeps the floor for the final round)';
  } finally { r.eng.kill('done'); }
}

async function main() {
  console.log('\nGoComet: the round count survives a restart (PR-T2a, contract 3 / 4)\n');

  await check(1, 'control_restarted_monitor_reaches_bid_path', 'control', async () => {
    const r = await restartCareer({ id: 'GC-RS-CTL', fired: [0], A: 2, observed: 1,
      restartAt: 60_000, observeRank: 1 });
    try {
      if (r.preBuzzerBids !== 0) return `HARNESS: ${r.preBuzzerBids} bid(s) before the restart`;
      const liveClose = r.posted + STEP;
      const first = await tick(r.eng, r.m, r.ctrl, liveClose, 1, 2);
      vnow = liveClose - 5_000;
      const buzzer = await tick(r.eng, r.m, r.ctrl, liveClose, 2, 2);
      if (first.length === 0 && buzzer.length === 1 && buzzer[0].price === r.ladder[1]) return null;
      return `HARNESS DEAD: rehydrated A=2 load, rung 0 standing, outranked at 5,000 placed `
        + `[${buzzer.map((b) => rungOf(r.ladder, b.price)).join(', ') || 'nothing'}] (first read: ${first.length} bid(s)), `
        + `expected exactly rung 1 (${r.ladder[1]}) - the restarted monitor is not reaching the bid path`;
    } finally { r.eng.kill('done'); }
  });

  await check(2, 'observed_count_survives_restart_floor_at_buzzer', 'mechanism', () => floorAtBuzzerAfterRestart(
    { id: 'GC-RS-OBS', fired: [0, 1], A: 1, observed: 3, restartAt: 2 * STEP + 60_000, observeRank: 2, liveClose: 3 * STEP },
    '3 extensions observed in-process, restart inside round 3 (close P+897,000), rank 2, A=1'));

  await check(3, 'count_derived_when_restart_missed_every_extension', 'mechanism', () => floorAtBuzzerAfterRestart(
    { id: 'GC-RS-DRV', fired: [0, 1], A: 1, observed: 0, restartAt: 2 * STEP + 500, observeRank: 2, liveClose: 3 * STEP },
    'engine down for all 3 extensions, first read after restart shows close P+897,000, rank 2, A=1'));

  await check(4, 'prefinal_restart_still_holds', 'guard', () => holdsAtBuzzerAfterRestart(
    { id: 'GC-RS-PRE', fired: [0, 1], A: 1, observed: 2, restartAt: STEP + 60_000, observeRank: 2, liveClose: 2 * STEP },
    'restart inside round 2 (close P+598,000), rank 2, A=1'));

  await check(5, 'load_cap_survives_restart', 'guard', () => holdsAtBuzzerAfterRestart(
    { id: 'GC-RS-CAP4', roundPolicy: { finalAfterExtensions: 4 }, fired: [0, 1], A: 1, observed: 3,
      restartAt: 2 * STEP + 60_000, observeRank: 2, liveClose: 3 * STEP },
    'armed with roundPolicy {finalAfterExtensions: 4}, restart inside round 3, rank 2, A=1 (cap 4 must be restored, not defaulted to 3)'));
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const isHarness = (x) => x.failure && (x.kind === 'control' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const guards = results.filter((x) => x.failure && !isHarness(x) && x.kind === 'guard');
  const mech = results.filter((x) => x.failure && !isHarness(x) && x.kind === 'mechanism');
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the control or the harness is broken, so the results above are not trustworthy`);
    process.exit(1);
  }
  if (guards.length) {
    console.log(`\nFAIL - ${guards.length} guard check(s) (${guards.map((x) => x.n).join(', ')}): a pre-final or cap-4 `
      + 'round took a bid at the buzzer after a restart - the round count or the load\'s own cap was not restored');
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${MECHANISM}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: the GoComet round count survives a restart`);
});
