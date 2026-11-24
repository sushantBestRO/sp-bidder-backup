'use strict';
/**
 * A shipper moving the close by several increments is a RESCHEDULE, not an anti-snipe round - it must
 * not be counted (P1), whether or not a bid of ours is already standing.
 *
 * _observeExtension's counting branch has a lower bound only: any forward move of the live close of at
 * least half the published increment adds one to extendsObserved, and it reads no bid state. arm() seeds
 * believedCloseAt from the arm-time close, so when the shipper pushes the whole auction out, the next live
 * read is measured against the old close and counted as a round. On a cap-1 branch that spends the only
 * round - in the evidence, before our first bid, so _effectivelyHard was already true at the establish -
 * and the final floor is released inside what is really a live round.
 *
 * Scope: the bound applies to a PUBLISHED increment only. With no published increment the engine sizes
 * against a 180 s fallback, and a real 300 s round (1.67x of it) must still count.
 *
 * Evidence (Vishal Pipes, Sikandrabad - PMT, published increment 120 s, cap 1): 25434318 (+300 s),
 * 25435880 (+3600 s), 25536468 (+600 s) each carried extendsObserved 1 on the first bid record, and each
 * then ran one real +120 s round after our last bid.
 *
 * Must NOT move: a one-increment jump is still counted (control), an unpublished-increment 300 s round is
 * still counted, the belief still follows every forward move onto disk, and a genuine round after an
 * adopted reschedule is still counted (bound).
 *
 *   node scripts/test-softclose-reschedule-not-a-round.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 11;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const EXTEND_MS = 120_000;
const EXTEND_CAP = 1;
const TRIGGER_WINDOW_MS = 100_000;

// named re-pin: round tracker, ruling 56 - a round is counted only when it is read inside the old
// close's trigger window, so the counted reads below run on a clock set inside it (`inWindow`); every
// reschedule read stays at arm time, 600 s before the close.
const REAL_NOW = Date.now;
let vnow = null;
Date.now = () => (vnow == null ? REAL_NOW() : vnow);
function inWindow(closeAt, fn) {
  vnow = closeAt - 60_000;
  try { return fn(); } finally { vnow = null; }
}

const STORES = [];
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of STORES) { try { fs.unlinkSync(f); } catch (_) {} }
};

function mkLoad(tag) {
  const store = path.join(os.tmpdir(), `sc-reschedule-${tag}-${process.pid}.json`);
  STORES.push(store);
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('no wire write may happen in this test'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(store), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
  });
  ENGINES.push(eng);
  const T = Date.now() + 600_000;
  const m = eng.arm({ id: `P1-${tag}`, lane: { origin: 'SIKANDRABAD', destination: 'PMT' }, units: 1,
    companyName: 'Havells', branchName: 'Sikandrabad - PMT', closesAt: T }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m._zeroSince = null;
  const extensions = () => events.filter((e) => e.type === 'extension_observed' && e.auctionId === m.auctionId).length;
  const durableClose = () => eng.scheduler.get(m.auctionId).closesAt;
  return { eng, m, T, extensions, durableClose };
}

// The establish shape from the evidence: first live read ~139.5 s before the (new) close, no bid yet.
const frame = (closesAtMs, closesInMs = 139_500) => ({ ok: true, closesAtMs, closesInMs, extendMs: EXTEND_MS,
  extendCount: EXTEND_CAP, triggerWindowMs: TRIGGER_WINDOW_MS, myRank: null, totalBidders: 6, minDecrement: 100 });

function assertFixture({ m, T }) {
  assert.strictEqual(m.softStrategy, 'live', 'fixture: load is not on the live soft allowlist');
  assert.strictEqual(m.believedCloseAt, T, 'fixture: arm() did not seed the belief from the arm-time close');
  assert.strictEqual(m.extendsObserved, 0, 'fixture: a fresh load must start at 0 rounds');
  assert.strictEqual(m.landedBids || 0, 0, 'fixture: no bid may be on the board yet');
  assert.strictEqual(m._zeroSince, null, 'fixture: no frozen zero may be outstanding'); // named re-pin: round tracker, ruling 56
}

try {
  // ---- CONTROL: a one-increment jump is one round --------------------------------------------
  const c = mkLoad('control');
  assertFixture(c);
  ok('1 control fixture: live soft load, belief = arm-time close, no bids, no zero run');

  inWindow(c.T, () => c.eng._observeExtension(c.m, frame(c.T + EXTEND_MS)));
  assert.strictEqual(c.m.extendsObserved, 1, 'control: a 1.0x published jump was not counted');
  assert.strictEqual(c.extensions(), 1, 'control: the counted round did not emit extension_observed');
  assert.strictEqual(c.eng._effectivelyHard(c.m), true, 'control: cap 1 reached but _effectivelyHard is false');
  ok('2 control: a 1.0x jump is counted - the harness reaches the counting branch');

  // ---- THE DEFECT: the shipper moves the close out by 300 s (2.5x) ----------------------------
  // Arrange
  const d = mkLoad('resched300');
  assertFixture(d);

  // Act
  d.eng._observeExtension(d.m, frame(d.T + 300_000));

  // Assert
  assert.strictEqual(d.m.extendsObserved, 0,
    `close RESCHEDULE counted as an anti-snipe round: extendsObserved is ${d.m.extendsObserved}. The first live `
    + `read moved the close 300000ms (2.5x the published ${EXTEND_MS}ms increment) against the arm-time close, `
    + 'and the counting branch in _observeExtension counts any forward move >= 0.5x with no upper bound');
  ok('3 mechanism: a 2.5x move of the close is not counted as a round');

  assert.strictEqual(d.extensions(), 0, `a reschedule emitted ${d.extensions()} extension_observed events`);
  assert.strictEqual(d.eng._effectivelyHard(d.m), false,
    `_effectivelyHard is true before our first bid: cap ${EXTEND_CAP} read as spent by a reschedule`);
  ok('4 consequence: no extension_observed, the one allowed round is still unspent');

  assert.strictEqual(d.m.believedCloseAt, d.T + 300_000, 'the rescheduled close was not adopted into belief');
  assert.strictEqual(d.durableClose(), d.T + 300_000, 'the rescheduled close did not reach the durable intent');
  ok('5 belief and durable intent follow the reschedule forward');

  // ---- second evidence shape: a one-hour move (30x) -------------------------------------------
  const h = mkLoad('resched3600');
  assertFixture(h);
  h.eng._observeExtension(h.m, frame(h.T + 3_600_000));
  assert.strictEqual(h.m.extendsObserved, 0,
    `a one-hour reschedule counted as ${h.m.extendsObserved} round(s)`);
  assert.strictEqual(h.extensions(), 0, 'a one-hour reschedule emitted extension_observed');
  assert.strictEqual(h.m.believedCloseAt, h.T + 3_600_000, 'the one-hour reschedule was not adopted into belief');
  assert.strictEqual(h.durableClose(), h.T + 3_600_000, 'the one-hour reschedule did not reach the durable intent');
  ok('6 a 30x move is not counted as one round or as thirty, and the belief follows it');

  // ---- BOUND: a genuine round after the adopted reschedule is still counted --------------------
  inWindow(d.T + 300_000, () => d.eng._observeExtension(d.m, frame(d.T + 300_000 + EXTEND_MS, EXTEND_MS - 3_000)));
  assert.strictEqual(d.m.extendsObserved, 1, 'bound: a genuine 1.0x round after a reschedule was not counted');
  assert.strictEqual(d.extensions(), 1, 'bound: the genuine round did not emit extension_observed');
  ok('7 bound: the genuine round after the reschedule is counted');

  assert.strictEqual(d.eng._effectivelyHard(d.m), true, 'bound: cap 1 reached but _effectivelyHard is false');
  assert.strictEqual(d.durableClose(), d.T + 300_000 + EXTEND_MS, 'bound: the round close did not reach the durable intent');
  ok('8 bound: cap 1 is spent by the real round, effectively hard from there');

  // ---- scope: no published increment -> sized against the 180 s fallback, a 300 s round counts --
  const u = mkLoad('unpublished300');
  assertFixture(u);
  const unpublished = frame(u.T + 300_000);
  delete unpublished.extendMs;
  inWindow(u.T, () => u.eng._observeExtension(u.m, unpublished));
  assert.strictEqual(u.m.extendsObserved, 1,
    'unpublished increment: a 300 s round (1.67x the 180 s fallback) was not counted - the bound must apply '
    + 'to a PUBLISHED increment only');
  assert.strictEqual(u.extensions(), 1, 'unpublished increment: the round did not emit extension_observed');
  ok('9 unpublished-increment control: a 1.67x-of-fallback jump is still one counted round');

  // ---- mid-auction: a bid of ours is standing when the shipper moves the close ------------------
  const b = mkLoad('afterbid300');
  assertFixture(b);
  b.m.landedBids = 1;
  b.m.lastBidPrice = 78_820;
  b.eng._observeExtension(b.m, frame(b.T + 300_000));
  assert.strictEqual(b.m.extendsObserved, 0,
    `a reschedule with our bid standing counted as ${b.m.extendsObserved} round(s)`);
  assert.strictEqual(b.eng._effectivelyHard(b.m), false, 'a reschedule with our bid standing spent cap 1');
  assert.strictEqual(b.m.believedCloseAt, b.T + 300_000, 'a reschedule with our bid standing was not adopted');
  ok('10 a reschedule after our first bid is not counted either, and the belief follows it');

  // ---- threshold: exactly 2.0x the published increment is not one round ------------------------
  const x = mkLoad('resched240');
  assertFixture(x);
  x.eng._observeExtension(x.m, frame(x.T + 2 * EXTEND_MS));
  assert.strictEqual(x.m.extendsObserved, 0,
    `a 2.0x published jump counted as ${x.m.extendsObserved} round(s) - two increments cannot be one round`);
  assert.strictEqual(x.m.believedCloseAt, x.T + 2 * EXTEND_MS, 'a 2.0x jump was not adopted into belief');
  ok('11 threshold: a 2.0x jump on a published increment is not counted');

  assert.strictEqual(pass, EXPECTED_CHECKS);
  console.log(`\nPASS - ${pass}/${EXPECTED_CHECKS} checks`);
  cleanup();
} catch (e) {
  console.error(`\nFAIL after ${pass}/${EXPECTED_CHECKS} checks - ${e.message}`);
  cleanup();
  process.exit(1);
}
