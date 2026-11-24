'use strict';
/**
 * A refusal that resolves after its monitor was retired may only raise a stand-down alert when a
 * monitor is left that can still act on the load. After a close (_finalize) or a stop with no re-arm,
 * nothing is left to stand down.
 *
 * vehicle_count_refused is a routed desk notice: it tells the customer's group to lower the truck count
 * and re-price. Sent for a load that has already closed or been cancelled, it is a wrong instruction the
 * customer acts on, possibly after the close receipt has gone out. _finalize keeps the finalized monitor
 * in the map, and a bare stop leaves the retired monitor as the only target, so both reach the alert.
 *
 * Must NOT move: the refusal is still recorded on the monitor (the close record states why), and the
 * re-price door - a live successor that can act - still gets its one alert.
 *
 *   node scripts/test-post-retire-alert-finalized-target.js
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
const QUANTITY_REFUSED = refusal('Quote quantity is greater than total quantity');
const SUBMISSION_CLOSED = refusal('Auction has already ended for this load');
const RAISE_REFUSED = refusal("You've increased the quote price. Please add a remark explaining the change to continue");

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = (id) => ({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 3,
  quoteType: 'FTL', companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false });
const PRICING_A = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const PRICING_B = { cost: 27_000, marginsPct: [20, 10, 1], minMarginPct: 1 };

const cleanups = [];
const alerts = (h, kind) => h.events.filter((e) => e.type === 'alert' && e.kind === kind).length;

// Parks the first write on the wire, retires its monitor through `door`, then resolves the write with res.
async function refuseAfter(door, id, res) {
  const f = path.join(os.tmpdir(), `post-retire-finalized-${id}-${process.pid}.json`);
  let release;
  const onWire = new Promise((r) => { release = r; });
  const adapter = {
    writeEnabled: true, placed: 0,
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    async placeBid() {
      this.placed += 1;
      if (this.placed === 1) return onWire;
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
  assert.strictEqual(adapter.placed, 1, `fixture (${id}): exactly one write is on the wire`);

  let target;
  if (door === 'finalize') {
    await engine._finalize(fired, liveState());
    assert.strictEqual(engine.monitors.get(id), fired, `fixture (${id}): _finalize kept the closed monitor in the map`);
    target = fired;
  } else if (door === 'stop') {
    engine.stop(id);
    assert.strictEqual(engine.monitors.get(id), undefined, `fixture (${id}): stop() left a monitor in the map`);
    target = fired;
  } else {
    engine.stop(id);
    target = engine.arm(mkLoad(id), PRICING_B);
    if (target.timer) clearTimeout(target.timer);
    target.timer = null;
    assert.notStrictEqual(target, fired, `fixture (${id}): the re-price built a successor monitor`);
  }
  assert.strictEqual(!!target.finalized, door !== 'reprice', `fixture (${id}): unexpected finalized state on the target`);

  release(res);
  await inFlight;
  assert.strictEqual(events.filter((e) => e.type === 'bid_rejected').length, 1,
    `fixture (${id}): the refusal resolved through the post-retire door`);
  return { engine, events, fired, target };
}

(async () => {
  // ---- 1) + 2) finalize door: the load has closed, then the quantity refusal resolves ----
  {
    const h = await refuseAfter('finalize', 'FINQTY', QUANTITY_REFUSED);
    assert.strictEqual(alerts(h, 'vehicle_count_refused'), 0,
      'a vehicle_count_refused desk notice went out for a load _finalize had already closed - the customer group is '
      + 'told to lower the truck count and re-price a closed load');
    ok('finalize door: no vehicle_count_refused alert for a closed load');

    assert.strictEqual(h.target.noBid && h.target.noBid.reason, 'vehicle_count_refused',
      'finalize door: the refusal was not recorded on the monitor');
    assert.strictEqual(h.target.quantityRefused, true, 'finalize door: the quantity latch was not set');
    ok('finalize door: the refusal is still recorded and latched');
  }

  // ---- 3) + 4) bare stop, no re-arm: the load was cancelled, then the quantity refusal resolves ----
  {
    const h = await refuseAfter('stop', 'STOPQTY', QUANTITY_REFUSED);
    assert.strictEqual(alerts(h, 'vehicle_count_refused'), 0,
      'a vehicle_count_refused desk notice went out for a load that was stopped with no successor');
    assert.strictEqual(h.target.noBid && h.target.noBid.reason, 'vehicle_count_refused',
      'bare stop: the refusal was not recorded on the retired monitor');
    ok('bare stop: no vehicle_count_refused alert, the refusal still recorded');

    const s = await refuseAfter('stop', 'STOPSUBM', SUBMISSION_CLOSED);
    assert.strictEqual(alerts(s, 'submission_window_closed'), 0,
      'a submission_window_closed alert went out for a load that was stopped with no successor');
    const r = await refuseAfter('finalize', 'FINRAISE', RAISE_REFUSED);
    assert.strictEqual(alerts(r, 'bid_price_raise_refused'), 0,
      'a bid_price_raise_refused alert went out for a load _finalize had already closed');
    assert.strictEqual(r.target.priceRaiseRefused, true, 'finalize door: the raise latch was not set');
    ok('the submission-closed and raise stand-down alerts are held the same way');
  }

  // ---- 5) + 6) CONTROL: re-price door - the successor can act, so it is told once ----
  {
    const h = await refuseAfter('reprice', 'REPQTY', QUANTITY_REFUSED);
    assert.strictEqual(alerts(h, 'vehicle_count_refused'), 1,
      'control: the re-price door lost its vehicle_count_refused alert');
    ok('control: re-price door still raises vehicle_count_refused exactly once');

    assert.strictEqual(h.target.quantityRefused, true, 'control: the successor was not latched');
    assert.strictEqual(h.target.noBid && h.target.noBid.reason, 'vehicle_count_refused', 'control: no refusal recorded');
    ok('control: re-price door latches and records on the successor');
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
