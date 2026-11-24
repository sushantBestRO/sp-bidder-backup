'use strict';
/**
 * Regression: BH-STATE-4 (T7 E8).
 *
 * A bid-cap refusal ("Bid limit exceeded") that resolves after the monitor that fired it was retired
 * has to put bid_cap_exhausted on the close receipt, exactly as the live rejection path does.
 *
 * _recordRefusedAfterRetire's cap branch sets capExhausted, zeroes revisionsLeft, persists it and
 * emits the bid_cap_exhausted alert, but never calls _recordRefusal - while the load-not-biddable
 * branch in the same function does. monitor.noBid stays null, _refusalAtClose returns null, and the
 * auction_result falls back to the generic "a rate was entered but no bid could be placed before
 * close", sending the desk after a pricing mistake that does not exist. Two production doors:
 *   - re-price: stop() + arm() while the write is on the wire; the SUCCESSOR is the live monitor;
 *   - kill: kill() lands mid-write and leaves the monitor in this.monitors for resume().
 *
 * Must NOT move: the load-not-biddable receipt through the same door (the control, check 1) and the
 * cap latch itself - capExhausted, revisionsLeft 0, one bid_cap_exhausted alert (check 2).
 *
 *   node scripts/test-post-retire-cap-receipt-reason.js
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

const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;

const refusal = (body) => ({ accepted: false, status: 400, reason: body, text: body });
const NOT_BIDDABLE = refusal('Load not available for bidding');
const BID_CAP = refusal('Bid limit exceeded');

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false });
const PRICING_A = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const PRICING_B = { cost: 27_000, marginsPct: [20, 10, 1], minMarginPct: 1 };

const cleanups = [];

async function refuseThroughDoor(door, id, res) {
  const f = path.join(os.tmpdir(), `post-retire-cap-${id}-${process.pid}.json`);
  let release;
  const onWire = new Promise((r) => { release = r; });
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    async placeBid(_id, price) {
      this.placed.push(price);
      if (this.placed.length === 1) { await onWire; return res; }
      return { accepted: true, myRank: 1, latencyMs: 30 };
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  cleanups.push(() => { try { engine.kill(); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} });

  const fired = engine.arm(mkLoad(id), PRICING_A);
  if (fired.timer) clearTimeout(fired.timer);
  fired.timer = null;
  const inFlight = engine._maybeBid(fired, liveState());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(adapter.placed.length, 1, `precondition (${id}): exactly one write is on the wire`);

  let live;
  if (door === 'reprice') {
    engine.stop(id);
    live = engine.arm(mkLoad(id), PRICING_B);
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    assert.notStrictEqual(live, fired, `precondition (${id}): the re-price built a successor monitor`);
  } else {
    engine.kill('manual');
    live = fired;
    assert.strictEqual(engine.monitors.get(id), fired, `precondition (${id}): kill() left the monitor in the map`);
  }

  release();
  await inFlight;
  assert.strictEqual(events.filter((e) => e.type === 'bid_rejected').length, 1,
    `precondition (${id}): the refusal resolved through the post-retire door onto the record`);
  if (door === 'kill') {
    engine.resume();
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
  }
  return { engine, adapter, live, events };
}

async function closeAndReadReceipt(h) {
  await h.engine._finalize(h.live, liveState());
  const results = h.events.filter((e) => e.type === 'auction_result');
  assert.strictEqual(results.length, 1, 'precondition: _finalize emitted exactly one auction_result');
  return results[0];
}

(async () => {
  // ---- 1) CONTROL: the sibling class in the same function reaches the receipt. A failure here is the harness. ----
  {
    const h = await refuseThroughDoor('reprice', 'E8CTRL', NOT_BIDDABLE);
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'load_not_biddable',
      'control: load-not-biddable recorded no refusal on the successor - harness is dead');
    const receipt = await closeAndReadReceipt(h);
    assert.strictEqual(receipt.noBidReason, 'load_not_biddable',
      'control: the close receipt did not carry load_not_biddable - the finalize harness is dead');
    ok('control: load-not-biddable after a re-price reaches the successor and its close receipt');
  }

  const cap = await refuseThroughDoor('reprice', 'E8CAP', BID_CAP);

  // ---- 2) PINS: the cap latch the post-retire branch already sets. ----
  {
    assert.strictEqual(cap.live.capExhausted, true, 'pin: the post-retire cap branch did not run');
    assert.strictEqual(cap.live.revisionsLeft, 0, 'pin: the successor kept revision budget after a cap refusal');
    assert.strictEqual(cap.events.filter((e) => e.type === 'alert' && e.kind === 'bid_cap_exhausted').length, 1,
      'pin: exactly one bid_cap_exhausted alert');
    ok('pin: "Bid limit exceeded" after a re-price latches capExhausted, zeroes revisionsLeft, alerts once');
  }

  // ---- 3) MECHANISM: the cap branch records its reason. ----
  {
    assert.strictEqual(cap.live.noBid && cap.live.noBid.reason, 'bid_cap_exhausted',
      'MECHANISM: "Bid limit exceeded" resolved after a re-price, the successor carries capExhausted true and '
      + `noBid ${JSON.stringify(cap.live.noBid)} - _recordRefusedAfterRetire's cap branch never calls `
      + "_recordRefusal(target, 'bid_cap_exhausted') (the live path and the load-not-biddable branch both do)");
    ok('the successor records bid_cap_exhausted as its refusal');
  }

  // ---- 4) CONSEQUENCE: the close receipt names the cap. ----
  {
    const receipt = await closeAndReadReceipt(cap);
    assert.strictEqual(receipt.noBidReason, 'bid_cap_exhausted',
      `the close receipt carries noBidReason ${receipt.noBidReason} on a load whose bid cap the platform closed, `
      + 'so the desk reads the generic "no bid could be placed before close"');
    ok('the close receipt carries noBidReason bid_cap_exhausted');
  }

  // ---- 5) KILL DOOR: the same monitor resume() keeps ticking records the cap. ----
  {
    const h = await refuseThroughDoor('kill', 'E8KILL', BID_CAP);
    assert.strictEqual(h.live.capExhausted, true, 'pin: the cap latch did not land through the kill door');
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'bid_cap_exhausted',
      'MECHANISM (kill door): a kill landed mid-write, SuperProcure answered "Bid limit exceeded", and the '
      + `resumed monitor carries noBid ${JSON.stringify(h.live.noBid)} - the cap branch drops the receipt reason`);
    ok('kill door: the resumed monitor records bid_cap_exhausted');
  }

  cleanups.forEach((c) => c());
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  cleanups.forEach((c) => c());
  console.error('\nFAILED:', e && e.stack || e);
  process.exit(1);
});
