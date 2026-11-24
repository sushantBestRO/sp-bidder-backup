'use strict';
/**
 * Per-tonne (PMT) loads say "per tonne" on the WhatsApp price ask and receipts, so the desk enters
 * a rate PER METRIC TONNE and never a whole-load figure in that field (the Vishal Pipes desk-unit
 * defect: docs/diagnoses/2026-09-28_pmt-never-bid.md). Gated strictly on discovery.isPmtBasis
 * (quoteType PMT), never on weightUnit - a KG-weighed FLAT load must render exactly as before.
 *
 *   node scripts/test-pmt-ask-copy.js
 */
const assert = require('assert');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };
const now = Date.now();

function load(id, over) {
  return Object.assign({
    id, lane: { origin: 'Sahibabad', destination: 'Jaipur' }, equipment: 'Any Vehicle', units: 1,
    companyName: 'Vishal Pipes Limited', closesAt: now + 60 * 60_000, startsAt: now - 60_000, status: 'live',
  }, over);
}

async function run(l, platformKey) {
  const store = new MemoryStore();
  const requests = new PriceRequestStore({ store, marginsPct: [12, 8, 5], minMarginPct: 3 });
  const req = await requests.createForLoad(l, { deadlineAt: now + 58 * 60_000, platformKey });
  const sent = [];
  const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'http://h', log: () => {}, store });
  notifier.alert = async (kind, data) => { sent.push({ kind, data }); return { delivered: true }; };
  const askData = await notifier._priceNeededData(req);
  const ask = renderMessage('price_needed', askData);
  await requests.capture(req.id, { cost: 2800 });
  await notifier.confirmSubmitted(await requests.getByToken(req.id), [3200, 3000, 2900]);
  const sub = sent.find((s) => s.kind === 'price_submitted');
  return {
    ask,
    resolved: sub ? renderMessage('ask_resolved', sub.data) : '',
    receipt: sub ? renderMessage('price_submitted', sub.data) : '',
  };
}

const vehicleLine = (msg) => (msg.split('\n').find((l) => l.startsWith('\u{1F69B}')) || null);
const lineAfterVehicle = (msg) => {
  const lines = msg.split('\n');
  const i = lines.findIndex((l) => l.startsWith('\u{1F69B}'));
  return i >= 0 ? lines[i + 1] : null;
};
const vehicleTypeCell = (msg) => {
  const m = /\*Vehicle Type\* - ([^\n]*)/.exec(msg);
  return m ? m[1] : null;
};
const yourRateCell = (msg) => {
  const m = /\*Your Rate\* - ([^\n]*)/.exec(msg);
  return m ? m[1] : null;
};
const rateLine = (msg) => (msg.split('\n').find((l) => l.startsWith('\u{1F4B0}')) || null);

(async () => {
  let n = 0;

  // ---- per-tonne (PMT, MT): the owner-approved copy, verbatim ----
  {
    const l = load('PMT-MT-1', { units: 30, quoteType: 'PMT', rateType: 'PMT', unit: 'MT', weight: 30, weightUnit: 'MT', shipmentType: 'FTL' });
    const r = await run(l, 'sp');
    ok(++n, `ask vehicle line: ${JSON.stringify(vehicleLine(r.ask))}`);
    assert.strictEqual(vehicleLine(r.ask), '\u{1F69B} Any Vehicle . 30 MT', 'PMT ask vehicle line drops the truck-count prefix');
    ok(++n, `ask per-tonne note: ${JSON.stringify(lineAfterVehicle(r.ask))}`);
    assert.strictEqual(lineAfterVehicle(r.ask), '⚖️ *Per tonne* - enter your rate per MT, not the truck total', 'PMT ask carries the per-tonne instruction right after the vehicle line');

    ok(++n, `ask_resolved rate: ${JSON.stringify(rateLine(r.resolved))}`);
    assert.strictEqual(rateLine(r.resolved), '\u{1F4B0} ₹2,800 per MT', 'ask_resolved (We have your rate) states the unit');

    ok(++n, `receipt Vehicle Type: ${JSON.stringify(vehicleTypeCell(r.receipt))}`);
    assert.strictEqual(vehicleTypeCell(r.receipt), 'Any Vehicle . 30 MT', 'price_submitted Vehicle Type is never "30 x Any Vehicle" on a PMT load');
    ok(++n, `receipt Your Rate: ${JSON.stringify(yourRateCell(r.receipt))}`);
    assert.ok(yourRateCell(r.receipt).startsWith('₹2,800 per MT'), 'price_submitted Your Rate states the unit');
  }

  // ---- review r1, Finding 1: a per-tonne load SPLIT ACROSS TRUCKS states the whole-load total, not
  // just the per-truck figure. vehicleCount (L.units) is the load's TOTAL quantity on a PMT load,
  // weight is PER-VEHICLE (loadRules.js derivePmtVehicleCount) - 60 MT total / 30 MT per truck = 2
  // trucks, the real shape of 3 of 5 live Vishal Pipes loads (2026-08-05 board). ----
  {
    const l = load('PMT-MT-SPLIT', { units: 60, quoteType: 'PMT', rateType: 'PMT', unit: 'MT', weight: 30, weightUnit: 'MT' });
    const r = await run(l, 'sp');
    ok(++n, `split-load ask vehicle line: ${JSON.stringify(vehicleLine(r.ask))}`);
    assert.strictEqual(vehicleLine(r.ask), '\u{1F69B} 2 x Any Vehicle . 30 MT each (60 MT)', 'split PMT ask states both the per-truck figure and the whole-load total');
    ok(++n, 'split-load ask still carries the per-tonne note');
    assert.strictEqual(lineAfterVehicle(r.ask), '⚖️ *Per tonne* - enter your rate per MT, not the truck total');
    ok(++n, `split-load receipt Vehicle Type: ${JSON.stringify(vehicleTypeCell(r.receipt))}`);
    assert.strictEqual(vehicleTypeCell(r.receipt), '2 x Any Vehicle . 30 MT each (60 MT)', 'the receipt must state the SAME total as the ask, never just the per-truck figure');
    ok(++n, `split-load receipt Your Rate: ${JSON.stringify(yourRateCell(r.receipt))}`);
    assert.ok(yourRateCell(r.receipt).startsWith('₹2,800 per MT'), 'a split load still prices per MT, not per truck');
  }

  // ---- release-2026-09-28 sweep, Finding 5: the truck count is genuinely UNKNOWN (a non-integral
  // vehicleCount/weight ratio - loadRules.js derivePmtVehicleCount returns null, never guessing 1).
  // units 25 / weight 10 = 2.5 trucks. The ask/receipt must state the WHOLE-LOAD total (25 MT, the
  // SAME figure the price page's pmtCommitmentText(trucks=null) states), never the per-truck 10 MT,
  // and never invent an "each"/truck-count it does not have. ----
  {
    const l = load('PMT-MT-UNKNOWN-COUNT', { units: 25, quoteType: 'PMT', rateType: 'PMT', unit: 'MT', weight: 10, weightUnit: 'MT' });
    const r = await run(l, 'sp');
    ok(++n, `unknown-count ask vehicle line: ${JSON.stringify(vehicleLine(r.ask))}`);
    assert.strictEqual(vehicleLine(r.ask), '\u{1F69B} Any Vehicle . 25 MT', 'an unknown truck count must state the whole-load total (25 MT), never the per-truck figure (10 MT) and never "each"');
    ok(++n, 'unknown-count ask still carries the per-tonne note');
    assert.strictEqual(lineAfterVehicle(r.ask), '⚖️ *Per tonne* - enter your rate per MT, not the truck total');
    ok(++n, `unknown-count receipt Vehicle Type: ${JSON.stringify(vehicleTypeCell(r.receipt))}`);
    assert.strictEqual(vehicleTypeCell(r.receipt), 'Any Vehicle . 25 MT', 'the receipt must state the SAME whole-load total as the ask');
    ok(++n, `unknown-count receipt Your Rate: ${JSON.stringify(yourRateCell(r.receipt))}`);
    assert.ok(yourRateCell(r.receipt).startsWith('₹2,800 per MT'), 'an unknown-count load still prices per MT');
  }

  // ---- review r1, Finding 3: a KG per-tonne load (Tata Consumer / Ashirvad - loadRules.js:370-377,
  // refused by the engine's own MT-only gate) keeps TODAY's rendering byte-identical. "per MT" on a
  // KG load would misstate the unit by 1000x. ----
  {
    const l = load('PMT-KG-1', { units: 2, quoteType: 'PMT', rateType: 'PMT', unit: 'KG', weight: 9000, weightUnit: 'KG' });
    const r = await run(l, 'sp');
    ok(++n, `KG per-tonne ask vehicle line: ${JSON.stringify(vehicleLine(r.ask))}`);
    assert.strictEqual(vehicleLine(r.ask), '\u{1F69B} 2 x Any Vehicle . 9000 KG', 'a KG per-tonne load renders exactly like a non-PMT load - no split/quantity rewrite');
    ok(++n, 'KG per-tonne ask carries NO per-tonne note');
    assert.ok(!/Per tonne/.test(lineAfterVehicle(r.ask) || ''), 'the MT-only per-tonne instruction leaked onto a KG load');
    ok(++n, `KG per-tonne ask_resolved rate: ${JSON.stringify(rateLine(r.resolved))}`);
    assert.strictEqual(rateLine(r.resolved), '\u{1F4B0} ₹2,800', 'a KG per-tonne load must never get the "per MT" suffix (1000x unit mismatch)');
    ok(++n, `KG per-tonne receipt Vehicle Type: ${JSON.stringify(vehicleTypeCell(r.receipt))}`);
    assert.strictEqual(vehicleTypeCell(r.receipt), '2 x Any Vehicle', 'KG per-tonne receipt Vehicle Type unchanged from a plain non-PMT rendering');
    ok(++n, `KG per-tonne receipt Your Rate: ${JSON.stringify(yourRateCell(r.receipt))}`);
    assert.strictEqual(yourRateCell(r.receipt), '₹2,800', 'KG per-tonne receipt Your Rate carries no unit suffix');
  }

  // ---- byte-identity pins: every other load renders EXACTLY as before ----
  const pins = [
    ['FTL single vehicle', load('FTL-1', { units: 1, quoteType: 'FTL', weight: 18, weightUnit: 'MT' }),
      '\u{1F69B} 1 x Any Vehicle . 18 MT', '\u{1F4B0} ₹2,800', '1 x Any Vehicle', '₹2,800'],
    // A genuine FTL multi-vehicle load already carries the pre-existing "(per vehicle x N vehicles)"
    // trailer (perVehicleNote) - untouched by this change, so it must survive byte-identically too.
    ['FTL multi-vehicle', load('FTL-2', { units: 3, quoteType: 'FTL', weight: 22, weightUnit: 'MT' }),
      '\u{1F69B} 3 x Any Vehicle . 22 MT', '\u{1F4B0} ₹2,800', '3 x Any Vehicle', '₹2,800 (per vehicle x 3 vehicles)'],
    ['GoComet (no quoteType)', load('GC-1', { units: 1, weight: 20, weightUnit: 'MT' }),
      '\u{1F69B} 1 x Any Vehicle . 20 MT', '\u{1F4B0} ₹2,800', '1 x Any Vehicle', '₹2,800'],
    ['KG-weighed FLAT load (Ashirvad-style, NOT per-tonne)', load('KG-1', { units: 2, quoteType: 'FTL', weight: 9000, weightUnit: 'KG' }),
      '\u{1F69B} 2 x Any Vehicle . 9000 KG', '\u{1F4B0} ₹2,800', '2 x Any Vehicle', '₹2,800 (per vehicle x 2 vehicles)'],
  ];
  for (const [name, l, wantVehicleLine, wantRateLine, wantVehicleType, wantYourRate] of pins) {
    const r = await run(l, 'sp');
    ok(++n, `${name}: ask vehicle line unchanged`);
    assert.strictEqual(vehicleLine(r.ask), wantVehicleLine, `${name}: ask vehicle line changed - ${JSON.stringify(vehicleLine(r.ask))}`);
    ok(++n, `${name}: no per-tonne note injected`);
    assert.ok(!/Per tonne/.test(lineAfterVehicle(r.ask) || ''), `${name}: a non-PMT load got the per-tonne note`);
    ok(++n, `${name}: ask_resolved rate has no unit suffix`);
    assert.strictEqual(rateLine(r.resolved), wantRateLine, `${name}: ask_resolved rate changed - ${JSON.stringify(rateLine(r.resolved))}`);
    ok(++n, `${name}: receipt Vehicle Type unchanged`);
    assert.strictEqual(vehicleTypeCell(r.receipt), wantVehicleType, `${name}: receipt Vehicle Type changed - ${JSON.stringify(vehicleTypeCell(r.receipt))}`);
    ok(++n, `${name}: receipt Your Rate has no unit suffix`);
    assert.strictEqual(yourRateCell(r.receipt), wantYourRate, `${name}: receipt Your Rate changed - ${JSON.stringify(yourRateCell(r.receipt))}`);
  }

  console.log(`\n${pass}/${n} checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
