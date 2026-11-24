'use strict';
/**
 * The edges of the soft-close round counter in _observeExtension: where a forward move of the live
 * close stops being one anti-snipe round and becomes a shipper reschedule (P1), and which late frames
 * are the same round we already inferred from a zeroed countdown (E4).
 *
 *   1 P1  published 180 s, +300 s (1.67x): a reschedule, not a round. The belief and the durable
 *         intent still follow it. A bound at 1.9x or at 2x counts it and spends a cap-1 round.
 *   2 P1  published 120 s, +192 s (1.6x): not a round either.
 *   3 P1  published 120 s, +122.7 s: one round. The REST close and the live close have drifted by
 *         seconds on the same load, so a bound at exactly 1.0x would drop genuine rounds. (guard)
 *   4 E4  no published increment, a frozen close, then a +3600 s late frame: ONE round, however
 *         far the catch-up frame moves the close.
 *   5 E4  no published increment, a frozen close, then a +120 s late frame (0.67x of the 180 s
 *         fallback, a real 120 s round): one round. (guard)
 *   6 E4 before P1  published 120 s, a frozen close, then a 2.5x late frame: one round, and the
 *         next genuine round counts too.
 *   7 P1 through the real SuperProcure adapter and _tick: branchAuctionExtendTime '00:02:00'
 *         surfaces as extendMs 120000, so a +300 s reschedule is not counted and a +122.7 s
 *         round after it is.
 *
 * named re-pin: round tracker, ruling 56. The frozen-zero inference is retired (4-6 now pin the
 * published late frame), and a round is counted only when read inside the old close's trigger window
 * (3, the round in 6 and the round in 7 are read there, on a virtual clock). The fixture publishes the
 * 100 s window, as SuperProcure does alongside the increment (7 reads it off the real adapter).
 *
 *   node scripts/test-softclose-round-count-bounds.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

const EXPECTED_CHECKS = 7;
const DRIFTED_ROUND_MS = 122_700;
const TRIGGER_WINDOW_MS = 100_000;

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const STORES = [];
const ENGINES = [];
const cleanup = () => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of STORES) { try { fs.unlinkSync(f); } catch (_) {} }
};

function newEngine(adapter, tag, shipper) {
  const store = path.join(os.tmpdir(), `sc-round-bounds-${tag}-${process.pid}.json`);
  STORES.push(store);
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(store), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: [shipper], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
  });
  ENGINES.push(eng);
  return { eng, events };
}

function mkLoad(tag) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('no wire write may happen in this test'); },
  };
  const { eng, events } = newEngine(adapter, tag, 'Havells');
  const T = Date.now() + 600_000;
  const m = eng.arm({ id: `RCB-${tag}`, lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName: 'Havells', branchName: 'ALWAR', closesAt: T }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m._zeroSince = null;
  assert.strictEqual(m.softStrategy, 'live', 'fixture: load is not on the live soft allowlist');
  assert.strictEqual(m.believedCloseAt, T, 'fixture: arm() did not seed the belief from the arm-time close');
  const extensions = () => events.filter((e) => e.type === 'extension_observed' && e.auctionId === m.auctionId).length;
  const durableClose = () => eng.scheduler.get(m.auctionId).closesAt;
  return { eng, m, T, extensions, durableClose };
}

// extendMs undefined = the branch publishes no increment (engine sizes against the 180 s fallback).
const frame = (closesAtMs, closesInMs, extendMs, extendCount) => {
  const f = { ok: true, closesAtMs, closesInMs, extendCount, triggerWindowMs: TRIGGER_WINDOW_MS, myRank: 3,
    totalBidders: 4, minDecrement: 100 };
  if (extendMs !== undefined) f.extendMs = extendMs;
  return f;
};

// A sustained zeroed countdown past the believed close, stamped the way _tick stamps _zeroSince. It
// counts nothing; the late frame is read a second after it, with the countdown live again.
function freezeAtClose({ eng, m, T }, extendMs, cap) {
  vnow = T - 300_000;
  eng._observeExtension(m, frame(T, 300_000, extendMs, cap));
  vnow = T + eng.cfg.finalizeDebounceMs + 1_000;
  m._zeroSince = T;
  const counted = eng._observeExtension(m, frame(T, 0, extendMs, cap));
  vnow += 1_000;
  m._zeroSince = null;
  assert.strictEqual(counted, false, 'fixture: the frozen zero counted a round');
  assert.strictEqual(m.extendsObserved, 0, 'fixture: the frozen zero must count nothing');
}

// Read inside the trigger window of the close the load currently believes.
const inWindow = (m) => { vnow = m.believedCloseAt - 60_000; };

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('1 P1: a +300 s move on a published 180 s increment (1.67x) is a reschedule, not a round', () => {
  // Arrange
  const x = mkLoad('p1-180-300');
  // Act
  x.eng._observeExtension(x.m, frame(x.T + 300_000, 139_500, 180_000, 1));
  // Assert
  assert.strictEqual(x.m.extendsObserved, 0,
    `close RESCHEDULE counted as ${x.m.extendsObserved} anti-snipe round(s): +300000ms is 1.67x the published `
    + '180000ms increment, over the 1.5x reschedule bound, yet it reached the counting branch');
  assert.strictEqual(x.extensions(), 0, 'a reschedule emitted extension_observed');
  assert.strictEqual(x.eng._effectivelyHard(x.m), false, 'cap 1 read as spent by a reschedule');
  assert.strictEqual(x.m.believedCloseAt, x.T + 300_000, 'the belief did not follow the reschedule');
  assert.strictEqual(x.durableClose(), x.T + 300_000, 'the reschedule did not reach the durable intent');
});

check('2 P1: a +192 s move on a published 120 s increment (1.6x) is not a round', () => {
  const x = mkLoad('p1-120-192');
  x.eng._observeExtension(x.m, frame(x.T + 192_000, 139_500, 120_000, 1));
  assert.strictEqual(x.m.extendsObserved, 0,
    `a 1.6x move of a published 120000ms increment counted as ${x.m.extendsObserved} round(s)`);
  assert.strictEqual(x.m.believedCloseAt, x.T + 192_000, 'the belief did not follow the 1.6x move');
});

check('3 P1 guard: a genuine round with 2.7 s of close drift (1.0225x of 120 s) is counted', () => {
  const x = mkLoad('p1-120-drift');
  inWindow(x.m);
  x.eng._observeExtension(x.m, frame(x.T + DRIFTED_ROUND_MS, 117_000, 120_000, 1));
  assert.strictEqual(x.m.extendsObserved, 1,
    `a genuine round measured at +${DRIFTED_ROUND_MS}ms on a published 120000ms increment was not counted - `
    + 'the reschedule bound sits at or below 1.0x and drops rounds that carry seconds of close drift');
  assert.strictEqual(x.extensions(), 1, 'the drifted round did not emit extension_observed');
  assert.strictEqual(x.m.believedCloseAt, x.T + DRIFTED_ROUND_MS, 'the belief did not follow the drifted round');
});

check('4 E4: a +3600 s late frame after a frozen close (unpublished increment) is one round', () => {
  // Arrange
  const x = mkLoad('e4-3600');
  freezeAtClose(x, undefined, 2);
  // Act
  x.eng._observeExtension(x.m, frame(x.T + 3_600_000, 3_597_000, undefined, 2));
  // Assert
  assert.strictEqual(x.m.extendsObserved, 1,
    `the late frame for the hidden round counted ${x.m.extendsObserved} rounds. A +3600000ms catch-up (20x the `
    + '180000ms fallback) read a second after the close can hold one round');
  assert.strictEqual(x.extensions(), 1, 'the late frame did not emit one extension_observed');
  assert.strictEqual(x.eng.roundVerdict(x.m).verdict, 'UNCERTAIN', 'a 20x catch-up must leave the round UNCERTAIN');
  assert.strictEqual(x.m.believedCloseAt, x.T + 3_600_000, 'the belief did not catch up to the late frame');
  assert.strictEqual(x.durableClose(), x.T + 3_600_000, 'the adopted close did not reach the durable intent');
});

check('5 E4 guard: a real 120 s round published late against the 180 s fallback (0.67x) is one round', () => {
  const x = mkLoad('e4-120');
  freezeAtClose(x, undefined, 2);
  x.eng._observeExtension(x.m, frame(x.T + 120_000, 117_000, undefined, 2));
  assert.strictEqual(x.m.extendsObserved, 1,
    `a 0.67x late frame for the hidden round counted ${x.m.extendsObserved} rounds`);
  assert.strictEqual(x.m.believedCloseAt, x.T + 120_000, 'the belief did not catch up to the 0.67x late frame');
});

check('6 E4 before P1: a 2.5x late frame on a published 120 s increment is one round, then the next round counts', () => {
  // Arrange
  const x = mkLoad('e4-published');
  freezeAtClose(x, 120_000, 3);
  // Act
  x.eng._observeExtension(x.m, frame(x.T + 300_000, 297_000, 120_000, 3));
  // Assert
  assert.strictEqual(x.m.extendsObserved, 1,
    `the 2.5x late frame for the hidden round counted ${x.m.extendsObserved} rounds`);
  inWindow(x.m);
  x.eng._observeExtension(x.m, frame(x.T + 420_000, 117_000, 120_000, 3));
  assert.strictEqual(x.m.extendsObserved, 2,
    `the genuine round after the adopted late frame was not counted: extendsObserved ${x.m.extendsObserved}`);
});

check('7 P1 through the real adapter: extendMs 120000 from 00:02:00, +300 s not counted, +122.7 s round counted', async () => {
  // Arrange: a cached listing row, the socket carrying the live close.
  const T = Date.now() + 20 * 60_000;
  const live = { loadEndTimeMs: null, myRank: null, bids: [], extended: false };
  const sock = {
    state: () => live,
    watch: () => {},
    closesInMs: (_id, fallback) => { const end = live.loadEndTimeMs || fallback; return end ? Math.max(0, end - Date.now()) : null; },
  };
  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN', sock });
  a.writeEnabled = false;
  a.placeBid = async () => { throw new Error('no wire write may happen in this test'); };
  const id = 25434318;
  const mapped = a._mapLoad({ id, companyName: 'Vishal Pipes Ltd', branchName: 'Sikandrabad - PMT', biddingOn: 1,
    biddingStartTime: new Date(Date.now() - 60_000).toISOString(), biddingCloseTime: new Date(T).toISOString(),
    branchAuctionExtendTime: '00:02:00', branchExtendAuctionCount: 1, branchAuctionRemainingTime: 100,
    branchQuoteType: 'FTL', rateType: 'FTL', loadShipmentType: 'FTL', vehicleCount: 1,
    sourceCity: 'Sikandrabad', destinationCity: 'PMT' });
  a.loadMeta.set(String(id), mapped);
  live.loadEndTimeMs = mapped.closesAt;
  const { eng, events } = newEngine(a, 'adapter', 'Vishal Pipes');
  const m = eng.arm(mapped, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  const settle = () => { if (m.timer) clearTimeout(m.timer); m.timer = null; };
  settle();
  const st = await a.getAuctionState(id);
  assert.strictEqual(st.extendMs, 120_000, `fixture: 00:02:00 surfaced as extendMs ${st.extendMs}, not 120000 ms`);
  assert.strictEqual(st.closeModel, 'soft', 'fixture: a 00:02:00 branch did not surface as soft');
  assert.strictEqual(m.believedCloseAt, mapped.closesAt, 'fixture: arm() did not seed the belief from the REST close');
  const extensions = () => events.filter((e) => e.type === 'extension_observed' && e.auctionId === m.auctionId).length;

  // Act: the shipper moves the close out 300 s.
  live.loadEndTimeMs = mapped.closesAt + 300_000;
  await eng._tick(m);
  settle();

  // Assert
  assert.strictEqual(m.softStrategy, 'live', 'fixture: the real-adapter load did not reach the live soft path');
  assert.strictEqual(m.extendsObserved, 0,
    `through the real adapter, a +300000ms reschedule on a 00:02:00 branch counted as ${m.extendsObserved} round(s) `
    + `(state.extendMs ${st.extendMs}): cap 1 spent before a single real round`);
  assert.strictEqual(extensions(), 0, 'through the real adapter, a reschedule emitted extension_observed');
  assert.strictEqual(m.believedCloseAt, mapped.closesAt + 300_000, 'through the real adapter, the belief did not follow the reschedule');
  assert.strictEqual(eng.scheduler.get(m.auctionId).closesAt, mapped.closesAt + 300_000,
    'through the real adapter, the reschedule did not reach the durable intent');

  inWindow(m);
  live.loadEndTimeMs = mapped.closesAt + 300_000 + DRIFTED_ROUND_MS;
  await eng._tick(m);
  settle();
  assert.strictEqual(m.extendsObserved, 1,
    `through the real adapter, a genuine +${DRIFTED_ROUND_MS}ms round after the reschedule counted as ${m.extendsObserved}`);
  assert.strictEqual(extensions(), 1, 'through the real adapter, the genuine round did not emit extension_observed');
});

(async () => {
  let pass = 0;
  const fails = [];
  for (const [name, fn] of checks) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fails.push(name); console.log(`  FAIL ${name} :: ${String(e.message).split('\n')[0]}`); }
  }
  cleanup();
  if (fails.length || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAIL - ${pass}/${EXPECTED_CHECKS} checks passed`);
    process.exit(1);
  }
  console.log(`\nPASS - ${pass}/${EXPECTED_CHECKS} checks`);
})().catch((e) => { console.error(`\nFAIL - ${e.message}`); cleanup(); process.exit(1); });
