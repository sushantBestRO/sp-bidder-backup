'use strict';

/**
 * SnipeHarness dry-run honesty.
 *
 * scripts/snipe.js advertises a DRY-RUN mode and gates a live run behind an explicit
 * "type yes to confirm" prompt, printing "not confirmed - running DRY-RUN" when the operator
 * declines. It passed that choice as `live: isLive` - but arm() destructured only
 * cost/maxMarginPct/minMarginPct, so `live` was silently dropped, the write backstop was raised
 * unconditionally, and _fire called placeBid on EVERY run. The declining operator was told it was
 * a dry run and placed real bids on BRL's account anyway.
 *
 * These cases pin the contract so the prompt can never become theatre again. They are deliberately
 * about the WIRE (was placeBid reached, was the backstop raised), not about log text.
 */

const assert = require('assert');
const { SnipeHarness } = require('../src/engine/snipeHarness');

let passed = 0;
function ok(name) { passed += 1; console.log(`  ok  ${name}`); }

// Adapter that records every placeBid instead of reaching a network.
function stubAdapter() {
  const calls = [];
  return {
    writeEnabled: false,
    calls,
    async placeBid(id, price, opts) { calls.push({ id, price, opts }); return { accepted: true, status: 201, myRank: 1 }; },
  };
}
const stubSock = () => ({ watch() {}, state() { return { myRank: 2 }; }, closesInMs() { return null; } });

const LOAD = { id: 'L1', lane: { origin: 'A', destination: 'B' }, revisionLimit: 3, softClose: false, shipmentType: 'FTL' };
const COST = 50000;

function armed(adapter, armOpts) {
  const h = new SnipeHarness({ realAdapter: adapter, sock: stubSock(), log: () => {} });
  h.arm(LOAD, Object.assign({ cost: COST, maxMarginPct: 12, minMarginPct: 6 }, armOpts));
  h.stop();
  return h;
}

// The decision object _fire takes. Price is the ladder's OPENING rung (plan.ladder is a flat
// price array, highest first) so it sits above the plan floor - otherwise assertAboveFloor throws
// before the live/dry branch is reached and the test would pass for the wrong reason.
const decision = (h) => ({ price: h.plan.ladder[0], rung: 0, why: 'test' });

(async () => {
  // 1. The regression itself: an unconfirmed run must not reach the wire.
  {
    const a = stubAdapter();
    const h = armed(a, {});                      // no `live` at all - snipe.js's declined path
    await h._fire(decision(h), 2, 30000);
    assert.strictEqual(a.calls.length, 0, 'dry-run placed a bid');
    ok('dry-run (live omitted) never calls placeBid');
  }

  // 2. Backstop stays down in dry-run, so the adapter's own gate is a second belt.
  {
    const a = stubAdapter();
    armed(a, {});
    assert.strictEqual(a.writeEnabled, false, 'dry-run raised the adapter write backstop');
    ok('dry-run never opens the adapter write backstop');
  }

  // 3. live: false is explicit and must behave identically to omission.
  {
    const a = stubAdapter();
    const h = armed(a, { live: false });
    await h._fire(decision(h), 2, 30000);
    assert.strictEqual(a.calls.length, 0, 'live:false placed a bid');
    assert.strictEqual(a.writeEnabled, false, 'live:false raised the backstop');
    ok('live: false behaves exactly as omission');
  }

  // 4. The confirmed path still works - this must not become a harness that cannot bid.
  {
    const a = stubAdapter();
    const h = armed(a, { live: true });
    await h._fire(decision(h), 2, 30000);
    assert.strictEqual(a.calls.length, 1, 'live:true did not place a bid');
    assert.strictEqual(a.calls[0].id, 'L1');
    ok('live: true places exactly one real bid per fire');
  }

  // 5. Strict === true. A future CLI/env parser handing a truthy near-miss must NOT arm live:
  //    'false' and '0' are the dangerous ones - both are truthy strings in JS.
  for (const bad of ['true', 'false', '0', 1, 'yes', {}]) {
    const a = stubAdapter();
    const h = armed(a, { live: bad });
    await h._fire(decision(h), 2, 30000);
    assert.strictEqual(a.calls.length, 0, `live: ${JSON.stringify(bad)} armed a real bid`);
    assert.strictEqual(a.writeEnabled, false, `live: ${JSON.stringify(bad)} raised the backstop`);
  }
  ok('only boolean true arms live - truthy near-misses stay dry-run');

  // 6. A live run must still restore the prior backstop state when it stops.
  {
    const a = stubAdapter();
    const h = new SnipeHarness({ realAdapter: a, sock: stubSock(), log: () => {} });
    h.arm(LOAD, { cost: COST, maxMarginPct: 12, minMarginPct: 6, live: true });
    assert.strictEqual(a.writeEnabled, true, 'live arm did not open the backstop');
    h.stop();
    assert.strictEqual(a.writeEnabled, false, 'live run left the backstop open');
    ok('live run restores the write backstop on stop');
  }

  console.log(`\n${passed} passed, 0 failed`);
})().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
