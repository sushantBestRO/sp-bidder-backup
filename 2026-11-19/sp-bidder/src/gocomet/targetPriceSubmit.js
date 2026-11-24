'use strict';

const { decideTargetPrice } = require('./targetPriceDecision');

/**
 * Answer a shipper Target Rate: decide, then place exactly ONE bid.
 *
 * WHY THIS EXISTS RATHER THAN armFromRequest. A target rate is not an auction. Routing the desk's
 * answer through the engine was the original wiring and it never reached the portal at all:
 * bidEngine.arm short-circuits on an existing monitor (`this.monitors.has(meta.id)`) and _finalize
 * leaves finalized monitors in that map, so a load whose auction closed in this same process
 * handed the desk's cost straight back to the dead monitor. The page then rendered that monitor's
 * stale ladder as if it were the plan. Nothing was ever submitted.
 *
 * Even with a re-arm path it would still be the wrong shape. A ladder walks a price DOWN over a
 * window, spending a revision per rung against GoComet's 3-per-vendor-per-enquiry cap - a cap this
 * vendor identity already shares with BRL's own separate bot. A target rate is one question with
 * one answer: meet their number or do not. So this places a single bid and stops.
 *
 * It refuses rather than counter-offering. A silent counter reads to the shipper as our real price
 * and anchors the next load; what we send when we cannot meet the target is the desk's call, not a
 * default.
 */
async function submitTargetRate({ adapter, request, cost, marginsPct, minMarginPct, nowMs = Date.now() } = {}) {
  if (!adapter || typeof adapter.placeBid !== 'function') {
    const e = new Error('submitTargetRate: no adapter to submit through'); e.code = 'BAD_INPUT'; throw e;
  }
  // The window is a wall, unlike an auction cutoff. capture() already refuses a cost past the
  // close it holds, but this is re-checked on the wire side because the two are separated by a
  // network round trip and the shortest window observed is 13m45s.
  const deadline = Number(request && request.targetDeadlineMs);
  if (Number.isFinite(deadline) && nowMs >= deadline) {
    return refusal('window_closed',
      "The customer's offer had already lapsed when this was submitted, so nothing was sent.");
  }

  const decision = decideTargetPrice({
    targetPricePerUnit: request.targetPricePerUnit,
    standingPricePerUnit: request.standingPricePerUnit,
    cost,
    marginsPct,
    minMarginPct,
    chargeLineCount: request.chargeLineCount,
  });
  if (decision.action !== 'bid') return Object.assign({ submitted: false }, decision);

  // decideTargetPrice rounds DOWN, so the amount is always inside the target it is ceilinged by
  // (see the comment there). Rounding down can in principle land under the floor when the two are
  // within a rupee, so that is re-checked rather than assumed.
  const price = decision.price;
  if (price < decision.floor) {
    return refusal('below_floor',
      'Their rate rounds to below the lowest price we accept on this load, so nothing was sent.');
  }

  // placeBid RESOLVES on a platform rejection - it returns { accepted: false, rejectReason } and
  // throws only on a network or structural failure. Awaiting it and assuming success is how a
  // refused bid gets reported to the desk as sent, which also suppresses the missed-window alert:
  // the load then reads as answered to us and unanswered to the shipper. Anything that is not an
  // explicit accepted:true is treated as NOT sent - fail closed, because "we could not tell" and
  // "it went through" must never collapse into the same message on a money path.
  const res = await adapter.placeBid(request.loadId, price, {
    floor: decision.floor,
    ceilingPrice: request.targetPricePerUnit,
  });
  if (!res || res.accepted !== true) {
    const why = (res && (res.rejectReason || res.reason)) || 'no reason given';
    return refusal('rejected', `The portal refused it (${why}).`);
  }
  return Object.assign({ submitted: true }, decision, { price });
}

function refusal(reason, message) {
  return { action: 'refuse', submitted: false, price: null, floor: null, trueCost: null, reason, message };
}

module.exports = { submitTargetRate };
