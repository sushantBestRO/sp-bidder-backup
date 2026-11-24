'use strict';
/**
 * Integration-shaped test of the live socket flow against a FAKE socket.io socket (no network):
 * join_v2 -> auctionStart (per load) -> bidListenerV2 (rank + loadEndTime) -> our rank is read.
 * Plus the reconnect regression: a socket.io auto-reconnect must re-subscribe every watched room,
 * or the rank feed dies silently (myRank frozen) and, on a hard-close snipe, we hold/step off a
 * dead rank through the close.
 *
 * Plus the carrier-per-load self-match: the socket matches OUR bids against a SET of carrier ids the
 * login bids as (its own carrier + any per-load registration it routes to). Matching a SINGLE id went
 * blind the moment we bid as a foreign carrier (Havells 5963 via master 2667) - rank tracking froze on
 * a load we were actively bidding. Cases 6-9 pin the set match and the placeBid -> registerCarrier
 * wiring end to end.
 *
 * All hard-close (the scoped Syngenta model). Never opens a real connection - the fake socket
 * records emits and lets us fire the registered handlers by hand.
 *
 *   node scripts/test-socket-flow.js
 */
const assert = require('assert');
const { SpSocket } = require('../src/platform/spSocket');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { deriveLoadRules } = require('../src/model/loadRules');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// a minimal EventEmitter-shaped fake socket.io Socket that records emits + exposes handlers
function fakeSocket() {
  const handlers = {};
  return {
    id: 'fake-1',
    emits: [],
    on(ev, fn) { (handlers[ev] || (handlers[ev] = [])).push(fn); },
    emit(ev, ...args) { this.emits.push({ ev, args }); },
    close() {},
    fire(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
  };
}

// build an SpSocket without connecting: inject the fake as its socket + register handlers
function wire(sock, fake) {
  sock.socket = fake;
  fake.on('connect', () => {
    fake.emit('join_v2', 'Bearer ' + sock.token);
    for (const [id, isOpen] of sock.rooms) fake.emit('auctionStart', { loadId: Number(id), isOpenAuction: isOpen ? 1 : 0 });
  });
  fake.on('bidListenerV2', (p) => sock._onBid(p));
}

(async () => {
  // 1. join_v2 -> auctionStart -> bidListenerV2 -> our rank is read from our carrier's active bid
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    const fake = fakeSocket();
    wire(sock, fake);
    fake.fire('connect');
    sock.watch('22365292', 0); // subscribe the load
    // server pushes a frame: our active bid (carrier 2667) is rank 2
    fake.fire('bidListenerV2', {
      loadId: 22365292,
      bids: [
        { carrierId: 9999, isActive: 1, rank: 1, amount: 90000 },
        { carrierId: 2667, isActive: 1, rank: 2, amount: 91000 },
      ],
      fieldsToBeUpdated: { loadEndTime: new Date(Date.now() + 30000).toISOString() },
      ackString: '22365292_x',
    });
    assert.strictEqual(sock.state('22365292').myRank, 2, 'our rank read from bidListenerV2');
    assert.ok(sock.closesInMs('22365292', 0) > 0, 'countdown derived from loadEndTime');
    const emitted = fake.emits.map((e) => e.ev);
    assert.ok(emitted.includes('join_v2'), 'join_v2 sent on connect');
    assert.ok(emitted.includes('auctionStart'), 'auctionStart subscribed the room');
    assert.ok(emitted.includes('bidListenerV2_ACK'), 'ACKed the frame');
    ok('join_v2 -> auctionStart -> bidListenerV2 flow reads our live rank + countdown');
  }

  // 2. reconnect re-subscribes every watched room (else the rank feed freezes)
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    const fake = fakeSocket();
    wire(sock, fake);
    fake.fire('connect');
    sock.watch('22365292', 0);
    const auctionStartsBefore = fake.emits.filter((e) => e.ev === 'auctionStart').length;
    assert.strictEqual(auctionStartsBefore, 1, 'subscribed once initially');
    // a routine blip: socket.io auto-reconnects -> 'connect' fires again
    fake.fire('connect');
    const auctionStartsAfter = fake.emits.filter((e) => e.ev === 'auctionStart').length;
    assert.strictEqual(auctionStartsAfter, 2, 'auctionStart re-emitted on reconnect (room re-subscribed, feed alive)');
    const joinV2s = fake.emits.filter((e) => e.ev === 'join_v2').length;
    assert.strictEqual(joinV2s, 2, 'join_v2 also replayed on reconnect');
    ok('reconnect re-subscribes watched rooms (rank feed does not silently freeze)');
  }

  // 3. a garbage/unparseable loadEndTime must never become NaN on the live path - same local
  // idiom as realAdapter.js's parseRetryAfterMs (Number.isNaN(t) ? null : ...). Before this
  // guard, Date.parse('not-a-date') silently wrote NaN into loadEndTimeMs, and closesInMs()'s
  // Math.max(0, NaN) is itself NaN - indistinguishable from "no countdown" everywhere it's read.
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    sock._onBid({
      loadId: 999,
      bids: [{ carrierId: 2667, isActive: 1, rank: 1, amount: 1000 }],
      fieldsToBeUpdated: { loadEndTime: 'not-a-date' },
    });
    assert.strictEqual(sock.state('999').loadEndTimeMs, undefined, 'garbage loadEndTime is dropped, never written as NaN');
    assert.ok(!Number.isNaN(sock.closesInMs('999', Date.now() + 60000)), 'closesInMs falls back to the REST close time instead of returning NaN');
    ok('garbage loadEndTime is rejected, not silently written as NaN');
  }

  // 4. a PARSEABLE far-future loadEndTime (SuperProcure's year-2100 placeholder) must be
  // rejected too - it sails past the NaN guard as a valid date, and because closesInMs()
  // prefers the socket's value over the REST fallback, one such frame froze the engine's
  // countdown decades out: far poll phase forever, establish rung never unlocked, zero bids
  // on an otherwise-correct auction (OA 23075092, OA 23088090 - the Jul 12/13 silent misses).
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    const realClose = Date.now() + 5 * 60_000; // discovery's trustworthy closesAt, 5 min out
    sock._onBid({
      loadId: 23075092,
      bids: [],
      fieldsToBeUpdated: { loadEndTime: '2100-05-25T12:00:00' }, // the placeholder, parseable
    });
    assert.strictEqual(sock.state('23075092').loadEndTimeMs, undefined, 'placeholder end time is dropped, not stored');
    const cd = sock.closesInMs('23075092', realClose);
    assert.ok(cd > 0 && cd <= 5 * 60_000, `countdown stays on the REST close time, got ${cd}`);
    // a genuine near-term end time on a later frame must still be accepted (the bound only
    // rejects the implausible, never a real extension/close)
    sock._onBid({
      loadId: 23075092,
      bids: [],
      fieldsToBeUpdated: { loadEndTime: new Date(Date.now() + 30_000).toISOString() },
    });
    const cd2 = sock.closesInMs('23075092', realClose);
    assert.ok(cd2 > 0 && cd2 <= 31_000, `real end time still updates the countdown, got ${cd2}`);
    ok('parseable year-2100 placeholder is rejected; real end times still accepted');
  }

  // 5. the placeholder-drop warn dedupes to ONE line per load. Frames repeat every few
  // seconds for the life of the auction room, so without the endTimeRejectedWarned latch a
  // single stuck load would spam a warn line per frame into pm2-err.log; and the latch is
  // per-LOAD state, so a second load carrying the same placeholder must still get its own
  // (single) line. Captured the same way test-logger.js observes log output: warn/error
  // lines route to console.error (one JSON line per call).
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    const placeholderFrame = (loadId) => ({
      loadId, bids: [], fieldsToBeUpdated: { loadEndTime: '2100-05-25T12:00:00' },
    });
    const errLines = [];
    const origError = console.error;
    console.error = (line) => errLines.push(String(line));
    try {
      for (let i = 0; i < 4; i++) sock._onBid(placeholderFrame(777)); // same load, repeated frames
      sock._onBid(placeholderFrame(888));                             // a different load
    } finally { console.error = origError; }
    const warns = errLines.filter((l) => l.includes('plausibility horizon'));
    assert.strictEqual(warns.filter((l) => l.includes('"loadId":777')).length, 1,
      `4 placeholder frames for one load -> exactly one warn line, got ${warns.length}: ${warns.join(' | ')}`);
    assert.strictEqual(warns.filter((l) => l.includes('"loadId":888')).length, 1,
      'a different load still warns once (the dedupe latch is per-load, not global)');
    assert.strictEqual(warns.length, 2, 'no other placeholder warns leaked');
    ok('placeholder warn fires once per load: no per-frame spam, no cross-load suppression');
  }

  // 6. carrier-per-load: a login that routes a bid to a FOREIGN registration (bidding@ / 2667 placing
  //    a Havells bid as 5963) must self-match its own 5963 row. registerCarrier(5963) is what
  //    realAdapter.placeBid calls when it routes; an unrelated competitor in the same frame is not ours.
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    sock.registerCarrier(5963); // the adapter routed a bid to the load's carrier
    sock._onBid({
      loadId: 24000001,
      bids: [
        { carrierId: 9999, isActive: 1, rank: 1, amount: 88000 }, // an unrelated competitor
        { carrierId: 5963, isActive: 1, rank: 2, amount: 90000 }, // OUR routed bid
      ],
      fieldsToBeUpdated: { loadEndTime: new Date(Date.now() + 30000).toISOString() },
      ackString: '24000001_x',
    });
    assert.strictEqual(sock.state('24000001').myRank, 2, 'our routed 5963 bid is matched as ours (rank tracked)');
    ok('foreign routed carrier (registerCarrier) self-matches; rank tracked on a cross-carrier bid');
  }

  // 7. a carrier we NEVER bid as is never matched as ours (no phantom self-rank off a competitor row).
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, userId: 'u1' });
    sock._onBid({
      loadId: 24000002,
      bids: [
        { carrierId: 5963, isActive: 1, rank: 1, amount: 70000 }, // NOT ours (never registered)
        { carrierId: 9999, isActive: 1, rank: 2, amount: 72000 },
      ],
      fieldsToBeUpdated: { loadEndTime: new Date(Date.now() + 30000).toISOString() },
      ackString: '24000002_x',
    });
    const st = sock.state('24000002');
    assert.strictEqual(st.myRank, undefined, 'no bid of ours -> myRank stays unset (never a competitor rank)');
    assert.strictEqual(st.bids.length, 2, 'the full ladder is still recorded (totalBidders), just none of it ours');
    ok('a carrier we do not bid as is not matched (no phantom self-rank)');
  }

  // 8. the constructor accepts a pre-seeded SET (account carrier + known routed carriers).
  {
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: 2667, carrierIds: [5963, 4441], userId: 'u1' });
    sock._onBid({
      loadId: 24000003,
      bids: [{ carrierId: 4441, isActive: 1, rank: 1, amount: 50000 }],
      fieldsToBeUpdated: { loadEndTime: new Date(Date.now() + 30000).toISOString() },
    });
    assert.strictEqual(sock.state('24000003').myRank, 1, 'a carrier passed via the carrierIds set self-matches');
    ok('constructor carrierIds seeds the self-match set (account carrier + routed carriers)');
  }

  // 9. INTEGRATION: realAdapter.placeBid, when it routes to a foreign carrier, registers that carrier
  //    with its attached socket, so the socket then self-matches our own bid frame. The whole blind
  //    spot fix end to end: route as 5963 -> socket learns 5963 -> the 5963 row is tracked.
  {
    const load = 24000004, accountCarrier = 2667, foreignCarrier = 5963;
    const sock = new SpSocket({ token: 'FAKE.JWT', carrierId: accountCarrier, userId: 'u1' });
    const fetchImpl = async () => ({ status: 201, headers: { get: () => null }, json: async () => ({ data: { rank: 2 } }) });
    const a = new RealSuperProcureAdapter({ token: 't', fetchImpl, sock });
    a.account = { carrierId: accountCarrier, tokenExp: Date.now() + 3_600_000 };
    a.writeEnabled = true;

    assert.strictEqual(sock.carrierIds.has(foreignCarrier), false, 'precondition: socket does not yet know 5963');
    const rules = deriveLoadRules({ id: String(load), branchCarrierCarrierId: foreignCarrier, branchAuctionExtendTime: '00:00:00' });
    await a.placeBid(String(load), 90000, rules); // routes the wire carrier to 5963
    assert.strictEqual(sock.carrierIds.has(foreignCarrier), true, 'placeBid registered the routed carrier 5963 with the socket');

    // a live frame carrying our 5963 bid is now recognised as ours (was blind before the fix)
    sock._onBid({
      loadId: load,
      bids: [
        { carrierId: 9999, isActive: 1, rank: 1, amount: 80000 },
        { carrierId: foreignCarrier, isActive: 1, rank: 2, amount: 90000 },
      ],
      fieldsToBeUpdated: { loadEndTime: new Date(Date.now() + 30000).toISOString() },
    });
    assert.strictEqual(sock.state(String(load)).myRank, 2, 'the socket now tracks our rank on the foreign-carrier load (no longer blind)');
    ok('placeBid -> registerCarrier -> socket self-matches the routed carrier (blind spot fixed end to end)');
  }

  console.log(`\n${pass}/9 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
