'use strict';
/**
 * A capped provisional-close (GoComet) load that runs past its cap treats each extra round as final
 * and raises one internal extend_cap_exceeded alert per load.
 *
 * Regression target: PR-T2a behaviour contract sections 4 and 5f (build plan B.0 / PR-T2a,
 * "BUILD PLAN 2026-09-24"). A plant whose cap
 * changed has to show up on the log and the dashboard: the existing kind 'extend_cap_exceeded',
 * which no notifier route consumes. Engine input: meta.roundPolicy = { finalAfterExtensions: C };
 * absent means C = 3; null means uncapped and never alerts.
 *
 * THE DEFECT. _observeExtension opens its softStrategy 'off' branch (every GoComet enquiry) with a
 * belief-only update and returns: "rounds are not counted and nothing is emitted". So no
 * extend_cap_exceeded event can exist for a GoComet load however far past its cap it runs, and the
 * engine has no final-round floor at the buzzer: a past-cap round runs branch 4's clock step-down,
 * which sends a middle rung, and the floor waits for the 2.5 s _isLastChance release.
 *
 * THE LOAD. Waaree 4-rung band on cost 70,000: margins 9 / 7.2 / 1.8, floor margin 1 ->
 * [76,300, 75,040, 71,260, 70,700], A = 3. Adapter capabilities mirror the real gocometAdapter
 * (extensionCeiling null, snipeBudgetMs 4,500); frames carry extendMs 300,000 and extendCount null,
 * and each round's close sits 299,000 ms after the previous one.
 *
 * CHECKS
 *   1. control: an allowlisted SuperProcure soft load publishing cap 2 (extendCount 2), extended three
 *      times, raises exactly one extend_cap_exceeded {extendsObserved 3, cap 2}. Green on both trees;
 *      proves the event capture and the extension frames reach the engine.
 *   Leg A, cap 3: rung 0 at the round-0 buzzer, rank 1 through rounds 1-2, outranked in round 3 and
 *   read at 5,000 and 2,000 ms, so the floor is accepted in round 3 on either tree (at the buzzer
 *   after the fix, at the 2.5 s release before it). Then a 4th and a 5th extension, rank 2, read at
 *   10,500 / 5,000 / 2,000 ms.
 *   2. pin: no write in round 4 (the floor stands) and no throw / tick_error.
 *   3. mechanism: after round 4, EXACTLY ONE {type 'alert', level 'warn', kind 'extend_cap_exceeded',
 *      extendsObserved 4, cap 3}.
 *   4. mechanism: after round 5, still exactly one extend_cap_exceeded in total, and no write.
 *   Leg C, cap 3: rung 0 at the round-0 buzzer, rank 1 through rounds 1-3 with round 3 read only at
 *   10,500 ms (its buzzer read is missed, so the floor is never sent), then a 4th extension, rank 2,
 *   A = 2, read at the 5,000 ms buzzer.
 *   5. mechanism: the write at the round-4 buzzer is the floor.
 *   6. mechanism: roundPolicy absent, 4 extensions read at 240,000 ms -> exactly one alert, cap 3,
 *      extendsObserved 4.
 *   7. pin: roundPolicy { finalAfterExtensions: null }, 9 extensions -> zero extend_cap_exceeded.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-past-cap.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 7;
const GC_STEP_MS = 299_000;
const SP_STEP_MS = 180_000;
const COST = 70_000;
// Ruling 27: the minimum margin is a guard, never a bid, so the floor rung is carried as the lowest band margin.
const BAND = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const EXPECTED_LADDER = [76_300, 75_040, 71_260, 70_700];
const ALERT_CAUSE = "_observeExtension returns early for softStrategy 'off' (every GoComet load): rounds are not "
  + 'counted and nothing is emitted, so a capped provisional-close load running past its cap raises no '
  + 'extend_cap_exceeded';
const FINAL_CAUSE = 'a past-cap round is not treated as final: the unfixed engine has no final-round floor at the '
  + "buzzer and runs _decide branch 4's clock step-down instead";

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

function rig({ caps, id, companyName, platformKey, roundPolicy, stepMs, extendMs, extendCount }) {
  const file = path.join(os.tmpdir(), `gc-past-cap-${process.pid}-${seq++}.json`);
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
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Hosur' }, equipment: '32ft SXL',
    units: 1, quoteType: 'FTL', companyName, closesAt: posted, platformKey,
    rules: { revisionLimit: 3, minDecrement: 500 },
  };
  if (roundPolicy !== undefined) meta.roundPolicy = roundPolicy;
  const m = eng.arm(meta, { cost: COST, ...BAND });
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  const at = async (round, countdown, myRank) => {
    const close = posted + round * stepMs;
    vnow = close - countdown;
    ctrl.round = round;
    ctrl.frame = { ok: true, status: 'live', closeModel: 'soft', closesAtMs: close, closesInMs: close - Date.now(),
      extendMs, extendCount, extensionCeiling: null, myRank, totalBidders: null, standingL1Price: null,
      revisionLimit: caps.revisionLimit, minDecrement: 500, measuredRttMs: 20 };
    if (ctrl.revisionsLeft != null) ctrl.frame.revisionsLeft = ctrl.revisionsLeft;
    try {
      await eng._tick(m);
    } catch (e) {
      throws.push(`round ${round} at ${countdown}: ${e && e.message}`);
    }
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const capAlerts = () => events.filter((e) => e.kind === 'extend_cap_exceeded');
  const tickErrors = () => events.filter((e) => e.kind === 'tick_error');
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, events, writes, throws, ctrl, at, capAlerts, tickErrors, done };
}

const gcRig = (id, roundPolicy) => {
  const r = rig({ caps: GOCOMET_CAPS, id, companyName: 'Waaree Energies', platformKey: 'gocomet', roundPolicy,
    stepMs: GC_STEP_MS, extendMs: 300_000, extendCount: null });
  const bad = [];
  if (!closeIsProvisional(GOCOMET_CAPS)) bad.push('the GoComet capabilities do not satisfy closeIsProvisional');
  if (r.m.ladder.join() !== EXPECTED_LADDER.join()) bad.push(`ladder ${r.m.ladder}, expected ${EXPECTED_LADDER} (ruling 27: the floor rung is the lowest band margin; the minimum margin is never appended as a rung)`);
  if (r.m.softStrategy !== 'off') bad.push(`softStrategy '${r.m.softStrategy}', expected 'off'`);
  r.harness = bad.length ? `HARNESS: ${bad.join('; ')}` : null;
  return r;
};

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind.startsWith('mechanism') ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

const describe = (ws, ladder) => (ws.length
  ? ws.map((w) => `round ${w.round}: ${w.price} (rung ${ladder.indexOf(w.price)}) at ${w.closesInMs} ms`).join(', ')
  : 'none');
const alertText = (as) => (as.length
  ? as.map((a) => `{level ${a.level}, extendsObserved ${a.extendsObserved}, cap ${a.cap}}`).join(', ')
  : 'none');
const isTheAlert = (a, id, observed, cap) => a.type === 'alert' && a.level === 'warn' && a.auctionId === id
  && a.extendsObserved === observed && a.cap === cap;

async function main() {
  await check(1, 'control_sp_allowlisted_soft_past_published_cap_alerts_once', 'control', async () => {
    const r = rig({ caps: SP_CAPS, id: 'SP-SOFT-CTL', companyName: 'Havells India', platformKey: null,
      stepMs: SP_STEP_MS, extendMs: SP_STEP_MS, extendCount: 2 });
    try {
      if (r.m.softStrategy === 'off') return "HARNESS: the allowlisted SP control resolved softStrategy 'off'";
      for (let round = 0; round <= 3; round++) await r.at(round, 170_000, null);
      const as = r.capAlerts();
      if (as.length === 1 && isTheAlert(as[0], 'SP-SOFT-CTL', 3, 2) && !r.writes.length && !r.throws.length) return null;
      return `HARNESS DEAD: SP soft control (cap 2, 3 extensions) raised [${alertText(as)}], wrote `
        + `[${describe(r.writes, r.m.ladder)}], throws [${r.throws.join('; ')}]; expected one alert {3, cap 2} and no `
        + 'write - the extension frames or the event capture are not reaching the engine';
    } finally { r.done(); }
  });

  const a = gcRig('GC-PASTCAP-A', { finalAfterExtensions: 3 });
  const lad = a.m.ladder;
  let aPre = a.harness;
  const round4 = [];
  const round5 = [];
  let alertsAfter4 = [];
  if (!aPre) {
    await a.at(0, 5_000, null);
    await a.at(1, 5_000, 1);
    await a.at(2, 5_000, 1);
    await a.at(3, 5_000, 2);
    await a.at(3, 2_000, 2);
    const floorIn3 = a.writes.filter((w) => w.round === 3 && w.price === lad[3]);
    if (floorIn3.length !== 1) {
      aPre = `HARNESS: leg A expected the floor accepted exactly once in round 3 on either tree; writes were `
        + `[${describe(a.writes, lad)}]`;
    } else {
      for (const c of [10_500, 5_000, 2_000]) {
        const before = a.writes.length;
        await a.at(4, c, 2);
        round4.push(...a.writes.slice(before));
      }
      alertsAfter4 = a.capAlerts().slice();
      for (const c of [10_500, 5_000, 2_000]) {
        const before = a.writes.length;
        await a.at(5, c, 2);
        round5.push(...a.writes.slice(before));
      }
    }
  }
  a.done();

  await check(2, 'floor_stands_past_the_cap_no_bid_no_throw', 'pin', async () => {
    if (aPre) return aPre;
    const errs = a.tickErrors();
    if (!round4.length && !errs.length && !a.throws.length) return null;
    return `round 4 (past cap 3, our floor standing, rank 2) wrote [${describe(round4, lad)}], tick_error(s) `
      + `[${errs.map((e) => e.detail).join('; ')}], throws [${a.throws.join('; ')}]; expected no write and no throw`;
  });

  await check(3, 'one_extend_cap_exceeded_alert_when_the_4th_extension_passes_cap_3', 'mechanism', async () => {
    if (aPre) return aPre;
    if (alertsAfter4.length === 1 && isTheAlert(alertsAfter4[0], 'GC-PASTCAP-A', 4, 3)) return null;
    return `after the 4th extension on a cap-3 GoComet load: extend_cap_exceeded alerts [${alertText(alertsAfter4)}]; `
      + `expected exactly one {type 'alert', level 'warn', extendsObserved 4, cap 3} - ${ALERT_CAUSE}`;
  });

  await check(4, 'cap_alert_is_once_per_load_through_the_5th_extension', 'mechanism', async () => {
    if (aPre) return aPre;
    const as = a.capAlerts();
    if (as.length === 1 && isTheAlert(as[0], 'GC-PASTCAP-A', 4, 3) && !round5.length) return null;
    return `after the 5th extension: extend_cap_exceeded alerts [${alertText(as)}] (expected exactly one, `
      + `{extendsObserved 4, cap 3}), round-5 write(s) [${describe(round5, lad)}] (expected none) - ${ALERT_CAUSE}`;
  });

  await check(5, 'a_past_cap_round_is_final_floor_at_the_round_4_buzzer', 'mechanism', async () => {
    const c = gcRig('GC-PASTCAP-C', { finalAfterExtensions: 3 });
    try {
      if (c.harness) return c.harness;
      await c.at(0, 5_000, null);
      await c.at(1, 5_000, 1);
      await c.at(2, 5_000, 1);
      await c.at(3, 10_500, 1);
      const pre = describe(c.writes, lad);
      if (c.writes.length !== 1 || c.writes[0].price !== lad[0] || c.m.revisionsLeft !== 2) {
        return `HARNESS: leg C expected only rung 0 on the wire and A = 2 entering round 4; writes [${pre}], `
          + `A = ${c.m.revisionsLeft}`;
      }
      const before = c.writes.length;
      await c.at(4, 5_000, 2);
      const shot = c.writes.slice(before);
      if (shot.length === 1 && shot[0].price === lad[3] && !c.throws.length) return null;
      return `round 4 of a cap-3 load (past cap, floor never sent, A = 2, rank 2) wrote [${describe(shot, lad)}] at the `
        + `5000 ms buzzer, throws [${c.throws.join('; ')}]; expected exactly the floor ${lad[3]} - ${FINAL_CAUSE}`;
    } finally { c.done(); }
  });

  await check(6, 'absent_round_policy_behaves_as_cap_3', 'mechanism', async () => {
    const d = gcRig('GC-PASTCAP-DEFAULT', undefined);
    try {
      if (d.harness) return d.harness;
      for (let round = 0; round <= 4; round++) await d.at(round, 240_000, null);
      const as = d.capAlerts();
      if (as.length === 1 && isTheAlert(as[0], 'GC-PASTCAP-DEFAULT', 4, 3) && !d.writes.length) return null;
      return `no roundPolicy, 4 extensions: extend_cap_exceeded alerts [${alertText(as)}], writes `
        + `[${describe(d.writes, lad)}]; expected one alert {extendsObserved 4, cap 3} and no write - ${ALERT_CAUSE}`;
    } finally { d.done(); }
  });

  await check(7, 'uncapped_load_never_raises_the_cap_alert', 'pin', async () => {
    const u = gcRig('GC-PASTCAP-UNCAPPED', { finalAfterExtensions: null });
    try {
      if (u.harness) return u.harness;
      for (let round = 0; round <= 9; round++) await u.at(round, 240_000, null);
      const as = u.capAlerts();
      if (!as.length && !u.throws.length) return null;
      return `uncapped load, 9 extensions: extend_cap_exceeded alerts [${alertText(as)}], throws [${u.throws.join('; ')}]; `
        + 'expected none';
    } finally { u.done(); }
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
    const causes = [];
    if (mech.some((x) => x.n !== 5)) causes.push(ALERT_CAUSE);
    if (mech.some((x) => x.n === 5)) causes.push(FINAL_CAUSE);
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${causes.join('; ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: a capped provisional-close load past its cap treats the round as final and alerts once`);
});
