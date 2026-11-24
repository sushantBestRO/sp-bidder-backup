'use strict';

const { PlatformAdapter } = require('./adapter');
const { SpSocket, DEFAULT_SOCKET_URL } = require('./spSocket');
const { parseHMS, assertAboveFloor, plausibleCeiling, assertBelowCeiling } = require('../engine/pricing');
const { deriveLoadRules, assertRulesSupported, assertTransitSatisfied, normalizeTransitDays } = require('../model/loadRules');
const { normalizeUnit } = require('../model/rulesConstants');
const { normalizePhoneIN } = require('../model/normalizePhone');
const { numericOrNull } = require('../util/numericOrNull');
const { roundTripServerOffset } = require('../util/serverClock');
const { portalFetch } = require('./portalFetch');
const { readSpDimensions, ownsSpDetail } = require('./spCargo');
const { createLogger } = require('../logging/logger');

/**
 * RealSuperProcureAdapter — the live integration, built from the recon
 * (see SUPERPROCURE_API.md). READ paths are implemented and used by BidPilot's
 * "Connect" flow. The WRITE path (placeBid) is guarded by `writeEnabled` — a
 * defensive backstop the engine's kill-switch lowers to hard-stop bidding. The
 * read-only "Connect" flow never calls placeBid, so connecting can never bid.
 *
 * Auth: a Bearer JWT (valid ~1yr on SP main). Data API: https://api.superprocure.com/sp/...
 * Live channel: socket.io (join_v2 + Bearer) — wired later for live rank.
 *
 * MULTI-TENANT: SuperProcure also ships WHITE-LABEL deployments on a customer's own
 * host (e.g. Rallis on https://logistics.tatachemicals.com/api, where an extra `/api`
 * sits before `/sp/...`). Same product, same wire shapes, same Bearer auth — only the
 * origin and path prefix move. The tenant is therefore a per-ACCOUNT fact carried on
 * the account record, NOT a process-wide config: one process can serve SP main and a
 * white-label tenant at once. Every tenant knob defaults to SP main, so an account
 * record that says nothing keeps today's exact behaviour.
 */

// SP main. Also the default for every account that does not name a tenant.
const DEFAULT_API_BASE = 'https://api.superprocure.com';
// The browser origin the operator UI is served from, sent as origin/referer. NOT derivable
// from DEFAULT_API_BASE by string surgery: SP main is api.* -> app.* (different subdomain),
// while a white-label tenant serves the app and the API off the SAME host. No single rule
// generates both, so this is its own knob.
const DEFAULT_WEB_ORIGIN = 'https://app.superprocure.com';

// Operational logger for this adapter — login/session lifecycle, the connectSocket()
// setup, and bid-write timing. This is distinct from BidLogger's business-outcome
// record: it captures HOW the platform call behaved (latency, HTTP status, connection
// state), never the auction/bid decision itself, and never the credential.
const log = createLogger('platform');

/**
 * Browser fingerprint for the hot path. COHERENCE across UA + Client-Hints +
 * Sec-Fetch is what matters — a UA-vs-hints mismatch is itself a detection flag —
 * so everything is derived from ONE Chrome major and can't drift. These are
 * constructed-coherent DEFAULTS; the authoritative move is to drop in the headers
 * CAPTURED from one real SuperProcure SPA request (constructor `headers`, or env
 * SP_CAPTURED_HEADERS). We deliberately do NOT mimic the TLS fingerprint (JA4):
 * it's the dominant signal for a non-browser client but is unfixable at the app
 * layer, and over-building it on BRL's own legitimate account is out of scope
 * unless blocking is actually observed. See
 * _research/2026-06-23_anti-detection-429-impl-notes.md.
 */
const CHROME_MAJOR = 126;
const BROWSER = {
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`,
  secChUa: `"Not/A)Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`,
  secChUaMobile: '?0',
  secChUaPlatform: '"Windows"',
  acceptLanguage: 'en-US,en;q=0.9',
};

// Plausibility bound on a parsed close/start time (boundedParse below), and the single
// source of truth src/pricing/priceRequests.js's expireOverdue imports (as
// MAX_PLAUSIBLE_DEADLINE_MS) rather than re-declaring. SuperProcure structurally cannot
// return a load outside listAuctions()'s own +/-7/14-day query window, so anything a
// load's own close time parses to further out than this (generous) bound is provably
// bad - either the shared year-2100 placeholder biddingOn:0 loads carry instead of null
// (observed live 2026-07-11), or a malformed biddingOn:1 date - never a real auction.
// Keeping this as ONE imported constant (not a hand-synced copy) is what lets
// priceRequests.js's Bug-2 guarantee - "a load that cleared this gate is never falsely
// expired" - hold structurally instead of by comment; see test-allowlist-and-prune.js's
// cross-module pin.
const MAX_PLAUSIBLE_DEADLINE_MS = 30 * 86_400_000;

const ymd = (d) => d.toISOString().slice(0, 10);

/** Parse Retry-After (RFC 9110 §10.2.3): delta-seconds first, else an HTTP-date. */
function parseRetryAfterMs(headerVal, nowMs) {
  if (headerVal == null) return null;
  const s = String(headerVal).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;     // delta-seconds
  const t = Date.parse(s);                           // HTTP-date
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

/** Parse a captured-headers JSON override (constructor arg or SP_CAPTURED_HEADERS). */
function parseCapturedHeaders(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (_) { return null; }
}

/** loadingPoints is a JSON string of point objects {shortName, isLoadingPoint}. */
function parseLane(s) {
  try {
    const pts = JSON.parse(s);
    if (Array.isArray(pts) && pts.length) {
      const load = pts.find((p) => p.isLoadingPoint === 1) || pts[0];
      const unload = [...pts].reverse().find((p) => p.isLoadingPoint === 0) || pts[pts.length - 1];
      const nm = (p) => (p && (p.shortName || p.longName)) || '?';
      return { origin: nm(load), destination: nm(unload) };
    }
  } catch (_) {}
  return { origin: '?', destination: '?' };
}

/**
 * Full loading/unloading detail from the same JSON blob parseLane reads. Each point on
 * /sp/loads/v4 carries (confirmed in the captured payloads): `shortName` (the city the
 * lane string shows), `longName` (place + state + often the pincode, e.g. "KOTTAYAM,
 * Kerala 686122, IN"), `pin`, and `companyName`/`client` (the party, which for drop
 * points frequently embeds the full street address). `isLoadingPoint` 1 = pickup,
 * 0 = drop; the array can hold multiple points. Compose the fullest address each point
 * carries ONCE here, dropping parts already contained in another (longName usually
 * repeats shortName/pin), so every surface renders the same string. Returns null when
 * the payload has no parseable points (sim/mock loads) - callers fall back to `lane`.
 */
function parsePoints(s) {
  try {
    const pts = JSON.parse(s);
    if (!Array.isArray(pts) || !pts.length) return null;
    const mapped = pts.map((p) => {
      const raw = [p && (p.companyName || p.client), p && p.shortName, p && p.longName, p && p.pin]
        .map((x) => (x == null ? '' : String(x).trim()))
        .filter(Boolean);
      // drop a part when another part already contains it (keep the first of exact duplicates)
      const parts = raw.filter((t, i) => !raw.some((o, j) => j !== i
        && o.toLowerCase().includes(t.toLowerCase())
        && (o.length > t.length || j < i)));
      return {
        kind: p && p.isLoadingPoint === 1 ? 'pickup' : 'drop',
        address: parts.join(', '),
      };
    }).filter((p) => p.address); // an all-empty point renders nothing, not "?"
    return mapped.length ? mapped : null;
  } catch (_) {}
  return null;
}

/**
 * The load's `notes` field (the shipper's note/instructions on /sp/loads/v4 — confirmed
 * in the captured payloads) arrives as rich-text HTML (<p>/<br>/<strong>...). Flatten it
 * to readable plain text here, once, so every surface (console, capture page, worklist)
 * renders it safely without carrying markup around. Returns null when there is nothing.
 */
function htmlToText(html) {
  if (html == null) return null;
  const s = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&') // decode last so "&amp;lt;" can't double-decode
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s || null;
}

/**
 * The load's QUOTE TYPE (the pricing basis SuperProcure ranks on), normalized.
 *
 * 'FTL' = "Quote Per Vehicle" (amount is rupees per truck; `vehicleCount` is a real truck count);
 * 'PMT' = "Quote Per MT" (amount is quoted against a per-tonne basis; `vehicleCount` is the
 * MT/KG QUANTITY, NOT a truck count). This is NOT `loadShipmentType`, and that distinction is a
 * money trap: on a PMT load SuperProcure still reports loadShipmentType:"FTL" while
 * branchQuoteType/rateType say "PMT" (verified live on load 23122869, Goodluck: branchQuoteType
 * "PMT", rateType "PMT", loadShipmentType "FTL", vehicleCount 30 = 30 MT on one truck; and again
 * on the 2026-07-16 board probe where Vishal Pipes carried branchQuoteType "PMT", vehicleCount 22).
 * So anything that needs the pricing basis - notably the multi-vehicle count fix, which may only
 * read `vehicleCount` as a truck count on an FTL load - must read THIS, never shipmentType.
 *
 * null when SuperProcure sent neither field (never observed across the 5,532-load census);
 * callers treat null as "basis unknown", not as FTL. (Predicate: src/discovery/discovery.js
 * isMultiVehicle.)
 */
function normQuoteType(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  return s || null;
}

/**
 * The `vcq` invariant, asserted at bid-payload-build time - the same discipline as the cost
 * floor (assertAboveFloor in engine/pricing.js), so a bad count can never leave the building.
 *
 * `vcq` is the vehicle-count field on the createV2 wire. It is EITHER:
 *   -1  the PROVEN sentinel for a single/unspecified/PMT bid. SuperProcure normalizes it to
 *       bidVehicleCount:1 on a single-vehicle FTL read-back, and it is what every winning bid to
 *       date (SIKA, Syngenta, Durian) has sent. It MUST keep passing - do NOT "harden" the -1
 *       default away (that would change a proven wire and break the golden byte-identity pins).
 *   N   a POSITIVE INTEGER truck count, only set on a genuine FTL multi-vehicle load (Layer B).
 * Anything else - 0, NaN, a fraction, or a negative other than -1 - is a bug (a forgotten field,
 * a Math.max(1, NaN) slip, a mis-derived count) and must throw BEFORE the bid is sent, so it
 * degrades to "no bid" rather than a dead "-1 vehicles" quote or a nonsense count on live money.
 */
function assertValidVcq(vcq) {
  const ok = vcq === -1 || (Number.isInteger(vcq) && vcq >= 1);
  if (!ok) {
    const e = new Error(`invalid vcq ${JSON.stringify(vcq)}: must be -1 (sentinel) or a positive integer vehicle count`);
    e.code = 'VCQ';
    throw e;
  }
  return vcq;
}

/**
 * THERE IS NO PER-TONNE WIRE CONVERSION. A PMT ("Quote Per MT") createV2 carries the BARE PER-MT
 * RATE in `amount`, byte-identical in shape to the flat path, and SuperProcure MULTIPLIES it by the
 * per-vehicle tonnage server-side to derive the total it stores.
 *
 * SETTLED 2026-08-05 from a captured desk WRITE on PMT load 23828313
 * (_research/2026-08-05_pmt-createv2-capture-SETTLED.md): the browser sent `amount: 2240`; SP stored
 * `amount 33600`, `amountPMT 2240`, `bidRate 2240`, `bidQuantity 30`, `bidVehicleCount 2`
 * (33600 = 2240 x 15, and 15 = 30/2 = the PER-VEHICLE tonnage). Our number comes back verbatim on
 * amountPMT and bidRate; the multiplied total is SP's own derivation, not our input.
 *
 * A `pmtWireTotal(rate, tonnage)` helper used to live here and #88 multiplied by it on the write
 * path. That was an INFERENCE, never an observation: the readback it rested on
 * (_research/2026-07-25_pmt-wire-semantics-readback.md) measured only SP's STORED amount and assumed
 * the stored value echoes what the browser sent - true on FTL, where the rate and the total are the
 * same number, and false on PMT. Multiplying here makes SP multiply a SECOND time, so a Rs 2,240/MT
 * intent on a 22 MT load is recorded as Rs 49,280/MT: an overbid that scales with tonnage. Do not
 * reintroduce it, and do not "restore" the tonnage multiplier from the readback doc - its DATA is
 * correct and its direction was backwards.
 *
 * Consequence for the floor: because the wire amount is per-MT, the wire-space floor stays per-MT
 * too, so assertAboveFloor compares the desk's own units on both sides with no conversion at all
 * (see buildBidPayload). The conversion that could desync the two operands no longer exists.
 */

function collectBranchIds(h) {
  // branchList is an OBJECT keyed by branchId; each value also has .branchId.
  // transactionCreateBranchList is similarly keyed. (carrierBranches = carrier ids, not branches.)
  const out = new Set();
  const scanObj = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      const n = Number(k);
      if (Number.isFinite(n) && n > 0) out.add(n);
      const v = o[k];
      if (v && typeof v === 'object' && typeof v.branchId === 'number') out.add(v.branchId);
    }
  };
  scanObj(h && h.branchList);
  scanObj(h && h.transactionCreateBranchList);
  return [...out];
}

/**
 * The same branchList, kept rather than reduced to integers. getHeader already carries the branch
 * NAME and its customer (`freighterName`); discarding them is why nobody could answer "which login
 * sees Havells?" without an SSH session while four customers sat dark for 27 hours on 2026-09-18.
 *
 * `bidPermission` is captured and never classified on: it read 2 on 339 of 339 branches sampled
 * across five accounts (2026-09-19), so it carries no information today. Kept so the day it varies
 * is visible rather than invented.
 */
function collectBranches(h) {
  const bl = (h && h.branchList) || {};
  const out = [];
  for (const v of Object.values(bl)) {
    if (!v || typeof v !== 'object' || typeof v.branchId !== 'number') continue;
    const perm = v.permissions && v.permissions.procurement && v.permissions.procurement.bid;
    out.push({
      branchId: v.branchId,
      name: String(v.branchName || '').trim() || String(v.label || '').trim(),
      customer: String(v.freighterName || '').trim(),
      bidPermission: typeof perm === 'number' ? perm : null,
    });
  }
  return out;
}

const V4_PAGE = 5000;
const LIVE_RANK_MIN_GAP_MS = 1000;

/**
 * Our settled position per load from a /sp/loads/v4 response: loadId -> { rank, amount }, or null
 * for a listed load where we hold no active row with a whole rank. A row is ours when its
 * bidCarrierId is one of `carrierIds` or the load's own branchCarrierCarrierId (the routed
 * registration we bid as).
 */
function settledFromV4(d, { carrierIds = [] } = {}) {
  const out = new Map();
  const loadCarrier = new Map();
  for (const l of (d && Array.isArray(d.loadDetails) ? d.loadDetails : [])) {
    if (!l || l.id == null) continue;
    out.set(String(l.id), null);
    if (l.branchCarrierCarrierId != null) loadCarrier.set(String(l.id), Number(l.branchCarrierCarrierId));
  }
  const own = new Set(carrierIds.filter((c) => c != null).map(Number));
  for (const b of (d && Array.isArray(d.bidDetails) ? d.bidDetails : [])) {
    if (!b || b.load == null || b.isActive !== 1 || b.bidCarrierId == null) continue;
    const id = String(b.load);
    const carrier = Number(b.bidCarrierId);
    if (!own.has(carrier) && loadCarrier.get(id) !== carrier) continue;
    const rank = b.rank == null ? NaN : Number(b.rank);
    const prev = out.get(id) || null;
    if (!Number.isInteger(rank) || rank < 1) { if (!out.has(id)) out.set(id, null); continue; }
    if (prev && prev.rank <= rank) continue;
    const amount = Number(b.amount);
    out.set(id, { rank, amount: b.amount != null && Number.isFinite(amount) ? amount : null });
  }
  return out;
}

class RealSuperProcureAdapter extends PlatformAdapter {
  constructor({ token, sock = null, assumedRttMs = 200, headers = null, fetchImpl, sleep, rand,
    accountId = null, accountLabel = null, onAuthDead = null, onAuthRestored = null,
    apiBaseUrl = DEFAULT_API_BASE, webOrigin = DEFAULT_WEB_ORIGIN,
    socketUrl = null, socketPath = null, authProbeEnabled = true, inheritedEpisodeSince = null,
    setTimeoutImpl = null, clearTimeoutImpl = null,
    sizeDetailTtlMs = 5 * 60_000, maxSizeDetailFetchesPerList = 3 } = {}) {
    super();
    this.token = token;
    // Tenant knobs. The `|| DEFAULT` inside is load-bearing and is NOT redundant with the
    // destructuring default above: a destructuring default fires only on `undefined`, and
    // account records normalise absent optional fields to `null` (see auth/accounts.js).
    // Without it, `String(null)` yields the literal 'null' and every request goes to
    // `null/sp/loads/v4` — a relative-URL throw that _request's catch turns into status 0,
    // i.e. silent total blindness that reads as "SuperProcure is down". Belt and braces.
    this.apiBaseUrl = String(apiBaseUrl || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.webOrigin = String(webOrigin || DEFAULT_WEB_ORIGIN).replace(/\/+$/, '');
    // Socket origin defaults to the REST origin's scheme+host (NOT the full apiBaseUrl —
    // a path there would be read by socket.io as a NAMESPACE, not as the handshake path).
    this.socketUrl = socketUrl || null;
    this.socketPath = socketPath || null;
    this.account = null;
    this.serverTimeOffsetMs = 0;
    this.serverTimeErrorMs = null;
    this.writeEnabled = true; // real mode always bids; the engine's kill-switch lowers this backstop

    // === THE SESSION-AUTH STATE MACHINE ===========================================================
    //
    // WRITTEN AS A MODEL, ON PURPOSE, IN ONE PLACE. Three fix rounds each violated a pairwise
    // invariant that lived somewhere else, because the legal states and the legal transitions were
    // never written down together - they existed only as prose spread across nine fields and three
    // layers (this adapter, the engine, the composition root). This block is that one place.
    // Anything below, or in bidEngine.js / server.js, that contradicts it is the bug.
    //
    // ---- STATES. `authState()` is DERIVED on every read, never a stored enum. --------------------
    //
    //   CLEAR    nothing is known to be wrong. Reads and writes both flow.
    //   LATCHED  SuperProcure refused authenticated calls (401/403) often enough to believe it.
    //            Reads still flow. Writes are held except ONE TRIAL per authWriteTrialIntervalMs -
    //            the only way the proof of recovery can ever be obtained.
    //   EXPIRED  this token is at or past its own `exp`. Reads AND writes are held and NOTHING
    //            reaches the wire: no trial, no probe.
    //
    // EXPIRED DOMINATES LATCHED. Deriving the state from (tokenExp, now, _latchedSince) rather than
    // storing it is structural, not stylistic: a derived state cannot be left wrong by a missed
    // transition and cannot get stuck independently of its own cause, which is how the stored flag
    // this replaces failed.
    //
    // WHY LATCHED DOES NOT SEAL READS. The only thing that clears LATCHED is a proven write; a write
    // needs an armed load; an armed load needs discovery; discovery is a read. Sealing reads is a
    // deadlock that outlives SuperProcure's own recovery. A read costs nothing that was not already
    // being spent (discovery polls every 30s regardless) and a read that 401s feeds the read streak.
    //
    // WHY EXPIRED DOES SEAL READS. There is no deadlock to create - no local behaviour can un-lapse a
    // JWT, so a read is pure wasted traffic on a shared, anti-detection-sensitive account. Recovery
    // is a NEW TOKEN, which means a new adapter, which clears everything for free. The alert loop is
    // fed by discovery's own polling regardless: each poll takes the synthetic refusal below and
    // drives the bounded re-offer without touching the wire.
    //
    // ---- CAPABILITY STREAKS: TWO, NOT ONE -------------------------------------------------------
    //
    // Reads and writes are SEPARATELY REVOCABLE, so a single shared streak cannot protect both
    // directions at once - reset it on any success and a write-scope revocation can never latch;
    // reset it only on a write and a healthy read path can never clear it. Both horns have been
    // taken by a previous version of this code; neither is theoretical.
    //
    //   _readStreak   incremented by a READ auth-refusal; reset by a READ success (login()) AND by
    //                 an accepted write.
    //   _writeStreak  incremented by a WRITE auth-refusal; reset ONLY by an accepted write.
    //
    // Either streak reaching authLatchThreshold within authStreakWindowMs latches the account.
    //
    // A READ 200 BETWEEN TWO WRITE 401s DOES NOT PROTECT THE WRITE STREAK, and that is deliberate:
    // that sequence is the SIGNATURE of write-scope revocation, not evidence against it. "Reset the
    // streak on any success" would make the one shape the trial write exists for unlatchable.
    //
    // ---- EPISODE: the outage identity, and the ONLY alert identity ------------------------------
    //
    // `_episodeSince` opens at the first latch/expiry when no episode is open, and closes ONLY when
    // the all-clear is ACTUALLY EMITTED. Not on a latch clear, not on a timer, not on a reconnect.
    //   - the down-alert's dedupe key IS the episode id. One message per episode; the 15-min re-offer
    //     is a DELIVERY retry rather than a second message - see _maybeReRaiseDown.
    //   - the engine's zero-bid suppression bound measures from the episode, so a flap cannot rewind
    //     it, and a genuinely new episode gets a fresh full budget instead of a spent one.
    //
    // THE ALL-CLEAR IS DEBOUNCED ON THE RESOLVE EDGE, NOT THE TRIP EDGE. Reaching CLEAR with an
    // episode open ARMS a timer for authSettleMs; a re-latch inside that window CANCELS a message
    // that was never sent. A flap therefore cannot collide with an already-delivered all-clear -
    // that collision class is structurally absent rather than guarded against.
    //
    // ---- RECOVERY PROOF: exactly one standard, at every layer ------------------------------------
    //
    // AN ACCEPTED WRITE. Nothing else, nowhere. login() is two GETs and proves only that the token
    // authenticates. The COMPOSITION ROOT has no independent authority either: a reconnect inherits
    // the open episode (`inheritedEpisodeSince`) and says "confirming", not "back online", and the
    // fresh adapter closes that episode through this same accepted-write path.
    //
    // ---- DISCARD ---------------------------------------------------------------------------------
    //
    // discard() is the single chokepoint. Every _note* entry point early-returns once it is set, so a
    // write still in flight when a stack is torn down can neither latch a dead adapter, re-arm its
    // probe, emit an all-clear, nor write into a newer outage's bookkeeping.
    //
    // ---- WHY THE STATE LIVES HERE ----------------------------------------------------------------
    //
    // It is a property of the SESSION, the session IS the token, and the token lives here. Nothing
    // else in the process is 1:1 with a SuperProcure session. It is deliberately NOT persisted: a
    // restart is a fresh login and a reconnect builds a fresh adapter, so both clear it for free,
    // while a persisted latch would only ever be a stuck-latch generator.

    // When the CURRENT latch began (ms epoch), or null when not latched. This is the latch's own
    // instant - it is NOT an identity and nothing alert-facing or clock-facing may key off it.
    this._latchedSince = null;
    // THE EPISODE. See the model above. Seeded from an outstanding down-alert when the composition
    // root rebuilds a stack mid-outage, so a reconnect inherits the outage instead of forgetting it.
    this._episodeSince = Number.isFinite(inheritedEpisodeSince) ? inheritedEpisodeSince : null;
    // WHEN THIS INSTANCE INHERITED THAT EPISODE - null on an adapter that opened its own.
    //
    // An inherited episode is a CLAIM about somebody else's outage, and this adapter has observed
    // nothing of its own to support it. The claim is honest right after a reconnect (the outage
    // really is still open; that is why the mark was there) and it stops being honest once this
    // adapter has run healthily for a while without either closing the episode (a proven write) or
    // re-confirming it (an auth failure of its own). See _expireStaleInheritedEpisode for what goes
    // wrong when it is allowed to absorb a new outage indefinitely.
    //
    // Deliberately the INHERIT instant rather than the episode instant: an outage a human reconnects
    // 40 minutes in hands over an episode that is already older than any bound worth setting, and
    // that reconnect must still be able to carry it.
    this._episodeInheritedAt = this._episodeSince != null ? Date.now() : null;
    // How long an inherited-but-unconfirmed episode may still absorb a NEW latch/expiry on this
    // adapter. Matched to authDeadReAlertMs below by intent, not by coincidence: that is already this
    // file's unit of "how long a desk waits to hear about an outage again", and a same-outage
    // reconnect re-latches within its first couple of write attempts, not a quarter of an hour later.
    this.authInheritedEpisodeConfirmMs = 15 * 60_000;
    // The armed, not-yet-fired all-clear. Non-null means "CLEAR is holding and the resolve is
    // pending"; any re-latch clears it and the message is never sent.
    this._resolveTimer = null;
    // WHEN RECOVERY WAS PROVEN - the instant of the accepted write that started the settle window,
    // not the instant the message goes out. It is what the desk's "down for N minutes" is measured to
    // (see _emitAllClear). Cleared with the pending message by _cancelResolve, because a re-latch
    // invalidates the proof as well as the message.
    this._recoveredAt = null;
    // How long the adapter must hold CLEAR before the all-clear is emitted and the episode closes.
    // Two trial intervals: long enough that a session flapping on the trial cadence never emits, and
    // short enough that a real recovery reaches the desk while it still matters.
    this.authSettleMs = 180_000;
    // Earliest instant at which the next TRIAL WRITE may reach the wire, or null when not latched.
    // Set to `now + authWriteTrialIntervalMs` at the latch (a trial the instant we latch would only
    // re-prove the two failures we just saw) and again each time a trial is actually spent.
    this._trialDueAt = null;
    // The trial cadence: the interval at which a latched account is willing to spend ONE refused
    // write to find out whether it can bid again. Deliberately NOT operator-tunable - shortening it
    // is a request-profile cost on a live shared account, lengthening it is recovery latency on live
    // money. Coupled to authProbeIntervalMs by intent; scripts/test-auth-boundaries.js pins that.
    this.authWriteTrialIntervalMs = 90_000;
    // The two capability streaks and their own last-observation clocks. Separate clocks matter as
    // much as separate counters: windowing a write streak off a read's timestamp would let a busy
    // read path hold a stale write observation alive indefinitely.
    this._readStreak = 0;
    this._lastReadFailureAt = null;
    this._writeStreak = 0;
    this._lastWriteFailureAt = null;
    // Two observations WITHIN THIS WINDOW, so one spurious 401 - a transient edge-node blip, a
    // mid-rotation race - can never stop an entire account: a second observation this long after the
    // first is a fresh first observation, not a confirmation. 60s is generous against the surfaces
    // that actually produce back-to-back auth responses (a 200ms hot tick, a 30s discovery poll) and
    // still latches inside ~60s on a genuine revocation - in the measured incident the second
    // observation arrived inside the same second.
    this.authStreakWindowMs = 60_000;
    this.authLatchThreshold = 2;
    // How close to `exp` the GRACE band starts. Inside it a write is refused WITHOUT counting as an
    // auth failure - see _tokenPhase for the three-case split, and for why conflating any two of them
    // has already shipped a confirmed defect in both directions.
    this.tokenGraceMs = 60_000;
    // Liveness-heartbeat cadence. NOT a self-heal - see _startAuthProbe.
    this.authProbeIntervalMs = 90_000;
    this._authProbeTimer = null;
    // THE PROBE CEILING. EXPIRED stops probing outright because re-authenticating a provably dead
    // credential is pure wasted traffic on a shared, anti-detection-sensitive account; LATCHED had no
    // equivalent and re-armed forever, which is the same traffic under the state a genuine ongoing
    // revocation actually produces. 40 attempts at authProbeIntervalMs is one hour - the measured
    // volume of a single revoked hour (120 listing calls + 40 identity calls), made a total rather
    // than an hourly rate. Nothing about recovery is lost by stopping: the probe is a read and CANNOT
    // clear the latch, the trial write that can is on its own cadence and untouched by this, and the
    // bounded alert re-offer keeps its other drivers (a 401 read from discovery's 30s poll, a held
    // write). Reset at every latch transition, so a later outage gets a fresh hour.
    this.authProbeMaxAttempts = 40;
    this._authProbeAttempts = 0;
    // Set by _stopAuthProbe, cleared at the latch transition. Without it _stopAuthProbe is a pure
    // handle check and therefore a silent NO-OP for the up-to-12s window in which the probe's own
    // login() is in flight (the tick nulls the handle before awaiting), and the completion handler
    // then re-arms a probe on an adapter the caller has already discarded.
    this._authProbeStopped = false;
    // May this adapter EVER probe? False for the read-only `POST /api/connect` adapter, which is
    // parked in a module-level variable, is not a member of `stacks`, and therefore never reaches
    // teardownStack: it has no business self-healing a session it does not own, and a probe armed
    // there would re-authenticate a known-dead token every 90s for the life of the process.
    this.authProbeEnabled = authProbeEnabled !== false;
    // THE DISCARD CHOKEPOINT. See the model above.
    this._discarded = false;
    // When the down-alert was last offered for the CURRENT episode. Null on an open episode means
    // "never offered", which raises immediately rather than waiting out a cadence - see
    // _maybeReRaiseDown for why the offer is bounded rather than one-shot.
    this._lastDownRaiseAt = null;
    this.authDeadReAlertMs = 15 * 60_000;
    // Timer seam. Both auth timers (the settle-window resolve and the liveness probe) route through
    // here so a test can drive the settle boundary exactly instead of sleeping through 180 real
    // seconds. Defaults are the globals, so production behaviour is unchanged. The seam exists
    // because untested clock cross-products are the diagnosed root cause of this fix's earlier
    // defects - if a timing edge here is not drivable from a test, it will not be tested.
    this._setTimeout = setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = clearTimeoutImpl || ((h) => clearTimeout(h));
    // Identity for the desk-facing alarm, passed straight through from the account record. Kept
    // separate from `this.account` above, which is the SuperProcure IDENTITY that login() resolves.
    // Set unconditionally by the caller, never from the stack tag - the tag is null on a
    // single-account box and this alarm has to name the account even when only one runs.
    this.accountId = accountId;
    this.accountLabel = accountLabel;
    // Alerting hooks, injected. The adapter deliberately requires nothing out of src/notify: it
    // reports a state change and the composition root decides what that means to a human.
    this.onAuthDead = onAuthDead;
    this.onAuthRestored = onAuthRestored;

    // --- request layer (header fidelity + 429-aware retry) ---
    this.capturedHeaders = parseCapturedHeaders(headers || process.env.SP_CAPTURED_HEADERS);
    this.fetchImpl = fetchImpl || portalFetch; // injectable for tests
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._rand = rand || Math.random; // jitter source; injectable for deterministic tests

    // --- live-feed wiring (gap A1) ---
    // The engine polls getAuctionState on an adaptive cadence (200ms in the snipe
    // window). Instead of a REST hit per tick, those reads are served from the
    // SuperProcure socket's in-memory cache (push-fed by `bidListenerV2`). The
    // socket is platform-specific, so it lives BEHIND this adapter seam — the
    // engine stays platform-agnostic and unchanged.
    this.sock = sock;              // an SpSocket (or null -> REST-only, rank stays null)
    this.loadMeta = new Map();     // id -> mapped load (closesAt, softClose, revisionLimit, isOpenAuction)
    // id -> epoch ms this load was last SEEN in a /sp/loads/v4 list response. Separate from loadMeta
    // on purpose: loadMeta is the mapped-load shape that flows on into durable intents and the
    // closedBids doc, and this is an observation about the FEED, not about the load. It exists
    // because loadMeta is written once per sighting and NEVER evicted (no delete, no TTL in the
    // file's entire history), so a load SuperProcure stops returning keeps its last-known snapshot -
    // and therefore a healthy local countdown - forever. Nothing could previously tell that state
    // apart from a genuinely live load; this timestamp is what makes it visible.
    this.loadLastSeenAt = new Map();
    this.watched = new Set();      // ids we've already emitted `auctionStart` for
    this.lastWriteRttMs = null;    // measured bid-write round-trip (the latency that matters for snipe timing)
    this.assumedRttMs = assumedRttMs; // until a real bid measures it
    this._lastUnknownListAt = 0;   // throttle the safety-net re-list for unknown loads
    // When the last full listAuctions() completed successfully (BC-15 Fix B, ruling 65) - null
    // until this adapter process has completed one. _checkDelisted judges a never-listed load off
    // this rather than probing it, so a restart's armed loads ride the discovery poll the stack
    // already runs instead of each opening its own board-wide read. Kept off listingTrace's own
    // return (a separate accessor below) so that envelope's frozen key set never has to change.
    this._lastFullListingAt = null;
    // Concurrent listingProbe callers (several never-listed loads armed in the same restart) share
    // this ONE in-flight listAuctions() rather than each opening its own board-wide read.
    this._listingInflight = null;
    // Recent REST round trips, kept so a socket attached later (connectSocket runs after login)
    // starts with the transit correction login already measured.
    this._roundTrips = [];
    this._sizeDetails = new Map();
    this._sizeDetailFailures = new Map();
    this._sizeDetailCursor = 0;
    this._sizeDetailTtlMs = Number.isFinite(sizeDetailTtlMs) && sizeDetailTtlMs > 0 ? sizeDetailTtlMs : 5 * 60_000;
    this._maxSizeDetailFetches = Number.isInteger(maxSizeDetailFetchesPerList)
      ? Math.max(0, Math.min(3, maxSizeDetailFetchesPerList)) : 3;
    // Our rank off the OPEN tab for loads the socket never ranked (requestLiveRank).
    this._liveRank = new Map();
    this._liveRankPrice = new Map();
    this._socketRanked = new Set();
    this._liveRankPending = null;
    this._liveRankLastAt = null;
    // The engine leads its hold check read by this, so a read queued behind another on this login still lands in time.
    this.liveRankGapMs = LIVE_RANK_MIN_GAP_MS;
  }

  /** Attach a live socket after construction (e.g. once login() yields carrierId/userId). */
  attachSocket(sock) { this.sock = sock; this._replayRoundTrips(); return this; }

  _noteRoundTrip(rttMs) {
    this._roundTrips.push(rttMs);
    if (this._roundTrips.length > 16) this._roundTrips.shift();
    if (this.sock && typeof this.sock.noteRoundTrip === 'function') this.sock.noteRoundTrip(rttMs);
  }

  _replayRoundTrips() {
    if (!this.sock || typeof this.sock.noteRoundTrip !== 'function') return;
    for (const rttMs of this._roundTrips) this.sock.noteRoundTrip(rttMs);
  }

  /**
   * Build + connect an SpSocket from this account and attach it. Requires login()
   * first (needs carrierId + userId). Returns the connected socket.
   */
  async connectSocket({ onUpdate = () => {}, onLog = () => {} } = {}) {
    if (!this.account) {
      const e = new Error('connectSocket: call login() first');
      log.error('connectSocket failed: adapter has no account (login() was not called)', { err: e });
      throw e;
    }
    // WARNING: without a carrierId the socket can't match our own bids (no other self-identity),
    // so rank-tracking runs blind and the engine dumps the floor on loads it is already winning.
    if (this.account.carrierId == null) {
      const e = new Error('connectSocket: account has no carrierId (branchIds-only login) - rank tracking would be blind; resolve the carrierId before going live');
      log.error('connectSocket failed: account has no carrierId', { err: e });
      throw e;
    }
    const carrierId = this.account.carrierId;
    log.info('connecting SuperProcure socket', { carrierId });
    // onLog is left exactly as it was — the caller's own hook into the dashboard's
    // in-memory event ring buffer. Fine-grained connect/disconnect/reconnect/error
    // logging for the underlying socket.io connection is emitted directly by SpSocket
    // itself, at the point those native events fire (the earliest and most precise
    // place to capture a connection issue); what's logged here is this adapter's own
    // view of the connectSocket() call succeeding or failing.
    const sock = new SpSocket({
      token: this.token,
      carrierId: this.account.carrierId,
      userId: this.account.userId,
      onUpdate, onLog,
      // Tenant socket knobs. Both null on SP main -> SpSocket's own defaults apply, so the
      // existing accounts get a byte-identical connect. `_socketOrigin()` deliberately hands
      // over scheme+host ONLY; the path prefix travels separately as socketPath, because
      // socket.io would read a pathname as a namespace. See SpSocket's constructor.
      ...(this.socketUrl || this.apiBaseUrl !== DEFAULT_API_BASE ? { url: this._socketOrigin() } : {}),
      ...(this.socketPath ? { path: this.socketPath } : {}),
    });
    await sock.connect();
    this.sock = sock;
    this._replayRoundTrips();
    // (re)subscribe anything already armed before the socket existed
    for (const id of this.watched) { this.watched.delete(id); this._ensureWatching(id); }
    log.info('SuperProcure socket connected', { carrierId, watchedLoads: this.watched.size });
    return sock;
  }

  /** Subscribe the socket to a load's auction room, once. No-op without a socket. */
  _ensureWatching(auctionId) {
    if (!this.sock) return;
    const id = String(auctionId);
    if (this.watched.has(id)) return;
    const meta = this.loadMeta.get(id);
    this.sock.watch(id, meta && meta.isOpenAuction ? 1 : 0);
    this.watched.add(id);
  }

  /** scheme://host of the data API, with any path prefix STRIPPED — socket.io reads a
   *  URL pathname as a namespace, so the prefix must never travel in the socket url.
   *  An explicit socketUrl always wins; otherwise it is derived from apiBaseUrl. */
  _socketOrigin() {
    if (this.socketUrl) return this.socketUrl;
    try { return new URL(this.apiBaseUrl).origin; } catch (_) { return DEFAULT_SOCKET_URL; }
  }

  /** 'same-origin' when the web app and the data API share a host (white-label tenants),
   *  'same-site' otherwise (SP main: app.superprocure.com -> api.superprocure.com).
   *  Falls back to 'same-site' — today's value — if either URL fails to parse, so a
   *  malformed knob can never change the header set on the existing live accounts. */
  _secFetchSite() {
    try {
      return new URL(this.apiBaseUrl).host === new URL(this.webOrigin).host
        ? 'same-origin' : 'same-site';
    } catch (_) { return 'same-site'; }
  }

  _headers() {
    const h = {
      authorization: 'Bearer ' + this.token,
      'content-type': 'application/json',
      accept: 'application/json',
      'accept-language': BROWSER.acceptLanguage,
      origin: this.webOrigin,
      referer: this.webOrigin + '/',
      'user-agent': BROWSER.userAgent,
      // Client-Hints + Sec-Fetch, coherent with the UA above. On SP main,
      // app.superprocure.com -> api.superprocure.com is a same-site cross-origin XHR
      // (shared eTLD+1), hence sec-fetch-site:same-site / mode:cors / dest:empty;
      // sec-fetch-user is absent (it only appears on a real user-gesture navigation).
      // On a white-label tenant the app and the API share ONE host, so a real browser
      // sends same-origin there — derived below rather than hardcoded, so the header
      // stays truthful on both and neither looks synthetic to a WAF.
      'sec-ch-ua': BROWSER.secChUa,
      'sec-ch-ua-mobile': BROWSER.secChUaMobile,
      'sec-ch-ua-platform': BROWSER.secChUaPlatform,
      'sec-fetch-site': this._secFetchSite(),
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    };
    // a captured real-request header set wins (drop-in once we have one), but the
    // Authorization is ALWAYS our live token — never a stale captured one.
    const merged = this.capturedHeaders ? Object.assign({}, h, this.capturedHeaders) : h;
    merged.authorization = 'Bearer ' + this.token;
    return merged;
  }

  /**
   * One request with 429/503-aware retry. `retry:true` callers (login, list) run in
   * discovery, far from the buzzer — safe to back off. The hot-loop rank read is the
   * socket cache (A1), NOT a REST call, so it never reaches this path. The bid WRITE
   * passes retry:false (idempotency — a silent retry can double-bid) and inspects the
   * 429 itself. Honors Retry-After, else Full Jitter backoff (AWS), capped so a read
   * retry can't stall near a close. See the 2026-06-23 anti-detection research note.
   */
  async _request(method, path, { body = null, retry = false, maxRetries = 3, capMs = 4000, timeoutMs = 8000, measureRtt = true } = {}) {
    let attempt = 0;
    for (;;) {
      const init = { method, headers: this._headers() };
      if (body != null) init.body = JSON.stringify(body);
      let status = 0, json = null, text = null, retryAfterMs = null, sentAt = null, receivedAt = null;
      // Bound every fetch: a hung socket (TCP stall, no RST) otherwise never settles, and a hung
      // bid WRITE freezes that auction's monitor for good. Race the fetch against a timeout (plus
      // abort()) so _request ALWAYS settles even if the fetch ignores AbortController; timeout -> status 0.
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ac) init.signal = ac.signal;
      let timer = null;
      const timeout = new Promise((_res, rej) => {
        timer = setTimeout(() => { if (ac) { try { ac.abort(); } catch (_e) {} } rej(new Error('request_timeout')); }, timeoutMs);
        if (timer && timer.unref) timer.unref();
      });
      try {
        sentAt = Date.now();
        const r = await Promise.race([this.fetchImpl(this.apiBaseUrl + path, init), timeout]);
        status = r.status;
        if (status === 429 || status === 503) {
          const ra = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
          retryAfterMs = parseRetryAfterMs(ra, Date.now());
        }
        // Read the body ONCE as text, then attempt to parse it as JSON. SuperProcure's bid
        // endpoint answers a rejection with a PLAINTEXT body ("Load is under approval for
        // allotment. Bidding is not allowed."), which r.json() silently collapsed to null -
        // destroying the only explanation of a 400 before any caller ever saw it (the exact
        // incident this fixes). Text-first preserves that raw body for the reject path; JSON
        // callers are unaffected because we still parse it into `json`. Some test fetch stubs
        // implement only .json() (not .text()) - fall back to r.json() so those keep working.
        if (typeof r.text === 'function') {
          const reading = r.text().catch(() => null);
          text = await (measureRtt ? reading : Promise.race([reading, timeout]));
          if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
        } else if (typeof r.json === 'function') {
          const reading = r.json().catch(() => null);
          json = await (measureRtt ? reading : Promise.race([reading, timeout]));
        }
        if (status > 0) { receivedAt = Date.now(); if (measureRtt) this._noteRoundTrip(receivedAt - sentAt); }
      } catch (err) { // network error / timeout -> retryable when retry is on
        status = 0;
        log.warn('SuperProcure request failed at transport', { method, path, attempt,
          errName: (err && err.name) || null, errMessage: (err && err.message) || null,
          causeCode: (err && err.cause && err.cause.code) || null,
          elapsedMs: sentAt != null ? Date.now() - sentAt : null });
      } finally { if (timer) clearTimeout(timer); }
      const throttled = status === 429 || status === 503;
      const failed = throttled || status === 0;
      if (!failed || !retry || attempt >= maxRetries) {
        return { status, json, text, rateLimited: throttled, retryAfterMs, sentAt, receivedAt };
      }
      await this.sleep(this._backoffMs(attempt, retryAfterMs, capMs));
      attempt += 1;
    }
  }

  /** Full Jitter (AWS): random(0, min(cap, base*2^attempt)); honor Retry-After if present (capped). */
  _backoffMs(attempt, retryAfterMs, capMs) {
    if (retryAfterMs != null) return Math.min(retryAfterMs, capMs);
    const base = 250;
    return Math.floor(this._rand() * Math.min(capMs, base * 2 ** attempt));
  }

  async _get(path) { return this._request('GET', path, { retry: true }); }
  async _post(path, body) { return this._request('POST', path, { body, retry: true }); }

  static jwtExp(t) { try { const e = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).exp * 1000; return Number.isFinite(e) ? e : null; } catch (_) { return null; } }
  // Issued-at, so a caller can tell an 8-hour white-label session from a 365-day SP-main one.
  // A token without `iat` yields null, which every consumer must read as "lifetime unknown".
  static jwtIat(t) { try { const i = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).iat * 1000; return Number.isFinite(i) ? i : null; } catch (_) { return null; } }
  static jwtUserId(t) { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString()).u_id || null; } catch (_) { return null; } }

  capabilities() {
    // biddingEnabled is unconditionally true and that is the invariant, not an oversight: real mode
    // ALWAYS places real bids (CLAUDE.local.md safety invariant 2 - there is no dry-run landing
    // state). Only the kill-switch stops it, and that is `writeEnabled`, not this.
    // platformLabel names this portal on pages a human reads; the desk works two portals from one
    // worklist and the product surface holds no portal name of its own. No extensionCeiling is
    // declared: SuperProcure's cap is a per-BRANCH number that rides the load, so at the platform
    // level it is genuinely unknown, and an absent key says that where a null would claim "no cap".
    // partialVehicleCountSupported: SuperProcure HONOURS the vcq we send rather than deriving it
    // from the load (settled 2026-08-05 over ~64,000 historical FTL bid rows: 120 rows across 45
    // loads carry a stored count strictly below the load's vehicleCount, 8 of them allotted at that
    // count). So the price page's editable truck count is a real choice here, unlike on a portal
    // whose server multiplies by its own units.
    // A live socket rank is not a verified closed result. Unparticipated loads make no outcome reads.
    return { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null, closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure', partialVehicleCountSupported: true, settledOutcomeRequiresOwnPosition: true };
  }

  async login() {
    const av = await this._get('/sp/base/getAvailableViews?isWeb=1');
    if (av.status !== 200 || !av.json) {
      const e = new Error('auth_failed_' + av.status); e.code = 'AUTH'; e.status = av.status;
      log.error('login failed: getAvailableViews returned an unauthorized or empty response', { err: e, httpStatus: av.status });
      throw e;
    }
    const d = av.json.data || av.json;
    // NOTE: getAvailableViews.currentTime is a STALE cached value - observed 15-28 min
    // behind real time and drifting further as the session ages, i.e. a fixed timestamp,
    // not a live clock. Trusting it made just-started live auctions read as "scheduled"
    // (the bug behind "no live loads"). The socket's `current` heartbeat matches the
    // system clock within ~12s, so use the system clock for REST status and let the
    // socket drive precise snipe timing. Only honour the field if it is plausibly fresh.
    if (d.currentTime != null) {
      // Whole seconds, stamped inside the round trip of the attempt that answered (_get retries):
      // read as the middle of both.
      const r = roundTripServerOffset(d.currentTime, av.sentAt, av.receivedAt); // <90s skew only
      if (r.ok) { this.serverTimeOffsetMs = r.offsetMs; this.serverTimeErrorMs = r.errorMs; } // else keep the system clock
    }

    const hd = await this._get('/sp/base/getHeader?relationShipType=Carrier&isWeb=1');
    // status-check getHeader (the first call is guarded, this one wasn't): a failure here
    // used to yield an empty-but-"connected" account that listed zero loads, looking like
    // "no auctions". Fail loudly instead.
    if (hd.status !== 200 || !hd.json) {
      const e = new Error('header_fetch_failed_' + hd.status); e.code = 'AUTH'; e.status = hd.status;
      log.error('login failed: getHeader returned an unauthorized or empty response', { err: e, httpStatus: hd.status });
      throw e;
    }
    const h = (hd.json && (hd.json.data || hd.json)) || {};
    const branchIds = collectBranchIds(h);
    let carrierId = (Array.isArray(h.carrierBranches) && h.carrierBranches[0]) ||
      (d.companyInfo && (d.companyInfo.id || d.companyInfo.companyId)) || null;
    // A usable carrier account must resolve a carrierId or at least one branchId.
    //
    // CODE 'ACCOUNT_UNRESOLVED', NOT 'AUTH', and the distinction is what the desk reads. This line is
    // reached only after BOTH calls above returned 200 with valid JSON - the session provably
    // authenticated twice - so it is a data/permissions resolution failure, not a dead session.
    // Coded AUTH it routed into the boot path's session-death copy ("SuperProcure has logged this
    // account out ... quote these loads from the portal"), pointing whoever reads it at a Reconnect
    // that cannot fix a mapping problem. The generic boot alarm carries the real message instead.
    if (carrierId == null && branchIds.length === 0) {
      const e = new Error('account_unresolved: getHeader returned no carrierId or branchIds');
      e.code = 'ACCOUNT_UNRESOLVED';
      log.error('login failed: account could not be resolved from getHeader response', { err: e });
      throw e;
    }

    this.account = {
      carrierId,
      branchIds,
      // Name + customer per branch, kept so the console can say WHICH customers this login covers.
      branches: collectBranches(h),
      isCarrier: h.isCarrier,
      company: (d.userInfo && (d.userInfo.companyName || d.userInfo.company)) || (d.companyInfo && d.companyInfo.name) || null,
      user: d.userInfo && (d.userInfo.name || d.userInfo.userName),
      userId: RealSuperProcureAdapter.jwtUserId(this.token),
      tokenExp: RealSuperProcureAdapter.jwtExp(this.token),
      tokenIat: RealSuperProcureAdapter.jwtIat(this.token),
      serverTimeOffsetMs: this.serverTimeOffsetMs,
    };
    // Identifiers only — never the token itself. tokenExpiresAt lets an operator spot a
    // session nearing expiry in the logs before ensureSession() has to reject it outright.
    log.info('login succeeded', {
      carrierId: this.account.carrierId,
      company: this.account.company,
      branchCount: this.account.branchIds.length,
      tokenExpiresAt: this.account.tokenExp ? new Date(this.account.tokenExp).toISOString() : null,
    });
    // login() is TWO GETs and no write, so it is a READ success and nothing more: it resets the READ
    // streak, leaves the WRITE streak untouched, and CANNOT clear the latch. This method is what the
    // 90s heartbeat, the "Refresh scope" button and the scheduled scope refresh all end in, and if
    // any of them could unlatch on a read, a write-scope revocation would oscillate clear ->
    // re-latch forever. Recovery is a proven WRITE (the trial write a latched adapter still lets
    // through every interval), or a reconnect / restart, both of which build a fresh adapter.
    this._noteReadSuccess();
    return this.account;
  }

  serverNow() { return Date.now() + this.serverTimeOffsetMs; }

  /**
   * THE TOKEN-LIFETIME SPLIT: three cases, and no tag ever covers two of them.
   *
   * This has shipped a confirmed defect in BOTH directions, because one condition ("the token is
   * near/at its expiry") was carrying one tag:
   *   - treating the whole band as an auth FAILURE sealed the account off two ordinary bid attempts
   *     inside a token's final minute - deterministic, needing no SuperProcure-side condition at all;
   *   - exempting the whole band from detection made a token that had FULLY LAPSED produce silent,
   *     unlatched, unalerted rejections forever, which is precisely the 2026-08-04 incident.
   *
   *   'normal'   now < exp - tokenGraceMs. Nothing to say.
   *   'grace'    exp - tokenGraceMs <= now < exp. The session is still valid; we simply decline to
   *              start a write we may not be able to finish. NOT an auth failure - nothing has been
   *              observed and nothing has been revoked, and the condition has its own alert path
   *              (src/notify/tokenExpiry.js).
   *   'expired'  now >= exp. The credential is dead as a matter of arithmetic on our own token. It
   *              needs no confirmation, no streak and no second observation.
   *
   * The boundaries are exact and are pinned by scripts/test-auth-boundaries.js: at now === exp the
   * phase is 'expired' (not 'grace'), and at now === exp - tokenGraceMs it is 'grace' (not 'normal').
   */
  _tokenPhase(now = Date.now()) {
    const exp = this.account && this.account.tokenExp;
    if (!Number.isFinite(exp)) return 'normal'; // no parsed exp -> no local claim to make
    if (now >= exp) return 'expired';
    if (now >= exp - this.tokenGraceMs) return 'grace';
    return 'normal';
  }

  /**
   * THE STATE. Derived on every read from (tokenExp, now, _latchedSince) - never stored, so it can
   * neither be left wrong by a missed transition nor get stuck independently of its own cause.
   * EXPIRED dominates LATCHED: a lapsed credential is a stronger fact than a refusal streak, and
   * conflating them would let a trial write or a probe put pointless traffic on a dead token.
   */
  authState() {
    if (this._tokenPhase() === 'expired') return 'EXPIRED';
    if (this._latchedSince != null) return 'LATCHED';
    return 'CLEAR';
  }

  /**
   * The READ-path session gate. It KEEPS its throwing contract - every read caller already handles a
   * thrown `code: 'AUTH'` (getAuctionState turns it into `{ ok:false, authError:true }`, discovery
   * catches it and logs a zero tick), and there is no money outcome to fabricate on a read.
   *
   * IT DOES NOT CHECK THE LATCH, and that is deliberate: the latch gates WRITES. Sealing reads while
   * the only clear is a proven write is a deadlock, because a write needs an armed load, an armed
   * load needs discovery, and discovery is a read - so a fully recovered account would stay dark
   * forever. A read that 401s is already handled one layer up and feeds the READ streak.
   *
   * IT DOES CHECK EXPIRY, in all three cases. See _tokenPhase.
   */
  async ensureSession() {
    this._refuseIfTokenExpired('ensureSession');
    const now = Date.now();
    if (this._tokenPhase(now) === 'grace') {
      // DEFENCE IN DEPTH, and the assert is the point rather than the throw. _refuseIfTokenExpired
      // above has already taken every now >= exp, so reaching here with now >= exp would mean the two
      // boundary comparisons had drifted apart - the exact class of edit that produced a confirmed
      // defect in each of the two preceding rounds. Fail to the SAFE side (treat it as expired) so a
      // future edit that breaks the boundary cannot silently re-open the silent-lapse hole.
      const exp = this.account.tokenExp;
      if (!(now < exp)) {
        log.error('token grace band computed for an already-expired token; treating it as expired', {
          accountId: this.accountId, now, exp });
        this._noteTokenExpired(now, 'ensureSession:graceAssert');
        const dead = new Error('token_expired'); dead.code = 'AUTH'; dead.authReason = 'token_expired';
        throw dead;
      }
      const e = new Error('token_expiring'); e.code = 'AUTH'; e.authReason = 'token_expiring'; throw e;
    }
    return this.account;
  }

  /**
   * The EXPIRED short-circuit, shared by every path that would otherwise touch the wire.
   *
   * `zero further wire traffic` is the whole behaviour of this state: no read, no trial write, no
   * probe. The bounded alert re-offer is fed by discovery's own 30s polling, which reaches this
   * function and takes the synthetic refusal without a request ever leaving the box.
   */
  _refuseIfTokenExpired(where) {
    const now = Date.now();
    if (this._tokenPhase(now) !== 'expired') return;
    this._noteTokenExpired(now, where);
    const e = new Error('token_expired'); e.code = 'AUTH'; e.authReason = 'token_expired';
    throw e;
  }

  /**
   * Observe that this token has lapsed. Opens the episode if none is open, and otherwise carries the
   * bounded re-offer.
   *
   * NO STREAK, NO THRESHOLD, NO CONFIRMATION. Every other path here reasons about somebody else's
   * responses and needs corroboration before it acts; this one is arithmetic on our own credential.
   * Requiring two observations would only delay a certainty.
   */
  _noteTokenExpired(now = Date.now(), where = null) {
    if (this._discarded) return;
    const ctx = { where: where || 'tokenExpiry', reason: 'token_expired' };
    this._stopAuthProbe();   // a probe would re-authenticate a provably dead token every interval
    this._trialDueAt = null; // no trial can prove anything here; the claim path refuses on state
    this._cancelResolve();   // a pending all-clear must never fire into an expired token
    this._expireStaleInheritedEpisode(now);
    if (this._episodeSince == null) {
      this._episodeSince = now;
      this._episodeInheritedAt = null; // ours, not inherited - it can never go stale under us
      this._lastDownRaiseAt = null;
      log.error('the SuperProcure token for this account has expired; holding every bid on it until it is reconnected', {
        accountId: this.accountId, where: ctx.where,
        tokenExp: this.account && this.account.tokenExp, episodeSince: this._episodeSince });
      this._raiseDown(ctx, now);
      return;
    }
    this._maybeReRaiseDown(now, ctx);
  }

  /** Is this account's SuperProcure session unusable right now? Sync, no I/O, safe on the 200ms tick. */
  isAuthDead() { return this.authState() !== 'CLEAR'; }

  /**
   * When the CURRENT dead state began (ms epoch), or null when the account is fine.
   *
   * This is the LATCH's instant, not the episode's, and it is for logging and feature-detection only.
   * Nothing alert-facing and nothing clock-facing may key off it - see authEpisodeSince. Falls back
   * to the episode in EXPIRED, where there is no latch instant to report but the account is dead.
   */
  authDeadSince() {
    if (this._latchedSince != null) return this._latchedSince;
    return this.isAuthDead() ? this._episodeSince : null;
  }

  /**
   * THE EPISODE: when the current outage began, and its identity.
   *
   * Opened at the first latch/expiry with no episode open; closed ONLY when the all-clear is actually
   * emitted. It therefore survives an arbitrary number of clear -> re-latch cycles inside one outage,
   * which makes it the honest clock for the engine's suppression bound (a flap cannot rewind it) and
   * the honest identity for the alert dedupe key on both sides (a flap cannot mint a second pair).
   * A genuinely later outage opens a NEW episode with a fresh instant, so it gets its own message and
   * its own full suppression budget rather than inheriting a spent one.
   */
  authEpisodeSince() { return this._episodeSince; }

  /**
   * Compatibility alias for authEpisodeSince. The engine feature-detects this name and hand-rolled
   * test stubs implement it; the episode IS the outage, so the two are the same fact.
   */
  authOutageSince() { return this._episodeSince; }

  /**
   * Is this token inside its own pre-expiry GRACE band right now (exp - tokenGraceMs <= now < exp)?
   *
   * THE ONE AUTH REFUSAL THAT LEAVES THE ACCOUNT CLEAR. Every other refusal this adapter produces
   * either latches the account or is already EXPIRED, and in both of those the engine's account-wide
   * gate holds the load's next tick. The grace band is deliberately exempt from the streak (see
   * placeBid's ensureSession catch for why counting it sealed an account off two ordinary attempts
   * inside a token's final minute), so nothing upstream throttles a load that keeps re-firing into
   * it - which is exactly what the engine needs to know when it decides how much of a refused write's
   * bookkeeping it may hand back. See bidEngine._undoAuthRefusedFire.
   *
   * A PURE PEEK, sync and side-effect free: it is read on the 200ms hot tick.
   */
  authTokenGrace() { return this._tokenPhase() === 'grace'; }

  /**
   * May a write reach the wire right now? True when the account is CLEAR, and true for the ONE trial
   * write per authWriteTrialIntervalMs a LATCHED account allows in order to find out whether its
   * write scope is back. Always false in EXPIRED: there is nothing a trial could prove.
   *
   * A PURE PEEK - it consumes nothing, and must not be made to. The engine calls it at the TOP of
   * _maybeBid, where a dozen gates below can still return without reaching the wire; the allowance is
   * claimed at the wire instead - see _claimAuthWriteTrial.
   */
  authWriteTrialDue() {
    if (this._discarded) return false;
    const state = this.authState();
    if (state === 'EXPIRED') return false;
    if (state === 'CLEAR') return true;
    return this._trialDueAt == null || Date.now() >= this._trialDueAt;
  }

  /** The engine's hold predicate: not CLEAR, and this interval's trial write is already spent. */
  authWriteHeld() {
    if (this._discarded) return true;
    return this.authState() !== 'CLEAR' && !this.authWriteTrialDue();
  }

  /**
   * Record WHY a write is being held, at the moment it is held. Deliberately separate from
   * authWriteHeld(), which is a pure predicate the engine calls on a 200ms hot tick and must stay
   * free of side effects.
   *
   * This is not bookkeeping for its own sake. In EXPIRED it is the write path's ONLY opportunity to
   * notice the token lapsed: the state is derived, so nothing transitions and no callback fires on
   * its own, and the peek returns before ensureSession is ever reached. Without this an account whose
   * token simply ran out - never refused by SuperProcure, never latched - could be held silently, on
   * a box where discovery happened to be stopped. That silence is the 2026-08-04 incident's exact
   * shape and it must not be reachable from any direction.
   */
  _observeHoldReason(where) {
    if (this._discarded) return;
    const now = Date.now();
    if (this._tokenPhase(now) === 'expired') { this._noteTokenExpired(now, where); return; }
    // A HELD write never reaches _noteAuthFailure, so it is its own re-offer trigger. Between the
    // three drivers - the 30s discovery read, this, and the liveness heartbeat - an outage always has
    // some steady signal to hang the bounded alert retry off, whatever else the box is or is not
    // doing. Self-guarded and idempotent inside the cadence, so it costs two comparisons per tick.
    this._maybeReRaiseDown(now, { where });
  }

  /**
   * Claim this interval's trial write. Returns null when refused, otherwise a TOKEN whose release()
   * puts the claim back.
   *
   * CLAIMED AT THE POINT OF CONSUMPTION - immediately before the wire call, with no await and no log
   * line between this and the request. Claiming it earlier (at placeBid's entry, above ensureSession
   * and the payload build) meant a throw from either of those consumed the whole interval's
   * allowance with nothing having reached SuperProcure and no path that gave it back, extending the
   * outage by a further interval. The cheap PEEK still happens early so a held write never builds a
   * payload; only this call spends anything.
   *
   * THE TOKEN IS THE LAST GAP IN THAT ARGUMENT. Adjacency shrinks the pre-wire throw window; it
   * cannot close it, because _request itself can throw before anything leaves the process (it folds
   * every TRANSPORT failure into status 0 and RETURNS, so a throw out of it means the request was
   * never dispatched at all). release() restores the EXACT prior due-instant rather than nulling it:
   * putting the previous value back is what makes the claim fully reversible instead of
   * approximately reversible - nulling would hand out an unbounded number of trials, and leaving it
   * advanced would make the account wait out a full interval for a write that never happened.
   * release() is idempotent, so a double-release cannot rewind the interval twice.
   *
   * SYNCHRONOUS, so "one per interval" holds across concurrently ticking monitors: the claim and the
   * request that follows it are one uninterrupted run on a single-threaded event loop, so a second
   * monitor cannot interleave between the check and the set. Two loads racing therefore produce
   * exactly one write - the loser gets null and takes the ordinary auth-rejection path, which the
   * engine reverses in full.
   */
  _claimAuthWriteTrial() {
    if (this._discarded) return null;
    const state = this.authState();
    if (state === 'EXPIRED') return null;
    // CLEAR spends nothing, so its token releases nothing. Returning a uniform token shape keeps the
    // caller free of a "did this actually claim anything" branch it would get wrong exactly once.
    if (state === 'CLEAR') return { release: () => {} };
    const now = Date.now();
    if (this._trialDueAt != null && now < this._trialDueAt) return null;
    const prior = this._trialDueAt;
    this._trialDueAt = now + this.authWriteTrialIntervalMs;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this._trialDueAt = prior;
      },
    };
  }

  /**
   * One authenticated call came back 401/403. Count it against the CAPABILITY it exercised, and latch
   * the account if that capability's streak reaches the threshold within authStreakWindowMs.
   *
   * `kind` is 'read' or 'write' and it is LOAD-BEARING - it selects the streak. `where` is carried for
   * the log only; the round-2 mechanism that tried to derive a recovery policy from it is exactly what
   * this design replaces, and nothing here may classify on it again.
   *
   * WINDOW BOUNDARY: a gap EQUAL to authStreakWindowMs still counts as a confirmation; only a strictly
   * larger gap restarts the streak at 1. Pinned by scripts/test-auth-boundaries.js so the comparison
   * cannot silently flip.
   *
   * Idempotent once latched - it returns without re-stamping anything, so 360 refusals raise exactly
   * one alert.
   */
  _noteAuthFailure({ status, text, where, kind = 'write' } = {}) {
    // DEFAULTS TO 'write', and that default is the fail-closed direction rather than a convenience.
    // Every call site names its capability explicitly today, so this only ever governs a FUTURE
    // caller that forgets - and an unclassified refusal silently landing in the READ streak would
    // leave the write path unprotected by the very counter that exists to protect it. The cost of
    // over-counting is one latch a trial write clears within an interval; the cost of under-counting
    // is 360 refused writes and 41 auctions closing with nothing on the board.
    if (this._discarded) return this._authStateReport({ transitioned: false, discarded: true });
    const now = Date.now();
    if (kind === 'write') {
      const prev = this._lastWriteFailureAt;
      this._lastWriteFailureAt = now;
      this._writeStreak = (prev != null && (now - prev) > this.authStreakWindowMs) ? 1 : this._writeStreak + 1;
    } else {
      const prev = this._lastReadFailureAt;
      this._lastReadFailureAt = now;
      this._readStreak = (prev != null && (now - prev) > this.authStreakWindowMs) ? 1 : this._readStreak + 1;
    }
    const streak = kind === 'write' ? this._writeStreak : this._readStreak;
    if (this._latchedSince != null) {
      // Already latched, so no state changes - but this is also the only steady heartbeat an ongoing
      // outage produces (the 30s discovery read, the trial write), which makes it the right place to
      // re-offer an alert that may never have been delivered.
      this._maybeReRaiseDown(now, { status, where });
      return this._authStateReport({ transitioned: false, streak });
    }
    if (streak < this.authLatchThreshold) return this._authStateReport({ transitioned: false, streak });
    return this._latch(now, { status, text, where, kind, streak });
  }

  /** The shape _noteAuthFailure's callers log. Latched is read from the live state, never a copy. */
  _authStateReport({ transitioned, streak = null, discarded = false }) {
    return {
      streak: streak != null ? streak : Math.max(this._readStreak, this._writeStreak),
      readStreak: this._readStreak, writeStreak: this._writeStreak,
      latched: this.isAuthDead(), state: this.authState(), transitioned, discarded,
    };
  }

  /**
   * CLEAR -> LATCHED. The single transition site.
   *
   * A RE-LATCH INSIDE THE SETTLE WINDOW CANCELS A MESSAGE THAT WAS NEVER SENT, which is why the
   * whole collision class the previous round guarded against is simply absent here: there is no
   * already-delivered all-clear for a re-latch to contradict, because the all-clear is emitted only
   * after the settle window has fully elapsed, and any re-latch inside it cancels the pending one.
   * The episode is untouched, so the down-alert's dedupe key still names the outage the desk was
   * already told about, and the suppression clock is not rewound.
   */
  _latch(now, ctx) {
    this._latchedSince = now;
    // The first trial write is one full interval away: a trial the instant we latch would only
    // re-observe the failures that just latched us.
    this._trialDueAt = now + this.authWriteTrialIntervalMs;
    this._authProbeStopped = false; // a fresh latch re-arms a probe a previous clear had stopped
    this._authProbeAttempts = 0;    // ...with a fresh ceiling; see _startAuthProbe
    const cancelledPendingAllClear = this._cancelResolve();
    this._expireStaleInheritedEpisode(now);
    const isNewEpisode = this._episodeSince == null;
    if (isNewEpisode) {
      this._episodeSince = now;
      this._episodeInheritedAt = null; // ours, not inherited - it can never go stale under us
      this._lastDownRaiseAt = null;
    }
    log.error('SuperProcure has logged this account out; holding every bid on it until it is signed back in', {
      accountId: this.accountId, httpStatus: ctx.status, where: ctx.where, kind: ctx.kind,
      readStreak: this._readStreak, writeStreak: this._writeStreak,
      episodeSince: this._episodeSince, newEpisode: isNewEpisode, cancelledPendingAllClear,
      sample: typeof ctx.text === 'string' ? ctx.text.slice(0, 120) : null });
    this._startAuthProbe();
    // A brand-new episode gets its message now; a re-latch inside one that was already announced
    // falls through to the bounded delivery retry instead of minting a second message.
    if (this._lastDownRaiseAt == null) this._raiseDown(ctx, now);
    else this._maybeReRaiseDown(now, ctx);
    return this._authStateReport({ transitioned: true, streak: ctx.streak });
  }

  /**
   * Release an INHERITED episode this adapter never confirmed, so a genuinely new outage can mint its
   * own identity instead of being swallowed by it.
   *
   * THE HOLE THIS CLOSES. A reconnect seeds `_episodeSince` from the ledger's outstanding mark but
   * starts with `_lastDownRaiseAt = null`, and the only thing that ever CLOSES an episode is a proven
   * write. An account that reconnects and then simply has no load to bid - which is most of any given
   * day - therefore carries that episode indefinitely. A later, entirely unrelated revocation on the
   * same adapter then reads `_episodeSince != null`, computes "not a new episode", and raises its
   * down-alert under the OLD episode's dedupe key. The notifier's sent-mark is a permanent document
   * with no TTL, so that key was consumed by the first outage's message and the second outage is
   * SILENT - the exact failure class this whole mechanism exists to remove.
   *
   * THE BOUND IS ON THE INHERIT, NOT ON THE EPISODE. Two conditions, and both are load-bearing:
   *   - `_lastDownRaiseAt == null`: this adapter has never itself offered the down-alert for the
   *     inherited episode, i.e. nothing it observed has re-confirmed the outage. A reconnect that
   *     lands into a still-broken account fails its first writes, raises, and is never stale.
   *   - the inherit is older than authInheritedEpisodeConfirmMs: a same-outage reconnect re-latches
   *     within its first couple of write attempts. A quarter of an hour of an adapter behaving itself
   *     is not the same outage any more.
   *
   * The worst case in the direction this errs is ONE extra "logged out" message on an outage that was
   * genuinely still open but had no traffic for 15 minutes. The worst case in the other direction is
   * total silence on a live revocation, which is what this file exists to prevent.
   *
   * The LEDGER is not touched from here. It is the composition root's, it is keyed per account rather
   * than per adapter, and the down-raise that follows this call carries the fresh episode to it
   * through the ordinary hook.
   */
  _expireStaleInheritedEpisode(now = Date.now()) {
    if (this._episodeSince == null) return false;
    if (this._episodeInheritedAt == null) return false;   // an episode this instance opened itself
    if (this._lastDownRaiseAt != null) return false;      // already re-confirmed by our own raise
    if ((now - this._episodeInheritedAt) < this.authInheritedEpisodeConfirmMs) return false;
    log.warn('the outage this session inherited was never confirmed and has gone stale; a new refusal here is a NEW outage and gets its own alert', {
      accountId: this.accountId, inheritedEpisodeSince: this._episodeSince,
      inheritedAt: this._episodeInheritedAt, unconfirmedForMs: now - this._episodeInheritedAt });
    this._episodeSince = null;
    this._episodeInheritedAt = null;
    return true;
  }

  /**
   * Fire the account-down hook. Alerting must NEVER break a bid or read path, so it is wrapped twice -
   * a synchronous throw and a rejected promise are both swallowed.
   *
   * `since` is the EPISODE, so the raiser's dedupe key names the outage rather than this latch.
   */
  _raiseDown(ctx = {}, now = Date.now()) {
    if (this._discarded) return;
    this._lastDownRaiseAt = now;
    try {
      const p = this.onAuthDead && this.onAuthDead({
        accountId: this.accountId, accountLabel: this.accountLabel, since: this._episodeSince,
        status: ctx.status, where: ctx.where, reason: ctx.reason || null,
        readStreak: this._readStreak, writeStreak: this._writeStreak });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* alerting must never break a bid/read path */ }
  }

  /**
   * Re-offer the account-down alert on a bounded cadence while the episode is open.
   *
   * A DELIVERY retry, not a second message: the dedupe key is identical (it is keyed to the episode),
   * and notifier._markSent writes its permanent sent-mark only when a send actually reached somebody -
   * so a delivered message dedupes this to nothing and a dropped one gets another chance.
   *
   * It is bounded rather than one-shot because the 'error' kind rides HEALTH_POLICY 'drop' (skip and
   * discard, no retry). The Maytapi sender being logged out at the instant an episode opens is a
   * documented recurring incident on this deployment, and without a retry the one message that
   * replaces the whole symptom flood is lost outright while the suppression it authorises holds
   * anyway - silence, which is the failure mode this mechanism exists to remove.
   */
  _maybeReRaiseDown(now, ctx) {
    if (this._discarded) return;
    // GATED ON THE EPISODE, not on a previous raise. An open episode with no raise recorded against
    // it is a real and reachable state - an adapter built mid-outage INHERITS the episode but not the
    // previous instance's raise bookkeeping - and gating on the raise instead would make that case
    // silent on every path. Silence is the one failure mode this whole mechanism exists to remove, so
    // an un-raised open episode raises immediately rather than waiting out a cadence it never started.
    if (this._episodeSince == null) return;
    if (this._lastDownRaiseAt != null && (now - this._lastDownRaiseAt) < this.authDeadReAlertMs) return;
    this._raiseDown(ctx, now);
  }

  /**
   * A READ came back clean (login(): two GETs and no write).
   *
   * It proves the token still authenticates and NOTHING MORE, so it resets the READ streak and stops
   * there. It cannot unlatch, and it deliberately leaves the WRITE streak alone - a read 200 between
   * two write 401s is the signature of a write-scope revocation, not evidence against one.
   */
  _noteReadSuccess() {
    if (this._discarded) return;
    this._readStreak = 0;
    this._lastReadFailureAt = null;
  }

  /**
   * A WRITE was ACCEPTED. The single recovery-proof standard in the whole system.
   *
   * It proves both capabilities live at once - the call authenticated AND carried write scope - so it
   * resets both streaks and unlatches unconditionally, with no cases and no classification.
   *
   * The all-clear is armed off the EPISODE, not off the latch, which is what lets a reconnect that
   * inherited an open episode close it through this same path: the composition root announces nothing
   * itself, it only hands the episode over.
   */
  _noteWriteSuccess() {
    if (this._discarded) return;
    this._readStreak = 0; this._lastReadFailureAt = null;
    this._writeStreak = 0; this._lastWriteFailureAt = null;
    if (this._latchedSince != null) {
      const heldForMs = Date.now() - this._latchedSince;
      this._latchedSince = null;
      this._trialDueAt = null;
      this._stopAuthProbe();
      log.info('a bid was accepted on this account, so its write scope is live again', {
        accountId: this.accountId, thisLatchHeldForMs: heldForMs, episodeSince: this._episodeSince });
    }
    if (this._episodeSince != null && this.authState() === 'CLEAR') this._armResolve();
  }

  /**
   * Arm the all-clear. RESOLVE-SIDE DEBOUNCE: the message is emitted only after authSettleMs of
   * continuous CLEAR, and any re-latch inside that window cancels it before it is ever sent.
   *
   * Does NOT restart an already-pending timer. A busy account accepting a bid every few seconds would
   * otherwise push its own all-clear out indefinitely - the settle window measures how long the
   * account has been healthy, not how recently it last proved it.
   */
  _armResolve() {
    if (this._discarded) return;
    if (this._resolveTimer) return;
    // Stamped AFTER the already-pending check, so it records the write that STARTED this window
    // rather than the most recent one. A busy account accepting a bid every few seconds would
    // otherwise walk its own recovery instant forward and under-report the outage to nothing.
    this._recoveredAt = Date.now();
    const t = this._setTimeout(() => { this._resolveTimer = null; this._emitAllClear(); }, this.authSettleMs);
    if (t && typeof t.unref === 'function') t.unref();
    this._resolveTimer = t;
  }

  /** Cancel a pending all-clear. Returns whether one was actually pending (logged at the latch). */
  _cancelResolve() {
    // The proof dies with the message. Whatever cancels an all-clear - a re-latch, an expiry, a
    // discard - has said the account is not recovered after all, so the next window has to be timed
    // from a write that proves it again rather than from this one.
    this._recoveredAt = null;
    if (!this._resolveTimer) return false;
    try { this._clearTimeout(this._resolveTimer); } catch (_) { /* best effort */ }
    this._resolveTimer = null;
    return true;
  }

  /**
   * THE ONE SITE THAT CLOSES AN EPISODE. Nothing else may null _episodeSince - not a latch clear, not
   * a reconnect, not a teardown - because the episode's whole job is to outlive every one of those.
   */
  _emitAllClear() {
    if (this._discarded) return;
    if (this._episodeSince == null) return;
    // Belt: a re-latch should already have cancelled this timer. If the state is not CLEAR the
    // episode is still live and must stay open.
    if (this.authState() !== 'CLEAR') return;
    const since = this._episodeSince;
    // MEASURED TO THE WRITE THAT PROVED RECOVERY, not to this instant. The settle window is our own
    // confidence-building delay and the desk must not read it as downtime - measuring to the emit
    // adds a flat authSettleMs to every reported outage, which on a 40-second blip is most of the
    // number. Falls back to now only if the proof instant is somehow missing, which keeps the old
    // arithmetic rather than reporting a negative or a NaN.
    const downForMs = (this._recoveredAt != null ? this._recoveredAt : Date.now()) - since;
    this._recoveredAt = null;
    this._episodeSince = null;
    this._episodeInheritedAt = null;
    this._lastDownRaiseAt = null;
    log.info('SuperProcure session is back; bidding on this account has resumed', {
      accountId: this.accountId, downForMs, episodeSince: since });
    try {
      const p = this.onAuthRestored && this.onAuthRestored({
        accountId: this.accountId, accountLabel: this.accountLabel, since, downForMs });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* alerting must never break a bid/read path */ }
  }

  /**
   * The liveness heartbeat. IT DOES NOT CLEAR THE LATCH AND CANNOT - login() is a read, and only a
   * proven write clears. Do not "restore" a clear here.
   *
   * What it is still for: it keeps the account identity and branch scope fresh so discovery works
   * from current data the moment writes come back; it holds the READ streak at zero while the token
   * demonstrably authenticates; it gives the logs a heartbeat that distinguishes "the token is
   * revoked outright" from "the token authenticates but writes are refused", which is the single most
   * useful fact for whoever picks up the alarm; and it carries the bounded re-offer of the
   * account-down alert on an account with no other traffic.
   *
   * ARMED ONLY IN LATCHED, checked from the derived state rather than from a flag. In CLEAR there is
   * nothing to heartbeat; in EXPIRED a probe would re-authenticate a provably dead credential every
   * interval, which is exactly the wire traffic that state exists to eliminate.
   *
   * ...AND BOUNDED WITHIN LATCHED, by the same reasoning EXPIRED stops outright. A genuine, ongoing
   * account revocation IS the LATCHED state, so "re-arm unconditionally while latched" meant
   * re-authenticating a known-bad credential every 90s for the entire duration of any long outage -
   * unbounded, unattributable traffic on BRL's live shared SuperProcure account, which is precisely
   * the anti-detection risk stopping the probe in EXPIRED exists to avoid. After authProbeMaxAttempts
   * the probe stops the same way EXPIRED stops it, and resuming needs the same things EXPIRED needs:
   * a proven write (which clears the latch, and a later latch re-arms with a fresh count) or an
   * operator reconnect/restart (which builds a fresh adapter). Recovery is NOT gated on this - see
   * the ceiling's own note in the constructor for why the probe was never the recovery path.
   *
   * Unref'd, matching this file's own timer convention, so it can never hold the process open.
   */
  _startAuthProbe() {
    if (this._discarded) return;
    if (!this.authProbeEnabled || this._authProbeStopped) return;
    if (this.authState() !== 'LATCHED') return;
    if (this._authProbeTimer) return;
    const tick = () => {
      // The handle is nulled BEFORE the await, so from here until login() settles _stopAuthProbe has
      // no handle to clear. The flag is what it checks instead - on both sides of the await.
      this._authProbeTimer = null;
      if (this._discarded || this._authProbeStopped || this.authState() !== 'LATCHED') return;
      // Counted at the ATTEMPT, before the request, and irrespective of what login() comes back with.
      // The cost this bounds is the request itself; a probe that authenticates is still one more
      // unattributable authentication on a shared account, and a probe that 401s is the case the
      // ceiling exists for. Counting successes only would leave the write-scope-revocation shape -
      // reads fine, writes dead, latch never clears - probing forever.
      this._authProbeAttempts += 1;
      this._maybeReRaiseDown(Date.now(), { where: 'authProbe' });
      this.login()
        .catch(() => {})              // a still-dead token fails here; that is the expected case
        .then(() => {
          if (this._discarded || this._authProbeStopped) return; // discarded while login() was in flight
          if (this.authState() !== 'LATCHED') return;
          if (this._authProbeAttempts >= this.authProbeMaxAttempts) {
            log.warn('this account has been logged out long enough that the liveness heartbeat is standing down; it will resume on a reconnect, a restart, or an accepted bid', {
              accountId: this.accountId, attempts: this._authProbeAttempts,
              overMs: this._authProbeAttempts * this.authProbeIntervalMs });
            this._stopAuthProbe();
            return;
          }
          this._startAuthProbe();
        });
    };
    const t = this._setTimeout(tick, this.authProbeIntervalMs);
    if (t && typeof t.unref === 'function') t.unref();
    this._authProbeTimer = t;
  }

  /**
   * Stop probing.
   *
   * Clearing the handle is NOT enough on its own. `tick` nulls the handle before awaiting login(), so
   * for up to ~12s (two _get calls, retry:true, maxRetries 3, capMs 4000) there is no handle to clear
   * and this would be a silent no-op - after which the completion handler would happily re-arm a probe
   * on an already-discarded adapter. The flag closes that window, and `tick` checks it on both sides
   * of the await.
   *
   * `permanent` is the DISCARD case: a plain stop is per-cycle (a later latch on the same adapter may
   * re-arm), while a discard revokes the permission itself so nothing - not even a 401 arriving from a
   * write that was already in flight - can bring it back.
   */
  _stopAuthProbe({ permanent = false } = {}) {
    this._authProbeStopped = true;
    if (permanent) this.authProbeEnabled = false;
    if (!this._authProbeTimer) return;
    try { this._clearTimeout(this._authProbeTimer); } catch (_) { /* best effort */ }
    this._authProbeTimer = null;
  }

  /**
   * THE SINGLE DISCARD CHOKEPOINT. Called by server.js teardownStack when a stack is thrown away.
   *
   * Every _note* entry point, every raiser and both allowance methods early-return once this is set,
   * so work that was already in flight when the stack was discarded - a write awaiting its response,
   * a probe awaiting login() - can neither latch a dead adapter, re-arm its probe, emit an all-clear,
   * nor write into the bookkeeping of the NEWER outage that the replacement adapter now owns. That
   * last one is not hypothetical: a stale in-flight write resolving after a reconnect is exactly how
   * a newer outage's mark was corrupted before this existed.
   *
   * It deliberately does NOT close the episode. The episode belongs to the account, not to this
   * adapter instance; the composition root hands it to the replacement, which closes it by proving a
   * write. Closing it here would announce a recovery nobody has evidence for.
   *
   * It RETURNS the still-open episode instead, so teardownStack can park it back on the ledger. The
   * ledger normally already holds it - it is written when the down-alert is raised - so this is a
   * belt rather than the primary path: it covers any adapter that opened an episode without the
   * ledger recording it (a hook wired without the mark, a mark cleared underneath a live outage) and
   * costs one comparison at teardown. The recovery PROOF (_recoveredAt) is deliberately NOT handed
   * over: it was proof about a different token, and the replacement has to earn its own.
   *
   * Idempotent - a second discard reports no episode, so a double teardown cannot re-park anything.
   */
  discard() {
    if (this._discarded) return { episodeSince: null };
    this._discarded = true;
    const episodeSince = this._episodeSince;
    this._cancelResolve();
    this._stopAuthProbe({ permanent: true });
    return { episodeSince: episodeSince != null ? episodeSince : null };
  }

  /**
   * The rejection envelope for an auth refusal, key-for-key identical to the ordinary rejection
   * envelope placeBid returns below. Its key set is PLACE_BID_ENVELOPE_KEYS (exported at the foot of
   * this module) - the one list all four contract assertions read, so a field added at one
   * construction site and not another fails somewhere instead of nowhere.
   *
   * NOT ONE EXTRA FIELD, and that is a hard contract rather than a preference:
   * scripts/test-rejection-classify-contract.js pins the key set with deepStrictEqual and tolerates
   * no additional properties, because a new key on this envelope is a wire-contract change. The
   * engine needs nothing new anyway - it classifies on `status`, which is already here.
   *
   * `reason` is the literal 'session_logged_out', never SuperProcure's own body text. Two reasons.
   * The engine's rejection classifiers regex-scan reason/text/raw, and while "Token is invalid."
   * matches neither of them today, SuperProcure could reword it into a collision - a literal removes
   * that class of accident. And it is deliberately NOT 'auth', which is the MOCK adapter's string and
   * has a live handler in the engine's reject path; reusing it would silently route the real adapter
   * into the mock's behaviour.
   */
  _authRejection({ status, text, raw, carrierSent, latencyMs }) {
    return {
      accepted: false,
      status,
      myRank: null,
      revisionsLeft: null,
      bidVehicleCount: null,
      amountPMT: null,
      // bidRate joined the envelope on 2026-08-05 with the per-MT wire fix - SuperProcure's SECOND
      // echo of the rate we sent, which the pmt_amount_mismatch oracle reads alongside amountPMT.
      // It must be present-and-null here for the same reason every other read-back field is: this
      // envelope is key-for-key identical to the ordinary one, and the oracle's `v != null` filter
      // must skip a field that is explicitly absent rather than read an undefined off a missing key.
      bidRate: null,
      bidQuantity: null,
      reason: 'session_logged_out',
      carrierSent: carrierSent != null ? carrierSent : null,
      text: text != null ? text : null,
      latencyMs,
      raw: raw != null ? raw : (text != null ? text : null),
    };
  }

  _mapLoad(l, detail = null) {
    const lane = parseLane(l.loadingPoints || l.loadLoadingUnloadingPoint || '');
    // full pickup/drop addresses (drop especially - the pricing team needs the exact
    // drop point, not the abbreviated lane city). Same source blob as the lane.
    const points = parsePoints(l.loadingPoints || l.loadLoadingUnloadingPoint || '');
    // SuperProcure's own "does this load actually have a scheduled bidding window" flag.
    // When biddingOn !== 1, biddingCloseTime/biddingStartTime are NOT real deadlines -
    // SuperProcure fills them with a shared placeholder instead of null (observed live,
    // 2026-07-11: every biddingOn:0 load across multiple unrelated shippers returned the
    // identical "2100-05-24T19:53:25.000Z"/"...19:38:25.000Z" pair). Trusting that
    // placeholder as a real close time is what let 6 loads get human-priced and armed with
    // a 74-year "runway" the engine would never race against. boundedParse is a second line
    // of defense even on a biddingOn:1 load: SuperProcure structurally cannot have returned
    // this load outside listAuctions()'s own +/-7/14-day query window, so anything parsing
    // further out than that (with slack) is provably bad, not just suspicious - same local
    // idiom as parseRetryAfterMs above (Number.isNaN(t) ? null : ...).
    //
    // scheduled=false is NOT always "check back later, SuperProcure hasn't gotten to it yet."
    // Ashirvad Pipes posts loads across its whole branch network with biddingOn permanently 0
    // - no other API field (loadType, loadBiddingType, isConsignmentAuction, isIndent,
    // isOpenAuction) distinguishes this from a normal auction; biddingOn is the only signal.
    // Module 1's 3-rung snipe ladder has nothing to time against without a real close, so
    // these loads are out of scope for THIS module by design, not a bug to chase - see
    // _research/2026-07-11_no-schedule-bid-type-scoping.md before building anything for them.
    const scheduled = l.biddingOn === 1;
    const boundedParse = (raw) => {
      if (!raw) return null;
      const t = Date.parse(raw);
      if (Number.isNaN(t)) return null;
      const now = this.serverNow();
      if (t < now - MAX_PLAUSIBLE_DEADLINE_MS || t > now + MAX_PLAUSIBLE_DEADLINE_MS) return null;
      return t;
    };
    // biddingOn stays 0 until SuperProcure OPENS the window, so biddingOn:0 covers TWO very
    // different loads: (a) a genuinely scheduled auction whose window just hasn't started yet
    // (SP's own UI shows these as "Auction starts at 12:25 pm" vs "Ends in" once live) with
    // REAL start/close times on the payload, and (b) the no-schedule class above with the
    // year-2100 placeholder pair. boundedParse is the discriminator - real future windows
    // parse inside the +/-30d bound, the placeholder never does. Gating on biddingOn alone
    // (the first cut of this mapper) nulled the real times of class (a) too, which starved
    // the pricing team of lead time AND left the arm-lead wake with no known close - the
    // class-C premature finalize (OA 23088404/23088465, docs/diagnoses/2026-07-13_*.md).
    // Fail-closed: a biddingOn:0 load whose window is NOT verifiably in the future (past,
    // partial, or implausible times) stays unscheduled.
    let closesAt = boundedParse(l.biddingCloseTime);
    let startsAt = boundedParse(l.biddingStartTime);
    const now = this.serverNow();
    let status;
    if (scheduled) {
      status = 'scheduled';
      if (closesAt && now >= closesAt) status = 'closed';
      else if (startsAt && now >= startsAt) status = 'live';
    } else if (startsAt && closesAt && startsAt > now && closesAt > startsAt) {
      status = 'scheduled'; // window announced, not yet open - price early, engine wakes at start
    } else {
      status = 'unscheduled';
      closesAt = null;
      startsAt = null;
    }
    // Close model from the real extend-time: >0s = soft (anti-snipe), 0 = hard.
    // (the branchExtendAuction flag proved unreliable in live data.) closeModelKnown is
    // true ONLY when that field arrived as a parseable HH:MM:SS - so the scope gate can
    // fail CLOSED on an absent/malformed value instead of silently reading "unknown" as
    // hard and admitting an out-of-scope soft-close load. parseHMS returns 0 for both a
    // real "00:00:00" and for garbage, which is why "was it parseable" is tracked apart.
    const extRaw = l.branchAuctionExtendTime;
    const closeModelKnown = typeof extRaw === 'string' && /\d+\s*:\s*\d+\s*:\s*\d+/.test(extRaw);
    const extendSeconds = parseHMS(extRaw);
    // Soft-close (L3, G3) surfacing: the MAX number of anti-snipe extensions (branchExtendAuctionCount)
    // and the trigger window in seconds (branchAuctionRemainingTime = a bid landing with <= this much
    // time left is what CAUSES an extension). Both are FACTS off the same live load. null when SP omits
    // or garbles them - the engine treats an absent cap as UNKNOWN and fails closed to the Module-1
    // hard-close snipe (never assumes a cap it cannot read). Number.isFinite so a non-numeric never
    // reaches the engine as NaN.
    const extCountRaw = Number(l.branchExtendAuctionCount);
    const extendCount = Number.isFinite(extCountRaw) ? extCountRaw : null;
    const trigRaw = Number(l.branchAuctionRemainingTime);
    const triggerWindowSeconds = Number.isFinite(trigRaw) ? trigRaw : null;
    // A3 (capture-only): SP's OWN published lane-freight anchors - loadAvgLaneFreightFTL /
    // loadAvgLaneFreightPMT (per-lane average freight for the FTL / PMT quote types) and freightRate
    // (the shipper's own reference rate). These are SuperProcure's published averages, NOT any
    // competitor's bid amount, so they sit INSIDE the legal-independence wall: a legal, unmasked
    // benchmark that lets a closed auction be scored above/below market after the fact. Coerced
    // null-safe: absent/empty/non-numeric -> null; a real 0 (SP's "no anchor for this quote type"
    // value, seen on most loads) is preserved as 0 so the scoring layer - not this capture - decides
    // what 0 means. Never throws; a missing field must never break _mapLoad or a bid.
    const anchorNum = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    const laneFreight = {
      ftl: anchorNum(l.loadAvgLaneFreightFTL),
      pmt: anchorNum(l.loadAvgLaneFreightPMT),
      freightRate: anchorNum(l.freightRate),
    };
    // WHO POSTED THIS LOAD - the shipper-side person the pricing desk rings when a load needs a
    // question answered (branchUserName + branchUserMobile, both already on /sp/loads/v4; zero
    // extra API calls). DISPLAY-ONLY, exactly like companyName/branchName above: never a routing,
    // margin, or matching key.
    //
    // Fails CLOSED to null, because a wrong phone number is worse than no phone number - the desk
    // would ring a stranger about someone else's freight. Four ways SuperProcure hands over
    // something that is not a real person:
    //   (a) no name at all (sim/mock loads, older payloads),
    //   (b) branchUserName "System" - SP's own placeholder on system-posted loads (observed live),
    //   (c) a placeholder MOBILE paired with that class of row - the 1000000000 shape, or any
    //       all-same-digit run. Same hazard class as the year-2100 close time boundParse guards
    //       above: it parses as a perfectly valid 10-digit number, so only a shape check catches it.
    //       A placeholder mobile discredits the whole row, name included - fail closed on both.
    //   (d) displayPartyDetails present and falsy - SP's own "the shipper does not want party
    //       details shown" flag. Observed 1 on every load so far, but honour it the moment it flips.
    //       Number() coercion on purpose: a STRING "0" is truthy in JS and would leak a hidden name.
    // Anything surviving all four is carried with a mobile that passes the repo's ONE phone rule -
    // or null, because a real name with an unusable number still tells the desk who to ask for.
    const isPlaceholderDigits = (d) => /^(\d)\1+$/.test(d) || /^10{9}$/.test(d);
    // SP is inconsistent about how a mobile is punctuated ("+91 90000-12345", "09000012345",
    // "9000012345" would all be the same subscriber number). Reduce to the bare national number
    // FIRST, so the placeholder shape-check and the validity check both see one canonical form
    // instead of being defeated by a country code or a trunk prefix.
    const nationalDigits = (raw) => {
      let d = String(raw == null ? '' : raw).replace(/\D/g, '');
      if (d.length === 12 && d.startsWith('91')) d = d.slice(2);   // +91 country code
      else if (d.length === 11 && d.startsWith('0')) d = d.slice(1); // domestic trunk prefix
      return d;
    };
    // Ten digits is NOT the rule, and this surface does not get to invent its own. normalizePhoneIN
    // (src/model/normalizePhone.js) is the single rule for every phone input in this repo - it is
    // why '1234567890' is rejected rather than truncated into something dialable, the exact defect
    // class PR #30 spent four rounds eliminating from the other surfaces. SP free text is a new
    // phone-input surface, so it routes through the same rule instead of around it.
    //
    // That rule throws on a near-miss and returns '+91XXXXXXXXXX'; this seam wants bare national
    // digits or nothing, so drop the prefix it just added (a literal it controls, not a guess) and
    // turn the throw into the null the caller already handles.
    const dialableDigits = (d) => {
      try { return normalizePhoneIN(d).replace(/^\+91/, ''); } catch (_e) { return null; }
    };
    const poster = (() => {
      const name = typeof l.branchUserName === 'string' ? l.branchUserName.trim() : '';
      if (!name) return null;
      if (name.toLowerCase() === 'system') return null;
      if (l.displayPartyDetails != null && !Number(l.displayPartyDetails)) return null;
      const digits = nationalDigits(l.branchUserMobile);
      if (digits && isPlaceholderDigits(digits)) return null;
      return {
        name,
        mobile: dialableDigits(digits),
        // SP's numeric user id for the poster - carried because it is free and is the only stable
        // key if a later rung ever wants to group loads by who posted them. Not read today.
        createdBy: l.loadCreatedBy != null && l.loadCreatedBy !== '' ? String(l.loadCreatedBy) : null,
      };
    })();
    return {
      id: String(l.id), loadCode: l.loadCode, lane, points,
      equipment: l.vehicleName || l.vehicleType, units: l.vehicleCount, weight: l.weight,
      dimensions: readSpDimensions(detail, l.id),
      // The unit `weight` is actually expressed in - most BRL branches quote in MT, but
      // several (e.g. Ashirvad Pipes, Tata Consumer) are configured in KG. Verified live
      // against SuperProcure's own weightUtilizationPercentage (weight / truck capacity):
      // only checks out when this unit is honored, not when "MT" is assumed unconditionally.
      // Normalised to the canonical enum (KG/MT; case/whitespace-tolerant); unknown/absent -> null,
      // which falls back to 'MT' at the display layer (today's de facto default) - the same
      // normaliser deriveLoadRules uses, so the display unit and the LoadRules fact never diverge.
      weightUnit: normalizeUnit(l.brancheUnit),
      // Route distance in km, as SuperProcure computes it. Never carried before - Suyashh
      // flagged it missing; the mockup (notification-templates-mockup.html) already scoped
      // this exact gap ("Distance-km ... not carried") against SuperProcure's own alert format.
      distanceKm: l.loadDistance != null && l.loadDistance !== '' ? Number(l.loadDistance) : null,
      // shipmentType is SuperProcure's loadShipmentType and is kept as-is for DISPLAY only - it
      // reads "FTL" even on a PMT load, so it is NOT the pricing basis and must never be used as
      // one. quoteType (branchQuoteType, falling back to rateType) is the real basis; see
      // normQuoteType above. The multi-vehicle count fix (engine) reads quoteType to tell a genuine
      // FTL N-truck load from a PMT tonnage load, where the same `vehicleCount`/`units` field means
      // MT, not trucks. loadTotalQuantity is what is STILL BIDDABLE, not a mirror of vehicleCount:
      // it starts equal on FTL and then DECREMENTS as the shipper partially allots, while
      // vehicleCount never moves. It is read - getAuctionState surfaces it as `remainingQuantity`
      // and the engine clamps its vehicle count to it.
      shipmentType: l.loadShipmentType, quoteType: normQuoteType(l.branchQuoteType || l.rateType),
      loadTotalQuantity: l.loadTotalQuantity != null ? l.loadTotalQuantity : null,
      // A3: SP's published lane-freight anchor ({ftl, pmt, freightRate}, parsed above). Carried
      // through arm() -> the durable intent + the armed event -> the closedBids doc (bidLogger).
      // Our-side legal benchmark, never a competitor amount.
      laneFreight,
      companyName: l.companyName, productName: l.productName,
      // SuperProcure's per-load branch label - the consignor's own branch/depot ("REN-K",
      // "Bhiwadi- Plant", "Alwar Cable (1350)"). DISPLAY-ONLY, like companyName; never a
      // routing/margin key. Multi-branch shippers (Renewsys, Ashirvad's 9 depots, Havells, KEI)
      // all share ONE companyName, so branchName is the only field that tells their branches
      // apart - carried so the capture link and the pricing-desk display can name the branch.
      // null when SP omits it (sim/mock loads never carry it).
      branchName: l.branchName || null,
      // {name, mobile, createdBy} | null - the person who posted this load, for the pricing desk
      // to call. Guarded above (System / placeholder mobile / displayPartyDetails). DISPLAY-ONLY.
      poster,
      // shipper note (rich-text on the wire -> plain text) + "there is more on the portal"
      // flags — all confirmed fields on /sp/loads/v4; a pricing person needs to read these.
      notes: htmlToText(l.notes),
      hasPortalComments: !!l.loadIsCommentsPresent,
      hasPortalAttachments: !!(l.loadIsAttachmentPresent || Number(l.attachmentCount) > 0),
      // SP ships ceilingPrice as a STRING ("90000.00"); parse+bound-check to a number (or null) at
      // this boundary so no downstream reader does a lexicographic string compare (v4 capture finding 5).
      ceiling: plausibleCeiling(l.ceilingPrice), minDecrement: l.loadBidDifference, minBid: l.loadMinBid,
      revisionLimit: l.branchBidCountAllowed || l.loadBidCountAllowed || null,
      startsAt, closesAt, biddingStartTime: l.biddingStartTime, biddingCloseTime: l.biddingCloseTime,
      biddingOn: scheduled,
      showL1Rate: !!(l.showL1Rate || l.allowShowL1Rate),
      extendSeconds,
      softClose: extendSeconds > 0,
      closeModelKnown,
      // soft-close extension cap + trigger window (L3). Facts today; the engine's endgame reads them.
      extendCount,
      triggerWindowSeconds,
      isOpenAuction: !!l.isOpenAuction, status,
      // SuperProcure's OWN status fields for the load, carried verbatim and untouched. All three ride
      // on the raw /sp/loads/v4 row and were being discarded at this mapper; they are exactly the
      // fields that would explain a "Load not available for bidding" refusal, which is a per-load
      // state we can currently only observe by being refused (U1). loadStatusKey is SP's lifecycle
      // key, loadNotificationStatus its notification state, and oldLoadId points at a PREDECESSOR
      // row - a repost/supersede would be one very plausible way for a load to become unbiddable
      // while still sitting in our never-evicted cache. Facts only: nothing reads them for a
      // decision, and no meaning is assumed for any particular value until the data says what they
      // are. Absent on sim/mock loads and on every pre-existing record -> null (additive, byte-safe).
      loadStatusKey: l.loadStatusKey != null ? l.loadStatusKey : null,
      loadNotificationStatus: l.loadNotificationStatus != null ? l.loadNotificationStatus : null,
      oldLoadId: l.oldLoadId != null ? l.oldLoadId : null,
      // LoadRules: the per-load facts every bidding mechanic needs, derived ONCE here from the raw
      // SP load and carried whole (price request -> arm -> monitor.meta -> placeBid opts). Inert in
      // this PR - buildBidPayload does not yet consume it for the wire - but it is the single seam
      // every future capability extends (see src/model/loadRules.js).
      rules: deriveLoadRules(l),
    };
  }

  /** List the carrier's auction loads (read-only). Uses /sp/loads/v4 (branchIds-based). */
  _v4Body(tab, { from = new Date(this.serverNow() - 7 * 86400000), offset = 0, loadId = null } = {}) {
    const branchIds = (this.account && this.account.branchIds) || [];
    const to = new Date(this.serverNow() + 14 * 86400000);
    return {
      baseFilter: { branchIds, fromDate: ymd(from), toDate: ymd(to), tab, loadId },
      limit: { limit: V4_PAGE, offset }, sort: { value: null, order: 'ASC' }, isWeb: 1,
    };
  }

  _noteSizeDetailFailure(loadId, status, reason) {
    if (this._discarded) return;
    const now = Date.now();
    const key = JSON.stringify([String(loadId), status, reason]);
    const previous = this._sizeDetailFailures.get(key);
    if (previous != null && now - previous < 5 * 60_000) return;
    this._sizeDetailFailures.set(key, now);
    for (const [oldKey, at] of this._sizeDetailFailures) {
      if (now - at >= 5 * 60_000 || this._sizeDetailFailures.size > 500) this._sizeDetailFailures.delete(oldKey);
    }
    log.warn('SuperProcure size detail unavailable', { loadId: String(loadId), status, reason });
  }

  async _enrichDimensions(rows, mapped, enabled) {
    let remaining = enabled ? this._maxSizeDetailFetches : 0;
    const start = this._sizeDetailCursor % Math.max(1, rows.length);
    for (let offset = 0; offset < rows.length && !this._discarded; offset += 1) {
      const i = (start + offset) % rows.length;
      const raw = rows[i], load = mapped[i];
      if (!load.biddingCloseTime) continue;
      const key = JSON.stringify([raw.id, raw.vehicleType, raw.vehicleName, raw.dimensions,
        raw.dimensionUnit, raw.loadDimensionUnit, raw.branchDimensions]);
      const cached = this._sizeDetails.get(key);
      if (cached && Date.now() - cached.at < this._sizeDetailTtlMs) {
        load.dimensions = cached.dimensions;
        continue;
      }
      if (remaining <= 0 || !load.closesAt || load.closesAt - this.serverNow() <= 60_000) continue;
      remaining -= 1;
      this._sizeDetailCursor = i + 1;
      try {
        const res = await this._request('GET', '/sp/loads/loadBoardDetails?loadId=' + encodeURIComponent(raw.id),
          { timeoutMs: 1500, measureRtt: false });
        if (this._discarded) continue;
        if (res.status < 200 || res.status >= 300 || !ownsSpDetail(res.json, raw.id)) {
          this._noteSizeDetailFailure(raw.id, res.status, res.status >= 200 && res.status < 300
            ? 'unattributable_detail' : 'detail_read_failed');
          continue;
        }
        const dimensions = readSpDimensions(res.json, raw.id);
        load.dimensions = dimensions;
        this._sizeDetails.set(key, { at: Date.now(), dimensions });
      } catch (_e) { this._noteSizeDetailFailure(raw.id, 0, 'detail_read_failed'); }
    }
    for (const [key, cached] of this._sizeDetails) {
      if (Date.now() - cached.at >= this._sizeDetailTtlMs || this._sizeDetails.size > 500) this._sizeDetails.delete(key);
    }
  }

  async listAuctions({ enrichDimensions = false } = {}) {
    await this.ensureSession();
    const res = await this._post('/sp/loads/v4', this._v4Body('OPEN'));
    // THE READ PATH'S SILENCE, fixed at the seam that actually manufactures it. _request behaves
    // correctly - it returns status 401 faithfully. The silence is made on the next two lines: a 401
    // body does not parse into an object with loadDetails, so `loads` becomes [] and this function
    // returns an empty array. Discovery's catch never fires because nothing threw, and a revoked
    // session reads as "no auctions today" indefinitely.
    //
    // Deliberately NOT inside _request. A 401 branch there would also pre-empt login(), which
    // inspects av.status !== 200 itself to build the auth_failed_<status> error - i.e. it would
    // change the wording of the one auth alert path that was already correct.
    //
    // Read failures count against the READ streak, which is separate from the write streak by
    // design: reads and writes are separately revocable on this platform, so one shared counter
    // cannot protect both directions at once. Discovery polls every 30s, so a full revocation still
    // latches within ~60s even on an account with nothing armed - earlier than fire time, and the
    // desk hears about it before the next auction is priced.
    if (res.status === 401 || res.status === 403) {
      this._noteAuthFailure({ status: res.status, text: res.text, where: 'listAuctions', kind: 'read' });
      const e = new Error('auth_failed_' + res.status); e.code = 'AUTH'; throw e;
    }
    // S2002: only a 2xx carrying a loadDetails array is a listing. Anything else (transport failure,
    // a 429/503 that outlasted the retries, another non-2xx, a 2xx that is not the listing JSON) used
    // to fall through to [] - indistinguishable from a genuine delist to listingProbe, the never-listed
    // check and discovery's dead-man ping. It throws before any read-success or listing stamp.
    const d = (res.json && (res.json.data || res.json)) || {};
    if (!(res.status >= 200 && res.status < 300) || !Array.isArray(d.loadDetails)) {
      const e = new Error(res.status >= 200 && res.status < 300
        ? 'listing_unreadable_' + res.status : 'listing_failed_' + res.status);
      e.code = 'LISTING_FAILED'; e.status = res.status;
      throw e;
    }
    // A 200 HERE IS THE STRONGEST READ EVIDENCE THERE IS, and it has to reset the read streak or the
    // read side has no success axis at all. login() authenticates against /sp/base/*; this is
    // /sp/loads/v4 - the very endpoint whose refusals feed the read streak - so a 200 from it is
    // proof about that streak's own subject rather than an inference from a neighbouring endpoint.
    // Without this, two transient read 401s an interval apart with a healthy discovery poll between
    // them would latch an account that was demonstrably reading fine thirty seconds earlier.
    //
    // It resets the READ streak only, and nothing about the latch. A read says nothing about write
    // scope, which is the one thing the latch is about.
    this._noteReadSuccess();
    const allMapped = d.loadDetails.map((l) => this._mapLoad(l));
    await this._enrichDimensions(d.loadDetails, allMapped, enrichDimensions);
    const mapped = allMapped.filter((a) => a.biddingCloseTime); // auction loads only
    // cache metadata so getAuctionState can serve countdown/close-model without a REST hit per tick
    // ...and stamp WHEN each load was seen, off ONE clock read for the whole response so every load
    // in a listing shares an identical timestamp (a per-load Date.now() would make loads from the
    // same response differ by the loop's own duration, which would be noise, not signal).
    const seenAt = Date.now();
    for (const a of mapped) {
      this.loadMeta.set(a.id, a);
      this.loadLastSeenAt.set(a.id, seenAt);
    }
    // This IS the full listing landing, whether a discovery poll, the getAuctionState safety net or
    // a listingProbe triggered it - see lastFullListingAt() and _checkDelisted.
    this._lastFullListingAt = seenAt;
    return mapped;
  }

  /**
   * One PENDING-tab page of /sp/loads/v4, or null when the read did not land. A closed load sits in
   * PENDING with our active bid row frozen at its final rank (HAR 2026-09-28). Same request path,
   * retry and read-auth accounting as listAuctions, except that a failure returns null instead of
   * throwing: every caller treats null as "not known", never as an empty board (S2002).
   */
  async _readPendingPage(opts) {
    let res;
    try {
      await this.ensureSession();
      res = await this._post('/sp/loads/v4', this._v4Body('PENDING', opts));
    } catch (_) { return null; }
    if (res.status === 401 || res.status === 403) {
      this._noteAuthFailure({ status: res.status, text: res.text, where: 'readPending', kind: 'read' });
      return null;
    }
    const d = res.status === 200 && res.json ? (res.json.data || res.json) : null;
    if (!d || !Array.isArray(d.loadDetails) || !Array.isArray(d.bidDetails)) {
      log.warn('SuperProcure PENDING read did not land', { httpStatus: res.status, rateLimited: !!res.rateLimited });
      return null;
    }
    this._noteReadSuccess();
    return d;
  }

  _ownCarrierIds() {
    return [this.account && this.account.carrierId];
  }

  // Tabs can move between close and allotment. Read the same load, never an account-wide cached rank.
  // Each HTTP call is single-attempt; this outer schedule bounds retries for both failure and absence.
  async readSettledOutcome(auctionId, { expectedAmount = null, pricingMode = 'flat' } = {}) {
    const id = String(auctionId);
    const loadId = /^\d+$/.test(id) ? Number(id) : id;
    if (expectedAmount != null && (!Number.isFinite(Number(expectedAmount)) || Number(expectedAmount) <= 0)) {
      return { settled: false, reason: 'amount_mismatch' };
    }
    let reason = 'not_found';
    for (const delay of [0, 1000, 2000]) {
      if (delay) await this.sleep(delay);
      for (const tab of ['PENDING', 'CONFIRMED', 'HISTORY']) {
        let res;
        try {
          await this.ensureSession();
          res = await this._request('POST', '/sp/loads/v4', { body: this._v4Body(tab, { loadId }) });
        } catch (_) { reason = 'read_failed'; continue; }
        if (res.status === 401 || res.status === 403) {
          this._noteAuthFailure({ status: res.status, text: res.text, where: 'readSettledOutcome', kind: 'read' });
          return { settled: false, reason: 'auth_failed' };
        }
        if (res.status === 429) return { settled: false, reason: 'rate_limited' };
        const d = res.status === 200 && res.json ? (res.json.data || res.json) : null;
        if (!d || !Array.isArray(d.loadDetails) || !Array.isArray(d.bidDetails)) {
          reason = 'read_failed'; continue;
        }
        this._noteReadSuccess();
        const load = d.loadDetails.find((l) => l && String(l.id) === id);
        if (!load) continue;
        if (load.biddingOn !== 0 && load.biddingOn !== false) {
          // Wait for closure on a later pass; another tab can still hold an older view of this load.
          reason = 'not_closed';
          break;
        }
        if (load.loadCancelReason || /cancel|inactive/i.test(String(load.loadStatusKey || ''))) {
          return { settled: false, reason: 'cancelled' };
        }
        const owners = new Set(this._ownCarrierIds().filter((c) => c != null).map(Number));
        if (load.branchCarrierCarrierId != null) owners.add(Number(load.branchCarrierCarrierId));
        const bids = d.bidDetails.filter((b) => b && String(b.load) === id && b.isActive === 1
          && b.bidCarrierId != null && owners.has(Number(b.bidCarrierId)));
        if (bids.length !== 1) { reason = 'own_bid_ambiguous'; continue; }
        const bid = bids[0];
        const rank = numericOrNull(bid.rank);
        if (!Number.isInteger(rank) || rank < 1) { reason = 'rank_unknown'; continue; }
        let amount = numericOrNull(bid.amount);
        if (pricingMode === 'per_tonne') {
          const pmt = numericOrNull(bid.amountPMT);
          const rate = numericOrNull(bid.bidRate);
          if (pmt == null || rate == null || Math.abs(pmt - rate) > 0.01) {
            return { settled: false, reason: 'amount_conflict' };
          }
          amount = pmt;
        }
        if (amount == null || amount <= 0 || (expectedAmount != null
            && Math.abs(amount - Number(expectedAmount)) > 0.01)) {
          return { settled: false, reason: 'amount_mismatch' };
        }
        const awardConfirmed = numericOrNull(bid.bidAllottedVehicleCount) > 0;
        if (rank > 1 && awardConfirmed) return { settled: false, reason: 'rank_award_conflict' };
        return { settled: true, rank, amount, source: 'sp_v4', tab,
          verifiedAt: Date.now(), awardConfirmed };
      }
    }
    return { settled: false, reason };
  }

  /**
   * Our live rank on a load whose socket has never ranked us (the Epack logins), off the OPEN tab's
   * bidDetails - proven 2026-09-28 to carry our active row at the rank the socket showed. The engine
   * asks after each accepted walk write with the price it wrote. Never awaited by a bid: the rank
   * reaches the walk through getAuctionState once the read lands, and until then it stays unknown.
   * At most one read per ask, never two within LIVE_RANK_MIN_GAP_MS on this login (asks made while
   * one is waiting share it), one attempt with no retry: a failed read is an unknown rank. Every
   * response answers every load we have asked about, so an ask made while a read is in flight is
   * served by it as well as by its own read.
   */
  requestLiveRank(auctionId, price) {
    const id = String(auctionId);
    if (!this.sock || this._socketRanked.has(id)) return false;
    const s = this.sock.state(id);
    if (s && s.myRank != null) { this._socketRanked.add(id); return false; }
    this._liveRankPrice.set(id, Number(price));
    if (this._liveRankPending) { this._liveRankPending.add(id); return true; }
    this._liveRankPending = new Set([id]);
    const wait = this._liveRankLastAt == null ? 0 : Math.max(0, this._liveRankLastAt + LIVE_RANK_MIN_GAP_MS - Date.now());
    this._setTimeout(() => { this._readLiveRank().catch(() => {}); }, wait);
    return true;
  }

  async _readLiveRank() {
    this._liveRankPending = null;
    const sentAt = Date.now();
    this._liveRankLastAt = sentAt;
    let res;
    try {
      await this.ensureSession();
      res = await this._request('POST', '/sp/loads/v4', { body: this._v4Body('OPEN') });
    } catch (e) {
      log.warn('SuperProcure live-rank read did not land; rank stays unknown', { err: (e && e.message) || String(e) });
      return;
    }
    if (res.status === 401 || res.status === 403) {
      this._noteAuthFailure({ status: res.status, text: res.text, where: 'liveRank', kind: 'read' });
      return;
    }
    const d = res.status === 200 && res.json ? (res.json.data || res.json) : null;
    if (!d || !Array.isArray(d.loadDetails) || !Array.isArray(d.bidDetails)) {
      log.warn('SuperProcure live-rank read did not land; rank stays unknown', { httpStatus: res.status, rateLimited: !!res.rateLimited });
      return;
    }
    this._noteReadSuccess();
    this._applyLiveRanks(d, sentAt);
  }

  // A load no longer on the OPEN tab has closed and is forgotten. A read with no row of ours keeps the
  // last rank (the engine ages it by round), and a response older than the rank held never replaces it.
  _applyLiveRanks(d, at) {
    const ranks = settledFromV4(d, { carrierIds: this._ownCarrierIds() });
    for (const id of [...this._liveRankPrice.keys()]) {
      if (!ranks.has(id)) { this._liveRankPrice.delete(id); this._liveRank.delete(id); continue; }
      const hit = ranks.get(id);
      const prev = this._liveRank.get(id);
      if (hit && !(prev && prev.at > at)) this._liveRank.set(id, { rank: hit.rank, amount: hit.amount, at });
    }
  }

  // Served only for the price the engine last wrote, so a read of an earlier bid is never this one's rank.
  _liveRankFor(id) {
    const e = this._liveRank.get(id);
    const price = this._liveRankPrice.get(id);
    return e && e.amount != null && price != null && e.amount === price ? e : null;
  }

  /**
   * Every PENDING load since `from`, paged, for the back-fill. null when any page fails, so a caller
   * never mistakes a partial read for the whole tab.
   */
  async readPendingOutcomes({ from, maxPages = 20 } = {}) {
    const outcomes = new Map();
    let loads = 0;
    for (let page = 0; page < maxPages; page++) {
      const d = await this._readPendingPage({ from, offset: page * V4_PAGE });
      if (!d) return null;
      for (const [k, v] of settledFromV4(d, { carrierIds: this._ownCarrierIds() })) {
        if (v || !outcomes.has(k)) outcomes.set(k, v);
      }
      loads += d.loadDetails.length;
      if (d.loadDetails.length < V4_PAGE) return { outcomes, loads };
    }
    return null;
  }

  /**
   * When the adapter's last full listAuctions() completed successfully - null if this process has
   * never completed one. Separate from listingTrace on purpose: that envelope's key set is pinned
   * (test-rejection-classify-contract.js C3) and this is adapter-wide, not per-load.
   */
  lastFullListingAt() {
    return this._lastFullListingAt;
  }

  /**
   * How long ago this load was last seen in a list response, and the biddingOn we cached from it.
   *
   * Pure cache reads - no request, no await - so the engine can call it from the rejection path
   * without adding anything to the money path. It answers the question the engine could not
   * previously ask: is SuperProcure still LISTING this load (in which case a refusal means it is
   * listed-but-closed to bidding), or has it stopped returning it entirely and our never-evicted
   * loadMeta entry is the only thing still claiming the load is live?
   *
   * `lastSeenInListAgoMs` is null for a load this adapter has never listed - which is itself a real
   * and meaningful state (a load armed from a durable intent after a restart, before the first
   * listing) and must read as UNKNOWN, never as a fabricated age.
   *
   * @param {string|number} auctionId - the load id
   * @returns {{lastSeenInListAt: number|null, lastSeenInListAgoMs: number|null, biddingOn: boolean|null}}
   */
  listingTrace(auctionId) {
    const id = String(auctionId);
    const at = this.loadLastSeenAt.has(id) ? this.loadLastSeenAt.get(id) : null;
    const meta = this.loadMeta.get(id);
    return {
      lastSeenInListAt: at,
      lastSeenInListAgoMs: at == null ? null : Math.max(0, Date.now() - at),
      biddingOn: (meta && meta.biddingOn != null) ? meta.biddingOn : null,
    };
  }

  /**
   * Is SuperProcure STILL LISTING this load, right now? The live half of listingTrace.
   *
   * WHY BOTH EXIST. listingTrace answers "when did we last see it", off the cache, for free. That
   * discriminates only at discovery-interval granularity (~30s) and cannot separate "SP dropped this
   * load" from "we simply have not polled since". This one re-runs the listing and answers the sharper
   * question outright:
   *
   *   still listed, biddingOn 1  -> SuperProcure is listing the load as OPEN and refusing bids on it
   *                                 anyway. That is a question for the vendor, not a bug we can fix.
   *   absent from the listing    -> SuperProcure DELISTED it, and our never-evicted loadMeta entry is
   *                                 the only thing still claiming the load is live. Cache invalidation
   *                                 plus the stand-down is then ours to build.
   *
   * COST, and why it is acceptable. This is one extra REST read, and it is called on exactly one path:
   * a load the platform has just refused with "Load not available for bidding", which the engine is
   * about to stand down on permanently. Nothing is waiting on it - no bid is in flight, no countdown
   * is being raced - so it adds nothing to any live money path. It is NOT called on ordinary
   * price-class rejections, which retry and do have a clock to beat.
   *
   * Returns nulls rather than throwing on any failure: this is telemetry on a path that has already
   * failed, and it must never be able to change what the engine does about the refusal.
   *
   * @param {string|number} auctionId - the load id
   * @returns {Promise<{stillListed: boolean|null, biddingOn: boolean|null, biddingCloseTime: *, listedCount: number|null}>}
   */
  /**
   * One listAuctions() shared by every concurrent listingProbe caller. A restart arms every
   * never-listed load at once, and each one's fallback probe (see bidEngine._checkDelisted) would
   * otherwise open its own board-wide read in the same instant - the read-cost defect BC-15 Fix B
   * shipped (ruling 65). Not applied to listAuctions() itself: the discovery poller's own cadence is
   * untouched, and this only collapses probes that land inside one already-in-flight read.
   */
  _sharedListing() {
    if (!this._listingInflight) {
      this._listingInflight = this.listAuctions().finally(() => { this._listingInflight = null; });
    }
    return this._listingInflight;
  }

  async listingProbe(auctionId) {
    const id = String(auctionId);
    try {
      const mapped = await this._sharedListing();
      const hit = mapped.find((a) => String(a.id) === id) || null;
      return {
        stillListed: !!hit,
        biddingOn: hit && hit.biddingOn != null ? hit.biddingOn : null,
        biddingCloseTime: hit ? hit.biddingCloseTime : null,
        listedCount: mapped.length,
      };
    } catch (e) {
      return { stillListed: null, biddingOn: null, biddingCloseTime: null, listedCount: null,
        error: String((e && e.message) || e) };
    }
  }

  /**
   * The parsed close the last listing showed for this load, or null. A cache read: after a
   * listingProbe it is that probe's listing. Separate from listingProbe because that envelope's key
   * set is pinned (test-rejection-classify-contract.js).
   */
  listedCloseAt(auctionId) {
    const meta = this.loadMeta.get(String(auctionId));
    return meta && meta.closesAt != null ? meta.closesAt : null;
  }

  /**
   * Live state of one load for the engine's hot-path poll (gap A1).
   *
   * Source of truth per field:
   *   - myRank, totalBidders, soft-extension : the SOCKET's latest `bidListenerV2` frame (our
   *     active bid's `rank`, the full ladder, the AuctionExtended flag).
   *   - closesInMs : the socket's `loadEndTime` (reflects live anti-snipe extensions) off the
   *     socket's own server clock; falls back to the REST bidding-close time until the first
   *     frame arrives.
   *   - closeModel, revisionsLeft : the cached REST metadata, upgraded to 'soft' the moment the
   *     socket reports an extension.
   *
   * measuredRttMs is deliberately the BID-WRITE latency proxy (last real placeBid, else
   * assumedRttMs), NOT this call's ~0ms cache-read time — the engine uses it to
   * latency-compensate the snipe fire, where write latency is what counts.
   *
   * Without a socket attached this degrades to REST-only: countdown works, rank stays null (the
   * pre-A1 behaviour).
   *
   * @param {string|number} auctionId - the load id to read live state for
   * @returns {Promise<Object>} - `{ ok: false, measuredRttMs }` when the load's state is not
   *   knowable yet (the engine skips the tick; `authError: true` is added on an AUTH failure),
   *   else `{ ok: true, status, myRank, totalBidders, standingL1Price, closesInMs, revisionLimit,
   *   revisionsLeft, minDecrement, closeModel, extendMs, extendCount, triggerWindowMs, closesAtMs,
   *   measuredRttMs, clockErrorMs }`. clockErrorMs bounds how far closesInMs may be from
   *   SuperProcure's own clock (null until a clock reading exists).
   */
  async getAuctionState(auctionId) {
    const id = String(auctionId);
    const rtt = this.lastWriteRttMs != null ? this.lastWriteRttMs : this.assumedRttMs;

    let meta = this.loadMeta.get(id);
    // safety net: if we've never listed this load and have an account, list once
    // (throttled) so we at least know its scheduled close. The engine normally
    // primes loadMeta via listAuctions() at arm time, so this rarely fires.
    if (!meta && this.account && Date.now() - this._lastUnknownListAt > 5000) {
      this._lastUnknownListAt = Date.now();
      try { await this.listAuctions(); meta = this.loadMeta.get(id); }
      catch (e) { if (e && e.code === 'AUTH') return { ok: false, authError: true, measuredRttMs: rtt }; }
    }

    this._ensureWatching(id);
    const s = this.sock ? this.sock.state(id) : null;

    // nothing known yet (no metadata, no frame) -> tell the engine to skip + retry,
    // never report closesInMs:0 (that would trip a premature finalize).
    if (!meta && !s) return { ok: false, measuredRttMs: rtt };

    // The close time can be UNKNOWN even with metadata cached: a scheduled-but-not-yet-open
    // window maps with closesAt null (biddingOn stays !== 1 until SP opens the window - see
    // _mapLoad), and the socket has no frame until the auction room goes live. Unknown is
    // NOT closed: the old `?? 0` here turned that gap into closesInMs:0 -> status 'closed',
    // finalizing a real auction 30 minutes early as "lost" with zero bids at the arm-lead
    // wake, 10s before its window even opened (OA 23088404, 2026-07-13). Skip + retry
    // instead - the countdown appears the moment biddingOn flips / the first frame lands,
    // and a permanently-unknown load surfaces as repeated_read_failures rather than a
    // silent false loss.
    // The absolute close, preferring the socket's live loadEndTime (it reflects extensions) over the
    // REST close. Hoisted out of the payload so the publish site has one value to test.
    const closesAtMs = (s && s.loadEndTimeMs) || (meta && meta.closesAt) || null;

    const closesInMs = this.sock
      ? this.sock.closesInMs(id, meta && meta.closesAt)
      : (meta && meta.closesAt ? Math.max(0, meta.closesAt - this.serverNow()) : null);
    if (closesInMs == null) return { ok: false, measuredRttMs: rtt };

    let myRank = s ? (s.myRank ?? null) : null;
    if (myRank != null) this._socketRanked.add(id);
    const live = myRank == null && closesInMs > 0 ? this._liveRankFor(id) : null;
    if (live) myRank = live.rank;
    const totalBidders = s && Array.isArray(s.bids) ? s.bids.length : 0;
    const softObserved = !!(s && s.extended) || !!(meta && meta.softClose);

    return {
      ok: true,
      status: closesInMs <= 0 ? 'closed' : 'live',
      myRank,
      // Our own standing amount, only when the socket is attached: REST alone cannot see it, and an
      // absent field is what tells the engine there is no evidence either way. pushFed: this read is
      // the socket's own cache and issues no request, so the engine may repeat it after a bid.
      ...(this.sock ? { myAmount: live ? live.amount : (s ? (s.myAmount ?? null) : null), pushFed: true } : {}),
      ...(live ? { rankFromRest: true, restRankAt: live.at } : {}),
      totalBidders,
      standingL1Price: null,             // SuperProcure is rank-only
      closesInMs,
      clockErrorMs: this.sock
        ? (typeof this.sock.clockErrorMs === 'function' ? this.sock.clockErrorMs() : null)
        : this.serverTimeErrorMs,
      // static per-load cap (total allowed), NOT a live remaining — the engine seeds from
      // it and decrements locally. revisionsLeft is null: neither REST nor socket exposes
      // our remaining count today.
      revisionLimit: meta ? meta.revisionLimit : null,
      revisionsLeft: null,
      // per-load Bid Difference (observed live as 100 AND 1500). The engine must honor THIS,
      // not the static capabilities() default, or its steps get rejected on wide-decrement loads.
      minDecrement: meta && meta.minDecrement != null ? meta.minDecrement : null,
      // LIVE REMAINING QUANTITY - what is STILL BIDDABLE on this load. NOT `units` (SP's
      // vehicleCount), which is the ORIGINAL requirement and never moves: SuperProcure decrements
      // this one as the shipper partially allots, and quoting more than it is left is what SP
      // refuses outright with "Quote quantity is greater than total quantity". It is gated by the
      // branch's own branchPartialAllotment flag, so it stays rare rather than constant.
      //
      // It MUST come from `meta`, which loadMeta re-sets on every listAuctions poll (~30s), and
      // never from the price-request snapshot: that snapshot is written once at discovery and never
      // refreshed, so at bid time it still holds the PRE-allotment number - which is why a captured
      // payload will appear to refute all of this. Anyone re-checking has to read the live value.
      //
      // null when SP did not send it (older rows, mock/sim); the engine treats null as "unknown" and
      // keeps bid-max rather than inventing a limit. Typed rather than coerced for the same reason -
      // see numericOrNull, where a zero read off a malformed field is the outcome being avoided.
      remainingQuantity: numericOrNull(meta && meta.loadTotalQuantity),
      closeModel: softObserved ? 'soft' : 'hard',
      // anti-snipe extension interval (ms); the soft-close finalize debounce waits longer
      // than this. null on a hard close.
      extendMs: meta && meta.extendSeconds ? meta.extendSeconds * 1000 : null,
      // L3 soft-close endgame inputs (all null on a hard close / a load that never surfaced them):
      //  - extendCount     : the MAX anti-snipe extensions (branchExtendAuctionCount). null = UNKNOWN
      //                      cap -> the engine fails closed to the Module-1 hard-close snipe.
      //  - triggerWindowMs : the seconds-remaining threshold that triggers an extension, in ms.
      //  - closesAtMs      : the ABSOLUTE server-epoch close (socket loadEndTime reflects live
      //                      extensions; REST close until the first frame). The engine tracks forward
      //                      jumps of THIS to count extensions - clock-robust vs the relative closesInMs.
      extendCount: meta && Number.isFinite(meta.extendCount) ? meta.extendCount : null,
      triggerWindowMs: meta && Number.isFinite(meta.triggerWindowSeconds) ? meta.triggerWindowSeconds * 1000 : null,
      // OMITTED, never null. Today this branch cannot be taken - closesInMs above is derived from the
      // same two sources, so ok:true already implies a close exists - but the safety must not depend
      // on that coupling. If a future change gives closesInMs a third fallback, a null would reach
      // bidEngine.js:1047, where the test is `Number.isFinite(Number(closesAtMs))` and `Number(null)`
      // is 0, which IS finite: the engine would take epoch 0 as the absolute close. Absent yields NaN,
      // fails that test, and resolves to null as intended. test-adapter-wire pins the coupling.
      ...(closesAtMs != null ? { closesAtMs } : {}),
      // The close the last listing showed and when it landed, for the round tracker's cross-check
      // against the socket's close (a frame the socket missed shows here first).
      ...(meta && meta.closesAt != null && this.loadLastSeenAt.has(id)
        ? { restClosesAtMs: meta.closesAt, restSeenAt: this.loadLastSeenAt.get(id) } : {}),
      measuredRttMs: rtt,
    };
  }

  /**
   * buildBidPayload - THE single place the createV2 method + URL + body are constructed, from a
   * LoadRules (or a legacy opts bag) + the amount. Every future mechanic (transit, ceiling, per-tonne,
   * ...) becomes one field on LoadRules + one branch HERE, never a change threaded through five
   * money-path files. Carrier-per-load is the FIRST mechanic to consume the pipeline.
   *
   * CARRIER-PER-LOAD: the ?carrier= query param AND the carrierBranchId body field are the load's own
   * carrier registration (rules.branchCarrierCarrierId) when it carries one, else the account's own
   * carrier (this.account.carrierId) - FAIL-SAFE on absent, so a load whose rules never resolved a
   * carrier still bids exactly as it does today. For the currently-live SAME-carrier customers
   * (Syngenta via 10686, Durian via 4441) branchCarrierCarrierId EQUALS the account carrier, so the
   * wire is BYTE-IDENTICAL to before; only a FOREIGN-carrier load (e.g. Havells 5963 routed through
   * master 2667) moves the two carrier fields to the load's carrier - fixing the master-account defect
   * that 400'd 27 Renewsys bids sent as the static 2667.
   *
   * CONDITIONAL TRANSIT TIME: when the load's rules say SuperProcure requires transit time on the
   * bid (rules.loadIsTransitTimeOn), the transitTime wire field becomes the capture-provided
   * rules.transitDays as a STRING of days ("3" - the exact shape proven live on SIKA: transitTime
   * null -> HTTP 400, "3" -> 201). The days ride on the LoadRules (merged in at armFromRequest), so
   * every rung/revision on the load re-sends the SAME value - SuperProcure treats it as sticky per
   * load. A transit-required load whose days were never captured is REFUSED (MISSING_TRANSIT_TIME,
   * via assertTransitSatisfied below) before anything is constructed - fail closed, never the
   * silent bid-and-400 those loads produced before this mechanic existed. A load withOUT the flag
   * keeps transitTime at the legacy `o.transitTime ?? null` - byte-identical to today.
   *
   * Every OTHER wire field is still read from the SAME opts keys with the SAME defaults it always had
   * (in='FTL', vcq=-1, type='E-AUCTION', ...). A LoadRules carries its remaining facts under
   * DISTINCT keys this builder does not yet consume, so a same-carrier non-transit LoadRules bid
   * stays byte-identical to the pre-pipeline empty-opts bid.
   *
   * Fails CLOSED (assertRulesSupported) on a rules object naming a mechanic we have not built, so no
   * caller - engine, harness, or direct - can ever construct a wrong payload for an unbuilt mechanic.
   *
   * @param {Object} rules - LoadRules | legacy opts bag (may also carry a `floor` the belt reads
   *   in placeBid)
   * @param {number} price - the amount to bid (rounded onto the wire)
   * @param {string|number} auctionId - the authoritative wire load id (matches placeBid's arg;
   *   overrides rules.loadId)
   * @returns {{ method: string, url: string, body: Object }} - the createV2 request triple
   *   { method, url, body }
   */
  buildBidPayload(rules, price, auctionId) {
    const o = rules || {};
    assertRulesSupported(o); // refuse an unbuilt mechanic BEFORE constructing anything
    assertTransitSatisfied(o); // refuse a transit-required load with no captured days (belt; the engine guard is the suspenders)
    const load = Number(auctionId != null ? auctionId : o.loadId);
    // Route to the load's own carrier registration when the rules carry one, else the account carrier
    // (fail-safe). `!= null` matches the LoadRules deriveLoadRules default (null when SP omitted it).
    // Numeric-normalise the routed id to the account carrier's type: SuperProcure returns carrier ids
    // as strings on its socket frames (spSocket Number()-normalises for exactly this reason), so a
    // same-carrier load must stay BYTE-IDENTICAL even if branchCarrierCarrierId arrives as "10686"
    // rather than 10686 - both go on the wire as the number 10686, and the differs-from-account compare
    // below stays numeric (no spurious cross-carrier log on a same-carrier bid). A present-but-non-
    // numeric value falls back to the account carrier rather than ever emitting carrier=NaN.
    const accountCarrier = this.account.carrierId;
    const routed = o.branchCarrierCarrierId != null ? Number(o.branchCarrierCarrierId) : accountCarrier;
    const carrier = Number.isFinite(routed) ? routed : accountCarrier;
    if (carrier !== accountCarrier) {
      // A live cross-carrier route must be legible at the default LOG_LEVEL=info: it pairs with the
      // rejection warn if SP still 400s, and confirms the bid is actually being routed, not silently
      // sent as the account carrier (the failure mode this whole change fixes).
      log.info('bid routed to per-load carrier (differs from account carrier)', {
        auctionId: load, accountCarrier, routedCarrier: carrier });
    }
    // PER-TONNE (PMT) wire shape. Everything ABOVE this seam (the price page, the engine ladder, the
    // engine's own floor guards) works in per-MT terms, the desk's mental model - and so does the
    // WIRE: a PMT createV2 carries the bare per-MT rate and SuperProcure does the multiplication
    // itself (see the block comment on the PMT wire above; captured 2026-08-05 on load 23828313).
    // So there is NO unit change at this boundary and NO conversion to keep in lockstep: `amount` is
    // Math.round(price) on both branches, and the wire-space floor is the operating floor unchanged,
    // which leaves the placeBid belt comparing per-MT against per-MT.
    //
    // What the per_tonne branch still does is REFUSE. assertRulesSupported above already held every
    // unsupported case (SP_PMT_BID off, non-MT unit, a load carrying a ceiling), so reaching here
    // means a real, MT, flag-enabled per-tonne bid; the two asserts below are the structural last
    // line on live money, not the primary gate.
    const perTonne = o.pricingMode === 'per_tonne';
    // The operating floor, in the SAME unit as `price` on BOTH branches - per-MT on a per-tonne load,
    // per-vehicle rupees on a flat one. Nothing rescales it any more.
    const wireFloor = Number.isFinite(o.floor) ? o.floor : null;
    if (perTonne) {
      if (o.unit !== 'MT') {
        // KG / unknown unit stays fail-closed even here (assertRulesSupported already refused it); this
        // is the structural last line, so an MT-only per-tonne write can never run on a KG-quoted load
        // (the ~1000x trap). No KG PMT write has ever been captured - Tata / Ashirvad wait for their
        // own supervised capture. Do not relax this because the amount is now unconverted: an unproven
        // unit is a wrong RATE on the wire, which the arithmetic change does nothing to make safe.
        const e = new Error(`pmt_unit: per-tonne bidding is MT-only; load ${load} unit=${JSON.stringify(o.unit)} - refusing`);
        e.code = 'PMT_UNIT';
        throw e;
      }
      if ((o.vcq ?? -1) !== -1) {
        // Multi-vehicle PMT is DELIBERATELY UNBUILT: PMT bids with the vcq:-1 sentinel, and a
        // partial-tonnage PMT bid is a bid SHAPE nothing has ever captured. isMultiVehicle already
        // returns false for PMT so the engine never sets vcq:N here; this refuses any caller that
        // tried to. NOTE (2026-08-05 capture): vcq:-1 does NOT mean "one vehicle" to SuperProcure -
        // it derived bidVehicleCount 2 from the load - so a PMT bid commits to the load's FULL
        // vehicle count. That is another reason a hand-set vcq must not slip through here.
        //
        // DO NOT read this as the split-load guard: it is UNREACHABLE from the engine (nothing there
        // ever sets a non-(-1) vcq on a PMT load), so it protects direct/harness callers only. The
        // full-count commitment this note describes is handled where it can actually be acted on -
        // LoadRules.pmtVehicleCount states the truck count, renderPriceForm shows it to the desk
        // before a cost is entered, and bidEngine's vehicle-count read-back oracle checks SP's
        // recorded count against it. If you are looking for the vehicleCount/weight comparison the
        // old PMT_QUANTITY refusal rested on, it lives in derivePmtVehicleCount, as a fact.
        const e = new Error(`pmt_multi_vehicle: multi-vehicle per-tonne bidding is not built; load ${load} must bid with the vcq:-1 sentinel, got vcq=${JSON.stringify(o.vcq)}`);
        e.code = 'PMT_MULTI_VEHICLE';
        throw e;
      }
    }
    // Whole rupees, on both branches. On flat this is the per-vehicle rupee amount; on per-tonne it
    // is the per-MT RATE. Byte-identical arithmetic either way - that identity IS the fix.
    const amount = Math.round(price);
    const body = {
      load,
      carrierBranchId: carrier, // per-load routed carrier (identical value to the ?carrier= query param)
      amount,
      bidNotes: o.bidNotes ?? null,
      type: o.type || 'E-AUCTION',
      // Quote basis on the wire. On a per-tonne load send the TRUE basis 'PMT': SuperProcure's
      // loadShipmentType LIES "FTL" on every PMT load (the source of the old realAdapter.js in:"FTL"
      // defect - o.shipmentType read that lie), so the flat default would mislabel a per-tonne bid.
      // PROVEN, no longer an assumption: the browser itself sends in:"PMT" on a PMT createV2
      // (2026-08-05 capture, load 23828313 -> HTTP 201). Flat loads keep the legacy
      // o.shipmentType || 'FTL' - byte-identical to before.
      in: perTonne ? 'PMT' : (o.shipmentType || 'FTL'),
      vcq: o.vcq ?? -1,
      loadLotId: o.loadLotId ?? null,
      reportingTime: o.reportingTime ?? null,
      // Conditional transit time: a STRING of days on a transit-required load (SIKA-proven wire
      // shape; assertTransitSatisfied above guarantees normalizeTransitDays succeeds here), the
      // legacy null passthrough on everything else (byte-identical to the pre-transit body).
      transitTime: o.loadIsTransitTimeOn ? String(normalizeTransitDays(o.transitDays)) : (o.transitTime ?? null),
      requestTime: Date.now(),
      vehicleTypes: o.vehicleTypes || [],
      bidDiscount: o.bidDiscount ?? 0,
      isOfferRate: o.isOfferRate ?? false,
      isWeb: 1,
    };
    // wireFloor: the operating floor expressed in the SAME unit as body.amount - which is now the
    // operating floor UNCHANGED on both branches, because body.amount is Math.round(price) on both.
    // Still carried out of this function rather than re-resolved at the belt, so the belt provably
    // asserts against the floor this build used. null when no floor was handed down (legacy/harness
    // callers).
    return { method: 'POST', url: `/sp/bids/createV2?id=${load}&carrier=${carrier}`, body, wireFloor };
  }

  /**
   * Place / revise a bid (per vehicle). Contract captured from a real submit on
   * 2026-06-19 (load 22365292): POST /sp/bids/createV2?id=<loadId>&carrier=<carrierId>
   * with a JSON body; returns 201 Created on success.
   *
   * GATED: throws when `writeEnabled` is false — a defensive backstop the kill-switch
   * lowers to hard-stop the write path. Real mode leaves it open by default so the
   * engine bids; a read-only "Connect" adapter never reaches placeBid.
   *
   * Every throw raised before the createV2 request is issued carries `placed: false` - the gate,
   * the payload build and the vcq/floor/ceiling belts - so the engine books nothing for it. The
   * status-0 NETWORK throw after the request does not: that write may have been received.
   */
  async placeBid(auctionId, price, opts = {}) {
    const wire = { dispatched: false };
    try {
      return await this._submitBid(auctionId, price, opts, wire);
    } catch (e) {
      if (!wire.dispatched && e && typeof e === 'object') e.placed = false;
      throw e;
    }
  }

  async _submitBid(auctionId, price, opts, wire) {
    if (!this.writeEnabled) {
      const e = new Error('write_disabled: bidding is off; arm a load with a floor + explicit go to enable');
      e.code = 'WRITE_DISABLED';
      throw e;
    }
    // Order here is deliberate. writeEnabled stays FIRST: a killed engine must keep throwing
    // WRITE_DISABLED exactly as it does today - that is the operator's own control and its behaviour
    // is understood. The auth gate sits below it and above ensureSession, so a held write builds no
    // payload and touches no wire.
    //
    // THE TRIAL WRITE. A latched account does not refuse every write forever - it refuses all but ONE
    // per authWriteTrialIntervalMs, because a write that succeeds is the only observation that can
    // ever prove write scope is back, and a mechanism with no way to obtain that proof is a mechanism
    // that never recovers without a human.
    //
    // THIS IS THE CHEAP PEEK ONLY, and it consumes NOTHING - it exists to stop a held write building
    // a payload. The allowance is claimed far below, immediately before the request; see
    // _claimAuthWriteTrial for why it cannot be claimed at this gate.
    if (this.authWriteHeld()) {
      this._observeHoldReason('placeBid:held');
      return this._authRejection({ status: 401, text: null, raw: null, carrierSent: null, latencyMs: 0 });
    }
    // ensureSession THROWS code AUTH for both of the two token-lifetime conditions, and they are NOT
    // the same thing. On the write path either throw would be the fabricated-landed-bid bug (see the
    // engine's uncertain-outcome handler), so both convert to the same non-throwing rejection the
    // wire 401 takes - but only one of them is evidence of anything.
    //
    //   token_expiring (GRACE, exp-60s <= now < exp) - EXEMPT from the streak. Nothing has been
    //     observed and nothing has been revoked; counting it sealed the account off two ordinary bid
    //     attempts inside a token's own final minute, deterministically and with no SuperProcure-side
    //     condition at all. It has its own alert path in src/notify/tokenExpiry.js.
    //   token_expired (now >= exp) - already handled inside ensureSession, which opens the episode
    //     and alerts directly. It must NOT also feed the streak: it needs no corroboration, and
    //     routing it through a threshold is what made a fully lapsed token silent and unlatchable.
    //
    // Anything else arriving with code AUTH is an unrecognised refusal and DOES feed the write
    // streak, so a future condition added to ensureSession fails closed rather than silently exempt.
    try {
      await this.ensureSession();
    } catch (e) {
      if (e && e.code === 'AUTH') {
        if (e.authReason !== 'token_expiring' && e.authReason !== 'token_expired') {
          this._noteAuthFailure({ status: 401, text: (e && e.message) || null,
            where: 'placeBid:ensureSession', kind: 'write' });
        }
        return this._authRejection({ status: 401, text: null, raw: null, carrierSent: null, latencyMs: 0 });
      }
      throw e;
    }
    const t0 = Date.now();
    // THE single payload seam: LoadRules (or legacy opts) -> createV2 method + URL + body. The carrier
    // on the wire (?carrier= query param + carrierBranchId body field) is the load's routed
    // registration or the account carrier - see buildBidPayload.
    const { method, url, body, wireFloor } = this.buildBidPayload(opts, price, auctionId);
    const load = body.load;
    // Payload-build invariant (same discipline as the cost floor): vcq is -1 (proven sentinel) or a
    // positive integer truck count - never 0/NaN/other-negative. A forgotten or mis-derived count
    // throws here, so it becomes "no bid" instead of a dead "-1 vehicles" quote on live money.
    assertValidVcq(body.vcq);
    const carrierSent = body.carrierBranchId; // the carrier registration ACTUALLY sent (== the ?carrier= param)
    // Keep the live socket's self-match set aware of every carrier we bid AS: the moment we route to a
    // foreign registration, the socket must recognise our own bid frame or rank tracking goes blind on
    // a load we are actively bidding (the single-carrier self-match blind spot this change also fixes).
    // No-op without a socket, or on a socket stand-in that predates registerCarrier (older tests).
    if (this.sock && typeof this.sock.registerCarrier === 'function') this.sock.registerCarrier(carrierSent);
    // Timing only — how long the write took and what the platform returned. Separate from BidLogger's
    // business-outcome record; useful on its own when diagnosing latency/timeout issues against the
    // <=10s snipe window.
    log.debug('placeBid request started', { auctionId: load, carrierId: carrierSent, price: body.amount });
    // BELT: re-assert the floor at the adapter boundary, on the EXACT amount going on the wire, in
    // addition to the engine's two call-site guards (suspenders). The floor asserted here is the
    // wireFloor buildBidPayload returned - the monitor's operating floor in body.amount's OWN unit,
    // which on BOTH branches is now the operating floor unchanged: per-MT floor vs per-MT amount on a
    // per-tonne bid, per-vehicle vs per-vehicle on a flat one. The mixed-unit hazard this belt used to
    // have to reason about (a converted total on one side, a per-MT floor on the other) no longer
    // exists, because nothing converts. Falls back to opts.floor only for a legacy/harness caller whose
    // buildBidPayload path returned no wireFloor; the real engine path always carries it. A sub-floor
    // amount can never leave the building.
    const beltFloor = (wireFloor != null) ? wireFloor : ((opts && Number.isFinite(opts.floor)) ? opts.floor : null);
    if (beltFloor != null) assertAboveFloor(body.amount, beltFloor);
    // CEILING BELT: the upper-bound mirror of the floor belt, keyed off the load's OWN ceilingPrice
    // fact carried on the LoadRules (opts.ceilingPrice) rather than a separately-resolved field, so
    // the load's ceiling is enforced structurally straight from the fact the pipeline snapshotted.
    // A plausible ceiling makes a bid ABOVE it fail closed (throw, no silent clamp, nothing on the
    // wire); an absent/implausible ceiling is ignored (byte-identical to today - the floor still
    // guards the money). The engine caps the ladder so this never fires in normal operation; it is
    // the structural last line if any caller ever tried to bid over the ceiling.
    if (opts) {
      const ceil = plausibleCeiling(opts.ceilingPrice);
      if (ceil != null) assertBelowCeiling(body.amount, ceil);
    }
    // THE CLAIM, at the point of consumption. This position is load-bearing, and everything above -
    // ensureSession, buildBidPayload, the vcq/floor/ceiling assertions - can still throw without ever
    // reaching the wire; see _claimAuthWriteTrial for why the allowance cannot be claimed at the gate.
    wire.dispatched = true;
    const trial = this._claimAuthWriteTrial();
    if (!trial) {
      this._observeHoldReason('placeBid:trialLost');
      return this._authRejection({ status: 401, text: null, raw: null, carrierSent, latencyMs: Date.now() - t0 });
    }
    // NOTHING GOES BETWEEN THE CLAIM AND THE REQUEST - not a log line, not an await. The adjacency is
    // what makes "one trial per interval" hold across concurrently ticking monitors, and a log.debug
    // parked here (which is what the parallel implementation of this design did) is a real yield point
    // on the formatting path.
    //
    // retry:false on the write - a silent retry could double-bid (idempotency). Tight 2.5s timeout
    // (>> real write RTT ~80-200ms, << the <=10s snipe window) leaves time to read rank back on a hang.
    let res;
    try {
      res = await this._request(method, url, { body, retry: false, timeoutMs: 2500 });
    } catch (e) {
      // _request folds every transport failure - timeout, abort, socket error - into status 0 and
      // RETURNS. So a throw out of it means the request was never dispatched: nothing was observed by
      // SuperProcure, and the interval's one trial is given back rather than burned on a write that
      // did not happen. A status-0 RETURN is deliberately not refunded below: a timed-out request may
      // still have been received and acted on, and refunding there could put a second real write on
      // the wire inside one interval.
      trial.release();
      if (e && typeof e === 'object') e.placed = false;
      throw e;
    }
    const latencyMs = Date.now() - t0;
    // Guarded on a real response (status !== 0): a timed-out/network-failed write got no answer, so
    // its timeout span is not a measured round trip (the write may still have landed) - recording it
    // would install a fake multi-second RTT for every bid after this one on the same load.
    if (res.status !== 0) this.lastWriteRttMs = latencyMs; // feed the engine's snipe-timing compensation with the real write RTT
    log.debug('placeBid response received', { auctionId: load, httpStatus: res.status, latencyMs, rateLimited: !!res.rateLimited });
    if (res.rateLimited) {
      // throttled on the WRITE -> surface it. The engine keeps the rung unspent and
      // re-attempts next tick off last-known state (the "fire, don't wait" rule).
      return { accepted: false, status: res.status, myRank: null, revisionsLeft: null,
        reason: 'rate_limited', retryAfterMs: res.retryAfterMs, latencyMs, raw: res.json,
        carrierSent, text: res.text != null ? res.text : null };
    }
    if (res.status === 0) {
      // network error on the WRITE -> uncertain whether the bid landed. Throw so the
      // engine reads rank back before any retry (the idempotency oracle), as before.
      const e = new Error('bid_network_error'); e.code = 'NETWORK'; throw e;
    }
    // SESSION LOGGED OUT on the WRITE. Placed BEFORE `accepted` is computed, so an auth response can
    // never fall through into the generic price-shaped rejection below it - down there `accepted`
    // would be false, the per-load reject warn would fire, and `reason` would be built from
    // SuperProcure's own body ("Token is invalid."), which is precisely how 2026-08-04's 401s were
    // read as price refusals and walked ten ladders to the floor.
    //
    // It RETURNS and never throws. A throw out of placeBid routes into the engine's uncertain-outcome
    // handler, which on this platform can never disprove a commit (getAuctionState hardcodes
    // revisionsLeft null) and therefore records a landed bid that never existed - durable, and it
    // silences the very alarm that would have surfaced the outage.
    //
    // Logged at error, not the per-load warn below: this is account-wide, not one refused rung.
    if (res.status === 401 || res.status === 403) {
      const st = this._noteAuthFailure({ status: res.status, text: res.text, where: 'placeBid', kind: 'write' });
      log.error('placeBid refused: SuperProcure has logged this account out', {
        auctionId: load, httpStatus: res.status, carrierSent, latencyMs, accountId: this.accountId,
        writeStreak: st.writeStreak, readStreak: st.readStreak, latched: st.latched, state: st.state });
      return this._authRejection({ status: res.status, text: res.text, raw: res.json,
        carrierSent, latencyMs });
    }
    const accepted = res.status === 201 || res.status === 200;
    // AN ACCEPTED WRITE is the ONLY recovery proof in the system - the only observation that speaks
    // for the write scope, and the only thing that can close an outage episode. See _noteWriteSuccess
    // for why a read success deliberately does not, at any layer including the composition root.
    if (accepted) this._noteWriteSuccess();
    const d = res.json && (res.json.data || res.json);
    // Raw platform body. SuperProcure answers a rejected bid with PLAINTEXT (res.json is null
    // for it), so res.text is where the real "why" lives - surface it in reason + raw below.
    const rawBody = res.text != null ? res.text : null;
    if (!accepted) {
      // Unconditional warn (NOT debug): a rejected bid must self-document from the logs even at
      // the default LOG_LEVEL=info (the prior debug-level line here never printed in prod).
      // carrierSent + the request essentials (load, carrierBranchId, amount) plus httpStatus and
      // the raw body capture exactly what we sent and what SuperProcure sent back, so a rejection
      // no longer has to be reconstructed by guesswork - e.g. a cross-carrier identity 400 (a bid
      // placed as the account's static carrier for a load owned by a different carrier entity) is
      // now legible straight from the log.
      log.warn('placeBid rejected by platform', {
        auctionId: load, httpStatus: res.status, body: rawBody,
        carrierSent, carrierBranchId: body.carrierBranchId, amount: body.amount,
      });
    }
    return {
      accepted,
      status: res.status,
      myRank: (d && (d.rank ?? d.bidRank ?? d.vendorRank ?? d.l1)) ?? null,
      revisionsLeft: (d && (d.revisionsLeft ?? d.bidsLeft ?? d.bidCountLeft)) ?? null,
      // READ-BACK ORACLE source. SuperProcure echoes the vehicle count it actually RECORDED for
      // this bid as `bidVehicleCount` (proven live on the SIKA capture: sent vcq:-1, response
      // bidVehicleCount:1 - SP normalized the sentinel to 1). This is the field that renders as
      // "N vehicles" on the shipper's Quote History, so it is the ONLY authoritative check that our
      // count landed. Surfaced here (was dropped before) so the engine can compare it to what we
      // meant to send and alert on a mismatch - the detector that would have caught the "-1
      // vehicles" allotment failure on load 23167278. Null when the response carries no such field
      // (mock adapter, older/rejected responses) - the engine's oracle is gated on non-null.
      bidVehicleCount: (d && d.bidVehicleCount != null) ? Number(d.bidVehicleCount) : null,
      // PER-TONNE READ-BACK ORACLE source, the sibling of bidVehicleCount above. On a PMT createV2
      // SuperProcure echoes the number WE SENT back on two fields - `amountPMT` and `bidRate` - and
      // stores its own multiplied figure on `amount` (2026-08-05 capture, load 23828313: sent 2240,
      // got back amountPMT 2240, bidRate 2240, amount 33600, bidQuantity 30, bidVehicleCount 2).
      // So the oracle's question is "did our rate land verbatim?", and these two fields answer it
      // independently of each other. bidQuantity rides along as pure diagnostics: it is SP's own
      // per-load TOTAL quantity, nothing we send or control. It is NOT on its own the number SP
      // multiplied by - that is bidQuantity / bidVehicleCount, the PER-VEHICLE tonnage (captured:
      // 33600 = 2240 x 15, 15 = 30 / 2). The two coincide only on a one-truck load, so any consumer
      // stating a multiplier must divide by bidVehicleCount; see the pmt_amount_mismatch alert in
      // bidEngine. Null when the response carries no such field (mock adapter, rejected bids), and
      // the engine's oracle is gated on non-null.
      amountPMT: (d && d.amountPMT != null) ? Number(d.amountPMT) : null,
      bidRate: (d && d.bidRate != null) ? Number(d.bidRate) : null,
      bidQuantity: (d && d.bidQuantity != null) ? Number(d.bidQuantity) : null,
      // reason: prefer SP's JSON message, else the raw plaintext body, else the bare status code.
      reason: accepted ? null : ((d && d.message) || rawBody || ('http_' + res.status)),
      carrierSent,                   // the carrier id actually sent (per-load routed carrier or account carrier)
      text: rawBody,                 // raw platform body, tied to this response
      latencyMs,
      raw: d != null ? d : rawBody,  // parsed JSON when present, else the raw text (never silently null)
    };
  }
}

/**
 * THE placeBid ENVELOPE KEY SET - sorted, and the single definition of it.
 *
 * placeBid returns this same key set from three construction sites (the accept/reject return at the
 * foot of placeBid, the rate_limited early return, and _authRejection), and two contract suites pin
 * it at four separate assertions. Until 2026-08-05 each of those four hand-typed the list, and the
 * cost of that is on the record: the per-MT wire fix added `bidRate` to placeBid's own return while
 * the auth work added _authRejection, and when the two were rebased together the auth envelope was
 * left one key short. BOTH suites stayed green - the auth suite's own 12-key list still matched its
 * own 12-key envelope, and the other suite's 13-key pin never drives a 401 - so the shapes diverged
 * in silence. Four copies of an invariant are four chances for one of them to agree with the bug.
 *
 * What this does and does not buy: it is still a HAND-MAINTAINED statement of what the code produces,
 * so it cannot notice a key added to every site at once. What it makes impossible is the failure that
 * actually happened - one site changing while a suite's private copy of the list quietly agrees with
 * it. Every assertion now compares against the SAME list, so one site drifting fails somewhere.
 *
 * Exported from the module that OWNS the envelope rather than declared in a test, so the definition
 * sits next to the code it describes and a reader changing placeBid's return has it in view.
 * Frozen - a suite must never mutate the thing it is asserting against.
 *
 * NOTE the `rate_limited` early return is a FOURTH site that does NOT match this list (it omits the
 * read-back fields and adds retryAfterMs). That is pre-existing and has no runtime consequence today
 * because both read-back oracles sit inside the `res.accepted` branch, but it means this list is the
 * contract for the accept / reject / auth envelopes only. Do not "fix" it by widening the list.
 */
const PLACE_BID_ENVELOPE_KEYS = Object.freeze([
  'accepted', 'amountPMT', 'bidQuantity', 'bidRate', 'bidVehicleCount', 'carrierSent', 'latencyMs',
  'myRank', 'raw', 'reason', 'revisionsLeft', 'status', 'text',
]);

module.exports = { RealSuperProcureAdapter, settledFromV4, parseLane, parsePoints, parseRetryAfterMs, htmlToText, MAX_PLAUSIBLE_DEADLINE_MS, normQuoteType, assertValidVcq, PLACE_BID_ENVELOPE_KEYS, DEFAULT_API_BASE, DEFAULT_WEB_ORIGIN };
