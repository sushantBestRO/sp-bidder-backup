'use strict';
/**
 * A GoComet round shot is decided on the countdown NOW, not on the countdown a late read carried.
 *
 * Regression target: PR-T2a "GoComet final-round timing", ruling 52 (fresh decision countdown).
 *
 * THE DEFECT. The adapter reads the close exactly (the whole-second snap of ruling 51), but the engine
 * still decides a provisional-close round shot, and aims its next read, on state.closesInMs: the
 * countdown as of the server's stamp. A response that comes back D ms after the stamp is D ms stale
 * when the engine acts on it, and the adapter's own server offset is taken from that same late read
 * (stamp minus arrival), so it cannot correct it. Near the close that costs twice: the read aimed at
 * ~11 s comes back D late but still says 11 s, so the buzzer read is aimed D too late; then the buzzer
 * read is itself D late. The shot goes out at about 6 s - 2D truly left, which is after the close at
 * D = 3 s. Decided fresh (the exact close against the server clock at decision time), the buzzer read
 * is aimed at the real 6 s and the shot goes out on its arrival, about 6 s - D truly left.
 *
 * HOW. The real loop runs (arm/rehydrate -> _schedule -> timer -> _tick -> _cadence) on a fake clock
 * and fake timers, against the REAL GoCometAdapter with its production spacing (minGetIntervalMs
 * 5,000, global 1,000, snipeBudgetMs 4,500) and a stubbed transport. The true close is a whole second;
 * the server stamps current_server_time and computes a ROUNDED bid_closing_in at the same instant.
 * Every GET takes 100 ms out; the response takes 100 ms back, except a read stamped in the last 12 s,
 * whose response is held D ms. Early reads are therefore fast and symmetric (they give the adapter a
 * good clock) and only the tail is late. D in {2,000, 2,500, 3,000} ms; D = 100 is the control. Close
 * phase 0..900 ms step 100. placeBid is stubbed on the adapter: it records the true countdown, accepts
 * and puts us at rank 1. The engine's round-shot debug line records the countdown it decided on.
 *
 * SCENARIOS (A = revisionsLeft)
 *   (i)  round 0, fresh unbid load, default cap 3, A = 3, unranked -> one write, rung 0.
 *   (ii) round 1 (pre-final), rung 0 standing through a rehydrate, rank 3, A = 2 -> one write, rung 1.
 *
 * WHAT MUST NOT MOVE. SP loads (no extensionCeiling declared) never take this path; with a fast tail
 * the shot goes at the buzzer exactly as before (check 2).
 *
 * CHECKS
 *   1. harness: every cell ran through the real adapter spacing, started from the intended state,
 *      held at least one tail response D ms, and raised no tick_error.
 *   2. control: fast tail (D = 100): one write per round, the expected rung, at a true countdown in
 *      (6,500, 12,000], every cell: both scenarios are pre-final rounds, whose shot goes in the middle
 *      band since rulings 40 and 56.
 *   3. mechanism: late tail (D = 2,000-3,000): one write in the round, the expected rung, invoked with
 *      at least B - D - 1,000 truly left (B = the 6,500 buzzer; the 1,000 is one read interval of aim
 *      slack), every cell. Fresh: ~5,900 - D. Stale: ~5,900 - 2D, or after the close.
 *   4. mechanism: in the same cells the countdown the engine decided the round shot on is within 250 ms
 *      of the true countdown at that instant.
 *
 *   node scripts/test-gocomet-decision-countdown-fresh.js
 */
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 4;
const STEP_MS = 299_000;
const RUNWAY_MS = 4_500;
const BUZZER_MS = 6_500;
// named re-pin: round tracker piece C, rulings 40 and 56 - a pre-final round's shot moved from the
// buzzer into the middle band.
const MIDDLE_BAND_MS = 12_000;
const READ_INTERVAL_MS = 1_000;
const DECISION_TOLERANCE_MS = 250;
const ARM_LEAD_MS = 120_000;
const TAIL_MS = 12_000;
const LEG_MS = 100;
const COST = 70_000;
const WAAREE = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const CONTROL_D = LEG_MS;
const DELAYS = [2_000, 2_500, 3_000];
const PHASES = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
const MECHANISM = 'the engine decides a provisional round shot, and aims its next read, on state.closesInMs - the '
  + 'countdown as of the server stamp - and the adapter takes its server offset from that same late read, so a '
  + 'response held D ms leaves the engine D ms behind: the buzzer read is aimed D late and the shot goes at '
  + '~6 s - 2D truly left, after the close at D = 3 s, instead of on the buzzer read at ~6 s - D';

const SCENARIOS = {
  i: { label: '(i) round-0 opening shot', rounds: 0, restore: null, rank: null, revisionsLeft: 3, rung: 0 },
  ii: { label: '(ii) pre-final round 1', rounds: 1, restore: { revisionsLeft: 2 }, rank: 3, revisionsLeft: 2, rung: 1 },
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
  const f = path.join(os.tmpdir(), `gc-fresh-countdown-${process.pid}-${fseq++}.json`);
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

async function runCell(key, D, phase) {
  const sc = SCENARIOS[key];
  timers.clear();
  const posted = BASE_MS + 3_600_000;
  const close = posted + sc.rounds * STEP_MS;
  vnow = close - ARM_LEAD_MS + phase;
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
    const trueMs = close - stamp;
    const secs = trueMs > 0 ? Math.round(trueMs / 1000) : null;
    const back = trueMs > 0 && trueMs <= TAIL_MS ? D : LEG_MS;
    Object.assign(rd, { stamp, trueMs, secs, back });
    const body = { data: { bid_closing_in: secs, vendor_rank: srv.rank, revisions_left: srv.revisionsLeft,
      total_revisions: srv.total, current_server_time: new Date(stamp).toISOString() } };
    await sleep(back);
    rd.arrive = vnow;
    return resp(200, body);
  };
  const adapter = new GoCometAdapter({ token: validToken(), fetchImpl, sleep, now: () => vnow, log: quiet,
    minGetIntervalMs: 5_000, globalMinGetIntervalMs: 1_000, snipeBudgetMs: 4_500 });
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
  const id = `GC-FRESH-${key}-${D}-${phase}`;
  const meta = {
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: posted,
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
    eng.scheduler.update(id, { status: 'bidding', firedRungs: [0], landedBids: 1, everBid: true,
      revisionsLeft: sc.restore.revisionsLeft, landedBidPrice: ladder[0], closesAt: close });
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
  if (m && roundSeen !== sc.rounds) setup.push(`engine counted round ${roundSeen}, expected ${sc.rounds}`);

  return { key, D, phase, close, ladder, reads, writes: writes.filter((w) => w.trueMs > 0), allWrites: writes,
    decisions, events, setup, expectRung: sc.rung };
}

const cells = [];
const rungOf = (c, w) => c.ladder.indexOf(w.price);
const tailOf = (c) => c.reads.filter((r) => r.trueMs != null && r.trueMs <= TAIL_MS + 3_000 && r.trueMs > -2_000)
  .map((r) => `stamp ${(r.trueMs / 1000).toFixed(2)}/arrive ${((c.close - r.arrive) / 1000).toFixed(2)}`).join(', ');
const describeCell = (c) => `${SCENARIOS[c.key].label} D=${c.D} phase=${c.phase}: writes in round ${c.writes.length}`
  + `${c.allWrites.length ? ` [${c.allWrites.map((w) => `rung ${rungOf(c, w)} at true ${w.trueMs}`).join(', ')}]` : ''}; `
  + `decided on ${JSON.stringify(c.decisions.map((d) => ({ engine: d.remainingMs, true: c.close - d.at })))}; `
  + `reads (true s) ${tailOf(c)}`;

function byD(bad, all) {
  const ds = [...new Set(all.map((c) => c.D))];
  return ds.map((D) => `D=${D}: ${bad.filter((c) => c.D === D).length}/${all.filter((c) => c.D === D).length}`).join(', ');
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
  console.log('\nGoComet: a round shot is decided on the countdown now, not on a late read (PR-T2a, ruling 52)\n');
  installClock();

  await check(1, 'harness_every_cell_ran_the_real_adapter_with_a_late_tail', 'control', async () => {
    const probe = new GoCometAdapter({ token: validToken(), log: quiet });
    const caps = probe.capabilities();
    if (!closeIsProvisional(caps) || caps.snipeBudgetMs !== RUNWAY_MS) {
      return `HARNESS: real GoCometAdapter caps do not match the contract: ${JSON.stringify(caps)}`;
    }
    for (const key of Object.keys(SCENARIOS)) {
      for (const D of [CONTROL_D, ...DELAYS]) for (const phase of PHASES) cells.push(await runCell(key, D, phase));
    }
    const bad = [];
    for (const c of cells) {
      const tag = `${c.key} D=${c.D} phase=${c.phase}`;
      if (c.setup.length) bad.push(`${tag}: ${c.setup.join('; ')}`);
      if (c.D !== CONTROL_D && !c.reads.some((r) => r.back === c.D)) bad.push(`${tag}: no tail response was held`);
      if (c.reads.filter((r) => r.trueMs > TAIL_MS).length < 5) bad.push(`${tag}: fewer than 5 fast reads before the tail`);
      const errs = c.events.filter((e) => e.kind === 'tick_error' || e.kind === 'repeated_read_failures');
      if (errs.length) bad.push(`${tag}: ${JSON.stringify(errs.slice(0, 2))}`);
    }
    return bad.length ? `HARNESS: ${bad.length} problems; ${bad.slice(0, 4).join(' | ')}` : null;
  });

  await check(2, 'control_fast_tail_shot_at_the_buzzer_every_cell', 'control', async () => {
    const all = cells.filter((c) => c.D === CONTROL_D);
    if (!all.length) return 'HARNESS: no control cells ran';
    const bad = all.filter((c) => c.writes.length !== 1 || rungOf(c, c.writes[0]) !== c.expectRung
      || c.writes[0].trueMs <= BUZZER_MS || c.writes[0].trueMs > MIDDLE_BAND_MS);
    if (!bad.length) return null;
    return `HARNESS: ${bad.length} of ${all.length} fast-tail cells did not write once in (${BUZZER_MS}, ${MIDDLE_BAND_MS}]; e.g. `
      + bad.slice(0, 2).map(describeCell).join(' || ');
  });

  const late = cells.filter((c) => c.D !== CONTROL_D);

  await check(3, 'late_tail_shot_fires_on_the_buzzer_read_not_after_it', 'mechanism', async () => {
    if (!late.length) return 'HARNESS: no late-tail cells ran';
    const floorFor = (c) => BUZZER_MS - c.D - READ_INTERVAL_MS;
    const bad = late.filter((c) => c.writes.length !== 1 || rungOf(c, c.writes[0]) !== c.expectRung
      || c.writes[0].trueMs < floorFor(c));
    if (!bad.length) return null;
    return `${bad.length} of ${late.length} late-tail cells did not write exactly once with at least `
      + `${BUZZER_MS} - D - ${READ_INTERVAL_MS} truly left (${byD(bad, late)}); e.g. ${bad.slice(0, 3).map(describeCell).join(' || ')}`;
  });

  await check(4, 'round_shot_decided_on_the_true_countdown', 'mechanism', async () => {
    if (!late.length) return 'HARNESS: no late-tail cells ran';
    const bad = late.filter((c) => !c.decisions.length
      || c.decisions.some((d) => !Number.isFinite(d.remainingMs)
        || Math.abs(d.remainingMs - (c.close - d.at)) > DECISION_TOLERANCE_MS));
    if (!bad.length) return null;
    return `${bad.length} of ${late.length} late-tail cells decided the round shot on a countdown more than `
      + `${DECISION_TOLERANCE_MS} ms from the true one (${byD(bad, late)}); e.g. ${bad.slice(0, 3).map(describeCell).join(' || ')}`;
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
  console.log(`\nPASS - ${results.length} checks: a late GoComet read still fires the round shot on the buzzer, `
    + 'decided on the true countdown');
});
