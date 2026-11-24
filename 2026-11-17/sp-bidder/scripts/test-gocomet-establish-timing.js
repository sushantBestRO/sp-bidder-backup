'use strict';
/**
 * SOFT-CLOSE ESTABLISH TIMING - the regression suite for CW-209.
 *
 * The defect: _decide's soft-close establish branch had no remaining-time test. It returned rung 0
 * on the first tick at ANY remaining, so a load whose closeModel is 'soft' and whose shipper is not
 * on the soft-close allowlist put its opening price on the board the moment a rate was entered.
 * Every GoComet load is exactly that shape - gocometAdapter declares closeModel 'soft' as a static
 * capability and no GoComet shipper has ever been allowlisted - so it fired on 100% of them:
 * 376 of 504 bid more than an hour before close, against 1,229 of 1,238 SuperProcure hard-close
 * loads bidding in the final minute.
 *
 * Because nothing downstream can run before the establish (the clock-scheduled step-down needs a
 * currentRungIndex, the snipe needs the final window), gating the establish holds the WHOLE walk.
 * That is what these cases assert - not just "the first bid is later".
 *
 * The two paths this must NOT move are asserted by CONSTRUCTION rather than by eyeball: the same
 * scripted walk is run on two engines whose softOpenAtMs differ by four orders of magnitude, and the
 * decision sequences must be identical. A knob that cannot change the output cannot regress it.
 *
 * Drives _decide directly with scripted states - no timers, no network, no wall-clock waits - the
 * same reach-into-internals style as test-softclose-decisive-shot-timing.js.
 *
 *   node scripts/test-gocomet-establish-timing.js
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
let seq = 0;
const tmp = () => path.join(os.tmpdir(), `gc-est-${process.pid}-${seq++}.json`);
const CLEAN = [];
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };
const FAILURES = [];

// Completion sentinel, registered before any case runs so it fires on every path out of the
// process - the runner grades by exit code alone, and an early return would otherwise exit 0 as a
// silent zero-assertion green. Same shape as test-softclose-decisive-shot-timing.js.
const EXPECTED_CASES = 26;
process.on('exit', (code) => {
  cleanup();
  const bad = [];
  if (ran !== EXPECTED_CASES) bad.push(`only ${ran} of ${EXPECTED_CASES} cases ran - this file exited early`);
  if (pass !== EXPECTED_CASES) bad.push(`${EXPECTED_CASES - pass} of ${EXPECTED_CASES} cases failed`);
  if (!bad.length) {
    if (code === 0) console.log(`\ngocomet establish timing: ${pass}/${EXPECTED_CASES} cases passed`);
    return;
  }
  console.error(`\nCOMPLETION SENTINEL FAILED: ${bad.join('; ')}`);
  for (const f of FAILURES) console.error(`  - ${f.name}\n      ${f.message}`);
  process.exitCode = 1;
});

// Production values from config.js, so a case that passes here is a case that passes on the box.
const OPEN_AT_MS = 25_000;
const SOFT_OPEN_AT_MS = 150_000;
const SOFT_OPEN_JITTER_MS = 15_000;
// The non-allowlisted establish floor's own lead over a published anti-snipe window. NOT
// softCfg.establishLeadMs - that knob belongs to the allowlisted soft-close endgame and is asserted
// not to reach this path. Same number, deliberately, so nothing moved at shipped settings.
const NON_ALLOWLISTED_LEAD_MS = 40_000;
const HOUR_MS = 3_600_000;
// GoComet's own published legitimate read gap: max(rateLimitBackoffMs 60s, maxRateLimitBackoffMs
// 120s) + minGetIntervalMs 5s. Through a cooldown every GET returns ok:false and the engine cannot
// decide at all, so the establish window has to be wider than this or one routine rate-limit
// response closes an armed load with nothing on the board.
const GOCOMET_LIVENESS_GAP_MS = 125_000;

/**
 * A GoComet-shaped engine: rank-only board, revisionLimit 3, and a static soft close model. The
 * soft-close allowlist is deliberately left empty, which is the live configuration - that is the
 * whole reason every GoComet load ran the non-allowlisted branch.
 */
function mkEngine({ rand = null, softOpenAtMs = SOFT_OPEN_AT_MS, softOpenJitterMs = SOFT_OPEN_JITTER_MS,
  shippers = [], softEnabled = false, revisionLimit = 3 } = {}) {
  const f = tmp(); CLEAN.push(f);
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('placeBid must not be reached in these decision tests'); },
  };
  const opts = {
    config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, rungs: 6, softOpenAtMs, softOpenJitterMs },
    softClose: { enabled: softEnabled, shippers, mode: 'live' },
    onEvent: () => {},
  };
  if (rand) opts.rand = rand;
  return new BidEngine(adapter, new DurableScheduler(f), opts);
}

// Waaree is the only shipper on the live GoComet board, and it is not on the soft-close allowlist.
function armLoad(eng, { companyName = 'Waaree', closeModel = 'soft', triggerWindowMs = null,
  extendCap = null, revisionsLeft = 3 } = {}) {
  const meta = { id: String(++seq), lane: { origin: 'Degam', destination: 'Vadodara' }, units: 1,
    companyName, closesAt: Date.now() + HOUR_MS };
  const m = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = closeModel;
  m.triggerWindowMs = triggerWindowMs;
  m.extendCap = extendCap;
  m.extendsObserved = 0;
  m.revisionsLeft = revisionsLeft;
  return m;
}

const st = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 1000, standingL1Price: null });

// Advance monitor state exactly as an accepted bid would, so a driven sequence progresses the same
// way the live fire point does.
function applyDecision(m, d) {
  if (!d) return;
  m.lastBidPrice = d.price;
  if (d.rungIndex != null) { m.currentRungIndex = Math.max(m.currentRungIndex, d.rungIndex); m.firedRungs.add(d.rungIndex); }
  if (m.revisionsLeft != null) m.revisionsLeft -= 1;
  if (d.snipe) m.snipeFired = true;
  if (d.defend) m._lastDefendAtExtend = m.extendsObserved;
}

/**
 * Walk the countdown at the cadence the engine ITSELF would have scheduled. A fixed fine-grained
 * sweep would offer decision points production never offers - above 60s to close the poll is ~30
 * seconds apart - so any claim about WHERE a bid lands has to be made against this walk.
 */
function sweepCadence(eng, m, { from, to = 0, rank, maxTicks = 20_000 }) {
  const shots = [];
  let r = from;
  let ticks = 0;
  while (r >= to && ticks++ < maxTicks) {
    const k = typeof rank === 'function' ? rank(m, r) : rank;
    const d = eng._decide(m, st(r, k));
    if (d) { shots.push({ rungIndex: d.rungIndex, price: d.price, remaining: r, snipe: !!d.snipe }); applyDecision(m, d); }
    r -= Math.max(1, eng._cadence(r, m));
  }
  return shots;
}

function run(name, fn) {
  ran++;
  try { fn(); ok(name); } catch (e) {
    FAILURES.push({ name, message: e && e.message });
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
}

console.log('\nsoft-close establish timing (CW-209)\n');

// ---------------------------------------------------------------------------------------------
// 1-4. The defect itself.
// ---------------------------------------------------------------------------------------------

run('an hour out, a non-allowlisted soft load does NOT establish', () => {
  const eng = mkEngine({ rand: () => 0.5 });
  const m = armLoad(eng);
  const d = eng._decide(m, st(HOUR_MS, null));
  assert.strictEqual(d, null,
    `establishing ${HOUR_MS}ms before close is the CW-209 defect - the opening price goes on the board on rate entry`);
  assert.strictEqual(m.currentRungIndex, -1, 'the monitor must still be unestablished after the hold');
});

run('the 222s countdown from live load 260907C2I8 does NOT establish', () => {
  // The forensic record's live proof: [price-req] captured at 14:09:16.661Z, establish logged at
  // 14:09:17.825Z with remainingMs 222000 - 1.2 seconds after the rate was entered.
  const eng = mkEngine({ rand: () => 0.5 });
  const m = armLoad(eng);
  assert.strictEqual(eng._decide(m, st(222_000, null)), null,
    '222,000ms out is 3.7 minutes of exposure on an extending auction');
});

run('it establishes once inside the closing window, at rung 0', () => {
  const eng = mkEngine({ rand: () => 0 }); // jitter fraction 0 -> the mark is exactly softOpenAtMs
  const m = armLoad(eng);
  assert.strictEqual(eng._decide(m, st(SOFT_OPEN_AT_MS + 1, null)), null, 'one ms outside the mark must hold');
  const d = eng._decide(m, st(SOFT_OPEN_AT_MS, null));
  assert.ok(d, 'at the mark it must establish');
  assert.strictEqual(d.rungIndex, 0, 'the establish is still the opening rung, unchanged');
  assert.strictEqual(d.price, m.ladder[0]);
});

run('the whole ladder walk is held, not just the first bid', () => {
  // The step-down and the snipe both sit downstream of the establish, so holding it holds them too.
  // Outranked on every tick, which is the case that walks the ladder fastest.
  const eng = mkEngine();
  const m = armLoad(eng);
  const shots = sweepCadence(eng, m, { from: HOUR_MS, rank: 4 });
  assert.ok(shots.length > 0, 'the load must still bid - a hold that never releases is a forfeit');
  const earliest = Math.max(...shots.map((s) => s.remaining));
  assert.ok(earliest <= SOFT_OPEN_AT_MS + SOFT_OPEN_JITTER_MS,
    `every bid must land inside the closing window; earliest landed at ${earliest}ms remaining`);
});

run('the establish lands AT the mark, not wherever the poll happens to fall', () => {
  // TWO-SIDED on purpose. A one-sided `earliest <= mark` bound passes even when the establish is
  // landing far below the mark, which is exactly what happened before _cadence learned to approach
  // it: _decisiveBandFor returns null for a soft-off load, so the far bucket strode 30,000ms up to
  // farThresholdMs and the crossing tick landed anywhere in (~30s, 60s] no matter what the mark was.
  // Raising the knob changed nothing at the bottom of that spread, which is the shape of a knob
  // that does not work.
  const eng = mkEngine();
  const leads = [];
  for (let i = 0; i < 60; i++) {
    const m = armLoad(eng);
    const mark = eng._softEstablishThreshold(m);
    const shots = sweepCadence(eng, m, { from: HOUR_MS, rank: 4 });
    assert.ok(shots.length > 0, 'every load must bid');
    const first = Math.max(...shots.map((s) => s.remaining));
    assert.ok(first <= mark, `first bid at ${first} is outside its own mark ${mark}`);
    assert.ok(mark - first <= eng.cfg.pollHotMs * 2,
      `first bid at ${first} undershot its mark ${mark} by ${mark - first}ms - the cadence is not aiming at the mark`);
    leads.push(first);
  }
  assert.ok(Math.min(...leads) > GOCOMET_LIVENESS_GAP_MS,
    `the earliest first bid was ${Math.min(...leads)}ms, inside GoComet's own ${GOCOMET_LIVENESS_GAP_MS}ms legitimate read gap`);
});

// ---------------------------------------------------------------------------------------------
// 5-7. Timing varies, and varies only in the safe direction.
// ---------------------------------------------------------------------------------------------

run('the establish mark varies between loads', () => {
  const eng = mkEngine(); // real Math.random: each monitor rolls its own fraction
  const marks = [];
  for (let i = 0; i < 40; i++) marks.push(eng._softEstablishThreshold(armLoad(eng)));
  const distinct = new Set(marks);
  assert.ok(distinct.size >= 30,
    `40 loads produced only ${distinct.size} distinct marks - a near-fixed mark reads as automated`);
  const spread = Math.max(...marks) - Math.min(...marks);
  assert.ok(spread > SOFT_OPEN_JITTER_MS * 0.5,
    `marks spanned only ${spread}ms of the ${SOFT_OPEN_JITTER_MS}ms jitter`);
});

run('the jitter is one-sided EARLIER and never reaches the write budget', () => {
  const eng = mkEngine();
  for (let i = 0; i < 200; i++) {
    const mark = eng._softEstablishThreshold(armLoad(eng));
    assert.ok(mark >= SOFT_OPEN_AT_MS,
      `mark ${mark} is inside softOpenAtMs - jitter must only ever move the establish EARLIER`);
    assert.ok(mark <= SOFT_OPEN_AT_MS + SOFT_OPEN_JITTER_MS,
      `mark ${mark} exceeds softOpenAtMs + softOpenJitterMs`);
  }
});

run('one load keeps ONE mark across ticks', () => {
  // The fraction is rolled once and cached. Without that the mark would be re-rolled every 200ms and
  // the establish would fire on whichever tick drew the largest value - not held timing at all.
  const eng = mkEngine();
  const m = armLoad(eng);
  const first = eng._softEstablishThreshold(m);
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(eng._softEstablishThreshold(m), first, 'the mark must be stable for the life of the monitor');
  }
});

// ---------------------------------------------------------------------------------------------
// 8-10. The fail-safe directions. A hold must never become a forfeit.
// ---------------------------------------------------------------------------------------------

run('an unreadable countdown still establishes immediately', () => {
  // NaN is not a placeholder, it is an unreadable countdown, and _isLastChance(NaN) is false - so a
  // hold here could never be released by anything downstream and would guarantee a zero-bid loss.
  const eng = mkEngine();
  for (const bad of [NaN, undefined, Infinity]) {
    const m = armLoad(eng);
    const d = eng._decide(m, st(bad, null));
    assert.ok(d && d.rungIndex === 0, `remaining=${String(bad)} must fall back to the deployed immediate establish`);
  }
});

run('a year-2100 placeholder countdown does NOT establish', () => {
  // A placeholder parses as a valid finite number, so it must be held against rather than fired on.
  //
  // A 2026-09-09 fix round briefly reversed this case, on the r4 finding that such a remaining can
  // never be released (_lastResortFloor is gated on _isLastChance, which a 74-year remaining never
  // satisfies) and so forfeits the load. The premise does not survive contact with the adapters:
  // NEITHER shipped producer can hand _decide a beyond-horizon countdown. GoComet returns
  // { ok: false, implausibleCountdown: true } and _tick skips _decide entirely
  // (gocometAdapter.js, MAX_PLAUSIBLE_DEADLINE_MS); SP's socket drops the frame's loadEndTime past
  // the same +30d horizon and keeps the trustworthy discovery close (spSocket.js,
  // PLAUSIBLE_END_HORIZON_MS), and the REST fallback is boundedParse'd. The forfeit was reproduced
  // by driving _decide directly - the same bypass-the-production-writer test shape that let the r3
  // dead code through. So the conservative hold stands, and the guard belongs at the parse
  // boundary, where both adapters already put it.
  const eng = mkEngine();
  const m = armLoad(eng);
  assert.strictEqual(eng._decide(m, st(2_366_841_600_000, null)), null,
    'a placeholder deadline must not trip an establish');
});

run('a load armed inside the final window still shoots the floor', () => {
  // The late-arm floor branch sits ABOVE the establish mark in _decide, so the new hold can never
  // suppress it. This is the backstop that makes a missed window cost margin rather than the load.
  const eng = mkEngine();
  const m = armLoad(eng);
  const last = m.ladder.length - 1;
  const d = eng._decide(m, st(1_000, 3));
  assert.ok(d, 'a fresh monitor inside the last-chance window must not hold');
  assert.strictEqual(d.rungIndex, last, 'it goes straight to the floor, the price that wins');
});

// ---------------------------------------------------------------------------------------------
// Hard close and allowlisted soft are unreachable from the new knob - by construction.
//
// Note what these two cases do NOT prove. They say nothing about the population this change
// actually moves. A SuperProcure branch can runtime-report closeModel 'soft' for a customer who is
// not on the allowlist (realAdapter surfaces it, and the engine takes the live value), and that
// load runs the changed branch. It is covered below and in test-reversibility-spine.js, not here.
// ---------------------------------------------------------------------------------------------

run('SuperProcure hard close is byte-identical under any softOpenAtMs', () => {
  // 1,229 of 1,238 SP hard-close loads bid in the final minute and win that way. If the new knob can
  // reach this path at all, these two walks diverge.
  const walk = (softOpenAtMs) => {
    const eng = mkEngine({ rand: () => 0.5, softOpenAtMs, softOpenJitterMs: SOFT_OPEN_JITTER_MS });
    const m = armLoad(eng, { closeModel: 'hard', revisionsLeft: 30 });
    return sweepCadence(eng, m, { from: HOUR_MS, rank: 4 });
  };
  const a = walk(SOFT_OPEN_AT_MS);
  const b = walk(999_999_999);
  assert.deepStrictEqual(a, b, 'softOpenAtMs must not be reachable from a hard-close load');
  assert.ok(a.length > 0, 'the hard-close walk must still bid');
  const earliest = Math.max(...a.map((s) => s.remaining));
  assert.ok(earliest <= OPEN_AT_MS + 4_000,
    `SP still establishes at the openAtMs mark; earliest bid landed at ${earliest}ms remaining`);
});

run('an ALLOWLISTED soft load is byte-identical under any softOpenAtMs', () => {
  // The allowlisted path establishes ahead of the branch's own trigger window and owns its own mark.
  const walk = (softOpenAtMs) => {
    const eng = mkEngine({ rand: () => 0.5, softOpenAtMs, softEnabled: true, shippers: ['Havells'],
      revisionLimit: 30 });
    const m = armLoad(eng, { companyName: 'Havells', triggerWindowMs: 100_000, extendCap: 0, revisionsLeft: 30 });
    assert.notStrictEqual(m.softStrategy, 'off', 'this case is only meaningful on an allowlisted load');
    return sweepCadence(eng, m, { from: HOUR_MS, rank: 4 });
  };
  assert.deepStrictEqual(walk(SOFT_OPEN_AT_MS), walk(999_999_999),
    'softOpenAtMs must not be reachable from an allowlisted soft load');
});

// ---------------------------------------------------------------------------------------------
// 13. A misconfigured knob cannot squeeze the walk.
// ---------------------------------------------------------------------------------------------

run('softOpenAtMs is floored at openAtMs', () => {
  // A soft portal needs at least the runway a hard one does. A too-small value (or a zeroed one from
  // a malformed env) must not be able to push the establish tighter than the hard-close mark.
  for (const bad of [0, 1_000, -5_000, NaN]) {
    const eng = mkEngine({ rand: () => 0, softOpenAtMs: bad, softOpenJitterMs: 0 });
    const mark = eng._softEstablishThreshold(armLoad(eng));
    assert.strictEqual(mark, OPEN_AT_MS, `softOpenAtMs=${String(bad)} must clamp up to openAtMs, got ${mark}`);
  }
});

run('the jitter cannot be widened back out to rate-entry time', () => {
  // The unsafe direction is LARGER: the mark is base + jitter, so a big enough jitter walks the
  // establish back toward arm time and silently restores CW-209 with the fix still deployed. This
  // knob is env-only and never passes through configStore's AD_LIMITS the way openJitterMs does, so
  // the bound has to hold here. 900000 is the realistic slip - "15 minutes" typed in ms.
  const eng = mkEngine({ rand: () => 1, softOpenJitterMs: 900_000 });
  const mark = eng._softEstablishThreshold(armLoad(eng));
  const cap = SOFT_OPEN_AT_MS * 0.2;
  assert.ok(mark <= SOFT_OPEN_AT_MS + cap,
    `a 900,000ms jitter produced a ${mark}ms mark - that is the CW-209 defect back, with the fix apparently deployed`);
});

// ---------------------------------------------------------------------------------------------
// The window has to survive the platform's own worst legitimate silence.
// ---------------------------------------------------------------------------------------------

run('the SHIPPED defaults clear the read gap, not just the values these tests inject', () => {
  // Every other case in this file passes softOpenAtMs into mkEngine, so none of them can catch the
  // shipped constant being wrong - a run with the default lowered back to 45,000 stays green right
  // through them. This case is the one that reads what actually ships: config.js's resolved value,
  // and the engine DEFAULTS an engine built with no config override falls back to.
  const cfg = require('../src/config');
  assert.ok(cfg.engine.softOpenAtMs > GOCOMET_LIVENESS_GAP_MS,
    `config.js ships softOpenAtMs=${cfg.engine.softOpenAtMs}, inside the ${GOCOMET_LIVENESS_GAP_MS}ms gap GoComet calls legitimate`);

  const f = tmp(); CLEAN.push(f);
  const bare = new BidEngine({
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }),
    placeBid: async () => { throw new Error('unreachable'); },
  }, new DurableScheduler(f), { onEvent: () => {} });
  assert.ok(bare.cfg.softOpenAtMs > GOCOMET_LIVENESS_GAP_MS,
    `bidEngine DEFAULTS ship softOpenAtMs=${bare.cfg.softOpenAtMs}, inside the ${GOCOMET_LIVENESS_GAP_MS}ms gap`);
  assert.strictEqual(bare.cfg.softOpenAtMs, SOFT_OPEN_AT_MS,
    'the engine default and the value these tests inject must be the same number, or the suite is judging a value that does not ship');
});

run('the window is wider than GoComet\'s declared legitimate read gap', () => {
  // Holding the establish makes it the FIRST bid, so every bid the load will ever place lives in
  // this window. GoComet opens a 60-120s read cooldown on a rate-limit response and the engine
  // cannot decide at all through it. If the window is narrower than that gap, one routine 429
  // closes an armed, priced load with nothing on the board - strictly worse than the defect, which
  // at least left a bid standing.
  const eng = mkEngine({ rand: () => 0 });
  const mark = eng._softEstablishThreshold(armLoad(eng));
  assert.ok(mark > GOCOMET_LIVENESS_GAP_MS,
    `mark ${mark}ms does not clear the ${GOCOMET_LIVENESS_GAP_MS}ms gap the adapter calls legitimate`);
});

run('a read blackout spanning the liveness gap still leaves the load a bid', () => {
  // Drives the walk with the reads the engine would actually get: nothing at all for the length of
  // a full cooldown, starting at the top of the window, then reads resume. _tick returns without
  // calling _decide on a failed read, so a blackout is simply an absence of decision points.
  const eng = mkEngine({ rand: () => 0 });
  const m = armLoad(eng);
  const mark = eng._softEstablishThreshold(m);
  const blackoutFrom = mark;
  const blackoutTo = mark - GOCOMET_LIVENESS_GAP_MS;
  const shots = [];
  let r = HOUR_MS;
  let ticks = 0;
  while (r >= 0 && ticks++ < 20_000) {
    if (r > blackoutTo && r <= blackoutFrom) { r -= 1_000; continue; } // adapter in cooldown: no read
    const d = eng._decide(m, st(r, shots.length ? 4 : null));
    if (d) { shots.push({ rungIndex: d.rungIndex, remaining: r }); applyDecision(m, d); }
    r -= Math.max(1, eng._cadence(r, m));
  }
  assert.ok(shots.length > 0,
    `the load placed ZERO bids across a ${GOCOMET_LIVENESS_GAP_MS}ms blackout at the top of its window`);
});

// ---------------------------------------------------------------------------------------------
// A published anti-snipe window outranks the mark.
// ---------------------------------------------------------------------------------------------

run('a non-allowlisted SuperProcure soft load establishes OUTSIDE its trigger window', () => {
  // The population this change actually moves, and the one the two byte-identity cases above do not
  // reach. A soft SP branch publishes a 100-200 SECOND anti-snipe window; a mark derived from
  // GoComet's budgets alone would put BRL's OPENING (highest) bid inside it, self-trigger an
  // extension, and hand rivals a fresh round against a price we just revealed.
  const eng = mkEngine({ rand: () => 0 });
  const m = armLoad(eng, { companyName: 'Syngenta', triggerWindowMs: 180_000 });
  assert.strictEqual(m.softStrategy, 'off', 'this case is only meaningful on a NON-allowlisted load');
  const mark = eng._softEstablishThreshold(m);
  assert.ok(mark > 180_000,
    `mark ${mark}ms is inside the branch's own 180,000ms anti-snipe window - the establishing bid would extend the auction`);
  assert.strictEqual(mark, 180_000 + NON_ALLOWLISTED_LEAD_MS,
    'it clears the window by this path\'s own fixed lead');
  assert.strictEqual(eng._decide(m, st(mark + 1, null)), null, 'above its own mark it must still hold');
  const d = eng._decide(m, st(mark, null));
  assert.ok(d && d.rungIndex === 0, 'at its own mark it establishes');
  // The point of the whole case: where that bid lands relative to the anti-snipe window.
  assert.ok(mark - 180_000 >= NON_ALLOWLISTED_LEAD_MS,
    'the establishing bid must clear the trigger window by the full lead, not merely miss it');
});

run('the establish mark still varies on a load that publishes a wide trigger window', () => {
  // The floor and the spread are not alternatives. Jitter-then-floor made the Math.max pick the
  // floor outright whenever the published window cleared the top of the jitter band (w >= 125,000 at
  // shipped values), so on a Shriji-shaped 200s branch all 40 loads below produced ONE mark, spread
  // 0 - the anti-fingerprint knob silently void on exactly the SuperProcure population that shares a
  // live account with human bidders. Same assertion as the GoComet spread case above, run against
  // the windowed shape that case cannot reach.
  const eng = mkEngine(); // real Math.random: each monitor rolls its own fraction
  const marks = [];
  for (let i = 0; i < 40; i++) {
    marks.push(eng._softEstablishThreshold(armLoad(eng, { companyName: 'Shriji', triggerWindowMs: 200_000 })));
  }
  const distinct = new Set(marks);
  assert.ok(distinct.size >= 30,
    `40 windowed loads produced only ${distinct.size} distinct marks - the floor swallowed the spread`);
  const spread = Math.max(...marks) - Math.min(...marks);
  assert.ok(spread > SOFT_OPEN_JITTER_MS * 0.5,
    `windowed marks spanned only ${spread}ms of the ${SOFT_OPEN_JITTER_MS}ms jitter`);
  // The spread must ride ABOVE the safety floor, never eat into it.
  assert.ok(Math.min(...marks) >= 200_000 + NON_ALLOWLISTED_LEAD_MS,
    `the lowest mark ${Math.min(...marks)} does not clear the 200,000ms window by the full lead`);
});

run('the soft-close endgame knob does not move a NON-allowlisted load', () => {
  // establishLeadMs is a soft-close-ENDGAME knob. DEFAULT_SOFT's contract is that with `enabled`
  // false no load runs that endgame; .env.example tells the operator SP_SOFT_ESTABLISH_LEAD_MS
  // reaches the allowlisted path only; and setSoftClose promises never to flip a live soft auction
  // mid-window. Reading it from this path made all three false at once - an operator tuning the
  // allowlisted endgame moved the opening bid of every non-allowlisted soft load on a windowed
  // branch by the same amount, including loads already armed and in flight.
  const mk = (establishLeadMs) => {
    const f = tmp(); CLEAN.push(f);
    return new BidEngine({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 3, closeModel: 'soft' }),
      ensureSession: async () => ({}), getAuctionState: async () => ({ ok: false }),
      placeBid: async () => { throw new Error('unreachable'); },
    }, new DurableScheduler(f), {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, rungs: 6,
        softOpenAtMs: SOFT_OPEN_AT_MS, softOpenJitterMs: SOFT_OPEN_JITTER_MS },
      softClose: { enabled: false, shippers: [], mode: 'live', establishLeadMs },
      rand: () => 0, onEvent: () => {},
    });
  };
  const a = mk(40_000);
  const b = mk(120_000);
  assert.strictEqual(b.softCfg.establishLeadMs, 120_000, 'precondition: the knob really is set on engine b');
  const markA = a._softEstablishThreshold(armLoad(a, { companyName: 'Syngenta', triggerWindowMs: 200_000 }));
  const markB = b._softEstablishThreshold(armLoad(b, { companyName: 'Syngenta', triggerWindowMs: 200_000 }));
  assert.strictEqual(markA, markB,
    `the endgame knob moved a non-allowlisted mark from ${markA} to ${markB}`);
  assert.strictEqual(markA, 200_000 + NON_ALLOWLISTED_LEAD_MS,
    'and the mark is the window plus this path\'s own constant lead');
});

run('a re-priced load with a bid already standing places the corrected price NOW', () => {
  // The desk corrects a cost upward on a load that is already bidding. reArmWithNewBand is
  // stop + arm: it resets currentRungIndex to -1 but deliberately carries landedBids across, so the
  // corrected price arrives at the establish gate on a load whose OLD, too-low bid is standing and
  // acceptable. Holding there leaves that stale price live - on GoComet the 299s extension pushes
  // the load back outside its own mark, so it was held for ~142 seconds - while the desk has just
  // been told "bidding off the new cost and margins now". The hold exists to stop an UNBID load
  // exposing its opening price early; once a bid has landed there is nothing left to protect.
  // Driven through the REAL re-price path - scheduler.update to record a landed bid, then
  // eng.stop() + eng.arm() off the corrected cost, which is what server.js's reArmWithNewBand does.
  // Hand-assigning landedBids/currentRungIndex/firedRungs would miss that arm() rebuilds firedRungs
  // as an empty Set, so `est` is always 0 and the exempted bid is ladder[0] of the NEW band.
  const eng = mkEngine({ rand: () => 0.5 });
  const meta = { id: 'REPRICE-1', lane: { origin: 'Degam', destination: 'Vadodara' }, units: 1,
    companyName: 'Waaree', closesAt: Date.now() + HOUR_MS };
  const first = eng.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
  if (first.timer) clearTimeout(first.timer);
  first.timer = null;
  eng.scheduler.update(meta.id, { status: 'bidding', landedBids: 1 });
  eng.stop(meta.id);
  const m = eng.arm(meta, { cost: 82_000, marginsPct: [12.6, 7.2, 6.3] }); // the desk corrects upward
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.closeModel = 'soft';
  m.triggerWindowMs = null;
  m.extendsObserved = 0;
  m.revisionsLeft = 3;
  assert.strictEqual(m.landedBids, 1, 'precondition: the re-arm carries the landed bid across');
  assert.strictEqual(m.currentRungIndex, -1, 'precondition: the re-arm reset the walk');

  const EXTENDED_REMAINING = 299_000; // one GoComet extension increment, back outside the mark
  const mark = eng._softEstablishThreshold(m);
  assert.ok(EXTENDED_REMAINING > mark,
    'precondition: the extension really does put this load back outside its own establish mark');
  const d = eng._decide(m, st(EXTENDED_REMAINING, 2));
  assert.ok(d, `the corrected price was held at ${EXTENDED_REMAINING}ms remaining - the old bid stays on the board`);
  assert.strictEqual(d.rungIndex, 0, 'the corrected price is the opening rung of the NEW band, not the floor');
  assert.strictEqual(d.price, m.ladder[0]);
  applyDecision(m, d);

  // ONLY the establish was exempted. The rest of the walk still belongs to the closing window - a
  // step-down out here would give back margin ~268s before close, against ~127s by design.
  const shots = sweepCadence(eng, m, { from: EXTENDED_REMAINING - 1, rank: 4 });
  const early = shots.filter((s) => s.remaining > mark);
  assert.deepStrictEqual(early, [],
    `the exemption released the whole walk: ${JSON.stringify(early)} landed outside the ${mark}ms mark`);
  assert.ok(shots.length > 0, 'the walk must still run once inside the window - a hold is never the last word');

  // An UNBID load at the same remaining must still hold - the exemption is landedBids, not the clock.
  const fresh = armLoad(eng);
  assert.strictEqual(eng._decide(fresh, st(EXTENDED_REMAINING, null)), null,
    'a load that has never bid must still hold - this must not become a blanket release');
});

// Async tail: the production-path case. run() is synchronous, so this one owns its own runner and
// the completion sentinel counts it like any other.
const runAsync = async (name, fn) => {
  ran++;
  try { await fn(); ok(name); } catch (e) {
    FAILURES.push({ name, message: e && e.message });
    console.log('  FAIL ' + name + '\n       ' + (e && e.message));
  }
};

const productionPathCase = runAsync(
  'the trigger window reaches the mark through the REAL tick path, not a test assignment', async () => {
    // THE CASE THAT MATTERS, and the one whose absence made the floor dead code for a whole round.
    // Every other trigger-window case here sets monitor.triggerWindowMs by hand in armLoad, which
    // bypasses whatever actually writes it in production. That is a test passing for a reason the
    // running system does not share: the only writer used to be _observeExtension, whose first line
    // returns on `softStrategy === 'off'` - exactly this class of load - so the field was always
    // null on the box and the floor never fired, while the suite stayed green.
    //
    // So this case touches the field nowhere. It drives a real _tick against an adapter publishing a
    // live 180,000ms window and lets the engine surface it however it does.
    const f = tmp(); CLEAN.push(f);
    const placed = [];
    const liveState = {
      ok: true, status: 'live', myRank: null, totalBidders: 3, standingL1Price: null,
      closesInMs: 200_000, revisionsLeft: 3, closeModel: 'soft', triggerWindowMs: 180_000,
      measuredRttMs: 50, minDecrement: 1000,
    };
    const eng = new BidEngine({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 3, closeModel: 'soft' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => liveState,
      placeBid: async (id, price) => { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: 2, latencyMs: 20 }; },
    }, new DurableScheduler(f), {
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, rungs: 6,
        softOpenAtMs: SOFT_OPEN_AT_MS, softOpenJitterMs: 0 },
      softClose: { enabled: false, shippers: [], mode: 'live' },
      rand: () => 0, onEvent: () => {},
    });
    const m = eng.arm({ id: 'TW-PROD', lane: { origin: 'A', destination: 'B' }, units: 1,
      companyName: 'Syngenta', closesAt: Date.now() + 200_000 }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m.timer) clearTimeout(m.timer);
    m.timer = null;
    assert.strictEqual(m.softStrategy, 'off', 'this case is only meaningful on a non-allowlisted load');
    assert.strictEqual(m.triggerWindowMs, null, 'precondition: nothing has surfaced a window yet');

    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }

    assert.strictEqual(m.triggerWindowMs, 180_000,
      'the live window must reach the monitor through the real tick path - if this is null the floor below is dead code on the box');
    assert.strictEqual(eng._softEstablishThreshold(m), 180_000 + NON_ALLOWLISTED_LEAD_MS,
      'and the mark must then clear the window by the full lead');

    // 200,000ms remaining is the discriminating point, which is why the state carries it. With the
    // floor working the mark is 220,000 and the load establishes here; with the floor dead the mark
    // is softOpenAtMs 150,000 and it holds. So a bid landing is the proof the floor is live - and it
    // lands at 200,000, safely OUTSIDE the branch's own 180,000ms anti-snipe window, which is the
    // entire point of raising the mark.
    assert.strictEqual(placed.length, 1,
      'the load must establish here - holding means the mark is still 150,000 and the trigger-window floor never fired');
    assert.strictEqual(placed[0], m.ladder[0], 'and it establishes at the opening rung');
    assert.ok(liveState.closesInMs > m.triggerWindowMs,
      `the establishing bid landed at ${liveState.closesInMs}ms, inside the ${m.triggerWindowMs}ms anti-snipe window it was supposed to clear`);
  });

// Chained off the production-path case so the ordering is deterministic and the completion
// sentinel counts both. If either fails to settle before exit, the sentinel reports the shortfall
// rather than letting run-tests.js grade a silent green.
const restartCase = productionPathCase.then(() => runAsync(
  'a restart does NOT re-open the early walk on a re-priced load', async () => {
    // THE DEPLOY CASE. The step-down hold is the only thing keeping a re-priced load's ladder inside
    // the closing window, and it hangs off one monitor field. `sh scripts/deploy.sh` restarts the
    // pm2 process mid-auction - this file's own arm() comment calls that routine - and rehydrate
    // rebuilds currentRungIndex from the durable firedRungs, which SKIPS the establish branch, the
    // only place that sets the flag. If the flag is not durable the load comes back without it and
    // walks immediately, outside the mark: the repaired defect, reintroduced by a deploy.
    //
    // Driven through the real path end to end - _tick -> _maybeBid -> placeBid -> the accepted-bid
    // scheduler write - because the write that has to persist the flag only happens there. A test
    // that set the field by hand would pass against exactly the bug this case exists to catch.
    const f = tmp(); CLEAN.push(f);
    const REMAINING = 299_000; // one GoComet extension increment: back outside the mark
    const mkAdapter = (placed) => ({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 30, closeModel: 'soft' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: 'live', myRank: 4, totalBidders: 3,
        standingL1Price: null, closesInMs: REMAINING, revisionsLeft: 30, closeModel: 'soft',
        triggerWindowMs: null, measuredRttMs: 50, minDecrement: 1000 }),
      placeBid: async (id, price) => { placed.push(price); return { accepted: true, myRank: 2, revisionsLeft: 29, latencyMs: 20 }; },
    });
    const opts = () => ({
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, rungs: 6,
        softOpenAtMs: SOFT_OPEN_AT_MS, softOpenJitterMs: SOFT_OPEN_JITTER_MS },
      softClose: { enabled: false, shippers: [], mode: 'live' },
      rand: () => 0.5, onEvent: () => {},
    });
    const meta = { id: 'RESTART-1', lane: { origin: 'Degam', destination: 'Vadodara' }, units: 1,
      companyName: 'Waaree', closesAt: Date.now() + REMAINING };

    // Session 1: a bid is already on the board, the desk re-prices upward, the exemption releases
    // the corrected price outside the mark - then the box restarts.
    const placed1 = [];
    const eng1 = new BidEngine(mkAdapter(placed1), new DurableScheduler(f), opts());
    const a = eng1.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
    eng1.scheduler.update(meta.id, { status: 'bidding', landedBids: 1 });
    eng1.stop(meta.id);
    const m1 = eng1.arm(meta, { cost: 82_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m1.timer) clearTimeout(m1.timer);
    m1.timer = null;
    m1.closeModel = 'soft';
    assert.strictEqual(m1.landedBids, 1, 'precondition: the re-arm carried the landed bid');
    await eng1._tick(m1);
    if (m1.timer) { clearTimeout(m1.timer); m1.timer = null; }
    assert.strictEqual(placed1.length, 1, 'the exemption must place the corrected price on the real tick path');
    assert.strictEqual(m1.establishedBeforeWindow, true, 'and must record that it fired outside the window');
    assert.strictEqual(eng1.scheduler.get(meta.id).establishedBeforeWindow, true,
      'the flag must reach DISK on the accepted-bid write - in memory only, a deploy loses it');
    eng1.kill('simulated deploy restart');

    // Session 2: fresh engine, same durable store. This is the box after `sh scripts/deploy.sh`.
    const placed2 = [];
    const eng2 = new BidEngine(mkAdapter(placed2), new DurableScheduler(f), opts());
    await eng2.rehydrate();
    const m2 = eng2.snapshotMonitors ? null : [...eng2.monitors.values()].find((x) => String(x.auctionId) === meta.id);
    assert.ok(m2, 'the load must be re-armed by rehydrate');
    if (m2.timer) { clearTimeout(m2.timer); m2.timer = null; }
    m2.closeModel = 'soft';
    assert.ok(m2.currentRungIndex >= 0,
      'precondition: rehydrate rebuilds the rung index from firedRungs, so the establish branch is skipped');
    assert.strictEqual(m2.establishedBeforeWindow, true,
      'the flag must survive the restart - without it the walk re-opens outside the mark');

    // The load is outranked, still outside its mark. It must HOLD, not step down.
    const mark = eng2._softEstablishThreshold(m2);
    assert.ok(REMAINING > mark, 'precondition: still outside the closing window after the restart');
    assert.strictEqual(eng2._decide(m2, st(REMAINING - 1_000, 4)), null,
      `the restarted load stepped down at ${REMAINING - 1_000}ms remaining, outside its ${mark}ms mark`);
    // And it still walks once inside the window - the hold is not a forfeit.
    const inside = eng2._decide(m2, st(mark - 1_000, 4));
    assert.ok(inside && inside.rungIndex != null, 'inside the window the walk must resume');
    eng2.kill('test done');
  }));

const restartThrowCase = restartCase.then(() => runAsync(
  'a restart after an UNCERTAIN bid outcome also keeps the walk held', async () => {
    // The second of the two writes that count a bid as ON THE BOARD, and the one where a restart is
    // MOST likely - placeBid threw, the read-back could not prove the write never committed, so the
    // engine banks the rung fail-closed. That write persists firedRungs, so rehydrate rebuilds
    // currentRungIndex and skips the establish branch; if it does not also persist the hold flag,
    // a transport failure plus a deploy re-opens the early ladder walk. Covering only the accepted
    // path would have left this half open.
    const f = tmp(); CLEAN.push(f);
    const REMAINING = 299_000;
    // No revisionsLeft on the state: the read-back then cannot disprove the write landed, which is
    // the fail-closed branch this case exists for.
    const mkAdapter = (throwOnBid) => ({
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 1000, revisionLimit: 30, closeModel: 'soft' }),
      ensureSession: async () => ({}),
      getAuctionState: async () => ({ ok: true, status: 'live', myRank: 4, totalBidders: 3,
        standingL1Price: null, closesInMs: REMAINING, closeModel: 'soft', triggerWindowMs: null,
        measuredRttMs: 50, minDecrement: 1000 }),
      placeBid: async () => { if (throwOnBid) throw new Error('ECONNRESET mid-write'); return { accepted: true, myRank: 2, latencyMs: 20 }; },
    });
    const opts = () => ({
      config: { openAtMs: OPEN_AT_MS, floorWindowMs: 2_500, rungs: 6,
        softOpenAtMs: SOFT_OPEN_AT_MS, softOpenJitterMs: SOFT_OPEN_JITTER_MS },
      softClose: { enabled: false, shippers: [], mode: 'live' },
      rand: () => 0.5, onEvent: () => {},
    });
    const meta = { id: 'RESTART-THROW', lane: { origin: 'Degam', destination: 'Vadodara' }, units: 1,
      companyName: 'Waaree', closesAt: Date.now() + REMAINING };

    const eng1 = new BidEngine(mkAdapter(true), new DurableScheduler(f), opts());
    const a = eng1.arm(meta, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
    eng1.scheduler.update(meta.id, { status: 'bidding', landedBids: 1 });
    eng1.stop(meta.id);
    const m1 = eng1.arm(meta, { cost: 82_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m1.timer) clearTimeout(m1.timer);
    m1.timer = null;
    m1.closeModel = 'soft';
    await eng1._tick(m1);
    if (m1.timer) { clearTimeout(m1.timer); m1.timer = null; }
    assert.ok(m1.firedRungs.has(0), 'the uncertain outcome must bank the rung fail-closed');
    assert.strictEqual(eng1.scheduler.get(meta.id).establishedBeforeWindow, true,
      'the uncertain-outcome write must persist the hold flag too - this is the likeliest restart moment');
    eng1.kill('simulated deploy restart');

    const eng2 = new BidEngine(mkAdapter(false), new DurableScheduler(f), opts());
    await eng2.rehydrate();
    const m2 = [...eng2.monitors.values()].find((x) => String(x.auctionId) === meta.id);
    assert.ok(m2, 'the load must be re-armed by rehydrate');
    if (m2.timer) { clearTimeout(m2.timer); m2.timer = null; }
    m2.closeModel = 'soft';
    assert.strictEqual(m2.establishedBeforeWindow, true, 'the flag must survive this restart too');
    assert.strictEqual(eng2._decide(m2, st(REMAINING - 1_000, 4)), null,
      'the restarted load must still hold its step-down outside the mark');
    eng2.kill('test done');
  }));

run('GoComet keeps the softOpenAtMs mark - it publishes no trigger window', () => {
  // The floor above only ever moves a platform that tells us where its window is. GoComet does not
  // surface branchAuctionRemainingTime at all, so triggerWindowMs stays null and nothing is invented.
  const eng = mkEngine({ rand: () => 0 });
  const m = armLoad(eng, { triggerWindowMs: null });
  assert.strictEqual(eng._softEstablishThreshold(m), SOFT_OPEN_AT_MS,
    'an unknown window must not change the mark - no fabricated window');
});
