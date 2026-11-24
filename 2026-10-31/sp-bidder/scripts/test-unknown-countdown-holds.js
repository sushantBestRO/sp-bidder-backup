'use strict';
/**
 * AN UNKNOWN COUNTDOWN (null, undefined or NaN) HOLDS THE LOAD: NO BID, NO FINALIZE, THE DESK TOLD.
 *
 * Regression target: A087. Two consumers of the countdown compared it bare:
 *   - countdownZero was `state.closesInMs <= 0`, which is TRUE for null, so a hard-close load whose
 *     read carried a null countdown was finalized as closed while the auction was live;
 *   - _isLastChance was `remainingMs <= floorWindowMs`, TRUE for null and FALSE for undefined/NaN,
 *     so a null countdown unlocked the last-chance floor while the other two did not.
 * Owner's ruling: a non-finite countdown is UNKNOWN and the load holds. It is never "countdown zero"
 * and never "last chance", so it never fires the floor, and a held load is told to the desk once.
 *
 * A finite countdown is unchanged: the same load inside the floor window with the same rank still
 * fires its floor, and one at 0 on a hard close still finalizes.
 *
 * Mock policy: only the adapter seam is faked; the engine is the real BidEngine. No timers run - each
 * test tick's reschedule is cleared - and the clock is not advanced.
 *
 *   node scripts/test-unknown-countdown-holds.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `unknown-countdown-${process.pid}-${tmpFiles.length}.json`); tmpFiles.push(f); return f; };

function mk(closesInMs) {
  const placed = [];
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', closeModel: 'hard', closesInMs, myRank: 3, totalBidders: 5,
      minDecrement: 100, standingL1Price: null, measuredRttMs: 50, revisionsLeft: 10 }),
    placeBid: async (_id, price) => { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: 9, latencyMs: 20 }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0, finalizeDebounceMs: 0 },
    softClose: { enabled: false }, onEvent: (e) => events.push(e),
  });
  const m = eng.arm({ id: 'UC-1', lane: { origin: 'Pune', destination: 'Delhi' }, units: 1, equipment: '32ft',
    companyName: 'Havells', closesAt: Date.now() + 600_000 }, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  // Past the establish rung, outranked: the state in which the floor window releases the floor.
  m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = m.ladder[0]; m.landedBids = 1;
  return { eng, m, placed, events };
}

async function tickOnce(eng, m) {
  await eng._tick(m);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
}

(async () => {
  console.log('\n1. control: a finite countdown inside the floor window fires the floor, and 0 finalizes');
  {
    const { eng, m, placed } = mk(1_000);
    await tickOnce(eng, m);
    ok(placed.length === 1 && placed[0] === m.ladder[m.ladder.length - 1], `the floor fires at 1s left (sent ${placed.join(', ')})`);
  }
  {
    const { eng, m } = mk(0);
    await tickOnce(eng, m);
    ok(m.finalized === true, 'a hard-close countdown of 0 finalizes the load');
  }

  for (const [label, value] of [['null', null], ['undefined', undefined], ['NaN', NaN]]) {
    console.log(`\n2. a ${label} countdown`);
    const { eng, m, placed, events } = mk(value);
    await tickOnce(eng, m);
    await tickOnce(eng, m);
    ok(!m.finalized, `is not read as countdown zero: the live load is not finalized (finalized=${m.finalized})`);
    ok(placed.length === 0, `is not read as last chance: nothing is bid (sent ${placed.join(', ') || 'nothing'})`);
    const held = events.filter((e) => e.type === 'alert' && e.level === 'error' && String(e.auctionId) === 'UC-1'
      && /closing|countdown/i.test(String(e.detail || '')));
    ok(held.length === 1, `the desk is told once that the load is held (${held.length} alert(s): ${held.map((e) => e.kind).join(', ')})`);
  }

  const total = pass + fail;
  if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
