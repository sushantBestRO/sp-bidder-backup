'use strict';

/**
 * WHAT THE DESK IS TOLD when the platform's minimum bid difference reshapes the prices it typed.
 *
 * The rule this exists to satisfy: nothing fails after the price request page. The minimum gap
 * between our own successive bids is published on the load itself, so it is on disk before a cost is
 * typed - which makes "how many of your prices can actually go out" answerable at the moment the
 * desk types the cost, not a surprise discovered mid-auction. Until this, the answer was a log line.
 *
 * A NOTICE AND NOT A REFUSAL, deliberately. Bids still go out and the money is still safe, so an
 * ack-gated block would be the wrong instrument - it trains a desk to click through. A two-attempt
 * plan is a legitimate thing to submit. What must never happen again is submitting it without
 * knowing.
 *
 * TWO OUTCOMES, TWO INSTRUMENTS, and the split is the whole point of this file.
 *
 *   ladderShortfall - prices the plan CANNOT SEND. Capability is lost: fewer attempts is a weaker
 *     snipe, and the desk has exactly two levers to get it back. That is a half-failure, so the page
 *     paints it amber above the Submit button, not grey inside a panel the desk has to open. It
 *     returns FIELDS rather than a paragraph because the page needs the corrective number on a
 *     button as well as in the sentence.
 *   ladderNotice - prices that MOVED but all still go out. Nothing is lost, so it stays a neutral
 *     line beside the prices themselves.
 *
 * A shortfall silences the notice: the amber block has already told that story, and the price line
 * beside the band is then free to do the job it is good at, which is listing what will be sent.
 *
 * Copy rules, and they are load-bearing rather than stylistic: plain language, no internal
 * vocabulary (the words "band" and "floor" and the phrase "your lowest price" do not appear), no em
 * dashes, and every sentence names either a number the desk typed or one we will send. The
 * corrective sentence is what makes it bucket 1 instead of an FYI: it says what to change.
 *
 * Rendered SERVER-side and handed to the page as finished text, so there is exactly one
 * implementation of this copy rather than a second one in the price page's inline script.
 */

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve'];
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth',
  'ninth', 'tenth', 'eleventh', 'twelfth'];

const rs = (n) => `Rs ${Number(n).toLocaleString('en-IN')}`;
const word = (n) => (Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const ordinal = (n) => (Number.isInteger(n) && n > 0 && n < ORDINALS.length ? ORDINALS[n] : `${n}th`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Rs A, Rs B and Rs C" - the plain list form, so the desk reads prices and not an arrow diagram. */
function priceList(prices) {
  const parts = prices.map(rs);
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The last price that would restore `attempts` attempts. The opening is pinned, so the room the
 * plan has to work with is opening minus the last price, and it needs one full gap per step.
 * `spacingMinDecrement` rather than the platform number, because on a per-truck-type load the gap
 * that has to hold is the one that keeps every line clear.
 */
function lastPriceTarget(opening, attempts, spacingMinDecrement) {
  return opening - (attempts - 1) * spacingMinDecrement;
}

/**
 * The facts both of the copy functions below read, or null when this plan cannot be described.
 *
 * @param {Object} p - the preview's derivation result plus the two page-level facts.
 * @param {number[]} p.ladder - the prices the plan holds, opening first.
 * @param {number[]} p.fittingPrices - the subset that can actually reach the board.
 * @param {number} p.rungsRequested - how many prices the desk asked for.
 * @param {number} p.rungsFitting - fittingPrices.length, carried so the page and this agree.
 * @param {number} p.minDecrement - the platform's own minimum, as told to the desk.
 * @param {number} p.spacingMinDecrement - what the ladder had to be spaced by (differs only when
 *   the desk priced each truck type separately).
 * @param {Array} p.rungsMoved - [{index, from, to, gapBefore}] rungs the derivation lowered/raised.
 * @param {number} [p.trueCost] - the desk's own cost, so a corrective target below it is not
 *   suggested. Absent -> the target is offered whatever it is.
 * @param {number} [p.guard] - the minimum-margin guard. A corrective under it is not offered, and
 *   the shortfall then states the fact alone (ruling 67).
 */
function readPlan(p) {
  if (!p) return null;
  const ladder = Array.isArray(p.ladder) ? p.ladder : [];
  const requested = Number(p.rungsRequested);
  const fits = Number(p.rungsFitting);
  const minDec = Number(p.minDecrement);
  if (!ladder.length || !Number.isFinite(minDec) || !Number.isFinite(requested) || !Number.isFinite(fits)) {
    return null;
  }
  // COUNTS ONLY WHEN THEY ARE THE DESK'S OWN. On the interpolated fine-ladder path the rung count is
  // the engine's, not the number of margin rows the desk filled in, so every "N of your M prices"
  // sentence below would name a figure they never typed.
  if (!p.countsAreDeskFacing) return null;
  const spacing = Number.isFinite(Number(p.spacingMinDecrement)) ? Number(p.spacingMinDecrement) : minDec;
  const guard = Number.isFinite(Number(p.guard)) ? Number(p.guard) : null;
  // On a round-figure customer the gap has to be whole grid steps, or the corrective figure snaps
  // back to the same prices and the same refusal every time it is pressed.
  const step = (Number.isInteger(p.roundStep) && p.roundStep > 1) ? p.roundStep : null;
  const targetSpacing = step ? Math.max(step, Math.ceil(spacing / step) * step) : spacing;
  const lostToGrid = Number.isInteger(p.rungsLostToGrid) ? p.rungsLostToGrid : 0;
  return { ladder, requested, fits, minDec, spacing, guard, step, targetSpacing, lostToGrid,
    // A target under the desk's own cost or the minimum-margin guard is not a correction.
    usable: (target) => (!Number.isFinite(Number(p.trueCost)) || target > Number(p.trueCost))
      && (guard == null || target >= guard) };
}

/**
 * THE HALF-FAILURE: prices the desk typed that this load cannot carry.
 *
 * Two sentences and a number, because the desk reads this under a clock on the way to Submit. The
 * fact says what is lost and why; the action says the one thing to change and the figure to change
 * it to. The list of what WILL be sent is deliberately not here - it lives beside the prices
 * themselves, where a desk that wants it will look, and repeating it here is what turned this state
 * into a paragraph nobody read.
 *
 * `costTarget` is the same number the action sentence names, returned separately so the page can put
 * it on a button. One derivation, so the button and the sentence cannot disagree.
 *
 * The target restores ALL the attempts. Where that sits below the desk's own cost or the
 * minimum-margin guard it is not a correction, and the fallback is a SECOND attempt rather than
 * nothing: on a load down to one shot, two is the difference the snipe actually turns on. When the
 * guard rules out both, the block states the fact with no action line and no figure.
 *
 * @returns {{fact: string, action: string|null, costTarget: number|null}|null} - null when every price
 *   the desk typed can be sent.
 */
function ladderShortfall(p) {
  const f = readPlan(p);
  if (!f || f.requested < 2 || f.fits >= f.requested) return null;
  const opening = f.ladder[0];
  const targetFor = (attempts) => lastPriceTarget(opening, attempts, f.targetSpacing);
  const all = targetFor(f.requested);
  const two = targetFor(2);
  let action = null;
  let costTarget = null;
  if (f.usable(all)) {
    costTarget = all;
    action = `Set your last price at ${rs(all)} or less to send all ${word(f.requested)}.`;
  } else if (f.fits < 2 && f.usable(two)) {
    costTarget = two;
    action = `Set your last price at ${rs(two)} or less to send a second price.`;
  } else if (f.guard == null) {
    action = `Move your prices further apart to send all ${word(f.requested)}.`;
  }
  // Blame the grid when it is what cost the missing prices, not a gap every sent price clears.
  const byGrid = f.step != null && f.lostToGrid >= f.requested - f.fits;
  return {
    fact: byGrid
      ? `Only ${f.fits} of your ${f.requested} prices can be sent - this customer takes prices in steps of ${rs(f.step)}, and yours are too close together for that.`
      : `Only ${f.fits} of your ${f.requested} prices can be sent - this customer needs ${rs(f.minDec)} between bids.`,
    action,
    costTarget,
  };
}

/**
 * The NEUTRAL half: every price still goes out, one or more of them at a slightly different figure.
 *
 * Silent on a shortfall. That state is the amber block's, and saying "your first and last prices are
 * unchanged" beside "three of your four cannot be sent" is two stories about one plan.
 *
 * @returns {string|null} - the notice, or null when the plan does exactly what the desk typed.
 */
function ladderNotice(p) {
  const f = readPlan(p);
  if (!f || f.fits < f.requested) return null;
  const { ladder, minDec } = f;
  const moved = Array.isArray(p.rungsMoved) ? p.rungsMoved : [];
  const eachBid = `This customer needs each new bid to be at least ${rs(minDec)} below the one before it`;

  if (moved.length === 1) {
    const m = moved[0];
    const which = (ladder.length === 3 && m.index === 1) ? 'Your middle price' : `Your ${ordinal(m.index + 1)} price`;
    const above = m.index === 1 ? 'your first price' : 'the price before it';
    return `${which} will go out at ${rs(m.to)} instead of ${rs(m.from)}. ${eachBid}, `
      + `and ${rs(m.from)} is only ${rs(m.gapBefore)} below ${above}. Your first and last prices are unchanged.`;
  }
  if (moved.length > 1) {
    return `${cap(word(moved.length))} of your prices move slightly so each bid clears the gap this customer needs. ${eachBid}. `
      + `We will send ${priceList(ladder)}. Your first and last prices are unchanged.`;
  }
  return null;
}

/**
 * THE STEP INTO THE LAST PRICE, which is the one step ladderShortfall above cannot see.
 *
 * `rungsFitting` counts the last price as always sent, because the ENGINE always attempts it - so a
 * plan whose final step is under the customer's minimum reads as complete to every count on this
 * page while the portal may take one price fewer. That is the fact this surfaces, and it is knowable
 * the moment a cost is typed, which is what puts it in bucket 1 of the price-page gate rather than
 * on an alert after the auction.
 *
 * A REFUSAL AND NOT A NOTICE, unlike ladderShortfall beside it, and the difference is which price is
 * at stake. A missing middle price costs an attempt. The last price is the decisive shot the whole
 * ladder is built to reserve, and the correction is free at this moment and gone once the load arms.
 *
 * "MAY BE REFUSED", never will be. Whether the portal measures its minimum against our own previous
 * bid on this last step is a question _reachableAt (bidEngine) and floorStepViolation (pricing)
 * both decline to settle, and the desk is not told more than the code knows.
 *
 * THE CORRECTION RAISES THE PRICE ABOVE IT, never lowers the last one. Lowering the last price is
 * giving away margin to buy back an attempt, which is the exact harm fittingRungs' own note records
 * from the last time this page overstated a shortfall.
 *
 * SILENT ON A MINIMUM WE DO NOT HAVE. `minDecrementUnknown` means the figure is the adapter's static
 * fallback, not this load's published number - GoComet's real slab_rate has been observed at both
 * 300 and 1,000 on one day. This block stops the submit, so computing it off a fallback would refuse
 * a load over a gap that may not exist. ladderCaveat already tells the desk the number is
 * provisional, which is the honest instrument for a fact we are missing.
 *
 * @param {Object} p - the preview, carrying floorStepViolation as bidEngine computed it.
 * @param {boolean} [p.minDecrementUnknown] - the minimum came from the adapter, not from the load.
 * @returns {{fact: string, action: string, priceTarget: number|null, rowIndex: number|null}|null}
 *   - null when the last price can go out.
 */
function floorStepRefusal(p) {
  const v = p && p.floorStepViolation;
  if (!v || !Number.isFinite(Number(v.minDecrement))) return null;
  if (p.minDecrementUnknown) return null;
  const b = v.bindingLine;
  const fact = b
    ? `On the ${b.label || 'cheapest'} truck, ${rs(b.toPrice)} is only ${rs(b.gap)} below `
      + `${rs(b.fromPrice)}, so your last price may be refused. This customer needs ${rs(v.minDecrement)} `
      + 'between bids on every truck.'
    : `${rs(v.toPrice)} is only ${rs(v.gap)} below ${rs(v.fromPrice)}, so your last price may be refused. `
      + `This customer needs ${rs(v.minDecrement)} between bids.`;
  // The row to raise, offered only where the prices on this page ARE the rows the desk filled in.
  // On the interpolated fine ladder they are not, so there is no row to point a button at and the
  // instruction has to name the change instead of making it.
  const f = readPlan(p);
  const ladder = (p && Array.isArray(p.ladder)) ? p.ladder : [];
  const idx = ladder.indexOf(v.fromPrice);
  const target = v.toPrice + v.minDecrement;
  // Absent stays absent: the preview reports no ceiling as null, and Number(null) is 0, which reads
  // as a cap below every price and would withhold the correction on every load that has none.
  const ceiling = (p && p.ceiling != null) ? Number(p.ceiling) : NaN;
  // A target above the customer's cap would be capped straight back down, so it is not a correction.
  // Per-line exclusions get no figure at all: the blended price that clears one truck's own gap is
  // not this arithmetic, and a number that does not fix it is worse than the instruction alone.
  const offer = !b && f && idx >= 0 && idx < ladder.length - 1
    && !(Number.isFinite(ceiling) && target > ceiling);
  return {
    fact,
    action: offer
      ? `Raise your ${ordinal(idx + 1)} price to ${rs(target)} or more so the last one can go out.`
      : 'Move your last two prices further apart so the last one can go out.',
    priceTarget: offer ? target : null,
    rowIndex: offer ? idx : null,
  };
}

/**
 * The "we do not know this customer's minimum yet" caveat, SEPARATE from the notice above.
 *
 * It is a missing FACT, not a changed plan, and conflating the two cost the desk its price list: the
 * page swaps the ladder line for the notice, so returning this as a notice hid the prices on every
 * keystroke for every load whose minimum is unknown - including plans that were byte-identical to
 * what the desk typed. Kept apart so the page can show both: the prices, and the caveat under them.
 *
 * The ratified copy ends with "You will be told on the close message if that happens." That sentence
 * is NOT here, deliberately: nothing yet reads skippedRungs[] onto a close message, and a promise the
 * code does not keep is worse on a money page than no promise. Restore it in the same change that
 * implements the close receipt, not before.
 */
function ladderCaveat(p) {
  if (!p || !p.minDecrementUnknown) return null;
  const minDec = Number(p.minDecrement);
  if (!Number.isFinite(minDec)) return null;
  return `We do not have this customer's minimum gap between bids for this load yet, so we are planning on ${rs(minDec)}. `
    + 'If the real gap turns out to be wider, one of your prices may not go out.';
}

module.exports = { ladderNotice, ladderCaveat, ladderShortfall, floorStepRefusal };
