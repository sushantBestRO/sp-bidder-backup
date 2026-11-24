'use strict';
/**
 * /price capture-form money-path input validation. The capture form sets the cost + margins that
 * drive real bids, and the POST handler is untrusted (a curl/fetch with the token bypasses every
 * inline control). Three holes this pins closed:
 *   1. Blank margin field -> Number('') = 0 -> smallest bid 0 -> derived floor collapses to
 *      break-even cost (all protected margin given away, silently). parseBandForm now rejects it.
 *   2. Sub-rupee cost (0.4) -> Math.round -> 0 -> operatingFloor 0 -> a Rs 0 bid passes
 *      assertAboveFloor. capture() now requires cost >= Rs 1.
 *   3. Finite-but-absurd margin (1e308) -> cost x (1 + m/100) overflows to Infinity in the ladder.
 *      validateMargins now caps at MAX_MARGIN_PCT.
 * Plus: non-contiguous rungs (m_0 + m_2, no m_1) silently dropped a bid and mis-derived the floor.
 *   node scripts/test-price-validation.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { validateMargins, parseBandForm, MAX_MARGIN_PCT } = require('../src/pricing/marginValidate');
const { buildBandLadder } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const fail = (n) => { console.error('  FAIL  ' + n); process.exitCode = 1; };
function throwsBad(fn, label) {
  try { fn(); } catch (e) {
    if (e.code === 'BAD_INPUT') return ok(label);
    return fail(`${label}: threw ${e.code || '(no code)'} - ${e.message}`);
  }
  fail(`${label}: expected BAD_INPUT, nothing thrown`);
}
async function throwsBadAsync(fn, label) {
  try { await fn(); } catch (e) {
    if (e.code === 'BAD_INPUT') return ok(label);
    return fail(`${label}: threw ${e.code || '(no code)'} - ${e.message}`);
  }
  fail(`${label}: expected BAD_INPUT, nothing thrown`);
}
const mkLoad = (id) => ({ id, lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, equipment: '20ft container',
  units: 1, companyName: 'Syngenta', closesAt: Date.now() + 60_000, startsAt: Date.now() - 1000, status: 'live', softClose: false });
const newRequests = () => new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });

(async () => {
  // --- parseBandForm: the untrusted-boundary parser ---
  assert.deepStrictEqual(parseBandForm({ use_override: '1', m_0: '13', m_1: '9', m_2: '7' }),
    { marginsPct: [13, 9, 7], minMarginPct: 7 }, 'valid band parses and derives floor = min bid');
  ok('parseBandForm: valid m_0..m_2 -> [13,9,7], floor = min = 7');

  // Finding 1: a blank/whitespace/non-numeric rung is rejected, NOT coerced to 0
  throwsBad(() => parseBandForm({ use_override: '1', m_0: '13', m_1: '9', m_2: '' }), 'blank "Lowest" rung rejected (no silent 0 floor)');
  throwsBad(() => parseBandForm({ use_override: '1', m_0: '13', m_1: '   ', m_2: '7' }), 'whitespace-only rung rejected');
  throwsBad(() => parseBandForm({ use_override: '1', m_0: 'abc', m_1: '9', m_2: '7' }), 'non-numeric rung rejected');

  // Finding 4: a gap in the rung indices is rejected (would drop a bid + mis-derive the floor)
  throwsBad(() => parseBandForm({ use_override: '1', m_0: '13', m_2: '7' }), 'non-contiguous rungs (m_0 + m_2, no m_1) rejected');
  throwsBad(() => parseBandForm({ use_override: '1' }), 'no rungs at all rejected');

  // TIGHTENED 2026-09-09 (T6). This used to pin the opposite - a deliberately typed 0 was allowed as
  // an explicit operator choice, and the comment invited exactly this change if a literal 0% floor
  // should be forbidden too. It should: the lowest bid IS the floor on this form, so a 0% lowest bid
  // is a bid at exactly the entered cost. 133 loads on the box did that, 13 won at no margin.
  throwsBad(() => parseBandForm({ use_override: '1', m_0: '13', m_1: '9', m_2: '0' }),
    'a deliberately typed 0% lowest bid is now rejected too (it bids the load at cost)');

  // --- validateMargins: the shared shape/range check ---
  assert.doesNotThrow(() => validateMargins([12.6, 7.2, 6.3], 6.3), 'a normal freight band validates');
  ok('validateMargins: normal band [12.6,7.2,6.3] accepted');
  // Finding 3: finite-but-absurd margin capped (would overflow cost x (1+m/100) to Infinity)
  throwsBad(() => validateMargins([1e308, 9, 7], 7), `margin above ${MAX_MARGIN_PCT}% rejected (no Infinity rung)`);
  throwsBad(() => validateMargins([13, 9, 7], 1e308), `minMarginPct above ${MAX_MARGIN_PCT}% rejected`);
  // still catches the classics
  throwsBad(() => validateMargins([13, -1, 7], 6), 'negative margin still rejected');
  throwsBad(() => validateMargins([], 6), 'empty band still rejected');

  // Dashboard 0%-floor trap: a cleared margin/floor field arrives as null over JSON. Reject it
  // (was Number(null) -> silent 0), while a deliberately-typed 0 still passes.
  throwsBad(() => validateMargins([13, null, 7], 6), 'null margin (cleared field) rejected, not coerced to 0');
  throwsBad(() => validateMargins([13, 9, 7], null), 'null floor (cleared field) rejected, not coerced to 0');
  assert.throws(() => validateMargins([13, 9, 7], null), (e) => /^the minimum margin must be a number \(it was left blank\)$/.test(e.message),
    'a blank minimum is named the minimum margin, never a floor');
  throwsBad(() => validateMargins([13, 9, ''], 6), 'blank-string margin rejected');
  assert.throws(() => validateMargins([13, 9, 0], 6), (e) => e.code === 'BAD_INPUT' && /^a bid margin cannot be below the minimum margin \(6%\)$/.test(e.message),
    'a deliberately-typed 0 margin step is refused as below the minimum margin, not as a blank field');
  throwsBad(() => validateMargins([13, 9, 7], 0), 'a 0 floor margin is rejected (it puts the lowest bid at cost)');
  assert.throws(() => validateMargins([13, 9, 7], 0), (e) => /^the minimum margin must be above 0% - /.test(e.message),
    'a 0 minimum is named the minimum margin, never a floor');
  ok('validateMargins: cleared field (null/blank) rejected as blank, a deliberate 0 step refused as below the floor');

  // --- capture(): cost floor ---
  // Finding 2: sub-rupee cost rejected (else Math.round -> 0 -> Rs 0 bid past the floor clamp)
  {
    const requests = newRequests();
    // These fixtures close FAST on purpose (seconds), which is what the engine under test needs.
    // createForLoad would otherwise DERIVE deadlineAt = closesAt - 90s lead, landing it in the past -
    // a request production cannot create (discovery refuses to open one inside the lead) and which
    // capture() now rightly refuses. So hold the pricing window open explicitly: deadlineAt gates
    // capture() alone and never engine timing, so closesAt (and every assertion below) is unchanged.
    const created = await requests.createForLoad(mkLoad('SUBRUPEE'), { deadlineAt: Date.now() + 60_000 });
    await throwsBadAsync(() => requests.capture(created.id, { cost: 0.4 }), 'cost 0.4 rejected (sub-rupee -> would round to a Rs 0 floor)');
  }
  {
    const requests = newRequests();
    const created = await requests.createForLoad(mkLoad('ZERO'), { deadlineAt: Date.now() + 60_000 });
    await throwsBadAsync(() => requests.capture(created.id, { cost: 0 }), 'cost 0 rejected');
  }

  // --- end-to-end: a valid capture protects the margin the floor is meant to guard ---
  {
    const requests = newRequests();
    const created = await requests.createForLoad(mkLoad('OK'), { deadlineAt: Date.now() + 60_000 });
    const override = { ...parseBandForm({ use_override: '1', m_0: '13', m_1: '9', m_2: '7' }), setBy: 'pricing' };
    const capt = await requests.capture(created.id, { cost: 50_000, marginOverride: override });
    const { floor } = buildBandLadder({ cost: capt.price.cost, marginsPct: capt.price.marginsPct, minMarginPct: capt.price.minMarginPct });
    assert.strictEqual(floor, 53_500, 'floor = round(50000 x 1.07) = 53500, not break-even 50000');
    assert.ok(floor > 50_000, 'operating floor is strictly above cost (protected margin intact)');
    ok('end-to-end: cost 50000 + band [13,9,7] -> floor 53500 (margin protected, not zeroed)');
  }

  const total = pass;
  if (process.exitCode) { console.error(`\n${total} checks passed, but at least one FAILED`); process.exit(1); }
  console.log(`\n${total}/${total} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
