'use strict';
/**
 * Regression pins for the 2026-07-25 test-pass fix batch (docs/tests/..._master.md B3/B4/B5):
 *
 *   B3  planPreview mirrors arm()'s ceiling gate - a capped ladder previews capped, and a ceiling
 *       below the operating floor previews as willNotBid instead of a biddable ladder.
 *   B4  _observeExtension never lets a mid-auction wire read LOWER a known extendCap - a transient
 *       junk 0 must not flip a capped soft load to effectively-hard (floor inside the trigger window).
 *   B5  the constructor's softClose merge sanitizes numeric fields like setSoftClose does - a
 *       malformed env (NaN) falls back to the DEFAULT_SOFT value instead of silently disabling
 *       establish/defend on an allowlisted soft load.
 *
 *   node scripts/test-fix-regressions.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `fix-reg-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

function mkEngine(softClose, cfgOverrides) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: Object.assign({ openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 }, cfgOverrides || {}),
    softClose,
  });
}

// BAND -> anchors [22400, 21600, 20800], floor 20800 (cost*(1+m/100), hand-derived).
const BAND = { cost: 20_000, marginsPct: [12, 8, 4], minMarginPct: 4 };

// ---- B3: planPreview ceiling parity -------------------------------------------------------------
{
  const eng = mkEngine();
  const uncapped = eng.planPreview({ id: 'L1', rules: null, companyName: null }, BAND);
  assert.deepStrictEqual(uncapped.ladder, [22400, 21600, 20800]);
  assert.strictEqual(uncapped.willNotBid, undefined);
  assert.strictEqual(uncapped.ceiling, undefined);
  ok('B3: no ceiling -> plain anchor ladder, no willNotBid/ceiling fields');

  const capped = eng.planPreview({ id: 'L2', rules: { ceilingPrice: 22_000 }, companyName: null }, BAND);
  assert.strictEqual(capped.ceiling, 22_000);
  assert.ok(capped.ladder.length >= 2, 'capped ladder still has rungs');
  for (const p of capped.ladder) assert.ok(p <= 22_000, `rung ${p} exceeds the ceiling`);
  assert.strictEqual(capped.ladder[capped.ladder.length - 1], 20_800, 'floor rung survives the cap');
  assert.strictEqual(capped.floor, 20_800);
  assert.strictEqual(capped.rungCount, capped.ladder.length);
  ok('B3: ceiling above floor -> ladder capped, floor intact, ceiling surfaced');

  const refused = eng.planPreview({ id: 'L3', rules: { ceilingPrice: 20_000 }, companyName: null }, BAND);
  assert.strictEqual(refused.willNotBid, 'ceiling_below_floor');
  assert.deepStrictEqual(refused.ladder, []);
  assert.strictEqual(refused.rungCount, 0);
  assert.strictEqual(refused.floor, 20_800);
  assert.strictEqual(refused.ceiling, 20_000);
  ok('B3: ceiling below floor -> willNotBid, empty ladder, floor still reported');

  const junk = eng.planPreview({ id: 'L4', rules: { ceilingPrice: 'abc' }, companyName: null }, BAND);
  assert.strictEqual(junk.ladder.length, 3, 'junk ceiling ignored like absent');
  assert.strictEqual(junk.willNotBid, undefined);
  ok('B3: junk ceiling string -> ignored (implausible == absent), no crash');
}

// ---- B4: extendCap never lowers mid-auction ------------------------------------------------------
{
  const eng = mkEngine({ enabled: true, shippers: ['Renewsys'], mode: 'live' });
  const mon = { softStrategy: 'live', closeModel: 'soft', extendCap: 2, triggerWindowMs: null,
    believedCloseAt: null, finalized: false, auctionId: 'B4', meta: { lane: '', companyName: 'Renewsys' } };
  eng._observeExtension(mon, { extendCount: 0, closesAtMs: null });
  assert.strictEqual(mon.extendCap, 2, 'transient 0 must not lower a known cap');
  ok('B4: spurious wire 0 does not flip a capped load to effectively-hard');

  eng._observeExtension(mon, { extendCount: 3, closesAtMs: null });
  assert.strictEqual(mon.extendCap, 3, 'upward correction accepted');
  ok('B4: upward cap correction still lands');

  const fresh = { softStrategy: 'live', closeModel: 'soft', extendCap: null, triggerWindowMs: null,
    believedCloseAt: null, finalized: false, auctionId: 'B4b', meta: { lane: '', companyName: 'Renewsys' } };
  eng._observeExtension(fresh, { extendCount: 0, closesAtMs: null });
  assert.strictEqual(fresh.extendCap, 0, 'a genuinely cap-0 load still learns its cap on first read');
  eng._observeExtension(fresh, { extendCount: 3, closesAtMs: null });
  assert.strictEqual(fresh.extendCap, 3, 'and a later real value can only raise it');
  ok('B4: first finite read latches; later reads may only raise');
}

// ---- B5: constructor soft-config sanitize ---------------------------------------------------------
{
  const eng = mkEngine({ enabled: true, shippers: ['X'], mode: 'shadow',
    establishLeadMs: NaN, reserve: 'abc', jumpPerRival: Infinity });
  assert.strictEqual(eng.softCfg.establishLeadMs, 40_000, 'NaN establishLeadMs -> DEFAULT_SOFT');
  assert.strictEqual(eng.softCfg.reserve, 1, 'junk reserve -> DEFAULT_SOFT');
  assert.strictEqual(eng.softCfg.jumpPerRival, 1, 'Infinity jumpPerRival -> DEFAULT_SOFT');
  assert.strictEqual(eng.softCfg.enabled, true, 'non-numeric fields untouched');
  ok('B5: boot-path NaN/junk numerics fall back to safe defaults');

  const eng2 = mkEngine({ enabled: true, shippers: ['X'], mode: 'live',
    establishLeadMs: '30000', reserve: 2, jumpPerRival: '2' });
  assert.strictEqual(eng2.softCfg.establishLeadMs, 30_000, 'numeric string coerces');
  assert.strictEqual(eng2.softCfg.reserve, 2);
  assert.strictEqual(eng2.softCfg.jumpPerRival, 2);
  ok('B5: legitimate numeric values (incl. string-typed env) pass through');

  const eng3 = mkEngine();
  assert.strictEqual(eng3.softCfg.establishLeadMs, 40_000);
  assert.strictEqual(eng3.softCfg.reserve, 1);
  assert.strictEqual(eng3.softCfg.jumpPerRival, 1);
  ok('B5: absent softClose -> defaults byte-identical');
}

for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
console.log(`\n${pass} checks passed`);
