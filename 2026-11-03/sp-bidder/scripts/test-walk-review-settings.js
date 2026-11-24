'use strict';
/**
 * @requires-summary-line
 * T9 final-window walk: the settings / server / UI review of cd484de (26 Sep).
 *
 * 1  the measured-timing recompute parses closedBids once, and never runs while any engine has a load
 *    inside its final window (hourly and on a Settings save alike): it defers and retries.
 * 2  a save is validated against the worst clock error the engine can use (1,000 ms).
 * 4  the console's "measured" figures are the engine's effective step and landing times, each with its
 *    own source and sample count.
 * 5  save refusals name the Settings labels, and the limits metadata carries the check-bid limits.
 * 6  a corrupt walkTiming.json logs one accurate warning.
 * 7  walk-report.js reads closedBids straight from disk (a corrupt file is left where it is), counts
 *    "stopped at L1" only on loads the walk ran on, and uses the configured GoComet platform key.
 *    Bids the walk placed carry which walk decision sent them.
 *
 *   node scripts/test-walk-review-settings.js
 */
const os = require('os');
const fs = require('fs'); // allowed: temp data dirs for the store and the report script
const path = require('path');
const { execFileSync } = require('child_process');
const H = require('./lib/walk-harness');
const walkMath = require('../src/engine/walk');
const walkTiming = require('../src/engine/walkTiming');
const { BidLogger } = require('../src/logging/bidLogger');
const { createStore } = require('../src/store');

const EXPECTED = 11;
const lazy = (p) => { try { return require(p); } catch (_) { return null; } };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walk-review-'));

(async () => {
  console.log('T9 walk - settings, server and report review findings');

  await H.check('1a: one recompute parses closedBids once - both portals from one read', async () => {
    const store = createStore({ backend: 'memory' });
    const logger = new BidLogger({ store });
    await store.putDoc('closedBids', 'a', { auctionId: 'a', status: 'closed', platformKey: 'sp', closedAt: 1 });
    await store.putDoc('closedBids', 'b', { auctionId: 'b', status: 'closed', platformKey: 'gocomet', closedAt: 2 });
    await store.putDoc('closedBids', 'c', { auctionId: 'c', status: 'armed', platformKey: 'sp' });
    let reads = 0;
    const orig = store.listDocs.bind(store);
    store.listDocs = async (c) => { if (c === 'closedBids') reads += 1; return orig(c); };
    if (typeof logger.listClosedSplit !== 'function') return 'bidLogger.listClosedSplit is missing';
    const got = await logger.listClosedSplit({ platformKeys: ['sp', 'gocomet'] });
    const ids = (k) => (got[k] || []).map((r) => r.auctionId).join(',');
    const bad = [];
    if (reads !== 1) bad.push(`${reads} reads of closedBids, expected 1`);
    if (ids('sp') !== 'a' || ids('gocomet') !== 'b') bad.push(`split sp=[${ids('sp')}] gocomet=[${ids('gocomet')}]`);
    return bad.join('; ') || null;
  });

  await H.check('1b: the recompute does not run while a load is inside its final window; it defers, retries and runs once clear', async () => {
    const mod = lazy('../src/engine/walkTimingRefresh');
    if (!mod) return 'src/engine/walkTimingRefresh.js is missing';
    let busy = true;
    let parses = 0;
    const timers = [];
    const r = mod.createWalkTimingRefresher({
      listClosedSplit: async () => { parses += 1; return { sp: [], gocomet: [] }; },
      platformKeys: () => ({ sp: 'sp', gocomet: 'gocomet' }),
      walk: () => walkMath.DEFAULT_WALK,
      save: async () => {}, apply: () => {}, busy: () => busy, log: H.quiet,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    });
    const bad = [];
    await r.request();
    if (parses !== 0) bad.push(`it parsed ${parses} time(s) with a load in its final window`);
    if (!r.pending()) bad.push('not reported as pending while deferred');
    if (timers.length !== 1) bad.push(`${timers.length} retry timers, expected 1`);
    await r.request();
    if (timers.length !== 1) bad.push('a second request while deferred armed a second retry');
    busy = false;
    await timers[0].fn();
    if (parses !== 1) bad.push(`after the window cleared it parsed ${parses} time(s), expected 1`);
    if (r.pending()) bad.push('still pending after it ran');
    return bad.join('; ') || null;
  });

  await H.check('1c: an engine reports a load inside its final window (a live load 30 s from close), and not one 10 minutes out', async () => {
    const near = H.load({});
    const far = H.load({});
    H.setNow(near.close - 30_000);
    const a = typeof near.eng.hasMonitorInFinalWindow === 'function' ? near.eng.hasMonitorInFinalWindow(60_000) : 'missing';
    H.setNow(far.close - 600_000);
    const b = typeof far.eng.hasMonitorInFinalWindow === 'function' ? far.eng.hasMonitorInFinalWindow(60_000) : 'missing';
    near.done(); far.done();
    return a === true && b === false ? null : `30 s out: ${a}, 10 min out: ${b}; expected true and false`;
  });

  await H.check('2: a save is checked against the worst clock error (1,000 ms): SP landing 5,000 with a 6,000 window is refused; 4,900 is taken', async () => {
    const bad = [];
    const save = (landMs) => { try { walkMath.validateWalk({ sp: { landMs, maxWalkWindowMs: 6_000, safetyMarginMs: 100, probeLeadMs: 8_000 } }); return null; } catch (e) { return e; } };
    const refused = save(5_000);
    if (!refused || refused.code !== 'BAD_INPUT') bad.push('SP landing 5,000 + safety 100 + clock 1,000 > 6,000 was accepted');
    if (save(4_900)) bad.push(`SP landing 4,900 (exactly 6,000 with the worst clock error) was refused: ${save(4_900).message}`);
    return bad.join('; ') || null;
  });

  await H.check('5: refusals name the Settings labels, not field names', async () => {
    const bad = [];
    const msg = (raw) => { try { walkMath.validateWalk(raw); return ''; } catch (e) { return e.message; } };
    const cases = [
      [{ sp: { stepTimeMs: 10 } }, /Manual step time/],
      [{ gocomet: { probeLeadMs: 100 } }, /Early-round check bid/],
      [{ sp: { landMs: 5_000, maxWalkWindowMs: 6_000 } }, /Earliest start/],
      [{ sp: { windowDays: 0 } }, /Measured over/],
    ];
    for (const [raw, re] of cases) {
      const m = msg(raw);
      if (!re.test(m)) bad.push(`"${m}" does not name ${re}`);
      if (/\bwalk\.|Ms\b|probeLead|stepTime|landMs|maxWalkWindow/.test(m)) bad.push(`"${m}" carries a field name`);
    }
    const lim = typeof walkMath.walkLimitsMeta === 'function' ? walkMath.walkLimitsMeta() : null;
    if (!lim || !lim.probeLeadMs || !lim.probeLeadMs.sp || lim.probeLeadMs.gocomet.min !== 5_000) bad.push(`limits metadata ${JSON.stringify(lim && lim.probeLeadMs)} lacks the check-bid limits`);
    return bad.join('; ') || null;
  });

  await H.check('4: the effective summary is what the engine uses - step and landing each with its own source and sample count', async () => {
    if (typeof walkMath.effectiveSummary !== 'function') return 'walk.effectiveSummary is missing';
    const walk = walkMath.mergeWalk(walkMath.DEFAULT_WALK, { sp: { minSamples: 50 }, gocomet: { stepTimeSource: 'manual' } });
    const snap = { sp: { n: 60, landN: 20, windowDays: 5, percentile: 85, landPercentile: 95, measuredSince: null, minSamples: 50,
      step: { atPercentile: 1_200 }, land: { atPercentile: 900 } } };
    const s = walkMath.effectiveSummary(walk, snap);
    const bad = [];
    if (!(s.sp.stepTimeMs === 1_200 && s.sp.stepSource === 'measured' && s.sp.stepN === 60)) bad.push(`sp step ${JSON.stringify(s.sp)}`);
    if (!(s.sp.landMs === 1_500 && s.sp.landSource === 'manual' && s.sp.landN === 20)) bad.push(`sp land (20 < 50 samples -> manual 1,500) ${JSON.stringify(s.sp)}`);
    if (!(s.gocomet.stepSource === 'manual' && s.gocomet.stepTimeMs === 2_500 && s.gocomet.landSource === 'manual')) bad.push(`gocomet ${JSON.stringify(s.gocomet)}`);
    return bad.join('; ') || null;
  });

  await H.check('6: a corrupt walkTiming.json logs one accurate warning', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'walkTiming.json'), '{ not json');
    const store = createStore({ backend: 'file', dataDir: dir });
    const warns = [];
    const doc = await walkTiming.loadWalkTiming(store, { warn: (m) => warns.push(m), info() {}, error() {} });
    const bad = [];
    if (doc !== null) bad.push('a corrupt file produced a document');
    if (warns.length !== 1 || !/walk timing file was corrupt; using manual times/.test(warns[0])) bad.push(`warnings ${JSON.stringify(warns)}`);
    const dir2 = tmpDir();
    const warns2 = [];
    await walkTiming.loadWalkTiming(createStore({ backend: 'file', dataDir: dir2 }), { warn: (m) => warns2.push(m), info() {}, error() {} });
    if (warns2.some((w) => /corrupt/.test(w))) bad.push(`a missing file was reported corrupt: ${JSON.stringify(warns2)}`);
    return bad.join('; ') || null;
  });

  await H.check('7a: walk-report.js leaves a corrupt closedBids.json where it is (truly read-only)', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'closedBids.json');
    fs.writeFileSync(file, '{ not json');
    try { execFileSync(process.execPath, [path.join(__dirname, 'walk-report.js'), '--data-dir', dir], { stdio: 'pipe' }); } catch (_) { /* exit code is not the point */ }
    const left = fs.readdirSync(dir);
    return fs.existsSync(file) && !left.some((f) => /corrupt/.test(f)) ? null : `the report moved the file: ${JSON.stringify(left)}`;
  });

  await H.check('7b: "stopped at L1" counts only loads the walk ran on, and GoComet rows are read by the configured key', async () => {
    const dir = tmpDir();
    const closedAt = Date.parse('2026-09-26T08:00:00Z');
    const rec = (id, platformKey, walk) => ({ auctionId: id, status: 'closed', platformKey, closedAt, finalRank: 1, won: true,
      ladder: [100, 90, 80], ourBids: [Object.assign({ price: 90, decidedAt: closedAt - 5_000, closesInMs: 5_000 }, walk ? { walk: 'step' } : {})] });
    const docs = { A: rec('A', 'sp', true), B: rec('B', 'sp', false), C: rec('C', 'gocomet', true) };
    fs.writeFileSync(path.join(dir, 'closedBids.json'), JSON.stringify(docs, null, 2));
    const out = execFileSync(process.execPath, [path.join(__dirname, 'walk-report.js'), '--data-dir', dir], { encoding: 'utf8' });
    const row = (p) => out.split('\n').find((l) => l.startsWith('2026-09-26') && l.includes(` ${p} `));
    const stopped = (l) => (l ? Number(l.trim().split(/\s+/).slice(-2)[0]) : null);
    const bad = [];
    if (stopped(row('sp')) !== 1) bad.push(`sp stopped at L1 ${stopped(row('sp'))}, expected 1 (only A walked): ${row('sp')}`);
    if (stopped(row('gocomet')) !== 1) bad.push(`gocomet row ${row('gocomet')}`);
    return bad.join('; ') || null;
  });

  await H.check('7c: a bid the walk placed carries its walk decision on the closed record; a walk-off bid carries none', async () => {
    const bad = [];
    for (const [walk, want] of [['step', 'step'], [undefined, undefined]]) {
      const store = createStore({ backend: 'memory' });
      const logger = new BidLogger({ store });
      await logger.handle({ type: 'armed', auctionId: 'W', ts: 1, companyName: 'X', units: 1, lane: { origin: 'a', destination: 'b' } });
      await logger.handle(Object.assign({ type: 'bid_placed', auctionId: 'W', price: 90, rungIndex: 1, ts: 2 }, walk ? { walk } : {}));
      const doc = await store.getDoc('closedBids', 'W');
      const b = doc && doc.ourBids && doc.ourBids[0];
      if (!b) { bad.push(`walk ${walk}: no bid recorded`); continue; }
      if (b.walk !== want || (want === undefined && 'walk' in b)) bad.push(`walk ${walk}: recorded ${JSON.stringify(b.walk)}`);
    }
    return bad.join('; ') || null;
  });

  await H.check('7d: the engine puts the walk decision on the bid_placed event (walk on), and nothing walk-off', async () => {
    const bad = [];
    for (const [walkCfg, want] of [[H.walkCfg('sp', { stepTimeMs: 2_500 }), true], [H.WALK_OFF, false]]) {
      const r = H.load({ walk: walkCfg });
      for (const cd of [25_000, 9_700, 9_500, 7_000, 4_000, 2_400]) await r.at(cd, { rank: 2 });
      r.done();
      const ev = r.events.filter((e) => e.type === 'bid_placed');
      if (!ev.length) { bad.push(`${want ? 'walk on' : 'walk off'}: no bid`); continue; }
      const tagged = ev.filter((e) => e.walk != null).length;
      if (want && tagged === 0) bad.push('walk on: no bid_placed event carries the walk decision');
      if (!want && ev.some((e) => 'walk' in e)) bad.push('walk off: a bid_placed event carries a walk key');
    }
    return bad.join('; ') || null;
  });

  H.finish('T9 walk settings, server and report review findings', EXPECTED);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
