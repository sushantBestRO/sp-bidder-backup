'use strict';
/**
 * THE PER-TONNE PRICING MODE IS RECONCILED AND GATED ON EVERY PATH THAT PLANS A LADDER.
 *
 * Regression targets:
 *   A055 - _planFor honoured inputs.roundStep off a durable intent even on a per-tonne load, so a
 *          restart or scheduled wake snapped a per-MT rate onto the rupee grid that the arm path
 *          refuses (_resolveRoundingStep returns null for per_tonne). The refusal holds on every path.
 *   A056 - reconcilePricingMode ran only in arm(). schedule() planned on the raw snapshot, so a PMT
 *          load whose snapshot predates the per-tonne build persisted a flat-space ladder while the
 *          woken monitor armed a per-tonne one; the by-price spend tracking then compares two
 *          different ladders.
 *   A057 - planPreview neither reconciled the mode nor ran assertRulesSupported, so the price page
 *          showed a priced, biddable plan for a load the engine refuses outright, with no "will not
 *          bid", and on a stale snapshot re-spaced a per-MT ladder the arm never builds.
 *   A060 - assertRulesSupported tested pricingMode against the supported-MECHANICS set, which holds
 *          'transit_time'; a mechanic token in the pricingMode field passed the fail-closed gate.
 *
 * What must not move: a flat load plans, schedules, previews and snaps exactly as before.
 *
 * Offline: a stub adapter, the real engine, a temp-file scheduler; every planned wake is cleared.
 *
 *   node scripts/test-pricing-mode-every-path.js
 */
process.env.LOG_LEVEL = 'silent';
delete process.env.SP_PMT_BID;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { assertRulesSupported } = require('../src/model/loadRules');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmpFiles = [];
process.on('exit', () => { for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} } });
const tmp = () => { const f = path.join(os.tmpdir(), `pricing-mode-${process.pid}-${tmpFiles.length}.json`); tmpFiles.push(f); return f; };
const engines = [];
function mkEngine({ rounding } = {}) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }), placeBid: async () => ({ accepted: true }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), { config: {}, softClose: { enabled: false }, onEvent: () => {} });
  if (rounding) eng.setRounding(rounding);
  engines.push(eng);
  return eng;
}
const stopTimers = () => {
  for (const eng of engines) {
    for (const t of eng.scheduledTimers.values()) clearTimeout(t);
    for (const m of eng.monitors.values()) if (m.timer) clearTimeout(m.timer);
  }
};

const PMT = { pricingMode: 'per_tonne', rateType: 'PMT', unit: 'MT', minDecrement: 1000 };
const PMT_STALE = { pricingMode: 'flat', rateType: 'PMT', unit: 'MT', minDecrement: 1000 };
const FLAT = { pricingMode: 'flat', rateType: 'FTL', minDecrement: 1000 };
const perMt = { cost: 2237, marginsPct: [12, 7, 2], minMarginPct: 2 };
const perTruck = { cost: 50_000, marginsPct: [12, 7, 2], minMarginPct: 2 };
const meta = (id, rules, extra) => Object.assign({ id, lane: { origin: 'Pune', destination: 'Delhi' }, units: 1,
  equipment: '32ft', companyName: 'Vishal Pipes', closesAt: Date.now() + 3_600_000, rules }, extra || {});
const GRID = { enabled: true, shippers: ['Vishal'], step: 100 };

console.log('\nA060 - the pricing-mode gate tests the pricing-mode namespace');
{
  let err = null;
  try { assertRulesSupported({ pricingMode: 'transit_time' }); } catch (e) { err = e; }
  ok(!!err && err.code === 'UNSUPPORTED_RULE', `a mechanic token in pricingMode is refused (${err ? err.message : 'passed'})`);
  let flatErr = null;
  try { assertRulesSupported({ pricingMode: 'flat', requires: ['transit_time'] }); } catch (e) { flatErr = e; }
  ok(!flatErr, 'a flat, transit-required load still passes');
}

console.log('\nA055 - a per-tonne ladder is never snapped to the grid, whichever path plans it');
{
  const noGrid = mkEngine()._planFor(Object.assign({}, perMt, { roundStep: null }), PMT, 'Vishal Pipes').plan.ladder;
  const eng = mkEngine({ rounding: GRID });
  const fromIntent = eng.arm(meta('PMT-INTENT', PMT), Object.assign({}, perMt, { roundStep: 100 }));
  ok(same(fromIntent.ladder, noGrid), `an intent carrying a grid step arms the per-MT ladder unsnapped (${fromIntent.ladder} vs ${noGrid})`);
  const healed = eng.arm(meta('PMT-HEAL', PMT_STALE), Object.assign({}, perMt, { roundStep: 100 }));
  ok(same(healed.ladder, noGrid), `a stale-flat PMT intent carrying a grid step is healed AND unsnapped (${healed.ladder})`);
  const flatArm = eng.arm(meta('FLAT-INTENT', FLAT), Object.assign({}, perTruck, { roundStep: 100 }));
  ok(flatArm.ladder.every((p) => p % 100 === 0), `control: a flat load from the same intent shape is still snapped (${flatArm.ladder})`);
  stopTimers();
}

console.log('\nA056 - schedule() persists the ladder the wake will arm');
{
  const starts = { startsAt: Date.now() + 3_600_000, closesAt: Date.now() + 7_200_000 };
  const armLadder = mkEngine().arm(meta('PMT-SCHED', PMT_STALE, starts), perMt).ladder;
  const intent = mkEngine().schedule(meta('PMT-SCHED', PMT_STALE, starts), perMt);
  ok(same(intent.ladder, armLadder), `the scheduled intent's ladder is the armed ladder (${intent.ladder} vs ${armLadder})`);
  ok(intent.rules && intent.rules.pricingMode === 'per_tonne', `and its rules are persisted in per-tonne space (${intent.rules && intent.rules.pricingMode})`);
  const flatArmLadder = mkEngine().arm(meta('FLAT-SCHED', FLAT, starts), perTruck).ladder;
  const flatIntent = mkEngine().schedule(meta('FLAT-SCHED', FLAT, starts), perTruck);
  ok(same(flatIntent.ladder, flatArmLadder) && flatIntent.rules.pricingMode === 'flat', 'control: a flat load schedules exactly as it arms');
  stopTimers();
}

console.log('\nA057 - the preview plans in the space arm() uses, and says when the engine will not bid');
{
  const eng = mkEngine();
  const stale = eng.planPreview(meta('PV-1', PMT_STALE), perMt);
  ok(stale.willNotBid != null && stale.ladder.length === 0,
    `a PMT load the engine refuses (per-tonne bidding off) previews as will-not-bid, no prices (${stale.willNotBid}, ${JSON.stringify(stale.ladder)})`);
  const good = eng.planPreview(meta('PV-2', PMT), perMt);
  ok(good.willNotBid === stale.willNotBid && good.ladder.length === 0, 'the same for a correctly-classified PMT load');
  process.env.SP_PMT_BID = '1';
  const armed = mkEngine().arm(meta('PV-3', PMT_STALE), perMt).ladder;
  const live = eng.planPreview(meta('PV-3', PMT_STALE), perMt);
  ok(!live.willNotBid && same(live.ladder, armed), `with per-tonne bidding on, a stale snapshot previews the armed ladder (${live.ladder} vs ${armed})`);
  delete process.env.SP_PMT_BID;
  const flatArm = mkEngine().arm(meta('PV-4', FLAT), perTruck).ladder;
  const flatPv = eng.planPreview(meta('PV-4', FLAT), perTruck);
  ok(!flatPv.willNotBid && same(flatPv.ladder, flatArm), `control: a flat load previews its armed ladder (${flatPv.ladder})`);
  stopTimers();
}

const total = pass + fail;
if (fail) { console.error(`\nFAILED: ${fail} of ${total} checks`); process.exit(1); }
console.log(`\n${pass}/${total} checks passed`);
process.exit(0);
