'use strict';
/**
 * A retired write refused as a raise over a standing bid at the SAME price does not stand the successor down.
 *
 * A re-price that keeps the prices builds a successor that lands the same first price as the retired
 * monitor's write still on the wire. When that write is then refused as a raise, the lower-or-equal
 * standing quote is our own, exactly as when the successor stands below it. The suite pinned the
 * below case and the above control but not the equal boundary (mutation critique, PR-1).
 *
 *   node scripts/test-post-retire-raise-equal-standing-bid.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 2;
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
  const f = path.join(os.tmpdir(), `post-retire-raise-equal-${id}-${process.pid}.json`);
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

(async () => {
  try {
    const h = await raceThroughReprice('RAISEEQUAL', PRICING_RETIRED, () => RAISE_REFUSED);
    assert.strictEqual(h.successorPrice, h.retiredPrice,
      `fixture: the successor landed ${h.successorPrice}, which must equal the retired write's ${h.retiredPrice}`);
    assert.ok(!h.live.priceRaiseRefused,
      `the retired write at ${h.retiredPrice} was refused against the successor's own standing bid at the same price, `
      + 'and the successor is stood down for the rest of the auction');
    assert.strictEqual(alerts(h, 'bid_price_raise_refused'), 0, 'a raise alert went out for a refusal our own bid explains');
    ok('1. a raise refusal explained by our own standing bid at the same price does not latch the successor');
    const fires = await firesInFinalWindow(h);
    assert.strictEqual(fires, 1, `in the final window the successor put ${fires} writes on the wire; it must still fire`);
    ok('2. the successor still fires its final-window shot');
  } finally {
    for (const c of cleanups) c();
  }
  if (pass !== EXPECTED_CHECKS) { console.log(`FAIL: ${pass}/${EXPECTED_CHECKS}`); process.exit(1); }
  console.log(`
${pass}/${EXPECTED_CHECKS} checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); for (const c of cleanups) c(); process.exit(1); });
