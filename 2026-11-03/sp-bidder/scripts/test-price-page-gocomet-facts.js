'use strict';
/**
 * What the /price page tells a pricer about a GoComet load, driven off CAPTURED portal responses.
 *
 * The desk's words, on a live load: "The vehicle types are not proper. What do you mean by FTL?
 * Where is the OAN number? That is the GID number, which you are saying is ID. Weight also the
 * number of vehicles." Four complaints, and none of them was missing data - every fact was already
 * arriving on a response this adapter makes, and was being dropped between the wire and the page:
 *
 *   vehicle   the truck type sat in `quantity` while `equipment` was built from `mode`, so a
 *             shipment mode occupied the Vehicle tile on every FTL load
 *   weight    `gross_weight` arrived on the enquiry detail and the field allowlist discarded it
 *   distance  same, via `custom_columns`
 *   identity  a bare "#2608115VVB" beside a "GoComet" pill, which reads as our own reference
 *
 * So every case here starts from the fixture bytes rather than a hand-built load: the point is not
 * that the renderer can render, it is that it renders correctly against what GoComet really sends.
 * Fixtures: scripts/fixtures/gocomet/ - live enquiry 2608115VVB, 2026-08-11 ~10:40 IST.
 *
 * Parses the SHIPPED bytes over real HTTP wherever a page is under test, same reasoning as
 * test-price-page-platform.js: the tiles are assembled inside template literals and a source read
 * cannot catch a rendering mistake.
 *
 *   node scripts/test-price-page-gocomet-facts.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir + fixture reads), not app state
const path = require('path');
process.env.SP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-gc-facts-'));

const http = require('http');
const assert = require('assert');
const { app, requests, stacks } = require('../src/web/server');
const { GoCometAdapter, readQuoteBasis } = require('../src/platform/gocometAdapter');
const { parseCargoDescriptor, readLoadSpec } = require('../src/platform/gocometCargo');

const EXPECTED_CHECKS = 104;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

const FIX = path.join(__dirname, 'fixtures', 'gocomet');
const readFix = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LIST = readFix('spot-enquiries.list.json');
const DETAIL = readFix('enquiry-detail.json');
const KEY = '2608115VVB';
const CAPTURED_AT = Date.parse('2026-08-11T05:10:00.000Z');

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(CAPTURED_AT / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

function fixtureFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes(`/enquiries/${KEY}/bidding-data`)) return resp(404, { error: 'not_under_test' });
    if (u.includes(`/enquiries/${KEY}`)) return resp(200, DETAIL);
    if (u.includes('/enquiries/spot')) return resp(200, LIST);
    return resp(404, { error: 'no_route' });
  };
}
const makeAdapter = () => new GoCometAdapter({
  token: token(), fetchImpl: fixtureFetch(), sleep: async () => {}, now: () => CAPTURED_AT,
});

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method },
      (res) => { let buf = ''; res.on('data', (d) => (buf += d)); res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, text: buf, json }); }); });
    r.on('error', reject);
    r.end();
  });
}

const GC_ACCOUNT = 'gocomet-primary';
/** Same stub shape as test-price-page-platform.js - a real adapter for the capabilities the page reads. */
function pushGoCometStack() {
  const adapter = new GoCometAdapter({ token: null, bidEnabled: true });
  const stack = {
    account: { accountId: GC_ACCOUNT, label: 'GoComet' },
    tag: { accountId: GC_ACCOUNT, label: 'GoComet' },
    platformKey: 'gocomet',
    adapter,
    engine: { caps: adapter.capabilities(), snapshot: () => [], planPreview: () => ({ ladder: [13000, 12000, 11000], floor: 11000, rungCount: 3 }) },
  };
  const at = stacks.findIndex((s) => s.account && s.account.accountId === GC_ACCOUNT);
  if (at >= 0) stacks[at] = stack; else stacks.push(stack);
}

/** The fact grid's cell for one label, or '' - the tiles are `<span class="sl">LABEL</span><span class="sv">VALUE</span>`. */
function tile(html, label) {
  const m = new RegExp(`<span class="sl">${label}</span><span class="sv">([\\s\\S]*?)</span>`).exec(html);
  return m ? m[1].trim() : '';
}
const header = (html) => { const m = /<div class="brand">([\s\S]*?)<\/div>\s*<h1/.exec(html); return m ? m[1] : ''; };
const laneHeader = (html) => { const m = /<div class="slane">([\s\S]*?)<\/div>\s*<div class="sgrid">/.exec(html); return m ? m[1] : ''; };

(async () => {
  // =====================================================================================
  // 1. THE SPEC PARSER, against every descriptor shape the captures contain.
  //
  // Values are quoted verbatim from reference/brl-gocomet/ and scripts/fixtures/gocomet/. The
  // register targeted is SuperProcure's own "32 SXL 9T HQ" - what the desk already reads one
  // tile away - not GoComet's run-together token, and never GoComet's raw charge-line string,
  // which carries unbalanced parentheses and an embedded quote.
  // =====================================================================================
  console.log('\n1. the truck type, read out of the descriptor GoComet already sends');
  {
    const cases = [
      ["1 x 32FTSXL (LxWXH  32'x8'x8'8\") 7 Ton Truck", '32 ft SXL, 7 T', 1],
      ["1 x 20FTODC (LxWXH - 20'x8'x8'8\") 11 Ton Truck", '20 ft ODC, 11 T', 1],
      ["2 x 40FT (LxWxH - 40'x8'x8'8\") 25 TONS Truck", '40 ft, 25 T', 2],
      ['1 x 19FT Truck', '19 ft', 1],
    ];
    for (const [raw, want, count] of cases) {
      const got = parseCargoDescriptor(raw);
      ok(got && got.vehicleType === want, `"${raw.slice(0, 24)}..." -> ${want} (got ${got && got.vehicleType})`);
      ok(got && got.count === count, `  and its count is ${count}`);
    }
    // ODC is not decoration - an over-dimensional consignment needs a different vehicle at a
    // different price, so it must survive the reduction rather than being filed as noise.
    ok(parseCargoDescriptor("1 x 20FTODC (LxWXH - 20'x8'x8'8\") 11 Ton Truck").vehicleType.includes('ODC'),
      'the ODC flag survives - it changes which vehicle is needed');
    // The raw string never reaches a page. Whatever comes out is free of the parenthesis and
    // quote debris the portal's own strings carry.
    for (const [raw] of cases) {
      const v = parseCargoDescriptor(raw).vehicleType;
      ok(!/[()"']/.test(v), `no portal punctuation survives into "${v}"`);
    }
  }

  console.log('\n1b. and it declines rather than guessing when no type was published');
  {
    // A bare TRUCK with no spec is the single most common value in the captured sample. There is
    // no type to show, so the tile is omitted - never a blank, a dash, or a type inferred from
    // the mode.
    ok(parseCargoDescriptor('1 x Truck').vehicleType === null, 'a bare "Truck" descriptor yields no type');
    ok(parseCargoDescriptor('TRUCK').vehicleType === null, 'and neither does a bare "TRUCK"');
    ok(parseCargoDescriptor('1 x ').vehicleType === null, 'a truncated descriptor yields no type, not the count remnant');
    ok(parseCargoDescriptor('') === null && parseCargoDescriptor(null) === null,
      'empty and absent descriptors return null rather than throwing');
    ok(parseCargoDescriptor('!!! ??? ***').vehicleType === null, 'punctuation with no letters is not a truck type');
    // A shape we do not recognise but that reads as words IS passed through. "Trailer Lowbed" is
    // indistinguishable from corruption at this level, and hiding the portal's own words would
    // cost the desk more than an unusual label does.
    ok(parseCargoDescriptor('1 x Trailer Lowbed').vehicleType === 'Trailer Lowbed',
      'an unfamiliar but legible type is passed through verbatim, not suppressed');
  }

  console.log('\n1c. declared weight, against a second independent capture set');
  {
    // These two enquiries come from HAR recordings of GoComet's OWN web app (2026-08-04), a
    // different capture from the fixtures above. Both carry a populated gross_weight, and their
    // total_gross_weight_mt custom column corroborates the per-UNIT reading: 2 x 25000 KG against
    // a declared total of 50, and 1 x 23000 KG against 23.
    ok(readLoadSpec({}, { gross_weight: ["2 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck 25000.0 KG"] }).weight === 25,
      'a 2-truck load reports 25 MT per truck, not the 50 MT load total');
    ok(readLoadSpec({}, { gross_weight: ['1 x 40FT (LxWXH - 40\'x8\'x8\'8") 22 Ton Truck 23000.0 KG'] }).weight === 23,
      'and a 1-truck load reports its 23 MT');

    // THE CASE THAT PROVES THE TWO TONNAGES ARE DIFFERENT FACTS. This load's truck is named as a
    // 22 Ton vehicle and its declared cargo is 23000 KG. Every other captured load has them equal,
    // which is exactly what would have made substituting one for the other invisible - here it
    // would misstate the consignment by a tonne.
    const split = readLoadSpec(
      { quantity: ['1 x 40FT (LxWXH - 40\'x8\'x8\'8") 22 Ton Truck'] },
      { gross_weight: ['1 x 40FT (LxWXH - 40\'x8\'x8\'8") 22 Ton Truck 23000.0 KG'] },
    );
    ok(split.vehicleType === '40 ft, 22 T', 'the vehicle keeps its rated 22 T');
    ok(split.weight === 23 && split.weightUnit === 'MT', 'and the weight tile reports the declared 23 MT, not the rated 22');

    // The three OTHER weight fields on the same payload are the string "N/A" on every captured
    // load - not null, a literal "N/A" - which is why none of them is read. gross_weight is the
    // one that carries a number.
    ok(readLoadSpec({}, { gross_weight: false }).weight === null,
      'a gross_weight that is not a descriptor list yields no weight rather than a coerced number');
    ok(readLoadSpec({}, { gross_weight: ['1 x 32FTSXL Truck N/A'] }).weight === null,
      'and an "N/A" tail yields no weight - the tile is omitted, never rendered as N/A');
  }

  console.log('\n1d. dimensions, read out of the same descriptor - the CARGO SIZE the director reported missing');
  {
    // Corpus: real descriptor strings observed in captures and BRL's own Waaree vehicle-master
    // feed. Each entry pairs the expected dimension string with the vehicleType/ratedTonnes the
    // PRE-EXISTING parse already produced for it (pinned against origin/main), so the same loop
    // proves dimensions extraction AND proves it moved neither of the two money-adjacent fields.
    const dimCases = [
      ["1 x 40FTHB (LXWXH - 40'x10'x10\") (Weight 18 MT) Truck", "40'x10'x10\"", '40 ft HB', null],
      ["1 x 32FTSXL (LxWXH  32'x8'x8'8\") 7 Ton Truck", "32'x8'x8'8\"", '32 ft SXL, 7 T', 7],
      ["1 x 17FT*01 (LXWXH -17'X7'X8') Truck", "17'X7'X8'", '17 ft *01', null],
      ['1 x 20FT ODC (20*8*9.6) Truck', '20*8*9.6', '20 ft ODC', null],
      ["1 x 32FT MXL (LXWXH - 32'X8'X9.6'&Wt.18.5 MT) Truck", "32'X8'X9.6'", '32 ft MXL', null],
      ["1 x 40FT (LxWXH - 40'x8'x8'8\")(24 Ton) Truck", "40'x8'x8'8\"", '40 ft', null],
      ["1 x 32FTMXL (LxWXH - 32'x8'x8'8\"') (12 Ton) Truck", "32'x8'x8'8\"'", '32 ft MXL', null],
      ['1 x 19FT Truck', null, '19 ft', null],
      ['1 x 40FT Open Trailor Truck', null, '40 ft OPEN TRAILOR', null],
      ['1 x 40FT (Weight 23 MT) Truck', null, '40 ft', null],
      // En-dash in the dash slot. Not seen in the corpus, but the live fixture already separates
      // the marker with a U+00A0, so this feed is not ASCII-clean and an ASCII-only dash strip
      // would refuse a good size here rather than fail loudly.
      ["1 x 40FTHB (LXWXH – 40'x10'x10\") Truck", "40'x10'x10\"", '40 ft HB', null],
    ];
    for (const [raw, wantDim] of dimCases) {
      const got = parseCargoDescriptor(raw);
      ok(got && got.dimensions === wantDim, `"${raw.slice(0, 30)}..." -> dimensions ${JSON.stringify(wantDim)} (got ${JSON.stringify(got && got.dimensions)})`);
    }

    console.log('\n1e. and vehicleType/ratedTonnes stay byte-identical to the pre-dimensions parse, on every case above');
    for (const [raw, , wantType, wantTon] of dimCases) {
      const got = parseCargoDescriptor(raw);
      ok(got.vehicleType === wantType && got.ratedTonnes === wantTon,
        `"${raw.slice(0, 30)}..." -> vehicleType/ratedTonnes unchanged (got ${JSON.stringify(got.vehicleType)}/${got.ratedTonnes})`);
    }
    // The reported load, pinned explicitly: the in-paren "(Weight 18 MT)" must stay invisible to
    // the tonnage regex, and the truck name must carry no ", N T" suffix scraped out of it.
    const reported = parseCargoDescriptor("1 x 40FTHB (LXWXH - 40'x10'x10\") (Weight 18 MT) Truck");
    ok(reported.ratedTonnes === null, 'the reported load: in-paren weight stays invisible to the tonnage regex');
    ok(!/, \d+(?:\.\d+)? T$/.test(reported.vehicleType), 'the reported load: no tonnage suffix leaked into the vehicle name');
  }

  // =====================================================================================
  // 2. THE DISPLAY PARSE MUST NOT REACH THE BASIS DECISION.
  //
  // `unit_name.includes('TON')` misclassifies 100% of the known sample - every TON-bearing
  // string in the captures is a PER-TRUCK load - and a per-tonne misread would write a fraction
  // of the intended rate onto a live auction. The basis keeps resolving off GoComet's own
  // normalised total_charges.total.unit_name and nothing here can influence it.
  // =====================================================================================
  console.log('\n2. the basis stays per-truck on a TON-bearing load');
  {
    const quote = {
      total_charges: { total: { unit_name: 'TRUCK', units: 1.0, quote_units: 1.0 } },
    };
    const line = { units: 1, unit_name: "TRUCK TON 22 40'X8'X8'8\") - (LXWXH 40FT" };
    const basis = readQuoteBasis(quote, line, KEY);
    ok(basis.unitName === 'TRUCK', 'a charge line whose unit_name contains TON still resolves as per-TRUCK');
    ok(basis.units === 1, 'and its multiplier is read from the totals block, not from the display string');
    // The same string, run through the display parser, produces a vehicle label - and that is the
    // only thing it is allowed to produce.
    const shown = parseCargoDescriptor("1 x 40FT (LxWxH - 40'x8'x8'8\") 22 Ton Truck");
    ok(shown.vehicleType === '40 ft, 22 T' && readQuoteBasis(quote, line, KEY).unitName === 'TRUCK',
      'the display parse and the basis decision share no state - reading one cannot move the other');
  }

  // =====================================================================================
  // 3. THE MAPPED LOAD, off the real list + detail responses through the real adapter.
  // =====================================================================================
  console.log('\n3. the captured enquiry maps with every fact the page has a tile for');
  const adapter = makeAdapter();
  const loads = await adapter.listAuctions({ maxPages: 1 });
  const load = loads[0];
  {
    ok(loads.length === 1 && load.id === KEY, 'the captured list maps to one load');
    ok(load.equipment === '32 ft SXL, 7 T', `Vehicle is the truck type (got ${JSON.stringify(load.equipment)})`);
    ok(load.equipment !== 'FTL' && !/^FTL$/i.test(String(load.equipment)),
      'and it is NOT the shipment mode - this is the desk\'s first complaint, pinned');
    ok(load.shipmentType === 'FTL', 'Shipment carries the mode, which is where FTL was always meant to go');
    ok(load.weight === 7 && load.weightUnit === 'MT', `Weight is the declared gross weight in MT (got ${load.weight} ${load.weightUnit})`);
    ok(load.distanceKm === 1672, `Distance comes off the shipper's custom column (got ${load.distanceKm})`);
    ok(load.units === 1, 'the vehicle count still comes from cargo_quantity, unchanged - the money path was not touched');
    ok(load.shipperRef === '3262511465-5601270693 (E.com)', 'the shipper\'s own reference is carried');
    ok(!('productName' in load) || load.productName == null,
      'no Material is invented - GoComet publishes no commodity field, and the enquiry name is a reference number');
  }

  console.log('\n3b. the two fields the allowlist used to drop now survive the projection');
  {
    // Weight and distance live ONLY on the enquiry detail. If the allowlist still discarded them
    // the mapped load above could not carry them, so this asserts the widening did the work
    // rather than some fallback having quietly covered for it.
    const listOnly = new GoCometAdapter({
      token: token(), sleep: async () => {}, now: () => CAPTURED_AT,
      fetchImpl: async (url) => (String(url).includes('/enquiries/spot') ? resp(200, LIST) : resp(500, { error: 'detail_down' })),
    });
    const [bare] = await listOnly.listAuctions({ maxPages: 1 });
    ok(bare && bare.weight == null && bare.distanceKm == null,
      'with the detail unavailable there is no weight and no distance - so the values above came from it');
    ok(bare && bare.equipment === '32 ft SXL, 7 T',
      'the truck type still renders from the LIST alone - it needs no detail fetch and no extra call');
    // The rated tonnage in the truck's name is NOT promoted into Weight. They coincide on every
    // captured load, which is exactly what would make the substitution invisible - a 22 T trailer
    // running 14 tonnes is an ordinary load and would be misstated.
    ok(bare && bare.equipment.includes('7 T') && bare.weight == null,
      'the rated capacity stays inside the vehicle name and never back-fills the declared weight');
  }

  console.log('\n3c. a multi-cargo enquiry gets no single Vehicle tile, and its line COUNT is untouched');
  {
    // `quantity` is one descriptor per cargo TYPE, so a two-entry list is two different trucks and
    // there is no single vehicle to name. Since 2026-08-19 such a load IS bid, off one per-truck
    // rate written to every type - which makes naming one of the two types worse than before, not
    // better: the desk would price a load believing it had one shape. The types are carried as
    // structure (spec.cargoTypes) and rendered as a list instead.
    const two = { ...DETAIL, quantity: ["1 x 32FTSXL (LxWXH 32'x8'x8'8\") 7 Ton Truck", '1 x 19FT Truck'] };
    const spec = readLoadSpec({ ...LIST.enquiries[0], quantity: two.quantity }, two);
    ok(spec.vehicleType === null, 'no single vehicle type is claimed for a two-cargo enquiry');
    ok(spec.shipmentType === 'FTL', 'the mode is still known - it does not depend on the cargo count');
    ok(spec.cargoTypes && spec.cargoTypes.length === 2 && spec.cargoTypes.every((t) => t.count === 1),
      'but BOTH types are carried, each with its own count');

    // cargoLines is the multi-type signal the desk page renders its breakdown from. Adding a
    // display consumer of the same field must not have changed how its length is counted, so the
    // count is asserted here alongside the display behaviour.
    const multi = new GoCometAdapter({
      token: token(), sleep: async () => {}, now: () => CAPTURED_AT,
      fetchImpl: async (url) => (String(url).includes('/enquiries/spot')
        ? resp(200, { ...LIST, enquiries: [{ ...LIST.enquiries[0], quantity: two.quantity }] })
        : resp(200, two)),
    });
    const [ml] = await multi.listAuctions({ maxPages: 1 });
    ok(ml && ml.cargoLines === 2, `cargoLines still counts descriptors, unchanged (got ${ml && ml.cargoLines})`);
    ok(ml && ml.equipment !== null && !/^32 ft SXL/.test(String(ml.equipment)),
      'and the load falls back to the joined raw descriptors rather than presenting one type as the load\'s');
  }

  console.log('\n3d. readLoadSpec carries dimensions on a single-cargo enquiry, and none on a multi-cargo one');
  {
    const single = readLoadSpec(
      { quantity: ["1 x 40FTHB (LXWXH - 40'x10'x10\") (Weight 18 MT) Truck"] },
      { quantity: ["1 x 40FTHB (LXWXH - 40'x10'x10\") (Weight 18 MT) Truck"] },
    );
    ok(single.dimensions === "40'x10'x10\"", `single-cargo enquiry carries dimensions (got ${JSON.stringify(single.dimensions)})`);

    const two = ["1 x 32FTSXL (LxWXH 32'x8'x8'8\") 7 Ton Truck", '1 x 19FT Truck'];
    const multi = readLoadSpec({ quantity: two }, { quantity: two });
    ok(multi.dimensions === null, 'a multi-descriptor enquiry still gets no dimensions - same refusal as vehicleType');
  }

  // =====================================================================================
  // 4. THE PAGE.
  // =====================================================================================
  console.log('\n4. the page a pricer opens');
  pushGoCometStack();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const pageFor = async (over = {}) => {
    const r = await requests.createForLoad({
      ...load, closesAt: now + 20 * 60_000, startsAt: now - 60_000, status: 'live',
      account: { accountId: GC_ACCOUNT, label: 'GoComet' }, ...over,
    }, { deadlineAt: now + 18 * 60_000, platformKey: 'gocomet' });
    return { r, html: (await req('GET', `${base}/price/${r.id}`)).text };
  };
  {
    const { html } = await pageFor();
    ok(tile(html, 'Vehicle').startsWith('32 ft SXL, 7 T'), `Vehicle tile reads the truck type (got ${JSON.stringify(tile(html, 'Vehicle'))})`);
    ok(tile(html, 'Vehicle').includes('&times;1'), 'and carries the vehicle count beside it');
    ok(tile(html, 'Shipment') === 'FTL', 'Shipment tile reads FTL - the mode is stated once, in its own box');
    ok(tile(html, 'Weight') === '7 MT', `Weight tile renders with its unit (got ${JSON.stringify(tile(html, 'Weight'))})`);
    ok(tile(html, 'Distance') === '1672 km', `Distance tile renders (got ${JSON.stringify(tile(html, 'Distance'))})`);
    ok(tile(html, 'Material') === '', 'no Material tile renders - the fact does not exist, so the tile does not either');
    // The reported gap, closed: the desk's own word is "Size", not "Dimensions" - see the tile
    // label pinned in server.js.
    ok(tile(html, 'Size') === '32\'x8\'x8\'8&quot;', `Size tile renders the cargo dimensions, HTML-escaped like every other value (got ${JSON.stringify(tile(html, 'Size'))})`);
  }

  console.log('\n4a2. and a load that carries no dimensions renders no Size tile');
  {
    const { html } = await pageFor({ id: 'GC-NO-DIM', dimensions: null });
    ok(tile(html, 'Size') === '', 'no Size tile at all when the portal published no dimension block');
  }

  console.log('\n4b. which number is whose');
  {
    const { html } = await pageFor();
    const h = header(html);
    ok(h.includes('<span class="loadno">GoComet #2608115VVB</span>'),
      'the portal name is bound to its own key, so the identifier cannot be read as ours');
    // The label is part of this exact-markup pin now: the client confirmed this field is the OA
    // number (4d below), so the line is no longer deliberately unlabelled. The VALUE inside it is
    // unchanged and stays asserted character for character.
    ok(h.includes('<span class="loadref"><span class="oal">OA</span>3262511465-5601270693 (E.com)</span>'),
      'and the shipper\'s own reference leads, labelled OA and whole - the number the desk works by');
    ok(!h.includes('class="badge portal"'), 'the separate portal pill is gone - one fewer thing stacked in that corner');
    // The close-model badge and close date are back in the header (product-owner instruction,
    // 2026-08-17, reverting PR #199's move onto the card - test-price-page-close-model.js
    // section G pins the badge's location directly). The header is a full-width block now, not
    // the old ~170px right-aligned column, so the four-item stack the client called "too compact"
    // does not recur even with the pair back.
    ok(h.includes('class="badge ctype"') && h.includes('class="lddate"'),
      'and the close-model badge and close date are in the header, alongside the identifier pair');
  }

  console.log('\n4c. a load with no truck type published shows no Vehicle tile');
  {
    // The bare-TRUCK case, end to end: the tile must be ABSENT, not blank. A dash or an empty box
    // under a Vehicle heading reads as a rendering fault and invites a guess.
    const { html } = await pageFor({ id: 'GC-BARE', equipment: null, shipperRef: null });
    ok(tile(html, 'Vehicle') === '', 'no Vehicle tile at all when the portal published no type');
    ok(tile(html, 'Shipment') === 'FTL', 'and Shipment still states the mode - it is a separate fact, still known');
    ok(!header(html).includes('class="loadref"'), 'and no reference line renders when the portal published no reference');
    ok(!header(html).includes('>OA<') && !/OA\s*<\/span>\s*<span class="loadno"/.test(header(html)),
      'and no stranded "OA" label with nothing after it - the line is omitted, not emptied');
  }

  console.log('\n4d. the reference is labelled OA, and the value passes through untouched');
  {
    // WHAT THE CLIENT CONFIRMED. He forwarded Best Roadways' own portal notification, which renders
    // `Name:- 3260108709 (260812UTJG)`, and said the one next to the name is the OA number and the
    // one in brackets is the portal's ID. That settles what this field is; it had been carried
    // deliberately unlabelled because no captured response settled it.
    //
    // THE TRAP THIS PINS. His example is a clean ten-digit number, but the captured value on the
    // enquiry this page was built against is a hyphenated compound with a trailing suffix. The
    // field's shape varies between loads, so BOTH must render WHOLE - no split on the hyphen, no
    // stripped suffix, no "just the number" extraction. A wrong OA number in front of a pricer is
    // worse than the unlabelled state this replaces, and their own notification passes the whole
    // value through untouched, so verbatim is also what the desk already reads.
    for (const [shape, ref] of [['plain', '3260108709'], ['compound', '3262511465-5601270693 (E.com)']]) {
      const h = header((await pageFor({ id: `GC-OA-${shape}`, shipperRef: ref })).html);
      const line = /<span class="loadref">([\s\S]*?)<\/span>\s*<span class="loadno">/.exec(h);
      ok(!!line && line[1].includes('class="oal">OA<'), `${shape}: the reference is labelled OA`);
      // The value with the label element removed must be the input, character for character.
      const value = line ? line[1].replace(/<span class="oal">OA<\/span>/, '') : '';
      ok(value === ref.replace(/&/g, '&amp;'), `${shape}: and its value renders VERBATIM (got ${JSON.stringify(value)})`);
    }
    const compound = header((await pageFor({ id: 'GC-OA-whole', shipperRef: '3262511465-5601270693 (E.com)' })).html);
    ok(compound.includes('3262511465-5601270693 (E.com)'),
      'the compound shape is never split on its hyphen nor stripped of its suffix');
    ok(compound.includes('#GC-OA-whole'),
      'and the portal key line beneath it is unchanged - two identifiers, still in that order');
  }

  // =====================================================================================
  // 5. LANE PARSING ON RECORDS THAT PREDATE THE FIELD.
  //
  // The parser shipped with #186 and only ever ran at discovery, so it populated records created
  // after that deploy and nothing before it - on the live box, 5 of 103 GoComet requests carry
  // the field. Every one of the other 98 renders the shipper's whole postal address where a city
  // belongs, on the capture page AND in the desk's worklist. Derived at serve time, never
  // written back: the worklist file is what the desk is working out of.
  // =====================================================================================
  console.log('\n5. a record stored before the lane parser existed still renders a city pair');
  {
    const { r, html } = await pageFor({ id: 'GC-OLD', laneParsed: null });
    ok(r.load.laneParsed == null, 'the stored record genuinely has no laneParsed - the case under test is real');
    const lane = laneHeader(html);
    ok(lane.includes('Degam') && lane.includes('Kottayam'), `the page heads with cities anyway (got ${JSON.stringify(lane.replace(/<[^>]*>/g, ' ').trim())})`);
    ok(!lane.includes('Survey No.'), 'and not with the postal blob');
    ok(lane.includes('396530') && lane.includes('686632'), 'with each pincode under its city');

    const list = await req('GET', `${base}/api/price-requests`);
    const row = list.json.requests.find((x) => x.loadId === 'GC-OLD');
    ok(!!row && row.load.laneParsed && row.load.laneParsed.origin.city === 'Degam',
      'and the worklist payload the console reads carries the derived pair too');
    ok(row.load.laneParsed.destination.city === 'Kottayam', 'both ends, not just the origin');

    // The derivation is READ-SIDE. Anything that persisted it would have rewritten the desk's
    // live worklist file, and a display-only field would have entered the bidding record.
    const stored = await requests.getByToken(r.id);
    ok(stored && stored.load.laneParsed == null,
      'the stored record is UNCHANGED - the value is derived on read and never written back');
  }

  console.log('\n5b. control: an address the parser cannot read still falls back to the raw string');
  {
    const raw = 'Sanagam Solar one PVT LTD - Samakhayli kutch';
    const { html } = await pageFor({ id: 'GC-RAW', laneParsed: null, lane: { origin: raw, destination: raw } });
    const lane = laneHeader(html);
    // The assertion here used to be `lane.includes('Samakhayli')`, which happens to sit at
    // characters 28-38 of this string. The behaviour it was reaching for is unchanged - an
    // unparseable address still heads the card rather than collapsing to "?" - but the fallback is
    // now BOUNDED (src/web/laneDisplay.js), because this same value also renders into a table
    // column on the worklist and an unbounded one blew that column out. So the check is restated
    // as what it was always about: the header still identifies the load, and the part the bound
    // cut off is recoverable from the address rows rather than lost.
    ok(lane.includes('Sanagam Solar one PVT LTD'),
      'an unparseable lane still heads the card - the raw string is the honest fallback');
    ok(lane.includes('...') && !lane.includes('Samakhayli'),
      'but bounded, and visibly so - the whole postal string never fills a lane cell');
    ok(html.includes('Samakhayli kutch'),
      'and the remainder is on the page in full, in the address rows - bounding is only safe because of that');
  }

  console.log('\n5c. control: SuperProcure lanes are never touched');
  {
    const r = await requests.createForLoad({
      id: 'SP-LANE', lane: { origin: 'Bhiwandi', destination: 'Nagpur' }, equipment: 'Trailer',
      units: 1, quoteType: 'FTL', companyName: 'Havells India', closesAt: now + 20 * 60_000,
      startsAt: now - 60_000, status: 'live', softClose: false, closeModelKnown: true,
    }, { deadlineAt: now + 18 * 60_000 });
    const list = await req('GET', `${base}/api/price-requests`);
    const row = list.json.requests.find((x) => x.loadId === 'SP-LANE');
    ok(!!row && row.load.laneParsed == null,
      'a SuperProcure row gains no laneParsed - its lane is already a city and must render exactly as it does today');
    void r;
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed (${pass + fail}/${EXPECTED_CHECKS} checks reached the sentinel)`);
  // The completion sentinel. run-tests.js grades this file by EXIT CODE ONLY, so a file that
  // returned early - an unawaited promise, a throw swallowed by a stray catch - would score a
  // silent green having asserted nothing. Asserting the COUNT is what makes the exit code mean
  // "every check ran", not merely "nothing threw".
  ok(pass + fail === EXPECTED_CHECKS,
    `completion sentinel: ran ${pass + fail} checks, expected ${EXPECTED_CHECKS} (a check was skipped or added without updating EXPECTED_CHECKS)`);
  assert.strictEqual(fail, 0, `${fail} GoComet load-fact checks failed`);
})().catch((e) => { console.error(e); process.exit(1); });
