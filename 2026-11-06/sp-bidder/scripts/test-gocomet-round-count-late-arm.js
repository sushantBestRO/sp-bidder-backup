'use strict';
/**
 * A GoComet load the desk prices AFTER rivals already extended it still counts its rounds from the
 * discovery close.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract section 3 ("postedCloseAt ... Source,
 * best first: the price request's discovery snapshot load.closesAt when it is earlier than the
 * effective close armFromRequest arms on ... carried unchanged across re-arm (re-price)").
 * Base d3bf803.
 *
 * THE DEFECT. armFromRequest (src/pricing/priceRequests.js) arms on effectiveCloseAt(load), the later
 * of the discovery snapshot load.closesAt and the refreshed load.liveClosesAt, so a load priced in
 * round 3 is armed with meta.closesAt already at the extended close. The engine keeps no posted close
 * and _observeExtension's 'off' branch counts no rounds, so the extensions that happened before the
 * arm are invisible: the final round is treated like any other, no middle-band shot is decided on the
 * final-round rule and the floor does not go out at the 5,000 ms buzzer (base steps to rung 1 there).
 * A fix that derives rounds from meta.closesAt alone reads R = 0 here and stays red on check 2 - that
 * is intended.
 *
 * CHECKS
 *   1. control: a round-0 load armed through the real armFromRequest, unbid, A=3, ticked only at the
 *      5,000 ms buzzer -> exactly one bid at rung 0 on base and on the fix.
 *   2. mechanism: priced in the final round (load.closesAt = P, load.liveClosesAt = P + 3 x 299,000, no
 *      customers provider so round policy = default 3), never bid, unranked, A=3 -> exactly one bid at
 *      10,500 (rung 0: final-round middle shot, next price of an unbid load) and exactly one at 5,000:
 *      the FLOOR.
 *   3. contrast: the same load priced in round 0 (no liveClosesAt) -> rung 0 at 10,500 (round 0's
 *      pre-final shot, in the middle band since rulings 40 and 56) and nothing at 5,000; no floor. The
 *      floor at 5,000 is what makes check 2's round final.
 *   4. mechanism: the late-armed load re-priced through the re-price path (engine.stop +
 *      armFromRequest, as reArmWithNewBand in src/web/server.js does) -> still final: rung 0 of the new
 *      ladder at 10,500, its FLOOR at 5,000.
 *
 * Offline and deterministic: real armFromRequest and BidEngine, fake adapter mirroring the real
 * gocometAdapter capabilities (extensionCeiling null, snipeBudgetMs 4500), stubbed Date.now, jitter
 * off, temp-file intents under os.tmpdir(), no network, no sleeps.
 *
 *   node scripts/test-gocomet-round-count-late-arm.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { armFromRequest } = require('../src/pricing/priceRequests');

const EXPECTED_CHECKS = 4;
const STEP = 299_000;
const EXTEND_MS = 300_000;
const MECHANISM = 'rounds extended before a late arm are not counted: armFromRequest arms on the extended '
  + "effectiveCloseAt, no posted close (the discovery load.closesAt) reaches the engine and _observeExtension's "
  + "'off' branch counts no rounds, so a load priced in its final round gets no final-round middle shot "
  + 'decision and no floor at the 5,000 ms buzzer';
const CONTRAST = 'round 0 is not told apart from the final round: its pre-final shot is not the one middle-band price, or its buzzer spends the floor';

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-round-late-arm-${process.pid}-${seq++}.json`);
  CLEAN.push(f, `${f}.tmp`);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: EXTEND_MS,
  snipeBudgetMs: 4500 };
const CFG = { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0, minInterFireMs: 0 };

function rig() {
  const ctrl = { frame: null, bids: [] };
  const adapter = {
    capabilities: () => ({ ...GOCOMET_CAPS }),
    ensureSession: async () => ({}),
    async getAuctionState() { return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' }; },
    async placeBid(id, price) {
      ctrl.bids.push({ id, price, countdown: ctrl.frame ? ctrl.frame.closesInMs : null });
      return { accepted: true, myRank: 2, latencyMs: 20 };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: CFG, softClose: { enabled: false, shippers: [], mode: 'live' },
    rand: () => 0.5, onEvent: () => {}, log: quiet,
  });
  return { eng, ctrl };
}

const request = (id, posted, liveClosesAt, cost) => ({
  id: `req-${id}`, loadId: id, platformKey: 'gocomet',
  load: {
    id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', status: 'live',
    startsAt: posted - 3_600_000, closesAt: posted,
    ...(liveClosesAt != null ? { liveClosesAt } : {}),
    rules: { revisionLimit: 3, minDecrement: 500 },
  },
  price: { cost, marginsPct: [9, 7.2, 1], minMarginPct: 1 },
});

function arm(r, req) {
  const m = armFromRequest(r.eng, req);
  if (!m || !Array.isArray(m.ladder)) throw new Error('HARNESS: armFromRequest did not return an armed monitor');
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  if (m.ladder.length !== 3) throw new Error(`HARNESS: expected a 3-rung ladder, got ${JSON.stringify(m.ladder)}`);
  return m;
}

const frame = (closesAtMs, myRank, revisionsLeft) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs,
  closesInMs: closesAtMs - Date.now(), extendMs: EXTEND_MS, extendCount: null, extensionCeiling: null, myRank,
  totalBidders: null, standingL1Price: null, revisionsLeft, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 });

async function tickAt(r, m, now, closesAtMs, myRank, revisionsLeft) {
  vnow = now;
  r.ctrl.frame = frame(closesAtMs, myRank, revisionsLeft);
  const before = r.ctrl.bids.length;
  await r.eng._tick(m);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  return r.ctrl.bids.slice(before);
}

const rungOf = (ladder, price) => {
  const i = ladder.indexOf(price);
  return i < 0 ? `off-ladder ${price}` : (i === ladder.length - 1 ? `FLOOR (${price})` : `rung ${i} (${price})`);
};
const list = (ladder, bids) => bids.map((b) => rungOf(ladder, b.price)).join(', ') || 'nothing';

// Final-round two-shot expectation shared by checks 2 and 4.
function finalRoundVerdict(ladder, middle, buzzer) {
  const bad = [];
  if (middle.length !== 1 || middle[0].price !== ladder[0]) {
    bad.push(`10,500 placed [${list(ladder, middle)}], expected exactly rung 0 (${ladder[0]}) - final round, unranked, A=3`);
  }
  if (buzzer.length !== 1 || buzzer[0].price !== ladder[2]) {
    bad.push(`5,000 placed [${list(ladder, buzzer)}], expected exactly the FLOOR (${ladder[2]})`);
  }
  return bad;
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
  console.log('\nGoComet: a load priced after round 0 extended still counts its rounds (PR-T2a, contract 3)\n');

  await check(1, 'control_round0_arm_reaches_bid_path', 'control', async () => {
    const r = rig();
    try {
      const P = REAL_NOW() + 3_600_000;
      vnow = P - 300_000;
      const m = arm(r, request('GC-LA-CTL', P, null, 70_000));
      const buzzer = await tickAt(r, m, P - 5_000, P, null, 3);
      if (buzzer.length === 1 && buzzer[0].price === m.ladder[0]) return null;
      return `HARNESS DEAD: a round-0 load armed through armFromRequest, unbid, A=3, placed [${list(m.ladder, buzzer)}] `
        + `at the 5,000 buzzer, expected exactly rung 0 (${m.ladder[0]}) - the harness is not reaching the bid path`;
    } finally { r.eng.kill('done'); }
  });

  await check(2, 'priced_in_final_round_counts_rounds_from_discovery_close', 'mechanism', async () => {
    const r = rig();
    try {
      const P = REAL_NOW() + 3_600_000;
      const live = P + 3 * STEP;
      vnow = P + 2 * STEP + 30_000;
      const m = arm(r, request('GC-LA-FIN', P, live, 70_000));
      const first = await tickAt(r, m, vnow, live, null, 3);
      if (first.length) return `HARNESS: first read ${live - vnow} ms out placed ${list(m.ladder, first)}`;
      const middle = await tickAt(r, m, live - 10_500, live, null, 3);
      const buzzer = await tickAt(r, m, live - 5_000, live, 2, 2);
      const bad = finalRoundVerdict(m.ladder, middle, buzzer);
      if (!bad.length) return null;
      return `priced in round 3 (load.closesAt P, liveClosesAt P+897,000, default cap 3), never bid: ${bad.join('; ')} - ${MECHANISM}`;
    } finally { r.eng.kill('done'); }
  });

  await check(3, 'priced_in_round0_contrast', 'contrast', async () => {
    const r = rig();
    try {
      const P = REAL_NOW() + 3_600_000;
      vnow = P - 300_000;
      const m = arm(r, request('GC-LA-R0', P, null, 70_000));
      const first = await tickAt(r, m, vnow, P, null, 3);
      const middle = await tickAt(r, m, P - 10_500, P, null, 3);
      const buzzer = await tickAt(r, m, P - 5_000, P, null, 3);
      const bad = [];
      if (first.length) bad.push(`300,000 placed ${list(m.ladder, first)}`);
      // named re-pin: round tracker piece C, rulings 40 and 56 - round 0's pre-final shot moved from the
      // 5,000 ms buzzer into the middle band, so it goes at 10,500 and the buzzer keeps the floor back.
      if (middle.map((b) => b.price).join() !== [m.ladder[0]].join()) {
        bad.push(`10,500 placed [${list(m.ladder, middle)}], expected exactly rung 0 (${m.ladder[0]}): round 0's pre-final shot`);
      }
      if (buzzer.length) bad.push(`5,000 placed [${list(m.ladder, buzzer)}], expected nothing (round 0 is pre-final: the floor is kept)`);
      if (r.ctrl.bids.some((b) => b.price === m.ladder[2])) bad.push('the FLOOR went out in round 0');
      if (!bad.length) return null;
      return `round-0 load (no liveClosesAt), unbid, A=3: ${bad.join('; ')} - ${CONTRAST}`;
    } finally { r.eng.kill('done'); }
  });

  await check(4, 'late_arm_stays_final_across_reprice', 'mechanism', async () => {
    const r = rig();
    try {
      const P = REAL_NOW() + 3_600_000;
      const live = P + 3 * STEP;
      vnow = P + 2 * STEP + 30_000;
      const m1 = arm(r, request('GC-LA-RP', P, live, 70_000));
      const first = await tickAt(r, m1, vnow, live, null, 3);
      if (first.length) return `HARNESS: first read placed ${list(m1.ladder, first)}`;
      vnow += 20_000;
      r.eng.stop('GC-LA-RP');
      const m2 = arm(r, request('GC-LA-RP', P, live, 72_000));
      if (String(m2.ladder) === String(m1.ladder)) return 'HARNESS: the re-price did not rebuild the ladder';
      const middle = await tickAt(r, m2, live - 10_500, live, null, 3);
      const buzzer = await tickAt(r, m2, live - 5_000, live, 2, 2);
      const bad = finalRoundVerdict(m2.ladder, middle, buzzer);
      if (!bad.length) return null;
      return `late-armed load re-priced (stop + armFromRequest, cost 70,000 -> 72,000) inside round 3: ${bad.join('; ')} `
        + `- the posted close did not survive the re-arm or was never known: ${MECHANISM}`;
    } finally { r.eng.kill('done'); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const isHarness = (x) => x.failure && (x.kind === 'control' || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x) && x.kind === 'mechanism');
  const contrast = results.filter((x) => x.failure && !isHarness(x) && x.kind === 'contrast');
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the control or the harness is broken, so the results above are not trustworthy`);
    process.exit(1);
  }
  if (mech.length || contrast.length) {
    const causes = [];
    if (mech.length) causes.push(`checks ${mech.map((x) => x.n).join(', ')}: ${MECHANISM}`);
    if (contrast.length) causes.push(`check 3: ${CONTRAST}`);
    console.log(`\nFAIL - ${mech.length + contrast.length} of ${results.length} checks. ${causes.join('. ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: a late-armed GoComet load counts its rounds from the discovery close`);
});
