'use strict';
/**
 * KG vs MT WEIGHT UNIT round-trip (Module 2 L6).
 *
 * SuperProcure quotes most branches in MT but some (Ashirvad Pipes ~1,907 loads, some Havells/Tata -
 * 2,047 loads total) in KG. The weight NUMBER is correct; only its UNIT label was ever wrong -
 * assuming MT on a KG load mislabels the figure ~1000x (verified against SP's own
 * weightUtilizationPercentage). This is interpretation / display / storage correctness: there is
 * deliberately NO per-tonne bid math (PMT is a separate, unbuilt capability), so this pins that the
 * unit is normalised ONCE and survives every hop from the raw SP load to the pricing team's screen,
 * never silently defaulting a KG load to MT, and never leaking onto the createV2 wire.
 *
 *   node scripts/test-weight-unit-roundtrip.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');
const { normalizeUnit, UNITS } = require('../src/model/rulesConstants');
const { fmtWeight } = require('../src/notify/waTemplates');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // ---- 1. normalizeUnit: canonicalise KG/MT, tolerate case/whitespace, unknown/absent -> null ----
  {
    assert.strictEqual(normalizeUnit('KG'), 'KG', 'KG stays KG');
    assert.strictEqual(normalizeUnit('MT'), 'MT', 'MT stays MT');
    assert.strictEqual(normalizeUnit('kg'), 'KG', 'a lowercase variant canonicalises to KG');
    assert.strictEqual(normalizeUnit(' Mt '), 'MT', 'whitespace + case are normalised');
    assert.strictEqual(normalizeUnit('lbs'), null, 'a unit outside the enum is UNKNOWN (null), never guessed');
    assert.strictEqual(normalizeUnit(''), null, 'blank -> null');
    assert.strictEqual(normalizeUnit(null), null, 'absent -> null');
    assert.ok(UNITS.includes('KG') && UNITS.includes('MT'), 'the enum is the single source normalizeUnit checks against');
    ok('normalizeUnit canonicalises KG/MT (case/whitespace-tolerant); unknown/absent -> null');
  }

  // ---- 2. _mapLoad + deriveLoadRules read the SAME normalised unit off brancheUnit ----
  {
    const a = new RealSuperProcureAdapter({ token: 't' });
    a.account = { carrierId: 2667 };
    const m = a._mapLoad({ id: 23062480, companyName: 'Ashirvad Pipes Pvt Ltd', weight: 4400, brancheUnit: 'KG',
      vehicleName: '22FT-SA-6MT (Container)', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(m.weightUnit, 'KG', 'the mapped load carries the KG unit (not the assumed MT)');
    assert.strictEqual(m.weight, 4400, 'the raw weight number is untouched - only the unit label was ever at risk');
    assert.strictEqual(m.rules.unit, 'KG', 'the LoadRules fact carries the SAME normalised unit as the display field');

    const mt = a._mapLoad({ id: 1, weight: 6, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(mt.weightUnit, 'MT', 'an MT branch stays MT');
    assert.strictEqual(mt.rules.unit, 'MT', 'and the MT LoadRules fact agrees');
    const none = a._mapLoad({ id: 2, weight: 6, branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(none.weightUnit, null, 'absent brancheUnit -> null (the display layer applies the MT fallback, not this layer)');
    assert.strictEqual(none.rules.unit, null, 'absent -> null on the LoadRules fact too');
    ok('_mapLoad + deriveLoadRules read one normalised unit off brancheUnit; weight number untouched');
  }

  // ---- 3. FULL round-trip to the pricing screen: raw KG load -> mapped -> snapshot -> display ----
  {
    const store = createStore({ backend: 'memory' });
    const a = new RealSuperProcureAdapter({ token: 't' }); a.account = { carrierId: 2667 };
    const rq = new PriceRequestStore({ store, marginsPct: [12, 7, 6], minMarginPct: 6 });

    const kg = a._mapLoad({ id: 'KG1', companyName: 'Ashirvad Pipes Pvt Ltd', weight: 4400, brancheUnit: 'KG',
      biddingOn: 1, biddingCloseTime: new Date(Date.now() + 60000).toISOString(), branchAuctionExtendTime: '00:00:00' });
    const reqKg = await rq.createForLoad(kg);
    assert.strictEqual(reqKg.load.weightUnit, 'KG', 'the price-request snapshot STORES the KG unit');
    assert.strictEqual(reqKg.load.weight, 4400, 'the price-request snapshot stores the raw weight number');
    assert.strictEqual(fmtWeight(reqKg.load.weight, reqKg.load.weightUnit), '4400 KG',
      'the pricing screen DISPLAYS 4400 KG, not 4400 MT (the ~1000x mislabel this prevents)');

    const mt = a._mapLoad({ id: 'MT1', companyName: 'Syngenta India', weight: 6, brancheUnit: 'MT',
      biddingOn: 1, biddingCloseTime: new Date(Date.now() + 60000).toISOString(), branchAuctionExtendTime: '00:00:00' });
    const reqMt = await rq.createForLoad(mt);
    assert.strictEqual(fmtWeight(reqMt.load.weight, reqMt.load.weightUnit), '6 MT', 'an MT load shows 6 MT end-to-end');
    ok('round-trip: a KG load reaches the pricing screen as KG (and an MT load as MT), number preserved');
  }

  // ---- 4. a case-variant unit canonicalises all the way through to display ----
  {
    const a = new RealSuperProcureAdapter({ token: 't' }); a.account = { carrierId: 2667 };
    const m = a._mapLoad({ id: 'LC1', weight: 4400, brancheUnit: 'kg', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(m.weightUnit, 'KG', 'a lowercase kg is canonicalised at the adapter');
    assert.strictEqual(fmtWeight(m.weight, m.weightUnit), '4400 KG', 'and reaches display as canonical KG');
    ok('a case-variant brancheUnit canonicalises to KG through to the display layer');
  }

  // ---- 5. the unit is display/storage only - it NEVER reaches the createV2 wire (byte-identity) ----
  {
    const cap = [];
    const fetchImpl = async (url, init) => { cap.push(JSON.parse(init.body)); return { status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 1 } }) }; };
    const mk = () => { const a = new RealSuperProcureAdapter({ token: 't', fetchImpl }); a.account = { carrierId: 10686, tokenExp: Date.now() + 3_600_000 }; a.writeEnabled = true; return a; };
    const kgRules = deriveLoadRules({ id: '23088090', branchCarrierCarrierId: 10686, weight: 4400, brancheUnit: 'KG', branchAuctionExtendTime: '00:00:00' });
    const mtRules = deriveLoadRules({ id: '23088090', branchCarrierCarrierId: 10686, weight: 6, brancheUnit: 'MT', branchAuctionExtendTime: '00:00:00' });
    assert.strictEqual(kgRules.unit, 'KG', 'precondition: KG rules'); assert.strictEqual(mtRules.unit, 'MT', 'precondition: MT rules');
    await mk().placeBid('23088090', 95000, kgRules);
    await mk().placeBid('23088090', 95000, mtRules);
    const norm = (b) => { const c = { ...b }; c.requestTime = 0; return JSON.stringify(c); };
    assert.strictEqual(norm(cap[0]), norm(cap[1]), 'a KG load and an MT load send BYTE-IDENTICAL createV2 bodies (unit is off-wire)');
    assert.ok(!('unit' in cap[0]) && !('weightUnit' in cap[0]) && !('weight' in cap[0]), 'no unit/weight field leaks onto the wire');
    ok('the weight unit is display/storage only - never on the createV2 wire (byte-identical KG vs MT)');
  }

  console.log(`\n${pass}/5 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
