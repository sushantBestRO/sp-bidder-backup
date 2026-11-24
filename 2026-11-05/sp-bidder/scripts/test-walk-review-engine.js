'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: the engine-slice review of cd484de (26 Sep).
 *
 * B1  a limit bid refused for any other reason is retried, and a load that ends with no bid carries a
 *     reason and a notice.
 * N1  SuperProcure's published clockErrorMs is clamped (1,000 ms) and the clamp is logged.
 * S2  never a zero-step walk for an outranked load with an attempt left: a landing time that leaves no
 *     step fitting is capped so the last step fits, with an ops warning.
 * N2  turning the walk off live stops an armed GoComet clock timer from bidding.
 * N3  stop(), _finalize, _retireUnreadable and kill() leave no walk timer behind.
 * N4  at rank 1 in a confirmed-final GoComet round, a read is aimed 500 ms before the no-read deadline.
 * N5  at the last-step deadline (and for the clock shot) the walk takes exactly one step, the lowest.
 *
 *   node scripts/test-walk-review-engine.js
 */
const H = require('./lib/walk-harness');
const walkMath = require('../src/engine/walk');

const EXPECTED = 9;
const BAND_GC = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const FINAL_NOW = { roundPolicy: { finalAfterExtensions: 0 } };
const capRefusal = (x) => ({ reason: `Amount should be less than or equal to ${x}`, text: `Amount should be less than or equal to ${x}` });
const TRANSIENT = { reason: 'Something went wrong, please try again', text: 'Something went wrong, please try again' };
const timersLeft = (m) => [m._walkClockTimer, m._walkPrepTimer].filter(Boolean).length;
const stopTimers = (m) => { for (const k of ['_walkClockTimer', '_walkPrepTimer']) if (m[k]) { clearTimeout(m[k]); m[k] = null; } };

(async () => {
  console.log('T9 walk - engine review findings');

  await H.check('B1: an SP limit bid refused for another reason is sent again (no published cap: bound 3); on a 3-revision load it is held after one, with a reason and a notice', async () => {
    const bad = [];
    for (const revisionLimit of [null, 3]) {
      const r = H.load({ walk: H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 }), sp: { revisionLimit } });
      r.ctrl.refuse.push(capRefusal(90_500));
      for (let i = 0; i < 20; i++) r.ctrl.refuse.push(TRANSIENT);
      for (const cd of [25_000, 24_800, 6_700, 6_500]) await r.at(cd, { rank: null });
      for (let cd = 6_300; cd >= 200; cd -= 200) await r.at(cd, { rank: 2 });
      r.done();
      const atLimit = r.writes.filter((w) => w.price === 90_500).length;
      if (revisionLimit == null && atLimit < 2) bad.push(`no cap: the limit 90,500 went ${atLimit} time(s) (${JSON.stringify(r.trace())}); a transient refusal must not end the walk`);
      if (!r.m.noBid) bad.push(`revisionLimit ${revisionLimit}: no reason on the record for a load with no bid`);
      const loud = r.events.filter((e) => e.type === 'alert' && ['refusal_unrecognised', 'refused_price_bound'].includes(e.kind));
      if (!loud.length) bad.push(`revisionLimit ${revisionLimit}: no notice: alerts ${JSON.stringify(r.events.filter((e) => e.type === 'alert').map((e) => e.kind))}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('N1: a published SP clockErrorMs of 5,000 is clamped to 1,000 and logged; the outranked load still gets its last step (shipped defaults)', async () => {
    const bad = [];
    const shipped = { sp: { enabled: true, stepTimeSource: 'manual' }, gocomet: { enabled: false } };
    const r = H.load({ walk: shipped, sp: { clockErrorMs: 5_000, revisionLimit: 3 } });
    r.seedStanding(0, 2);
    for (let cd = 12_000; cd >= 200; cd -= 100) await r.at(cd, { rank: 2 });
    r.done();
    if (!r.writes.length) bad.push('no bid: the unclamped clock error left no step fitting');
    if (r.params = r.eng.walkParams(r.m, { clockErrorMs: 5_000 }), r.params.safetyMs !== 1_000 + 100) bad.push(`safety ${r.params.safetyMs}, expected 1,100 (clamped 1,000 + margin 100)`);
    if (!r.logs.warn.some((l) => /clock error/i.test(l.m))) bad.push('the clamp was not logged');
    return bad.join('; ') || null;
  });

  await H.check('S2: a landing time that leaves no step in the window is capped so the last step goes, with a warning; the outranked load bids its lowest', async () => {
    const bad = [];
    const cfg = H.walkCfg('sp', { stepTimeMs: 1_000, landMs: 5_000, safetyMarginMs: 500, maxWalkWindowMs: 6_000, probeLeadMs: 6_000 });
    const r = H.load({ walk: cfg, sp: { clockErrorMs: 1_000, revisionLimit: 3 } });
    r.seedStanding(0, 2);
    for (let cd = 12_000; cd >= 200; cd -= 100) await r.at(cd, { rank: 2 });
    r.done();
    const lowest = r.ladder[r.ladder.length - 1];
    if (!r.writes.some((w) => w.price === lowest)) bad.push(`the lowest ${lowest} never went (${JSON.stringify(r.trace())})`);
    if (r.events.some((e) => e.type === 'walk_timing_miss')) bad.push('a walk_timing_miss with no bid: a zero-step walk on an outranked load');
    if (!r.logs.warn.some((l) => /landing time/i.test(l.m))) bad.push('no warning that the landing time was capped');
    return bad.join('; ') || null;
  });

  await H.check('N2: with the walk switched off live, an armed GoComet clock timer sends nothing', async () => {
    const cfg = H.walkCfg('gc', { stepTimeMs: 2_500, landMs: 4_500, safetyMarginMs: 100, maxWalkWindowMs: 10_000, probeLeadMs: 9_000 });
    const r = H.load({ platform: 'gc', band: BAND_GC, walk: cfg, gc: { roundPolicy: { finalAfterExtensions: 3 } } });
    r.seedStanding(0, 2);
    await r.at(60_000, { rank: 2 });
    await r.extend(200_000, 260_000, { rank: 2 });
    await r.at(20_000, { rank: 2 });
    r.eng._armWalkClockFallback(r.m);
    const armed = r.m._walkClockAtMs;
    r.eng.setWalk(H.WALK_OFF);
    H.setNow(r.close - (armed || 5_600));
    const before = r.writes.length;
    await r.eng._walkClockFire(r.m);
    stopTimers(r.m);
    r.done();
    if (armed == null) return 'HARNESS: no clock timer armed';
    return r.writes.length > before ? `the timer bid ${JSON.stringify(r.writes.slice(before).map((w) => w.price))} with the walk off` : null;
  });

  await H.check('N3: stop(), _finalize, _retireUnreadable and kill() each leave no walk timer', async () => {
    const bad = [];
    for (const door of ['stop', 'finalize', 'retireUnreadable', 'kill']) {
      const r = H.load({ platform: 'gc', band: BAND_GC, walk: H.walkCfg('gc'), gc: { roundPolicy: { finalAfterExtensions: null } } });
      r.seedStanding(0, 2);
      await r.at(60_000, { rank: 2 });
      await r.at(20_000, { rank: 2 });
      r.eng._armWalkClockFallback(r.m);
      if (!timersLeft(r.m)) { bad.push(`${door}: HARNESS: no walk timer armed`); r.done(); continue; }
      if (door === 'stop') r.eng.stop(r.m.auctionId);
      else if (door === 'finalize') await r.eng._finalize(r.m, r.m._lastOkState);
      else if (door === 'retireUnreadable') r.eng._retireUnreadable(r.m);
      else r.eng.kill('test');
      if (timersLeft(r.m)) bad.push(`${door}: ${timersLeft(r.m)} walk timer(s) still pending`);
      stopTimers(r.m);
      r.done();
    }
    return bad.join('; ') || null;
  });

  await H.check('N4: at rank 1 in a confirmed-final GoComet round, the next read is aimed 500 ms before the no-read deadline (8,000)', async () => {
    const r = H.load({ platform: 'gc', band: BAND_GC, walk: H.walkCfg('gc'), gc: FINAL_NOW });
    r.seedStanding(0, 2);
    await r.at(19_500, { rank: 1 });
    await r.at(12_000, { rank: 1 });
    const v = r.eng.roundVerdict(r.m);
    const delay = r.eng._walkGcAimMs(r.m, 12_000);
    r.done();
    if (v.verdict !== 'FINAL' || v.confidence !== 'HIGH') return `HARNESS: verdict ${v.verdict}/${v.confidence}`;
    return delay === 12_000 - 8_000 ? null : `from 12,000 the next read is ${delay} ms away, expected ${12_000 - 8_000} (a read at 8,000, 500 ms before the 7,500 deadline)`;
  });

  for (const step of [1_500, 1_000]) {
    await H.check(`N5: GoComet step ${step}: at the last-step deadline (5,700) and at the clock shot (4,700) the walk takes one step, the lowest`, async () => {
      const bad = [];
      const cfg = H.walkCfg('gc', { stepTimeMs: step, landMs: 4_500, safetyMarginMs: 100, maxWalkWindowMs: 20_000, probeLeadMs: 12_000 });
      const r = H.load({ platform: 'gc', band: BAND_GC, walk: cfg, gc: Object.assign({ clockErrorMs: 100 }, FINAL_NOW) });
      r.seedStanding(0, 3);
      await r.at(60_000, { rank: 2 });
      const t = r.eng.walkParams(r.m, r.m._lastOkState);
      for (const cd of [5_700, 4_700]) {
        const n = walkMath.stepsThatFit(cd, t);
        if (n !== 1) bad.push(`stepsThatFit(${cd}) = ${n}, expected 1`);
      }
      const sent = await r.at(5_700, { rank: 2 });
      r.done();
      if (!H.same(sent, [50_900])) bad.push(`at the last-step deadline it sent ${JSON.stringify(sent)}, expected the lowest 50,900`);
      return bad.join('; ') || null;
    });
  }

  await H.check('control: walk off, the GoComet final round at 5,700 is unchanged (nothing above the buzzer)', async () => {
    const r = H.load({ platform: 'gc', band: BAND_GC, walk: H.WALK_OFF, gc: Object.assign({ clockErrorMs: 100 }, FINAL_NOW) });
    r.seedStanding(0, 3);
    await r.at(60_000, { rank: 2 });
    const sent = await r.at(5_700, { rank: 2 });
    r.done();
    return H.same(sent, [50_900]) ? null : `walk off sent ${JSON.stringify(sent)} at 5,700; base sends the floor at the buzzer`;
  });

  H.finish('T9 walk engine review findings', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
