'use strict';

/**
 * Shared margin-band validator - the single source of truth for "is this a valid
 * bid band". Used by the admin config (configStore), the per-customer margin
 * profiles, and the per-load bid override, so all three reject the same bad input
 * (empty band, NaN/negative margin, bad floor) identically.
 *
 * Throws an Error with code 'BAD_INPUT' on any violation; on success returns the
 * numeric-coerced { marginsPct, minMarginPct }. Beyond shape it refuses a band margin
 * below minMarginPct, unless the band is `stored` unchanged. The price guard itself
 * (never below cost x (1 + minMarginPct)) is enforced in buildBandLadder / assertAboveFloor.
 */
// A ceiling well above any real freight margin (those are single/double-digit %). Its job is
// not business policy - it stops a finite-but-absurd value (a fat-fingered 1e308) from
// overflowing cost x (1 + m/100) to Infinity and riding into the ladder / engine.arm.
const MAX_MARGIN_PCT = 1000;

// A cleared dashboard field arrives as null over JSON; Number(null) would coerce it to a silent 0%
// floor. Reject a non-number up front so a blank reads as a blank rather than as a deliberate zero -
// the two are refused separately below and the operator needs to know which one they typed.
const isRealNumber = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

const sameBand = (mp, mm, stored) => !!stored && Array.isArray(stored.marginsPct)
  && Number(stored.minMarginPct) === mm
  && stored.marginsPct.length === mp.length
  && stored.marginsPct.every((v, i) => isRealNumber(v) && Number(v) === mp[i]);

function validateMargins(marginsPct, minMarginPct, stored = null) {
  const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_INPUT'; throw e; };
  if (!Array.isArray(marginsPct) || marginsPct.length === 0) bad('marginsPct must be a non-empty list');
  if (marginsPct.some((v) => !isRealNumber(v))) bad('every margin must be a number (one was left blank)');
  const mp = marginsPct.map(Number);
  if (mp.some((n) => !(n >= 0))) bad('every margin must be a number >= 0');
  if (mp.some((n) => n > MAX_MARGIN_PCT)) bad(`every margin must be <= ${MAX_MARGIN_PCT}%`);
  if (!isRealNumber(minMarginPct)) bad('the minimum margin must be a number (it was left blank)');
  const mm = Number(minMarginPct);
  if (!(mm >= 0)) bad('minMarginPct must be a number >= 0');
  // buildBandLadder derives the operating floor as max(cost, cost x (1 + minMarginPct/100)), so a
  // floor margin of 0 makes the floor EXACTLY the cost and the ladder spends down to a bid at cost.
  // 133 loads on the box carried a 0 and all 133 had floor === cost; 13 of them won, moving
  // Rs 5,59,500 of freight at no margin. Both sources were a stored value nobody remembered setting
  // (audit .build/cache/audit/2026-09-09_sheet-issues-rootcause-map.md, T6).
  if (mm === 0) bad('the minimum margin must be above 0% - at 0% the lowest bid is exactly the cost, so the load would be bid at no margin');
  if (mm > MAX_MARGIN_PCT) bad(`minMarginPct must be <= ${MAX_MARGIN_PCT}%`);
  if (mp.some((n) => n < mm) && !sameBand(mp, mm, stored)) {
    bad(`a bid margin cannot be below the minimum margin (${mm}%)`);
  }
  return { marginsPct: mp, minMarginPct: mm };
}

/**
 * Parse the /price capture page's inline band editor out of an Express form body:
 * use_override=1 plus one margin % per bid, posted as m_0..m_n. This is UNTRUSTED input
 * (a curl/fetch bypasses every inline control), so it rejects a blank or non-numeric field
 * rather than letting Number('') coerce it to 0 - a silent 0 would become the smallest bid
 * and collapse the derived floor to break-even cost. It also requires the rung indices to be
 * contiguous 0..n so a malformed body can't drop a middle bid and mis-derive the floor.
 * There is no separate minimum field: the lowest bid is the band's own minimum here, and the /price
 * routes lower it to the customer's minimum where that is lower (withCustomerMinimum).
 * Returns { marginsPct, minMarginPct }; range/shape is then re-checked by validateMargins.
 */
function parseBandForm(body) {
  const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_INPUT'; throw e; };
  const idxs = Object.keys(body || {})
    .filter((k) => /^m_\d+$/.test(k))
    .map((k) => Number(k.slice(2)))
    .sort((a, b) => a - b);
  if (!idxs.length) bad('at least one bid margin is required');
  idxs.forEach((n, i) => { if (n !== i) bad('bid margins must be a contiguous list (a rung is missing)'); });
  const marginsPct = idxs.map((i) => {
    const raw = String(body[`m_${i}`]).trim();
    if (raw === '' || !Number.isFinite(Number(raw))) bad('each bid needs a margin % - one was blank or not a number');
    const n = Number(raw);
    if (n < 0) bad('every bid needs a margin above 0% - a margin below 0% bids under the cost you entered');
    if (n > MAX_MARGIN_PCT) bad(`each margin must be ${MAX_MARGIN_PCT}% or less - check for an extra digit`);
    return n;
  });
  const minMarginPct = Math.min.apply(null, marginsPct);
  // The lowest bid IS this load's floor, so a 0% lowest bid is a bid at exactly the cost the desk
  // typed. Refused here rather than left to validateMargins downstream so the /price editor rejects
  // it in the desk's own words at the point of entry.
  if (minMarginPct === 0) bad('every bid needs a margin above 0% - a 0% bid is exactly the cost you entered, so this load would go in at no profit');
  return { marginsPct, minMarginPct };
}

module.exports = { validateMargins, parseBandForm, MAX_MARGIN_PCT };
