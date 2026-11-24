'use strict';
/**
 * THE ANTI-SNIPE INCREMENT THE PLATFORM NEVER PUBLISHED - state.extendMs absent vs. published zero.
 *
 * `extendMs` is read twice in bidEngine, eight lines apart, for two independent purposes, and both
 * reads treated a MISSING increment as an increment of ZERO:
 *
 *   the finalize debounce   `isSoft && state.extendMs ? state.extendMs + finalizeDebounceMs : ...`
 *       -> the soft settle window collapsed from 183,000ms to the bare 3,000ms clock-skew guard, and
 *          _finalize is TERMINAL ON DISK (status 'closed' on the durable intent), so a priced, armed,
 *          live auction was retired ~180s early with its reserved floor rung never sent and no path
 *          - not even the boot supervisor - able to re-arm it.
 *
 *   _observeExtension       `if (!(extendMs > 0)) return false;`
 *       -> a close time moving FORWARD by a whole 180,000ms, the most explicit form an extension can
 *          take, was discarded before it was ever measured. extendsObserved stayed 0 for the life of
 *          the auction, _effectivelyHard stayed false, and the decisive band that releases the floor
 *          above the anti-snipe trigger window never opened.
 *
 * REACHABLE ON THE LIVE SUPERPROCURE PATH, no exotic branch config and no future adapter needed.
 * realAdapter reads the increment off cached REST metadata only (`meta.extendSeconds ? *1000 : null`)
 * while it reads soft-close off the socket's sticky AuctionExtended latch as well, so an EMPTY
 * loadMeta - a fresh Map after any restart, or a load SuperProcure has delisted from /sp/loads/v4 -
 * publishes closeModel 'soft' with extendMs null on an ok:true read. Every deploy restarts the
 * process, so every deploy rolls this.
 *
 * WHAT THIS FILE HOLDS, and it is deliberately two-sided. The fix must resolve an ABSENT increment to
 * the measured platform bound, and it must ALSO leave a PUBLISHED zero meaning what it says - a
 * branch that runs no anti-snipe rounds. A patch that falls back on falsiness (`extendMs || 180000`)
 * fixes the first half and breaks the second, so cases A3 and B3 exist to fail it. A1/A4/B1 pin that
 * the ordinary published path - every hard-close load, and every soft load whose branch publishes its
 * increment - is untouched.
 *
 * The 180,000ms fallback is MEASURED, not chosen: bidEngine's own 2026-07-25 Havells record (in
 * _observeExtension) has 4 of 4 soft auctions whose socket froze at closesInMs 0 closing 183.1-183.4s
 * later - one clean 180s extension plus this engine's 3s finalize debounce.
 *
 * Every case drives the real _tick, so it exercises the shipped branch rather than a predicate in
 * isolation. The zero run is aged by moving monitor._zeroSince backwards rather than by sleeping, so
 * the file is deterministic and fast; placeBid is captured, never sent.
 *
 *   node scripts/test-extend-increment-unpublished.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
let ran = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const FAILURES = [];
const TMP_FILES = [];

// COMPLETION SENTINEL, registered HERE - before the first case is built - and fired on process exit.
// scripts/run-tests.js grades every file by EXIT CODE ALONE, so an async file that returns early,
// rejects into a swallowed handler, or resolves a require to a stub exits 0 as a silent green
// zero-assertion run. Registration ORDER is the fix: an exit handler installed before the work runs
// fires on every path out of the process, including the ones that never reach the end of the file.
const EXPECTED_CASES = 10;
process.on('exit', (code) => {
  for (const f of TMP_FILES) { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } }
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\nunpublished extend increment: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

// Cases are isolated so one failure does not hide the state of the others - on a money path the full
// picture of which reads moved matters more than failing fast. The sentinel keeps the exit code honest.
async function run(name, fn) {
  ran++;
  try { await fn(); ok(name); } catch (e) {
    FAILURES.push({ name, message: e && e.message });
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures - the live Havells soft branch these defects were found against.
// ---------------------------------------------------------------------------------------------
const BASE_DEBOUNCE_MS = 3_000;    // engine finalizeDebounceMs; the clock-skew guard, nothing more
const EXTEND_MS = 180_000;         // branchAuctionExtendTime on the branch, and the measured fallback
const TRIGGER_WINDOW_MS = 100_000; // branchAuctionRemainingTime: a bid inside this EXTENDS the close
const FLOOR_WINDOW_MS = 2_500;

let seq = 0;
// named re-pin: round tracker, ruling 56 - a close move counts as a round only when read inside the old
// close's trigger window, so the cases that count one (A5, B1-B3) arm 90 s before the close.
function stack(closeInMs = 600_000) {
  const stateFile = path.join(os.tmpdir(), `extend-increment-${process.pid}-${seq++}.json`);
  TMP_FILES.push(stateFile);
  const feed = { current: null };
  const placed = [];
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => feed.current,
    placeBid: async (id, price) => { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(stateFile), {
    config: { openAtMs: 25_000, floorWindowMs: FLOOR_WINDOW_MS, minInterFireMs: 0, openJitterMs: 0,
      cadenceJitterMs: 0, finalizeDebounceMs: BASE_DEBOUNCE_MS },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const closeAt = Date.now() + closeInMs;
  const m = eng.arm({ id: `HAV-${seq}`, lane: { origin: 'Alwar', destination: 'Pune' }, units: 1,
    companyName: 'Havells', closesAt: closeAt }, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  return { eng, m, feed, placed, events, closeAt };
}

// One frame. extendMs is the field under test and is passed through untouched, including undefined.
function frame(o) {
  return Object.assign({
    ok: true, status: 'live', myRank: 3, totalBidders: 5, standingL1Price: null,
    closesInMs: 250_000, closeModel: 'soft', extendCount: null, triggerWindowMs: TRIGGER_WINDOW_MS,
    minDecrement: 100, revisionsLeft: null, measuredRttMs: 50,
  }, o);
}

async function tick(eng, m, feed, state) {
  feed.current = state;
  await eng._tick(m);
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
}

/**
 * The frozen zeroed socket from the 2026-07-25 measurement: countdown pinned to 0, close time frozen
 * at the believed close (so no forward jump ever arrives), platform still answering ok:true. `status`
 * is 'closed' to match realAdapter exactly (`closesInMs <= 0 ? 'closed' : 'live'`) - the frozen socket
 * reports the auction closed while it is demonstrably still running. On a soft monitor that field
 * changes nothing: hardClosed is gated on !isSoft, so only the sustained-zero debounce can retire it.
 *
 * Runs two ticks, aging the zero run by `agedMs` between them, and returns the monitor's fate.
 */
async function survivesZeroRun({ extendMs, closeModel = 'soft', agedMs = BASE_DEBOUNCE_MS, closeInMs }) {
  const s = stack(closeInMs);
  const zeroed = frame({ status: 'closed', closesInMs: 0, closesAtMs: s.closeAt, closeModel, extendMs });
  await tick(s.eng, s.m, s.feed, zeroed);
  if (s.m._zeroSince != null) s.m._zeroSince -= agedMs;
  await tick(s.eng, s.m, s.feed, zeroed);
  return s;
}

/**
 * One whole soft auction: settle the belief, publish ONE real 180,000ms extension as a forward jump of
 * the live close, then step into the old decisive band (triggerWindow, triggerWindow + floorWindow] and
 * then the last-chance window. extendCount 1 means a single observed extension exhausts the cap, and
 * since 2026-09-24 a used-up cap sends the final bid in the last seconds like hard close.
 */
async function auctionWithOneExtension({ extendMs, jumpMs = EXTEND_MS, closeInMs }) {
  const s = stack(closeInMs);
  const at = (closesInMs, closesAtMs) => frame({ closesInMs, closesAtMs, extendMs, extendCount: 1 });
  await tick(s.eng, s.m, s.feed, at(250_000, s.closeAt));
  await tick(s.eng, s.m, s.feed, at(220_000, s.closeAt + jumpMs));
  const afterJump = { extendsObserved: s.m.extendsObserved, effectivelyHard: s.eng._effectivelyHard(s.m) };
  await tick(s.eng, s.m, s.feed, at(TRIGGER_WINDOW_MS + 1_000, s.closeAt + jumpMs));
  const placedInBand = s.placed.slice();
  await tick(s.eng, s.m, s.feed, at(FLOOR_WINDOW_MS - 100, s.closeAt + jumpMs));
  return Object.assign(s, { afterJump, placedInBand });
}

const floorOf = (m) => m.ladder[m.ladder.length - 1];

(async () => {
  console.log('unpublished extend increment');

  // ===========================================================================================
  // A - THE SETTLE WINDOW. Which zero runs retire a monitor, and which do not.
  // ===========================================================================================

  // The ordinary live path, held first so a regression here is unmistakable: every soft load whose
  // branch publishes its increment must behave exactly as the deployed engine does.
  await run('A1 CONTROL published 180,000ms increment: 3,000ms of zero does NOT retire the monitor', async () => {
    const s = await survivesZeroRun({ extendMs: EXTEND_MS });
    assert.strictEqual(s.m.finalized, false,
      'a soft monitor with a published 180,000ms increment was retired after 3,000ms of zeroed '
      + 'countdown. Its settle window is 183,000ms and this is the deployed behaviour - the fix must '
      + 'not have touched it');
  });

  // catches: the defect itself. Same auction, same instant, the increment simply not published.
  await run('A2 UNPUBLISHED increment (null): 3,000ms of zero does NOT retire the monitor', async () => {
    const s = await survivesZeroRun({ extendMs: null });
    assert.strictEqual(s.m.finalized, false,
      'a soft-close monitor whose platform published NO increment was terminally retired after only '
      + '3,000ms of a zeroed countdown while getAuctionState still answered ok:true. The measured '
      + 'freeze on this platform is ~183,000ms, _finalize writes status closed to the durable intent '
      + 'so nothing can re-arm it, and the reserved floor rung is never sent - a priced, armed, live '
      + 'auction abandoned ~180s early');
  });

  // catches: a falsiness-based patch (`extendMs || 180000`), which cannot tell the two apart. A
  // PUBLISHED zero is the platform stating this branch has no anti-snipe mechanic, so the settle
  // window is the base skew guard and 3,000ms of zero is a close.
  await run('A3 PUBLISHED zero increment: 3,000ms of zero DOES retire the monitor', async () => {
    const s = await survivesZeroRun({ extendMs: 0 });
    assert.strictEqual(s.m.finalized, true,
      'a branch that published an increment of ZERO - no anti-snipe rounds exist on it - was held '
      + 'open past its own close. "Not published" and "published as zero" are different facts and '
      + 'only the first may widen the settle window');
  });

  // catches: the fallback leaking onto the hard-close path, which is the overwhelming majority of
  // loads (intake is hard-close-only by default). A hard close has a fixed end; the base debounce is
  // a clock-skew guard and nothing else, and no increment - published or not - may extend it.
  await run('A4 HARD close with no increment: the zero is authoritative and retires immediately', async () => {
    const s = await survivesZeroRun({ extendMs: null, closeModel: 'hard', agedMs: 0 });
    assert.strictEqual(s.m.finalized, true,
      'a HARD-close load did not finalize at its authoritative zero. The unpublished-increment '
      + 'fallback is soft-close-only; leaking it here holds every ordinary load open for 183s past '
      + 'its close and delays every auction_result on the board');
  });

  // catches: a fix that keeps the monitor alive but leaves the extension uncounted, or one that
  // counts the inferred round twice when the real close finally publishes.
  await run('A5 the real extension then arrives: counted ONCE, belief catches up, nothing discarded', async () => {
    const s = await survivesZeroRun({ extendMs: null, closeInMs: 90_000 });
    assert.strictEqual(s.m.finalized, false, 'precondition: the monitor must still be live');
    // named re-pin: round tracker, ruling 56 - the sustained zero no longer infers the round; the round
    // reads UNCERTAIN_AFTER_CLOSE until the platform publishes it, and is counted then, once.
    assert.strictEqual(s.m.extendsObserved, 0,
      'the sustained zero counted a round - ruling 56 retired the inference');
    assert.strictEqual(s.eng.roundVerdict(s.m).verdict, 'UNCERTAIN_AFTER_CLOSE',
      'the sustained zero on a live soft auction did not make the round UNCERTAIN_AFTER_CLOSE');
    await tick(s.eng, s.m, s.feed, frame({ closesInMs: EXTEND_MS, closesAtMs: s.closeAt + EXTEND_MS,
      extendMs: null }));
    assert.strictEqual(s.m.extendsObserved, 1,
      'the late frame publishing the close of the round the zero hid is that ONE round; it was not '
      + 'counted exactly once');
    assert.strictEqual(s.m.believedCloseAt, s.closeAt + EXTEND_MS,
      'the belief did not catch up to the close SuperProcure finally published');
    assert.strictEqual(s.events.filter((e) => e.kind === 'extend_after_finalize').length, 0,
      'the engine watched a real 180s extension land on an auction it had already retired');
  });

  // catches: the string-coercion hole the raw read left open. `'180000' + 3000` is the STRING
  // '1800003000', a ~20-day settle window on a monitor that then never finalizes at all. No shipped
  // adapter sends a string today; this pins the normalization that makes it impossible.
  await run('A6 a NUMERIC STRING increment normalizes rather than concatenating into a 20-day window', async () => {
    const s = await survivesZeroRun({ extendMs: '180000', agedMs: 200_000 });
    assert.strictEqual(s.m.finalized, true,
      'a string increment was concatenated onto the base debounce instead of being normalized, so '
      + 'the settle window became ~1,800,003,000ms and the monitor can never retire');
  });

  // ===========================================================================================
  // B - COUNTING THE EXTENSION. What reaches extendsObserved, and what that releases.
  // ===========================================================================================

  await run('B1 CONTROL published increment: the +180,000ms jump is counted and the floor is released', async () => {
    const s = await auctionWithOneExtension({ extendMs: EXTEND_MS, closeInMs: 90_000 });
    assert.strictEqual(s.afterJump.extendsObserved, 1, 'a published forward jump of a full increment must count as one extension');
    assert.strictEqual(s.afterJump.effectivelyHard, true, 'one observed extension against a cap of 1 exhausts the cap');
    assert.ok(!s.placedInBand.includes(floorOf(s.m)),
      'the reserved floor rung was released ~100s before the close - reversed 2026-09-24: after the extension cap final '
      + 'bids go in the last seconds like hard close, not in the band above the trigger window');
    assert.strictEqual(s.placed[s.placed.length - 1], floorOf(s.m),
      'the reserved floor rung was not released at the buzzer once the published jump used up the cap (reversed '
      + '2026-09-24 from the band to the last seconds, like hard close)');
  });

  // catches: the defect. The platform announced the round in the clearest form it has - the live
  // close time moving forward by a whole increment - and the engine returned before measuring it.
  await run('B2 UNPUBLISHED increment: the same +180,000ms jump is still counted', async () => {
    const s = await auctionWithOneExtension({ extendMs: null, closeInMs: 90_000 });
    assert.strictEqual(s.afterJump.extendsObserved, 1,
      'the live close jumped FORWARD by a full 180,000ms - an unmistakable published extension - and '
      + 'the engine counted ZERO, because the increment read bailed before the jump was measured');
    assert.strictEqual(s.afterJump.effectivelyHard, true,
      'with extendsObserved stuck at 0 against a cap of 1 the load can never leave the reserve-gated '
      + 'defend branch, for the whole life of the auction');
  });

  // The money consequence of B2, asserted at the wire. Split from it so a failure names which half
  // broke: the counting, or what the count releases.
  // REVERSED 2026-09-24: with the cap used up the floor belongs in the last seconds, like hard close. An
  // uncounted jump leaves the load pre-cap, where the buzzer sends a middle price instead - so the floor
  // at the buzzer is still what proves the count.
  await run('B3 UNPUBLISHED increment: the floor rung reaches the wire at the buzzer, not in the band', async () => {
    const s = await auctionWithOneExtension({ extendMs: null, closeInMs: 90_000 });
    const floor = floorOf(s.m);
    assert.ok(!s.placedInBand.includes(floor),
      `the floor went at ${TRIGGER_WINDOW_MS + 1_000}ms remaining - reversed 2026-09-24: after the extension cap final `
      + 'bids go in the last seconds like hard close, not in the band above the trigger window');
    assert.strictEqual(s.placed[s.placed.length - 1], floor,
      `at ${FLOOR_WINDOW_MS - 100}ms remaining the engine did not release its reserved floor rung (Rs ${floor}); it sent `
      + `Rs ${s.placed[s.placed.length - 1]} off ladder [${s.m.ladder.join(',')}] - the uncounted jump left the load `
      + 'believing an extension remained, so the floor was kept back from the round that decided it');
  });

  // catches: a fallback applied so loosely that ANY forward move of the close reads as a round. The
  // plausibility floor (half an increment) still has to hold when the increment is the assumed one,
  // or clock-sync wobble manufactures extensions and walks the load to its cap on nothing.
  await run('B4 UNPUBLISHED increment: a jump too small to be a round is still NOT counted', async () => {
    const s = await auctionWithOneExtension({ extendMs: null, jumpMs: 30_000 });
    assert.strictEqual(s.afterJump.extendsObserved, 0,
      'a 30,000ms forward move - far below half the assumed 180,000ms increment - was counted as an '
      + 'anti-snipe round. The fallback supplies a SIZE for the plausibility gate; it must not remove it');
  });
})().catch((e) => {
  FAILURES.push({ name: 'harness', message: e && e.stack });
  process.exitCode = 1;
});
