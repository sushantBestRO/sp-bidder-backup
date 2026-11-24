'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk in the SHIPPED timing regime (engine review of cd484de): the default settings,
 * where the landing time is longer than the step time, and GoComet reads publishing clockErrorMs 100
 * (snapped to the server's second) or 1,000. The other suites fix landing = step for exact arithmetic;
 * this one checks the walk still does its job with what actually ships. It also runs the engine's own
 * timers on the virtual clock, so the GoComet clock fallback fires through its real timer.
 *
 *   node scripts/test-walk-shipped-regime.js
 */
const H = require('./lib/walk-harness');
const walkMath = require('../src/engine/walk');

const EXPECTED = 7;
const BAND_GC = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const SHIPPED = { sp: { enabled: true, stepTimeSource: 'manual' }, gocomet: { enabled: true, stepTimeSource: 'manual' } };
const GC_LOWEST = 50_900;

(async () => {
  console.log('T9 walk - shipped timing regime');

  if (!(walkMath.DEFAULT_WALK.sp.landMs > walkMath.DEFAULT_WALK.sp.stepTimeMs && walkMath.DEFAULT_WALK.gocomet.landMs > walkMath.DEFAULT_WALK.gocomet.stepTimeMs)) {
    console.log('  HARNESS: the shipped landing times are no longer longer than the step times; revisit this suite');
  }

  for (const clockErrorMs of [100, 1_000]) {
    await H.check(`GoComet final round, outranked with the top standing, clockErrorMs ${clockErrorMs}: the walk bids inside its window and ends on the lowest`, async () => {
      const r = H.load({ platform: 'gc', band: BAND_GC, walk: SHIPPED, gc: { clockErrorMs, roundPolicy: { finalAfterExtensions: 0 } } });
      r.seedStanding(0, 3);
      for (let cd = 15_000; cd >= 200; cd -= 100) await r.at(cd, { rank: 2 });
      r.done();
      const bad = [];
      if (!r.writes.length) bad.push('no bid');
      if (r.writes.some((w) => w.cd > walkMath.DEFAULT_WALK.gocomet.maxWalkWindowMs)) bad.push(`a bid before the 10,000 window: ${JSON.stringify(r.trace())}`);
      if (r.writes.length && r.writes[r.writes.length - 1].price !== GC_LOWEST) bad.push(`the last bid is not the lowest: ${JSON.stringify(r.trace())}`);
      const safety = clockErrorMs + walkMath.DEFAULT_WALK.gocomet.safetyMarginMs;
      const lastCd = r.writes.length ? r.writes[r.writes.length - 1].cd : 0;
      if (lastCd < walkMath.DEFAULT_WALK.gocomet.landMs + safety) bad.push(`the lowest went at ${lastCd}, inside landing + safety (${walkMath.DEFAULT_WALK.gocomet.landMs + safety})`);
      return bad.join('; ') || null;
    });

    await H.check(`GoComet uncapped round, outranked, clockErrorMs ${clockErrorMs}: never zero bids`, async () => {
      const r = H.load({ platform: 'gc', band: BAND_GC, walk: SHIPPED, gc: { clockErrorMs, roundPolicy: { finalAfterExtensions: null } } });
      r.seedStanding(0, 3);
      for (let cd = 15_000; cd >= 200; cd -= 100) await r.at(cd, { rank: 2 });
      r.done();
      return r.writes.length ? null : 'no bid in an outranked uncapped round';
    });
  }

  await H.check('SuperProcure hard close, outranked with the top standing (shipped defaults): the walk stays inside 6,000 and ends on the lowest', async () => {
    const r = H.load({ walk: SHIPPED, sp: { revisionLimit: 3 } });
    r.seedStanding(0, 2);
    for (let cd = 12_000; cd >= 100; cd -= 100) await r.at(cd, { rank: 2 });
    r.done();
    const lowest = r.ladder[r.ladder.length - 1];
    const bad = [];
    if (!r.writes.length) bad.push('no bid');
    if (r.writes.some((w) => w.cd > walkMath.DEFAULT_WALK.sp.maxWalkWindowMs)) bad.push(`a bid before the 6,000 window: ${JSON.stringify(r.trace())}`);
    if (r.writes.length && r.writes[r.writes.length - 1].price !== lowest) bad.push(`the last bid is not the lowest: ${JSON.stringify(r.trace())}`);
    return bad.join('; ') || null;
  });

  await H.check('GoComet confirmed final round at rank 1 (shipped defaults, switch off): holds - nothing sent', async () => {
    const r = H.load({ platform: 'gc', band: BAND_GC, walk: SHIPPED, gc: { clockErrorMs: 100, roundPolicy: { finalAfterExtensions: 0 } } });
    r.seedStanding(0, 3);
    for (let cd = 15_000; cd >= 200; cd -= 100) await r.at(cd, { rank: 1 });
    r.done();
    return r.writes.length ? `sent ${JSON.stringify(r.trace())} at rank 1` : null;
  });

  await H.check('engine timers on the virtual clock: with the read hanging, the GoComet clock fallback fires through its own timer at the last-step deadline', async () => {
    const clock = H.useFakeTimers();
    const r = H.load({ platform: 'gc', band: BAND_GC, walk: SHIPPED, keepTimers: true, gc: { clockErrorMs: 100, roundPolicy: { finalAfterExtensions: null } } });
    r.seedStanding(0, 3);
    await r.at(60_000, { rank: 2 });
    await r.at(20_000, { rank: 2 });
    r.ctrl.readDefer = true;
    await clock.advanceTo(r.close - 1_000);
    if (r.ctrl.releaseRead) r.ctrl.releaseRead();
    const t = walkMath.DEFAULT_WALK.gocomet;
    const at = t.landMs + 100 + t.safetyMarginMs;
    r.m.finalized = true;
    r.done();
    const w = r.writes[0];
    if (!w) return `nothing sent while the read hung (queue ${clock.queue.length})`;
    return w.cd === at ? null : `the fallback sent ${JSON.stringify(r.trace())}, expected one bid at ${at}`;
  });

  H.finish('T9 walk shipped timing regime', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
