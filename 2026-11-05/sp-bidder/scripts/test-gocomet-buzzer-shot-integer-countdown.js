'use strict';
/**
 * A GoComet round shot must be sent when GoComet's countdown is a whole number of seconds.
 *
 * Regression target: PR-T2a "GoComet final-round timing", the buzzer no-bid defect (ruling 51).
 *
 * THE DEFECT. GoComet's bid_closing_in is whole seconds, rounded to nearest (captured reads fit
 * rounding; flooring and ceiling are each contradicted). The buzzer B is snipeBudgetMs 4,500 + one
 * 1,000 ms read interval = 5,500: _decideProvisional takes its round shot on the first read at
 * countdown <= 5,500. _maybeBid then holds any NON-floor price on a provisional-close load whose
 * countdown is below the 4,500 write runway. With a whole-second countdown only a read of exactly 5
 * passes both gates. _cadence aims that read at ~5,000 relative to the previous read, so any GET
 * latency lands it on 4 part of the time; the shot is held there, and every later read in the round
 * is lower, so the round never sends. That drops round-0 opening shots, pre-final round shots and
 * uncapped round shots. The final-round floor is exempt from the runway and is always sent.
 *
 * A second, smaller defect sits beside it: the adapter derives the close as server stamp + whole
 * seconds, so a close that is really a whole second reads up to 0.5 s off. Under rounding the close
 * snaps to the nearest whole second.
 *
 * HOW. The real loop runs (arm/rehydrate -> _schedule -> timer -> _tick -> _cadence) on a fake clock
 * (Date.now) and fake timers, against the REAL GoCometAdapter with its production spacing
 * (minGetIntervalMs 5,000, global 1,000, snipeBudgetMs 4,500) and a stubbed transport. The auction's
 * true close is a whole second. Each GET waits L/2, the server stamps current_server_time and computes
 * bid_closing_in at that instant, then the response waits L/2 (the injected fake sleep). Grid:
 * quantisation {round (the evidence), floor} x L {0, 300, 600, 900, 1500, 2000, 2500, 3000} ms x close
 * phase 0..900 ms step 100 (the start instant's sub-second offset against the whole-second close).
 * placeBid is stubbed on the adapter instance: it records the true countdown, accepts, and puts us at
 * rank 1. The cells at L >= 2,000 pin the removed runway hold on its own: there the buzzer read reaches
 * the engine below 4,500 even with the buzzer at 6,500, so a hold loses the round (ruling 51 (c)).
 *
 * SCENARIOS (A = revisionsLeft; restored loads carry rung 0 landed through a rehydrate)
 *   (i)   round 0, fresh unbid load, default cap 3, A = 3, unranked -> one write, rung 0.
 *   (ii)  round 1, rung 0 standing, rank 3, A = 2 -> one write, rung 1.
 *   (iii) uncapped plant (roundPolicy finalAfterExtensions null), round 4, rung 0 standing, rank 3,
 *         A = 2 -> one write, rung 1.
 *   (iv)  final round 3, rung 0 standing, rank 1, A = 2 -> one write, the floor.
 *
 * WHAT MUST NOT MOVE. SP loads (no extensionCeiling declared) never reach the provisional path; the
 * final-round floor is sent at its buzzer whatever the countdown (check 2).
 *
 * CHECKS
 *   1. harness: every cell ran through the real adapter spacing, read the round's last 12 s, started
 *      from the intended state, and raised no tick_error.
 *   2. control: (iv) the final-round floor is written exactly once, every cell.
 *   3. mechanism: (i) the round-0 opening shot is written exactly once, every cell.
 *   4. mechanism: (ii) the pre-final round-1 shot is written exactly once, every cell.
 *   5. mechanism: (iii) the uncapped round shot is written exactly once, every cell.
 *   6. guard: in every (i)-(iii) cell at L <= 900 that wrote, the TRUE countdown when placeBid was
 *      invoked is >= 4,500 (a fix that only removes the hold would write with no runway). Slower reads
 *      cannot leave the runway and are held to checks 3-5 only.
 *   7. mechanism: the adapter's closesAtMs snaps a rounded countdown to the whole-second close
 *      (real captured reads, server stamps carrying milliseconds).
 *   8. mechanism: the adapter's closesInMs on those reads is that close minus the server stamp.
 *
 *   node scripts/test-gocomet-buzzer-shot-integer-countdown.js
 */
for (const k of Object.keys(process.env)) if (/^GC_/.test(k)) delete process.env[k];

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 8;
const STEP_MS = 299_000;
const RUNWAY_MS = 4_500;
const ARM_LEAD_MS = 120_000;
const TAIL_MS = 12_000;
const COST = 70_000;
const WAAREE = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const LATENCIES = [0, 300, 600, 900, 1500, 2000, 2500, 3000];
const LEAD_MAX_L = 900;
const PHASES = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
const QUANT = { rounded: Math.round, floored: Math.floor };
const MECHANISM = 'the buzzer decides at countdown <= 5,500 (snipeBudgetMs 4,500 + 1,000) but _maybeBid holds a '
  + 'non-floor provisional shot below the 4,500 write runway, and GoComet\'s countdown is whole seconds: only a '
  + 'read of exactly 5 passes both, a read of 4 is held, and no later read in the round is higher, so the round '
  + 'never sends';
const LEAD = 'a round shot decided on a whole-second read of 5 (or lower) reaches placeBid with under the 4,500 '
  + 'write runway truly left once the rounding error and the return leg of the read are paid, so the buzzer read has '
  + 'to be aimed earlier than ~5,000';
const SNAP = 'the adapter derives closesAtMs as server stamp + whole seconds instead of snapping the close to the '
  + 'nearest whole second';

const SCENARIOS = {
  i: { label: '(i) round-0 opening shot', rounds: 0, restore: null, rank: null, revisionsLeft: 3,
    cap: 3, roundPolicy: undefined, rung: () => 0 },
  ii: { label: '(ii) pre-final round 1', rounds: 1, restore: { revisionsLeft: 2 }, rank: 3, revisionsLeft: 2,
    cap: 3, roundPolicy: undefined, rung: () => 1 },
  iii: { label: '(iii) uncapped round 4', rounds: 4, restore: { revisionsLeft: 2 }, rank: 3, revisionsLeft: 2,
    cap: null, roundPolicy: { finalAfterExtensions: null }, rung: () => 1 },
  iv: { label: '(iv) final-round floor', rounds: 3, restore: { revisionsLeft: 2 }, rank: 1, revisionsLeft: 2,
    cap: 3, roundPolicy: undefined, rung: (ladder) => ladder.length - 1 },
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
  const f = path.join(os.tmpdir(), `gc-buzzer-integer-${process.pid}-${fseq++}.json`);
  CLEAN.push(f);
  return f;
};
// DurableScheduler's constructor logs one boot-time info line through a module logger it takes no
// injection for; hundreds of constructions would bury the check output, so only that line is muted.
function scheduler(file) {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  try { return new DurableScheduler(file); } finally {
    if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
  }
}
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
function engineLog(holds) {
  return { ...quiet, child() { return this; },
    debug(msg, ctx) { if (/^holding fire/.test(msg)) holds.push(ctx && ctx.remainingMs); } };
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(REAL_NOW() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;
function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

async function runCell(key, quant, L, phase) {
  const sc = SCENARIOS[key];
  timers.clear();
  const posted = BASE_MS + 3_600_000;
  const close = posted + sc.rounds * STEP_MS;
  vnow = close - ARM_LEAD_MS + phase;
  const q = QUANT[quant];
  const srv = { rank: sc.rank, revisionsLeft: sc.revisionsLeft, total: 3 - sc.revisionsLeft };
  const reads = [];
  const writes = [];
  const holds = [];
  const events = [];
  const sleep = (ms) => new Promise((r) => fakeSetTimeout(r, ms));
  const fetchImpl = async (url) => {
    if (!/\/bidding-data/.test(url)) return resp(404, {});
    reads.push({ req: vnow });
    await sleep(L / 2);
    const stamp = vnow;
    const trueMs = close - stamp;
    const secs = trueMs > 0 ? q(trueMs / 1000) : null;
    Object.assign(reads[reads.length - 1], { stamp, trueMs, secs });
    const body = { data: { bid_closing_in: secs, vendor_rank: srv.rank, revisions_left: srv.revisionsLeft,
      total_revisions: srv.total, current_server_time: new Date(stamp).toISOString() } };
    await sleep(L / 2);
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
    log: engineLog(holds),
  };
  const id = `GC-INT-${key}-${quant}-${L}-${phase}`;
  const meta = {
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: posted,
    platformKey: 'gocomet', rules: { revisionLimit: 3, minDecrement: 1000 },
    ...(sc.roundPolicy !== undefined ? { roundPolicy: sc.roundPolicy } : {}),
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
      revisionsLeft: sc.restore.revisionsLeft, landedBidPrice: ladder[0], closesAt: close });
    eng = new BidEngine(adapter, scheduler(file), opts);
    await eng.rehydrate();
    m = eng.monitors.get(id);
    if (!m) setup.push('not re-armed by rehydrate()');
    else {
      if (m.currentRungIndex !== 0 || !m.firedRungs.has(0) || m.landedBids !== 1) {
        setup.push(`restored currentRungIndex ${m.currentRungIndex} landedBids ${m.landedBids}, expected 0 / 1`);
      }
      if (m.revisionsLeft !== sc.restore.revisionsLeft) setup.push(`restored A ${m.revisionsLeft}`);
    }
  } else if (m.currentRungIndex !== -1 || m.landedBids !== 0) {
    setup.push(`fresh load already bid (currentRungIndex ${m.currentRungIndex})`);
  }
  if (m && !m.provisionalClose) setup.push('monitor is not a provisional-close load');
  if (m && eng._finalAfterExtensions(m) !== sc.cap) setup.push(`cap ${eng._finalAfterExtensions(m)}, expected ${sc.cap}`);
  if (ladder.length !== 4) setup.push(`ladder has ${ladder.length} rungs, expected 4`);

  await runUntil(close + 2_000);
  const roundSeen = m ? m.extendsObserved : null;
  try { eng.kill('test done'); } catch (_) {}
  timers.clear();
  if (m && roundSeen !== sc.rounds) setup.push(`engine counted round ${roundSeen}, expected ${sc.rounds}`);

  const inRound = writes.filter((w) => w.trueMs > 0);
  return { key, quant, L, phase, ladder, reads, writes: inRound, holds, events, setup,
    expectRung: sc.rung(ladder) };
}

const cells = [];
function cellsOf(key) { return cells.filter((c) => c.key === key); }
const rungOf = (c, w) => c.ladder.indexOf(w.price);
const tailOf = (c) => c.reads.filter((r) => r.trueMs != null && r.trueMs <= TAIL_MS && r.trueMs > -1_000)
  .map((r) => `${r.secs}(${(r.trueMs / 1000).toFixed(2)})`).join(' ');
const describeCell = (c) => `${c.quant} L=${c.L} phase=${c.phase}: writes ${c.writes.length}`
  + `${c.writes.length ? ` [${c.writes.map((w) => `rung ${rungOf(c, w)} at true ${w.trueMs}`).join(', ')}]` : ''}; `
  + `reads secs(true s) ${tailOf(c)}; held at ${JSON.stringify(c.holds)}`;

function summarise(bad, all) {
  const out = [];
  for (const quant of Object.keys(QUANT)) {
    const parts = LATENCIES.map((L) => {
      const n = bad.filter((c) => c.quant === quant && c.L === L).length;
      const of = all.filter((c) => c.quant === quant && c.L === L).length;
      return `L=${L}: ${n}/${of}`;
    });
    out.push(`${quant} ${parts.join(', ')}`);
  }
  return out.join(' | ');
}

function oneWriteCheck(key) {
  const all = cellsOf(key);
  if (!all.length) return 'HARNESS: no cells ran';
  const bad = all.filter((c) => c.writes.length !== 1 || rungOf(c, c.writes[0]) !== c.expectRung);
  if (!bad.length) return null;
  return `${SCENARIOS[key].label}: ${bad.length} of ${all.length} cells did not write exactly one bid at rung `
    + `${all[0].expectRung} (${summarise(bad, all)}); e.g. ${bad.slice(0, 3).map(describeCell).join(' || ')}`;
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

// Captured 19 Aug 2026 (IST): server stamp, bid_closing_in, and the whole-second close it implies.
const SNAP_READS = [
  { cst: '2026-08-19T12:55:46.282+05:30', secs: 254, close: '2026-08-19T13:00:00.000+05:30' },
  { cst: '2026-08-19T12:52:23.139+05:30', secs: 457, close: '2026-08-19T13:00:00.000+05:30' },
  { cst: '2026-08-19T13:05:21.927+05:30', secs: 276, close: '2026-08-19T13:09:58.000+05:30' },
  { cst: '2026-08-19T13:10:24.516+05:30', secs: 2375, close: '2026-08-19T13:50:00.000+05:30' },
  { cst: '2026-08-19T13:01:10.395+05:30', secs: 2930, close: '2026-08-19T13:50:00.000+05:30' },
];

async function snapReads() {
  const out = [];
  for (const r of SNAP_READS) {
    const stamp = Date.parse(r.cst);
    const fetchImpl = async (url) => {
      if (!/\/bidding-data/.test(url)) return resp(404, {});
      return resp(200, { data: { bid_closing_in: r.secs, vendor_rank: null, revisions_left: 3, total_revisions: 0,
        current_server_time: r.cst } });
    };
    const adapter = new GoCometAdapter({ token: validToken(), fetchImpl, sleep: async () => {}, now: () => stamp + 40,
      log: quiet, minGetIntervalMs: 5_000, globalMinGetIntervalMs: 1_000, snipeBudgetMs: 4_500 });
    const st = await adapter.getAuctionState('4455667');
    out.push({ ...r, stamp, expectClose: Date.parse(r.close), st });
  }
  return out;
}

async function main() {
  console.log('\nGoComet: a round shot is sent under a whole-second countdown (PR-T2a, ruling 51)\n');
  installClock();

  await check(1, 'harness_every_cell_reads_the_round_tail_through_real_adapter_spacing', 'control', async () => {
    const probe = new GoCometAdapter({ token: validToken(), log: quiet });
    const caps = probe.capabilities();
    if (!closeIsProvisional(caps) || caps.snipeBudgetMs !== RUNWAY_MS) {
      return `HARNESS: real GoCometAdapter caps do not match the contract: ${JSON.stringify(caps)}`;
    }
    for (const key of Object.keys(SCENARIOS)) {
      for (const quant of Object.keys(QUANT)) for (const L of LATENCIES) for (const phase of PHASES) {
        cells.push(await runCell(key, quant, L, phase));
      }
    }
    const bad = [];
    for (const c of cells) {
      const tag = `${c.key} ${c.quant} L=${c.L} phase=${c.phase}`;
      if (c.setup.length) bad.push(`${tag}: ${c.setup.join('; ')}`);
      if (!c.reads.some((r) => r.trueMs > 0 && r.trueMs <= TAIL_MS)) bad.push(`${tag}: no live read in the last 12 s`);
      const gaps = c.reads.slice(1).map((r, i) => r.req - c.reads[i].req);
      if (gaps.some((g) => g < 1_000)) bad.push(`${tag}: two GETs < 1,000 ms apart`);
      const errs = c.events.filter((e) => e.kind === 'tick_error' || e.kind === 'repeated_read_failures');
      if (errs.length) bad.push(`${tag}: ${JSON.stringify(errs.slice(0, 2))}`);
    }
    return bad.length ? `HARNESS: ${bad.length} problems; ${bad.slice(0, 4).join(' | ')}` : null;
  });

  await check(2, 'control_final_round_floor_written_exactly_once_every_cell', 'control', async () => {
    const f = oneWriteCheck('iv');
    return f ? `HARNESS: ${f}` : null;
  });

  await check(3, 'round0_opening_shot_written_exactly_once_every_cell', 'mechanism', async () => oneWriteCheck('i'));
  await check(4, 'prefinal_round1_shot_written_exactly_once_every_cell', 'mechanism', async () => oneWriteCheck('ii'));
  await check(5, 'uncapped_round_shot_written_exactly_once_every_cell', 'mechanism', async () => oneWriteCheck('iii'));

  await check(6, 'round_shot_true_countdown_at_placebid_clears_the_write_runway', 'guard', async () => {
    const wrote = cells.filter((c) => c.key !== 'iv' && c.L <= LEAD_MAX_L && c.writes.length);
    if (!wrote.length) return 'VACUOUS: no (i)-(iii) cell wrote';
    const bad = wrote.filter((c) => c.writes.some((w) => w.trueMs < RUNWAY_MS));
    if (!bad.length) return null;
    return `${bad.length} of ${wrote.length} writing cells at L <= ${LEAD_MAX_L} invoked placeBid with under ${RUNWAY_MS} ms truly left `
      + `(${summarise(bad, wrote)}); e.g. `
      + bad.slice(0, 3).map((c) => `${SCENARIOS[c.key].label} ${describeCell(c)}`).join(' || ');
  });

  restoreClock();
  const snaps = await snapReads();

  await check(7, 'adapter_close_snaps_to_the_nearest_whole_second', 'mechanism', async () => {
    const bad = snaps.filter((s) => s.st.closesAtMs !== s.expectClose);
    if (!bad.length) return null;
    return `${bad.length} of ${snaps.length} captured reads: ${bad.map((s) => `${s.cst} / ${s.secs} s -> closesAtMs `
      + `${new Date(s.st.closesAtMs).toISOString()}, expected ${new Date(s.expectClose).toISOString()}`).join('; ')}`;
  });

  await check(8, 'adapter_countdown_is_the_snapped_close_minus_the_server_stamp', 'mechanism', async () => {
    const bad = snaps.filter((s) => s.st.closesInMs !== s.expectClose - s.stamp);
    if (!bad.length) return null;
    return `${bad.length} of ${snaps.length} captured reads: ${bad.map((s) => `${s.cst} / ${s.secs} s -> closesInMs `
      + `${s.st.closesInMs}, expected ${s.expectClose - s.stamp}`).join('; ')}`;
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
    const causes = [];
    if (failed.some((x) => x.n >= 3 && x.n <= 5)) causes.push(MECHANISM);
    if (failed.some((x) => x.n === 6)) causes.push(LEAD);
    if (failed.some((x) => x.n >= 7)) causes.push(SNAP);
    console.log(`\nFAIL - ${failed.length} of ${results.length} checks (${failed.map((x) => x.n).join(', ')}): `
      + causes.join('; and '));
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: every GoComet round shot is sent with its write runway, and the `
    + 'close snaps to the whole second');
});
