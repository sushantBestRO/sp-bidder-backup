'use strict';
/**
 * EVERY DESK ACTION THAT REBUILDS THE QUOTE MOVES THE RE-PRICE EPOCH TO A VALUE IT HAS NOT HELD.
 *
 * The engine carries the portal's refusals across a restart only while the epoch on the intent equals
 * the one stamped on the refusals. That makes the epoch's arithmetic the whole of the re-price
 * discriminator: a bump that lands back on an earlier value (a counter that steps down and then
 * sticks, say) makes the second re-price read as a restart, and the old refusals silence a quote the
 * portal has never ruled on. The first re-price alone cannot show that, so this walks four in a row
 * across all four writers.
 *
 *   node scripts/test-reprice-epoch-moves-every-time.js
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

(async () => {
  const requests = new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
  const load = { id: 'EP1', lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Durian Industries', closesAt: Date.now() + 600_000, startsAt: Date.now() - 1000, status: 'live', softClose: false };
  const created = await requests.createForLoad(load, { deadlineAt: Date.now() + 300_000 });
  const captured = await requests.capture(created.id, { cost: 45_000 });

  const seen = [Number.isInteger(captured.repriceEpoch) ? captured.repriceEpoch : 0];
  const step = async (label, fn) => {
    const doc = await fn();
    const e = doc && doc.repriceEpoch;
    assert.ok(Number.isInteger(e), `${label}: the epoch is not an integer (${JSON.stringify(e)})`);
    assert.ok(!seen.includes(e), `${label}: the epoch went back to ${e}, a value it already held (${JSON.stringify(seen)}); `
      + 'this re-price would read as a restart and carry the old quote\'s refusals');
    seen.push(e);
  };

  await step('first margin override', () => requests.setBidOverride(created.id, { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 }));
  await step('second margin override', () => requests.setBidOverride(created.id, { marginsPct: [13, 8, 6.3], minMarginPct: 6.3 }));
  await step('clearing the override', () => requests.clearBidOverride(created.id));
  await requests.stop(created.id);
  await step('a desk re-arm', () => requests.rearm(created.id));
  console.log(`\nre-price epoch moves every time: ${seen.length - 1}/4 checks passed (${JSON.stringify(seen)})`);
})().catch((e) => { console.error('FAIL', e && e.message ? e.message : e); process.exitCode = 1; });
