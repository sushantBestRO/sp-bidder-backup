'use strict';
/**
 * An uncapped provisional-close (GoComet) plant spends one price per round, at the buzzer, and sends
 * the floor with the last attempt.
 *
 * Regression target: owner ruling Q1(a) ("UPDATE
 * 2026-09-24"), pinned against the PR-T2a behaviour contract section 5c. Kutch / Samakhiyali
 * ran up to 9 rounds in the measured window and 24 in July (timing diagnosis, -E-measurements), so
 * on those plants no round can be known final: each round's buzzer is treated as possibly final.
 * Engine input: meta.roundPolicy = { finalAfterExtensions: null }.
 *
 * THE DEFECT. The unfixed engine counts no GoComet rounds (_observeExtension returns early for
 * softStrategy 'off') and runs the non-allowlisted walk on every P-load:
 *   - the soft 'off' establish at the softOpenAtMs mark (~150 s), not at the buzzer;
 *   - _decide branch 4's clock step-down, next = max(currentRungIndex + 1, _scheduledRungIndex),
 *     on every outranked tick, which walks rung 1 and then the 1.8 % rung minutes before the close;
 *   - the floor held for the 2.5 s floorWindowMs release (_isLastChance), which a buzzer read at
 *     5,000 ms never reaches.
 *
 * THE LOAD. Waaree 4-rung band on cost 70,000: margins 9 / 7.2 / 1.8, floor margin 1 ->
 * [76,300, 75,040, 71,260, 70,700]. A = 3. Adapter capabilities mirror the real gocometAdapter
 * (extensionCeiling null, snipeBudgetMs 4,500); frames carry extendMs 300,000 and extendCount null,
 * and each round's close sits 299,000 ms after the previous one. Every round is read at 240,000,
 * 120,000, 10,500 and the 5,000 ms buzzer.
 *   round 0  unranked                        -> rung 0 at the buzzer
 *   round 1  outranked (rank 2)              -> rung 1 (7.2 %) at the buzzer
 *   round 2  rank 2, rank 1 at the buzzer    -> hold (A = 1, and rank 1 is not given away uncapped)
 *   round 3  outranked, A = 1                -> the FLOOR at the buzzer
 *   rounds 4-8 outranked (rank 3), A = 0     -> nothing
 *
 * CHECKS
 *   1. control: an SP hard-close load in the same harness establishes at 20,000 ms and releases the
 *      floor at 2,000 ms when outranked, exactly as deployed. Green on both trees; if it fails the
 *      harness is not reaching _decide or placeBid and nothing else here means anything.
 *   2. mechanism: the write sequence is exactly rung 0 / rung 1 / floor, each at countdown 5,000 in
 *      rounds 0 / 1 / 3; the 1.8 % price never goes on the wire.
 *   3. mechanism: no write at any 10,500 ms tick (no middle shot on an uncapped load).
 *   4. mechanism: at the round-2 buzzer, rank 1 with A = 1, no write.
 *   5. pin: no extend_cap_exceeded alert, no tick_error alert, no throw out of _tick.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-uncapped-plant.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 5;
const STEP_MS = 299_000;
const TICKS = [240_000, 120_000, 10_500, 5_000];
const BUZZER = 5_000;
const MIDDLE = 10_500;
const COST = 70_000;
// Ruling 27: the minimum margin is a guard, never a bid, so the floor rung is carried as the lowest band margin.
const BAND = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const EXPECTED_LADDER = [76_300, 75_040, 71_260, 70_700];
const SCRIPT = [
  { rank: () => null },
  { rank: () => 2 },
  { rank: (c) => (c === BUZZER ? 1 : 2) },
  { rank: () => 2 },
  ...Array(5).fill({ rank: () => 3 }),
];
const CAUSE = "an uncapped provisional-close load runs the non-allowlisted walk (the soft 'off' establish at "
  + "~150 s, _decide branch 4's clock step-down on outranked ticks, the floor held for the 2.5 s "
  + '_isLastChance release) instead of one price per round at the buzzer with the floor on the last attempt';

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
  softClose: { enabled: true, shippers: ['Havells India'], mode: 'live', reserve: 1 },
  rand: () => 0,
  log: quiet,
};

function rig({ caps, id, companyName, platformKey, closeModel, roundPolicy }) {
  const file = path.join(os.tmpdir(), `gc-uncapped-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const events = [];
  const writes = [];
  const throws = [];
  const ctrl = { frame: null, revisionsLeft: caps.revisionLimit, round: null };
  const adapter = {
    capabilities: () => ({ ...caps }),
    async getAuctionState() { return { ...ctrl.frame }; },
    async placeBid(auctionId, price) {
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      writes.push({ price, round: ctrl.round, closesInMs: ctrl.frame.closesInMs });
      return { accepted: true, myRank: ctrl.frame.myRank, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: (e) => events.push(e) });
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 600_000;
  const meta = {
    id, lane: { origin: 'Samakhiyali, Kutch, Gujarat', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName, closesAt: posted, platformKey, rules: { revisionLimit: 3, minDecrement: 500 },
  };
  if (roundPolicy !== undefined) meta.roundPolicy = roundPolicy;
  const m = eng.arm(meta, { cost: COST, ...BAND });
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  const at = async (round, countdown, myRank) => {
    const close = posted + round * STEP_MS;
    vnow = close - countdown;
    ctrl.round = round;
    ctrl.frame = { ok: true, status: 'live', closeModel, closesAtMs: close, closesInMs: close - Date.now(),
      extendMs: closeModel === 'hard' ? 0 : 300_000, extendCount: null, extensionCeiling: null, myRank,
      totalBidders: null, standingL1Price: null, revisionLimit: caps.revisionLimit, minDecrement: 500,
      measuredRttMs: 20 };
    if (ctrl.revisionsLeft != null) ctrl.frame.revisionsLeft = ctrl.revisionsLeft;
    try {
      await eng._tick(m);
    } catch (e) {
      throws.push(`round ${round} at ${countdown}: ${e && e.message}`);
    }
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, events, writes, throws, ctrl, at, done };
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

const describe = (ws, ladder) => (ws.length
  ? ws.map((w) => `round ${w.round}: ${w.price} (rung ${ladder.indexOf(w.price)}) at ${w.closesInMs} ms`).join(', ')
  : 'none');

async function main() {
  await check(1, 'control_sp_hard_close_establish_then_2500ms_floor_release', 'control', async () => {
    const r = rig({ caps: SP_CAPS, id: 'SP-HARD-CTL', companyName: 'Tata Consumer Products', platformKey: null,
      closeModel: 'hard' });
    try {
      if (closeIsProvisional(SP_CAPS)) return 'HARNESS: the SP control reads as provisional-close';
      await r.at(0, 20_000, null);
      await r.at(0, 2_000, 2);
      const lad = r.m.ladder;
      const ok = r.writes.length === 2
        && r.writes[0].price === lad[0] && r.writes[0].closesInMs === 20_000
        && r.writes[1].price === lad[lad.length - 1] && r.writes[1].closesInMs === 2_000;
      if (ok && !r.throws.length) return null;
      return `HARNESS DEAD: SP hard-close control wrote [${describe(r.writes, lad)}], throws [${r.throws.join('; ')}]; `
        + 'expected rung 0 at 20000 ms then the floor at 2000 ms - the harness is not reaching _decide or placeBid';
    } finally { r.done(); }
  });

  const r = rig({ caps: GOCOMET_CAPS, id: 'GC-KUTCH-UNCAPPED', companyName: 'Waaree Energies', platformKey: 'gocomet',
    closeModel: 'soft', roundPolicy: { finalAfterExtensions: null } });
  const lad = r.m.ladder;
  const harness = (() => {
    if (!closeIsProvisional(GOCOMET_CAPS)) return 'HARNESS: the GoComet capabilities do not satisfy closeIsProvisional';
    if (lad.join() !== EXPECTED_LADDER.join()) return `HARNESS: ladder ${lad}, expected the Waaree band ${EXPECTED_LADDER} (ruling 27: the floor rung is the lowest band margin; the minimum margin is never appended as a rung)`;
    if (r.m.softStrategy !== 'off') return `HARNESS: softStrategy '${r.m.softStrategy}', expected 'off'`;
    return null;
  })();
  const aBeforeRound2Buzzer = { value: undefined };
  const round2BuzzerWrites = [];
  if (!harness) {
    for (let round = 0; round < SCRIPT.length; round++) {
      for (const c of TICKS) {
        if (round === 2 && c === BUZZER) aBeforeRound2Buzzer.value = r.m.revisionsLeft;
        const before = r.writes.length;
        await r.at(round, c, SCRIPT[round].rank(c));
        if (round === 2 && c === BUZZER) round2BuzzerWrites.push(...r.writes.slice(before));
      }
    }
  }
  r.done();

  await check(2, 'one_price_per_round_at_the_buzzer_floor_with_the_last_attempt', 'mechanism', async () => {
    if (harness) return harness;
    const expected = [
      { round: 0, price: lad[0], closesInMs: BUZZER },
      { round: 1, price: lad[1], closesInMs: BUZZER },
      { round: 3, price: lad[3], closesInMs: BUZZER },
    ];
    const same = r.writes.length === expected.length && expected.every((e, i) => r.writes[i].round === e.round
      && r.writes[i].price === e.price && r.writes[i].closesInMs === e.closesInMs);
    const sentMiddle = r.writes.some((w) => w.price === lad[2]);
    if (same && !sentMiddle) return null;
    return `uncapped load (roundPolicy finalAfterExtensions null, A = 3) wrote [${describe(r.writes, lad)}]; expected `
      + `[${describe(expected, lad)}]${sentMiddle ? `, and the 1.8 % price ${lad[2]} went on the wire` : ''} - ${CAUSE}`;
  });

  await check(3, 'no_middle_band_shot_on_an_uncapped_load', 'mechanism', async () => {
    if (harness) return harness;
    const mid = r.writes.filter((w) => w.closesInMs === MIDDLE);
    if (!mid.length) return null;
    return `write(s) at the ${MIDDLE} ms middle-band tick: [${describe(mid, lad)}]; an uncapped load takes no middle `
      + `shot (contract 5c) - ${CAUSE}`;
  });

  await check(4, 'rank_1_at_the_buzzer_is_held_on_an_uncapped_load', 'mechanism', async () => {
    if (harness) return harness;
    const a = aBeforeRound2Buzzer.value;
    if (a === 1 && round2BuzzerWrites.length === 0) return null;
    const why = a === 1 ? '' : ` (the attempts were already spent mid-round, so the hold at A = 1 was never tested)`;
    return `round-2 buzzer, rank 1: attempts left before it ${a}, expected 1${why}; write(s) there `
      + `[${describe(round2BuzzerWrites, lad)}], expected none (the floor-at-rank-1 reversal is for a KNOWN final round only) - ${CAUSE}`;
  });

  await check(5, 'no_cap_alert_no_tick_error_no_throw', 'pin', async () => {
    if (harness) return harness;
    const cap = r.events.filter((e) => e.kind === 'extend_cap_exceeded');
    const errs = r.events.filter((e) => e.kind === 'tick_error');
    if (!cap.length && !errs.length && !r.throws.length) return null;
    return `uncapped load raised ${cap.length} extend_cap_exceeded alert(s), ${errs.length} tick_error(s) `
      + `[${errs.map((e) => e.detail).join('; ')}], throws [${r.throws.join('; ')}]`;
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
    console.log(`\nFAIL - HARNESS/PIN: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the mechanism results above are not trustworthy`);
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${CAUSE}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: an uncapped provisional-close plant spends one price per round at the buzzer, floor on the last attempt`);
});
