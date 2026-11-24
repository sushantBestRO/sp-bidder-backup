'use strict';
/**
 * A REVERT TO AN UNBUILDABLE BAND IS REFUSED, WHATEVER THE CALLER KNOWS ABOUT THE STANDING BID.
 *
 * Regression target: T1 D5.
 *
 * clearBidOverride proves the band it restores can build a ladder before it writes, and refuses
 * with BAD_INPUT when it cannot. That proof sat inside `standingBid && ...`, and every production
 * caller passes standingBid null (the re-price routes no longer refuse on reachability). So the
 * refusal fired for no real caller. The ordinary path is masked by the route's own floor preview,
 * which throws on the same band; the preview answers null when no running stack serves the load's
 * portal, and then nothing stood between an env-typo default band (a slash-separated margins list
 * parses to [NaN]) and an armed record carrying it.
 *
 * WHAT MUST NOT MOVE:
 *   - a revert to a buildable inherited band still saves with standingBid null (check 1);
 *   - with a standing bid supplied the refusal fires, as it always did (check 2).
 *
 * Offline and deterministic: MemoryStore, no server, no timers.
 *
 *   node scripts/test-revert-refuses-unbuildable-band.js
 */
const assert = require('assert');
const { MemoryStore } = require('../src/store/memoryStore');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const OVERRIDE = { marginsPct: [14, 10, 7], minMarginPct: 7 };
const mkLoad = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, companyName: 'Waaree',
  closesAt: Date.now() + 45 * 60_000, softClose: false, status: 'live',
});

async function armedWithOverride(requests, loadId) {
  const pr = await requests.createForLoad(mkLoad(loadId), { deadlineAt: Date.now() + 30 * 60_000 });
  await requests.capture(pr.id, { cost: 30000, marginOverride: OVERRIDE });
  const doc = await requests.getByToken(pr.id);
  assert.strictEqual(doc.status, 'armed', `setup: ${loadId} is armed on its override`);
  assert.deepStrictEqual(doc.marginsPct, OVERRIDE.marginsPct, `setup: ${loadId} carries the override band`);
  return pr.id;
}

(async () => {
  try {
    // ---- 1. CONTROL: a buildable inherited band reverts with standingBid null
    {
      const requests = new PriceRequestStore({ store: new MemoryStore(), marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
      const token = await armedWithOverride(requests, 'RUB-OK');
      const updated = await requests.clearBidOverride(token, { standingBid: null, planFloor: null });
      assert.deepStrictEqual(updated.marginsPct, [12.6, 7.2, 6.3], 'control: the inherited band is restored');
      assert.strictEqual(updated.marginOverride, null, 'control: the override is cleared');
      ok('control: a revert to a buildable band saves with no standing bid supplied');
    }

    // ---- 2. POSITIVE PIN: with a standing bid supplied, the unbuildable revert is refused
    {
      const requests = new PriceRequestStore({ store: new MemoryStore(), marginsPct: [NaN], minMarginPct: 6.3 });
      const token = await armedWithOverride(requests, 'RUB-STANDING');
      await assert.rejects(
        () => requests.clearBidOverride(token, { standingBid: { price: 34000, minDecrement: 100 }, planFloor: null }),
        (e) => e.code === 'BAD_INPUT' && /not buildable/.test(e.message),
        'with a standing bid the revert to [NaN] is refused BAD_INPUT');
      const doc = await requests.getByToken(token);
      assert.deepStrictEqual(doc.marginsPct, OVERRIDE.marginsPct, 'the refused revert left the override band in place');
      ok('with a standing bid supplied, a revert to [NaN] is refused and nothing is written');
    }

    // ---- 3. THE DEFECT: the production callers' arguments (standingBid null) skip the proof
    {
      const requests = new PriceRequestStore({ store: new MemoryStore(), marginsPct: [NaN], minMarginPct: 6.3 });
      const token = await armedWithOverride(requests, 'RUB-NULL');
      let refused = null;
      try { await requests.clearBidOverride(token, { standingBid: null, planFloor: null }); }
      catch (e) { refused = e; }
      const doc = await requests.getByToken(token);
      assert.ok(refused && refused.code === 'BAD_INPUT',
        `T1 D5 dead refusal: clearBidOverride with standingBid null (what every re-price route passes) `
        + `saved the unbuildable band ${JSON.stringify(doc.marginsPct)} on a record reading '${doc.status}' `
        + `instead of refusing BAD_INPUT (got ${refused ? refused.code : 'no error'})`);
      assert.deepStrictEqual(doc.marginsPct, OVERRIDE.marginsPct, 'T1 D5: the refused revert must leave the override band in place');
      assert.deepStrictEqual(doc.price.marginsPct, OVERRIDE.marginsPct, 'T1 D5: the armed price keeps the band its ladder was built from');
      ok('no standing bid: a revert to [NaN] is refused and nothing is written');
    }

    console.log(`\nPASS - ${pass}/3 checks passed`);
    process.exit(0);
  } catch (e) {
    console.error('\nFAILED (T1 D5 revert to an unbuildable band):', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
