'use strict';
/**
 * GoComet multi-TRUCK-TYPE bidding - the write path that used to be a refusal.
 *
 * Until 2026-08-19 a quote carrying more than one freight-charge line threw
 * MULTI_CARGO_UNSUPPORTED, on the reasoning that writing one amount to every line would bid N
 * times the intended total. The arithmetic behind that was wrong. `price` is PER UNIT, each line
 * carries its own `units`, and the server multiplies per line and sums - proven on 8 of 8 quote
 * bodies read off BRL's own tenant (_research/2026-08-19_gocomet-brl-tenant-api-probe.md),
 * including the asymmetric 63780x5 + 42520x1 = 361,420 and the 12386x187 = 2,316,182. So one
 * per-unit amount on every line is a uniform per-truck RATE totalling amount x sum(units).
 *
 * Every fixture here is shaped after a real captured quote, and the units carriers are set to the
 * values the live wire actually carries: total_charges.total.units is the SUM over lines, while
 * quote_units is neither the sum nor a per-line figure and is deliberately not cross-checked.
 *
 * The refusals that STAY refusals are pinned here too, because the risk in relaxing one guard is
 * relaxing its neighbours by accident.
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { cargoTypeList, readLoadSpec } = require('../src/platform/gocometCargo');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;

function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
/** A recording fetch that serves `quote` on the GET and 200s the submit. */
function transport(quote) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, init });
    if (init.method === 'GET' && String(url).includes('/quotes')) return resp(200, [quote]);
    if (init.method === 'PUT' && String(url).includes('/submit')) return resp(200, { data: { quote_rank: 2, can_submit_quote: true } });
    return resp(404, { error: 'no_route' });
  };
  return { fetchImpl, calls };
}
const noSleep = async () => {};
async function armed(quote) {
  const t = transport(quote);
  const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl: t.fetchImpl, sleep: noSleep });
  await a.login();
  return { a, calls: t.calls };
}
/** The freight group as it went out on the wire, or null when nothing was submitted. */
function submittedGroup(calls, group = '11_freight_charges') {
  const put = calls.find((c) => c.method === 'PUT');
  return put ? JSON.parse(put.init.body).quote.charges_list[group] : null;
}
/** A truck-type freight line in the shape the live wire carries. */
const line = (units, price, over = {}) => ({
  units, price, unit_name: 'TRUCK', currency: 'INR', taxable: '1', tax_id: '0',
  include_in_rank: true, is_custom_field: false, split_charge: false, ...over,
});
/**
 * A quote with N truck-type lines. `total_charges.total.units` is the SUM of the line units,
 * which is what the live wire carries (10 on 5+5, 6 on 5+1, 2 on 1+1) - and `quote_units` is set
 * to the FIRST line's units, matching every captured multi-line quote, precisely so a regression
 * that started cross-checking against it would fail here.
 */
function multiQuote(lines, over = {}) {
  const group = { display_name: 'Freight Charges' };
  for (const [key, ln] of lines) group[key] = ln;
  const units = lines.reduce((a, [, ln]) => a + ln.units, 0);
  return {
    id: 'QM', charges_list: { '11_freight_charges': Object.assign(group, over.group) },
    total_charges: { total: { units, quote_units: lines[0][1].units, unit_name: 'TRUCK', total: 0, currency: 'INR' } },
    ...over.quote,
  };
}

(async () => {
  // =====================================================================================
  // 1. TWO TRUCK TYPES, EQUAL UNITS - the 260817Q9LG shape (113505x5 + 102695x5 = 1,081,000).
  // =====================================================================================
  console.log('\n1. two truck types, equal units');
  {
    const q = multiQuote([
      ["freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x9'6\")_25_ton", line(5, 113505)],
      ["freight_charges_custom_charge_40fthb_(lxwxh_-_40'x8'x8'8\")_(weight_23_mt)", line(5, 102695)],
    ]);
    const { a, calls } = await armed(q);
    const r = await a.placeBid('EQ1', 90000, { floor: 50000 });
    ok(r.accepted === true, 'a two-truck-type quote is accepted, not refused');
    const g = submittedGroup(calls);
    const keys = Object.keys(g).filter((k) => k.startsWith('freight_charges_custom_charge'));
    ok(keys.length === 2 && keys.every((k) => g[k].price === 90000),
      'the SAME per-unit rate is written to both truck-type lines');
    ok(r.units === 10 && r.wireTotal === 90000 * 10,
      `the reported basis is the SUM of the line units and wireTotal follows it (units ${r.units}, wireTotal ${r.wireTotal})`);
    ok(r.cargoLines === 2 && r.pricedLines.length === 2 && r.pricedLines.every((l) => l.units === 5),
      'the result names the lines it priced and their own multipliers');
    // The old refusal's claim, tested directly: a uniform per-unit write is NOT an N-fold.
    ok(r.wireTotal !== 90000 * 2 * 10, 'and the total is not a multiple of itself - the N-fold the old guard feared does not occur');
  }

  // =====================================================================================
  // 2. TWO TRUCK TYPES, UNEQUAL UNITS - the 260807SXV9 shape (63780x5 + 42520x1 = 361,420).
  //    The case a blended single rate cannot be split by any rule that ignores per-line units.
  // =====================================================================================
  console.log('\n2. two truck types, ASYMMETRIC units');
  {
    const q = multiQuote([
      ["freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8.8')_25_tons", line(5, 63780)],
      ["freight_charges_custom_charge_20ftodc_(lxwxh_-_20'x8'x8'8\")_10_ton", line(1, 42520)],
    ]);
    ok(q.total_charges.total.units === 6 && q.total_charges.total.quote_units === 5,
      'fixture check: the wire carries units 6 (the sum) and quote_units 5 (neither) - the shape that breaks a naive cross-check');
    const { a, calls } = await armed(q);
    const r = await a.placeBid('AS1', 40000, { floor: 10000 });
    ok(r.accepted === true, 'an asymmetric two-type quote is accepted');
    const g = submittedGroup(calls);
    ok(g["freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8.8')_25_tons"].price === 40000
      && g["freight_charges_custom_charge_20ftodc_(lxwxh_-_20'x8'x8'8\")_10_ton"].price === 40000,
      'both lines carry the one per-unit rate, whatever their own counts');
    ok(r.units === 6 && r.wireTotal === 40000 * 6,
      `wireTotal is 40000x5 + 40000x1 = ${40000 * 6}, i.e. the sum over the priced lines (got ${r.wireTotal})`);
    // The line units are READ, never rewritten - the server owns the multiplier.
    ok(g["freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8.8')_25_tons"].units === 5
      && g["freight_charges_custom_charge_20ftodc_(lxwxh_-_20'x8'x8'8\")_10_ton"].units === 1,
      'the per-line units are carried through untouched');
  }

  // =====================================================================================
  // 3. A ONE-LINE LOAD IS UNCHANGED. The document that goes out differs from the one that came
  //    back by the price alone - nothing the multi-line path added leaks onto a single-type load.
  // =====================================================================================
  console.log('\n3. a single-truck-type load submits exactly what it always did');
  {
    const q = {
      id: 'QS', charges_list: { '11_freight_charges': {
        display_name: 'Freight Charges',
        freight_charges_custom_charge_40ft: line(187, 12386),
      } },
      total_charges: { total: { units: 187, quote_units: 187, unit_name: 'TRUCK', total: 2316182 } },
    };
    const { a, calls } = await armed(q);
    const r = await a.placeBid('SG1', 12000, { floor: 5000 });
    ok(r.accepted === true && r.units === 187 && r.wireTotal === 12000 * 187,
      `single-line basis and wire total are unchanged (units ${r.units}, wireTotal ${r.wireTotal})`);
    const sent = JSON.parse(calls.find((c) => c.method === 'PUT').init.body).quote;
    const expected = JSON.parse(JSON.stringify(q));
    expected.charges_list['11_freight_charges'].freight_charges_custom_charge_40ft.price = 12000;
    ok(JSON.stringify(sent) === JSON.stringify(expected),
      'THE POINT: the submitted document differs from the fetched one by the price and nothing else');
    ok(r.cargoLines === 1, 'and it reports one priced line');
  }

  // =====================================================================================
  // 4. ACCESSORIAL LINES IN THE SAME CONTAINER ARE NOT TOUCHED.
  //    BRL's tenant carries none, but atgtire's `11_freight_charges` holds `lr_charges` and
  //    `others` beside the freight line, both with include_in_rank true. Writing our rate onto
  //    one of those would move a number we are not the author of - the same class of harm as the
  //    detention line a concurrent overwrite once dragged from 7,500 to 5,000.
  // =====================================================================================
  console.log('\n4. accessorials and display_name are carried through byte-unchanged');
  {
    const accessorials = {
      lr_charges: line(1, 200, { is_custom_field: false }),
      others: line(1, 0),
    };
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft', line(2, 71500)],
      ['freight_charges_custom_charge_20ftodc', line(1, 52850)],
    ], { group: accessorials });
    const before = JSON.stringify({ lr: q.charges_list['11_freight_charges'].lr_charges, ot: q.charges_list['11_freight_charges'].others, dn: q.charges_list['11_freight_charges'].display_name });
    const { a, calls } = await armed(q);
    const r = await a.placeBid('AC1', 60000, { floor: 10000 });
    ok(r.accepted === true, 'the load is bid');
    const g = submittedGroup(calls);
    ok(JSON.stringify({ lr: g.lr_charges, ot: g.others, dn: g.display_name }) === before,
      'THE POINT: lr_charges, others and display_name go out exactly as they arrived');
    ok(g.lr_charges.price === 200 && g.others.price === 0, 'no accessorial received our rate');
    ok(r.units === 3 && r.wireTotal === 60000 * 3,
      `the basis counts ONLY the truck-type lines (2 + 1), not the accessorials (got units ${r.units})`);
    ok(r.pricedLines.every((l) => l.key.startsWith('freight_charges_custom_charge')),
      'and only truck-type keys are reported as priced');
  }

  // =====================================================================================
  // 5. THE COST FLOOR, ASSERTED ON EVERY LINE THE RATE LANDS ON.
  //    A uniform rate is one number, so on a load whose truck types are not worth the same per
  //    truck the floor is the only thing standing between the desk and a below-cost bid on the
  //    larger one. Nothing may reach the wire when it breaches.
  // =====================================================================================
  console.log('\n5. a sub-floor rate never reaches a multi-type wire');
  {
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft_25_ton', line(5, 113505)],
      ['freight_charges_custom_charge_20ftodc_10_ton', line(1, 42520)],
    ]);
    const { a, calls } = await armed(q);
    let err = null;
    try { await a.placeBid('FL1', 49999, { floor: 50000 }); } catch (e) { err = e; }
    ok(err && err.code === 'FLOOR', `a rate below the floor is refused (got ${err && err.code})`);
    ok(!calls.some((c) => c.method === 'PUT'), 'and nothing is submitted');
    // At the floor exactly, it goes - the belt is >=, not >, and a multi-line load must not be
    // stricter than a single-line one about the same number.
    const t2 = await armed(q);
    const r = await t2.a.placeBid('FL2', 50000, { floor: 50000 });
    ok(r.accepted === true && r.wireTotal === 50000 * 6, 'a rate exactly at the floor is bid, on every line');
  }

  // =====================================================================================
  // 6. CURRENCY IS PINNED TO INR ON EVERY LINE WE WRITE, NEVER INHERITED.
  //    A captured quote on another tenant carried a per-line USD against an INR group total; the
  //    portal accepted the submit and then invalidated it, holding Rs 57,79,129 against an
  //    intended Rs 59,700 - 96.8x. The engine has no currency concept, so the only honest unit to
  //    write beside a rupee figure is the one it is in.
  // =====================================================================================
  console.log('\n6. currency is pinned to INR on the lines we price');
  {
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft', line(2, 71500, { currency: 'USD' })],
      ['freight_charges_custom_charge_20ftodc', line(1, 52850, { currency: null })],
    ], { group: { lr_charges: line(1, 200, { currency: 'USD' }) } });
    const { a, calls } = await armed(q);
    await a.placeBid('CU1', 59700, { floor: 1000 });
    const g = submittedGroup(calls);
    ok(g.freight_charges_custom_charge_40ft.currency === 'INR', 'a USD line we price is rewritten to INR');
    ok(g.freight_charges_custom_charge_20ftodc.currency === 'INR', 'a null-currency line we price is given INR');
    ok(g.lr_charges.currency === 'USD', 'and an accessorial we do NOT price keeps its own currency - we are not its author');
  }
  {
    // Single-line loads are pinned too: the 96.8x case was a one-line quote.
    const q = {
      id: 'QC', charges_list: { '11_freight_charges': { freight_charges_custom_charge_40ft: line(1, 100, { currency: 'USD' }) } },
      total_charges: { total: { units: 1, quote_units: 1, unit_name: 'TRUCK' } },
    };
    const { a, calls } = await armed(q);
    await a.placeBid('CU2', 59700, { floor: 1000 });
    ok(submittedGroup(calls).freight_charges_custom_charge_40ft.currency === 'INR',
      'a single-line quote drafted in USD is also pinned to INR');
  }

  // =====================================================================================
  // 7. THE REFUSALS THAT STAY. Relaxing one guard must not relax its neighbours.
  // =====================================================================================
  console.log('\n7. the neighbouring refusals are untouched');
  {
    // MULTI_FREIGHT_GROUP: still unobserved, still refused. _freightContainer returns ONE group,
    // so a second group would keep its stale price and GoComet sums the groups - a mispriced bid
    // in an unpredictable direction, which is harder to spot after the fact than an N-fold.
    const q = { id: 'QG', charges_list: {
      '11_freight_charges': { freight_charges_custom_charge_a: line(1, 100), freight_charges_custom_charge_b: line(1, 200) },
      '12_freight_charges': { freight_charges_custom_charge_c: line(1, 999) },
    }, total_charges: { total: { units: 2, quote_units: 1, unit_name: 'TRUCK' } } };
    const { a, calls } = await armed(q);
    let err = null;
    try { await a.placeBid('MG1', 50000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'MULTI_FREIGHT_GROUP', `two freight GROUPS still refused (got ${err && err.code})`);
    ok(err && err.groups && err.groups.length === 2, 'and the refusal still names both groups');
    ok(!calls.some((c) => c.method === 'PUT'), 'a multi-group quote still never reaches the wire');
  }
  {
    // PARTIAL_VEHICLE_COUNT: GoComet has no per-bid count field at all, so bidding for 3 of 6 is
    // not expressible. On a multi-TYPE load the total the desk would be committing to is the sum
    // across types, and that is the number the refusal has to be measured against.
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft', line(5, 63780)],
      ['freight_charges_custom_charge_20ftodc', line(1, 42520)],
    ]);
    const { a, calls } = await armed(q);
    let err = null;
    try { await a.placeBid('PV1', 40000, { floor: 1000, vcq: 3 }); } catch (e) { err = e; }
    ok(err && err.code === 'PARTIAL_VEHICLE_COUNT', `a partial count on a multi-type load is still refused (got ${err && err.code})`);
    ok(err && err.units === 6, `the refusal measures the partial against the load's TOTAL trucks (got ${err && err.units})`);
    ok(!calls.some((c) => c.method === 'PUT'), 'and nothing is submitted');

    // The full count and the -1 sentinel both describe what GoComet is going to do anyway.
    for (const vcq of [6, -1]) {
      const t = await armed(q);
      const r = await t.a.placeBid('PV2', 40000, { floor: 1000, vcq });
      ok(r.accepted === true, `vcq ${vcq} is honoured on a multi-type load - it asks for exactly what the portal will do`);
    }
  }
  {
    // A units carrier that does not add up is a data-model change, not a tie to break. The
    // additive identity (sum of line units == total_charges.total.units) held exactly on every
    // observed quote, so a mismatch means we no longer understand the wire.
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft', line(5, 63780)],
      ['freight_charges_custom_charge_20ftodc', line(1, 42520)],
    ]);
    q.total_charges.total.units = 5; // was 6
    const { a, calls } = await armed(q);
    let err = null;
    try { await a.placeBid('UD1', 40000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'UNITS_DISAGREE', `a units carrier that does not add up is refused (got ${err && err.code})`);
    ok(!calls.some((c) => c.method === 'PUT'), 'and nothing is submitted');
  }
  {
    // A per-tonne basis would multiply our per-truck rupee figure by a tonnage of 23-50. The
    // multi-line path must refuse it exactly as the single-line one does.
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft', line(5, 63780)],
      ['freight_charges_custom_charge_20ftodc', line(1, 42520)],
    ]);
    q.total_charges.total.unit_name = 'MT';
    const { a, calls } = await armed(q);
    let err = null;
    try { await a.placeBid('BU1', 40000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'BASIS_UNSUPPORTED', `a per-tonne multi-line quote is refused (got ${err && err.code})`);
    ok(!calls.some((c) => c.method === 'PUT'), 'and nothing is submitted');
  }
  {
    // A line whose units are unreadable is refused rather than assumed to be 1 - the assumption
    // that would silently under-report the total the read-back oracle checks against.
    const q = multiQuote([
      ['freight_charges_custom_charge_40ft', line(5, 63780)],
      ['freight_charges_custom_charge_20ftodc', line(1, 42520)],
    ]);
    q.charges_list['11_freight_charges'].freight_charges_custom_charge_20ftodc.units = '1';
    q.total_charges.total.units = 6;
    const { a, calls } = await armed(q);
    let err = null;
    try { await a.placeBid('UU1', 40000, { floor: 1000 }); } catch (e) { err = e; }
    ok(err && err.code === 'UNITS_UNREADABLE', `a string units multiplier is refused, never coerced (got ${err && err.code})`);
    ok(!calls.some((c) => c.method === 'PUT'), 'and nothing is submitted');
  }

  // =====================================================================================
  // 8. WHAT THE DESK SEES. A multi-type load is bid off ONE rate applied to every type, so a
  //    surface that names a single vehicle would take a rate reasoned for one shape and put it on
  //    another. The types have to travel with the load.
  // =====================================================================================
  console.log('\n8. the truck types travel with the load, for the desk to read');
  {
    const two = ["5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck", "1 x 20FTODC (LxWXH - 20'x8'x8'8\") 10 Ton Truck"];
    const types = cargoTypeList(two);
    ok(types && types.length === 2, 'both descriptors parse into a type list');
    ok(types[0].count === 5 && types[1].count === 1, 'each type carries ITS OWN count, not the load total');
    ok(/40 ft/.test(types[0].label) && /20 ft ODC/.test(types[1].label),
      `the labels are the pricer-readable form (${types.map((t) => t.label).join(' | ')})`);
    // ALL-OR-NOTHING: a list missing a type looks complete and is worse than no list.
    ok(cargoTypeList([two[0], '1 x']) === null, 'one unparseable descriptor suppresses the whole list rather than dropping a type');
    ok(cargoTypeList([]) === null && cargoTypeList(null) === null, 'no descriptors yields no list');
    const spec = readLoadSpec({ quantity: two }, null);
    ok(spec.vehicleType === null, 'no single vehicle type is claimed for a two-type load');
    ok(spec.cargoTypes && spec.cargoTypes.length === 2, 'but the spec carries both types');
  }
  {
    // The mapped load's `equipment` names every type WITH its count, because the counts differ -
    // that is the whole hazard. Asserted through the adapter so the mapping cannot drift from the
    // parser it is built on.
    const listBody = { enquiries: [{
      key: 'MT1', name: 'ref-1', bidding_closed: false, mode: 'FTL', client_company_name: 'Waaree Energies Ltd.',
      bid_close_timestamp: new Date(Date.now() + 30 * 60_000).toISOString(),
      quantity: ["5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck", "1 x 20FTODC (LxWXH - 20'x8'x8'8\") 10 Ton Truck"],
    }], total_pages: 1 };
    const detail = { ...listBody.enquiries[0], cargo_quantity: 6.0, cargo_unit: 'TRUCK' };
    const a = new GoCometAdapter({
      token: validToken(), sleep: noSleep,
      fetchImpl: async (url) => (String(url).includes('/enquiries/spot') ? resp(200, listBody) : resp(200, detail)),
    });
    const [load] = await a.listAuctions({ maxPages: 1 });
    ok(load && load.cargoLines === 2, `the load reports two cargo lines (got ${load && load.cargoLines})`);
    ok(load && Array.isArray(load.cargoTypes) && load.cargoTypes.length === 2, 'and carries the two types as structure');
    ok(load && /40 ft/.test(load.equipment) && /20 ft ODC/.test(load.equipment),
      `equipment names BOTH types, never just the first (got ${load && load.equipment})`);
    ok(load && /5 x /.test(load.equipment) && /1 x /.test(load.equipment),
      'and each type carries its own count in the string');
  }
  {
    // fmtVehicle must not prefix the load total onto a string that already counts per type -
    // "6 x 5 x 40 ft ..." reads as a rendering fault. A SuperProcure equipment is a bare type and
    // can never match, so its rendering is untouched.
    const { fmtVehicle } = require('../src/notify/waTemplates');
    ok(fmtVehicle('5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T', 6) === '5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T',
      'a per-type-counted string is rendered as-is');
    ok(fmtVehicle('32ft SXL', 2) === '2 x 32ft SXL', 'a bare SuperProcure type still gets the load total prefixed');
    ok(fmtVehicle('40 ft, 25 T', null) === '40 ft, 25 T', 'and a countless load is unchanged');
  }

  assert.strictEqual(fail, 0, `${fail} GoComet multi-truck-type checks failed`);

  // COMPLETION SENTINEL - scripts/run-tests.js grades this file by its EXIT CODE ALONE, so a body
  // that exits 0 early (an unawaited rejection, an early return, a promise that never settles)
  // scores as a silent green having asserted nothing. The `fail === 0` assert cannot catch that,
  // because a run that never reached its assertions also never incremented `fail`. Asserting a
  // FLOOR on the checks that actually ran is what makes that impossible. Raise it when adding.
  const MIN_EXPECTED_CHECKS = 53;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS} - the suite exited early and would otherwise have scored as a silent green`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
