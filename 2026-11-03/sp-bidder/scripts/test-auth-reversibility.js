'use strict';
/**
 * FULL BOOKKEEPING REVERSIBILITY for a write the auth wall refused.
 *
 * A 401/403 is refused at SuperProcure's edge BEFORE the request is processed, so the bid PROVABLY
 * did not commit. Everything the fire point spent optimistically therefore has to come back - and
 * "everything" is the load-bearing word. The previous shape restored four of the eight facts it
 * advanced, and the two most consequential omissions (ownBidAttempts, everBid) were invisible in
 * every test that only checked the ladder: _detectForeignBids reads ownBidAttempts to decide whether
 * a rank it sees could be ours, so an attempt that never reached the platform permanently stopped
 * that load being checked for desk or competitor activity - during exactly the window the desk alert
 * told a human to go and hand-quote it.
 *
 * THE SHAPE OF THIS FILE IS THE POINT. It does not enumerate the fields it expects to be restored,
 * because that is the same enumeration the implementation already makes and a test that repeats it
 * catches nothing. It DIFFS THE WHOLE MONITOR either side of a refused write and requires every
 * difference to be on a short, argued allow-list. A ninth fact added to the fire point without a
 * matching entry in _captureFirePriors therefore fails this file by construction, naming itself in
 * the failure message - which is the only mechanism that keeps a partial restore from shipping
 * invisibly a third time.
 *
 *   node scripts/test-auth-reversibility.js
 */
const assert = require('assert');
const H = require('./lib/auth-harness');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const EXPECTED_CHECKS = 9;
process.on('exit', () => {
  H.cleanup();
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

/**
 * A comparable snapshot of a monitor's whole state.
 *
 * Sets become sorted arrays and anything non-serialisable (timers, the engine backref) is dropped by
 * name rather than by type, so a new NON-serialisable field cannot silently slip past the diff -
 * it would show up as a difference under its own name and have to be argued about.
 */
const UNCOMPARABLE = new Set(['timer', 'closeTimer', 'engine', 'adapter', 'scheduler', 'log']);
function snap(monitor) {
  const out = {};
  for (const k of Object.keys(monitor)) {
    if (UNCOMPARABLE.has(k)) continue;
    const v = monitor[k];
    if (v instanceof Set) { out[k] = [...v].slice().sort(); continue; }
    if (Array.isArray(v)) { out[k] = v.slice(); continue; }
    if (v && typeof v === 'object') { out[k] = JSON.parse(JSON.stringify(v)); continue; }
    if (typeof v === 'function') continue;
    out[k] = v;
  }
  return out;
}

function diffKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const k of keys) {
    let same;
    try { assert.deepStrictEqual(after[k], before[k]); same = true; } catch (_) { same = false; }
    if (!same) changed.push(k);
  }
  return changed.sort();
}

/**
 * THE ALLOW-LIST, and every member is argued rather than merely observed.
 *
 * These are the facts a refused write is SUPPOSED to change - the marks that say the auth wall is
 * why this load is silent. Everything else the fire point touched must be indistinguishable from a
 * tick that never happened.
 */
const ALLOWED_TO_CHANGE = new Set([
  // The suppression flag and the recorded reason. These ARE the outcome of a refused write: they are
  // what makes the close-time receipt name the real cause and what gates the zero-bid alarm.
  'authBlockedLast',
  'noBid',
  // Set true at the fire point and cleared in the outcome path's own finally. It describes whether a
  // write is in flight right now, not anything the auction spent.
  'bidInProgress',
  // The anti-detection jitter fraction for this auction's establish mark. Rolled ONCE, lazily, by
  // _openAtMs during _decide - which runs before the fire point and independently of what the write
  // came back with. It is a property of the AUCTION, not of an attempt, so a refused write must not
  // re-roll it and equally must not roll it back: doing either would give this load a second, fresh
  // establish mark every time the auth wall refused a tick, which is the opposite of what jitter is
  // for. It is on this list because it is genuinely not part of what the fire point spends.
  '_openAtFrac',
  // The desk-notice record - { episode, state } where state is held / standing / clear, and the debt
  // that the retraction discharges. DELIVERY state, not fire state, which is why it is exempt rather
  // than captured: it records which message about this outage has already gone to the desk, and
  // restoring it would re-send that message on every refused tick for the life of the outage - and
  // then, because the record is also what makes the engine owe an all-clear, silently drop the
  // retraction with it. It is written under a STRICTLY NARROWER condition than 'authBlockedLast' and
  // 'noBid' - only when a message actually leaves, so not on the grace band and not before the
  // adapter has an outage identity - which is the whole reason it is delivery state rather than fire
  // state. R8 in this file exercises exactly that gap: 120 grace-band ticks set the other two and
  // never this one. The invariant this file guards - a refused write consumes no ladder, rung,
  // revision or budget - is untouched.
  '_authNotice',
]);

(async () => {
  // ==============================================================================================
  // R1. THE INVARIANT: a refused write leaves the monitor indistinguishable from a tick that never
  //     happened, except for the auth marks. Diffed wholesale.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    H.program(eng, ['401']);

    const before = snap(m);
    await eng._maybeBid(m, H.state(50_000, 2));
    const after = snap(m);

    const changed = diffKeys(before, after);
    const illegal = changed.filter((k) => !ALLOWED_TO_CHANGE.has(k));
    assert.deepStrictEqual(illegal, [],
      'a write the auth wall refused must leave NOTHING else on the monitor changed, and these '
      + `fields changed anyway: ${illegal.join(', ')} - either the fire point advanced something `
      + '_captureFirePriors does not carry, or _undoAuthRefusedFire does not give it back');

    // ...and the marks it IS allowed to set really were set, so the check above cannot pass by the
    // write never having happened at all.
    assert.strictEqual(m.authBlockedLast, true, 'the auth mark is set');
    assert.ok(m.noBid && m.noBid.reason === 'session_logged_out', 'and the cause is recorded');
    ok('a refused write leaves the monitor byte-identical apart from the auth marks it is meant to set');
  }

  // ==============================================================================================
  // R1b. THE SAME INVARIANT WITH THE DESK NOTICE ACTUALLY IN PLAY. R1's adapter exposes no episode
  //      accessors, so _alertAuthBlocked returns before writing anything and its field never enters
  //      the diff at all - which means the allow-list entry for it is inert there and a wrong name on
  //      it passes unnoticed. In production a write is refused by a LATCHED adapter, which always has
  //      an episode, so the notice record is written on exactly this path.
  //
  //      isAuthDead is deliberately left off: with it the account gate returns above the fire point
  //      and there is no refused write left to diff. What is wanted here is the fire point running
  //      in full and coming back 401, with an outage identity available to key the notice on.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    H.program(eng, ['401']);
    const episode = Date.now() - 60_000;
    Object.assign(eng.adapter, { authDeadSince: () => episode, authEpisodeSince: () => episode });

    const before = snap(m);
    await eng._maybeBid(m, H.state(50_000, 2));
    const after = snap(m);

    const changed = diffKeys(before, after);
    assert.ok(changed.includes('_authNotice'),
      'precondition: the refused write really did write the desk-notice record, so the allow-list '
      + 'entry for it is being exercised rather than assumed');
    assert.deepStrictEqual(m._authNotice, { episode, state: 'held' },
      'and it names the episode it spoke under, which is what the retraction is later keyed on');
    const illegal = changed.filter((k) => !ALLOWED_TO_CHANGE.has(k));
    assert.deepStrictEqual(illegal, [],
      `a refused write that also notified the desk still changes nothing else; these differ: ${illegal.join(', ')}`);
    ok('the desk-notice record is the only extra thing a notifying refused write leaves behind');
  }

  // ==============================================================================================
  // R2. THE SAME INVARIANT ON THE THROW PATH. placeBid RETURNS auth rejections in normal operation,
  //     but ensureSession still THROWS code AUTH, and the sentinel at the head of the
  //     uncertain-outcome handler is the second call site. Two sites that must never drift, so both
  //     are diffed identically rather than one being taken on trust.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    H.program(eng, ['throw-auth']);

    const before = snap(m);
    await eng._maybeBid(m, H.state(50_000, 2));
    const after = snap(m);

    const illegal = diffKeys(before, after).filter((k) => !ALLOWED_TO_CHANGE.has(k));
    assert.deepStrictEqual(illegal, [],
      `the AUTH-throw path must restore exactly as much as the rejection path; these differ: ${illegal.join(', ')}`);
    assert.strictEqual(m.authBlockedLast, true, 'and it too sets the auth mark');
    ok('the AUTH-throw sentinel restores exactly what the AUTH-rejection arm does - the two cannot drift');
  }

  // ==============================================================================================
  // R3. THE TWO OMISSIONS, NAMED. The wholesale diff above would catch these, but it would report
  //     them as a list of key names; this states what each one COSTS, so a future reader deciding
  //     whether to "simplify" the restore has the consequence in front of them.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    H.program(eng, ['401']);

    assert.strictEqual(m.ownBidAttempts, 0, 'a freshly armed load has used the wire zero times');
    assert.strictEqual(m.everBid, false, 'and has never bid');
    await eng._maybeBid(m, H.state(50_000, 2));

    assert.strictEqual(m.ownBidAttempts, 0,
      'ownBidAttempts is given back: _detectForeignBids reads it to decide whether a rank it sees '
      + 'could be ours, so an attempt that never reached SuperProcure would permanently stop this '
      + 'load being checked for desk or competitor activity - during the exact window the alert '
      + 'tells a human to go and hand-quote it');
    assert.strictEqual(m.everBid, false,
      'and everBid with it - the same fact in the form that survives a re-price');
    assert.strictEqual(m.bidTimes.length, 0,
      'the runaway-cap slot is refunded too, so the decisive floor shot keeps its own reserve');
    assert.strictEqual(m.lastFireAt, 0,
      'and the inter-fire cadence slot, so a write that never left the box does not cost the load a tick');
    ok('the two previously-missed facts are restored, and so are the cadence and cap slots');
  }

  // ==============================================================================================
  // R4. THE DECISIVE SNIPE SURVIVES. This is the money case and the reason the restore exists at all:
  //     the endgame latches are advanced OPTIMISTICALLY before the await, so a 401 landing on the
  //     decisive shot consumed it against a request that never reached the platform - leaving a
  //     pristine ladder, a load that looks perfectly healthy, and a lost auction.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1); m.lastBidPrice = 9_700;
    m.extendsObserved = 2;                      // a new round of competition, so the buzzer shot is live
    H.program(eng, ['401', 'ok']);

    // THE CHECK MUST NOT BE ABLE TO PASS VACUOUSLY. Asserting "the latch is still at its prior value"
    // proves nothing if the tick never advanced it in the first place, so the undo is instrumented:
    // this captures the monitor AT THE MOMENT the restore is entered, which is after the optimistic
    // advance and before it is given back. An earlier draft of this check asserted a snipe latch on a
    // state that produces a DEFEND decision, and would have passed against a completely broken undo.
    const atUndo = {};
    const realUndo = eng._undoAuthRefusedFire.bind(eng);
    eng._undoAuthRefusedFire = (monitor, priors) => {
      atUndo.shotRoundId = monitor._shotRoundId;
      atUndo.ownBidAttempts = monitor.ownBidAttempts;
      atUndo.bidTimes = monitor.bidTimes.length;
      return realUndo(monitor, priors);
    };

    await eng._maybeBid(m, H.state(1_200, 2));
    // named re-pin: round tracker, ruling 56 - the latch holds the round's roundId, not its close.
    const thisRound = eng.roundVerdict(m).roundId;

    // Reversed 2026-09-24: 1,200ms is the buzzer of a round before the cap, where the shot is the one
    // next-middle-price buzzer shot rather than the round's defend, so that is the latch advanced. It
    // holds the round's roundId (ruling 56).
    assert.ok(atUndo.shotRoundId === thisRound,
      'PRECONDITION: the fire point really did advance the endgame latch optimistically before the '
      + 'await - without this the restore assertion below would be vacuous (reversed 2026-09-24 from the '
      + 'defend latch: outranked at a pre-cap buzzer the shot is the next middle price, once per buzzer)');
    assert.strictEqual(atUndo.ownBidAttempts, 1, 'and really did count the attempt');
    assert.strictEqual(atUndo.bidTimes, 1, 'and really did take a runaway-cap slot');

    assert.strictEqual(m._shotRoundId, null,
      'THE LOST ROUND: a 401 does not consume the once-per-buzzer shot - the shot is still available '
      + 'at the rung the auction actually deserves, because the request never reached the platform');
    assert.strictEqual(m.currentRungIndex, 1, 'the ladder position is exactly where _decide would have found it');
    assert.deepStrictEqual([...m.firedRungs].sort(), [0, 1], 'and the fired set is unchanged');
    assert.strictEqual(m.revisionsLeft, 30,
      'while the per-load budget is deliberately untouched - the fire point never spends one, and '
      + '"restoring" it here would hand a later re-price a phantom');

    // ...and the very next tick, with the session back, actually takes the shot it was denied.
    await eng._maybeBid(m, H.state(1_200, 2));
    assert.strictEqual(m._shotRoundId, thisRound,
      'so the next tick after recovery still gets to fire this round\'s buzzer shot');
    assert.strictEqual(m.landedBids, 1, 'and the bid genuinely lands rather than being swallowed');
    ok('a 401 on the decisive shot leaves it available rather than silently spending it');
  }

  // ==============================================================================================
  // R5. THE firedRungs SET KEEPS ITS IDENTITY. selectRung is handed this Set BY REFERENCE and the
  //     pricing path mutates it, so restoring by assigning a fresh Set would silently detach the
  //     engine's own view of the ladder. Restored by membership into the same object, and asserted
  //     as an identity rather than as a value.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    m.currentRungIndex = 0; m.firedRungs.add(0);
    const setIdentity = m.firedRungs;
    H.program(eng, ['401']);

    await eng._maybeBid(m, H.state(50_000, 2));
    assert.strictEqual(m.firedRungs, setIdentity,
      'the SAME Set object survives the restore - a fresh one would detach selectRung\'s view of it');
    assert.deepStrictEqual([...m.firedRungs], [0], 'with its membership restored into it');
    ok('firedRungs is restored by membership into the same object, never replaced');
  }

  // ==============================================================================================
  // R6. THE COMPOSITION THAT MAKES THE SUPPRESSION WORK AT ALL.
  //
  //     Full reversibility and the unified attribution predicate look like two independent repairs.
  //     They are not - they only work TOGETHER, and getting that wrong would silently undo the whole
  //     point of the change. The predicate refuses to blame the outage for a load with real wire
  //     history (ownBidAttempts > 0), because such a load owns a better explanation of its own
  //     silence. The 2026-08-04 loads had up to 88 attempts each. Read naively, the predicate would
  //     therefore decline to suppress exactly the 41 loads the whole exercise exists to silence, and
  //     the 56-message flood would come straight back.
  //
  //     It does not, and the reason is the restore: every one of those attempts was AUTH-refused, so
  //     every one of them is given back, and the load arrives at close with ownBidAttempts 0 and the
  //     auth mark set from DIRECT per-load evidence. A load that took a genuine non-auth refusal keeps
  //     its attempt and keeps its alarm. That distinction is the correct one and it is invisible
  //     unless both mechanisms are right, so it is asserted here rather than reasoned about.
  // ==============================================================================================
  {
    // (a) the incident shape: every attempt auth-refused -> suppressed
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    H.program(eng, ['401']);
    Object.assign(eng.adapter, { isAuthDead: () => true, authWriteHeld: () => false,
      authDeadSince: () => Date.now() - 60_000, authEpisodeSince: () => Date.now() - 60_000 });

    for (let i = 0; i < 88; i++) await eng._maybeBid(m, H.state(50_000, 2));
    assert.strictEqual(m.ownBidAttempts, 0,
      '88 auth-refused attempts leave ownBidAttempts at zero, because not one of them reached SuperProcure');
    assert.strictEqual(m.authBlockedLast, true, 'and the load is marked from its own direct evidence');
    await eng._finalize(m, H.state(0, null));
    assert.strictEqual(H.alertsOfKind(eng, 'never_bid_before_close').length, 0,
      'THE COMPOSITION: the 2026-08-04 load is still suppressed - the restore is what makes the '
      + 'attribution predicate reach it, and without the restore the 56-message flood returns');

    // (b) a load with real wire history that is HELD and never itself auth-refused -> still alarms.
    //
    //     This is the distinction the unified predicate actually draws, and it is finer than "does
    //     the load have wire history". A load whose OWN write came back 401 has DIRECT evidence and
    //     is marked regardless of history - the auth wall genuinely is the most recent thing that
    //     happened to its bidding, and case (a) above depends on that. A load that never reaches the
    //     wire during the outage has only the account-wide INFERENCE, and inference must yield to the
    //     load's own history: it tried, SuperProcure refused it on price, and that is a real failure
    //     the desk needs to hear about rather than have folded into an outage it was not part of.
    //
    //     Holding is also the common case, not the exotic one: while an account is latched the trial
    //     is spent for all but one write per interval, so most loads take this path.
    const eng2 = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m2 = H.armFine(eng2, [10_000, 9_700, 9_400, 9_100, 8_000]);
    const box2 = H.program(eng2, ['reject-other']);
    await eng2._maybeBid(m2, H.state(50_000, 2));           // a real HTTP 400, on a healthy account
    assert.strictEqual(box2.calls, 1, 'the load really did reach SuperProcure once');
    assert.ok(m2.ownBidAttempts > 0, 'and a genuine non-auth attempt is NOT given back - it happened');

    Object.assign(eng2.adapter, { isAuthDead: () => true, authWriteHeld: () => true,
      authDeadSince: () => Date.now() - 60_000, authEpisodeSince: () => Date.now() - 60_000 });
    for (let i = 0; i < 20; i++) await eng2._maybeBid(m2, H.state(50_000, 2));
    assert.strictEqual(box2.calls, 1, 'and is held for the rest of the outage, never reaching the wire again');
    assert.strictEqual(m2.authBlockedLast, false,
      'so it is never marked: it has no direct evidence, and the account-wide inference yields to its history');
    assert.ok(!m2.noBid, 'and its receipt does not blame the outage');

    await eng2._finalize(m2, H.state(0, null));
    assert.strictEqual(H.alertsOfKind(eng2, 'never_bid_before_close').length, 1,
      'THE DECOUPLING, END TO END: it still alarms, so the flag and the receipt agree about this load '
      + 'instead of one saying the outage explains it and the other saying it does not');
    ok('the restore and the attribution predicate compose: the incident is suppressed, a held real refusal is not');
  }

  // ==============================================================================================
  // R7. EVERY CAPTURED FACT IS ACTUALLY WRITTEN BACK - each one perturbed ALONE, and repaired.
  //
  //     R1's wholesale diff proves the pair is correct as a PAIR: it drives one real refusal and
  //     requires the monitor to come out unchanged. What it structurally cannot see is a fact that is
  //     captured faithfully and then never restored, IF the fire point happens not to move that fact
  //     on the path R1 drives (a snipe latch on a defend decision, a rung the ladder did not reach).
  //     Those are exactly the omissions that shipped twice: invisible because the scenario never
  //     advanced them, not because the undo was inspected and approved.
  //
  //     So this drives the capture/restore pair DIRECTLY. Each declared fact is perturbed on its own,
  //     the perturbation is asserted to have genuinely changed the captured state (so a no-op
  //     perturbation cannot make this check pass vacuously), and the restore must repair it. A ninth
  //     fact added to _captureFirePriors with no matching line in _undoAuthRefusedFire fails here by
  //     name - and so does one added with no perturbation registered for it, which is what stops this
  //     check from silently shrinking as the set grows.
  // ==============================================================================================
  {
    const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 });
    const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
    // A NON-DEFAULT starting value for every fact, so a restore that writes a constant, writes
    // `undefined`, or simply re-runs the capture cannot pass by coincidence.
    m.currentRungIndex = 1; m.firedRungs.add(0); m.firedRungs.add(1);
    m.snipeFired = true; m._lastDefendAtExtend = 2; m._shotRoundId = '1800000000000:2:0'; // named re-pin: round tracker, ruling 56
    m.ownBidAttempts = 3; m.everBid = true;
    m.bidTimes = [111, 222]; m.lastFireAt = 4_242;
    m._walkOfferedMin = 9_700; m._walkLimitSent = 9_650; // the T9 walk's fire latches (engine review B1)

    const snap = eng._captureFirePriors(m);
    // Perturbations are written in the DIRECTION the fire point actually moves each fact - a rung
    // added, a counter incremented, a slot taken - so a restore that only handles the real shape is
    // not credited for handling a shape that cannot occur.
    const perturb = {
      firedRungs: () => { m.firedRungs.add(4); },
      currentRungIndex: () => { m.currentRungIndex = 99; },
      snipeFired: () => { m.snipeFired = false; },
      lastDefendAtExtend: () => { m._lastDefendAtExtend = 77; },
      shotRoundId: () => { m._shotRoundId = '1800000000000:3:1'; },
      lastFireAt: () => { m.lastFireAt = 99_999; },
      bidTimesLength: () => { m.bidTimes.push(333); },
      ownBidAttempts: () => { m.ownBidAttempts = 42; },
      everBid: () => { m.everBid = false; },
      walkOfferedMin: () => { m._walkOfferedMin = 9_400; },
      walkLimitSent: () => { m._walkLimitSent = 9_500; },
    };
    const declared = Object.keys(snap);
    assert.ok(declared.length >= 8,
      `the capture still describes the whole fire-point surface (${declared.length} facts)`);
    for (const key of declared) {
      assert.ok(perturb[key],
        `every captured fact has a perturbation here - '${key}' was added to _captureFirePriors `
        + 'without one, so nothing in this file proves the restore writes it back');
      perturb[key]();
      assert.notDeepStrictEqual(eng._captureFirePriors(m), snap,
        `PRECONDITION: perturbing '${key}' really changed the captured state - a no-op perturbation `
        + 'would make the repair assertion below vacuous');
      eng._undoAuthRefusedFire(m, snap);
      assert.deepStrictEqual(eng._captureFirePriors(m), snap,
        `_undoAuthRefusedFire repairs '${key}' - it is captured but never written back`);
    }
    assert.ok(declared.includes('ownBidAttempts') && declared.includes('everBid'),
      'and the set still names the two facts whose omission disabled the shared-cap foreign-bid guard');
    ok('every captured fact is written back by the restore - each one perturbed alone and repaired');
  }

  // ==============================================================================================
  // R8. THE ONE FACT THE UNDO MAY NOT GIVE BACK, AND WHY THE OTHER SEVEN STILL COME BACK.
  //
  //     Every check above asserts a TOTAL undo, and every one of them is about a genuine account-wide
  //     refusal - the account leaves CLEAR, so the account gate at the top of _maybeBid holds the
  //     load's next tick and the retry stops of its own accord. Under that gate, handing back the
  //     throttle bookkeeping costs nothing and buys the money case (R4).
  //
  //     The token_expiring GRACE BAND is the one auth refusal with no such gate. It refuses the write
  //     while deliberately leaving the account CLEAR - counting it would seal the account off two
  //     ordinary attempts inside a token's own final minute, a confirmed defect in the other
  //     direction - so every 200ms hot tick reaches the fire point, and a total undo rolls back its
  //     OWN throttle every cycle. lastFireAt and the bidTimes slot are not bookkeeping here; between
  //     them they ARE the per-load write throttle, and giving them back is a self-inflicted retry
  //     storm for the whole duration of the band: hundreds of refused attempts per armed load per
  //     token rollover, each a synchronous JSONL append on the snipe-timing-critical path.
  //
  //     Driven on PRODUCTION constants - minInterFireMs 150, maxBidsPerMin 20, a 200ms hot tick -
  //     because the shared harness pins minInterFireMs to 0, which is exactly why the suite as
  //     written could not see this.
  // ==============================================================================================
  {
    // (a) THE STUB IS FAITHFUL. The engine half below drives a programmable adapter, so first pin
    //     that the REAL adapter in a real grace band actually reports what that stub reports - and
    //     that it produces this exact refusal without a byte reaching the wire.
    H.freezeClock();
    try {
      const t = H.transport();
      const a = H.mkAdapter(t.impl, { tokenLifeMs: 30_000 });   // inside the 60s grace band
      assert.strictEqual(a.authTokenGrace(), true, 'PRECONDITION: the token really is in its grace band');
      assert.strictEqual(a.isAuthDead(), false,
        'and the account is still CLEAR - which is the whole problem: no account-wide gate engages');
      const res = await H.bid(a);
      assert.strictEqual(res.accepted, false, 'the write is refused...');
      assert.strictEqual(res.reason, 'session_logged_out', '...as an auth rejection...');
      assert.strictEqual(t.calls.bid.length, 0, '...without reaching SuperProcure at all');
      a.discard();
    } finally { H.realClock(); }

    const TICKS = 120;
    const TICK_MS = 200;                                   // the engine's real hot cadence
    const CFG = { minInterFireMs: 150, maxBidsPerMin: 20 }; // src/config.js defaults, verbatim

    /** Drive TICKS refused ticks against an adapter that does/does not report the grace band. */
    const run = async (graceBand) => {
      H.freezeClock();
      try {
        const eng = H.mkEngine({ enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 }, CFG);
        const m = H.armFine(eng, [10_000, 9_700, 9_400, 9_100, 8_000]);
        const box = H.program(eng, ['401']);
        Object.assign(eng.adapter, { isAuthDead: () => false, authWriteHeld: () => false,
          authTokenGrace: () => graceBand });
        for (let i = 0; i < TICKS; i++) {
          await eng._maybeBid(m, H.state(50_000, 2));
          H.advance(TICK_MS);
        }
        return { calls: box.calls, monitor: m };
      } finally { H.realClock(); }
    };

    // (b) THE CONTROL, which is the defect itself. Same 120 ticks, same everything, except the
    //     adapter does not report the band - so the undo is total and nothing throttles anything.
    //     Without this the assertion below could pass against a load that simply never fired.
    const unthrottled = await run(false);
    assert.strictEqual(unthrottled.calls, TICKS,
      `PRECONDITION: a total undo fires on EVERY one of the ${TICKS} ticks - the throttle is rolled `
      + 'back as fast as it is spent, so neither minInterFireMs nor the runaway cap can ever bite');
    assert.strictEqual(unthrottled.monitor.lastFireAt, 0, 'ending with the cadence slot never spent');
    assert.strictEqual(unthrottled.monitor.bidTimes.length, 0, 'and the runaway cap at zero');

    // (c) THE FIX. The grace band leaves the two throttle facts SPENT, so the load is bounded by the
    //     same guards that bound every other kind of repeated attempt.
    const throttled = await run(true);
    assert.ok(throttled.calls <= CFG.maxBidsPerMin,
      `the runaway cap now actually bounds the band: ${throttled.calls} attempts over ${TICKS} ticks, `
      + `never more than maxBidsPerMin (${CFG.maxBidsPerMin})`);
    assert.ok(throttled.calls * 4 < TICKS,
      `and by a wide margin rather than a token one (${throttled.calls} of ${TICKS})`);
    assert.ok(throttled.monitor.bidTimes.length > 0,
      'because the refused attempts are left counted against the cap...');
    assert.ok(throttled.monitor.lastFireAt > 0, '...and the cadence slot is left spent');

    // (d) ...AND NOTHING ELSE CHANGED. The money case (R4) and the foreign-bid guard (R3, R6) depend
    //     on the other six facts still coming back on THIS path too - the exclusion is two fields
    //     wide, not a licence to stop restoring.
    assert.strictEqual(throttled.monitor.ownBidAttempts, 0,
      'the attempt facts still come back on the grace path - not one of those writes reached '
      + 'SuperProcure, so _detectForeignBids must still be able to read this load');
    assert.strictEqual(throttled.monitor.everBid, false, 'and everBid with it');
    assert.strictEqual(throttled.monitor.currentRungIndex, -1,
      'and the ladder is exactly where _decide would have found it, so the establish branch stays open');
    assert.deepStrictEqual([...throttled.monitor.firedRungs], [], 'with no rung spent');
    ok('the token_expiring grace band keeps its write throttle, while everything else is still restored');
  }

  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
