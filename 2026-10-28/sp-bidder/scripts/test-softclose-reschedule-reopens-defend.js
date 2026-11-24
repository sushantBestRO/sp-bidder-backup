'use strict';
/**
 * A shipper rescheduling the close must re-open the once-per-round soft defend for the new window,
 * without spending an anti-snipe round.
 *
 * The defend fires at most once per extension round, and the only thing that re-opens it is
 * extendsObserved advancing. A reschedule (a move of well over one published increment) deliberately
 * does not advance extendsObserved, so once a defend has fired the whole rescheduled window - up to an
 * hour - has no defend left: a rival can take L1 and the engine does nothing until the last tick.
 *
 * Must NOT move: the reschedule is still not counted as a round, the defend stays once per window (a
 * second tick in the new window holds), and the latch still holds before the reschedule arrives.
 *
 *   node scripts/test-softclose-reschedule-reopens-defend.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 5;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const EXTEND_MS = 120_000;
const EXTEND_CAP = 2;
const INSIDE_WINDOW_MS = 50_000;
const LADDER = [10_000, 9_700, 9_400, 9_100, 8_800, 8_000];

const store = path.join(os.tmpdir(), `sc-reschedule-defend-${process.pid}.json`);
let eng;
const cleanup = () => {
  try { if (eng) eng.kill(); } catch (_) {}
  try { fs.unlinkSync(store); } catch (_) {}
};

const frame = (closesAtMs, closesInMs = INSIDE_WINDOW_MS) => ({ ok: true, closesAtMs, closesInMs,
  extendMs: EXTEND_MS, extendCount: EXTEND_CAP, myRank: 2, totalBidders: 6, minDecrement: 100 });
const outranked = () => ({ closesInMs: INSIDE_WINDOW_MS, myRank: 2, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });

(async () => {
  const placed = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
  };
  eng = new BidEngine(adapter, new DurableScheduler(store), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
  });
  // named re-pin: round tracker, ruling 56 - the genuine round is read inside the 100 s trigger window
  // (a move seen before it opens is a reschedule); the five-increment move is still read outside it.
  const T = Date.now() + 60_000;
  const m = eng.arm({ id: 'RESCHDEF', lane: { origin: 'Alwar', destination: 'Pune' }, units: 1,
    companyName: 'Havells', branchName: 'Alwar', closesAt: T }, { cost: 7_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = LADDER[LADDER.length - 1];
  m.closeModel = 'soft';
  m._zeroSince = null;
  m.revisionsLeft = 30;
  m.triggerWindowMs = 100_000;
  m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = LADDER[0]; m.landedBids = 1;
  assert.strictEqual(m.softStrategy, 'live', 'fixture: load is not on the live soft allowlist');
  assert.strictEqual(m.believedCloseAt, T, 'fixture: arm() did not seed the belief from the arm-time close');

  // One genuine anti-snipe round, then the round's one defend.
  eng._observeExtension(m, frame(T + EXTEND_MS));
  assert.strictEqual(m.extendsObserved, 1, 'fixture: the one-increment round was not counted');
  assert.strictEqual(eng._effectivelyHard(m), false, 'fixture: cap 2 with one round must leave extensions');
  await eng._maybeBid(m, outranked());
  assert.deepStrictEqual(placed, [LADDER[1]], 'fixture: the round\'s defend did not fire rung 1');
  assert.strictEqual(m._lastDefendAtExtend, 1, 'fixture: the defend did not latch round 1');
  ok('fixture: one counted round, one defend fired and latched for it');

  assert.strictEqual(eng._decide(m, outranked()), null, 'control: a second defend in the same round was not held');
  ok('control: before any reschedule, the round latch holds the next defend');

  // The shipper moves the close out by five increments.
  const moved = eng._observeExtension(m, frame(m.believedCloseAt + 5 * EXTEND_MS));
  assert.strictEqual(moved, false, 'the reschedule was reported as a round');
  assert.strictEqual(m.extendsObserved, 1,
    `the reschedule moved extendsObserved to ${m.extendsObserved} - it must not spend a cap round`);
  ok('the reschedule is not counted as a round');

  const d = eng._decide(m, outranked());
  assert.ok(d && d.defend === true,
    `outranked inside the rescheduled window, _decide returned ${JSON.stringify(d)} - the once-per-round defend latch `
    + `is still closed at extendsObserved ${m.extendsObserved}, so no defend is possible until the last tick`);
  assert.strictEqual(d.rungIndex, 2, `the re-opened defend chose rung ${d.rungIndex}, expected the next rung down (2)`);
  ok('outranked in the rescheduled window, _decide returns a defend rung again');

  await eng._maybeBid(m, outranked());
  assert.deepStrictEqual(placed, [LADDER[1], LADDER[2]], 'the re-opened defend did not reach the wire');
  assert.strictEqual(eng._decide(m, outranked()), null, 'a second defend fired inside the same rescheduled window');
  assert.strictEqual(m.extendsObserved, 1, 'the defend in the rescheduled window moved extendsObserved');
  ok('the re-opened defend fires once, then holds for the rest of the window');

  cleanup();
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  cleanup();
  console.error('\nFAILED:', e && e.stack || e);
  process.exit(1);
});
