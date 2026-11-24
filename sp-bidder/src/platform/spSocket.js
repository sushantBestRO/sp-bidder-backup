'use strict';

const { io } = require('socket.io-client');

// SP main. socket.io's own default path is '/socket.io/'; stated explicitly here so the
// white-label override reads as a swap of a known value rather than a new behaviour.
const DEFAULT_SOCKET_URL = 'https://api.superprocure.com';
const DEFAULT_SOCKET_PATH = '/socket.io/';
const { createLogger } = require('../logging/logger');
const { normalizeServerOffset, readingResolutionMs, ServerClockEstimator } = require('../util/serverClock');

// Operational logger for the SuperProcure live socket. Connect/disconnect/reconnect/
// error activity is logged here, at the point the underlying socket.io client actually
// fires those events — the earliest and most precise place to capture a connection
// issue. This is separate from the onLog callback below, which stays purely the
// caller's UI hook into the dashboard's in-memory event ring buffer.
const log = createLogger('spSocket');

// The farthest-out loadEndTime a live frame is allowed to move a countdown to. SuperProcure
// ships a shared far-future placeholder end time (year 2100, rendered "25-05-2100" dd-mm-yyyy)
// on loads whose bidding window isn't actually running - it parses as a perfectly VALID date,
// so the NaN guard below never catches it. No genuine SP bidding window runs anywhere near a
// month out, so anything beyond this horizon is that placeholder, never a real close.
const PLAUSIBLE_END_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

// How long a warned-about concern stays quiet before it may re-report: long enough that repeating
// frames cannot flood the log, short enough that a fault stays visible for as long as it lasts.
const WARN_REARM_MS = 15 * 60 * 1000;

/**
 * SpSocket — SuperProcure live auction feed (read side of the real integration).
 * Protocol decoded from the live capture (see SUPERPROCURE_API.md):
 *   connect -> emit `join_v2` "Bearer <jwt>"
 *   per load -> emit `auctionStart` {loadId, isOpenAuction}
 *   receive `bidListenerV2` {bids:[...], fieldsToBeUpdated:{loadEndTime}, loadId, ackString}
 *            -> our live rank = our active bid's `rank`; countdown = loadEndTime
 *            -> reply `bidListenerV2_ACK`
 *   receive `current` {time} = server-clock heartbeat (for clock sync)
 *   ackString containing "AuctionExtended" => soft-close extension just happened.
 *
 * Read-only: this never emits a bid. It only listens + subscribes + ACKs.
 */
class SpSocket {
  constructor({ token, carrierId, carrierIds, userId, onUpdate = () => {}, onLog = () => {},
    url = DEFAULT_SOCKET_URL, path = DEFAULT_SOCKET_PATH }) {
    this.token = token;
    // Socket origin + handshake path. These are DELIBERATELY two knobs, not one URL:
    // socket.io-client reads a URL's pathname as the NAMESPACE and takes the transport
    // endpoint from the separate `path` option. Passing 'https://host/api' as the url
    // would handshake at https://host/socket.io/ on namespace '/api' — wrong endpoint AND
    // wrong namespace. A white-label tenant serving wss://host/api/socket.io/ therefore
    // needs url='https://host' + path='/api/socket.io/'.
    // Both default to SP main, so an existing caller that passes neither is unchanged.
    this.url = String(url || DEFAULT_SOCKET_URL).replace(/\/+$/, '');
    this.path = String(path || DEFAULT_SOCKET_PATH);
    // The account's OWN carrier registration, kept as a scalar: the ACK's companyId ('C_' + carrierId)
    // and the connect-time fail-loud guard (realAdapter.connectSocket) are the identity of the LOGIN,
    // not of any per-load routed carrier.
    this.carrierId = carrierId;
    // Self-match SET: a bidListenerV2 row is OURS when its carrierId is in here. The login bids as its
    // own carrier PLUS any per-load registration it routes to (SP branchCarrierCarrierId) - e.g.
    // bidding@ (carrier 2667) placing a Havells bid as 5963. Matching a SINGLE id went BLIND the moment
    // we bid as a foreign carrier, so rank tracking silently froze on a load we were actively bidding
    // (and the engine can dump the floor on a load it is already winning). Seeded from the account
    // carrier; registerCarrier() adds each routed carrier as realAdapter.placeBid bids as it. Ids are
    // numeric-normalised so a string-vs-number carrierId can never miss a self-match.
    this.carrierIds = new Set();
    // Seed via registerCarrier so the null-guard + numeric-normalise live in exactly ONE place (no
    // second copy to drift out of sync on this rank-tracking-critical set).
    this.registerCarrier(carrierId);
    if (Array.isArray(carrierIds)) for (const c of carrierIds) this.registerCarrier(c);
    this.userId = userId;
    this.onUpdate = onUpdate;
    this.onLog = onLog;
    this.loads = new Map(); // loadId -> { myRank, myAmount, loadEndTimeMs, bids, extended, lastTs }
    // Warn throttles, concern -> last-warned ms. Time-boxed, not one-shot: this instance outlives
    // every reconnect (socket.io retries the same socket forever), so a permanent latch would
    // report a permanent fault exactly once per process - indistinguishable from it having cleared.
    this._warnThrottle = new Map();
    this.rooms = new Map();  // loadId -> isOpenAuction; replayed on every (re)connect
    this.clock = new ServerClockEstimator();
    this.serverOffsetMs = 0;
    this.socket = null;
  }

  /**
   * Register a carrier registration this login bids AS, so its own bidListenerV2 rows self-match and
   * rank tracking stays live. Called by realAdapter.placeBid every time a bid is routed to a per-load
   * carrier (SP branchCarrierCarrierId). Idempotent; numeric-normalised; ignores null/undefined so a
   * missing carrier can never poison the set with a 0/NaN that matches an unrelated row. Returns this.
   */
  registerCarrier(carrierId) {
    if (carrierId != null) this.carrierIds.add(Number(carrierId));
    return this;
  }

  /**
   * Warn at most once per concern per WARN_REARM_MS, to BOTH surfaces the socket already uses: the
   * ops log and the operator's dashboard event ring. Mirrors the loadEndTime rejection's pattern
   * (which latches per load); these throttle per socket because the concerns they cover - the clock
   * heartbeat - are properties of the connection, not of any one auction. Distinct concerns MUST
   * pass distinct keys: sharing one key means the first fault to fire hides every later one.
   */
  _warnThrottled(key, message) {
    const last = this._warnThrottle.get(key);
    const now = Date.now();
    if (last != null && now - last < WARN_REARM_MS) return;
    this._warnThrottle.set(key, now);
    try { this.onLog(message); } catch (_) {}
    log.warn(message, { carrierId: this.carrierId });
  }

  /**
   * The `current` clock heartbeat - a NAMED handler, like _onBid, so it is reachable without
   * opening a websocket.
   *
   * Coerce, reject anything that is not a usable timestamp, normalise seconds to ms, and accept
   * only a plausible skew - the same normaliser the REST twin runs (src/util/serverClock.js). Two
   * things make an unguarded read HERE worse than an ordinary one:
   *
   *   1. IT IS THE REFERENCE CLOCK THE PLACEHOLDER GUARD MEASURES AGAINST. The loadEndTime check is
   *      `t - this.serverNow() > PLAUSIBLE_END_HORIZON_MS`. Poison the offset forward and a
   *      year-2100 close passes the very guard built to catch it.
   *   2. IT IS PER-SOCKET, NOT PER-LOAD. `if (p && p.time)` is truthy for a STRING, and
   *      `'2026-...' - Date.now()` is NaN, so serverNow() goes NaN for EVERY load this socket
   *      watches at once. closesInMs then returns NaN rather than null - which does NOT trip the
   *      adapter's `== null` skip - reads as status 'live', and falls through _phase to 'closing'
   *      on every watched auction simultaneously.
   *
   * No bad frame has ever been observed; this is an unexercised hole, not a live incident. A
   * rejected frame is a NO-OP, never a zeroing and never a throw: the previous offset is a better
   * estimate than anything derived from a frame we just refused, and the system clock (offset 0) is
   * the correct fallback when there has never been a good one.
   */
  _onClock(p) {
    // FALSY skip, not `!= null`: a keepalive carrying 0 or '' is an absent reading, and the frames
    // that carry one repeat. Diagnosing it as a ~56-year skew would be both wrong and loud.
    if (!p || !p.time) return;
    const now = Date.now();
    const r = normalizeServerOffset(p.time, now);
    if (r.ok) {
      // Pooled with the recent heartbeats, never adopted alone: one queued behind a stalled event loop
      // reads seconds late, and every load on this socket inherits it (Durian 25635492: 2,741 ms late,
      // the floor refused after the close).
      this.clock.addSample(r.offsetMs, now, readingResolutionMs(p.time));
      this.serverOffsetMs = this.clock.offsetMs();
      return;
    }
    if (r.reason === 'skew') {
      this._warnThrottled('clock:skew', `socket clock heartbeat skew ${Math.round(r.offsetMs / 1000)}s is implausible; keeping the previous offset`);
    } else {
      this._warnThrottled('clock:unusable', 'socket clock heartbeat was not a usable timestamp; keeping the previous offset');
    }
  }

  connect() {
    return new Promise((resolve) => {
      const s = io(this.url, {
        path: this.path,
        transports: ['websocket'],
        reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000,
        auth: { token: 'Bearer ' + this.token },
        extraHeaders: { Cookie: 'token=' + this.token },
      });
      this.socket = s;
      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      s.on('connect', () => {
        this.onLog('socket connected (' + s.id + ')');
        log.info('socket connected', { socketId: s.id, carrierId: this.carrierId });
        s.emit('join_v2', 'Bearer ' + this.token);
        // Re-subscribe every watched room: a reconnect lands on a fresh server-side socket in NO
        // rooms, so without this replay the rank feed dies silently (myRank frozen pre-blip).
        for (const [id, isOpen] of this.rooms) s.emit('auctionStart', { loadId: Number(id), isOpenAuction: isOpen ? 1 : 0 });
        done();
      });
      s.on('connect_error', (e) => {
        this.onLog('connect_error: ' + (e && e.message));
        log.warn('socket connect_error', { carrierId: this.carrierId, err: e });
      });
      s.on('disconnect', (r) => {
        this.onLog('socket disconnect: ' + r);
        log.warn('socket disconnected', { carrierId: this.carrierId, reason: r });
      });
      s.on('error', (e) => {
        this.onLog('socket error: ' + (e && e.message));
        log.error('socket error', { carrierId: this.carrierId, err: e });
      });
      // The clock heartbeat. Why it is guarded, and what a rejected frame does: see _onClock.
      s.on('current', (p) => this._onClock(p));
      s.on('bidListenerV2', (p) => this._onBid(p));
      s.on('refreshLoad', () => {});
      // Manager-level reconnection lifecycle (socket.io-client v4 emits these on the
      // Manager — s.io — not on the Socket itself). Reconnection is enabled above with
      // unlimited attempts, so these are the only signal an operator gets in the logs
      // that a drop is being retried, and how many times, versus dropped and abandoned.
      s.io.on('reconnect_attempt', (attempt) => log.debug('socket reconnect attempt', { carrierId: this.carrierId, attempt }));
      s.io.on('reconnect', (attempt) => log.info('socket reconnected', { carrierId: this.carrierId, attempt }));
      s.io.on('reconnect_error', (e) => log.warn('socket reconnect_error', { carrierId: this.carrierId, err: e }));
      s.io.on('reconnect_failed', () => log.error('socket reconnect_failed', { carrierId: this.carrierId }));
      setTimeout(done, 9000); // resolve anyway so callers proceed
    });
  }

  _onBid(p) {
    if (!p || p.loadId == null) return;
    const loadId = Number(p.loadId);
    const bids = Array.isArray(p.bids) ? p.bids : [];
    // OURS = any row whose carrierId is one this login bids as (own carrier + routed per-load
    // carriers). A row with a null/absent carrierId is never ours - guard it explicitly so a
    // Number(null) === 0 can never sneak in as a match; the set only ever holds real non-null ids.
    const mine = bids.filter((b) => b && b.carrierId != null && this.carrierIds.has(Number(b.carrierId)));
    const active = mine.find((b) => b.isActive === 1) || mine[0] || null;

    const cur = this.loads.get(loadId) || {};
    if (active) { cur.myRank = active.rank; cur.myAmount = active.amount; }
    // Guarded the same way parseRetryAfterMs (realAdapter.js) already guards its own
    // Date.parse: a garbage/unparseable loadEndTime must not silently become NaN here -
    // Math.max(0, NaN) in closesInMs() below is itself NaN, which would look like "no
    // countdown" everywhere it's read rather than erroring loudly.
    //
    // PLAUSIBILITY BOUND (L3 G5/F6): the socket loadEndTime was ONLY NaN-guarded, so a soft-close
    // extension (or a stale/spoofed frame) carrying a year-2100-class close would be trusted verbatim
    // and drive the live countdown - the same class of bug the REST path guards against at its own map
    // boundary. Bound it here off the socket's own server clock with a 30d FORWARD horizon
    // (PLAUSIBLE_END_HORIZON_MS): REJECT a close beyond now + 30d - keep the last plausible
    // loadEndTimeMs (fail closed) and alert once. SuperProcure structurally cannot return a real auction
    // close 30d out, so a beyond-horizon value is provably the placeholder, not merely suspicious. A
    // past/nearer close is left to flow through: a stale past close just reads as closesInMs 0 (closing),
    // itself fail-safe. This is the socket-layer half of L3's "believed close moves forward only on a
    // PLAUSIBLE confirmation" rule.
    if (p.fieldsToBeUpdated && p.fieldsToBeUpdated.loadEndTime) {
      const t = Date.parse(p.fieldsToBeUpdated.loadEndTime);
      if (Number.isNaN(t)) {
        // unparseable: keep the prior value (see the NaN rationale above)
      } else if (t - this.serverNow() > PLAUSIBLE_END_HORIZON_MS) {
        // The parseable year-2100 placeholder. Because closesInMs() prefers the socket's
        // value over the REST meta fallback, accepting one such frame freezes the engine's
        // countdown decades out: the monitor never leaves the far poll phase, the establish
        // rung never unlocks, and an otherwise-correct auction silently gets ZERO bids
        // (OA 23075092 Jul 12, OA 23088090 Jul 13 - docs/diagnoses/2026-07-13_*.md). Drop
        // the frame's value so the trustworthy discovery closesAt keeps the countdown, and
        // say so once per load (frames repeat every few seconds; one line is the signal).
        if (!cur.endTimeRejectedWarned) {
          cur.endTimeRejectedWarned = true;
          // L3 T5: mirror the rejection onto the operator's dashboard event ring (onLog), not
          // just the ops log - a soft-close extension carrying a year-2100 close is the signal
          // that SP pushed a placeholder mid-auction. Deduped by the same per-load latch, so
          // the repeating frames never spam the UI ring.
          this.onLog('rejected implausible loadEndTime (beyond +30d horizon): ' + p.fieldsToBeUpdated.loadEndTime);
          log.warn('socket loadEndTime beyond plausibility horizon - ignoring placeholder', {
            loadId, loadEndTime: p.fieldsToBeUpdated.loadEndTime, horizonDays: 30 });
        }
      } else {
        cur.loadEndTimeMs = t;
      }
    }
    cur.bids = bids;
    // LATCH: once an anti-snipe extension is seen the load is soft-close for good. Recomputing
    // this per frame (extension frames are the exception, not every frame) made `extended` flap
    // true->false, so closeModel oscillated soft->hard and a still-extending auction could finalize
    // on a transient zero. Sticky, matching snipeHarness.js's `if (st.extended) closeModel='soft'`.
    cur.extended = cur.extended || /AuctionExtended/i.test(p.ackString || '');
    cur.lastTs = Date.now();
    this.loads.set(loadId, cur);

    // ACK back (mirrors the real client)
    if (p.ackString && this.socket) {
      this.socket.emit('bidListenerV2_ACK', {
        ackString: p.ackString, companyId: 'C_' + this.carrierId, userId: this.userId, latency: 0,
      });
    }
    this.onUpdate(loadId, cur, p);
  }

  /** Subscribe to a load's auction room (remembered, so a reconnect re-subscribes it). */
  watch(loadId, isOpenAuction = 0) {
    this.rooms.set(Number(loadId), isOpenAuction ? 1 : 0);
    if (this.socket) this.socket.emit('auctionStart', { loadId: Number(loadId), isOpenAuction: isOpenAuction ? 1 : 0 });
  }

  /** A measured round trip to SuperProcure; half the smallest recent one corrects every heartbeat. */
  noteRoundTrip(rttMs) {
    this.clock.addRoundTrip(rttMs, Date.now());
    const off = this.clock.offsetMs();
    if (off != null) this.serverOffsetMs = off;
  }

  /** Bound on how far serverNow() may be from SuperProcure's clock; null before any heartbeat. */
  clockErrorMs() { return this.clock.errorMs(Date.now()); }

  serverNow() { return Date.now() + this.serverOffsetMs; }
  state(loadId) { return this.loads.get(Number(loadId)) || null; }
  closesInMs(loadId, fallbackCloseMs) {
    const s = this.loads.get(Number(loadId));
    const end = (s && s.loadEndTimeMs) || fallbackCloseMs;
    return end ? Math.max(0, end - this.serverNow()) : null;
  }
  close() { if (this.socket) this.socket.close(); }
}

module.exports = { SpSocket, PLAUSIBLE_END_HORIZON_MS, DEFAULT_SOCKET_URL, DEFAULT_SOCKET_PATH };
