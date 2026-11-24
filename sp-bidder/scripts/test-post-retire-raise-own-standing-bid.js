'use strict';
/**
 * A GoComet raise refusal ("You've increased the quote price") that resolves after a re-price must not
 * stand the successor down when the lower quote it was refused against is the successor's OWN landed
 * bid.
 *
 * stop() does not wait for a write already on the wire, so the retired monitor's write and the
 * successor's first write can overlap. If the successor lands a lower price first, the platform refuses
 * the retired write as an upward revision. GoComet's refusal names no cap, so nothing bounds the latch:
 * latching it on the successor stops it for the rest of the auction - no defend, no snipe - and puts a
 * false price_raise_refused reason on the close receipt.
 *
 * Must NOT move: when the successor's standing price is ABOVE the refused price, the lower quote is not
 * ours and the latch still sets; and SuperProcure's numeric cap is still judged against the successor's
 * floor, whatever the successor has standing.
 *
 *   node scripts/test-post-retire-raise-own-standing-bid.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 15;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const REMAINING_MS = 114 * 60 * 1000;
const OPEN_AT_MS = 2 * 60 * 60 * 1000;

const refusal = (body) => ({ accepted: false, status: 422, reason: body, text: body });
const RAISE_REFUSED = refusal("You've increased the quote price. Please add a remark explaining the change to continue");
const amountCap = (cap) => refusal(`Amount is invalid. Amount should be less than or equal to ${cap}`);

const liveState = (closesInMs = REMAINING_MS) => ({ ok: true, status: 'live', myRank: 2, totalBidders: 3,
  standingL1Price: null, closesInMs, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50, minDecrement: 100 });
const FINAL_WINDOW_MS = 2_000;
const mkLoad = (id) => ({ id, lane: { origin: 'Pune', destination: 'Nagpur' }, equipment: 'SXL', units: 1,
  companyName: 'Waaree Energies', branchName: 'Alwar', closesAt: Date.now() + REMAINING_MS,
  startsAt: Date.now() - 1_000, status: 'live', softClose: false });
const PRICING_RETIRED = { cost: 29_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const PRICING_LOWER = { cost: 27_000, marginsPct: [9, 5, 1], minMarginPct: 1 };
const PRICING_HIGHER = { cost: 30_000, marginsPct: [9, 5, 1], minMarginPct: 1 };

const cleanups = [];
const floorOf = (m) => m.ladder[m.ladder.length - 1];
const alerts = (h, kind) => h.events.filter((e) => e.type === 'alert' && e.kind === kind).length;

// The retired monitor's first write is held on the wire; the re-price arms a successor, the successor
// lands its own first bid, and only then does the held write resolve with `res(retiredPrice, live)`.
async function raceThroughReprice(id, successorPricing, res) {
  const f = path.join(os.tmpdir(), `post-retire-raise-own-${id}-${process.pid}.json`);
  let release;
  const onWire = new Promise((r) => { release = r; });
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
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

  const fired = engine.arm(mkLoad(id), PRICING_RETIRED);
  if (fired.timer) clearTimeout(fired.timer);
  fired.timer = null;
  const inFlight = engine._maybeBid(fired, liveState());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(adapter.placed.length, 1, `fixture (${id}): exactly one write is on the wire`);
  const retiredPrice = adapter.placed[0];

  engine.stop(id);
  const live = engine.arm(mkLoad(id), successorPricing);
  if (live.timer) clearTimeout(live.timer);
  live.timer = null;
  assert.notStrictEqual(live, fired, `fixture (${id}): the re-price built a successor monitor`);

  await engine._maybeBid(live, liveState());
  assert.strictEqual(adapter.placed.length, 2, `fixture (${id}): the successor put its own first bid on the wire`);
  assert.strictEqual(live.landedBids, 1, `fixture (${id}): the successor's first bid landed`);
  const successorPrice = adapter.placed[1];

  release(res(retiredPrice, live));
  await inFlight;
  assert.strictEqual(events.filter((e) => e.type === 'bid_rejected').length, 1,
    `fixture (${id}): the refusal resolved through the post-retire door`);
  return { engine, adapter, events, fired, live, retiredPrice, successorPrice };
}

async function firesInFinalWindow(h) {
  const before = h.adapter.placed.length;
  await h.engine._maybeBid(h.live, liveState(FINAL_WINDOW_MS));
  return h.adapter.placed.length - before;
}

// W1-7 F1 + its live mirror: BOTH writes held on the wire at once, resolve order controlled by the
// caller. This is the shape raceThroughReprice cannot reach - there the successor's write always
// resolves (accepted) before the retired write's refusal does, which is exactly the "already landed"
// case the existing R1-F01 guard already covers. Here neither write has resolved when the other's
// refusal is judged, so the guard can only see the other write by checking the in-flight record.
async function raceTwoHeldWrites(id, { predecessorPricing, successorPricing, order, predRes, succRes }) {
  const f = path.join(os.tmpdir(), `w17-f1-race-${id}-${process.pid}.json`);
  const releases = [];
  const adapter = {
    writeEnabled: true, placed: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => liveState(),
    async placeBid(_id, price) {
      this.placed.push(price);
      const idx = this.placed.length - 1;
      // Only the predecessor's and the successor's OWN first fire (idx 0, 1) are held for the caller
      // to resolve in the chosen order. Anything after that - firesInFinalWindow's later shot - is a
      // write this fixture is not exercising a race on, so it resolves immediately, same as
      // raceThroughReprice's adapter does past its own first held call.
      if (idx > 1) return { accepted: true, myRank: 1, latencyMs: 30 };
      return new Promise((r) => { releases[idx] = r; });
    },
  };
  const engine = new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, minInterFireMs: 0 }, live: true });
  const events = [];
  engine.onEvent = (e) => events.push(e);
  cleanups.push(() => { try { engine.kill(); } catch (_) {} try { fs.unlinkSync(f); } catch (_) {} });

  const predecessor = engine.arm(mkLoad(id), predecessorPricing);
  if (predecessor.timer) clearTimeout(predecessor.timer);
  predecessor.timer = null;
  const predFired = engine._maybeBid(predecessor, liveState());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(adapter.placed.length, 1, `fixture (${id}): the predecessor's write is on the wire`);
  const predPrice = adapter.placed[0];

  engine.stop(id);
  const successor = engine.arm(mkLoad(id), successorPricing);
  if (successor.timer) clearTimeout(successor.timer);
  successor.timer = null;
  assert.notStrictEqual(successor, predecessor, `fixture (${id}): the re-price built a successor monitor`);

  const succFired = engine._maybeBid(successor, liveState());
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(adapter.placed.length, 2, `fixture (${id}): the successor's write is also on the wire`);
  const succPrice = adapter.placed[1];

  if (order === 'predecessor-first') {
    releases[0](predRes(predPrice, succPrice));
    await predFired;
    releases[1](succRes(predPrice, succPrice));
    await succFired;
  } else {
    releases[1](succRes(predPrice, succPrice));
    await succFired;
    releases[0](predRes(predPrice, succPrice));
    await predFired;
  }
  return { engine, adapter, events, predecessor, live: successor, predPrice, succPrice };
}

(async () => {
  // ---- 1) + 2) + 3) the successor's own lower bid is what the platform refused against ----
  {
    const h = await raceThroughReprice('RAISEOWN', PRICING_LOWER, () => RAISE_REFUSED);
    assert.ok(h.successorPrice < h.retiredPrice,
      `fixture: the successor landed ${h.successorPrice}, which must sit below the retired write's ${h.retiredPrice}`);
    assert.strictEqual(h.live.lastBidPrice, h.successorPrice, 'fixture: the successor holds its own landed price');

    assert.ok(!h.live.priceRaiseRefused,
      `the retired write at ${h.retiredPrice} was refused as a raise over the successor's OWN standing ${h.successorPrice}, `
      + `and the successor carries priceRaiseRefused ${h.live.priceRaiseRefused} - it is stood down for the rest of `
      + 'the auction by its own bid');
    ok('a raise refusal explained by the successor\'s own lower bid does not latch the successor');

    assert.ok(!(h.live.noBid && h.live.noBid.reason === 'price_raise_refused'),
      'the successor carries a price_raise_refused record, so the close receipt would state a refusal that never applied to it');
    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 0,
      'a bid_price_raise_refused alert went out for a refusal the successor\'s own bid explains');
    ok('no price_raise_refused record and no raise alert for it');

    const fires = await firesInFinalWindow(h);
    assert.strictEqual(fires, 1, `in the final window the successor put ${fires} writes on the wire; it must still fire`);
    ok('the successor still fires its final-window shot');
  }

  // ---- 4) + 5) CONTROL: the successor stands ABOVE the refused price, so the lower quote is not ours.
  //      Owner ruling 26 Sep (260925SQRC): the successor continues BELOW that quote while a band price
  //      below it remains, and stands down only when none does.
  {
    const h = await raceThroughReprice('RAISEFOREIGN', PRICING_HIGHER, () => RAISE_REFUSED);
    assert.ok(h.successorPrice > h.retiredPrice,
      `fixture: the successor landed ${h.successorPrice}, which must sit above the retired write's ${h.retiredPrice}`);
    assert.ok(floorOf(h.live) < h.retiredPrice, 'fixture: the successor\'s floor must sit below the refused price');
    assert.ok(!h.live.priceRaiseRefused,
      'control: the successor stood down although a band price below the standing quote remains');
    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 0, 'control: a stand-down notice went out for a load still bidding');
    ok('control: with the successor above the refused price it keeps bidding, with no stand-down notice');

    const before = h.adapter.placed.length;
    const fires = await firesInFinalWindow(h);
    const sent = h.adapter.placed.slice(before);
    assert.strictEqual(fires, 1, `control: in the final window the successor put ${fires} writes on the wire; it must still fire`);
    assert.ok(sent.every((p) => p < h.retiredPrice),
      `control: the successor sent ${JSON.stringify(sent)}, at or above the refused ${h.retiredPrice}`);
    ok('control: the successor\'s next write is below the refused price');
  }

  // ---- 6) SuperProcure's numeric cap is judged on the successor's floor, unchanged ----
  {
    let cap;
    const h = await raceThroughReprice('RAISESPCAP', PRICING_LOWER, (_retiredPrice, live) => {
      cap = floorOf(live) - 100;
      return amountCap(cap);
    });
    assert.ok(h.successorPrice < h.retiredPrice, 'fixture: the successor stands below the retired write');
    assert.strictEqual(h.live.priceRaiseRefused, true,
      `SuperProcure capped the amount at ${cap}, below the successor's floor ${floorOf(h.live)}; the cap judgement must `
      + 'still latch whatever the successor has standing');
    assert.strictEqual(h.live.priceRaiseRefusedCap, cap, 'the successor records the cap the portal named');
    ok('an SP amount cap below the successor floor still latches while the successor stands lower');
  }

  // ---- 7) + 8) + 9) W1-7 F1: the retired door, successor's own LOWER write still IN FLIGHT --------
  // Monitor A (predecessor) fires 31,610 (held), is retired, B (successor) fires 29,430 (held). A's
  // refusal resolves while B's write is still unresolved - the shape raceThroughReprice cannot reach.
  {
    const h = await raceTwoHeldWrites('F1INFLIGHT', {
      predecessorPricing: PRICING_RETIRED, successorPricing: PRICING_LOWER, order: 'predecessor-first',
      predRes: () => RAISE_REFUSED,
      succRes: () => ({ accepted: true, myRank: 1, latencyMs: 30 }),
    });
    assert.ok(h.succPrice < h.predPrice,
      `fixture: the successor's in-flight price ${h.succPrice} must sit below the predecessor's refused ${h.predPrice}`);
    assert.ok(!h.live.priceRaiseRefused,
      `the predecessor's write at ${h.predPrice} was refused as a raise while the successor's own lower `
      + `write ${h.succPrice} was still in flight, and the successor carries priceRaiseRefused `
      + `${h.live.priceRaiseRefused} - it is stood down before its own lower write has even resolved`);
    ok('F1: a retired write refused while the successor\'s own lower write is in flight does not latch');

    assert.ok(!(h.live.noBid && h.live.noBid.reason === 'price_raise_refused'),
      'the successor carries a price_raise_refused record explained entirely by its own in-flight write');
    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 0, 'a raise alert went out for the in-flight case');
    ok('F1: no price_raise_refused record and no raise alert');

    const fires = await firesInFinalWindow(h);
    assert.strictEqual(fires, 1, `in the final window the successor put ${fires} writes on the wire; it must still fire`);
    ok('F1: the successor still fires its final-window shot');
  }

  // ---- 10) + 11) + 12) THE LIVE MIRROR: predecessor LANDS first, the successor's OWN fire is refused -
  // A (predecessor) fires 29,430 (held) then retires; B (successor), on a HIGHER ladder with a rung
  // still below 29,430, fires 31,610 (held). A resolves accepted (B.lastBidPrice becomes 29,430 via
  // _recordLandedAfterRetire) BEFORE B's own refusal resolves - so by the time B's live-door check
  // runs, monitor.lastBidPrice already reads 29,430. The live door had NO comparison against it at all.
  {
    const h = await raceTwoHeldWrites('MIRRORLANDED', {
      predecessorPricing: PRICING_LOWER, successorPricing: PRICING_RETIRED, order: 'predecessor-first',
      predRes: () => ({ accepted: true, myRank: 1, latencyMs: 30 }),
      succRes: () => RAISE_REFUSED,
    });
    assert.strictEqual(h.live.lastBidPrice, h.predPrice, 'fixture: the predecessor\'s landed price is now the successor\'s standing bid');
    assert.ok(h.succPrice > h.predPrice, `fixture: the successor's own fire ${h.succPrice} must sit above the standing ${h.predPrice}`);
    assert.ok(!h.live.priceRaiseRefused,
      `the successor's OWN fire at ${h.succPrice} was refused as a raise over its own standing bid of `
      + `${h.live.lastBidPrice}, and it carries priceRaiseRefused ${h.live.priceRaiseRefused} - the live door `
      + 'raise-refusal check has no comparison against the monitor\'s own standing price at all');
    ok('live mirror: a raise refusal over our own already-landed standing bid does not latch');

    assert.ok(!(h.live.noBid && h.live.noBid.reason === 'price_raise_refused'), 'the successor records a refusal its own standing bid explains');
    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 0, 'a raise alert went out for a refusal explained by our own standing bid');
    ok('live mirror: no price_raise_refused record and no raise alert');

    const fires = await firesInFinalWindow(h);
    assert.strictEqual(fires, 1, `in the final window the successor put ${fires} writes on the wire; it must still fire`);
    ok('live mirror: the successor still fires its final-window shot');
  }

  // ---- 13) + 14) + 15) THE LIVE MIRROR'S OWN IN-FLIGHT CASE: predecessor NOT YET landed -------------
  // Same fixture as above, but B's own refusal resolves BEFORE A's acceptance - so monitor.lastBidPrice
  // does not yet read 29,430 when B's live-door check runs. Only the in-flight record can explain it.
  {
    const h = await raceTwoHeldWrites('MIRRORINFLIGHT', {
      predecessorPricing: PRICING_LOWER, successorPricing: PRICING_RETIRED, order: 'successor-first',
      predRes: () => ({ accepted: true, myRank: 1, latencyMs: 30 }),
      succRes: () => RAISE_REFUSED,
    });
    assert.ok(h.succPrice > h.predPrice, `fixture: the successor's own fire ${h.succPrice} must sit above the predecessor's ${h.predPrice}`);
    assert.ok(!h.live.priceRaiseRefused,
      `the successor's OWN fire at ${h.succPrice} was refused as a raise while the predecessor's lower `
      + `write ${h.predPrice} was still in flight (not yet landed), and the successor carries `
      + `priceRaiseRefused ${h.live.priceRaiseRefused}`);
    ok('live mirror F1: a raise refusal over a predecessor\'s still in-flight lower write does not latch');

    assert.ok(!(h.live.noBid && h.live.noBid.reason === 'price_raise_refused'), 'the successor records a refusal its own in-flight predecessor explains');
    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 0, 'a raise alert went out for the in-flight case');
    ok('live mirror F1: no price_raise_refused record and no raise alert');

    const fires = await firesInFinalWindow(h);
    assert.strictEqual(fires, 1, `in the final window the successor put ${fires} writes on the wire; it must still fire`);
    ok('live mirror F1: the successor still fires its final-window shot');
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
