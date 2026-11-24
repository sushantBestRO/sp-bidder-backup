'use strict';

/**
 * ConfigStore - store-backed, admin-editable runtime config (the Targets & Recipients
 * + Settings panels). Seeds from the static config.js defaults on first read, then the
 * dashboard owns it. Persisted through the store seam (one doc) so it survives a
 * restart. The running components re-read the live values at point of use, so a save
 * takes effect without a redeploy (server.js applies the delta on POST).
 *
 * Fields:
 *   marginsPct[]                              the bid band (highest -> lowest %)
 *   minMarginPct                              the operating-floor margin (>= cost+this)
 *   allowlist { shippers[], lanes[], hardCloseOnly }   which loads to auto-bid
 *   recipients [{ name, phone, alerts[] }]    who gets which WhatsApp alert (Phase-2 wire)
 *   discoveryIntervalMs, priceDeadlineLeadMs, reminderLeadMs  loop timing
 *   notifyMode                                'whatsapp' (default) | 'dashboard' (console worklist only)
 *   gocometNotifyMode                         the SAME two values, for GoComet's records only
 *                                             ('dashboard' default). Resolution is per RECORD
 *                                             (Notifier.notifyModeFor), so this can never silence
 *                                             SuperProcure and notifyMode can never un-gate GoComet.
 *   antiDetection { enabled, cadenceJitterMs, openJitterMs, maxBidsPerMin, minInterFireMs }
 *                                             "human-like" cadence; the engine reads the
 *                                             effective values live. openJitterMs randomizes
 *                                             WHEN the first (establish) bid fires. Hard floors
 *                                             below keep a setting from breaking the snipe.
 *   clericalFloor { absRs, perKmRs }          the clerical-error cost floor; unset = the env floor
 *   walk { sp, gocomet }                      the final-window walk per platform (engine/walk.js),
 *                                             switched off by default
 */

const { validateMargins } = require('../pricing/marginValidate');
// The one canonical recipient rule (a mobile, or a WhatsApp group JID). normalizePhone requires
// nothing, so this does not close a cycle with personStore/project, which both require ALERT_KINDS
// from here.
const { normalizeRecipient } = require('../model/normalizePhone');
// The rupee-grid bounds live with the snapper they gate, so the save validator and the engine's own
// coercion can never drift into accepting different values.
const { ROUNDING_STEP_MIN, ROUNDING_STEP_MAX } = require('../engine/pricing');
// The final-window walk's settings are validated where the engine's own copy is normalised.
const { DEFAULT_WALK, WALK_LIMITS, mergeWalk, validateWalk } = require('../engine/walk');

const COLLECTION = 'config';
const KEY = 'current';
// 'desk_notice' joined on 2026-07-27 - the NON-PAGING class. A load we correctly and deliberately
// declined for a commercial reason is not a fault, and routing it as 'error' put it in the client
// Director's DMs (13 of them on 27-Jul) alongside genuine outages. It carries the load's shipper /
// origin / branch, so a per-customer WhatsApp group MATCHES it and the desk that priced the load
// hears about it early enough to act, while an 'error'-subscribed human does not.
//
// WHO PICKS IT UP, since a new kind reaching nobody is the documented failure mode here (see
// waTemplates.templateFor's docblock): the "BRL Bids" customer groups are registered
// `alertPrefs: 'all'`, which model/project.js expands against the LIVE ALERT_KINDS at read time -
// so they subscribe to this the moment it exists, with no record migration. Humans carrying an
// explicit kind list (the Director's is ["error","won","lost"]) do NOT, which is the point.
// The one way that latch is lost is an explicit per-assignment alertKinds override or a Team-page
// save on a group record (which freezes 'all' into a snapshot array) - verify on the box before
// relying on it. If it ever did reach nobody the fact is NOT lost: the refusal still logs, still
// reaches the dashboard event ring, and the load's own no-bid receipt at close now states the same
// reason (waTemplates.noBidWhy), so the worst case is a later message, never a silent one.
const ALERT_KINDS = ['price_needed', 'price_submitted', 'bid_live', 'outbid', 'won', 'lost', 'error', 'desk_notice'];
const NOTIFY_MODES = ['dashboard', 'whatsapp'];

// Anti-detection bounds. These are HARD limits (a save outside them is rejected); the
// UI carries the softer "recommended" warnings. The floors exist so no setting can
// starve a legitimate escalation or delay the final-seconds snipe — that timing is
// correctness, not stealth, and is never up for grabs.
const AD_LIMITS = {
  cadenceJitterMs: { min: 0, max: 5_000 },   // spread on the far/mid poll only
  openJitterMs: { min: 0, max: 15_000 },     // establish-bid spread; one-sided-earlier so it never nears the snipe
  maxBidsPerMin: { min: 6, max: 600 },       // >= the standard 6-rung ladder, or it could truncate it
  // Must stay comfortably under the fixed 200ms hot-poll cadence (bidEngine.js DEFAULTS.pollHotMs,
  // not operator-editable): the last-chance fix (bidEngine.js _isLastChance) can fire the
  // establish bid and the floor bid on two consecutive hot ticks ~200ms apart, and a ceiling
  // above that cadence could delay or skip the second (floor) shot inside the 2.5s floor window.
  minInterFireMs: { min: 0, max: 150 },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A rupee grid the save validator will accept: a whole 2-5000, or 1 meaning no grid. */
function sanitizeRoundingStep(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  if (n <= 1) return 1;
  if (!Number.isInteger(n) || n < ROUNDING_STEP_MIN) return 100;
  return Math.min(n, ROUNDING_STEP_MAX);
}

function defaultsFrom(config) {
  const al = config.allowlist || {};
  return {
    marginsPct: (config.marginsPct || []).slice(),
    minMarginPct: config.minMarginPct,
    allowlist: {
      shippers: (al.shippers || []).slice(),
      lanes: (al.lanes || []).slice(),
      hardCloseOnly: !!al.hardCloseOnly,
    },
    recipients: [],
    discoveryIntervalMs: config.discoveryIntervalMs,
    priceDeadlineLeadMs: config.priceDeadlineLeadMs,
    reminderLeadMs: config.reminderLeadMs,
    notifyMode: config.notifyMode || 'whatsapp',
    // Per-portal channel for GoComet. Defaults DARK rather than inheriting notifyMode: a portal
    // whose loads should surface without messaging is the requested posture, and inheriting would
    // make enabling GoComet silently start WhatsApp traffic on a customer's group.
    gocometNotifyMode: (config.gocomet && config.gocomet.notifyMode) || 'dashboard',
    antiDetection: {
      enabled: (config.antiDetection && config.antiDetection.enabled) !== false,
      cadenceJitterMs: config.antiDetection ? config.antiDetection.cadenceJitterMs : 250,
      openJitterMs: config.antiDetection ? config.antiDetection.openJitterMs : 4000,
      maxBidsPerMin: config.antiDetection ? config.antiDetection.maxBidsPerMin : 20,
      minInterFireMs: config.antiDetection ? config.antiDetection.minInterFireMs : 150,
    },
    // L3 soft-close strategy (per-customer, DEFAULT OFF). Persisted so a Settings save takes effect live
    // (server.js applyConfigValues -> engine.setSoftClose + config.softClose for discovery).
    softClose: {
      enabled: !!(config.softClose && config.softClose.enabled),
      shippers: (config.softClose && Array.isArray(config.softClose.shippers)) ? config.softClose.shippers.slice() : [],
      mode: (config.softClose && config.softClose.mode === 'live') ? 'live' : 'shadow',
      reserve: (config.softClose && Number.isFinite(Number(config.softClose.reserve))) ? Number(config.softClose.reserve) : 1,
    },
    // Round-figure quoting (per-shipper, DEFAULT OFF). Persisted so a Settings save takes effect live
    // (server.js applyConfigValues -> engine.setRounding).
    rounding: {
      enabled: !!(config.rounding && config.rounding.enabled),
      shippers: (config.rounding && Array.isArray(config.rounding.shippers)) ? config.rounding.shippers.slice() : [],
      // Sanitised HERE, not merely range-checked in validate(): these defaults seed the saved doc, and
      // config.js reads the step straight off an env var with no validation. An unusable value reaching
      // this object would fail validate() on every subsequent save of any unrelated panel.
      step: sanitizeRoundingStep(config.rounding && config.rounding.step),
    },
    // Does the GoComet stack's discovery poller run? DEFAULT OFF. The stack itself is env-gated
    // (GC_ENABLE) and building it is a restart; this is the operator's live stop, so polling a
    // third party can be halted from the console without editing .env. Closing it leaves the stack
    // built and inspectable - only the poller stops.
    gocometDiscovery: !!(config.gocomet && config.gocomet.discoveryEnabled),
    // The client's clerical-error floor, Rs absRs + Rs perKmRs x km. Unset (both null) leaves the
    // SP_MIN_COST_ABS / SP_MIN_COST_PER_KM floor in force.
    clericalFloor: { absRs: null, perKmRs: null },
    walk: mergeWalk(DEFAULT_WALK, config.walk),
  };
}

const bad = (msg) => { const e = new Error(msg); e.code = 'BAD_INPUT'; throw e; };

/** Merge a partial onto a base, field by field (deep for allowlist; replace for arrays). */
function merge(base, partial) {
  const out = clone(base);
  if (partial == null) return out;
  if (partial.marginsPct !== undefined) out.marginsPct = partial.marginsPct;
  if (partial.minMarginPct !== undefined) out.minMarginPct = partial.minMarginPct;
  if (partial.recipients !== undefined) out.recipients = partial.recipients;
  if (partial.discoveryIntervalMs !== undefined) out.discoveryIntervalMs = partial.discoveryIntervalMs;
  if (partial.priceDeadlineLeadMs !== undefined) out.priceDeadlineLeadMs = partial.priceDeadlineLeadMs;
  if (partial.reminderLeadMs !== undefined) out.reminderLeadMs = partial.reminderLeadMs;
  if (partial.notifyMode !== undefined) out.notifyMode = partial.notifyMode;
  if (partial.gocometNotifyMode !== undefined) out.gocometNotifyMode = partial.gocometNotifyMode;
  if (partial.allowlist !== undefined) {
    const a = partial.allowlist || {};
    out.allowlist = {
      shippers: a.shippers !== undefined ? a.shippers : out.allowlist.shippers,
      lanes: a.lanes !== undefined ? a.lanes : out.allowlist.lanes,
      hardCloseOnly: a.hardCloseOnly !== undefined ? !!a.hardCloseOnly : out.allowlist.hardCloseOnly,
    };
  }
  if (partial.antiDetection !== undefined) {
    const d = partial.antiDetection || {};
    const cur = out.antiDetection || {};
    out.antiDetection = {
      enabled: d.enabled !== undefined ? !!d.enabled : cur.enabled,
      cadenceJitterMs: d.cadenceJitterMs !== undefined ? d.cadenceJitterMs : cur.cadenceJitterMs,
      openJitterMs: d.openJitterMs !== undefined ? d.openJitterMs : cur.openJitterMs,
      maxBidsPerMin: d.maxBidsPerMin !== undefined ? d.maxBidsPerMin : cur.maxBidsPerMin,
      minInterFireMs: d.minInterFireMs !== undefined ? d.minInterFireMs : cur.minInterFireMs,
    };
  }
  if (partial.softClose !== undefined) {
    const d = partial.softClose || {};
    const cur = out.softClose || {};
    out.softClose = {
      enabled: d.enabled !== undefined ? !!d.enabled : cur.enabled,
      shippers: d.shippers !== undefined ? d.shippers : cur.shippers,
      mode: d.mode !== undefined ? d.mode : cur.mode,
      reserve: d.reserve !== undefined ? d.reserve : cur.reserve,
    };
  }
  if (partial.rounding !== undefined) {
    const d = partial.rounding || {};
    const cur = out.rounding || {};
    out.rounding = {
      enabled: d.enabled !== undefined ? !!d.enabled : cur.enabled,
      shippers: d.shippers !== undefined ? d.shippers : cur.shippers,
      step: d.step !== undefined ? d.step : cur.step,
    };
  }
  if (partial.gocometDiscovery !== undefined) out.gocometDiscovery = !!partial.gocometDiscovery;
  if (partial.walk !== undefined) out.walk = mergeWalk(out.walk || DEFAULT_WALK, partial.walk);
  if (partial.clericalFloor !== undefined) {
    const d = partial.clericalFloor || {};
    const cur = out.clericalFloor || {};
    out.clericalFloor = {
      absRs: d.absRs !== undefined ? d.absRs : cur.absRs,
      perKmRs: d.perKmRs !== undefined ? d.perKmRs : cur.perKmRs,
    };
  }
  return out;
}

function validate(cfg, stored = null) {
  // margin band shape is validated by the shared validateMargins (also used by the
  // customer margin profiles + per-load bid override, so all three reject identically).
  const vm = validateMargins(cfg.marginsPct, cfg.minMarginPct, stored);
  cfg.marginsPct = vm.marginsPct;
  cfg.minMarginPct = vm.minMarginPct;

  const a = cfg.allowlist || {};
  const strList = (v, name) => {
    if (!Array.isArray(v)) bad(`${name} must be a list`);
    return v.map((s) => String(s).trim()).filter(Boolean);
  };
  cfg.allowlist = {
    shippers: strList(a.shippers || [], 'allowlist.shippers'),
    lanes: strList(a.lanes || [], 'allowlist.lanes'),
    hardCloseOnly: !!a.hardCloseOnly,
  };

  if (!Array.isArray(cfg.recipients)) bad('recipients must be a list');
  const scopeList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
  cfg.recipients = cfg.recipients.map((r, i) => {
    if (!r || typeof r !== 'object') bad(`recipient #${i + 1} is malformed`);
    const name = String(r.name || '').trim();
    // The phone is the delivery address - it is the field a recipient MUST have; the name is
    // just a label (the console shows the number / "Unnamed" when it's blank). Delegate to the
    // one canonical recipient rule (model/normalizePhone) rather than re-deriving it here, so a
    // value that validates for a Person validates identically for a legacy recipient. A recipient
    // may be a mobile (+91XXXXXXXXXX) or a WhatsApp group ('<digits>@g.us').
    let phone;
    try { phone = normalizeRecipient(r.phone); }
    catch (_) { bad(`recipient #${i + 1} needs a valid 10-digit mobile number or a WhatsApp group id`); }
    const alerts = Array.isArray(r.alerts) ? r.alerts.filter((k) => ALERT_KINDS.includes(k)) : [];
    // scope = which loads this recipient's alerts cover; empty origins+shippers = all loads
    const s = r.scope && typeof r.scope === 'object' ? r.scope : {};
    const scope = { origins: scopeList(s.origins), shippers: scopeList(s.shippers) };
    return { name, phone, alerts, scope };
  });

  cfg.discoveryIntervalMs = Number(cfg.discoveryIntervalMs);
  if (!(cfg.discoveryIntervalMs >= 5000)) bad('discoveryIntervalMs must be >= 5000 (5s)');
  cfg.priceDeadlineLeadMs = Number(cfg.priceDeadlineLeadMs);
  if (!(cfg.priceDeadlineLeadMs >= 0)) bad('priceDeadlineLeadMs must be >= 0');
  cfg.reminderLeadMs = Number(cfg.reminderLeadMs);
  if (!(cfg.reminderLeadMs >= 0)) bad('reminderLeadMs must be >= 0');

  if (!NOTIFY_MODES.includes(cfg.notifyMode)) bad(`notifyMode must be one of ${NOTIFY_MODES.join(', ')}`);
  // Absent defaults to the DARK setting rather than being rejected: every real save arrives merged
  // onto defaultsFrom (which supplies it), so the only way here without one is a caller validating a
  // hand-built object - and refusing that would turn a pre-existing config doc into a boot failure.
  if (cfg.gocometNotifyMode === undefined) cfg.gocometNotifyMode = 'dashboard';
  if (!NOTIFY_MODES.includes(cfg.gocometNotifyMode)) bad(`gocometNotifyMode must be one of ${NOTIFY_MODES.join(', ')}`);

  const ad = cfg.antiDetection || {};
  const bounded = (name, v) => {
    const n = Number(v);
    const lim = AD_LIMITS[name];
    if (!isFinite(n) || n < lim.min || n > lim.max) bad(`antiDetection.${name} must be a number ${lim.min}-${lim.max}`);
    return n;
  };
  cfg.antiDetection = {
    enabled: !!ad.enabled,
    cadenceJitterMs: bounded('cadenceJitterMs', ad.cadenceJitterMs),
    openJitterMs: bounded('openJitterMs', ad.openJitterMs),
    maxBidsPerMin: bounded('maxBidsPerMin', ad.maxBidsPerMin),
    minInterFireMs: bounded('minInterFireMs', ad.minInterFireMs),
  };

  // L3 soft-close: `enabled` (master gate) is the on/off; `mode` is the strict shadow|live posture of an
  // enabled shipper (never silently coerce an unknown to 'live'). reserve is bounded non-negative. FAIL
  // CLOSED - a malformed save is rejected, not turned into a live-fire posture. Default OFF + shadow:
  // disabling requires no field; going live is a deliberate, explicit save. No trigger-window knob: the
  // trigger window is a per-load fact (branchAuctionRemainingTime), never an operator setting.
  const sc = cfg.softClose || {};
  if (sc.mode !== undefined && sc.mode !== 'shadow' && sc.mode !== 'live') {
    bad('softClose.mode must be one of shadow, live');
  }
  const scReserve = Number(sc.reserve != null ? sc.reserve : 1);
  if (!isFinite(scReserve) || scReserve < 0 || scReserve > 100) bad('softClose.reserve must be a number 0-100');
  cfg.softClose = {
    enabled: !!sc.enabled,
    shippers: strList(sc.shippers || [], 'softClose.shippers'),
    mode: sc.mode === 'live' ? 'live' : 'shadow',
    reserve: scReserve,
  };

  // REJECTED rather than coerced, unlike gocometDiscovery below, because there is no safe direction to
  // land on: coercing to 100 rounds on a grid the operator did not choose, coercing to off leaves a
  // shipper the desk believes is compliant quoting figures the customer discards. Both fail silently.
  const rc = cfg.rounding || {};
  const rcStep = Number(rc.step != null ? rc.step : 100);
  // Integer, not merely in range: a fractional grid (99.5) puts non-integer rupees on the ladder, and
  // the wire's own Math.round then turns them back into the odd figures this feature exists to avoid.
  //
  // A step AT OR BELOW 1 IS LEGAL and means "no grid" - the same meaning pricing.js and the engine
  // give it. Rejecting it here would be worse than inconsistent: validate() runs over the WHOLE merged
  // document on every save, and the boot defaults are seeded from an unvalidated env var, so one
  // documented-but-rejected value in .env poisons the defaults and every later save of ANY panel
  // (margins, recipients, notify mode) throws on a field the operator cannot see or reach - there is
  // no rounding control in the console. Normalised to 1 so the stored doc has one spelling of "off".
  if (!Number.isInteger(rcStep) || rcStep > ROUNDING_STEP_MAX
    || (rcStep > 1 && rcStep < ROUNDING_STEP_MIN)) {
    bad(`rounding.step must be a whole number ${ROUNDING_STEP_MIN}-${ROUNDING_STEP_MAX} (rupee grid), or <= 1 for no grid`);
  }
  cfg.rounding = {
    enabled: !!rc.enabled,
    shippers: strList(rc.shippers || [], 'rounding.shippers'),
    step: rcStep <= 1 ? 1 : rcStep,
  };

  // Coerced, never validated-and-rejected: a malformed value lands on false, which is the safe
  // direction (no live third-party polling) rather than a rejected save.
  cfg.gocometDiscovery = !!cfg.gocometDiscovery;

  // Rejected, never coerced: this floor refuses the desk's rates, so a junk figure landing on 0 would
  // switch it off and one landing high would refuse every truck rate.
  const cf = cfg.clericalFloor || {};
  const figure = (v, what, whole) => {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0 || (whole && !Number.isInteger(n))) {
      bad(`Missing-digit check: the ${what} must be ${whole ? 'a whole number of rupees' : 'a number of rupees'}, 0 or more`);
    }
    return n;
  };
  const absRs = figure(cf.absRs, 'fixed amount', true);
  const perKmRs = figure(cf.perKmRs, 'per-km amount', false);
  if ((absRs != null || perKmRs != null) && !(absRs > 0) && !(perKmRs > 0)) {
    bad('Missing-digit check: enter an amount above 0, or clear both amounts to use the default');
  }
  cfg.clericalFloor = { absRs, perKmRs };

  // Refused rather than coerced: a walk step time the operator did not choose moves live bids.
  cfg.walk = validateWalk(cfg.walk || DEFAULT_WALK);
  return cfg;
}

// Top-level fields where a persisted document differs from the env-derived defaults - the
// precedence a fresh save silently wins once it exists. Comparison is JSON-stable, not a deep
// diff, because callers only need to know WHICH fields diverged, not where inside them.
function diffFromDefaults(defaults, saved) {
  if (!saved) return [];
  const out = [];
  for (const key of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(saved, key)) continue;
    if (JSON.stringify(defaults[key]) !== JSON.stringify(saved[key])) out.push(key);
  }
  return out;
}

// validate() without throwing, for a caller that must still USE a possibly-invalid document
// (boot) rather than reject it (save()). Never mutates cfg.
function safeValidate(cfg) {
  try { validate(clone(cfg)); return { ok: true, error: null }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

class ConfigStore {
  constructor({ store, defaults }) {
    this.store = store;
    this.defaults = defaults;
    this._cache = null;
    // Fired once, the first time a persisted document is loaded (never on a cached repeat get(),
    // never on save() - validate() already gates that write). Callers wire this to ops alerting;
    // left null, ConfigStore behaves exactly as before. Set as a property rather than a
    // constructor param because the notifier this feeds doesn't exist yet at construction time.
    this.onLoad = null;
  }

  async get() {
    if (this._cache) return clone(this._cache);
    const saved = await this.store.getDoc(COLLECTION, KEY);
    this._cache = saved ? merge(this.defaults, saved) : clone(this.defaults);
    if (saved && this.onLoad) {
      const diverged = diffFromDefaults(this.defaults, saved);
      const check = safeValidate(this._cache);
      try { this.onLoad({ diverged, valid: check.ok, error: check.error }); } catch (_) {}
    }
    // Applied as-is, validated or not: an invalid persisted document must never stop the bidder
    // booting (onLoad above is where that gets surfaced loudly).
    return clone(this._cache);
  }

  async save(partial) {
    const cur = await this.get();
    const next = validate(merge(cur, partial), cur);
    await this.store.putDoc(COLLECTION, KEY, next);
    this._cache = next;
    return clone(next);
  }
}

module.exports = {
  ConfigStore, defaultsFrom, validate, merge, diffFromDefaults, safeValidate,
  ALERT_KINDS, NOTIFY_MODES, AD_LIMITS, WALK_LIMITS, COLLECTION, KEY,
};
