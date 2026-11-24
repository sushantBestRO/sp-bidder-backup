'use strict';
/**
 * A provisional-close (GoComet) load's final round is decided by the load's OWN round cap, not a
 * platform constant.
 *
 * Regression target: PR-T2a contract section 4, from diagnosis timing-E: Waaree's
 * Chikhli / Tumb / Nandigram plants run at most 3 extension rounds, Kutch is uncapped. The engine
 * input is meta.roundPolicy.finalAfterExtensions on arm(), persisted on the durable intent; absent
 * means 3. A round is final iff extensions so far R >= C, and in the final round the buzzer sends the
 * floor (5b). Before the final round, with one attempt left, the load holds (5a).
 *
 * THE DEFECT. softStrategy 'off' (every GoComet enquiry) counts no rounds, so no final-round predicate
 * exists and meta.roundPolicy is read by nothing. An outranked load at the 5,000 ms buzzer falls to
 * _decide branch 4, the clock step-down
 *   next = Math.max(monitor.currentRungIndex + 1, this._scheduledRungIndex(monitor, remaining));
 * which spends the LAST attempt on the non-floor rung below the standing one, whatever the round.
 * The floor is only released inside floorWindowMs (2,500 ms, _isLastChance), after that attempt is
 * gone. 61 of 78 Waaree losses 16-23 Sep had every attempt spent 1-16 min before the real close.
 *
 * ISOLATION. Both trees start each leg from the SAME state, reached through the public restore path:
 * arm() (with meta.roundPolicy, so a fixed engine can persist it) writes the durable intent, the
 * intent is updated to "rung 0 then rung 1 landed" (firedRungs [0, 1], landedBids 2, A = 1), and a new
 * BidEngine over the same DurableScheduler file rehydrate()s it before the posted close. The
 * extensions are then observed live: each frame arrives at the instant the previous close passed and
 * shows the close 299,000 ms later (published increment 300,000), so R is counted in-process and also
 * derivable from the posted close. myRank is 1 on those frames, so neither tree bids between rounds;
 * the rank drops to 2 on the buzzer tick only.
 *
 * The lane.origin values are realistic Waaree plant addresses, but origin resolution is tested
 * elsewhere: here the cap reaches the engine only through meta.roundPolicy. Caps 2 and 4 are not real
 * plant values; they exist to prove the engine reads the load's own number.
 *
 * CHECKS
 *   1. control: an SP hard-close load in the same restored state, rank 2 at 2,000 ms, fires exactly
 *      one placeBid at the floor. Green on both trees; if it fails the harness is not reaching
 *      _decide or placeBid and nothing else here means anything.
 *   2. mechanism: cap 3, 3 extensions (final), rank 2 at 5,000 ms -> exactly one placeBid: the floor.
 *   3. mechanism: cap 3, 2 extensions (pre-final), rank 2, A = 1 at 5,000 ms -> no bid (5a reserve).
 *   4. mechanism: cap 2, 2 extensions (final) -> the floor at the round-2 buzzer.
 *   5. mechanism: cap 4, 3 extensions (pre-final), A = 1 -> no bid at 5,000 ms.
 *   6. mechanism: no meta.roundPolicy, 3 extensions -> the floor at 5,000 ms (default 3).
 *
 * Offline and deterministic: fake adapter mirroring the real gocometAdapter capabilities, temp-file
 * DurableScheduler under os.tmpdir(), stubbed clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-final-round-per-plant.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 6;
const GC_STEP_MS = 299_000;
const BUZZER = 5_000;
const COST = 50_000;
const MARGINS = [9, 7.2, 1.8, 1];
const CHIKHLI = 'Degam (Survey No. 1934, NH-48, Chikhli)';
const CAUSE = "softStrategy 'off' counts no rounds and nothing reads meta.roundPolicy, so there is no "
  + 'final-round predicate: at the buzzer _decide branch 4 (next = max(currentRungIndex + 1, '
  + '_scheduledRungIndex)) spends the last attempt on a non-floor rung, and the floor waits for the '
  + '2,500 ms floorWindowMs';

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

async function restoredLoad({ id, platform = 'gocomet', closeModel = 'soft', origin = CHIKHLI, roundPolicy,
  firedRungs = [0, 1], revisionsLeft = 1, companyName = 'Waaree Energies Ltd' }) {
  const gc = platform === 'gocomet';
  const file = path.join(os.tmpdir(), `gc-final-per-plant-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const ctrl = { close: null, rank: null, revisionsLeft: gc ? revisionsLeft : null };
  const bids = [];
  const frame = () => (gc
    ? { ok: true, status: 'live', closeModel: 'soft', closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
      extendMs: 300_000, extendCount: null, extensionCeiling: null, myRank: ctrl.rank, totalBidders: null,
      standingL1Price: null, revisionsLeft: ctrl.revisionsLeft, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 }
    : { ok: true, status: 'live', closeModel, closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
      myRank: ctrl.rank, totalBidders: null, standingL1Price: null, revisionsLeft: null, revisionLimit: null,
      minDecrement: 500, measuredRttMs: 20 });
  const adapter = {
    capabilities: () => ({ ...(gc ? GOCOMET_CAPS : SP_CAPS) }),
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
    companyName, closesAt: posted, platformKey: gc ? 'gocomet' : 'superprocure',
    rules: { revisionLimit: 3, minDecrement: 500 } };
  if (roundPolicy !== undefined) meta.roundPolicy = roundPolicy;
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
      ctrl.close += GC_STEP_MS;
      ctrl.rank = rank;
      await tick();
    }
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
    if ([...m.firedRungs].sort().join() !== firedRungs.join() || m.currentRungIndex !== want) {
      bad.push(`restored rungs ${JSON.stringify([...m.firedRungs])} / currentRungIndex ${m.currentRungIndex}, `
        + `expected ${JSON.stringify(firedRungs)} / ${want}`);
    }
    if (m.landedBids !== firedRungs.length) bad.push(`landedBids ${m.landedBids}, expected ${firedRungs.length}`);
    if (gc && m.revisionsLeft !== revisionsLeft) bad.push(`revisionsLeft ${m.revisionsLeft}, expected ${revisionsLeft}`);
    if (m.softStrategy !== 'off') bad.push(`softStrategy '${m.softStrategy}', expected 'off'`);
    if (ladder.length !== 4 || m.ladder.join() !== ladder.join()) bad.push(`ladder ${m.ladder}, expected the 4-rung band ${ladder}`);
    if (closeIsProvisional(gc ? GOCOMET_CAPS : SP_CAPS) !== gc) bad.push('closeIsProvisional does not split the two cap shapes');
    return bad.length ? `HARNESS: restored state is wrong: ${bad.join('; ')}` : null;
  };
  const followed = () => (m.believedCloseAt === ctrl.close ? null
    : `HARNESS: the extension frames did not reach the engine (believedCloseAt ${m.believedCloseAt}, live close ${ctrl.close})`);
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { m, ladder, bids, extend, at, harness, followed, done };
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

// One leg: restore, observe `extensions` rounds at rank 1, then the buzzer at rank 2.
async function buzzerLeg({ id, roundPolicy, origin, extensions }) {
  const r = await restoredLoad({ id, roundPolicy, origin });
  const h = r.harness();
  if (h) { r.done(); return { harness: h }; }
  await r.extend(extensions, 1);
  const f = r.followed();
  if (f) { r.done(); return { harness: f }; }
  const between = r.bids.slice();
  await r.at(BUZZER, 2);
  r.done();
  return { between, shots: r.bids.slice(between.length), ladder: r.ladder };
}

const policyText = (p) => (p === undefined ? 'no meta.roundPolicy' : `roundPolicy ${JSON.stringify(p)}`);

async function expectFloor(opts) {
  const leg = await buzzerLeg(opts);
  if (leg.harness) return leg.harness;
  const floor = leg.ladder[leg.ladder.length - 1];
  if (leg.between.length) {
    return `${policyText(opts.roundPolicy)}: bid between rounds while leading ${describe(leg.between, leg.ladder)}`;
  }
  if (leg.shots.length === 1 && leg.shots[0].price === floor) return null;
  return `${policyText(opts.roundPolicy)}, ${opts.extensions} extensions observed (final round), rank 2, A = 1: at the `
    + `${BUZZER} ms buzzer placed ${describe(leg.shots, leg.ladder)}; expected exactly one placeBid at the floor ${floor} - ${CAUSE}`;
}

async function expectHold(opts) {
  const leg = await buzzerLeg(opts);
  if (leg.harness) return leg.harness;
  const all = leg.between.concat(leg.shots);
  if (all.length === 0) return null;
  return `${policyText(opts.roundPolicy)}, ${opts.extensions} extensions observed (pre-final round), rank 2, A = 1: `
    + `placed ${describe(all, leg.ladder)}; expected no bid (the last attempt is the final round's floor) - ${CAUSE}`;
}

async function main() {
  await check(1, 'control_sp_hard_close_outranked_in_floor_window_fires_the_floor', 'control', async () => {
    const r = await restoredLoad({ id: 'SP-HARD-CTL', platform: 'superprocure', closeModel: 'hard',
      origin: 'Bhiwandi', companyName: 'Tata Steel' });
    try {
      const h = r.harness();
      if (h) return h;
      await r.at(2_000, 2);
      const floor = r.ladder[r.ladder.length - 1];
      if (r.bids.length === 1 && r.bids[0].price === floor) return null;
      return `HARNESS DEAD: an SP hard-close load outranked at 2,000 ms placed ${describe(r.bids, r.ladder)}, expected `
        + `exactly one placeBid at the floor ${floor} - the harness is not reaching _decide or placeBid`;
    } finally { r.done(); }
  });

  await check(2, 'cap3_final_round_fires_the_floor_at_the_buzzer', 'mechanism',
    () => expectFloor({ id: 'GC-CAP3-FINAL', roundPolicy: { finalAfterExtensions: 3 }, extensions: 3 }));

  await check(3, 'cap3_round2_holds_the_last_attempt', 'mechanism',
    () => expectHold({ id: 'GC-CAP3-R2', roundPolicy: { finalAfterExtensions: 3 }, extensions: 2 }));

  await check(4, 'cap2_final_round_fires_the_floor_at_the_round2_buzzer', 'mechanism',
    () => expectFloor({ id: 'GC-CAP2-FINAL', roundPolicy: { finalAfterExtensions: 2 }, extensions: 2,
      origin: 'Tumb (GIDC Estate, Umbergaon Road, Tumb)' }));

  await check(5, 'cap4_round3_is_not_final_and_holds', 'mechanism',
    () => expectHold({ id: 'GC-CAP4-R3', roundPolicy: { finalAfterExtensions: 4 }, extensions: 3,
      origin: 'Nandigram (Survey No. 191, Nandigram, Valsad)' }));

  await check(6, 'absent_round_policy_defaults_to_cap3', 'mechanism',
    () => expectFloor({ id: 'GC-NOPOLICY-FINAL', roundPolicy: undefined, extensions: 3 }));
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
  console.log(`\nPASS - ${results.length} checks: a provisional-close load's final round follows its own round cap`);
});
