'use strict';
/**
 * A LOAD-NOT-BIDDABLE refusal that resolves after its own monitor was retired has to stand the load
 * down, exactly as it does on the live path.
 *
 * The retire bail was reopened (F10) so terminal per-load state survives the monitor that fired it,
 * but only the CAP class was implemented: `if (!isBidCapRejection(res)) return;`. SuperProcure's
 * per-load "Load not available for bidding" refusal therefore emitted a bid_rejected with no
 * stand-down anywhere behind it. Two consequences, both live-money:
 *
 *   - nothing latched on the successor, so it kept firing for the rest of the auction - the ~23
 *     refused writes on the shared live account the live path's latch exists to prevent;
 *   - no refusal was recorded, so at close _finalize fell back to the generic "a rate was entered
 *     but no bid could be placed before close" - which is not merely vague, it sends the desk to
 *     hunt a pricing mistake that does not exist.
 *
 *   node scripts/test-not-biddable-after-retire.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 5;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const A_COST = 29_000, A_BAND = [9, 5, 1], A_OPENING = 31_610;
const B_COST = 27_000, B_BAND = [20, 10, 1];
const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;

// SuperProcure's own plaintext body for the per-load state refusal, verbatim from the live records.
const NOT_BIDDABLE = { accepted: false, reason: 'Load not available for bidding', status: 400,
  text: 'Load not available for bidding' };
// The PRICE class, which is a retry and must never latch anything.
const PRICE_REFUSED = { accepted: false, reason: 'Amount is invalid', status: 400, text: 'Amount is invalid' };

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false });

// Arm a load, park its write on the wire, re-price around it, then resolve the parked write with
// `res`. Returns the successor plus everything the engine emitted.
async function refuseAfterRetire(tag, res) {
  const f = path.join(os.tmpdir(), `not-biddable-retire-${tag}-${process.pid}.json`);
  let release;
  const onWire = new Promise((r) => { release = r; });
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    async placeBid(id, price) {
      this.placed.push(price);
      if (price === A_OPENING) { await onWire; return res; }
      return { accepted: true, myRank: 1, latencyMs: 30 };
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const events = [];
  engine.onEvent = (e) => events.push(e);

  const m1 = engine.arm(mkLoad('LD2Z'), { cost: A_COST, marginsPct: A_BAND, minMarginPct: 1 });
  if (m1.timer) clearTimeout(m1.timer);
  const inFlight = engine._maybeBid(m1, liveState());
  await new Promise((r) => setImmediate(r));
  engine.stop('LD2Z');
  const m2 = engine.arm(mkLoad('LD2Z'), { cost: B_COST, marginsPct: B_BAND, minMarginPct: 1 });
  if (m2.timer) clearTimeout(m2.timer);
  release();
  await inFlight;
  return { engine, adapter, events, m2, f };
}

(async () => {
  // ---- 1) THE STAND-DOWN reaches the live successor, and the successor stops spending the wire. ----
  {
    const h = await refuseAfterRetire('latch', NOT_BIDDABLE);
    assert.deepStrictEqual(h.adapter.placed, [A_OPENING], 'precondition: one write went out and was refused after the retire');
    assert.strictEqual(h.events.filter((e) => e.type === 'bid_rejected').length, 1,
      'precondition: the refusal itself is on the durable record');

    assert.strictEqual(h.m2.loadNotBiddable, true,
      'the latch lands on the LIVE successor, not on the monitor that has already been retired');
    ok('a not-biddable refusal resolving after a retire latches the load on the live successor');

    const before = h.adapter.placed.length;
    await h.engine._maybeBid(h.m2, liveState());
    assert.strictEqual(h.adapter.placed.length, before,
      'and the successor puts nothing further on the shared live account for the rest of the auction');
    ok('the successor stops firing instead of walking its ladder into a load SP will not take');

    assert.ok(!h.m2.capExhausted, 'the per-load BUDGET is untouched - this is not a cap refusal');
    assert.ok(h.m2.revisionsLeft > 0, 'so revisionsLeft is not zeroed, and a later re-price does not inherit a phantom exhausted load');
    ok('the budget is left intact - the load is closed, not the wallet');
  }

  // ---- 2) THE RECEIPT names the reason, instead of the generic no-bid line. ----
  {
    const h = await refuseAfterRetire('receipt', NOT_BIDDABLE);
    assert.deepStrictEqual(h.engine._refusalAtClose(h.m2), { reason: 'load_not_biddable' },
      'the refusal is recorded on the monitor close time reads');
    assert.strictEqual(h.events.filter((e) => e.kind === 'load_not_biddable').length, 1,
      'and the desk gets its own notice, once, as it does on the live path');
    const notice = h.events.find((e) => e.kind === 'load_not_biddable');
    assert.ok(notice.companyName && notice.branchName,
      'carrying the scope keys a branch-scoped group matches on - without them it falls to the unscoped recipients');
    h.engine.kill(); try { fs.unlinkSync(h.f); } catch (_) {}
    ok('the close receipt has a reason to state, and the desk is told while the auction is still open');
  }

  // ---- 3) THE NARROWNESS. A PRICE-class refusal in the same window is a retry, and latching it
  // would forfeit a winnable auction. ----
  {
    const h = await refuseAfterRetire('price-class', PRICE_REFUSED);
    assert.ok(!h.m2.loadNotBiddable, 'an ordinary price refusal does not stand the load down');
    assert.strictEqual(h.engine._refusalAtClose(h.m2), null, 'and records no refusal against it');
    await h.engine._maybeBid(h.m2, liveState());
    assert.strictEqual(h.adapter.placed.length, 2, 'the successor bids on, exactly as before');
    h.engine.kill(); try { fs.unlinkSync(h.f); } catch (_) {}
    ok('a price-class refusal after a retire still leaves the load biddable');
  }

  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
