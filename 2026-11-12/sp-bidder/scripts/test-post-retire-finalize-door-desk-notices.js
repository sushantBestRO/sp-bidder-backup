'use strict';
/**
 * Regression: a finalized (or otherwise successor-less) post-retire target still gets desk
 * WhatsApp notices it has nothing left to act on.
 *
 * `_recordRefusedAfterRetire`'s vehicle_count_refused and price_raise_refused/submission_closed
 * emits already gate on `!target.finalized` (an earlier review finding). Their siblings -
 * load_not_biddable and bid_cap_exhausted - do not: through the FINALIZE door (`live` is the
 * already-finalized monitor itself, since `_finalize` never removes it from `this.monitors`) or a
 * bare `stop()` with no re-arm (`live` is undefined, so `target` falls back to the retired,
 * finalized `monitor`), the notice still fires on a load that has already closed and already sent
 * its receipt.
 *
 * WHAT MUST NOT MOVE: the LATCHES and the recorded refusal stay unconditional (checks 2 and 4) -
 * the close receipt still has to state the true reason - and the re-price door's live successor
 * (never finalized) still gets the notice (checks 5 and 6, the control).
 *
 * Mock policy: the ONLY mocked seam is the platform adapter's placeBid, parked on the wire and
 * resolved after the monitor is retired - the same harness shape
 * scripts/test-post-retire-refusal-classes-latch.js uses for the sibling classes.
 *
 *   node scripts/test-post-retire-finalize-door-desk-notices.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 6;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;

const refusal = (body) => ({ accepted: false, status: 400, reason: body, text: body });
const NOT_BIDDABLE = refusal('Load not available for bidding');
const CAP = refusal('Bid limit exceeded');

const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false });
const PRICING = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };

const cleanups = [];
const alerts = (h, kind) => h.events.filter((e) => e.type === 'alert' && e.kind === kind).length;

/**
 * Arms one load, parks its first write on the wire, retires the monitor through `door`
 * ('finalize' | 'stop-no-rearm' | 'reprice'), then resolves the parked write with `res`.
 */
async function refuseThroughDoor(door, id, res) {
  const f = path.join(os.tmpdir(), `post-retire-finalize-${id}-${process.pid}.json`);
  let release;
  const onWire = new Promise((r) => { release = r; });
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
      closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 }),
    async placeBid(_id, price) {
      this.placed.push(price);
      if (this.placed.length === 1) return onWire;
      return { accepted: true, myRank: 1, latencyMs: 30 };
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  cleanups.push(() => { try { engine.kill(); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} });

  const fired = engine.arm(mkLoad(id), PRICING);
  if (fired.timer) clearTimeout(fired.timer);
  fired.timer = null;
  const inFlight = engine._maybeBid(fired, { closesInMs: REMAINING_MS, myRank: 2, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(adapter.placed.length, 1, `precondition (${id}): exactly one write is on the wire`);

  let live;
  if (door === 'finalize') {
    await engine._finalize(fired, { ok: true, myRank: 1, closesInMs: 0 });
    live = engine.monitors.get(id);
    assert.strictEqual(fired.finalized, true, `precondition (${id}): _finalize left the monitor finalized`);
    assert.strictEqual(live, fired, `precondition (${id}): _finalize does not remove the monitor from this.monitors`);
  } else if (door === 'stop-no-rearm') {
    engine.stop(id);
    live = engine.monitors.get(id);
    assert.strictEqual(fired.finalized, true, `precondition (${id}): stop() left the monitor finalized`);
    assert.strictEqual(live, undefined, `precondition (${id}): a bare stop with no re-arm leaves no successor`);
  } else {
    engine.stop(id);
    live = engine.arm(mkLoad(id), PRICING);
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    assert.notStrictEqual(live, fired, `precondition (${id}): the re-price built a successor monitor`);
    assert.strictEqual(live.finalized, false, `precondition (${id}): the successor is not finalized`);
  }

  release(res);
  await inFlight;
  assert.strictEqual(events.filter((e) => e.type === 'bid_rejected').length, 1,
    `precondition (${id}): the refusal resolved through the post-retire door onto the record`);
  const target = live || fired;
  return { engine, adapter, events, fired, live, target };
}

(async () => {
  // ============================================================================================
  // 1. MECHANISM (finalize door): load_not_biddable must not page the desk on an already-closed load.
  // ============================================================================================
  {
    const h = await refuseThroughDoor('finalize', 'F5-LNB-FIN', NOT_BIDDABLE);
    assert.strictEqual(alerts(h, 'load_not_biddable'), 0,
      'a finalized target must not raise load_not_biddable - the load already closed and already has its receipt');
    ok('finalize door: load_not_biddable raises no desk notice on an already-closed load');
  }

  // ============================================================================================
  // 2. The latch and the recorded refusal stay unconditional through the finalize door - the
  //    close receipt still needs to state the true reason.
  // ============================================================================================
  {
    const h = await refuseThroughDoor('finalize', 'F5-LNB-FIN-LATCH', NOT_BIDDABLE);
    assert.strictEqual(h.target.loadNotBiddable, true, 'the latch must still be set through the finalize door');
    assert.strictEqual(h.target.noBid && h.target.noBid.reason, 'load_not_biddable', 'the close receipt reason must still be recorded');
    ok('finalize door: the load-not-biddable latch and recorded refusal survive unconditionally');
  }

  // ============================================================================================
  // 3. MECHANISM (bare stop, no re-arm): bid_cap_exhausted must not page the desk with no
  //    successor left to stand down.
  // ============================================================================================
  {
    const h = await refuseThroughDoor('stop-no-rearm', 'F5-CAP-STOP', CAP);
    assert.strictEqual(alerts(h, 'bid_cap_exhausted'), 0,
      'a stopped target with no successor must not raise bid_cap_exhausted');
    ok('stop-no-rearm door: bid_cap_exhausted raises no desk notice with nothing left to stand down');
  }

  // ============================================================================================
  // 4. The cap latch and the recorded refusal stay unconditional through the same door.
  // ============================================================================================
  {
    const h = await refuseThroughDoor('stop-no-rearm', 'F5-CAP-STOP-LATCH', CAP);
    assert.strictEqual(h.target.capExhausted, true, 'the cap latch must still be set with no successor');
    assert.strictEqual(h.target.revisionsLeft, 0, 'revisionsLeft must still be driven to zero');
    assert.strictEqual(h.target.noBid && h.target.noBid.reason, 'bid_cap_exhausted', 'the close receipt reason must still be recorded');
    ok('stop-no-rearm door: the cap latch, revisionsLeft and recorded refusal survive unconditionally');
  }

  // ============================================================================================
  // 5. + 6. CONTROL (re-price door): a live, un-finalized successor still gets both notices -
  //    the fix must not silence the case it exists to leave alone.
  // ============================================================================================
  {
    const h = await refuseThroughDoor('reprice', 'F5-LNB-CTRL', NOT_BIDDABLE);
    assert.strictEqual(alerts(h, 'load_not_biddable'), 1,
      'CONTROL: a live re-price successor must still get the load_not_biddable notice');
    ok('CONTROL: re-price door - load_not_biddable still reaches the desk on a live successor');
  }
  {
    const h = await refuseThroughDoor('reprice', 'F5-CAP-CTRL', CAP);
    assert.strictEqual(alerts(h, 'bid_cap_exhausted'), 1,
      'CONTROL: a live re-price successor must still get the bid_cap_exhausted notice');
    ok('CONTROL: re-price door - bid_cap_exhausted still reaches the desk on a live successor');
  }

  cleanups.forEach((c) => c());
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  cleanups.forEach((c) => c());
  console.error('\nFAILED:', e && e.stack || e);
  process.exit(1);
});
