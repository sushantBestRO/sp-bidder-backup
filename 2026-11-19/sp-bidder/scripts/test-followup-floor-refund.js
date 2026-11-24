'use strict';
/**
 * A follow-up floor that placed nothing gives its attempt back, and the count never goes below zero.
 *
 * After a landed non-floor final shot, the floor goes at the buzzer while we are outranked, bounded
 * by an attempt count. An attempt that put nothing on the board (refused, rate-limited, disproved) is
 * refunded, which is keyed on the decision's floorFollowUp marker (ruling 45 / W1-9). Refunding at
 * zero must not open a spare attempt. Neither the marker nor the zero bound was pinned (PR-2 mutation
 * critique).
 *
 *   node scripts/test-followup-floor-refund.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const file = path.join(os.tmpdir(), `followup-refund-${process.pid}.json`);
let eng = null;
process.on('exit', () => { try { if (eng) eng.kill(); } catch (_) {} try { fs.unlinkSync(file); } catch (_) {} });

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

(async () => {
  eng = new BidEngine({
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must never be reached here'); },
  }, new DurableScheduler(file), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: () => {},
  });
  const m = eng.arm({ id: 'FUR1', lane: { origin: 'ALWAR', destination: 'Manimajra' }, units: 1, companyName: 'Havells',
    branchName: 'ALWAR', closesAt: Date.now() + 900_000 }, { cost: 70_000, marginsPct: [12.6, 10, 8.5, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.triggerWindowMs = 100_000;
  m.extendMs = 180_000;
  m.extendCap = 3;
  const last = m.ladder.length - 1;
  m.firedRungs.add(1); m.currentRungIndex = 1; m.lastBidPrice = m.ladder[1]; m.landedBids = 1;
  m.snipeFired = true;
  const state = { closesInMs: 2_000, closesAtMs: Date.now() + 2_000, myRank: 2, minDecrement: 100, standingL1Price: null };

  const d = eng._softFloorAfterFinalShot(m, state, 2_000, last);
  assert.ok(d && d.rungIndex === last, `setup: no follow-up floor decision: ${JSON.stringify(d)}`);
  assert.strictEqual(m._lastResortFloorAttempts, 1, 'setup: the follow-up floor did not count an attempt');
  eng._refundReleaseAttempt(m, d);
  assert.strictEqual(m._lastResortFloorAttempts, 0, `a follow-up floor that placed nothing kept its attempt: ${m._lastResortFloorAttempts}`);
  ok(1, 'a follow-up floor that placed nothing gets its attempt back');

  eng._refundReleaseAttempt(m, d);
  assert.strictEqual(m._lastResortFloorAttempts, 0, `a refund at zero left the count at ${m._lastResortFloorAttempts}`);
  ok(2, 'a refund at zero leaves the count at zero');

  console.log(`\n${pass}/2 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exitCode = 1; });
