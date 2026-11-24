'use strict';
/**
 * SOFT-CLOSE-AFTER-CAP FIX LEAVES HARD CLOSE AND RANK-1 HOLDS ALONE - positive pins for the soft-close fix after the extension cap.
 *
 * The soft-close fix changes the allowlisted SuperProcure SOFT-close endgame: after a known extension cap the
 * decisive bid moves from the 100-102.5 s band to the last 2.5 s, the single-shot latch is lifted on
 * soft close, and a <= 3-bid branch keeps its last bid for the final round. None of that may reach a
 * HARD-close load or a load we are winning. These checks pin what must not move:
 *
 *   1. A 3-price / 3-bid hard load on a NON-allowlisted shipper (Durian's shape) bids exactly
 *      establish -> one scheduled step-down -> floor in the last 2.5 s.
 *   2. The same load on an ALLOWLISTED (rank-driven) shipper bids the same three.
 *   3. Rank 1 holds: once the establish lands and we read rank 1, nothing more is sent - on a hard
 *      close, and on an allowlisted soft load post-cap, pre-cap and with an unknown cap.
 *
 * Also safe against the hard-close floor reserve change (hard close keeps its last revision for the floor on a tight budget): the
 * 3-price / 3-bid shape spends one revision on the step-down and keeps the third for the floor, which
 * is the walk T5 leaves unchanged.
 *
 * Mechanism: the REAL _maybeBid is driven down the load's countdown on a virtual clock, stepped by the
 * engine's own _cadence, with production timing knobs and `rand` stubbed to 0.5, against a fake adapter
 * that accepts every bid. Offline, no network, no wall-clock waits.
 *
 *   node scripts/test-softclose-fix-leaves-hardclose-alone.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

// Production engine knobs (src/config.js engine + antiDetection), as literals.
const PROD = { openAtMs: 25_000, openJitterMs: 4_000, floorWindowMs: 2_500, cadenceJitterMs: 250,
  minInterFireMs: 150, maxBidsPerMin: 20, rungs: 6, rungCap: 0 };
const RAND = 0.5;
// 25,000 + floor(0.5 x 4,000): the hard-close establish mark under the stubbed rand.
const ESTABLISH_MARK = 27_000;
// 1,000 + floor(0.5 x 250): the mid poll under the stubbed rand, i.e. the widest step near the mark.
const MID_STEP = 1_125;
const FLOOR_WINDOW = 2_500;
const HOT_STEP = 200;
// Vishal Pipes soft branch: trigger 100 s, extension 120 s, 3 bids, cap 1.
const TRIGGER_MS = 100_000;
const EXTEND_MS = 120_000;
const CLOCK_EPOCH = 1_790_000_000_000;

const PREFIX = `t4-pins-hard-${process.pid}-`;
let seq = 0;
const tmp = () => path.join(os.tmpdir(), `${PREFIX}${seq++}.json`);
const cleanup = () => {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch (_) {}
  for (const n of names) if (n.startsWith(PREFIX)) { try { fs.unlinkSync(path.join(os.tmpdir(), n)); } catch (_) {} }
};

const ENGINES = [];
let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CASES = 3;
process.on('exit', (code) => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nsoft-close fix leaves hard close alone: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});
async function runAsync(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

function mkEngine({ allowlist }) {
  const sends = [];
  const clock = { remaining: null };
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: null, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => {
      sends.push({ price, remaining: clock.remaining });
      return { accepted: true, status: 201, myRank: null, revisionsLeft: null };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: PROD,
    softClose: { enabled: true, shippers: allowlist, mode: 'live', reserve: 1 },
    rand: () => RAND,
    onEvent: () => {},
  });
  eng._sends = sends;
  eng._clock = clock;
  eng._vnow = CLOCK_EPOCH;
  ENGINES.push(eng);
  return eng;
}

const LIMITS = new WeakMap();

// SP reports revisionLimit (the branch bid cap) and revisionsLeft null; the engine seeds its own count
// from revisionLimit on the first read, set here because the drive calls _maybeBid, not _tick.
function armLoad(eng, { companyName, closeModel, revisionLimit = 3, extendCap = null, extendsObserved = 0,
  triggerWindowMs = null, extendMs = null }) {
  const meta = { id: String(900_000 + ++seq), lane: { origin: 'Pune', destination: 'Nagpur' }, units: 1,
    companyName, branchName: 'MAIN', closesAt: Date.now() + 900_000,
    rules: { revisionLimit, minDecrement: 100 } };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.extendCap = extendCap;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = triggerWindowMs;
  m.extendMs = extendMs;
  m.revisionsLeft = revisionLimit;
  LIMITS.set(m, revisionLimit);
  return m;
}

const spState = (m, remaining, myRank) => ({
  ok: true, status: 'live', myRank, totalBidders: 4, standingL1Price: null, closesInMs: remaining,
  revisionLimit: LIMITS.get(m), revisionsLeft: null, minDecrement: 100, closeModel: m.closeModel,
  extendMs: m.extendMs, extendCount: m.extendCap, triggerWindowMs: m.triggerWindowMs, measuredRttMs: 80,
});

async function drive(eng, m, { from, to = 0, rank, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  Date.now = () => eng._vnow;
  const ticks = [];
  try {
    let r = from;
    while (r >= to && ticks.length < maxTicks) {
      eng._clock.remaining = r;
      const k = typeof rank === 'function' ? rank(m, r) : rank;
      ticks.push({ remaining: r, rank: k });
      await eng._maybeBid(m, spState(m, r, k));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      eng._vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
  assert.ok(ticks.length < maxTicks, 'PRECONDITION: the drive hit its tick guard - the cadence stopped advancing');
  const sends = eng._sends.map((s) => ({ rungIndex: m.ladder.indexOf(s.price), price: s.price, remaining: s.remaining }));
  return { sends, ticks };
}

const fmt = (sends) => '[' + sends.map((s) => `rung ${s.rungIndex} @ ${s.remaining}ms`).join(', ') + ']';
const outrankedAfterEstablish = (mon) => (mon.landedBids > 0 ? 2 : null);
const leadingAfterEstablish = (mon) => (mon.landedBids > 0 ? 1 : null);

// The Durian sequence: rung 0 on the first tick at or under the establish mark, rung 1 on the very next
// (outranked) tick, rung 2 (the floor) on the first tick inside the 2.5 s window, and nothing after.
function assertDurianSequence(label, m, { sends, ticks }) {
  assert.strictEqual(m.ladder.length, 3, `PRECONDITION (${label}): a revisionLimit-3 load must arm the coarse 3-price ladder`);
  assert.strictEqual(sends.length, 3,
    `${label}: hard close sent ${sends.length} bids ${fmt(sends)} - a 3-price / 3-bid hard load must send exactly `
    + 'establish, one step-down and the floor; the soft-close-after-cap fix must not move hard close');
  const [est, step, floor] = sends;

  const firstAtMark = ticks.find((t) => t.remaining <= ESTABLISH_MARK);
  assert.strictEqual(est.rungIndex, 0, `${label}: the first bid was rung ${est.rungIndex}, not the establish rung 0 ${fmt(sends)}`);
  assert.strictEqual(est.remaining, firstAtMark.remaining,
    `${label}: the establish went at ${est.remaining}ms, not on the first tick at or under the ${ESTABLISH_MARK}ms `
    + `hard-close mark (${firstAtMark.remaining}ms) - hard-close establish timing moved`);
  assert.ok(est.remaining > ESTABLISH_MARK - MID_STEP - 125 && est.remaining <= ESTABLISH_MARK,
    `${label}: establish at ${est.remaining}ms is outside one mid poll of the ${ESTABLISH_MARK}ms mark`);

  const estIdx = ticks.findIndex((t) => t.remaining === est.remaining);
  assert.strictEqual(step.rungIndex, 1, `${label}: the second bid was rung ${step.rungIndex}, not the step-down rung 1 ${fmt(sends)}`);
  assert.strictEqual(step.remaining, ticks[estIdx + 1].remaining,
    `${label}: the step-down went at ${step.remaining}ms, not on the first outranked tick after the establish `
    + `(${ticks[estIdx + 1].remaining}ms) - the hard-close step-down moved`);
  assert.ok(step.remaining > FLOOR_WINDOW,
    `${label}: the step-down went inside the final window (${step.remaining}ms)`);

  const firstInWindow = ticks.find((t) => t.remaining <= FLOOR_WINDOW);
  assert.strictEqual(floor.rungIndex, 2, `${label}: the third bid was rung ${floor.rungIndex}, not the floor rung 2 ${fmt(sends)}`);
  assert.strictEqual(floor.remaining, firstInWindow.remaining,
    `${label}: the floor went at ${floor.remaining}ms, not on the first tick inside the ${FLOOR_WINDOW}ms window `
    + `(${firstInWindow.remaining}ms) - the hard-close floor snipe moved`);
  assert.ok(floor.remaining > FLOOR_WINDOW - HOT_STEP && floor.remaining <= FLOOR_WINDOW,
    `${label}: the floor at ${floor.remaining}ms is not within one hot poll inside the ${FLOOR_WINDOW}ms window`);
  assert.strictEqual(m.revisionsLeft, 0, `${label}: the three bids must have spent the whole 3-bid budget`);
}

(async () => {
  console.log('soft-close fix leaves hard close alone');

  await runAsync('1 hard-nonallowlisted-durian: establish, scheduled step-down, floor at <= 2,500 ms', async () => {
    const eng = mkEngine({ allowlist: ['Havells'] });
    const m = armLoad(eng, { companyName: 'Durian Industries', closeModel: 'hard' });
    assert.strictEqual(m.softStrategy, 'off', 'PRECONDITION: Durian must not be on the allowlist in this case');
    const run = await drive(eng, m, { from: 120_000, rank: outrankedAfterEstablish });
    assertDurianSequence('non-allowlisted hard', m, run);
  });

  await runAsync('2 hard-allowlisted-durian: the rank-driven path bids the same three', async () => {
    const eng = mkEngine({ allowlist: ['Durian'] });
    const m = armLoad(eng, { companyName: 'Durian Industries', closeModel: 'hard' });
    assert.strictEqual(m.softStrategy, 'live', 'PRECONDITION: Durian must be on the allowlist (rank-driven) in this case');
    const run = await drive(eng, m, { from: 120_000, rank: outrankedAfterEstablish });
    assertDurianSequence('allowlisted hard', m, run);
  });

  await runAsync('3 l1-holds: at rank 1 after the establish nothing more is sent (hard, soft post-cap, pre-cap, unknown cap)', async () => {
    const shapes = [
      { label: '(a) hard, non-allowlisted', allowlist: ['Havells'], companyName: 'Durian Industries',
        load: { closeModel: 'hard' }, from: 120_000 },
      { label: '(a) hard, allowlisted', allowlist: ['Durian'], companyName: 'Durian Industries',
        load: { closeModel: 'hard' }, from: 120_000 },
      { label: '(b) allowlisted soft, post-cap (cap 1, 1 observed)', allowlist: ['Vishal'], companyName: 'Vishal Pipes',
        load: { closeModel: 'soft', extendCap: 1, extendsObserved: 1, triggerWindowMs: TRIGGER_MS, extendMs: EXTEND_MS }, from: 200_000 },
      { label: '(c) allowlisted soft, pre-cap (cap 1, 0 observed)', allowlist: ['Vishal'], companyName: 'Vishal Pipes',
        load: { closeModel: 'soft', extendCap: 1, extendsObserved: 0, triggerWindowMs: TRIGGER_MS, extendMs: EXTEND_MS }, from: 200_000 },
      { label: '(d) allowlisted soft, unknown cap', allowlist: ['Vishal'], companyName: 'Vishal Pipes',
        load: { closeModel: 'soft', extendCap: null, extendsObserved: 0, triggerWindowMs: TRIGGER_MS, extendMs: EXTEND_MS }, from: 200_000 },
    ];
    for (const s of shapes) {
      const eng = mkEngine({ allowlist: s.allowlist });
      const m = armLoad(eng, Object.assign({ companyName: s.companyName }, s.load));
      if (s.load.closeModel === 'soft') {
        assert.strictEqual(m.softStrategy, 'live', `PRECONDITION ${s.label}: the soft load must be allowlisted`);
      }
      const { sends, ticks } = await drive(eng, m, { from: s.from, rank: leadingAfterEstablish });
      assert.ok(sends.length >= 1 && sends[0].rungIndex === 0,
        `PRECONDITION ${s.label}: the establish (rung 0) must land first; sent ${fmt(sends)}`);
      const after = ticks.filter((t) => t.remaining < sends[0].remaining);
      assert.ok(after.length >= 20 && after.some((t) => t.remaining <= FLOOR_WINDOW) && after[after.length - 1].remaining <= HOT_STEP,
        `PRECONDITION ${s.label}: the drive must carry the load from the establish through the final window to the buzzer`);
      assert.ok(after.every((t) => t.rank === 1), `PRECONDITION ${s.label}: every tick after the establish must read rank 1`);
      assert.strictEqual(sends.length, 1,
        `${s.label}: ${sends.length - 1} bid(s) went after the establish while we read rank 1 ${fmt(sends)} - `
        + 'SuperProcure holds at rank 1, so a leading load must never be bid again');

      // CONTROL: the same load read at rank 2 after the establish does send again, so the silence above
      // is the rank-1 hold and not a harness that cannot place a second bid.
      const ce = mkEngine({ allowlist: s.allowlist });
      const cm = armLoad(ce, Object.assign({ companyName: s.companyName }, s.load));
      const control = await drive(ce, cm, { from: s.from, rank: outrankedAfterEstablish });
      assert.ok(control.sends.length >= 2,
        `CONTROL ${s.label}: outranked after the establish the load sent only ${fmt(control.sends)} - the harness `
        + 'cannot see a second bid, so the rank-1 hold above proves nothing');
    }
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
