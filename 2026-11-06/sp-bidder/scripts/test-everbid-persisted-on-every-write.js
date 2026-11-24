'use strict';
/**
 * everBid must reach the durable intent on EVERY bid-outcome write that claims to persist it - not
 * just the accepted-bid path already pinned elsewhere. Four sites set `everBid: true` in their patch
 * object (the wire was used, whatever SuperProcure did with it) and each was found, by mutation
 * testing, to survive with the literal flipped to `false` while every other test in the suite stayed
 * green - meaning nothing anywhere actually checks that these four writes land it.
 *
 * What must not move:
 *   1. _recordLandedAfterRetire's patch carries everBid: true.
 *   2. _recordRefusedAfterRetire's write carries everBid: true.
 *   3. The live-monitor REJECTED path ("placeBid rejected", res.accepted === false on a still-live
 *      monitor) carries everBid: true.
 *   4. The transport-throw "probably landed" update (adapter.placeBid threw, the read-back could not
 *      disprove the write committed) carries everBid: true.
 * Plus a control: an intent that never attempted a bid must not carry everBid: true.
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on temp files, no
 * network, no real waits, no RNG. Each check drives exactly the write it pins, either by calling the
 * retired-monitor helper directly or by driving one real _maybeBid call to the outcome in question.
 *
 *   node scripts/test-everbid-persisted-on-every-write.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let seq = 0;
const CLEAN = [];
const ENGINES = [];
const tmp = () => { const f = path.join(os.tmpdir(), `hc-everbid-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// outcome: 'accept' | 'reject' | 'throw' - the only thing that varies between checks.
function adapter(outcome) {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }), // no read-back: the throw path's "landed" stays its fail-closed default (true)
    async placeBid(_id, price) {
      if (outcome === 'accept') return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 10 };
      if (outcome === 'reject') return { accepted: false, reason: 'an unrelated price refusal for this test, matches no classifier', status: 400 };
      throw new Error('simulated transport failure');
    },
  };
}

function mkEngine(outcome) {
  const eng = new BidEngine(adapter(outcome), new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, openJitterMs: 0, floorWindowMs: 2_500 },
    softClose: { enabled: true, shippers: [] },
    rand: () => 0,
    onEvent: () => {},
  });
  ENGINES.push(eng);
  return eng;
}

function armMeta(id) {
  return { id: String(id), lane: { origin: 'A', destination: 'B' }, equipment: '32ft', units: 1,
    closesAt: Date.now() + 200_000, companyName: 'Ashirvad' };
}
const INPUTS = { cost: 100_000, marginsPct: [15, 11, 8, 5, 3], minMarginPct: 3 };
const LAST_CHANCE_STATE = { closesInMs: 100, myRank: null, minDecrement: 100, standingL1Price: null };

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CHECKS = 5;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\neverBid persisted on every write: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nFAILED - a bid-outcome write stopped persisting everBid: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

async function check(name, fn) {
  ran++;
  try { await fn(); pass++; console.log('  ok   ' + name); return true; } catch (e) {
    FAILURES.push({ name, message: (e && e.message) || String(e) });
    console.log('  FAIL ' + name + '\n         ' + ((e && e.message) || e));
    return false;
  }
}

(async () => {
  console.log('everBid persisted on every bid-outcome write');

  // ---- 0 CONTROL: an intent that never attempted a bid carries no everBid ----
  await check('0 CONTROL an armed load that never bid carries no everBid', () => {
    const eng = mkEngine('accept');
    const m = eng.arm(armMeta('EB0'), INPUTS);
    assert.strictEqual(m.everBid, false, 'setup: a fresh arm must not carry everBid');
    const intent = eng.scheduler.get('EB0');
    assert.ok(!intent.everBid, 'an intent for a load that never bid must not carry everBid: true');
  });

  // ---- 1: _recordLandedAfterRetire ----
  await check('1 _recordLandedAfterRetire persists everBid: true (mutant: everBid: true -> false in its patch)', () => {
    const eng = mkEngine('accept');
    const id = 'EB1';
    const m = eng.arm(armMeta(id), INPUTS);
    eng.stop(id); // retire: no live monitor for this id any more
    eng._recordLandedAfterRetire(m, { price: m.ladder[0], rungIndex: null },
      { accepted: true, revisionsLeft: null, myRank: null, latencyMs: 10 });
    const intent = eng.scheduler.get(id);
    assert.strictEqual(intent.everBid, true, 'a bid that landed after its monitor was retired must persist everBid: true');
  });

  // ---- 2: _recordRefusedAfterRetire ----
  await check('2 _recordRefusedAfterRetire persists everBid: true (mutant: everBid: true -> false on its write)', () => {
    const eng = mkEngine('accept');
    const id = 'EB2';
    const m = eng.arm(armMeta(id), INPUTS);
    eng.stop(id);
    const res = { accepted: false, reason: 'an unrelated refusal for this test, matches no classifier', status: 400 };
    eng._recordRefusedAfterRetire(m, { price: m.ladder[0], rungIndex: null }, res, { closesInMs: 500 }, {});
    const intent = eng.scheduler.get(id);
    assert.strictEqual(intent.everBid, true, 'a bid refused after its monitor was retired must persist everBid: true');
  });

  // ---- 3: the live-monitor REJECTED path ----
  await check('3 a rejected bid on a still-live monitor persists everBid: true (mutant: everBid: true -> false on the "placeBid rejected" write)', async () => {
    const eng = mkEngine('reject');
    const id = 'EB3';
    const m = eng.arm(armMeta(id), INPUTS);
    await eng._maybeBid(m, LAST_CHANCE_STATE);
    const intent = eng.scheduler.get(id);
    assert.ok(intent, 'setup: the intent must exist');
    assert.strictEqual(intent.everBid, true, 'a rejected bid on a still-live monitor must persist everBid: true');
  });

  // ---- 4: the transport-throw "probably landed" update ----
  await check('4 a transport-throw bid persists everBid: true (mutant: everBid: true -> false on the "probably landed" write)', async () => {
    const eng = mkEngine('throw');
    const id = 'EB4';
    const m = eng.arm(armMeta(id), INPUTS);
    await eng._maybeBid(m, LAST_CHANCE_STATE);
    const intent = eng.scheduler.get(id);
    assert.ok(intent, 'setup: the intent must exist');
    assert.strictEqual(intent.everBid, true, 'a transport-throw bid treated as possibly landed must persist everBid: true');
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
