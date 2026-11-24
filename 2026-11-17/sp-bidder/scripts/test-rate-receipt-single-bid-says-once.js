'use strict';
/**
 * C7-single-bid-receipt: A ONE-PRICE PLAN READS AS A RANGE ON THE RATE RECEIPT.
 *
 * The "New Market Rate Submitted" receipt carries one bidding-contract line (waTemplates
 * biddingContract). It always renders "We'll bid from Rs X (+a%), never below Rs Y (+b%)", taking X
 * off the armed ladder's first rung and Y off its last. When the ladder holds a single price - the
 * one bid at a shipper ceiling between the minimum-margin guard and the lowest band price, or a
 * ceiling equal to the lowest band price - X and Y are the same rung, so the desk reads
 * "from 1,05,500 (+5.5%), never below 1,05,500 (+5.5%)": a range that is really one bid.
 *
 * Contract: with a one-price ladder the line names that price once, with its percent once, says it
 * is one bid (contains "once"), and contains neither "never below" nor "from". On a load priced per
 * truck type it states the percent once ("on each rate above") with the same properties.
 *
 * Must NOT move: the three-price ladder's line, byte for byte, and a receipt with no armed ladder,
 * which carries no bidding-contract line at all.
 *
 * Driven through the real Notifier.confirmSubmitted and WhatsApp client, with a mock transport that
 * captures the sent text. Offline and deterministic: memory store, no network, fixed timestamps.
 *
 *   node scripts/test-rate-receipt-single-bid-says-once.js
 */
const assert = require('assert');
const { buildBandLadder, capLadderToCeiling } = require('../src/engine/pricing');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

const BAND = [12.6, 7.2, 6.3];
const FIXED_TS = Date.UTC(2026, 8, 25, 6, 0, 0);

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) }; };
  fn.calls = calls;
  return fn;
}

async function receipt(id, price, ladder) {
  const tr = mockTransport();
  const wa = new WhatsAppClient({ token: 't', productId: 'p', phoneId: '128023', enabled: true, transport: tr });
  const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => [{ name: 'Desk', phone: '+919000000001', alerts: ['price_submitted'] }] });
  await n.confirmSubmitted({ id, loadId: id, price, capturedAt: FIXED_TS, load: {
    lane: { origin: 'Bhiwandi', destination: 'Bawal' }, companyName: 'Shipper', equipment: '32FT', units: 1, quoteType: 'FTL', closesAt: FIXED_TS,
  } }, ladder);
  assert.ok(tr.calls.length >= 1, `setup: ${id} sent no receipt`);
  return tr.calls[tr.calls.length - 1].body.message;
}

// The bidding-contract line is the receipt's only line carrying a "+<n>%" figure.
function percentLines(msg) {
  return String(msg).split('\n').filter((l) => /\+-?\d+(?:\.\d+)?%/.test(l));
}
function contractLine(msg, id) {
  const lines = percentLines(msg);
  assert.strictEqual(lines.length, 1, `setup: ${id} receipt should carry exactly one percent line, got ${lines.length}:\n${msg}`);
  const line = lines[0];
  return { line, pcts: [...line.matchAll(/\+(-?\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1])) };
}
const count = (s, sub) => s.split(sub).length - 1;

let n = 0;
const failures = [];
function check(cond, msg) {
  n++;
  if (cond) console.log(`  ok ${n} - ${msg}`);
  else { console.error(`  FAIL ${n} - ${msg}`); failures.push(n); }
}

function singlePriceChecks(c, priceText, pct, what) {
  check(count(c.line, priceText) === 1, `${what}: price ${priceText} named once (got ${count(c.line, priceText)}): ${c.line.trim()}`);
  check(c.pcts.length === 1 && c.pcts[0] === pct, `${what}: its +${pct}% stated once (got [${c.pcts.join(', ')}])`);
  check(/\bonce\b/i.test(c.line), `${what}: line says it is one bid ("once")`);
  check(!/never below/i.test(c.line), `${what}: no "never below" on a one-price plan`);
  check(!/\bfrom\b/i.test(c.line), `${what}: no "from" on a one-price plan`);
}

(async () => {
  // cost 1,00,000, band [12.6, 7.2, 6.3], minimum 5:
  // guard = max(100000, round(100000 x 1.05)) = 105000; rungs 112600, 107200, 106300.
  const cost = 100000;
  const price = { cost, marginsPct: BAND, minMarginPct: 5 };
  const plan = buildBandLadder({ cost, marginsPct: BAND, minMarginPct: 5 });
  assert.deepStrictEqual(plan.ladder, [112600, 107200, 106300], 'setup: band ladder is the three band rungs');

  // A. ceiling 1,05,500 between the guard (1,05,000) and the lowest band price (1,06,300):
  //    one bid at 105500; 105500 / 100000 - 1 = 5.5%.
  const atCeiling = capLadderToCeiling(plan.ladder, 105500);
  assert.deepStrictEqual(atCeiling, [105500], 'setup: ceiling 1,05,500 leaves one price');
  singlePriceChecks(contractLine(await receipt('C7-A', price, atCeiling), 'C7-A'), '1,05,500', 5.5, 'ceiling one-bid');

  // B. ceiling equal to the lowest band price: every rung collapses to 106300, the 6.3% anchor.
  const atLowest = capLadderToCeiling(plan.ladder, 106300);
  assert.deepStrictEqual(atLowest, [106300], 'setup: ceiling 1,06,300 leaves one price');
  singlePriceChecks(contractLine(await receipt('C7-B', price, atLowest), 'C7-B'), '1,06,300', 6.3, 'ceiling at lowest');

  // C. per-truck-type load: 5 x 1,00,000 + 1 x 40,000 -> blended (500000 + 40000) / 6 = 90000.
  //    one rung 94950 = 90000 x 1.055, so the per-line margin is 94950 / 90000 - 1 = 5.5%.
  const types = [{ label: '40 ft', count: 5, cost: 100000 }, { label: '20 ft ODC', count: 1, cost: 40000 }];
  const c = contractLine(await receipt('C7-C', { cost: 90000, marginsPct: BAND, minMarginPct: 5, costByType: { types } }, [94950]), 'C7-C');
  check(c.pcts.length === 1 && c.pcts[0] === 5.5, `per-type one-bid: +5.5% stated once (got [${c.pcts.join(', ')}]): ${c.line.trim()}`);
  check(/\bonce\b/i.test(c.line), 'per-type one-bid: line says it is one bid ("once")');
  check(!/never below/i.test(c.line), 'per-type one-bid: no "never below"');
  check(!/\bfrom\b/i.test(c.line), 'per-type one-bid: no "from"');

  // Controls.
  const three = contractLine(await receipt('C7-D', price, plan.ladder), 'C7-D');
  const expected = "📈 *We'll bid from* - ₹1,12,600 (+12.6%), never below ₹1,06,300 (+6.3%)";
  check(three.line === expected, `three-price ladder line unchanged byte for byte (got ${three.line})`);

  const none = await receipt('C7-E', price, null);
  check(percentLines(none).length === 0 && !/We'll bid/.test(none), 'no armed ladder -> no bidding-contract line');

  if (failures.length) {
    console.error(`FAIL - checks ${failures.join(', ')} of ${n}: a one-price ladder is rendered as a from/never-below range naming the same price twice`);
    process.exit(1);
  }
  console.log(`PASS - ${n} checks: a one-price plan reads as one bid, the range line is unchanged`);
})().catch((e) => { console.error('FAIL - harness error:', e && e.stack || e); process.exit(1); });
