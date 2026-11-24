'use strict';
/**
 * One GoComet read showing the close +598 s (a read gap spanning two extensions) counts 2 rounds.
 *
 * Regression target: PR-T2a "GoComet final-round timing", contract section 3 ("One read showing the
 * close +598 s counts 2 (derived), never 0: W1-7's '> 1.5 x published increment = reschedule' rule is
 * NOT applied to P-loads").
 * Base d3bf803.
 *
 * THE DEFECT. _observeExtension's softStrategy 'off' branch (every GoComet enquiry) follows the
 * published close but counts no rounds at all, so after P+299,000 and a catch-up read at P+897,000 the
 * engine still believes no extension happened and round 3 is not final: nothing goes out at the
 * 5,000 ms buzzer. GoComet publishes extendMs 300,000 on every read, so if P-loads were routed through
 * the counting path instead, W1-7's reschedule rule (`jump > extendMs * 1.5`) would count the +598 s
 * read as 0, leaving the load one round short of its final round - the same miss by another route.
 *
 * CHECKS
 *   1. control: A=2, rung 0 standing, one +299 s read (round 1), outranked at the 5,000 ms buzzer ->
 *      exactly one bid at rung 1 on base and on the fix. Proves the harness reaches placeBid.
 *   2. mechanism: cap 3 (default), A=1, rank 2; reads at P+299,000 then P+897,000 -> no bid at 10,500,
 *      the FLOOR at 5,000.
 *   3. guard (green on base): ONE read at P+598,000 only is round 2, pre-final -> no bid at 5,000 (A=1).
 *
 * Starting state is a seeded durable intent (arm, then status/firedRungs/revisionsLeft/landedBids as
 * the accepted-bid path writes them, then rehydrate before any extension): A=1 with rung last-1
 * standing. Offline and deterministic: fake adapter mirroring the real gocometAdapter capabilities
 * (extensionCeiling null, snipeBudgetMs 4500), stubbed Date.now, jitter off, temp-file intents under
 * os.tmpdir(), no network, no sleeps.
 *
 *   node scripts/test-gocomet-two-round-catchup.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 3;
const STEP = 299_000;
const EXTEND_MS = 300_000;
const MECHANISM = "a +598 s catch-up read is not counted as two GoComet rounds: _observeExtension's 'off' branch "
  + 'counts no rounds (and W1-7\'s >1.5x-increment reschedule rule would count it 0), so round 3 is not '
  + 'recognised as final and no floor goes out at the 5,000 ms buzzer';

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-two-round-catchup-${process.pid}-${seq++}.json`);
  CLEAN.push(f, `${f}.tmp`);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const GOCOMET_CAPS = { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
  closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: EXTEND_MS,
  snipeBudgetMs: 4500 };
const INPUTS = { cost: 70_000, marginsPct: [9, 7.2, 1] };
const CFG = { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0, minInterFireMs: 0 };

function engineOn(file, ctrl) {
  const adapter = {
    capabilities: () => ({ ...GOCOMET_CAPS }),
    ensureSession: async () => ({}),
    async getAuctionState() { return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' }; },
    async placeBid(id, price) {
      ctrl.bids.push({ id, price, countdown: ctrl.frame ? ctrl.frame.closesInMs : null });
      return { accepted: true, myRank: 2, latencyMs: 20 };
    },
  };
  return new BidEngine(adapter, new DurableScheduler(file), {
    config: CFG, softClose: { enabled: false, shippers: [], mode: 'live' },
    rand: () => 0.5, onEvent: () => {}, log: quiet,
  });
}

const frame = (closesAtMs, myRank, revisionsLeft) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs,
  closesInMs: closesAtMs - Date.now(), extendMs: EXTEND_MS, extendCount: null, extensionCeiling: null, myRank,
  totalBidders: null, standingL1Price: null, revisionsLeft, revisionLimit: 3, minDecrement: 500, measuredRttMs: 20 });

async function tickAt(r, now, closesAtMs, myRank, revisionsLeft) {
  vnow = now;
  r.ctrl.frame = frame(closesAtMs, myRank, revisionsLeft);
  const before = r.ctrl.bids.length;
  await r.eng._tick(r.m);
  if (r.m.timer) { clearTimeout(r.m.timer); r.m.timer = null; }
  return r.ctrl.bids.slice(before);
}

async function seeded(id, fired, A) {
  const ctrl = { frame: null, bids: [] };
  const file = tmp();
  const posted = REAL_NOW() + 3_600_000;
  vnow = posted - 600_000;
  const e0 = engineOn(file, ctrl);
  const m0 = e0.arm({ id, lane: { origin: 'Degam (Survey No. 1934, NH-48, Chikhli)', destination: 'Vadodara' },
    equipment: '32ft SXL', units: 1, quoteType: 'FTL', companyName: 'Waaree', closesAt: posted,
    platformKey: 'gocomet', rules: { revisionLimit: 3, minDecrement: 500 } }, INPUTS);
  if (m0.timer) { clearTimeout(m0.timer); m0.timer = null; }
  const ladder = m0.ladder.slice();
  if (ladder.length !== 3) throw new Error(`HARNESS: expected a 3-rung ladder, got ${JSON.stringify(ladder)}`);
  e0.scheduler.update(id, { status: 'bidding', firedRungs: fired, revisionsLeft: A, landedBids: fired.length,
    landedBidPrice: ladder[Math.max(...fired)], everBid: true });
  e0.kill('seeded');

  const eng = engineOn(file, ctrl);
  await eng.rehydrate();
  for (const mm of eng.monitors.values()) { if (mm.timer) { clearTimeout(mm.timer); mm.timer = null; } }
  const m = eng.monitors.get(id);
  if (!m) throw new Error(`HARNESS: ${id} was not re-armed by rehydrate()`);
  if (m.revisionsLeft !== A || m.currentRungIndex !== Math.max(...fired)) {
    throw new Error(`HARNESS: seeded state not restored (revisionsLeft ${m.revisionsLeft}, rung ${m.currentRungIndex})`);
  }
  return { eng, m, ctrl, ladder, posted };
}

const rungOf = (ladder, price) => {
  const i = ladder.indexOf(price);
  return i < 0 ? `off-ladder ${price}` : (i === ladder.length - 1 ? `FLOOR (${price})` : `rung ${i} (${price})`);
};
const list = (ladder, bids) => bids.map((b) => rungOf(ladder, b.price)).join(', ') || 'nothing';

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try { failure = await fn(); } catch (e) { failure = `threw: ${e && e.stack ? e.stack : e}`; }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind === 'mechanism' ? '' : ` [${kind}]`}`);
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  console.log('\nGoComet: one +598 s catch-up read counts two rounds (PR-T2a, contract 3)\n');

  await check(1, 'control_harness_reaches_bid_path', 'control', async () => {
    const r = await seeded('GC-CU-CTL', [0], 2);
    try {
      const P = r.posted;
      const early = await tickAt(r, P, P + STEP, 1, 2);
      const buzzer = await tickAt(r, P + STEP - 5_000, P + STEP, 2, 2);
      if (early.length === 0 && buzzer.length === 1 && buzzer[0].price === r.ladder[1]) return null;
      return `HARNESS DEAD: A=2 load, rung 0 standing, outranked at 5,000 in round 1 placed [${list(r.ladder, buzzer)}] `
        + `(+299 s read: ${early.length} bid(s)), expected exactly rung 1 (${r.ladder[1]}) - the harness is not reaching the bid path`;
    } finally { r.eng.kill('done'); }
  });

  await check(2, 'catchup_read_counts_two_rounds_floor_at_buzzer', 'mechanism', async () => {
    const r = await seeded('GC-CU-TWO', [0, 1], 1);
    try {
      const P = r.posted;
      const live = P + 3 * STEP;
      const reads = [...await tickAt(r, P, P + STEP, 2, 1), ...await tickAt(r, P + 2 * STEP + 30_000, live, 2, 1)];
      if (reads.length) return `HARNESS: ${list(r.ladder, reads)} placed on the extension reads (~270-299 s out)`;
      const middle = await tickAt(r, live - 10_500, live, 2, 1);
      const buzzer = await tickAt(r, live - 5_000, live, 2, 1);
      const bad = [];
      if (middle.length) bad.push(`10,500 placed ${list(r.ladder, middle)} (A=1: no middle shot)`);
      if (buzzer.length !== 1 || buzzer[0].price !== r.ladder[2]) {
        bad.push(`5,000 placed [${list(r.ladder, buzzer)}], expected exactly the FLOOR (${r.ladder[2]})`);
      }
      if (!bad.length) return null;
      return `reads at P+299,000 then one at P+897,000 (+598 s = rounds 2 and 3), cap 3, rank 2, A=1: `
        + `${bad.join('; ')} - ${MECHANISM}`;
    } finally { r.eng.kill('done'); }
  });

  await check(3, 'catchup_alone_is_not_final', 'guard', async () => {
    const r = await seeded('GC-CU-PRE', [0, 1], 1);
    try {
      const P = r.posted;
      const live = P + 2 * STEP;
      const all = [
        ...await tickAt(r, P + STEP + 30_000, live, 2, 1),
        ...await tickAt(r, live - 10_500, live, 2, 1),
        ...await tickAt(r, live - 5_000, live, 2, 1),
      ];
      if (!all.length) return null;
      return `one read at P+598,000 (round 2 of cap 3, pre-final), rank 2, A=1 placed ${all.map((b) => `${rungOf(r.ladder, b.price)} at ${b.countdown}`).join(', ')}, `
        + 'expected nothing - a +598 s read was counted as more than 2 rounds, or a pre-final round spent the floor';
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
  const guards = results.filter((x) => x.failure && !isHarness(x) && x.kind === 'guard');
  const mech = results.filter((x) => x.failure && !isHarness(x) && x.kind === 'mechanism');
  if (harness.length || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${results.length} of ${EXPECTED_CHECKS} checks ran; the control or the harness is broken, so the results above are not trustworthy`);
    process.exit(1);
  }
  if (guards.length) {
    console.log('\nFAIL - guard check 3: a single +598 s read on a cap-3 load took a bid at the buzzer - '
      + 'the catch-up read was over-counted into a final round');
    process.exit(1);
  }
  if (mech.length) {
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${MECHANISM}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: a +598 s GoComet read counts two rounds`);
});
