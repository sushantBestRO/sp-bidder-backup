'use strict';

/**
 * The one-request-per-load collision, which is what would make this feature silently do nothing.
 *
 * A Target Rate always lands on a load that already has an auction price-request, and by then the
 * sweeps have moved that record to terminal 'closed'. createForLoad returns the dead row without
 * error, so the ask would never be raised and nothing would log. These pin the separate path and,
 * just as importantly, pin that the auction path is unchanged by its existence.
 */

const assert = require('assert');
const { PriceRequestStore, effectiveCloseAt, TARGET_PRICE_KIND, armFromRequest } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store/memoryStore');

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`); };

const AUCTION_CLOSE = Date.now() - 45 * 60_000;      // closed 45 minutes ago, as both real ones were
const TARGET_DEADLINE = Date.now() + 14 * 60_000;    // a 14-minute window, the shortest observed

const LOAD = {
  id: '260817N3VH',
  lane: { origin: 'Kutch', destination: 'Chennai' },
  equipment: '40FTHB', units: 1, companyName: 'Waaree Energies Ltd.',
  closesAt: AUCTION_CLOSE, rules: { minDecrement: 500 },
};

(async () => {
  const store = new MemoryStore();
  const reqs = new PriceRequestStore({ store, log: () => {}, platformKey: 'gocomet' });

  // The auction ask, then swept terminal exactly as it would be after the close.
  const auction = await reqs.createForLoad(LOAD, { deadlineAt: AUCTION_CLOSE - 35_000 });
  await reqs.finalizeClosed(Date.now(), { platformKey: 'gocomet' });
  const swept = await reqs.getByToken(auction.id);
  assert.strictEqual(swept.status, 'closed', 'precondition: the auction ask is terminal');
  ok('the auction request is terminal by the time a target rate arrives');

  // THE TRAP, pinned as live behaviour rather than described in a comment.
  const collided = await reqs.createForLoad(LOAD, { deadlineAt: TARGET_DEADLINE });
  assert.strictEqual(collided.id, auction.id, 'createForLoad hands back the DEAD row');
  assert.strictEqual(collided.status, 'closed');
  assert.strictEqual(collided.deadlineAt, auction.deadlineAt, 'the new deadline was silently ignored');
  ok('createForLoad on a closed load silently returns the dead row (why a separate path exists)');

  // The separate path raises a real, open ask.
  const tp = await reqs.createForTargetPrice(LOAD, {
    targetPricePerUnit: 98000, standingPricePerUnit: 102695,
    targetDeadlineMs: TARGET_DEADLINE, negotiationRound: 'r1', comment: 'Immediate Requirement',
  });
  assert.notStrictEqual(tp.id, auction.id, 'a distinct record');
  assert.strictEqual(tp.status, 'awaiting_price');
  assert.strictEqual(tp.kind, TARGET_PRICE_KIND);
  assert.strictEqual(tp.targetPricePerUnit, 98000);
  // deadlineAt is a CUTOFF held back from the wall so a cost typed at the line still has time to
  // be submitted - the same shape the auction ask uses. It must be before the shipper's deadline
  // and not so far before that it eats the window.
  assert.ok(tp.deadlineAt < TARGET_DEADLINE, 'the desk cutoff sits before the shipper deadline');
  assert.ok(TARGET_DEADLINE - tp.deadlineAt <= 60_000, 'the runway never exceeds a minute');
  assert.ok(TARGET_DEADLINE - tp.deadlineAt >= 15_000, 'the runway is at least fifteen seconds');
  ok('the target-rate path raises a genuinely open ask on the same load, with runway to submit');

  // The deadline that every sweep and the page countdown read must be the SHIPPER'S, not the
  // auction's - otherwise expireOverdue retires this ask on its very next tick.
  assert.strictEqual(effectiveCloseAt(tp.load), TARGET_DEADLINE,
    'the sweeps read the target deadline, not the auction close');
  const expired = await reqs.expireOverdue(Date.now(), { platformKey: 'gocomet' });
  assert.strictEqual(expired.find((r) => r.id === tp.id), undefined,
    'the ask survives the sweep that runs immediately after it is created');
  assert.strictEqual((await reqs.getByToken(tp.id)).status, 'awaiting_price');
  ok('carrying the shipper deadline as closesAt stops the sweeps retiring the ask instantly');

  // Had it carried the auction close, the sweep would have killed it - proving the point is real.
  const naive = await reqs.createForTargetPrice({ ...LOAD, id: 'NAIVE1' }, {
    targetPricePerUnit: 98000, targetDeadlineMs: TARGET_DEADLINE, negotiationRound: 'r1',
  });
  await reqs.store.patchDoc('priceRequests', naive.id, { load: { ...naive.load, closesAt: AUCTION_CLOSE } });
  const killed = await reqs.expireOverdue(Date.now(), { platformKey: 'gocomet' });
  assert.ok(killed.some((r) => r.id === naive.id), 'with the auction close it IS swept, immediately');
  ok('the same ask carrying the auction close is swept at once (the trap is real, not theoretical)');

  // The auction path must be unaffected by the new record sharing its loadId.
  const back = await reqs.getByLoad(LOAD.id);
  assert.strictEqual(back.id, auction.id, 'getByLoad still returns the AUCTION record, not the target one');
  assert.notStrictEqual(back.kind, TARGET_PRICE_KIND);
  ok('getByLoad is unchanged for the auction path despite a second record on the same load');

  // Idempotent per round, and a second round is its own ask.
  const again = await reqs.createForTargetPrice(LOAD, { targetPricePerUnit: 98000, targetDeadlineMs: TARGET_DEADLINE, negotiationRound: 'r1' });
  assert.strictEqual(again.id, tp.id, 'same round returns the same ask');
  const r2 = await reqs.createForTargetPrice(LOAD, { targetPricePerUnit: 95000, targetDeadlineMs: TARGET_DEADLINE + 3_600_000, negotiationRound: 'r2' });
  assert.notStrictEqual(r2.id, tp.id, 'a second round is its own ask');
  assert.strictEqual(r2.targetPricePerUnit, 95000);
  ok('one ask per round: idempotent within a round, distinct across rounds');

  // The target rides the ceiling machinery, which is how the floor refusal gets reused.
  assert.strictEqual(tp.load.rules.ceilingPrice, 98000,
    'the target is expressed as a ceiling so planPreview and the ceiling belt judge it');
  assert.strictEqual(tp.load.rules.minDecrement, 500, 'the original rules survive');
  ok('the target is carried as a shipper ceiling, reusing the existing dead-plan machinery');

  await assert.rejects(
    () => reqs.createForTargetPrice(LOAD, { targetPricePerUnit: 98000, negotiationRound: 'r9' }),
    (e) => e.code === 'BAD_INPUT', 'a missing deadline is refused, never defaulted');
  ok('an ask with no shipper deadline is refused rather than given a made-up one');

  // THE ARMING HOLE, closed structurally. capture() moves every request to 'armed', which is the
  // status that opens the re-price surface - and that posts straight back into armFromRequest. The
  // console's margin route reaches it too. Refusing at the one function they all funnel through is
  // what makes "a target rate never arms the auction engine" a property rather than a convention.
  {
    const armable = Object.assign({}, tp, { price: { cost: 80000, marginsPct: [12.6], minMarginPct: 6.3 } });
    let threw = null;
    try { armFromRequest({ caps: {} }, armable); } catch (e) { threw = e; }
    assert.ok(threw && threw.code === 'TARGET_RATE_NOT_ARMABLE',
      'armFromRequest refuses a target rate outright, whichever route reached it');
    // and an ordinary auction request is untouched by that guard
    const plainArmable = Object.assign({}, auction, { price: { cost: 80000, marginsPct: [12.6], minMarginPct: 6.3 } });
    let plainThrew = null;
    try { armFromRequest({ caps: {}, arm: () => ({ ladder: [1] }), scheduler: null }, plainArmable); } catch (e) { plainThrew = e; }
    assert.ok(!plainThrew || plainThrew.code !== 'TARGET_RATE_NOT_ARMABLE',
      'an ordinary auction ask is not caught by the target-rate guard');
    ok('a target rate can never arm the auction engine, from any route');
  }

  const EXPECTED = 10;
  assert.strictEqual(checks, EXPECTED, `expected ${EXPECTED} checks, ran ${checks} - the file did not run to completion`);
  console.log(`\n${checks}/${EXPECTED} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
