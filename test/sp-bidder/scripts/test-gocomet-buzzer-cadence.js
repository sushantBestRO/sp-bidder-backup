'use strict';
/**
 * The engine's own poll schedule must put a GoComet state read on every round's buzzer.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract
 * sections 2 and 5g (rulings: BUILD PLAN 2026-09-24). Base d3bf803.
 *
 * THE DEFECT. The buzzer decision is taken on the first tick at countdown <= 5,500 (snipeBudgetMs
 * 4,500 + one 1,000 ms read interval), so a read has to land in (4,500, 5,500]. _cadence never aims
 * at that band: while a softStrategy 'off' load is unestablished it aims only at the 150 s soft
 * establish mark, and otherwise it strides the far/mid/hot buckets (30 s / 1 s / 200 ms) with no
 * buzzer target, and _decisiveBandFor returns null for 'off' loads. Under the GoComet adapter's
 * spacing (5 s per enquiry, 1 s once inside its 5,500 ms decisive horizon) the reads then fall on a
 * 5 s grid whose phase is set by where the round's first read happened to land, so whether any read
 * reaches the band is luck of phase - the same shape as SP's B4 (a 2,500 ms band against a 30,000 ms
 * stride, reached on 8.4% of loads).
 *
 * HOW. The real loop runs: arm() -> _schedule -> timer -> _tick -> _cadence, on a fake clock
 * (Date.now) and fake timers (global setTimeout/clearTimeout), against the REAL GoCometAdapter
 * with its production spacing (minGetIntervalMs 5,000, global ceiling 1,000, snipeBudgetMs 4,500)
 * and a stubbed transport serving bidding-data from an in-file auction. Every bidding-data GET is
 * recorded with the countdown it returned. placeBid is stubbed on the adapter instance (it records,
 * accepts, and consumes no read slot), which can only make reads MORE available than live.
 *
 * THE CAREER. 4 rounds: rounds 0-2 each extended by a rival bid at a fixed countdown (+299,000 ms),
 * round 3 final (cap 3). Round 0 is entered never-bid; after our first bid we hold rank 1 through
 * rounds 1-2 (A stays 2), and in round 3 a rival sits above us until we bid again. Extensions are
 * scripted, independent of our bids, so base and fix see the same four rounds. The career is swept
 * over the per-load jitter roll and the rival's extension instant, because a single career would
 * only prove what one phase does; the claim is "every round, every phase".
 *
 * CHECKS
 *   1. control: an SP hard-close load under the same harness gets a read at countdown <= 2,500.
 *   2. harness: every GoComet career read all four rounds live, through the real adapter spacing,
 *      with no tick_error and no starved read.
 *   3. mechanism: round 0 (entered never-bid) gets a read in (4,500, 5,500], every career.
 *   4. mechanism: rounds 1-3 (established) each get a read in (4,500, 5,500], every career.
 *   5. mechanism: the final round (A = 2) gets a read in (5,500, 12,000] before its buzzer read.
 *
 *   node scripts/test-gocomet-buzzer-cadence.js
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
const FINAL_ROUND = 3;
const BUZZER_LO = 4_500;
const BUZZER_HI = 5_500;
const MIDDLE_HI = 12_000;
const SP_FLOOR_WINDOW = 2_500;
const ARM_BEFORE_CLOSE = 1_200_000;
const ROLLS = [0, 0.2, 0.4, 0.6, 0.8];
const RIVAL_AT = [1_000, 1_700, 2_400, 3_100, 3_800];
const MECHANISM = '_cadence aims only at the 150 s soft establish mark while a softStrategy \'off\' load is '
  + 'unestablished and otherwise strides far/mid/hot (30 s / 1 s / 200 ms) with no buzzer target '
  + '(_decisiveBandFor is null for \'off\' loads), so under GoComet\'s 5 s per-enquiry read spacing a read '
  + 'lands in the (4,500, 5,500] buzzer band only by luck of phase';

const REAL_NOW = Date.now;
const REAL_SET = global.setTimeout;
const REAL_CLEAR = global.clearTimeout;
let vnow = REAL_NOW();
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
  const f = path.join(os.tmpdir(), `gc-buzzer-cadence-${process.pid}-${fseq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(REAL_NOW() / 1000) + 30 * 86400, user_id: 'u1' })}.sig`;
function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function auction(postedClose, rivalAt) {
  const closes = [0, 1, 2, 3].map((k) => postedClose + k * STEP_MS);
  const extendAt = [0, 1, 2].map((k) => closes[k] - rivalAt);
  const bids = [];
  const reads = [];
  const roundAt = (t) => extendAt.filter((x) => x <= t).length;
  const rank = (t) => {
    const k = roundAt(t);
    if (!bids.length) return null;
    if (k < FINAL_ROUND) return 1;
    return bids.some((b) => b.round === FINAL_ROUND) ? 1 : 2;
  };
  const revisionsLeft = () => Math.max(0, 3 - bids.length);
  return { closes, bids, reads, roundAt, rank, revisionsLeft, closeAt: (t) => closes[roundAt(t)] };
}

function gocometRig(roll, rivalAt) {
  const postedClose = vnow + ARM_BEFORE_CLOSE;
  const a = auction(postedClose, rivalAt);
  const events = [];
  const fetchImpl = async (url) => {
    if (!/\/bidding-data/.test(url)) return resp(404, {});
    const round = a.roundAt(vnow);
    const countdown = a.closeAt(vnow) - vnow;
    a.reads.push({ at: vnow, round, countdown });
    return resp(200, { data: {
      bid_closing_in: countdown > 0 ? countdown / 1000 : null,
      vendor_rank: a.rank(vnow), revisions_left: a.revisionsLeft(), total_revisions: a.bids.length,
      current_server_time: new Date(vnow).toISOString(),
    } });
  };
  const sleep = (ms) => new Promise((r) => fakeSetTimeout(r, ms));
  const adapter = new GoCometAdapter({ token: validToken(), fetchImpl, sleep, now: () => vnow, log: quiet,
    minGetIntervalMs: 5_000, globalMinGetIntervalMs: 1_000, snipeBudgetMs: 4_500 });
  adapter.placeBid = async (_id, price) => {
    a.bids.push({ at: vnow, round: a.roundAt(vnow), countdown: a.closeAt(vnow) - vnow, price });
    return { accepted: true, myRank: a.rank(vnow), revisionsLeft: a.revisionsLeft(), latencyMs: 20 };
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { cadenceJitterMs: 0 },
    softClose: { enabled: false, shippers: [], mode: 'live' },
    rand: () => roll,
    onEvent: (e) => events.push(e),
    log: quiet,
  });
  return { a, adapter, eng, events, postedClose };
}

async function gocometCareer(roll, rivalAt) {
  timers.clear();
  const r = gocometRig(roll, rivalAt);
  r.eng.arm({
    id: `GC-CAD-${roll}-${rivalAt}`, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: r.postedClose,
    platformKey: 'gocomet', rules: { revisionLimit: 3, minDecrement: 1000 },
  }, { cost: 70_000, marginsPct: [9, 7.2, 1.8, 1] });
  await runUntil(r.a.closes[FINAL_ROUND] + 2_000);
  try { r.eng.kill('test done'); } catch (_) {}
  timers.clear();
  return { roll, rivalAt, ...r };
}

function roundsOf(career) {
  return [0, 1, 2, 3].map((k) => {
    const live = career.a.reads.filter((x) => x.round === k && x.countdown > 0);
    const buzzer = live.find((x) => x.countdown > BUZZER_LO && x.countdown <= BUZZER_HI) || null;
    const middle = live.find((x) => x.countdown > BUZZER_HI && x.countdown <= MIDDLE_HI
      && (!buzzer || x.at < buzzer.at)) || null;
    const tail = live.filter((x) => x.countdown <= MIDDLE_HI + 3_000).map((x) => x.countdown);
    return { k, live: live.length, buzzer, middle, tail };
  });
}

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

const describeMiss = (c, rd) => `roll=${c.roll} rivalAt=${c.rivalAt} round ${rd.k}: reads at countdown ${JSON.stringify(rd.tail)}`;

async function main() {
  console.log('\nGoComet: a read on every round\'s buzzer under the engine\'s own cadence (PR-T2a, contract 2 / 5g)\n');
  installClock();

  await check(1, 'control_sp_hard_close_cadence_reaches_its_floor_window', 'control', async () => {
    timers.clear();
    const close = vnow + ARM_BEFORE_CLOSE;
    const reads = [];
    const caps = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' };
    if (closeIsProvisional(caps)) return 'HARNESS: SP hard-close caps read as provisional';
    const adapter = {
      capabilities: () => ({ ...caps }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        const cd = close - vnow;
        reads.push(cd);
        return { ok: true, status: cd > 0 ? 'live' : 'closed', closeModel: 'hard', closesAtMs: close,
          closesInMs: Math.max(0, cd), myRank: 2, totalBidders: 3, standingL1Price: null, revisionsLeft: 3,
          minDecrement: 500, measuredRttMs: 20 };
      },
      async placeBid() { return { accepted: true, myRank: 1, latencyMs: 20 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { cadenceJitterMs: 0 }, softClose: { enabled: false, shippers: [], mode: 'live' },
      rand: () => 0, onEvent: () => {}, log: quiet,
    });
    eng.arm({ id: 'SP-HARD-CTL', lane: { origin: 'A', destination: 'B' }, units: 1, quoteType: 'FTL',
      companyName: 'Havells', closesAt: close, platformKey: 'superprocure' }, { cost: 70_000, marginsPct: [9, 7.2, 1.8, 1] });
    await runUntil(close + 5_000);
    try { eng.kill('test done'); } catch (_) {}
    timers.clear();
    if (reads.some((cd) => cd > 0 && cd <= SP_FLOOR_WINDOW)) return null;
    return `HARNESS: SP hard-close load never read inside its ${SP_FLOOR_WINDOW} ms floor window; last reads `
      + `${JSON.stringify(reads.filter((cd) => cd <= 15_000))}`;
  });

  const careers = [];
  await check(2, 'harness_every_career_reads_all_four_rounds_through_real_adapter_spacing', 'control', async () => {
    const probe = new GoCometAdapter({ token: validToken(), log: quiet });
    const caps = probe.capabilities();
    if (!closeIsProvisional(caps) || caps.snipeBudgetMs !== 4_500 || caps.extensionIncrementMs !== 300_000) {
      return `HARNESS: real GoCometAdapter caps do not match the contract: ${JSON.stringify(caps)}`;
    }
    for (const roll of ROLLS) for (const rivalAt of RIVAL_AT) careers.push(await gocometCareer(roll, rivalAt));
    const bad = [];
    for (const c of careers) {
      const rounds = roundsOf(c);
      if (rounds.some((rd) => rd.live === 0)) bad.push(`roll=${c.roll} rivalAt=${c.rivalAt}: a round with no live read`);
      const gaps = c.a.reads.slice(1).map((x, i) => x.at - c.a.reads[i].at);
      if (gaps.some((g) => g < 1_000)) bad.push(`roll=${c.roll} rivalAt=${c.rivalAt}: two GETs < 1,000 ms apart`);
      const errs = c.events.filter((e) => e.kind === 'tick_error' || e.kind === 'repeated_read_failures');
      if (errs.length) bad.push(`roll=${c.roll} rivalAt=${c.rivalAt}: ${JSON.stringify(errs.slice(0, 2))}`);
      if (!c.a.bids.length) bad.push(`roll=${c.roll} rivalAt=${c.rivalAt}: no bid placed at all`);
    }
    return bad.length ? `HARNESS: ${bad.slice(0, 4).join('; ')}` : null;
  });

  const sweep = () => careers.map((c) => ({ c, rounds: roundsOf(c) }));

  await check(3, 'round0_never_bid_gets_a_read_in_the_buzzer_band', 'mechanism', async () => {
    if (!careers.length) return 'HARNESS: no careers ran';
    const misses = sweep().filter((s) => !s.rounds[0].buzzer);
    if (!misses.length) return null;
    return `${misses.length} of ${careers.length} careers had no round-0 read in (${BUZZER_LO}, ${BUZZER_HI}]; e.g. `
      + misses.slice(0, 3).map((s) => describeMiss(s.c, s.rounds[0])).join(' | ');
  });

  await check(4, 'every_established_round_gets_a_read_in_the_buzzer_band', 'mechanism', async () => {
    if (!careers.length) return 'HARNESS: no careers ran';
    const misses = [];
    for (const s of sweep()) for (const rd of s.rounds.slice(1)) if (!rd.buzzer) misses.push({ c: s.c, rd });
    if (!misses.length) return null;
    return `${misses.length} of ${careers.length * 3} rounds 1-3 had no read in (${BUZZER_LO}, ${BUZZER_HI}]; e.g. `
      + misses.slice(0, 3).map((m) => describeMiss(m.c, m.rd)).join(' | ');
  });

  await check(5, 'final_round_gets_a_middle_band_read_before_the_buzzer_read', 'mechanism', async () => {
    if (!careers.length) return 'HARNESS: no careers ran';
    const misses = sweep().filter((s) => !s.rounds[FINAL_ROUND].middle);
    if (!misses.length) return null;
    return `${misses.length} of ${careers.length} final rounds had no read in (${BUZZER_HI}, ${MIDDLE_HI}] ahead of the `
      + 'buzzer read; e.g. ' + misses.slice(0, 3).map((s) => describeMiss(s.c, s.rounds[FINAL_ROUND])).join(' | ');
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  restoreClock();
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
  console.log(`\nPASS - ${results.length} checks: every GoComet round's buzzer gets a read, and the final round a middle-band read`);
});
