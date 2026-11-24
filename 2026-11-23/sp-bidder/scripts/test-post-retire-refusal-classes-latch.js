'use strict';
/**
 * Regression: BH-STATE-3 (T7 E5).
 *
 * A SUBMISSION-CLOSED, QUANTITY-REFUSED or RAISE-REFUSED refusal that resolves after the monitor that
 * fired it was retired has to stand the load down on whatever monitor is live, exactly as the live
 * rejection path does after ONE refused write: the same latch, the same recorded refusal, the same
 * desk alert.
 *
 * _recordRefusedAfterRetire classifies only load-not-biddable and the bid cap. The other three
 * terminal classes fall through with a bid_rejected event and nothing latched, so the live monitor
 * spends the rest of the auction firing writes SuperProcure is already refusing on the shared live
 * account, and the close receipt has no reason to state. Two production doors reach it:
 *   - re-price: stop() + arm() while a write is on the wire; the SUCCESSOR is the live monitor;
 *   - kill: kill() lands mid-write and deliberately leaves the monitor in this.monitors, so after
 *     resume() the SAME monitor keeps ticking.
 *
 * The SP amount-cap form of the raise refusal is ladder-relative (raiseRefusal): it is terminal only
 * when the FLOOR is above the named cap. After a re-price the ladder that matters is the successor's,
 * so a cap sitting between the successor's floor and the retired floor must not latch.
 *
 * Must NOT move: the load-not-biddable latch through the same door (the control, check 1), and the
 * budget - revisionsLeft is not zeroed and capExhausted is not set for these classes, the same as on
 * the live path. The bid-cap class is out of scope here.
 *
 *   node scripts/test-post-retire-refusal-classes-latch.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 12;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;

const refusal = (body) => ({ accepted: false, status: 400, reason: body, text: body });
const NOT_BIDDABLE = refusal('Load not available for bidding');
const SUBMISSION_CLOSED = refusal('Auction has already ended for this load');
const QUANTITY_REFUSED = refusal('Quote quantity is greater than total quantity');
const RAISE_REFUSED = refusal("You've increased the quote price. Please add a remark explaining the change to continue");
const amountCap = (cap) => refusal(`Amount should be less than or equal to ${cap}`);

const liveState = () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs: REMAINING_MS, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const mkLoad = (id, extra) => Object.assign({ id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false }, extra);
const MULTI_VEHICLE = { units: 3, quoteType: 'FTL' };
// The re-price lowers the cost, so the successor's floor sits below the retired one.
const PRICING_A = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const PRICING_B = { cost: 27_000, marginsPct: [20, 10, 1], minMarginPct: 1 };

const cleanups = [];
const floorOf = (m) => m.ladder[m.ladder.length - 1];
const alerts = (h, kind) => h.events.filter((e) => e.type === 'alert' && e.kind === kind).length;

// Arms one load, parks its first write on the wire, lands `door` while it is held, then resolves the
// write with `res` (or `res(fired, live)`, built once both ladders exist). Returns the live monitor.
async function refuseThroughDoor(door, id, res, loadExtra) {
  const f = path.join(os.tmpdir(), `post-retire-classes-${id}-${process.pid}.json`);
  let release;
  const onWire = new Promise((r) => { release = r; });
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    async placeBid(_id, price, opts) {
      this.placed.push({ price, vcq: opts && opts.vcq != null ? opts.vcq : null });
      if (this.placed.length === 1) return onWire;
      return { accepted: true, myRank: 1, latencyMs: 30 };
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  cleanups.push(() => { try { engine.kill(); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} });

  const fired = engine.arm(mkLoad(id, loadExtra), PRICING_A);
  if (fired.timer) clearTimeout(fired.timer);
  fired.timer = null;
  const inFlight = engine._maybeBid(fired, liveState());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(adapter.placed.length, 1, `precondition (${id}): exactly one write is on the wire`);

  let live;
  if (door === 'reprice') {
    engine.stop(id);
    live = engine.arm(mkLoad(id, loadExtra), PRICING_B);
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    assert.notStrictEqual(live, fired, `precondition (${id}): the re-price built a successor monitor`);
  } else {
    engine.kill('manual');
    live = fired;
    assert.strictEqual(engine.monitors.get(id), fired, `precondition (${id}): kill() left the monitor in the map`);
  }
  const revisionsBefore = live.revisionsLeft;

  release(typeof res === 'function' ? res(fired, live) : res);
  await inFlight;
  assert.strictEqual(events.filter((e) => e.type === 'bid_rejected').length, 1,
    `precondition (${id}): the refusal resolved through the post-retire door onto the record`);
  if (door === 'kill') {
    engine.resume();
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
  }
  return { engine, adapter, events, fired, live, revisionsBefore };
}

function assertBudgetUntouched(h, cls) {
  assert.ok(!h.live.capExhausted, `${cls} is not a cap refusal, so capExhausted must stay unset`);
  assert.strictEqual(h.live.revisionsLeft, h.revisionsBefore,
    `${cls} leaves revisionsLeft intact; zeroing it hands a later re-price a phantom exhausted load`);
}

function assertOnlyLatch(h, cls, own) {
  for (const k of ['loadNotBiddable', 'submissionClosed', 'quantityRefused', 'priceRaiseRefused']) {
    if (k !== own) assert.ok(!h.live[k], `${cls} must latch ${own} only, but ${k} is set too`);
  }
}

(async () => {
  // ---- 1) CONTROL: the class the post-retire path already carries. A failure here is the harness. ----
  {
    const h = await refuseThroughDoor('reprice', 'E5CTRL', NOT_BIDDABLE);
    assert.strictEqual(h.live.loadNotBiddable, true, 'control: load-not-biddable did not reach the successor - harness is dead');
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'load_not_biddable', 'control: no refusal recorded');
    ok('control: load-not-biddable after a re-price latches on the successor');
  }

  // ---- 2) + 3) SUBMISSION CLOSED, re-price door. ----
  {
    const h = await refuseThroughDoor('reprice', 'E5SUBM', SUBMISSION_CLOSED);
    assert.strictEqual(h.live.submissionClosed, true,
      'MECHANISM: "Auction has already ended for this load" resolved after a re-price and the successor carries '
      + `submissionClosed ${h.live.submissionClosed} - _recordRefusedAfterRetire has no submission-closed class, so the `
      + 'successor keeps firing into a closed window on the shared account (live path latches after ONE write)');
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'submission_window_closed',
      'the close receipt has no submission_window_closed reason on the successor');
    assertBudgetUntouched(h, 'submission closed');
    ok('submission-closed after a re-price latches submissionClosed on the successor');

    assert.strictEqual(alerts(h, 'submission_window_closed'), 1,
      'the live path emits exactly one submission_window_closed alert; the post-retire twin must not be silent');
    assertOnlyLatch(h, 'submission closed', 'submissionClosed');
    ok('submission-closed after a re-price raises its alert once and latches nothing else');
  }

  // ---- 4) + 5) + 6) QUANTITY REFUSED, re-price door, on a multi-vehicle load (vcq on the wire). ----
  {
    const h = await refuseThroughDoor('reprice', 'E5QTY', QUANTITY_REFUSED, MULTI_VEHICLE);
    const vcqSent = h.adapter.placed[0].vcq;
    assert.strictEqual(vcqSent, MULTI_VEHICLE.units, 'precondition: the refused write carried the load\'s truck count');
    assert.strictEqual(h.live.quantityRefused, true,
      'MECHANISM: the vehicle-count refusal resolved after a re-price and the successor carries quantityRefused '
      + `${h.live.quantityRefused} - _recordRefusedAfterRetire has no quantity class, so the successor re-sends the refused count`);
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'vehicle_count_refused',
      'the close receipt has no vehicle_count_refused reason on the successor');
    assertBudgetUntouched(h, 'quantity refused');
    ok('quantity-refused after a re-price latches quantityRefused on the successor');

    assert.strictEqual(h.live.quantityRefusedAtVcq, vcqSent,
      'the latch binds the COUNT that was refused, as the live path does; a bare latch stands the load down outright '
      + 'and blocks the desk\'s lower-count remedy');
    assert.strictEqual(h.live.noBid.units, MULTI_VEHICLE.units, 'the recorded refusal carries the load\'s units');
    assert.strictEqual(h.live.noBid.vcqSent, vcqSent, 'the recorded refusal carries the count that went on the wire');
    assert.strictEqual(alerts(h, 'vehicle_count_refused'), 1,
      'the live path emits exactly one vehicle_count_refused alert; the post-retire twin must not be silent');
    assertOnlyLatch(h, 'quantity refused', 'quantityRefused');
    ok('quantity-refused after a re-price latches the refused count, records units, alerts once, latches nothing else');

    await h.engine._maybeBid(h.live, liveState());
    const again = h.adapter.placed.slice(1).filter((p) => p.vcq != null && p.vcq >= vcqSent);
    assert.deepStrictEqual(again, [],
      'the successor put the refused count back on the shared account after the portal refused it');
    ok('the successor sends no second write at the refused count');
  }

  // ---- 7) + 8) RAISE REFUSED (GoComet wording), re-price door. The standing quote sits below the
  //      successor's floor, so no band price remains below it (owner ruling 26 Sep, 260925SQRC). ----
  {
    const h = await refuseThroughDoor('reprice', 'E5RAISE', (_fired, live) => Object.assign({}, RAISE_REFUSED, { standingPrice: floorOf(live) - 100 }));
    assert.strictEqual(h.live.priceRaiseRefused, true,
      'MECHANISM: the upward-revision refusal resolved after a re-price and the successor carries priceRaiseRefused '
      + `${h.live.priceRaiseRefused} - _recordRefusedAfterRetire has no raise class, so the successor walks its ladder under a standing bid`);
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'price_raise_refused',
      'the close receipt has no price_raise_refused reason on the successor');
    assertBudgetUntouched(h, 'raise refused');
    ok('raise-refused after a re-price latches priceRaiseRefused on the successor');

    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 1,
      'the live path emits exactly one bid_price_raise_refused alert; the post-retire twin must not be silent');
    assertOnlyLatch(h, 'raise refused', 'priceRaiseRefused');
    ok('raise-refused after a re-price raises its alert once and latches nothing else');
  }

  // ---- 9) AMOUNT CAP below the successor's floor: no rung the successor owns can be accepted. ----
  {
    let cap;
    const h = await refuseThroughDoor('reprice', 'E5CAPLO', (fired, live) => {
      assert.ok(floorOf(live) < floorOf(fired), 'precondition: the re-price lowered the floor');
      cap = floorOf(live) - 100;
      return amountCap(cap);
    });
    assert.strictEqual(h.live.priceRaiseRefused, true,
      `SuperProcure capped the amount at ${cap}, below the successor's floor ${floorOf(h.live)}, and the successor `
      + `carries priceRaiseRefused ${h.live.priceRaiseRefused} - the amount-cap form of the raise refusal is not carried across the retire`);
    assert.strictEqual(h.live.priceRaiseRefusedCap, cap, 'the successor records the cap the portal named');
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'price_raise_refused', 'the close receipt names the raise refusal');
    assert.strictEqual(h.live.noBid.amountCap, cap, 'the recorded refusal carries the named cap');
    assertBudgetUntouched(h, 'amount cap');
    ok('an amount cap below the successor floor latches on the successor with the cap recorded');
  }

  // ---- 10) AMOUNT CAP between the successor's floor and the retired floor: the successor can still
  // offer a rung at or below it, so this is the ordinary walk-down, judged on the SUCCESSOR's ladder. ----
  {
    let cap, retiredFloor;
    const h = await refuseThroughDoor('reprice', 'E5CAPMID', (fired, live) => {
      retiredFloor = floorOf(fired);
      cap = Math.floor((floorOf(live) + retiredFloor) / 2);
      assert.ok(floorOf(live) <= cap && cap < retiredFloor, 'precondition: the cap sits between the two floors');
      return amountCap(cap);
    });
    assert.ok(!h.live.priceRaiseRefused,
      `a cap of ${cap} is above the successor's floor ${floorOf(h.live)} (retired floor ${retiredFloor}), so the successor `
      + 'still owns acceptable rungs; latching it judges the verdict against the retired ladder');
    assert.strictEqual(h.live.noBid, null, 'and no refusal is recorded against the successor');
    ok('an amount cap the successor ladder can still meet does not latch - judged on the successor floor');
  }

  // ---- 11) + 12) SUBMISSION CLOSED, kill door: the latch, then the stand-down it exists for. ----
  {
    const h = await refuseThroughDoor('kill', 'E5KILL', SUBMISSION_CLOSED);
    assert.strictEqual(h.live.submissionClosed, true,
      'MECHANISM: a kill landed mid-write, the portal said the auction has ended, and the SAME monitor resume() keeps '
      + `ticking carries submissionClosed ${h.live.submissionClosed} - the kill door drops the stand-down`);
    assert.strictEqual(h.live.noBid && h.live.noBid.reason, 'submission_window_closed',
      'the close receipt has no submission_window_closed reason after the kill door');
    ok('submission-closed through the kill door latches on the live monitor');

    const before = h.adapter.placed.length;
    await h.engine._maybeBid(h.live, liveState());
    assert.strictEqual(h.adapter.placed.length, before,
      'after resume() the monitor put a second write on the shared account into a window the portal already closed');
    ok('after resume() the monitor puts no second write on the wire');
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
