'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: step time set from measured data (owner scope addition, 26 Sep).
 *
 * Samples come from the P6 telemetry on every bid (closedBids ourBids): step = rankVisibleAt -
 * decidedAt, land = writeLandedAt - decidedAt, counting only final-window bids (decided within 60 s of
 * the close) per platform over the last windowDays. The walk reads stepTimeMs = the measured value at
 * the system-wide percentile (walk.percentile, one of 70 / 80 / 85 / 90 / 95 - owner, 26 Sep) when there
 * are at least minSamples samples, else the manual stepTimeMs;
 * and its last-step landMs = the measured land at the percentile, else the write runway. Effective
 * values are clamped into the validated ranges. Measured values are computed on boot, saved to
 * data/walkTiming.json through the store, and a corrupt or missing file falls back to manual with one
 * warn. With the walk switched off nothing here moves a decision.
 *
 *   node scripts/test-walk-measured-timing.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp dir + subprocess), not app state
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./lib/walk-harness');

const DAY = 86_400_000;
const NOW = H.REAL_NOW();

if (process.argv[2] === '--boot-child') {
  (async () => {
    const out = { ok: false };
    try {
      const srv = require('../src/web/server');
      await srv.boot();
      out.engines = srv.stacks.map((s) => s.engine.walkTiming || null);
      out.ok = true;
    } catch (e) { out.error = (e && e.stack) || String(e); }
    process.stdout.write(`\nCHILD ${JSON.stringify(out)}\n`);
    process.exit(0);
  })();
  return;
}

const EXPECTED = 13;

const lazy = () => require('../src/engine/walkTiming');

/** One closedBids record with the given bids: [closesInMs, decidedAgoMs, landMs, stepMs|null]. */
function rec(platformKey, bids) {
  return { auctionId: `R${Math.random()}`, status: 'closed', ...(platformKey ? { platformKey } : {}),
    ourBids: bids.map(([closesInMs, ago, land, step]) => {
      const decidedAt = NOW - ago;
      const b = { price: 100, closesInMs, decidedAt, writeLandedAt: decidedAt + land };
      if (step != null) b.rankVisibleAt = decidedAt + step;
      return b;
    }) };
}
const platformOf = (r) => (r.platformKey === 'gocomet' ? 'gocomet' : 'sp');

(async () => {
  console.log('T9 walk - measured step time');

  await H.check('percentile maths on fixed samples (nearest rank): 10 samples 100..1,000 -> p50 500, p85 900, p95 1,000; 20 samples -> p85 170; one sample; none', async () => {
    const { percentile } = lazy();
    const bad = [];
    const ten = [700, 100, 1_000, 300, 200, 900, 400, 600, 800, 500];
    for (const [p, want] of [[50, 500], [85, 900], [95, 1_000], [99, 1_000]]) {
      if (percentile(ten, p) !== want) bad.push(`p${p} of 100..1,000 is ${percentile(ten, p)}, expected ${want}`);
    }
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    if (percentile(twenty, 85) !== 170) bad.push(`p85 of 10..200 is ${percentile(twenty, 85)}, expected 170`);
    if (percentile([700], 85) !== 700) bad.push('p85 of one sample is not that sample');
    if (percentile([], 85) !== null) bad.push('p85 of no samples is not null');
    if (JSON.stringify(ten) !== JSON.stringify([700, 100, 1_000, 300, 200, 900, 400, 600, 800, 500])) bad.push('percentile sorted its input in place');
    return bad.join('; ') || null;
  });

  await H.check('samples: final-window bids only (decided within 60 s of the close), per platform, inside windowDays; step and land from P6 stamps', async () => {
    const { computeWalkTiming } = lazy();
    const records = [
      rec(null, [[5_000, 1 * DAY, 300, 2_000], [8_000, 2 * DAY, 400, 2_500], [59_000, 3 * DAY, 350, 1_800], [61_000, DAY, 9_000, 9_000]]),
      rec('superprocure', [[4_000, 4 * DAY, 200, 3_000], [3_000, 6 * DAY, 9_000, 9_000], [2_000, DAY, 500, null]]),
      rec('gocomet', [[10_000, DAY, 4_900, 6_000], [12_000, DAY, 4_000, 5_000]]),
    ];
    const walk = { percentile: 85, sp: { windowDays: 5, minSamples: 3 }, gocomet: { windowDays: 5, minSamples: 3 } };
    const t = computeWalkTiming(records, walk, { nowMs: NOW, platformOf });
    const bad = [];
    if (!t || !t.sp || !t.gocomet) return `computeWalkTiming returned ${JSON.stringify(t)}`;
    // SP step samples: 2,000, 2,500, 1,800, 3,000 (61 s bid out of window, 6-day bid out of the 5 days, no-rank bid has no step).
    if (t.sp.n !== 4) bad.push(`sp n ${t.sp.n}, expected 4 step samples`);
    if (t.sp.step.p50 !== 2_000 || t.sp.step.p85 !== 3_000 || t.sp.step.atPercentile !== 3_000) bad.push(`sp step ${JSON.stringify(t.sp.step)}, expected p50 2000, p85 3000, at 85 3000`);
    if (t.sp.land.p50 !== 350 || t.sp.land.p95 !== 500) bad.push(`sp land ${JSON.stringify(t.sp.land)}, expected p50 350 and p95 500 over 200/300/350/400/500`);
    if (t.sp.source !== 'measured') bad.push(`sp source ${t.sp.source}, expected measured (4 >= minSamples 3)`);
    if (t.gocomet.n !== 2 || t.gocomet.source !== 'fallback-insufficient-samples') bad.push(`gocomet n ${t.gocomet.n} source ${t.gocomet.source}, expected 2 and fallback-insufficient-samples`);
    for (const k of ['windowDays', 'percentile', 'computedAt']) if (t.sp[k] == null) bad.push(`sp summary has no ${k}`);
    if (t.sp.computedAt !== NOW) bad.push(`computedAt ${t.sp.computedAt}, expected the nowMs passed in`);
    return bad.join('; ') || null;
  });

  // SP hard, band 100,772 / 96,839 / 91,333, safety 700, manual stepTime 2,000 -> start 6,700;
  // a measured p85 of 3,000 moves the start to 9,700.
  const measured = (step, land = step, n = 60) => ({ sp: { n, landN: n, windowDays: 5, percentile: 85, landPercentile: 95,
    measuredSince: null, minSamples: 50,
    step: { p50: step, p85: step, p95: step, p99: step, atPercentile: step },
    land: { p50: land, p85: land, p95: land, p99: land, atPercentile: land },
    computedAt: NOW, source: n >= 50 ? 'measured' : 'fallback-insufficient-samples' } });
  const spWalk = (over = {}, percentile = 85) => Object.assign(H.walkCfg('sp', Object.assign({ stepTimeMs: 2_000, landMs: 2_000,
    safetyMarginMs: 500, stepTimeSource: 'measured', windowDays: 5, minSamples: 50 }, over)), { percentile, landPercentile: 95 });
  const firstAt = async (walk, timing, from = 11_000, to = 5_000) => {
    const r = H.load({ walk });
    if (timing) r.eng.setWalkTiming(timing);
    for (let cd = from; cd >= to; cd -= 100) {
      await r.at(cd, { rank: null });
      if (r.writes.length) break;
    }
    r.done();
    return r.writes.length ? r.writes[0].cd : null;
  };

  await H.check('fallback below minSamples: 49 samples -> the manual stepTimeMs (start 6,700); 60 samples -> the measured p85 (start 9,700)', async () => {
    const bad = [];
    const low = await firstAt(spWalk(), measured(3_000, 3_000, 49));
    if (low !== 6_700) bad.push(`with 49 samples the walk started at ${low}, expected the manual 6,700`);
    const enough = await firstAt(spWalk(), measured(3_000, 3_000, 60));
    if (enough !== 9_700) bad.push(`with 60 samples the walk started at ${enough}, expected the measured 9,700`);
    const manual = await firstAt(spWalk({ stepTimeSource: 'manual' }), measured(3_000, 3_000, 60));
    if (manual !== 6_700) bad.push(`with stepTimeSource manual the walk started at ${manual}, expected 6,700`);
    return bad.join('; ') || null;
  });

  await H.check('a live settings change is picked up on the next tick: minSamples raised above n, then the source set back to measured', async () => {
    const bad = [];
    const r = H.load({ walk: spWalk() });
    r.eng.setWalkTiming(measured(3_000, 3_000, 60));
    const p1 = r.eng.walkParams(r.m, { clockErrorMs: 200 });
    r.eng.setWalk(spWalk({ minSamples: 100 }));
    const p2 = r.eng.walkParams(r.m, { clockErrorMs: 200 });
    r.eng.setWalk(spWalk({ minSamples: 50 }, 90));
    const p3 = r.eng.walkParams(r.m, { clockErrorMs: 200 });
    r.eng.setWalk(spWalk({ minSamples: 50 }));
    await r.at(9_800, { rank: null });
    const before = r.writes.length;
    await r.at(9_700, { rank: null });
    r.done();
    if (p1.stepTimeMs !== 3_000 || p1.source !== 'measured') bad.push(`with 60 samples walkParams gave ${JSON.stringify(p1)}, expected the measured 3000`);
    if (p2.stepTimeMs !== 2_000 || p2.source === 'measured') bad.push(`after minSamples 100 walkParams gave ${JSON.stringify(p2)}, expected the manual 2000`);
    if (p3.stepTimeMs !== 2_000) bad.push(`with the percentile moved to 90 and a snapshot computed at 85, walkParams gave ${JSON.stringify(p3)}, expected the manual 2000 until the recompute`);
    if (before !== 0 || r.writes.length !== 1) bad.push(`after the settings moved back the walk sent ${JSON.stringify(r.trace())}, expected nothing at 9,800 and the top price at 9,700`);
    return bad.join('; ') || null;
  });

  await H.check('each bid-timing preset takes its own percentile of the samples: 20 step samples 100..2,000 -> p70 1,400, p80 1,600, p85 1,700, p90 1,800, p95 1,900; the walk reads it', async () => {
    const { computeWalkTiming } = lazy();
    const bad = [];
    const bids = Array.from({ length: 20 }, (_, i) => [5_000, DAY, 300, (i + 1) * 100]);
    const records = [rec(null, bids)];
    for (const [p, want] of [[70, 1_400], [80, 1_600], [85, 1_700], [90, 1_800], [95, 1_900]]) {
      const walk = { percentile: p, sp: { windowDays: 5, minSamples: 10 }, gocomet: { windowDays: 5, minSamples: 10 } };
      const t = computeWalkTiming(records, walk, { nowMs: NOW, platformOf });
      if (!t || !t.sp || t.sp.step.atPercentile !== want || t.sp.percentile !== p) bad.push(`preset p${p}: step at percentile ${t && t.sp && t.sp.step.atPercentile} (recorded ${t && t.sp && t.sp.percentile}), expected ${want}`);
      const r = H.load({ walk: spWalk({ minSamples: 10 }, p) });
      r.eng.setWalkTiming(t);
      const eff = r.eng.walkParams(r.m, { clockErrorMs: 200 });
      r.done();
      if (eff.stepTimeMs !== Math.max(500, want)) bad.push(`preset p${p}: the walk read stepTimeMs ${eff.stepTimeMs}, expected ${Math.max(500, want)}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('the bid-timing preset is one system-wide setting: 70, 80, 85, 90 or 95, default 85; anything else is refused on save with a plain message', async () => {
    const { validate, merge, defaultsFrom } = require('../src/admin/configStore');
    const defaults = defaultsFrom(require('../src/config'));
    const bad = [];
    if (!defaults.walk || defaults.walk.percentile !== 85) bad.push(`default walk.percentile is ${defaults.walk && defaults.walk.percentile}, expected 85`);
    for (const p of ['sp', 'gocomet']) if (defaults.walk && defaults.walk[p] && 'percentile' in defaults.walk[p]) bad.push(`walk.${p} still carries its own percentile`);
    for (const ok of [70, 80, 85, 90, 95]) {
      try {
        const v = validate(merge(defaults, { walk: { percentile: ok } }), defaults);
        if (v.walk.percentile !== ok) bad.push(`p${ok} saved as ${v.walk.percentile}`);
      } catch (e) { bad.push(`p${ok} was refused: ${e.message}`); }
    }
    for (const no of [50, 75, 99, 100, '85', null]) {
      let err = null;
      try { validate(merge(defaults, { walk: { percentile: no } }), defaults); } catch (e) { err = e; }
      if (!err || err.code !== 'BAD_INPUT') bad.push(`walk.percentile ${JSON.stringify(no)} was accepted`);
      else if (!/70, 80, 85, 90/.test(err.message)) bad.push(`walk.percentile ${JSON.stringify(no)} refused with "${err.message}" - it must list the allowed values`);
    }
    return bad.join('; ') || null;
  });

  // Corrected 26 Sep (engine review S2): too late with the manual land, the lowest still goes best effort,
  // marked as a timing miss; with the measured land it is in time and unmarked.
  await H.check('the measured land drives the last step (D-B): standing at the middle, undercut at 1,700 -> answered in time with a measured land of 1,000, a marked timing miss with the manual 3,000', async () => {
    const bad = [];
    const scenario = async (timing) => {
      const r = H.load({ walk: Object.assign(H.walkCfg('sp', { stepTimeMs: 3_000, landMs: 3_000, safetyMarginMs: 500, stepTimeSource: 'measured', minSamples: 50 }),
        { percentile: 85, landPercentile: 95 }) });
      if (timing) r.eng.setWalkTiming(timing);
      r.seedStanding(1, 2);
      await r.at(1_700, { rank: 2 });
      const land = r.eng.walkParams(r.m, { clockErrorMs: 200 }).landMs;
      const miss = r.events.filter((e) => e.type === 'walk_timing_miss').length;
      r.done();
      return { trace: r.trace(), land, miss };
    };
    const withLand = await scenario(measured(3_000, 1_000, 60));
    if (withLand.land !== 1_000 || !H.same(withLand.trace, ['91333@1700']) || withLand.miss) bad.push(`measured land: landMs ${withLand.land}, sent ${JSON.stringify(withLand.trace)}, ${withLand.miss} misses; expected 1000, the lowest at 1,700, no miss`);
    const manual = await scenario(null);
    if (manual.land !== 3_000 || !H.same(manual.trace, ['91333@1700']) || manual.miss !== 1) bad.push(`manual land: landMs ${manual.land}, sent ${JSON.stringify(manual.trace)}, ${manual.miss} misses; expected 3000, the lowest best effort, one miss`);
    return bad.join('; ') || null;
  });

  await H.check('land is its own tail percentile (landPercentile, default 95): 20 land samples 100..2,000 -> p90 1,800, p95 1,900, p99 2,000; summaries carry p99', async () => {
    const { computeWalkTiming } = lazy();
    const bad = [];
    const records = [rec(null, Array.from({ length: 20 }, (_, i) => [5_000, DAY, (i + 1) * 100, 500]))];
    for (const [lp, want] of [[90, 1_800], [95, 1_900], [99, 2_000]]) {
      const walk = { percentile: 85, landPercentile: lp, sp: { windowDays: 5, minSamples: 10 }, gocomet: { windowDays: 5, minSamples: 10 } };
      const t = computeWalkTiming(records, walk, { nowMs: NOW, platformOf });
      if (!t || t.sp.land.atPercentile !== want || t.sp.landPercentile !== lp) bad.push(`landPercentile ${lp}: land ${t && t.sp.land.atPercentile}, expected ${want}`);
      if (!t || t.sp.land.p99 !== 2_000 || t.sp.step.p99 !== 500) bad.push(`landPercentile ${lp}: p99 land ${t && t.sp.land.p99} / step ${t && t.sp.step.p99}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('measuredSince: only bids decided at or after it are samples, and a snapshot for another measuredSince is not used', async () => {
    const { computeWalkTiming } = lazy();
    const bad = [];
    const since = NOW - 2 * DAY;
    const records = [rec(null, [[5_000, DAY, 300, 1_000], [5_000, 3 * DAY, 300, 9_000]])];
    const walk = { percentile: 85, landPercentile: 95, measuredSince: since, sp: { windowDays: 5, minSamples: 1 }, gocomet: { windowDays: 5, minSamples: 1 } };
    const t = computeWalkTiming(records, walk, { nowMs: NOW, platformOf });
    if (!t || t.sp.n !== 1 || t.sp.step.atPercentile !== 1_000 || t.sp.measuredSince !== since) bad.push(`with measuredSince 2 days back: ${JSON.stringify(t && t.sp)}`);
    const r = H.load({ walk: Object.assign(spWalk({ minSamples: 10 }), { measuredSince: NOW - DAY }) });
    r.eng.setWalkTiming(measured(3_000));
    const p = r.eng.walkParams(r.m, { clockErrorMs: 200 });
    r.done();
    if (p.stepTimeMs !== 2_000) bad.push(`a snapshot computed for measuredSince null was used under measuredSince ${NOW - DAY}: ${JSON.stringify(p)}`);
    return bad.join('; ') || null;
  });

  await H.check('effective values are clamped into the validated ranges: measured step 45,000 -> 30,000, 100 -> 500', async () => {
    const bad = [];
    for (const [raw, want] of [[45_000, 30_000], [100, 500]]) {
      const r = H.load({ walk: spWalk() });
      r.eng.setWalkTiming(measured(raw, 400, 60));
      const p = r.eng.walkParams(r.m, { clockErrorMs: 200 });
      r.done();
      if (p.stepTimeMs !== want) bad.push(`measured ${raw}: effective stepTimeMs ${p.stepTimeMs}, expected ${want}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('a corrupt or missing walkTiming.json falls back to manual with one warn', async () => {
    const { loadWalkTiming, saveWalkTiming } = lazy();
    const { FileStore } = require('../src/store/fileStore');
    const bad = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-timing-'));
    try {
      const store = new FileStore({ dataDir: dir });
      const warns = [];
      const log = { debug() {}, info() {}, error() {}, warn: (m) => warns.push(m) };
      const missing = await loadWalkTiming(store, log);
      if (missing !== null || warns.length !== 1) bad.push(`missing file: returned ${JSON.stringify(missing)} with ${warns.length} warns, expected null and one warn`);
      fs.writeFileSync(path.join(dir, 'walkTiming.json'), '{ not json');
      warns.length = 0;
      const corrupt = await loadWalkTiming(store, log);
      if (corrupt !== null || warns.length !== 1) bad.push(`corrupt file: returned ${JSON.stringify(corrupt)} with ${warns.length} warns, expected null and one warn`);
      await store.putDoc('walkTiming', 'current', { sp: 'nonsense' });
      warns.length = 0;
      const malformed = await loadWalkTiming(store, log);
      if (malformed !== null || warns.length !== 1) bad.push(`malformed doc: returned ${JSON.stringify(malformed)} with ${warns.length} warns, expected null and one warn`);
      const good = measured(3_000, 400, 60);
      await saveWalkTiming(store, good);
      if (!fs.existsSync(path.join(dir, 'walkTiming.json'))) bad.push('saveWalkTiming wrote no data/walkTiming.json');
      warns.length = 0;
      const back = await loadWalkTiming(store, log);
      if (!back || !back.sp || back.sp.step.atPercentile !== 3_000 || warns.length) bad.push(`a good file did not load back cleanly: ${JSON.stringify(back)}, ${warns.length} warns`);
      const at = await firstAt(spWalk(), null);
      if (at !== 6_700) bad.push(`with no timing loaded the walk started at ${at}, expected the manual 6,700`);
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
    return bad.join('; ') || null;
  });

  await H.check('with the walk switched off, decisions stay byte-identical whatever the measured timing says', async () => {
    const script = async (r) => {
      for (const [cd, rank] of [[40_000, null], [25_000, null], [24_000, 3], [10_000, 2], [3_000, 2], [2_400, 2], [1_000, 2]]) await r.at(cd, { rank });
    };
    const bad = [];
    for (const timing of [null, measured(12_000, 5_000, 500)]) {
      const r = H.load({ walk: H.WALK_OFF });
      if (typeof r.eng.setWalkTiming !== 'function') { bad.push('engine.setWalkTiming does not exist'); r.done(); break; }
      if (timing) r.eng.setWalkTiming(timing);
      await script(r);
      r.done();
      if (!H.same(r.trace(), ['100772@25000', '96839@24000', '91333@2400'])) bad.push(`walk off with timing ${timing ? 'present' : 'absent'} moved: ${JSON.stringify(r.trace())}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('computed on boot and saved to data/walkTiming.json; every engine carries it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-boot-'));
    try {
      const bids = [];
      for (let i = 0; i < 60; i++) bids.push({ price: 100, closesInMs: 5_000, decidedAt: NOW - DAY + i, writeLandedAt: NOW - DAY + i + 300, rankVisibleAt: NOW - DAY + i + 1_500 + i * 10 });
      fs.writeFileSync(path.join(dir, 'closedBids.json'), JSON.stringify({ A1: { auctionId: 'A1', status: 'closed', ourBids: bids } }, null, 2));
      const env = Object.assign({}, process.env, { PLATFORM: 'mock', PORT: '0', SP_DATA_DIR: dir, SP_WHATSAPP_ENABLED: '0' });
      delete env.STORE_BACKEND; delete env.SP_DEMO_SEED; delete env.SP_ADMIN_PASS_HASH;
      const c = spawnSync(process.execPath, [__filename, '--boot-child'], { env, encoding: 'utf8', timeout: 60_000 });
      const line = (c.stdout || '').split('\n').find((l) => l.startsWith('CHILD '));
      const out = line ? JSON.parse(line.slice(6)) : null;
      if (!out || !out.ok) return `server child failed: ${out ? out.error : (c.stderr || '').slice(-500)}`;
      const file = path.join(dir, 'walkTiming.json');
      if (!fs.existsSync(file)) return 'boot wrote no data/walkTiming.json';
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')).current;
      const bad = [];
      if (!doc || !doc.sp || doc.sp.n !== 60 || doc.sp.source !== 'measured') bad.push(`walkTiming.json sp is ${JSON.stringify(doc && doc.sp)}, expected n 60 measured`);
      else if (doc.sp.land.p50 !== 300) bad.push(`sp land p50 ${doc.sp.land.p50}, expected 300`);
      if (!out.engines.length || !out.engines.every((t) => t && t.sp && t.sp.n === 60)) bad.push(`engines after boot carry ${JSON.stringify(out.engines)}`);
      return bad.join('; ') || null;
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  });

  H.finish('T9 walk measured step time', EXPECTED);
})().catch((e) => { console.log(`FAIL harness threw: ${e && e.stack ? e.stack : e}`); process.exitCode = 1; });
