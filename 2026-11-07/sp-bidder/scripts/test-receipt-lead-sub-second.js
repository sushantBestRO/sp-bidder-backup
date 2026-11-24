'use strict';
/**
 * T6 D7: a bid that landed in the final half-second never reads "0s before close".
 *
 * leadPhrase guarded its INPUT (a lead <= 0 renders nothing) but rounded at the OUTPUT, so every
 * lead in [1, 500) ms printed "0s before close" - the string its own comment says it must not print.
 * The engine aims into that band by design (hot poll 200 ms, minimum lead 400 ms), and the line is
 * the desk's only "did the snipe fire" signal on the won receipt and the short loss reply.
 *
 *   node scripts/test-receipt-lead-sub-second.js
 */
const { closeTimeCell, renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const cell = (ms) => closeTimeCell({ closeTime: '25/09/2026 18:00', lastBidTime: '05:59 pm', lastBidLeadMs: ms });

console.log('\n1. the won receipt cell');
for (const ms of [1, 200, 400, 499]) {
  const c = cell(ms);
  ok(!/\b0s before close/.test(c) && c.includes('(under 1s before close)'),
    `lead ${ms} ms reads "under 1s before close" (got ${JSON.stringify(c.split('\n')[1])})`);
}
ok(cell(500).includes('(1s before close)'), 'lead 500 ms still rounds to "1s before close"');
ok(cell(58_000).includes('(58s before close)') && cell(240_000).includes('(4 min before close)'),
  'seconds and minutes above one second are unchanged');
ok(!/before close/.test(cell(0)) && !/before close/.test(cell(-300)),
  'a lead at or past the close still renders no lead at all');

console.log('\n2. the short loss reply');
{
  const d = { oaNo: '23501122', shipperName: 'Havells', origin: 'Bhiwandi', dest: 'Chennai', finalRank: 2,
    landedBids: 1, lastBidTime: '05:59 pm', lastBidLeadMs: 300 };
  const body = renderMessage(templateFor('lost', d, { short: true }), d);
  ok(body.includes('⏱ *Last bid* - 05:59 pm, under 1s before close') && !/\b0s before close/.test(body),
    `a 300 ms lead on the short reply reads "under 1s before close" (got ${JSON.stringify((body.match(/⏱.*/) || [''])[0])})`);
}

const EXPECTED_CHECKS = 8;
console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_CHECKS) {
  console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
