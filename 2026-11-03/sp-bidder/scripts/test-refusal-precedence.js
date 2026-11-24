'use strict';
/**
 * THE CLOBBER: _recordRefusal was UNGUARDED last-writer-wins, and this branch adds three new
 * writers - refused_price_bound, price_raise_refused, submission_window_closed - onto the same
 * `monitor.noBid` field main already writes vehicle_count_refused (and load_not_biddable) into. On
 * a zero-bid load, whichever of these fired LAST won the close-time receipt, regardless of which
 * one actually stopped the load - so a specific, actionable reason (lower the vehicle count) could
 * be silently replaced by a generic one (the window closed) that tells the desk nothing they can
 * act on.
 *
 * THE FIX, two parts:
 *   1. _recordRefusal (src/engine/bidEngine.js) is now FIRST-WRITER-WINS between different reasons -
 *      the reason that actually stopped the load is preserved - with TWO documented exceptions,
 *      REPLACEABLE_PLACEHOLDER_REASONS: refused_price_bound and refusal_unrecognised, the two arms
 *      of one ternary at the refused-price hold. Both are deliberately-weak placeholders rather
 *      than terminal findings (the call site: "we hit a repeated wall is the weakest true statement
 *      available and any sharper verdict should win"), so any DIFFERENT reason recorded after
 *      either is allowed to replace it - but neither displaces an existing different reason, and
 *      neither replaces the other, since neither is the sharper verdict.
 *      Re-recording the SAME reason is untouched - it is how vehicle_count_refused keeps naming the
 *      most recently refused count and how ceiling_below_floor/stood_down_below_floor re-assert
 *      their facts every tick they are still true.
 *   2. waTemplates.js's noBidWhy gained a rendering branch for each of the three new reasons, in the
 *      sibling reasons' 2-sentence pattern, so the close-time receipt names the real cause instead
 *      of degrading to "a rate was entered but no bid could be placed before close".
 *
 * Part 1 is tested directly against _recordRefusal, exactly as this suite already tests noBid
 * semantics elsewhere (test-nobid-classification.js, test-auth-trial-write.js's "refusal-priority
 * guard") - by driving the actual function with hand-built monitor state, not by trying to
 * contrive a live multi-tick sequence through the ladder-walk guards that stand a load down (most
 * of which prevent a second placeBid attempt outright, and so can never reach a second classifier
 * to test the clobber against in the first place). This is the direct, deterministic reproduction
 * of the finding: RED at 620fbc4 (the unguarded last-writer-wins), GREEN after the fix.
 *
 * Offline and deterministic: no adapter, no timers, no network - _recordRefusal takes a plain
 * object and two literals.
 *
 *   node scripts/test-refusal-precedence.js
 */
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;

// EXPECTED-COUNT SENTINEL - see test-nobid-classification.js for why this has to be registered
// before any check runs rather than asserted at the bottom of the file: run-tests.js grades by
// EXIT CODE alone, so an early return or a swallowed throw would otherwise read as a silent green.
const EXPECTED_CHECKS = 54;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

// _recordRefusal reads no engine state (no `this`), so it can be driven directly off the
// prototype against a bare monitor object - no adapter, scheduler or config needed.
const recordRefusal = (m, reason, facts) => BidEngine.prototype._recordRefusal(m, reason, facts || {});

console.log('\n1. FIRST-WRITER-WINS: a specific reason survives a later, more generic write');
{
  // The exact clobber the finding named: main's vehicle_count_refused against each of the three
  // new writers this branch adds.
  for (const [later, facts] of [
    ['refused_price_bound', { price: 8_000, refusals: 3 }],
    ['price_raise_refused', { amountCap: 51_650 }],
    ['submission_window_closed', {}],
  ]) {
    const m = {};
    recordRefusal(m, 'vehicle_count_refused', { vcqSent: 2, units: 5 });
    recordRefusal(m, later, facts);
    ok(m.noBid.reason === 'vehicle_count_refused',
      `vehicle_count_refused survives a later ${later} write (got: ${m.noBid.reason})`);
    ok(m.noBid.vcqSent === 2 && m.noBid.units === 5,
      `vehicle_count_refused's own facts are untouched by the blocked ${later} write`);
  }
}

console.log('\n2. FIRST-WRITER-WINS holds for an older main reason too (load_not_biddable)');
{
  const m = {};
  recordRefusal(m, 'load_not_biddable');
  recordRefusal(m, 'submission_window_closed');
  ok(m.noBid.reason === 'load_not_biddable',
    `load_not_biddable survives a later submission_window_closed write (got: ${m.noBid.reason})`);
}

// BOTH placeholder reasons, not just one. They are the two arms of a single ternary at the
// refused-price hold, chosen by whether any regex matched the portal's wording - a coin the
// precedence rule does not care about. refusal_unrecognised says strictly LESS than
// refused_price_bound ("no classifier could even name the wall" vs "we hit a repeated wall"), so a
// list holding only the stronger of the two would let the weaker one latch where the stronger
// yields. Every exception check below runs against both.
const PLACEHOLDERS = [
  ['refused_price_bound', { price: 8_000, refusals: 3, attemptBudget: 3, bound: 1 }],
  ['refusal_unrecognised', { price: 8_000, refusals: 1, attemptBudget: 3, bound: 1 }],
];

console.log('\n3. THE DOCUMENTED EXCEPTIONS: both placeholder reasons are always superseded');
{
  for (const [placeholder, pfacts] of PLACEHOLDERS) {
    for (const [later, facts] of [
      ['vehicle_count_refused', { vcqSent: 1, units: 3 }],
      ['price_raise_refused', { amountCap: 40_000 }],
      ['submission_window_closed', {}],
      ['load_not_biddable', {}],
    ]) {
      const m = {};
      recordRefusal(m, placeholder, pfacts);
      recordRefusal(m, later, facts);
      ok(m.noBid.reason === later,
        `${placeholder} is replaced by a later ${later} write (got: ${m.noBid.reason})`);
    }
  }
}

console.log('\n4. THE OTHER DIRECTION: neither placeholder displaces an existing different reason '
  + 'when IT is the late write (a weak reason cannot un-happen a strong one)');
{
  for (const [placeholder, pfacts] of PLACEHOLDERS) {
    for (const first of ['vehicle_count_refused', 'price_raise_refused', 'submission_window_closed', 'load_not_biddable']) {
      const m = {};
      recordRefusal(m, first, {});
      recordRefusal(m, placeholder, pfacts);
      ok(m.noBid.reason === first,
        `${first} is NOT displaced by a later ${placeholder} write (got: ${m.noBid.reason})`);
    }
  }
}

console.log('\n4b. THE PLACEHOLDERS DO NOT REPLACE EACH OTHER: neither is the sharper verdict');
{
  for (const [first] of PLACEHOLDERS) {
    const other = PLACEHOLDERS.find(([r]) => r !== first);
    const m = {};
    recordRefusal(m, first, { price: 8_000, refusals: 1 });
    recordRefusal(m, other[0], other[1]);
    ok(m.noBid.reason === first,
      `${first} survives a later ${other[0]} write - one placeholder is not a sharper verdict than the other (got: ${m.noBid.reason})`);
  }
}

console.log('\n5. SAME-REASON RE-LATCH is untouched by the precedence guard');
{
  // vehicle_count_refused: "re-recorded on every refusal ... so the close-time receipt names the
  // most recent count refused" (its own call site) - a walk-down to a strictly lower count must
  // still update the record, not be blocked as a "different" write.
  const m = {};
  recordRefusal(m, 'vehicle_count_refused', { vcqSent: 5, units: 10 });
  recordRefusal(m, 'vehicle_count_refused', { vcqSent: 3, units: 10 });
  ok(m.noBid.reason === 'vehicle_count_refused' && m.noBid.vcqSent === 3,
    `vehicle_count_refused's own re-latch still updates to the newest count (got vcqSent=${m.noBid.vcqSent})`);

  // ceiling_below_floor: "recorded on EVERY tick, not only the first ... the refusal is the
  // standing state of this load" (its own call site) - the SAME reason re-firing every tick must
  // keep refreshing its ceiling/floor facts.
  const m2 = {};
  recordRefusal(m2, 'ceiling_below_floor', { ceiling: 26_000, floor: 27_540 });
  recordRefusal(m2, 'ceiling_below_floor', { ceiling: 26_500, floor: 27_540 });
  ok(m2.noBid.reason === 'ceiling_below_floor' && m2.noBid.ceiling === 26_500,
    `ceiling_below_floor keeps refreshing its facts on every re-latch (got ceiling=${m2.noBid.ceiling})`);
}

console.log('\n6. A FRESH MONITOR always takes its first refusal, whichever reason fires first');
{
  for (const reason of ['refused_price_bound', 'refusal_unrecognised', 'price_raise_refused',
    'submission_window_closed', 'vehicle_count_refused']) {
    const m = {};
    recordRefusal(m, reason, {});
    ok(m.noBid && m.noBid.reason === reason, `a fresh monitor records ${reason} as its first refusal`);
  }
}

console.log('\n7. noBidWhy renders a real explanation for all three new reasons, not the fallback');
{
  const BANNED = [/\bband\b/i, /\bfloor\b/i, /your lowest price/i, /%/];
  const bodies = {};
  for (const reason of ['refused_price_bound', 'price_raise_refused', 'submission_window_closed']) {
    const d = { landedBids: 0, noBidReason: reason };
    const body = renderMessage('no_bid', d);
    const short = renderMessage('no_bid_short', d);
    bodies[reason] = body;
    ok(!/A rate was entered but no bid could be placed/.test(body),
      `${reason} renders its own explanation on the long receipt, not the generic fallback`);
    ok(!/A rate was entered but no bid could be placed/.test(short),
      `${reason} renders its own explanation on the short group-reply receipt too`);
    for (const re of BANNED) {
      ok(!re.test(body), `${reason} avoids banned desk vocabulary ${re} (long receipt)`);
    }
    ok(!/\bbots?\b/i.test(body) && !/\bengines?\b/i.test(body),
      `${reason} contains no internal jargon ("bot"/"engine")`);
  }

  // refused_price_bound is the one reason that must NOT absolve the rate - the portal is refusing
  // this exact PRICE, repeatedly, which every other branch's "the rate was not the problem" line
  // would misstate.
  ok(!/the rate was not the problem/i.test(bodies.refused_price_bound),
    'refused_price_bound does not falsely absolve the rate - the price itself is what is being refused');

  console.log('\n  verbatim bodies:');
  for (const reason of Object.keys(bodies)) console.log(`    ${reason}: ${bodies[reason]}`);
}

console.log(`\nrefusal-precedence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
