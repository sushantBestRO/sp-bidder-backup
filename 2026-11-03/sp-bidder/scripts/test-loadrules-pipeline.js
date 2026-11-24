'use strict';
/**
 * LoadRules CARRY PATH (Module 2 foundation, audit fix #1).
 *
 * The per-load rules object is derived ONCE and must survive every hop to placeBid:
 *   deriveLoadRules -> realAdapter._mapLoad(load.rules) -> priceRequests.createForLoad(req.load.rules)
 *   -> armFromRequest(meta.rules) -> BidEngine.arm(monitor.meta.rules) + the durable intent
 *   -> _intentToArm/rehydrate (survives a wake + a restart, exactly like companyName/points do).
 * If any hop dropped it, a re-armed or rehydrated load would lose the per-load facts the payload
 * builder will need (the carrier-per-load PR would then bid under the WRONG carrier after a restart).
 *
 *   node scripts/test-loadrules-pipeline.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { PriceRequestStore, armFromRequest } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const tmp = (tag) => path.join(os.tmpdir(), `loadrules-${tag}-${process.pid}.json`);
const BAND = [12.6, 7.2, 6.3];

(async () => {
  // ---- 1. deriveLoadRules maps the raw SP fields the mechanics need ----
  {
    const r = deriveLoadRules({
      id: 23088090, branchCarrierCarrierId: 10686, branchFreighterId: 55, loadIsTransitTimeOn: 1,
      ceilingPrice: 120000, branchQuoteType: 'PER_TRUCK', brancheUnit: 'KG', branchAuctionExtendTime: '00:05:00',
      branchBidCountAllowed: 3,
    });
    assert.strictEqual(r.loadId, '23088090', 'loadId is stringified');
    assert.strictEqual(r.branchCarrierCarrierId, 10686, 'per-load carrier captured (the carrier-PR fact)');
    assert.strictEqual(r.branchFreighterId, 55, 'branchFreighterId captured');
    assert.strictEqual(r.loadIsTransitTimeOn, true, 'transit flag captured as a boolean');
    assert.strictEqual(r.ceilingPrice, 120000, 'ceilingPrice captured');
    assert.strictEqual(r.rateType, 'PER_TRUCK', 'rateType from branchQuoteType');
    assert.strictEqual(r.unit, 'KG', 'unit from brancheUnit');
    assert.strictEqual(r.softClose, true, 'softClose derived from a non-zero extend time');
    assert.strictEqual(r.extendSeconds, 300, 'extendSeconds parsed from HH:MM:SS');
    assert.strictEqual(r.revisionLimit, 3, 'revisionLimit captured');
    assert.strictEqual(r.pricingMode, 'flat', 'pricingMode is flat (the only built pricing mode)');
    // transit is a BUILT mechanic: a transit-required load declares it (classification at
    // discovery), and the guard lets it through because SUPPORTED_MECHANICS carries the token.
    assert.deepStrictEqual(r.requires, ['transit_time'], 'a transit-required load declares the transit_time mechanic');
    const rOff = deriveLoadRules({ id: 1, branchAuctionExtendTime: '00:00:00' });
    assert.deepStrictEqual(rOff.requires, [], 'requires stays empty for a transit-off load (the flat baseline)');
    assert.strictEqual(deriveLoadRules(null), null, 'null raw load -> null rules');
    ok('deriveLoadRules maps branchCarrierCarrierId/transit/ceiling/rateType/unit/close/revision');
  }

  // ---- 2. realAdapter._mapLoad attaches a LoadRules onto the mapped load ----
  {
    const a = new RealSuperProcureAdapter({ token: 't' });
    a.account = { carrierId: 2667, serverTimeOffsetMs: 0 };
    const mapped = a._mapLoad({ id: 23088090, companyName: 'Syngenta India', branchCarrierCarrierId: 10686,
      biddingOn: 1, biddingCloseTime: new Date(Date.now() + 60000).toISOString(), branchAuctionExtendTime: '00:00:00' });
    assert.ok(mapped.rules, '_mapLoad attaches a rules object');
    assert.strictEqual(mapped.rules.branchCarrierCarrierId, 10686, 'the mapped load rules carry the per-load carrier');
    assert.strictEqual(mapped.rules.loadId, '23088090', 'the mapped load rules carry the loadId');
    ok('_mapLoad attaches LoadRules (derived once at the adapter, the audit\'s "derive in _mapLoad")');
  }

  // ---- 3. createForLoad snapshots rules; armFromRequest carries them onto monitor.meta + the intent ----
  {
    const f = tmp('live');
    const store = createStore({ backend: 'memory' });
    const engine = new BidEngine(
      { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
        ensureSession: async () => ({}), writeEnabled: true,
        getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null, closesInMs: 8000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
        placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }) },
      new DurableScheduler(f), { config: { minInterFireMs: 0 } });
    const rq = new PriceRequestStore({ store, marginsPct: BAND, minMarginPct: 6.3 });

    const rules = deriveLoadRules({ id: 'PIPE1', branchCarrierCarrierId: 10686, branchAuctionExtendTime: '00:00:00', branchBidCountAllowed: 3 });
    const load = { id: 'PIPE1', lane: { origin: 'A', destination: 'B' }, equipment: 'Trailer', units: 1,
      companyName: 'Syngenta India', closesAt: Date.now() + 120000, startsAt: Date.now() - 1000, status: 'live', softClose: false, rules };

    const created = await rq.createForLoad(load);
    assert.deepStrictEqual(created.load.rules, rules, 'createForLoad snapshots the LoadRules WHOLE onto req.load');

    const capt = await rq.capture(created.id, { cost: 80000 });
    const monitor = armFromRequest(engine, capt);
    if (monitor && monitor.timer) clearTimeout(monitor.timer);
    assert.deepStrictEqual(monitor.meta.rules, rules, 'armFromRequest carries the rules onto monitor.meta (placeBid opts source)');
    assert.deepStrictEqual(engine.scheduler.get('PIPE1').rules, rules, 'arm() persists the rules on the durable intent');
    ok('createForLoad -> armFromRequest -> monitor.meta + durable intent all carry the LoadRules');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ---- 4. the intent round-trip restores rules (wake path) AND survives a restart (rehydrate) ----
  {
    const f = tmp('restart');
    const rules = deriveLoadRules({ id: 'PIPE2', branchCarrierCarrierId: 4441, branchAuctionExtendTime: '00:00:00' });
    const mkEngine = () => new BidEngine(
      { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
        ensureSession: async () => ({}), writeEnabled: true,
        getAuctionState: async () => ({ ok: true, status: 'live', myRank: 2, totalBidders: 2, standingL1Price: null, closesInMs: 8000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
        placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }) },
      new DurableScheduler(f), { config: { minInterFireMs: 0 } });

    // session 1: arm live, then "crash"
    const e1 = mkEngine();
    const m1 = e1.arm({ id: 'PIPE2', lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Durian', closesAt: Date.now() + 8000, rules },
      { cost: 80000, marginsPct: BAND, minMarginPct: 6.3 });
    if (m1.timer) clearTimeout(m1.timer);
    // the wake path: _intentToArm rebuilds meta.rules from the persisted intent
    const rebuiltMeta = e1._intentToArm(e1.scheduler.get('PIPE2')).meta;
    assert.deepStrictEqual(rebuiltMeta.rules, rules, '_intentToArm restores rules from the intent (scheduled-wake path)');
    e1.kill('simulated crash');

    // session 2: fresh engine, same intent file -> rehydrate re-arms with rules intact
    const e2 = mkEngine();
    await e2.rehydrate();
    const m2 = e2.monitors.get('PIPE2');
    assert.ok(m2, 'rehydrate re-armed the load');
    assert.deepStrictEqual(m2.meta.rules, rules, 'rehydrated monitor.meta carries the LoadRules after a restart');
    ok('LoadRules survives the intent round-trip (wake) and a full restart (rehydrate)');
    e2.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  console.log(`\n${pass}/4 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
