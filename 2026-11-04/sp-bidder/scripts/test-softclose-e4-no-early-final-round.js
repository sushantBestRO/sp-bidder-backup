'use strict';
/**
 * SOFT-CLOSE E4: NO EARLY FINAL ROUND - an order pin for the soft-close fix after the extension cap.
 *
 * The soft-close fix makes "extendsObserved >= extendCap" the trigger for final-seconds treatment. An over-counted
 * round therefore fires the final bid a round early. The E4 sequence (T7 E4, BH-STATE-1) is the known
 * over-count: a round inferred from a sustained zeroed countdown, then the platform publishing that same
 * round's close late, on a branch whose real increment (300 s) misses the 1.5x window of the 180 s
 * fallback. The round-counting fix (7c41153) counts it once. This file pins that the count stays at one AND that the load is then
 * still decided as pre-cap, so the soft-close fix cannot land on a tree where E4 double counts.
 *
 * Must NOT move:
 *   1 e4-counts-once                   after the E4 sequence on a cap-2 load, extendsObserved === 1.
 *   2 e4-still-precap                  at 101,900 ms (just outside the 100 s trigger window), outranked,
 *                                      revisions with slack: NO bid - the outside-the-window hold.
 *                                      CONTROL: the same load after one more genuine round (post-cap)
 *                                      DOES bid at 101,900 on base (the band shot) and would under the
 *                                      fix (a step-down or final shot), so a hold here is the count.
 *   3 e4-no-final-treatment-in-window  at 50,000 ms, outranked, the round's defend unspent: the decision,
 *                                      if any, is a middle rung, never the floor.
 *
 * Expected RED on main f1b2066 without 7c41153 (the double count); green from d3bf803 on.
 *
 * named re-pin: round tracker, ruling 56. The E4 sequence no longer infers a round from the frozen
 * zero: the zero counts nothing and the late 300 s frame (read a second after the close) is the one
 * round, off the 180 s fallback grid. The frames publish the 100 s trigger window, reads run on a
 * virtual clock, and the post-cap control twin's extra round is one on-grid fallback increment read
 * inside its window, so it reads FINAL (a second off-grid round would stay UNCERTAIN, not post-cap).
 *
 *   node scripts/test-softclose-e4-no-early-final-round.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const FALLBACK_EXTEND_MS = 180_000;
const REAL_EXTEND_MS = 300_000;
const EXTEND_CAP = 2;
const TRIGGER_MS = 100_000;

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

let ran = 0;
let pass = 0;
const FAILURES = [];
const STORES = [];
const ENGINES = [];

const EXPECTED_CASES = 3;
process.on('exit', (code) => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of STORES) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nPASS - soft-close E4 no early final round: ${pass}/${EXPECTED_CASES} cases`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

function run(name, fn) {
  ran++;
  try { fn(); pass++; console.log('  ok   ' + name); } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
  }
}

function mkLoad(tag) {
  const store = path.join(os.tmpdir(), `sc-e4-no-early-final-${tag}-${process.pid}.json`);
  STORES.push(store);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('no wire write may happen in this test'); },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(store), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  const T = Date.now() + 600_000;
  const m = eng.arm({ id: `E4NF-${tag}`, lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1,
    companyName: 'Havells', branchName: 'ALWAR', closesAt: T }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  return { eng, m, T };
}

// The E4 frames, as in test-softclose-inferred-round-counted-once.js: no extendMs published, so the
// engine sizes a round against the 180 s fallback.
const frame = (closesAtMs, closesInMs) => ({ ok: true, closesAtMs, closesInMs, extendCount: EXTEND_CAP,
  triggerWindowMs: TRIGGER_MS, myRank: 3, totalBidders: 4, minDecrement: 100 });

function runE4({ eng, m, T }) {
  vnow = T - 300_000;
  eng._observeExtension(m, frame(T, 300_000));
  vnow = T + eng.cfg.finalizeDebounceMs + 1_000;
  m._zeroSince = T;
  const counted = eng._observeExtension(m, frame(T, 0));
  vnow += 1_000;
  m._zeroSince = null;
  assert.strictEqual(counted, false, 'PRECONDITION: the frozen zero counted a round');
  assert.strictEqual(m.extendCap, EXTEND_CAP, 'PRECONDITION: extendCap not surfaced from the frame');
  eng._observeExtension(m, frame(T + REAL_EXTEND_MS, REAL_EXTEND_MS - 3_000));
}

// Established at rung 0 (landed), trigger window published, revisions well above the reserve.
function standEstablished(m) {
  m.triggerWindowMs = TRIGGER_MS;
  m.firedRungs.add(0);
  m.currentRungIndex = 0;
  m.lastBidPrice = m.ladder[0];
  m.landedBids = 1;
  m.revisionsLeft = 8;
}

const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null });

console.log('soft-close E4 no early final round');

const load = mkLoad('once');
assert.notStrictEqual(load.m.softStrategy, 'off', 'PRECONDITION: softStrategy off short-circuits _observeExtension');

run('1 e4-counts-once: an inferred round published late is one round (extendsObserved 1 of cap 2)', () => {
  // Arrange / Act
  runE4(load);
  // Assert
  assert.strictEqual(load.m.extendsObserved, 1,
    `the E4 round was counted ${load.m.extendsObserved} times - ruling: an inferred round whose close the `
    + 'platform publishes late is ONE round; counted twice, the cap-2 load reads as post-cap and the soft-close fix fires its '
    + 'final bid a round early');
});

run('2 e4-still-precap: no bid at 101,900 ms (outside the window); post-cap control does bid', () => {
  // Arrange
  const { eng, m } = load;
  standEstablished(m);
  const last = m.ladder.length - 1;
  assert.ok(m.revisionsLeft - eng.softCfg.reserve > 0, 'PRECONDITION: revisions must have slack above the reserve');
  const twin = mkLoad('postcap');
  runE4(twin);
  vnow = twin.T + REAL_EXTEND_MS - 60_000;
  twin.eng._observeExtension(twin.m, frame(twin.T + REAL_EXTEND_MS + FALLBACK_EXTEND_MS, FALLBACK_EXTEND_MS - 3_000));
  standEstablished(twin.m);
  assert.ok(twin.m.extendsObserved >= EXTEND_CAP, 'PRECONDITION: the control twin must be post-cap');
  // Act
  const d = eng._decide(m, st(101_900, 2));
  const c = twin.eng._decide(twin.m, st(101_900, 2));
  // Assert
  assert.ok(c != null,
    'CONTROL: the post-cap twin held at 101,900 ms outranked - the rig cannot tell a pre-cap hold from a post-cap load');
  assert.strictEqual(d, null,
    `pre-cap load bid ${JSON.stringify(d)} at 101,900 ms (floor rung ${last}) - ruling: with a round still left `
    + 'an outranked load holds outside the trigger window; a bid here is final-round treatment a round early');
});

run('3 e4-no-final-treatment-in-window: at 50,000 ms the decision, if any, is a middle rung, never the floor', () => {
  // Arrange
  const { eng, m } = load;
  const last = m.ladder.length - 1;
  assert.strictEqual(m.extendsObserved, 1, 'PRECONDITION: still one round observed');
  assert.notStrictEqual(m._lastDefendAtExtend, m.extendsObserved, 'PRECONDITION: this round\'s defend is unspent');
  // Act
  const d = eng._decide(m, st(50_000, 2));
  // Assert
  if (d != null) {
    assert.ok(d.rungIndex > m.currentRungIndex && d.rungIndex < last && d.price > m.ladder[last],
      `pre-cap in-window decision was ${JSON.stringify(d)} (floor rung ${last}, price ${m.ladder[last]}) - ruling: `
      + 'before the cap the floor is kept for the final round; an in-window defend is a middle rung');
  }
});
