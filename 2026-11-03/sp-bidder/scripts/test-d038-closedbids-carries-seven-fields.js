'use strict';
/**
 * D038: the durable closedBids record must carry loadCode, branchName, distance, weight,
 * weightUnit, capturedAt and marginSource - fields that used to live ONLY on the short-retention
 * price-request store (pruned ~7 days after close). A historical export or reconciliation for a
 * load older than that window was permanently missing all seven, with no way to reconstruct them
 * from the durable store alone.
 *
 * Regression target: D038. bidLogger.js's _onArmed built its record with no loadCode, branchName,
 * distance, weight, weightUnit, capturedAt or marginSource keys at all (bidLogger.js:108-138 at
 * the time this was written); armFromRequest's meta object never carried them onto the engine's
 * 'armed' event either.
 *
 * Forward-only, additive (D038's own rule): this only checks that NEW records carry the fields, not
 * that anything gets backfilled.
 *
 * NON-BLOCKING fix (coordinator review of 99c4bd0): exportModel.js's canonical() read loadCode/
 * branchName/distanceKm/weight/weightUnit ONLY off the price request's own load snapshot, so once
 * that request is pruned (~7 days after close) the export blanked all five columns even though
 * closedBids now carries every one of them forward. canonical() must fall back to the closed
 * record's copy.
 *
 * @requires-summary-line
 *   node scripts/test-d038-closedbids-carries-seven-fields.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { armFromRequest } = require('../src/pricing/priceRequests');
const { canonical } = require('../src/web/exportModel');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

const tmp = (tag) => path.join(os.tmpdir(), `d038-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

(async () => {
  // --- (1) bidLogger._onArmed: given an 'armed' event carrying the seven fields, the closedBids
  // record stores every one of them.
  {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await logger.handle({
      type: 'armed', auctionId: 'B1', lane: { origin: 'A', destination: 'B' }, equipment: '32ft',
      units: 1, companyName: 'Havells', platformKey: 'sp', branchName: 'Alwar Cable (1350)',
      loadCode: 'HAV-0091', distanceKm: 812, weight: 14000, weightUnit: 'KG',
      capturedAt: 1758800000000, marginSource: 'customer:havells', cost: 10000, ladder: [11000], floor: 10000,
    });
    const rec = await store.getDoc('closedBids', 'B1');
    ok(rec.branchName === 'Alwar Cable (1350)', `branchName must reach the record (got ${rec.branchName})`);
    ok(rec.loadCode === 'HAV-0091', `loadCode must reach the record (got ${rec.loadCode})`);
    ok(rec.distanceKm === 812, `distanceKm must reach the record (got ${rec.distanceKm})`);
    ok(rec.weight === 14000, `weight must reach the record (got ${rec.weight})`);
    ok(rec.weightUnit === 'KG', `weightUnit must reach the record (got ${rec.weightUnit})`);
    ok(rec.capturedAt === 1758800000000, `capturedAt must reach the record (got ${rec.capturedAt})`);
    ok(rec.marginSource === 'customer:havells', `marginSource must reach the record (got ${rec.marginSource})`);

    // A re-arm with none of the fields on the event (e.g. a restart replay that lost them off an
    // old intent) carries the existing values forward rather than wiping them - same lazy
    // carry-forward discipline as shipper/laneFreight.
    await logger.handle({ type: 'armed', auctionId: 'B1', lane: { origin: 'A', destination: 'B' }, cost: 10000, ladder: [11000], floor: 10000 });
    const rec2 = await store.getDoc('closedBids', 'B1');
    ok(rec2.branchName === 'Alwar Cable (1350)' && rec2.loadCode === 'HAV-0091' && rec2.marginSource === 'customer:havells',
      `a re-arm with no fields on the event carries the existing ones forward (got ${JSON.stringify({ branchName: rec2.branchName, loadCode: rec2.loadCode, marginSource: rec2.marginSource })})`);
  }

  // --- (2) armFromRequest builds a meta object carrying the seven fields off the load/request, so
  // they reach the engine at all. A fake engine captures what it was armed with.
  {
    let capturedMeta = null;
    const fakeEngine = {
      caps: {},
      arm(meta) { capturedMeta = meta; return { ladder: [], floor: 0 }; },
      schedule(meta) { capturedMeta = meta; return { ladder: [], floor: 0 }; },
    };
    const req = {
      loadId: 'B2', price: { cost: 10000, marginsPct: [9, 7, 5], minMarginPct: 5 },
      capturedAt: 1758800000000, marginSource: 'bid',
      load: {
        companyName: 'Havells', lane: { origin: 'A', destination: 'B' }, equipment: '32ft', units: 1,
        branchName: 'Alwar Cable (1350)', loadCode: 'HAV-0091', distanceKm: 812, weight: 14000, weightUnit: 'KG',
        closesAt: Date.now() + 3600000,
      },
    };
    armFromRequest(fakeEngine, req, {});
    ok(capturedMeta && capturedMeta.loadCode === 'HAV-0091', `armFromRequest's meta must carry loadCode (got ${capturedMeta && capturedMeta.loadCode})`);
    ok(capturedMeta.distanceKm === 812, `armFromRequest's meta must carry distanceKm (got ${capturedMeta.distanceKm})`);
    ok(capturedMeta.weight === 14000, `armFromRequest's meta must carry weight (got ${capturedMeta.weight})`);
    ok(capturedMeta.weightUnit === 'KG', `armFromRequest's meta must carry weightUnit (got ${capturedMeta.weightUnit})`);
    ok(capturedMeta.capturedAt === 1758800000000, `armFromRequest's meta must carry capturedAt (got ${capturedMeta.capturedAt})`);
    ok(capturedMeta.marginSource === 'bid', `armFromRequest's meta must carry marginSource (got ${capturedMeta.marginSource})`);
  }

  // --- (3) end-to-end through the real engine: engine.arm() persists the fields on the intent and
  // emits them on 'armed', and a rehydrate (_intentToArm) restores them from the persisted intent.
  {
    const intents = tmp('d038');
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 5, standingL1Price: null, closesInMs: 3600000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
      placeBid: async () => ({ accepted: true, myRank: null, revisionsLeft: 2, latencyMs: 60 }),
    };
    const scheduler = new DurableScheduler(intents);
    const pending = [];
    const engine = new BidEngine(adapter, scheduler, { config: { openAtMs: 15000, floorWindowMs: 2500 }, onEvent: (e) => pending.push(logger.handle(e)) });
    const meta = {
      id: 'B3', lane: { origin: 'A', destination: 'B' }, equipment: '32ft', units: 1, companyName: 'Havells',
      branchName: 'Alwar Cable (1350)', loadCode: 'HAV-0091', distanceKm: 812, weight: 14000, weightUnit: 'KG',
      capturedAt: 1758800000000, marginSource: 'customer:havells', closesAt: Date.now() + 3600000,
    };
    engine.arm(meta, { cost: 10000, marginsPct: [9, 7, 5], minMarginPct: 5 });
    await Promise.all(pending);
    const rec = await store.getDoc('closedBids', 'B3');
    ok(rec && rec.loadCode === 'HAV-0091' && rec.distanceKm === 812 && rec.weight === 14000
      && rec.weightUnit === 'KG' && rec.capturedAt === 1758800000000 && rec.marginSource === 'customer:havells' && rec.branchName === 'Alwar Cable (1350)',
      `the real engine's arm() must reach closedBids with all seven fields (got ${JSON.stringify(rec)})`);

    // A restart rehydrate reads the persisted intent back through _intentToArm - the fields must
    // survive that round-trip too, or a post-restart re-arm would wipe them on the next 'armed'.
    const it = scheduler.get('B3');
    const { meta: restoredMeta } = engine._intentToArm(it);
    ok(restoredMeta.loadCode === 'HAV-0091' && restoredMeta.branchName === 'Alwar Cable (1350)'
      && restoredMeta.distanceKm === 812 && restoredMeta.weight === 14000 && restoredMeta.weightUnit === 'KG'
      && restoredMeta.capturedAt === 1758800000000 && restoredMeta.marginSource === 'customer:havells',
      `_intentToArm must restore all seven fields from the persisted intent (got ${JSON.stringify(restoredMeta)})`);

    try { fs.unlinkSync(intents); } catch (_) {}
  }

  // --- (4) the SCHEDULED-WAKE path (a pre-armed, "not yet live" load): schedule() persists the
  // intent before arm() ever runs, and the wake later reads it back through the SAME
  // _intentToArm() - the fields must survive that leg too, or a scheduled load's first 'armed'
  // event (fired by the wake) would carry none of them even though schedule() saw them on meta.
  {
    const intents2 = tmp('d038-sched');
    const scheduler2 = new DurableScheduler(intents2);
    const adapter2 = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 5, standingL1Price: null, closesInMs: 3600000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
      placeBid: async () => ({ accepted: true, myRank: null, revisionsLeft: 2, latencyMs: 60 }),
    };
    const engine2 = new BidEngine(adapter2, scheduler2, { config: { openAtMs: 15000, floorWindowMs: 2500 }, onEvent: () => {} });
    const meta = {
      id: 'B4', lane: { origin: 'A', destination: 'B' }, equipment: '32ft', units: 1, companyName: 'Havells',
      branchName: 'Alwar Cable (1350)', loadCode: 'HAV-0091', distanceKm: 812, weight: 14000, weightUnit: 'KG',
      capturedAt: 1758800000000, marginSource: 'customer:havells',
      startsAt: Date.now() + 3600000, closesAt: Date.now() + 7200000,
    };
    engine2.schedule(meta, { cost: 10000, marginsPct: [9, 7, 5], minMarginPct: 5 });
    const scheduledIt = scheduler2.get('B4');
    ok(scheduledIt && scheduledIt.loadCode === 'HAV-0091' && scheduledIt.distanceKm === 812 && scheduledIt.weight === 14000
      && scheduledIt.weightUnit === 'KG' && scheduledIt.capturedAt === 1758800000000 && scheduledIt.marginSource === 'customer:havells',
      `schedule() must persist all seven fields onto the scheduled intent (got ${JSON.stringify(scheduledIt)})`);
    const { meta: wakeMeta } = engine2._intentToArm(scheduledIt);
    ok(wakeMeta.loadCode === 'HAV-0091' && wakeMeta.branchName === 'Alwar Cable (1350)' && wakeMeta.distanceKm === 812
      && wakeMeta.weight === 14000 && wakeMeta.weightUnit === 'KG' && wakeMeta.capturedAt === 1758800000000 && wakeMeta.marginSource === 'customer:havells',
      `the wake's _intentToArm must restore all seven fields from the scheduled intent (got ${JSON.stringify(wakeMeta)})`);
    try { fs.unlinkSync(intents2); } catch (_) {}
  }

  // --- (5) exportModel.canonical() must fall back to the CLOSED record's copy of ALL SEVEN D038
  // fields once the price request is pruned (req === null) - the whole reason D038 carried them
  // onto closedBids in the first place was so an export survives that prune. Extended (coordinator
  // review of 478b248) to cover capturedAt and marginSource too - the first cut fixed only five of
  // the seven (loadCode, branchName, distanceKm, weight, weightUnit), leaving the Priced-at and
  // Margin Source export columns blank for a pruned row.
  {
    const closedOnly = {
      auctionId: 'B5', status: 'closed', cost: 10000, lastBidPrice: 11000, ourBids: [{ price: 11000 }],
      loadCode: 'HAV-0091', branchName: 'Alwar Cable (1350)', distanceKm: 812, weight: 14000, weightUnit: 'KG',
      capturedAt: 1758800000000, marginSource: 'customer:havells',
    };
    const row = canonical(null, closedOnly);
    ok(row.loadCode === 'HAV-0091', `canonical() must fall back to closed.loadCode once the request is pruned (got ${row.loadCode})`);
    ok(row.branchName === 'Alwar Cable (1350)', `canonical() must fall back to closed.branchName (got ${row.branchName})`);
    ok(row.distanceKm === 812, `canonical() must fall back to closed.distanceKm (got ${row.distanceKm})`);
    ok(row.weight === 14000, `canonical() must fall back to closed.weight (got ${row.weight})`);
    ok(row.weightUnit === 'KG', `canonical() must fall back to closed.weightUnit (got ${row.weightUnit})`);
    ok(row.capturedAt === 1758800000000, `canonical() must fall back to closed.capturedAt - feeds the Priced-at column (got ${row.capturedAt})`);
    ok(row.marginSource === 'customer:havells', `canonical() must fall back to closed.marginSource - feeds the Margin Source column (got ${row.marginSource})`);
    // capturedAt's fallback also fixes `participated` (capturedAt != null) for a pruned-but-priced
    // row - it used to read false there, which is exactly what pricedRow()'s row._closed OR-branch
    // exists to paper over; this makes the two agree instead of one silently compensating.
    ok(row.participated === true, `a pruned row that WAS priced (closed.capturedAt set) must read participated true (got ${row.participated})`);

    // Control: the request side still wins when BOTH are present (the request is the fresher,
    // discovery-time snapshot; the closed doc is the fallback, not a replacement).
    const req = {
      loadId: 'B5', capturedAt: 1758900000000, marginSource: 'bid',
      load: { loadCode: 'FRESH-CODE', branchName: 'Fresh Branch', distanceKm: 5, weight: 1, weightUnit: 'MT' },
    };
    const rowWithReq = canonical(req, closedOnly);
    ok(rowWithReq.loadCode === 'FRESH-CODE' && rowWithReq.branchName === 'Fresh Branch'
      && rowWithReq.distanceKm === 5 && rowWithReq.weight === 1 && rowWithReq.weightUnit === 'MT'
      && rowWithReq.capturedAt === 1758900000000 && rowWithReq.marginSource === 'bid',
      `control: the live request's own fields still win over the closed fallback, for all seven (got ${JSON.stringify({ loadCode: rowWithReq.loadCode, branchName: rowWithReq.branchName, distanceKm: rowWithReq.distanceKm, weight: rowWithReq.weight, weightUnit: rowWithReq.weightUnit, capturedAt: rowWithReq.capturedAt, marginSource: rowWithReq.marginSource })})`);

    // Control: a request with NO capturedAt of its own (never priced while the request lived, but
    // priced by the time it armed and closed - the arm-time snapshot on closed is what proves it)
    // still falls back correctly rather than treating req.capturedAt's mere presence as authoritative.
    const reqNoCappedAt = { loadId: 'B5', capturedAt: null, load: {} };
    const rowFallsBack = canonical(reqNoCappedAt, closedOnly);
    ok(rowFallsBack.capturedAt === 1758800000000, `a request with no capturedAt of its own still falls back to closed.capturedAt (got ${rowFallsBack.capturedAt})`);
  }

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
