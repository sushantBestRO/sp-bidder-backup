'use strict';

const { PlatformAdapter } = require('./adapter');
const { assertAboveFloor, plausibleCeiling, assertBelowCeiling } = require('../engine/pricing');
const { portalFetch } = require('./portalFetch');
const { createLogger } = require('../logging/logger');
const { GoCometCloseModel, resolvePlantIncrementMs } = require('./gocometCloseModel');
const { parseGoCometLane, parseGoCometPlace } = require('./gocometLane');
const { readLoadSpec, chargeMatchToken } = require('./gocometCargo');
const { readTargetPrice } = require('./gocometTargetPrice');
const { normalizeServerOffset, ServerClockEstimator } = require('../util/serverClock');

/**
 * GoCometAdapter - the SECOND platform behind the PlatformAdapter seam (Module 2, Phase 1).
 *
 * GoComet is BRL's other freight reverse-auction portal (their own existing bot bids on it
 * today; see automated-bidding/reference/brl-gocomet/). This adapter implements the same five
 * seam methods the SuperProcure adapter does, so everything above the seam - the engine,
 * scheduler, pricing ladder, cost floor, kill-switch, dashboard - is inherited unchanged.
 *
 * SCOPE OF THIS PHASE (deliberately narrow):
 *   - READ paths (login/session, listAuctions, getAuctionState) are implemented against the
 *     live-validated GoComet vendor API (contract in
 *     _research/2026-07-13_gocomet-recon-for-module2.md + the 2026-07-25 on-box discovery).
 *   - The WRITE path (placeBid) is implemented to the clone's exact fetch-mutate-PUT contract
 *     but HARD-DISABLED behind TWO independent gates: the adapter's own `writeEnabled` backstop
 *     (the same one the engine kill-switch lowers) AND an explicit env flag
 *     (config.gocomet.bidEnabled / GC_BID=1), which defaults OFF. Both must be true for a bid to
 *     leave the building, so a configured READ token can never place a bid, and this PR never
 *     auto-enables writes anywhere.
 *   - There is NO scheduling/engine wiring here: in Phase 1 the adapter is registered (built,
 *     session-validated, expiry-watched) but NOT inserted into the SuperProcure bidding stack,
 *     so it has ZERO impact on live SP money.
 *
 * AUTH. GoComet uses a BARE JWT (no `Bearer` prefix) in the `authorization` header, alongside
 * `schema: app` / `ops-client-schema: app` and an app.gocomet.com origin/referer -
 * Bearer-prefixing OR dropping the schema headers yields 401 (confirmed live). The "session" is
 * simply the configured token (config.gocomet.token / GC_TOKEN); login() adopts and VALIDATES it
 * offline (structure + expiry), it does NOT drive an OTP/Puppeteer flow - unattended re-auth is
 * a separately-scoped item. GoComet JWTs are short-lived (~monthly; the token on the box expires
 * 2026-08-09), so expiry awareness matters far more than it does for SuperProcure's ~1yr JWT -
 * an absent/expired token fails CLOSED with a clear operator alert, and the boot registration
 * reuses tokenExpiry.js's 30/14/7/3/1-day proactive-alert rail.
 *
 * A reverse auction here means LOWEST price wins; rank 1 = winning. GoComet is rank-only
 * (Waaree hides L1), reactive-countdown close (the deadline slides forward on an extension; the
 * `auction_type` field is UNRELIABLE and must never gate extension handling), and multi-cargo
 * (one enquiry can carry several freight-charge lines each with its own price).
 */

// GoComet's live vendor API. All per-enquiry read/write paths hang off this prefix.
const API_PREFIX = '/api/v1/vendor';

// Plausibility bound on any parsed close time. GoComet (like SuperProcure) can return a
// placeholder far-future timestamp instead of a real deadline, and the SuperProcure year-2100
// placeholder incident is the canonical lesson: a bad time that parses as VALID arms a load with
// a decades-long fake runway. So every close time is bound-checked to a sane window around now
// and anything outside it is treated as "no real deadline" - flagged + excluded, never armed.
const MAX_PLAUSIBLE_DEADLINE_MS = 30 * 86_400_000; // +30 days
const MAX_PLAUSIBLE_PAST_MS = 7 * 86_400_000;      // -7 days (a just-closed load can still list)

// Browser-coherent header stack, ported verbatim from BRL's own live GoComet bot getHeaders()
// (reference/brl-gocomet/source/server.js:126) and reconfirmed working on-box 2026-07-25. The
// authorization value is the BARE JWT - no `Bearer` prefix (that 401s). We keep this constructed-
// coherent rather than capturing a full real header set; over-building header/TLS fidelity on
// BRL's own legitimate account is out of scope unless blocking is actually observed.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

/** Decode a JWT segment that may be base64url (url-safe alphabet, no padding). */
function decodeJwtSegment(seg) {
  const norm = String(seg).replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? norm : norm + '='.repeat(4 - (norm.length % 4));
  return Buffer.from(pad, 'base64').toString('utf8');
}

/** Parse a JWT payload's claims, or null if the token is malformed. Never throws. */
function jwtClaims(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const obj = JSON.parse(decodeJwtSegment(parts[1]));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) { return null; }
}

/** Parse Retry-After (RFC 9110): delta-seconds first, else an HTTP-date. Ported from realAdapter. */
function parseRetryAfterMs(headerVal, nowMs) {
  if (headerVal == null) return null;
  const s = String(headerVal).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, t - nowMs);
}

/**
 * The pricing BASES we are willing to bid against, normalized and uppercased.
 *
 * GoComet resolves a per-enquiry unit vocabulary of 96 entries, and `TRUCK` is the only basis
 * ever observed on BRL's account (both HAR loads plus the live probe). The vocabulary also
 * contains `TON`, and on the two captured loads `TON` resolved to 50.0 and 23.0 - so a per-tonne
 * line multiplies the written price by 23-50x. That is precisely the SuperProcure PMT incident
 * (a 12-45x underbid on live money) waiting to happen on a second platform, which is why an
 * unrecognised basis is REFUSED rather than assumed to be per-vehicle.
 */
const SUPPORTED_QUOTE_BASES = new Set(['TRUCK']);

/**
 * The ONLY fields we keep off `GET /enquiries/{key}`. An ALLOWLIST, not a denylist, and that is
 * a security decision rather than a tidiness one.
 *
 * That endpoint returns 81 top-level keys and ~25 KB, and among them GoComet serves
 * `created_by.password_digest` - a 40-hex credential hash belonging to the SHIPPER'S staff user -
 * to an unrelated vendor account. Reproduced on three separate enquiries, so it is systematic and
 * not a fluke. `created_by` also carries that person's email, phone, employee id and role, and
 * `client_group` is a second 30-key config blob. None of it is adapter-relevant.
 *
 * `quote_approved_by` carries the SAME class of leak - a name, email, phone, employee id,
 * permissions and a password digest, for a different Waaree staff user (2026-09-25 two-point
 * capture). It never joins this list either, for the same reason `created_by` does not.
 *
 * A blanket store.putDoc() or a debug log line that dumped this object would write a third
 * party's password hash into data/ on BRL's VPS and into the log stream. A denylist would leave
 * us one GoComet schema change away from doing exactly that, silently. So nothing survives this
 * projection unless it is named here. Dropping the two blobs also removes ~90% of the payload.
 * `quote_approved_by` carries the same kind of third-party record as `created_by`; never add either.
 */
const ENQUIRY_DETAIL_FIELDS = [
  // the two fields this fetch exists for
  'cargo_quantity', 'cargo_unit', 'slab_rate',
  // One human descriptor per CARGO TYPE ("1 x 40FT (LxWxH - 40'x8'x8'8\") 22 Ton Truck"). Kept for
  // its LENGTH, which is the only pre-write signal that a quote will carry more than one
  // freight-charge line - see _mapEnquiry's cargoLines. Free text, no third-party identity in it.
  'quantity',
  // THE LOAD'S PHYSICAL SPEC, and the reason these two joined an allowlist that had refused them.
  // `gross_weight` is the descriptor with the declared per-unit weight appended ("... 7000.0 KG")
  // and `custom_columns` is where the shipper puts the road distance. Both were already arriving
  // on this response and being discarded here, which is why the price page could show neither -
  // widening the projection is the whole fix, no extra call. Both are free text / a small
  // label-value list, and neither carries a third party's identity, which is the bar this
  // allowlist exists to hold.
  'gross_weight', 'custom_columns',
  // The shipment MODE ("FTL"). Named so the detail can answer it when the list item is not to
  // hand; it is a mode word, never a vehicle type - see gocometCargo.
  'mode',
  // BC-36: a load's EXTRA pickup/drop points beyond the primary lane. Plain string arrays,
  // `[]` on a single-point load (2026-09-25 capture) - no third-party identity in any of the
  // four, only an address and a pincode that _mapEnquiry immediately reduces to city/pincode.
  'other_origins', 'other_origin_zip_codes', 'other_destinations', 'other_destination_zip_codes',
  // cheap, adapter-relevant extras that ride along for free
  'ceiling_rate', 'bid_close_timestamp', 'bid_close_time', 'bid_closing_in',
  'bidding_closed', 'bidding_closed_at', 'status', 'current_server_time',
  'vendor_rank', 'total_revisions', 'revisions_left',
];

/**
 * A stable rendering of one quote's WRITABLE state, used to tell "nobody has touched this quote
 * since we read it" from "somebody has". Keys are sorted, so two reads of an unchanged document
 * compare equal whatever order the server happened to serialise them in - a false "it changed"
 * would refuse a live bid, so the comparison must not be sensitive to anything but content.
 *
 * SCOPE IS DELIBERATELY NARROW: the charge lines (every price and multiplier we would submit) plus
 * `updated_at` when the endpoint serves it. Comparing the whole 52-key body would be stronger and
 * is the wrong trade - one server-side field that legitimately churns between two reads (a clock, a
 * countdown) would refuse EVERY bid, and only one quote body has ever been captured, so that set
 * cannot be enumerated. Every way a concurrent write can cost us money runs through charges_list:
 * the price on our own line, and the sibling lines GoComet sums into the quote total.
 */
function quoteWriteFingerprint(quote) {
  const canon = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) || 'null';
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  };
  if (!quote || typeof quote !== 'object') return 'null';
  return canon({ charges_list: quote.charges_list ?? null, updated_at: quote.updated_at ?? null });
}

/**
 * READ CLASSES. The GET budget below serves the highest class that can use a slot, so a load in
 * its endgame is never queued behind discovery paging. WRITE is the quote fetch inside placeBid -
 * it is a read, but a bid is already in flight behind it.
 */
const READ_PRIORITY = { ROUTINE: 0, POLL: 1, HOT: 2, WRITE: 3 };
/** Indexed by the priority value, so a starvation report names a class instead of a number. */
const READ_PRIORITY_NAME = ['ROUTINE', 'POLL', 'HOT', 'WRITE'];

// T2b (ruling 61): how long a prepared quote is trusted without a fresh confirming read.
const PREPARED_QUOTE_MAX_AGE_MS = 5000;
// The engine fires a pre-final round's shot from this far out (PROVISIONAL_MIDDLE_BAND_MS).
const PROBE_SHOT_LEAD_MS = 12_000;
// How long past its believed close a load with no later close seen stays HOT. Long enough for the
// reads that show whether the close moved, short enough that a closed load stops taking slots from
// a sibling still in its endgame (2026-09-25, Waaree 260925RP1C).
const POST_CLOSE_HOT_MS = 3_000;

/**
 * The tightest global ceiling we will accept from configuration, and the ONE number in this file
 * with hard evidence behind it: BRL's own legacy GoComet bot polled at ~200ms and logged 2,629
 * HTTP 429s. A configured ceiling at or below that is a rate we have positive evidence is harmful,
 * so it resolves to the default rather than being honoured. 250ms leaves the operator the whole
 * usable range and refuses only the part we already know does not work.
 */
const MIN_CREDIBLE_CEILING_MS = 250;

/**
 * Resolve one rate-limiter knob, degrading anything unusable to `def`.
 *
 * These are safety knobs against a limit nobody has measured, so the rule is one-directional:
 * garbage must never resolve to a MORE aggressive request rate than the default. 0, a negative, a
 * NaN from a typo'd env value, and anything below `min` therefore all take the default - not
 * "unbounded", which is what a bare Number() would hand back for `GC_GLOBAL_MIN_GET_INTERVAL_MS=0`
 * and which is the one outcome that must not be reachable by misconfiguration. `max` clamps rather
 * than defaults, because every knob that has one is capped on its SAFE side.
 */
function rateKnob(raw, def, { min = 1, max = Infinity, integer = false } = {}) {
  if (!Number.isFinite(raw) || raw < min) return def;
  const v = Math.min(raw, max);
  return integer ? Math.floor(v) : v;
}

// C102: a field GoComet adds that this allowlist has never heard of is exactly the kind of drift a
// hand-maintained field list cannot catch any other way - it must surface somewhere, not vanish
// silently into the projection. Logged ONCE per field name for the life of the process (a fresh
// unknown field is news; the same one on every subsequent enquiry is not).
const _loggedUnknownEnquiryFields = new Set();
const _enquiryProjectionLog = createLogger('gocomet');

/** Keep only the allowlisted keys. Never returns a reference into the raw payload. */
function projectEnquiryDetail(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of Object.keys(raw)) {
    if (ENQUIRY_DETAIL_FIELDS.includes(k) || _loggedUnknownEnquiryFields.has(k)) continue;
    _loggedUnknownEnquiryFields.add(k);
    _enquiryProjectionLog.warn(`gocomet enquiry detail carries a field the allowlist does not recognise (dropped): '${k}'`, { field: k });
  }
  for (const f of ENQUIRY_DETAIL_FIELDS) if (raw[f] !== undefined) out[f] = raw[f];
  return out;
}

/**
 * BC-36: GoComet's extra-point arrays (`other_origins`/`other_destinations`, each paired with its
 * own zip array), reduced to `{city, pincode}` - never the raw address - via the same
 * pincode-anchored parser the primary lane uses (gocometLane.parseGoCometPlace). A stop that
 * yields neither a usable city nor a pincode is dropped rather than passed through as a street
 * address; an empty result is null, matching every other "not established" field on this load.
 */
function mapExtraStops(addresses, zips) {
  if (!Array.isArray(addresses) || !addresses.length) return null;
  const stops = [];
  for (let i = 0; i < addresses.length; i++) {
    const place = parseGoCometPlace(addresses[i], zips && zips[i]);
    if (place.city || place.pincode) stops.push({ city: place.city, pincode: place.pincode });
  }
  return stops.length ? stops : null;
}

/**
 * The WRITE path's half of the same allowlist discipline ENQUIRY_DETAIL_FIELDS applies to the read.
 *
 * A refused submit's body used to reach `reason`, `raw` and a log.warn verbatim, and those three land
 * in data/closedBids.json, in the append-only (un-backfillable) bids-*.jsonl, and in pm2-err.log on
 * BRL's VPS. That is the same door the read-path allowlist exists to close - GoComet serves a third
 * party's `created_by.password_digest` on the enquiry endpoint - left open on the side where the body
 * is an ERROR whose shape nobody has captured or bounded. Unbounded third-party text on a durable,
 * operator-read, backed-up surface is the exposure, not one known payload.
 *
 * Only these three names survive, and they are exactly the ones that carry the "why": the forensic
 * trace bidLogger keeps must not be paid for with an unbounded dump. A NON-JSON body (a framework
 * error page) has no names to project, so nothing of it survives and the rejection is recorded as
 * `http_<status>` - which is what a denylist could never guarantee.
 */
const SUBMIT_ERROR_FIELDS = ['message', 'error', 'errors'];

/** Longest projected reason we will persist. An allowlisted field can still be arbitrarily long. */
const SUBMIT_ERROR_MAX_CHARS = 300;

/**
 * Project a parsed submit-rejection body to the allowlisted "why", or null when it carries none.
 * Returns a bounded STRING because that is what the seam's `reason` is; a caller wanting structure
 * would be re-opening the egress this closes.
 */
function projectSubmitError(parsed) {
  const joined = projectSubmitText(parsed);
  if (joined == null) return null;
  return joined.length > SUBMIT_ERROR_MAX_CHARS ? `${joined.slice(0, SUBMIT_ERROR_MAX_CHARS)}...` : joined;
}

/**
 * The same allowlisted projection, uncut. For CLASSIFYING the refusal only: a verdict past the display
 * cut must still be read. It rides the envelope's `body`, which the engine scans and never persists.
 */
function projectSubmitText(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const parts = [];
  for (const f of SUBMIT_ERROR_FIELDS) {
    const v = parsed[f];
    if (v == null) continue;
    if (Array.isArray(v)) { for (const x of v) if (x != null && typeof x !== 'object') parts.push(String(x)); }
    else if (typeof v !== 'object') parts.push(String(v));
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * Normalize GoComet's `cargo_unit` into the quote-basis vocabulary the rest of the codebase
 * shares with SuperProcure ('FTL' = the count is trucks, 'PMT' = it is a weight quantity).
 *
 * This matters because the basis is what stops `units` being read as a truck count when it is
 * actually a tonnage. Matching is on the SERVER-NORMALIZED cargo_unit ("TRUCK" on every observed
 * load), never on a charge line's mangled unit_name - see readQuoteBasis for why that string is
 * unparseable. An unrecognised value returns null, i.e. "basis not established", which is the
 * honest input to the upstream fail-closed path; it is never guessed into FTL.
 */
function normalizeCargoUnit(cargoUnit) {
  if (cargoUnit == null) return null;
  const u = String(cargoUnit).trim().toUpperCase();
  if (!u) return null;
  if (u === 'TRUCK' || u === 'TRUCKS' || u === 'VEHICLE' || u === 'VEHICLES') return 'FTL';
  if (u === 'TON' || u === 'TONS' || u === 'MT' || u === 'TONNE' || u === 'TONNES' || u === 'KG') return 'PMT';
  return null;
}

/**
 * Read the QUANTITY MULTIPLIER and the PRICING BASIS off a quote, or throw.
 *
 * This exists because GoComet's server computes `total = price x units` - proven on 34 server
 * bodies with zero violations - while the price we write is a bare per-unit number. Everything
 * about whether our bid means what we think it means therefore depends on two facts the adapter
 * previously never read at all: what `units` is, and what ONE unit is.
 *
 * READ THE NORMALIZED FIELDS, NEVER THE PER-LINE `unit_name`. The charge line's own unit_name is
 * a mangled, word-reordered concatenation - the two captured loads carried
 *   "TRUCK TONS 25 40'X8'X8.8') - (LXWXH 40FT"   and   "TRUCK TON 22 40'X8'X8'8\") - (LXWXH 40FT"
 * Both contain the substring TON/TONS and BOTH ARE PER-TRUCK, so the obvious
 * `unit_name.includes('TON')` basis check misclassifies 100% of the known sample - in the
 * dangerous direction, and silently. The string also carries an unbalanced ')' and an embedded
 * '"', so it is not safely parseable at all. `total_charges.total.unit_name` is the server's own
 * normalized value ("TRUCK") and is what this reads.
 *
 * CROSS-CHECK RATHER THAN TRUST ONE FIELD. Four independent carriers of the multiplier agreed in
 * 83/83 quote bodies, so a disagreement is not a tie to be broken - it means the data model has
 * changed under us and we no longer understand the wire. Which carrier the SERVER multiplies by
 * is genuinely NOT DETERMINABLE from any capture (every request carried all of them in
 * agreement), so there is no "authoritative" one to prefer. Refusing on disagreement is the only
 * position that does not rest on a guess.
 *
 * @returns {{units: number, unitName: string, lineUnits: number}}
 * @throws  BASIS_UNKNOWN / BASIS_UNSUPPORTED / UNITS_UNREADABLE / UNITS_DISAGREE
 */
function readQuoteBasis(quote, chargeLine, enquiryKey) {
  const tot = quote && quote.total_charges && quote.total_charges.total;
  if (!tot || typeof tot !== 'object') {
    const e = new Error(`gocomet: quote for enquiry ${enquiryKey} has no total_charges.total - cannot establish the pricing basis, refusing to bid blind`);
    e.code = 'BASIS_UNKNOWN'; throw e;
  }
  const unitName = tot.unit_name == null ? null : String(tot.unit_name).trim().toUpperCase();
  if (!unitName) {
    const e = new Error(`gocomet: quote for enquiry ${enquiryKey} has no normalized total_charges.total.unit_name - refusing`);
    e.code = 'BASIS_UNKNOWN'; throw e;
  }
  if (!SUPPORTED_QUOTE_BASES.has(unitName)) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} prices per ${JSON.stringify(unitName)}, which is not a basis this adapter can bid (supported: ${[...SUPPORTED_QUOTE_BASES].join(', ')}). A per-tonne basis multiplies the written price by the tonnage - refusing rather than underbidding by that factor`);
    e.code = 'BASIS_UNSUPPORTED'; e.unitName = unitName; throw e;
  }

  // The four carriers, in the order the docs inventory them. `quote_units` sits beside `units`
  // on the same object and is not a duplicate by accident - it is a separate leaf that has
  // always agreed, so it is a free consistency check.
  const carriers = [
    ['total_charges.total.units', tot.units],
    ['total_charges.total.quote_units', tot.quote_units],
    ['charges_list[line].units', chargeLine && chargeLine.units],
  ].filter(([, v]) => v != null);

  // TYPE-STRICT, not Number()-coercive. Number() happily turns true into 1, [2] into 2 and
  // " 2 " into 2, so a reshaped payload could have produced a confident multiplier out of a
  // value that was never a number. The observed wire is an integer on the charge line and a
  // float on the totals block, so a JS number is the only shape we accept.
  const nums = carriers.map(([name, v]) => [name, typeof v === 'number' ? v : NaN]);
  const bad = nums.find(([, n]) => !Number.isFinite(n) || n <= 0);
  if (!nums.length || bad) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} has no usable units multiplier (${bad ? `${bad[0]}=${JSON.stringify(bad[1])}` : 'no carrier present'}) - refusing rather than assuming 1`);
    e.code = 'UNITS_UNREADABLE'; throw e;
  }
  // A CROSS-CHECK NEEDS SOMETHING TO CROSS-CHECK AGAINST. Nulls are filtered out above, so a
  // payload carrying only one carrier would reach the comparison below and pass it trivially -
  // the guard would still be there, doing nothing, while its docblock claimed four independent
  // fields agreed. If a schema change drops the others, that is exactly when we most want to
  // stop, so require at least two.
  if (nums.length < 2) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} carries only one units carrier (${nums[0][0]}) - the agreement check that makes this multiplier trustworthy cannot run, so the wire is no longer the one we validated against. Refusing`);
    e.code = 'UNITS_UNCORROBORATED'; throw e;
  }
  // No fractional multipliers. There is no such thing as 1.5 trucks, and SuperProcure's
  // assertValidVcq rejects a fractional count for the same reason; this is the GoComet-side
  // equivalent, applied to the number the server multiplies by.
  const fractional = nums.find(([, n]) => !Number.isInteger(n));
  if (fractional) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} has a fractional units multiplier (${fractional[0]}=${fractional[1]}) - refusing rather than bidding against a partial unit`);
    e.code = 'UNITS_FRACTIONAL'; throw e;
  }
  // Float-tolerant equality: the totals block carries 2.0 while the charge line carries an int 2.
  const first = nums[0][1];
  const mismatch = nums.find(([, n]) => Math.abs(n - first) > 1e-9);
  if (mismatch) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} disagrees with itself on the units multiplier (${nums.map(([n, v]) => `${n}=${v}`).join(', ')}). These agreed in 83/83 observed quotes, so a disagreement means the data model changed - refusing to bid against a wire we no longer understand`);
    e.code = 'UNITS_DISAGREE'; e.carriers = nums.map(([n, v]) => ({ field: n, value: v })); throw e;
  }
  return { units: first, unitName, lineUnits: chargeLine && chargeLine.units != null ? Number(chargeLine.units) : first };
}

/**
 * The basis for a quote carrying SEVERAL truck-type freight lines, where readQuoteBasis cannot be
 * used because its own cross-check is guaranteed to fail.
 *
 * That guarantee is the reason this exists rather than a flag on readQuoteBasis. Its three carriers
 * are total_charges.total.units, .quote_units and the LINE's units, and on a multi-line quote those
 * are three different quantities by construction: `.units` is the SUM over lines (10 on 5+5, 6 on
 * 5+1, 2 on 1+1), `.quote_units` is neither (5, 5, 1 on the same three), and a line carries only
 * its own. Feeding a multi-line quote to readQuoteBasis therefore throws UNITS_DISAGREE every time,
 * which is a false alarm about the data model rather than the refusal it looks like.
 *
 * `quote_units` IS DELIBERATELY NOT A CARRIER HERE. On the four multi-line quotes captured
 * 2026-08-19 it equals both max(line units) and the FIRST line's units, and no capture separates
 * those two rules - so which one it is remains unverified, and a cross-check against a field we
 * cannot predict would refuse honest quotes. What replaces it is the additive identity the server's
 * own arithmetic gives us for free: sum(line units) must equal total_charges.total.units, exact on
 * 8 of 8 observed quotes. That is a real second carrier, not a weaker one.
 *
 * @param {Object} quote
 * @param {Array<{key: string, line: Object}>} lines - the freight lines about to be priced
 * @returns {{units: number, unitName: string, lines: Array<{key: string, units: number}>}}
 *   `units` is the TOTAL across the lines, so `amount x units` is the whole freight total a
 *   uniform per-unit rate produces - the number the read-back oracle needs.
 * @throws BASIS_UNKNOWN / BASIS_UNSUPPORTED / UNITS_UNREADABLE / UNITS_FRACTIONAL /
 *         UNITS_UNCORROBORATED / UNITS_DISAGREE - same codes and same meanings as readQuoteBasis,
 *         so a caller classifies a refusal identically whatever the line count.
 */
function readMultiLineBasis(quote, lines, enquiryKey) {
  const tot = quote && quote.total_charges && quote.total_charges.total;
  if (!tot || typeof tot !== 'object') {
    const e = new Error(`gocomet: quote for enquiry ${enquiryKey} has no total_charges.total - cannot establish the pricing basis, refusing to bid blind`);
    e.code = 'BASIS_UNKNOWN'; throw e;
  }
  const unitName = tot.unit_name == null ? null : String(tot.unit_name).trim().toUpperCase();
  if (!unitName) {
    const e = new Error(`gocomet: quote for enquiry ${enquiryKey} has no normalized total_charges.total.unit_name - refusing`);
    e.code = 'BASIS_UNKNOWN'; throw e;
  }
  if (!SUPPORTED_QUOTE_BASES.has(unitName)) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} prices per ${JSON.stringify(unitName)}, which is not a basis this adapter can bid (supported: ${[...SUPPORTED_QUOTE_BASES].join(', ')}). A per-tonne basis multiplies the written price by the tonnage - refusing rather than underbidding by that factor`);
    e.code = 'BASIS_UNSUPPORTED'; e.unitName = unitName; throw e;
  }
  const out = [];
  for (const { key, line } of lines) {
    // Type-strict for readQuoteBasis's reason: Number() turns true into 1 and " 2 " into 2, so a
    // reshaped payload could produce a confident multiplier out of a value that was never a number.
    const u = line && typeof line.units === 'number' ? line.units : NaN;
    if (!Number.isFinite(u) || u <= 0) {
      const e = new Error(`gocomet: enquiry ${enquiryKey} freight line ${key} has no usable units multiplier (${JSON.stringify(line && line.units)}) - refusing rather than assuming 1`);
      e.code = 'UNITS_UNREADABLE'; e.line = key; throw e;
    }
    if (!Number.isInteger(u)) {
      const e = new Error(`gocomet: enquiry ${enquiryKey} freight line ${key} has a fractional units multiplier (${u}) - refusing rather than bidding against a partial unit`);
      e.code = 'UNITS_FRACTIONAL'; e.line = key; throw e;
    }
    out.push({ key, units: u });
  }
  const sum = out.reduce((a, l) => a + l.units, 0);
  if (typeof tot.units !== 'number' || !Number.isFinite(tot.units) || tot.units <= 0) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} carries ${out.length} freight lines but no usable total_charges.total.units to corroborate them against (${JSON.stringify(tot.units)}) - the agreement check that makes these multipliers trustworthy cannot run. Refusing`);
    e.code = 'UNITS_UNCORROBORATED'; throw e;
  }
  if (Math.abs(tot.units - sum) > 1e-9) {
    const e = new Error(`gocomet: enquiry ${enquiryKey} disagrees with itself on the units multiplier (total_charges.total.units=${tot.units}, sum over ${out.length} freight lines=${sum}: ${out.map((l) => `${l.key}=${l.units}`).join(', ')}). These agreed exactly on every observed quote, so a disagreement means the data model changed - refusing to bid against a wire we no longer understand`);
    e.code = 'UNITS_DISAGREE'; e.carriers = [{ field: 'total_charges.total.units', value: tot.units }, { field: 'sum(charges_list[line].units)', value: sum }];
    throw e;
  }
  return { units: sum, unitName, lines: out };
}

/**
 * ONE LADDER, N COSTS: turn the rung the engine decided into a distinct price per truck type.
 *
 * The engine's whole vocabulary is one per-unit number - the ladder, the floor, the rung it picks.
 * That does not change here. What changes is that the desk may have priced each truck type
 * separately, and a 40 ft 25 T and a 20 ft ODC 10 T are not worth the same per truck. So the rung
 * is read as a MULTIPLIER over the blended cost it was built from (`k = amount / spec.cost`) and
 * re-applied to each type's own cost. Same margin on every line, each line's own base.
 *
 * That choice is what keeps the blast radius here rather than in the engine. N independent ladders
 * would mean N descents against one auction that ranks a single total, and every persisted intent
 * field, the price-matched rung remap and the read-back oracles would all become arrays.
 *
 * THE JOIN IS BY CONTENT, NEVER BY POSITION. The desk's types come off the enquiry's `quantity`
 * descriptors; the lines come off the quote fetched at bid time. Two fetches, and their own prior
 * bot shipped an "if no cargoIndex match, use array index" fallback - i.e. its author had already
 * hit the reorder that silently swaps prices between truck types. chargeMatchToken reduces both
 * sides to the same content token, and this refuses unless the two sets form a bijection AND every
 * matched pair agrees on its count. A rate on the wrong truck type is a mispriced live bid in an
 * unpredictable direction, so the only safe failure here is a loud one.
 *
 * @returns {Map<string, {price: number, cost: number, floor: number|null, label: string}>|null}
 *   null when the desk gave one blended rate (the uniform path, unchanged).
 */
function resolvePerTypePrices(spec, pricedLines, amount, floor, enquiryKey) {
  if (!spec) return null;
  const refuse = (msg) => { const e = new Error(`gocomet: ${msg}`); e.code = 'COST_TYPE_UNMATCHED'; throw e; };
  const base = Number(spec.cost);
  const types = Array.isArray(spec.types) ? spec.types : null;
  if (!Number.isFinite(base) || base <= 0 || !types || !types.length) {
    refuse(`enquiry ${enquiryKey} carries a per-truck-type cost that is not usable (${JSON.stringify(spec)}). Refusing rather than falling back to one blended rate the desk did not type`);
  }
  if (types.length !== pricedLines.length) {
    refuse(`enquiry ${enquiryKey} was priced for ${types.length} truck type(s) but the quote carries ${pricedLines.length} freight line(s). The load changed shape between the ask and the bid - refusing rather than guessing which rate belongs to which truck`);
  }
  const byToken = new Map();
  for (const ln of pricedLines) {
    const tok = chargeMatchToken(String(ln.key).replace(/^freight_charges_custom_charge_?/, ''));
    if (!tok || byToken.has(tok)) {
      refuse(`enquiry ${enquiryKey} has freight lines this build cannot tell apart (${ln.key}) - a per-truck-type rate cannot be routed to them`);
    }
    byToken.set(tok, ln);
  }
  const out = new Map();
  for (const t of types) {
    const ln = byToken.get(t.match);
    if (!ln) {
      refuse(`enquiry ${enquiryKey}: the rate for "${t.label}" matches no freight line on the quote (looked for ${t.match}, quote has ${[...byToken.keys()].join(', ')})`);
    }
    if (ln.units !== t.count) {
      refuse(`enquiry ${enquiryKey}: "${t.label}" was priced for ${t.count} truck(s) but its freight line now carries ${ln.units}. Refusing rather than bidding a rate reasoned for a different quantity`);
    }
    byToken.delete(t.match);
    const cost = Number(t.cost);
    if (!Number.isFinite(cost) || cost <= 0) refuse(`enquiry ${enquiryKey}: "${t.label}" carries no usable cost (${JSON.stringify(t.cost)})`);
    // THE FLOOR THAT ACTUALLY BITES PER LINE. Two independent lower bounds, and the max of them:
    //   - the type's OWN cost, straight off what the desk typed. Absolute, unscaled, and the one
    //     that catches a cost vector that has drifted from the blended number the rung was built
    //     from - the failure the single shared floor structurally could not see.
    //   - the operating floor carried through the same ratio as the price, so the desk's margin
    //     minimum holds per truck type rather than only on the average.
    const scaled = Number.isFinite(floor) ? Math.round(floor * cost / base) : null;
    out.set(ln.key, {
      price: Math.round(amount * cost / base),
      cost,
      floor: scaled == null ? cost : Math.max(cost, scaled),
      label: t.label,
    });
  }
  return out;
}

class GoCometAdapter extends PlatformAdapter {
  /**
   * @param {object} deps
   *   token              bare JWT (config.gocomet.token / GC_TOKEN). Absent -> login() fails closed.
   *   userId             GoComet vendor user id (config.gocomet.userId / GC_USER_ID); falls back to the token claim.
   *   baseUrl            https://enquiry.gocomet.com by default.
   *   bidEnabled         the SECOND write gate (GC_BID=1). Default false -> placeBid refuses.
   *   minGetIntervalMs   minimum spacing between reads OF ONE ENQUIRY on the polling path. Default 5000.
   *   globalMinGetIntervalMs  the hard ceiling: minimum spacing between ANY two GETs. Default
   *                      min(1000, minGetIntervalMs), so lowering the per-load knob lowers this too.
   *   routineGetIntervalMs    minimum spacing between ROUTINE GETs (list paging + detail
   *                      enrichment) as a class. Default minGetIntervalMs - discovery keeps
   *                      exactly its current cadence and can never crowd out a poll.
   *   rateLimitBackoffMs cooldown after a 429/503 before the next GET is attempted. Default 60000.
   *   maxRateLimitBackoffMs   ceiling on a server-supplied Retry-After. Default 120000.
   *   slotWaitTimeoutMs  how long a GET may wait for a read slot before it gives up and reports
   *                      the budget as saturated. Default 30000, floored at the widest legitimate
   *                      wait the configured budget can impose.
   *   notifier           optional Notifier - fail-closed auth alerts go here (best-effort).
   *   log                optional logger (createLogger instance). Defaults to the 'gocomet' logger.
   *   fetchImpl/sleep/now injectable transport + clock for deterministic tests.
   *   assumedRttMs       RTT reported before a real call has measured one.
   */
  constructor({
    token = null, userId = null, baseUrl = 'https://enquiry.gocomet.com', bidEnabled = false,
    platformKey = 'gocomet',
    minGetIntervalMs = 5000, rateLimitBackoffMs = 60_000, notifier = null, log = null,
    fetchImpl = null, sleep = null, now = null, assumedRttMs = 1100,
    detailTtlMs = 6 * 3600_000, maxDetailFetchesPerList = 5, detailFailBackoffMs = 120_000,
    snipeBudgetMs = 4500, writeTimeoutMs = 8000, writeGetSpacingCapMs = 1000,
    globalMinGetIntervalMs = null, routineGetIntervalMs = null, maxRateLimitBackoffMs = 120_000,
    rateLimitBackoffSteps = 3, rateLimitRecoveryReads = 20, plantIncrementOverrides = null,
    slotWaitTimeoutMs = null,
    readAgingMs = null,
  } = {}) {
    super();
    this.token = token ? String(token).replace(/^Bearer\s+/i, '').trim() : null;
    this.configuredUserId = userId || null;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    // write master switch (GC_BID). placeBid ALSO requires writeEnabled; both gate every write.
    this.bidEnabled = !!bidEnabled;
    this.platformKey = platformKey;
    // defensive write backstop - the same knob the engine kill-switch lowers on the SP adapter.
    // Default open (real mode always bids WHERE wired); GoComet is not wired to the engine here,
    // so the bidEnabled gate above is what actually keeps writes off in this phase.
    this.writeEnabled = true;
    this.account = null;
    this.serverTimeOffsetMs = 0;
    this.serverClock = new ServerClockEstimator();

    // EVERY DEFAULT BELOW LIVES HERE AND NOWHERE ELSE. config.js passes null for an unset env var
    // rather than repeating a number, so there is one home per default and the two cannot drift.
    this.minGetIntervalMs = rateKnob(minGetIntervalMs, 5000);
    this.rateLimitBackoffMs = rateKnob(rateLimitBackoffMs, 60_000);
    // THE CEILING. Never exceed one GET per this interval, whatever is armed. See the GET-budget
    // docblock for where the number comes from and why it is not a measured rate limit. The DERIVED
    // default is floored too, so lowering the per-enquiry knob cannot silently drag the ceiling
    // down into the rate we already know draws 429s.
    this.globalMinGetIntervalMs = rateKnob(
      globalMinGetIntervalMs,
      Math.max(MIN_CREDIBLE_CEILING_MS, Math.min(1000, this.minGetIntervalMs)),
      { min: MIN_CREDIBLE_CEILING_MS },
    );
    this.routineGetIntervalMs = rateKnob(routineGetIntervalMs, this.minGetIntervalMs);
    // INVERTED KNOB: a SMALLER clamp means we stop obeying Retry-After sooner, which is the
    // aggressive direction. Below the base cooldown the clamp could never bind anyway, so that is
    // where the floor sits.
    this.maxRateLimitBackoffMs = rateKnob(maxRateLimitBackoffMs, 120_000, { min: this.rateLimitBackoffMs });
    // FLOORED AT 1, DELIBERATELY DEPARTING from this repo's "a literal 0 is a deliberate disable"
    // convention. Do not "restore" it. That convention is right for a feature toggle where being
    // off is a legitimate operating mode; 0 here means "stop backing off when the server says
    // stop", against a rate limit nobody has measured, on a vendor account shared with BRL's own
    // autopilot process. The asymmetry is the whole argument: nobody wants to disable this, so the
    // cost of forbidding it is zero, and the cost of allowing it is the account - which is BRL's
    // only way onto the portal. The cap is a liveness guard rather than a safety one - 2^N ms of
    // spacing stops being a backoff and becomes a hang.
    this.rateLimitBackoffSteps = rateKnob(rateLimitBackoffSteps, 3, { min: 1, max: 10, integer: true });
    // INVERTED KNOB: fewer clean reads per recovery step means the ceiling relaxes sooner. 0 would
    // recover on every read, i.e. no backoff at all, so the floor is 1.
    this.rateLimitRecoveryReads = rateKnob(rateLimitRecoveryReads, 20, { min: 1, integer: true });
    // A BOUND ON THE WAIT FOR A SLOT, which is a different guarantee from the request timeout: that
    // timeout is armed only AFTER the slot is granted, so a GET that never gets one has no resolve,
    // no reject, no timeout and no log. Selection below WAS strict class priority with no aging,
    // which starved the ROUTINE class - discovery's listing and enrichment - for as long as a
    // saturated ceiling lasted, and an unbounded wait turned that into an adapter that kept
    // polling known loads while silently never surfacing a new one, with every surface reading
    // healthy. Fairness is now handled by _outranks (aging plus a reserved cadence), so this bound
    // is the backstop rather than the whole answer: it makes the limit audible when a read still
    // cannot be served. Floored at one
    // routine interval plus the fully-backed-off ceiling, so the widest wait the configured budget
    // can legitimately impose can never trip it.
    const slotWaitFloorMs = this.routineGetIntervalMs + this._maxGlobalSpacingMs();
    this.slotWaitTimeoutMs = rateKnob(slotWaitTimeoutMs, Math.max(30_000, slotWaitFloorMs * 2), { min: slotWaitFloorMs });
    // HOW LONG A READ MAY BE OUTRANKED BEFORE IT STARTS OUTRANKING IN TURN. Strict class priority
    // does not merely make the lowest class wait longer under sustained saturation - it makes it
    // never win, and the lowest class is discovery's own listing read. Aging bounds that without
    // touching the ordinary uncontended case, where nothing waits long enough to age at all. Half
    // the slot bound, so a read is promoted well before it would otherwise give up and surfacing
    // goes quiet.
    this.readAgingMs = rateKnob(readAgingMs, Math.max(1000, Math.floor(this.slotWaitTimeoutMs / 2)), { min: 1000 });
    this._cooldownUntil = 0;    // GETs are refused until here after a 429/503 (rate-limit backoff)
    this._cooldownSince = null; // when the current cooldown episode opened; identifies it on RATE_LIMITED
    this._globalNextAt = 0;     // earliest time the next GET of ANY class may be issued
    this._lastGetAtByKey = new Map(); // enquiry key -> the slot time of its last GET
    this._lastRoutineGetAt = 0; // slot time of the last ROUTINE-class GET
    this._getWaiters = [];      // pending slot requests, served by class then arrival order
    this._getSeq = 0;
    this._pumping = false;
    this._wakePump = null;      // ends a pump sleep early when a waiter arrives that is ready sooner
    this._pumpSleepUntil = Infinity;
    // Adaptive throttle state: 429s raise the ceiling's spacing, clean reads walk it back down.
    this._backoffSteps = 0;
    this._cleanReads = 0;
    // C101: livenessExpectedMs (capabilities()) declared this but nothing ever consumed it - "past
    // this window with no observation, the adapter is SILENT, not idle" had no clock to compare
    // against. Stamped at the end of every successful (or rate-limited-partial) listAuctions();
    // heartbeat.js's GoComet section compares against it.
    this.lastListSucceededAt = null;
    // enquiry-detail cache: key -> { at, detail }. See _fetchEnquiryDetail for why this is
    // per-NEW-load rather than per-poll, and why the hot path deliberately never reads it live.
    this._detailCache = new Map();
    // Failed fetches live in their OWN map. Keeping a negative marker out of the success cache
    // is the whole lesson of the poisoning bug this backoff was added alongside.
    this._detailFailUntil = new Map();
    // last observed LIVE close per enquiry: key -> { at, closeAt }. What getAuctionState publishes
    // once the countdown stops; see _closesAtFor for why a frozen close beats both null and "now".
    this._lastCloseAt = new Map();
    // The close-model translator, one instance per enquiry key, plus the plant string each was
    // seeded from. GoComet publishes no increment, no cap and no trigger window, so the whole close
    // model has to be reconstructed from the countdown - see _closeModelFor.
    this._closeModels = new Map();
    // key -> { at, origin }. STAMPED, like _lastCloseAt above, purely so _pruneDetailCaches has an
    // age to sweep on: nothing else bounds a map written once per enquiry key ever listed.
    this._originByKey = new Map();
    // key -> the time the terminal verdict was logged. A Map rather than a Set for the same reason.
    this._terminalLogged = new Map();
    // T2b (ruling 61): key -> { quote, preparedAt, closeAtArm }. closeAtArm is the believed close
    // (_lastCloseAt) at prepare time - the "arm" a stale-but-cooldown-usable entry must still match.
    this._preparedQuotes = new Map();
    this._preparingQuotes = new Map(); // key -> in-flight prepare promise, for single-flight await
    this._shotRefresh = new Map();     // key -> { closeAt, timer } of a pending pre-buzzer quote refresh
    this._refreshWaiters = new Map();  // key -> a refresh read still queued for a slot
    this.plantIncrementOverrides = Array.isArray(plantIncrementOverrides) ? plantIncrementOverrides : null;
    this.detailTtlMs = Number.isFinite(detailTtlMs) ? detailTtlMs : 6 * 3600_000;
    this.detailFailBackoffMs = Number.isFinite(detailFailBackoffMs) ? detailFailBackoffMs : 120_000;
    this.maxDetailFetchesPerList = Number.isFinite(maxDetailFetchesPerList) ? maxDetailFetchesPerList : 5;
    this.lastWriteRttMs = null; // measured bid-write round-trip (the SUBMIT leg only)
    // Reported until a real bid has measured one. The old default was 200ms, inherited from the
    // SuperProcure adapter, and it is not a GoComet number: measured submits ran 645ms min,
    // 1,070ms median, 2,482ms max, and the slow one was 2,436ms of ENVOY UPSTREAM time - i.e.
    // inside GoComet's own Rails, where no amount of local latency compensation reaches it.
    // 1,100ms is the measured median rather than the tail: it is the honest expectation for a
    // typical write, and the tail is handled by the budget below instead of by inflating this.
    this.assumedRttMs = Number.isFinite(assumedRttMs) ? assumedRttMs : 1100;
    // How long a bid can take end to end, worst case observed: quote GET (~0.4s), the confirming
    // re-read placeBid does before it submits (another ~0.4s, and it cannot jump the global GET
    // ceiling, so ~1s of spacing between the two), then submit (~2.5s) - all serial inside
    // placeBid, so ~4.3s. The findings board's "budget 2.5s" quoted only the submit leg and dropped
    // the GET; 3,000 counted one GET and predates the re-read. Declared through capabilities() so
    // the engine can reserve real runway instead of inferring one from an RTT number.
    this.snipeBudgetMs = Number.isFinite(snipeBudgetMs) ? snipeBudgetMs : 4500;
    // Submit timeout. 5,000ms against an observed 2,482ms max is under 2x headroom on a sample
    // of five, on a path with no retry by design (a silent retry can double-bid), where a
    // timeout means the auction is simply lost. The gateway is named gocomet-app-public-timeout,
    // so a hard server-side cap exists at an unknown value.
    this.writeTimeoutMs = Number.isFinite(writeTimeoutMs) ? writeTimeoutMs : 8000;
    // Cap on the inter-GET spacing wait that placeBid's own quote fetch will sit out.
    this.writeGetSpacingCapMs = Number.isFinite(writeGetSpacingCapMs) ? writeGetSpacingCapMs : 1000;

    this.notifier = notifier;
    this.log = log || createLogger('gocomet');
    this.fetchImpl = fetchImpl || portalFetch; // injectable for tests
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now || (() => Date.now());
  }

  static jwtClaims(token) { return jwtClaims(token); }
  static jwtExp(token) { const c = jwtClaims(token); const e = c && Number(c.exp) * 1000; return Number.isFinite(e) ? e : null; }
  static jwtUserId(token) { const c = jwtClaims(token); return (c && c.user_id) || null; }

  /**
   * capabilities - honest, static facts the engine's fail-closed logic keys off. Extra fields
   * beyond the seam's five are documentation of GoComet-specific realities the multi-cargo
   * mapping and any future strategy work must respect.
   */
  capabilities() {
    return {
      // --- the seam's declared five ---
      standingPriceVisible: false, // rank-only: Waaree hides L1 (l1_quote_total_cost_display null)
      durableSubmissionTracking: true,
      // FALLBACK ONLY - the real value is per-ENQUIRY (slab_rate) and rides the mapped load and
      // getAuctionState. capabilities() is bound once at engine construction, so it structurally
      // cannot carry a per-enquiry number; this is what the engine uses when an enquiry was
      // never enriched from its detail record.
      //
      // It was 0, which is FAIL-OPEN rather than merely unknown: zero is falsy, so it switched
      // the engine's decrement guard off outright. The observed slab_rates are 300 and 1000, so
      // 1000 is the largest seen and the conservative side of the fallback - a step at least
      // that big is legal on every enquiry observed to date. Overshooting only walks the ladder
      // down faster (the floor still clamps, and GoComet's revisionLimit of 3 keeps it on the
      // coarse ladder where rungs are far wider than this anyway); undershooting risks a
      // rejection, and rejections cost one of only three revisions per enquiry, forever.
      minDecrement: 1000,
      allowsTieRate: false,        // UNKNOWN -> conservative false (do not assume ties are legal)
      revisionLimit: 3,            // bidding-data revisions_left defaults to 3 (total_revisions + revisions_left)
      // THE WRITE GATE, DECLARED so callers can act on it instead of discovering it one throw at a
      // time. placeBid refuses on !bidEnabled before any network call, and GC_BID defaults off - so
      // with it off, arming a GoComet load produces a monitor that walks its ladder and throws on
      // every rung while the desk is told the load is being bid. armFromRequest reads this and refuses
      // the arm instead. Reflects the env gate only; the kill-switch backstop is `writeEnabled`.
      biddingEnabled: this.bidEnabled,
      closeModel: 'soft',          // reactive-countdown: the deadline slides on an extension. 'soft' is the
                                   // fail-closed-safe honest value (assume it CAN extend), so hard-close-only
                                   // upstream scope logic excludes GoComet by default until it is opted in.
      // --- honest GoComet-specific extras (documentation for upstream + the write path) ---
      reactiveClose: true,         // never precompute a cutoff: poll bidding-data, treat closed only when the
                                   // clock/bidding_closed says so. auction_type is UNRELIABLE - never gate on it.
      multiCargo: true,            // one enquiry CAN carry several freight_charges_custom_charge* lines
      // ...and we can now price one, with ONE per-unit rate written to every truck-type line.
      // Still distinct from multiCargo on purpose: that is a fact about the platform, this is a
      // fact about us. It was false until 2026-08-19 on the belief that a uniform write bids N x
      // the intended total; the wire is per-unit and the server sums the lines, so it does not
      // (see placeBid). What remains unbuilt is a DISTINCT rate per truck type, which needs a desk
      // capture surface asking for more than one cost - a separate capability, not this one.
      multiCargoBidSupported: true,
      // A PARTIAL VEHICLE COUNT CANNOT BE EXPRESSED HERE. GoComet has no per-bid count field: the
      // count IS the quote's own `units`, and the server multiplies the written price by it, so a
      // bid is unavoidably for all of them. placeBid refuses a partial (PARTIAL_VEHICLE_COUNT)
      // rather than bidding for every truck while the desk believed it had asked for fewer - which
      // makes the price page's editable count control a number the write path will never use, the
      // same shape multiCargoBidSupported exists to keep off the page.
      partialVehicleCountSupported: false,
      // WHAT TO CALL THIS PORTAL ON A PAGE A HUMAN READS. The desk works two portals from one
      // worklist, and invariant 5 of MULTI_PLATFORM_ARCHITECTURE.md makes an unlabelled row on a
      // shared operator surface the one wrong answer. The label has to come from here because the
      // product surface may not hold a portal name of its own (invariant 1).
      platformLabel: 'GoComet',
      // "NO CAP EXISTS", and the KEY'S PRESENCE is what says so - an ABSENT key means the cap is
      // simply unknown. Two different facts, and collapsing them is what makes a capped soft close
      // and an uncapped one read identically to the desk. SuperProcure's cap is a per-BRANCH number
      // that rides the load, so its adapter declares nothing here and the page keeps saying only
      // what it can prove. Same null-vs-omitted doctrine _closesAtFor applies on the state seam.
      //
      // Roughly two in three GoComet auctions extend at least once, one observed load extended 22
      // times and closed nearly two hours past its posted time, and nothing in the platform or the
      // captures bounds it. Mirrors the extensionCeiling on getAuctionState, which the price desk
      // cannot reach: that page renders from a stored snapshot, never a live tick.
      extensionCeiling: null,
      // The extension INCREMENT, the platform-wide seed. It is a static platform fact, which is
      // what belongs in capabilities() - and capabilities() is bound once at engine construction,
      // so it can never carry what a live enquiry has since LEARNED. Anything that needs the
      // current value calls extensionIncrementMs(key), or reads state.extendMs, which is the same
      // accessor. Declared here so a caller that only has capabilities() has one number to reach
      // for rather than a constant of its own.
      extensionIncrementMs: this.extensionIncrementMs(),
      transitField: false,         // GoComet's bid has no transit-time field (SuperProcure's does)
      priceWriteType: 'number',    // live read-back shows price as a float; we WRITE a number (clone wrote a
                                   // string) - flagged as a verification-bid checklist item, not yet proven on the wire
      tokenLifetime: 'monthly',    // ~30-day JWT - proactive expiry alerting is Phase-1, not later
      // SNIPE RUNWAY, in milliseconds, and it is not derived from RTT.
      //
      // placeBid is a quote GET, a confirming re-read of the same quote, then a submit PUT, run
      // serially. Measured: each GET ~0.4s with the global ~1s ceiling between them, the submit
      // 645ms / 1,070ms / 2,482ms (min / median / max, n=5). So ~4.3s worst case, and 4,500ms is
      // that rounded up. The findings board's "budget 2.5s" quoted the submit leg alone and
      // dropped the GET.
      //
      // Latency compensation CANNOT substitute for this. The slow submit carried
      // x-envoy-upstream-service-time: 2436 against a 2,482ms wall - 98% of it inside GoComet's
      // own backend, with steady ~30-45ms of network. Compensating for half an RTT models a
      // symmetric network delay that is not what is happening: the bid is late because the
      // server is slow to process it, so the only defence is to start earlier.
      //
      // Honest limit on this number: n=5 submits, and nothing establishes whether the 2.48s tail
      // is recurrent or a one-off. It is the observed max, not a distributional p99.
      //
      // IT NOW HAS A CONSUMER, on the READ side: _decisiveHorizonMs uses it to decide when an
      // enquiry's reads become decisive and take priority in the GET budget. The declared-and-
      // unread state invariant 8 names is closed for reads and NOT for writes - the engine still
      // does not reserve write runway from this, which is layer-2 strategy and deliberately
      // deferred. Do not read the presence of a consumer as the whole gap being closed.
      snipeBudgetMs: this.snipeBudgetMs,
      // LIVENESS: past this window with no observation, the adapter is SILENT, not idle. Nothing
      // consumes it yet - a later liveness alert will, and it exists so a monitor that has stopped
      // observing is distinguishable from one whose auction is simply quiet.
      //
      // DERIVED from this adapter's own two throttles rather than picked, because they are what
      // bound a LEGITIMATE gap: a 429 opens a cooldown during which GETs are refused outright, and
      // the next read then waits out its per-enquiry spacing. Anything longer is not our own
      // budgeting. The cooldown term is the WORST legitimate one, not the default: a server-supplied
      // Retry-After can extend it up to maxRateLimitBackoffMs, and deriving this from the 60s
      // default alone made the declaration a lie on exactly the reads that go quietest. Honest
      // limit: back-to-back 429s chain cooldowns and would cross this - deliberately, since
      // sustained throttling means the auction is going unobserved, the condition the alert is for.
      livenessExpectedMs: Math.max(this.rateLimitBackoffMs, this.maxRateLimitBackoffMs) + this.minGetIntervalMs,
    };
  }

  // ---- session (offline: the configured token IS the session) --------------------------------

  /**
   * Adopt + VALIDATE the configured bare JWT. Offline by design - no network, no OTP/Puppeteer
   * (that re-auth path is separately scoped). Fails CLOSED with an operator alert when the token
   * is absent or already expired, so a lapsed GoComet token surfaces loudly instead of silently
   * losing auctions (the exact silent-death failure mode of the existing GoComet bot).
   */
  async login() {
    if (!this.token) {
      const e = new Error('gocomet: no token configured (set GC_TOKEN)'); e.code = 'AUTH';
      this._alertAuth('GoComet token is not configured - set GC_TOKEN to enable the adapter.');
      this.log.error('gocomet login failed: no token configured', { err: e });
      throw e;
    }
    const claims = jwtClaims(this.token);
    const tokenExp = GoCometAdapter.jwtExp(this.token);
    if (!claims || !tokenExp) {
      const e = new Error('gocomet: token is malformed or has no exp claim'); e.code = 'AUTH';
      this._alertAuth('GoComet token is malformed (no readable expiry) - get a fresh GoComet token (update GC_TOKEN) and restart Bid Command.');
      this.log.error('gocomet login failed: token malformed / no exp', { err: e });
      throw e;
    }
    if (this.now() >= tokenExp) {
      const e = new Error('gocomet: token already expired'); e.code = 'AUTH';
      this._alertAuth(`GoComet token EXPIRED (${new Date(tokenExp).toISOString().slice(0, 10)}) - get a fresh GoComet token (update GC_TOKEN) and restart Bid Command.`);
      this.log.error('gocomet login failed: token expired', { err: e, tokenExp: new Date(tokenExp).toISOString() });
      throw e;
    }
    this.account = {
      userId: this.configuredUserId || (claims.user_id || null),
      clientId: claims.client_id || null,
      tokenType: claims.token_type || null,
      tokenExp,
    };
    // Identifiers only - never the token itself. tokenExp lets an operator spot a session nearing
    // expiry in `pm2 logs` before ensureSession() has to reject it outright.
    this.log.info('gocomet login succeeded (token adopted)', {
      userId: this.account.userId, tokenExpiresAt: new Date(tokenExp).toISOString(),
    });
    return this.account;
  }

  /** Re-check the adopted token near expiry. Idempotent; throws AUTH within 60s of expiry. */
  async ensureSession() {
    if (!this.account) return this.login();
    const exp = this.account.tokenExp;
    if (exp && this.now() > exp - 60_000) {
      const e = new Error('gocomet: token expiring'); e.code = 'AUTH';
      this._alertAuth(`GoComet token expiring (${new Date(exp).toISOString().slice(0, 10)}) - get a fresh GoComet token (update GC_TOKEN) and restart Bid Command.`);
      throw e;
    }
    return this.account;
  }

  _alertAuth(detail) { this._alertOps(detail, 'gocomet_auth_failed'); }

  _alertOps(detail, dedupeKey) {
    if (!this.notifier || typeof this.notifier.alert !== 'function') return;
    try {
      // platformKey is what routes this to the console instead of the customer's WhatsApp group -
      // Notifier.notifyModeFor resolves an untagged payload to SuperProcure, which is the money-safe
      // default for a price ask and exactly wrong for a GoComet failure. C078: this is a credential/
      // health alarm, not a per-load message, so it must not be silenced by gocometNotifyMode
      // (which exists to cut load-message noise) - notifyModeOverride forces it through regardless.
      this.notifier.alert('error', { context: 'gocomet', platformKey: this.platformKey, notifyModeOverride: 'whatsapp', detail }, { dedupeKey })
        .catch(() => {});
    } catch (_) { /* alerting must never break a bid/read path */ }
  }

  // ---- request layer (bare-JWT headers + GET spacing + 429 cooldown) --------------------------

  _headers() {
    return {
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      authorization: this.token || '', // BARE JWT - no `Bearer` prefix (that 401s on GoComet)
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'ops-client-schema': 'app',
      origin: 'https://app.gocomet.com',
      referer: 'https://app.gocomet.com/',
      schema: 'app',
      'user-agent': BROWSER_UA,
    };
  }

  /**
   * The GET budget, in one place. Three gates, and they answer three different questions.
   *
   * PER ENQUIRY (minGetIntervalMs, 5s) - how often we re-read ONE auction. This used to be the
   * only gate and it was GLOBAL, which made it the wrong shape twice over. Reads for distinct
   * enquiries starved each other, so N armed loads plus discovery paging gave each load an
   * effective interval of roughly 5s x (N + overhead) - four armed loads meant a 20s gap between
   * reads of an auction that extends. And the engine's 200ms hot poll inside a 2,500ms decisive
   * window could not land at all: one global 5s gate makes a tick in that window a coin flip.
   *
   * GLOBAL (globalMinGetIntervalMs, 1s) - the ceiling this adapter will never exceed however many
   * loads are armed. Without it, per-load fairness just multiplies the request rate into the
   * limiter we already know exists. WE DO NOT KNOW THE REAL RATE LIMIT and this number does not
   * pretend to: it is bracketed by the only two measurements there are. BRL's own legacy GoComet
   * bot polled at ~200ms (5/s) and logged 2,629 HTTP 429s - that is the known-bad side, and it is
   * where the conservative 5s default came from. A 2026-08-04 live probe made 123 calls at a
   * minimum 0.32s gap with zero 429/503 - clean, but it never sustained a hot cadence, so it
   * bounds nothing. 1/s sits below the clean probe and 5x under the known-bad rate. It is also
   * exactly the spacing the write path has already been taking since writeGetSpacingCapMs, on the
   * same evidence, so this generalises an accepted floor rather than inventing a new one.
   *
   * ROUTINE CLASS (routineGetIntervalMs, 5s) - list paging and detail enrichment as a group.
   * Discovery keeps precisely its current cadence and therefore cannot consume the ceiling; what
   * changes is that it no longer blocks a poll while it does so.
   *
   * PRIORITY. The slot goes to the highest class that can use it, so a load inside its decisive
   * window beats a routine page. In the hot direction the residual is one slot deep: a routine GET
   * already released and awaiting the network cannot be recalled, so a hot read can still be
   * delayed by up to one global interval.
   *
   * IN THE OTHER DIRECTION IT IS NOT A DELAY, IT IS A CAPACITY LIMIT, and it is stated here rather
   * than discovered from an outage. Class priority alone had no aging, so while POLL demand could
   * fill every slot the ceiling issues, a ready ROUTINE waiter lost at every cursor and discovery
   * made no progress at all - that is the 2026-09-08 shape, and _outranks now bounds it with aging
   * plus a reserved cadence for the listing class. The capacity limit itself is unchanged. Armed
   * loads alone can reach that point - _perKeyIntervalMs(HOT) EQUALS globalMinGetIntervalMs, so one
   * load in its endgame consumes the whole ceiling by itself. Making the budget fair means serving
   * two competing demands out of one hard-capped rate shared with BRL's own autopilot, and it is
   * deliberately not attempted here. What IS guaranteed is that the limit reports itself:
   * slotWaitTimeoutMs bounds the wait, a starved read is logged and alerted, and listAuctions
   * refuses to return a starved page as an empty board.
   *
   * ADAPTIVE. The ceiling's spacing doubles per 429/503 up to rateLimitBackoffSteps and walks back
   * one step per rateLimitRecoveryReads clean GETs, so a throttle discovers a tighter limit than
   * the default instead of latching at it. The hard cooldown is unchanged and remains global - a
   * 429 is a statement about the account, not about one load.
   *
   * ---------------------------------------------------------------------------------------------
   * HOW TO ACTUALLY MEASURE THE LIMIT, if you are here to tune these numbers.
   *
   * Everything above is bracketing, not measurement, and the adaptive backoff exists to cover that
   * ignorance. One experiment would settle it, and it has a precondition that is easy to miss.
   *
   * PRECONDITION, and it invalidates the run if ignored: BRL's own `autopilot` PM2 process polls
   * GoComet on the SAME vendor identity from the same box. A rate limit keyed to the account or the
   * source IP counts its traffic and ours together, so a ramp run while it is polling measures the
   * two of us jointly and will read as a tighter limit than we actually have. The window has to be
   * one where autopilot is confirmed stopped (or the run happens off that box on a different
   * egress IP), and which of those two it was must be recorded - they answer different questions.
   *
   * PROTOCOL. Read-only, `bidding-data` on a single live enquiry, no writes. Hold each cadence for
   * ~5 minutes: 2s, 1.5s, 1s, 0.75s, 0.5s. Record for EVERY response the status, the full
   * `Retry-After`, and any `x-ratelimit-*` / `x-envoy-*` header, plus wall time. Stop at the first
   * 429 and do not resume inside that hour.
   *
   * WHAT IT DISCRIMINATES, and this is the part the current design cannot tell apart: a TOKEN
   * BUCKET fails only after a sustained burst drains it and then recovers gradually, while a FIXED
   * WINDOW fails abruptly at a request count and resets cleanly on a wall-clock boundary. The
   * backoff here is shaped for the first and is merely not-wrong for the second. The 2026-08-04
   * probe (123 calls, min 0.32s gap, zero 429s) cannot distinguish them because it never sustained
   * a cadence long enough to drain anything.
   *
   * UNTIL THAT RUNS, treat every interval in this file as a bracket and not a measurement, and do
   * not tighten the ceiling on the strength of a quiet week.
   * ---------------------------------------------------------------------------------------------
   */
  _perKeyIntervalMs(priority) {
    return priority >= READ_PRIORITY.HOT ? this.globalMinGetIntervalMs : this.minGetIntervalMs;
  }

  _globalSpacingMs() {
    return this.globalMinGetIntervalMs * Math.pow(2, this._backoffSteps);
  }

  /** The ceiling's spacing at FULL backoff - the widest gap the budget can legitimately impose. */
  _maxGlobalSpacingMs() {
    return this.globalMinGetIntervalMs * Math.pow(2, this.rateLimitBackoffSteps);
  }

  /**
   * Does waiter `a` beat `b` for the next slot? Four rules, in order:
   *
   *   1. WRITE is never displaced - a live bid's quote read keeps absolute precedence.
   *   2. A ROUTINE listing that is DUE (no slot for readAgingMs) beats any other non-WRITE waiter.
   *      This is the starvation guarantee, and it is what makes surfacing latency independent of
   *      how many loads are being polled.
   *   3. An AGED waiter outranks class, so nothing below the top class waits forever.
   *   4. Otherwise the original strict class priority, then arrival order - including when both
   *      waiters have aged, so a decisive HOT read still beats an older POLL near a close.
   *
   * Under normal load nothing ages and nothing is due, so bid reads keep exactly the precedence
   * they had. Fairness is bought purely by REORDERING the queue - never by issuing more requests,
   * which on a shared vendor identity against an unmeasured limit would be the one unacceptable fix.
   */
  _outranks(a, b, cursor) {
    // A LIVE BID IS NEVER DISPLACED BY AGING. WRITE already carries its own escape hatch
    // (maxSpacingWaitMs -> deadlineAt) precisely so a snipe cannot sit out a polling interval
    // before it fetches the quote it is about to submit. That hatch only makes a WRITE waiter
    // ELIGIBLE early - _slotReadyAt decides eligibility, not order - so without this branch an
    // aged listing read would win the slot ahead of it and reintroduce the stall the hatch exists
    // to prevent, on the one path where the delay costs an auction.
    if (a.priority === READ_PRIORITY.WRITE || b.priority === READ_PRIORITY.WRITE) {
      if (a.priority !== b.priority) return a.priority > b.priority;
      return a.seq < b.seq;
    }
    // RESERVED CADENCE for the listing class, and this is what makes surfacing latency bounded
    // rather than load-dependent. Plain aging is not enough on its own: once the queue is busy
    // enough that every waiter ages before any is served (N * globalSpacing >= readAgingMs, ~16
    // concurrent pollers at the shipped defaults) "aged" stops discriminating, and whatever the
    // tiebreak below happens to be decides - which starved the listing again at exactly the load
    // where surfacing matters most (measured: READ_STARVED at N=16/20/30). Once the class has gone
    // readAgingMs without a slot it is DUE, and a due listing beats any non-WRITE contender no
    // matter how deep the queue is. That guarantee is what carries the fix, so the tiebreak below
    // is free to keep class priority intact (verified starvation-free to N=200).
    const aAged = (cursor - a.queuedAt) >= this.readAgingMs;
    const bAged = (cursor - b.queuedAt) >= this.readAgingMs;
    // Being due requires the waiter itself to have AGED, not merely for the class to be overdue.
    // Without that clause a never-served class reads as due from the very first cursor, and a
    // freshly-queued listing would take the slot ahead of a decisive read on a cold adapter -
    // inverting the priority contract instead of just bounding it.
    const aDue = aAged && a.priority === READ_PRIORITY.ROUTINE && this._routineIsDue(cursor);
    const bDue = bAged && b.priority === READ_PRIORITY.ROUTINE && this._routineIsDue(cursor);
    if (aDue !== bDue) return aDue;
    if (aAged !== bAged) return aAged;
    // BOTH AGED -> class priority still decides. An earlier revision made this FIFO instead, which
    // silently dropped the HOT-over-POLL guarantee once both had aged: during a batch close, an
    // older POLL could take the slot ahead of the decisive read that determines whether to bid.
    // FIFO was never what bounded starvation - the reserved cadence above is - so class priority
    // stays, and the bid-critical ordering with it.
    if (a.priority !== b.priority) return a.priority > b.priority;
    if (a.priority === READ_PRIORITY.HOT) {
      // Several endgames at once (2026-09-25, Waaree 260925RP1C). A load past its own close ranks
      // below every load still before its close; among those, the load read longest ago goes first, so
      // the endgames alternate rather than the nearer one taking every slot; then the nearer close.
      const ua = this._hotUrgencyMs(a.key);
      const ub = this._hotUrgencyMs(b.key);
      if ((ua === Infinity) !== (ub === Infinity)) return ub === Infinity;
      if (!a.refresh !== !b.refresh) return !a.refresh;
      const la = a.key != null ? (this._lastGetAtByKey.get(a.key) ?? -Infinity) : -Infinity;
      const lb = b.key != null ? (this._lastGetAtByKey.get(b.key) ?? -Infinity) : -Infinity;
      if (la !== lb) return la < lb;
      if (ua !== ub) return ua < ub;
    }
    return a.seq < b.seq;
  }

  /**
   * Local time at which a POLL read of this load turns HOT, or null if it will not on this close: its
   * load's last read was more than two POLL intervals before `asOf` (the read is not being kept up), or
   * the close has passed beyond the post-close window. Without the second, a closed load released a
   * read every second for the ~300 s the engine keeps a soft close open.
   */
  _hotFromMs(key, asOf = this.now()) {
    const last = this._lastCloseAt.get(key);
    if (!last) return null;
    if (asOf - last.at > this.minGetIntervalMs * 2) return null;
    if (this.serverNow() - last.closeAt >= this._postCloseHotMs(key)) return null;
    return last.closeAt - this._decisiveHorizonMs() - this.serverTimeOffsetMs;
  }

  _postCloseHotMs(key) { return Math.min(POST_CLOSE_HOT_MS, this.extensionIncrementMs(key)); }

  /** Time to this load's believed close; a close already passed ranks after every one still ahead. */
  _hotUrgencyMs(key) {
    const last = key != null ? this._lastCloseAt.get(key) : null;
    const toClose = last ? last.closeAt - this.serverNow() : Infinity;
    return toClose > 0 ? toClose : Infinity;
  }

  /** Has the ROUTINE class gone longer than readAgingMs without a slot? Never served counts as due. */
  _routineIsDue(cursor) {
    if (!this._lastRoutineGetAt) return true;
    return (cursor - this._lastRoutineGetAt) >= this.readAgingMs;
  }

  /** Earliest time this waiter may be released, given the ledger and a virtual clock. */
  _slotReadyAt(w, cursor) {
    const lastKey = w.key != null ? this._lastGetAtByKey.get(w.key) : undefined;
    let keyReady = lastKey != null ? lastKey + this._perKeyIntervalMs(w.priority) : -Infinity;
    // A POLL read turns HOT when its load crosses into the horizon, so it is ready from then on the
    // HOT spacing; without this the pump sleeps out the POLL spacing across the crossing.
    if (w.priority === READ_PRIORITY.POLL && w.key != null) {
      const hotAt = this._hotFromMs(w.key, w.queuedAt);
      if (hotAt != null) keyReady = Math.min(keyReady, Math.max(hotAt, lastKey != null ? lastKey + this.globalMinGetIntervalMs : -Infinity));
    }
    const classReady = w.priority === READ_PRIORITY.ROUTINE && this._lastRoutineGetAt
      ? this._lastRoutineGetAt + this.routineGetIntervalMs : -Infinity;
    let at = Math.max(cursor, keyReady, classReady);
    // A deadline (placeBid's maxSpacingWaitMs) may skip the per-enquiry gate, never the ceiling.
    // A bid must not sit out a polling interval before it can even fetch the quote it is about to
    // submit: that is a snipe stalled past its own close by our own throttle, and it is silent.
    // The trade is deliberate - a capped wait slightly raises the chance of a 429 on one GET,
    // which aborts the bid loudly as RATE_LIMITED, against a guaranteed stall that loses the
    // auction outright.
    if (w.deadlineAt != null) at = Math.min(at, w.deadlineAt);
    return Math.max(at, this._globalNextAt);
  }

  _acquireGetSlot({ key = null, priority = READ_PRIORITY.ROUTINE, maxSpacingWaitMs = null, refresh = false } = {}) {
    return new Promise((resolve) => {
      const w = { key, priority, seq: this._getSeq += 1, resolve, deadlineAt: null, queuedAt: this.now(), settled: false, timer: null,
        refresh };
      if (refresh && key != null) this._refreshWaiters.set(key, w);
      if (Number.isFinite(maxSpacingWaitMs)) w.deadlineAt = this.now() + Math.max(0, maxSpacingWaitMs);
      // REAL-TIME BACKSTOP for the one case the cursor sweep cannot reach: a waiter parked behind a
      // pump that is no longer running. The sweep remains the primary bound and still fires first
      // in normal operation (and is the only one that moves on the virtual clock the timing tests
      // inject, which is why it is not replaced here). This timer exists so that NO path through
      // this class can hand a caller a promise with no resolve, no reject and no timeout - the
      // promise shape that stopped discovery on both platforms for 18 hours on 2026-09-08. Set at
      // twice the bound so it can never pre-empt the sweep and change who reports a starved read.
      const t = setTimeout(() => {
        const i = this._getWaiters.indexOf(w);
        if (i >= 0) this._getWaiters.splice(i, 1);
        if (w.settled) return;
        const waitedMs = Math.max(0, this.now() - w.queuedAt);
        this._noteSlotStarved(w, waitedMs);
        this._settleWaiter(w, { timedOut: true, waitedMs });
      }, Math.max(1, this.slotWaitTimeoutMs * 2));
      if (t.unref) t.unref();
      w.timer = t;
      this._getWaiters.push(w);
      if (this._wakePump && this._slotReadyAt(w, this.now()) < this._pumpSleepUntil) this._wakePump();
      this._pumpGetQueue();
    });
  }

  /** Resolve a waiter exactly once and disarm its backstop. Returns false if it already settled. */
  _settleWaiter(w, value) {
    if (w.settled) return false;
    w.settled = true;
    if (w.refresh && this._refreshWaiters.get(w.key) === w) this._refreshWaiters.delete(w.key);
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    w.resolve(value);
    return true;
  }

  /**
   * Drop every waiter that has sat past slotWaitTimeoutMs and REPORT each one, resolving it with a
   * timed-out marker rather than leaving it parked. Driven off the pump's cursor instead of a
   * timer, because the cursor is the only clock that moves under an injected sleep - a real
   * setTimeout would never fire on the virtual clock the timing tests run on, which is precisely
   * where this has to be provable. An expired waiter consumes NO slot: it never reached the
   * transport, so the ceiling is untouched by it.
   *
   * `all` is the pump's exit path. Waiters left behind by a throw are the one case no future cursor
   * reaches, since the loop that would advance it has already gone.
   */
  _expireStarvedWaiters(cursor, all = false) {
    let expired = 0;
    for (let i = this._getWaiters.length - 1; i >= 0; i -= 1) {
      const w = this._getWaiters[i];
      const waitedMs = Math.max(0, cursor - w.queuedAt);
      if (!all && waitedMs < this.slotWaitTimeoutMs) continue;
      this._getWaiters.splice(i, 1);
      if (w.settled) continue;
      expired += 1;
      this._noteSlotStarved(w, waitedMs);
      this._settleWaiter(w, { timedOut: true, waitedMs });
    }
    return expired;
  }

  /**
   * A starved read is the failure this whole bound exists to make visible, so it goes out on BOTH
   * surfaces: the operator log for the detail, and the alert path for the fact. A ROUTINE one means
   * discovery is not surfacing new auctions while everything else still reads healthy - the shape
   * that let this run unnoticed.
   */
  _noteSlotStarved(w, waitedMs) {
    const readClass = READ_PRIORITY_NAME[w.priority] || String(w.priority);
    this.log.warn('gocomet GET gave up waiting for a read slot - the account read budget is saturated', {
      enquiry: w.key, readClass, waitedMs, timeoutMs: this.slotWaitTimeoutMs,
      queueDepth: this._getWaiters.length, spacingMs: this._globalSpacingMs(),
    });
    this._alertOps(
      `GoComet reads are saturated - a ${readClass} request waited ${Math.round(waitedMs / 1000)}s for a slot and was dropped.`
      + (w.priority === READ_PRIORITY.ROUTINE ? ' New auctions are NOT being surfaced while this lasts.' : ''),
      'gocomet_read_starved',
    );
  }

  /**
   * Release waiters one at a time, honouring every gate. `cursor` is a VIRTUAL clock advanced from
   * the slot times themselves rather than re-read after each sleep: the injected test clock does
   * not move when the injected sleep is a stub, and a loop that waited for now() to catch up would
   * spin forever against one. The choice of who goes is deliberately made AFTER the sleep, so a
   * hot read that arrives while we are waiting can still take the slot. Selection is _outranks:
   * class priority, but an aged waiter outranks class and a ROUTINE listing that is due outranks
   * every non-WRITE contender, so the lowest class can no longer be starved indefinitely under
   * sustained saturation. The expiry sweep at each cursor still bounds and reports what is left.
   */
  async _pumpGetQueue() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      let cursor = this.now();
      while (this._getWaiters.length) {
        cursor = Math.max(cursor, this.now());
        if (this._expireStarvedWaiters(cursor)) continue;
        this._reclassWaiters();
        let goAt = Infinity;
        for (const w of this._getWaiters) goAt = Math.min(goAt, this._slotReadyAt(w, cursor));
        if (goAt > cursor) {
          // A waiter arriving during this sleep may be ready sooner (a quote read for a bid, a load
          // entering its horizon), so its arrival ends the sleep and the slot is chosen again.
          let woken = false;
          const wake = new Promise((r) => { this._wakePump = () => { woken = true; r(); }; });
          this._pumpSleepUntil = goAt;
          await Promise.race([this.sleep(goAt - cursor), wake]);
          this._wakePump = null;
          this._pumpSleepUntil = Infinity;
          if (woken) { cursor = Math.max(cursor, this.now()); continue; }
        }
        cursor = Math.max(cursor, goAt, this.now());
        this._reclassWaiters();

        if (this._expireStarvedWaiters(cursor)) continue;

        let fallback = null; let earliest = Infinity;
        for (const w of this._getWaiters) {
          const at = this._slotReadyAt(w, cursor);
          if (at < earliest) { earliest = at; fallback = w; }
        }
        cursor = Math.max(cursor, earliest);
        let best = null;
        for (const w of this._getWaiters) {
          if (this._slotReadyAt(w, cursor) > cursor) continue;
          if (!best || this._outranks(w, best, cursor)) best = w;
        }
        if (!best) best = fallback;

        this._getWaiters.splice(this._getWaiters.indexOf(best), 1);
        this._globalNextAt = cursor + this._globalSpacingMs();
        if (best.key != null) this._lastGetAtByKey.set(best.key, cursor);
        if (best.priority === READ_PRIORITY.ROUTINE) this._lastRoutineGetAt = cursor;
        this._settleWaiter(best);
      }
    } finally {
      this._pumping = false;
      this._wakePump = null;
      this._pumpSleepUntil = Infinity;
      // Only a throw can leave the queue non-empty here, and a waiter parked behind a pump that is
      // no longer running is the unbounded wait by another route.
      if (this._getWaiters.length) this._expireStarvedWaiters(this.now(), true);
    }
  }

  /**
   * A state or detail read is classed by its load's close when it is chosen, not only when it queued:
   * a read queued as POLL at 12 s to close must compete as HOT once its load is inside its horizon.
   */
  _reclassWaiters() {
    for (const w of this._getWaiters) {
      if (w.key == null || w.refresh || (w.priority !== READ_PRIORITY.POLL && w.priority !== READ_PRIORITY.HOT)) continue;
      // Freshness is judged when the read was asked for: a read waiting behind a sibling ages in the
      // queue, and demoting it for that is how a load was starved across its close.
      w.priority = this._readPriorityFor(w.key, w.queuedAt);
    }
  }

  /** The synthesised 429 a GET gets instead of reaching the wire while a cooldown is open. */
  _cooldownResult() {
    return { status: 429, json: null, text: null, rateLimited: true, cooldown: true, retryAfterMs: this._cooldownUntil - this.now() };
  }

  /** A 429/503 tightens the ceiling one step; sustained clean reads give a step back. */
  _noteThrottled() {
    this._backoffSteps = Math.min(this.rateLimitBackoffSteps, this._backoffSteps + 1);
    this._cleanReads = 0;
  }

  _noteCleanRead() {
    if (!this._backoffSteps) return;
    this._cleanReads += 1;
    if (this._cleanReads >= this.rateLimitRecoveryReads) { this._backoffSteps -= 1; this._cleanReads = 0; }
  }

  /**
   * How close to its close an enquiry has to be for its reads to become decisive.
   *
   * THIS IS THE CONSUMER `snipeBudgetMs` DID NOT HAVE. It was declared through capabilities() and
   * read by nobody, which MULTI_PLATFORM_ARCHITECTURE.md invariant 8 names as a silent degradation
   * in the published-with-no-consumer direction. It states how long a bid needs to land - the
   * quote GET, the confirming re-read and the submit, measured at ~4.3s worst case - so a read that
   * is meant to inform a bid has to complete at least that long before close, plus two global slots:
   * the engine takes its buzzer read a read interval and a countdown second above the runway, and a
   * read requested there must not wait out the 5 s per-enquiry POLL spacing.
   * Past that point the read is decisive: it is the last one that can still change what we send.
   */
  _decisiveHorizonMs() {
    return this.snipeBudgetMs + 2 * this.globalMinGetIntervalMs;
  }

  /**
   * Classify a state read from what the adapter already knows about this enquiry's close. The
   * engine passes no hint and must not have to - it is platform-agnostic by design, and priority
   * here is a fact about GoComet's budget, not about strategy.
   *
   * A first read is never hot: there is no observed close to be near. A frozen close (the auction
   * stopped counting down) stays hot only briefly - one extend increment past the deadline, which
   * is exactly the ambiguous instant while GoComet writes a new one - and only while the enquiry
   * is still being actively polled, so a dead load cannot sit at the head of the queue forever.
   */
  _readPriorityFor(key, asOf = this.now()) {
    const last = this._lastCloseAt.get(key);
    if (!last) return READ_PRIORITY.POLL;
    if (asOf - last.at > this.minGetIntervalMs * 2) return READ_PRIORITY.POLL;
    const toClose = last.closeAt - this.serverNow();
    return (toClose <= this._decisiveHorizonMs() && toClose > -this._postCloseHotMs(key))
      ? READ_PRIORITY.HOT : READ_PRIORITY.POLL;
  }

  /**
   * One HTTP request. GETs go through the budget above; there is NO silent auto-retry - a hot-path
   * read that comes back throttled is handled by the caller (getAuctionState reports ok:false so
   * the engine skips a tick), and the WRITE never retries (idempotency - a silent retry can
   * double-bid). Every fetch is bounded by a timeout+abort so a hung socket cannot freeze a caller,
   * and the wait for a GET slot is bounded separately by slotWaitTimeoutMs - that timeout is armed
   * only after the slot is granted, so it never covered the wait in front of it.
   */
  async _request(method, path, {
    body = null, timeoutMs = 8000, maxSpacingWaitMs = null,
    key = null, priority = READ_PRIORITY.ROUTINE, refresh = false,
  } = {}) {
    const isGet = method === 'GET';
    if (isGet) {
      // Respect an active rate-limit cooldown: do not even issue the GET. Tested AGAIN after the
      // slot wait, because the wait is exactly where someone else's 429 lands: _cooldownUntil is
      // global state any concurrent read can set, so a single test in front of the queue says
      // nothing about the state on the other side of it. Without the second test, every GET already
      // parked when a burst is throttled is released straight into the cooldown that burst just
      // opened - one per ceiling slot, backoff inverted for precisely the set a burst produces,
      // against a vendor identity shared with BRL's own autopilot and a limit nobody has measured.
      if (this.now() < this._cooldownUntil) return this._cooldownResult();
      const slot = await this._acquireGetSlot({ key, priority, maxSpacingWaitMs, refresh });
      // Gave up waiting rather than got a slot. Reported as a transport failure (status 0) so every
      // existing caller already treats it as "no read happened" instead of as an empty answer, with
      // slotStarved carrying the real reason for the one caller that must say so out loud.
      if (slot && slot.timedOut) {
        return { status: 0, json: null, text: null, rateLimited: false, slotStarved: true, waitedMs: slot.waitedMs };
      }
      if (this.now() < this._cooldownUntil) return this._cooldownResult();
    }

    const init = { method, headers: this._headers() };
    if (body != null) init.body = JSON.stringify(body);
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ac) init.signal = ac.signal;
    let timer = null;
    const timeout = new Promise((_res, rej) => {
      timer = setTimeout(() => { if (ac) { try { ac.abort(); } catch (_e) {} } rej(new Error('request_timeout')); }, timeoutMs);
      if (timer && timer.unref) timer.unref();
    });

    let status = 0, json = null, text = null, retryAfterMs = null;
    // Measured from AFTER the spacing gate, so it is the real network+server span and not our
    // own throttle. getAuctionState reports this to the engine as measuredRttMs; including the
    // sleep would hand the engine a 4-5s "round trip" that is 95% us waiting on ourselves.
    const netT0 = this.now();
    try {
      const r = await Promise.race([this.fetchImpl(this.baseUrl + path, init), timeout]);
      status = r.status;
      if (status === 429 || status === 503) {
        const ra = r.headers && r.headers.get ? r.headers.get('retry-after') : null;
        retryAfterMs = parseRetryAfterMs(ra, this.now());
        // OBEY Retry-After, BUT BOUND IT. Ignoring what the server asked for is how an account
        // gets banned, so the clamp is generous (2 min) rather than tight - it exists only so one
        // absurd header value, or an HTTP-date years out, cannot strand every armed load for the
        // rest of the process. The value reported to the caller stays UNCLAMPED: that is what the
        // server actually said, and a parser that quietly rewrites it is worse than a long wait.
        const honoured = retryAfterMs == null ? 0 : Math.min(retryAfterMs, this.maxRateLimitBackoffMs);
        // A throttle landing inside an open cooldown extends that episode rather than starting one.
        // The start stamp is the episode's identity on every RATE_LIMITED it causes (see
        // _fetchQuoteForWrite): a clock value rather than a counter, because a counter restarts at 1
        // with the process while the notifier's sent-marks persist, and would swallow the first
        // cooldown after every restart as a repeat of one already told.
        const nowMs = this.now();
        if (nowMs >= this._cooldownUntil) this._cooldownSince = nowMs;
        this._cooldownUntil = nowMs + Math.max(this.rateLimitBackoffMs, honoured);
        if (isGet) this._noteThrottled();
      } else if (isGet && status > 0) this._noteCleanRead();
      // Read the body once as text, then try JSON - GoComet answers some rejections in plaintext,
      // so text-first preserves the real "why" for the reject path (the SP adapter learned this
      // the hard way). Test stubs that implement only .json() still work via the fallback.
      if (typeof r.text === 'function') {
        text = await r.text().catch(() => null);
        if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
      } else if (typeof r.json === 'function') {
        json = await r.json().catch(() => null);
      }
    } catch (_) { status = 0; } // network error / timeout
    finally { if (timer) clearTimeout(timer); }

    return { status, json, text, rateLimited: status === 429 || status === 503, retryAfterMs, networkMs: this.now() - netT0 };
  }

  // ---- read: list auctions --------------------------------------------------------------------

  /**
   * The engine's PER-UNIT minimum decrement for one enquiry, derived from `slab_rate`.
   *
   * `slab_rate` is per-ENQUIRY, not a platform constant: 300 and 1000 were observed on the same
   * day, and a third enquiry read 1000 again. So the old `minDecrement: 0` was not merely
   * unknown-and-conservative, it was FAIL-OPEN - zero is falsy, which switches the engine's
   * decrement guard off entirely and lets it fire rungs a step apart that GoComet would reject.
   *
   * THE DIVISION QUESTION, AND WHY THIS DOES NOT DIVIDE.
   * The findings board derives the per-unit minimum as `slab_rate / units`, on the ground that
   * the rule is enforced in TOTAL space. That reading comes from GoComet's own frontend bundle -
   *   slabRateExceeded = "draft" !== status && total < original_total && original_total - total < slab_rate
   * - where both operands are `total_charges.total.*`, i.e. totals. It is good evidence and it is
   * probably right. But the only EMPIRICAL confirmation (a 1,000 decrement accepted against a
   * slab_rate of 1000) happened on a load with units = 1, where total space and per-unit space are
   * numerically identical and therefore cannot be told apart. The one load that would have
   * discriminated never saw a small enough step. Server-side enforcement was never observed at
   * all - zero 4xx in 278 calls - so we do not even know the rule is enforced outside the UI.
   *
   * Given that, the asymmetry decides it. Bidding a step that is too SMALL risks a rejection, and
   * a rejection here is not a retryable annoyance: the revision budget is THREE per enquiry
   * forever, it does not reset when the auction extends, and on the captured load it hit zero
   * eleven seconds before close. Burning one of three on a step the server refuses is close to
   * the worst outcome available. Bidding a step that is too LARGE only walks the ladder down
   * faster, and the cost floor still clamps the bottom - and GoComet's revisionLimit of 3 keeps
   * it on the coarse three-anchor ladder anyway, where the rungs are already tens of thousands
   * apart and a 300-1000 rupee minimum is not the binding constraint on anything.
   *
   * So: use `slab_rate` itself as the PER-UNIT minimum. A per-unit step of slab_rate produces a
   * total step of slab_rate x units, which is >= slab_rate for any units >= 1 - meaning this one
   * value satisfies BOTH candidate rules simultaneously and cannot be rejected under either.
   * Dividing would satisfy only the total-space rule, and only if that reading is correct.
   * Revisit when a multi-unit load is observed taking a sub-slab_rate per-unit step.
   */
  _minDecrementFor(detail) {
    const slab = detail && detail.slab_rate != null ? Number(detail.slab_rate) : NaN;
    return Number.isFinite(slab) && slab > 0 ? slab : null;
  }

  /**
   * The close-model translator for one enquiry. One instance per key, created on first use and
   * seeded from the plant this enquiry was listed under.
   *
   * IT IS NOT A SECOND STATE MACHINE BESIDE THE ENGINE'S. It never sees a monitor and decides
   * nothing about money; its whole output leaves through `extendMs` below, which the engine already
   * reads. Round counting for STRATEGY stays with bidEngine._observeExtension - the rounds counted
   * in here exist only to decide what may be learned about the increment.
   */
  _closeModelFor(enquiryKey) {
    const key = String(enquiryKey);
    let model = this._closeModels.get(key);
    if (!model) {
      model = new GoCometCloseModel({ incrementMs: this._plantSeedMsFor(key) });
      this._closeModels.set(key, model);
    }
    return model;
  }

  /** The plant seed for one key, from the origin the listing recorded. No model, no allocation. */
  _plantSeedMsFor(enquiryKey) {
    const overrides = Array.isArray(this.plantIncrementOverrides) ? this.plantIncrementOverrides : null;
    const seen = this._originByKey ? this._originByKey.get(String(enquiryKey)) : null;
    return resolvePlantIncrementMs(seen ? seen.origin : null, overrides);
  }

  /**
   * THE extension increment for one enquiry, in milliseconds. One accessor, one source of truth -
   * nothing else in this process may hold its own copy of this number.
   *
   * GoComet exposes no increment, no cap and no trigger window, so this is RECONSTRUCTED rather
   * than read: a per-plant seed, then the translator's ratcheted value once live jumps have
   * confirmed a LONGER step (GoCometCloseModel.publishedExtendMs, which can only grow). That is
   * why a module-level constant cannot serve as the answer, and why the constant that used to be
   * one is gone.
   *
   * SAFE TO CALL AT CONSTRUCTION TIME. capabilities() is bound once when the engine is built and
   * reaches this before any enquiry has been listed, armed or observed, so: it answers the seed
   * when nothing has been learned rather than null, it allocates NO per-enquiry state (an accessor
   * that created a close model would grow a map its caller never asked to populate, out from under
   * _pruneDetailCaches's list-cycle sweep), and it cannot throw on a half-constructed adapter. The
   * last one is the load-bearing property: a throw out of capabilities() is caught by the stack
   * registration and takes GoComet silently 100% dark, on an alert path that does not name the
   * platform.
   *
   * @param {string|number|null} [enquiryKey] - omit for the platform-wide seed.
   * @returns {number} milliseconds. Never null, never NaN.
   */
  extensionIncrementMs(enquiryKey) {
    if (enquiryKey == null) return resolvePlantIncrementMs(null, null);
    const model = this._closeModels ? this._closeModels.get(String(enquiryKey)) : null;
    return model ? model.publishedExtendMs() : this._plantSeedMsFor(enquiryKey);
  }

  /**
   * The absolute close for one enquiry: the live derivation while a countdown is still running,
   * and the LAST LIVE ONE, frozen, once it stops. Mirrors extensionIncrementMs / _minDecrementFor
   * - one per-enquiry value with a fallback.
   *
   * WHY FROZEN, AND NOT "NOW". GoComet sends bid_closing_in: null once bidding is over, so there
   * is no countdown left to add. Deriving the close from the clock instead would make it SLIDE
   * FORWARD on every poll of a dead auction, and _observeExtension (bidEngine.js:1768) counts a
   * forward jump of half an extendMs as an extension - a zeroed load left polling would manufacture
   * a phantom round roughly every 150s. A frozen close gives jump 0 and holds the engine's belief
   * put, which is what "we learned nothing this tick" should look like, and it keeps the
   * sustained-zero extension inference (bidEngine.js:1801) reachable rather than sending
   * _observeExtension out at its :1764 null guard before that inference can run.
   *
   * WHY NOT null. The engine's read is `Number.isFinite(Number(live.closesAtMs))`
   * (bidEngine.js:1047) and Number(null) is a FINITE 0, so a published null does not read as
   * unknown - it resolves to epoch 1970 and reports every retired load as ~56 years late.
   *
   * undefined - the caller OMITS the key - when this enquiry was never read live: a first read that
   * is already closed, or a restart that lost the memory. There is nothing to freeze and nothing
   * true to say, so this publishes exactly what origin/main did before the field existed at all,
   * which is what makes the consumer's Number(undefined) NaN and sends it down its null branch.
   */
  _closesAtFor(key, liveCloseAtMs) {
    if (liveCloseAtMs != null) {
      this._lastCloseAt.set(key, { at: this.now(), closeAt: liveCloseAtMs });
      return liveCloseAtMs;
    }
    const last = this._lastCloseAt.get(key);
    return last ? last.closeAt : undefined;
  }

  /** Bound-check a parsed timestamp against a sane window around now; null if bad/placeholder. */
  _boundedParseMs(raw) {
    if (!raw) return null;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return null;
    const n = this.now();
    if (t < n - MAX_PLAUSIBLE_PAST_MS || t > n + MAX_PLAUSIBLE_DEADLINE_MS) return null;
    return t;
  }

  /**
   * Fetch and PROJECT one enquiry's detail record. Returns the allowlisted projection, or null
   * on any failure - this never throws, because an enrichment miss must degrade the mapped load,
   * not kill the whole discovery cycle.
   *
   * WHY THIS CALL EXISTS AT ALL. The 2026-08-04 live probe settled it: the spot LIST does NOT
   * carry `cargo_quantity`, `cargo_unit` or `slab_rate` - all three are detail-only. So the
   * multiplier the money maths needs, and the minimum decrement the ladder needs, are simply not
   * obtainable from the list, and the previous `units: null` was not a conservative choice so
   * much as the only one available.
   *
   * WHY IT IS NOT ON THE HOT PATH. The detail record is a strict superset of bidding-data and it
   * is tempting to poll it instead - one call for rank, revisions, countdown, clock, multiplier
   * and decrement. Measured, that trade is bad: 25,337 bytes against 193, roughly 131x, on the
   * one path where the snipe window is decided. The right shape is the split this implements -
   * detail ONCE when a load first appears, cached; bidding-data every tick.
   *
   * The cost is therefore per-NEW-load, not per-poll, and bounded twice over: a TTL, and a cap on
   * how many misses one listAuctions cycle will chase (each GET pays the inter-read spacing, so
   * an unbounded loop over a large first page would stall discovery for minutes).
   */
  /**
   * Record a failed detail fetch in a SEPARATE map, deliberately not as a null entry in
   * _detailCache - a negative marker sitting in the success cache is exactly the confusion that
   * produced the poisoning bug above.
   *
   * Its purpose is anti-starvation, not caching. Each cycle only chases maxDetailFetchesPerList
   * misses, and a permanently-broken enquiry is a miss forever, so a handful of them at the head
   * of the list consume the entire budget on every cycle and no healthy load behind them ever
   * gets enriched. The backoff is deliberately much shorter than the success TTL: a failure is
   * usually transient and should be retried soon, just not on the very next cycle.
   */
  _noteDetailFailure(key, status) {
    this._detailFailUntil.set(key, this.now() + this.detailFailBackoffMs);
    return status;
  }

  /**
   * The ONE TTL-respecting read of the detail cache. It exists because the hot path reached into
   * the Map directly and so had no expiry at all, which quietly undid the TTL for the one caller
   * that polls: a slab_rate read once could drive the decrement guard for the life of the process.
   */
  _cachedDetail(key) {
    const c = this._detailCache.get(key);
    return c && (this.now() - c.at) < this.detailTtlMs ? c.detail : null;
  }

  /**
   * Drop expired entries from every per-enquiry map. Nothing else bounds them: one entry is added
   * per enquiry key ever seen, GoComet keys are never reused, and discovery runs for the life of
   * the process, so they grow monotonically. Swept once per list cycle - the cold path, never the
   * poll. A frozen close ages from its last LIVE observation, so an enquiry still being polled live
   * keeps refreshing its entry and only a long-dead one is ever swept - and losing that entry
   * degrades to the never-seen-live case (key omitted), never to a stale close presented as fact.
   */
  _pruneDetailCaches() {
    const now = this.now();
    for (const [k, v] of this._detailCache) if (now - v.at >= this.detailTtlMs) this._detailCache.delete(k);
    for (const [k, until] of this._detailFailUntil) if (now >= until) this._detailFailUntil.delete(k);
    for (const [k, v] of this._lastCloseAt) if (now - v.at >= this.detailTtlMs) this._lastCloseAt.delete(k);
    // The per-enquiry read ledger grows the same way and needs the same sweep. Dropping an entry
    // only forgets a gate the key has not needed for hours; the global ceiling still holds.
    for (const [k, at] of this._lastGetAtByKey) if (now - at >= this.detailTtlMs) this._lastGetAtByKey.delete(k);
    // The close model, the plant it was seeded from and the terminal-log latch are per-enquiry the
    // same way. A close model ages from its LAST OBSERVATION rather than its creation, which matters
    // more here than for the caches above: a swept model loses its published-extendMs high-water
    // mark and reseeds at the plant value, so only an enquiry nobody has polled for a whole TTL may
    // be dropped. A model with no observation at all was created and fed in one synchronous step, so
    // a missing timestamp means the observation never landed and there is no belief to preserve.
    for (const [k, m] of this._closeModels) {
      const at = m ? Number(m.lastObservedAt) : NaN;
      if (!Number.isFinite(at) || now - at >= this.detailTtlMs) this._closeModels.delete(k);
    }
    for (const [k, v] of this._originByKey) if (now - v.at >= this.detailTtlMs) this._originByKey.delete(k);
    // Dropping the latch only lets an enquiry still being polled a whole TTL after it died log its
    // terminal verdict once more. That is an info line, not a decision.
    for (const [k, at] of this._terminalLogged) if (now - at >= this.detailTtlMs) this._terminalLogged.delete(k);
  }

  /**
   * ON-DEMAND per-load rules for ONE enquiry, for the price page.
   *
   * slab_rate - this platform's minimum gap between our own successive bids - is DETAIL-only, and
   * the listing loop's detail enrichment is budgeted (maxDetailFetchesPerList) and skipped under a
   * per-key failure backoff. A load that misses its slot maps with no decrement, and nothing later
   * recovers it: the poll re-derives from the same cached detail, so the load stays unknown for its
   * whole life and the plan silently runs on the platform fallback.
   *
   * Price-page render is a human-latency moment, so one read is affordable there in a way it is not
   * inside the budgeted listing loop. Bounded by the same cache and the same failure backoff every
   * other detail read obeys, so a load whose detail is already known costs nothing and a broken one
   * cannot be re-chased in a loop.
   *
   * Returns null rather than throwing when the read does not land - the caller says so on the page
   * rather than presenting the fallback as fact.
   */
  async refreshLoadRules(auctionId) {
    if (auctionId == null) return null;
    const detail = await this._fetchEnquiryDetail(String(auctionId));
    if (!detail) return null;
    const minDecrement = this._minDecrementFor(detail);
    return minDecrement != null ? { minDecrement } : null;
  }

  /**
   * The round tracker's check of a countdown held at zero: one fresh detail read, past the
   * cache, since the close it is asked about is the one the cache would still hold. null when the read
   * does not land. `status` is 'open' only on an explicit open flag or a live countdown.
   */
  async closeProbe(auctionId) {
    const key = String(auctionId);
    const d = await this._fetchEnquiryDetail(key, { fresh: true, priority: this._readPriorityFor(key) });
    if (!d) return null;
    const secs = d.bid_closing_in;
    const open = d.bidding_closed === false || (typeof secs === 'number' && secs > 0);
    const closed = d.bidding_closed === true || secs === null;
    return { closesAtMs: this._boundedParseMs(d.bid_close_timestamp), status: open ? 'open' : (closed ? 'closed' : null),
      vendorRank: d.vendor_rank != null ? d.vendor_rank : null };
  }

  /**
   * The same answer as refreshLoadRules when it costs NOTHING - a TTL-valid cached detail, no wire
   * read, no read slot. It exists so a caller can ration only the reads that actually spend budget:
   * rationing the free path instead makes a load whose minimum is already known report it as unknown.
   */
  cachedLoadRules(auctionId) {
    if (auctionId == null) return null;
    const detail = this._cachedDetail(String(auctionId));
    if (!detail) return null;
    const minDecrement = this._minDecrementFor(detail);
    return minDecrement != null ? { minDecrement } : null;
  }

  /**
   * The result GoComet has settled for one enquiry, off the enquiry record. bidding-data carries only
   * the live rank, and on 6 of 22 booked wins (1-9 Sep 2026) a live rank 1 was not the enquiry's
   * final vendor_rank. Read once at finalize, always fresh (the enrichment cache can hold a rank hours
   * old), through the same allowlist projection as every detail read. Read-only and never throws.
   *
   * -> { settled: true, rank } when bidding is closed on a whole rank, and a rank 1 is not marked Lost;
   *    { settled: false } otherwise; null when the read did not land.
   */
  async readSettledOutcome(auctionId) {
    const key = String(auctionId);
    let res;
    try {
      await this.ensureSession();
      res = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}`, { key, priority: READ_PRIORITY.POLL });
    } catch (_) { return null; }
    if (res.status === 401 || res.status === 403) {
      this._alertAuth('GoComet returned 401/403 on the enquiry detail - the token has likely lapsed.');
      return null;
    }
    if (res.status !== 200 || !res.json) return null;
    const d = projectEnquiryDetail(res.json.data || res.json);
    if (!d) return null;
    const rank = Number(d.vendor_rank);
    const settled = d.bidding_closed === true && Number.isInteger(rank) && rank >= 1
      && !(rank === 1 && /lost/i.test(String(d.status || '')));
    return settled ? { settled: true, rank } : { settled: false };
  }

  async _fetchEnquiryDetail(key, { fresh = false, priority = READ_PRIORITY.ROUTINE } = {}) {
    const cached = fresh ? null : this._cachedDetail(key);
    if (cached) return cached;
    let res;
    try {
      res = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}`, { priority });
    } catch (_) { return null; }
    if (res.status === 401 || res.status === 403) {
      this._alertAuth('GoComet returned 401/403 on the enquiry detail - the token has likely lapsed.');
      return null;
    }
    // GATE ON THE STATUS, NOT MERELY ON "IS THERE A BODY".
    //
    // This used to test `!res.json`, which lets any 4xx/5xx that answers in JSON through - and
    // GoComet's do. A `{"error":"boom"}` 500 then reached projectEnquiryDetail, which returns an
    // empty object for any payload with no allowlisted key, and `{}` is truthy, so a failed
    // fetch was CACHED AS A SUCCESS for the full 6-hour TTL. Three things followed, none of them
    // visible: the load never re-enriched even after the server recovered, it ran its whole
    // auction on units:null and the coarse fallback decrement instead of its real slab_rate, and
    // the caller counted it as enriched so the `unenriched` figure in the discovery log read
    // zero. The identical failure with a PLAINTEXT body behaved correctly, which is the tell -
    // the outcome depended on the error's content type, not on the error.
    if (res.status !== 200 || !res.json) {
      this._noteDetailFailure(key, res.status);
      this.log.warn('gocomet enquiry detail unavailable - the load maps without a multiplier', {
        enquiry: key, httpStatus: res.status, rateLimited: !!res.rateLimited,
      });
      return null;
    }
    const raw = (res.json && (res.json.data || res.json)) || null;
    // PROJECT IMMEDIATELY. The raw object is dropped on this line and never stored, logged or
    // returned - it carries a third party's password_digest (see ENQUIRY_DETAIL_FIELDS).
    const detail = projectEnquiryDetail(raw);
    // A 200 that yielded none of the fields this call exists for is not a usable detail record.
    // Caching it would be the same silent poisoning as above, just with a friendlier status.
    if (!detail || (detail.cargo_quantity == null && detail.slab_rate == null)) {
      this._noteDetailFailure(key, res.status);
      this.log.warn('gocomet enquiry detail carried none of the fields it is fetched for', {
        enquiry: key, httpStatus: res.status, keptFields: detail ? Object.keys(detail) : [],
      });
      return null;
    }
    this._detailCache.set(key, { at: this.now(), detail });
    return detail;
  }

  /**
   * Map one GoComet spot enquiry to the seam's auction shape (or null if its close time is bad).
   * `detail` is the ALLOWLISTED enquiry-detail projection when one could be fetched, else null -
   * every field it supplies degrades to the pre-enrichment behaviour when it is absent.
   */
  _mapEnquiry(e, detail = null) {
    const closesAt = this._boundedParseMs(e.bid_close_timestamp);
    // Fail-closed on an unusable close time: a placeholder/absurd/past timestamp is flagged and
    // EXCLUDED (returned null -> filtered out below), never armed with a fake runway.
    if (closesAt == null) {
      this.log.warn('gocomet enquiry excluded: implausible/absent close time', {
        key: e.key, bid_close_timestamp: e.bid_close_timestamp, bid_close_time: e.bid_close_time,
      });
      return null;
    }
    // THE VEHICLE IS THE TRUCK TYPE, NOT THE MODE. `e.mode` is "FTL" on every FTL enquiry, and
    // leading with it here is what put a shipment mode in the price page's Vehicle tile and left
    // the desk pricing "FTL x1". The mode is still read - it moves to `shipmentType` below, which
    // is the slot that has always meant this - and the descriptor GoComet sends alongside it
    // ("1 x 32FTSXL (...) 7 Ton Truck") now answers the vehicle question it was always able to.
    //
    // The raw descriptor stays as the fallback, exactly as the old second branch had it, so a
    // descriptor this parser cannot reduce still reaches the page whole rather than becoming a
    // blank tile. `e.shipment_type` ("DOMESTIC") is gone from this chain: it is a trade lane, and
    // it was only ever reachable on a load with no mode and no descriptor, where it described the
    // vehicle no better than the mode did.
    const spec = readLoadSpec(e, detail);
    // SEVERAL TRUCK TYPES ON ONE LOAD, kept as structure rather than flattened to a sentence.
    // Published only when there is genuinely more than one, so a single-type load carries exactly
    // the keys it always did and every surface renders it byte-for-byte as before.
    const cargoTypes = spec.cargoTypes && spec.cargoTypes.length > 1 ? spec.cargoTypes : null;
    // "5 x 40 ft, 25 T + 1 x 20 ft ODC, 10 T" - each type WITH ITS OWN COUNT, because the whole
    // point on a multi-type load is that the counts differ. The raw-descriptor join stays as the
    // last fallback for a load whose descriptors did not parse: long, but it names every type,
    // which is the property that must not be lost.
    const equipment = spec.vehicleType
      || (cargoTypes ? cargoTypes.map((t) => `${t.count} x ${t.label}`).join(' + ') : null)
      || (Array.isArray(e.quantity) ? e.quantity.filter(Boolean).join('; ') : e.quantity)
      || null;

    // --- enrichment from the allowlisted enquiry detail (all of it optional) ---
    const rawUnits = detail && detail.cargo_quantity != null ? Number(detail.cargo_quantity) : NaN;
    const cargoBasis = detail ? normalizeCargoUnit(detail.cargo_unit) : null;
    // PUBLISH ONLY A BASIS THIS ADAPTER CAN ACTUALLY BID, which is TRUCK and nothing else.
    // SUPPORTED_QUOTE_BASES is {'TRUCK'} and readQuoteBasis throws BASIS_UNSUPPORTED on anything
    // else, so a per-tonne enquiry is refused at the wire whatever discovery says about it.
    // Publishing quoteType 'PMT' anyway is not merely redundant, it is harmful: upstream reads PMT
    // as "a legitimate per-tonne load", which DISARMS the desk's hard clerical-error floor
    // (hardCostFloorViolation returns null on a PMT basis, because an absolute rupee floor cannot
    // judge an honest Rs 800/MT rate) and relabels the price page to a per-MT cost. That floor is
    // the 2026-07-25 commitment against a missing digit - 1,500 typed for 15,000 - and trading it
    // away on a load we are going to refuse buys nothing.
    //
    // So a weight-family basis degrades to the same safe shape an unrecognised one already takes:
    // units null, no quoteType. That keeps the floor ARMED, because an unknown basis is treated as
    // truck, which is the conservative direction for a too-low cost.
    //
    // The pairing below is the other half of the same rule. `units` is published ONLY alongside the
    // basis that says what it counts, because `units` alone is read as a TRUCK COUNT on the
    // fail-closed-unknown branch (true whenever PLATFORM=real): a truck control on the price page,
    // a per-truck cost label, and an EOD value figure multiplied by a number that does not count
    // trucks. On a per-tonne enquiry that count is a tonnage, and reading a tonnage as trucks is
    // the 12-45x class this codebase has already been bitten by once.
    const quoteType = cargoBasis === 'FTL' ? 'FTL' : null;
    const unitsFromDetail = (quoteType && Number.isFinite(rawUnits) && rawUnits > 0) ? rawUnits : null;
    if (detail && !quoteType && Number.isFinite(rawUnits) && rawUnits > 0) {
      this.log.warn('gocomet enquiry has a quantity but no biddable basis - publishing neither', {
        key: e.key, cargoUnit: detail.cargo_unit, cargoQuantity: rawUnits,
        normalizedBasis: cargoBasis, biddableBases: [...SUPPORTED_QUOTE_BASES],
      });
    }
    const minDecrement = this._minDecrementFor(detail);
    // Bound-checked at the MAP boundary, exactly as realAdapter._mapLoad does for SuperProcure's
    // string-typed ceilingPrice, so both platforms hand the engine one already-validated number and
    // `plausibleCeiling` stays the single definition of "is this ceiling real".
    const ceilingPrice = plausibleCeiling(detail && detail.ceiling_rate);
    // HOW MANY FREIGHT-CHARGE LINES THE QUOTE WILL CARRY, known at DISCOVERY instead of at the
    // write. It was published so the price page could refuse a multi-line load before a cost was
    // typed; placeBid now prices those loads, so what this count feeds is the desk's own warning
    // that the one rate they enter lands on every truck type. Same field, same fail direction, a
    // different consumer - see loadWillNotBid and the price form in src/web/server.js.
    //
    // `quantity` is one descriptor per cargo type, and the charge-line KEY is that same descriptor
    // lowercased and underscored: "1 x 40FT (LxWxH - 40'x8'x8'8\") 22 Ton Truck" pairs with
    // freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8'8\")_22_ton, on both captured enquiries.
    // So the count of descriptors is the count of lines.
    //
    // HONEST LIMIT: both matched pairs are SINGLE-cargo, and no multi-cargo ENQUIRY was ever
    // captured (only a multi-cargo QUOTE, reference/brl-gocomet public/query_multiple.json, which
    // carries no enquiry object). The one-to-one is derived from the key derivation, not observed on
    // a 2-line enquiry. Both error directions are survivable and neither costs money: over-counting
    // declines a load the desk then quotes by hand, under-counting lands exactly on today's
    // bid-time refusal. Omitted entirely - never 0, never null - when no descriptor list was read,
    // so "not established" stays distinguishable from "one line".
    const cargoDescriptors = Array.isArray(detail && detail.quantity) ? detail.quantity.filter(Boolean)
      : (Array.isArray(e.quantity) ? e.quantity.filter(Boolean) : null);
    // BC-36: extra pickup/drop points beyond the primary lane, city/pincode only - see
    // mapExtraStops. Detail-only fields (the spot list carries no other_origins/other_destinations
    // at all), so both are null whenever the detail fetch was skipped, throttled or failed, exactly
    // like every other detail-enrichment field above.
    const otherOrigins = mapExtraStops(detail && detail.other_origins, detail && detail.other_origin_zip_codes);
    const otherDestinations = mapExtraStops(detail && detail.other_destinations, detail && detail.other_destination_zip_codes);
    // The listing is the only place the plant is ever seen: bidding-data carries seven keys and the
    // origin is not among them, so an enquiry armed without passing through here can only ever get
    // the default seed. That is the fail-safe-up direction, which is why nothing re-fetches for it.
    this._originByKey.set(String(e.key), { at: this.now(), origin: e.origin || null });
    return {
      id: String(e.key),
      lane: { origin: e.origin || '?', destination: e.destination || '?' },
      // DISPLAY ONLY, AND ADDITIVE ON PURPOSE. `lane` above stays the portal's raw strings because
      // its VALUE is load-bearing well beyond display: discovery matches the allowlist on
      // `origin + ' ' + destination`, the engine carries it into the durable intent that is
      // rehydrated after a restart, and notifier keys "recent quotes on this route" history off it.
      // Reparsing those strings would silently re-scope allowlists and stop historical matches
      // matching. So the cities/states land beside the raw values and the surfaces read these.
      laneParsed: parseGoCometLane(e),
      equipment,
      // The spec fields the price page has always had tiles for and this adapter never filled, so
      // GoComet loads rendered a two-tile grid where SuperProcure's renders six. Every one of them
      // is spread conditionally: an absent fact must leave the key ABSENT rather than null, because
      // the renderer omits a tile on a falsy value but the WhatsApp ask and the CSV export both
      // distinguish "not carried" from "carried as nothing".
      //
      // No Material tile is built. GoComet's enquiry carries no commodity field at all - `name` is
      // the shipper's own reference number, not a description of the goods - and inventing one from
      // the enquiry name would put a purchase-order number under a Material heading.
      ...(spec.shipmentType ? { shipmentType: spec.shipmentType } : {}),
      ...(spec.dimensions ? { dimensions: spec.dimensions } : {}),
      ...(spec.weight != null ? { weight: spec.weight, weightUnit: spec.weightUnit } : {}),
      ...(spec.distanceKm != null ? { distanceKm: spec.distanceKm } : {}),
      // THE QUANTITY MULTIPLIER, and it comes from the enquiry DETAIL, not the list.
      //
      // The live probe confirmed cargo_quantity is absent from the spot list entirely, so this
      // is null whenever the detail fetch was skipped, capped out, throttled or failed. That
      // absence is a genuine safe degradation and not a silent one: units:null is exactly the
      // pre-enrichment behaviour, and isMultiVehicle treats a non-finite count as single rather
      // than multi, so nothing downstream starts guessing a count we could not read.
      //
      // Populating it is deliberately paired with quoteType below. `units` alone is the field
      // upstream reads as a TRUCK COUNT: with units>1 and no recorded basis, isMultiVehicle
      // falls to its fail-closed-unknown branch (true whenever PLATFORM=real), the price page
      // grows an editable truck-count control, and the EOD value figure multiplies by it. On a
      // per-tonne enquiry that count is a TONNAGE, and reading a tonnage as trucks is the
      // 12-45x class this codebase has already been bitten by once. So the count is never
      // published without the basis that says what it counts.
      units: unitsFromDetail,
      // The pricing basis in the vocabulary discovery/pricing already share with SuperProcure.
      // Omitted entirely (not set to null) when the detail did not establish it, so the
      // upstream unknown-basis path keeps behaving exactly as it does today.
      ...(quoteType ? { quoteType } : {}),
      status: e.bidding_closed === true ? 'closed' : 'open',
      closesAt,
      // honest extras carried through (display / future strategy); the engine ignores unknown keys.
      name: e.name || null,
      // THE SHIPPER'S OWN REFERENCE for this enquiry, under a key that says what it is.
      //
      // Same value as `name` above, and the duplication is the point: `name` is GoComet's field
      // name and nothing downstream reads it, while this is the number BRL's desk works by and the
      // price page renders it. A future reader deleting the "unused" `name` must not silently take
      // the header's identifier with it.
      //
      // What it is NOT: this is the shipper's reference as GoComet publishes it
      // ("3262511465-5601270693 (E.com)"), not a Best Roadways order number, and no captured
      // response carries one of those. It is rendered unlabelled for that reason.
      shipperRef: e.name || null,
      // THE SHIPPER, under the ONE key every consumer above the seam reads: discovery's
      // softAdmitted (:83) and matchesAllowlist (:225), priceRequests, margin resolution, and every
      // alert-routing scope key. realAdapter._mapLoad emits the same key (:1644). An adapter that
      // emits any other name surfaces ZERO loads - the allowlist matches against undefined.
      //
      // Do NOT also emit `shipper`: the `shipper` that exists downstream is a notification-payload
      // and closedBids-record field derived FROM companyName (engineAlerts.js:206,
      // bidLogger.js:64). A second load-level name for one fact is the trap a future reader binds
      // to by mistake.
      companyName: e.client_company_name || null,
      // L1 VISIBILITY, free at discovery. This is a per-shipper config switch, it lives ONLY on
      // the list item (the 81-key detail does not carry it), and it is false for Waaree - which
      // is why GoComet reads as rank-only today. It is the shipper hiding L1, not the platform
      // masking it, so the day a principal turns it on BRL gets a real clearing-price read on
      // that customer. Carrying it costs nothing and makes that answer arrive on its own instead
      // of needing another probe. Reading a disclosed L1 PRICE stays inside the legal wall - it
      // is the platform publishing a number, not a rival's identity.
      showsL1: e.show_cost_of_l1_quote === true,
      ...(cargoDescriptors && cargoDescriptors.length ? { cargoLines: cargoDescriptors.length } : {}),
      // The truck types themselves, when there is more than one. The COUNT above tells a surface
      // that a load is multi-type; this tells the desk WHICH types and how many of each, which is
      // what they have to see before typing a rate that is applied to all of them.
      ...(cargoTypes ? { cargoTypes } : {}),
      // BC-36: extra pickup/drop points, city/pincode only. Absent (not []) on a single-point
      // load, so laneDisplay.twoPointFacts can fall back to the shipper's free text.
      ...(otherOrigins ? { otherOrigins } : {}),
      ...(otherDestinations ? { otherDestinations } : {}),
      // Per-enquiry rules the engine reads off the load (monitor.meta.rules), and the ONLY route by
      // which a per-load number reaches either ceiling defence: arm() caps the ladder from
      // rules.ceilingPrice and _bidOpts spreads this same object into placeBid's opts. Each fact is
      // omitted individually when its wire field could not be read, so the engine falls back to
      // capabilities().minDecrement, and an unreadable ceiling means "no cap" rather than an
      // explicit null it would have to interpret - the money-safe direction, since with no cap the
      // cost floor still guards the downside.
      //
      // ceiling_rate's UNIT is unproven: it is null on all 11 observed enquiries (this tenant has
      // enable_ceiling_rate:false), so nothing establishes whether it is per-unit like the wire
      // `price` or a quote total. Read as per-unit because it sits beside slab_rate, which is
      // per-unit; if it is in fact a total, both defences become more PERMISSIVE on a multi-unit
      // load rather than falsely refusing, so the unproven reading cannot cost a bid.
      ...((minDecrement != null || ceilingPrice != null) ? {
        rules: Object.assign({},
          minDecrement != null ? { minDecrement } : {},
          ceilingPrice != null ? { ceilingPrice } : {}),
      } : {}),
      ...(minDecrement != null ? { minDecrement } : {}),
      // CLOSE MODEL, stated in the vocabulary the scope gate actually reads.
      //
      // GoComet is reactive-countdown: an enquiry's deadline SLIDES FORWARD on an extension.
      // Roughly two in three observed auctions extend at least once, each extension adds five
      // minutes, and one ran 22 extensions and closed nearly two hours past its posted time. That
      // makes softClose TRUE for every GoComet load - it is a PLATFORM CONSTANT here, not a
      // per-load field read the way SuperProcure's branchAuctionExtendTime is. Which is also why
      // closeModelKnown is true rather than false: the model IS established for this platform, and
      // it is established as soft. Marking it "unknown" would be a second lie in the safe
      // direction, and the unknown path is not a place to park facts we actually have.
      //
      // Both booleans are load-bearing, not decorative. This codebase carries the close model in
      // TWO vocabularies: load-level it is the softClose/closeModelKnown BOOLEAN PAIR (what
      // realAdapter._mapLoad sets, what discovery.isOutOfHardCloseScope gates on, what
      // priceRequests persists onto the request snapshot, what snipeHarness reads), while
      // adapter-level capabilities() and getAuctionState() report a closeModel STRING. This mapper
      // used to emit the STRING ONLY - an honest 'soft' in the wrong vocabulary - so the gate
      // evaluated `undefined` against both booleans and concluded NOT out of scope. A permanently
      // extending auction was therefore admitted as though it had a fixed deadline, on a
      // deployment configured hard-close-only: the fail-closed default failing OPEN. The boolean
      // pair is also the ONLY form that survives the persisted price-request snapshot, so the
      // string alone could never have reached the capture-time backstop in server.js either.
      softClose: true,
      closeModelKnown: true,
      closeModel: 'soft', // reactive-countdown (see capabilities); auction_type is unreliable
    };
  }

  /**
   * List the open spot enquiries visible to this vendor account. Pages through
   * /enquiries/spot (size caps at ~30 live) up to a small bounded number of pages, each GET
   * spaced by the GET-budget above. Read-only. On a rate-limit cooldown returns what it has (or
   * []), logged - never hammers the limiter.
   */
  async listAuctions({ maxPages = 10, size = 30, enrich = true, maxDetailFetches = null } = {}) {
    await this.ensureSession();
    this._pruneDetailCaches();
    const out = [];
    let excluded = 0;
    let unenriched = 0;
    let budget = Number.isFinite(maxDetailFetches) ? maxDetailFetches : this.maxDetailFetchesPerList;
    for (let page = 1; page <= maxPages; page += 1) {
      const path = `${API_PREFIX}/enquiries/spot?page=${page}&size=${size}&reset_filter=false&filter[enquiry_type]=spot`;
      const res = await this._request('GET', path, { priority: READ_PRIORITY.ROUTINE });
      // A LISTING THAT NEVER GOT A SLOT MUST NOT RETURN AS "NO AUCTIONS". Those two are
      // indistinguishable to every caller above, and that is the whole shape of this defect: the
      // desk sees a quiet board, the poller logs a normal cycle, and nothing anywhere says the
      // account's read budget was saturated the entire time. So page 1 throws - discovery logs the
      // failure at error level and reports nothing scanned - while a later page keeps what it
      // already gathered, exactly as the cooldown path does.
      if (res.slotStarved) {
        if (out.length) {
          this.log.warn('gocomet listAuctions starved on the read budget - returning partial list', {
            page, gathered: out.length, waitedMs: res.waitedMs,
          });
          break;
        }
        const e = new Error(`gocomet: listAuctions never got a read slot (waited ${res.waitedMs}ms) - the account read budget is saturated and no new auctions are being surfaced`);
        e.code = 'READ_STARVED';
        throw e;
      }
      if (res.rateLimited) {
        this.log.warn('gocomet listAuctions throttled - returning partial list', { page, gathered: out.length });
        break;
      }
      if (res.status === 401 || res.status === 403) {
        const e = new Error('gocomet: list unauthorized (token expired?)'); e.code = 'AUTH';
        this._alertAuth('GoComet returned 401/403 on the enquiry list - the token has likely lapsed.');
        throw e;
      }
      const d = (res.json && (res.json.data || res.json)) || {};
      const enquiries = Array.isArray(d.enquiries) ? d.enquiries : [];
      for (const e of enquiries) {
        // ENRICH FROM THE ENQUIRY DETAIL, once per new load. cargo_quantity / cargo_unit /
        // slab_rate are detail-only (confirmed by the live probe), so without this the mapped
        // load has no multiplier and no decrement. Bounded two ways: a cache hit costs nothing,
        // and `budget` caps how many MISSES one cycle will chase - every detail GET pays the
        // inter-read spacing, so an unbounded loop over a full first page would stall discovery
        // for minutes and starve the hot path. Loads past the cap simply map unenriched this
        // cycle and get picked up on the next one.
        let detail = null;
        if (enrich && e && e.key != null) {
          const k = String(e.key);
          const cached = this._cachedDetail(k);
          const backoffUntil = this._detailFailUntil.get(k);
          if (cached) detail = cached;
          // A recently-failed enquiry does not spend budget. Without this, a few permanently
          // broken loads at the head of the list starve every healthy one behind them, forever.
          else if (backoffUntil && this.now() < backoffUntil) unenriched += 1;
          // A transport-wide cooldown is not a fact about THIS enquiry - _fetchEnquiryDetail would
          // only get back the synthetic cooldown 429 (_cooldownResult, nothing sent), and booking
          // that as a per-enquiry failure gives it a 120s backoff that outlives the 60s cooldown
          // that actually caused it, plus spends a budget unit on a call that never reached the
          // wire. Skip it the same way a real per-enquiry backoff is skipped, above.
          else if (this.now() < this._cooldownUntil) unenriched += 1;
          else if (budget > 0) { budget -= 1; detail = await this._fetchEnquiryDetail(k); if (!detail) unenriched += 1; }
          else unenriched += 1;
        }
        const mapped = this._mapEnquiry(e, detail);
        if (mapped) out.push(mapped); else excluded += 1;
      }
      const totalPage = Number(d.total_page);
      if (enquiries.length < size || (Number.isFinite(totalPage) && page >= totalPage)) break;
    }
    this.log.info('gocomet listAuctions', {
      open: out.length, excludedBadCloseTime: excluded, unenriched,
      // Answers "does any principal expose L1?" on its own, over ordinary discovery cycles,
      // instead of needing another live probe. false on every Waaree load seen so far.
      showsL1: out.filter((a) => a.showsL1).map((a) => a.id),
    });
    this.lastListSucceededAt = this.now(); // C101: reached only on a real HTTP response - see capabilities().livenessExpectedMs
    return out;
  }

  // ---- read: one auction's live state (the hot-path poll) -------------------------------------

  serverNow() { return this.now() + this.serverTimeOffsetMs; }

  /**
   * Live state of one enquiry for the engine's poll. Reads /enquiries/{key}/bidding-data - the
   * single call that returns rank + the live countdown + the revision budget + the server clock.
   * The countdown is the PLATFORM's own bid_closing_in (seconds), never the local wall clock, so
   * clock skew can't kill the snipe. A throttled/failed read returns ok:false (skip the tick)
   * rather than a false closesInMs:0 that would finalize a live auction early.
   */
  async getAuctionState(auctionId) {
    const key = String(auctionId);
    // measuredRttMs IS THE WRITE-LATENCY PROXY, NEVER THIS READ'S OWN SPAN. The seam contract is
    // stated at realAdapter.js getAuctionState and the SP adapter implements exactly this line.
    // The engine computes `oneway = measuredRttMs / 2` and gates the snipe on it, so the only
    // number that belongs here is how long a BID takes to land. Reporting the read span instead
    // is not a smaller estimate of the same thing - it is a different quantity: GoComet reads run
    // a steady ~30-45ms while submits ran 645ms / 1,070ms / 2,482ms (min/median/max, n=5), so the
    // engine would reserve ~20ms of runway for a write that can take over two seconds and release
    // the bid far too late to land. Both plausible-looking read-span variants are wrong for that
    // same reason - the wall span (which also includes our own inter-GET spacing wait) and
    // res.networkMs (which excludes it) differ from each other, but neither measures a write.
    const rtt = this.lastWriteRttMs != null ? this.lastWriteRttMs : this.assumedRttMs;
    let res;
    try {
      await this.ensureSession();
      res = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}/bidding-data`, {
        key, priority: this._readPriorityFor(key),
      });
    } catch (e) {
      if (e && e.code === 'AUTH') return { ok: false, authError: true, measuredRttMs: rtt };
      return { ok: false, measuredRttMs: rtt };
    }
    // A BODY-LESS RESPONSE MUST NEVER REACH THE CLOSE DECISION BELOW.
    //
    // HTTP 304 is the measured instance of that shape. GoComet ETags every read, and a 304 comes
    // back with content-length 0 and no body at all. Fed through _request that is text:'' ->
    // JSON.parse throws -> json:null, which USED to fall through to `bd = {}` and then to
    // Number(undefined) = NaN -> !Number.isFinite(NaN) -> `status:'closed'`, `closesInMs:0`.
    // That is the worst possible reading of a response whose entire meaning is "nothing changed":
    // it declares a LIVE auction closed. Two such reads in a row clear the engine's 3s
    // finalize debounce (and our own GET spacing is 5s, so two consecutive polls always do), and
    // _finalize is TERMINAL - `monitor.finalized` is never unset, _schedule refuses a finalized
    // monitor, and an extension seen afterwards is ignored. So the cost of this path is not a
    // skipped tick, it is silently abandoning a live auction for good. A total loss, no alert.
    //
    // It is dormant today only because we never send `if-none-match`, and the 2026-08-04 live
    // probe showed conditional polling is not even worth adopting here: `bidding-data`'s weak
    // ETag hashes a body containing `bid_closing_in` and `current_server_time`, so it changes
    // every second and can never match (two reads 3s apart both returned 200 with fresh ETags).
    // A true 304 WAS reproduced on `suggested-quotes` on the same API, so the server shape is
    // real, not hypothetical - this guard is defensive, not an enabler for conditional reads.
    if (res.rateLimited || res.status === 0 || res.status === 304) {
      return { ok: false, notModified: res.status === 304, measuredRttMs: rtt };
    }
    if (res.status === 401 || res.status === 403) {
      this._alertAuth('GoComet returned 401/403 on bidding-data - the token has likely lapsed.');
      return { ok: false, authError: true, measuredRttMs: rtt };
    }
    const body = res.json && (res.json.data || res.json);
    // The general form of the same defence, so a future body-less/reshaped response cannot
    // re-open this hole by arriving with a status we did not enumerate above. `closed` is only
    // ever inferred from a bid_closing_in the payload ACTUALLY CARRIED: a live load returns
    // seconds and a closed one returns an explicit null (both confirmed live), so the key is
    // always present on a well-formed body. Its ABSENCE means we did not get bidding-data at
    // all, which is a read failure - report ok:false and skip the tick, exactly as for a 429.
    // Distinguishing "absent" from "null" is the whole point; `bd = {}` collapsed the two.
    if (!body || typeof body !== 'object' || !Object.prototype.hasOwnProperty.call(body, 'bid_closing_in')) {
      this.log.warn('gocomet bidding-data body unusable - skipping the tick rather than reading it as closed', {
        enquiry: key, httpStatus: res.status, hasJson: !!res.json,
      });
      return { ok: false, malformedBody: true, measuredRttMs: rtt };
    }
    const bd = body;

    // Server clock: closesInMs is driven by bid_closing_in, and the server's stamp is the base
    // closesAtMs is derived from below - the engine compares that absolute close across polls, so an
    // epoch that drifts against the platform's own would read as an extension.
    // A response that arrives late under-reads the offset by its own return leg, so the offset is the
    // minimum-delay estimate over recent reads rather than the last read's: the engine times a
    // provisional round shot against this clock (ruling 52), and one slow read must not move it.
    // A stamp the estimator refuses (the box clock 90 s or more from GoComet's) still places this
    // read's close on GoComet's clock, which no offset the estimator holds describes; the state then
    // publishes no server clock (serverOffsetMs null, below), as it does before any stamp is accepted.
    const srvT = Date.parse(bd.current_server_time);
    let stampRefused = false;
    if (!Number.isNaN(srvT)) {
      const at = this.now();
      const r = normalizeServerOffset(srvT, at);
      if (r.ok) {
        this.serverClock.addRoundTrip(res.networkMs, at);
        this.serverClock.addSample(r.offsetMs, at);
        this.serverTimeOffsetMs = this.serverClock.offsetMs();
      } else stampRefused = true;
    }
    // PLAUSIBILITY BOUND ON THE STAMP ITSELF - same doctrine _boundedParseMs applies to a close
    // timestamp, applied here to the CLOCK reading. A skew-refused stamp (stampRefused above) is
    // still a real clock reading, just far from the box's own - ruling 52 says that one still
    // belongs on GoComet's clock (srvBase = srvT), and this bound (days-wide) is nowhere near the
    // 90s skew threshold, so it can never touch that case. A stamp that parses to a DIFFERENT
    // CALENDAR YEAR or epoch 0, though, is not a clock reading at all - Number.isNaN(srvT) is false
    // for it just like a normal stamp, and unbounded it becomes srvBase (and, via `snap` below, the
    // base of liveCloseAtMs itself), carrying a decades-scale absolute time straight into the
    // published closesAtMs. Treated the same as an unparseable stamp instead: falls back to our own
    // clock, exactly the already-safe path a missing current_server_time already takes.
    const srvTUsable = !Number.isNaN(srvT) && srvT >= this.now() - MAX_PLAUSIBLE_PAST_MS && srvT <= this.now() + MAX_PLAUSIBLE_DEADLINE_MS;
    // Fall back to the last accepted offset when this body carried no usable clock, rather than
    // dropping closesAtMs: a missing timestamp is not a reason to stop reporting the close.
    const srvBase = srvTUsable ? srvT : this.serverNow();

    // ONLY AN EXPLICIT null MEANS CLOSED. Everything else must be a real number.
    //
    // A closed load returns bid_closing_in = null (confirmed live); a live load returns integer
    // seconds. The old test was `!Number.isFinite(Number(x))`, which swept every unusable VALUE
    // into "closed" alongside the genuine null: a string ("soon", "00:05:00"), an object
    // wrapper ({value: 300}), an array, a boolean, Infinity. None of those is a close - they are
    // a schema change under us - and reading one as a close is terminal, because two such reads
    // clear the finalize debounce and _finalize cannot be undone.
    //
    // Number() coercion made it worse in both directions: [300] would have coerced to a live
    // 300s countdown and `true` to a live 1s one, so a reshaped payload could equally have
    // invented a countdown that was never sent.
    const rawSecs = bd.bid_closing_in;
    if (rawSecs !== null && !(typeof rawSecs === 'number' && Number.isFinite(rawSecs))) {
      this.log.warn('gocomet bid_closing_in is neither null nor a finite number - skipping the tick rather than reading it as closed', {
        enquiry: key, bidClosingIn: rawSecs, type: typeof rawSecs,
      });
      return { ok: false, malformedBody: true, measuredRttMs: rtt };
    }
    const secs = rawSecs;
    const closed = secs === null || secs <= 0;
    const countedMs = closed ? 0 : Math.round(secs * 1000);
    // UPPER PLAUSIBILITY BOUND, the same doctrine _boundedParseMs applies to close TIMESTAMPS
    // and for the same reason. The SuperProcure year-2100 placeholder incident is this file's
    // canonical lesson (see the header): a bad deadline that parses as VALID arms a load with a
    // decades-long fake runway. That bound was applied to the list path and never to the
    // countdown, so an enquiry excluded from discovery for an implausible close time would, if
    // armed by any other route, poll as perpetually live and never fire. A countdown beyond the
    // same +30d horizon is not a long auction, it is a placeholder - skip the tick.
    if (!closed && countedMs > MAX_PLAUSIBLE_DEADLINE_MS) {
      this.log.warn('gocomet bid_closing_in exceeds the plausible-deadline bound - treating as a placeholder, not a live countdown', {
        enquiry: key, bidClosingIn: secs, boundMs: MAX_PLAUSIBLE_DEADLINE_MS,
      });
      return { ok: false, implausibleCountdown: true, measuredRttMs: rtt };
    }

    // GoComet closes on a whole second and rounds bid_closing_in to the nearest one, so the whole
    // second nearest stamp + count IS the close, and the countdown to it is exact rather than +/-0.5 s.
    // A tie goes to the earlier second: a close believed early only aims the buzzer read early, one
    // believed late aims it past the runway. Only the server's own stamp can place the count inside its
    // second, and a fractional count carries its own precision, so either absence takes the count as sent.
    const snap = srvTUsable && Number.isInteger(secs);
    const liveCloseAtMs = closed ? null
      : (snap ? Math.ceil((srvT + countedMs) / 1000 - 0.5) * 1000 : srvBase + countedMs);
    const closesInMs = closed ? 0 : liveCloseAtMs - srvBase;
    const closesAtMs = this._closesAtFor(key, liveCloseAtMs);
    if (!closed) {
      this.log.debug('gocomet close derived from bid_closing_in', { enquiry: key, snapped: snap,
        bidClosingIn: secs, stampUsable: srvTUsable });
    }

    // T2b (ruling 61): prepare a quote in the background well before the buzzer, so a fresh one is
    // already cached by the time the decisive read fires the shot. The trigger is the earliest shot
    // (the engine's pre-final probe at 12s, ruling 56) PLUS the freshness bound, not the buzzer's own
    // 6.5s, which is left untouched - starting only at the shot's own read is already too late, since
    // a bid landing in that same tick would still race the prepare it just started (see
    // _prepareQuote). Gated on bidEnabled: an adapter with writes off never places a bid, so
    // preparing one would only spend read budget for nothing.
    const prepareFrom = Math.max(this._decisiveHorizonMs(), PROBE_SHOT_LEAD_MS) + PREPARED_QUOTE_MAX_AGE_MS;
    if (this.bidEnabled && !closed && closesInMs <= prepareFrom) {
      this._pendingPrepare = this._prepareQuote(key).catch(() => {});
      this._scheduleShotRefresh(key, liveCloseAtMs);
    }

    // Feed the translator the SERVER-derived close, never the local wall clock, for the same reason
    // closesInMs is not derived from one. A closed countdown is fed as an absent close rather than
    // the frozen value, so the zero-held rule sees the deadline expire instead of a deadline that
    // never moves.
    const closeModel = this._closeModelFor(key);
    const observation = closeModel.observe({ closeAtMs: liveCloseAtMs, atMs: this.now() });
    if (observation.terminal && !this._terminalLogged.has(key)) {
      this._terminalLogged.set(key, this.now());
      // The only close verdict this portal offers. bidding-data carries no close flag at all (the
      // 44-response key census), so an operator reading the log has nothing else to look at.
      this.log.info('gocomet enquiry read as terminal by the zero-held rule - no close flag exists on this endpoint', {
        enquiry: key, roundsObserved: closeModel.roundsObserved, extendMs: closeModel.publishedExtendMs(),
      });
    }

    const revsLeft = Number(bd.revisions_left);
    const totalRevs = Number(bd.total_revisions);
    const revisionLimit = (Number.isFinite(revsLeft) && Number.isFinite(totalRevs))
      ? revsLeft + totalRevs : this.capabilities().revisionLimit;

    return {
      ok: true,
      status: closed ? 'closed' : 'live',
      myRank: bd.vendor_rank != null ? bd.vendor_rank : null,
      // GoComet's vendor API exposes our own rank but NOT a live bidder count - null, not a guess.
      totalBidders: null,
      standingL1Price: null,            // rank-only (Waaree hides L1)
      closesInMs,
      // The clock closesAtMs is on. closesInMs is as old as this response; the engine counts down to
      // closesAtMs against serverNow at the moment it decides (ruling 52). null until the estimator
      // holds an accepted stamp, and on a read whose stamp it refused: the engine then keeps this
      // read's countdown, which is exact as of the stamp whatever the box clock says.
      serverOffsetMs: stampRefused || this.serverClock.offsetMs() == null ? null : this.serverTimeOffsetMs,
      // How far the close may be from this read's: ~0.1 s once snapped to the server's whole second,
      // the whole second otherwise. Read by the final-window walk's safety term.
      clockErrorMs: snap ? 100 : 1_000,
      // Whether closesAtMs came from the whole-second snap (integer countdown plus a usable stamp).
      closeSnapped: !closed && snap,
      revisionsLeft: Number.isFinite(revsLeft) ? revsLeft : null,
      revisionLimit,
      // Per-enquiry minimum decrement, served from the discovery-time detail cache. It is NOT
      // re-read here: bidding-data carries exactly 7 keys and slab_rate is not among them, so
      // the only way to have it on the hot path is to have fetched it earlier. null when this
      // enquiry was never enriched, which sends the engine to the capabilities() fallback.
      minDecrement: this._minDecrementFor(this._cachedDetail(key)),
      closeModel: 'soft',               // reactive-countdown; auction_type is unreliable, never gate on it

      // ---- close model, in the vocabulary the engine already speaks (realAdapter.js:1914-1927) ----

      // THE FIELD WHOSE ABSENCE SILENTLY ABANDONED LIVE AUCTIONS. bidEngine.js:1403 sizes the
      // sustained-zero finalize debounce as `extendMs + finalizeDebounceMs` on a soft close and
      // falls back to the bare finalizeDebounceMs (3s) without it. Our own GET spacing is 5,000ms,
      // so two consecutive polls ALWAYS outlast 3s: a countdown reading zero or null across an
      // extension boundary - precisely the ambiguous instant while GoComet is writing the new
      // deadline - finalized the monitor. _finalize is terminal (monitor.finalized is never unset,
      // _schedule refuses a finalized monitor at :1259 and _observeExtension at :1829), so the
      // auction was abandoned permanently, silently, and indistinguishably from a genuine loss.
      extendMs: this.extensionIncrementMs(key),
      // The translator's own floor for a real forward move of the deadline. The engine's believed
      // close follows moves of at least this much on loads it runs no soft endgame for.
      minCloseJumpMs: closeModel.cfg.minJumpMs,

      // The IMPLIED absolute close, from the SERVER's clock plus the platform's own countdown -
      // never the local wall clock, for the same reason closesInMs is not derived from one.
      //
      // FROZEN WHEN CLOSED at the last live value, and OMITTED ENTIRELY when this enquiry has never
      // been read live - two different facts, deliberately published differently. The phantom-slide
      // hazard that rules out deriving a close from the clock is real, but publishing null is not
      // the answer to it: the engine coerces this field with Number(), and Number(null) is a finite
      // 0, so null does not read as unknown - it reads as epoch 1970. The full reasoning for both
      // branches, and for why an omitted key is the honest way to say "no value", is _closesAtFor.
      ...(closesAtMs != null ? { closesAtMs } : {}),

      // THE EXTENSION CAP, not the number of extensions seen so far - this key is the MAXIMUM in
      // the vocabulary realAdapter established (branchExtendAuctionCount) and bidEngine.js:1760
      // reads it straight into monitor.extendCap. GoComet publishes no cap, so null: an unknown cap
      // makes _effectivelyHard (:1865) fail closed to the proven hard-close snipe. Publishing an
      // observed count here instead would set extendCap equal to extendsObserved on every
      // extension, making `extendsObserved >= extendCap` true from the first round onward and
      // telling the engine a permanently-extending auction was already final.
      extendCount: null,

      // "NO CAP EXISTS" - a different fact from extendCount's null, which is "the cap is unknown".
      // Roughly two in three GoComet auctions extend at least once, one observed load extended 22
      // times, and nothing in the platform or the captures bounds it. The distinction is load-
      // bearing for the strategy work that follows: a bounded auction has a genuinely final round
      // worth reserving the floor for, an unbounded one never does, and only this field can tell
      // those apart from a cap we merely have not read yet.
      extensionCeiling: null,

      // GoComet's own explicit close flag, carried as a fact. It deliberately does NOT feed
      // `status` above: that stays derived from bid_closing_in, where an explicit null is the
      // confirmed close signal. Letting a possibly-absent boolean force a close would put a
      // TERMINAL finalize behind a field we have never seen on this endpoint, and a late finalize
      // costs a few wasted polls while an early one costs the auction. Type-strict for the reason
      // bid_closing_in is: absent must read as "not reported", never as false.
      biddingClosed: typeof bd.bidding_closed === 'boolean' ? bd.bidding_closed : null,

      measuredRttMs: rtt,
    };
  }

  // ---- write: place / revise a bid (HARD-DISABLED in this phase) ------------------------------

  /**
   * Locate the freight-charge container on a quote. The clone hardcodes '11_freight_charges';
   * we prefer that key, then fall back to any charges_list key ending in `_freight_charges`, so a
   * numbering drift doesn't silently write nothing. Returns [containerKey, container] or null.
   */
  _freightContainer(quote) {
    const cl = quote && quote.charges_list;
    if (!cl || typeof cl !== 'object') return null;
    const groups = Object.keys(cl).filter((key) => /_freight_charges$/.test(key) && cl[key] && typeof cl[key] === 'object');
    if (!groups.length) return null;
    // MORE THAN ONE FREIGHT GROUP IS REFUSED, and this is a distinct hole from the multi-LINE
    // one below rather than a duplicate of it.
    //
    // This function returns ONE group, so the multi-line guard downstream only ever counts the
    // lines inside the group it happened to pick. A quote carrying two freight GROUPS would
    // therefore sail past that guard: we would price the first group's line and leave the
    // second group's line at whatever stale price it already held. GoComet sums the groups, so
    // the bid that lands is (our amount + some stale number) - not the amount the engine
    // decided, and not a clean multiple of it either. That is a mispriced bid in an
    // unpredictable direction, which is harder to spot after the fact than the N-fold, because
    // nothing about the number looks obviously wrong.
    //
    // 107/107 observed quote bodies carry exactly one group, so this is refusing an unobserved
    // shape rather than declining a known one - same posture as the multi-line refusal.
    if (groups.length > 1) {
      const e = new Error(`gocomet: quote has ${groups.length} freight-charge groups (${groups.join(', ')}); only one can be priced, and leaving the others untouched would submit a bid summed with their stale prices - refusing`);
      e.code = 'MULTI_FREIGHT_GROUP'; e.groups = groups.slice();
      throw e;
    }
    // Prefer the canonical key when it is the only one, preserving the previous behaviour.
    const k = groups.includes('11_freight_charges') ? '11_freight_charges' : groups[0];
    return [k, cl[k]];
  }

  // ---- T2b: the prepared-quote fast path (ruling 61) -------------------------------------------

  /**
   * Is `doc` a well-formed, priceable quote - the same shape checks placeBid runs before it will
   * write to a quote, run here so a bad document is never cached in the first place.
   */
  _quoteIsCacheable(doc, key) {
    if (!doc || doc.id == null) return false;
    const clone = JSON.parse(JSON.stringify(doc));
    const fc = this._freightContainer(clone);
    if (!fc) return false;
    const [, container] = fc;
    const chargeKeys = Object.keys(container).filter((k) => k.startsWith('freight_charges_custom_charge'));
    if (!chargeKeys.length) return false;
    try {
      if (chargeKeys.length === 1) readQuoteBasis(clone, container[chargeKeys[0]], key);
      else readMultiLineBasis(clone, chargeKeys.map((k) => ({ key: k, line: container[k] })), key);
    } catch (_e) { return false; }
    return true;
  }

  /** Cache `doc` as the prepared quote for `key`, tagged with the believed close it belongs to. */
  _cachePreparedQuote(key, doc) {
    if (!this._quoteIsCacheable(doc, key)) return;
    const lastClose = this._lastCloseAt.get(key);
    this._preparedQuotes.set(key, { quote: doc, preparedAt: this.now(), closeAtArm: lastClose ? lastClose.closeAt : null });
  }

  /**
   * A cached quote is usable without a fresh read if it is at most PREPARED_QUOTE_MAX_AGE_MS old,
   * or, while a 429 read cooldown is open (no fresh read is possible anyway), if it was prepared
   * for the believed close still in force - "the current arm". A close that has since moved
   * (an extension) is a different arm, and a quote prepared for another enquiry is a different
   * cache entry entirely, so both fall through to the ordinary cold path untouched.
   */
  _usablePreparedQuote(key) {
    const entry = this._preparedQuotes.get(key);
    if (!entry) return null;
    if (this.now() - entry.preparedAt <= PREPARED_QUOTE_MAX_AGE_MS) return entry;
    if (this.now() >= this._cooldownUntil) return null;
    const lastClose = this._lastCloseAt.get(key);
    const currentCloseAt = lastClose ? lastClose.closeAt : null;
    return entry.closeAtArm === currentCloseAt ? entry : null;
  }

  /**
   * A quote prepared on the approach can pass its freshness bound before the buzzer shot, and when no
   * middle shot lands nothing refreshes it, so the shot fetched and confirmed a quote first (2026-09-26,
   * 260925NP9V: GET, GET, PUT, 4,578 ms, decided at 3,532 ms). One refresh per close, timed two read
   * slots ahead of the decisive horizon, keeps the quote fresh from the buzzer read through the write
   * runway. Skipped when the close moved (the new close schedules its own) or a quote was just cached.
   */
  _scheduleShotRefresh(key, closeAt) {
    if (closeAt == null) return;
    const prev = this._shotRefresh.get(key);
    if (prev && prev.closeAt === closeAt) return;
    const waitMs = closeAt - this._decisiveHorizonMs() - 2 * this.globalMinGetIntervalMs - this.serverNow();
    if (!(waitMs > 0)) return;
    if (prev) clearTimeout(prev.timer);
    // A timer rather than the injected sleep: that sleep is the read queue's clock, and a test stub
    // for it advances time for everyone.
    const entry = { closeAt, timer: null };
    entry.timer = setTimeout(() => {
      if (this._shotRefresh.get(key) !== entry) return;
      this._shotRefresh.delete(key);
      const last = this._lastCloseAt.get(key);
      if (!last || last.closeAt !== closeAt || closeAt - this.serverNow() <= 0) return;
      const cached = this._preparedQuotes.get(key);
      if (cached && this.now() - cached.preparedAt <= 2 * this.globalMinGetIntervalMs) return;
      this._refreshPreparedQuote(key);
    }, waitMs);
    if (entry.timer.unref) entry.timer.unref();
    this._shotRefresh.set(key, entry);
  }

  /** Cancel the pending pre-buzzer refresh of one load, or of every load. The engine calls it on stop and kill. */
  cancelShotRefresh(auctionId = null) {
    const keys = auctionId == null ? [...this._shotRefresh.keys()] : [String(auctionId)];
    for (const k of keys) {
      const e = this._shotRefresh.get(k);
      if (e) { clearTimeout(e.timer); this._shotRefresh.delete(k); }
    }
  }

  /**
   * Refresh the prepared quote with one read when it still matches the cached one (same quote, same
   * write fingerprint - the cached copy is the first of the confirming pair), else the usual two.
   * Single-flight with _prepareQuote, so a bid landing mid-refresh joins it.
   */
  _refreshPreparedQuote(key) {
    const inFlight = this._preparingQuotes.get(key);
    if (inFlight) return inFlight;
    const cached = this._preparedQuotes.get(key);
    const p = (async () => {
      try {
        const fresh = await this._fetchQuoteForWrite(key, { refresh: true });
        if (cached && fresh.id === cached.quote.id && quoteWriteFingerprint(fresh) === quoteWriteFingerprint(cached.quote)) {
          this._cachePreparedQuote(key, fresh);
          return;
        }
        const second = await this._fetchQuoteForWrite(key, { refresh: true });
        if (second.id === fresh.id && quoteWriteFingerprint(second) === quoteWriteFingerprint(fresh)) this._cachePreparedQuote(key, second);
        else this.log.warn('gocomet pre-buzzer quote refresh did not confirm; the final shot will read its quote first', { enquiry: key });
      } catch (e) {
        this.log.warn('gocomet pre-buzzer quote refresh failed; the final shot will read its quote first', {
          enquiry: key, code: (e && e.code) || null, err: (e && e.message) || null });
      }
    })().finally(() => { this._preparingQuotes.delete(key); });
    this._preparingQuotes.set(key, p);
    return p;
  }

  /**
   * Prepare a quote for `key` ahead of the shot: read, validate, and a confirming re-read (the same
   * two-GET dance placeBid does at fire today), so the only thing left at fire is the PUT. Runs at
   * WRITE priority - this IS the write's own reads, just off the clock - on the shared GET budget.
   * Best-effort throughout: any failure here simply leaves the cold path as the fallback, which is
   * why every throw _fetchQuoteForWrite can raise (AUTH, RATE_LIMITED, NETWORK, NO_QUOTE, ...) is
   * swallowed rather than surfaced - there is no caller here to hand it to.
   *
   * SINGLE-FLIGHT. One prepare in flight per key, and the promise stays reachable via
   * _preparingQuotes for the life of that prepare (not just a "don't start a second one" flag) -
   * _submitBid awaits this SAME promise when a bid lands mid-prepare, rather than racing its own
   * cold-path reads against it. Without this a bid at the buzzer could see nothing cached yet and
   * open a second GET,GET pair that contends with the prepare's own on the one-per-second global
   * ceiling - four GETs before the PUT, at the exact instant ruling 51 sized the buzzer to avoid.
   */
  /** Prepare `auctionId`'s quote now (plan H: ahead of the final-window walk's first step). */
  prepareQuote(auctionId) {
    if (!this.bidEnabled) return Promise.resolve();
    return this._prepareQuote(String(auctionId));
  }

  _prepareQuote(key) {
    const inFlight = this._preparingQuotes.get(key);
    if (inFlight) return inFlight;
    if (this._usablePreparedQuote(key)) return Promise.resolve();
    const p = (async () => {
      try {
        const first = await this._fetchQuoteForWrite(key);
        const second = await this._fetchQuoteForWrite(key);
        if (second.id !== first.id || quoteWriteFingerprint(second) !== quoteWriteFingerprint(first)) return;
        this._cachePreparedQuote(key, second);
      } catch (_e) {
        // opportunistic - a bid still has the cold path if this never lands.
      }
    })().finally(() => { this._preparingQuotes.delete(key); });
    this._preparingQuotes.set(key, p);
    return p;
  }

  /**
   * The quote GET that a bid is built on, with every transport failure classified BEFORE parsing.
   *
   * Each of these used to fall through to the `!quote` test and die as NO_QUOTE - "this enquiry has
   * nothing submittable" - which is a statement about the ENQUIRY and is simply false in all three
   * cases. The bid was killed by OUR OWN cooldown, or by the network, and the operator was told the
   * load was unbiddable. Diagnosing a lost auction from that log line is impossible, and the three
   * need genuinely different responses (wait out a cooldown, retry a network blip, skip the load).
   *
   * The cooldown case is the sharpest: _request SYNTHESISES a 429 without issuing anything at all
   * when this.now() < this._cooldownUntil. So a rate limit hit by an unrelated background read -
   * discovery paging, another load's poll - silently disarms the next bid on a completely different
   * auction, and reports it as that auction having no quote.
   *
   * ONE definition because placeBid reads twice (see the confirming read there): a second copy of
   * this classification is how the two reads would end up disagreeing about what a 429 means.
   * maxSpacingWaitMs: a bid must never sit out the full polling interval before it can even fetch
   * the quote it is about to submit. See _request for the trade being made.
   */
  /**
   * Read the shipper's Target Rate off a CLOSED load, projected. Separate from _fetchQuoteForWrite
   * on two axes that both matter:
   *
   *   PRIORITY. That one is WRITE class, which outranks everything and has no aging, so running a
   *   post-close watch at that priority would starve discovery outright. This is ROUTINE - it shares
   *   the 5s class gate with list paging, which dilutes discovery rather than blocking it, and a
   *   target window is minutes long so it can afford to lose a cursor.
   *
   *   PROJECTION. That one returns the raw 52-key quote, which is safe only because placeBid mutates
   *   one field and drops it. This value is stored, logged and shown to the desk, so it must not
   *   carry a third party's identity - same doctrine as ENQUIRY_DETAIL_FIELDS. readTargetPrice keeps
   *   a fixed set of scalars and nothing else; the raw body is dropped on the return line.
   *
   * Returns null when there is no target rather than throwing - a load with no negotiation is the
   * overwhelmingly common case and is not an error.
   */
  async fetchTargetPrice(key, { nowMs } = {}) {
    const qr = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}/quotes`, {
      key, priority: READ_PRIORITY.ROUTINE,
    });
    if (qr.status === 401 || qr.status === 403) {
      const e = new Error('gocomet: quotes fetch unauthorized'); e.code = 'AUTH';
      this._alertAuth('GoComet 401/403 reading a target rate - token lapsed.'); throw e;
    }
    if (qr.rateLimited) { const e = new Error(`gocomet: target-rate read throttled for enquiry ${key}`); e.code = 'RATE_LIMITED'; throw e; }
    if (qr.status === 0) { const e = new Error(`gocomet: target-rate read network error for enquiry ${key}`); e.code = 'NETWORK'; throw e; }
    if (!qr.json) return null;
    return readTargetPrice(qr.json, nowMs != null ? nowMs : this.now());
  }

  // A refresh reads ahead of the shot, not for it: it waits its turn behind a sibling's decisive read
  // (_outranks) instead of jumping every queue as a bid's own quote read does.
  async _fetchQuoteForWrite(key, { refresh = false } = {}) {
    const qr = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}/quotes`, refresh
      ? { key, priority: READ_PRIORITY.HOT, refresh: true }
      : { key, priority: READ_PRIORITY.WRITE, maxSpacingWaitMs: this.writeGetSpacingCapMs });
    if (qr.status === 401 || qr.status === 403) { const e = new Error('gocomet: quotes fetch unauthorized'); e.code = 'AUTH'; this._alertAuth('GoComet 401/403 fetching the quote to bid - token lapsed.'); throw e; }
    if (qr.rateLimited) {
      const e = new Error(`gocomet: quote fetch throttled for enquiry ${key}${qr.cooldown ? ' (local cooldown, no request was issued)' : ''}`);
      e.code = 'RATE_LIMITED'; e.retryAfterMs = qr.retryAfterMs || null; e.localCooldown = !!qr.cooldown;
      // Which cooldown refused this bid. The cooldown is adapter-wide, so every load it holds off
      // carries the same value, and the desk hears about one cooldown once rather than once per load.
      e.cooldownSince = this._cooldownSince;
      this.log.warn('gocomet placeBid aborted: quote fetch throttled', { enquiry: key, localCooldown: !!qr.cooldown, retryAfterMs: qr.retryAfterMs || null });
      throw e;
    }
    if (qr.status === 0) {
      const e = new Error(`gocomet: quote fetch network error/timeout for enquiry ${key}`); e.code = 'NETWORK';
      this.log.warn('gocomet placeBid aborted: quote fetch network error', { enquiry: key });
      throw e;
    }
    if (qr.status === 304) {
      // Same class as the getAuctionState 304 hole: a body-less response must never be read as
      // data. We send no if-none-match today, so this is defensive.
      const e = new Error(`gocomet: quote fetch returned 304 (no body) for enquiry ${key}`); e.code = 'NO_BODY'; throw e;
    }
    // A server error, or a 2xx that is not a quote list, says nothing about the enquiry. Some of
    // GoComet's error answers are JSON and some are HTML or plaintext; without this every one of them
    // parses to "no list" and reads as NO_QUOTE, which the engine treats as a load it can never bid.
    // A transient code the engine retries at the held price instead (W1-8 V1-F01).
    const quotes = qr.status >= 200 && qr.status < 300
      ? (Array.isArray(qr.json) ? qr.json : (qr.json && Array.isArray(qr.json.data) ? qr.json.data : null))
      : null;
    if (!quotes) {
      const e = new Error(`gocomet: quote fetch for enquiry ${key} returned HTTP ${qr.status} without a readable quote list`);
      e.code = 'QUOTE_READ_FAILED'; e.httpStatus = qr.status;
      this.log.warn('gocomet placeBid aborted: quote fetch unreadable', { enquiry: key, httpStatus: qr.status });
      throw e;
    }
    const quote = quotes[0];
    // NO_QUOTE now means only what it says: we got a real, parsed response and it held no
    // submittable quote. Anything that prevented us from READING one throws above.
    if (!quote || quote.id == null) { const e = new Error('gocomet: no submittable quote for enquiry ' + key); e.code = 'NO_QUOTE'; throw e; }
    return quote;
  }

  /**
   * Place / revise a bid via GoComet's fetch-mutate-PUT whole-quote contract (ported from
   * reference/brl-gocomet/source/server.js:1665-1840): GET the current quote, deep-clone it,
   * overwrite the `price` on the freight-charge line, and PUT the entire modified quote back to
   * /quotes/{quoteId}/submit - plus a confirming re-read before the PUT, because the document is
   * shared with another writer on this same vendor identity (see step 3).
   *
   * DOUBLE-GATED and OFF by default: requires BOTH `writeEnabled` (the kill-switch backstop) AND
   * `bidEnabled` (GC_BID=1). Either being false throws WRITE_DISABLED before anything is fetched,
   * so a configured read token can never bid and this PR ships with writes off.
   *
   * PRICE TYPE: we write a NUMBER (the live read-back shows `price` as a float), whereas the clone
   * wrote String(bidPrice). This is a deliberate, VERIFICATION-PENDING choice - confirm the wire
   * accepts a number in the supervised write-path capture before enabling writes.
   *
   * MULTI-TRUCK-TYPE. `price` is per unit and the server multiplies each line by its own `units`
   * and sums, so one per-unit amount written to every line totals amount x sum(units) - it is not
   * a multiple of the intended bid, which is what the old MULTI_CARGO_UNSUPPORTED refusal wrongly
   * assumed. Only freight-charge lines are written; accessorials in the same container are carried
   * through untouched. Where the desk priced each truck type separately (`opts.costByType`), the
   * rung is applied as a MULTIPLIER over each type's own cost, so every line carries the same
   * margin over a different base - see resolvePerTypePrices.
   *
   * COST-FLOOR BELT: the engine owns the floor; this re-asserts it at the adapter boundary on the
   * exact amount going on the wire (opts.floor), so a sub-floor amount can never leave the building.
   *
   * @param {string|number} auctionId - the GoComet enquiry key to bid on
   * @param {number} price - the amount to bid; rounded, then written to every freight-charge line
   * @param {Object} [opts] - bid context; `opts.floor` is the operating cost floor the belt
   *   re-asserts on the exact wire amount
   * @returns {Promise<{accepted: boolean, status: number, myRank: number|null,
   *   revisionsLeft: number|null, reason: string|null, latencyMs: number,
   *   units: number, unitName: string, wireTotal: number,
   *   raw: Object|string|null}>} - the platform's response in the seam's placeBid shape.
   *
   *   Throws, and the codes are deliberately distinct because they need different responses:
   *     WRITE_DISABLED         either gate is down (kill-switch backstop, or GC_BID off)
   *     AUTH                   401/403 on the quote fetch
   *     RATE_LIMITED           throttled, or held off by our OWN cooldown (localCooldown flag);
   *                            cooldownSince names the cooldown episode
   *     NETWORK                the quote GET or the PUT never landed
   *     NO_BODY                a body-less response (304) where data was required
   *     QUOTE_READ_FAILED      a quote read that was not 2xx, or a 2xx that is not a quote list
   *     NO_QUOTE               a 2xx quote list holding no submittable quote
   *     NO_FREIGHT / NO_CHARGE the quote has no freight container / no charge line
   *     MULTI_FREIGHT_GROUP    more than one freight GROUP - still refused, still unobserved
   *     BASIS_UNKNOWN / BASIS_UNSUPPORTED  the pricing basis is unreadable or is not per-vehicle
   *     UNITS_UNREADABLE / UNITS_DISAGREE  the quantity multiplier is absent or self-contradictory
   *     PARTIAL_VEHICLE_COUNT  a partial count was armed; GoComet cannot express one
   *     COST_TYPE_UNMATCHED    per-truck-type costs were armed but cannot be routed to this
   *                            quote's freight lines (see resolvePerTypePrices)
   *     FLOOR                  the cost-floor belt (from assertAboveFloor)
   *     CEILING                the enquiry's own ceiling_rate belt (from assertBelowCeiling)
   *     QUOTE_CHANGED          another writer on this vendor identity moved the quote under us
   *
   *   Every throw raised before the submit PUT is issued carries `placed: false`, whatever its code.
   *   NETWORK is thrown on both sides of the PUT (quote GET and submit), so the code alone cannot
   *   tell the engine whether a bid may be on the board; the call site can.
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

  async readSubmissionPosition(auctionId, attempt) {
    try {
      if (!attempt || !attempt.quoteId || !Array.isArray(attempt.pricedLines) || !attempt.pricedLines.length) return { verified: false };
      if (!Number.isFinite(attempt.price) || attempt.price <= 0
          || new Set(attempt.pricedLines.map(p => p.key)).size !== attempt.pricedLines.length
          || attempt.pricedLines.some(p => !Number.isFinite(p.price) || p.price <= 0 || !Number.isFinite(p.units) || p.units <= 0 || p.currency !== 'INR')) return { verified: false };
      await this.ensureSession();
      const key = String(auctionId);
      const res = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}/quotes`, { key, priority: READ_PRIORITY.POLL });
      const rows = res.json && (Array.isArray(res.json) ? res.json : res.json.data);
      if (res.status !== 200 || !Array.isArray(rows)) return { verified: false };
      const matches = rows.filter(q => q && String(q.id) === String(attempt.quoteId));
      if (matches.length !== 1) return { verified: false };
      const q = matches[0];
      if (!['submitted', 'selected'].includes(q.status) || q.deleted === true) return { verified: false };
      const [, lines] = this._freightContainer(q);
      if (!lines || Object.keys(lines).filter(k => k.startsWith('freight_charges_custom_charge')).length !== attempt.pricedLines.length || !attempt.pricedLines.every(p => {
        const line = lines[p.key];
        return line && Number(line.price) === p.price && Number(line.units) === p.units
          && line.currency === p.currency;
      })) return { verified: false };
      const state = await this._request('GET', `${API_PREFIX}/enquiries/${encodeURIComponent(key)}/bidding-data`, { key, priority: READ_PRIORITY.POLL });
      const d = state.json && (state.json.data || state.json);
      if (state.status !== 200 || !d || !Number.isInteger(d.revisions_left) || d.revisions_left < 0) return { verified: false };
      const seconds = d.bid_closing_in;
      if (seconds !== null && !(typeof seconds === 'number' && Number.isFinite(seconds))) return { verified: false };
      return { verified: true, quoteId: attempt.quoteId, price: attempt.price,
        biddingOpen: d.bidding_closed !== true && seconds !== null && seconds > 0,
        closesInMs: seconds === null ? 0 : Math.max(0, seconds * 1000),
        revisionsLeft: d.revisions_left, rank: d.vendor_rank ?? null, verifiedAt: this.now() };
    } catch (_) { return { verified: false }; }
  }

  async _submitBid(auctionId, price, opts, wire) {
    if (!this.writeEnabled) {
      const e = new Error('gocomet write_disabled: writeEnabled backstop is down (kill-switch)'); e.code = 'WRITE_DISABLED'; throw e;
    }
    if (!this.bidEnabled) {
      const e = new Error('gocomet write_disabled: GC_BID is not enabled (writes are off by default)'); e.code = 'WRITE_DISABLED'; throw e;
    }
    await this.ensureSession();
    const amount = Math.round(price);
    // BELT: re-assert the cost floor on the exact wire amount before constructing anything.
    if (opts && Number.isFinite(opts.floor)) assertAboveFloor(amount, opts.floor);
    // CEILING BELT: the upper-bound mirror, keyed off the enquiry's own ceiling_rate carried on the
    // rules (opts.ceilingPrice). assertBelowCeiling THROWS on a null ceiling - `!(price <= null)` is
    // true for any positive price - so the plausibleCeiling guard is what makes "no ceiling" mean no
    // assertion rather than a refused bid, and it is the reason this is not a bare call. Identical
    // shape to realAdapter's belt so the two platforms cannot drift on the same class of number.
    if (opts) {
      const ceil = plausibleCeiling(opts.ceilingPrice);
      if (ceil != null) assertBelowCeiling(amount, ceil);
    }

    const key = String(auctionId);
    const t0 = this.now();
    // T2b (ruling 61): a quote prepared during the approach - already read, validated and
    // confirmed - stands in for BOTH reads below, so the only thing left is the PUT. SINGLE-FLIGHT:
    // if this key is already being prepared, JOIN that prepare instead of opening our own cold-path
    // reads beside it - two independent GET,GET pairs would otherwise contend for the same
    // one-per-second global ceiling right at the buzzer.
    const inFlight = this._preparingQuotes.get(key);
    if (inFlight) {
      // A shot joining a refresh still queued for a slot promotes it to the shot's own priority.
      const rw = this._refreshWaiters.get(key);
      if (rw && !rw.settled) {
        rw.refresh = false;
        rw.priority = READ_PRIORITY.WRITE;
        rw.deadlineAt = this.now() + this.writeGetSpacingCapMs;
        if (this._wakePump) this._wakePump();
      }
      await inFlight;
    }
    const prepared = this._usablePreparedQuote(key);
    if (!prepared) {
      const last = this._lastCloseAt.get(key);
      const toClose = last ? last.closeAt - this.serverNow() : null;
      if (toClose != null && toClose <= this._decisiveHorizonMs()) {
        this.log.warn('gocomet final-window shot has no fresh prepared quote; reading it first (GET, GET, PUT)', {
          enquiry: key, toCloseMs: Math.round(toClose) });
      }
    }
    // 1) fetch the current quote. Validation below runs against THIS read so a load we cannot price
    // at all is refused before the confirming read is spent.
    const quote = prepared ? prepared.quote : await this._fetchQuoteForWrite(key);

    // 2) deep-clone and validate: find the single freight-charge line and establish the pricing
    // basis. The price itself is written in step 3, onto the confirming read rather than this one.
    const updated = JSON.parse(JSON.stringify(quote));
    const fc = this._freightContainer(updated);
    if (!fc) { const e = new Error('gocomet: quote has no freight_charges container'); e.code = 'NO_FREIGHT'; throw e; }
    const [, container] = fc;
    const chargeKeys = Object.keys(container).filter((k) => k.startsWith('freight_charges_custom_charge'));
    if (!chargeKeys.length) { const e = new Error('gocomet: quote has no freight_charges_custom_charge* lines'); e.code = 'NO_CHARGE'; throw e; }

    for (const k of chargeKeys) {
      if (!container[k] || typeof container[k] !== 'object') {
        const e = new Error(`gocomet: freight-charge line ${k} on enquiry ${key} is not an object`); e.code = 'NO_CHARGE'; throw e;
      }
    }

    // A MULTI-TRUCK-TYPE QUOTE IS PRICED, NOT REFUSED - and this used to be the opposite.
    //
    // Until 2026-08-19 an N-line quote threw MULTI_CARGO_UNSUPPORTED, on the reasoning that
    // writing one amount to every line bids N times the intended total. THAT ARITHMETIC WAS
    // WRONG. `price` is PER UNIT, each line carries its own `units`, and the server multiplies
    // per line and sums: line_total = price_i x units_i, exact on 8 of 8 quote bodies read off
    // BRL's own tenant (_research/2026-08-19_gocomet-brl-tenant-api-probe.md), including an
    // asymmetric 63780x5 + 42520x1 = 361,420 and a 12386x187 = 2,316,182. So one per-unit amount
    // on every line is a uniform per-truck RATE, whose total is amount x sum(units) - not a
    // multiple of anything. BRL's own prior bot did exactly this and has a captured 200 to show
    // for it (reference/brl-gocomet/source/server.js prepareBidPayload:1745-1751).
    //
    // The engine still reasons about ONE per-unit number, which is what makes this safe to do
    // here rather than upstream: nothing about the ladder, the floor or the desk's cost changes.
    // A DISTINCT price per truck type is a separate, unbuilt capability - it needs a desk capture
    // surface that asks for two rates, and that is a product decision, not this function's.
    //
    // WHAT THIS DOES NOT TOUCH. Only keys matching the freight-charge prefix are written. The
    // same container can hold accessorial lines - `lr_charges` and `others` both appear inside
    // 11_freight_charges on the atgtire tenant, with include_in_rank true - and `display_name`,
    // which is a string rather than a line at all. Those are read by nobody here and rewritten by
    // nobody here; the submit carries them through byte-unchanged from the confirming read.

    // ESTABLISH THE PRICING BASIS BEFORE TRUSTING THE FLOOR COMPARISON.
    //
    // The floor belt above compares `amount` against `opts.floor`. Both are per-unit numbers -
    // the engine's ladder, its floor, and the desk's cost are all per-unit - and until now
    // NOTHING in this adapter established that the wire is per-unit too, or per-unit of WHAT.
    // The comparison was therefore only accidentally valid: correct on the loads we happened to
    // capture, and silently wrong the first time GoComet hands us a per-tonne line, where the
    // server would multiply our per-truck rupee figure by a tonnage of 23-50.
    //
    // WHY NOT MIRROR realAdapter's pmtWireTotal AND ASSERT IN TOTAL SPACE. That was the obvious
    // move and it is arithmetically empty here. On SuperProcure the conversion is real: the wire
    // `amount` IS the total while the engine's floor is per-MT, so the two live in different
    // spaces and pmtWireTotal exists to carry both through ONE tonnage so they cannot drift.
    // On GoComet the wire `price` is per-unit and the SERVER multiplies, so amount and floor are
    // already in the same space; asserting `amount x units >= floor x units` multiplies both
    // sides of an inequality by the same positive number and can never catch anything the
    // per-unit assert did not. The genuine content of the SuperProcure precedent is not the
    // multiply, it is "prove the two quantities are commensurable before comparing them" - and
    // on this platform that proof is the BASIS check, not an arithmetic one.
    //
    // So: read the basis, refuse anything that is not a supported per-vehicle basis, and refuse
    // when the multiplier's four independent carriers disagree. Only then is the floor belt's
    // comparison known-valid rather than assumed-valid.
    //
    // The single-line path stays on readQuoteBasis unchanged; a multi-line quote needs a different
    // carrier set for a structural reason readMultiLineBasis spells out.
    const basis = chargeKeys.length === 1
      ? readQuoteBasis(updated, container[chargeKeys[0]], key)
      : readMultiLineBasis(updated, chargeKeys.map((k) => ({ key: k, line: container[k] })), key);
    // ONE list of the lines about to be priced, whatever branch produced the basis, so the write
    // below and the read-back total cannot disagree about which lines are in play.
    const pricedLines = basis.lines || [{ key: chargeKeys[0], units: basis.units }];

    // MULTI-VEHICLE. GoComet has no vehicle-count field on the wire at all: the count IS `units`
    // on the quote, and the bid is unavoidably for ALL of them, because the server multiplies.
    // A desk-chosen PARTIAL count (SuperProcure's bidVehicleCount / vcq path) is therefore not
    // expressible here - the same situation as a partial PMT tonnage on SuperProcure, which
    // realAdapter also refuses rather than inventing a wire shape for. The engine can legitimately
    // hand us vcq:-1 (the single/unspecified sentinel) or vcq equal to the full count, both of
    // which describe what GoComet is going to do anyway; anything else is a partial we cannot
    // honour, and silently ignoring it - which is what happened before, by omission rather than
    // by decision - would bid for every truck while the desk believed it had asked for fewer.
    if (opts && opts.vcq != null && opts.vcq !== -1 && Number(opts.vcq) !== basis.units) {
      const e = new Error(`gocomet: enquiry ${key} was armed for ${opts.vcq} of ${basis.units} ${basis.unitName}(s), but GoComet has no per-bid vehicle-count field - the server multiplies the written price by its own units, so a partial count cannot be expressed. Refusing rather than bidding for all ${basis.units}`);
      e.code = 'PARTIAL_VEHICLE_COUNT'; e.requested = opts.vcq; e.units = basis.units;
      this.log.error('gocomet placeBid refused: partial vehicle count is not expressible', { enquiry: key, requested: opts.vcq, units: basis.units });
      throw e;
    }

    // The FREIGHT-LINE total the server will store across the lines we priced, derived through the
    // multipliers we just validated. Not a guard (see above - it cannot be one), but the number a
    // post-bid read-back needs in order to check what GoComet recorded against what we meant.
    //
    // It is deliberately the SUM OVER THE LINES WE PRICED, not the quote's grand total. The group
    // can carry sibling non-freight lines (`lr_charges`, `others`, detention and the like) which we
    // neither price nor overwrite, so they are part of total_charges.total but are not ours. A
    // read-back oracle must therefore compare this against the freight lines' stored total, not the
    // grand total - comparing it against the grand total would fire a false mismatch on any quote
    // with a sibling charge, and mask a real one on any quote without.
    //
    // A DISTINCT RATE PER TRUCK TYPE, when the desk gave one. Resolved BEFORE the confirming read
    // so a load whose types cannot be routed to its freight lines is refused without spending a
    // read slot on it. null when the desk gave a single blended rate - that path is untouched.
    const perType = resolvePerTypePrices(opts && opts.costByType, pricedLines, amount, opts && opts.floor, key);

    // `basis.units` is the sum of the priced lines' own units on BOTH branches, so on the uniform
    // path this one expression is sum(amount x units_i) without a second loop that could drift
    // from the write. On the per-type path the rates differ per line, so it is summed line by line
    // off the same map the write reads - one source, no chance of the two disagreeing.
    const wireTotal = perType
      ? pricedLines.reduce((a, ln) => a + perType.get(ln.key).price * ln.units, 0)
      : amount * basis.units;

    // 3) CONFIRMING READ, then rebase the submit onto it.
    //
    // GoComet's submit is the WHOLE document, and BRL's `autopilot` process bids the same vendor
    // identity on the same enquiries. Two writers, one document, no precondition: a revision that
    // lands between our read and our write is reverted to the values we read, with 200 on both
    // writes and nothing anywhere saying so. Proven at 92,000 overwritten by 98,000 - our own price
    // raised over a lower one on a REVERSE auction - and a sibling detention line we never priced
    // dragged 7,500 -> 5,000 along with it, because the submit carries every line.
    //
    // THE PORTAL OFFERS NOTHING TO PRECONDITION ON. The quote body carries `updated_at` and the GET
    // carries a weak ETag, but the submit's CORS allow-headers list does not include If-Match and
    // no capture shows the server rejecting a stale write - so sending one would be inventing a
    // platform capability, and a precondition the server ignores is worse than none.
    //
    // What is left is unilateral: read again, and refuse rather than submit a document that moved.
    // Two honest limits on it. It cannot close the window between GoComet serving this read and
    // GoComet committing our PUT (645-2,482 ms of measured server time), so a write landing inside
    // that window is still lost silently - that gap is a platform property, not a bug here. And it
    // costs a second GET slot, which is why the declared snipe budget below now covers two.
    // What it does buy is the rest of the exposure, converted from a silent overwrite into a loud
    // refusal, plus a submit built on the FRESHEST sibling values rather than values we never
    // authored and read seconds ago.
    // A PREPARED quote was already confirmed this same way during the approach (two reads,
    // fingerprint-matched, in _prepareQuote) - reusing it here, with no second live read, is the
    // fast path itself. The accepted staleness this trades away is the residual ruling 22 and the
    // timing proposal's Q4 licence: a foreign revision landing between prepare and this PUT is
    // overwritten, exactly as one landing in this window always was on the cold path.
    const fresh = prepared ? prepared.quote : await this._fetchQuoteForWrite(key);
    if (!prepared && (fresh.id !== quote.id || quoteWriteFingerprint(fresh) !== quoteWriteFingerprint(quote))) {
      const e = new Error(`gocomet: the quote for enquiry ${key} changed between our read and our submit - another writer on this vendor identity (autopilot, or the desk by hand) has revised it. Refusing rather than reverting their revision to the values we read`);
      e.code = 'QUOTE_CHANGED'; e.quoteId = quote.id;
      this.log.error('gocomet placeBid refused: the quote moved under us', { enquiry: key, quoteId: quote.id, freshQuoteId: fresh.id, amount });
      throw e;
    }
    // Identical by the fingerprint, so the same group and line are present and the basis just
    // validated still holds; submitting the fresh object rather than the first read is what keeps
    // "we only ever author our own price" true of the bytes that actually go on the wire.
    const submit = JSON.parse(JSON.stringify(fresh));
    const [, submitContainer] = this._freightContainer(submit);
    // What stands on this vendor login before our PUT, per unit: a raise refusal is answered below it.
    let standingPrice = null;
    for (const ln of pricedLines) {
      const was = Number(submitContainer[ln.key] && submitContainer[ln.key].price);
      if (Number.isFinite(was) && was > 0 && (standingPrice == null || was < standingPrice)) standingPrice = was;
    }
    for (const ln of pricedLines) {
      const line = submitContainer[ln.key];
      const pt = perType ? perType.get(ln.key) : null;
      const linePrice = pt ? pt.price : amount;
      // LAST BELT, ON THE EXACT NUMBER GOING ONTO THIS LINE, AGAINST THAT LINE'S OWN FLOOR. On the
      // uniform path this is the shared per-unit floor and repeats the assert at the top of
      // placeBid. On the per-type path the two sides come from different places - the price from
      // the engine's rung, the floor from what the desk typed against this truck type - so it is a
      // real comparison rather than the same inequality twice.
      const lineFloor = pt ? pt.floor : (opts && Number.isFinite(opts.floor) ? opts.floor : null);
      if (Number.isFinite(lineFloor)) assertAboveFloor(linePrice, lineFloor);
      ln.price = linePrice;
      line.price = linePrice;
      // CURRENCY IS PINNED, NEVER INHERITED. A captured quote on another tenant carried a per-line
      // currency of USD while its group total rendered INR; the portal accepted the submit and then
      // invalidated it, having stored Rs 57,79,129 against an intended Rs 59,700 - 96.8x. A draft
      // quote was separately observed defaulting a line to USD. The engine reasons in rupees and
      // has no currency concept at all, so the only honest thing to write beside a rupee figure is
      // the unit it is in. Scoped to the lines we price: a sibling accessorial keeps whatever it
      // carried, because we are not the author of its number.
      line.currency = 'INR';
    }

    // 4) PUT the whole modified quote back. No retry (idempotency - a silent retry can double-bid).
    const pricedSnapshot = pricedLines.map(ln => ({ key: ln.key, price: Number(submitContainer[ln.key].price),
      units: Number(submitContainer[ln.key].units), currency: submitContainer[ln.key].currency }));
    if (opts.unconfirmedSubmission) {
      const previous = opts.unconfirmedSubmission;
      const safe = String(previous.quoteId) === String(quote.id) && previous.pricedLines.length === pricedSnapshot.length
        && pricedSnapshot.every(p => previous.pricedLines.some(old => old.key === p.key && old.units === p.units
          && old.currency === p.currency && p.price < old.price));
      if (!safe) { const e = new Error('GoComet unresolved submission: refusing a duplicate or incompatible quote'); e.code = 'SUBMISSION_UNCONFIRMED'; throw e; }
    }
    if (typeof opts.beforeSubmit === 'function') opts.beforeSubmit({ quoteId: String(quote.id),
      price: amount, pricedLines: pricedSnapshot });
    this.log.debug('gocomet placeBid request started', { enquiry: key, quoteId: quote.id, amount, units: basis.units, unitName: basis.unitName, wireTotal, cargoLines: chargeKeys.length, perType: perType ? [...perType.values()].map((v) => v.price) : null });
    const putT0 = this.now();
    wire.dispatched = true;
    const res = await this._request('PUT', `${API_PREFIX}/quotes/${encodeURIComponent(quote.id)}/submit`, { body: { quote: submit }, timeoutMs: this.writeTimeoutMs });
    const putMs = this.now() - putT0;
    const latencyMs = this.now() - t0;
    // lastWriteRttMs feeds the engine latency compensation, so it must be the SUBMIT leg alone.
    // It used to be the whole placeBid span - spacing sleep + quote GET + PUT - so one stalled
    // bid taught the engine to expect a multi-second round trip and skewed the next snipe on
    // every load. latencyMs still reports the full operation for the caller and the logs.
    // Guarded on a real response (status !== 0): a timed-out/network-failed PUT got no answer, so its
    // abort span is not a measured round trip (the write may still have landed) - recording it would
    // install a fake multi-second RTT for every bid after this one on the same enquiry.
    if (res.status !== 0) this.lastWriteRttMs = putMs;

    if (res.status === 0) { const e = new Error('gocomet: bid network error'); e.code = 'NETWORK'; throw e; }
    const accepted = res.status === 200 || res.status === 201;
    const d = (res.json && (res.json.data || res.json)) || null;
    // T2b (ruling 61): every accepted submit refreshes the prepared quote from the server's own
    // returned document, so the NEXT bid on this enquiry inside the bound is the PUT alone too.
    if (accepted && d) this._cachePreparedQuote(key, d);
    // PROJECTED, never the raw body - see SUBMIT_ERROR_FIELDS. This is the one value the rejection
    // is allowed to carry out of the adapter, and it feeds the log line, `reason` and `raw` alike so
    // there is a single place the write path's egress is decided.
    // A throttle is decided by status, not body (GoComet's 429 is usually empty): the portal never ruled
    // on the price, so it goes out as the word the engine's throttle arm branches on, as SuperProcure's
    // does, and the rung is held for retry instead of walked down (T5 F2).
    const rateLimited = !accepted && (res.status === 429 || res.status === 503);
    const rejectReason = accepted ? null
      : (rateLimited ? 'rate_limited' : (projectSubmitError(res.json) || `http_${res.status}`));
    // This validation error can follow a saved quote; shared-login read-back cannot identify its writer.
    const unconfirmed = res.status === 422 && rejectReason === 'Validation failed: Bid close time should be greater than 5 minutes from creation time';
    if (!accepted) {
      this.log.warn(unconfirmed ? 'gocomet submission response unconfirmed' : 'gocomet placeBid rejected by platform', { enquiry: key, quoteId: quote.id, httpStatus: res.status, reason: rejectReason, amount });
    }
    return {
      accepted,
      status: res.status,
      ...(unconfirmed ? { submissionOutcome: 'unconfirmed', quoteId: String(quote.id), pricedLines: pricedSnapshot } : {}),
      ...(accepted ? {} : { standingPrice }),
      // quote_rank is the ONLY rank field the submit response carries. The vendor_rank / rank
      // fallbacks are kept as pure defence against a schema change; neither has ever appeared.
      myRank: (d && (d.quote_rank ?? d.vendor_rank ?? d.rank)) ?? null,

      // REVISIONS. The submit response is the whole quote object - 52 top-level keys - and
      // grepping them for /revis/ returns NOTHING. There is no revisions_left, no
      // total_revisions, no revisions. The old `d.revisions_left ?? d.revisionsLeft` was
      // therefore not a fallback chain, it was two names for a field that does not exist, and it
      // returned null on every bid ever placed while looking like a real read.
      //
      // That matters more here than the dead code suggests: the budget is THREE per enquiry,
      // shared across every BRL user and the autopilot process, it does not reset when the
      // auction extends, and on the captured load it hit zero eleven seconds before close. A
      // caller that believed it was reading the budget was reading nothing at all.
      //
      // What the response DOES carry is can_submit_quote, and it is server-authoritative: it was
      // overridden true -> false on exactly the submit that drove revisions_left to 0. So a
      // `false` is GoComet stating we have no moves left, which is worth exactly one bit -
      // report it as 0. Any other value leaves this null, because "some remain" is genuinely all
      // we know from this response. The real count is on bidding-data and the enquiry detail,
      // and getAuctionState already reads it there; this is the write path being honest about
      // what its own response does and does not tell it.
      revisionsLeft: (d && d.can_submit_quote === false) ? 0
        : ((d && (d.revisions_left ?? d.revisionsLeft)) ?? null),
      canSubmitAgain: d && d.can_submit_quote != null ? !!d.can_submit_quote : null,

      // FREE EXTENSION DETECTOR. bid_closing_in on the submit response is server-overridden on
      // every observed submit (one sent 187 and got back 471 - that bid extended the close by
      // ~5 minutes). So the write response itself says whether our own bid moved the deadline,
      // with no extra call and no polling delay. Carried out rather than used here, because
      // acting on it is an engine decision.
      // Same "only a real number is a countdown" guard getAuctionState applies to this field, and
      // for the same reason: a closed enquiry sends an explicit null, and Number(null) is 0, which
      // Number.isFinite accepts - so the coercing form reported a live-looking "closes in 0ms"
      // instead of "not reported" on exactly the response that says bidding is over.
      bidClosingInMs: (d && typeof d.bid_closing_in === 'number' && Number.isFinite(d.bid_closing_in))
        ? Math.round(d.bid_closing_in * 1000) : null,
      reason: rejectReason,
      body: (accepted || rateLimited) ? null : projectSubmitText(res.json),
      retryAfterMs: rateLimited && res.retryAfterMs != null ? res.retryAfterMs : null,
      latencyMs,
      // When the PUT was sent, so an accepted landing can be bracketed: the portal took the bid
      // somewhere between this and the response.
      submitStartedAt: putT0,
      // The validated basis, carried out so a caller never has to re-derive it (and so a
      // read-back oracle can compare wireTotal against the server's own total_charges.total).
      units: basis.units,
      unitName: basis.unitName,
      wireTotal,
      // How many truck-type lines this rate was written to, and which ones. A read-back oracle
      // needs the KEYS to sum the freight lines it should compare wireTotal against - the quote's
      // grand total is the wrong comparand (see wireTotal), and re-deriving the key set from the
      // response would let the oracle and the write disagree about what was priced.
      cargoLines: pricedLines.length,
      pricedLines: pricedLines.map((l) => ({ key: l.key, units: l.units, price: l.price != null ? l.price : amount })),
      // The rates actually written, by truck type, when they differ from each other. Null on the
      // uniform path so a reader cannot mistake "one rate" for "we did not record it".
      perTypePrices: perType
        ? pricedLines.map((l) => ({ key: l.key, label: perType.get(l.key).label, units: l.units, cost: perType.get(l.key).cost, price: perType.get(l.key).price }))
        : null,
      // ACCEPT carries the server's own quote object (our data, and the engine drops a non-string
      // raw anyway); REJECT carries the projected reason and nothing else. The old `res.text`
      // fallback was the string form that DID reach disk, and a rejection body is the one response
      // whose shape GoComet has never shown us.
      raw: accepted ? d : rejectReason,
    };
  }
}

module.exports = {
  GoCometAdapter, jwtClaims, parseRetryAfterMs, readQuoteBasis, readMultiLineBasis, resolvePerTypePrices, projectSubmitError,
  projectEnquiryDetail,
  SUPPORTED_QUOTE_BASES, SUBMIT_ERROR_FIELDS, SUBMIT_ERROR_MAX_CHARS, MAX_PLAUSIBLE_DEADLINE_MS,
};
