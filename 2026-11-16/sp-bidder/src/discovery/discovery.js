'use strict';

const { tokenMatch } = require('../util/tokenMatch');
const { logAt } = require('../logging/logger');
const { closeIsProvisional, declaredExtensionIncrementMs } = require('../platform/adapter');
// The pricing-cutoff lead default lives in ONE place: config.priceDeadlineLeadMs (src/config.js).
// Referenced here only as the fallback for an injected config that omits the field (tests), so a
// change to that default never has to be mirrored into this module.
const appConfig = require('../config');

/**
 * The Module-1 scope gate, expressed as its complement so it reads once and is reused by
 * the capture-time backstop (server.js). FAIL CLOSED: a load is out of hard-close-only
 * scope when it is soft-close (softClose truthy) OR its close model was never verified
 * (closeModelKnown === false - the extend-time field was absent/unparseable). "Unknown"
 * is held OUT, never bid, because a soft-close auction is outside the paid module and an
 * unverified one could be soft. closeModelKnown === undefined (an older persisted request
 * snapshot, or a non-real adapter) intentionally keeps the prior behaviour - only the real
 * intake path, where _mapLoad always sets the flag, gets the stricter fail-closed check.
 *
 * THE closeModel STRING IS READ AS A THIRD SIGNAL, because this codebase states the same fact in
 * two vocabularies and a second adapter picked the one this gate does not speak. Load-level, the
 * close model is the softClose/closeModelKnown BOOLEAN PAIR (realAdapter._mapLoad sets it,
 * priceRequests persists it, snipeHarness reads it). Adapter-level, capabilities() and
 * getAuctionState() report a closeModel STRING ('hard'|'soft'|'unknown'). The GoComet adapter
 * mapped its enquiries with the string only - honestly declaring closeModel:'soft' - and set
 * neither boolean, so this gate compared `undefined` against both and returned false: a
 * permanently-extending auction (two in three extend; one observed ran 22 extensions and closed
 * nearly two hours late) admitted as though it had a fixed deadline, on a hard-close-only
 * deployment. That is this module's fail-closed default failing OPEN, and every downstream
 * property that assumes a real deadline - the latency-compensated snipe fire, the ladder
 * walk-down, finalize-on-zero - was then reasoning against a close time that can move.
 *
 * The adapter now sets the booleans, and that is the load-bearing fix (it is the only form that
 * survives the persisted request snapshot). Reading the string HERE is the belt: an adapter that
 * declares a close model this module cannot positively confirm as hard is held OUT even if it
 * forgets the boolean pair entirely, so the same mistake cannot fail open again. Only the literal
 * 'hard' is admitted - 'soft', 'unknown', and any value a future platform invents all fail closed,
 * which is the correct direction for a field whose whole purpose is to say whether the deadline is
 * real. An ABSENT closeModel deliberately changes nothing: it falls through to the boolean check
 * above, preserving the intentional carve-out for legacy snapshots and for the simulator, whose
 * loads carry none of these three fields and must stay in scope.
 */
function isOutOfHardCloseScope(load) {
  if (!load) return false;
  if (load.softClose) return true;
  if (load.closeModelKnown === false) return true;
  // Only a positively-declared 'hard' passes. Absent/non-string -> '' -> falls through as in-scope
  // (the legacy + simulator carve-out); anything else present is held out.
  const declared = typeof load.closeModel === 'string' ? load.closeModel.trim().toLowerCase() : '';
  return declared !== '' && declared !== 'hard';
}

/**
 * L3 soft-close opt-in predicate, extracted as a PURE function so the intake gate (discovery's
 * matchesAllowlist, via the _softAdmitted method) and the capture-time scope backstop
 * (server.js POST /price) share ONE implementation - same soft-close config + load in, same
 * admit/reject out. The two gates DIVERGING is exactly the bug this consolidation closes:
 * discovery would admit an enrolled, verified soft load onto the pricing worklist (it has this
 * carve-out), but the capture POST lacked it and refused the same load with OUT_OF_SCOPE - so the
 * desk was invited to price a load it was then blocked from pricing, and zero soft bids ever
 * landed. Keeping the predicate in one place is what makes "discovery admits it => capture accepts
 * it" true by construction rather than by two hand-kept-in-sync copies.
 *
 * `sc` is config.softClose (the soft-close block: { enabled, shippers, mode, reserve }); `load` is
 * the wire/persisted load. FAIL CLOSED and opt-IN in four independent ways, any one of which
 * returns false: the master flag is off (or the block is absent), the shipper allowlist is
 * empty/absent, the close model is unverified (closeModelKnown !== true - the strictest, earliest
 * guard, so an "unknown" load is never admitted), or the shipper is not on the opt-in list. So the
 * soft path can only ever admit an explicitly enrolled, VERIFIED soft load - never a blanket match.
 * Word-boundary tokenMatch (not a bare substring) is the SAME match discovery's hard allowlist and
 * the engine's _resolveSoftStrategy use, so intake, capture, and endgame all agree on which
 * shippers are enabled.
 *
 * @param {object} sc - config.softClose block ({ enabled, shippers, mode, reserve }).
 * @param {object} load - the wire/persisted load being evaluated for soft-close admission.
 * @returns {boolean} - true only when the load is an explicitly enrolled, verified soft-close load.
 */
function softAdmitted(sc, load) {
  if (!sc || !sc.enabled) return false;
  if (!(load && load.softClose === true && load.closeModelKnown === true)) return false;
  const shippers = Array.isArray(sc.shippers) ? sc.shippers : [];
  if (!shippers.length) return false; // opt-in, never a blanket admit
  return shippers.some((s) => tokenMatch(String(load.companyName || ''), s));
}

// The one READ-side normalization of a load's pricing basis: trimmed + upper-cased, '' when the load
// carries no basis at all. Intake sets `quoteType` through realAdapter.normQuoteType, but a persisted
// request snapshot, a mock load, or a hand-built fixture can carry a raw value - so every reader
// re-normalizes rather than trusting the writer.
function quoteBasisOf(load) {
  const q = load && load.quoteType;
  return q == null ? '' : String(q).trim().toUpperCase();
}

/**
 * PMT-BASIS predicate - the ONE definition of "this load is quoted PER METRIC TONNE", and the only
 * place the `'PMT'` literal is compared anywhere in the codebase.
 *
 * Every consumer that has to tell tonnes from trucks calls this: isMultiVehicle below (on PMT,
 * `units` is a QUANTITY and must never become a truck count), the price page's per-MT cost label +
 * read-only count control, and the desk cost floor's carve-out (a per-tonne rate is legitimately
 * small, so an absolute rupee floor cannot judge it). Those were three hand-kept-in-sync copies of
 * the same idiom; the tonnes-vs-trucks hazard is one this codebase has already been burned by and
 * deliberately fixed by READING THE DATA, so a new alias, a case fix, or the "per-tonne" value the
 * wire may yet carry needs exactly one place to land - here.
 */
function isPmtBasis(load) {
  return quoteBasisOf(load) === 'PMT';
}

/**
 * FTL MULTI-VEHICLE: a genuine FTL load that requires more than one truck. This is the ONE class
 * the engine cannot auto-bid correctly yet, because the bid payload hardcodes the `vcq:-1`
 * sentinel: SuperProcure normalizes -1 to 1 on a single-vehicle load, but records it literally as
 * "-1 vehicles" on a multi-vehicle load, which the shipper cannot allot (the 2026-07-16 Renewsys/
 * Vishal incident). The engine reads this predicate to FAIL CLOSED (Layer A) or, once the count
 * fix is enabled, to send vcq = the required truck count (Layer B).
 *
 * `units` is `vehicleCount` off the wire (realAdapter._mapLoad). It only means "trucks" on an FTL
 * load - on a PMT ("Quote Per MT") load the SAME field carries the MT/KG QUANTITY (e.g. 22, 30,
 * 9000), so treating >1 as multi-vehicle there would sweep in every PMT load for the wrong reason.
 * That is why this reads `quoteType` (branchQuoteType/rateType), NOT `shipmentType`: SuperProcure
 * reports loadShipmentType:"FTL" even on a PMT load (verified live on 23122869 Goodluck and the
 * 2026-07-16 board probe), so the shipment type is unusable as the basis. See normQuoteType.
 *
 * strictUnknownBasis: how a load that carries NO quoteType is treated. Two callers land here:
 *   - INTAKE / discovery / mock (default false): the real adapter ALWAYS sets quoteType, so a
 *     missing basis means a non-real load (the simulator emits units 1-3 and no quoteType). Keep
 *     the prior behaviour rather than fail-close the whole simulator - same reasoning as the
 *     closeModelKnown === undefined case above.
 *   - REAL bidding (true): a load/intent persisted BEFORE this field existed carries no basis, so
 *     a >1 count on it cannot be proven to be trucks rather than tonnes. Those stale intents ARE
 *     the live multi-vehicle exposure across a deploy, so real mode fails CLOSED on them.
 *
 * @param {object} load - the wire/persisted load being evaluated.
 * @param {object} [opts] - options bag.
 * @param {boolean} [opts.strictUnknownBasis=false] - how a load with no quoteType is treated;
 *   false (intake default) keeps prior non-strict behaviour, true (real bidding) fails closed.
 * @returns {boolean} - true if the load is a genuine FTL multi-vehicle load (requires >1 truck).
 */
function isMultiVehicle(load, { strictUnknownBasis = false } = {}) {
  if (!load) return false;
  // Only a finite count strictly above 1 is multi-vehicle. An absent/null/unparseable count is
  // NOT treated as multi-vehicle: over-excluding a countless load would silently stop legitimate
  // single-truck bidding, which is worse than the status quo.
  const n = Number(load.units);
  if (!Number.isFinite(n) || n <= 1) return false;
  if (!quoteBasisOf(load)) return !!strictUnknownBasis;
  // PMT -> `units` is a QUANTITY, not trucks: not multi-vehicle, stay quiet (PMT is its own gap).
  // Everything else the real adapter reports (FTL today, any future basis) is read as a truck
  // count and IS multi-vehicle when >1 - fail closed on a basis we cannot yet price per-vehicle.
  // The basis test itself is isPmtBasis above - one definition, shared with the price page and the
  // desk cost floor, so the three cannot drift apart.
  return !isPmtBasis(load);
}

/**
 * DiscoveryPoller - the front of the price-request loop. Polls listAuctions(),
 * filters to in-scope loads (allowlist), and for each NEW in-scope load creates a
 * price request + notifies the pricing team. Also expires awaiting-price requests
 * past their deadline (the floor is mandatory - never bid without a captured cost).
 *
 * Read-only on the platform: discovery only lists + asks. Arming happens elsewhere,
 * and only after a human captures a cost.
 */
/** What a tick resolves to when it outlived its deadline instead of finishing. */
const STALLED = Symbol('discovery_tick_stalled');

/**
 * How long a sustained stall stays quiet between alerts.
 *
 * The notifier's dedupe store is PERSISTENT and has no TTL - a key is released only when the
 * collection passes its 1000-doc LRU cap - so a stall key built from identity alone
 * (platform + account) would alert once for the life of the deployment and then go silent on
 * every recurrence. That is precisely the 18 hours of silence this watchdog exists to end, so
 * the key carries an episode counter and this window instead: a NEW outage always alerts, and a
 * sustained one re-alerts hourly rather than once ever.
 */
const STALL_REALERT_MS = 3600_000;

// A timer, not setImmediate: the pass resumes from the listing's I/O callback, and from there the
// first setImmediate runs before an overdue timer does, so a due hot tick would still wait.
const yieldToTimers = () => new Promise((resolve) => setTimeout(resolve, 0));

// Cords / no-schedule loads (ruling 46): one durable row per load ever noticed, keyed by loadId,
// on the SAME store the price requests use - no new wiring needed to make it restart-safe. Also
// doubles as the once-ever gate for the desk notice (see _noteNoSchedule).
const NO_SCHEDULE_COLLECTION = 'noScheduleLoads';

/** Per-shipper counts of no-schedule loads noticed so far. For whichever report surfaces them. */
async function noScheduleCounts(store) {
  const rows = (await store.listDocs(NO_SCHEDULE_COLLECTION)) || [];
  const byShipper = {};
  for (const r of rows) {
    const shipper = (r && r.shipper) || 'Unknown shipper';
    byShipper[shipper] = (byShipper[shipper] || 0) + 1;
  }
  return byShipper;
}

class DiscoveryPoller {
  // account ({accountId, label} | null): tags each created price request with the
  //   owning SP account and scopes the reconcile to that account's own asks. Null
  //   (the default, and the only-primary case) = today's untagged behaviour.
  // gate ({chain: Promise} | null): a serializer SHARED by every poller, so with
  //   multiple accounts whose scopes overlap, ticks run one at a time in account
  //   order - the check-then-create in _tick becomes atomic across pollers and a
  //   load two accounts can see gets exactly ONE price request (first account wins).
  // platformKey ('sp' default): which bidding portal this poller feeds. It scopes
  //   margin-profile resolution (a customer's SP band differs from its GoComet band)
  //   and is snapshotted onto each price request. Only 'sp' exists today; a GoComet
  //   poller passes its own key so the merge is additive.
  constructor({ adapter, requests, notifier, config, log = () => {}, onExpire = () => {}, account = null, gate = null, platformKey = 'sp',
    // D003: external dead-man's-switch ping (healthchecks.io-style) - proves the app itself is up
    // and discovery is actually ticking, not just that the box and cron are alive (that is what
    // scripts/monitor-wa-sender.js's HEALTHCHECK_URL already covers, from OUTSIDE the process).
    // Off by default (unset URL); a failed ping is logged and never allowed to break a tick.
    //
    // healthcheckPeers (review correction, 26 Sep): every poller pinging the SAME URL shares ONE
    // array reference here (server.js builds it once and passes it to every stack) and registers
    // itself onto it below - so the ping only fires once EVERY registered poller has had a good
    // pass within its own interval, and one healthy account can no longer mask a dead one. Left
    // unset (a poller built alone, or a test), it defaults to an array holding only itself.
    healthcheckUrl = null, healthcheckFetch = (typeof fetch === 'function' ? fetch : null), healthcheckPeers = null,
    // D012: this account's engine, so the poller's own recurring tick can also carry the "silent
    // no-bid streak" check (see BidEngine.noLandingReport). Optional - a poller built without one
    // (older constructions, tests) simply never runs this check.
    engine = null }) {
    this.adapter = adapter;
    this.requests = requests;
    this.notifier = notifier;
    this.config = config || {};
    this.log = log;
    this.onExpire = onExpire;
    this.account = account;
    this.gate = gate;
    this.engine = engine;
    this.platformKey = platformKey;
    this.healthcheckUrl = healthcheckUrl || null;
    this.healthcheckFetch = healthcheckFetch;
    this.healthcheckPeers = healthcheckPeers || [];
    if (this.healthcheckUrl) this.healthcheckPeers.push(this);
    this._lastGoodTickAt = null;
    this.timer = null;
    // A tick that has not settled within this budget is wedged, not slow. Legitimate ticks on the
    // box finish in single-digit seconds against a 30s interval, so at 10x the interval this can
    // only fire on a genuine hang. See _runTickBounded for what an unbounded tick cost.
    this.tickTimeoutMs = Number.isFinite(this.config.tickTimeoutMs) ? this.config.tickTimeoutMs : 300_000;
    this._stalls = 0;
    this._stallEpisode = 0;
  }

  // `log` is caller-injected (constructor DI, the convention used throughout this codebase):
  // server.js wires in the structured per-module logger from src/logging/logger.js, which
  // exposes .debug/.info/.warn/.error alongside the bare log(msg) call, but the constructor's
  // default (and some test constructions) still pass a plain `(msg) => {}` function with none
  // of those level methods on it. Shared with Notifier/WhatsAppClient via logging/logger.js's
  // exported logAt() so the DI-fallback logic lives in exactly one place.
  _logAt(level, msg, meta) {
    logAt(this.log, level, msg, meta);
  }

  matchesAllowlist(load) {
    const al = this.config.allowlist || {};
    // C056/D050: this.config.allowlist is already the EFFECTIVE, per-account allowlist (the
    // discoveryConfigFor getter folds in resolveTargets' assignment-derived shippers on top of the
    // account/global base) - "hard allowlist" below means this resolved list, not a static config
    // literal. Word-boundary match (shared tokenMatch), not bare substring: "Ren" must not sweep in
    // "Warren Steel", but must still match a word-prefix ("Syngenta" -> "Syngenta India Ltd").
    const shippers = al.shippers || [];
    const name = String(load.companyName || '');
    // Does the hard allowlist have anything to say AGAINST this shipper? Empty/absent has nothing to
    // say either way (an account may scope purely through the soft-close list); a non-empty list
    // that matches also has nothing to say against it. Only a non-empty list that does NOT name this
    // shipper - including an explicit ["__none__"] opt-out sentinel - is a deliberate exclusion.
    const hardExcludes = shippers.length > 0 && !shippers.some((s) => tokenMatch(name, s));
    // L3 soft-close opt-in is an INDEPENDENT admission path, but ONLY when the hard allowlist does
    // not deliberately exclude this shipper. Global soft-close enrolment (config.softClose.shippers)
    // selects STRATEGY for an admitted load, never admission on its own - an explicit non-empty hard
    // allowlist that excludes a shipper must still exclude it even when that shipper is separately
    // enrolled for the SuperProcure soft endgame on some OTHER account. This does NOT reintroduce the
    // match-all flood #34 removed: _softAdmitted is itself fail-closed and opt-in (master flag off,
    // empty/absent softClose.shippers, an unverified close model, or a non-enrolled shipper each
    // return false), so the soft path can only ever admit an explicitly enrolled, verified soft load
    // whose shipper the hard allowlist has not deliberately excluded.
    if (!hardExcludes && this._softAdmitted(load)) return true;
    // FAIL CLOSED on an empty shipper allowlist: no shippers approved => match NOTHING, never
    // everything (unless soft-admitted above). `shippers: []` used to read as "no filter -> bid every
    // shipper", so the moment an account's list was cleared (or never set) discovery flooded the
    // pricing worklist with unbiddable loads - the exact 2026-07-14 incident (one live account's
    // list was []). Match-all is no longer settable by accident; an operator who wants an account to
    // bid nothing (hard AND soft) uses an explicit sentinel like ["__none__"].
    if (shippers.length === 0) return false;
    if (hardExcludes) return false; // explicit exclusion - soft enrolment above already had its chance
    const lanes = al.lanes || [];
    if (lanes.length) {
      const lane = `${load.lane && load.lane.origin} ${load.lane && load.lane.destination}`;
      if (!lanes.some((s) => tokenMatch(lane, s))) return false;
    }
    // Module 1 in-scope path = hard close. Exclude soft-close AND unverified-close-model
    // loads (fail closed) - see isOutOfHardCloseScope. L3: a VERIFIED soft-close load is
    // admitted only when its shipper is explicitly opted into the soft-close strategy (see
    // _softAdmitted); otherwise the fail-closed exclusion stands.
    if (
      al.hardCloseOnly &&
      isOutOfHardCloseScope(load) &&
      !this._softAdmitted(load) &&
      !tokenMatch(name, 'Shyam Steel')
    ) return false;
    return true;
  }

  /**
   * L3 soft-close opt-in (G6): a soft load is admitted to intake ONLY when the master soft-close flag is
   * ON and its shipper is on the soft allowlist AND its close model was VERIFIED soft. This is the
   * intake half of the per-customer gate the engine also applies (bidEngine._resolveSoftStrategy) - both
   * read the SAME config.softClose, so intake and endgame agree on which shippers are enabled.
   *
   * Thin instance wrapper over the module-level pure softAdmitted(sc, load): the predicate lives in ONE
   * place so the capture-time backstop in server.js can reuse the identical logic (see softAdmitted's
   * docblock for why divergence here was a real bug). This reads the poller's live config.softClose - a
   * getter on the injected config that returns the global config.softClose, so a Settings save is picked
   * up without reconstructing the poller.
   */
  _softAdmitted(load) {
    return softAdmitted(this.config.softClose, load);
  }

  /**
   * How far ONE forward close-time move may go on this portal, in ms; null when its posted close is
   * final and no refresh applies. Resolved from the adapter's own declaration, never from its
   * identity - an adapter publishing no capabilities() at all declares nothing and gets nothing.
   *
   * Read ONCE and cached (including the null), which deliberately pins this to whatever the portal
   * declares up front rather than to a value it may later raise from live observation. Not
   * following a growing increment only ever keeps the bound tighter, and tighter costs a rescue
   * this code did not perform at all before it existed.
   */
  _liveCloseStepMs() {
    if (this._closeStepMs === undefined) {
      let caps = null;
      try { caps = this.adapter && typeof this.adapter.capabilities === 'function' ? this.adapter.capabilities() : null; }
      catch (_) { caps = null; }
      this._closeStepMs = closeIsProvisional(caps) ? declaredExtensionIncrementMs(caps) : null;
    }
    return this._closeStepMs;
  }

  async tick() {
    // Re-entrancy guard: setInterval can fire while a slow prior tick is still awaiting; two
    // overlapped ticks would both pass the has-request check and create duplicate price requests.
    if (this._ticking) return { created: 0, expired: 0, scanned: 0, skipped: 'in_progress' };
    this._ticking = true;
    try {
      if (this.gate) {
        // Cross-poller serialization, PER PLATFORM. The check-then-create in _tick still has to be
        // atomic across the accounts sharing one portal, but SuperProcure and GoComet share no
        // loads and must not share a queue: one process-wide chain meant a single stalled GoComet
        // read stopped every SuperProcure account's surfacing too. A failed tick never breaks the
        // chain (the reassignment below catches both settlements) - but a tick that never SETTLES
        // used to park it forever, which is the bug _runTickBounded closes.
        const chain = this._chainFor();
        const run = chain.then(() => this._runTickBounded());
        this._setChainFor(run.then(() => {}, () => {}));
        return await run;
      }
      return await this._runTickBounded();
    } finally {
      this._ticking = false;
    }
  }

  /** This poller's platform lane on the shared gate, seeded from any pre-existing single chain. */
  _chainFor() {
    if (!this.gate.chains) this.gate.chains = new Map();
    const k = this.platformKey || 'sp';
    if (!this.gate.chains.has(k)) this.gate.chains.set(k, this.gate.chain || Promise.resolve());
    return this.gate.chains.get(k);
  }

  _setChainFor(p) { this.gate.chains.set(this.platformKey || 'sp', p); }

  /**
   * Run _tick under a hard deadline so it ALWAYS settles.
   *
   * _tick awaits the adapter, the notifier and the store, and none of those is guaranteed to
   * settle: a GoComet read can park on the adapter's slot pump with no resolve, no reject and no
   * timeout, and the WhatsApp transport is a bare fetch carrying no abort signal. On 2026-09-08 one
   * such await stopped the shared chain, wedged the _ticking guard (whose `finally` sits downstream
   * of the hung await) and surfaced nothing on EITHER platform for 18 hours, while the process
   * stayed healthy and kept bidding armed loads. It was silent because the jam parks before the
   * tick's own log line, so the desk noticed before the operator did.
   *
   * A stalled tick is abandoned rather than cancelled: it may stay pending forever, but the chain
   * advances, the guard clears, and the next interval gets a fresh tick instead of a restart.
   *
   * KNOWN RESIDUAL, stated rather than papered over. Abandoning re-opens a narrow version of the
   * duplicate-request race the _ticking guard exists to prevent: the abandoned tick is no longer
   * held behind the gate, so it can resume mid-loop while a fresh tick walks the same loads. The
   * per-load re-read plus the `notified` flag cover the ordinary case - a resumed tick finds the
   * row the fresh one created and skips it. A tick suspended INSIDE createForLoad is covered by
   * the store itself: createForLoad is single-flight per load id, so a second call joins the first
   * one's creation instead of writing a second request.
   */
  async _runTickBounded() {
    let timer = null;
    const stalled = new Promise((res) => {
      timer = setTimeout(() => res(STALLED), this.tickTimeoutMs);
      if (timer.unref) timer.unref();
    });
    let r;
    try { r = await Promise.race([this._tick(), stalled]); }
    finally { clearTimeout(timer); }
    if (r !== STALLED) { this._stalls = 0; return r; }
    // A 0 -> 1 transition is the start of a NEW outage, and it gets its own alert identity so the
    // notifier's permanent dedupe store cannot swallow it as a repeat of a previous one.
    this._stalls += 1;
    if (this._stalls === 1) this._stallEpisode += 1;
    this._noteStalledTick();
    return { created: 0, dropped: 0, expired: 0, reminded: 0, closed: 0, pruned: 0, scanned: 0, stalled: true };
  }

  /**
   * A stalled tick goes out on BOTH surfaces - the error log for the detail, the alert path for the
   * fact. Half of the 2026-09-08 incident was that a jammed poller logged nothing at all, so an
   * outage that stopped every customer on both platforms produced no operator signal for 18 hours.
   */
  _noteStalledTick() {
    const who = this.account ? `account '${this.account.accountId}' ` : '';
    const detail = `discovery on ${this.platformKey} ${who}has not completed a tick in `
      + `${Math.round(this.tickTimeoutMs / 1000)}s - the poller is stalled and NO new auctions are being surfaced`;
    this._logAt('error', `[discovery] STALLED: ${detail} (stall #${this._stalls}) - recovering the poller`, {
      platformKey: this.platformKey,
      account: this.account && this.account.accountId,
      stalls: this._stalls,
      tickTimeoutMs: this.tickTimeoutMs,
    });
    if (!this.notifier || typeof this.notifier.alert !== 'function') return;
    try {
      this.notifier.alert('error', { context: 'discovery', platformKey: this.platformKey, detail },
        { dedupeKey: `discovery_stalled:${this.platformKey}:${this.account ? this.account.accountId : 'default'}`
          + `:${this._stallEpisode}:${Math.floor(Date.now() / STALL_REALERT_MS)}` })
        .catch(() => {});
    } catch (_) { /* alerting must never break the recovery path */ }
  }

  /**
   * Cords / no-schedule loads (ruling 46): bidding them is OUT (see the note above the
   * `closesAt == null` skip), but a desk that never hears about them cannot bid them by hand
   * either. The store row is BOTH the durable per-shipper count and the once-ever gate on the
   * notice - a load already rowed here is never notified or counted again, tick after tick,
   * restart after restart.
   */
  async _noteNoSchedule(load) {
    const shipper = load.companyName || 'Unknown shipper';
    const store = this.requests && this.requests.store;
    let firstSeen = true;
    if (store && typeof store.getDoc === 'function') {
      try {
        const key = String(load.id);
        if (await store.getDoc(NO_SCHEDULE_COLLECTION, key)) firstSeen = false;
        else await store.putDoc(NO_SCHEDULE_COLLECTION, key, { loadId: load.id, shipper, firstSeenAt: Date.now() });
      } catch (_) { /* a store error must never block the notice below */ }
    }
    if (!firstSeen || !this.notifier || typeof this.notifier.alert !== 'function') return;
    const origin = (load.lane && load.lane.origin) || '';
    const dest = (load.lane && load.lane.destination) || '';
    try {
      await this.notifier.alert('desk_notice', {
        platformKey: this.platformKey,
        shipper, origin, dest,
        lane: [origin, dest].filter(Boolean).join(' -> ') || '-',
        auctionId: load.id, oaNo: load.id,
        reason: 'no_schedule',
      }, { dedupeKey: `no_schedule_notice:${load.id}` });
    } catch (_) { /* alerting must never break discovery */ }
  }

  /**
   * CW-145/G9: a price-needed push that matched zero recipients (notifier._whatsapp returned
   * 'unreached') is a routing-config gap - no group or person scope covers this customer - not a
   * delivery hiccup, and it must not be mistaken for one. A loud, per-request-deduped alert to the
   * error/ops channel names the customer and the load; the console badge itself is PR-3's job, this
   * only makes the stored state honest for it to read (priceRequests.markReachedNobody).
   */
  _noteReachedNobody(request) {
    if (!this.notifier || typeof this.notifier.alert !== 'function') return;
    const shipper = (request.load && request.load.companyName) || 'this customer';
    try {
      this.notifier.alert('error', {
        context: 'price request', platformKey: this.platformKey,
        detail: `price ask for '${shipper}' (load ${request.loadId}) matched no group or person - nobody was asked to price it`,
      }, { dedupeKey: `price_needed_unreached:${request.id}` }).catch(() => {});
    } catch (_) { /* alerting must never break discovery */ }
  }

  /**
   * D003 (review correction, 26 Sep): the switch is shared - a ping only goes out when every
   * poller on healthcheckPeers (including this one) has had a good pass within its own interval.
   * Before this, each poller pinged independently on its own good listing, so one healthy account
   * kept the switch alive while a different one sat dead with zero ops signal. A poller that just
   * failed its own listing is itself one of the peers checked here, so no separate "did THIS tick
   * succeed" gate is needed - a stale _lastGoodTickAt on any one peer, including this one, withholds
   * the ping for everyone sharing the URL.
   */
  _maybePingHealthcheck() {
    if (!this.healthcheckUrl || !this.healthcheckFetch) return;
    const now = Date.now();
    for (const p of this.healthcheckPeers) {
      // Verification finding (26 Sep): a SIBLING with no live timer is not currently running at all -
      // paused via the console (GC_DISCOVERY off, or applyGoCometDiscovery(false)), or torn down by a
      // reconnect and simply not yet spliced out (belt on top of stop()'s own removal, below) - and
      // must never block everyone else's ping just by sitting in the shared array. This poller (`this`)
      // is exempted from the timer check: it is, by definition, actively ticking right now (a test or
      // caller driving .tick() directly, with no live setInterval, is still a genuine live pass, and
      // must keep failing this check on its OWN staleness exactly as before).
      if (p !== this && !p.timer) continue;
      const interval = (p.config && p.config.discoveryIntervalMs) || 30_000;
      if (p._lastGoodTickAt == null || now - p._lastGoodTickAt > interval) return;
    }
    this.healthcheckFetch(this.healthcheckUrl, { method: 'POST' }).catch((e) => {
      this._logAt('warn', `[discovery] app healthcheck ping failed: ${e && e.message}`, { err: e });
    });
  }

  async _tick() {
    let loads = [];
    let listingOk = false;
    try { loads = await this.adapter.listAuctions({ enrichDimensions: true }); listingOk = true; }
    catch (e) {
      // C059: a failed listing used to return here, which also skipped every time-based sweep below
      // (dropOutOfScope, expireOverdue, finalizeClosed, pruneEnded) - none of which need a fresh
      // listing, all of which key off Date.now() and this poller's own platformKey. A platform stuck
      // failing its listing call (auth dead, a sustained 5xx) therefore never expired an overdue ask,
      // never retired a closed auction, and never dropped an out-of-scope request for as long as the
      // failure lasted - the worklist silently rotted instead of just not growing. Log and fall
      // through with an empty `loads` (the per-load creation loop below simply does nothing), so
      // every sweep still runs on the platform's own stored requests.
      this._logAt('error', `[discovery] listAuctions failed: ${e.message}`, { err: e });
      loads = [];
    }
    // D003: this poller's own half of the shared dead-man's-switch ping - stamped on a GOOD pass
    // only (a failed listing must never look like a heartbeat). The actual ping, gated on every
    // PEER poller also being current, fires at the end of the tick (see _maybePingHealthcheck) -
    // after the sweeps, not here, so the switch attests to a whole tick having gone through.
    if (listingOk) this._lastGoodTickAt = Date.now();

    // Observability for the fail-closed allowlist: a poller whose EFFECTIVE allowlist has no
    // shippers now bids on NOTHING. That is correct for an explicit ["__none__"] opt-out, but a
    // silently-empty list (a cleared config, a failed .env load) means this account has gone dark
    // with no other signal - warn on each transition into empty, the same posture the box takes on
    // the analogous auth-off state. A non-empty resolved list (explicit shippers, or
    // assignments-only targeting) never warns.
    const scopeShippers = ((this.config.allowlist || {}).shippers) || [];
    if (scopeShippers.length === 0) {
      if (!this._emptyAllowlistWarned) {
        this._emptyAllowlistWarned = true;
        this._logAt('warn',
          `[discovery] ${this.account ? `account '${this.account.accountId}' ` : ''}has no shippers in scope - it will bid on NOTHING (fail-closed). Set a shipper list, assign customers, or use ["__none__"] to silence this.`,
          { account: this.account && this.account.accountId });
      }
    } else {
      this._emptyAllowlistWarned = false;
    }

    // D051: the empty-list guard above only catches a TOTAL wipe. Removing (or typo-mutating) ONE
    // shipper name out of an otherwise non-empty list is silent - the list is still "non-empty" and
    // trips nothing. Diff this tick's resolved scope against the last tick's: any shipper present
    // before and absent now, while the list is still non-empty, is exactly the fat-fingered-config
    // shape that cost a customer 26 days of undetected silence. Warn once per drop, not every tick.
    if (this._prevScopeShippers) {
      const droppedShippers = this._prevScopeShippers.filter((s) => !scopeShippers.includes(s));
      if (droppedShippers.length && scopeShippers.length > 0) {
        const acctTag = this.account ? `account '${this.account.accountId}'` : 'this account';
        this._logAt('warn',
          `[discovery] ${acctTag} allowlist dropped shipper(s) that were previously in scope: ${droppedShippers.join(', ')}`
            + ' - bidding for them has silently stopped if this was not intentional',
          { account: this.account && this.account.accountId, dropped: droppedShippers });
        if (this.notifier && typeof this.notifier.alert === 'function') {
          this.notifier.alert('error', { context: 'discovery', platformKey: this.platformKey,
            detail: `${acctTag} allowlist dropped shipper(s) that were previously in scope: ${droppedShippers.join(', ')}.`
              + ' If this was not a deliberate change, bidding for them has silently stopped - re-add the name(s).' },
            { dedupeKey: `allowlist_shipper_dropped_${this.account ? this.account.accountId : 'default'}_${droppedShippers.slice().sort().join(',')}` })
            .catch(() => {});
        }
      }
    }
    this._prevScopeShippers = scopeShippers.slice();

    // D012 (redesigned 26 Sep after review, then review-corrected again): a streak of consecutive
    // closes with zero landed bids and no explained reason - a wedged write path or a wedged tick
    // loop can otherwise sit silent with every existing signal quiet (the per-load
    // never_bid_before_close/zero-landed-bids fact only reports AFTER a load closes, one load at a
    // time). Fires ONCE per streak - noLandingReport() itself is a latch that returns non-null only
    // the first time the streak crosses threshold, staying quiet (even across many idle ticks with
    // nothing armed at all) until a landed bid or an explained close resets it. The dedupe key is
    // deliberately NOT time-bucketed any more: an hourly bucket previously re-fired this alert every
    // hour for as long as the streak stood, including through a completely idle overnight stretch
    // with no new activity of any kind. It is keyed per STREAK instead, and an offer skipped on a down
    // sender (alert() === false, nothing marked sent) re-arms the latch, so the next tick offers the
    // same streak again; the notifier's sent-key dedupe stops it once delivered.
    if (this.engine && typeof this.engine.noLandingReport === 'function') {
      const noLanding = this.engine.noLandingReport();
      if (noLanding && this.notifier && typeof this.notifier.alert === 'function') {
        // Owner-approved terse form (26 Sep) - see the copy packet.
        const shortAcct = this.account ? this.account.accountId : 'this account';
        this.notifier.alert('error', { context: 'discovery', platformKey: this.platformKey,
          detail: `${shortAcct}: ${noLanding.streak} closes in a row with no bid landed and no reason. Bidding may be stuck.` },
          { dedupeKey: `no_landing_${this.account ? this.account.accountId : 'default'}_${this.platformKey}_${noLanding.streakId}` })
          .then((delivered) => { if (delivered === false) this.engine.noLandingUndelivered(noLanding.streakId); })
          .catch(() => {});
      }
    }

    // One whole-collection read serves every load until the pass next yields; the store settles
    // without yielding, so until then it is exactly what a fresh read would return. Every write or
    // notifier call is followed by a yield, so the hot ticks run between steps instead of after the
    // whole pass, and a yield drops the snapshot so the next decision reads the collection again.
    let snapshot = null;
    const settle = async () => { await yieldToTimers(); snapshot = null; };
    const requestFor = async (loadId) => {
      if (!snapshot) snapshot = await this.requests.listAll();
      return snapshot.find((r) => String(r.loadId) === String(loadId)) || null;
    };

    let created = 0;
    // D034: an allowlist rejection used to be a bare `continue` with no trace anywhere - a shipper
    // whose loads are ALWAYS dropped here read as "posts no loads at all", indistinguishable from a
    // quiet day, and could go unnoticed for months. Counted per shipper so the drop is at least
    // visible in the tick summary and the returned stats, without logging one line per load (this
    // loop sees every load on the platform, most of them legitimately not ours).
    const allowlistRejectedByShipper = new Map();
    for (const load of loads) {
      if (load.status === 'closed') continue;
      // No real bidding schedule (SuperProcure biddingOn !== 1, or a close time that failed
      // the adapter's own sanity bound) - closesAt is null in either case. Skip rather than
      // price/arm against a fake deadline. NOTE (2026-07-11): for one whole category of loads
      // this is NOT "wait for the next tick and it'll clear" - Ashirvad Pipes (and observed:
      // Tata Consumer, Shriji Polymers) post loads across their entire branch network with
      // biddingOn permanently 0; SuperProcure's own live data showed one load still unscheduled
      // 11+ days after posting. That's a structurally different, non-timed bid mechanic Module
      // 1's snipe-ladder cannot bid at all, not a pending-schedule race - see
      // _research/2026-07-11_no-schedule-bid-type-scoping.md. Unconditional (not gated behind
      // hardCloseOnly) - this is a data-validity/capability check, not a module-scope toggle,
      // and two of today's live accounts (primary, sameer-ambdaskar) don't set hardCloseOnly.
      // Scope FIRST: a no-schedule load outside our own shipper/lane allowlist is not this desk's
      // load to hear about at all - the notice below is for our own listed shippers only.
      if (!this.matchesAllowlist(load)) {
        const shipper = load.companyName || 'Unknown shipper';
        allowlistRejectedByShipper.set(shipper, (allowlistRejectedByShipper.get(shipper) || 0) + 1);
        continue;
      }
      // LIVE DEFECT (26 Sep, SP 25834194 Durian): `existing` is looked up BEFORE the no-schedule
      // branch below, not after. A hard-close load's own listing drops its times AT its close (the
      // realAdapter mapping for biddingOn 0 with past times reads as "unscheduled") - a load that
      // already has, or ever had, a real price request proves it once carried a real schedule (a
      // request is only ever created when closesAt was non-null), so this is never a genuine
      // no-schedule load and must never fire that notice or overwrite the schedule already on file.
      let existing = await requestFor(load.id);
      if (load.closesAt == null) {
        // Verification finding (26 Sep): a load first sighted AT OR AFTER its own close - a restart,
        // a listing outage across the whole window, or a shipper newly added to scope - maps
        // closesAt to null exactly like a genuinely never-scheduled load (realAdapter nulls it for
        // any biddingOn:0 with a time that fails the future-window bound, past times included). But
        // the raw portal close time (biddingCloseTime) survives the mapping regardless. When it
        // parses and is already at or past now, this load is CLOSED, not unscheduled - there is
        // nothing to bid by hand and nothing for the desk to act on, so the no-schedule notice must
        // stay silent rather than send a false "no bidding schedule" on a load that plainly had one.
        const rawClose = Date.parse(load.biddingCloseTime);
        const closedAlready = Number.isFinite(rawClose) && rawClose <= Date.now();
        if (!existing && !closedAlready) await this._noteNoSchedule(load);
        continue;
      }
      if (existing) {
        // THE CLOSE REFRESH (contract + guards: priceRequests.refreshLiveClose). It belongs HERE,
        // on the listing this loop already has, because the direction stays one-way
        // adapter -> discovery -> pricing and no other layer sees the whole population: the engine
        // knows only ARMED loads, and a superseded close strands the un-priced ones just as hard -
        // expireOverdue files those 'skipped_no_price', reporting the desk's own work as desk
        // non-response. A null step (every non-extending portal) skips the call entirely.
        const stepMs = this._liveCloseStepMs();
        if (stepMs != null
            && await this.requests.refreshLiveClose(existing.id, load.closesAt, { extensionStepMs: stepMs, record: existing })) {
          await settle();
          existing = await requestFor(load.id);
          if (!existing) continue;
        }
        // Re-notify a request whose WhatsApp push was SKIPPED because the sender session was down
        // (notified === false), but ONLY while it's still open AND still within its price deadline -
        // a stale one is left dashboard-only, never flushed. This is what makes the circuit breaker
        // lose nothing on a fast recovery (the queue-flush's one virtue) WITHOUT the stale flood.
        // The notifier dedupes, so a healthy, already-sent request is a cheap no-op that just marks it.
        if (existing.status === 'awaiting_price' && existing.notified === false
            && (existing.deadlineAt == null || existing.deadlineAt > Date.now())) {
          const res = await this.notifier.requestPrice(existing);
          await settle();
          if (res && res.delivered === true) {
            await this.requests.markNotified(existing.id);
            await settle();
          } else if (res && res.delivered === 'unreached') {
            await this.requests.markReachedNobody(existing.id);
            await settle();
            this._noteReachedNobody(existing);
          }
        }
        continue;
      }
      // `??`, not `||`, so an explicit 0 (price right up to close, valid per configStore's
      // `>= 0` check) is honored instead of being silently bumped to the config default lead.
      const lead = this.config.priceDeadlineLeadMs ?? appConfig.priceDeadlineLeadMs;
      // deadlineAt is computed + stored as an advisory "danger zone" line (the UI warns past it),
      // but it is NOT a create-gate any more: a load discovered inside the lead is still worth
      // notifying and pricing best-effort right up to the real close. Only skip a genuinely-closed
      // auction (closesAt is non-null here - the null case skipped above).
      const deadlineAt = load.closesAt ? load.closesAt - lead : null;
      if (load.closesAt <= Date.now()) { this.log(`[discovery] load ${load.id} auction already closed, skipping`); continue; }
      // stamp the owning account (multi-account only; priceRequests reads load.account)
      // and the portal (platformKey) so the request resolves + displays its margin band.
      const req = await this.requests.createForLoad(
        this.account ? Object.assign({}, load, { account: this.account }) : load,
        { deadlineAt, platformKey: this.platformKey });
      await settle();
      const res = await this.notifier.requestPrice(req);
      await settle();
      if (res && res.delivered === true) { // stays notified:false if skipped for a down session -> re-fired above
        await this.requests.markNotified(req.id);
        await settle();
      } else if (res && res.delivered === 'unreached') { // CW-145/G9: reached nobody, not a sender outage
        await this.requests.markReachedNobody(req.id);
        await settle();
        this._noteReachedNobody(req);
      }
      created += 1;
    }

    // Reconcile awaiting-price asks against the CURRENT allowlist. A target the operator
    // removed (or hard-close-only just toggled on) leaves stale "needs a number" requests for
    // loads we no longer want - drop those. Armed/committed requests are deliberately left
    // running: the allowlist is an intake filter, not a retroactive kill of already-priced work.
    // Portal- and owner-scoped: this poller's allowlist describes only what THIS portal and THIS
    // account bid, so it may only judge the asks it owns on both axes.
    await yieldToTimers();
    const dropped = await this.requests.dropOutOfScope((load) => this.matchesAllowlist(load),
      { owner: this.account, platformKey: this.platformKey });
    for (const r of dropped) this.log(`[discovery] target removed -> dropped stale price request for load ${r.loadId}`);

    // C059 (review correction, 26 Sep): on a platform with a live-close step (GoComet), the stored
    // close is provisional and refreshLiveClose - the only thing that keeps it current - runs off
    // this tick's own listing, above. A failed listing means that refresh never ran, so the stored
    // close may already be stale by the time these two close-keyed sweeps read it: an unpriced ask
    // gets filed 'skipped_no_price' (with a price_expired alert blaming the desk) and an armed load
    // gets terminally 'closed', for an auction that may since have extended - neither rescuable on
    // the next good tick, since the request these sweeps key off is already gone. SuperProcure
    // declares no live-close step (_liveCloseStepMs() is null), so it is unaffected and keeps
    // sweeping through a failed listing exactly as before.
    const skipCloseSweeps = !listingOk && this._liveCloseStepMs() != null;

    // Portal-scoped, like every close-keyed sweep below: this poller refreshes only its own
    // portal's closes, so it is the only one entitled to declare one of them overdue.
    await yieldToTimers();
    const expired = skipCloseSweeps ? [] : await this.requests.expireOverdue(Date.now(), { platformKey: this.platformKey });
    for (const r of expired) {
      this.log(`[discovery] price deadline passed -> skipped load ${r.loadId} (no number entered)`);
      // Tagged with this poller's own portal so the alert routes on its owning portal's channel
      // (notifyModeFor). 'sp' resolves exactly as the untagged payload did, so SuperProcure's
      // money-safe default is preserved rather than flipped.
      await this.notifier.alert('price_expired', { loadId: r.loadId, platformKey: this.platformKey });
      this.onExpire(r);
      await yieldToTimers();
    }

    // Follow-up nudge as the pricing deadline approaches (still open, not yet reminded). Same
    // delivered-gated pattern as the initial ask above: only mark reminderSentAt once the send
    // actually went out, so a down WhatsApp session doesn't lose the reminder outright.
    // After the first nudge the pass has yielded, so each later one is re-judged on a fresh read at
    // the same clock.
    await yieldToTimers();
    const remindAt = Date.now();
    const dueReminders = await this.requests.dueForReminder(remindAt, this.config.reminderLeadMs);
    let due = dueReminders;
    for (const { id } of dueReminders) {
      if (!due) due = await this.requests.dueForReminder(remindAt, this.config.reminderLeadMs);
      const r = due.find((x) => x.id === id);
      if (!r) continue;
      const res = await this.notifier.remindApproaching(r);
      await yieldToTimers();
      due = null;
      if (res && res.delivered === true) {
        await this.requests.markReminded(r.id);
        await yieldToTimers();
      } else if (res && res.delivered === 'unreached') { // CW-145/G9: same class as the initial ask
        await this.requests.markReachedNobody(r.id);
        await yieldToTimers();
        this._noteReachedNobody(r);
      }
    }

    // Retire requests whose auction has closed (awaiting/armed -> closed) so a finished load
    // stops looking actionable in the worklist instead of lingering until the 7d prune.
    // Portal-scoped: another portal's close moves under a poller this one cannot see, so judging
    // it here would retire a live auction off a snapshot only that poller can refresh.
    await yieldToTimers();
    const closed = skipCloseSweeps ? 0 : await this.requests.finalizeClosed(Date.now(), { platformKey: this.platformKey });

    // Bound the request collection: drop requests whose auction ended long ago.
    await yieldToTimers();
    const pruned = await this.requests.pruneEnded(Date.now());

    // D003: the shared dead-man's-switch ping, now that this tick's sweeps are actually done -
    // only when EVERY poller registered on healthcheckPeers (see the constructor) has itself had a
    // good pass within its own interval. This runs once per completed tick; the poller whose sweeps
    // just finished is the one that fires it, but the health of every peer is what decides whether
    // it goes out at all.
    this._maybePingHealthcheck();

    // Every other line in this method already narrates its own event (a drop, an expiry, a
    // listAuctions failure) - a tick that finds nothing new to do produced no output at all
    // before this, so a quiet box gave no signal of whether discovery was even still running.
    // One debug-level summary per tick closes that gap without adding noise at the default
    // info threshold.
    const allowlistRejected = [...allowlistRejectedByShipper.values()].reduce((a, b) => a + b, 0);
    this._logAt('debug',
      `[discovery] tick complete: scanned ${loads.length} load(s), created ${created} price request(s), expired ${expired.length} awaiting-price request(s), reminded ${dueReminders.length}, `
        + `rejected by allowlist ${allowlistRejected} (${[...allowlistRejectedByShipper.entries()].map(([s, n]) => `${s}: ${n}`).slice(0, 10).join(', ') || 'none'})`,
      { scanned: loads.length, created, expired: expired.length, reminded: dueReminders.length, allowlistRejected, allowlistRejectedByShipper: Object.fromEntries(allowlistRejectedByShipper) });

    return { created, dropped: dropped.length, expired: expired.length, reminded: dueReminders.length, closed, pruned, scanned: loads.length, allowlistRejected };
  }

  start(intervalMs) {
    const ms = intervalMs || this.config.discoveryIntervalMs || 30_000;
    const run = async () => {
      try { await this.tick(); }
      catch (e) { this._logAt('error', `[discovery] tick error: ${e.message}`, { err: e }); }
    };
    // Verification finding (26 Sep): re-register onto the shared healthcheck array if stop() (or a
    // constructor that never started, e.g. a paused GoComet poller) had this poller out of it - a
    // console toggle back on, or a genuine restart, must not leave this poller permanently excluded
    // from the check its own siblings still run.
    if (this.healthcheckUrl && !this.healthcheckPeers.includes(this)) this.healthcheckPeers.push(this);
    run();
    this.timer = setInterval(run, ms);
    if (this.timer.unref) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Verification finding (26 Sep): a stopped (or torn-down, or never-started) poller must not go
    // on blocking the shared healthcheck ping forever - a paused GoComet poller silenced every SP
    // ping, and an SP reconnect's discarded old poller silenced the ping until the NEXT restart.
    const i = this.healthcheckPeers.indexOf(this);
    if (i !== -1) this.healthcheckPeers.splice(i, 1);
  }
}

module.exports = {
  DiscoveryPoller, isOutOfHardCloseScope, isMultiVehicle, isPmtBasis, softAdmitted,
  NO_SCHEDULE_COLLECTION, noScheduleCounts,
};
