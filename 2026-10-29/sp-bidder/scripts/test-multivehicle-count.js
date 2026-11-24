'use strict';
/**
 * FTL MULTI-VEHICLE COUNT FIX - full regression (the "-1 vehicles" allotment bug).
 *
 * THE BUG (2026-07-16 Renewsys/Vishal incident): the bid payload hardcodes the vehicle-count
 * field `vcq:-1`. On a single-vehicle FTL load SuperProcure normalizes -1 to 1 and it works, and
 * that sentinel is PROVEN (SIKA/Syngenta/Durian win with it). But on a genuine FTL MULTI-vehicle
 * load SP records -1 literally and renders "-1 vehicles", which the shipper cannot allot.
 *
 * THE FIX + the BID-MAX-ALWAYS rule (never bid fewer vehicles than the load's count):
 *   - On any load with a USABLE count > 1 the engine bids all N required trucks (vcq = N; `amount`
 *     is already per-vehicle and floor-safe) at the single decision point (_multiVehiclePlan). This
 *     covers BOTH a proven, WELL-FORMED FTL multi-vehicle load AND an UNKNOWN-basis count (units>1,
 *     no recorded quoteType) in REAL mode - the unknown-basis case used to HOLD and now bids max.
 *   - The ONLY hold that remains is the OFF-switch (SP_MULTI_VEHICLE_BID=0), the operator control
 *     that disables multi-vehicle bidding entirely.
 *   - A missing / -1 / non-finite count has NO N to max to, so it bids SINGLE (no vcq -> -1 sentinel).
 *
 * THE HARD GUARDRAIL this pins: the wire for single-vehicle FTL and for PMT loads is UNCHANGED -
 * both still send `vcq:-1` byte-identically. PMT loads (where `units`/vehicleCount is TONNAGE, not
 * trucks) are NEVER treated as multi-vehicle. The FTL-vs-PMT decision reads `quoteType`
 * (branchQuoteType/rateType), never `loadShipmentType` (which lies "FTL" on PMT loads). The
 * tonnes-vs-trucks ambiguity on the unknown-basis case is caught before pricing by the price-page
 * vehicle-count confirmation (scripts/test-price-page-js.js), not by holding in the engine.
 *
 * Sections:
 *   A. isMultiVehicle predicate (the PMT field-trap, FTL-multi, unknown-basis, case-insensitivity)
 *   B. _mapLoad exposes quoteType + loadTotalQuantity from the real load shape
 *   C. assertValidVcq invariant (-1 or positive integer; rejects 0 / NaN / fraction / other-negative)
 *   D. WIRE byte-identity: real placeBid with empty opts -> vcq:-1 full-body pin (single FTL + PMT)
 *   E. WIRE Layer B: real placeBid with opts.vcq:N -> vcq:N (2 / 4 / 40), amount per-vehicle
 *   F. ENGINE default-on: a WELL-FORMED FTL-multi load auto-bids vcq:N with NO flag set
 *   F2. ENGINE off-switch (multiVehicleBid:false): FTL-multi held closed - no bid, one manual-bid alert
 *   G. ENGINE bid-max: an UNKNOWN-basis count (units>1, no quoteType) now bids vcq:units (was hold)
 *   G2. ENGINE floor invariant: a multi-vehicle ladder is floor-clamped; no sub-floor vcq:N bid leaves
 *   H. ENGINE PMT (units>1) + single-vehicle FTL: bid normally, engine passes NO vcq (wire stays -1)
 *   H2. ENGINE no-count-to-max: a missing / -1 / non-finite count bids SINGLE, never an invented vcq
 *   I. ENGINE read-back oracle: alert on recorded bidVehicleCount != what we bid for (incl. -1)
 *   J. ENGINE operator-chosen count: a desk-lowered partial flows to vcq; out-of-range -> bid-max;
 *      the chosen count persists on the intent + is restored by _intentToArm (survives a restart)
 *   K. normalizeBidVehicleCount: capture-time validation (valid partial passes; over-total /
 *      non-integer rejected BAD_INPUT; not-supplied / single-unit -> null = the bid-max default)
 *
 *   node scripts/test-multivehicle-count.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { RealSuperProcureAdapter, normQuoteType, assertValidVcq } = require('../src/platform/realAdapter');
const { isMultiVehicle } = require('../src/discovery/discovery');
const { normalizeBidVehicleCount } = require('../src/pricing/priceRequests');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { assertAboveFloor } = require('../src/engine/pricing');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const API = 'https://api.superprocure.com';

// ---------------------------------------------------------------------------
// A. the predicate - FTL-multi vs the PMT field-trap
// ---------------------------------------------------------------------------
{
  // FTL, one truck -> a normal load. Over-excluding this would silently stop single-truck bidding.
  assert.strictEqual(isMultiVehicle({ quoteType: 'FTL', units: 1 }), false, 'FTL x1 is a normal load');
  for (const n of [2, 4, 40, 80]) {
    assert.strictEqual(isMultiVehicle({ quoteType: 'FTL', units: n }), true, `FTL x${n} is multi-vehicle`);
  }
  ok('isMultiVehicle: FTL x1 allowed; FTL x2/4/40/80 held out');

  // THE FIELD TRAP. A real PMT load carries vehicleCount 22/30 meaning MT on ONE truck, and SP
  // reports loadShipmentType "FTL" on it anyway. Reading shipmentType would sweep in every PMT load.
  assert.strictEqual(isMultiVehicle({ quoteType: 'PMT', shipmentType: 'FTL', units: 22 }), false, 'PMT 22 = 22 MT, not 22 trucks');
  assert.strictEqual(isMultiVehicle({ quoteType: 'PMT', shipmentType: 'FTL', units: 9000 }), false, 'a KG-based PMT load is not 9000 trucks');
  ok('isMultiVehicle: PMT with a large vehicleCount is NOT multi-vehicle (the field trap)');

  // Absent / unparseable count -> never over-excluded.
  for (const u of [undefined, null, '', 'n/a', NaN]) {
    assert.strictEqual(isMultiVehicle({ quoteType: 'FTL', units: u }), false, `units ${JSON.stringify(u)} -> not excluded`);
  }
  ok('isMultiVehicle: missing / null / unparseable vehicleCount -> allowed');

  // No quote type recorded: lenient by default (mock/sim, pre-fix snapshot), strict fails CLOSED.
  assert.strictEqual(isMultiVehicle({ units: 3 }), false, 'no quoteType -> prior behaviour (mock/sim)');
  assert.strictEqual(isMultiVehicle({ units: 3 }, { strictUnknownBasis: true }), true, 'strict: >1 with no recorded basis fails closed');
  assert.strictEqual(isMultiVehicle({ units: 1 }, { strictUnknownBasis: true }), false, 'strict: a single-vehicle legacy snapshot still bids');
  assert.strictEqual(isMultiVehicle({ quoteType: 'PMT', units: 30 }, { strictUnknownBasis: true }), false, 'strict: a RECORDED PMT basis still bids');
  ok('isMultiVehicle(strictUnknownBasis): >1 with no basis fails closed; PMT / single still bid');

  // Case-insensitive; an unrecognized real quote type with >1 fails closed; null load is safe.
  assert.strictEqual(isMultiVehicle({ quoteType: 'ftl', units: 2 }), true, 'quote-type match is case-insensitive');
  assert.strictEqual(isMultiVehicle({ quoteType: 'SOMETHING_NEW', units: 4 }), true, 'unrecognized real quote type + >1 -> fail closed');
  assert.strictEqual(isMultiVehicle(null), false, 'null load is not multi-vehicle');
  ok('isMultiVehicle: case-insensitive; unrecognized basis + >1 fails closed; null load safe');
}

// ---------------------------------------------------------------------------
// B. _mapLoad exposes the real quote type + loadTotalQuantity (prereq for the guard)
// ---------------------------------------------------------------------------
{
  assert.strictEqual(normQuoteType('  pmt '), 'PMT', 'normQuoteType trims + upper-cases');
  assert.strictEqual(normQuoteType(null), null, 'normQuoteType null stays null (basis unknown, not FTL)');

  const a = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
  const future = new Date(Date.now() + 600000).toISOString();

  // Real PMT load shape (Vishal Pipes 23195633, 2026-07-16 probe): branchQuoteType PMT, but
  // loadShipmentType FTL - the trap. vehicleCount 22 is 22 MT on ~1 truck.
  const pmt = a._mapLoad({
    id: 23195633, companyName: 'Vishal Pipes Ltd', biddingOn: 1, biddingCloseTime: future,
    branchAuctionExtendTime: '00:00:00',
    branchQuoteType: 'PMT', rateType: 'PMT', loadShipmentType: 'FTL', vehicleCount: 22, loadTotalQuantity: 22,
  });
  assert.strictEqual(pmt.quoteType, 'PMT', 'quoteType reads branchQuoteType');
  assert.strictEqual(pmt.shipmentType, 'FTL', 'loadShipmentType really does say FTL on a PMT load - the trap');
  assert.strictEqual(pmt.units, 22, 'vehicleCount 22 carried through (it is 22 MT, not 22 trucks)');
  assert.strictEqual(pmt.loadTotalQuantity, 22, 'loadTotalQuantity exposed');
  assert.strictEqual(isMultiVehicle(pmt), false, 'the mapped PMT load is NOT held out');
  ok('_mapLoad: a real PMT load maps to quoteType "PMT" (though shipmentType says "FTL") and is not held');

  // Real FTL multi-vehicle shape (Epack Prefab 23196002: 5 trucks).
  const ftl = a._mapLoad({
    id: 23196002, companyName: 'Epack Prefab', biddingOn: 1, biddingCloseTime: future, branchAuctionExtendTime: '00:00:00',
    branchQuoteType: 'FTL', rateType: 'FTL', loadShipmentType: 'FTL', vehicleCount: 5, loadTotalQuantity: 5,
  });
  assert.strictEqual(ftl.quoteType, 'FTL', 'an FTL load maps to quoteType FTL');
  assert.strictEqual(isMultiVehicle(ftl), true, 'a real 5-vehicle FTL load IS held out');
  ok('_mapLoad: a real 5-vehicle FTL load maps to quoteType "FTL" and is held out');

  // rateType is the fallback; neither field -> null (never silently "FTL").
  assert.strictEqual(a._mapLoad({ id: 1, rateType: 'PMT', branchAuctionExtendTime: '00:00:00' }).quoteType, 'PMT', 'rateType used when branchQuoteType absent');
  assert.strictEqual(a._mapLoad({ id: 2, branchAuctionExtendTime: '00:00:00' }).quoteType, null, 'neither field -> quoteType null');
  ok('_mapLoad: quoteType falls back to rateType, and is null (not "FTL") when SP sends neither');
}

// ---------------------------------------------------------------------------
// C. assertValidVcq invariant: -1 sentinel OR a positive integer; nothing else
// ---------------------------------------------------------------------------
{
  for (const v of [-1, 1, 2, 3, 40]) assert.strictEqual(assertValidVcq(v), v, `vcq ${v} allowed`);
  ok('assertValidVcq: -1 sentinel and positive integer counts (1/2/3/40) are allowed');

  for (const bad of [0, NaN, -2, -1.5, 2.5, '3', null, undefined, Infinity]) {
    assert.throws(() => assertValidVcq(bad), (e) => e && e.code === 'VCQ', `vcq ${JSON.stringify(bad)} must throw`);
  }
  ok('assertValidVcq: rejects 0 / NaN / fraction / other-negative / non-number (code VCQ)');
}

// ---------------------------------------------------------------------------
// D + E. WIRE byte-identity via the real placeBid + a capturing fetch
// ---------------------------------------------------------------------------
// captures the outgoing request, answers 201 (json-only, echoing bidVehicleCount for the oracle).
function capturingAdapter(carrierId, captured, bidVehicleCount = 1) {
  const fetchImpl = async (url, init) => {
    captured.url = url; captured.method = init.method;
    captured.bodyRaw = init.body; captured.body = JSON.parse(init.body);
    return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1, bidVehicleCount, bidQuantity: 25 } }) };
  };
  const a = new RealSuperProcureAdapter({ token: 't', fetchImpl });
  a.account = { carrierId, tokenExp: Date.now() + 3_600_000 };
  a.writeEnabled = true;
  return a;
}
// the pinned single/PMT body EXCEPT requestTime (Date.now(), checked separately).
function expectedSentinelBody({ load, carrier, amount }) {
  return {
    load, carrierBranchId: carrier, amount,
    bidNotes: null, type: 'E-AUCTION', in: 'FTL', vcq: -1,
    loadLotId: null, reportingTime: null, transitTime: null,
    vehicleTypes: [], bidDiscount: 0, isOfferRate: false, isWeb: 1,
  };
}
function withoutRequestTime(body) { const b = { ...body }; delete b.requestTime; return b; }

(async () => {
  // ---- D. single-vehicle FTL (Syngenta, Durian) AND a PMT load: empty opts -> vcq:-1, pinned ----
  for (const c of [
    { name: 'Syngenta (single FTL)', carrier: 10686, load: 23088090, price: 95000, amount: 95000 },
    { name: 'Durian (single FTL)', carrier: 4441, load: 22990011, price: 87650.4, amount: 87650 }, // proves amount rounds
    { name: 'Vishal (PMT, 22 MT)', carrier: 2667, load: 23195633, price: 60000, amount: 60000 },  // PMT still -1 on the wire
  ]) {
    const captured = {};
    const a = capturingAdapter(c.carrier, captured);
    // The engine sends NO vcq on these loads (single FTL / PMT), so the wire is the proven sentinel.
    const res = await a.placeBid(String(c.load), c.price, {});
    assert.strictEqual(res.accepted, true, `${c.name}: 201 accepted`);
    assert.strictEqual(captured.method, 'POST', `${c.name}: POST`);
    assert.strictEqual(captured.url, `${API}/sp/bids/createV2?id=${c.load}&carrier=${c.carrier}`, `${c.name}: exact createV2 URL`);
    assert.strictEqual(captured.body.vcq, -1, `${c.name}: vcq is the proven -1 sentinel`);
    assert.ok(Number.isFinite(captured.body.requestTime), `${c.name}: requestTime is finite`);
    assert.deepStrictEqual(withoutRequestTime(captured.body), expectedSentinelBody({ load: c.load, carrier: c.carrier, amount: c.amount }),
      `${c.name}: FULL createV2 body matches the pinned -1 contract (byte-identity)`);
    ok(`byte-identity: ${c.name} -> vcq:-1, full body pinned unchanged`);
  }

  // ---- E. Layer B write shape: opts.vcq:N -> vcq:N on the wire (per-vehicle amount unchanged) ----
  for (const n of [2, 4, 40]) {
    const captured = {};
    const a = capturingAdapter(10686, captured);
    await a.placeBid('23196002', 74316, { vcq: n });
    assert.strictEqual(captured.body.vcq, n, `Layer B: vcq === ${n} on the wire`);
    assert.strictEqual(captured.body.amount, 74316, 'amount is UNCHANGED (per-vehicle, not multiplied by N)');
    ok(`Layer B wire: opts.vcq ${n} -> body.vcq ${n}, amount stays per-vehicle`);
  }

  // A wrong count never leaves the building: the payload-build assert throws before the fetch.
  {
    const captured = {};
    const a = capturingAdapter(10686, captured);
    await assert.rejects(a.placeBid('1', 50000, { vcq: 0 }), (e) => e && e.code === 'VCQ', 'vcq:0 is refused at payload build');
    assert.strictEqual(captured.body, undefined, 'no request was sent for the invalid vcq');
    ok('Layer B wire: an invalid vcq (0) throws at payload build - no bid is sent');
  }

  // -------------------------------------------------------------------------
  // F..I. ENGINE behaviour through a real _tick + a capturing stub adapter
  // -------------------------------------------------------------------------
  let tmpN = 0;
  const tmpFiles = [];
  // A stub adapter that fires the establish rung and records exactly what opts the engine passed.
  function stubAdapter(placed, { bidVehicleCount } = {}) {
    return {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      writeEnabled: true,
      async getAuctionState() {
        return { ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null,
          closesInMs: 8000, revisionLimit: 3, revisionsLeft: null, minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 };
      },
      async placeBid(id, price, opts = {}) {
        placed.push({ price, opts });
        const r = { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
        if (bidVehicleCount !== undefined) r.bidVehicleCount = bidVehicleCount;
        return r;
      },
    };
  }
  function makeEngine(adapter, cfgExtra = {}) {
    const f = path.join(os.tmpdir(), `mv-count-${process.pid}-${tmpN++}.json`);
    tmpFiles.push(f);
    const events = [];
    const eng = new BidEngine(adapter, new DurableScheduler(f), {
      config: Object.assign({ openAtMs: 15000, floorWindowMs: 2500, minInterFireMs: 0 }, cfgExtra),
      onEvent: (e) => events.push(e), rand: () => 0,
    });
    return { eng, events };
  }
  // arm a live load and drive one establish tick.
  async function armTick(eng, meta) {
    const m = eng.arm(Object.assign({ lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 8000 }, meta),
      { cost: 40000, marginsPct: [8, 7.5, 6] });
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    eng.kill();
    return m;
  }
  const heldAlerts = (events) => events.filter((e) => e.type === 'alert' && e.kind === 'multi_vehicle_held');
  const mismatchAlerts = (events) => events.filter((e) => e.type === 'alert' && e.kind === 'vehicle_count_mismatch');

  // ---- F. DEFAULT-ON (no flag): a genuine, WELL-FORMED FTL multi-vehicle load AUTO-BIDS vcq:N ----
  // The graduation - proven live 2026-07-23 on load 23423905 (vcq:2, all rungs 201, zero
  // vehicle_count_mismatch). NO env flag / config override is passed: default-on comes from DEFAULTS,
  // exactly as the box now behaves without SP_MULTI_VEHICLE_BID being set to anything.
  for (const n of [2, 4, 40]) {
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed)); // no multiVehicleBid override -> default ON
    await armTick(eng, { id: `FTLdef${n}`, units: n, quoteType: 'FTL' });
    assert.strictEqual(placed.length >= 1, true, `default-on: the well-formed FTL x${n} load DID bid`);
    assert.strictEqual(placed[0].opts.vcq, n, `default-on: engine passed opts.vcq === ${n} with NO flag set`);
    assert.strictEqual(heldAlerts(events).length, 0, 'default-on: no fail-closed hold on a well-formed load');
    ok(`default-on: well-formed FTL x${n} auto-bids opts.vcq = ${n} (no flag)`);
  }

  // ---- F2. OFF-SWITCH: multiVehicleBid:false (env SP_MULTI_VEHICLE_BID=0) forces the old hold ----
  {
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed), { multiVehicleBid: false });
    await armTick(eng, { id: 'FTLoff3', units: 3, quoteType: 'FTL' });
    assert.strictEqual(placed.length, 0, 'off-switch: no bid placed on the FTL multi-vehicle load - no rung spent');
    const held = heldAlerts(events);
    assert.strictEqual(held.length, 1, 'off-switch: exactly one multi_vehicle_held alert fired');
    assert.strictEqual(held[0].level, 'error', "the alert is 'error' level (reaches WhatsApp via ERROR_KINDS)");
    assert.strictEqual(held[0].units, 3, 'the alert carries the required vehicle count');
    assert.ok(/quote this one manually/i.test(held[0].detail), 'the alert tells the desk to bid it manually');
    ok('off-switch (multiVehicleBid:false): FTL x3 held closed - no bid, no rung spent, one manual-bid alert');
  }

  // Dedup: the held alert fires ONCE across repeated ticks (discovery/monitor re-ticks), off-switch path.
  {
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed), { multiVehicleBid: false });
    const m = eng.arm({ id: 'FTL4', units: 4, quoteType: 'FTL', lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 8000 },
      { cost: 40000, marginsPct: [8, 7.5, 6] });
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    await eng._tick(m); if (m.timer) clearTimeout(m.timer);
    eng.kill();
    assert.strictEqual(placed.length, 0, 'still no bid across three ticks');
    assert.strictEqual(heldAlerts(events).length, 1, 'the held alert is deduped across ticks (fired once)');
    ok('off-switch: the held-out alert is deduped per load across repeated ticks');
  }

  // ---- G. BID-MAX: an UNKNOWN-basis count (units>1, NO quoteType) now BIDS vcq:units (was a hold) ----
  // Bid-max-always: never fewer vehicles than the load's count. An unknown-basis count in REAL mode
  // (failClosedUnknownBasis:true - a stale pre-fix intent with units>1 and no recorded quoteType) used
  // to HOLD; it now bids the full count (vcq = round(units) = 3). The tonnes-vs-trucks ambiguity on
  // this case is caught BEFORE pricing by the price-page vehicle-count confirmation, not by holding
  // here. Holds only remain for the OFF-switch (F2). Verified at default-on and explicitly-on alike.
  for (const flagState of [{}, { multiVehicleBid: true }]) {
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed), Object.assign({ failClosedUnknownBasis: true }, flagState));
    await armTick(eng, { id: 'UNK3', units: 3 }); // NO quoteType -> unknown basis, real-mode lever on
    assert.strictEqual(placed.length >= 1, true, 'unknown-basis multi-vehicle load now BIDS (bid-max always)');
    assert.strictEqual(placed[0].opts.vcq, 3, 'unknown-basis load bids vcq = round(units) = 3 (the max)');
    assert.strictEqual(heldAlerts(events).length, 0, 'unknown-basis load no longer holds (no manual-bid alert)');
  }
  ok('bid-max: an unknown-basis (units>1, no quoteType) load now bids vcq:units in real mode (was a hold)');

  // ---- G2. FLOOR INVARIANT on a multi-vehicle (default-on) ladder: no sub-floor vcq:N bid leaves ----
  // The graduation changes only the vehicle COUNT, never the price path: the ladder is still built
  // floor-clamped and every bid still clears assertAboveFloor. Prove it on a real multi-vehicle armed
  // monitor (cost 40000, band [8,7.5,6] -> floor 42400, ladder [43200,43000,42400]).
  {
    const placed = [];
    const { eng } = makeEngine(stubAdapter(placed)); // default-on
    const m = await armTick(eng, { id: 'FTLfloor', units: 2, quoteType: 'FTL' });
    assert.ok(Array.isArray(m.ladder) && m.ladder.length > 0, 'the multi-vehicle load built a ladder');
    assert.ok(m.floor >= 40000, 'the operating floor is at or above the entered per-vehicle cost (never a guaranteed loss)');
    for (const rung of m.ladder) assert.ok(rung >= m.floor, `ladder rung ${rung} is at or above the floor ${m.floor}`);
    assert.strictEqual(m.ladder[m.ladder.length - 1], m.floor, 'the floor is the last (lowest) rung');
    assert.strictEqual(placed.length >= 1, true, 'the multi-vehicle load bid');
    assert.strictEqual(placed[0].opts.vcq, 2, 'default-on: the multi-vehicle bid carried vcq:2');
    for (const p of placed) {
      assert.ok(p.price >= m.floor, `placed per-vehicle price ${p.price} is at or above the floor ${m.floor}`);
      assert.doesNotThrow(() => assertAboveFloor(p.price, m.floor), 'assertAboveFloor holds on the multi-vehicle bid');
    }
    ok('floor invariant: a multi-vehicle (default-on) ladder is floor-clamped and no sub-floor vcq:N bid leaves');
  }

  // ---- H. PMT (units>1) and single-vehicle FTL: bid normally, engine passes NO vcq (wire -> -1) ----
  {
    // PMT with a large vehicleCount (22 MT) must NOT be held and must NOT get vcq=22.
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed)); // default-on, doesn't matter: PMT is never multi-vehicle
    await armTick(eng, { id: 'PMT22', units: 22, quoteType: 'PMT' });
    assert.strictEqual(placed.length >= 1, true, 'PMT x22 (22 MT) is bid normally - not held');
    assert.strictEqual(placed[0].opts.vcq, undefined, 'PMT: engine passes NO vcq -> adapter sends the -1 sentinel');
    assert.strictEqual(heldAlerts(events).length, 0, 'PMT x22 raised no multi-vehicle alert');
    ok('PMT x22 (tonnage): bids normally, engine passes no vcq (wire stays -1) - not treated as 22 trucks');
  }
  // Even with Layer B ON, a PMT load never gets vcq=N (units is tonnage there).
  {
    const placed = [];
    const { eng } = makeEngine(stubAdapter(placed), { multiVehicleBid: true });
    await armTick(eng, { id: 'PMT35', units: 35, quoteType: 'PMT' });
    assert.strictEqual(placed[0].opts.vcq, undefined, 'PMT with Layer B ON still passes no vcq (35 = 35 MT, not 35 trucks)');
    ok('PMT x35 with Layer B ON: still no vcq - the flag only ever affects FTL multi-vehicle');
  }
  {
    // single-vehicle FTL bids exactly as today (no vcq -> wire -1), flag on or off.
    for (const flag of [false, true]) {
      const placed = [];
      const { eng } = makeEngine(stubAdapter(placed), { multiVehicleBid: flag });
      await armTick(eng, { id: `FTL1_${flag}`, units: 1, quoteType: 'FTL' });
      assert.strictEqual(placed.length >= 1, true, `single FTL bids (flag=${flag})`);
      assert.strictEqual(placed[0].opts.vcq, undefined, `single FTL passes no vcq (flag=${flag}) -> wire -1`);
    }
    ok('single-vehicle FTL: bids with NO vcq (wire -1) whether Layer B is on or off');
  }

  // ---- H2. NO COUNT TO MAX TO: a missing / -1 / non-finite count bids SINGLE, never an invented vcq ----
  // "Bid max" needs a count. When there is none - units absent, -1, or non-finite - there is no N to
  // bid, so the load stays single-vehicle (engine passes NO vcq -> the adapter's -1 sentinel). Run in
  // REAL mode (failClosedUnknownBasis:true), so the unknown-basis lever is ON: it must still never
  // manufacture a vcq from a countless load. quoteType FTL so only the count is what excludes it.
  {
    for (const units of [undefined, -1, NaN]) {
      const placed = [];
      const { eng, events } = makeEngine(stubAdapter(placed), { failClosedUnknownBasis: true });
      await armTick(eng, { id: `NOCOUNT_${String(units)}`, units, quoteType: 'FTL' });
      assert.strictEqual(placed.length >= 1, true, `units ${String(units)}: bids single, not held`);
      assert.strictEqual(placed[0].opts.vcq, undefined, `units ${String(units)}: no vcq (single, wire -1) - no invented count`);
      assert.strictEqual(heldAlerts(events).length, 0, `units ${String(units)}: no multi-vehicle hold`);
    }
    ok('no-count-to-max: a missing / -1 / non-finite count stays single-vehicle (no vcq), never invented');
  }

  // ---- I. read-back oracle: alert when recorded bidVehicleCount != what we bid for ----
  {
    // single-vehicle: sent -1, SP normalizes to 1 -> expected 1 -> MATCH -> no alert (no false positive).
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed, { bidVehicleCount: 1 }));
    await armTick(eng, { id: 'ORA_ok', units: 1, quoteType: 'FTL' });
    assert.strictEqual(mismatchAlerts(events).length, 0, 'single-vehicle -1 -> recorded 1 is a MATCH, no spurious alert');
    ok('oracle: single-vehicle (sent -1, recorded 1) raises NO mismatch alert');
  }
  {
    // the 23167278 shape: sent -1 on a load, SP recorded -1 (the bug) -> expected 1 != -1 -> ALERT.
    // (drive it via a single-vehicle-looking meta so the engine bids; the oracle is on the read-back.)
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed, { bidVehicleCount: -1 }));
    await armTick(eng, { id: 'ORA_neg', units: 1, quoteType: 'FTL' });
    const al = mismatchAlerts(events);
    assert.strictEqual(al.length, 1, 'recorded -1 != expected 1 -> one mismatch alert (this catches the 23167278 failure)');
    assert.strictEqual(al[0].level, 'error', 'the mismatch alert is error-level (reaches WhatsApp)');
    assert.ok(/not be allottable|SuperProcure recorded/i.test(al[0].detail), 'the alert explains the allotment risk');
    ok('oracle: recorded bidVehicleCount -1 (the -1-vehicles bug) fires a mismatch alert');
  }
  {
    // Layer B: sent N, SP records N -> MATCH -> no alert.
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed, { bidVehicleCount: 3 }), { multiVehicleBid: true });
    await armTick(eng, { id: 'ORA_b_ok', units: 3, quoteType: 'FTL' });
    assert.strictEqual(mismatchAlerts(events).length, 0, 'Layer B: sent 3, recorded 3 -> no alert');
    ok('oracle: Layer B (sent 3, recorded 3) raises NO mismatch alert');
  }
  {
    // Layer B: sent N, SP records something else (e.g. 1 - vcq:N did not take) -> ALERT. This is the
    // exact signal the supervised live capture must NOT produce before the flag is trusted unattended.
    const placed = [];
    const { eng, events } = makeEngine(stubAdapter(placed, { bidVehicleCount: 1 }), { multiVehicleBid: true });
    await armTick(eng, { id: 'ORA_b_bad', units: 3, quoteType: 'FTL' });
    const al = mismatchAlerts(events);
    assert.strictEqual(al.length, 1, 'Layer B: sent 3 but recorded 1 -> one mismatch alert');
    assert.ok(/recorded 1/.test(al[0].detail) && /bid for 3/.test(al[0].detail), 'the alert names both counts');
    ok('oracle: Layer B write that did not take (sent 3, recorded 1) fires a mismatch alert');
  }

  // ---- J. OPERATOR-CHOSEN COUNT: a desk-lowered partial flows to vcq; out-of-range -> bid-max ----
  // Bid-max is the DEFAULT; the desk may LOWER it (BRL can supply fewer trucks) on the price page. The
  // chosen count rides meta.bidVehicleCount (capture -> armFromRequest -> intent -> here) and is
  // honoured ONLY as a whole number in [1, round(units)]; anything else falls back to bid-max, so a
  // corrupt / over-total persisted count can never over-commit onto the wire.
  {
    for (const [chosen, units] of [[1, 3], [2, 4], [3, 3]]) {
      const placed = [];
      const { eng } = makeEngine(stubAdapter(placed)); // default-on
      await armTick(eng, { id: `CHOSE_${chosen}_${units}`, units, quoteType: 'FTL', bidVehicleCount: chosen });
      assert.strictEqual(placed.length >= 1, true, `chosen ${chosen} of ${units}: the load bid`);
      assert.strictEqual(placed[0].opts.vcq, chosen, `chosen ${chosen} of ${units} -> vcq ${chosen} (the desk's count, not the max)`);
    }
    ok('operator count: a desk-chosen partial (1 of 3, 2 of 4) and a full count (3 of 3) each bid vcq = the chosen count');
  }
  {
    // out of range (0, above-total, fraction, NaN, negative) -> fall back to the bid-max default.
    for (const bad of [0, 5, 2.5, NaN, -1]) {
      const placed = [];
      const { eng } = makeEngine(stubAdapter(placed));
      await armTick(eng, { id: `BADCNT_${String(bad)}`, units: 3, quoteType: 'FTL', bidVehicleCount: bad });
      assert.strictEqual(placed[0].opts.vcq, 3, `chosen ${String(bad)} (of 3) is ignored -> vcq falls back to bid-max 3`);
    }
    ok('operator count: an out-of-range chosen count (0 / over-total / fraction / NaN / negative) falls back to bid-max - never over-commits');
  }
  {
    // the chosen count survives the intent round-trip (persist on arm, restore on _intentToArm),
    // so a restart / re-arm keeps the desk's partial instead of reverting to bid-max (an over-commit).
    const placed = [];
    const { eng } = makeEngine(stubAdapter(placed));
    const m = eng.arm({ id: 'PERSIST2of4', units: 4, quoteType: 'FTL', bidVehicleCount: 2, lane: { origin: 'A', destination: 'B' }, closesAt: Date.now() + 8000 },
      { cost: 40000, marginsPct: [8, 7.5, 6] });
    if (m.timer) clearTimeout(m.timer);
    const it = eng.scheduler.get('PERSIST2of4');
    assert.strictEqual(it.bidVehicleCount, 2, 'the chosen count is persisted on the durable intent');
    const restored = eng._intentToArm(it);
    assert.strictEqual(restored.meta.bidVehicleCount, 2, '_intentToArm restores the chosen count onto meta (survives a restart)');
    eng.kill();
    ok('operator count: the chosen count is persisted on the intent and restored by _intentToArm (survives a restart)');
  }

  // ---- K. normalizeBidVehicleCount: the capture-time validation (reject over-total / non-integer) ----
  {
    // valid full/partial counts pass through (string-tolerant).
    assert.strictEqual(normalizeBidVehicleCount(1, 3), 1, 'a partial (1 of 3) is valid');
    assert.strictEqual(normalizeBidVehicleCount(2, 4), 2, 'a partial (2 of 4) is valid');
    assert.strictEqual(normalizeBidVehicleCount('3', 3), 3, 'a full count as a string (3 of 3) is valid');
    // not supplied, or a single-unit load -> null (no chosen count; the engine keeps its bid-max default).
    for (const raw of [null, undefined, '', '   ']) assert.strictEqual(normalizeBidVehicleCount(raw, 3), null, `not supplied (${JSON.stringify(raw)}) -> null`);
    assert.strictEqual(normalizeBidVehicleCount(1, 1), null, 'a single-unit load carries no chosen count');
    ok('normalizeBidVehicleCount: valid full/partial counts pass; not-supplied / single-unit -> null (the bid-max default)');
    // over-total and non-integer are REJECTED (BAD_INPUT) - a visible error, not a silent clamp.
    for (const [raw, total] of [[5, 3], [3, 2]]) assert.throws(() => normalizeBidVehicleCount(raw, total), (e) => e && e.code === 'BAD_INPUT', `over-total ${raw} of ${total} rejected`);
    for (const raw of [0, 2.5, NaN, -1, 'x']) assert.throws(() => normalizeBidVehicleCount(raw, 3), (e) => e && e.code === 'BAD_INPUT', `non-integer/0/neg ${JSON.stringify(raw)} rejected`);
    ok('normalizeBidVehicleCount: an over-total count and a 0 / fraction / negative / non-numeric count are rejected (code BAD_INPUT)');
  }

  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }

  assert.strictEqual(pass, 37, `expected 37 checks, ran ${pass} - a check was dropped or double-counted`);
  console.log(`\n${pass}/37 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
