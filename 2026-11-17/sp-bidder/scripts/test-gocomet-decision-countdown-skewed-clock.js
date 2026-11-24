'use strict';
/**
 * A GoComet round shot is decided on the true countdown when the box clock is 90 s or more from
 * GoComet's.
 *
 * Regression target: PR-T2a "GoComet final-round timing", ruling 52 (fresh decision countdown),
 * follow-up F1.
 *
 * THE DEFECT. The adapter derives closesAtMs from the server's stamp, so the close is on GoComet's
 * clock. Its server offset comes from the shared estimator, which refuses a stamp 90 s or more from
 * the box clock as a bad reading (normalizeServerOffset). When every stamp is refused the adapter's
 * offset stays at its initial 0 and it still publishes serverOffsetMs 0, so the engine's fresh
 * countdown, closesAtMs - (now + serverOffsetMs), is off by the whole skew: with the box behind the
 * round never reaches the buzzer and no shot is sent; with the box ahead the shot goes out a skew early.
 * The same happens when the box clock steps 90 s or more after the estimator has accepted samples: the
 * published offset is the old one while the close is on the new server stamps. The contract says an
 * adapter that publishes no server clock keeps its read countdown, and the read countdown (close minus
 * this read's own stamp) is correct whatever the box clock says.
 *
 * HOW. The real loop runs (arm/rehydrate -> _schedule -> timer -> _tick -> _cadence) on a fake clock
 * and fake timers, against the REAL GoCometAdapter with its production spacing (minGetIntervalMs
 * 5,000, global 1,000, snipeBudgetMs 4,500) and a stubbed transport. The box clock is the fake clock;
 * the server's clock is the box clock plus S. The true close is a whole second; the server stamps
 * current_server_time on its own clock and computes a ROUNDED bid_closing_in at the same instant. Each
 * GET takes 100 ms out and 100 ms back. The load's posted close (meta.closesAt, as discovery reads it)
 * is on the server's clock. S in {-100,000, +100,000} ms, held for the whole auction ("skewed") or
 * switched on 40 s before the close after the estimator has accepted earlier stamps ("stepped");
 * S = 0 is the control. Close phase 0..900 ms step 100. placeBid is stubbed on the adapter: it records
 * the true countdown, accepts and puts us at rank 1. The engine's round-shot debug line records the
 * countdown it decided on.
 *
 * SCENARIOS (A = revisionsLeft; restored loads carry rung 0 landed through a rehydrate)
 *   (i)   round 0, fresh unbid load, default cap 3, A = 3, unranked -> one write, rung 0.
 *   (ii)  round 1 (pre-final), rung 0 standing, rank 3, A = 2 -> one write, rung 1.
 *   (iv)  final round 3, rung 0 standing, rank 1, A = 2 -> one write, the floor.
 *
 * WHAT MUST NOT MOVE. With the box on GoComet's clock the fresh countdown is used exactly as before
 * (check 2). SP loads (no extensionCeiling declared) never take this path.
 *
 * CHECKS
 *   1. harness: every cell ran through the real adapter spacing, started from the intended state,
 *      counted the intended round, read the load before its last 12 s (a control cell at least 5 times,
 *      so the estimator holds samples), raised no tick_error, and its stamps were skewed as intended: every stamp 90 s or more from the box clock (skewed),
 *      or at least one stamp within 90 s before the step and every stamp after it 90 s or more off
 *      (stepped), or every stamp within 90 s (control).
 *   2. control: S = 0: one write per round, the expected rung, at a true countdown in [4,500, 6,500]
 *      for the final round's floor and in (6,500, 12,000] for a pre-final round's shot (the middle
 *      band, since rulings 40 and 56), and the round shot decided on a countdown within 250 ms of the
 *      true one, every cell.
 *   3. mechanism: skewed: the round shot is decided on a countdown within 250 ms of the true one,
 *      every cell.
 *   4. mechanism: skewed: one write per round, the expected rung, sent inside the round at or under
 *      its shot's band (true countdown in (0, 6,500] for the final floor, (0, 12,000] for a pre-final
 *      shot), every cell. The runway is not asserted here: with the
 *      box behind GoComet's clock the adapter's read priority, which measures the close against its own
 *      serverNow(), does not see the load inside its decisive horizon, so the buzzer read keeps the 5 s
 *      per-enquiry spacing and the shot can go under 4,500. That is a separate residual, present before
 *      ruling 52 too, and outside this pin.
 *   5. mechanism: stepped: one write per round, the expected rung, true countdown in the same bands as
 *      check 4, decided on a countdown within 250 ms of the true one, every cell.
 *
 *   node scripts/test-gocomet-decision-countdown-skewed-clock.js
 */
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 5;
const STEP_MS = 299_000;
const RUNWAY_MS = 4_500;
const BUZZER_MS = 6_500;
// Inside the round: a write at or after the close is not in c.writes at all.
const IN_ROUND_MIN_MS = 1;
const DECISION_TOLERANCE_MS = 250;
const REFUSED_SKEW_MS = 90_000;
const ARM_LEAD_MS = 120_000;
const TAIL_MS = 12_000;
const STEP_AT_MS = 40_000;
const LEG_MS = 100;
const COST = 70_000;
const WAAREE = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const SKEWS = [-100_000, 100_000];
const PHASES = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
const MECHANISM = 'when every GoComet stamp is refused as skew (90 s or more from the box clock) the adapter still '
  + 'publishes serverOffsetMs 0 (or the offset from before a clock step) while closesAtMs is on the server clock, so '
  + 'the engine\'s fresh countdown closesAtMs - (now + serverOffsetMs) is off by the whole skew instead of falling '
  + 'back to the read countdown';

const SCENARIOS = {
  i: { label: '(i) round-0 opening shot', rounds: 0, restore: null, rank: null, revisionsLeft: 3,
    rung: () => 0 },
  ii: { label: '(ii) pre-final round 1', rounds: 1, restore: { revisionsLeft: 2 }, rank: 3, revisionsLeft: 2,
    rung: () => 1 },
  iv: { label: '(iv) final-round floor', rounds: 3, restore: { revisionsLeft: 2 }, rank: 1, revisionsLeft: 2,
    rung: (ladder) => ladder.length - 1 },
};

const REAL_NOW = Date.now;
const REAL_SET = global.setTimeout;
const REAL_CLEAR = global.clearTimeout;
const BASE_MS = Math.floor(REAL_NOW() / 3_600_000) * 3_600_000 + 7_200_000;
let vnow = BASE_MS;
const timers = new Map();
let tseq = 0;
function fakeSetTimeout(fn, ms, ...args) {
  const id = ++tseq;
  timers.set(id, { id, at: vnow + Math.max(0, Number(ms) || 0), fn, args });
  return { _fakeId: id, unref() { return this; }, ref() { return this; }, hasRef() { return false; } };
}
function fakeClearTimeout(h) { if (h && h._fakeId != null) timers.delete(h._fakeId); }
function installClock() { Date.now = () => vnow; global.setTimeout = fakeSetTimeout; global.clearTimeout = fakeClearTimeout; }
function restoreClock() { Date.now = REAL_NOW; global.setTimeout = REAL_SET; global.clearTimeout = REAL_CLEAR; }
const yieldReal = () => new Promise((r) => setImmediate(r));

async function runUntil(endAt) {
  for (let steps = 0; steps < 200_000; steps++) {
    for (let i = 0; i < 4; i++) await yieldReal();
    let next = null;
    for (const t of timers.values()) if (!next || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
    if (!next || next.at > endAt) return;
    timers.delete(next.id);
    vnow = Math.max(vnow, next.at);
    next.fn(...next.args);
  }
  throw new Error('HARNESS: fake timer loop did not settle');
}

const CLEAN = [];
let fseq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-skewed-clock-${process.pid}-${fseq++}.json`);
  CLEAN.push(f);
  return f;
};
// DurableScheduler's constructor logs one boot-time info line through a module logger it takes no
// injection for; only that line is muted.
function scheduler(file) {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  try { return new DurableScheduler(file); } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
  }
}
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
function engineLog(decisions) {
  return { ...quiet, child() { return this; },
    debug(msg, ctx) {
      if (/^rung selected: provisional-close round shot/.test(msg)) decisions.push({ at: vnow, remainingMs: ctx && ctx.remainingMs });
    } };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(REAL_NOW() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;
function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

// mode: 'control' (S = 0), 'skewed' (S for the whole auction), 'stepped' (S from STEP_AT_MS before the close).
async function runCell(key, mode, S, phase) {
  const sc = SCENARIOS[key];
  timers.clear();
  const posted = BASE_MS + 3_600_000;
  const close = posted + sc.rounds * STEP_MS;
  vnow = close - ARM_LEAD_MS + phase;
  const skewAt = (boxMs) => (mode === 'skewed' || (mode === 'stepped' && close - boxMs <= STEP_AT_MS) ? S : 0);
  // What discovery would have read: the posted close on the server's clock at arm time.
  const armSkew = skewAt(vnow);
  const srv = { rank: sc.rank, revisionsLeft: sc.revisionsLeft, total: 3 - sc.revisionsLeft };
  const reads = [];
  const writes = [];
  const decisions = [];
  const events = [];
  const sleep = (ms) => new Promise((r) => fakeSetTimeout(r, ms));
  const fetchImpl = async (url) => {
    if (!/\/bidding-data/.test(url)) return resp(404, {});
    const rd = { req: vnow };
    reads.push(rd);
    await sleep(LEG_MS);
    const stamp = vnow;
    const skew = skewAt(stamp);
    const trueMs = close - stamp;
    const secs = trueMs > 0 ? Math.round(trueMs / 1000) : null;
    Object.assign(rd, { stamp, skew, trueMs, secs });
    const body = { data: { bid_closing_in: secs, vendor_rank: srv.rank, revisions_left: srv.revisionsLeft,
      total_revisions: srv.total, current_server_time: new Date(stamp + skew).toISOString() } };
    await sleep(LEG_MS);
    rd.arrive = vnow;
    rd.stampOffBoxMs = stamp + skew - vnow;
    return resp(200, body);
  };
  const adapter = new GoCometAdapter({ token: validToken(), fetchImpl, sleep, now: () => vnow, log: quiet,
    minGetIntervalMs: 5_000, globalMinGetIntervalMs: 1_000, snipeBudgetMs: 4_500 });
  const realRead = adapter.getAuctionState.bind(adapter);
  adapter.getAuctionState = async (auctionId) => {
    const st = await realRead(auctionId);
    const rd = reads[reads.length - 1];
    if (rd && st && st.ok) rd.published = { closesInMs: st.closesInMs, closesAtMs: st.closesAtMs, serverOffsetMs: st.serverOffsetMs };
    return st;
  };
  adapter.placeBid = async (_id, price) => {
    writes.push({ at: vnow, trueMs: close - vnow, price });
    srv.rank = 1;
    srv.revisionsLeft = Math.max(0, srv.revisionsLeft - 1);
    srv.total += 1;
    return { accepted: true, myRank: 1, revisionsLeft: srv.revisionsLeft, latencyMs: 20 };
  };
  const opts = {
    config: { cadenceJitterMs: 0, openJitterMs: 0, softOpenJitterMs: 0 },
    softClose: { enabled: false, shippers: [], mode: 'live' },
    rand: () => 0,
    onEvent: (e) => events.push(e),
    log: engineLog(decisions),
  };
  const id = `GC-SKEW-${key}-${mode}-${S}-${phase}`;
  const meta = {
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: posted + armSkew,
    platformKey: 'gocomet', rules: { revisionLimit: 3, minDecrement: 1000 },
  };
  const file = tmp();
  const setup = [];
  let eng = new BidEngine(adapter, scheduler(file), opts);
  let m = eng.arm(meta, { cost: COST, ...WAAREE });
  const ladder = m.ladder.slice();
  if (sc.restore) {
    eng.kill('test: process restart');
    timers.clear();
    // closesAt is the believed close the engine persists as rounds extend; postedCloseAt stays at arm's value.
    eng.scheduler.update(id, { status: 'bidding', firedRungs: [0], landedBids: 1, everBid: true,
      revisionsLeft: sc.restore.revisionsLeft, landedBidPrice: ladder[0], closesAt: close + armSkew });
    eng = new BidEngine(adapter, scheduler(file), opts);
    await eng.rehydrate();
    m = eng.monitors.get(id);
    if (!m) setup.push('not re-armed by rehydrate()');
    else if (m.currentRungIndex !== 0 || m.landedBids !== 1 || m.revisionsLeft !== sc.restore.revisionsLeft) {
      setup.push(`restored rung ${m.currentRungIndex} landed ${m.landedBids} A ${m.revisionsLeft}`);
    }
  } else if (m.currentRungIndex !== -1 || m.landedBids !== 0) {
    setup.push(`fresh load already bid (currentRungIndex ${m.currentRungIndex})`);
  }
  if (m && !m.provisionalClose) setup.push('monitor is not a provisional-close load');
  if (ladder.length !== 4) setup.push(`ladder has ${ladder.length} rungs, expected 4`);

  await runUntil(close + 5_000);
  const roundSeen = m ? m.extendsObserved : null;
  try { eng.kill('test done'); } catch (_) {}
  timers.clear();
  // named re-pin: round tracker piece B, ruling 56 (e) - a forward step of the server clock 40 s before
  // the close moves the derived close +100 s while bid_closing_in keeps falling, so it is a belief
  // update and never a round: the stepped cells count no round and send the scenario's own rung again
  // (piece A had counted it as one UNCERTAIN round and sent the floor).
  if (m && roundSeen !== sc.rounds) setup.push(`engine counted round ${roundSeen}, expected ${sc.rounds}`);

  return { key, mode, S, phase, close, ladder, reads, writes: writes.filter((w) => w.trueMs > 0), allWrites: writes,
    decisions, events, setup, expectRung: sc.rung(ladder) };
}

const cells = [];
const rungOf = (c, w) => c.ladder.indexOf(w.price);
const fmt = (ms) => (ms == null ? 'null' : (ms / 1000).toFixed(2));
const tailOf = (c) => c.reads.filter((r) => r.trueMs != null && r.trueMs <= TAIL_MS && r.trueMs > 3_000 && r.published)
  .map((r) => `true ${fmt(r.trueMs)} read ${fmt(r.published.closesInMs)} fresh `
    + `${typeof r.published.serverOffsetMs === 'number' ? fmt(r.published.closesAtMs - (r.arrive + r.published.serverOffsetMs)) : 'n/a'}`
    + ` (published offset ${r.published.serverOffsetMs})`).join(', ');
const describeCell = (c) => `${SCENARIOS[c.key].label} ${c.mode} S=${c.S} phase=${c.phase}: writes in round ${c.writes.length}`
  + `${c.allWrites.length ? ` [${c.allWrites.map((w) => `rung ${rungOf(c, w)} at true ${w.trueMs}`).join(', ')}]` : ''}; `
  + `decided on ${JSON.stringify(c.decisions.map((d) => ({ engine: d.remainingMs, true: c.close - d.at })))}; `
  + `reads 12-3 s before the close (s): ${tailOf(c)}`;

function byCell(bad, all) {
  const keys = [...new Set(all.map((c) => `${c.key} S=${c.S}`))];
  return keys.map((k) => `${k}: ${bad.filter((c) => `${c.key} S=${c.S}` === k).length}/${all.filter((c) => `${c.key} S=${c.S}` === k).length}`).join(', ');
}
// named re-pin: round tracker piece C, rulings 40 and 56 - a pre-final round's shot (scenarios i and
// ii) moved from the buzzer into the 12 s middle band; the final round's floor (iv) stays at the buzzer.
const MIDDLE_BAND_MS = 12_000;
const shotMaxMs = (c) => (c.key === 'iv' ? BUZZER_MS : MIDDLE_BAND_MS);
const shotMinMs = (c) => (c.key === 'iv' ? RUNWAY_MS : BUZZER_MS + 1);
const wroteOnce = (c, minMs) => c.writes.length === 1 && rungOf(c, c.writes[0]) === c.expectRung
  && c.writes[0].trueMs >= minMs && c.writes[0].trueMs <= shotMaxMs(c);
const decidedTrue = (c) => c.decisions.length > 0 && c.decisions.every((d) => Number.isFinite(d.remainingMs)
  && Math.abs(d.remainingMs - (c.close - d.at)) <= DECISION_TOLERANCE_MS);

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  console.log('\nGoComet: a round shot is decided on the true countdown when the box clock is 90 s or more off GoComet\'s (PR-T2a, ruling 52, F1)\n');
  installClock();

  await check(1, 'harness_every_cell_ran_the_real_adapter_with_the_intended_skew', 'control', async () => {
    const probe = new GoCometAdapter({ token: validToken(), log: quiet });
    const caps = probe.capabilities();
    if (!closeIsProvisional(caps) || caps.snipeBudgetMs !== RUNWAY_MS) {
      return `HARNESS: real GoCometAdapter caps do not match the contract: ${JSON.stringify(caps)}`;
    }
    for (const key of Object.keys(SCENARIOS)) {
      for (const phase of PHASES) cells.push(await runCell(key, 'control', 0, phase));
      for (const mode of ['skewed', 'stepped']) {
        for (const S of SKEWS) for (const phase of PHASES) cells.push(await runCell(key, mode, S, phase));
      }
    }
    const bad = [];
    for (const c of cells) {
      const tag = `${c.key} ${c.mode} S=${c.S} phase=${c.phase}`;
      if (c.setup.length) bad.push(`${tag}: ${c.setup.join('; ')}`);
      const done = c.reads.filter((r) => r.arrive != null);
      if (!done.some((r) => r.trueMs > TAIL_MS)) bad.push(`${tag}: no read before the last 12 s`);
      if (c.mode === 'control' && done.filter((r) => r.trueMs > TAIL_MS).length < 5) {
        bad.push(`${tag}: fewer than 5 control reads before the last 12 s`);
      }
      const off = (r) => Math.abs(r.stampOffBoxMs) >= REFUSED_SKEW_MS;
      if (c.mode === 'control' && done.some(off)) bad.push(`${tag}: a control stamp was 90 s or more off the box clock`);
      if (c.mode === 'skewed' && !done.every(off)) bad.push(`${tag}: a skewed stamp was within 90 s of the box clock`);
      if (c.mode === 'stepped') {
        const before = done.filter((r) => r.skew === 0);
        const after = done.filter((r) => r.skew !== 0);
        if (!before.some((r) => !off(r))) bad.push(`${tag}: no stamp within 90 s before the step`);
        if (!after.length || !after.every(off)) bad.push(`${tag}: a stamp after the step was within 90 s of the box clock`);
        if (!after.some((r) => r.trueMs > 0 && r.trueMs <= TAIL_MS)) bad.push(`${tag}: no read in the last 12 s after the step`);
      }
      const errs = c.events.filter((e) => e.kind === 'tick_error' || e.kind === 'repeated_read_failures');
      if (errs.length) bad.push(`${tag}: ${JSON.stringify(errs.slice(0, 2))}`);
    }
    return bad.length ? `HARNESS: ${bad.length} problems; ${bad.slice(0, 4).join(' | ')}` : null;
  });

  await check(2, 'control_box_on_the_server_clock_shot_at_the_buzzer_every_cell', 'control', async () => {
    const all = cells.filter((c) => c.mode === 'control');
    if (!all.length) return 'HARNESS: no control cells ran';
    const bad = all.filter((c) => !wroteOnce(c, shotMinMs(c)) || !decidedTrue(c));
    if (!bad.length) return null;
    return `HARNESS: ${bad.length} of ${all.length} control cells did not write once in their shot's band `
      + `([${RUNWAY_MS}, ${BUZZER_MS}] final, (${BUZZER_MS}, ${MIDDLE_BAND_MS}] pre-final) `
      + `decided within ${DECISION_TOLERANCE_MS} ms of the true countdown; e.g. ${bad.slice(0, 2).map(describeCell).join(' || ')}`;
  });

  const skewed = cells.filter((c) => c.mode === 'skewed');
  const stepped = cells.filter((c) => c.mode === 'stepped');

  await check(3, 'skewed_round_shot_decided_on_the_true_countdown', 'mechanism', async () => {
    if (!skewed.length) return 'HARNESS: no skewed cells ran';
    const bad = skewed.filter((c) => !decidedTrue(c));
    if (!bad.length) return null;
    return `${bad.length} of ${skewed.length} skewed cells did not decide the round shot on a countdown within `
      + `${DECISION_TOLERANCE_MS} ms of the true one (${byCell(bad, skewed)}); e.g. ${bad.slice(0, 3).map(describeCell).join(' || ')}`;
  });

  await check(4, 'skewed_round_shot_written_once_in_its_round', 'mechanism', async () => {
    if (!skewed.length) return 'HARNESS: no skewed cells ran';
    const bad = skewed.filter((c) => !wroteOnce(c, IN_ROUND_MIN_MS));
    if (!bad.length) return null;
    return `${bad.length} of ${skewed.length} skewed cells did not write exactly once, at the expected rung, with `
      + `(0, ${BUZZER_MS}] (final) or (0, ${MIDDLE_BAND_MS}] (pre-final) truly left (${byCell(bad, skewed)}); e.g. `
      + bad.slice(0, 3).map(describeCell).join(' || ');
  });

  await check(5, 'stepped_round_shot_decided_on_the_true_countdown_and_written_in_its_round', 'mechanism', async () => {
    if (!stepped.length) return 'HARNESS: no stepped cells ran';
    const bad = stepped.filter((c) => !wroteOnce(c, IN_ROUND_MIN_MS) || !decidedTrue(c));
    if (!bad.length) return null;
    return `${bad.length} of ${stepped.length} stepped cells did not write once in their shot's band decided `
      + `within ${DECISION_TOLERANCE_MS} ms of the true countdown (${byCell(bad, stepped)}); e.g. `
      + bad.slice(0, 3).map(describeCell).join(' || ');
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  restoreClock();
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const isHarness = (x) => x.failure && (x.kind === 'control' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const failed = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the mechanism results above are not trustworthy`);
    process.exit(1);
  }
  if (failed.length) {
    console.log(`\nFAIL - ${failed.length} of ${results.length} checks (${failed.map((x) => x.n).join(', ')}): ${MECHANISM}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: with the box clock 90 s or more off GoComet's, the round shot is `
    + 'decided on the true countdown and sent once in its round');
});
