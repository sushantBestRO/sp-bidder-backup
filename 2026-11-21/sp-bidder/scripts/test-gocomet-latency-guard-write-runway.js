'use strict';
/**
 * A non-floor rung on a GoComet load must clear the declared write runway, not half an RTT.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract
 * sections 2, 5d and 6 (Phase T test list #11); diagnosis timing-A (271 GoComet writes, 16-23 Sep).
 *
 * THE DEFECT. _maybeBid's latency guard holds a non-floor rung only while
 *   state.closesInMs < measuredRttMs / 2 + minLeadMs
 * which at this week's GoComet PUT p50 (measuredRttMs 1,346) is ~1,073 ms. A GoComet write is a quote
 * GET, a confirming re-read and the PUT, serial: decision -> response p50 3.6 s, p90 5.6 s; the adapter
 * declares snipeBudgetMs 4,500 and base never reads it. So a rung decided at 3,000 ms is sent, spends
 * one of three enquiry revisions, and lands after the close.
 *
 * Contract 5d as first written: a non-floor rung is never sent below W = snipeBudgetMs (4,500 ms) - held,
 * not sent late; the floor is exempt. Ruling 51 reverses the hold at the buzzer: a provisional-close
 * load decides only at a round's buzzer, no later read in the round shows more time, so a held shot is
 * the round lost. The runway is kept by reading earlier (buzzer 6,500), not by holding. SuperProcure
 * keeps measuredRttMs / 2 + minLeadMs byte-identically.
 *
 * STARTING STATE (identical on base and fix): arm() at the posted close P with roundPolicy C = 3, bank
 * the landed rungs on the durable intent, then a new BidEngine over the same DurableScheduler file and
 * rehydrate(). GoComet extensions are observed one 299 s round per read at ~299 s remaining.
 *
 *   1. [control] SuperProcure hard close, rank 3, rung 0 standing, first tick at 3,000, measuredRttMs 200:
 *      rung 1 (non-floor) is sent at 3,000. Green on base and after.
 *   2. P-load round 1 of cap 3 (pre-final), rank 3, A=2, rung 0 standing. Rank 1 on the round-0 and
 *      extension reads (so base's mid-round walk stays out of it); the first buzzer tick arrives at
 *      3,000 (the ~6 s read was lost), then 2,000 and 1,000: exactly one write, rung 1, at 3,000 and
 *      nothing after it (ruling 51 named reversal; it pinned NO write in that round before).
 *   3. P-load final round (3 extensions), rank 2, A=1, rung 1 standing, first buzzer tick at 3,000: the
 *      FLOOR at 3,000 (exempt from the runway). Also red on base, for the File-10 reason: base releases
 *      the floor only at floorWindowMs 2,500, so it goes at the 2,000 tick.
 *
 * Offline and deterministic: fake adapters (GoComet caps mirror the real gocometAdapter), temp-file
 * DurableScheduler under os.tmpdir(), stubbed Date.now, rand pinned, timers cleared, no network.
 *
 *   node scripts/test-gocomet-latency-guard-write-runway.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 3;
const STEP_MS = 299_000;
const GC_RTT_MS = 1_346;
const RUNWAY_CAUSE = "ruling 51: _maybeBid holds a provisional-close buzzer shot below the write runway, and no later "
  + 'read in the round shows more time, so the round sends nothing';
const FLOOR_CAUSE = 'the runway-exempt floor is not sent at the first buzzer tick below W: base releases it only at '
  + 'floorWindowMs 2,500 (_isLastChance)';

const GC_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null,
  extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const PREFIX = `gc-write-runway-${process.pid}-`;
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = { minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 };

async function rig(platform, { fired, revisionsLeft, rank, rtt }) {
  const gc = platform === 'gocomet';
  const file = path.join(os.tmpdir(), `${PREFIX}${seq++}.json`);
  const ctrl = { close: null, rank, revisionsLeft, rtt };
  const writes = [];
  const events = [];
  const adapter = {
    capabilities: () => ({ ...(gc ? GC_CAPS : SP_CAPS) }),
    async getAuctionState() {
      if (ctrl.close == null) return { ok: false, error: 'no frame' };
      const base = { ok: true, status: 'live', closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
        myRank: ctrl.rank, standingL1Price: null, minDecrement: 500, measuredRttMs: ctrl.rtt };
      return gc
        ? { ...base, closeModel: 'soft', extendMs: 300_000, extendCount: null, extensionCeiling: null,
          totalBidders: null, revisionsLeft: ctrl.revisionsLeft, revisionLimit: 3 }
        : { ...base, closeModel: 'hard', totalBidders: 5, revisionsLeft: null };
    },
    async placeBid(id, price) {
      writes.push({ price, countdown: ctrl.close - Date.now() });
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 20 };
    },
  };
  const make = () => new BidEngine(adapter, new DurableScheduler(file),
    { config: cfg, rand: () => 0, onEvent: (e) => events.push(e), log: quiet });

  const posted = Math.floor(REAL_NOW() / 1000) * 1000 + 3_600_000;
  const id = gc ? 'GC-RUNWAY' : 'SP-RUNWAY';
  vnow = posted - 900_000;
  const first = make();
  const m1 = first.arm({
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Pune' }, equipment: '32ft SXL',
    units: 1, quoteType: 'FTL', companyName: 'Waaree Energies', closesAt: posted,
    platformKey: gc ? 'gocomet' : 'superprocure', rules: { revisionLimit: 3, minDecrement: 500 },
    roundPolicy: { finalAfterExtensions: 3 },
  }, { cost: 70_000, marginsPct: [9, 7.2, 1] });
  if (m1.timer) { clearTimeout(m1.timer); m1.timer = null; }
  const ladder = m1.ladder.slice();
  first.scheduler.update(id, { status: 'bidding', firedRungs: fired.slice(), everBid: true,
    landedBids: fired.length, landedBidPrice: ladder[Math.max(...fired)],
    ...(revisionsLeft != null ? { revisionsLeft } : {}) });
  first.kill('harness restart');

  vnow = posted - 600_000;
  const eng = make();
  await eng.rehydrate();
  for (const x of eng.monitors.values()) { if (x.timer) { clearTimeout(x.timer); x.timer = null; } }
  const m = eng.monitors.get(id);
  if (!m) throw new Error('HARNESS: rehydrate did not re-arm the load');
  if (String(m.ladder) !== String(ladder) || m.currentRungIndex !== Math.max(...fired)
      || m.landedBids !== fired.length || (revisionsLeft != null && m.revisionsLeft !== revisionsLeft)) {
    throw new Error(`HARNESS: rehydrated state is not the seeded one (ladder ${m.ladder}, rung ${m.currentRungIndex}, `
      + `landed ${m.landedBids}, revisionsLeft ${m.revisionsLeft})`);
  }
  if (gc && m.softStrategy !== 'off') throw new Error(`HARNESS: GoComet load resolved softStrategy '${m.softStrategy}'`);

  const tickAt = async (countdown) => {
    vnow = ctrl.close - countdown;
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const extendTo = async (rounds) => {
    ctrl.close = posted;
    await tickAt(300_000);
    for (let r = 0; r < rounds; r++) {
      vnow = ctrl.close;
      ctrl.close += STEP_MS;
      await eng._tick(m);
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    }
  };
  const harnessErrors = () => events.filter((e) => e.kind === 'tick_error' || e.kind === 'floor_breach_blocked');
  const describe = () => (writes.length
    ? writes.map((w) => `${w.price === m.floor ? 'FLOOR ' : `rung ${ladder.indexOf(w.price)} `}${w.price} at countdown ${w.countdown}`).join(', ')
    : 'none');
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, ctrl, ladder, writes, events, posted, tickAt, extendTo, harnessErrors, describe, done };
}

const results = [];
async function check(n, name, kind, cause, fn) {
  let failure = null;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  results.push({ n, name, kind, cause, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  await check(1, 'control_sp_guard_unchanged_rung_sent_at_3000', 'control', null, async () => {
    const r = await rig('superprocure', { fired: [0], revisionsLeft: null, rank: 3, rtt: 200 });
    try {
      r.ctrl.close = r.posted;
      await r.tickAt(3_000);
      if (r.harnessErrors().length) return `HARNESS: ${r.harnessErrors().map((e) => `${e.kind}: ${e.detail}`).join('; ')}`;
      const w = r.writes;
      if (w.length === 1 && w[0].price === r.ladder[1] && w[0].countdown === 3_000) return null;
      return `HARNESS DEAD: an SP hard-close load at rank 3 with rung 0 standing must send rung 1 (${r.ladder[1]}) at `
        + `countdown 3000 (guard measuredRttMs / 2 + minLeadMs = 500); got ${r.describe()}`;
    } finally { r.done(); }
  });

  await check(2, 'buzzer_shot_below_write_runway_is_sent', 'mechanism', RUNWAY_CAUSE, async () => {
    const r = await rig('gocomet', { fired: [0], revisionsLeft: 2, rank: 1, rtt: GC_RTT_MS });
    try {
      await r.extendTo(1);
      if (r.writes.length) return `HARNESS: a write went out while observing the extension: ${r.describe()}`;
      r.ctrl.rank = 3;
      for (const c of [3_000, 2_000, 1_000]) await r.tickAt(c);
      if (r.harnessErrors().length) return `HARNESS: ${r.harnessErrors().map((e) => `${e.kind}: ${e.detail}`).join('; ')}`;
      const w = r.writes;
      if (w.length === 1 && w[0].price === r.ladder[1] && w[0].countdown === 3_000) return null;
      return `pre-final round 1 of cap 3 (rank 3, A=2, rung 0 standing, measuredRttMs ${GC_RTT_MS}), first buzzer `
        + `tick at 3000 then 2000/1000: expected exactly one write, rung 1 (${r.ladder[1]}), at 3000 (ruling 51 named `
        + `reversal of the 5d hold); got ${r.describe()} - ${RUNWAY_CAUSE}`;
    } finally { r.done(); }
  });

  await check(3, 'floor_exempt_from_write_runway', 'mechanism', FLOOR_CAUSE, async () => {
    const r = await rig('gocomet', { fired: [0, 1], revisionsLeft: 1, rank: 2, rtt: GC_RTT_MS });
    try {
      await r.extendTo(3);
      if (r.writes.length) return `HARNESS: a write went out while observing the extensions: ${r.describe()}`;
      for (const c of [10_500, 7_000, 3_000, 2_000]) await r.tickAt(c);
      if (r.harnessErrors().length) return `HARNESS: ${r.harnessErrors().map((e) => `${e.kind}: ${e.detail}`).join('; ')}`;
      const w = r.writes;
      if (w.length === 1 && w[0].price === r.m.floor && w[0].countdown === 3_000) return null;
      return `final round (3 extensions of cap 3, rank 2, A=1), first buzzer tick at 3000: expected exactly one write, `
        + `the FLOOR ${r.m.floor}, at countdown 3000 (exempt from the write runway); got ${r.describe()} - ${FLOOR_CAUSE}`;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', cause: null, failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(PREFIX)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {} }
  }
  const isHarness = (x) => x.failure && (x.kind !== 'mechanism' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the control or the rig is broken, so the mechanism `
      + 'results above are not trustworthy');
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): `
      + mech.map((x) => x.cause).join('; '));
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: a GoComet buzzer shot below the write runway is sent (ruling 51), the floor is exempt, SP guard unchanged`);
});
