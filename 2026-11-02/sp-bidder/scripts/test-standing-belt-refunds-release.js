'use strict';
/**
 * A FLOOR RELEASE THE STANDING-BID BELT DROPS DOES NOT SPEND THE RELEASE BUDGET.
 *
 * Regression target: A090. _lastResortFloor counts an attempt against lastResortFloorAttempts when it
 * DECIDES to release the reserved floor. _maybeBid's standing-bid belt then drops that decision when
 * the floor does not improve on our own standing bid, and returned without _refundReleaseAttempt, so a
 * decision that never reached the wire consumed the budget. The bound's own contract (and
 * test-lastresort-release-refund.js) says it counts OFFERS.
 *
 * What must not move: the belt still holds (nothing is sent), and a release that does reach the wire
 * still spends exactly one attempt.
 *
 * Mock policy: fake adapter at the platform seam, real engine, temp-file scheduler, no timers.
 *
 *   node scripts/test-standing-belt-refunds-release.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent file), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const tmpFiles = [];
process.on('exit', () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} } });
const tmp = () => { const f = path.join(os.tmpdir(), `belt-refund-${process.pid}-${tmpFiles.length}.json`); tmpFiles.push(f); return f; };

// An allowlisted soft load in its last revision, outranked in the last-chance window: the tick on
// which the never-forfeit release decides to send the floor.
function mk(standing) {
  const placed = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async (_id, price) => { placed.push(price); return { accepted: true, myRank: 2, latencyMs: 20 }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 }, onEvent: () => {},
  });
  const m = eng.arm({ id: 'BELT-1', lane: { origin: 'Pune', destination: 'Delhi' }, units: 1, equipment: '32ft',
    companyName: 'Havells', closesAt: Date.now() + 600_000 }, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft'; m.extendCap = 5; m.extendsObserved = 0; m.triggerWindowMs = 100_000; m.revisionsLeft = 1;
  m.currentRungIndex = 0; m.firedRungs.add(0); m.landedBids = 1; m.lastBidPrice = standing;
  return { eng, m, placed };
}
const lastChance = { closesInMs: 1_000, myRank: 3, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 };

(async () => {
  console.log('\n1. the belt drops the release: no bid, and no attempt spent');
  {
    const { eng, m, placed } = mk(95_000);
    const floor = m.ladder[m.ladder.length - 1];
    ok(floor > 95_000, `setup: the floor ${floor} is above our standing 95,000`);
    await eng._maybeBid(m, lastChance);
    ok(placed.length === 0, `nothing is sent (sent ${placed.join(', ') || 'nothing'})`);
    ok((m._lastResortFloorAttempts || 0) === 0, `the release budget is untouched (attempts ${m._lastResortFloorAttempts})`);
    await eng._maybeBid(m, lastChance);
    await eng._maybeBid(m, lastChance);
    await eng._maybeBid(m, lastChance);
    ok((m._lastResortFloorAttempts || 0) === 0, `four dropped decisions still spend nothing (attempts ${m._lastResortFloorAttempts})`);
  }

  console.log('\n2. control: a release that reaches the wire still spends exactly one');
  {
    const { eng, m, placed } = mk(104_000);
    await eng._maybeBid(m, lastChance);
    ok(placed.length === 1 && placed[0] === m.ladder[m.ladder.length - 1], `the floor is sent (sent ${placed.join(', ')})`);
    ok(m._lastResortFloorAttempts === 1, `and one attempt is spent (attempts ${m._lastResortFloorAttempts})`);
  }

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
