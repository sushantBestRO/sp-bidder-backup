'use strict';
/**
 * S4 - a zero/negative floor margin must not arm at cost on ANY arm path.
 *
 * #238 put the substitution in armFromRequest, which the restart rehydrate and the scheduled wake
 * both bypass: they rebuild inputs from the durable intent and call engine.arm() directly. A row
 * carrying a stored 0 therefore armed with floor === the desk's own cost, silently, on exactly the
 * event every deploy performs (`sh scripts/deploy.sh` restarts pm2). Historical cost of this
 * failure: 133 loads, 77 bid at cost, 13 won, Rs 5,59,500 of freight at no margin.
 *
 * Five input shapes reach buildBandLadder's arithmetic and produce floor === cost. The last two
 * are invisible to a guard that tests Number.isFinite(Number(minMarginPct)), because
 * Number(undefined) is NaN and buildBandLadder then falls back to the band's LOWEST margin:
 *   1. minMarginPct 0
 *   2. minMarginPct -5
 *   3. minMarginPct ''          (Number('') === 0)
 *   4. minMarginPct undefined, band lowest 0
 *   5. minMarginPct undefined, band lowest negative
 *
 *   node scripts/test-zero-floor-arm-paths.js
 */
process.env.STORE_BACKEND = 'memory';
process.env.SP_ROUNDING_ENABLED = '0';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const appConfig = require('../src/config');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (tag) => path.join(os.tmpdir(), `s4-floor-${tag}-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

const COST = 38000;
const HOUSE = 6.3;

// Every shape whose effective floor margin resolves to <= 0. `marginsPct` is the desk's band; the
// last two carry no explicit floor at all, so buildBandLadder falls back to the band's lowest.
const SHAPES = [
  { name: 'minMarginPct 0', marginsPct: [12.6, 7.2, 6.3], minMarginPct: 0 },
  { name: 'minMarginPct -5', marginsPct: [12.6, 7.2, 6.3], minMarginPct: -5 },
  { name: 'minMarginPct "" (empty string)', marginsPct: [12.6, 7.2, 6.3], minMarginPct: '' },
  { name: 'minMarginPct undefined, band lowest 0', marginsPct: [12.6, 7.2, 0], minMarginPct: undefined },
  { name: 'minMarginPct undefined, band lowest -3', marginsPct: [12.6, 7.2, -3], minMarginPct: undefined },
];

// No bid may leave this rig: rank 1 holds every selector, and placeBid throws if one ever tries.
function quietAdapter() {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: true, status: 'live', myRank: 1, totalBidders: 2,
      standingL1Price: null, closesInMs: 600_000, revisionsLeft: 3, closeModel: 'hard', measuredRttMs: 50 }),
    placeBid: async () => { throw new Error('this test must never place a bid'); },
  };
}

function rig(file, extra) {
  const events = [];
  const engine = new BidEngine(quietAdapter(), new DurableScheduler(file), Object.assign({
    config: { armLeadMs: 150 },
    onEvent: (e) => events.push(e),
  }, extra || {}));
  return { engine, events };
}

function intent(id, shape, extra) {
  return Object.assign({
    auctionId: id, lane: { origin: 'Bhiwandi', destination: 'Bawal' }, equipment: '32 Feet', units: 1,
    companyName: 'Adama India Private Limited', branchName: null, rules: null, platformKey: null,
    closesAt: Date.now() + 40 * 60_000,
    cost: COST, marginsPct: shape.marginsPct, minMarginPct: shape.minMarginPct,
    ladder: [], firedRungs: [], status: 'armed', finalRank: null, won: null,
  }, extra || {});
}

const substitutionAlert = (events, id) => events.find((e) => e.type === 'alert'
  && e.kind === 'zero_floor_margin_substituted' && e.auctionId === id);

function report(label, id, engine, events) {
  const m = engine.monitors.get(id);
  const floor = m ? m.floor : null;
  const ladder = m ? m.ladder : null;
  ok(!!m, `${label}: the load still arms (a bad stored margin must never forfeit the auction)`);
  ok(floor != null && floor > COST,
    `${label}: floor ${floor} is above the desk cost ${COST} (ladder ${JSON.stringify(ladder)})`);
  ok(!!substitutionAlert(events, id), `${label}: the substitution is announced, not silent`);
}

(async () => {
  appConfig.minMarginPct = HOUSE;

  // ===============================================================================================
  console.log('\n1. RESTART: a durable intent replayed by rehydrate() must not arm at cost');
  // ===============================================================================================
  for (const shape of SHAPES) {
    const f = tmp('restart');
    const id = 'S4-RESTART';
    { const { engine } = rig(f); engine.scheduler.upsert(intent(id, shape)); engine.kill('seeded'); }
    const { engine, events } = rig(f);
    await engine.rehydrate();
    report(`restart / ${shape.name}`, id, engine, events);
    const healed = engine.scheduler.get(id);
    ok(healed && Number(healed.minMarginPct) > 0,
      `restart / ${shape.name}: the durable intent no longer carries the bad margin (${healed && healed.minMarginPct})`);
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ===============================================================================================
  console.log('\n2. SCHEDULED WAKE: a not-yet-live intent armed by its wake must not arm at cost');
  // ===============================================================================================
  for (const shape of SHAPES) {
    const f = tmp('wake');
    const id = 'S4-WAKE';
    {
      const { engine } = rig(f);
      engine.scheduler.upsert(intent(id, shape, { status: 'scheduled', startsAt: Date.now() + 250 }));
      engine.kill('seeded');
    }
    const { engine, events } = rig(f);
    await engine.rehydrate();      // scheduled intents re-plan their wake
    await sleep(700);              // wake fires at startsAt - armLeadMs
    report(`wake / ${shape.name}`, id, engine, events);
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ===============================================================================================
  console.log('\n3. DIRECT ARM + SCHEDULE: the two engine entry points carry the same guard');
  // ===============================================================================================
  {
    const f = tmp('direct');
    const { engine, events } = rig(f);
    const meta = { id: 'S4-ARM', lane: { origin: 'A', destination: 'B' }, equipment: '32 Feet', units: 1,
      companyName: 'Adama India Private Limited', rules: null, closesAt: Date.now() + 40 * 60_000 };
    engine.arm(meta, { cost: COST, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 0 });
    report('direct arm()', 'S4-ARM', engine, events);
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }
  {
    const f = tmp('schedule');
    const { engine, events } = rig(f);
    const meta = { id: 'S4-SCHED', lane: { origin: 'A', destination: 'B' }, equipment: '32 Feet', units: 1,
      companyName: 'Adama India Private Limited', rules: null,
      startsAt: Date.now() + 10 * 60_000, closesAt: Date.now() + 40 * 60_000 };
    engine.schedule(meta, { cost: COST, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 0 });
    const it = engine.scheduler.get('S4-SCHED');
    ok(it && Number(it.minMarginPct) > 0,
      `schedule(): the intent it persists carries a real floor margin (${it && it.minMarginPct})`);
    ok(Array.isArray(it && it.ladder) && it.ladder[it.ladder.length - 1] > COST,
      `schedule(): the persisted ladder bottoms out above cost (${JSON.stringify(it && it.ladder)})`);
    ok(!!substitutionAlert(events, 'S4-SCHED'), 'schedule(): the substitution is announced');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ===============================================================================================
  console.log('\n4. NOTHING TO FALL BACK TO: refuse rather than arm at cost');
  // ===============================================================================================
  {
    appConfig.minMarginPct = 0;
    const f = tmp('bothzero');
    const { engine } = rig(f);
    const meta = { id: 'S4-BOTHZERO', lane: { origin: 'A', destination: 'B' }, equipment: '32 Feet', units: 1,
      companyName: 'Adama India Private Limited', rules: null, closesAt: Date.now() + 40 * 60_000 };
    let err = null;
    try { engine.arm(meta, { cost: COST, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 0 }); } catch (e) { err = e; }
    ok(err && err.code === 'BAD_INPUT', `arm() refuses with BAD_INPUT when the house default is 0 too (${err && err.code})`);
    ok(!engine.monitors.has('S4-BOTHZERO'), 'nothing was armed');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
    appConfig.minMarginPct = HOUSE;
  }

  // ===============================================================================================
  console.log('\n5. NO REGRESSION: a real band arms byte-identically and says nothing');
  // ===============================================================================================
  {
    const f = tmp('ok');
    const { engine, events } = rig(f);
    const meta = { id: 'S4-OK', lane: { origin: 'A', destination: 'B' }, equipment: '32 Feet', units: 1,
      companyName: 'Adama India Private Limited', rules: null, closesAt: Date.now() + 40 * 60_000 };
    const m = engine.arm(meta, { cost: COST, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    ok(JSON.stringify(m.ladder) === JSON.stringify([42788, 40736, 40394]),
      `a real band builds the unchanged ladder (${JSON.stringify(m.ladder)})`);
    ok(!substitutionAlert(events, 'S4-OK'), 'no substitution alert on a real band');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }
  {
    // The band-lowest default still works when that lowest margin is positive: no explicit floor
    // must NOT be mistaken for a zero floor.
    const f = tmp('default');
    const { engine, events } = rig(f);
    const meta = { id: 'S4-DEFAULT', lane: { origin: 'A', destination: 'B' }, equipment: '32 Feet', units: 1,
      companyName: 'Adama India Private Limited', rules: null, closesAt: Date.now() + 40 * 60_000 };
    const m = engine.arm(meta, { cost: COST, marginsPct: [12.6, 7.2, 6.3] });
    ok(m.floor === 40394, `an omitted floor margin still defaults to the band's lowest (${m.floor})`);
    ok(!substitutionAlert(events, 'S4-DEFAULT'), 'an omitted floor margin raises no substitution alert');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
  }

  // ===============================================================================================
  console.log('\n6. ONE POISONED INTENT MUST NOT TAKE THE WHOLE BATCH DOWN');
  // ===============================================================================================
  {
    // The refusal in section 4 is raised INSIDE rehydrate()'s per-intent loop, which production
    // reaches through activateRealStack() -> boot(). Unguarded, one unusable stored margin ends the
    // whole rehydrate, empties `stacks`, exits the process - and pm2 restarts it onto the same
    // intent, forever. A blank SP_MIN_MARGIN_PCT= is the whole trigger: Number('') is 0.
    appConfig.minMarginPct = 0;
    const f = tmp('poison');
    {
      const { engine } = rig(f);
      // Seeded bad-first so an unguarded loop dies before it ever reaches the healthy one.
      engine.scheduler.upsert(intent('S4-BAD', { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 0 }));
      engine.scheduler.upsert(intent('S4-GOOD', { marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 }));
      engine.kill('seeded');
    }
    const { engine, events } = rig(f);
    let err = null;
    try { await engine.rehydrate(); } catch (e) { err = e; }
    ok(!err, `rehydrate() survives an intent it cannot arm (${err && err.message})`);
    ok(engine.monitors.has('S4-GOOD'), 'every other live auction still re-arms');
    ok(!engine.monitors.has('S4-BAD'), 'the unusable intent is skipped rather than armed at cost');
    ok(!!events.find((e) => e.type === 'alert' && e.level === 'error'
      && e.kind === 'rehydrate_arm_failed' && e.auctionId === 'S4-BAD'),
      'the skipped load is alerted, not dropped in silence');
    engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
    appConfig.minMarginPct = HOUSE;
  }

  // ===============================================================================================
  console.log('\n7. THE RUNG COUNT IS DERIVED FROM THE SUBSTITUTED FLOOR, NOT THE STORED ONE');
  // ===============================================================================================
  {
    // _deriveRungCount rebuilds the coarse band to read its anchor count and rupee span. Off the raw
    // stored 0 that band carries an extra rung AT COST and a span 27% wider, so the FINE ladder is
    // sized against the band the rest of the plan has already replaced. Only reachable with a real
    // `rules` object - the fine-ladder gate needs revisionLimit > LOW_CAP_THRESHOLD plus the
    // soft-close allowlist - which is why every case above, passing `rules: null`, cannot see it.
    const RULES = { revisionLimit: 5, minDecrement: 500 };
    const MARGINS = [30, 24, 18, 12, 6.3];
    const armFine = (id, minMarginPct) => {
      const f = tmp('rung');
      const { engine } = rig(f, { softClose: { enabled: true, shippers: ['Adama'], mode: 'shadow' } });
      const m = engine.arm({ id, lane: { origin: 'A', destination: 'B' }, equipment: '32 Feet', units: 1,
        companyName: 'Adama India Private Limited', rules: RULES,
        closesAt: Date.now() + 40 * 60_000 }, { cost: COST, marginsPct: MARGINS, minMarginPct });
      const ladder = m.ladder;
      engine.kill('test done'); try { fs.unlinkSync(f); } catch (_) {}
      return ladder;
    };
    const substituted = armFine('S4-RUNG-SUB', 0);       // stored 0 -> armed on the house 6.3
    const configured = armFine('S4-RUNG-CFG', HOUSE);    // the same 6.3, stored properly
    ok(JSON.stringify(substituted) === JSON.stringify(configured),
      'a substituted floor arms the identical fine ladder to the same floor stored properly'
      + ` (substituted ${JSON.stringify(substituted)} vs configured ${JSON.stringify(configured)})`);
    ok(substituted[substituted.length - 1] > COST,
      `the fine ladder still bottoms out above cost (${substituted[substituted.length - 1]} vs ${COST})`);
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
