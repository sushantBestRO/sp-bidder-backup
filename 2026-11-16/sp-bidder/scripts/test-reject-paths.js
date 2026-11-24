'use strict';
/**
 * Regression for the money-path rejection branches:
 *   A. a plain (non-429) bid rejection consumes the rung and steps toward the floor,
 *      and still reaches the floor rung at the buzzer.
 *   B1. a placeBid NETWORK throw with NO revision oracle (SuperProcure: revisionsLeft is
 *       never exposed) SPENDS the rung — the write may have committed server-side, and a
 *       blind same-price re-fire double-submits and burns a limited revision.
 *   B2. when the platform DOES expose revisionsLeft and the read-back shows it unchanged
 *       (proof the bid never landed), the rung stays unspent and the same price re-fires.
 *
 *   node scripts/test-reject-paths.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { buildBandLadder } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAND = [12.6, 7.2, 6.3];
const tmp = (tag) => path.join(os.tmpdir(), `rej-${tag}-${process.pid}.json`);
const ladder = buildBandLadder({ cost: 50_000, marginsPct: BAND }).ladder;

(async () => {
  // A. plain reject consumes the rung; floor is still reached at the buzzer
  {
    const f = tmp('plain');
    const placed = [];
    const closesAt = Date.now() + 3_000;
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 6, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: 2, totalBidders: 2,
          standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionLimit: 6, revisionsLeft: null,
          closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) { placed.push(price); return { accepted: false, reason: 'http_400', latencyMs: 30 }; },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true });
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt }, { cost: 50_000, marginsPct: BAND });
    await sleep(3_300);
    eng.kill();
    assert.strictEqual(placed[0], ladder[0], 'opened at the top rung');
    assert.ok(placed.length >= 2, 'a reject stepped the ladder down (rung consumed, not retried in place)');
    assert.ok(placed.includes(ladder[ladder.length - 1]), 'floor rung still reached at the buzzer despite rejects');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('plain reject consumes the rung and still reaches the floor');
  }

  // B1. NETWORK throw, no revision oracle (SP reality) -> rung SPENT, never re-fired at the
  //     same price (the bid may have landed; a duplicate burns one of the few revisions)
  {
    const f = tmp('timeout');
    const attempts = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 6, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        return { ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
          closesInMs: 8_000, revisionLimit: 6, revisionsLeft: null, closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) {
        attempts.push(price);
        if (attempts.length === 1) { const e = new Error('timeout'); e.code = 'NETWORK'; throw e; }
        return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 30 };
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true });
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 8_000 }, { cost: 50_000, marginsPct: BAND });
    await sleep(700);
    eng.kill();
    assert.ok(attempts.length >= 2, 'kept escalating after the timeout');
    assert.strictEqual(attempts[0], ladder[0], 'first attempt was the opening rung');
    assert.strictEqual(attempts[1], ladder[1], 'uncertain throw spent the rung: next attempt is the NEXT rung');
    assert.ok(!attempts.slice(1).includes(attempts[0]), 'the maybe-landed price is never re-submitted (no double-bid)');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('NETWORK throw without an oracle spends the rung (no same-price double-submit)');
  }

  // B2. NETWORK throw where the revision oracle PROVES the bid never landed
  //     (revisionsLeft unchanged on read-back) -> rung unspent, same price re-fired
  {
    const f = tmp('oracle');
    const attempts = [];
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 6, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        return { ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
          closesInMs: 8_000, revisionLimit: 6, revisionsLeft: 6, closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price) {
        attempts.push(price);
        if (attempts.length === 1) { const e = new Error('timeout'); e.code = 'NETWORK'; throw e; }
        return { accepted: true, myRank: 2, revisionsLeft: 5, latencyMs: 30 };
      },
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f), { config: { openAtMs: 15_000, floorWindowMs: 2_500 }, live: true });
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 8_000 }, { cost: 50_000, marginsPct: BAND });
    await sleep(700);
    eng.kill();
    assert.ok(attempts.length >= 2, 'fired again after the timeout');
    assert.strictEqual(attempts[0], ladder[0], 'first attempt was the opening rung');
    assert.strictEqual(attempts[1], attempts[0], 'proven-not-landed: same price re-fired, rung not skipped');
    try { fs.unlinkSync(f); } catch (_) {}
    ok('NETWORK throw with an unchanged revision count re-fires the same price (proven not landed)');
  }

  console.log(`\n${pass}/3 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
