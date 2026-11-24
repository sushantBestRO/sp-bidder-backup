'use strict';
/**
 * A DISTINCT RATE PER TRUCK TYPE on GoComet - the desk capture, the blend, and the write.
 *
 * The uniform per-truck rate shipped on 2026-08-19 was arithmetically correct and commercially
 * wrong: a 40 ft 25 T and a 20 ft ODC 10 T are not worth the same per truck, so one blended rate
 * sits BELOW COST on the dearer type while giving the cheaper one away. No assertion could close
 * that while only one cost existed, which is what made the per-line floor loop vacuous.
 *
 * The shape now: ONE ladder, N costs. The desk prices each type; the blended per-truck cost (the
 * weighted mean over the load's own truck counts) is what the ladder, the operating floor and every
 * receipt keep reading; and the adapter re-applies the rung as a MULTIPLIER over each type's own
 * cost, so every line carries the same margin over a different base.
 *
 * The join from a desk type to a freight line is BY CONTENT, never by array position - their own
 * prior bot shipped an "if no cargoIndex match, use array index" fallback, which is the author
 * having already hit the reorder that silently swaps prices between truck types. Section 4 is that
 * case, and it is the reason this file exists as much as the arithmetic is.
 *
 * Every fixture is shaped on a real captured quote (260807SXV9, 260817Q9LG), and the match tokens
 * are the ones chargeMatchToken actually derives from those enquiries' own `quantity` descriptors.
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;
const os = require('os');
const fsq = require('fs'); // allowed: test harness (temp data dir), not app state
const pathq = require('path');
process.env.SP_DATA_DIR = fsq.mkdtempSync(pathq.join(os.tmpdir(), 'sp-per-type-'));

const http = require('http');
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { cargoTypeList, chargeMatchToken } = require('../src/platform/gocometCargo');
const { PriceRequestStore, normalizeCostByType, armFromRequest } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const noSleep = async () => {};

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
async function armed(quote) {
  const t = transport(quote);
  const a = new GoCometAdapter({ token: validToken(), bidEnabled: true, fetchImpl: t.fetchImpl, sleep: noSleep });
  await a.login();
  return { a, calls: t.calls };
}
const submittedGroup = (calls) => {
  const put = calls.find((c) => c.method === 'PUT');
  return put ? JSON.parse(put.init.body).quote.charges_list['11_freight_charges'] : null;
};
const line = (units, price, over = {}) => ({
  units, price, unit_name: 'TRUCK', currency: 'INR', taxable: '1', tax_id: '0',
  include_in_rank: true, is_custom_field: false, split_charge: false, ...over,
});
function multiQuote(lines) {
  const group = { display_name: 'Freight Charges' };
  for (const [key, ln] of lines) group[key] = ln;
  const units = lines.reduce((a, [, ln]) => a + ln.units, 0);
  return {
    id: 'QM', charges_list: { '11_freight_charges': group },
    total_charges: { total: { units, quote_units: lines[0][1].units, unit_name: 'TRUCK', total: 0, currency: 'INR' } },
  };
}

// The two captured 260807SXV9 descriptors, and the charge keys the SAME enquiry's quote carries.
// Kept as literals rather than derived here, so a change to chargeMatchToken that broke the join
// would show up as a failing assertion rather than as two derivations agreeing with each other.
const DESC_40FT = "5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck";
const DESC_20ODC = "1 x 20FTODC (LxWXH - 20'x8'x8'8\") 10 Ton Truck";
const KEY_40FT = "freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8.8')_25_tons";
const KEY_20ODC = "freight_charges_custom_charge_20ftodc_(lxwxh_-_20'x8'x8'8\")_10_ton";

const gcLoad = (over = {}) => ({
  id: 'PT-1', lane: { origin: 'Gurugram', destination: 'Pune' }, companyName: 'Waaree Energies',
  closesAt: Date.now() + 20 * 60_000, startsAt: Date.now() - 60_000, softClose: false, status: 'live',
  equipment: '5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T', units: 6, cargoLines: 2,
  cargoTypes: cargoTypeList([DESC_40FT, DESC_20ODC]), ...over,
});

(async () => {
  // =====================================================================================
  // 0. THE JOIN KEY. The descriptor the desk reads and the charge key the bid is written onto
  //    are the same string in two encodings - that is what makes a content join possible at all.
  // =====================================================================================
  console.log('\n0. a desk type and its freight line reduce to the same token');
  {
    const types = cargoTypeList([DESC_40FT, DESC_20ODC]);
    ok(types.length === 2 && types[0].match && types[1].match, 'every parsed type carries a join token');
    ok(types[0].match === chargeMatchToken(KEY_40FT.replace(/^freight_charges_custom_charge_/, '')),
      'the 40 ft descriptor and the 40 ft charge key agree');
    ok(types[1].match === chargeMatchToken(KEY_20ODC.replace(/^freight_charges_custom_charge_/, '')),
      'the 20 ft ODC descriptor and the 20 ft ODC charge key agree');
    ok(types[0].match !== types[1].match, 'and the two tokens are distinct, so neither can claim the other line');
    // ALL-OR-NOTHING, one rung further than the parser's: two types that reduce to the SAME token
    // cannot be told apart, and a list that keeps them would let a rate land on either line.
    ok(cargoTypeList([DESC_40FT, DESC_40FT]) === null,
      'two indistinguishable descriptors suppress the whole list rather than yielding an ambiguous join');
  }

  // =====================================================================================
  // 1. THE DESK CAPTURE. Per-type costs in, one blended cost out - the weighted mean over the
  //    load's own truck counts, so `cost` still means "what one truck of this load costs BRL".
  // =====================================================================================
  console.log('\n1. per-type costs blend to a weighted mean, and both are stored');
  {
    const types = cargoTypeList([DESC_40FT, DESC_20ODC]);
    const v = normalizeCostByType([100000, 40000], types);
    // 5 x 100,000 + 1 x 40,000 = 540,000 over 6 trucks.
    ok(v.cost === 90000, `the blend is the WEIGHTED mean, not the average of the rates (got ${v.cost}, not 70000)`);
    ok(v.types.length === 2 && v.types[0].cost === 100000 && v.types[1].cost === 40000,
      'each type keeps its own cost');
    ok(v.types[0].match === types[0].match && v.types[0].count === 5,
      'and its join token and count travel with it, so nothing downstream needs the array position');
    ok(normalizeCostByType(null, types) === null && normalizeCostByType([], types) === null,
      'nothing supplied -> null, which is the unchanged single-rate path');
    assert.throws(() => normalizeCostByType([100000], types), /each of the 2 truck types/,
      'a rate for one of two types is refused');
    assert.throws(() => normalizeCostByType([100000, 0], types), /at least Rs 1/, 'a zero rate is refused');
    assert.throws(() => normalizeCostByType([100000, 40000], [{ label: 'a', count: 5 }, { label: 'b', count: 1 }]),
      /before per-type pricing existed/, 'types with no join token refuse the per-type capture outright');
    ok(true, 'a short, zero-valued or unroutable vector is REFUSED, never quietly blended away');
  }
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12.6, 9.4, 6.3], minMarginPct: 6.3 });
    const req = await requests.createForLoad(gcLoad());
    const armedDoc = await requests.capture(req.id, { cost: '999', costByType: ['100000', '40000'] });
    ok(armedDoc.price.cost === 90000,
      `capture arms off its OWN blend and ignores the posted cost (got ${armedDoc.price.cost}, posted 999)`);
    ok(armedDoc.price.costByType && armedDoc.price.costByType.types.length === 2,
      'the vector is stored BESIDE the blended cost, not instead of it');
    // A bare cost on a re-price must not leave a vector that no longer matches it: the adapter
    // scales each line against the blend, so a stale pair puts every line at the wrong ratio.
    const reDoc = await requests.setBidOverride(req.id, { marginsPct: [12.6, 9.4, 6.3], minMarginPct: 6.3, cost: 70000 });
    ok(reDoc.price.cost === 70000 && reDoc.price.costByType === undefined,
      're-pricing with ONE cost drops the per-type vector rather than leaving a stale one behind');
    const re2 = await requests.setBidOverride(req.id, { marginsPct: [12.6, 9.4, 6.3], minMarginPct: 6.3, costByType: [90000, 36000] });
    ok(re2.price.cost === 81000 && re2.price.costByType.types[0].cost === 90000,
      'and re-pricing with a vector replaces both together');
  }

  // =====================================================================================
  // 2. UNEQUAL UNIT COUNTS - the captured 260807SXV9 shape. Each line gets the SAME margin over
  //    its OWN cost, and the load total is the sum of the lines rather than one rate x 6.
  // =====================================================================================
  console.log('\n2. two truck types, unequal counts, distinct rates');
  {
    const q = multiQuote([[KEY_40FT, line(5, 63780)], [KEY_20ODC, line(1, 42520)]]);
    const { a, calls } = await armed(q);
    const spec = normalizeCostByType([100000, 40000], cargoTypeList([DESC_40FT, DESC_20ODC]));
    // The rung: blended cost 90,000 at +10% = 99,000. Uniform, that lands 99,000 on a truck that
    // cost 100,000 - the below-cost line this whole build exists to stop.
    const r = await a.placeBid('ASY', 99000, { floor: 90000, costByType: spec });
    const g = submittedGroup(calls);
    ok(g[KEY_40FT].price === 110000, `the 40 ft line carries its own rate (got ${g[KEY_40FT].price}, expected 110000 = 99000 x 100000/90000)`);
    ok(g[KEY_20ODC].price === 44000, `the 20 ft ODC line carries a DIFFERENT rate (got ${g[KEY_20ODC].price}, expected 44000)`);
    ok(g[KEY_40FT].price > 100000 && g[KEY_20ODC].price > 40000,
      'and BOTH sit above their own type cost - which the uniform 99,000 rate did not do for the 40 ft');
    ok(r.wireTotal === 110000 * 5 + 44000 * 1,
      `wireTotal is summed line by line, not amount x 6 (got ${r.wireTotal}, expected ${110000 * 5 + 44000})`);
    // AND IT EQUALS THE UNIFORM TOTAL, which is the property that keeps this out of the engine.
    // sum(k x cost_i x units_i) = k x sum(cost_i x units_i) = amount x total units, so the number
    // the auction actually ranks is the rung the ladder chose - unchanged. Per-type pricing moves
    // the SPLIT across the lines, never the bid. If this ever stops holding, the ladder and the
    // wire have started disagreeing about what was bid and the read-back oracle is reading a lie.
    ok(r.wireTotal === 99000 * 6,
      `and the whole-load total is still the rung x 6 - only the split moved (got ${r.wireTotal})`);
    ok(r.perTypePrices && r.perTypePrices.length === 2
      && r.perTypePrices.every((p) => p.price > 0 && p.cost > 0 && p.label),
      'the result reports what each truck type was actually bid at, for a read-back oracle to check');
    ok(g[KEY_40FT].currency === 'INR' && g[KEY_20ODC].currency === 'INR',
      'and the currency is still pinned on every line we price');
    // The margin is what is held constant across the lines, which is the whole scalar-k design.
    const m0 = g[KEY_40FT].price / spec.types[0].cost, m1 = g[KEY_20ODC].price / spec.types[1].cost;
    ok(Math.abs(m0 - m1) < 0.001, `both lines carry the SAME margin over their own cost (${m0.toFixed(3)} vs ${m1.toFixed(3)})`);
  }

  // =====================================================================================
  // 3. THE PER-LINE FLOOR NOW BITES. Under the uniform write the per-line assert compared one
  //    number against one floor N times and could not fail. Here the price comes from the
  //    engine's rung and the floor from what the desk typed against THAT truck type, so the two
  //    sides have independent origins - and a vector that has drifted from the blend is caught
  //    on the line it actually harms, with nothing submitted.
  // =====================================================================================
  console.log('\n3. a below-cost rate on ONE truck type is refused');
  const specOf = (cost, a40, a20) => ({ cost, types: [
    { label: '40 ft, 25 T', match: chargeMatchToken(KEY_40FT.replace(/^freight_charges_custom_charge_/, '')), count: 5, cost: a40 },
    { label: '20 ft ODC, 10 T', match: chargeMatchToken(KEY_20ODC.replace(/^freight_charges_custom_charge_/, '')), count: 1, cost: a20 },
  ] });
  {
    // THE CASE THIS BELT EXISTS FOR: the vector and the blend the ladder was built from have come
    // apart. Here the rung was built on a blend of 120,000 while the desk's own numbers say the
    // 40 ft trucks cost 100,000 - so scaling puts that line at 90000 x 100000/120000 = 75,000, a
    // fifth below what BRL pays for the truck, while the load total still looks healthy. The
    // per-line floor is the only thing in the system that can see it: the price comes from the
    // engine's rung and the floor from the desk's own figure for THAT type, so the two sides have
    // independent origins. Under the uniform write both sides were the same number and the assert
    // could not fail at all.
    const q = multiQuote([[KEY_40FT, line(5, 63780)], [KEY_20ODC, line(1, 42520)]]);
    const { a, calls } = await armed(q);
    await assert.rejects(() => a.placeBid('FLR', 90000, { floor: 50000, costByType: specOf(120000, 100000, 40000) }),
      (e) => e.code === 'FLOOR', 'a vector that has drifted from the blend is caught on the line it under-prices');
    ok(!calls.some((c) => c.method === 'PUT'), 'and nothing was submitted');
    // The 20 ft ODC line on that same bid would have gone out at 30,000 against a 40,000 cost -
    // so it is not that one line is fine and the other is not; the refusal covers the whole bid.
  }
  {
    // The boundary, on a consistent vector: at the blended true cost the dearer line lands EXACTLY
    // on its own cost, and one rupee lower breaches it. That single rupee is what the uniform path
    // had no number capable of expressing.
    const q = multiQuote([[KEY_40FT, line(5, 63780)], [KEY_20ODC, line(1, 42520)]]);
    const { a, calls } = await armed(q);
    await assert.rejects(() => a.placeBid('FLR1', 89999, { floor: 50000, costByType: specOf(90000, 100000, 40000) }),
      (e) => e.code === 'FLOOR', 'a rupee below the blended cost puts the 40 ft line under its own and is refused');
    ok(!calls.some((c) => c.method === 'PUT'), 'nothing submitted at the boundary either');
  }
  {
    const q = multiQuote([[KEY_40FT, line(5, 63780)], [KEY_20ODC, line(1, 42520)]]);
    const { a, calls } = await armed(q);
    const spec = normalizeCostByType([100000, 40000], cargoTypeList([DESC_40FT, DESC_20ODC]));
    const r = await a.placeBid('FLR2', 90000, { floor: 50000, costByType: spec });
    ok(r.accepted === true && submittedGroup(calls)[KEY_40FT].price === 100000,
      'EXACTLY at the type cost still bids - the floor is a floor, not a margin');
    void calls;
  }

  // =====================================================================================
  // 4. THE POSITIONAL TRAP. The descriptors and the freight lines arrive on two independent
  //    fetches. Reversing the line order must NOT reverse the prices.
  // =====================================================================================
  console.log('\n4. the join is by content, so a reordered quote cannot swap the prices');
  {
    // Same quote, lines declared in the OPPOSITE order to the desk's types.
    const q = multiQuote([[KEY_20ODC, line(1, 42520)], [KEY_40FT, line(5, 63780)]]);
    const { a, calls } = await armed(q);
    const spec = normalizeCostByType([100000, 40000], cargoTypeList([DESC_40FT, DESC_20ODC]));
    await a.placeBid('REV', 99000, { floor: 50000, costByType: spec });
    const g = submittedGroup(calls);
    ok(g[KEY_40FT].price === 110000 && g[KEY_20ODC].price === 44000,
      `each rate still lands on its own truck type (40ft ${g[KEY_40FT].price}, 20ftODC ${g[KEY_20ODC].price})`);
  }

  // =====================================================================================
  // 5. WHAT IS REFUSED RATHER THAN BLENDED. A per-type vector that cannot be routed is a loud
  //    refusal: falling back to one rate the desk did not type is the failure this build is for.
  // =====================================================================================
  console.log('\n5. an unroutable vector refuses, and never silently reverts to one rate');
  {
    const mk = () => multiQuote([[KEY_40FT, line(5, 63780)], [KEY_20ODC, line(1, 42520)]]);
    const spec = () => normalizeCostByType([100000, 40000], cargoTypeList([DESC_40FT, DESC_20ODC]));

    // (a) the load changed shape - three types priced, two lines on the quote
    {
      const { a, calls } = await armed(mk());
      const s = spec(); s.types.push({ label: 'x', match: 'zzz', count: 1, cost: 1000 });
      await assert.rejects(() => a.placeBid('S1', 99000, { floor: 50000, costByType: s }),
        (e) => e.code === 'COST_TYPE_UNMATCHED', 'a type count that no longer matches the quote is refused');
      ok(!calls.some((c) => c.method === 'PUT'), 'nothing submitted on a shape change');
    }
    // (b) a type that matches no line at all
    {
      const { a, calls } = await armed(mk());
      const s = spec(); s.types[1].match = 'somethingelse';
      await assert.rejects(() => a.placeBid('S2', 99000, { floor: 50000, costByType: s }),
        (e) => e.code === 'COST_TYPE_UNMATCHED', 'a type matching no freight line is refused');
      ok(!calls.some((c) => c.method === 'PUT'), 'nothing submitted on an unmatched type');
    }
    // (c) the matched line's quantity moved under us
    {
      const { a, calls } = await armed(multiQuote([[KEY_40FT, line(4, 63780)], [KEY_20ODC, line(2, 42520)]]));
      await assert.rejects(() => a.placeBid('S3', 99000, { floor: 50000, costByType: spec() }),
        (e) => e.code === 'COST_TYPE_UNMATCHED', 'a line whose units no longer match the priced count is refused');
      ok(!calls.some((c) => c.method === 'PUT'), 'nothing submitted on a quantity change');
    }
    // (d) an unusable blend base - the divisor of every per-line rate
    {
      const { a } = await armed(mk());
      const s = spec(); s.cost = 0;
      await assert.rejects(() => a.placeBid('S4', 99000, { floor: 50000, costByType: s }),
        (e) => e.code === 'COST_TYPE_UNMATCHED', 'a zero blend base is refused rather than dividing by it');
    }
  }

  // =====================================================================================
  // 6. THE SINGLE-TYPE PATH IS UNTOUCHED. Both halves: a one-line quote with no vector, and the
  //    multi-line quote with no vector - which is every load priced before today.
  // =====================================================================================
  console.log('\n6. a load priced with ONE rate behaves exactly as it did');
  {
    const single = {
      id: 'QS', charges_list: { '11_freight_charges': { display_name: 'Freight Charges', [KEY_40FT]: line(187, 12386) } },
      total_charges: { total: { units: 187, quote_units: 187, unit_name: 'TRUCK', total: 0, currency: 'INR' } },
    };
    const { a, calls } = await armed(single);
    const r = await a.placeBid('ONE', 12000, { floor: 10000 });
    const g = submittedGroup(calls);
    ok(r.accepted === true && g[KEY_40FT].price === 12000, 'the bare per-unit price goes on the one line, unchanged');
    ok(r.wireTotal === 12000 * 187, 'and wireTotal is still amount x units');
    ok(r.perTypePrices === null, 'perTypePrices is null, so a reader cannot mistake one rate for a per-type breakdown');
    ok(r.pricedLines.length === 1 && r.pricedLines[0].price === 12000,
      'the priced-line record carries the price it wrote');
  }
  {
    const q = multiQuote([[KEY_40FT, line(5, 63780)], [KEY_20ODC, line(1, 42520)]]);
    const { a, calls } = await armed(q);
    const r = await a.placeBid('UNI', 90000, { floor: 50000 });
    const g = submittedGroup(calls);
    ok(g[KEY_40FT].price === 90000 && g[KEY_20ODC].price === 90000,
      'a multi-type load with NO vector still gets the uniform rate on every line');
    ok(r.wireTotal === 90000 * 6 && r.perTypePrices === null, 'and reports the uniform total');
  }
  {
    // A single-type load whose desk gave one cost must not acquire a vector anywhere on the way
    // to the engine: normalizeCostByType refuses, and armFromRequest carries nothing.
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12.6, 9.4, 6.3], minMarginPct: 6.3 });
    const req = await requests.createForLoad(gcLoad({
      id: 'PT-SINGLE', units: 6, cargoLines: 1, equipment: '6 x 40 ft, 25 T',
      cargoTypes: cargoTypeList(["6 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck"]),
    }));
    const doc = await requests.capture(req.id, { cost: 63780 });
    ok(doc.price.cost === 63780 && doc.price.costByType === undefined,
      'a one-type load stores the cost alone, exactly as before');
    let seen = null;
    armFromRequest({ caps: { multiCargoBidSupported: true }, arm: (meta) => { seen = meta; return null; } },
      Object.assign({}, doc, { load: Object.assign({}, doc.load, { rules: { pricingMode: 'flat' } }) }));
    ok(seen && seen.rules && seen.rules.costByType === undefined,
      'and nothing per-type reaches the engine on a single-type load');
  }

  // =====================================================================================
  // 7. THE CARRY PATH. costByType rides the LoadRules the way transitDays does, so _bidOpts hands
  //    it to the adapter and arm() persists it on the durable intent - no engine change at all.
  // =====================================================================================
  console.log('\n7. the vector reaches the adapter through the rules, and only where usable');
  {
    const store = new MemoryStore();
    const requests = new PriceRequestStore({ store, marginsPct: [12.6, 9.4, 6.3], minMarginPct: 6.3 });
    const req = await requests.createForLoad(gcLoad());
    const doc = await requests.capture(req.id, { costByType: [100000, 40000] });
    const withRules = Object.assign({}, doc, { load: Object.assign({}, doc.load, { rules: { pricingMode: 'flat' } }) });
    let seen = null;
    armFromRequest({ caps: { multiCargoBidSupported: true }, arm: (meta) => { seen = meta; return null; } }, withRules);
    ok(seen.rules.costByType && seen.rules.costByType.cost === 90000,
      'the blended base and the vector both reach the engine as a LoadRules fact');
    ok(seen.rules.pricingMode === 'flat', 'and the load\'s existing rules are carried through beside it');
    // A portal that prices one line must never be handed a vector: the same capability doctrine
    // bidVehicleCount already uses, read off the adapter and never off a portal name.
    let seen2 = null;
    armFromRequest({ caps: { multiCargoBidSupported: false }, arm: (meta) => { seen2 = meta; return null; } }, withRules);
    ok(seen2.rules.costByType === undefined,
      'a portal that cannot price several lines is not handed a per-type vector');
  }

  // =====================================================================================
  // 8. THE ASK. One truck line per type, in the shape the single-type line already uses. A
  //    variable-length list appended to a line that already has content wraps mid-phrase on a
  //    phone - "10" and "T" end up on different lines - which is what this replaced.
  // =====================================================================================
  console.log('\n8. the WhatsApp ask gives every truck type its own line');
  {
    const { renderMessage } = require('../src/notify/waTemplates');
    const base = { shipper: 'Waaree Energies Ltd.', laneFrom: 'Gurugram 122051', laneTo: 'Pune 410501',
      closesText: '20-08-2026 11:45 AM', link: 'http://x/price/t', loadId: '260807SXV9' };
    const multi = renderMessage('price_needed', Object.assign({}, base, {
      cargo: '5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T',
      cargoTypes: [{ label: '40 ft, 25 T', count: 5 }, { label: '20 ft ODC, 10 T', count: 1 }],
    }));
    ok(multi.includes('\u{1F69B} 5 x 40 ft, 25 T\n\u{1F69B} 1 x 20 ft ODC, 10 T'),
      'each truck type gets its own line, each opening with the truck glyph');
    ok(!/truck types/.test(multi),
      'and nothing counts the types out for the reader - two lines already say it');
    ok(!multi.includes('40 ft, 25 T + 1 x'), 'the joined one-line form is gone');

    // The single-type ask is the control, and it is byte-identical to what it renders today -
    // including the weight half, which a multi-type load has no per-type attribution for.
    const single = renderMessage('price_needed', Object.assign({}, base, {
      cargo: '6 x 40 ft, 25 T', weight: 25, weightUnit: 'MT',
    }));
    ok(single.includes('\u{1F69B} 6 x 40 ft, 25 T . 25 MT'), 'a one-type ask keeps the vehicle . weight line unchanged');
    ok(single.split('\u{1F69B}').length === 2, 'and carries exactly one truck line');
  }

  // =====================================================================================
  // 9. THE UNTRUSTED POST. The page computes the blend client-side to drive the band preview and
  //    posts it as a hidden `cost`, so every server-side gate has to judge the blend it derives
  //    ITSELF - otherwise a curl (or a stale tab, or a dead page script) walks a plausible cost
  //    past the clerical-error floor and arms a load at rates nobody checked.
  // =====================================================================================
  console.log('\n9. the server blends the posted rates itself and gates on its own figure');
  {
    const { app, requests: webRequests, stacks } = require('../src/web/server');
    const adapter = new GoCometAdapter({ token: null, bidEnabled: true });
    // `arm` is reassigned per case below so the confirmation card can be driven with a real ladder -
    // it is the ladder that produces the per-line opening/floor figures under test.
    const engineStub = { caps: adapter.capabilities(), snapshot: () => [],
      planPreview: () => ({ ladder: [], floor: 0, rungCount: 0 }), arm: () => null, schedule: () => null };
    stacks.push({
      account: { accountId: 'gocomet-primary', label: 'GoComet' },
      tag: { accountId: 'gocomet-primary', label: 'GoComet' },
      platformKey: 'gocomet', adapter, engine: engineStub,
    });
    const srv = app.listen(0);
    await new Promise((res) => srv.once('listening', res));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const post = (url, body) => new Promise((res, rej) => {
      const u = new URL(url);
      const data = new URLSearchParams(body).toString();
      const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(data) } },
      (rs) => { let b = ''; rs.on('data', (d) => { b += d; }); rs.on('end', () => res({ status: rs.statusCode, text: b })); });
      rq.on('error', rej); rq.end(data);
    });
    const seed = async (id) => webRequests.createForLoad(
      Object.assign(gcLoad({ id }), { account: { accountId: 'gocomet-primary', label: 'GoComet' } }),
      { deadlineAt: Date.now() + 19 * 60_000, platformKey: 'gocomet' });

    const r1 = await seed('HTTP-PT1');
    const ok1 = await post(`${base}/price/${r1.id}`, { cost: '1', cost_type_0: '100000', cost_type_1: '40000' });
    const d1 = await webRequests.getByToken(r1.id);
    ok(ok1.status === 200 && d1.status === 'armed', `a per-type capture arms over HTTP (status ${ok1.status}, ${d1.status})`);
    ok(d1.price.cost === 90000, `and arms at the SERVER's blend, not the posted cost of 1 (got ${d1.price.cost})`);
    ok(d1.price.costByType.types.length === 2 && d1.price.costByType.types[0].match,
      'the stored vector carries each type\'s join token, ready for the write path');

    // THE CONFIRMATION PAGE (CW-213, the server-rendered half). This response body is the screen the
    // desk sees the instant they submit - before any WhatsApp message - and it used to confirm the
    // blend as "Cost", i.e. hand back a number they never typed as the thing that was saved. The
    // reported case is exactly this: entered 45,000 and 28,000, page read "Cost Rs 39333".
    ok(/<b>Rs 1,00,000<\/b> per truck/.test(ok1.text) && /<b>Rs 40,000<\/b> per truck/.test(ok1.text),
      'the confirmation echoes BOTH entered rates, each marked per truck');
    ok(!/Cost <b>/.test(ok1.text) && !/\b90,?000\b/.test(ok1.text),
      'and never presents the blend as the saved Cost - the figure the desk did not enter is absent');
    ok(/Your rates for load HTTP-PT1/.test(ok1.text) && />Rates saved</.test(ok1.text),
      'the lead line and heading are plural and name no single cost, because the load has none');

    // THE OPENING AND FLOOR THE WIRE WILL ACTUALLY CARRY, per line. A blended rung is not a
    // prediction about any truck on this load: with the fix in place the adapter re-applies the rung
    // as a multiplier over each type's own rate, so a card printing the blended figures under-reports
    // the dearer type's opening bid and can advertise an opening BELOW the rate on the same screen.
    // Ladder [1,00,800 -> 96,000 -> 91,800] over a 90,000 blend; every figure below is the exact
    // Math.round(rung x cost / base) of gocometAdapter.js:486-488.
    engineStub.arm = () => ({ ladder: [100800, 96000, 91800] });
    const r3 = await seed('HTTP-PT3');
    const ok3 = await post(`${base}/price/${r3.id}`, { cost: '1', cost_type_0: '100000', cost_type_1: '40000' });
    ok(/opens at <b>Rs 1,12,000<\/b>, never below Rs 1,02,000/.test(ok3.text),
      'the dearer type opens at its OWN scaled rung (1,00,800 x 1,00,000 / 90,000 = 1,12,000)');
    ok(/opens at <b>Rs 44,800<\/b>, never below Rs 40,800/.test(ok3.text),
      'and the cheaper type at its own (1,00,800 x 40,000 / 90,000 = 44,800)');
    ok(!/1,00,800|91,800/.test(ok3.text),
      'the blended rungs themselves never appear - no truck on this load is quoted at either');

    // THE MAX IS LOAD-BEARING (not a percentage). A band whose floor rung sits BELOW the blend - the
    // zero-floor customer default - scales to 94,444 on the 1,00,000 type, i.e. under the rate the
    // desk just typed. gocometAdapter.js:490 takes max(own cost, scaled), so the entered rate binds.
    // A card that scaled a percentage instead would promise to bid below their own cost.
    engineStub.arm = () => ({ ladder: [95000, 85000] });
    const r4 = await seed('HTTP-PT4');
    const ok4 = await post(`${base}/price/${r4.id}`, { cost: '1', cost_type_0: '100000', cost_type_1: '40000' });
    ok(/never below Rs 1,00,000/.test(ok4.text) && !/94,444/.test(ok4.text),
      'a floor rung under the blend floors the dearer type at its OWN cost, never at the scaled figure');
    engineStub.arm = () => null;

    // THE CEILING-DEAD CARD ON A PER-TYPE LOAD. ceilingDeadPlan's `floor` is buildBandLadder's
    // operating floor over the BLEND (pricing.js:113-115), so it is a rupee figure nobody typed and
    // no truck is held at - the wire holds each line at max(own rate, scaled floor). Printing it as
    // the desk's own lowest figure is CW-213 again on the card written to end it. The customer's cap
    // is a published number off the load's rules and is true on any load, so it stays.
    engineStub.planPreview = () => ({ ladder: [], floor: 94500, rungCount: 0, willNotBid: 'ceiling_below_floor', ceiling: 80000 });
    const r5 = await seed('HTTP-PT5');
    const ok5 = await post(`${base}/price/${r5.id}`,
      { cost: '1', cost_type_0: '100000', cost_type_1: '40000', ceiling_ack: '1' });
    ok(/Nothing will be bid/.test(ok5.text) && /max bid on this load is Rs 80,000/.test(ok5.text),
      'a ceiling-dead per-type card still names the customer\'s cap, which is a published figure');
    ok(!/94,500/.test(ok5.text) && !/lowest price/i.test(ok5.text),
      'and never states a blended figure as the lowest the desk would go on a load with no single cost');
    // A PER-LINE COMPARATIVE IS FALSE HERE, which is why the reason is a whole-load claim. The cheap
    // line's wire floor is max(40,000, round(94,500 x 40,000 / 90,000)) = 42,000 (gocometAdapter.js:486-490),
    // well UNDER the Rs 80,000 cap - so "the cap is less than we can bid on the rates below" would be
    // false about a rate printed directly beneath it. The refusal is decided on the blended ladder.
    ok(!/less than we can bid on the rates/.test(ok5.text)
      && /the load as a whole prices above that/.test(ok5.text),
      'the reason is a whole-load claim, never a per-line one the cheaper rate on the same card falsifies');
    ok(/<b>Rs 1,00,000<\/b> per truck/.test(ok5.text) && /<b>Rs 40,000<\/b> per truck/.test(ok5.text),
      'the entered rates are still listed, so the sentence has something true to point at');
    engineStub.planPreview = () => ({ ladder: [], floor: 0, rungCount: 0 });

    // The mirror: a plausible-looking `cost` beside rates that blend to nothing must be refused.
    // If any gate read the posted number this would arm at Rs 90,000 and bid Rs 3 a truck.
    const r2 = await seed('HTTP-PT2');
    const bad = await post(`${base}/price/${r2.id}`, { cost: '90000', cost_type_0: '3', cost_type_1: '2' });
    const d2 = await webRequests.getByToken(r2.id);
    ok(bad.status === 400 && d2.status === 'awaiting_price',
      `rates that blend to a clerical-error figure are refused even under a plausible posted cost (status ${bad.status}, ${d2.status})`);
    srv.close();
  }

  // =====================================================================================
  // 10. THE RECEIPT (CW-213). The blend is the right BASE for the ladder and the wrong thing to
  //     print as "Your Rate". Anchored on 260906V7TB - three 40 ft at 60,000 and one pickup at
  //     30,000, blending to 52,500 - and on 260907C2I8, the load the desk reported on 2026-09-08
  //     as "entered 45,000, message showed 39,333".
  // =====================================================================================
  console.log('\n10. the receipt shows every entered rate, never the blend');
  {
    const { Notifier } = require('../src/notify/notifier');
    const { renderMessage } = require('../src/notify/waTemplates');
    const { buildBandLadder } = require('../src/engine/pricing');

    const V7TB_40FT = "3 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck";
    const V7TB_PICKUP = '1 x PICKUP 1 TON Truck';
    const WAAREE = { marginsPct: [9, 7.2, 1.8], minMarginPct: 1.8 };

    const receiptFor = async (id, descriptors, rates) => {
      const store = new MemoryStore();
      const requests = new PriceRequestStore({ store, ...WAAREE });
      const types = cargoTypeList(descriptors);
      const req = await requests.createForLoad(gcLoad({
        id, cargoTypes: types, cargoLines: descriptors.length,
        // The load's OWN total, so perVehicleNote's multi-vehicle predicate is live and its
        // " (per vehicle x N vehicles)" trailer has to be suppressed rather than merely absent.
        units: types.reduce((a, t) => a + t.count, 0),
      }), { platformKey: 'gocomet' });
      const doc = await requests.capture(req.id, { costByType: rates });
      const plan = buildBandLadder({ cost: doc.price.cost, ...WAAREE });
      const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'https://bid.example' });
      let payload = null;
      notifier.alert = async (kind, data) => { payload = { kind, data }; return true; };
      await notifier.confirmSubmitted(doc, plan.ladder);
      return { doc, plan, payload, body: renderMessage(payload.kind, payload.data) };
    };

    const v7tb = await receiptFor('260906V7TB', [V7TB_40FT, V7TB_PICKUP], [60000, 30000]);
    // (60,000 x 3 + 30,000 x 1) / 4 = 52,500, and Waaree's 1.8% floor over it is 53,445 - the
    // exact pair the closed record carries.
    ok(v7tb.doc.price.cost === 52500 && v7tb.plan.floor === 53445,
      `260906V7TB blends to 52,500 with a 53,445 floor (got ${v7tb.doc.price.cost} / ${v7tb.plan.floor})`);
    // The WHOLE cell, as one literal. Substring checks for the two amounts pass against a body
    // that prints them with no label, with no count, or with the labels SWAPPED - and a rate on
    // the wrong truck type is the reorder failure section 4 exists to defend against. Amount,
    // label, count, order and the continuation glyph are all pinned by this one string.
    ok(v7tb.body.includes('\u{1F4B0} *Your Rate* - ₹60,000 per truck . 40 ft, 25 T x3\n\u{1F4B0} ₹30,000 per truck . PICKUP, 1 T x1'),
      'each entered rate renders against its own truck type and count, in the load\'s own type order');
    // THE UNIT, on every line and not once as a header. Without it "₹60,000 . 40 ft, 25 T x3" reads
    // equally as that line's total, which is a 3x misread on the message the desk reconciles its own
    // entry against - and the load-total trailer that used to be the only "per vehicle" marker on
    // this receipt is suppressed on the per-type path.
    ok((v7tb.body.match(/per truck/g) || []).length === 2,
      'every rate line states the unit, so no line can be read as a line total');
    ok(!/52,500/.test(v7tb.body),
      'and the blended mean, a number the desk did not enter, appears nowhere');
    // vehicleCount is forced on rather than plumbed through the fixture's basis: the point under
    // test is the trailer's suppression, and a fixture whose basis leaves the count null would
    // assert nothing.
    ok(!/per vehicle x/.test(renderMessage('price_submitted',
      Object.assign({}, v7tb.payload.data, { vehicleCount: 4 }))),
    'the load-total multiplier note is suppressed - each rate already carries its own count');
    ok(!/never below ₹53,445/.test(v7tb.body) && /never below \+1\.8%/.test(v7tb.body),
      'the bidding contract states the margin, not two rung prices no truck is quoted at');
    // A CEILING-CAPPED LADDER. capLadderToCeiling collapses every rung above a shipper ceiling into
    // ONE rung at the ceiling, still rungIndex 0, so the band's +9% is not what goes out. Stating
    // the band there would claim a 9% opening on a bid placed at 2.86% - and this branch has
    // dropped the rupee figure that used to contradict it, so the percent has to carry itself.
    const capped = renderMessage('price_submitted',
      Object.assign({}, v7tb.payload.data, { openingBid: 54000, floorBid: 53445 }));
    ok(/bid from\* - \+2\.86% on each rate above/.test(capped) && /never below \+1\.8%/.test(capped),
      'a ceiling-capped opening rung is reported at its true margin, not the band\'s anchor');

    // The reported case, verbatim: entered 45,000 and 28,000, receipt read 39,333.
    const c2i8 = await receiptFor('260907C2I8',
      ["2 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck", '1 x 17FT 5 TONS Truck'], [45000, 28000]);
    ok(c2i8.doc.price.cost === 39333, `260907C2I8 still blends to 39,333 for the ladder (got ${c2i8.doc.price.cost})`);
    ok(/45,000/.test(c2i8.body) && /28,000/.test(c2i8.body) && !/39,333/.test(c2i8.body),
      'and the desk sees 45,000 and 28,000 on the receipt, never 39,333');

    // The single-rate path is untouched: no vector, no change to a receipt the desk already reads.
    const one = await (async () => {
      const store = new MemoryStore();
      const requests = new PriceRequestStore({ store, ...WAAREE });
      const req = await requests.createForLoad(gcLoad({ id: 'PT-RCPT-1', units: 4, cargoLines: 1,
        cargoTypes: cargoTypeList([V7TB_40FT]) }), { platformKey: 'gocomet' });
      const doc = await requests.capture(req.id, { cost: 60000 });
      const notifier = new Notifier({ mode: 'dashboard', baseUrl: 'https://bid.example' });
      let payload = null;
      notifier.alert = async (kind, data) => { payload = { kind, data }; return true; };
      await notifier.confirmSubmitted(doc, buildBandLadder({ cost: 60000, ...WAAREE }).ladder);
      return renderMessage(payload.kind, payload.data);
    })();
    ok(/Your Rate\* - ₹60,000/.test(one) && /never below ₹/.test(one),
      'a one-rate receipt renders exactly as before');
  }

  assert.strictEqual(fail, 0, `${fail} GoComet per-truck-type cost checks failed`);

  // COMPLETION SENTINEL - run-tests.js grades this file by its EXIT CODE ALONE, so a body that
  // exits 0 early scores as a silent green having asserted nothing. Assert a FLOOR on the checks
  // that actually ran. Raise it when adding.
  const MIN_EXPECTED_CHECKS = 66;
  assert.ok(pass >= MIN_EXPECTED_CHECKS,
    `completion sentinel: only ${pass} checks ran, expected at least ${MIN_EXPECTED_CHECKS} - the suite exited early and would otherwise have scored as a silent green`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
