'use strict';
/**
 * observe-shriji-window.js - READ-ONLY Shriji NOTES-window observer + post-run analyzer.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shriji Polymers posts its SuperProcure auctions with biddingOn:0 and a free-text `notes`
 * field that carries the real schedule ("AUCTION TIME: 11:30 AM, 12:30 PM, AND 05:00 PM").
 * The open question that decides whether we BUILD a NOTES parser into the arm path (the "L7
 * edge") is NOT "can the bot bid Shriji" - that is settled YES from local data (biddingOn
 * does flip to 1 during a NOTES window; see _research/2026-07-25_local-unblock-hunt-*.md
 * ITEM 1). The remaining unknown is narrower:
 *
 *   Does #25's STRUCTURED-window path (realAdapter _mapLoad) already arm these loads at the
 *   right time - i.e. is biddingStartTime/biddingCloseTime the REAL next window - or is the
 *   structured field a stale default (the corpus shows an identical 07:00-07:27Z = 12:30 IST
 *   window copied across 17 loads created at 17 different times) that only ever points at one
 *   of the three daily NOTES slots, leaving the 11:30 and 17:00 runs uncovered?
 *
 * This tool captures the evidence that answers it, without touching live money. It polls the
 * SP adapter's READ path across a declared NOTES window and, per tick per Shriji load, records
 * the exact fields the feasibility report asked for (section 6): biddingOn, biddingStartTime,
 * biddingCloseTime, branchAuctionRemainingTime, notes, and the server clock - plus the mapped
 * status/startsAt/closesAt that _mapLoad (#25) actually derived, so "would #25 have armed this
 * load" is read straight off the real code, not re-implemented. A post-run analyzer then
 * answers three questions from the log alone:
 *   1. did the structured window match reality (did the load go live inside it)?
 *   2. would #25's structured-window path have armed this load, and when?
 *   3. what is the NOTES-vs-structured delta (which NOTES slot ran vs which slot structured
 *      pointed at)?
 *
 * READ-ONLY GUARANTEES (this tool can never place a bid)
 * ------------------------------------------------------
 *   - It only ever calls adapter.login(), adapter.listAuctions(), adapter.getAuctionState() -
 *     the three read methods of the seam. It never calls placeBid().
 *   - As a belt: main() overwrites adapter.placeBid with a thrower the moment the adapter is
 *     built, so even an accidental call cannot reach the network.
 *   - It writes nothing to the SuperProcure API and nothing to the bidder's data/ store; its
 *     only writes are the local observation log + analysis file under the chosen output dir.
 *   - Cadence is floored at 10s (polite), and the token is never printed.
 *
 * USAGE
 * -----
 *   # observe the next declared Shriji window today (auto-picks 11:30 / 12:30 / 17:00 IST):
 *   SP_TOKEN=eyJ... node scripts/observe-shriji-window.js
 *
 *   # observe a specific window, wider cadence, custom output dir:
 *   node scripts/observe-shriji-window.js --window=17:00 --cadence=15 --out=./data/shriji-obs
 *
 *   # token from a Netscape cookie export instead of SP_TOKEN:
 *   COOKIE_FILE=C:\path\app.superprocure.com_cookies.txt node scripts/observe-shriji-window.js
 *
 *   # single immediate read (no window wait) - quick "is anything live now" check:
 *   node scripts/observe-shriji-window.js --once
 *
 *   # re-run the analyzer over an existing capture (no live calls at all):
 *   node scripts/observe-shriji-window.js --analyze=./data/shriji-obs/2026-07-28_1130.jsonl
 *
 * OPTIONS (all optional; env in parentheses)
 *   --window=HH:MM     IST window to observe (SHRIJI_WINDOW). Default: next of 11:30/12:30/17:00.
 *   --lead=MIN         minutes before the window to start polling. Default 10.
 *   --trail=MIN        minutes after the window end to keep polling. Default 5.
 *   --window-len=MIN   the NOTES window length. Default 30.
 *   --cadence=SEC      poll cadence, floored at 10. Default 10.
 *   --customer=REGEX   customer-name match. Default "shriji".
 *   --out=DIR          output dir for the JSONL log + analysis. Default ./data/shriji-obs.
 *   --once             take a single immediate read and exit (skips the window wait).
 *   --analyze=FILE     analyze an existing .jsonl capture and exit (no login, no live calls).
 *
 * IMPORTANT: run this under the account whose branch set actually carries Shriji (the master
 * 2667 account in the recon). An account that does not list Shriji branches (e.g. a single-
 * customer carrier login) will simply see zero Shriji loads regardless of the window.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants (kept local + dependency-free so the pure analyzer needs no live code)
// ---------------------------------------------------------------------------

// IST is UTC+5:30, fixed year-round (India observes no DST), so a bare IST time-of-day maps
// to a UTC instant by plain arithmetic - no timezone database needed. This matters because
// the analyzer must run anywhere (CI, a shell with no tz data), and the earlier attempt that
// leaned on the OS tz database silently produced GMT. We only use Intl (which Node ships with
// full ICU) for HUMAN-READABLE display strings, never for the comparison math.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

// Mirror of realAdapter.js's exported MAX_PLAUSIBLE_DEADLINE_MS (30 days). Used ONLY to label
// a structured window as the shared year-2100 placeholder in the human-readable delta. The arm
// decision itself is read off the mapped `status`/`closesAt` that realAdapter._mapLoad already
// computed with the authoritative constant, so this copy is never on a money path.
const MAX_PLAUSIBLE_DEADLINE_MS = 30 * 86400000;

// The three declared Shriji NOTES slots seen across the corpus (IST). The observer auto-picks
// the next of these when no --window is given; the analyzer uses them only as a fallback label.
const KNOWN_WINDOWS_IST = ['11:30', '12:30', '17:00'];

// ---------------------------------------------------------------------------
// Pure time helpers (no I/O; unit-tested)
// ---------------------------------------------------------------------------

/**
 * Convert an IST wall-clock time-of-day (h:m) on the IST calendar day OF `dateMs` to a UTC
 * epoch-ms instant. Deriving the IST calendar day by shifting +5:30 and reading the UTC parts
 * avoids any dependence on a timezone database.
 */
function istWallToUtcMs(dateMs, h, m) {
  const shifted = new Date(dateMs + IST_OFFSET_MS); // now its UTC Y-M-D == the IST calendar day
  const y = shifted.getUTCFullYear();
  const mo = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  // Date.UTC(...) treats h:m as if UTC; subtracting the offset re-interprets them as IST wall time.
  return Date.UTC(y, mo, d, h, m, 0, 0) - IST_OFFSET_MS;
}

/** Human-readable IST timestamp for logs/reports. Intl only (never used for comparisons). */
function msToIst(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

/** IST HH:MM only, for compact slot labels. */
function msToIstHm(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// NOTES parsing (observation-only; NOT wired into any arm/bid path)
// ---------------------------------------------------------------------------

/**
 * Extract the auction-time schedule from a load's `notes` (raw HTML or the flattened text the
 * observer logs). Survives the noise the corpus documents: HTML wrappers, UPPER/lower casing,
 * the "AUCTION TIME:" / "Auction time:" / "Auction time.:" label variants, non-breaking spaces
 * (\u00a0 / &nbsp;), a stray space inside a time ("12: 30 PM"), and trailing junk such as a
 * contact phone number ("Rishi: 8109751084" - excluded because it carries no AM/PM anchor).
 *
 * Fail-closed and never throws: a note with no AUCTION TIME label, or no parseable time, yields
 * { matched:false, times:[], windowMinutes:null } - so the caller treats "unparseable NOTES" as
 * "no schedule read", exactly as a real build would have to.
 *
 * @returns {{ matched:boolean, times:Array<{h:number,m:number,label:string}>, windowMinutes:number|null }}
 */
function parseNotesAuctionTimes(notes) {
  const empty = { matched: false, times: [], windowMinutes: null };
  if (notes == null) return empty;
  const text = String(notes)
    .replace(/<[^>]+>/g, ' ')          // strip any HTML tags (works on raw or flattened)
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')           // non-breaking space
    .replace(/\s+/g, ' ')
    .toUpperCase();

  const label = text.match(/AUCTION\s*TIME\s*\.?\s*:/);
  if (!label) return empty;

  // Scope to the schedule region: from the label to the earliest window marker / continuation /
  // newline / a generous char cap, so downstream prose ("IF THE TRANSPORTER ...") and contact
  // numbers cannot leak a stray token into the time list.
  const startIdx = label.index + label[0].length;
  const rest = text.slice(startIdx);
  const cutMarkers = [/\(?\s*FIX\s*TIME/, /IF\s+THE/, /\bNOTE\b/];
  let end = Math.min(rest.length, 200);
  for (const re of cutMarkers) {
    const mm = rest.match(re);
    if (mm && mm.index < end) end = mm.index;
  }
  const region = rest.slice(0, end);

  const times = [];
  const seen = new Set();
  const timeRe = /(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)/g;
  let mt;
  while ((mt = timeRe.exec(region)) !== null) {
    let h = parseInt(mt[1], 10);
    const min = parseInt(mt[2], 10);
    const ap = mt[3];
    if (h < 1 || h > 12 || min > 59) continue; // 12-hour clock sanity
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    const key = h * 60 + min;
    if (seen.has(key)) continue;
    seen.add(key);
    times.push({ h, m: min, label: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` });
  }

  // Window length: "(FIX TIME 30 MINUTES)" -> 30; any "<n> MINUTES" as a fallback; else null.
  let windowMinutes = null;
  const fix = text.match(/FIX\s*TIME\s*(\d+)\s*MINUTES/);
  const anyMin = text.match(/(\d+)\s*MINUTES/);
  if (fix) windowMinutes = parseInt(fix[1], 10);
  else if (anyMin) windowMinutes = parseInt(anyMin[1], 10);

  times.sort((a, b) => (a.h * 60 + a.m) - (b.h * 60 + b.m));
  return { matched: times.length > 0, times, windowMinutes };
}

/**
 * Turn the NOTES schedule into concrete UTC windows on the IST calendar day of `dateMs`. This
 * is the bare-time-of-day -> startsAt/closesAt datetime heuristic the feasibility report flagged
 * as itself needing validation; it lives here in the analyzer (observation), never in the arm
 * path. `windowMinutesAssumed` is true when the note omitted the length and we defaulted to 30.
 */
function notesWindowsForDate(notes, dateMs) {
  const parsed = parseNotesAuctionTimes(notes);
  const windowMinutesAssumed = parsed.windowMinutes == null;
  const winLen = parsed.windowMinutes == null ? 30 : parsed.windowMinutes;
  const windows = parsed.times.map((t) => {
    const startMs = istWallToUtcMs(dateMs, t.h, t.m);
    return {
      ist: t.label,
      startMs,
      endMs: startMs + winLen * 60000,
      startIst: msToIstHm(startMs),
      endIst: msToIstHm(startMs + winLen * 60000),
    };
  });
  return { matched: parsed.matched, windows, windowMinutes: winLen, windowMinutesAssumed };
}

// ---------------------------------------------------------------------------
// Tick record + the three analyzer verdicts (all pure; unit-tested)
// ---------------------------------------------------------------------------

/**
 * Build one observation record from a MAPPED adapter load (realAdapter._mapLoad output) and the
 * server clock at the tick. `gs` is the optional getAuctionState() result for the same load.
 * Every field the feasibility report's capture list names is here; startsAt/closesAt/status are
 * the values _mapLoad (#25) actually derived, so the analyzer reads the real arm decision.
 */
function buildTickRecord(load, serverNowMs, gs) {
  return {
    serverNowMs,
    serverNowIst: msToIst(serverNowMs),
    id: load.id,
    loadCode: load.loadCode,
    companyName: load.companyName,
    branchName: load.branchName,
    // capture list (feasibility report s6):
    biddingOn: load.biddingOn,                                   // mapped bool: true == raw biddingOn:1
    biddingStartTime: load.biddingStartTime,                     // raw ISO string off the wire
    biddingCloseTime: load.biddingCloseTime,                     // raw ISO string off the wire
    branchAuctionRemainingTime: load.triggerWindowSeconds,       // = branchAuctionRemainingTime
    notes: load.notes,                                           // flattened schedule text
    // #25 structured-window derivation (what decides "would it arm"):
    status: load.status,                                         // scheduled | live | unscheduled | closed
    startsAtMs: load.startsAt,
    closesAtMs: load.closesAt,
    // close-model context (Shriji is soft-close: extendSeconds 180 -> hardCloseOnly holds it):
    extendSeconds: load.extendSeconds,
    softClose: load.softClose,
    // engine hot-path view (optional; REST-only without a socket -> rank null):
    gsOk: gs ? gs.ok : null,
    gsStatus: gs ? gs.status : null,
    gsClosesInMs: gs ? gs.closesInMs : null,
    gsMyRank: gs ? (gs.myRank == null ? null : gs.myRank) : null,
    gsTotalBidders: gs ? gs.totalBidders : null,
  };
}

/**
 * Would #25's structured-window path arm this tick's load? Discovery skips a load only when
 * status==='closed' or closesAt==null (discovery.js:238/250); anything else that matched the
 * allowlist is priced + armed. So the arm-eligibility of the STRUCTURED path is exactly:
 * a non-closed status with a non-null mapped close time. (Allowlist match and the hardCloseOnly
 * soft-close gate are separate config gates, reported alongside - not part of _mapLoad.)
 */
function wouldArm(tick) {
  return (tick.status === 'scheduled' || tick.status === 'live') && tick.closesAtMs != null;
}

/** Classify a tick's RAW structured window, for the human-readable delta (not the arm decision). */
function classifyStructuredWindow(tick) {
  const s = tick.biddingStartTime ? Date.parse(tick.biddingStartTime) : NaN;
  const c = tick.biddingCloseTime ? Date.parse(tick.biddingCloseTime) : NaN;
  const now = tick.serverNowMs;
  if (!tick.biddingStartTime && !tick.biddingCloseTime) return { kind: 'absent', startMs: null, closeMs: null };
  if (Number.isNaN(c) && Number.isNaN(s)) return { kind: 'unparseable', startMs: null, closeMs: null };
  const outOfBound = (t) => Number.isFinite(t) && (t < now - MAX_PLAUSIBLE_DEADLINE_MS || t > now + MAX_PLAUSIBLE_DEADLINE_MS);
  if (outOfBound(c) || outOfBound(s)) return { kind: 'placeholder', startMs: s, closeMs: c };
  if (Number.isFinite(c) && c <= now) return { kind: 'past', startMs: s, closeMs: c };
  if (!(Number.isFinite(s) && Number.isFinite(c) && s < c)) return { kind: 'partial', startMs: s, closeMs: c };
  return { kind: 'real', startMs: s, closeMs: c };
}

/** The interval over which the load was actually observed live (biddingOn flipped / status live). */
function observedLiveInterval(ticks) {
  const live = ticks.filter((t) => t.biddingOn === true || t.status === 'live');
  if (!live.length) return null;
  const starts = live.map((t) => t.serverNowMs);
  return { startMs: Math.min(...starts), endMs: Math.max(...starts), count: live.length };
}

/**
 * VERDICT 1: did the structured window match reality? Reality = when the load was observed live.
 * "Matched" means some PRE-live tick carried a REAL (usable, in-bound, future) structured window
 * whose [start,close] contained the observed live start - i.e. #25 could have predicted and armed
 * the actual window. A placeholder/absent/wrong-slot structured window that never contained the
 * live start is 'structured-did-not-cover' (NOTES would be the only signal). No live window
 * observed at all -> inconclusive for this run.
 */
function structuredMatchedReality(ticks, cadenceMs) {
  const tol = Number.isFinite(cadenceMs) ? cadenceMs : 10000;
  const live = observedLiveInterval(ticks);
  if (!live) {
    return { verdict: 'no-live-window-observed', observedLive: null, predictingTick: null };
  }
  const preLive = ticks.filter((t) => t.serverNowMs < live.startMs);
  let predictingTick = null;
  for (const t of preLive) {
    const c = classifyStructuredWindow(t);
    if (c.kind !== 'real') continue;
    if (c.startMs - tol <= live.startMs && live.startMs <= c.closeMs) { predictingTick = t; break; }
  }
  return {
    verdict: predictingTick ? 'structured-covered' : 'structured-did-not-cover',
    observedLive: { startIst: msToIst(live.startMs), endIst: msToIst(live.endMs), liveTicks: live.count },
    predictingTick: predictingTick ? {
      atIst: msToIst(predictingTick.serverNowMs),
      structuredIst: msToIstHm(classifyStructuredWindow(predictingTick).startMs),
    } : null,
    preLiveStructuredKinds: [...new Set(preLive.map((t) => classifyStructuredWindow(t).kind))],
  };
}

/**
 * VERDICT 2: would #25 have armed this load, and when? Reports the first arm-eligible tick and
 * whether the soft-close scope gate would still hold it (Shriji extendSeconds > 0), which it will
 * until soft-close go-live regardless of #25.
 */
function wouldTwentyFiveArm(ticks) {
  const armed = ticks.filter(wouldArm);
  const softHeld = ticks.some((t) => t.softClose === true);
  const first = armed[0] || null;
  return {
    wouldArm: armed.length > 0,
    armedTickCount: armed.length,
    firstArmAtIst: first ? msToIst(first.serverNowMs) : null,
    firstArmClosesAtIst: first ? msToIst(first.closesAtMs) : null,
    softCloseHeld: softHeld,
    note: softHeld
      ? 'even when the structured path arms, hardCloseOnly holds soft-close Shriji out of scope until soft-close go-live'
      : null,
  };
}

/**
 * VERDICT 3: the NOTES-vs-structured delta. Parses the NOTES schedule, projects it onto the
 * observation day, and reports which NOTES slot the STRUCTURED window points at vs which slot the
 * load actually RAN in. A structured slot != realized slot is the exact case only a NOTES parser
 * could catch.
 */
function notesVsStructuredDelta(ticks) {
  const noteTick = ticks.find((t) => t.notes) || ticks[0] || null;
  const dateMs = ticks.length ? ticks[Math.floor(ticks.length / 2)].serverNowMs : Date.now();
  const notes = notesWindowsForDate(noteTick ? noteTick.notes : null, dateMs);

  // The structured window as it read BEFORE the load went live (the default the desk would see):
  const live = observedLiveInterval(ticks);
  const preLive = live ? ticks.filter((t) => t.serverNowMs < live.startMs) : ticks;
  const structuredSource = (preLive.length ? preLive : ticks)
    .map((t) => classifyStructuredWindow(t))
    .find((c) => c.kind === 'real' || c.kind === 'placeholder') || { kind: 'absent', startMs: null, closeMs: null };

  const slotOf = (ms) => {
    if (ms == null) return -1;
    return notes.windows.findIndex((w) => ms >= w.startMs - 60000 && ms <= w.endMs);
  };
  const structuredSlot = structuredSource.kind === 'real' ? slotOf(structuredSource.startMs) : -1;
  const liveSlot = live ? slotOf(live.startMs) : -1;
  const slotLabel = (i) => (i >= 0 && notes.windows[i] ? notes.windows[i].ist + ' IST' : 'none');

  let summary;
  if (!notes.matched) {
    summary = 'no AUCTION TIME schedule parsed from notes';
  } else if (structuredSource.kind === 'placeholder') {
    summary = `structured window is the year-2100 placeholder (unusable); NOTES declares ${notes.windows.map((w) => w.ist).join(', ')} IST -> NOTES is the sole schedule signal`;
  } else if (!live) {
    summary = `structured points at ${slotLabel(structuredSlot)}; NOTES declares ${notes.windows.map((w) => w.ist).join(', ')} IST; no live window observed this run to compare against`;
  } else if (structuredSlot === liveSlot && structuredSlot >= 0) {
    summary = `structured window and the realized live window are the SAME NOTES slot (${slotLabel(liveSlot)}) -> #25 structured path covers this run`;
  } else {
    summary = `structured points at ${slotLabel(structuredSlot)} but the load actually ran at ${slotLabel(liveSlot)} -> structured MISSED the realized window; only a NOTES read catches this run`;
  }

  return {
    notesMatched: notes.matched,
    notesTimesIst: notes.windows.map((w) => w.ist),
    notesWindowMinutes: notes.windowMinutes,
    notesWindowMinutesAssumed: notes.windowMinutesAssumed,
    structuredKind: structuredSource.kind,
    structuredStartIst: structuredSource.kind === 'real' ? msToIstHm(structuredSource.startMs) : null,
    structuredSlot,
    liveSlot,
    summary,
  };
}

/** Run all three verdicts for ONE load's tick series. Handles the insufficient-data case. */
function analyzeSession(ticks, cadenceMs) {
  if (!ticks || !ticks.length) {
    return { verdict: 'insufficient-data', reason: 'no ticks for this load', tickCount: 0 };
  }
  const sorted = [...ticks].sort((a, b) => a.serverNowMs - b.serverNowMs);
  const matched = structuredMatchedReality(sorted, cadenceMs);
  const arm = wouldTwentyFiveArm(sorted);
  const delta = notesVsStructuredDelta(sorted);

  // A single headline that folds the three verdicts into the build-vs-covered call for this load.
  let headline;
  if (matched.verdict === 'no-live-window-observed') {
    headline = 'INCONCLUSIVE - no live window observed; re-run on a weekday window under the Shriji-scoped account';
  } else if (matched.verdict === 'structured-covered') {
    headline = 'COVERED-BY-#25 - the structured window predicted the realized live window (NOTES build not needed for this run)';
  } else {
    headline = 'NOTES-NEEDED - structured window did not cover the realized live window (only a NOTES read arms this run)';
  }

  return {
    loadId: sorted[0].id,
    loadCode: sorted[0].loadCode,
    branchName: sorted[0].branchName,
    tickCount: sorted.length,
    spanIst: { from: msToIst(sorted[0].serverNowMs), to: msToIst(sorted[sorted.length - 1].serverNowMs) },
    headline,
    structuredMatchedReality: matched,
    wouldArm: arm,
    notesVsStructuredDelta: delta,
  };
}

/** Group a full flat tick log by loadId and analyze each load. */
function analyzeLog(allTicks, cadenceMs) {
  const byId = new Map();
  for (const t of allTicks) {
    if (!byId.has(t.id)) byId.set(t.id, []);
    byId.get(t.id).push(t);
  }
  const perLoad = [...byId.values()].map((ticks) => analyzeSession(ticks, cadenceMs));
  return {
    generatedAtIst: msToIst(Date.now()),
    loadsObserved: perLoad.length,
    totalTicks: allTicks.length,
    perLoad,
  };
}

// ---------------------------------------------------------------------------
// CLI arg parsing + token resolution (used by main only)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] == null ? true : m[2];
  }
  return out;
}

function resolveToken() {
  if (process.env.SP_TOKEN) return String(process.env.SP_TOKEN).replace(/^Bearer\s+/i, '').trim();
  const cookieFile = process.env.COOKIE_FILE || 'C:\\Users\\sidro\\Downloads\\app.superprocure.com_cookies.txt';
  if (fs.existsSync(cookieFile)) {
    for (const l of fs.readFileSync(cookieFile, 'utf8').split(/\r?\n/)) {
      if (l.startsWith('#') || !l.trim()) continue;
      const p = l.split('\t');
      if (p[5] === 'token') return p[6];
    }
  }
  return null;
}

/** Next occurrence (UTC ms) of an IST HH:MM relative to nowMs; today if still ahead, else +1 day. */
function nextIstWindowMs(nowMs, hm) {
  const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
  let target = istWallToUtcMs(nowMs, h, m);
  if (target < nowMs) target = istWallToUtcMs(nowMs + 86400000, h, m);
  return target;
}

// ---------------------------------------------------------------------------
// Live observer (lazy-requires the adapter so tests never touch node_modules)
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Analyze-only path: no login, no live calls.
  if (args.analyze) {
    const file = String(args.analyze);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const ticks = lines.map((l) => JSON.parse(l));
    const report = analyzeLog(ticks, 10000);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const token = resolveToken();
  if (!token) {
    console.error('no token: set SP_TOKEN or provide COOKIE_FILE (Netscape cookie export with a "token" cookie).');
    process.exit(2);
  }

  const cadenceMs = Math.max(10, parseInt(args.cadence || '10', 10)) * 1000; // polite floor: 10s
  const leadMin = parseInt(args.lead || '10', 10);
  const trailMin = parseInt(args.trail || '5', 10);
  const winLenMin = parseInt(args['window-len'] || '30', 10);
  const custRe = new RegExp(String(args.customer || 'shriji'), 'i');
  const outDir = path.resolve(String(args.out || './data/shriji-obs'));
  fs.mkdirSync(outDir, { recursive: true });

  const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
  const adapter = new RealSuperProcureAdapter({ token });
  // READ-ONLY belt: disable the write path entirely, so no code path here can ever bid.
  adapter.placeBid = () => { throw new Error('observe-shriji-window is READ-ONLY: placeBid is disabled'); };

  const acct = await adapter.login();
  console.log(`login ok: company=${acct.company} carrierId=${acct.carrierId} branches=${(acct.branchIds || []).length}`);
  console.log(`server clock: ${msToIst(adapter.serverNow())} IST`);

  // Resolve the observation window.
  const now = adapter.serverNow();
  let windowMs;
  if (args.window) {
    windowMs = nextIstWindowMs(now, String(args.window));
  } else {
    // pick the nearest upcoming known slot (or the one currently open within its lead/trail span)
    const candidates = KNOWN_WINDOWS_IST.map((hm) => {
      const [h, m] = hm.split(':').map((x) => parseInt(x, 10));
      return { hm, today: istWallToUtcMs(now, h, m) };
    });
    const active = candidates.find((c) => now >= c.today - leadMin * 60000 && now <= c.today + (winLenMin + trailMin) * 60000);
    windowMs = active ? active.today : nextIstWindowMs(now, candidates.sort((a, b) => a.today - b.today).find((c) => c.today > now)?.hm || KNOWN_WINDOWS_IST[0]);
  }
  const startMs = windowMs - leadMin * 60000;
  const endMs = windowMs + (winLenMin + trailMin) * 60000;
  const stamp = (msToIstHm(windowMs) || '').replace(':', '');
  const dayIso = new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
  const logFile = path.join(outDir, `${dayIso}_${stamp}.jsonl`);
  const analysisFile = path.join(outDir, `${dayIso}_${stamp}.analysis.json`);

  console.log(`window (IST): ${msToIst(windowMs)}  observe ${msToIst(startMs)} -> ${msToIst(endMs)}  cadence ${cadenceMs / 1000}s`);
  console.log(`log -> ${logFile}`);

  const doTick = async () => {
    const serverNowMs = adapter.serverNow();
    let loads;
    try { loads = await adapter.listAuctions(); }
    catch (e) { console.log(`tick ${msToIstHm(serverNowMs)} listAuctions failed: ${e.message}`); return; }
    const shriji = loads.filter((l) => custRe.test(String(l.companyName || '')) || custRe.test(String(l.branchName || '')));
    if (!shriji.length) { console.log(`tick ${msToIstHm(serverNowMs)}  ${loads.length} open loads, 0 match /${custRe.source}/`); return; }
    const out = [];
    for (const l of shriji) {
      let gs = null;
      try { gs = await adapter.getAuctionState(l.id); } catch (_) { gs = null; }
      const rec = buildTickRecord(l, serverNowMs, gs);
      out.push(rec);
      console.log(`  ${rec.loadCode} biddingOn=${rec.biddingOn} status=${rec.status} closesAtIst=${msToIstHm(rec.closesAtMs)} remTime=${rec.branchAuctionRemainingTime} gsStatus=${rec.gsStatus}`);
    }
    fs.appendFileSync(logFile, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  };

  if (args.once) {
    await doTick();
  } else {
    // Wait out the pre-window lead (idle, no polling) if we started early.
    while (adapter.serverNow() < startMs) {
      const waitMs = Math.min(30000, startMs - adapter.serverNow());
      console.log(`waiting for window start (${msToIstHm(startMs)} IST)...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    while (adapter.serverNow() <= endMs) {
      await doTick();
      await new Promise((r) => setTimeout(r, cadenceMs));
    }
  }

  // Post-run analysis.
  if (fs.existsSync(logFile)) {
    const ticks = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const report = analyzeLog(ticks, cadenceMs);
    fs.writeFileSync(analysisFile, JSON.stringify(report, null, 2));
    console.log(`\n=== ANALYSIS (${report.loadsObserved} load(s), ${report.totalTicks} ticks) ===`);
    for (const l of report.perLoad) {
      console.log(`\n[${l.loadCode || l.loadId}] ${l.headline}`);
      console.log(`  structured-vs-reality: ${l.structuredMatchedReality.verdict}`);
      console.log(`  would #25 arm: ${l.wouldArm.wouldArm}${l.wouldArm.softCloseHeld ? ' (soft-close held under hardCloseOnly)' : ''}`);
      console.log(`  notes-vs-structured: ${l.notesVsStructuredDelta.summary}`);
    }
    console.log(`\nanalysis -> ${analysisFile}`);
  } else {
    console.log('\nno Shriji ticks captured (empty board or account does not carry Shriji branches).');
  }
}

module.exports = {
  // pure, unit-tested:
  istWallToUtcMs,
  msToIst,
  msToIstHm,
  parseNotesAuctionTimes,
  notesWindowsForDate,
  buildTickRecord,
  wouldArm,
  classifyStructuredWindow,
  observedLiveInterval,
  structuredMatchedReality,
  wouldTwentyFiveArm,
  notesVsStructuredDelta,
  analyzeSession,
  analyzeLog,
  nextIstWindowMs,
  parseArgs,
  // live entry point:
  main,
  // constants (for tests):
  KNOWN_WINDOWS_IST,
  IST_OFFSET_MS,
  MAX_PLAUSIBLE_DEADLINE_MS,
};

if (require.main === module) {
  main().catch((e) => { console.error('observer failed:', e.message); process.exit(1); });
}
