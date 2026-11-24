'use strict';
/**
 * BC-35: the GoComet WhatsApp price ask carries the truck's own size.
 *
 * GoComet sends dimensions on `quantity` ("1 x 32FTSXL (LxWXH  32'x8'x8'8\") 9 Ton Truck") and the
 * price page already shows them (#204); the ask (waTemplates.js price_needed) had no field for
 * them at all. Fixed by threading `load.dimensions` (gocometCargo.readLoadSpec) through
 * notifier._priceNeededData onto vehicleWeightCell.
 *
 * This calls the REAL renderMessage('price_needed', d), the same entry point notifier.js uses -
 * not a copy of the template string - so a future edit to the body or to vehicleWeightCell is
 * caught here.
 *
 *   node scripts/test-gocomet-ask-dimensions.js
 */
const assert = require('assert');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const BASE = {
  shipperName: 'Waaree Energies Ltd.', branch: '', name: '2609192Q56', loadCode: '',
  laneFrom: 'Chikhli 396521', laneTo: 'Degam 396530',
  cargo: '1 x 32FTSXL', weight: 9, weightUnit: 'MT',
  closesText: '25-09-2026 03:30 PM (enter cost by 03:28 PM)', link: 'http://x/price/1',
};

(async () => {
  // ---- with dimensions -> appended after weight, GoComet's own punctuation verbatim -----------
  {
    const m = renderMessage('price_needed', { ...BASE, dimensions: `32'x8'x8'8"` });
    ok(/\u{1F69B} 1 x 32FTSXL \. 9 MT \. 32'x8'x8'8"/u.test(m), `dimensions ride the vehicle line after weight (got: ${JSON.stringify(m)})`);
  }

  // ---- without dimensions -> the line renders exactly as it did before this feature ------------
  {
    const withDim = renderMessage('price_needed', { ...BASE, dimensions: '' });
    const noField = renderMessage('price_needed', { ...BASE });
    ok(/\u{1F69B} 1 x 32FTSXL \. 9 MT\n/u.test(withDim), `no size -> vehicle line stays "vehicle . weight" (got: ${JSON.stringify(withDim)})`);
    ok(withDim === noField, 'an empty dimensions field and a wholly absent one render identically');
    ok(!/32'x8'x8'8/.test(withDim), 'no invented size text when the load carries none');
  }

  // ---- a multi-truck-type load never carries dimensions to begin with (readLoadSpec only sets
  // it for a single-descriptor load), so the multi-type branch is untouched by this feature -----
  {
    const m = renderMessage('price_needed', {
      ...BASE, dimensions: '',
      cargoTypes: [{ count: 5, label: '40 ft, 25 T' }, { count: 1, label: '20 ft ODC, 10 T' }],
    });
    ok(/\u{1F69B} 5 x 40 ft, 25 T\n\u{1F69B} 1 x 20 ft ODC, 10 T/u.test(m), `multi-type ask is unaffected (got: ${JSON.stringify(m)})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
