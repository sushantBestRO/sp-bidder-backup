'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: settings and rollback (W8, W10, rulings 35, 48, 49; owner decisions of 26 Sep:
 * per-platform switches default off, live settings, maxWalkWindowMs 5,000..60,000).
 *
 * With a platform's switch off, every decision on that platform is byte-identical to the shipped
 * engine - the rollback lever. stepTimeMs, safetyMarginMs and maxWalkWindowMs are live: a Settings
 * save moves the next tick's start with no restart. safety = clockErrorMs + safetyMarginMs, where
 * SuperProcure's clockErrorMs is the clock sync's published bound and GoComet's is a setting. A save
 * outside the ranges is refused with a message that says what to change.
 *
 *   node scripts/test-walk-settings-rollback.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp dir + subprocess), not app state
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/walk-harness');

if (process.argv[2] === '--server-child') {
  (async () => {
    const out = { ok: false };
    try {
      const srv = require('../src/web/server');
      await srv.boot();
      const before = srv.stacks.map((s) => JSON.stringify(s.engine.walkCfg || null));
      srv.applyConfigValues(await srv.configStore.save({ walk: { sp: { enabled: true, stepTimeMs: 2_000, probeLeadMs: 5_000 } } }));
      out.after = srv.stacks.map((s) => s.engine.walkCfg && s.engine.walkCfg.sp && s.engine.walkCfg.sp.stepTimeMs);
      out.enabled = srv.stacks.map((s) => s.engine.walkCfg && s.engine.walkCfg.sp && s.engine.walkCfg.sp.enabled);
      out.before = before;
      let refused = null;
      try { await srv.configStore.save({ walk: { sp: { stepTimeMs: 60_000 } } }); } catch (e) { refused = { code: e.code, message: e.message }; }
      out.refused = refused;
      out.ok = true;
    } catch (e) {
      out.error = (e && e.stack) || String(e);
    }
    process.stdout.write(`\nCHILD ${JSON.stringify(out)}\n`);
    process.exit(0);
  })();
  return;
}

const EXPECTED = 6;
const [P0] = [100_772];
const LIVE = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };
const GC_BAND = { cost: 50_000, marginsPct: [9, 7.2, 1.8], minMarginPct: 1 };
const GC_ON = H.walkCfg('gc');
const SP_ON = H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 500 });
const SP_ON_GC_OFF = { sp: SP_ON.sp, gocomet: { enabled: false } };

// The shapes the shipped engine already pins (timing PRs 1 and 2), each driven start to finish.
const SHAPES = {
  spHardDurian: {
    opts: { sp: { closeModel: 'hard', revisionLimit: 3 } },
    script: async (r) => {
      for (const [cd, rank] of [[40_000, null], [25_000, null], [24_000, 3], [10_000, 2], [3_000, 2], [2_400, 2], [1_000, 2]]) await r.at(cd, { rank });
    },
  },
  spSoftOffShriji: {
    opts: { company: 'Shriji Polymers', band: { cost: 87_400, marginsPct: [15.3, 12.9, 10.8, 4.5, 3], minMarginPct: 3 },
      sp: { closeModel: 'soft', extendMs: 180_000, extendCount: 3, triggerWindowMs: 200_000, revisionLimit: 10 },
      softClose: LIVE },
    script: async (r) => {
      for (const [cd, rank] of [[400_000, null], [300_000, null], [250_000, null], [245_000, null], [230_000, null], [215_000, 3],
        [190_000, 2], [170_000, 1]]) await r.at(cd, { rank });
      await r.extend(180_000, 340_000, { rank: 2 });
      for (const [cd, rank] of [[250_000, 1], [60_000, 2], [10_000, 2], [3_000, 2], [2_400, 2], [1_000, 2]]) await r.at(cd, { rank });
    },
  },
  spLiveUnknownCap: {
    opts: { company: 'Havells India', softClose: LIVE,
      sp: { closeModel: 'soft', extendMs: 180_000, extendCount: null, triggerWindowMs: 100_000, revisionLimit: 10 } },
    script: async (r) => {
      for (const [cd, rank] of [[200_000, null], [140_000, null], [125_000, 1], [101_500, 3], [60_000, 1], [2_400, 1], [1_000, 1]]) await r.at(cd, { rank });
    },
  },
  gcCareer: {
    opts: { platform: 'gc', band: GC_BAND },
    script: async (r) => {
      for (const [cd, rank] of [[400_000, null], [60_000, null], [12_000, null], [7_000, 2], [6_000, 2]]) await r.at(cd, { rank });
      r.ctrl.close += 299_000;
      for (const [cd, rank] of [[298_000, 2], [60_000, 2], [11_000, 2], [6_000, 2]]) await r.at(cd, { rank });
      r.ctrl.close += 299_000;
      for (const [cd, rank] of [[298_000, 2], [11_000, 2], [6_000, 2], [3_000, 2]]) await r.at(cd, { rank });
    },
  },
};

const GOLDEN = {
  spHardDurian: ['100772@25000', '96839@24000', '91333@2400'],
  spSoftOffShriji: ['100772@230000', '98675@215000', '96839@190000', '91333@340000', '90022@2400'],
  spLiveUnknownCap: ['100772@140000', '98150@101500'],
  gcCareer: ['54500@12000', '50900@6000'],
};

async function trace(shape, walk) {
  const s = SHAPES[shape];
  const opts = Object.assign({}, s.opts);
  if (walk !== undefined) opts.walk = walk;
  const r = H.load(opts);
  await s.script(r);
  r.done();
  return r.trace();
}

(async () => {
  console.log('T9 walk - settings and rollback');

  await H.check('31 walk-off-byte-identical: the shipped shapes decide exactly as base with no walk config, with both switches off, and with only the other platform on; switching the platform on moves them', async () => {
    const bad = [];
    for (const shape of Object.keys(SHAPES)) {
      const gc = SHAPES[shape].opts.platform === 'gc';
      const noCfg = await trace(shape, undefined);
      if (process.env.WALK_RECORD) { console.log(`    RECORD ${shape}: ${JSON.stringify(noCfg)}`); continue; }
      const variants = { 'no walk config': noCfg, 'both off': await trace(shape, H.WALK_OFF),
        'other platform on': await trace(shape, gc ? SP_ON_GC_OFF : { sp: { enabled: false }, gocomet: GC_ON.gocomet }) };
      for (const [name, t] of Object.entries(variants)) {
        if (!H.same(t, GOLDEN[shape])) bad.push(`${shape} with ${name} moved: base ${JSON.stringify(GOLDEN[shape])}, now ${JSON.stringify(t)}`);
      }
      const on = await trace(shape, gc ? GC_ON : SP_ON);
      if (H.same(on, GOLDEN[shape])) bad.push(`${shape}: switching the walk ON changed nothing (${JSON.stringify(on)}) - the switch is not live`);
    }
    return bad.join('; ') || null;
  });

  await H.check('32 step-time-live: a Settings save moving stepTimeMs mid-auction moves the next tick\'s start, no restart (engine and composition root)', async () => {
    const bad = [];
    const r = H.load({ walk: SP_ON });
    await r.at(9_800, { rank: null });
    if (r.writes.length) bad.push(`with stepTime 2,000 (start 6,700) the walk bid at 9,800: ${JSON.stringify(r.trace())}`);
    if (typeof r.eng.setWalk !== 'function') bad.push('engine.setWalk does not exist');
    else {
      r.eng.setWalk(H.walkCfg('sp', { stepTimeMs: 3_000, safetyMarginMs: 500 }));
      await r.at(9_650, { rank: null });
      if (!H.same(r.trace(), [`${P0}@9650`])) bad.push(`after the save to stepTime 3,000 (start 9,700) the next tick at 9,650 sent ${JSON.stringify(r.trace())}, expected ${P0}`);
    }
    r.done();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-settings-'));
    try {
      const env = Object.assign({}, process.env, { PLATFORM: 'mock', STORE_BACKEND: 'memory', PORT: '0', SP_DATA_DIR: dir,
        SP_WHATSAPP_ENABLED: '0' });
      delete env.SP_DEMO_SEED; delete env.SP_ADMIN_PASS_HASH; delete env.WALK_RECORD;
      const c = spawnSync(process.execPath, [__filename, '--server-child'], { env, encoding: 'utf8', timeout: 60_000 });
      const line = (c.stdout || '').split('\n').find((l) => l.startsWith('CHILD '));
      const out = line ? JSON.parse(line.slice(6)) : null;
      if (!out || !out.ok) bad.push(`server child failed: ${out ? out.error : (c.stderr || '').slice(-500)}`);
      else {
        if (!out.after.length || !out.after.every((v) => v === 2_000)) bad.push(`after applyConfigValues the engines carry stepTimeMs ${JSON.stringify(out.after)}, expected 2000 on every engine`);
        if (!out.enabled.every((v) => v === true)) bad.push(`after applyConfigValues walk.sp.enabled reads ${JSON.stringify(out.enabled)}`);
        if (!out.refused || out.refused.code !== 'BAD_INPUT') bad.push(`a save of stepTimeMs 60,000 was not refused (${JSON.stringify(out.refused)})`);
      }
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
    return bad.join('; ') || null;
  });

  await H.check('33 safety-uses-clock-error: SP clockErrorMs 400 + margin 300 -> safety 700 (start 6,700), 900 + 300 -> 7,200, unknown -> 1,000 + 300; GoComet setting 1,000 + 500 -> 19,500, 1,500 + 500 -> 20,000', async () => {
    const bad = [];
    const firstAt = async (opts, from, to, step) => {
      const r = H.load(opts);
      for (let cd = from; cd >= to; cd -= step) {
        await r.at(cd, { rank: null });
        if (r.writes.length) break;
      }
      r.done();
      return r.writes.length ? r.writes[0].cd : null;
    };
    const sp = (clockErrorMs) => ({ sp: { clockErrorMs }, walk: H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 300 }) });
    for (const [err, want] of [[400, 6_700], [900, 7_200], [null, 7_300]]) {
      const got = await firstAt(sp(err), 9_000, 5_000, 100);
      if (got !== want) bad.push(`SP clockErrorMs ${err}: the walk started at ${got}, expected ${want}`);
    }
    const gc = (clockErrorMs) => ({ platform: 'gc', band: GC_BAND, gc: { roundPolicy: { finalAfterExtensions: 0 } }, walk: H.walkCfg('gc', { clockErrorMs }) });
    for (const [err, want] of [[1_000, 19_500], [1_500, 20_000]]) {
      const got = await firstAt(gc(err), 25_000, 10_000, 500);
      if (got !== want) bad.push(`GoComet clockErrorMs ${err}: the walk started at ${got}, expected ${want}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('34 per-platform-switch: SP on, GoComet off -> GoComet decisions byte-identical to base; SP walks', async () => {
    const bad = [];
    const gc = await trace('gcCareer', SP_ON_GC_OFF);
    if (!H.same(gc, GOLDEN.gcCareer)) bad.push(`GoComet with its switch off moved: base ${JSON.stringify(GOLDEN.gcCareer)}, now ${JSON.stringify(gc)}`);
    const sp = await trace('spHardDurian', SP_ON_GC_OFF);
    if (H.same(sp, GOLDEN.spHardDurian) || sp.some((t) => Number(t.split('@')[1]) > 6_700)) {
      bad.push(`SuperProcure with its switch on sent ${JSON.stringify(sp)}, expected the walk (nothing before its 6,700 start)`);
    }
    return bad.join('; ') || null;
  });

  await H.check('35 settings-validation: stepTimeMs 0 or 60,000, safetyMarginMs -1, maxWalkWindowMs 4,000 or 61,000 and the measured-time fields out of range are refused with a corrective message; the defaults are off and the window is late (SP 6,000, GoComet 10,000)', async () => {
    const bad = [];
    const { validate, merge, defaultsFrom, ConfigStore } = require('../src/admin/configStore');
    const defaults = defaultsFrom(require('../src/config'));
    const w = defaults.walk;
    const want = { sp: { enabled: false, stepTimeMs: 1_000, landMs: 1_500, safetyMarginMs: 100, maxWalkWindowMs: 6_000, stepTimeSource: 'measured',
      windowDays: 5, minSamples: 50, probeLeadMs: 4_000 },
    gocomet: { enabled: false, stepTimeMs: 2_500, landMs: 4_500, safetyMarginMs: 100, maxWalkWindowMs: 10_000, clockErrorMs: 1_000,
      stepTimeSource: 'measured', windowDays: 5, minSamples: 50, probeLeadMs: 9_000, finalShotWithoutRead: true } };
    // Owner, 26 Sep: reach L1 as late as possible. The window holds about 4 SuperProcure steps and 2
    // GoComet steps before the landing time and safety (clock error: SP ~200-500, GoComet 100 after the snap).
    if (w) {
      const spNeeds = 4 * w.sp.stepTimeMs + w.sp.landMs + w.sp.safetyMarginMs;
      const gcNeeds = 2 * w.gocomet.stepTimeMs + w.gocomet.landMs + w.gocomet.safetyMarginMs;
      if (!(w.sp.maxWalkWindowMs >= spNeeds && w.sp.maxWalkWindowMs <= spNeeds + 1_000)) bad.push(`SP maxWalkWindowMs ${w.sp.maxWalkWindowMs} is not ~4 steps + land + safety (${spNeeds})`);
      if (!(w.gocomet.maxWalkWindowMs >= gcNeeds && w.gocomet.maxWalkWindowMs <= gcNeeds + 1_000)) bad.push(`GoComet maxWalkWindowMs ${w.gocomet.maxWalkWindowMs} is not ~2 steps + land + safety (${gcNeeds})`);
    }
    if (w && (w.percentile !== 85 || w.landPercentile !== 95 || w.measuredSince !== null)) {
      bad.push(`system-wide defaults percentile ${w.percentile}, landPercentile ${w.landPercentile}, measuredSince ${w.measuredSince}; expected 85, 95, null`);
    }
    if (!w) bad.push('defaultsFrom carries no walk block');
    else {
      for (const p of ['sp', 'gocomet']) {
        for (const [k, v] of Object.entries(want[p])) if (!w[p] || w[p][k] !== v) bad.push(`default walk.${p}.${k} is ${w[p] && w[p][k]}, expected ${v}`);
      }
    }
    const cases = [
      [{ sp: { stepTimeMs: 0 } }, /Manual step time/], [{ sp: { stepTimeMs: 60_000 } }, /Manual step time/],
      [{ gocomet: { stepTimeMs: 499 } }, /Manual step time/], [{ sp: { safetyMarginMs: -1 } }, /Safety margin/],
      [{ gocomet: { safetyMarginMs: 5_001 } }, /Safety margin/], [{ sp: { maxWalkWindowMs: 4_000 } }, /Earliest start/],
      [{ gocomet: { maxWalkWindowMs: 61_000 } }, /Earliest start/], [{ gocomet: { clockErrorMs: -5 } }, /Clock error/],
      [{ percentile: 49 }, /Bid timing/], [{ percentile: 100 }, /Bid timing/],
      [{ sp: { windowDays: 0 } }, /Measured over/], [{ gocomet: { windowDays: 31 } }, /Measured over/],
      [{ sp: { minSamples: 9 } }, /Minimum bids measured/], [{ gocomet: { minSamples: 501 } }, /Minimum bids measured/],
      [{ sp: { stepTimeSource: 'auto' } }, /Step time from/],
      [{ sp: { landMs: 14_000, safetyMarginMs: 2_000, maxWalkWindowMs: 15_000 } }, /Earliest start/],
      [{ sp: { landMs: 99 } }, /Manual landing time/], [{ gocomet: { landMs: 30_001 } }, /Manual landing time/],
      [{ sp: { probeLeadMs: 1_999 } }, /Early-round check bid/], [{ sp: { probeLeadMs: 10_001 } }, /Early-round check bid/],
      [{ gocomet: { probeLeadMs: 4_999 } }, /Early-round check bid/], [{ gocomet: { probeLeadMs: 15_001 } }, /Early-round check bid/],
      [{ sp: { probeLeadMs: 2_000 } }, /Early-round check bid/],
      [{ gocomet: { probeLeadMs: 7_000 } }, /Early-round check bid/],
      [{ landPercentile: 89 }, /Landing time percentile/], [{ landPercentile: 100 }, /Landing time percentile/], [{ landPercentile: '95' }, /Landing time percentile/],
      [{ measuredSince: -1 }, /Count bids from/], [{ measuredSince: 'yesterday' }, /Count bids from/],
      [{ gocomet: { finalShotWithoutRead: 'yes' } }, /Last bid without a fresh read/],
    ];
    for (const [partial, field] of cases) {
      let err = null;
      try { validate(merge(defaults, { walk: partial }), defaults); } catch (e) { err = e; }
      if (!err || err.code !== 'BAD_INPUT') bad.push(`walk ${JSON.stringify(partial)} was accepted`);
      else if (!field.test(err.message) || !(/[0-9]/.test(err.message) || /measured or manual|on or off|a date/.test(err.message))) {
        bad.push(`walk ${JSON.stringify(partial)} refused with "${err.message}" - it must name the Settings label and what is allowed`);
      }
    }
    try {
      const { MemoryStore } = require('../src/store/memoryStore');
      const cs = new ConfigStore({ store: new MemoryStore(), defaults });
      const saved = await cs.save({ walk: { gocomet: { enabled: true, stepTimeMs: 3_000 } } });
      if (!(saved.walk && saved.walk.gocomet.enabled === true && saved.walk.gocomet.stepTimeMs === 3_000 && saved.walk.sp.enabled === false)) {
        bad.push(`a valid partial save did not round-trip: ${JSON.stringify(saved.walk)}`);
      }
      const again = await cs.save({ minMarginPct: defaults.minMarginPct });
      if (!(again.walk && again.walk.gocomet.stepTimeMs === 3_000)) bad.push('an unrelated save dropped the saved walk block');
    } catch (e) { bad.push(`a valid walk save threw: ${e.message}`); }
    return bad.join('; ') || null;
  });

  await H.check('pin: the walk never starts earlier than close - maxWalkWindowMs, whatever the step count (5,000 window, 10 bids, 19 prices)', async () => {
    const band19 = { cost: 100_000, marginsPct: Array.from({ length: 19 }, (_, i) => 20 - i), minMarginPct: 1 };
    const r = H.load({ band: band19, sp: { revisionLimit: 10 }, walk: H.walkCfg('sp', { stepTimeMs: 2_000, safetyMarginMs: 300, maxWalkWindowMs: 5_000 }) });
    for (let cd = 20_000; cd >= 200; cd -= 100) await r.at(cd, { rank: null });
    r.done();
    const early = r.writes.filter((w) => w.cd > 5_000);
    if (!r.writes.length) return 'the walk sent nothing';
    return early.length ? `bids above the 5,000 window: ${JSON.stringify(r.trace())}` : null;
  });

  H.finish('T9 walk settings and rollback', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
