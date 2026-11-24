'use strict';
/**
 * Unit tests for scripts/observe-shriji-window.js - the READ-ONLY Shriji NOTES-window observer
 * and its post-run analyzer. Pure functions only; NO live SuperProcure calls (requiring the
 * observer module does not load the adapter - main() lazy-requires it, so this suite runs with
 * zero node_modules dependency and is safe under `npm test`).
 *
 * Fixtures are the verbatim real NOTES strings from the feasibility report appendix
 * (_research/2026-07-25_shriji-notes-schedule-feasibility.md) plus the corpus structured window
 * (biddingStartTime 07:00Z / biddingCloseTime 07:27Z = 12:30-12:57 IST, copied identically across
 * 17 loads) and synthetic live-flip sequences. The "went live at 11:30 while the structured field
 * still reads the 12:30 default" fixture is a HYPOTHESIS the analyzer must flag, not a claim about
 * observed reality - that is exactly what a live run would confirm or refute.
 *
 *   node scripts/test-shriji-window-observer.js
 */
const assert = require('assert');
const obs = require('./observe-shriji-window');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// Base instant on a weekday (2026-07-14, IST). istWallToUtcMs derives the IST calendar day from it.
const BASE = Date.UTC(2026, 6, 14, 12, 0, 0);
const at = (h, m) => obs.istWallToUtcMs(BASE, h, m);       // an IST time-of-day -> UTC ms on 2026-07-14
const iso = (h, m) => new Date(at(h, m)).toISOString();    // same, as an ISO string for biddingStart/Close

// Corpus structured window: 12:30-12:57 IST == 07:00-07:27Z (the single default slot in the corpus).
const STRUCT_START = iso(12, 30);
const STRUCT_CLOSE = new Date(at(12, 30) + 27 * 60000).toISOString();
const PLACEHOLDER_START = '2100-05-24T19:38:25.000Z';
const PLACEHOLDER_CLOSE = '2100-05-24T19:53:25.000Z';

// Verbatim appendix NOTES strings (ASCII-escaped non-breaking spaces).
const NOTE_UPPER = '<p><strong>AUCTION TIME: 11:30 AM, 12: 30 PM, AND 05:00 PM. (FIX TIME 30 MINUTES) </strong></p>';
const NOTE_LOWER = '<p>Auction time: 11:30 AM, 12: 30 PM, and 05:00 PM. (Fix Time 30 Minutes) If the transporter fails to bid the load will be re-auctioned</p>';
const NOTE_HEADER = '<h2>Elysium Pharmaceuticals Ltd.</h2><p><strong>AUCTION TIME: 11:30 AM, 12: 30 PM, AND 05:00 PM. (FIX TIME 30 MINUTES)</strong></p>';
const NOTE_H_BRANCH = '<ul><li><strong>Auction time.: 10:30 AM, 11:30 AM,12:30 PM, 02:30 PM Rishi: 8109751084</strong></li></ul>';
const NOTE_PLACEHOLDER_BRANCH = '<p><strong>AUCTION TIME: 11:30 AM, 12: 30 PM, AND 05:00 PM. (FIX TIME 30 MINUTES) IF THE TRANSPORTER DOES NOT BID</strong></p>';

// A tick-record builder with Shriji defaults; override per case.
function mkTick(o) {
  return Object.assign({
    id: '23091685', loadCode: 'SPILSPUI1', companyName: 'Shriji Polymers India Ltd', branchName: 'U Shriji Polymers',
    biddingOn: false, status: 'scheduled',
    biddingStartTime: STRUCT_START, biddingCloseTime: STRUCT_CLOSE,
    startsAtMs: at(12, 30), closesAtMs: at(12, 30) + 27 * 60000,
    branchAuctionRemainingTime: 120, notes: NOTE_UPPER,
    extendSeconds: 180, softClose: true,
    gsOk: null, gsStatus: null, gsClosesInMs: null, gsMyRank: null, gsTotalBidders: null,
  }, o);
}

// ---------------------------------------------------------------------------
// A. parseNotesAuctionTimes - the corpus noise the parser must survive
// ---------------------------------------------------------------------------
{
  const r = obs.parseNotesAuctionTimes(NOTE_UPPER);
  assert.strictEqual(r.matched, true, 'UPPER note matched');
  assert.deepStrictEqual(r.times.map((t) => t.label), ['11:30', '12:30', '17:00'], 'UPPER -> 11:30/12:30/17:00 (survives "12: 30" and casing)');
  assert.strictEqual(r.windowMinutes, 30, 'FIX TIME 30 MINUTES parsed');
  ok('parseNotesAuctionTimes: dominant UPPER note -> 3 IST times + 30-min window, stray-space and \\u00a0 tolerant');

  const rl = obs.parseNotesAuctionTimes(NOTE_LOWER);
  assert.deepStrictEqual(rl.times.map((t) => t.label), ['11:30', '12:30', '17:00'], 'lower-case note -> same 3 times');
  ok('parseNotesAuctionTimes: lower-case single-<p> note parses, "If the transporter..." continuation excluded');

  const rh = obs.parseNotesAuctionTimes(NOTE_HEADER);
  assert.deepStrictEqual(rh.times.map((t) => t.label), ['11:30', '12:30', '17:00'], 'header-prefixed note -> the <h2> prefix does not leak a time');
  ok('parseNotesAuctionTimes: header-prefixed note (<h2>Elysium...) still yields the 3 auction times');
}

// ---------------------------------------------------------------------------
// B. H-branch different set + phone-number exclusion + fail-closed
// ---------------------------------------------------------------------------
{
  const r = obs.parseNotesAuctionTimes(NOTE_H_BRANCH);
  assert.deepStrictEqual(r.times.map((t) => t.label), ['10:30', '11:30', '12:30', '14:30'], 'H-branch -> 10:30/11:30/12:30/14:30, phone 8109751084 excluded');
  assert.strictEqual(r.windowMinutes, null, 'H-branch note omits FIX TIME -> windowMinutes null (not assumed here)');
  ok('parseNotesAuctionTimes: H-branch <ul><li> note yields the different 4-time set and excludes the trailing phone number');

  assert.deepStrictEqual(obs.parseNotesAuctionTimes(null), { matched: false, times: [], windowMinutes: null }, 'null -> empty, no throw');
  assert.strictEqual(obs.parseNotesAuctionTimes('<p>Deliver to Dahej SEZ gate 3. GST on arrival.</p>').matched, false, 'a note with no AUCTION TIME label -> matched false');
  ok('parseNotesAuctionTimes: fail-closed on null / no-schedule notes (never throws, returns empty)');
}

// ---------------------------------------------------------------------------
// C. istWallToUtcMs - the IST->UTC datetime heuristic (no tz database)
// ---------------------------------------------------------------------------
{
  assert.strictEqual(at(11, 30), Date.UTC(2026, 6, 14, 6, 0, 0), '11:30 IST == 06:00Z');
  assert.strictEqual(at(12, 30), Date.UTC(2026, 6, 14, 7, 0, 0), '12:30 IST == 07:00Z (matches corpus structured start)');
  assert.strictEqual(at(17, 0), Date.UTC(2026, 6, 14, 11, 30, 0), '17:00 IST == 11:30Z');
  assert.strictEqual(at(0, 0), Date.UTC(2026, 6, 13, 18, 30, 0), '00:00 IST == previous day 18:30Z');
  ok('istWallToUtcMs: IST times map to the correct UTC instants by fixed +5:30 offset (12:30 IST == 07:00Z)');
}

// ---------------------------------------------------------------------------
// D. notesWindowsForDate - projects the schedule onto the observation day
// ---------------------------------------------------------------------------
{
  const w = obs.notesWindowsForDate(NOTE_UPPER, BASE);
  assert.strictEqual(w.windows.length, 3, '3 windows');
  assert.strictEqual(w.windows[0].startMs, at(11, 30), 'slot 0 start == 11:30 IST');
  assert.strictEqual(w.windows[1].startMs, at(12, 30), 'slot 1 start == 12:30 IST');
  assert.strictEqual(w.windows[2].endMs, at(17, 0) + 30 * 60000, 'slot 2 end == 17:30 IST');
  assert.strictEqual(w.windowMinutesAssumed, false, 'FIX TIME present -> not assumed');
  const wh = obs.notesWindowsForDate(NOTE_H_BRANCH, BASE);
  assert.strictEqual(wh.windowMinutesAssumed, true, 'H-branch omits length -> defaulted to 30, flagged assumed');
  ok('notesWindowsForDate: builds concrete UTC windows and flags an assumed (defaulted) window length');
}

// ---------------------------------------------------------------------------
// E. buildTickRecord - field mapping off a mapped adapter load
// ---------------------------------------------------------------------------
{
  const mappedLoad = {
    id: '22590923', loadCode: 'UJFL1', companyName: 'Shriji Polymers India Ltd', branchName: '1-Live load',
    biddingOn: false, status: 'unscheduled',
    biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE,
    startsAt: null, closesAt: null, triggerWindowSeconds: 90, notes: NOTE_PLACEHOLDER_BRANCH,
    extendSeconds: 180, softClose: true,
  };
  const rec = obs.buildTickRecord(mappedLoad, at(11, 25), { ok: false, status: null, closesInMs: null, myRank: null, totalBidders: 0 });
  assert.strictEqual(rec.branchAuctionRemainingTime, 90, 'branchAuctionRemainingTime read from triggerWindowSeconds');
  assert.strictEqual(rec.closesAtMs, null, 'placeholder load -> closesAtMs null (from _mapLoad)');
  assert.strictEqual(rec.biddingStartTime, PLACEHOLDER_START, 'raw biddingStartTime preserved');
  assert.strictEqual(rec.serverNowMs, at(11, 25), 'server clock recorded');
  assert.strictEqual(rec.gsTotalBidders, 0, 'getAuctionState fields folded in');
  ok('buildTickRecord: maps every capture-list field, incl. branchAuctionRemainingTime <- triggerWindowSeconds and the raw bidding times');
}

// ---------------------------------------------------------------------------
// F. wouldArm - #25 structured-path arm-eligibility
// ---------------------------------------------------------------------------
{
  assert.strictEqual(obs.wouldArm(mkTick({ status: 'scheduled', closesAtMs: at(12, 30) })), true, 'scheduled + closesAt -> arm');
  assert.strictEqual(obs.wouldArm(mkTick({ status: 'live', closesAtMs: at(12, 30) })), true, 'live + closesAt -> arm');
  assert.strictEqual(obs.wouldArm(mkTick({ status: 'unscheduled', closesAtMs: null })), false, 'unscheduled/null close -> no arm (discovery skips)');
  assert.strictEqual(obs.wouldArm(mkTick({ status: 'closed', closesAtMs: at(12, 30) })), false, 'closed -> no arm');
  ok('wouldArm: matches discovery non-skip (non-closed status + non-null mapped close time)');
}

// ---------------------------------------------------------------------------
// G. classifyStructuredWindow - placeholder / real / past / absent
// ---------------------------------------------------------------------------
{
  assert.strictEqual(obs.classifyStructuredWindow(mkTick({ serverNowMs: at(11, 25), biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE })).kind, 'placeholder', 'year-2100 -> placeholder');
  assert.strictEqual(obs.classifyStructuredWindow(mkTick({ serverNowMs: at(11, 25), biddingStartTime: STRUCT_START, biddingCloseTime: STRUCT_CLOSE })).kind, 'real', 'in-bound future window -> real');
  assert.strictEqual(obs.classifyStructuredWindow(mkTick({ serverNowMs: at(13, 0), biddingStartTime: STRUCT_START, biddingCloseTime: STRUCT_CLOSE })).kind, 'past', 'now past the close -> past');
  assert.strictEqual(obs.classifyStructuredWindow(mkTick({ biddingStartTime: null, biddingCloseTime: null })).kind, 'absent', 'no times -> absent');
  ok('classifyStructuredWindow: separates the 2100 placeholder, a real window, a past window, and absent times');
}

// ---------------------------------------------------------------------------
// H. observedLiveInterval
// ---------------------------------------------------------------------------
{
  const ticks = [
    mkTick({ serverNowMs: at(11, 20), biddingOn: false }),
    mkTick({ serverNowMs: at(11, 32), biddingOn: true }),
    mkTick({ serverNowMs: at(11, 44), biddingOn: true }),
    mkTick({ serverNowMs: at(12, 10), biddingOn: false }),
  ];
  const li = obs.observedLiveInterval(ticks);
  assert.strictEqual(li.startMs, at(11, 32), 'live interval starts at first biddingOn:true tick');
  assert.strictEqual(li.count, 2, 'two live ticks');
  assert.strictEqual(obs.observedLiveInterval([mkTick({ biddingOn: false })]), null, 'no live ticks -> null');
  ok('observedLiveInterval: bounds the biddingOn-true window, null when never live');
}

// ---------------------------------------------------------------------------
// I. structuredMatchedReality - the core covered-vs-not verdict
// ---------------------------------------------------------------------------
{
  // Session A: load runs live at 11:30 while the structured field still reads the 12:30 default.
  const sessA = [
    mkTick({ serverNowMs: at(11, 20), biddingOn: false, status: 'scheduled' }),
    mkTick({ serverNowMs: at(11, 32), biddingOn: true, status: 'scheduled' }),
    mkTick({ serverNowMs: at(11, 44), biddingOn: true, status: 'scheduled' }),
  ];
  assert.strictEqual(obs.structuredMatchedReality(sessA, 10000).verdict, 'structured-did-not-cover', '11:30 run vs 12:30 structured -> not covered');
  ok('structuredMatchedReality: a load running at the 11:30 slot with a 12:30 structured window -> structured-did-not-cover (NOTES needed)');

  // Session B: load runs live at 12:30 - exactly the structured window.
  const sessB = [
    mkTick({ serverNowMs: at(12, 20), biddingOn: false, status: 'scheduled' }),
    mkTick({ serverNowMs: at(12, 32), biddingOn: true, status: 'live' }),
    mkTick({ serverNowMs: at(12, 44), biddingOn: true, status: 'live' }),
  ];
  assert.strictEqual(obs.structuredMatchedReality(sessB, 10000).verdict, 'structured-covered', '12:30 run matches 12:30 structured');
  ok('structuredMatchedReality: a load running at the 12:30 slot with the 12:30 structured window -> structured-covered (#25 covers it)');

  // Session C: never observed live.
  const sessC = [mkTick({ serverNowMs: at(11, 20), biddingOn: false }), mkTick({ serverNowMs: at(11, 40), biddingOn: false })];
  assert.strictEqual(obs.structuredMatchedReality(sessC, 10000).verdict, 'no-live-window-observed', 'no live tick -> inconclusive');
  ok('structuredMatchedReality: no live window observed -> inconclusive (the actual 2026-07-25 weekend case)');

  // Session D: placeholder structured, live at 11:30.
  const sessD = [
    mkTick({ serverNowMs: at(11, 20), biddingOn: false, status: 'unscheduled', biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE, closesAtMs: null }),
    mkTick({ serverNowMs: at(11, 32), biddingOn: true, status: 'scheduled', biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE, closesAtMs: null }),
  ];
  assert.strictEqual(obs.structuredMatchedReality(sessD, 10000).verdict, 'structured-did-not-cover', 'placeholder structured never covers');
  ok('structuredMatchedReality: a year-2100 placeholder structured window never covers a real live run');
}

// ---------------------------------------------------------------------------
// J. wouldTwentyFiveArm - arm + soft-close hold
// ---------------------------------------------------------------------------
{
  const armed = [
    mkTick({ serverNowMs: at(12, 20), status: 'scheduled', closesAtMs: at(12, 30), softClose: true }),
    mkTick({ serverNowMs: at(12, 32), status: 'live', closesAtMs: at(12, 30) + 27 * 60000, softClose: true }),
  ];
  const a = obs.wouldTwentyFiveArm(armed);
  assert.strictEqual(a.wouldArm, true, 'arm-eligible ticks -> wouldArm true');
  assert.strictEqual(a.softCloseHeld, true, 'Shriji soft-close -> held under hardCloseOnly');
  const never = [mkTick({ status: 'unscheduled', closesAtMs: null }), mkTick({ status: 'unscheduled', closesAtMs: null })];
  assert.strictEqual(obs.wouldTwentyFiveArm(never).wouldArm, false, 'all unscheduled -> never arms');
  ok('wouldTwentyFiveArm: reports arm-eligibility and the soft-close hold that gates Shriji until soft-close go-live');
}

// ---------------------------------------------------------------------------
// K. notesVsStructuredDelta - which slot ran vs which slot structured pointed at
// ---------------------------------------------------------------------------
{
  const sessA = [
    mkTick({ serverNowMs: at(11, 20), biddingOn: false }),
    mkTick({ serverNowMs: at(11, 32), biddingOn: true, status: 'scheduled' }),
  ];
  const dA = obs.notesVsStructuredDelta(sessA);
  assert.deepStrictEqual(dA.notesTimesIst, ['11:30', '12:30', '17:00'], 'NOTES slots surfaced');
  assert.strictEqual(dA.structuredSlot, 1, 'structured points at the 12:30 slot (index 1)');
  assert.strictEqual(dA.liveSlot, 0, 'load actually ran at the 11:30 slot (index 0)');
  assert.ok(/MISSED/.test(dA.summary), 'summary flags the miss');
  ok('notesVsStructuredDelta: structured (12:30) MISSED the realized 11:30 window -> only a NOTES read catches this run');

  const sessB = [mkTick({ serverNowMs: at(12, 20), biddingOn: false }), mkTick({ serverNowMs: at(12, 32), biddingOn: true, status: 'live' })];
  const dB = obs.notesVsStructuredDelta(sessB);
  assert.ok(/SAME NOTES slot/.test(dB.summary), '12:30 run matches 12:30 structured');
  ok('notesVsStructuredDelta: structured and realized window on the SAME slot -> covered by #25');

  const sessP = [mkTick({ serverNowMs: at(11, 20), biddingOn: false, biddingStartTime: PLACEHOLDER_START, biddingCloseTime: PLACEHOLDER_CLOSE, closesAtMs: null })];
  assert.ok(/placeholder/.test(obs.notesVsStructuredDelta(sessP).summary), 'placeholder -> NOTES is sole signal');
  ok('notesVsStructuredDelta: a placeholder structured window is reported as making NOTES the sole schedule signal');
}

// ---------------------------------------------------------------------------
// L. analyzeSession / analyzeLog - end-to-end headlines + grouping
// ---------------------------------------------------------------------------
{
  const sessA = [
    mkTick({ id: 'A', serverNowMs: at(11, 20), biddingOn: false }),
    mkTick({ id: 'A', serverNowMs: at(11, 32), biddingOn: true, status: 'scheduled' }),
  ];
  assert.ok(/NOTES-NEEDED/.test(obs.analyzeSession(sessA, 10000).headline), 'Session A -> NOTES-NEEDED');
  const sessB = [
    mkTick({ id: 'B', serverNowMs: at(12, 20), biddingOn: false }),
    mkTick({ id: 'B', serverNowMs: at(12, 32), biddingOn: true, status: 'live' }),
  ];
  assert.ok(/COVERED-BY-#25/.test(obs.analyzeSession(sessB, 10000).headline), 'Session B -> COVERED-BY-#25');
  const sessC = [mkTick({ id: 'C', serverNowMs: at(11, 20), biddingOn: false })];
  assert.ok(/INCONCLUSIVE/.test(obs.analyzeSession(sessC, 10000).headline), 'Session C -> INCONCLUSIVE');
  ok('analyzeSession: folds the three verdicts into a NOTES-NEEDED / COVERED-BY-#25 / INCONCLUSIVE headline');

  const report = obs.analyzeLog([...sessA, ...sessB, ...sessC], 10000);
  assert.strictEqual(report.loadsObserved, 3, 'grouped by loadId -> 3 loads');
  assert.strictEqual(report.totalTicks, 5, 'total ticks counted');
  ok('analyzeLog: groups a flat tick log by loadId and analyzes each load');

  assert.strictEqual(obs.analyzeSession([], 10000).verdict, 'insufficient-data', 'empty -> insufficient-data');
  ok('analyzeSession: insufficient-data on an empty tick series (no throw)');
}

// ---------------------------------------------------------------------------
// M. read-only surface: the module exposes no bid/write function
// ---------------------------------------------------------------------------
{
  const names = Object.keys(obs);
  assert.ok(!names.some((n) => /bid|write|place|arm(?!$)/i.test(n) && n !== 'wouldArm' && n !== 'wouldTwentyFiveArm'), 'no bid/write/place export');
  assert.strictEqual(typeof obs.main, 'function', 'main present (live entry, lazy-requires the adapter)');
  assert.deepStrictEqual(obs.parseArgs(['--window=17:00', '--once']), { window: '17:00', once: true }, 'parseArgs handles flags');
  ok('module surface: read-only (no bid/write/place export), main present, parseArgs works');
}

console.log(`\n${pass}/23 checks passed`);
assert.strictEqual(pass, 23, 'all 23 checks must run');
process.exit(0);
