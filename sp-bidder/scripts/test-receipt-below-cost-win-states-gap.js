'use strict';
/**
 * T6 D4: a win below the desk's rate is never told to "place at a lower rate", and the rupee gap
 * the enrichment computed is always the line it gets instead.
 *
 * outcomeEnrichment renders marginPct with toFixed(2), so a shortfall of a few rupees on a large
 * cost is the STRING "-0.00". wonWarning tested Number(marginPct) < 0, which is false for -0, so the
 * receipt fell through to "Margin low - only -0.00%. Squeeze the vendor and place at a lower rate"
 * on a closed auction, while belowRateBy sat on the payload unrendered.
 *
 *   node scripts/test-receipt-below-cost-win-states-gap.js
 */
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

const won = (cost, price, extra) => {
  const rec = Object.assign({ auctionId: '23501122', won: true, cost, lastBidPrice: price,
    ourBids: [{ price }], lane: { origin: 'Bhiwandi', destination: 'Chennai' },
    equipment: '32ft SXL', units: 1, finalRank: 1 }, extra || {});
  const d = Object.assign({ shipperName: 'Havells', branch: 'Chikhli', oaNo: rec.auctionId }, outcomeEnrichment(rec));
  return { d, body: renderMessage(templateFor('won', d), d) };
};

console.log('\n1. Rs 1 under a Rs 3,00,000 rate (margin renders as "-0.00")');
{
  const { d, body } = won(300_000, 299_999);
  console.log(`  marginPct ${JSON.stringify(d.marginPct)}, belowRateBy ${JSON.stringify(d.belowRateBy)}`);
  ok(d.marginPct === '-0.00' && d.belowRateBy === '1', 'fixture: the -0.00 band with a Rs 1 gap on the payload');
  ok(!/place at a lower rate/.test(body) && !/Margin low/.test(body),
    'no instruction to bid lower on an auction that has closed');
  ok(body.includes('This load stands ₹1 below your rate of ₹3,00,000.'),
    'the rupee gap is stated instead');
}

console.log('\n2. a plainly negative margin keeps the same line');
{
  const { body } = won(120_000, 110_000);
  ok(body.includes('This load stands ₹10,000 below your rate of ₹1,20,000.') && !/place at a lower rate/.test(body),
    'Rs 10,000 under: the gap line, no bid-lower advice');
}

console.log('\n3. wins at or above the rate are unchanged');
{
  const thin = won(100_000, 103_000, { marginsPct: [12, 8, 5], minMarginPct: 2 });
  ok(/Margin low - only 3\.00%/.test(thin.body) && !/below your rate/.test(thin.body),
    'a +3.00% win under a 5% lowest band margin keeps its thin-margin note');
  const healthy = won(100_000, 109_000, { marginsPct: [12, 8, 5], minMarginPct: 2 });
  ok(!/Margin low/.test(healthy.body) && !/below your rate/.test(healthy.body),
    'a +9.00% win says nothing');
}

const EXPECTED_CHECKS = 6;
console.log(`\n${pass} passed, ${fail} failed`);
if (pass + fail !== EXPECTED_CHECKS) {
  console.error(`FAIL - expected ${EXPECTED_CHECKS} checks to run, got ${pass + fail}`);
  process.exit(1);
}
process.exit(fail ? 1 : 0);
