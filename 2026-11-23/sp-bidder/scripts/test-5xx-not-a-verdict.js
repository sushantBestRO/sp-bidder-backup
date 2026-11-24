'use strict';
/**
 * Regression: T5 F7 - a 5xx server fault reaching the terminal rejection classifiers.
 *
 * The refused-price run counter already excludes a >=500 status ("a server fault is not a
 * platform verdict"), but the five terminal classifiers built on rejectionMatch (bid-cap,
 * load-not-biddable, quantity, raise, submission-closed) scan the SAME envelope unguarded, on
 * both the live rejection path and the post-retire path. A portal 5xx whose body happens to
 * contain a classifier's wording therefore stands a live auction down for good, or drains its
 * revision budget, on a response that never reached the auction at all.
 *
 * WHAT MUST NOT MOVE: an identical body at a genuine 4xx is a real platform verdict and must
 * still latch exactly as before (checks 2 and 4 are the control - a green mechanism check next
 * to a harness that cannot itself tell 5xx from 4xx is not evidence of anything).
 *
 * Mock policy: only the platform adapter's placeBid is mocked. Every decision comes from the
 * real _decide/_maybeBid/_recordRefusedAfterRetire. Offline and deterministic: fake adapter,
 * temp-file scheduler, no network, no timers beyond immediate microtask flushes.
 *
 *   node scripts/test-5xx-not-a-verdict.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0;
const EXPECTED_CHECKS = 6;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-5xx-verdict-'));
let seq = 0;
const tmp = () => path.join(TMPDIR, `intent-${seq++}.json`);
const cleanup = () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} };

// Verbatim platform strings, matched against the same classifiers T5 F7 traces.
const SUBMISSION_CLOSED_BODY = 'Auction has already ended for this load';
const LOAD_NOT_BIDDABLE_BODY = 'Load not available for bidding';
const CAP_BODY = 'Bid limit exceeded';

function mkEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: false },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return eng;
}

function armFine(eng, ladder, { id = 'F5XX' } = {}) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'hard';
  m.revisionsLeft = 30;
  return m;
}

const state = (remaining, myRank = null) => ({ closesInMs: remaining, myRank,
  minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });

const rejectedEvents = (eng) => eng._events.filter((e) => e.type === 'bid_rejected');
const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);

(async () => {
  // ============================================================================================
  // 1. MECHANISM (live path): a 503 carrying the submission-closed wording must not stand the
  //    load down. The engine must keep sending on the next tick and be able to land.
  // ============================================================================================
  {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700]);
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      if (attempted.length === 1) return { accepted: false, status: 503, reason: SUBMISSION_CLOSED_BODY, text: SUBMISSION_CLOSED_BODY };
      return { accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 };
    };

    await eng._maybeBid(m, state(20_000, null));
    assert.strictEqual(m.submissionClosed, false,
      `a 503 is not a platform verdict, so the submission-closed classifier must not latch (submissionClosed ${m.submissionClosed})`);

    await eng._maybeBid(m, state(2_000, 2));
    assert.deepStrictEqual(attempted, [10_000, 9_700], 'the engine kept sending after the 5xx instead of standing down for good');
    assert.ok(m.landedBids > 0, `nothing landed after the platform recovered (attempted: [${attempted.join(', ')}])`);
    ok('a 503 matching the submission-closed wording does not latch a stand-down, and the load keeps bidding');
  }

  // ============================================================================================
  // 2. CONTROL (live path): the IDENTICAL body at a genuine 400 must still latch immediately -
  //    proves the harness (and the classifier) can tell a real verdict from a server fault.
  // ============================================================================================
  {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700]);
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => {
      attempted.push(price);
      return { accepted: false, status: 400, reason: SUBMISSION_CLOSED_BODY, text: SUBMISSION_CLOSED_BODY };
    };

    await eng._maybeBid(m, state(20_000, null));
    assert.strictEqual(m.submissionClosed, true, 'CONTROL: a genuine 400 with the same wording must still latch - harness is dead otherwise');

    await eng._maybeBid(m, state(15_000, 2));
    await eng._maybeBid(m, state(3_000, 2));
    assert.deepStrictEqual(attempted, [10_000], 'CONTROL: a real submission-closed verdict must stop every later attempt');
    ok('CONTROL: the same wording at a real 4xx still stands the load down for good');
  }

  // ============================================================================================
  // 3. MECHANISM (post-retire path): _recordRefusedAfterRetire must not latch loadNotBiddable on
  //    the successor when the resolving write was a 503.
  // ============================================================================================
  {
    const eng = mkEngine();
    const fired = armFine(eng, [10_000, 9_700], { id: 'F5XX-RETIRE' });
    eng.stop('F5XX-RETIRE');
    const live = armFine(eng, [9_400, 9_100], { id: 'F5XX-RETIRE' });
    assert.notStrictEqual(live, fired, 'precondition: the re-price built a distinct successor monitor');
    const res = { accepted: false, status: 503, reason: LOAD_NOT_BIDDABLE_BODY, text: LOAD_NOT_BIDDABLE_BODY };
    await eng._recordRefusedAfterRetire(fired, { price: 10_000, rungIndex: 0 }, res, state(20_000, null), { vcq: null });

    assert.strictEqual(live.loadNotBiddable, false,
      `a 503 resolving after a retire must not latch the successor (loadNotBiddable ${live.loadNotBiddable})`);
    ok('post-retire: a 503 carrying the load-not-biddable wording does not latch the successor');
  }

  // ============================================================================================
  // 4. CONTROL (post-retire path): the identical body at 400 still latches on the successor.
  // ============================================================================================
  {
    const eng = mkEngine();
    const fired = armFine(eng, [10_000, 9_700], { id: 'F5XX-RETIRE-CTRL' });
    eng.stop('F5XX-RETIRE-CTRL');
    const live = armFine(eng, [9_400, 9_100], { id: 'F5XX-RETIRE-CTRL' });
    assert.notStrictEqual(live, fired, 'precondition: the re-price built a distinct successor monitor');
    const res = { accepted: false, status: 400, reason: LOAD_NOT_BIDDABLE_BODY, text: LOAD_NOT_BIDDABLE_BODY };
    await eng._recordRefusedAfterRetire(fired, { price: 10_000, rungIndex: 0 }, res, state(20_000, null), { vcq: null });

    assert.strictEqual(live.loadNotBiddable, true, 'CONTROL: a genuine 400 must still latch on the successor - harness is dead otherwise');
    ok('CONTROL: post-retire, the same wording at a real 4xx still latches the successor');
  }

  // ============================================================================================
  // 5. Same guard, second classifier: a 503 carrying "Bid limit exceeded" must not exhaust the
  //    per-load budget either - the fix is one guard shared by all five classifiers, not a
  //    one-off for submission-closed.
  // ============================================================================================
  {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700]);
    const before = m.revisionsLeft;
    const attempted = [];
    eng.adapter.placeBid = async (_id, price) => { attempted.push(price); return { accepted: false, status: 503, reason: CAP_BODY, text: CAP_BODY }; };

    await eng._maybeBid(m, state(20_000, null));
    assert.strictEqual(m.capExhausted, false, `a 503 carrying "Bid limit exceeded" must not latch the cap (capExhausted ${m.capExhausted})`);
    assert.strictEqual(m.revisionsLeft, before, 'the budget must stay intact against a server fault');

    // A real cap exhaustion is permanent (the top-of-tick stand-down guard drops revisionsLeft to
    // 0), so if it had wrongly latched here this second call would never reach the wire.
    await eng._maybeBid(m, state(2_000, 2));
    assert.deepStrictEqual(attempted, [10_000, 9_700], 'a false cap latch stopped the engine from sending its next rung');
    ok('a 503 matching the bid-cap wording does not exhaust the per-load budget');
  }

  // ============================================================================================
  // 6. NOT SILENT: a 5xx rejection is still recorded on the event stream (bid_rejected, carrying
  //    its own status) - the fix must not turn a server fault into a dropped, untraceable write.
  // ============================================================================================
  {
    const eng = mkEngine();
    const m = armFine(eng, [10_000, 9_700]);
    eng.adapter.placeBid = async () => ({ accepted: false, status: 503, reason: SUBMISSION_CLOSED_BODY, text: SUBMISSION_CLOSED_BODY });
    await eng._maybeBid(m, state(20_000, null));

    const rej = rejectedEvents(eng);
    assert.strictEqual(rej.length, 1, 'a 5xx rejection must still be recorded on the event stream, not dropped silently');
    assert.strictEqual(rej[0].status, 503, 'the recorded rejection must carry the real status the platform sent');
    assert.strictEqual(alertsOfKind(eng, 'submission_window_closed').length, 0,
      'a 5xx must not raise the submission-closed desk alert - nothing was actually decided');
    ok('a 5xx rejection is still recorded on the event stream, carrying its own status, with no false stand-down alert');
  }

  cleanup();
  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran/passed ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  cleanup();
  console.error('\nFAILED:', e && e.stack || e);
  process.exit(1);
});
