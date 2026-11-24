'use strict';
/**
 * A GoComet load's final shot is decided at countdown 3.5-5.5 s, not at <= 2.5 s.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract
 * sections 2, 5b and 6 (Phase T test list #10); diagnosis timing-A (271 GoComet writes, 16-23 Sep).
 *
 * THE DEFECT. A GoComet enquiry runs softStrategy 'off', and for that class the only release of the
 * floor is _isLastChance (remaining <= floorWindowMs = 2,500 ms). A GoComet write is a quote GET, a
 * confirming re-read and the PUT, serial: decision -> response p50 3.6 s, p90 5.6 s. Measured, a
 * decision at countdown >= 3 s landed 9 of 9, at 2 s 1 of 6, at 0 s 0 of 6, and 11 final floors were
 * refused at the close. The adapter declares snipeBudgetMs 4,500; base's engine never reads it.
 *
 * Contract: buzzer B = snipeBudgetMs + one read interval = 5,500 ms. In the final round (R >= C) the
 * floor goes on the first tick at countdown <= B whatever the rank, unless it already stands or A is 0.
 * The floor is exempt from the write-runway hold, so a first buzzer tick at 4,000 still sends it.
 *
 * STARTING STATE (identical on base and fix): arm() at the posted close P with roundPolicy C = 3, bank
 * rungs 0 and 1 as landed on the durable intent (A = 1, rung last-1 standing, so base's step-down has
 * nothing left above the floor), then a new BidEngine over the same DurableScheduler file and
 * rehydrate(). Three 299 s extensions are then observed one per read (in-process count 3; derived
 * round(897 / 300) = 3), each at ~299 s remaining. Rank 2 on every frame.
 *
 *   1. [control] SuperProcure hard close, same rung state, ticks 10,500 / 7,000 / 5,000 / 2,000:
 *      one write, the floor, at 2,000 (SP final window stays 2.5 s by ruling). Green on base and after.
 *   2. P-load final round, same ticks: exactly one write, the floor, decided in [3,500, 5,500];
 *      nothing at 2,000. RED on base: the floor goes at the 2,000 tick.
 *   3. P-load final round, first buzzer tick at 4,000 (ticks 10,500 / 7,000 / 4,000 / 2,000): the
 *      floor at 4,000. RED on base: the floor goes at 2,000.
 *
 * Offline and deterministic: fake adapters (GoComet caps mirror the real gocometAdapter), temp-file
 * DurableScheduler under os.tmpdir(), stubbed Date.now, rand pinned, timers cleared, no network.
 *
 *   node scripts/test-gocomet-buzzer-lead.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 3;
const STEP_MS = 299_000;
const GC_RTT_MS = 1_346;
const CAUSE = "the final-round floor on a provisional-close (GoComet) load is released only by _isLastChance "
  + '(floorWindowMs 2,500), not at the ~5 s buzzer the declared snipeBudgetMs 4,500 requires, so it is '
  + 'decided inside the ~3.6 s write path and refused at the close';

const GC_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null,
  extensionIncrementMs: 300_000, snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const PREFIX = `gc-buzzer-lead-${process.pid}-`;
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = { minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 };

async function rig(platform, { fired, revisionsLeft, rank }) {
  const gc = platform === 'gocomet';
  const file = path.join(os.tmpdir(), `${PREFIX}${seq++}.json`);
  const ctrl = { close: null, rank, revisionsLeft, rtt: gc ? GC_RTT_MS : 200 };
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
  const id = gc ? 'GC-BUZZ' : 'SP-BUZZ';
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
  const last = m.ladder.length - 1;
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
    ? writes.map((w) => `${w.price === m.floor ? 'FLOOR ' : ''}${w.price} at countdown ${w.countdown}`).join(', ')
    : 'none');
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, ctrl, writes, events, last, posted, tickAt, extendTo, harnessErrors, describe, done };
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

async function main() {
  await check(1, 'control_sp_hard_close_floor_still_at_2000', 'control', async () => {
    const r = await rig('superprocure', { fired: [0, 1], revisionsLeft: null, rank: 2 });
    try {
      r.ctrl.close = r.posted;
      for (const c of [10_500, 7_000, 5_000, 2_000]) await r.tickAt(c);
      if (r.harnessErrors().length) return `HARNESS: ${r.harnessErrors().map((e) => `${e.kind}: ${e.detail}`).join('; ')}`;
      const w = r.writes;
      if (w.length === 1 && w[0].price === r.m.floor && w[0].countdown === 2_000) return null;
      return `HARNESS DEAD: an SP hard-close load at rank 2 with rung last-1 standing must send exactly one write, `
        + `the floor, at countdown 2000 (SP final window 2.5 s); got ${r.describe()}`;
    } finally { r.done(); }
  });

  await check(2, 'final_round_floor_decided_at_buzzer_not_at_2000', 'mechanism', async () => {
    const r = await rig('gocomet', { fired: [0, 1], revisionsLeft: 1, rank: 2 });
    try {
      await r.extendTo(3);
      if (r.writes.length) return `HARNESS: a write went out while observing the extensions: ${r.describe()}`;
      for (const c of [10_500, 7_000, 5_000, 2_000]) await r.tickAt(c);
      if (r.harnessErrors().length) return `HARNESS: ${r.harnessErrors().map((e) => `${e.kind}: ${e.detail}`).join('; ')}`;
      const w = r.writes;
      if (w.length === 1 && w[0].price === r.m.floor && w[0].countdown >= 3_500 && w[0].countdown <= 5_500) return null;
      return `final round (3 extensions of cap 3, rank 2, A=1, ticks 10500/7000/5000/2000): expected exactly one `
        + `write, the FLOOR ${r.m.floor}, decided at countdown in [3500, 5500] (the 5000 tick) and nothing at 2000; `
        + `got ${r.describe()} - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(3, 'late_first_buzzer_tick_at_4000_still_sends_floor', 'mechanism', async () => {
    const r = await rig('gocomet', { fired: [0, 1], revisionsLeft: 1, rank: 2 });
    try {
      await r.extendTo(3);
      if (r.writes.length) return `HARNESS: a write went out while observing the extensions: ${r.describe()}`;
      for (const c of [10_500, 7_000, 4_000, 2_000]) await r.tickAt(c);
      if (r.harnessErrors().length) return `HARNESS: ${r.harnessErrors().map((e) => `${e.kind}: ${e.detail}`).join('; ')}`;
      const w = r.writes;
      if (w.length === 1 && w[0].price === r.m.floor && w[0].countdown === 4_000) return null;
      return `final round, the ~5 s read lost and the first buzzer tick at 4000: expected exactly one write, the `
        + `FLOOR ${r.m.floor}, at countdown 4000 (the floor is exempt from the write-runway hold); got ${r.describe()} - ${CAUSE}`;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
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
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${CAUSE}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: the GoComet final floor is decided at the ~5 s buzzer, SP unchanged`);
});
