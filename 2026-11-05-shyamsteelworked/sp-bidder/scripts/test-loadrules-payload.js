'use strict';
/**
 * GOLDEN PAYLOAD CONTRACT + BYTE-IDENTICAL proof for the LoadRules pipeline (Module 2 foundation).
 *
 * This pins the exact SuperProcure createV2 wire contract - method, URL, and the FULL body - that
 * the live bot sends, so a future field rename / dropped isWeb / broken carrier param can never pass
 * `npm test` silently (the class of defect the audit found had ZERO tests).
 *
 * It carries TWO proofs for carrier-per-load (the first mechanic to consume the LoadRules pipeline):
 *   1. SAME-CARRIER byte-identity (the safety property): for the currently-live customers (Syngenta
 *      via 10686, Durian via 4441) the load's branchCarrierCarrierId EQUALS the account carrier, so
 *      routing a real LoadRules through placeBid -> buildBidPayload produces a body BYTE-IDENTICAL to
 *      the pre-pipeline empty-opts path. No regression on the loads we bid today.
 *   2. FOREIGN-CARRIER routing (the new behaviour): when the load's branchCarrierCarrierId differs
 *      from the account carrier (e.g. a Havells 5963 load routed through the master account, carrier
 *      2667), BOTH the ?carrier= query param and the carrierBranchId body field become the load's
 *      carrier. Absent branchCarrierCarrierId falls back to the account carrier (fail-safe).
 *
 * And THREE proofs for conditional transit time (the second mechanic):
 *   3. TRANSIT-OFF byte-identity (the safety property): a load withOUT loadIsTransitTimeOn - which
 *      is every load the bot bids today (Syngenta/Durian are transit-off) - keeps transitTime:null
 *      and the FULL pinned body, byte-identical to the pre-transit build (sections 1-3, 6, 7).
 *   4. TRANSIT-REQUIRED golden (the new behaviour): a loadIsTransitTimeOn load with capture-provided
 *      transitDays emits transitTime as a STRING of days ("3" - the exact shape proven live on SIKA:
 *      null -> HTTP 400, "3" -> 201), sticky across every rung/revision, with every OTHER field
 *      still matching the pinned contract (section 8).
 *   5. FAIL CLOSED: a transit-required load whose days were never captured is REFUSED
 *      (MISSING_TRANSIT_TIME) before any request is sent - never the silent bid-and-400 (section 9).
 *
 *   node scripts/test-loadrules-payload.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered HERE, above every check, and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE. An async file that ends early - a
// swallowed rejection, an unref'd timer letting the loop drain, a stray `return` - reaches exit 0
// having asserted nothing and reads as a silent green zero-assertion run. The "N/N checks passed"
// line at the bottom is not a guard: it prints whatever `pass` happens to be, and every path that
// exits early skips it entirely. Registering the handler before any case runs is what makes it fire
// on every path out of the process. Same shape as test-rejection-classify-contract.js.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 11;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`
COMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

const API = 'https://api.superprocure.com';

// a fetch stub that CAPTURES the outgoing request, then answers 201 (json-only shape, exactly like
// the real accepted path - the text-first read falls back to .json()).
function capturingAdapter(carrierId, captured) {
  const fetchImpl = async (url, init) => {
    captured.url = url;
    captured.method = init.method;
    captured.bodyRaw = init.body;
    captured.body = JSON.parse(init.body);
    return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) };
  };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return a;
}

// the pinned body EXCEPT requestTime (Date.now(), checked separately as a finite number).
function expectedBody({ load, carrier, amount }) {
  return {
    load, carrierBranchId: carrier, amount,
    bidNotes: null, type: 'E-AUCTION', in: 'FTL', vcq: -1,
    loadLotId: null, reportingTime: null, transitTime: null,
    vehicleTypes: [], bidDiscount: 0, isOfferRate: false, isWeb: 1,
  };
}
// key ORDER is part of the contract this file pins, so a per-tonne expectation is built by
// overriding fields on the same literal rather than spreading a second object after it.
function expectedPmtBody({ load, carrier, amount }) {
  const b = expectedBody({ load, carrier, amount });
  b.in = 'PMT'; // the true basis; loadShipmentType lies "FTL" on every PMT load
  return b;
}
// strip the one non-deterministic field so two payloads can be compared for byte-identity.
function withoutRequestTime(body) { const b = { ...body }; delete b.requestTime; return b; }

// a representative raw SP load for a currently-live customer (fields _mapLoad/deriveLoadRules read).
// loadIsTransitTimeOn is 0: the currently-live customers (Syngenta, Durian) are transit-OFF on the
// real board (the 2026-07-14 census puts the flag on Havells/KEI/Cords/Dynamic/SIKA, never these
// two), and the pinned wire below carries transitTime:null accordingly. An earlier revision of this
// fixture set the flag to 1, which was inert while the builder ignored it; now that the transit
// mechanic is live, the fixture must say what the real loads say. The transit-ON golden has its own
// fixture + pins (sections 8-9).
function rawLoad({ id, carrier }) {
  return {
    id, companyName: 'Syngenta India', branchCarrierCarrierId: carrier, branchFreighterId: carrier,
    loadIsTransitTimeOn: 0, ceilingPrice: 120000, branchQuoteType: 'PER_TRUCK', brancheUnit: 'MT',
    branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3, loadShipmentType: 'FTL',
  };
}

(async () => {
  // ---- 1 + 2. golden contract for the two currently-live customers, THROUGH placeBid w/ a real LoadRules ----
  for (const c of [
    { name: 'Syngenta', carrier: 10686, load: 23088090, price: 95000, amount: 95000 },
    { name: 'Durian', carrier: 4441, load: 22990011, price: 87650.4, amount: 87650 }, // proves amount rounds
  ]) {
    const captured = {};
    const a = capturingAdapter(c.carrier, captured);
    const rules = deriveLoadRules(rawLoad({ id: String(c.load), carrier: c.carrier }));
    const res = await a.placeBid(String(c.load), c.price, rules);

    assert.strictEqual(res.accepted, true, `${c.name}: 201 accepted`);
    assert.strictEqual(captured.method, 'POST', `${c.name}: method is POST`);
    assert.strictEqual(captured.url, `${API}/sp/bids/createV2?id=${c.load}&carrier=${c.carrier}`,
      `${c.name}: exact createV2 URL with id + account carrier`);
    assert.strictEqual(typeof captured.body.requestTime, 'number' , `${c.name}: requestTime is a number`);
    assert.ok(Number.isFinite(captured.body.requestTime), `${c.name}: requestTime is finite`);
    assert.deepStrictEqual(withoutRequestTime(captured.body),
      expectedBody({ load: c.load, carrier: c.carrier, amount: c.amount }),
      `${c.name}: FULL createV2 body matches the pinned contract (same-carrier: routed carrier == account carrier)`);
    ok(`golden contract pinned for ${c.name} (carrier ${c.carrier}) - method + URL + full body`);
  }

  // ---- 3. BYTE-IDENTICAL: a LoadRules-carried bid == the pre-refactor (empty-opts) bid, same load ----
  {
    const carrier = 10686, load = 23088090, price = 88888.7;
    const capRules = {}, capEmpty = {}, capEngine = {};
    const aR = capturingAdapter(carrier, capRules);
    const aE = capturingAdapter(carrier, capEmpty);
    const aG = capturingAdapter(carrier, capEngine);
    const rules = deriveLoadRules(rawLoad({ id: String(load), carrier }));
    await aR.placeBid(String(load), price, rules);                       // NEW path: LoadRules as opts
    await aE.placeBid(String(load), price, {});                          // OLD path: empty opts (what the bot sent pre-refactor)
    await aG.placeBid(String(load), price, { ...rules, floor: 50000 });  // EXACT engine shape: _bidOpts = {...rules, floor}

    assert.strictEqual(capRules.method, capEmpty.method, 'method identical');
    assert.strictEqual(capRules.url, capEmpty.url, 'URL identical (same-carrier: routed carrier == account carrier)');
    // the wire STRING is byte-identical once the timestamp is normalised (key order + every value)
    const norm = (raw) => { const b = JSON.parse(raw); b.requestTime = 0; return JSON.stringify(b); };
    assert.strictEqual(norm(capRules.bodyRaw), norm(capEmpty.bodyRaw),
      'the createV2 body is BYTE-IDENTICAL through the LoadRules path vs the empty-opts path');
    assert.strictEqual(norm(capEngine.bodyRaw), norm(capEmpty.bodyRaw),
      'the engine\'s exact opts shape ({...rules, floor}) is ALSO byte-identical (floor is not a wire field)');
    assert.strictEqual(JSON.parse(capRules.bodyRaw).amount, 88889, 'amount rounded consistently on both paths');
    ok('byte-identical: LoadRules-path AND engine {...rules,floor}-path == pre-refactor empty-opts body');
  }

  // ---- 4. LoadRules field names DO NOT collide with any wire key (the invariant that makes 3 hold) ----
  {
    const rules = deriveLoadRules(rawLoad({ id: '1', carrier: 10686 }));
    const wireKeys = ['load', 'carrierBranchId', 'amount', 'bidNotes', 'type', 'in', 'vcq', 'loadLotId',
      'reportingTime', 'transitTime', 'requestTime', 'vehicleTypes', 'bidDiscount', 'isOfferRate', 'isWeb'];
    const collisions = Object.keys(rules).filter((k) => wireKeys.includes(k));
    assert.deepStrictEqual(collisions, [], `LoadRules keys must not collide with wire keys - collisions: ${collisions}`);
    // and it really does carry the follow-on carrier fact (inert here, consumed by the carrier PR)
    assert.strictEqual(rules.branchCarrierCarrierId, 10686, 'LoadRules carries branchCarrierCarrierId as a fact');
    // transitDays is merged onto the rules at arm time (armFromRequest), not derived - assert the
    // KEY itself is not a wire key, so the merged object stays disjoint too (transitTime, the wire
    // field, is only ever written by buildBidPayload).
    assert.ok(!wireKeys.includes('transitDays'), 'transitDays (the capture-side key) is not a createV2 wire key');
    ok('LoadRules keys are disjoint from the createV2 wire keys (why routing rules as opts stays byte-identical)');
  }

  // ---- 5. FOREIGN-carrier load: the load's carrier != the account carrier -> BOTH the ?carrier=
  //         query param AND the carrierBranchId body field become rules.branchCarrierCarrierId. This
  //         is the master-account fix: a Havells 5963 load bid from the 2667 login must go out as 5963
  //         (bidding as 2667 is the HTTP 400 that killed 27 Renewsys bids). ----
  {
    const accountCarrier = 2667, foreignCarrier = 5963, load = 23092558, price = 91000;
    const captured = {};
    const a = capturingAdapter(accountCarrier, captured);
    // a load whose branch is mapped to carrier 5963, bid from the master (2667) login
    const rules = deriveLoadRules(rawLoad({ id: String(load), carrier: foreignCarrier }));
    assert.strictEqual(rules.branchCarrierCarrierId, foreignCarrier, 'precondition: rules carry the foreign carrier 5963');
    const res = await a.placeBid(String(load), price, rules);

    assert.strictEqual(res.accepted, true, 'foreign-carrier bid accepted (201)');
    assert.strictEqual(captured.url, `${API}/sp/bids/createV2?id=${load}&carrier=${foreignCarrier}`,
      'the ?carrier= query param is the LOAD carrier (5963), NOT the account carrier (2667)');
    assert.strictEqual(captured.body.carrierBranchId, foreignCarrier,
      'the carrierBranchId body field is the LOAD carrier (5963), NOT the account carrier (2667)');
    assert.strictEqual(res.carrierSent, foreignCarrier, 'placeBid reports the routed carrier as carrierSent');
    // only the carrier moved: every OTHER wire field still matches the pinned contract
    assert.deepStrictEqual(withoutRequestTime(captured.body),
      expectedBody({ load, carrier: foreignCarrier, amount: price }),
      'only the carrier moved; every other createV2 field matches the pinned contract');
    ok('foreign-carrier load routes ?carrier= + carrierBranchId to rules.branchCarrierCarrierId (5963 via 2667)');
  }

  // ---- 6. FAIL-SAFE: rules with NO branchCarrierCarrierId -> the carrier falls back to the account
  //         carrier, byte-for-byte the same as today. A load whose carrier never resolved bids exactly
  //         as it does today rather than under a wrong/undefined carrier. ----
  {
    const accountCarrier = 2667, load = 23093593, price = 25900;
    const capAbsent = {}, capToday = {};
    const aAbsent = capturingAdapter(accountCarrier, capAbsent);
    const aToday = capturingAdapter(accountCarrier, capToday);
    // rules derived from a raw load that carries NO branchCarrierCarrierId at all
    const rules = deriveLoadRules({ id: String(load), branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(rules.branchCarrierCarrierId, null, 'precondition: rules carry no carrier (null)');
    await aAbsent.placeBid(String(load), price, rules);   // absent-carrier LoadRules
    await aToday.placeBid(String(load), price, {});        // pre-pipeline empty-opts path

    assert.strictEqual(capAbsent.url, `${API}/sp/bids/createV2?id=${load}&carrier=${accountCarrier}`,
      'absent carrier falls back to the account carrier on the ?carrier= param');
    assert.strictEqual(capAbsent.body.carrierBranchId, accountCarrier,
      'absent carrier falls back to the account carrier on carrierBranchId');
    const norm = (raw) => { const b = JSON.parse(raw); b.requestTime = 0; return JSON.stringify(b); };
    assert.strictEqual(norm(capAbsent.bodyRaw), norm(capToday.bodyRaw),
      'absent-carrier LoadRules bid is BYTE-IDENTICAL to the pre-pipeline empty-opts bid');
    ok('absent branchCarrierCarrierId -> fail-safe fallback to the account carrier (byte-identical)');
  }

  // ---- 7. TYPE-ROBUST byte-identity: SuperProcure can return carrier ids as STRINGS on the wire (its
  //         socket frames do - spSocket Number()-normalises for exactly this). A same-carrier load
  //         whose branchCarrierCarrierId arrives as the STRING "10686" must still bid byte-identically
  //         to the numeric account carrier 10686 - number on the wire, no spurious cross-carrier route.
  //         A number-literal fixture cannot catch a string/number type divergence, so this pins it. ----
  {
    const accountCarrier = 10686, load = 23088090, price = 90000;
    const capStr = {}, capNum = {};
    const aStr = capturingAdapter(accountCarrier, capStr);
    const aNum = capturingAdapter(accountCarrier, capNum);
    // branchCarrierCarrierId as a STRING equal to the numeric account carrier
    const rulesStr = deriveLoadRules({ id: String(load), branchCarrierCarrierId: String(accountCarrier), branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(rulesStr.branchCarrierCarrierId, '10686', 'precondition: rules carry the carrier as a STRING');
    await aStr.placeBid(String(load), price, rulesStr);  // string same-carrier LoadRules
    await aNum.placeBid(String(load), price, {});         // pre-pipeline numeric account-carrier path

    assert.strictEqual(capStr.url, `${API}/sp/bids/createV2?id=${load}&carrier=${accountCarrier}`,
      'string carrier is numeric-normalised on the ?carrier= param (10686, not "10686")');
    assert.strictEqual(capStr.body.carrierBranchId, accountCarrier,
      'string carrier is numeric-normalised on carrierBranchId (number 10686 - same type as today)');
    const norm = (raw) => { const b = JSON.parse(raw); b.requestTime = 0; return JSON.stringify(b); };
    assert.strictEqual(norm(capStr.bodyRaw), norm(capNum.bodyRaw),
      'a STRING same-carrier id bids BYTE-IDENTICALLY to the numeric account-carrier path');
    ok('string-typed same-carrier branchCarrierCarrierId is numeric-normalised (byte-identical, no spurious route)');
  }

  // ---- 8. TRANSIT-REQUIRED golden: loadIsTransitTimeOn + capture-provided days -> transitTime is
  //         the days as a STRING ("3" - the exact shape proven live on SIKA: null -> HTTP 400,
  //         "3" -> 201), STICKY across every rung/revision, and every OTHER field still matches the
  //         pinned contract. SIKA bids as the master account's own carrier (2667), so this is a
  //         same-carrier load - only transitTime moves vs the pinned body. ----
  {
    const carrier = 2667, load = 23095011, price = 61000;
    const captured = {};
    const a = capturingAdapter(carrier, captured);
    // a SIKA-shaped transit-required raw load; the days come from the pricing operator at capture
    // and are merged onto the rules by armFromRequest - reproduce the engine's exact opts shape.
    const rules = deriveLoadRules({ ...rawLoad({ id: String(load), carrier }), companyName: 'SIKA India', loadIsTransitTimeOn: 1 });
    assert.deepStrictEqual(rules.requires, ['transit_time'], 'precondition: a transit-required load declares the transit_time mechanic');
    const opts = { ...rules, transitDays: 3, floor: 55000 };
    const res = await a.placeBid(String(load), price, opts);

    assert.strictEqual(res.accepted, true, 'transit bid accepted (201)');
    assert.strictEqual(captured.url, `${API}/sp/bids/createV2?id=${load}&carrier=${carrier}`, 'URL unchanged by the transit mechanic');
    assert.strictEqual(captured.body.transitTime, '3', 'transitTime is the STRING "3" (the SIKA-proven wire shape), not the number 3');
    assert.deepStrictEqual(withoutRequestTime(captured.body),
      { ...expectedBody({ load, carrier, amount: price }), transitTime: '3' },
      'only transitTime moved; every other createV2 field matches the pinned contract');
    // STICKY: a revision (next rung) on the same monitor re-sends the SAME rules -> the SAME days.
    const captured2 = {};
    const a2 = capturingAdapter(carrier, captured2);
    await a2.placeBid(String(load), price - 500, opts);
    assert.strictEqual(captured2.body.transitTime, '3', 'a revision re-sends the same transitTime (sticky per load)');
    // numeric-string days (a form input arrives as a string) normalise to the same wire value
    const captured3 = {};
    const a3 = capturingAdapter(carrier, captured3);
    await a3.placeBid(String(load), price, { ...rules, transitDays: '3' });
    assert.strictEqual(captured3.body.transitTime, '3', 'transitDays as the string "3" normalises to the same wire value');
    ok('transit-required golden: transitTime:"3" (string), sticky across rungs, rest of the body pinned unchanged');
  }

  // ---- 9. FAIL CLOSED on a transit-required load with NO captured days: refused BEFORE any request
  //         is sent (MISSING_TRANSIT_TIME), never a silent bid-and-400 (SP rejects transitTime:null
  //         on these loads - proven live on SIKA). A malformed value (decimal days) is refused the
  //         same way - "3.5" days is uncaptured wire territory, never sent as a guess. ----
  {
    const carrier = 2667, load = 23095011, price = 61000;
    let fetchCalls = 0;
    const fetchImpl = async () => { fetchCalls += 1; return { status: 201, headers: { get: () => null }, json: async () => ({}) }; };
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
    a.account = { carrierId: carrier, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;
    const rules = deriveLoadRules({ ...rawLoad({ id: String(load), carrier }), companyName: 'SIKA India', loadIsTransitTimeOn: 1 });

    let e1 = null; try { a.buildBidPayload(rules, price, String(load)); } catch (e) { e1 = e; }
    assert.ok(e1 && e1.code === 'MISSING_TRANSIT_TIME', 'buildBidPayload refuses a transit-required load with no days');
    let e2 = null; try { await a.placeBid(String(load), price, { ...rules, floor: 55000 }); } catch (e) { e2 = e; }
    assert.ok(e2 && e2.code === 'MISSING_TRANSIT_TIME', 'placeBid propagates the refusal (engine opts shape)');
    let e3 = null; try { await a.placeBid(String(load), price, { ...rules, transitDays: 3.5 }); } catch (e) { e3 = e; }
    assert.ok(e3 && e3.code === 'MISSING_TRANSIT_TIME', 'decimal days (3.5) are refused, never sent as a guess');
    assert.strictEqual(fetchCalls, 0, 'NO createV2 request was sent for any refused transit bid (fail closed)');
    ok('missing/malformed transit days -> MISSING_TRANSIT_TIME refusal, nothing on the wire');
  }

  // ---- 10. PER-TONNE golden: the FULL createV2 body for a PMT bid, byte-identity, pinned to the
  //          REAL CAPTURED REQUEST. The build plan names this file and lists this pin as a ship gate:
  //          "the wire golden pins the captured PMT createV2 body so a future refactor cannot drift
  //          it". Field-level asserts elsewhere (test-adapter-wire) check amount/in/vcq/wireFloor
  //          individually and cannot catch a field ADDED to or DROPPED from the per_tonne branch -
  //          only a full-body deepStrictEqual can.
  //          The fixture is now load 23828313 with the exact request body a browser sent on
  //          2026-08-05 (amount 2240, in:"PMT", vcq:-1 -> HTTP 201;
  //          _research/2026-08-05_pmt-createv2-capture-SETTLED.md). It replaces a worked-example
  //          golden that pinned 3500 x 25 = 87500 - a number no capture ever produced, derived from
  //          an inference the capture disproved. Same-carrier (2667), so ONLY `in` moves against the
  //          flat pinned contract; `amount` is now built by identical arithmetic on both branches. ----
  {
    const priorFlag = process.env.SP_PMT_BID;
    try {
      process.env.SP_PMT_BID = '1';
      // the captured bid: per-MT rate 2240 on a 30 MT / 2 vehicle load (15 MT per vehicle).
      const carrier = 2667, load = 23828313, perMtRate = 2240, quantity = 30;
      const captured = {};
      const a = capturingAdapter(carrier, captured);
      const rules = deriveLoadRules({ id: String(load), companyName: 'Vishal Pipes Ltd',
        branchCarrierCarrierId: carrier, branchFreighterId: carrier, branchQuoteType: 'PMT', rateType: 'PMT',
        loadShipmentType: 'FTL', brancheUnit: 'MT', vehicleCount: quantity,
        branchAuctionExtendTime: '00:03:00', branchBidCountAllowed: 3, loadIsTransitTimeOn: 0 });
      assert.strictEqual(rules.pricingMode, 'per_tonne', 'precondition: the load classifies per_tonne');
      // the engine's exact opts shape: _bidOpts = Object.assign({}, rules, { floor })
      const res = await a.placeBid(String(load), perMtRate, { ...rules, floor: 2000 });

      assert.strictEqual(res.accepted, true, 'per-tonne bid accepted (201)');
      assert.strictEqual(captured.method, 'POST', 'per-tonne: method is POST');
      assert.strictEqual(captured.url, `${API}/sp/bids/createV2?id=${load}&carrier=${carrier}`,
        'per-tonne: the createV2 URL is unchanged by the mechanic');
      assert.ok(Number.isFinite(captured.body.requestTime), 'per-tonne: requestTime is a finite number');
      assert.deepStrictEqual(withoutRequestTime(captured.body),
        expectedPmtBody({ load, carrier, amount: 2240 }),
        'per-tonne: the FULL createV2 body matches the CAPTURED request - amount is the bare per-MT rate 2240 and in is "PMT"; every other field unchanged');
      // spell out the values the whole mechanic turns on, so a failure names the defect
      assert.strictEqual(captured.body.amount, perMtRate, 'amount = the bare per-MT rate, byte-identical to the captured browser bid');
      assert.notStrictEqual(captured.body.amount, perMtRate * quantity, 'amount is NOT rate x quantity (the #88 double-multiply overbid)');
      assert.strictEqual(captured.body.vcq, -1, 'per-tonne sends the vcq:-1 sentinel');
      // and no NEW key crept onto the per-tonne branch: the key SET and ORDER match the flat body
      const flatKeys = Object.keys(expectedBody({ load, carrier, amount: 1 }));
      assert.deepStrictEqual(Object.keys(withoutRequestTime(captured.body)), flatKeys,
        'the per-tonne body carries exactly the flat body\'s keys, in the same order - no field added or dropped');
      ok('per-tonne golden: FULL createV2 body pinned to the 2026-08-05 capture (amount 2240 = the bare rate, in:"PMT", vcq:-1, same key set)');

      // FAIL CLOSED with the gate off: the same load builds NOTHING.
      delete process.env.SP_PMT_BID;
      let fetchCalls = 0;
      const fetchImpl = async () => { fetchCalls += 1; return { status: 201, headers: { get: () => null }, json: async () => ({}) }; };
      const a2 = new RealSuperProcureAdapter({ token: 't', fetchImpl });
      a2.account = { carrierId: carrier, tokenExp: Date.now() + 3_600_000 };
      a2.writeEnabled = true;
      let e = null; try { await a2.placeBid(String(load), perMtRate, { ...rules, floor: 2000 }); } catch (err) { e = err; }
      assert.ok(e && e.code === 'UNSUPPORTED_RULE', 'gate off: the same per-tonne load is refused');
      assert.strictEqual(fetchCalls, 0, 'gate off: NO createV2 request was sent');
      ok('per-tonne golden fail-closed: with SP_PMT_BID off the same load builds no body and sends nothing');
    } finally {
      if (priorFlag === undefined) delete process.env.SP_PMT_BID; else process.env.SP_PMT_BID = priorFlag;
    }
  }

  // Belt to the exit-handler sentinel above: this gives the clearer failure when the file runs
  // to the end; the handler is the only thing that fires when it does not.
  assert.strictEqual(pass, EXPECTED_CHECKS, `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
