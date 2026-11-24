'use strict';
/**
 * THE LAST-RESORT FLOOR RELEASE IS REFUNDED ON EVERY EXIT WHERE NOTHING WAS PROVABLY PLACED.
 *
 * Regression target: T5 F3 under ruling 20, the writer round the ruling asks for once W1-9 sits on
 * W1-8. Companion to test-lastresort-release-refund.js (frozen), whose check 5 covers the returned
 * 401/403/grace/429 exits. This file adds the exits that file could not reach on its base:
 *   - check 1, the PRE-WIRE 429: after one GoComet PUT 429 the adapter's 60 s cooldown makes every
 *     following placeBid throw RATE_LIMITED from the quote read, marked placed:false. W1-8's
 *     placed:false arm gives back the ladder and the latches but not the release _decide already
 *     spent, so three cooldown ticks exhaust it and the floor never goes out after the throttle clears.
 *     Same conservation oracle as the frozen check 5: attempts spent never exceed offers ruled on.
 *   - check 2, the rest of ruling 20's list: a pre-wire NETWORK throw, COST_TYPE_UNMATCHED, and a
 *     NETWORK throw the read-back disproves.
 *   - check 3, auditor F10: the refused-price hold in _maybeBid returns before the fire point, after
 *     _decide has already spent the release, so hold ticks burn the bound with no write at all.
 * Check 4 is the fail-closed control: a 5xx and a NETWORK throw the read-back cannot disprove keep
 * the release spent.
 *
 *   node scripts/test-lastresort-release-refund-prewire.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 4;
let ran = 0;
const failures = [];

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `lastresort-prewire-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

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
const REVISIONS = 30;

const prewire = (code) => () => { const e = new Error(`bid stopped before the write: ${code}`); e.code = code; e.placed = false; throw e; };
const networkThrow = () => { const e = new Error('bid_network_error'); e.code = 'NETWORK'; throw e; };
const OUTCOMES = {
  accept: () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
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
const RULED_ON = new Set(['accept']);

// Every rung offered and refused, nothing landed, the decisive shot still owed.
function rig() {
  const wire = [];
  const adapter = {
    next: 'accept',
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'unknown', biddingEnabled: true, platformLabel: 'Scripted',
      partialVehicleCountSupported: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => (adapter.next === 'networkDisproved'
      ? { ok: true, myRank: 2, revisionsLeft: REVISIONS }
      : { ok: false }),
    placeBid: async (_id, price) => {
      wire.push({ price, kind: adapter.next });
      return OUTCOMES[adapter.next]();
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, mode: 'live', shippers: ['Havells'] },
    onEvent: () => {},
  });
  const m = eng.arm({ id: `LP${seq}`, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
    equipment: '32ft', companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 },
  { cost: 50_000, marginsPct: [20, 16, 12, 8] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = FLOOR;
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = REVISIONS;
  m.triggerWindowMs = 100_000;
  for (const i of [0, 1, 2, 3]) m.firedRungs.add(i);
  m.currentRungIndex = 3;
  m.landedBids = 0;
  m.snipeFired = false;
  m.ownBidAttempts = 4;
  m.everBid = true;
  return { eng, m, wire, adapter, bound: eng.softCfg.lastResortFloorAttempts };
}

// 1200 ms from close is inside floorWindowMs; 600 ms per tick outlasts any retryAfterMs here.
async function tick(r, kind, revisionLimit = null) {
  r.adapter.next = kind;
  const before = r.wire.length;
  await r.eng._maybeBid(r.m, { closesInMs: 1_200, myRank: 2, minDecrement: 100, standingL1Price: null,
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
  await check(1, 'pre-wire 429: release attempts spent never exceed offers ruled on, and the floor goes once the cooldown ends', async () => {
    const r = rig();
    const pinned = ['prewireRateLimited', 'prewireRateLimited', 'prewireRateLimited', 'accept'];
    for (const k of pinned) await tick(r, k);
    assert.deepStrictEqual(r.wire.slice(0, 3).map((w) => [w.kind, w.price]), Array(3).fill(['prewireRateLimited', FLOOR]),
      `FIXTURE: the three cooldown-refused releases did not all reach the placeBid seam: ${JSON.stringify(r.wire)}`);
    const ruledOn = r.wire.filter((w) => RULED_ON.has(w.kind)).length;
    const afterCooldown = r.wire.slice(3).map((w) => w.price);
    assert.ok(spent(r.m) <= ruledOn && afterCooldown.length === 1 && afterCooldown[0] === FLOOR,
      `${JSON.stringify(pinned)}: spent ${spent(r.m)} of ${r.bound} while the platform ruled on ${ruledOn};`
      + ` wire sends after the cooldown ended: [${afterCooldown}], expected [${FLOOR}] - the placed:false arm`
      + ' does not refund the release _decide spent');
  });

  await check(2, 'a pre-wire NETWORK, COST_TYPE_UNMATCHED or read-back-disproved NETWORK on the release gives the attempt back', async () => {
    const kept = [];
    for (const kind of ['prewireNetwork', 'costTypeUnmatched', 'networkDisproved']) {
      const r = rig();
      const sent = await tick(r, kind);
      assert.deepStrictEqual(sent.map((w) => w.price), [FLOOR], `FIXTURE (${kind}): the release did not reach the placeBid seam`);
      if (kind === 'networkDisproved') assert.strictEqual(r.m.landedBids, 0, 'FIXTURE: the read-back did not disprove the write');
      if (spent(r.m) !== 0) kept.push(`${kind}: _lastResortFloorAttempts 0 -> ${spent(r.m)}`);
    }
    assert.deepStrictEqual(kept, [], `the release kept its spent attempt on writes that placed nothing (${kept.join('; ')})`);
  });

  await check(3, 'a refused-price hold that takes the release gives the attempt back (auditor F10)', async () => {
    const r = rig();
    // A 3-revision load has a refused-price bound of 1, so the first ruled-on refusal of the floor
    // holds that price on every later tick.
    for (let i = 0; i < r.bound; i++) await tick(r, 'refuse400', 3);
    assert.deepStrictEqual(r.wire.map((w) => [w.kind, w.price]), [['refuse400', FLOOR]],
      `FIXTURE: expected one ruled-on release and then holds, saw ${JSON.stringify(r.wire)}`);
    assert.strictEqual(r.m._refusedPriceHeld, true, 'FIXTURE: the refused-price hold did not engage');
    assert.strictEqual(spent(r.m), r.wire.length,
      `the refused-price hold spent the release with no write: _lastResortFloorAttempts=${spent(r.m)} of ${r.bound}`
      + ` after ${r.wire.length} release write(s) - the hold returns after _decide spent it and nothing gives it back`);
  });

  await check(4, 'CONTROL: a 5xx or a NETWORK throw the read-back cannot disprove keeps the release spent', async () => {
    const wrong = [];
    for (const kind of ['server502', 'networkUncertain']) {
      const r = rig();
      const sent = await tick(r, kind);
      assert.deepStrictEqual(sent.map((w) => w.price), [FLOOR], `FIXTURE (${kind}): the release did not reach the wire`);
      if (kind === 'networkUncertain') assert.strictEqual(r.m.landedBids, 1, 'FIXTURE: the uncertain write was not booked as landed');
      if (spent(r.m) !== 1) wrong.push(`${kind}: _lastResortFloorAttempts ${spent(r.m)}, expected 1`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
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
