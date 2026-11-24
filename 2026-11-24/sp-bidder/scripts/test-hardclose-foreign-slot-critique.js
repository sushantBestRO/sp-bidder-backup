'use strict';
/**
 * T5 R1-F01 mutation critique - untested decisions inside the foreign-slot reserve fix that
 * survived every existing PR-4 pin and hard-close neighbour. Each check below isolates ONE of them
 * directly against the engine's own methods (no full auction drive needed - these are seam-level
 * facts, not end-to-end behaviour), with a control alongside it so a later green is attributable to
 * the fix and not to a check that can never go red.
 *
 * What must not move (each pinned by its own control):
 *   1. _detectForeignBids must NOT set foreignSlotUncounted when this tick's OWN state.revisionsLeft
 *      is already a live, non-null number - that number already reflects the desk bid, and
 *      discounting it again double-counts the one slot that is actually gone.
 *   2. arm() must restore foreignSlotUncounted from the durable intent on a re-arm, exactly as it
 *      restores everBid - not reset it to false.
 *   3. The accepted-bid durable write (the still-live-monitor "status: bidding" update) must persist
 *      foreignSlotUncounted alongside everBid, not drop it (and not flip everBid back to false).
 *   4. _recordLandedAfterRetire must UNION its retired monitor's belief with whatever the disk
 *      already holds, never overwrite a true disk value with a stale false one.
 *   5. _recordRefusedAfterRetire must do the same union.
 *   6. _shortBudgetMiddleRung must read the discounted budget (via _hardCloseRevisionsLeft), never
 *      monitor.revisionsLeft directly, when deciding whether the ladder needs to skip a middle price.
 *
 * Offline and deterministic: fake adapter, real BidEngine, real DurableScheduler on temp files, no
 * network, no real waits, no RNG. Every check calls the engine's own methods directly on hand-built
 * or arm()-produced state rather than driving a full countdown, so each pins exactly one mechanism.
 *
 *   node scripts/test-hardclose-foreign-slot-critique.js
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
const tmp = () => { const f = path.join(os.tmpdir(), `hc-fsc-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

// A minimal hard-close SuperProcure-shaped adapter: cap above LOW_CAP_THRESHOLD, revisionsLeft never
// reported, every bid accepted. Enough to drive arm() and one write.
function adapter() {
  return {
    writes: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: null, totalBidders: 1,
      closesInMs: 999_999, revisionLimit: 5, revisionsLeft: null, minDecrement: 100, closeModel: 'hard' }),
    async placeBid(_id, price) {
      this.writes.push(price);
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 10 };
    },
  };
}

function mkEngine() {
  const eng = new BidEngine(adapter(), new DurableScheduler(tmp()), {
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

let ran = 0, pass = 0;
const FAILURES = [];
const EXPECTED_CHECKS = 6;
process.on('exit', () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  const bad = [];
  if (ran !== EXPECTED_CHECKS) bad.push(`only ${ran} of ${EXPECTED_CHECKS} checks ran`);
  if (pass !== EXPECTED_CHECKS) bad.push(`${EXPECTED_CHECKS - pass} of ${EXPECTED_CHECKS} checks failed`);
  if (!bad.length) { console.log(`\nhard-close foreign-slot critique: ${pass}/${EXPECTED_CHECKS} checks passed`); return; }
  console.error(`\nFAILED - a mutation-surviving gap in the foreign-slot reserve is back: ${bad.join('; ')}`);
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
  console.log('hard-close foreign-slot reserve mutation critique (T5 R1-F01)');

  // ---- 1: _detectForeignBids must not double-discount a live, already-adjusted revisionsLeft ----
  await check('1 _detectForeignBids leaves foreignSlotUncounted unset when state.revisionsLeft is already live (mutant: drop the state.revisionsLeft==null guard)', () => {
    const eng = mkEngine();
    const baseMonitor = () => ({
      auctionId: 'DX1', meta: { lane: null, companyName: null },
      foreignBidsDetected: false, ownBidAttempts: 0, firedRungs: new Set(), currentRungIndex: -1,
      everBid: false, closeModel: 'hard', revisionsLeft: null, foreignSlotUncounted: false,
    });
    // CONTROL: revisionsLeft genuinely unknown (SuperProcure reality) - the flag MUST be set, or this
    // check could pass by never engaging the branch at all.
    const control = baseMonitor();
    const controlFired = eng._detectForeignBids(control, { myRank: 3, revisionLimit: 5, revisionsLeft: null });
    assert.strictEqual(controlFired, true, 'setup: detection must fire when a standing rank exists before our first bid');
    assert.strictEqual(control.foreignSlotUncounted, true, 'CONTROL: an unknown local budget above the low-cap threshold must still be flagged');
    // MECHANISM: the platform reports a LIVE revisionsLeft on this very tick - it already reflects the
    // desk bid, so the reserve must not subtract a second time.
    const live = baseMonitor();
    const liveFired = eng._detectForeignBids(live, { myRank: 3, revisionLimit: 5, revisionsLeft: 4 });
    assert.strictEqual(liveFired, true, 'setup: detection still fires (a standing rank exists) even though the count is live');
    assert.strictEqual(live.foreignSlotUncounted, false,
      'a live, already-adjusted revisionsLeft must not be flagged for a second discount');
  });

  // ---- 2: arm() must restore foreignSlotUncounted from the durable intent, not reset it ----
  await check('2 arm() restores foreignSlotUncounted from the persisted intent on a re-arm (mutant: force priorForeignSlotUncounted to false)', () => {
    const eng = mkEngine();
    const id = 'DX2';
    let m = eng.arm(armMeta(id), INPUTS);
    assert.strictEqual(m.foreignSlotUncounted, false, 'setup: a fresh arm with nothing detected yet must not carry the flag');
    eng.stop(id);
    // Simulate: an earlier monitor incarnation already detected the foreign slot and persisted it.
    eng.scheduler.update(id, { foreignSlotUncounted: true });
    m = eng.arm(armMeta(id), INPUTS);
    assert.strictEqual(m.foreignSlotUncounted, true,
      're-arming onto an intent that already carries foreignSlotUncounted must restore it, exactly as everBid is restored');
  });

  // ---- 3: the accepted-bid durable write must persist foreignSlotUncounted alongside everBid ----
  await check('3 an accepted bid on a still-live monitor persists foreignSlotUncounted on the intent (mutant: drop the field and flip everBid to false on that write)', async () => {
    const eng = mkEngine();
    const state = { closesInMs: 100, myRank: null, minDecrement: 100, standingL1Price: null };
    // CONTROL: nothing was ever detected - the write must persist foreignSlotUncounted false, proving
    // the field genuinely rides this write both ways rather than just happening to read true always.
    const c = eng.arm(armMeta('DX3-control'), INPUTS);
    await eng._maybeBid(c, state);
    const controlIntent = eng.scheduler.get('DX3-control');
    assert.ok(controlIntent && controlIntent.everBid === true, 'setup: the control bid must land and persist everBid');
    assert.strictEqual(controlIntent.foreignSlotUncounted, false, 'CONTROL: an undetected load must persist foreignSlotUncounted false');
    // MECHANISM
    const m = eng.arm(armMeta('DX3'), INPUTS);
    m.foreignSlotUncounted = true; // simulate: an earlier tick's _detectForeignBids already set this
    await eng._maybeBid(m, state);
    const intent = eng.scheduler.get('DX3');
    assert.ok(intent, 'setup: the bid must land and the intent must exist');
    assert.strictEqual(intent.everBid, true, 'setup: the accepted write must persist everBid true');
    assert.strictEqual(intent.foreignSlotUncounted, true,
      'the accepted-bid write must carry foreignSlotUncounted forward onto the durable intent');
  });

  // ---- 4: _recordLandedAfterRetire must union with the disk value, never overwrite it ----
  await check('4 _recordLandedAfterRetire unions foreignSlotUncounted with the disk value (mutant: drop the prior.foreignSlotUncounted || in the union)', () => {
    const eng = mkEngine();
    const id = 'DX4';
    const m = eng.arm(armMeta(id), INPUTS);
    eng.stop(id); // retire: no live monitor for this id any more
    m.foreignSlotUncounted = false; // THIS retired monitor never itself detected anything
    // A successor (or an earlier write) already proved the fact and persisted it.
    eng.scheduler.update(id, { foreignSlotUncounted: true });
    eng._recordLandedAfterRetire(m, { price: m.ladder[0], rungIndex: null },
      { accepted: true, revisionsLeft: null, myRank: null, latencyMs: 10 });
    const intent = eng.scheduler.get(id);
    assert.strictEqual(intent.foreignSlotUncounted, true,
      'a retired monitor whose own belief is false must never stomp a true value already on disk');
  });

  // ---- 5: _recordRefusedAfterRetire must union with the disk value, never overwrite it ----
  await check('5 _recordRefusedAfterRetire unions foreignSlotUncounted with the disk value (mutant: drop the priorForeign || in the union)', () => {
    const eng = mkEngine();
    const id = 'DX5';
    const m = eng.arm(armMeta(id), INPUTS);
    eng.stop(id);
    m.foreignSlotUncounted = false;
    eng.scheduler.update(id, { foreignSlotUncounted: true });
    const res = { accepted: false, reason: 'an unrelated refusal for this test, matches no classifier', status: 400 };
    eng._recordRefusedAfterRetire(m, { price: m.ladder[0], rungIndex: null }, res, { closesInMs: 500 }, {});
    const intent = eng.scheduler.get(id);
    assert.strictEqual(intent.foreignSlotUncounted, true,
      'a retired monitor whose own belief is false must never stomp a true value already on disk');
  });

  // ---- 6: _shortBudgetMiddleRung must read the discounted budget, not raw revisionsLeft ----
  await check('6 _shortBudgetMiddleRung reads the discounted budget via _hardCloseRevisionsLeft (mutant: compare against monitor.revisionsLeft instead of left)', () => {
    const eng = mkEngine();
    const baseMonitor = () => ({ closeModel: 'hard', currentRungIndex: 0, unfireableRungs: new Set(), firedRungs: new Set() });
    // CONTROL: no discount in force - the raw budget of 4 exactly fits establish+3 middles+floor (a
    // 5-rung ladder, last=4), so nothing needs to be skipped. This must return null under BOTH the fix
    // and the mutant (the mutant only changes behaviour when the flag is set), proving this check is
    // not accidentally sensitive to something unrelated.
    const control = Object.assign(baseMonitor(), { revisionsLeft: 4, foreignSlotUncounted: false });
    assert.strictEqual(eng._shortBudgetMiddleRung(control, 4), null,
      'CONTROL: an undiscounted budget that exactly fits the remaining ladder must not force a skip');
    // MECHANISM: the same raw budget of 4, but a foreign slot was detected - the true remaining is 3,
    // one short of what the remaining ladder needs, so the next middle price must be picked NOW rather
    // than left to the clock walk.
    const discounted = Object.assign(baseMonitor(), { revisionsLeft: 4, foreignSlotUncounted: true });
    assert.strictEqual(eng._shortBudgetMiddleRung(discounted, 4), 1,
      'a discounted budget one short of the remaining ladder must force the next middle price, not fit silently');
  });
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exitCode = 1; });
