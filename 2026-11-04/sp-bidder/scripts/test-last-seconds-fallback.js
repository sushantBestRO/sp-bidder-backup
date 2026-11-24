'use strict';
/**
 * Ruling 64 (last-seconds fallback, timing-items.md s2): a state read that fails inside the final
 * seconds must not leave the planned shot unsent.
 *
 * THE DEFECT. _tick's `!state.ok` branch counts the failure, alerts once at exactly five, and either
 * retires the monitor past the unreadable bound or reschedules - it never calls _maybeBid. GoComet
 * returns ok:false on every 429 cooldown, network failure or starved read slot, so a cooldown running
 * to close is a guaranteed zero-bid forfeit even with a healthy ladder and budget in hand.
 *
 * CHECKS (dossier timing-items.md s2 "Red test" + the red pin's own controls; ruling 64, 39, 47)
 *   1. mechanism: GoComet final round (cap 3, 3 extensions observed), one attempt left, outranked.
 *      Last good read at 9,000 ms; every later read ok:false. Expected: exactly one placeBid, the
 *      floor, at a tick with 0 < remaining <= 6,500 ms (the buzzer) - never zero.
 *   2. control: identical, but rank 1 on the last good read -> no bid, no notice (ruling 39/47).
 *   3. control: a fresh ok read lands at the buzzer before any failed-read tick inside the window ->
 *      the normal path fires exactly one shot; failed reads after that must never fire a second.
 *   4. control: no attempt left (revisionsLeft 0) on the last good read -> no bid.
 *   5. control: SuperProcure hard close, the same read-failure shape inside its 2,500 ms window ->
 *      the floor once.
 *
 *   node scripts/test-last-seconds-fallback.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const results = [];
async function check(n, name, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}`);
  if (failure) console.log(`        ${failure}`);
}

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const COST = 50_000;
const MARGINS = [9, 7.2, 1.8, 1];
const BUZZER = 6_500;
const SP_FLOOR_WINDOW = 2_500;
const EXTEND_STEP_MS = 299_000;

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'hard', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true };

const ENGINE_OPTS = {
  config: { openAtMs: 25_000, floorWindowMs: SP_FLOOR_WINDOW, softOpenAtMs: 150_000, softOpenJitterMs: 0,
    openJitterMs: 0, cadenceJitterMs: 0 },
  rand: () => 0,
  log: quiet,
};

let seq = 0;
const CLEAN = [];

function armLoad({ caps, meta, firedRungs }) {
  const file = path.join(os.tmpdir(), `lsf-${process.pid}-${seq++}.json`);
  CLEAN.push(file);
  const ctrl = { close: meta.closesAt, rank: null, revisionsLeft: null, failing: false };
  const bids = [];
  const adapter = {
    capabilities: () => ({ ...caps }),
    async getAuctionState() {
      if (ctrl.failing) return { ok: false, error: 'ECONNRESET' };
      const base = { ok: true, status: 'live', closesAtMs: ctrl.close, closesInMs: ctrl.close - Date.now(),
        myRank: ctrl.rank, totalBidders: 3, standingL1Price: null, minDecrement: 500, measuredRttMs: 20 };
      return caps.closeModel === 'soft'
        ? { ...base, closeModel: 'soft', extendMs: 300_000, extendCount: null, serverOffsetMs: 0,
            revisionsLeft: ctrl.revisionsLeft, revisionLimit: 3 }
        : { ...base, closeModel: 'hard', revisionsLeft: null, revisionLimit: null };
    },
    async placeBid(auctionId, price) {
      bids.push({ price, closesInMs: ctrl.close - Date.now() });
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      return { accepted: true, myRank: ctrl.rank, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent: () => {} });
  const armed = eng.arm(meta, { cost: COST, marginsPct: MARGINS });
  const ladder = armed.ladder.slice();
  const m = eng.monitors.get(meta.id);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  for (const idx of firedRungs) { m.firedRungs.add(idx); m.currentRungIndex = Math.max(m.currentRungIndex, idx); }
  if (firedRungs.length) { m.landedBids = firedRungs.length; m.everBid = true; }
  const tick = async () => { await eng._tick(m); if (m.timer) { clearTimeout(m.timer); m.timer = null; } };
  // Three qualifying forward jumps of the believed close, exactly the shape _observeExtension counts
  // a round on (mirrors test-gocomet-final-floor-at-rank1.js) - reaches the default cap of 3.
  const extend = async (rank) => {
    for (let i = 0; i < 3; i++) { vnow = ctrl.close; ctrl.close += EXTEND_STEP_MS; ctrl.rank = rank; await tick(); }
  };
  const at = async (countdown, rank) => {
    vnow = ctrl.close - countdown; ctrl.rank = rank; ctrl.failing = false; await tick();
  };
  const atFailed = async (countdown) => {
    vnow = ctrl.close - countdown; ctrl.failing = true; await tick();
  };
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { m, ladder, bids, ctrl, extend, at, atFailed, done };
}

function gocometLoad({ id, firedRungs, revisionsLeft }) {
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 900_000;
  const r = armLoad({
    caps: GOCOMET_CAPS,
    meta: { id, lane: { origin: 'A', destination: 'B' }, equipment: '32ft SXL', units: 1, quoteType: 'FTL',
      companyName: 'Waaree Energies Ltd', closesAt: posted, platformKey: 'gocomet',
      rules: { revisionLimit: 3, minDecrement: 500 } },
    firedRungs,
  });
  r.ctrl.revisionsLeft = revisionsLeft;
  return r;
}

function spHardLoad({ id, firedRungs }) {
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 30_000;
  return armLoad({
    caps: SP_CAPS,
    meta: { id, lane: { origin: 'A', destination: 'B' }, equipment: '32ft SXL', units: 1, quoteType: 'FTL',
      companyName: 'Tata Steel', closesAt: posted, platformKey: 'superprocure', rules: { minDecrement: 100 } },
    firedRungs,
  });
}

const describe = (bids, ladder) => `[${bids.map((b) => `${b.price} (rung ${ladder.indexOf(b.price)}) at ${b.closesInMs} ms`).join(', ')}]`;

async function main() {
  await check(1, 'gocomet_final_round_outranked_fallback_sends_the_floor', async () => {
    const r = gocometLoad({ id: 'LSF-GC-1', firedRungs: [0, 1], revisionsLeft: 1 });
    try {
      await r.extend(2);          // rank 2 (outranked) through all three counted rounds
      await r.at(9_000, 2);       // last good read at 9,000 ms, still outranked
      await r.atFailed(6_000);    // failed read inside the 6,500 ms buzzer
      await r.atFailed(3_000);    // still failing, closer to close
      await r.atFailed(200);      // still failing, right at the wire
      const floor = r.ladder[r.ladder.length - 1];
      if (r.bids.length === 1 && r.bids[0].price === floor) return null;
      return `expected exactly one placeBid at the floor ${floor} once a read failed inside the buzzer; `
        + `placed ${describe(r.bids, r.ladder)} - _tick returns on the failed read before _maybeBid runs`;
    } finally { r.done(); }
  });

  await check(2, 'gocomet_final_round_rank1_fallback_holds_silently', async () => {
    const r = gocometLoad({ id: 'LSF-GC-2', firedRungs: [0, 1], revisionsLeft: 1 });
    try {
      await r.extend(1);
      await r.at(9_000, 1);
      await r.atFailed(6_000);
      await r.atFailed(3_000);
      await r.atFailed(200);
      if (r.bids.length === 0) return null;
      return `rank 1 on the last good read must hold silently (ruling 39/47); placed ${describe(r.bids, r.ladder)}`;
    } finally { r.done(); }
  });

  await check(3, 'gocomet_fresh_read_at_buzzer_fires_once_never_twice', async () => {
    const r = gocometLoad({ id: 'LSF-GC-3', firedRungs: [0, 1], revisionsLeft: 1 });
    try {
      await r.extend(2);
      await r.at(9_000, 2);
      await r.at(BUZZER, 2);      // a fresh ok read lands exactly at the buzzer: the NORMAL path
      const afterNormal = r.bids.length;
      await r.atFailed(3_000);    // reads fail again afterward - must not fire a second shot
      await r.atFailed(200);
      const floor = r.ladder[r.ladder.length - 1];
      if (afterNormal === 1 && r.bids.length === 1 && r.bids[0].price === floor) return null;
      return `expected exactly one placeBid (the normal path at the buzzer, none from the fallback after); `
        + `placed ${describe(r.bids, r.ladder)}`;
    } finally { r.done(); }
  });

  await check(4, 'gocomet_no_attempts_left_fallback_holds', async () => {
    const r = gocometLoad({ id: 'LSF-GC-4', firedRungs: [0, 1], revisionsLeft: 0 });
    try {
      await r.extend(2);
      await r.at(9_000, 2);
      await r.atFailed(6_000);
      await r.atFailed(200);
      if (r.bids.length === 0) return null;
      return `no attempt left (revisionsLeft 0) must hold; placed ${describe(r.bids, r.ladder)}`;
    } finally { r.done(); }
  });

  await check(5, 'sp_hard_close_fallback_sends_the_floor_once', async () => {
    // Every rung but the floor already fired, so the ordinary step-down walk has nothing left to
    // offer above it - the establishing read below places nothing, isolating the fallback.
    const r = spHardLoad({ id: 'LSF-SP-1', firedRungs: [0, 1, 2] });
    try {
      await r.at(5_000, 2);       // last good read outside the 2,500 ms window, outranked
      await r.atFailed(2_000);    // failed read inside the window
      await r.atFailed(500);      // still failing, right at the wire
      const floor = r.ladder[r.ladder.length - 1];
      if (r.bids.length === 1 && r.bids[0].price === floor) return null;
      return `expected exactly one placeBid at the floor ${floor} on SuperProcure's hard close; `
        + `placed ${describe(r.bids, r.ladder)}`;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const EXPECTED_CHECKS = 5;
  const fails = results.filter((r) => r.failure);
  assert.strictEqual(results.length, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${results.length}`);
  if (fails.length) {
    console.log(`\nFAIL - ${fails.length} of ${results.length} checks failed: ${fails.map((f) => f.n).join(', ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: a failed read in the final seconds still sends the planned shot`);
});
