'use strict';
/**
 * At a pre-final buzzer a provisional-close (GoComet) load keeps its last attempt for the floor.
 *
 * Regression target: PR-T2a behaviour contract section 5a, owner ruling
 * "the floor is kept for the final round". Pre-final round (R < C, default C = 3), at the buzzer:
 * rank 1 holds; unranked or outranked bids the NEXT price only if A >= 2; A <= 1 holds; a next
 * price that would be the floor holds; at most one shot per pre-final round.
 *
 * THE DEFECT. _decide branch 4, the non-allowlisted step-down,
 *   next = Math.max(monitor.currentRungIndex + 1, this._scheduledRungIndex(monitor, remaining));
 *   if (next >= last) next = last - 1;
 * has no revision reserve and no per-round latch. At a 5 s countdown _scheduledRungIndex is already
 * deep, so an outranked tick spends rung 2 with the load's LAST attempt (check 2), skips the next
 * price (check 3), and a second outranked tick in the same round spends again (check 5).
 *
 * ISOLATION. Checks 2, 3, 4 and 6 start both trees from the SAME restored state: a first arm writes
 * the durable intent, the intent is set to "rung 0 landed", and a new BidEngine over the same
 * DurableScheduler file rehydrate()s it. The only frame the engine ever sees is the 5,000 ms buzzer
 * of round 1 (close = posted + 299,000), so no mid-round rule can fire first. Check 5 starts from a
 * fresh unbid arm in round 0, where both trees send rung 0 at the buzzer; the check is on what
 * follows in the same round.
 *
 * FRAMES mirror the real gocometAdapter (extendMs 300,000, extendCount null, extensionCeiling null,
 * revisionLimit 3); capabilities mirror gocometAdapter.capabilities() (extensionCeiling null,
 * snipeBudgetMs 4,500). placeBid is accepted and returns myRank and the decremented revisionsLeft.
 * Frames after check 5's shot keep the same close: the extension the shot triggers has not been
 * published yet, so the engine is still inside round 0.
 *
 * CHECKS
 *   1. control: an SP hard-close load restored from the same state, outranked at 10,500 ms, still
 *      steps down one non-floor rung through placeBid. Green on both trees.
 *   2. mechanism: rung 0 standing, round 1, rank 3, A = 1 -> no bid at the 5,000 ms buzzer.
 *   3. mechanism: same, A = 2 -> exactly one bid, at rung 1 (the next price), never rung 2 or the floor.
 *   4. mechanism: 2-rung ladder, rung 0 standing, A = 2, rank 3 -> the next price is the floor -> no bid.
 *   5. mechanism: round 0, unbid, A = 3: rung 0 at the buzzer, then still rank 3 at 4,800 / 3,000 /
 *      1,000 ms of the same round -> no second bid.
 *   6. mechanism: rung 0 standing, round 1, rank 1, A = 2 -> no bid.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * clock, injected rand, no network, no sleeps.
 *
 *   node scripts/test-gocomet-prefinal-budget.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { closeIsProvisional } = require('../src/platform/adapter');

const EXPECTED_CHECKS = 6;
const EXTEND_MS = 299_000;
const BUZZER = 5_000;
const COST = 70_000;
// Ruling 27: the minimum margin is a guard, never a bid, so the floor rung is carried as the lowest band margin.
const WAAREE = { marginsPct: [9, 7.2, 1.8, 1], minMarginPct: 1 };
const TWO_RUNG = { marginsPct: [9, 1], minMarginPct: 1 };
const CAUSE = '_decide branch 4 (next = max(currentRungIndex + 1, _scheduledRungIndex), capped at last - 1) '
  + 'steps a provisional-close load down at a pre-final buzzer with no revision reserve for the final-round '
  + 'floor and no once-per-round latch';

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: 300_000,
  snipeBudgetMs: 4_500 };
const SP_CAPS = { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
  closeModel: 'unknown' };

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const TMP_PREFIX = `gc-prefinal-budget-${process.pid}-`;
let seq = 0;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ENGINE_OPTS = {
  config: { minInterFireMs: 0, openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0 },
  softClose: { enabled: false, shippers: [], mode: 'live' },
  rand: () => 0,
  log: quiet,
};

function build({ caps, closeModel, id, platformKey, companyName, band, restore, rounds }) {
  const file = path.join(os.tmpdir(), `${TMP_PREFIX}${seq++}.json`);
  const ctrl = { frame: null, revisionsLeft: restore ? restore.revisionsLeft : (caps.revisionLimit || null),
    rankAfterBid: 3 };
  const bids = [];
  const tickErrors = [];
  const adapter = {
    capabilities: () => ({ ...caps }),
    async getAuctionState() { return { ...ctrl.frame, revisionsLeft: ctrl.revisionsLeft }; },
    async placeBid(auctionId, price) {
      bids.push({ price, closesInMs: ctrl.frame.closesInMs });
      if (ctrl.revisionsLeft != null) ctrl.revisionsLeft -= 1;
      return { accepted: true, myRank: ctrl.rankAfterBid, revisionsLeft: ctrl.revisionsLeft };
    },
  };
  const onEvent = (e) => { if (e && e.kind === 'tick_error') tickErrors.push(e.detail); };
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 600_000;
  const meta = {
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Hosur' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName, closesAt: posted,
    platformKey, rules: { revisionLimit: 3, minDecrement: 500 },
  };
  const first = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent });
  const m0 = first.arm(meta, { cost: COST, ...band });
  if (m0.timer) { clearTimeout(m0.timer); m0.timer = null; }
  const ladder = m0.ladder.slice();
  const close = posted + rounds * EXTEND_MS;
  return {
    ladder, bids, tickErrors, ctrl, close,
    async start() {
      if (!restore) return { eng: first, m: m0 };
      first.kill('test: process restart');
      first.scheduler.update(id, { status: 'bidding', firedRungs: [0], landedBids: 1, everBid: true,
        revisionsLeft: restore.revisionsLeft, landedBidPrice: ladder[0] });
      vnow = close - 424_000;
      const eng = new BidEngine(adapter, new DurableScheduler(file), { ...ENGINE_OPTS, onEvent });
      await eng.rehydrate();
      const m = eng.monitors.get(id);
      if (m && m.timer) { clearTimeout(m.timer); m.timer = null; }
      return { eng, m };
    },
    frame(countdown, myRank) {
      vnow = close - countdown;
      ctrl.frame = { ok: true, status: 'live', closeModel, closesAtMs: close, closesInMs: close - Date.now(),
        extendMs: 300_000, extendCount: null, extensionCeiling: null, myRank, totalBidders: null,
        standingL1Price: null, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 };
    },
  };
}

async function load(spec) {
  const b = build(spec);
  const { eng, m } = await b.start();
  const at = async (countdown, myRank) => {
    b.frame(countdown, myRank);
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const harness = (expect) => {
    if (!m) return `HARNESS: '${spec.id}' is not armed`;
    const bad = [];
    if (m.softStrategy !== 'off') bad.push(`softStrategy '${m.softStrategy}', expected 'off'`);
    if (b.ladder.length !== expect.rungs || m.ladder.join() !== b.ladder.join()) {
      bad.push(`ladder ${m.ladder}, expected ${expect.rungs} rungs ${b.ladder} (ruling 27: the floor rung is the lowest band margin; the minimum margin is never appended as a rung)`);
    }
    if (spec.restore) {
      if (!m.firedRungs.has(0) || m.currentRungIndex !== 0) {
        bad.push(`restored rungs ${JSON.stringify([...m.firedRungs])} / currentRungIndex ${m.currentRungIndex}, expected [0] / 0`);
      }
      if (m.landedBids !== 1) bad.push(`landedBids ${m.landedBids}, expected 1`);
      if (m.revisionsLeft !== spec.restore.revisionsLeft) {
        bad.push(`revisionsLeft ${m.revisionsLeft}, expected ${spec.restore.revisionsLeft}`);
      }
    } else if (m.currentRungIndex !== -1 || m.landedBids !== 0) {
      bad.push(`fresh load already bid (currentRungIndex ${m.currentRungIndex}, landedBids ${m.landedBids})`);
    }
    return bad.length ? `HARNESS: starting state is wrong: ${bad.join('; ')}` : null;
  };
  const errors = () => (b.tickErrors.length ? `HARNESS: tick_error ${b.tickErrors.join(' | ')}` : null);
  const done = () => { try { eng.kill('test done'); } catch (_) {} };
  return { eng, m, ladder: b.ladder, bids: b.bids, ctrl: b.ctrl, at, harness, errors, done };
}

const gocomet = (id, band, restore, rounds) => ({ caps: GOCOMET_CAPS, closeModel: 'soft', id, platformKey: 'gocomet',
  companyName: 'Waaree Energies', band, restore, rounds });

const describe = (bids, ladder) => `[${bids.map((b) => `${b.price} (rung ${ladder.indexOf(b.price)}) at ${b.closesInMs} ms`).join(', ')}]`;

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
  if (!closeIsProvisional(GOCOMET_CAPS) || closeIsProvisional(SP_CAPS)) {
    throw new Error('HARNESS: closeIsProvisional does not split the GoComet and SP capabilities');
  }

  await check(1, 'control_sp_hard_close_outranked_still_steps_down', 'control', async () => {
    const r = await load({ caps: SP_CAPS, closeModel: 'hard', id: 'SP-HARD-CTL', platformKey: null,
      companyName: 'Havells India', band: WAAREE, restore: { revisionsLeft: null }, rounds: 0 });
    try {
      const h = r.harness({ rungs: 4 });
      if (h) return h;
      await r.at(10_500, 3);
      const e = r.errors();
      if (e) return e;
      const last = r.ladder.length - 1;
      const i = r.bids.length === 1 ? r.ladder.indexOf(r.bids[0].price) : -1;
      if (i > 0 && i < last) return null;
      return `HARNESS DEAD: an SP hard-close load outranked at 10,500 ms placed ${describe(r.bids, r.ladder)}, `
        + 'expected exactly one non-floor step-down - the harness is not reaching _decide or placeBid';
    } finally { r.done(); }
  });

  await check(2, 'reserve_held_no_bid_with_last_attempt_at_prefinal_buzzer', 'mechanism', async () => {
    const r = await load(gocomet('GC-PF-A1', WAAREE, { revisionsLeft: 1 }, 1));
    try {
      const h = r.harness({ rungs: 4 });
      if (h) return h;
      await r.at(BUZZER, 3);
      const e = r.errors();
      if (e) return e;
      if (r.bids.length === 0) return null;
      return `round 1 of 3 (pre-final), rung 0 standing, rank 3, A = 1: at the ${BUZZER} ms buzzer the load placed `
        + `${describe(r.bids, r.ladder)}; expected no bid - the last attempt belongs to the final-round floor - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(3, 'next_price_at_prefinal_buzzer_when_budget_allows', 'mechanism', async () => {
    const r = await load(gocomet('GC-PF-A2', WAAREE, { revisionsLeft: 2 }, 1));
    try {
      const h = r.harness({ rungs: 4 });
      if (h) return h;
      await r.at(BUZZER, 3);
      const e = r.errors();
      if (e) return e;
      if (r.bids.length === 1 && r.bids[0].price === r.ladder[1]) return null;
      return `round 1 of 3, rung 0 standing, rank 3, A = 2: at the ${BUZZER} ms buzzer the load placed `
        + `${describe(r.bids, r.ladder)}; expected exactly one bid at the next price ${r.ladder[1]} (rung 1) - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(4, 'no_bid_when_next_price_would_be_the_floor', 'mechanism', async () => {
    const r = await load(gocomet('GC-PF-FLOORNEXT', TWO_RUNG, { revisionsLeft: 2 }, 1));
    try {
      const h = r.harness({ rungs: 2 });
      if (h) return h;
      await r.at(BUZZER, 3);
      const e = r.errors();
      if (e) return e;
      if (r.bids.length === 0) return null;
      return `2-rung ladder ${r.ladder}, rung 0 standing, round 1 of 3, rank 3, A = 2: at the ${BUZZER} ms buzzer the `
        + `load placed ${describe(r.bids, r.ladder)}; expected no bid - the next price is the floor, which is kept `
        + `for the final round - ${CAUSE}`;
    } finally { r.done(); }
  });

  await check(5, 'one_shot_per_prefinal_round', 'mechanism', async () => {
    const r = await load(gocomet('GC-PF-ONESHOT', WAAREE, null, 0));
    try {
      const h = r.harness({ rungs: 4 });
      if (h) return h;
      await r.at(BUZZER, null);
      if (r.bids.length !== 1 || r.bids[0].price !== r.ladder[0]) {
        return `HARNESS: round 0 buzzer, unbid, A = 3 placed ${describe(r.bids, r.ladder)}, expected rung 0 `
          + `${r.ladder[0]} - no shot landed, so the same-round follow-up below cannot be judged`;
      }
      for (const c of [4_800, 3_000, 1_000]) await r.at(c, 3);
      const e = r.errors();
      if (e) return e;
      const later = r.bids.slice(1);
      if (later.length === 0) return null;
      return `round 0 of 3: rung 0 landed at the ${BUZZER} ms buzzer (A now 2), still rank 3 at 4,800 / 3,000 / `
        + `1,000 ms of the same round, and the load placed ${describe(later, r.ladder)}; expected no second bid - ${CAUSE}`
        + (later.some((b) => b.price === r.ladder[r.ladder.length - 1])
          ? '; and the deployed always-floor snipe spent the floor inside floorWindowMs of a pre-final round' : '');
    } finally { r.done(); }
  });

  await check(6, 'rank1_holds_at_prefinal_buzzer', 'mechanism', async () => {
    const r = await load(gocomet('GC-PF-RANK1', WAAREE, { revisionsLeft: 2 }, 1));
    try {
      const h = r.harness({ rungs: 4 });
      if (h) return h;
      await r.at(BUZZER, 1);
      const e = r.errors();
      if (e) return e;
      if (r.bids.length === 0) return null;
      return `round 1 of 3, rung 0 standing, rank 1, A = 2: at the ${BUZZER} ms buzzer the load placed `
        + `${describe(r.bids, r.ladder)}; expected no bid while holding L1 in a pre-final round`;
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(TMP_PREFIX)) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) {} }
  }

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
  console.log(`\nPASS - ${results.length} checks: a provisional-close load keeps its last attempt for the final-round floor`);
});
