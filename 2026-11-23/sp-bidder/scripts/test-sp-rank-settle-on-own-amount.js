'use strict';
/**
 * A RANK READ THAT SHOWS OUR OWN LAST BID IS SETTLED THE MOMENT IT ARRIVES; ONLY A READ THAT CANNOT
 * SHOW IT WAITS OUT rankSettleMs.
 *
 * Regression target: rankSettleMs (1,200 ms) holds the soft-close floor after a landed final shot,
 * and the floor behind a pending probe, for a fixed time after every landed bid. The 1.2 s is the
 * box's p50 accept -> improved-rank figure from 16-24 Sep (v2.14.2), and that figure was the ~1.1 s
 * closed-bids stall on the tick thread, not SuperProcure's socket (fixed in 86f9309). A read whose
 * own amount equals the price we just landed is SuperProcure telling us the rank on it already
 * includes our bid, so holding it for the rest of 1.2 s spends the last seconds of the window
 * waiting on nothing.
 *
 * Pinned on the two call sites, each 50 ms after a landed bid, well inside rankSettleMs:
 *   1. _softFloorAfterFinalShot releases the floor on a read showing our own amount, outranked.
 *   2. It still holds on a read showing an OLDER amount of ours (the rank is from before the shot).
 *   3. It still holds on a read that carries no amount at all (GoComet shape: nothing to verify),
 *      and releases once rankSettleMs has passed - the time fallback is unchanged.
 *   4. _softPreCapBuzzerShot's pending-probe hold follows the same rule.
 *
 * Offline: fake adapter, real BidEngine, real DurableScheduler on a temp file, virtual Date.now.
 *
 *   node scripts/test-sp-rank-settle-on-own-amount.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
});

const EXPECTED_CHECKS = 4;
let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) {
    if (/^harness:/.test(e.message)) throw e;
    fail++; console.log('  FAIL ' + name + ': ' + e.message);
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const LANDED = 75_600;
const OLDER = 76_300;
const SOON_MS = 50;

let seq = 0;
function landedSoftMonitor() {
  const f = path.join(os.tmpdir(), `sp-rank-settle-${process.pid}-${seq++}.json`);
  CLEAN.push(f, f + '.tmp');
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('harness: nothing may be placed'); },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openJitterMs: 0, softOpenJitterMs: 0, cadenceJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Transrail'], mode: 'live', reserve: 1 },
    log: quiet,
  });
  const m = engine.arm({ id: `SETTLE${seq}`, lane: { origin: 'Nagpur', destination: 'Vadodara' }, equipment: '32 ft MXL',
    units: 1, companyName: 'Transrail Lighting Ltd', closesAt: vnow + 60_000, startsAt: vnow - 1_000, status: 'live', softClose: true },
  { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  if (m.softStrategy === 'off') throw new Error('harness: the load did not arm on the soft-close allowlist');
  const last = m.ladder.length - 1;
  m.closeModel = 'soft';
  m.extendCap = 2;
  m.extendsObserved = 2;
  m.snipeFired = true;
  m.currentRungIndex = last - 1;
  m.firedRungs.add(last - 1);
  m.landedBids = 2;
  m.lastBidPrice = LANDED;
  m._lastLandedAt = vnow;
  return { engine, m, last };
}

const withAmount = (amount, rank = 2) => ({ ok: true, myRank: rank, myAmount: amount, closesInMs: 1_500 });

(async () => {
  await check('1. the floor after a final shot goes on a read showing our own landed amount, 50ms after the landing', async () => {
    const { engine, m, last } = landedSoftMonitor();
    vnow += SOON_MS;
    const d = engine._softFloorAfterFinalShot(m, withAmount(LANDED), 1_500, last);
    assert.ok(d && d.rungIndex === last && d.floorFollowUp === true,
      `held the floor ${SOON_MS}ms after landing although the read already shows our landed ${LANDED} at rank 2 (got ${JSON.stringify(d)})`);
  });

  await check('2. a read still showing an older amount of ours holds the floor', async () => {
    const { engine, m, last } = landedSoftMonitor();
    vnow += SOON_MS;
    const d = engine._softFloorAfterFinalShot(m, withAmount(OLDER), 1_500, last);
    assert.strictEqual(d, null, `released the floor on a rank read from before the shot (got ${JSON.stringify(d)})`);
  });

  await check('3. a read with no amount waits out rankSettleMs, then the floor goes', async () => {
    const { engine, m, last } = landedSoftMonitor();
    vnow += SOON_MS;
    const noAmount = { ok: true, myRank: 2, closesInMs: 1_500 };
    assert.strictEqual(engine._softFloorAfterFinalShot(m, noAmount, 1_500, last), null,
      'released the floor inside rankSettleMs on a read that cannot show our bid');
    vnow += engine.cfg.rankSettleMs;
    const d = engine._softFloorAfterFinalShot(m, noAmount, 1_500, last);
    assert.ok(d && d.rungIndex === last, `the time fallback no longer releases the floor after rankSettleMs (got ${JSON.stringify(d)})`);
  });

  await check('4. a pending probe is judged the same way: our own amount releases it, an older one holds it', async () => {
    const seen = [];
    for (const amount of [LANDED, OLDER]) {
      const { engine, m, last } = landedSoftMonitor();
      engine.roundVerdict = () => ({ verdict: 'UNCERTAIN', reason: 'probe_pending', roundId: 'r2' });
      engine._lastResortFloor = () => ({ price: m.ladder[last], rungIndex: last, lastResort: true });
      vnow += SOON_MS;
      seen.push(engine._softPreCapBuzzerShot(m, withAmount(amount), 1_500, last));
    }
    assert.ok(seen[0] && seen[0].lastResort === true,
      `a read showing our landed probe did not release the buzzer floor ${SOON_MS}ms after it (got ${JSON.stringify(seen[0])})`);
    assert.strictEqual(seen[1], null, `a read from before the probe released the buzzer floor (got ${JSON.stringify(seen[1])})`);
  });

  console.log(`${pass} passed, ${fail} failed`);
  assert.strictEqual(fail, 0, `${fail} check(s) failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks, ran ${pass}`);
  process.exit(0);
})().catch((e) => { console.error('FAIL test-sp-rank-settle-on-own-amount:', e && e.message); process.exit(1); });
