'use strict';
/**
 * L3 SOFT-CLOSE / AUCTION-EXTENSION endgame - deterministic extend-sequence suite (design section 5).
 *
 * Drives the engine's decision + extend-detection logic DIRECTLY (no timers, no network, no wall-clock
 * waits) with scripted states, the same reach-into-internals style the rest of this suite uses
 * (eng._decide, eng._observeExtension, eng._maybeBid). Each case pins the placeBid/decision sequence and
 * the money-safety spine: we NEVER snipe a non-final soft window, NEVER bid past believed close, and
 * degrade to the proven Module-1 behaviour when extend state is unknown.
 *
 *   T1  no-extension soft load               T6  missed extend event (dropped ackString / neither)
 *   T2  single extension mid-window          T7  extend AFTER finalize (ignored)
 *   T3  max extensions reached               T8  clock skew (server-corrected countdown)
 *   T4  extend at T-0 (finalize debounce)    T9  revision exhaustion under repeated extends
 *   T5  extend beyond plausibility bound     T10 golden byte-identity (hard + soft-disabled)
 *
 *   node scripts/test-softclose-extend-sequences.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { SpSocket } = require('../src/platform/spSocket');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const tmp = () => path.join(os.tmpdir(), `sc-ext-${process.pid}-${seq++}.json`);
const CLEAN = [];
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// A soft-strategy engine. mode 'live' so _decide's soft branch engages (mode gates only the write path,
// which these decision tests bypass). caps are SuperProcure's: rank-only, 30-revision default.
function mkEngine({ mode = 'live', reserve = 1, shippers = ['Havells'], onEvent } = {}) {
  const f = tmp(); CLEAN.push(f);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must not be reached in these decision tests'); },
  };
  return new BidEngine(adapter, new DurableScheduler(f), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, rungs: 6 },
    softClose: { enabled: true, shippers, mode, reserve },
    onEvent: onEvent || (() => {}),
  });
}

// Arm a soft monitor on a 3-rung BAND ladder and detach the auto-tick so we can drive decisions
// synchronously. Coarse (3-rung) is what every existing customer runs on merge (the reversibility
// spine): selectRung('snipe') collapses to the FLOOR on a < 3-rung ladder, so the rank-aware snipe is
// byte-identical to the deployed always-floor snipe these sequence cases assert against. (Fine ladders
// + a rank-selected non-floor snipe are a separate, allowlisted-shipper concern, covered elsewhere.)
// The band [78820, 75040, 74410] at cost 70000 has rung 0 establish, rung 1 the one defend step, rung 2
// the reserved floor - exactly the coarse shape the old rate-model 6-rung fixture stood in for.
function armSoft(eng, { companyName = 'Havells', cost = 70_000, marginsPct = [12.6, 7.2, 6.3], revisionsLeft = 30 } = {}) {
  const meta = { id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, companyName, closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost, marginsPct });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';          // as _tick sets from the live socket frame
  m.revisionsLeft = revisionsLeft;
  return m;
}

// rank-only state for _decide.
const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null });
// advance monitor state exactly as an accepted bid would (so a sequence progresses).
function applyDecision(m, d) {
  if (!d) return;
  m.lastBidPrice = d.price;
  if (d.rungIndex != null) { m.currentRungIndex = Math.max(m.currentRungIndex, d.rungIndex); m.firedRungs.add(d.rungIndex); }
  if (m.revisionsLeft != null) m.revisionsLeft -= 1;
  // landedBids is the ON-THE-BOARD participation fact, incremented at the real accepted-bid fire point
  // (_maybeBid) and NOT on a rejection. This harness models an ACCEPTED bid, so it must move too:
  // _lastResortFloor reads it to tell "we are bidding this load and holding the floor in reserve"
  // (the documented T1b/T3 strategy) apart from "nothing ever reached the board" (the Alwar forfeit).
  m.landedBids = (m.landedBids || 0) + 1;
}
// establish rung 0 and record it as fired. Soft establishes LATE now (LM#5) - ~establishLeadMs before
// the trigger window, or at the openAtMs mark (25s here) when the window is not yet surfaced - not at any
// remaining as it used to. 20s clears both marks (25s openAtMs, and window+40s when a window is set), so
// the establish decision fires regardless of whether _observeExtension has surfaced a window yet.
function establish(eng, m) {
  const d = eng._decide(m, st(20_000, null));
  assert.ok(d && d.rungIndex === 0, 'precondition: soft establishes rung 0 in the establish window');
  applyDecision(m, d);
  return d;
}
// an extend frame at a given absolute close time (server epoch ms).
const frame = (closeAt, { extendCount = null, triggerWindowMs = 100_000, extendMs = 180_000 } = {}) =>
  ({ extendCount, triggerWindowMs, extendMs, closesAtMs: closeAt });
// named re-pin: round tracker, ruling 56 - a forward move counts as a round only when it is read inside
// the old close's trigger window, so an extension is observed 30 s before the close it extends.
function observeInWindow(eng, m, f) {
  const REAL_NOW = Date.now;
  const at = m.believedCloseAt - 30_000;
  Date.now = () => at;
  try { return eng._observeExtension(m, f); } finally { Date.now = REAL_NOW; }
}

(async () => {
  // ---- T1a. NO EXTENSION POSSIBLE (cap 0) -> behaves like a single HARD-close window ----
  {
    const eng = mkEngine();
    const m = armSoft(eng);
    // extendCount 0 surfaced -> effectivelyHard from the start (no window can ever trigger).
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 0 }));
    assert.strictEqual(m.extendCap, 0, 'cap surfaced as 0');
    assert.strictEqual(eng._effectivelyHard(m), true, 'cap 0 -> effectively hard immediately');
    establish(eng, m);
    assert.strictEqual(eng._decide(m, st(300_000, 1)), null, 'hold while L1');
    const step = eng._decide(m, st(200_000, 3)); // outranked, early -> step down (hard path), never the floor
    const last = m.ladder.length - 1;
    assert.ok(step && step.rungIndex > 0 && step.rungIndex < last, 'outranked early: steps down, floor held');
    applyDecision(m, step);
    const snipe = eng._decide(m, st(2_000, 2)); // final window
    assert.ok(snipe && snipe.rungIndex === last, 'ONE floor snipe in the final window (like hard close)');
    ok('T1a no-extension soft load (cap 0) behaves like a single hard-close window: one floor snipe at the end');
  }

  // ---- T1b. cap>=1 soft load that NEVER extends -> the floor snipe is SUPPRESSED (fail-closed). ----
  // DESIGN NOTE (contradiction, resolved fail-closed): section 5 T1 says a no-extension soft load fires
  // "exactly one floor snipe at the end". But per the mechanic the design itself describes, ANY floor
  // snipe placed while extensions remain (extendsObserved < cap) lands inside the trigger window and
  // ITSELF triggers an extension - so the only safe snipe is once extensions are exhausted (3.1). With a
  // real cap>=1 and zero extensions we therefore SUPPRESS the terminal snipe (never reveal the floor into
  // a window that would just extend). The G1 property "none before" holds; the terminal snipe does not.
  {
    const eng = mkEngine();
    const m = armSoft(eng);
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 1 }));
    assert.strictEqual(eng._effectivelyHard(m), false, 'cap 1, 0 extends -> not effectively hard');
    establish(eng, m);
    const last = m.ladder.length - 1;
    const inFinal = eng._decide(m, st(2_000, 2)); // final-window countdown, outranked, extensions remain
    assert.ok(!(inFinal && inFinal.rungIndex === last), 'floor snipe SUPPRESSED while extensions remain (would itself extend)');
    ok('T1b cap>=1 never-extended soft load suppresses the terminal floor snipe (fail-closed; design-note contradiction)');
  }

  // ---- T2. SINGLE EXTENSION MID-WINDOW (cap 1): defend before, floor snipe only in the final window ----
  {
    const eng = mkEngine();
    const m = armSoft(eng);
    establish(eng, m);
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 1 })); // surface cap, no jump
    assert.strictEqual(m.extendCap, 1, 'cap 1 surfaced');
    const last = m.ladder.length - 1;
    // pre-final window, outranked inside the trigger window -> a controlled DEFEND (step down), NO snipe
    const d1 = eng._decide(m, st(50_000, 2));
    assert.ok(d1 && d1.rungIndex > 0 && d1.rungIndex < last, 'pre-final: defends one rung, never the floor');
    applyDecision(m, d1);
    // the single extension arrives: absolute close jumps forward by the extend delta
    const counted = observeInWindow(eng, m, frame(m.believedCloseAt + 180_000, { extendCount: 1 }));
    assert.strictEqual(counted, true, 'forward jump counted as an extension');
    assert.strictEqual(m.extendsObserved, 1, 'extendsObserved = 1');
    assert.strictEqual(eng._effectivelyHard(m), true, 'extensions now exhausted -> effectively hard');
    const d2 = eng._decide(m, st(2_000, 2)); // now the genuinely-final window
    assert.ok(d2 && d2.rungIndex === last, 'floor snipe fires ONLY in the final (post-extension) window');
    ok('T2 single extension: defend before, no premature snipe, floor snipe only in the final window');
  }

  // ---- T3. THE RESERVE DISCIPLINE, and the ONE place it now yields (cap 2) ----
  //
  // What this case has always asserted, and still does: while a fireable rung remains ABOVE the floor,
  // the floor is not spent - the engine defends with the cheaper rung and keeps the decisive shot in
  // reserve. And it is never spent outside the final window at all.
  //
  // WHAT CHANGED, deliberately (2026-08-01). This case also used to assert that once the ladder above
  // the floor was EXHAUSTED, the floor stayed held anyway - on the reasoning that extensions remained,
  // so a better moment was still coming. That reasoning confuses CAPACITY with EXPECTATION.
  // extendsObserved < extendCap does not mean the auction will extend; an anti-snipe extension is
  // caused by a BID inside the trigger window, so a countdown that has run all the way down to 2s
  // means nobody has bid for the last 98 seconds of a 100-second window. The auction is ending.
  //
  // Holding there is a certain loss: we close outranked with a price we never sent. Firing there
  // cannot cost us anything we could have kept - our floor is cost-plus-minimum, so a rival who beats
  // it after an extension was always going to beat it, and we had nothing lower to answer with either
  // way. It is also the reported live symptom: loads "not bidding properly, only first being placed",
  // 15 of them across three customers closing with the floor unspent while armed and priced.
  //
  // The old T1b design note flagged this same tension and called it a "design-note contradiction". It
  // is resolved here in the direction that cannot forfeit a load outright.
  {
    const eng = mkEngine();
    const m = armSoft(eng);
    establish(eng, m);
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 2 }));
    const last = m.ladder.length - 1;

    // A rung above the floor is still available -> defend with THAT, floor stays reserved. Unchanged.
    const d1 = eng._decide(m, st(2_000, 2));
    assert.ok(d1 && d1.rungIndex > 0 && d1.rungIndex < last,
      'a defend rung above the floor was available and the engine did not use it');
    applyDecision(m, d1);

    observeInWindow(eng, m, frame(m.believedCloseAt + 180_000, { extendCount: 2 })); // extend #1
    assert.strictEqual(eng._effectivelyHard(m), false, 'after 1 of 2 extends: still soft');

    // OUTSIDE the final window with the ladder now exhausted: still no floor. The release is the last
    // tick only, so the reserve is genuinely held for everything but the buzzer.
    assert.strictEqual(eng._decide(m, st(50_000, 2)), null,
      'the floor was released outside the final window - the reserve must survive everywhere but the buzzer');

    // INSIDE the final window with nothing above the floor left: the floor is released rather than the
    // load forfeited. This is the deliberate change described above.
    const d2 = eng._decide(m, st(2_000, 2));
    assert.ok(d2 && d2.rungIndex === last,
      'the ladder above the floor was exhausted, we were outranked, and the countdown was at the buzzer - the engine '
      + 'held anyway and the load closes with our best price never sent. That is the reported live defect');
    applyDecision(m, d2);

    // ...and exactly ONCE. A released floor is not re-offered on every subsequent tick.
    assert.strictEqual(eng._decide(m, st(2_000, 2)), null, 'the decisive shot must be single');
    observeInWindow(eng, m, frame(m.believedCloseAt + 180_000, { extendCount: 2 })); // extend #2 -> cap reached
    assert.strictEqual(m.extendsObserved, 2, 'two extensions counted');
    assert.strictEqual(eng._effectivelyHard(m), true, 'cap reached -> effectively hard');
    assert.strictEqual(eng._decide(m, st(2_000, 2)), null,
      'the floor fired once already; reaching the cap must not license a second decisive shot');
    ok('T3 reserve held above the floor and outside the final window; released once at the buzzer when nothing else remained');
  }

  // ---- T4. EXTEND AT T-0: an extension at the last tick re-arms; finalize debounce holds (tick loop) ----
  {
    const f = tmp(); CLEAN.push(f);
    const events = [];
    // Anchor the close so the extended close is a genuine FORWARD jump past the original (a real T-0
    // extension bumps loadEndTime beyond the scheduled close, not to an earlier time).
    const armAt = Date.now();
    const origClose = armAt + 800;
    const ctrl = { closesInMs: 800, closesAtMs: origClose, extendMs: 400, extendCount: 2 };
    const adapter = {
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'soft' }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        return { ok: true, status: ctrl.closesInMs <= 0 ? 'closed' : 'live', myRank: 1, totalBidders: 2,
          standingL1Price: null, closesInMs: ctrl.closesInMs, closesAtMs: ctrl.closesAtMs, revisionLimit: 30,
          revisionsLeft: null, closeModel: 'soft', extendMs: ctrl.extendMs, extendCount: ctrl.extendCount,
          triggerWindowMs: 100_000, measuredRttMs: 50 };
      },
      placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
    };
    const eng = new BidEngine(adapter, new DurableScheduler(f),
      { config: { finalizeDebounceMs: 200, openAtMs: 15_000, floorWindowMs: 2_500 },
        softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
        onEvent: (e) => events.push(e) });
    eng.arm({ id: '1', lane: { origin: 'A', destination: 'B' }, units: 1, companyName: 'Havells', closesAt: origClose },
      { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
    await sleep(250);
    ctrl.closesInMs = 0; ctrl.closesAtMs = origClose; // countdown lapses AT the close (loadEndTime unchanged)
    await sleep(150);                                 // < 600 (extendMs 400 + base 200) -> debounce holds
    const m = eng.monitors.get('1');
    assert.strictEqual(m.finalized, false, 'transient zero did not finalize (debounce holds)');
    ctrl.closesInMs = 400; ctrl.closesAtMs = origClose + 400; // extension: loadEndTime jumps forward by the delta
    await sleep(300);
    assert.strictEqual(m.finalized, false, 'extension re-armed; still not finalized');
    assert.ok(m.extendsObserved >= 1, 'the T-0 extension was counted');
    eng.kill();
    ok('T4 extend at T-0: finalize debounce holds, engine re-arms into the extended window, extension counted');
  }

  // ---- T5. EXTEND BEYOND PLAUSIBILITY BOUND (socket, year-2100 class): REJECTED, belief unchanged ----
  {
    const logs = [];
    const sock = new SpSocket({ token: 't', carrierId: 2667, userId: 'u', onUpdate: () => {}, onLog: (m) => logs.push(m) });
    // first, a plausible extended close is accepted
    const good = new Date(Date.now() + 5 * 60_000).toISOString();
    sock._onBid({ loadId: 1, bids: [{ carrierId: 2667, rank: 1, isActive: 1, amount: 1000 }],
      fieldsToBeUpdated: { loadEndTime: good }, ackString: 'x' });
    const acceptedMs = sock.state(1).loadEndTimeMs;
    assert.ok(Number.isFinite(acceptedMs), 'plausible loadEndTime accepted');
    // then a year-2100-class close is REJECTED; the last plausible value is kept
    sock._onBid({ loadId: 1, bids: [{ carrierId: 2667, rank: 1, isActive: 1, amount: 1000 }],
      fieldsToBeUpdated: { loadEndTime: '2100-05-24T19:53:25.000Z' }, ackString: 'AuctionExtended' });
    assert.strictEqual(sock.state(1).loadEndTimeMs, acceptedMs, 'implausible loadEndTime rejected; belief unchanged');
    assert.ok(logs.some((l) => /implausible loadEndTime/i.test(l)), 'rejection alert emitted');
    ok('T5 socket rejects an implausible (>+/-30d) extended close and keeps the last plausible believed close');
  }

  // ---- T6. MISSED EXTEND EVENT: forward jump WITHOUT an ackString still counts; neither -> no count ----
  {
    // 6a socket: loadEndTime advances but NO AuctionExtended ackString -> countdown moves, extended latch stays off
    const sock = new SpSocket({ token: 't', carrierId: 2667, userId: 'u', onUpdate: () => {}, onLog: () => {} });
    const t1 = new Date(Date.now() + 60_000).toISOString();
    sock._onBid({ loadId: 9, bids: [], fieldsToBeUpdated: { loadEndTime: t1 }, ackString: '' });
    const t2 = new Date(Date.now() + 240_000).toISOString(); // +180s forward jump, still no ackString
    sock._onBid({ loadId: 9, bids: [], fieldsToBeUpdated: { loadEndTime: t2 }, ackString: '' });
    assert.strictEqual(sock.state(9).loadEndTimeMs, Date.parse(t2), 'loadEndTime advanced even without an ackString');

    // 6b engine: the forward jump alone counts the extension (D2 - authoritative close-time move)
    const eng = mkEngine();
    const m = armSoft(eng);
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 3, extendMs: 180_000 }));
    const counted = observeInWindow(eng, m, frame(m.believedCloseAt + 180_000, { extendCount: 3, extendMs: 180_000 }));
    assert.strictEqual(counted, true, 'forward jump counts as an extension with no ackString involved (T6)');
    assert.strictEqual(m.extendsObserved, 1, 'extension counted from the jump alone');

    // 6c neither arrives: no forward jump -> no phantom extension counted, believed close unchanged
    const before = m.believedCloseAt;
    const again = eng._observeExtension(m, frame(before, { extendCount: 3, extendMs: 180_000 }));
    assert.strictEqual(again, false, 'no forward jump -> no extension counted (fail-closed)');
    assert.strictEqual(m.believedCloseAt, before, 'believed close unchanged with no confirmation');
    ok('T6 missed extend: forward jump alone counts (ackString-independent); no jump -> no phantom, belief held');
  }

  // ---- T7. EXTEND AFTER FINALIZE: ignored (finalized is terminal), alert emitted, no re-arm ----
  {
    const events = [];
    const eng = mkEngine({ onEvent: (e) => events.push(e) });
    const m = armSoft(eng);
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 2 }));
    m.finalized = true; // the monitor has finalized
    const before = m.extendsObserved;
    const counted = eng._observeExtension(m, frame(m.believedCloseAt + 180_000, { extendCount: 2 }));
    assert.strictEqual(counted, false, 'an extension after finalize is IGNORED');
    assert.strictEqual(m.extendsObserved, before, 'extendsObserved unchanged after finalize');
    assert.ok(events.some((e) => e.kind === 'extend_after_finalize'), 'extend_after_finalize alert emitted');
    ok('T7 extend after finalize: ignored (finalized terminal), extend_after_finalize alert, no re-arm');
  }

  // ---- T8. CLOCK SKEW: every timing decision uses the server-corrected countdown, not local wall clock ----
  {
    const eng = mkEngine();
    const m = armSoft(eng);
    m.extendCap = 0; // effectively hard so the floor snipe is eligible
    establish(eng, m);
    const last = m.ladder.length - 1;
    // The engine's local Date.now() is irrelevant: the floor snipe keys off state.closesInMs (which the
    // adapter already computes off the socket server clock). A tiny corrected remaining fires the snipe;
    // a large corrected remaining does not - regardless of wall-clock time.
    const early = eng._decide(m, st(30_000, 2));
    assert.ok(!early || early.rungIndex !== last, 'large corrected remaining: no floor snipe');
    const snipe = eng._decide(m, st(1_500, 2));
    assert.ok(snipe && snipe.rungIndex === last, 'small corrected remaining: floor snipe fires (server-corrected timing)');
    ok('T8 clock skew: snipe timing follows the server-corrected closesInMs, never the local wall clock');
  }

  // ---- T9. REVISION EXHAUSTION UNDER REPEATED EXTENDS: reserve preserves the final snipe ----
  {
    // no-reset path: 3-revision customer, reserve 1 -> defends allowed only while revisionsLeft-1 > 0
    const eng = mkEngine({ reserve: 1 });
    const m = armSoft(eng, { revisionsLeft: 3 });
    eng._observeExtension(m, frame(m.believedCloseAt, { extendCount: 2 }));
    establish(eng, m);                        // revisionsLeft 3 -> 2
    const last = m.ladder.length - 1;
    const d1 = eng._decide(m, st(40_000, 2)); // defend: revisionsLeft 2 - reserve 1 > 0 -> allowed
    assert.ok(d1 && d1.rungIndex < last, 'defend #1 allowed with slack above reserve');
    applyDecision(m, d1);                      // revisionsLeft 2 -> 1
    const d2 = eng._decide(m, st(30_000, 2)); // revisionsLeft 1 - reserve 1 == 0 -> NO discretionary defend
    assert.strictEqual(d2, null, 'defend refused once only the reserve revision remains');
    assert.strictEqual(m.revisionsLeft, 1, 'exactly the reserved revision is preserved for the final snipe');
    // extensions exhaust -> the reserved final snipe still fires (revisionsLeft 1 > 0)
    observeInWindow(eng, m, frame(m.believedCloseAt + 180_000, { extendCount: 2 }));
    observeInWindow(eng, m, frame(m.believedCloseAt + 180_000, { extendCount: 2 }));
    assert.strictEqual(eng._effectivelyHard(m), true, 'cap reached');
    const snipe = eng._decide(m, st(2_000, 2));
    assert.ok(snipe && snipe.rungIndex === last, 'the reserved revision fires the final floor snipe');

    // reset variant: authoritative revisionsLeft climbs across an extension -> defends relax automatically
    const eng2 = mkEngine({ reserve: 1 });
    const m2 = armSoft(eng2, { revisionsLeft: 1 });
    eng2._observeExtension(m2, frame(m2.believedCloseAt, { extendCount: 2 }));
    establish(eng2, m2);
    assert.strictEqual(eng2._decide(m2, st(40_000, 2)), null, 'at the reserve floor, no defend (pre-reset)');
    m2.revisionsLeft = 3; // SP reset on extension (authoritative count read off the next state/bid response)
    const relaxed = eng2._decide(m2, st(40_000, 2));
    assert.ok(relaxed && relaxed.rungIndex < m2.ladder.length - 1, 'reset lifts revisionsLeft -> defends relax automatically');
    ok('T9 revision reserve preserves the final snipe (no-reset) and relaxes defends when a reset lifts the count');
  }

  // ---- T10. GOLDEN BYTE-IDENTITY: L3 is additive + gated off. Two proofs. ----
  {
    // (a) a HARD-close load runs the unchanged Module-1 schedule: establish only at the mark, hold L1,
    //     step down when outranked, floor snipe in the final window. The soft branch is never entered.
    const engHard = mkEngine();
    const mHard = armSoft(engHard);
    mHard.closeModel = 'hard';
    mHard.softStrategy = 'off';
    const lastH = mHard.ladder.length - 1;
    assert.strictEqual(engHard._decide(mHard, st(590_000, null)), null, 'hard: no establish far from close (waits for the mark)');
    const est = engHard._decide(mHard, st(24_000, null)); // <= establish mark (openAtMs 25000, jitter 0)
    assert.ok(est && est.rungIndex === 0, 'hard: establishes rung 0 at the establish mark'); applyDecision(mHard, est);
    assert.strictEqual(engHard._decide(mHard, st(10_000, 1)), null, 'hard: hold while L1');
    const snipeHard = engHard._decide(mHard, st(2_000, 2));
    assert.ok(snipeHard && snipeHard.rungIndex === lastH, 'hard: floor snipe fires in the final window (Module-1 unchanged)');

    // (b) the SAME soft load, soft-close DISABLED -> the final-window floor snipe FIRES (soft branch gated
    //     off). This is the exact opposite of T1b (soft enabled -> suppressed): the ONLY difference is the
    //     config gate, proving the endgame is byte-identical to Module-1 whenever soft-close is off.
    const engOff = mkEngine();
    engOff.setSoftClose({ enabled: false });
    const mOff = armSoft(engOff);
    assert.strictEqual(mOff.softStrategy, 'off', 'soft-close disabled -> strategy off');
    establish(engOff, mOff);
    const snipeOff = engOff._decide(mOff, st(2_000, 2));
    assert.ok(snipeOff && snipeOff.rungIndex === mOff.ladder.length - 1,
      'soft-DISABLED soft load: floor snipe FIRES in the final window (opposite of T1b - gate off = Module-1 endgame)');
    ok('T10 byte-identity: hard-close schedule unchanged; a soft-disabled load runs the Module-1 endgame (soft branch gated off)');
  }

  cleanup();
  console.log(`\n${pass}/11 checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
