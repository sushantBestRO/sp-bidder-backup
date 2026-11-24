'use strict';
/**
 * Replay harness test suite — the npm-test entry point for replay/.
 *
 * Lives in scripts/ because run-tests.js discovers `scripts/test-*.js` and nothing else; the
 * harness itself is namespaced under replay/ so it merges cleanly alongside other agents' work.
 *
 * EXIT-CODE TRAP. run-tests.js grades PURELY by exit code, so a file that exits 0 early — an
 * unref'd timer, an early return, an unhandled rejection that Node still exits 0 on — is a silent
 * green run with zero assertions. Three defences here:
 *   1. every test is SYNCHRONOUS (no timers, no promises, nothing to leave pending)
 *   2. an assertion COUNTER with a hard floor, so a suite that silently stops running is a failure
 *   3. an explicit completion sentinel printed as the very last statement
 *
 * CORPUS-OPTIONAL. The corpora live in the super-repo and are gitignored, so CI has no data. The
 * synthetic-fixture tests always run and are the real gate; corpus-backed checks are additive and
 * skip loudly when the data is absent. `npm test` therefore stays honest on a bare checkout.
 */
process.env.LOG_LEVEL = 'silent';

const assert = require('assert');
const { VirtualClock, WallClockGuard } = require('../replay/lib/clock');
const { normaliseGocometRecord, loadGocometCorpus, corpusAvailable } = require('../replay/lib/corpus');
const { classifySlide, reconstructEnquiry, reconstructCorpus, summarise, DEFAULTS } = require('../replay/lib/reconstruct');
const { readCloseModel, buildSpScenario, parseHMS } = require('../replay/lib/spScenario');
const { ReplayHarness, buildTickSchedule, believedCloseAt } = require('../replay/lib/harness');
const { summariseRun, compareRevisionPolicies } = require('../replay/lib/metrics');
const { createSpEngineDriver } = require('../replay/drivers/spEngineDriver');

let asserts = 0;
let failures = 0;
const MIN_EXPECTED_ASSERTS = 40;

function ok(name, fn) {
  try { fn(); asserts += 1; console.log('  ok  ' + name); }
  catch (e) { failures += 1; console.error('  FAIL ' + name + '\n        ' + (e && e.message || e)); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- helpers
const T0 = Date.parse('2026-01-15T10:00:00.000Z');
let rowSeq = 0;
/** Build a normalised bid record. ttcMs = time-to-close at that instant. */
function rec(offsetSec, ttcSec, extra = {}) {
  return normaliseGocometRecord(Object.assign({
    timestamp: new Date(T0 + offsetSec * 1000).toISOString(),
    enquiryKey: 'TESTKEY01',
    bidType: 'MEDIUM',
    bidPrice: 25000,
    timeToClosingMs: ttcSec * 1000,
    timeToClosingSec: Math.floor(ttcSec),
    currentRank: 2,
    success: true,
    responseTimeMs: 800,
  }, extra), 'test.json', rowSeq++);
}

// ================================================================ clock
section('VirtualClock / WallClockGuard');

ok('clock starts at seed and advances', () => {
  const c = new VirtualClock(1000);
  assert.strictEqual(c.now(), 1000);
  c.advanceTo(1500);
  assert.strictEqual(c.now(), 1500);
});

ok('clock REFUSES to move backwards (a replay is monotone)', () => {
  const c = new VirtualClock(1000);
  c.advanceTo(2000);
  assert.throws(() => c.advanceTo(1999), /backwards/);
});

ok('clock rejects a non-finite seed', () => {
  assert.throws(() => new VirtualClock(NaN), /finite/);
});

ok('WallClockGuard counts and restores Date.now', () => {
  const g = new WallClockGuard().install();
  try {
    const before = g.counts.dateNow;
    Date.now();
    assert.strictEqual(g.counts.dateNow, before + 1);
  } finally {
    // restore in a finally so a failed assertion above never leaves the globals patched for the
    // rest of the file (install() re-saves a leaked stub as its baseline).
    g.restore();
  }
  const after = g.counts.dateNow;
  Date.now();
  assert.strictEqual(g.counts.dateNow, after, 'restore must stop counting');
});

// ================================================================ band classification
section('Slide classification — the band filter (the correction that prevents 3.5x inflation)');

ok('sub-noise wobble is not an event', () => {
  assert.strictEqual(classifySlide(0.2, null, null, DEFAULTS).kind, 'none');
  assert.strictEqual(classifySlide(4.9, null, null, DEFAULTS).kind, 'none');
});

ok('5-100s gap is sub_band, NOT an extension', () => {
  assert.strictEqual(classifySlide(30, null, null, DEFAULTS).kind, 'sub_band');
  assert.strictEqual(classifySlide(99, null, null, DEFAULTS).rounds, 0);
});

ok('100-400s IS an anti-snipe extension worth exactly one round', () => {
  for (const d of [100, 240, 298, 300, 302, 400]) {
    const c = classifySlide(d, null, null, DEFAULTS);
    assert.strictEqual(c.kind, 'extension', `${d}s should be an extension`);
    assert.strictEqual(c.rounds, 1, `${d}s must count as exactly ONE round, never ${c.rounds}`);
  }
});

ok('both documented increments (240s Sachin-Surat, 300s elsewhere) fall in band', () => {
  assert.strictEqual(classifySlide(240, null, null, DEFAULTS).kind, 'extension');
  assert.strictEqual(classifySlide(300, null, null, DEFAULTS).kind, 'extension');
});

ok('400s-1h is aliased_multi_round and contributes ZERO to round counts', () => {
  const c = classifySlide(900, null, null, DEFAULTS);
  assert.strictEqual(c.kind, 'aliased_multi_round');
  assert.strictEqual(c.rounds, 0, 'an unrecoverable round count must never be guessed');
});

ok('a multi-hour slide WITH a bidsSubmitted reset is a reopen', () => {
  const prev = { rec: { bidsSubmitted: 3 } };
  const next = { rec: { bidsSubmitted: 1 } };
  assert.strictEqual(classifySlide(5 * 3600, prev, next, DEFAULTS).kind, 'reopen');
});

ok('a 22-DAY slide is never an extension (the exact inflation bug)', () => {
  const prev = { rec: { bidsSubmitted: 3 } };
  const next = { rec: { bidsSubmitted: 1 } };
  const c = classifySlide(22 * 86400, prev, next, DEFAULTS);
  assert.notStrictEqual(c.kind, 'extension');
  assert.strictEqual(c.rounds, 0);
});

ok('a multi-hour slide WITHOUT a counter reset is unclassified, still not an extension', () => {
  const c = classifySlide(6 * 3600, { rec: { bidsSubmitted: 1 } }, { rec: { bidsSubmitted: 2 } }, DEFAULTS);
  assert.strictEqual(c.kind, 'unclassified_gap');
  assert.strictEqual(c.rounds, 0);
});

ok('bands are configurable, not buried constants', () => {
  const custom = Object.assign({}, DEFAULTS, { bandLowSec: 200, bandHighSec: 260 });
  assert.strictEqual(classifySlide(240, null, null, custom).kind, 'extension');
  assert.strictEqual(classifySlide(300, null, null, custom).kind, 'aliased_multi_round');
});

// ================================================================ reconstruction
section('Reconstruction from timeToClosingMs');

ok('a static deadline yields zero extensions', () => {
  // three bids at 60s, 30s, 10s to close -> same implied close throughout
  const rows = [rec(0, 60), rec(30, 30), rec(50, 10)];
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].confirmedExtensions, 0);
  assert.strictEqual(a[0].confirmedRoundsLowerBound, 0);
});

ok('one +300s slide is reconstructed as exactly one round', () => {
  // bid at t=0 with 60s left (close=60); bid at t=50 with 310s left (close=360) -> +300s
  const rows = [rec(0, 60), rec(50, 310)];
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS);
  assert.strictEqual(a[0].confirmedExtensions, 1);
  assert.strictEqual(a[0].confirmedRoundsLowerBound, 1);
  assert.strictEqual(a[0].extensions[0].onGrid, true);
});

ok('REGRESSION: a shipper re-open is NOT counted as an extension and cuts the segment', () => {
  // bid at t=0 close=60; then 10 days later a fresh auction on the same key with the bid
  // counter reset to 1. The naive ">60s = extension" rule scored this as a round.
  const rows = [
    rec(0, 60, { bidsSubmitted: 3, revisionsLeft: 0 }),
    rec(10 * 86400, 600, { bidsSubmitted: 1, revisionsLeft: 2 }),
  ];
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS);
  assert.strictEqual(a.length, 2, 're-open must start a new segment');
  assert.strictEqual(a[0].confirmedExtensions, 0);
  assert.strictEqual(a[1].confirmedExtensions, 0);
  assert.strictEqual(a[1].cutReason, 'reopen');
  const total = a.reduce((n, x) => n + x.confirmedRoundsLowerBound, 0);
  assert.strictEqual(total, 0, 'a re-open contributes ZERO rounds');
});

ok('aliased slide moves the clock but adds no round', () => {
  const rows = [rec(0, 60), rec(50, 910)];   // +900s
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS);
  assert.strictEqual(a[0].confirmedRoundsLowerBound, 0);
  assert.strictEqual(a[0].aliasedSlides, 1);
  assert.ok(a[0].finalCloseMs > a[0].originalCloseMs, 'the clock still moved');
});

ok('records with null timeToClosingMs cannot anchor a timeline', () => {
  const rows = [normaliseGocometRecord({
    timestamp: new Date(T0).toISOString(), enquiryKey: 'K', bidType: 'PUBLIC_SUBMISSION',
    bidPrice: 1, timeToClosingMs: null, success: true,
  }, 'f.json', 0)];
  assert.strictEqual(reconstructEnquiry('K', rows, DEFAULTS).length, 0);
});

ok('revision boundaries across an extension are recorded with direction', () => {
  const rows = [
    rec(0, 60, { revisionsLeft: 0, bidsSubmitted: 3 }),
    rec(50, 310, { revisionsLeft: 2, bidsSubmitted: 1, success: true }),
  ];
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS);
  assert.strictEqual(a[0].revisionBoundaries.length, 1);
  assert.strictEqual(a[0].revisionBoundaries[0].direction, 'increased');
  assert.strictEqual(a[0].revisionBoundaries[0].fromExhausted, true);
});

ok('REGRESSION: finalCloseMs tracks a trailing sub_band slide, not just clock-moves', () => {
  // A +50s move is sub_band (below the 100s extension band) but STILL moved the close. Keying
  // finalCloseMs off clock-moves only (which exclude sub_band) left it at the original close and
  // the blindTailMs clamp then hid the negative discrepancy as a clean 0.
  const a = reconstructEnquiry('TESTKEY01', [rec(0, 60), rec(50, 60)], DEFAULTS)[0];
  assert.strictEqual(a.subBandSlides, 1, 'the +50s move must classify as sub_band');
  assert.strictEqual(a.confirmedExtensions, 0, 'a sub_band slide is not an extension');
  assert.ok(a.finalCloseMs > a.originalCloseMs, 'the sub_band advance was lost from finalCloseMs');
  assert.ok(a.quality.blindTailMs >= 0, 'blind tail must not be a concealed negative');
});

ok('REGRESSION: pricing is harvested per SEGMENT, not stamped enquiry-wide', () => {
  // A re-open cuts a genuinely new auction. Each segment must keep its OWN cost basis; the second
  // segment must not inherit the first segment's pricing.
  const rows = [
    rec(0, 60, { bidsSubmitted: 3, calculatedBids: { marketValue: 1000, high: 1200, medium: 1100, low: 900 } }),
    rec(10 * 86400, 600, { bidsSubmitted: 1, calculatedBids: { marketValue: 2000, high: 2400, medium: 2200, low: 1800 } }),
  ];
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS);
  assert.strictEqual(a.length, 2, 're-open must split into two segments');
  assert.strictEqual(a[0].pricing.marketValue, 1000, 'segment 0 keeps its own pricing');
  assert.strictEqual(a[1].pricing.marketValue, 2000, 'segment 1 must NOT inherit segment 0 pricing');
});

ok('bidPrice arrives as int, string or absent and never poisons arithmetic', () => {
  assert.strictEqual(normaliseGocometRecord({ bidPrice: '30890' }, 'f', 0).bidPrice, 30890);
  assert.strictEqual(normaliseGocometRecord({ bidPrice: 25000 }, 'f', 0).bidPrice, 25000);
  assert.strictEqual(normaliseGocometRecord({}, 'f', 0).bidPrice, null);
  assert.strictEqual(normaliseGocometRecord({ bidPrice: 'abc' }, 'f', 0).bidPrice, null);
});

// ================================================================ harness
section('ReplayHarness — determinism and the honesty boundary');

/** A trivial deterministic driver that always bids a fixed price. */
function fixedDriver(price, name) {
  return {
    name: name || 'fixed',
    init: () => ({ fired: 0, seen: [] }),
    onTick: (s, obs) => { s.seen.push(obs); return { price }; },
  };
}

function twoExtensionAuction() {
  const rows = [rec(0, 60), rec(50, 310), rec(350, 310)];
  return reconstructEnquiry('TESTKEY01', rows, DEFAULTS)[0];
}

ok('standingL1Price is ALWAYS null — competitor amounts are structurally absent', () => {
  const a = twoExtensionAuction();
  const d = fixedDriver(1000);
  new ReplayHarness().run(a, d, { revisionLimit: 99 });
  const st = d.init().seen;   // fresh state; use the captured one instead
  // re-run capturing state
  const drv = fixedDriver(1000);
  let captured;
  const wrapped = Object.assign({}, drv, {
    init: (ctx) => { captured = drv.init(ctx); return captured; },
    onTick: (s, obs) => drv.onTick(s, obs),
  });
  new ReplayHarness().run(a, wrapped, { revisionLimit: 99 });
  assert.ok(captured.seen.length > 0, 'driver must have been ticked');
  for (const obs of captured.seen) {
    assert.strictEqual(obs.standingL1Price, null, 'a rival price must never reach an engine');
  }
  assert.ok(!('competitorPrices' in captured.seen[0]));
  assert.ok(!('clearingPrice' in captured.seen[0]));
  void st;
});

ok('closesInMs is never negative', () => {
  const a = twoExtensionAuction();
  const drv = fixedDriver(1000);
  let captured;
  new ReplayHarness().run(a, Object.assign({}, drv, {
    init: (ctx) => { captured = drv.init(ctx); return captured; },
  }), { revisionLimit: 99 });
  for (const obs of captured.seen) assert.ok(obs.closesInMs >= 0, 'countdown went negative');
});

ok('two identical runs produce byte-identical results', () => {
  const a = twoExtensionAuction();
  const r1 = new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 5 });
  const r2 = new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 5 });
  assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2), 'replay must be reproducible');
});

ok('the tick loop performs ZERO wall-clock reads', () => {
  const a = twoExtensionAuction();
  const g = new WallClockGuard();
  const driver = {
    name: 'clockfree',
    init: () => ({}),
    onTick: () => null,
  };
  // The clockfree driver's init/onTick do nothing, so this measures the harness's OWN tick loop.
  // NOTE: run() calls driver.init INSIDE the guarded window, so a driver whose init reads the clock
  // (as the real BidEngine driver's does during engine construction) would be counted here — which
  // is why the real-engine determinism check below uses byte-identical output, not a zero count.
  const h = new ReplayHarness();
  g.install();
  let counts;
  try { h.run(a, driver, { revisionLimit: 5 }); counts = g.snapshot(); }
  finally { g.restore(); }
  assert.strictEqual(counts.dateNow, 0, `harness tick loop read Date.now ${counts.dateNow} times`);
  assert.strictEqual(counts.setTimeout, 0, 'harness tick loop scheduled a timer');
  assert.strictEqual(counts.setInterval, 0, 'harness tick loop scheduled an interval');
});

ok('REGRESSION: an extension observed AFTER the old close still replays', () => {
  // The bot's next bid landed 5 minutes past the original close. Keying visibility off that
  // observation instant made the run terminate at the original close and the war vanish.
  const rows = [rec(0, 10), rec(300, 300)];
  const a = reconstructEnquiry('TESTKEY01', rows, DEFAULTS)[0];
  assert.strictEqual(a.confirmedExtensions + a.aliasedSlides, 1, 'the slide must be detected');
  const drv = fixedDriver(1000);
  let captured;
  const r = new ReplayHarness().run(a, Object.assign({}, drv, {
    init: (ctx) => { captured = drv.init(ctx); return captured; },
  }), { revisionLimit: 99 });
  const lastTick = captured.seen[captured.seen.length - 1].nowMs;
  assert.ok(lastTick > a.originalCloseMs,
    `replay stopped at the original close (${lastTick} <= ${a.originalCloseMs}) - the extension was lost`);
  assert.ok(r.ticksRun > 2, 'run truncated to a couple of ticks');
});

ok('floor breach is RECORDED, not silently corrected', () => {
  const a = twoExtensionAuction();
  const r = new ReplayHarness().run(a, fixedDriver(500), { floor: 1000, revisionLimit: 5 });
  assert.ok(r.violations.some((v) => v.kind === 'floor_breach'), 'a sub-floor bid must be reported');
});

ok('ceiling breach is recorded AND the bid is refused', () => {
  const a = twoExtensionAuction();
  const r = new ReplayHarness().run(a, fixedDriver(9999), { ceiling: 1000, revisionLimit: 5 });
  assert.ok(r.violations.some((v) => v.kind === 'ceiling_breach'));
  assert.strictEqual(r.bids.length, 0, 'an over-ceiling bid must not be accepted');
  assert.ok(r.rejections.every((x) => x.reason === 'above_ceiling'));
});

ok('revision budget is enforced', () => {
  const a = twoExtensionAuction();
  const r = new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 2 });
  assert.strictEqual(r.bids.length, 2, 'budget must cap accepted bids');
  assert.ok(r.rejections.some((x) => x.reason === 'no_revisions_left'));
});

ok('reset-per-round restores budget at each boundary; no-reset does not', () => {
  const a = twoExtensionAuction();
  const noReset = new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 1, revisionPolicy: 'no-reset' });
  const reset = new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 1, revisionPolicy: 'reset-per-round' });
  assert.strictEqual(noReset.revisionResets, 0);
  assert.ok(reset.revisionResets > 0, 'reset policy must restore budget on an extension');
  assert.ok(reset.bids.length > noReset.bids.length,
    `reset should allow more bids (${reset.bids.length} vs ${noReset.bids.length})`);
});

ok('an unknown revision policy is refused rather than silently defaulted', () => {
  const a = twoExtensionAuction();
  assert.throws(() => new ReplayHarness().run(a, fixedDriver(1), { revisionPolicy: 'sometimes' }), /unknown revisionPolicy/);
});

ok('a driver missing onTick is refused', () => {
  const a = twoExtensionAuction();
  assert.throws(() => new ReplayHarness().run(a, { name: 'bad', init: () => ({}) }), /onTick/);
});

ok('a throwing driver is contained and recorded, not crashed on', () => {
  const a = twoExtensionAuction();
  const r = new ReplayHarness().run(a, {
    name: 'boom', init: () => ({}), onTick: () => { throw new Error('kaboom'); },
  }, { revisionLimit: 5 });
  assert.ok(r.violations.some((v) => v.kind === 'driver_threw'));
  assert.strictEqual(r.bids.length, 0);
});

ok('tick schedule always includes open, close and every extension instant', () => {
  const a = twoExtensionAuction();
  const { ticks } = buildTickSchedule(a, { coarseTickMs: 30000, fineTickMs: 1000, fineWindowMs: 180000, maxTicks: 20000 });
  assert.ok(ticks.includes(Math.round(a.openMs)));
  for (const e of a.extensions) assert.ok(ticks.includes(Math.round(e.atMs)), 'extension instant missing from schedule');
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1], 'schedule must be strictly increasing');
});

ok('believedCloseAt tracks the moving deadline', () => {
  const a = twoExtensionAuction();
  assert.strictEqual(believedCloseAt(a, a.openMs), a.originalCloseMs);
  assert.strictEqual(believedCloseAt(a, a.finalCloseMs), a.finalCloseMs);
});

// ================================================================ SP scenario
section('SuperProcure scenario builder');

ok('parseHMS reads SP durations and refuses garbage', () => {
  assert.strictEqual(parseHMS('00:03:00'), 180);
  assert.strictEqual(parseHMS('00:00:00'), 0);
  assert.strictEqual(parseHMS('01:00:00'), 3600);
  assert.strictEqual(parseHMS('garbage'), 0);
  assert.strictEqual(parseHMS(null), 0);
});

ok('extendTime>0 with extendAuction=0 is hard on the platform but soft by extendTime alone', () => {
  const cm = readCloseModel({ branchAuctionExtendTime: '00:01:00', branchExtendAuction: 0, branchExtendAuctionCount: 1 });
  assert.strictEqual(cm.actuallySoftCloses, false, 'platform will not extend when the flag is off');
  assert.strictEqual(cm.softByExtendTimeAlone, true, 'an extendTime-only read calls it soft');
  assert.strictEqual(cm.extendTimeSetButExtensionOff, true);
});

ok('a genuine soft-close load reads soft both ways', () => {
  const cm = readCloseModel({ branchAuctionExtendTime: '00:03:00', branchExtendAuction: 1, branchExtendAuctionCount: 3 });
  assert.strictEqual(cm.actuallySoftCloses, true);
  assert.strictEqual(cm.softByExtendTimeAlone, true);
  assert.strictEqual(cm.extendTimeSetButExtensionOff, false);
});

ok('a hard-close load reads hard both ways', () => {
  const cm = readCloseModel({ branchAuctionExtendTime: '00:00:00', branchExtendAuction: 0, branchExtendAuctionCount: 0 });
  assert.strictEqual(cm.actuallySoftCloses, false);
  assert.strictEqual(cm.softByExtendTimeAlone, false);
});

ok('scenario scripts exactly the declared number of rounds', () => {
  const s = buildSpScenario({
    id: 1, biddingStartTime: '2026-07-13T06:00:00.000Z', biddingCloseTime: '2026-07-13T06:15:00.000Z',
    branchAuctionExtendTime: '00:03:00', branchExtendAuction: 1, branchExtendAuctionCount: 3,
    branchAuctionRemainingTime: 100, branchBidCountAllowed: 30,
  });
  assert.strictEqual(s.scriptedRounds, 3);
  assert.strictEqual(s.extensions.length, 3);
  assert.strictEqual(s.finalCloseMs - s.postedCloseMs, 3 * 180 * 1000, 'three 3-minute rounds');
  assert.strictEqual(s.observedSlides, 0, 'SP rounds are scripted, never observed');
});

ok('scenario refuses an unparseable window', () => {
  assert.strictEqual(buildSpScenario({ id: 1, biddingStartTime: 'nope', biddingCloseTime: 'nope' }), null);
});

ok('REGRESSION: scenario refuses a year-2100 placeholder window (parses valid, is not real)', () => {
  // A year-2100 placeholder START parses as a valid Date; Number.isFinite misses it. The window is
  // inverted (open after close), so it must be rejected, not turned into an empty-schedule silence.
  assert.strictEqual(buildSpScenario({
    id: 1, biddingStartTime: '2100-01-01T00:00:00.000Z', biddingCloseTime: '2026-07-13T06:15:00.000Z',
    branchAuctionExtendTime: '00:03:00', branchExtendAuction: 1, branchExtendAuctionCount: 3,
  }), null);
  // A year-2100 placeholder CLOSE parses valid too, giving a ~74-year span that would materialise
  // millions of ticks. Beyond the +30-day plausibility bound -> rejected.
  assert.strictEqual(buildSpScenario({
    id: 2, biddingStartTime: '2026-07-13T06:00:00.000Z', biddingCloseTime: '2100-01-01T00:00:00.000Z',
  }), null);
});

ok('REGRESSION: a genuinely soft-close load with an UNKNOWN cap is flagged, not silently 0 rounds', () => {
  // extendTime>0, extension ON, but no count: the platform soft-closes (actuallySoftCloses) yet the
  // scripted depth cannot be known. It must carry capUnknown so the report does not read it as a
  // hard-close replay of a SOFT load.
  const s = buildSpScenario({
    id: 3, biddingStartTime: '2026-07-13T06:00:00.000Z', biddingCloseTime: '2026-07-13T06:15:00.000Z',
    branchAuctionExtendTime: '00:03:00', branchExtendAuction: 1,
  });
  assert.strictEqual(s.closeModel.actuallySoftCloses, true);
  assert.strictEqual(s.scriptedRounds, 0);
  assert.strictEqual(s.capUnknown, true, 'unknown-cap soft-close must be flagged');
});

// ================================================================ metrics
section('Metrics — behavioural only');

ok('summary exposes no outcome/win/clearing field', () => {
  const a = twoExtensionAuction();
  const r = new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 5 });
  const s = summariseRun(r, a);
  const flat = JSON.stringify(s).toLowerCase();
  for (const banned of ['winrate', 'win_rate', 'clearingprice', 'clearing_price', 'wouldhavewon', 'profit']) {
    assert.ok(!flat.includes(banned), `metrics leaked an outcome-shaped field: ${banned}`);
  }
});

ok('REGRESSION: exhaustion reads revisionsLeftAtClose, not cumulative bids.length', () => {
  // A reset-per-round run that placed 6 bids against a per-round limit of 3, but finished a round
  // with budget to spare. bids.length(6) >= budget(3), yet the budget was NOT exhausted at close.
  const run = {
    bids: [{ atMs: 1 }, { atMs: 2 }, { atMs: 3 }, { atMs: 4 }, { atMs: 5 }, { atMs: 6 }],
    limits: { revisionLimit: 3 }, revisionsLeftAtClose: 2, revisionPolicy: 'reset-per-round',
    violations: [], rejections: [],
  };
  const s = summariseRun(run, { extensions: [] });
  assert.strictEqual(s.revisions.used, 6);
  assert.strictEqual(s.revisions.exhausted, false, 'reset run with budget left at close is NOT exhausted');
  assert.ok(!(s.revisions.exhausted && s.revisions.leftAtClose > 0), 'exhausted must never coexist with leftAtClose>0');
  assert.strictEqual(s.war.hadRevisionForFinalRound, true, 'it demonstrably had budget for the final round');
});

ok('rank is labelled exogenous', () => {
  const a = twoExtensionAuction();
  const s = summariseRun(new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 5 }), a);
  assert.ok(/EXOGENOUS/.test(s.rank.note), 'rank must carry its exogenous caveat');
});

ok('policy comparison pairs by auction id', () => {
  const a = twoExtensionAuction();
  const nr = [summariseRun(new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 1, revisionPolicy: 'no-reset' }), a)];
  const rs = [summariseRun(new ReplayHarness().run(a, fixedDriver(1000), { revisionLimit: 1, revisionPolicy: 'reset-per-round' }), a)];
  const cmp = compareRevisionPolicies(nr, rs);
  assert.strictEqual(cmp.pairedAuctions, 1);
  assert.ok(cmp.bidsReset >= cmp.bidsNoReset);
});

// ================================================================ SP engine driver (real engine)
section('SP engine driver — real BidEngine (the driver run-replay actually uses)');

// Two-extension GoComet timeline, seeded from harness fixtures, driven through the REAL production
// BidEngine via createSpEngineDriver. No corpus and no node-only stub — this is the integration this
// suite was missing entirely, so an engine change on main now breaks CI instead of silently
// invalidating the replay report.
function runSpDriver() {
  const a = twoExtensionAuction();
  const driver = createSpEngineDriver({ name: 'sp-it', companyName: 'Havells', cost: 20000, marginsPct: [12.6, 7.2, 6.3] });
  return new ReplayHarness().run(a, driver, {
    floor: 20000, revisionLimit: 5, revisionPolicy: 'reset-per-round', extendMs: 300_000, extendCount: 3,
  });
}

ok('the real engine bids AND advances its rung ladder past the establish rung', () => {
  const run = runSpDriver();
  assert.ok(run.bids.length > 0, 'real engine never bid - driver likely pinned in the establish branch');
  // The bug this guards: with rung state never advanced, currentRungIndex stays -1, _decide is
  // pinned in establish, and every bid is rung 0. A progressing ladder yields >=2 distinct rungs.
  const rungs = new Set(run.bids.map((b) => b.meta && b.meta.rungIndex).filter((r) => r != null));
  assert.ok(rungs.size >= 2, `rung ladder did not progress (rung indices: ${[...rungs].join(',') || 'none'})`);
});

ok('the real engine actually OBSERVES the extensions (soft-close defend fires)', () => {
  // A defend bid can only be produced once the soft non-final window is entered, which requires
  // extendsObserved > 0. That guards the believedCloseAt-anchor fix: seeding the belief at the FINAL
  // close made every jump <= 0, so no extension was ever counted and the defend never fired.
  const run = runSpDriver();
  assert.ok(run.bids.some((b) => b.meta && b.meta.defend === true),
    'no soft-close defend fired - extensions were not observed');
});

ok('two real-engine runs produce byte-identical results (determinism, on the real decision path)', () => {
  assert.strictEqual(JSON.stringify(runSpDriver()), JSON.stringify(runSpDriver()),
    'the real engine replay must be reproducible');
});

// ================================================================ corpus-backed (optional)
section('Corpus-backed checks (skipped when the corpus is absent)');

const HAVE_DEAD = corpusAvailable('gocomet-dead');
if (!HAVE_DEAD) {
  console.log('  SKIP corpus checks - gocomet corpus not present on this machine (expected in CI)');
} else {
  const c = loadGocometCorpus('gocomet-dead');
  const auctions = reconstructCorpus(c.records);
  const s = summarise(auctions);

  ok('corpus loads without throwing and reports its own losses', () => {
    assert.ok(c.records.length > 10000);
    assert.ok(Array.isArray(c.parseFailures));
  });

  ok('reconstruction is stable across two runs', () => {
    const again = summarise(reconstructCorpus(c.records));
    assert.strictEqual(JSON.stringify(s), JSON.stringify(again));
  });

  ok('confirmed extension events land on the documented increment grid', () => {
    assert.ok(s.confirmedEventsOnGridPct >= 90,
      `only ${s.confirmedEventsOnGridPct}% of in-band slides are on-grid; the band may be mis-set`);
  });

  ok('re-opens and aliased slides are excluded from round counts', () => {
    assert.ok(s.aliasedSlidesExcluded > 0, 'expected some aliased slides in a real corpus');
    assert.ok(s.confirmedExtensionEvents < s.aliasedSlidesExcluded + s.confirmedExtensionEvents);
  });

  ok('revision boundaries corroborate the reset finding', () => {
    const rb = s.revisionBoundaries;
    assert.ok(rb.total > 20, `only ${rb.total} boundaries found`);
    assert.ok(rb.increased > rb.decreased, 'budget should increase across boundaries more often than it falls');
    assert.ok(rb.successFromExhausted > 0, 'expected at least one successful bid from an exhausted budget');
  });
}

// ================================================================ sentinel
console.log(`\n${asserts} assertions passed, ${failures} failed`);

if (asserts < MIN_EXPECTED_ASSERTS) {
  console.error(`FAIL: only ${asserts} assertions ran, expected at least ${MIN_EXPECTED_ASSERTS}.`);
  console.error('A suite that stops early exits 0 and reads as GREEN to run-tests.js. Treating as failure.');
  process.exit(1);
}
if (failures) { console.error(`FAIL: ${failures} test(s) failed`); process.exit(1); }
console.log('COMPLETE: test-replay-harness.js ran to the end');
process.exit(0);
