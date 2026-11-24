'use strict';
/**
 * RES-receipt-floor-percent: THE RATE RECEIPT PAIRS THE LOWEST BAND PRICE WITH THE MINIMUM'S PERCENT.
 *
 * The "New Market Rate Submitted" receipt carries one bidding-contract line: the opening price and
 * the lowest price the bot will bid, each with its margin over the entered cost. notifier
 * confirmSubmitted takes both PRICES off the armed ladder but takes the lowest PERCENT off
 * price.minMarginPct. Since the minimum became a guard that is never bid, the ladder's last rung is
 * the lowest BAND price, so on a 1,00,000 cost with band [12.6, 7.2, 6.3] and minimum 5 the line
 * reads "1,06,300 (+5%)" - a price and a percent that do not belong together. On a ceiling-capped
 * one-rung ladder [1,05,500] it reads +12.6% and +5% beside a price that carries 5.5%.
 *
 * Contract: each percent on the line is the margin its own price carries over the entered cost. A
 * price equal to a band anchor's own price (round(cost x (1 + p/100))) shows that anchor's percent
 * unrounded (12.6 stays 12.6); any other price shows (price / cost - 1) x 100.
 *
 * Must NOT move: the opening percent on an uncapped ladder, a band with no gap between its lowest
 * margin and the minimum, and the per-truck-type receipt, which already derives its percents from
 * the rungs and carries no rupee anchors.
 *
 * Driven through the real Notifier.confirmSubmitted and WhatsApp client, with a mock transport that
 * captures the sent text. Offline and deterministic: memory store, no network, fixed timestamps.
 *
 *   node scripts/test-rate-receipt-lowest-percent-matches-price.js
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

// The bidding-contract line is the one line of the receipt carrying "+<n>%" figures. Returned with
// its percents in reading order (opening first, lowest second), so the check is on figures, not copy.
function contractLine(msg, id, percents = 2) {
  const lines = String(msg).split('\n').filter((l) => /\+-?\d+(?:\.\d+)?%/.test(l));
  assert.strictEqual(lines.length, 1, `setup: ${id} receipt should carry exactly one percent line, got ${lines.length}:\n${msg}`);
  const pcts = [...lines[0].matchAll(/\+(-?\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  assert.strictEqual(pcts.length, percents, `setup: ${id} percent line should carry ${percents} percent(s): ${lines[0]}`);
  return { line: lines[0], opening: pcts[0], lowest: pcts[pcts.length - 1] };
}

let n = 0;
const failures = [];
function check(cond, msg) {
  n++;
  if (cond) console.log(`  ok ${n} - ${msg}`);
  else { console.error(`  FAIL ${n} - ${msg}`); failures.push(n); }
}

(async () => {
  // A. cost 1,00,000, band [12.6, 7.2, 6.3], minimum 5.
  //    guard = max(100000, round(100000 x 1.05)) = 105000; rungs 112600, 107200, 106300 (all >= guard).
  const plan = buildBandLadder({ cost: 100000, marginsPct: BAND, minMarginPct: 5 });
  assert.deepStrictEqual(plan.ladder, [112600, 107200, 106300], 'setup: band ladder is the three band rungs');
  const a = contractLine(await receipt('RES-A', { cost: 100000, marginsPct: BAND, minMarginPct: 5 }, plan.ladder), 'RES-A');
  assert.ok(a.line.includes('1,12,600') && a.line.includes('1,06,300'), `setup: RES-A line names both prices: ${a.line}`);
  check(a.opening === 12.6, `opening price 1,12,600 shows +12.6% (got +${a.opening}%)`);
  check(a.lowest === 6.3,
    `lowest price 1,06,300 shows its own +6.3%, not the minimum's percent (got +${a.lowest}%): receipt pairs the lowest band price with minMarginPct`);

  // B. no gap: the same band with minimum 6.3 - the lowest price already carries the minimum.
  const b = contractLine(await receipt('RES-B', { cost: 100000, marginsPct: BAND, minMarginPct: 6.3 }, plan.ladder), 'RES-B');
  check(b.opening === 12.6 && b.lowest === 6.3, `no-gap band reads +12.6% / +6.3% (got +${b.opening}% / +${b.lowest}%)`);

  // C. ceiling-capped one-rung ladder: every rung above 105500 collapses to 105500.
  //    105500 / 100000 - 1 = 0.055 -> the one price reads +5.5% (a one-price line names it once).
  const capped = capLadderToCeiling(plan.ladder, 105500);
  assert.deepStrictEqual(capped, [105500], 'setup: ceiling 1,05,500 caps the ladder to one rung');
  const c = contractLine(await receipt('RES-C', { cost: 100000, marginsPct: BAND, minMarginPct: 5 }, capped), 'RES-C', 1);
  check(c.opening === 5.5, `capped opening price 1,05,500 shows +5.5%, not the band's +12.6% (got +${c.opening}%)`);
  check(c.lowest === 5.5, `capped lowest price 1,05,500 shows +5.5%, not the minimum's +5% (got +${c.lowest}%)`);

  // D. a small cost where rounding moves the derived percent, so the anchor's own percent must win.
  //    cost 5100: 12.6% -> round(5742.6) = 5743 (derived 12.61); 7.2% -> round(5467.2) = 5467;
  //    6.3% -> round(5421.3) = 5421 (derived 6.29); guard max(5100, round(5355)) = 5355.
  const small = buildBandLadder({ cost: 5100, marginsPct: BAND, minMarginPct: 5 });
  assert.deepStrictEqual(small.ladder, [5743, 5467, 5421], 'setup: small-cost ladder');
  const d = contractLine(await receipt('RES-D', { cost: 5100, marginsPct: BAND, minMarginPct: 5 }, small.ladder), 'RES-D');
  check(d.opening === 12.6, `opening 5,743 equals the 12.6% anchor price and shows +12.6%, not a derived 12.61 (got +${d.opening}%)`);
  check(d.lowest === 6.3, `lowest 5,421 equals the 6.3% anchor price and shows +6.3%, neither the minimum's 5 nor a derived 6.29 (got +${d.lowest}%)`);

  // E. per-truck-type load: 5 x 1,00,000 + 1 x 40,000 -> blended (500000 + 40000) / 6 = 90000.
  //    rungs round(90000 x 1.126) = 101340, 96480, 95670; 101340 / 90000 = 1.126, 95670 / 90000 = 1.063.
  const perType = buildBandLadder({ cost: 90000, marginsPct: BAND, minMarginPct: 5 });
  assert.deepStrictEqual(perType.ladder, [101340, 96480, 95670], 'setup: per-type blended ladder');
  const types = [{ label: '40 ft', count: 5, cost: 100000 }, { label: '20 ft ODC', count: 1, cost: 40000 }];
  const e = contractLine(await receipt('RES-E', { cost: 90000, marginsPct: BAND, minMarginPct: 5, costByType: { types } }, perType.ladder), 'RES-E');
  check(e.opening === 12.6 && e.lowest === 6.3 && !e.line.includes('1,01,340') && !e.line.includes('95,670'),
    `per-type receipt keeps its per-type line: +12.6% / +6.3% with no rupee anchors (got ${e.line.trim()})`);

  if (failures.length) {
    console.error(`FAIL - checks ${failures.join(', ')} of ${n}: the rate receipt's percents do not match the prices they sit beside (lowest percent read off minMarginPct, opening off the band top)`);
    process.exit(1);
  }
  console.log(`PASS - ${n} checks: each receipt percent is the margin its own price carries`);
})().catch((e) => { console.error('FAIL - harness error:', e && e.stack || e); process.exit(1); });
