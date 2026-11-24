'use strict';

const { buildBandLadder } = require('../engine/pricing');

/**
 * Decide what to do about a shipper Target Rate, given the desk's cost and margin band.
 *
 * The bound is NOT recomputed here - it is buildBandLadder's minimum-margin guard, the same number
 * the engine's one-bid-at-the-ceiling branch clears (ruling 30), so the price page's preview and this
 * submit cannot disagree about a target that sits between the guard and the lowest band price. The
 * returned `floor` is that guard: placeBid's belt asserts against it, so it must be the bound this
 * decision used, not the lowest band price.
 *
 * REFUSING IS THE POINT. A target below the guard is the shipper asking us to work at a
 * loss, and the correct answer is no. This returns 'refuse' rather than clamping up to the floor
 * and submitting that, because a silent counter-offer reads to the shipper as our real price and
 * sets the anchor for the next load. What we submit when we cannot meet the target is a decision
 * for the desk, not a default.
 */
function decideTargetPrice({ targetPricePerUnit, standingPricePerUnit, cost, marginsPct, minMarginPct, chargeLineCount = 1 } = {}) {
  const target = Number(targetPricePerUnit);
  if (!Number.isFinite(target) || target <= 0) {
    return refuse('no_target', 'No usable target price was read from the platform.');
  }
  // The target is quoted across all the truck types at once - verified arithmetically, the
  // platform's own per-unit total is the SUM of the per-line prices - and we have no evidenced
  // way to split one stated number back across lines carrying different trucks. #214 made the
  // write path able to price an N-line quote, but only with ONE uniform per-unit rate; a distinct
  // rate per truck type is still unbuilt. So this refuses because the SPLIT is unknown, not
  // because the portal cannot take it - and the desk is told before a submit is attempted.
  if (chargeLineCount > 1) {
    return refuse('multi_line',
      `This load has ${chargeLineCount} truck types and the target covers all of them. Re-quote it by hand on the portal.`,
      { chargeLineCount });
  }
  // GoComet rejects a quote that does not come down, so sending this only turns an answer we
  // already know into a portal refusal.
  if (targetNotBelowQuote(target, standingPricePerUnit)) {
    return refuse('not_below_quote', 'Our quote is already at or under their rate, so there is nothing to send.',
      { standing: Number(standingPricePerUnit) });
  }
  let plan;
  try {
    plan = buildBandLadder({ cost, marginsPct, minMarginPct });
  } catch (e) {
    return refuse('bad_band', e.message);
  }
  const guard = plan.guard;
  if (target < plan.trueCost) {
    return refuse('below_cost',
      `The target is below what the load costs us. Every bid at that number loses money.`,
      { floor: guard, trueCost: plan.trueCost, shortfall: plan.trueCost - target });
  }
  if (target < guard) {
    return refuse('below_floor',
      `The target is above cost but below our lowest acceptable price.`,
      { floor: guard, trueCost: plan.trueCost, shortfall: guard - target });
  }
  return {
    action: 'bid',
    // ROUND DOWN, never to nearest. The target rides as its own ceiling on the write, and
    // placeBid's belt is `price <= ceiling` - so a target of 97999.6 rounded to nearest sends
    // 98000 against a 97999.6 ceiling and throws CEILING on our own bid. Down is always inside it,
    // and costs at most a rupee of margin on a number the shipper already named.
    price: Math.floor(target),
    floor: guard,
    trueCost: plan.trueCost,
    marginOverFloor: Math.floor(target) - guard,
    reason: null,
    message: null,
  };
}

// Compared on the amount that would go out (rounded down, as the bid is), against a standing quote
// that was actually read; an unread one leaves the decision to the portal.
function targetNotBelowQuote(targetPricePerUnit, standingPricePerUnit) {
  const target = Number(targetPricePerUnit);
  const standing = Number(standingPricePerUnit);
  if (!Number.isFinite(target) || !Number.isFinite(standing) || !(standing > 0)) return false;
  return Math.floor(target) >= standing;
}

function refuse(reason, message, extra = {}) {
  return Object.assign({ action: 'refuse', price: null, floor: null, trueCost: null, reason, message }, extra);
}

module.exports = { decideTargetPrice, targetNotBelowQuote };
