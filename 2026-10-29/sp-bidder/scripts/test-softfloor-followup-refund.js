'use strict';
/**
 * THE FLOOR FOLLOW-UP AFTER A NON-FLOOR FINAL SHOT GETS ITS ATTEMPT BACK WHEN NOTHING WAS PLACED.
 *
 * Regression target: PR-2 integration defect S2 (W1-9 x T4), under ruling 20. T4's
 * _softFloorAfterFinalShot sends the floor after a landed non-floor final shot while we are still
 * outranked, and spends the same per-load bound as the last-resort release
 * (monitor._lastResortFloorAttempts) at decision time. Its decision carries no `lastResort` marker, so
 * a refund keyed on decision.lastResort misses it. Ruling 20: the attempt comes back on every exit where
 * nothing was provably placed (returned or thrown auth, 429, every pre-wire throw, COST_TYPE_UNMATCHED,
 * a NETWORK throw the read-back disproves) and stays spent on an uncertain outcome.
 *
 * Check 1 is the per-exit refund, check 2 the money consequence (three throttled follow-ups, then the
 * throttle clears and the floor must still go), check 3 the refused-price hold (auditor F10), which
 * returns before the fire point after _decide spent the attempt. Checks 4 and 5 are controls: ruled-on, 5xx and
 * uncertain outcomes keep the spend (fail closed), and a refused non-floor final snipe, which never
 * spent the bound, never gives back an attempt a ruled-on release spent.
 *
 *   node scripts/test-softfloor-followup-refund.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 5;
let ran = 0;
const failures = [];

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `softfloor-refund-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const REAL_NOW = Date.now;
let CLOCK = 1_770_000_000_000;
Date.now = () => CLOCK;

process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    process.exitCode = 1;
  }
});

const LADDER = [60_000, 58_000, 56_000, 54_000];
const FLOOR = LADDER[LADDER.length - 1];
const REVISIONS = 27;

const prewire = (code) => () => { const e = new Error(`bid stopped before the write: ${code}`); e.code = code; e.placed = false; throw e; };
const networkThrow = () => { const e = new Error('bid_network_error'); e.code = 'NETWORK'; throw e; };
const OUTCOMES = {
  accept: () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
  auth401: () => ({ accepted: false, status: 401, myRank: null, revisionsLeft: null, bidVehicleCount: null,
    amountPMT: null, bidRate: null, bidQuantity: null, reason: 'session_logged_out', carrierSent: 2667,
    text: 'Token is invalid.', latencyMs: 12, raw: 'Token is invalid.' }),
  grace401: () => OUTCOMES.auth401(),
  throwAuth: () => { const e = new Error('token_expired'); e.code = 'AUTH'; throw e; },
  rate429: () => ({ accepted: false, status: 429, myRank: null, revisionsLeft: null, reason: 'rate_limited',
    retryAfterMs: 500, latencyMs: 5, raw: null, carrierSent: 2667, text: null }),
  prewireRateLimited: prewire('RATE_LIMITED'),
  prewireNetwork: prewire('NETWORK'),
  costTypeUnmatched: prewire('COST_TYPE_UNMATCHED'),
  networkDisproved: networkThrow,
  networkUncertain: networkThrow,
  refuse400: () => ({ accepted: false, status: 400, myRank: null, revisionsLeft: null,
    reason: 'Bid amount should be less than previous bid', text: 'Bid amount should be less than previous bid',
    latencyMs: 5 }),
  server502: () => ({ accepted: false, status: 502, myRank: null, revisionsLeft: null, reason: 'http_502',
    text: 'Bad Gateway', latencyMs: 5 }),
};
const NOTHING_PLACED = ['auth401', 'grace401', 'throwAuth', 'rate429', 'prewireRateLimited', 'prewireNetwork',
  'costTypeUnmatched', 'networkDisproved'];

// Final round (extensions exhausted), a non-floor final shot already landed at rung 2, still rank 2.
function rig({ grace = false, finalShotLanded = true, extendsObserved = 3 } = {}) {
  const wire = [];
  const adapter = {
    next: 'accept',
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'unknown', biddingEnabled: true, platformLabel: 'Scripted',
      partialVehicleCountSupported: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => (adapter.next === 'networkDisproved'
      ? { ok: true, myRank: 2, revisionsLeft: m.revisionsLeft }
      : { ok: false }),
    placeBid: async (_id, price) => {
      wire.push({ price, kind: adapter.next });
      return OUTCOMES[adapter.next]();
    },
  };
  if (grace) {
    Object.assign(adapter, { isAuthDead: () => false, authWriteHeld: () => false,
      authTokenGrace: () => adapter.next === 'grace401' });
  }
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0, refusedPriceAttempts: 10 },
    softClose: { enabled: true, mode: 'live', shippers: ['Havells'] },
    onEvent: () => {},
  });
  const m = eng.arm({ id: `SF${seq}`, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
    equipment: '32ft', companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 },
  { cost: 50_000, marginsPct: [20, 16, 12, 8] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = FLOOR;
  m.closeModel = 'soft';
  m.extendCap = 3;
  m.extendsObserved = extendsObserved;
  m.triggerWindowMs = 100_000;
  m.revisionsLeft = REVISIONS;
  m.everBid = true;
  if (finalShotLanded) {
    for (const i of [0, 1, 2]) m.firedRungs.add(i);
    m.currentRungIndex = 2;
    m.lastBidPrice = LADDER[2];
    m.landedBids = 3;
    m.ownBidAttempts = 3;
    m.snipeFired = true;
    m._lastLandedAt = Date.now() - 10_000;
  } else {
    for (const i of [0, 1]) m.firedRungs.add(i);
    m.currentRungIndex = 1;
    m.lastBidPrice = LADDER[1];
    m.landedBids = 2;
    m.ownBidAttempts = 2;
    m.snipeFired = false;
  }
  return { eng, m, wire, adapter, bound: eng.softCfg.lastResortFloorAttempts };
}

async function tick(r, kind, myRank = 2, revisionLimit = null) {
  r.adapter.next = kind;
  const before = r.wire.length;
  await r.eng._maybeBid(r.m, { closesInMs: 1_200, myRank, minDecrement: 100, standingL1Price: null,
    measuredRttMs: 50, revisionsLeft: null, revisionLimit, closeModel: 'soft' });
  CLOCK += 600;
  return r.wire.slice(before);
}

const spent = (m) => m._lastResortFloorAttempts || 0;

async function check(n, name, fn) {
  try {
    await fn();
    console.log(`  ok  ${n}. ${name}`);
  } catch (e) {
    failures.push(n);
    console.error(`  FAIL ${n}. ${name}: ${e && e.message ? e.message : e}`);
  } finally {
    ran += 1;
  }
}

(async () => {
  await check(1, 'a floor follow-up that placed nothing gives its attempt back, on every nothing-placed exit', async () => {
    const kept = [];
    for (const kind of NOTHING_PLACED) {
      const r = rig({ grace: kind === 'grace401' });
      const sent = await tick(r, kind);
      assert.deepStrictEqual(sent.map((w) => w.price), [FLOOR],
        `FIXTURE (${kind}): the floor follow-up after the non-floor final shot did not reach the wire`);
      if (spent(r.m) !== 0) kept.push(`${kind}: _lastResortFloorAttempts 0 -> ${spent(r.m)}`);
    }
    assert.deepStrictEqual(kept, [],
      `the floor follow-up kept its spent attempt on writes that placed nothing (${kept.join('; ')}):`
      + ' _softFloorAfterFinalShot spends the release bound without a lastResort marker, and no exit refunds it');
  });

  await check(2, 'after `bound` throttled follow-ups the floor still goes once the throttle clears', async () => {
    const r = rig();
    for (let i = 0; i < r.bound; i++) await tick(r, 'rate429');
    assert.deepStrictEqual(r.wire.map((w) => [w.kind, w.price]), Array(r.bound).fill(['rate429', FLOOR]),
      `FIXTURE: expected ${r.bound} throttled floor follow-ups, saw ${JSON.stringify(r.wire)}`);
    const cleared = [];
    for (let i = 0; i < 2; i++) cleared.push(...(await tick(r, 'accept')));
    assert.deepStrictEqual(cleared.map((w) => w.price), [FLOOR],
      `wire sends after the throttle cleared: [${cleared.map((w) => w.price)}], expected exactly [${FLOOR}] -`
      + ` ${r.bound} writes the portal never ruled on spent the follow-up bound`
      + ` (_lastResortFloorAttempts=${spent(r.m)} of ${r.bound}) while still outranked with ${r.m.revisionsLeft} revisions left`);
  });

  await check(3, 'a refused-price hold that takes the floor follow-up gives the attempt back (auditor F10)', async () => {
    const r = rig();
    // Revision limit 3 gives a refused-price bound of 1: after one ruled-on refusal the floor is held.
    for (let i = 0; i < r.bound; i++) await tick(r, 'refuse400', 2, 3);
    assert.deepStrictEqual(r.wire.map((w) => [w.kind, w.price]), [['refuse400', FLOOR]],
      `FIXTURE: expected one ruled-on floor follow-up and then holds, saw ${JSON.stringify(r.wire)}`);
    assert.strictEqual(r.m._refusedPriceHeld, true, 'FIXTURE: the refused-price hold did not engage');
    assert.strictEqual(spent(r.m), r.wire.length,
      `the refused-price hold spent the follow-up bound with no write: _lastResortFloorAttempts=${spent(r.m)}`
      + ` of ${r.bound} after ${r.wire.length} floor write(s)`);
  });

  await check(4, 'CONTROL: accepted, ruled-on, 5xx and uncertain follow-ups keep their attempt spent', async () => {
    const wrong = [];
    for (const kind of ['accept', 'refuse400', 'server502', 'networkUncertain']) {
      const r = rig();
      const sent = await tick(r, kind);
      assert.deepStrictEqual(sent.map((w) => w.price), [FLOOR], `FIXTURE (${kind}): the floor follow-up did not reach the wire`);
      if (spent(r.m) !== 1) wrong.push(`${kind}: _lastResortFloorAttempts ${spent(r.m)}, expected 1`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
  });

  await check(5, 'CONTROL: after a ruled-on release, a refused non-floor final snipe leaves the spent attempt spent', async () => {
    const moved = [];
    for (const kind of ['rate429', 'prewireRateLimited', 'auth401']) {
      const r = rig({ finalShotLanded: false, extendsObserved: 2 });
      // Rank unread at the buzzer of the round before the cap routes to the last-resort release.
      const release = await tick(r, 'refuse400', null);
      assert.deepStrictEqual(release.map((w) => w.price), [FLOOR], `FIXTURE (${kind}): the ruled-on release did not go at the floor`);
      assert.strictEqual(spent(r.m), 1, `FIXTURE (${kind}): the ruled-on release did not spend one attempt`);
      r.m.extendsObserved = r.m.extendCap;
      const sent = await tick(r, kind);
      assert.ok(sent.length === 1 && sent[0].price !== FLOOR,
        `FIXTURE (${kind}): the final-round shot was not a non-floor rank-aware snipe: ${JSON.stringify(sent)}`);
      if (spent(r.m) !== 1) moved.push(`${kind}: _lastResortFloorAttempts 1 -> ${spent(r.m)}`);
    }
    assert.deepStrictEqual(moved, [], `a refusal of a write that spent no attempt moved the bound: ${moved.join('; ')}`);
  });

  if (failures.length) {
    console.error(`\n${failures.length} of ${EXPECTED_CHECKS} checks FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nUNEXPECTED ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
