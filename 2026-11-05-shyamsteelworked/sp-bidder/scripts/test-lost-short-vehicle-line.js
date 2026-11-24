'use strict';
/**
 * The lost_short receipt's vehicle line cannot vanish on a vehicle-less payload.
 *
 * outcomeVehicleCell falls back to vehicleWeightCell's own '-' default, and the truck glyph plus
 * its leading newline are hardcoded in the lost_short template body OUTSIDE the {{3}} placeholder
 * - unlike oaLine / yourRateLine, which own their glyph and newline and can vanish entirely. So a
 * payload with no vehicle (the rate-model / mock outcome shape, e.g. this file's own `bare`
 * fixture below) renders a dangling truck-glyph line with nothing after it, on the one receipt
 * the diff this review covered was written to clean up.
 *
 * WHAT MUST NOT MOVE: a payload that DOES carry a vehicle must render the exact same line, in the
 * exact same position, as before the fix - moving the glyph inside the cell function must not
 * change a single byte of the populated case (control).
 *
 *   node scripts/test-lost-short-vehicle-line.js
 */
const assert = require('assert');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const VEHICLE_GLYPH = '\u{1F69B}';
const shortLoss = (d) => renderMessage(templateFor('lost', d, { short: true }), d);

// The exact shape from the finding: a rate-model / mock outcome with landedBids set (so this
// routes to 'lost_short', not 'no_bid_short') but no vehicleType at all.
const bare = { shipper: 'Waaree Energies Ltd.', finalRank: 4, marginRate: '61,000', landedBids: 1 };

// The same payload, but WITH a vehicle - the populated case that must render unchanged.
const withVehicle = Object.assign({}, bare, { vehicleType: '1 x 32FT', weight: 18, weightUnit: 'MT' });

const bareMsg = shortLoss(bare);
const populatedMsg = shortLoss(withVehicle);

// THE MECHANISM: outcomeVehicleCell's placeholder falling back to vehicleWeightCell's own '-'
// renders exactly this dangling line - the glyph followed by nothing but the fallback dash.
const bareLines = bareMsg.split('\n').map((l) => l.trim());
ok(!bareLines.includes(`${VEHICLE_GLYPH} -`), `no dangling "${VEHICLE_GLYPH} -" line on a vehicle-less receipt:\n${bareMsg}`);
ok(!bareMsg.includes(VEHICLE_GLYPH), `the truck glyph does not appear at all when there is no vehicle to report:\n${bareMsg}`);

// CONTROL - a payload with a vehicle still renders exactly the line the desk has always seen:
// glyph, space, "<vehicle> . <weight> <unit>", on its own line.
const expectedLine = `${VEHICLE_GLYPH} 1 x 32FT . 18 MT`;
ok(populatedMsg.split('\n').some((l) => l.trim() === expectedLine),
  `a populated payload still renders the vehicle line unchanged: "${expectedLine}"\n${populatedMsg}`);

// CONTROL - the rest of the receipt is untouched: the header and ranking lines still render for
// the vehicle-less payload, so this fix touches only the one line.
ok(bareMsg.startsWith('🔴 *LOST - Waaree Energies Ltd.*'), 'the header still renders on a vehicle-less receipt (control)');
ok(/Our Final Ranking. - 4/.test(bareMsg), 'the ranking line still renders on a vehicle-less receipt (control)');

console.log(`\nlost-short-vehicle-line: ${pass} passed, ${fail} failed`);
assert.ok(pass > 0, 'the suite must assert something');
process.exit(fail ? 1 : 0);
