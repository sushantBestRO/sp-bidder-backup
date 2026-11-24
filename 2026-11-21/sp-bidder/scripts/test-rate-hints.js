'use strict';
/**
 * @requires-summary-line
 * RATE HINTS ON THE PRICE ASK: "Last quote" + "FR8 guide".
 *
 * What this pins:
 *   - both lines are DISPLAY-ONLY and default OFF: with the switches off (or no hints) the ask is byte-for-byte
 *     the ask it was before - checked against the same payload rendered with and without a rateHints key
 *   - FR8 data is only ever used when it is unambiguous: exact hub names, a vehicle class we are sure of,
 *     a fresh route, a flat (not per-tonne) single-type load. Everything else yields NO line, never a guess
 *   - the parser reads FR8-style tables in several markups and refuses rows it cannot trust
 *   - the nightly refresher keeps old data when FR8 errors, remembers pages that do not exist, and is polite
 *   - a broken rates file or throwing quotes provider can never throw out of the ask
 * No network: FR8 is a local fixture server.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-hints-'));
process.env.SP_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
delete process.env.RATE_LINE_LAST_QUOTE; delete process.env.RATE_LINE_FR8; delete process.env.FR8_MAX_AGE_HOURS;

const RH = require('../src/notify/rateHints');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { Notifier } = require('../src/notify/notifier');

let n = 0;
function check(name, fn) {
  try { fn(); n++; } catch (e) { console.log(`FAIL: ${name}\n  ${e && e.message}`); process.exitCode = 1; }
}
async function checkAsync(name, fn) {
  try { await fn(); n++; } catch (e) { console.log(`FAIL: ${name}\n  ${e && e.message}`); process.exitCode = 1; }
}
let planned = 0;
const plan = (k) => { planned += k; };

// ---------------------------------------------------------------- fixtures: FR8-style pages
const DJ_ROWS = [
  ['32ft MXL Container<sup>~Approx</sup>', 'Closed body · 15 Ton', '₹20,850', '₹18,000 – ₹22,500'],
  ['32ft SXL Container', 'Closed body · 7 Ton', '₹18,200', '₹16,900 – ₹19,250'],
  ['20ft / 22ft / 24ft Container', 'Closed body · 6 Ton', '₹15,000', '₹13,200 – ₹16,500'],
  ['19ft Open Truck<sup>~Approx</sup>', 'Open body · 6 Ton', '₹15,500', '₹14,000 – ₹17,600'],
];
const tableV1 = (rows) => `<html><head><script>var t="<table><tr><td>32ft SXL Container</td><td>x</td><td>₹1</td></tr></table>"</script></head><body>
<h2>Freight Rates — Delhi to Jaipur (~312 km)</h2>
<table class="rates"><thead><tr><th>Truck Type</th><th>Payload</th><th>Rate</th><th>Range</th></tr></thead><tbody>
${rows.map((r) => `<tr class="x"><td><span>${r[0]}</span></td><td>${r[1]}</td><td><strong>${r[2]}</strong></td><td>${r[3]}</td></tr>`).join('\n')}
</tbody></table></body></html>`;
const PAGE_V1 = tableV1(DJ_ROWS);
// entities + Indian digit grouping + plain hyphen range, attributes everywhere
const PAGE_V2 = `<h1>Kanpur to Lucknow (~90 km)</h1><TABLE><TR><TD data-a="1">32ft&nbsp;SXL Container</TD><TD>7 Ton</TD><TD>&#8377;1,00,000</TD><TD>&#8377;95,000 &ndash; &#8377;1,05,000</TD></TR>
<TR><TD>19ft Open Truck</TD><TD>6 Ton</TD><TD>&#x20B9;9,500</TD><TD>&#x20B9;9,000 - &#x20B9;10,000</TD></TR></TABLE>`;
const PAGE_NO_TABLE = '<html><body><h1>Hubli to Bangalore</h1><p>Call us for rates</p></body></html>';
// the second row's range does not bracket its rate -> a misread column, must be dropped; first row is fine
const PAGE_MISREAD = tableV1([DJ_ROWS[1], ['19ft Open Truck', 'Open body · 6 Ton', '₹15,500', '₹1,400 – ₹1,760']]);

// ---------------------------------------------------------------- the fixture "FR8"
let mode500 = true;
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  const route = (p, body) => { if (req.url === `/transport-service/${p.split('/')[0]}-transport-service/${p.split('/')[0]}-to-${p.split('/')[1]}/`) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); return true; } return false; };
  if (route('delhi/jaipur', PAGE_V1)) return;
  if (route('kanpur/lucknow', PAGE_V2)) return;
  if (route('hubli/bangalore', PAGE_NO_TABLE)) return;
  if (route('jaipur/kanpur', PAGE_MISREAD)) return;
  if (req.url.includes('ahmedabad-to-bhiwandi')) { if (mode500) { res.writeHead(500); res.end('boom'); return; } res.writeHead(200); res.end(PAGE_V1); return; }
  res.writeHead(404); res.end('nope');
});

function inquiry(id, o, d, equipment, ago = 1) {
  return JSON.stringify({ id, platformKey: 'sp', createdAt: Date.now() - ago * 3600 * 1000, equipment, lane: { origin: o, destination: d } });
}

(async () => {
  // ---------------- places
  plan(6);
  check('exact hub names (case, commas, qualifiers)', () => {
    assert.strictEqual(RH.hubSlug('DELHI,'), 'delhi');
    assert.strictEqual(RH.hubSlug('Gurgaon Rural'), 'gurgaon');
    assert.strictEqual(RH.hubSlug('Kanpur UA'), 'kanpur');
    assert.strictEqual(RH.hubSlug('Bengaluru'), 'bangalore');
    assert.strictEqual(RH.hubSlug('Mysore'), 'mysuru');
    assert.strictEqual(RH.hubSlug('New Delhi'), 'delhi');
  });
  check('nearby towns are NOT hubs (a Pune rate must not pose as Chakan)', () => {
    for (const s of ['Pune Chakan', 'Navi Mumbai', 'Govindgarh', 'Tamil Nadu', 'KOZHIKODE CALICUT', '', null, undefined]) assert.strictEqual(RH.hubSlug(s), null, String(s));
  });
  check('Aurangabad is excluded (two cities share the name and the lane has no state)', () => assert.strictEqual(RH.hubSlug('Aurangabad'), null));
  check('url shape matches the FR8 route pages', () => assert.strictEqual(RH.routeUrl('delhi', 'jaipur'), 'https://www.fr8.in/transport-service/delhi-transport-service/delhi-to-jaipur/'));
  check('route key', () => assert.strictEqual(RH.routeKey('delhi', 'jaipur'), 'delhi>jaipur'));
  check('qualifier-only text is not treated as a place', () => assert.strictEqual(RH.hubSlug('rural'), null));

  // ---------------- vehicles
  plan(5);
  check('real equipment strings map to the right class', () => {
    const want = {
      '32 SXL 9T HQ': 'sxl32', '7 Ton 32 FT Container': 'sxl32', 'Container 7MT 32ft': 'sxl32', '32 ft SXL': 'sxl32',
      '14.5 Ton 32 FT Container': 'mxl32', '18 Ton 32FT Container': 'mxl32', '32 ft MXL': 'mxl32', 'Container 14 MT 32ft': 'mxl32', '32 MXL( 9.1 - 15  MT)': 'mxl32',
      '6.5 Ton 20 FT Container': 'cont20_24', 'Container 20/22 Ft': 'cont20_24', 'Container 7MT 24ft': 'cont20_24',
      'Dala Body LPT - 19Ft': 'open19', 'Eicher 19 Feet': 'open19', '19 ft OPEN': 'open19', "Truck 19' Open Dala": 'open19',
    };
    for (const [e, c] of Object.entries(want)) assert.strictEqual(RH.fr8ClassOf(e), c, e);
  });
  check('anything not clearly one of the four classes is null', () => {
    for (const e of ['9 Ton Open', "Trailer 40'", '40 ft', 'Any Vehicle', 'Dala Body LPT - 22Ft', 'Tata 22 Feet', '20( 6 MT)', '6-Wheeler 9 MT', 'Taurus 16 T (10 Tyre)', '', null, undefined, '22 FT']) assert.strictEqual(RH.fr8ClassOf(e), null, String(e));
  });
  check('32 ft OPEN body is not a container (FR8 prices closed containers)', () => {
    for (const e of ['32ft MXL Open body', '32 FT Open', '32 ft open container']) assert.strictEqual(RH.fr8ClassOf(e), null, e);
  });
  check('32 ft container with no axle and no tonnage, or 10-13 t, is ambiguous -> null', () => {
    assert.strictEqual(RH.fr8ClassOf('32 ft Container'), null);
    assert.strictEqual(RH.fr8ClassOf('11.5 Ton 32 FT Container'), null);
  });
  check('FR8 row labels map to the same keys', () => {
    assert.strictEqual(RH.fr8LabelKey('32ft MXL Container~Approx'), 'mxl32');
    assert.strictEqual(RH.fr8LabelKey('32ft SXL Container'), 'sxl32');
    assert.strictEqual(RH.fr8LabelKey('20ft / 22ft / 24ft Container'), 'cont20_24');
    assert.strictEqual(RH.fr8LabelKey('19ft Open Truck~Approx'), 'open19');
    assert.strictEqual(RH.fr8LabelKey('10 Whl Open Truck'), null);
  });

  // ---------------- parser
  plan(6);
  check('parses the standard table, ignores a table-looking string inside <script>', () => {
    const p = RH.parseFr8Page(PAGE_V1);
    assert.strictEqual(p.km, 312);
    assert.deepStrictEqual(p.rows.map((r) => [r.key, r.rate, r.low, r.high, r.approx]), [
      ['mxl32', 20850, 18000, 22500, true], ['sxl32', 18200, 16900, 19250, false], ['cont20_24', 15000, 13200, 16500, false], ['open19', 15500, 14000, 17600, true]]);
  });
  check('row label has the Approx marker stripped, payload kept', () => {
    const r = RH.parseFr8Page(PAGE_V1).rows[0];
    assert.strictEqual(r.label, '32ft MXL Container');
    assert.strictEqual(r.payload, 'Closed body · 15 Ton');
  });
  check('entities, upper-case tags, Indian digit grouping and hyphen ranges', () => {
    const p = RH.parseFr8Page(PAGE_V2);
    assert.strictEqual(p.rows.length, 2);
    assert.deepStrictEqual([p.rows[0].key, p.rows[0].rate, p.rows[0].low, p.rows[0].high], ['sxl32', 100000, 95000, 105000]);
    assert.deepStrictEqual([p.rows[1].key, p.rows[1].rate, p.rows[1].low, p.rows[1].high], ['open19', 9500, 9000, 10000]);
  });
  check('a page with no table yields no rows (never a guess)', () => assert.deepStrictEqual(RH.parseFr8Page(PAGE_NO_TABLE).rows, []));
  check('a row whose range does not bracket its rate is dropped, the good row survives', () => {
    const p = RH.parseFr8Page(PAGE_MISREAD);
    assert.deepStrictEqual(p.rows.map((r) => r.key), ['sxl32']);
  });
  check('garbage input never throws', () => {
    for (const s of [null, undefined, '', '<table>', '<tr><td>x', 123, {}]) assert.doesNotThrow(() => RH.parseFr8Page(s));
  });

  // ---------------- nightly refresher against the fixture server
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.FR8_BASE = `http://127.0.0.1:${server.address().port}`;
  const archive = [
    inquiry('a1', 'Delhi', 'Jaipur', '32 SXL 9T HQ'), inquiry('a2', 'Delhi', 'Jaipur', '14.5 Ton 32 FT Container'), inquiry('a3', 'Delhi', 'Jaipur', '9 Ton Open'),
    inquiry('a4', 'Kanpur UA', 'Lucknow', 'Eicher 19 Feet'), inquiry('a5', 'Hubli', 'Bengaluru', '32 ft MXL'), inquiry('a6', 'Jaipur', 'Kanpur', '32 SXL 9T HQ'),
    inquiry('a7', 'Ahmedabad', 'Bhiwandi', '32 SXL 9T HQ'), inquiry('a8', 'Surat', 'Vapi', '32 SXL 9T HQ'), inquiry('a9', 'Govindgarh', 'Delhi', '32 SXL 9T HQ'),
    inquiry('a10', 'Delhi', 'Jaipur', '32 SXL 9T HQ', 24 * 400), // older than the 120-day window: must not count
  ];
  fs.writeFileSync(path.join(TMP, 'logs', 'priceRequestArchive-2026-11-01.jsonl'), archive.join('\n') + '\n');
  const F = require('../scripts/fr8-rates');
let mtimeTick = Date.now();
const putDoc = (doc) => { const f = path.join(TMP, 'fr8Rates.json'); fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc)); mtimeTick += 2000; fs.utimesSync(f, new Date(mtimeTick), new Date(mtimeTick)); };
  const logs = [];
  plan(8);
  await checkAsync('demand: counts hub-to-hub pairs in the window only', async () => {
    const items = F.collectDemand(120);
    assert.strictEqual(items.length, 9, 'old inquiry excluded');
    assert.strictEqual(items.filter((i) => i.routable).length, 8);
    const pairs = F.pairsByDemand(items);
    assert.strictEqual(pairs[0].key, 'delhi>jaipur');
    assert.strictEqual(pairs[0].n, 3);
  });
  await checkAsync('refresh: saves routes, remembers pages that do not exist, keeps going past an error', async () => {
    await F.refresh({ days: 120, max: 50, delay: 1, log: (m) => logs.push(m) });
    const doc = JSON.parse(fs.readFileSync(path.join(TMP, 'fr8Rates.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(doc.routes).sort(), ['delhi>jaipur', 'jaipur>kanpur', 'kanpur>lucknow']);
    assert.strictEqual(doc.routes['delhi>jaipur'].rows.length, 4);
    assert.strictEqual(doc.routes['delhi>jaipur'].km, 312);
    assert.ok(doc.missing['surat>vapi'], '404 remembered');
    assert.strictEqual(doc.missing['hubli>bangalore'].reason, 'no-rate-table');
    assert.ok(!doc.routes['ahmedabad>bhiwandi'] && !doc.missing['ahmedabad>bhiwandi'], '500 is neither a route nor "missing"');
  });
  await checkAsync('refresh: a second run does not re-hit fresh routes or known-missing pages', async () => {
    const before = hits.length;
    await F.refresh({ days: 120, max: 50, delay: 1, log: () => {} });
    const again = hits.slice(before);
    assert.ok(!again.some((u) => u.includes('delhi-to-jaipur')), 'fresh route not refetched');
    assert.ok(!again.some((u) => u.includes('surat-to-vapi')), 'missing page not rechecked');
    assert.ok(again.some((u) => u.includes('ahmedabad-to-bhiwandi')), 'the failed one IS retried');
  });
  await checkAsync('refresh: when FR8 later errors, the previously saved rates are kept', async () => {
    const file = path.join(TMP, 'fr8Rates.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.routes['delhi>jaipur'].fetchedAt = Date.now() - 20 * 3600 * 1000; // stale enough to refetch
    fs.writeFileSync(file, JSON.stringify(doc));
    const real = global.fetch; let calls = 0;
    global.fetch = async () => { calls++; return { status: 503, text: async () => '' }; };
    try { await F.refresh({ days: 120, max: 50, delay: 1, log: () => {} }); } finally { global.fetch = real; }
    assert.ok(calls > 0);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(after.routes['delhi>jaipur'].rows.length, 4, 'old rates survive an outage');
  });
  await checkAsync('refresh: stops after 5 failures in a row', async () => {
    const file = path.join(TMP, 'fr8Rates.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(doc.routes)) doc.routes[k].fetchedAt = 0;
    fs.writeFileSync(file, JSON.stringify(doc));
    const real = global.fetch; let calls = 0;
    global.fetch = async () => { calls++; throw new Error('network down'); };
    const lines = [];
    try { await F.refresh({ days: 120, max: 50, delay: 1, force: true, log: (m) => lines.push(m) }); } finally { global.fetch = real; }
    assert.ok(calls <= 5, `made ${calls} calls`);
    assert.ok(lines.some((l) => /stopping this run/.test(l)));
  });
  await checkAsync('refresh: a recovered page replaces the missing marker and the 500 route appears', async () => {
    mode500 = false;
    await F.refresh({ days: 120, max: 50, delay: 1, force: true, log: () => {} });
    const doc = JSON.parse(fs.readFileSync(path.join(TMP, 'fr8Rates.json'), 'utf8'));
    assert.ok(doc.routes['ahmedabad>bhiwandi']);
  });
  await checkAsync('report: coverage numbers add up', async () => {
    const lines = []; const r = F.report(120, (m) => lines.push(m));
    assert.strictEqual(r.total, 9);
    assert.strictEqual(r.routable, 8);
    assert.ok(r.pageHit >= 5 && r.shown <= r.vehicleOk && r.vehicleOk <= r.pageHit);
    assert.ok(lines.join('\n').includes('messages that would carry the FR8 line'));
  });
  await checkAsync('refresh: --max caps the number of pages fetched', async () => {
    const before = hits.length;
    const file = path.join(TMP, 'fr8Rates.json'); fs.unlinkSync(file);
    await F.refresh({ days: 120, max: 2, delay: 1, log: () => {} });
    assert.strictEqual(hits.length - before, 2);
  });
  await F.refresh({ days: 120, max: 50, delay: 1, force: true, log: () => {} }); // full file for the lookups below

  // ---------------- per-load lookup
  const load = (o, d, eq, extra = {}) => ({ lane: { origin: o, destination: d }, equipment: eq, ...extra });
  plan(9);
  check('fr8Hint returns the rate, range and approx flag for the right truck class', () => {
    const h = RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {});
    assert.deepStrictEqual([h.rate, h.low, h.high, h.approx], [18200, 16900, 19250, false]);
    const m = RH.fr8Hint(load('DELHI,', 'Jaipur', '14.5 Ton 32 FT Container'), {});
    assert.deepStrictEqual([m.rate, m.approx], [20850, true]);
  });
  check('direction matters: Jaipur->Delhi is a different page and is not served from Delhi->Jaipur', () => {
    assert.strictEqual(RH.fr8Hint(load('Jaipur', 'Delhi', '32 SXL 9T HQ'), {}), null);
  });
  check('no line for: unknown vehicle, non-hub end, same city, no lane', () => {
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '9 Ton Open'), {}), null);
    assert.strictEqual(RH.fr8Hint(load('Govindgarh', 'Jaipur', '32 SXL 9T HQ'), {}), null);
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Delhi', '32 SXL 9T HQ'), {}), null);
    assert.strictEqual(RH.fr8Hint({ equipment: '32 SXL 9T HQ' }, {}), null);
    assert.strictEqual(RH.fr8Hint(null, {}), null);
  });
  check('no line for a truck class that page does not price (cont20_24 on Kanpur->Lucknow)', () => {
    assert.strictEqual(RH.fr8Hint(load('Kanpur', 'Lucknow', '6.5 Ton 20 FT Container'), {}), null);
    assert.ok(RH.fr8Hint(load('Kanpur', 'Lucknow', 'Eicher 19 Feet'), {}));
  });
  check('no line on a per-tonne load or a multi-truck-type load', () => {
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), { pmtBasis: true }), null);
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), { cargoTypes: [{}, {}] }), null);
  });
  check('a stale route (older than 72h) is ignored; FR8_MAX_AGE_HOURS can widen it', () => {
    const file = path.join(TMP, 'fr8Rates.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    doc.routes['delhi>jaipur'].fetchedAt = week; putDoc(doc);
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {}), null);
    process.env.FR8_MAX_AGE_HOURS = '400';
    assert.ok(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {}));
    delete process.env.FR8_MAX_AGE_HOURS;
    doc.routes['delhi>jaipur'].fetchedAt = Date.now(); putDoc(doc);
  });
  check('a future-dated fetchedAt (clock problem) is not trusted', () => {
    const file = path.join(TMP, 'fr8Rates.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.routes['delhi>jaipur'].fetchedAt = Date.now() + 5 * 24 * 3600 * 1000; putDoc(doc);
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {}), null);
    doc.routes['delhi>jaipur'].fetchedAt = Date.now(); putDoc(doc);
  });
  check('a corrupt or missing rates file means no line, never an exception', () => {
    const file = path.join(TMP, 'fr8Rates.json');
    const keep = fs.readFileSync(file, 'utf8');
    putDoc('{not json'); assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {}), null);
    fs.unlinkSync(file); assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {}), null);
    putDoc(keep);
  });
  check('file edits are picked up without a restart', () => {
    const file = path.join(TMP, 'fr8Rates.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.routes['delhi>jaipur'].fetchedAt = Date.now();
    doc.routes['delhi>jaipur'].rows.find((r) => r.key === 'sxl32').rate = 19999;
    putDoc(doc);
    assert.strictEqual(RH.fr8Hint(load('Delhi', 'Jaipur', '32 SXL 9T HQ'), {}).rate, 19999);
  });

  // ---------------- switches + hintsFor
  const quotes = [{ amount: 63780, rate: 58000, bid: 63780, rank: 2, at: new Date(2026, 6, 17, 14, 51).getTime() }, { amount: 50000, rate: 50000, bid: null, rank: 1, at: 1 }];
  const request = { loadId: 'L1', load: load('Delhi', 'Jaipur', '32 SXL 9T HQ') };
  plan(5);
  check('both switches default OFF', () => assert.strictEqual(RH.hintsFor(request, { quotes }), null));
  check('last-quote switch alone attaches only the NEWEST quote', () => {
    process.env.RATE_LINE_LAST_QUOTE = '1';
    const h = RH.hintsFor(request, { quotes });
    assert.strictEqual(h.lastQuote, quotes[0]); assert.strictEqual(h.fr8, undefined);
  });
  check('fr8 switch alone attaches only the FR8 guide', () => {
    delete process.env.RATE_LINE_LAST_QUOTE; process.env.RATE_LINE_FR8 = 'true';
    const h = RH.hintsFor(request, { quotes });
    assert.strictEqual(h.lastQuote, undefined); assert.strictEqual(h.fr8.rate > 0, true);
  });
  check('no quotes and no FR8 route -> null, not an empty object', () => {
    process.env.RATE_LINE_LAST_QUOTE = '1';
    assert.strictEqual(RH.hintsFor({ load: load('Pune', 'Nagpur', '32 SXL 9T HQ') }, { quotes: [] }), null);
  });
  check('a quote row with no numbers at all is not shown', () => {
    assert.strictEqual(RH.hintsFor({ load: {} }, { quotes: [{ rank: 1, at: 1 }] }), null);
  });

  // ---------------- message rendering
  const base = { loadId: '27837773', laneFrom: 'Delhi 110001', laneTo: 'Jaipur 302001', cargo: '1 x 32 SXL 9T HQ', closesText: '09-11-2026 06:13 AM', link: 'https://bid.example/price/x', platformKey: 'sp' };
  const render = (d) => renderMessage(templateFor('price_needed', d), d);
  plan(6);
  check('no rateHints key -> the ask is exactly the original shape (no hint lines, no stray placeholder)', () => {
    const lines = render(base).split('\n');
    assert.deepStrictEqual(lines.slice(1), ['🆔 27837773', '📍 *From* - Delhi 110001', '🎯 *To* - Jaipur 302001', '🚛 1 x 32 SXL 9T HQ', '⏰ 09-11-2026 06:13 AM', '', '👉 https://bid.example/price/x']);
    assert.ok(!render(base).includes('{{'));
  });
  check('empty / unusable rateHints render identically to none', () => {
    const none = render(base);
    for (const rh of [null, {}, 'x', { lastQuote: null, fr8: null }, { fr8: { rate: 'abc' } }]) assert.strictEqual(render({ ...base, rateHints: rh }), none);
  });
  check('both lines sit directly under the vehicle line, before the close time', () => {
    const out = render({ ...base, rateHints: { lastQuote: quotes[0], fr8: { rate: 18200, low: 16900, high: 19250, approx: false } } });
    const lines = out.split('\n');
    const v = lines.findIndex((l) => l.includes('1 x 32 SXL 9T HQ'));
    assert.strictEqual(lines[v + 1], '💵 *Last quote* - ₹58,000 → we bid ₹63,780');
    assert.strictEqual(lines[v + 2], '🏅 Rank 2 | 17/07/2026');
    assert.strictEqual(lines[v + 3], '📊 *FR8 guide* - ₹18,200 (₹16,900–19,250)');
    assert.ok(lines[v + 4].startsWith('⏰'));
  });
  check('approx marker and a missing range render cleanly', () => {
    assert.ok(render({ ...base, rateHints: { fr8: { rate: 20850, low: null, high: null, approx: true } } }).includes('📊 *FR8 guide* - ~₹20,850\n⏰'));
  });
  check('only a single entered cost (no bid) collapses to one figure', () => {
    const out = render({ ...base, rateHints: { lastQuote: { amount: 45000, rate: 45000, bid: null, rank: null, at: new Date(2026, 5, 2, 9, 0).getTime() } } });
    assert.ok(out.includes('💵 *Last quote* - ₹45,000\n🏅 02/06/2026\n⏰'), out);
  });
  check('hints are display-only: the target-rate ask (a different template) is untouched', () => {
    const d = { ...base, targetRate: true, targetPrice: 1, standingPrice: 2, chargeLineCount: 1 };
    assert.strictEqual(render({ ...d, rateHints: { fr8: { rate: 1 } } }), render(d));
  });

  // ---------------- notifier integration (the real _priceNeededData)
  const req = {
    id: 'r1', loadId: '27837773', platformKey: 'sp', status: 'open',
    customer: { customerId: 'x', label: 'X' },
    load: { lane: { origin: 'Delhi', destination: 'Jaipur' }, equipment: '32 SXL 9T HQ', units: 1, loadCode: '1', weight: 9, weightUnit: 'MT', companyName: 'X Ltd', branchName: 'B',
      points: [{ kind: 'pickup', address: 'X, Delhi, India, 110001' }, { kind: 'drop', address: 'Y, Jaipur, India, 302001' }], closesAt: Date.now() + 3600000, rules: {} },
  };
  plan(5);
  const mk = (provider) => new Notifier({ baseUrl: 'https://bid.example', log: () => {}, historyProvider: provider });
  await checkAsync('switches off -> the ask data carries no rateHints at all', async () => {
    delete process.env.RATE_LINE_LAST_QUOTE; delete process.env.RATE_LINE_FR8;
    const d = await mk(async () => quotes)._priceNeededData(req);
    assert.ok(!('rateHints' in d));
    assert.ok(!render(d).includes('Last quote') && !render(d).includes('FR8 guide'));
  });
  await checkAsync('switches on -> both lines reach the rendered ask', async () => {
    process.env.RATE_LINE_LAST_QUOTE = '1'; process.env.RATE_LINE_FR8 = '1';
    const out = render(await mk(async () => quotes)._priceNeededData(req));
    assert.ok(out.includes('💵 *Last quote* - ₹58,000 → we bid ₹63,780'), out);
    assert.ok(out.includes('📊 *FR8 guide* - ₹'), out);
  });
  await checkAsync('a quotes provider that throws still sends the ask (FR8 line only)', async () => {
    const out = render(await mk(async () => { throw new Error('log unreadable'); })._priceNeededData(req));
    assert.ok(!out.includes('Last quote') && out.includes('FR8 guide') && out.includes('👉'), out);
  });
  await checkAsync('a throwing hint module can never break the ask', async () => {
    const orig = RH.hintsFor; RH.hintsFor = () => { throw new Error('boom'); };
    try { const d = await mk(null)._priceNeededData(req); assert.ok(!('rateHints' in d)); assert.ok(render(d).includes('👉')); } finally { RH.hintsFor = orig; }
  });
  await checkAsync('the lookup is local-only: building the ask makes no network request', async () => {
    const real = global.fetch; let calls = 0; global.fetch = async () => { calls++; throw new Error('no network allowed'); };
    const before = hits.length;
    try { await mk(async () => quotes)._priceNeededData(req); } finally { global.fetch = real; }
    assert.strictEqual(calls, 0); assert.strictEqual(hits.length, before);
  });

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  if (n !== planned) { console.log(`FAIL: ran ${n} of ${planned} planned checks`); process.exitCode = 1; }
  console.log(`${n}/${planned} checks passed`);
})().catch((e) => { console.log('FAIL: test crashed -', e && e.stack || e); process.exit(1); });
