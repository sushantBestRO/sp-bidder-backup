'use strict';
/**
 * LATCH-RESTORE EDGES (bidEngine _maybeBid nothing-placed restore spine).
 *
 * Pins the snipe/defend latch restore-vs-hold contract at the corners scripts/test-rank-driven-endgame.js
 * check 6 does not reach. Regression target: the adversarial-review finding on feat/rank-driven-rungs
 * (2026-07-24, the same review check 6 cites) - the decisive snipe/defend latches were restored only on
 * an HTTP 429, so a rejected or transport-errored decisive shot that placed NOTHING was silently
 * abandoned. In a live-money engine that is an auction lost with budget still in hand. The fix
 * (bidEngine.js:1752-1959) snapshots snipeFired/_lastDefendAtExtend before the fire and:
 *   - RESTORES both on every NOTHING-PLACED outcome: 429, a non-cap rejection, a transport throw whose
 *     read-back proves the bid did not land - so the shot retries next poll.
 *   - HOLDS both where a bid actually LANDED (accepted; or a throw the read-back proves committed) or the
 *     shared-account budget is terminally GONE (a "Bid limit exceeded" cap rejection) - so a landed shot
 *     never double-fires and a capped load never retry-storms.
 *
 * Check 6 covers the three basic SNIPE restore paths (429, non-cap reject, throw-not-landed). This file
 * covers the corners it skips: the same three on the DEFEND (once-per-round) latch, the bid-cap HOLD on
 * defend, the throw-but-LANDED hold, the restore-preserves-a-true-prior invariant, an interleaved
 * one-auction lifecycle, and the accepted-holds control case. Mock policy: the ONLY seam mocked is the
 * platform adapter (placeBid, and getAuctionState for the throw read-back oracle). No engine internal is
 * stubbed. Offline and deterministic: fake adapter, memory-backed scheduler, decisions driven directly
 * with explicit state, no timers, no network.
 *
 *   node scripts/test-latch-restore-edges.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `latch-restore-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// A soft-strategy engine. Rank-only caps, 30-revision default, minDecrement 100. (Same shape as the
// endgame harness so the two files agree on what an armed soft monitor looks like.)
function mkEngine(softClose, cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose,
  });
}

// Arm a soft monitor with a controlled FINE ladder, isolating the latch logic from interpolateBandLadder.
// Post-establish state (currentRungIndex/firedRungs/lastBidPrice) is set by each check. extendCap 5 by
// default keeps extensions in hand (soft defend owns the decision); pass extendCap 0 for an effectively
// hard monitor whose final snipe is eligible.
function armFine(eng, ladder, { companyName = 'Havells', revisionsLeft = 30, extendCap = 5, triggerWindowMs = 100_000 } = {}) {
  const meta = { id: 'F', lane: { origin: 'A', destination: 'B' }, units: 1, companyName, closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = extendCap;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  m.triggerWindowMs = triggerWindowMs;
  return m;
}

const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

// PROGRAMMABLE per-call platform adapter (the one mocked seam). Each placeBid pops the next outcome off
// `kinds`; past the end it repeats the last. `placed` records the prices the wire ACCEPTED (landed);
// `calls` counts every invocation (throws included), so a check can assert both what landed and how many
// times the wire was touched. An optional readBack overrides getAuctionState for the throw oracle.
//   'ok' | '429' | 'reject-cap' | 'reject-other' | 'throw'
function program(eng, kinds, readBack) {
  const placed = [];
  const box = { placed, calls: 0 };
  let i = 0;
  eng.adapter.placeBid = async (id, price) => {
    box.calls += 1;
    const kind = kinds[Math.min(i, kinds.length - 1)];
    i += 1;
    if (kind === 'throw') throw new Error('ECONNRESET');
    if (kind === '429') return { accepted: false, reason: 'rate_limited', retryAfterMs: 50 };
    if (kind === 'reject-cap') return { accepted: false, reason: 'Bid limit exceeded', status: 400, text: 'Bid limit exceeded' };
    if (kind === 'reject-other') return { accepted: false, reason: 'Bid difference too small.', status: 400, text: 'Bid difference too small.' };
    placed.push(price); // 'ok'
    return { accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 };
  };
  if (readBack) eng.adapter.getAuctionState = readBack;
  return box;
}

(async () => {
  // ============================================================================================
  // 1. DEFEND 429 restores the once-per-round latch. A throttled defend placed nothing, so the round is
  //    NOT spent - _lastDefendAtExtend rolls back and the defend re-fires the SAME rung inside the SAME
  //    extension round (not skipped to the next round). (Check 6b proves this for the snipe latch only.)
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]); // extensions remain -> soft defend owns it
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['429', 'ok']);
    await eng._maybeBid(m, state(50_000, 2)); // round-0 defend (inside the 100s window), throttled -> nothing placed
    assert.strictEqual(m._lastDefendAtExtend, null, 'a 429 restores the once-per-round defend latch (nothing placed - the round is not spent)');
    assert.deepStrictEqual(box.placed, [], 'the throttled defend placed nothing');
    await eng._maybeBid(m, state(50_000, 2)); // retry inside the SAME round: same rung re-fires and lands
    assert.deepStrictEqual(box.placed, [9_700], 'the throttled defend retries within the same extension round and lands (not deferred to the next round)');
    assert.strictEqual(m._lastDefendAtExtend, 0, 'once the retry lands, the round latch re-sets to the current round');
    ok('defend 429 restores the round latch: the defend retries inside the SAME extension round');
  }

  // ============================================================================================
  // 2. DEFEND non-cap reject restores the round latch. The rung was refused for price/state (nothing
  //    stands), so the defend must retry the NEXT fireable rung within the round, not be abandoned.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['reject-other', 'ok']);
    await eng._maybeBid(m, state(50_000, 2)); // defend rung 1 refused (non-cap) -> latch restored
    assert.strictEqual(m._lastDefendAtExtend, null, 'a non-cap rejection restores the round latch (the rung was refused, nothing stands)');
    await eng._maybeBid(m, state(50_000, 2)); // retry walks to the next fireable rung and lands, same round
    assert.deepStrictEqual(box.placed, [9_400], 'the refused defend retries the next fireable rung and lands within the same round');
    assert.strictEqual(m._lastDefendAtExtend, 0, 'the landed retry re-latches the round');
    ok('defend non-cap reject restores the round latch: the defend retries the next rung, still within the round');
  }

  // ============================================================================================
  // 3. DEFEND bid-cap reject HOLDS the latch (and stops). A "Bid limit exceeded" refusal is terminal for
  //    the shared-account budget: the latch is NOT restored, capExhausted latches, revisionsLeft is driven
  //    to 0, and no further rung is spent - so a capped load cannot retry-storm.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const box = program(eng, ['reject-cap', 'ok']);
    await eng._maybeBid(m, state(50_000, 2)); // defend rung 1 refused for the shared-account bid cap -> TERMINAL
    assert.strictEqual(m._lastDefendAtExtend, 0, 'a bid-cap rejection HOLDS the round latch (not a nothing-placed retry case)');
    assert.strictEqual(m.capExhausted, true, 'the cap rejection latched capExhausted');
    const callsAfterReject = box.calls;
    await eng._maybeBid(m, state(50_000, 2)); // capped load: no retry storm
    await eng._maybeBid(m, state(49_000, 2));
    assert.strictEqual(box.calls, callsAfterReject, 'no further wire attempt on a capped load (revisionsLeft driven to 0 stops every subsequent rung)');
    assert.deepStrictEqual(box.placed, [], 'nothing ever landed on the capped load');
    ok('defend bid-cap reject HOLDS the latch and stops: no retry storm on a shared-account capped load');
  }

  // ============================================================================================
  // 4. SNIPE throw-NOT-landed restores the latch AND the next poll re-fires. The transport threw; the
  //    read-back oracle reports revisionsLeft UNCHANGED, proving the bid is absent from history. The latch
  //    rolls back, the rung stays clear of firedRungs, and the very next poll re-fires the same decisive
  //    shot. (Check 6c asserts the retry lands; this additionally pins the mechanism - latch + history.)
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0, revisionsLeft: 5 }); // effectively hard -> snipe
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const notLanded = async () => ({ ok: true, myRank: 2, revisionsLeft: m.revisionsLeft, closesInMs: 1_400 });
    const box = program(eng, ['throw', 'ok'], notLanded);
    await eng._maybeBid(m, state(1_500, 2)); // snipe rung 1, transport throws, read-back proves not landed
    assert.strictEqual(m.snipeFired, false, 'a throw the read-back proves did NOT land restores the snipe latch');
    assert.ok(!m.firedRungs.has(1), 'the un-landed snipe rung is absent from the fired-rung history (nothing committed)');
    await eng._maybeBid(m, state(1_400, 2)); // the very next poll re-fires the SAME decisive shot and lands
    assert.deepStrictEqual(box.placed, [9_700], 'the throw-not-landed snipe re-fires the same rung on the next poll and lands');
    assert.strictEqual(m.snipeFired, true, 'once the re-fired shot lands, the snipe latch holds (single-shot from here)');
    ok('snipe throw-not-landed restores the latch AND the next poll re-fires the decisive shot');
  }

  // ============================================================================================
  // 5. SNIPE throw-but-LANDED HOLDS the latch (no double-fire). The transport threw, but the read-back
  //    reports a DROPPED revision, proving the bid committed. The latch is HELD, the rung is recorded, and
  //    no subsequent poll re-sends the committed shot. This is the corner check 6 does not test.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0, revisionsLeft: 5 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const landed = async () => ({ ok: true, myRank: 2, revisionsLeft: m.revisionsLeft - 1, closesInMs: 1_400 });
    const box = program(eng, ['throw'], landed);
    await eng._maybeBid(m, state(1_500, 2)); // snipe rung 1, transport throws, read-back proves it committed
    assert.strictEqual(m.snipeFired, true, 'a throw the read-back proves DID land HOLDS the snipe latch (no restore)');
    assert.ok(m.firedRungs.has(1), 'the committed snipe rung is recorded in the fired-rung history');
    await eng._maybeBid(m, state(1_400, 2)); // subsequent polls must not double-fire the committed shot
    await eng._maybeBid(m, state(1_200, 3));
    assert.strictEqual(box.calls, 1, 'exactly one wire attempt total - the committed shot is never re-sent (no double-fire on a landed bid)');
    ok('snipe throw-but-landed HOLDS the latch: the committed shot is not restored and never double-fires');
  }

  // ============================================================================================
  // 6. RESTORE PRESERVES A TRUE PRIOR. snipeFired was already latched by a decisive shot in an EARLIER
  //    round; SP then extended again, so a fresh DEFEND runs and is refused non-cap. The nothing-placed
  //    restore must roll the defend latch back to its captured prior WITHOUT clearing the still-valid
  //    snipe latch - i.e. it restores the SNAPSHOT, it never hard-sets snipeFired = false. A hard-set
  //    would falsely un-latch the decisive shot and let it double-fire.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]); // extensions remain -> a defend window
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    m.snipeFired = true; // already latched by an earlier-round decisive shot
    const box = program(eng, ['reject-other']);
    await eng._maybeBid(m, state(50_000, 2)); // a non-snipe (defend) attempt is refused non-cap
    assert.strictEqual(m.snipeFired, true, 'the nothing-placed restore preserves an already-true snipe latch (restores the captured prior, never hard-sets false)');
    assert.strictEqual(m._lastDefendAtExtend, null, 'the defend latch is restored to its captured prior (null)');
    assert.deepStrictEqual(box.placed, [], 'the refused defend placed nothing');
    ok('restore preserves the prior: an unrelated already-true snipe latch survives a defend rollback (no false un-latch)');
  }

  // ============================================================================================
  // 7. INTERLEAVED ONE-AUCTION LIFECYCLE. A single monitor: [defend 429 -> retry lands] in round 0, then
  //    extensions exhaust (effectively hard) and [snipe throw-not-landed -> retry lands]. The landed bid
  //    log is exactly the defend rung then the decisive snipe rung, every price an exact ladder rung, none
  //    below the floor - the whole restore contract exercised end-to-end on one load.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 1, revisionsLeft: 5 });
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    const notLanded = async () => ({ ok: true, myRank: 2, revisionsLeft: m.revisionsLeft });
    const box = program(eng, ['429', 'ok', 'throw', 'ok'], notLanded);
    // round 0: defend throttled, then lands rung 1
    await eng._maybeBid(m, state(50_000, 2)); // 429
    await eng._maybeBid(m, state(50_000, 2)); // retry lands
    // extensions exhaust -> effectively hard; the final snipe throws-not-landed, then lands
    m.extendsObserved = 1; // reached extendCap 1
    await eng._maybeBid(m, state(1_500, 2)); // snipe throw, read-back not landed
    await eng._maybeBid(m, state(1_400, 2)); // snipe retry lands
    assert.deepStrictEqual(box.placed, [9_700, 9_400], 'the auction lands exactly the defend rung then the decisive snipe rung, in order');
    for (const p of box.placed) assert.ok(m.ladder.includes(p), `every landed price ${p} is an exact ladder rung`);
    for (const p of box.placed) assert.ok(p >= m.floor, `no landed price ${p} is below the floor ${m.floor}`);
    assert.strictEqual(m.snipeFired, true, 'the decisive shot is latched after it finally lands');
    ok('interleaved lifecycle: defend-429-retry then snipe-throw-not-landed-retry lands the exact on-ladder, above-floor sequence');
  }

  // ============================================================================================
  // 8. ACCEPTED HOLDS (control case). A clean accepted snipe keeps its latch (the accepted path never
  //    restores) and leaves the unrelated defend latch exactly as it was - subsequent polls place nothing.
  //    This anchors the restore/hold dichotomy: only nothing-placed outcomes restore.
  // ============================================================================================
  {
    const eng = mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000], { extendCap: 0 }); // effectively hard -> snipe eligible
    m.currentRungIndex = 0; m.firedRungs.add(0); m.lastBidPrice = 10_000;
    m._lastDefendAtExtend = 7; // sentinel prior: the accepted path must not restore/mutate the other latch
    const box = program(eng, ['ok']);
    await eng._maybeBid(m, state(1_500, 2)); // clean accepted snipe
    assert.strictEqual(m.snipeFired, true, 'an accepted snipe HOLDS the snipe latch (the accepted path never restores)');
    assert.strictEqual(m._lastDefendAtExtend, 7, 'the accepted path leaves the unrelated defend latch exactly as it was (no spurious restore)');
    assert.deepStrictEqual(box.placed, [9_700], 'the accepted snipe landed its one decisive rung');
    await eng._maybeBid(m, state(1_400, 2)); // subsequent polls place nothing
    await eng._maybeBid(m, state(1_200, 3));
    assert.strictEqual(box.calls, 1, 'no further wire attempt once the accepted decisive shot has landed');
    ok('accepted snipe holds both latches: the shot is single-fire and no latch is spuriously restored');
  }

  cleanup();
  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
