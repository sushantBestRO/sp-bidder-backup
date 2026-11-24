'use strict';
/**
 * Ruling 60 - the post-close refusal latch (submissionClosed) must clear when a published close
 * moves forward past the close in force when it latched.
 *
 * Defect (timing-items.md s3): GoComet's post-close refusal is a conflated 422 ("closed or maximum
 * revision limit") that cannot distinguish "this round really ended" from "a rival's in-window bid
 * just extended it". The engine treats it as terminal and nothing anywhere clears it - not even once
 * the close visibly moves forward into a new round with attempts still left. Scale: timing-E counted
 * 2,117 such refusals on bid-command's own Waaree writes in three weeks.
 *
 * Must NOT move: no forward close move -> still latched (the ~45-writes-per-load fix this class
 * exists for); revisionsLeft exhausted after the move -> still no write; an equal or backward close
 * -> still latched; SuperProcure's inferred zero-countdown round -> still latched (it invents no
 * time, so there is nothing to clear against).
 *
 *   node scripts/test-submission-closed-latch-clears-on-forward-close.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 9;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const GC_CLOSED = 'Validation failed: Cannot Submit Quote either the enquiry is closed or you have reached maximum revision limit';
const EXTEND_MS = 300_000; // GoComet's declared increment
const JUMP_MS = 299_000;   // the real jump: whole-second rounding of the increment

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `latch-clear-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const ENGINES = [];
const cleanup = () => {
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
};

// The soft-close opt-in in the shape _resolveSoftStrategy requires: master gate ON and the shipper
// named. Havells is allowlisted, so softStrategy resolves off 'off' and _observeExtension takes the
// GoComet-shaped round-counting branch rather than the non-allowlisted early-return one.
const SOFT_ON = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };

function mkEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('this fixture wires placeBid explicitly per scenario'); },
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: SOFT_ON,
    onEvent: (e) => events.push(e),
  });
  ENGINES.push(eng);
  eng._events = events;
  return eng;
}

function armFine(eng, ladder, { id = 'F', revisionsLeft = 3 } = {}) {
  const T = Date.now() + 600_000;
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: T };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  return { m, T };
}

const state = (closesInMs, extra = {}) => Object.assign(
  { closesInMs, myRank: null, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 }, extra);
const frame = (closesAtMs, closesInMs, extra = {}) => Object.assign(
  { ok: true, closesAtMs, closesInMs, extendMs: EXTEND_MS, extendCount: null }, extra);

function mkScenario(tag, { revisionsLeft = 3 } = {}) {
  const eng = mkEngine();
  const { m, T } = armFine(eng, [41_420, 40_736, 38_684], { id: `LATCH-${tag}`, revisionsLeft });
  return { eng, m, T };
}

(async () => {
  // ---- 1) + 2) the conflated 422 latches the load after exactly one refused write ----------------
  const primary = mkScenario('PRIMARY');
  {
    const calls = [];
    primary.eng.adapter.placeBid = async (_id, price) => {
      calls.push(price);
      return { accepted: false, status: 422, reason: GC_CLOSED, text: GC_CLOSED };
    };
    await primary.eng._maybeBid(primary.m, state(12_000));
    assert.strictEqual(calls.length, 1, `fixture: exactly one write must reach the wire, got ${calls.length}`);
    assert.strictEqual(primary.m.submissionClosed, true, 'the conflated 422 did not latch submissionClosed');
    assert.strictEqual(primary.m._submissionClosedAtClose, primary.T,
      'the close in force when the latch set was not stamped');
    ok('the conflated 422 latches submissionClosed and stamps the close in force');

    assert.ok(primary.m.noBid && primary.m.noBid.reason === 'submission_window_closed',
      'the refusal is not recorded as submission_window_closed');
    ok('the no-bid reason is recorded as submission_window_closed');
  }

  // ---- 3) CONTROL: no forward close move -> still latched, no second write ------------------------
  {
    const calls2 = [];
    primary.eng.adapter.placeBid = async (_id, price) => { calls2.push(price); return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }; };
    await primary.eng._maybeBid(primary.m, state(11_500));
    assert.strictEqual(calls2.length, 0, `control: ${calls2.length} write(s) went out while the close never moved`);
    assert.strictEqual(primary.m.submissionClosed, true, 'control: the latch cleared with no forward close move');
    ok('control: with no forward close move the latch holds and no second write is sent');
  }

  // ---- 4) + 5) + 6) THE FIX: a published forward move clears the latch and the load bids again ----
  {
    primary.eng._observeExtension(primary.m, frame(primary.T + JUMP_MS, 6_000));
    assert.strictEqual(primary.m.believedCloseAt, primary.T + JUMP_MS,
      'fixture: the published forward move did not advance the believed close');
    assert.strictEqual(primary.m.submissionClosed, false,
      'a published close moved forward past the close in force when the 422 latched, and the load is '
      + 'still stood down - ruling 60 (timing-items.md s3): the latch must clear on this move');
    ok('a published forward close move clears the submissionClosed latch');

    assert.ok(!(primary.m.noBid && primary.m.noBid.reason === 'submission_window_closed'),
      'the no-bid reason still blames a submission window that has reopened');
    ok('the recorded no-bid reason resets when the latch clears');

    const calls3 = [];
    primary.eng.adapter.placeBid = async (_id, price) => { calls3.push(price); return { accepted: true, myRank: 1, revisionsLeft: 1, latencyMs: 20 }; };
    await primary.eng._maybeBid(primary.m, state(6_000));
    assert.strictEqual(calls3.length, 1,
      `the round shot in the new round made ${calls3.length} writes; expected exactly 1 - the load must bid `
      + 'again once the close has genuinely moved past the round that refused it');
    ok('the load places a bid in the new round once the latch has cleared');
  }

  // ---- 7) CONTROL: revisionsLeft exhausted after the move -> still no write ------------------------
  {
    const s = mkScenario('NOREV');
    s.eng.adapter.placeBid = async () => ({ accepted: false, status: 422, reason: GC_CLOSED, text: GC_CLOSED });
    await s.eng._maybeBid(s.m, state(12_000));
    assert.strictEqual(s.m.submissionClosed, true, 'fixture: the 422 did not latch');
    s.m.revisionsLeft = 0;
    s.eng._observeExtension(s.m, frame(s.T + JUMP_MS, 6_000));
    assert.strictEqual(s.m.submissionClosed, false, 'fixture: the latch did not clear on the forward move');
    const calls = [];
    s.eng.adapter.placeBid = async (_id, price) => { calls.push(price); return { accepted: true, myRank: 1, revisionsLeft: 0, latencyMs: 20 }; };
    await s.eng._maybeBid(s.m, state(6_000));
    assert.strictEqual(calls.length, 0,
      `control: the latch cleared with zero revisions left and the engine still sent ${calls.length} write(s)`);
    ok('control: clearing the latch spends no budget the load does not have');
  }

  // ---- 8) CONTROL: an equal or backward close does not clear the latch ------------------------------
  {
    const s = mkScenario('BACKWARD');
    s.m.submissionClosed = true;
    s.m._submissionClosedAtClose = s.T;
    s.eng._clearSubmissionClosedOnForwardMove(s.m, s.T);
    assert.strictEqual(s.m.submissionClosed, true, 'control: an EQUAL close cleared the latch');
    s.eng._clearSubmissionClosedOnForwardMove(s.m, s.T - 1_000);
    assert.strictEqual(s.m.submissionClosed, true, 'control: a BACKWARD close cleared the latch');
    ok('control: an equal or backward close leaves the latch set');
  }

  // ---- 9) CONTROL: a sustained zero countdown never clears the latch --------------------------------
  // named re-pin: round tracker, ruling 56 - a frozen zero no longer infers a round; it counts nothing
  // and moves no close, so it still cannot satisfy the clear's forward-move test.
  {
    const s = mkScenario('INFERRED');
    s.m.submissionClosed = true;
    s.m._submissionClosedAtClose = s.m.believedCloseAt;
    s.m._zeroSince = Date.now() - (s.eng.cfg.finalizeDebounceMs + 1_000);
    const counted = s.eng._observeExtension(s.m, frame(s.m.believedCloseAt, 0));
    s.m._zeroSince = null;
    assert.strictEqual(counted, false, 'fixture: the sustained zero counted a round');
    assert.strictEqual(s.m.submissionClosed, true,
      'the sustained zero countdown cleared the latch, but it moves no close to clear against');
    ok('control: a sustained zero countdown never clears the latch');
  }

  cleanup();
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  cleanup();
  console.error('\nFAILED:', e && e.stack || e);
  process.exit(1);
});
