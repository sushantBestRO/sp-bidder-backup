'use strict';
/**
 * Two-floor operating-margin test (Task 3). The bot must never bid below the
 * OPERATING floor = cost x (1 + minMarginPct). minMarginPct is an explicit,
 * deliberate param (>= the asset's opportunity cost), not the band's lowest rung by
 * accident. Omitting it stays backward-compatible (defaults to the band's lowest %).
 */
const assert = require('assert');
const { buildBandLadder, assertAboveFloor } = require('../src/engine/pricing');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// A) backward-compatible: no minMarginPct -> floor = band's lowest rung
{
  const p = buildBandLadder({ cost: 100000, marginsPct: [12.6, 7.2, 6.3] });
  ok(p.floor === 106300, `default floor = cost*(1+6.3%) = 106300, got ${p.floor}`);
  ok(p.trueCost === 100000, `trueCost surfaced (100000), got ${p.trueCost}`);
  ok(p.minMarginPct === 6.3, `default minMarginPct = band lowest 6.3, got ${p.minMarginPct}`);
  ok(JSON.stringify(p.ladder) === JSON.stringify([112600, 107200, 106300]), `unchanged ladder, got ${JSON.stringify(p.ladder)}`);
}

// B) explicit minMarginPct HIGHER than the band's lowest -> operating floor lifts; sub-floor rungs clamped away
{
  const p = buildBandLadder({ cost: 100000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 8 });
  ok(p.floor === 108000, `operating floor = cost*(1+8%) = 108000, got ${p.floor}`);
  ok(p.ladder.every((x) => x >= 108000), `no rung below the operating floor, got ${JSON.stringify(p.ladder)}`);
  ok(JSON.stringify(p.ladder) === JSON.stringify([112600, 108000]), `clamped ladder [112600,108000], got ${JSON.stringify(p.ladder)}`);
}

// C) explicit minMarginPct LOWER than the band's lowest -> the min only guards; the band bottom is the floor and last rung
{
  const p = buildBandLadder({ cost: 100000, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 5 });
  ok(JSON.stringify(p.ladder) === JSON.stringify([112600, 107200, 106300]), `band ladder, no guard rung, got ${JSON.stringify(p.ladder)}`);
  ok(p.floor === 106300, `floor = the band bottom 106300, got ${p.floor}`);
  ok(p.ladder[p.ladder.length - 1] === 106300, `floor is the last rung (106300), got ${p.ladder[p.ladder.length - 1]}`);
}

// D) the hard invariant: a sub-floor price can never be built
{
  let threw = false;
  try { assertAboveFloor(107999, 108000); } catch (e) { threw = e.code === 'FLOOR'; }
  ok(threw, 'assertAboveFloor rejects a price below the operating floor');
  let okAt = true;
  try { assertAboveFloor(108000, 108000); } catch (_) { okAt = false; }
  ok(okAt, 'assertAboveFloor allows a price exactly at the operating floor');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
