'use strict';
/**
 * One failed durable write must not silence the whole restart sweep.
 *
 * THE DEFECT. retirePastClose() walked every active intent with no per-intent guard, and each
 * retirement ends in scheduler.update() -> _persist() -> writeJSONAtomic, which rethrows
 * synchronously on any fs failure (disk full, an unwritable data dir). A throw on the FIRST
 * retirement abandoned the loop, so the caller received nothing: rehydrateGoCometStack's `stillOpen`
 * stayed empty and the "these auctions are still open, quote them by hand" instruction never went
 * out. The desk got one message about closed-auction reporting and no notice that N live auctions
 * were unresumed - every one of them forfeited in silence, which is exactly what the price-page gate
 * forbids.
 *
 * The second half is in the scheduler. update() mutated the in-memory intent to 'closed' BEFORE
 * persisting, so a failed write left the load closed in memory and open on disk: activeIntents()
 * dropped it, nothing re-armed it, and nothing had actually retired it either.
 *
 *   A. a throwing retirement is reported, not swallowed - the sweep continues and the caller can
 *      still see which auctions are open.
 *   B. update() rolls its in-memory mutation back when the write fails, so the intent stays
 *      re-armable rather than vanishing from activeIntents() with nothing on disk.
 *
 *   node scripts/test-retire-sweep-resilience.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intents files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const HOUR = 3_600_000;

const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
  ensureSession: async () => ({}),
  writeEnabled: false,
  async getAuctionState() { return { ok: false, error: 'unused' }; },
  async placeBid() { return { accepted: false }; },
};

/** An intent in the shape the durable file holds one. */
const intent = (id, closesAt) => ({ auctionId: id, status: 'bidding', closesAt, won: null,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, units: 1, cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });

(async () => {
  // ---- A. one intent whose write fails does not abort the sweep ----
  {
    const intents = [
      intent('DEAD-OK', Date.now() - 2 * HOUR),   // past close, retires cleanly
      intent('DEAD-FAIL', Date.now() - 2 * HOUR), // past close, its durable write throws
      intent('LIVE', Date.now() + 2 * HOUR),      // genuinely still open
    ];
    const updated = [];
    const scheduler = {
      activeIntents: () => intents.slice(),
      get: (id) => intents.find((i) => i.auctionId === id) || null,
      update: (id, patch) => {
        if (id === 'DEAD-FAIL') throw new Error('ENOSPC: no space left on device');
        updated.push(id);
        return Object.assign(intents.find((i) => i.auctionId === id), patch);
      },
    };
    const eng = new BidEngine(adapter, scheduler, { onEvent: () => {} });

    let swept = null;
    assert.doesNotThrow(() => { swept = eng.retirePastClose(); },
      'A: retirePastClose must not propagate one intent\'s write failure');
    ok(swept.retired === 1, `A: the retirement that CAN be written still lands (got ${swept.retired})`);
    ok(updated.includes('DEAD-OK'), 'A: ...and the sweep reached it despite the earlier throw');
    ok(swept.stillOpen.length === 1 && swept.stillOpen[0].auctionId === 'LIVE',
      `A: the genuinely open auction is still reported, so the hand-quote instruction can be sent (got ${JSON.stringify(swept.stillOpen.map((i) => i.auctionId))})`);
    ok(Array.isArray(swept.failed) && swept.failed.length === 1 && swept.failed[0].auctionId === 'DEAD-FAIL',
      `A: and the one that could not be written is named rather than dropped (got ${JSON.stringify((swept.failed || []).map((i) => i.auctionId))})`);
    // A failed retirement is NOT a hand-quote instruction: the auction is past its close, so telling
    // the desk to go and bid it would be a second wrong answer, not a fix for the first.
    ok(!swept.stillOpen.some((i) => i.auctionId === 'DEAD-FAIL'),
      'A: a past-close intent whose write failed is never reported as still open');
  }

  // ---- B. a failed persist rolls the in-memory mutation back ----
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-rollback-'));
    const file = path.join(dir, 'intents.json');
    const sched = new DurableScheduler(file);
    sched.upsert(intent('R1', Date.now() + HOUR));
    ok(sched.activeIntents().length === 1, 'B: fixture - the intent is open before the failed write');

    // Point the scheduler at a path whose parent is a FILE, so ensureDir throws inside _persist.
    const blocked = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocked, 'x');
    sched.filePath = path.join(blocked, 'intents.json');

    let threw = false;
    try { sched.update('R1', { status: 'closed', won: null, closedWhileDown: true }); }
    catch (_) { threw = true; }
    ok(threw, 'B: a failed persist still throws - callers keep seeing the failure they always saw');
    const after = sched.get('R1');
    ok(after.status === 'bidding',
      `B: but the in-memory intent is NOT left closed - the write never reached disk (got '${after.status}')`);
    ok(after.closedWhileDown === undefined,
      'B: and no half-applied patch field survives the rollback');
    ok(sched.activeIntents().length === 1,
      'B: so activeIntents() still holds it - a load nothing retired stays re-armable');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  const EXPECTED_CHECKS = 10;
  assert.strictEqual(fail, 0, `${fail} retire-sweep resilience checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
