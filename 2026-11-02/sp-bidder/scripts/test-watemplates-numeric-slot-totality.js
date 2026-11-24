'use strict';
/**
 * H2 - four numeric render slots in src/notify/waTemplates.js are non-total on a non-finite
 * input (NaN / Infinity), each rendering the token itself into a customer/ops-visible message
 * instead of a neutral fallback:
 *   1. fmtNum        - guard is `n == null`; NaN/Infinity pass Number.isFinite-free through
 *                       Number(n).toLocaleString('en-IN') as the literal string "NaN" / "∞".
 *   2. fmtPct         - the finite check exists but its else-branch is `return String(p)`, so
 *                       NaN specifically renders as the literal "NaN" - the exact token its own
 *                       docstring says the guard prevents.
 *   3. rank/finalRank slots (won/lost/lost_short/outbid) - `!= null` guards with no finiteness
 *      check, so NaN/Infinity survive to the WhatsApp body.
 *   4. account_auth_restored's downForMs slot - `Math.max(1, Math.round((d.downForMs || 0) / 60000))`;
 *      `|| 0` only catches falsy values, so 'abc' or Infinity produce NaN and break the
 *      documented "floored at 1" promise.
 * None of these are reachable from a real portal payload today (JSON cannot carry NaN/Infinity
 * and every producer already filters to finite) - this is a hardening pin on the shared render
 * sinks, not a reproduction of an observed bad message.
 *
 * What must not move: a normal, fully-numeric payload renders BYTE-IDENTICALLY to today
 * (the CONTROL check in each group).
 *
 *   node scripts/test-watemplates-numeric-slot-totality.js
 */
const assert = require('assert');
const { renderMessage, fmtNum } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const noBadToken = (s) => !/\bNaN\b|Infinity|∞/.test(s);

const LANE_D = { lane: 'Bhiwandi -> Alwar', shipper: 'Havells' };
const WON_D = { vehicleType: '32ft', finalRank: 1 };
const LOST_D = { oaNo: 'OA1', vehicleType: '32ft', finalRank: 3 };

try {

// ---- 1. fmtNum: cost/price slots on the bid_live sink ----
{
  const control = renderMessage('bid_live', { ...LANE_D, price: 103600, cost: 100000, openingPct: 12.6 });
  assert.ok(control.includes('First bid ₹1,03,600 - your rate ₹1,00,000'),
    '1 CONTROL: bid_live with valid numbers renders the money line unchanged');
  ok('fmtNum CONTROL: a valid price/cost pair renders exactly as today');

  const nanPrice = renderMessage('bid_live', { ...LANE_D, price: NaN, cost: 100000, openingPct: 12.6 });
  assert.ok(noBadToken(nanPrice), '1a: fmtNum(NaN) must not put "NaN" into the bid_live body - got: ' + nanPrice);
  ok('fmtNum: a NaN price does not render "NaN" into the live-bid alert');

  const infCost = renderMessage('bid_live', { ...LANE_D, price: 103600, cost: Infinity, openingPct: 12.6 });
  assert.ok(noBadToken(infCost), '1b: fmtNum(Infinity) must not put "Infinity"/the glyph into the bid_live body - got: ' + infCost);
  ok('fmtNum: an Infinity cost does not render "Infinity"/the glyph into the live-bid alert');

  assert.strictEqual(fmtNum(100000), '1,00,000', '1 CONTROL (direct): fmtNum keeps its normal Indian-grouped output');
  ok('fmtNum CONTROL (direct call): a plain finite number is unaffected');
}

// ---- 2. fmtPct: openingPct slot on the same bid_live sink ----
{
  const control = renderMessage('bid_live', { ...LANE_D, price: 103600, cost: 100000, openingPct: 12.6 });
  assert.ok(control.endsWith('+ 12.6%.'), '2 CONTROL: a valid openingPct still renders "+ 12.6%."');
  ok('fmtPct CONTROL: a valid opening margin renders exactly as today');

  const nanPct = renderMessage('bid_live', { ...LANE_D, price: 103600, cost: 100000, openingPct: NaN });
  assert.ok(noBadToken(nanPct), '2a: fmtPct(NaN) must not put "NaN" into the bid_live body - got: ' + nanPct);
  ok('fmtPct: a NaN opening margin does not render "NaN" into the live-bid alert');

  const infPct = renderMessage('bid_live', { ...LANE_D, price: 103600, cost: 100000, openingPct: Infinity });
  assert.ok(noBadToken(infPct), '2b: fmtPct(Infinity) must not put "Infinity" into the bid_live body - got: ' + infPct);
  ok('fmtPct: an Infinity opening margin does not render "Infinity" into the live-bid alert');
}

// ---- 3. rank / finalRank slots: won, lost, lost_short, outbid ----
{
  const wonControl = renderMessage('won', WON_D);
  assert.ok(wonControl.includes('Our Final Ranking* - 1.'), '3 CONTROL (won): a valid finalRank still renders "- 1."');
  ok('won CONTROL: a valid finalRank renders exactly as today');
  assert.ok(noBadToken(renderMessage('won', { ...WON_D, finalRank: NaN })), '3a: won NaN finalRank must not render "NaN"');
  ok('won: a NaN finalRank does not render "NaN" into the win receipt');
  assert.ok(noBadToken(renderMessage('won', { ...WON_D, finalRank: Infinity })), '3b: won Infinity finalRank must not render "Infinity"');
  ok('won: an Infinity finalRank does not render "Infinity" into the win receipt');

  const lostControl = renderMessage('lost', LOST_D);
  assert.ok(lostControl.includes('Our Final Ranking* - 3'), '3 CONTROL (lost): a valid finalRank still renders "- 3"');
  ok('lost CONTROL: a valid finalRank renders exactly as today');
  assert.ok(noBadToken(renderMessage('lost', { ...LOST_D, finalRank: NaN })), '3c: lost NaN finalRank must not render "NaN"');
  ok('lost: a NaN finalRank does not render "NaN" into the loss receipt');
  assert.ok(noBadToken(renderMessage('lost', { ...LOST_D, finalRank: Infinity })), '3d: lost Infinity finalRank must not render "Infinity"');
  ok('lost: an Infinity finalRank does not render "Infinity" into the loss receipt');

  const shortControl = renderMessage('lost_short', { ...LOST_D, finalRank: 3 });
  assert.ok(shortControl.includes('Our Final Ranking* - 3'), '3 CONTROL (lost_short): a valid finalRank still renders "- 3"');
  ok('lost_short CONTROL: a valid finalRank renders exactly as today');
  assert.ok(noBadToken(renderMessage('lost_short', { ...LOST_D, finalRank: NaN })), '3e: lost_short NaN finalRank must not render "NaN"');
  ok('lost_short: a NaN finalRank does not render "NaN" into the short loss reply');
  assert.ok(noBadToken(renderMessage('lost_short', { ...LOST_D, finalRank: Infinity })), '3f: lost_short Infinity finalRank must not render "Infinity"');
  ok('lost_short: an Infinity finalRank does not render "Infinity" into the short loss reply');

  const outbidControl = renderMessage('outbid', { ...LANE_D, rank: 2 });
  assert.ok(outbidControl.includes('now rank 2.'), '3 CONTROL (outbid): a valid rank still renders "now rank 2."');
  ok('outbid CONTROL: a valid rank renders exactly as today');
  assert.ok(noBadToken(renderMessage('outbid', { ...LANE_D, rank: NaN })), '3g: outbid NaN rank must not render "NaN"');
  ok('outbid: a NaN rank does not render "NaN" into the outbid alert');
  assert.ok(noBadToken(renderMessage('outbid', { ...LANE_D, rank: Infinity })), '3h: outbid Infinity rank must not render "Infinity"');
  ok('outbid: an Infinity rank does not render "Infinity" into the outbid alert');
}

// ---- 4. account_auth_restored's downForMs slot: the floored-at-1 promise ----
{
  const control = renderMessage('account_auth_restored', { accountLabel: 'Branch A', downForMs: 125000 });
  assert.ok(control.includes('Down about 2 min.'), '4 CONTROL: 125000ms still rounds to "Down about 2 min."');
  ok('downForMs CONTROL: a normal duration renders exactly as today');

  const stringInput = renderMessage('account_auth_restored', { accountLabel: 'Branch A', downForMs: 'abc' });
  assert.ok(noBadToken(stringInput), '4a: downForMs="abc" must not render "NaN" - got: ' + stringInput);
  assert.ok(stringInput.includes('Down about 1 min.'), '4a: downForMs="abc" must still keep the floored-at-1 promise - got: ' + stringInput);
  ok('downForMs: a non-numeric string floors to 1 minute instead of rendering "NaN"');

  const infInput = renderMessage('account_auth_restored', { accountLabel: 'Branch A', downForMs: Infinity });
  assert.ok(noBadToken(infInput), '4b: downForMs=Infinity must not render "Infinity" - got: ' + infInput);
  assert.ok(infInput.includes('Down about 1 min.'), '4b: downForMs=Infinity must still keep the floored-at-1 promise - got: ' + infInput);
  ok('downForMs: an Infinity duration floors to 1 minute instead of rendering "Infinity"');
}

console.log(`\n${pass} passed`);
process.exit(0);

} catch (e) {
  console.error(`\nFAILED after ${pass} passed:`, (e && e.message) || e);
  process.exit(1);
}
