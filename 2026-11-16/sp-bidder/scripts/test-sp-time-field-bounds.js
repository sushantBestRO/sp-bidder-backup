'use strict';
/**
 * THE LAST TWO UNBOUNDED SuperProcure TIME FIELDS.
 *
 * Regression target: Ashirvad loads 22724361 and 23049480 (2026-07-11 placeholder-close incident).
 *
 * The named year-2100 placeholder defect itself is CLOSED - fixed 2026-07-13 (a222daa), hardened
 * 2026-07-17 (0f8a059, eee11d9) and 2026-07-22 (60db708). Both Ashirvad loads in the handoff
 * (22724361, 23049480) predate the fix. What this file pins is the two gaps a fresh audit of every
 * SP-supplied time field found still open around it.
 *
 * GAP 1 - the socket clock heartbeat (spSocket `current`). The last unvalidated SP time field in
 * the codebase: no NaN guard, no unit normalisation, no skew clamp. WHY an unguarded read there is
 * worse than an ordinary one - it is the reference clock the placeholder guard measures against,
 * and it is per-socket, so one bad frame takes out every watched load at once - is documented on
 * _onClock itself; this file pins the behaviour rather than restating the reasoning. Pinned
 * alongside it: the warn throttle, because a refused frame that reports once per PROCESS is a
 * silent failure by the time anyone looks, and the two concerns must not share a throttle key.
 *
 * No bad `current` frame has ever been observed. This is an unexercised hole, not a live incident -
 * pinned because it is one frame away from mispricing every auction on the socket.
 *
 * GAP 2 - capture() and restore() had no PLAUSIBILITY bound, only a has-it-closed check. rearm()
 * and expireOverdue() both have one. Intake now gates placeholders at discovery and the sweeps
 * retire them every tick, so this is a belt against a legacy or hand-seeded row priced inside the
 * sweep window rather than a live hole - but capture() is the point where a human has ALREADY typed
 * a cost, so a silent accept there turns their work into a load that can never bid.
 *
 * Offline and deterministic: no socket connection is ever opened (the handler is invoked directly),
 * no network, in-memory store.
 *
 *   node scripts/test-sp-time-field-bounds.js
 */
const assert = require('assert');
const { SpSocket, PLAUSIBLE_END_HORIZON_MS } = require('../src/platform/spSocket');
const { normalizeServerOffset, MAX_CLOCK_SKEW_MS } = require('../src/util/serverClock');
const { MAX_PLAUSIBLE_DEADLINE_MS } = require('../src/platform/realAdapter');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// Build a socket WITHOUT connecting and drive the REAL handler as a method - the same approach
// test-socket-flow.js takes with _onBid, and the reason _onClock is a named method at all. connect()
// is never called: it would open a real websocket to api.superprocure.com, which a test must never
// do. Nothing here re-implements the guard, so this cannot pass against a broken one.
function mkSocket() {
  const logs = [];
  const s = new SpSocket({ token: 't', carrierId: 2667, userId: 'u', onLog: (m) => logs.push(m) });
  s._logs = logs;
  return s;
}
const currentHandlerOf = (sock) => (p) => sock._onClock(p);

(async () => {
  // ---------------------------------------------------------------- GAP 1: the socket clock
  {
    // The handler connect() wires must be the method under test, or every check below is testing
    // dead code. Asserted by reading the wiring rather than by opening a socket. Matched loosely
    // (same line, names _onClock) so an arrow-shape or .bind() rewrite stays green - the drift this
    // guards against is the handler being pointed somewhere else, not its punctuation.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/platform/spSocket.js'), 'utf8');
    assert.ok(/s\.on\('current',[^\n]*_onClock/.test(src),
      "connect() must wire the 'current' event to _onClock - the method these checks drive");
    ok('the `current` event is wired to _onClock (the checks below drive real production code)');
  }
  {
    // A GOOD frame still works - the guard must not break the thing it protects.
    const sock = mkSocket();
    const h = currentHandlerOf(sock);
    h({ time: Date.now() + 4_000 });      // 4s ahead, well inside the plausible band
    assert.ok(Math.abs(sock.serverOffsetMs - 4_000) < 2_500, 'a plausible ms heartbeat is accepted');
    // ...and SECONDS are normalised, exactly as the REST twin normalises currentTime. Tolerance
    // covers the up-to-999ms the floor-to-seconds throws away PLUS real elapsed wall clock.
    const sock2 = mkSocket();
    currentHandlerOf(sock2)({ time: Math.floor((Date.now() + 3_000) / 1000) });
    assert.ok(Math.abs(sock2.serverOffsetMs - 3_000) < 2_500,
      'a heartbeat in Unix SECONDS is normalised to ms, not read as epoch ~1970');
    ok('a good heartbeat is accepted, in ms or in seconds');
  }
  {
    // THE NaN CASE - the one that poisons every load on the socket at once.
    const sock = mkSocket();
    const h = currentHandlerOf(sock);
    sock.serverOffsetMs = 1234;                    // a known-good prior offset
    h({ time: '2026-08-05T00:00:00.000Z' });       // truthy STRING -> NaN under the old code
    assert.strictEqual(sock.serverOffsetMs, 1234, 'a non-numeric heartbeat must be a NO-OP');
    assert.ok(Number.isFinite(sock.serverNow()), 'serverNow() must stay finite');
    h({ time: NaN });
    h({ time: {} });
    h({ time: [] });                               // Number([]) is 0 - finite, and still not a time
    assert.strictEqual(sock.serverOffsetMs, 1234, 'and stays a no-op for every non-finite shape');
    ok('a non-numeric clock heartbeat is a no-op - serverNow() can never go NaN');
  }
  {
    // A FALSY reading is an ABSENT one, not a fault: no offset change and NOTHING said. Treating
    // {time:0} as a timestamp reads as a ~56-year backwards skew, which both writes nonsense into
    // the log and spends the skew throttle on a frame that carries no information.
    const sock = mkSocket();
    const h = currentHandlerOf(sock);
    sock.serverOffsetMs = 777;
    h({ time: 0 });
    h({ time: '' });
    h({});
    h(null);
    assert.strictEqual(sock.serverOffsetMs, 777, 'a falsy heartbeat leaves the offset untouched');
    assert.strictEqual(sock._logs.length, 0, 'and is silent - an absent reading is not a fault');
    ok('a falsy/absent heartbeat is a silent no-op, never a skew diagnosis');
  }
  {
    // THE SKEW CASE - what would defeat the placeholder guard by moving its reference clock.
    const sock = mkSocket();
    const h = currentHandlerOf(sock);
    sock.serverOffsetMs = 500;
    h({ time: Date.now() + 40 * 365 * 86_400_000 }); // ~year 2066: absurd, but finite and parseable
    assert.strictEqual(sock.serverOffsetMs, 500, 'an implausible forward skew is rejected');
    h({ time: Date.now() - 10 * 365 * 86_400_000 }); // absurd backwards
    assert.strictEqual(sock.serverOffsetMs, 500, 'and an implausible backward skew too');
    h({ time: Date.now() + MAX_CLOCK_SKEW_MS + 1_000 }); // just OUTSIDE the band
    assert.strictEqual(sock.serverOffsetMs, 500, 'and a frame just past the band edge');
    h({ time: Date.now() + 60_000 });                // comfortably inside it
    assert.ok(Math.abs(sock.serverOffsetMs - 60_000) < 2_500, 'but a plausible skew inside the band is accepted');
    ok('an implausible clock skew is rejected; the previous offset is kept (never zeroed)');
  }
  {
    // TWO CONCERNS, TWO KEYS. Sharing one throttle key means whichever fault fires first hides the
    // other for as long as the process lives - and these two have different remedies (a malformed
    // frame is an SP contract change; a skew is a clock problem on one of the two boxes).
    const sock = mkSocket();
    const h = currentHandlerOf(sock);
    for (let i = 0; i < 25; i++) h({ time: 'not-a-number' });
    assert.strictEqual(sock._logs.length, 1, `expected exactly one operator warning, got ${sock._logs.length}`);
    assert.ok(/clock/i.test(sock._logs[0]), 'and it names the concern');
    for (let i = 0; i < 25; i++) h({ time: Date.now() + 40 * 365 * 86_400_000 });
    assert.strictEqual(sock._logs.length, 2, 'a DIFFERENT concern still gets through the first one\'s throttle');
    assert.ok(/skew/i.test(sock._logs[1]), 'and reports itself as the skew, not the malformed-frame case');
    ok('each concern warns once per frame-storm, and never masks the other');
  }
  {
    // THE THROTTLE IS TIME-BOXED, NOT PERMANENT. This SpSocket instance outlives every reconnect
    // (socket.io retries the same socket forever), so a one-shot latch would report a permanent
    // clock fault exactly once per process - which looks identical to the fault having cleared.
    const sock = mkSocket();
    const h = currentHandlerOf(sock);
    h({ time: 'not-a-number' });
    h({ time: 'not-a-number' });
    assert.strictEqual(sock._logs.length, 1, 'a repeat inside the window stays quiet');
    for (const k of sock._warnThrottle.keys()) sock._warnThrottle.set(k, Date.now() - 3_600_000);
    h({ time: 'not-a-number' });
    assert.strictEqual(sock._logs.length, 2, 'an hour on, a still-broken clock reports itself again');
    ok('a persistent fault re-reports on a cooldown - it never goes permanently silent');
  }
  {
    // The horizon constant is hand-copied into spSocket (importing realAdapter there would be a
    // require cycle - realAdapter requires spSocket). The cross-module pin that exists for
    // realAdapter <-> priceRequests does not cover this pair, so drift is pinned here instead -
    // by comparing the two EXPORTED values, not by matching source text.
    assert.strictEqual(PLAUSIBLE_END_HORIZON_MS, MAX_PLAUSIBLE_DEADLINE_MS,
      'the socket horizon and the adapter deadline bound must stay equal (they are two copies)');
    ok('the socket placeholder horizon still equals the adapter MAX_PLAUSIBLE_DEADLINE_MS');
  }
  {
    // The offset algorithm itself, now shared by both SP clock surfaces (src/util/serverClock.js)
    // instead of hand-copied into each. Fixed `now` - the only fully deterministic check here.
    const now = 1_700_000_000_000;
    assert.deepStrictEqual(normalizeServerOffset(now + 5_000, now), { ok: true, offsetMs: 5_000 });
    assert.deepStrictEqual(normalizeServerOffset((now + 5_000) / 1000, now), { ok: true, offsetMs: 5_000 },
      'a seconds-epoch reading normalises to the same offset as its ms twin');
    assert.strictEqual(normalizeServerOffset('nope', now).reason, 'unusable');
    assert.strictEqual(normalizeServerOffset(0, now).reason, 'unusable');
    assert.strictEqual(normalizeServerOffset([], now).reason, 'unusable', 'Number([]) is 0, not a time');
    assert.strictEqual(normalizeServerOffset(now + MAX_CLOCK_SKEW_MS, now).reason, 'skew',
      'the band edge itself is refused (>= , matching the REST twin it replaced)');
    assert.strictEqual(normalizeServerOffset(now + MAX_CLOCK_SKEW_MS - 1, now).ok, true,
      'and one ms inside it is accepted');
    ok('the shared clock normaliser: seconds, unusable shapes, and both sides of the skew edge');
  }

  // ---------------------------------------------------------------- GAP 2: capture() / restore()
  const mkReqs = () => new PriceRequestStore({
    store: new MemoryStore(), marginsPct: [12, 7, 2], minMarginPct: 2, log: () => {} });
  const PLACEHOLDER = Date.parse('2100-05-24T19:53:25.000Z'); // SP's real placeholder, byte-exact
  const seed = (reqs, closesAt) => reqs.createForLoad(
    { id: 'P1', lane: { origin: 'A', destination: 'B' }, companyName: 'Syngenta', units: 1,
      closesAt, status: 'live' },
    { deadlineAt: Date.now() + 600_000 });
  {
    // NO_VALID_CLOSE, not GONE. The code IS the operator's copy: server.js renders "your cost
    // reached us after this auction closed" for GONE, which on a load that has not closed is
    // false in the direction that sends the desk hunting for a mistake of their own.
    const reqs = mkReqs();
    const r = await seed(reqs, PLACEHOLDER);
    await assert.rejects(
      () => reqs.capture(r.id, { cost: 15_000, marginsPct: [12, 7, 2], minMarginPct: 2 }),
      (e) => e.code === 'NO_VALID_CLOSE' && /placeholder/i.test(e.message),
      'capture() must refuse a placeholder close with its OWN code, not GONE');
    ok('capture() refuses a year-2100 placeholder instead of arming a load that can never bid');
  }
  {
    // The boundary is INCLUSIVE on the good side, matching expireOverdue's - a close exactly at the
    // horizon is a real (if unusual) load and must still be priceable.
    const reqs = mkReqs();
    const r = await seed(reqs, Date.now() + MAX_PLAUSIBLE_DEADLINE_MS - 60_000);
    const out = await reqs.capture(r.id, { cost: 15_000, marginsPct: [12, 7, 2], minMarginPct: 2 });
    assert.strictEqual(out.status, 'armed', 'a close just inside the horizon still captures');
    ok('a close just inside the plausibility horizon is still accepted (no over-reach)');
  }
  {
    const reqs = mkReqs();
    const r = await seed(reqs, PLACEHOLDER);
    await reqs.dismiss(r.id);
    await assert.rejects(
      () => reqs.restore(r.id),
      (e) => e.code === 'NO_VALID_CLOSE' && /placeholder/i.test(e.message),
      'restore() must refuse to walk a placeholder back onto the worklist');
    ok('restore() refuses a placeholder - a dismissed bad row cannot be re-surfaced for pricing');
  }

  // COMPLETION SENTINEL. run-tests.js grades by EXIT CODE alone, so an early return reads as a
  // green zero-assertion run. Pinning the count is what makes truncation fail.
  const EXPECTED = 12;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
