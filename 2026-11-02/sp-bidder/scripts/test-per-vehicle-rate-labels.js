'use strict';
/**
 * PER-VEHICLE RATE LABELS (display-only safety feature).
 *
 * SuperProcure charges the bid `amount` PER VEHICLE and multiplies it by the load's own truck
 * count. On a genuine FTL multi-vehicle load an operator who enters the total for all N trucks
 * produces a bid N-times too high. Nothing on the /price capture page or the price_submitted
 * receipt said the rate had to be per-vehicle. This suite pins the two label surfaces that close
 * that gap - and, just as importantly, pins that EVERY other load (single-vehicle, PMT/tonnage,
 * unknown basis, missing count) renders BYTE-IDENTICALLY to before, so the feature can never leak
 * per-vehicle phrasing (or a guessed count) onto a load it doesn't apply to.
 *
 * The one multi-vehicle decision comes from discovery.isMultiVehicle (the same predicate the
 * engine's Layer A/B uses) - this suite never redefines it, it exercises it through both surfaces.
 *
 *   A. /price capture form label   (src/web/server.js renderPriceForm, booted over HTTP)
 *   B. price_submitted receipt wiring (src/notify/notifier.js confirmSubmitted -> isMultiVehicle)
 *   C. price_submitted formatter    (src/notify/waTemplates.js perVehicleNote, exact byte-identity)
 */

process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
// the mock stack's DurableScheduler writes intents.json on arm - keep it out of data/
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-pvrl-'));

const http = require('http');
const { app, requests } = require('../src/web/server');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage } = require('../src/notify/waTemplates');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function httpReq(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => resolve({ status: res.statusCode, text: buf })); },
    );
    r.on('error', reject);
    r.end();
  });
}

// A Maytapi-shaped mock: captures every send so the receipt text can be asserted offline.
function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) }; };
  fn.calls = calls;
  return fn;
}
const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const OLD_LABEL = '<label for="cost">Your cost (Rs)</label>';   // the exact pre-feature label shape

(async () => {
  // =========================================================================================
  // A. /price capture form label
  // =========================================================================================
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  // deadlineAt held open so GET renders the live capture form (not the expiry page). The
  // multi-vehicle fail-closed guard is an engine/bid-time concern; capture + render are unaffected.
  const mkForm = async (id, extra) => {
    const r = await requests.createForLoad({
      id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32FT',
      companyName: 'Syngenta India', closesAt: now + 10 * 60_000, startsAt: now - 60_000,
      softClose: false, status: 'live', ...extra,
    }, { deadlineAt: now + 60_000 });
    return (await httpReq('GET', `${base}/price/${r.id}`)).text;
  };

  // FTL multi-vehicle: a per-TRUCK cost label + the editable count control ("/ N trucks").
  const ftlMulti = await mkForm('PVRL-A1', { units: 3, quoteType: 'FTL' });
  ok(/Your cost PER TRUCK \(Rs\)/.test(ftlMulti) && /How many trucks to bid for/.test(ftlMulti) && /\/ 3 trucks/.test(ftlMulti),
    'form: FTL x3 -> per-TRUCK cost label + editable count control ("/ 3 trucks")');
  ok(!new RegExp('>Your cost \\(Rs\\)</label>').test(ftlMulti) && !/PER VEHICLE/.test(ftlMulti),
    'form: FTL x3 -> the bare "Your cost (Rs)" label and the old "PER VEHICLE" wording are gone');

  // FTL single vehicle: byte-identical to the pre-feature label; no per-vehicle phrasing.
  const ftlSingle = await mkForm('PVRL-A2', { units: 1, quoteType: 'FTL' });
  ok(ftlSingle.includes(OLD_LABEL), 'form: FTL x1 -> exact pre-feature label, byte-identical');
  ok(!/PER VEHICLE/.test(ftlSingle), 'form: FTL x1 -> no per-vehicle phrasing anywhere');

  // Unknown basis (count > 1 but no quoteType, e.g. sim/legacy snapshot): FAIL CLOSED - byte-identical.
  const unknownBasis = await mkForm('PVRL-A3', { units: 3 });
  ok(unknownBasis.includes(OLD_LABEL) && !/PER VEHICLE/.test(unknownBasis), 'form: count 3 with NO quoteType -> fail closed, byte-identical label');

  // PMT/tonnage load: `units` is a QUANTITY (22 MT), not 22 trucks. It gets a per-METRIC-TONNE cost
  // label + a READ-ONLY tonnes control - and must NEVER be phrased as trucks / per-vehicle.
  const pmt = await mkForm('PVRL-A4', { units: 22, quoteType: 'PMT' });
  ok(/Your cost PER METRIC TONNE \(Rs\)/.test(pmt) && /\/ 22 metric tonnes/.test(pmt) && !/PER TRUCK|PER VEHICLE|22 trucks/i.test(pmt),
    'form: PMT units=22 -> per-METRIC-TONNE label + read-only tonnes control, never 22 trucks (field trap held)');

  // Missing count entirely: byte-identical, never a guessed number.
  const noCount = await mkForm('PVRL-A5', { quoteType: 'FTL' });
  ok(noCount.includes(OLD_LABEL) && !/PER VEHICLE/.test(noCount), 'form: missing vehicle count -> byte-identical label, no guessed count');

  server.close();

  // =========================================================================================
  // B. price_submitted receipt wiring (confirmSubmitted -> isMultiVehicle -> the receipt text)
  // =========================================================================================
  const subRecipients = [{ name: 'Desk', phone: '+919000000001', alerts: ['price_submitted'] }];
  const mkReceipt = async (id, extra) => {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => subRecipients });
    await n.confirmSubmitted({ id, loadId: id, price: { cost: 45000 }, capturedAt: now, load: {
      lane: { origin: 'Bhiwandi', destination: 'Bawal' }, companyName: 'Syngenta India', equipment: '32FT', closesAt: now, ...extra,
    } });
    return tr.calls[tr.calls.length - 1].body.message;
  };

  // FTL multi-vehicle: the Your Rate line echoes the multiplier with the real count. (#50 unified the
  // receipt label to "Your Rate"; the per-vehicle note is unchanged and still hangs off the amount.)
  const rMulti = await mkReceipt('PVRL-B1', { units: 3, quoteType: 'FTL' });
  ok(/💰 \*Your Rate\* - ₹45,000 \(per vehicle x 3 vehicles\)/.test(rMulti), 'receipt: FTL x3 -> Your Rate line echoes "(per vehicle x 3 vehicles)"');

  // FTL single: byte-identical Your Rate line - rate value flows straight into the footer, no note.
  const rSingle = await mkReceipt('PVRL-B2', { units: 1, quoteType: 'FTL' });
  ok(/💰 \*Your Rate\* - ₹45,000\n/.test(rSingle) && !/per vehicle/.test(rSingle), 'receipt: FTL x1 -> Your Rate line unchanged, no per-vehicle note');

  // PMT (units=22): the field trap - 22 is tonnage, not 22 trucks. No per-vehicle note.
  const rPmt = await mkReceipt('PVRL-B3', { units: 22, quoteType: 'PMT' });
  ok(!/per vehicle/.test(rPmt), 'receipt: PMT units=22 -> no per-vehicle note (field trap held)');

  // Unknown basis (count > 1, no quoteType): FAIL CLOSED - no per-vehicle note.
  const rUnknown = await mkReceipt('PVRL-B4', { units: 3 });
  ok(!/per vehicle/.test(rUnknown), 'receipt: count 3 with NO quoteType -> fail closed, no per-vehicle note');

  // Missing count: no note, never a guessed number.
  const rNoCount = await mkReceipt('PVRL-B5', { quoteType: 'FTL' });
  ok(!/per vehicle/.test(rNoCount), 'receipt: missing count -> no per-vehicle note');

  // =========================================================================================
  // C. price_submitted formatter (perVehicleNote) - exact byte-identity of the pure render
  // =========================================================================================
  const baseData = { oaNo: 'L1', closingTime: '06-07-2026 02:02 PM', route: 'A -> B', cargoQty: '3 x 32FT', enteredTime: '12:00 pm', submittedRate: '₹45,000' };
  const noField = renderMessage('price_submitted', baseData);                       // no vehicleCount at all
  const multi3 = renderMessage('price_submitted', { ...baseData, vehicleCount: 3 });
  const count1 = renderMessage('price_submitted', { ...baseData, vehicleCount: 1 });
  const countNull = renderMessage('price_submitted', { ...baseData, vehicleCount: null });
  const countNaN = renderMessage('price_submitted', { ...baseData, vehicleCount: 'x' });
  ok(multi3.includes('💰 *Your Rate* - ₹45,000 (per vehicle x 3 vehicles)'), 'formatter: vehicleCount 3 inserts the per-vehicle note after the rate');
  ok(multi3 === noField.replace('₹45,000', '₹45,000 (per vehicle x 3 vehicles)'), 'formatter: the ONLY change vs baseline is the inserted note (nothing else moved)');
  ok(count1 === noField, 'formatter: vehicleCount 1 renders byte-identically to no field (never "x 1 vehicles")');
  ok(countNull === noField, 'formatter: vehicleCount null renders byte-identically to no field');
  ok(countNaN === noField, 'formatter: a non-numeric vehicleCount renders byte-identically to no field');
  ok(!/per vehicle/.test(noField), 'formatter: baseline (no vehicleCount) carries no per-vehicle phrasing');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
