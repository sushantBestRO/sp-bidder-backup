'use strict';

const { hydrateLaneParsed, usableCity, INDIAN_STATES } = require('../platform/gocometLane');
const { lanePins } = require('../pricing/lanePins');

/**
 * THE one rule for how a lane end is written on screen - every portal, every surface.
 *
 * WHY THIS IS A MODULE RATHER THAN A HELPER PER SURFACE. Each surface used to render whatever its
 * adapter happened to emit, and there were two independent implementations of "one lane end" - one
 * in server.js and one in dashboard/src/lib/api.ts. They disagreed: the console printed the parsed
 * "City, State" label while the price page printed the city alone, so the same load read two ways
 * on two screens. Underneath that, SuperProcure and GoComet reached the renderer in different
 * shapes (a city string vs a postal address plus a parse), so the two portals also disagreed with
 * each other on one screen. Those are the same defect at two altitudes, and a third portal would
 * have produced a third shape. The rule now lives here, the server composes the finished strings
 * into the payload, and the console reads the field rather than re-deriving it.
 *
 * THE CANONICAL FORM IS: the city, title-cased, no state.
 *
 * - CITY, because the column is scanned, not read. It sits beside a load number, a customer and a
 *   countdown, and its job is to say which lane this is at a glance.
 * - NO STATE, because keeping it would not even make one portal consistent with itself: a state is
 *   appended only when the address happened to carry one after its pincode, so GoComet rows differ
 *   row to row, and SuperProcure publishes its own state suffix ("Bawal, HR") on some branches and
 *   not others. The disambiguating detail is not lost - the full address renders directly beneath
 *   every row, on both surfaces, from `points` below, and the price page also prints the pincode
 *   under the city. So the state is one line away wherever it actually decides something.
 * - TITLE-CASED, because the portals do not agree on case and neither is authored: SuperProcure
 *   returns UDHAMPUR beside Sikandrabad on the same board. Only a token that carries NO case
 *   information is recased, so a name the source spelled deliberately is never rewritten.
 *
 * WHAT THIS MUST NOT TOUCH: `lane.origin` / `lane.destination` stay the portal's raw strings.
 * Discovery matches the allowlist on them, the durable intent is rehydrated from them, and route
 * history is keyed on them - a display value leaking into any of those silently re-scopes it.
 * Everything here is derived at serve time and never written back, the same wall #186 drew.
 */

// Two-letter state/UT codes as they appear as a lane suffix ("Bawal, HR", "Mundra, GJ"). Matched
// against a closed list and only as a whole trailing segment, never extracted - a place name is not
// something to guess at, and the same discipline governs the full-name list this reuses.
const INDIAN_STATE_CODES = [
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'CT', 'DD', 'DL', 'DN', 'GA', 'GJ', 'HP', 'HR',
  'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB',
  'PY', 'RJ', 'SK', 'TG', 'TN', 'TR', 'TS', 'UA', 'UK', 'UP', 'UT', 'WB',
];

// A lane cell holds two of these plus a separator. Past this the string stops being a label and
// starts being a paragraph in a table column, which is the shape the desk complained about.
const MAX_LABEL = 32;

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Drop a trailing ", <state>" - either the full name or its two-letter code. */
function stripTrailingState(s) {
  const at = s.lastIndexOf(',');
  if (at <= 0) return s;
  const head = s.slice(0, at).trim();
  const tail = s.slice(at + 1).trim();
  if (!head || !tail) return s;
  const isState = INDIAN_STATE_CODES.includes(tail.toUpperCase())
    || INDIAN_STATES.some((n) => n.toLowerCase() === tail.toLowerCase());
  return isState ? head : s;
}

/**
 * Recase only what carries no case of its own. "UDHAMPUR" and "dharangaon" are the portal shouting
 * or mumbling; "Sikandrabad" and "McLeodganj" are somebody's spelling and are left exactly alone.
 */
function titleCasePlace(s) {
  return s.replace(/[A-Za-z]+/g, (w) => (
    /[a-z]/.test(w) && /[A-Z]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ));
}

/**
 * Bound a value that is not a place name. Cut on a word boundary when one is near the limit, so the
 * truncation reads as a truncation rather than as a typo, and never leave a dangling separator.
 */
function clampLabel(s) {
  if (s.length <= MAX_LABEL) return s;
  const cut = s.slice(0, MAX_LABEL);
  const at = cut.lastIndexOf(' ');
  const head = (at > MAX_LABEL / 2 ? cut.slice(0, at) : cut).replace(/[\s,\-]+$/, '');
  return `${head}...`;
}

/**
 * One lane end as it is written on screen.
 *
 * Place-shaped values are recased and de-stated; anything else is an address the parser declined,
 * and it is bounded rather than rewritten. Bounding is safe ONLY because the untruncated string is
 * on the same screen, in the address rows `displayPoints` builds - do not change one without the
 * other. `usableCity` is the same predicate the GoComet parser accepts a city with, so "is this a
 * place name" cannot come to mean two things.
 */
function canonicalPlace(raw) {
  const v = collapse(raw);
  if (!v) return '';
  // Our own clampLabel output: short enough to pass usableCity, so without this a second pass
  // would recase an address the first pass declined.
  if (v.endsWith('...') && v.length <= MAX_LABEL + 3) return v;
  const place = usableCity(v);
  if (!place) return clampLabel(v);
  let city = place;
  for (let prev = null; prev !== city;) { prev = city; city = stripTrailingState(city); }
  return titleCasePlace(city);
}

/**
 * The full pickup/drop addresses, for the follow-on rows under a lane.
 *
 * SuperProcure publishes a points array and GoComet publishes none at all - it puts the whole
 * postal address in the lane field instead. That difference, not any styling choice, is why the
 * sub-rows appeared under one portal's rows and not the other's. The addresses exist on both; only
 * the shape differs, so the shape is normalised here and both portals fill the same rows.
 *
 * The portal's own points always win when it published them. Synthesised entries are DISPLAY ONLY
 * and deliberately do not reach `load.points`, which lanePins, the WhatsApp ask, the bid log and
 * the CSV exports all read as "what the portal actually gave us".
 *
 * `echoesLaneEnd` says a synthesised entry carries nothing its own lane end does not already say,
 * so a surface that prints both can drop it. It is decided HERE because only here are the raw
 * string and `canonicalPlace` both in scope: the label is the address recased and stripped of a
 * trailing state, and a consumer comparing the two strings would have to re-implement that
 * stripping - which is the second implementation of one lane rule this module was written to
 * prevent. The test is `usableCity`, the same predicate `canonicalPlace` uses to decide whether a
 * string is a place name at all: a lane end it accepts differs from its label only by case and a
 * state suffix ("Bawal, HR" -> "Bawal"), while GoComet's postal addresses fail it (over 40
 * characters, or carrying a pincode) and keep their line. A point the PORTAL published is never
 * flagged - it is the full address, whatever it happens to look like.
 */
function displayPoints(load) {
  const pts = Array.isArray(load.points) ? load.points.filter((p) => p && p.address) : [];
  if (pts.length) return pts;
  return [['origin', 'pickup'], ['destination', 'drop']]
    .map(([end, kind]) => {
      const address = collapse(load.lane && load.lane[end]);
      return { kind, address, echoesLaneEnd: !!usableCity(address) };
    })
    .filter((p) => p.address && p.address !== '?');
}

/**
 * The pincode written beside each lane end - `{ from, to }`, either of which may be null.
 *
 * The two portals answer "what is this place's pin" from different places, and a surface that
 * consults only one of them prints pins for one portal and nothing for the other. SuperProcure's
 * pin has to be dug out of a point address or the shipper's note, which is what lanePins does and
 * why its 7-digit refusal exists; GoComet publishes it as a field, which the lane parser carries
 * through on `laneParsed`. lanePins stays FIRST because its note-recovery path is the proven one,
 * and the parsed field is the fallback for the portal that has no points to recover from.
 *
 * Expects a load that has already been through hydrateLaneParsed (withLaneDisplay returns one), so
 * a record stored before the parser existed still yields its pin.
 */
function laneEndPins(load) {
  const L = load || {};
  const recovered = lanePins(L);
  const parsed = (end) => {
    const p = L.laneParsed && L.laneParsed[end];
    return (p && p.pincode) || null;
  };
  return { from: recovered.from || parsed('origin'), to: recovered.to || parsed('destination') };
}

/**
 * A load with its display bundle attached, derived on read and never persisted.
 *
 * Derived rather than migrated for the reason gocometLane.hydrateLaneParsed sets out: the store is
 * the live worklist the desk is working out of, a migration would fix only the rows present when it
 * ran, and this costs one pass on an endpoint that already serialises the whole record.
 */
function withLaneDisplay(load, platformKey) {
  const L = hydrateLaneParsed(load || {}, platformKey);
  const end = (k) => {
    const p = L.laneParsed && L.laneParsed[k];
    const src = (p && (p.city || p.label)) || (L.lane && L.lane[k]) || '';
    return canonicalPlace(src) || '?';
  };
  return {
    ...L,
    laneDisplay: { origin: end('origin'), destination: end('destination'), points: displayPoints(L) },
  };
}

/**
 * BC-36/GC-2: does this load have more than one pickup or drop point, in the ONE form every
 * surface renders it - city/pincode pairs, NEVER a full street address (the reason
 * gocometAdapter's ENQUIRY_DETAIL_FIELDS stays an allowlist). Shared by the WhatsApp ask
 * (waTemplates.js) and the /price page so the two cannot state this differently for the same
 * load.
 *
 * PICKUP AND DROP ARE KEPT APART. An extra origin and an extra destination joined onto one
 * unlabelled "Also" line used to read as one fact about one end - a pricer seeing only "Also -
 * Hathras 204101" cannot tell whether that is a second pickup or a second drop, and a wrong guess
 * prices the wrong route. `pickup`/`drop` are the joined strings for each side, never mixed into
 * one string.
 *
 * Structured fields win: gocometAdapter maps GoComet's `other_origins`/`other_destinations` (plus
 * their zip arrays) onto `load.otherOrigins`/`load.otherDestinations`, each already reduced to
 * `{city, pincode}` - a stop that yields neither is dropped there, never passed through here as an
 * address. When neither array is present (single-point load, or the detail fetch found nothing
 * structured), the shipper's own free text is the only signal GoComet gives, and it cannot be
 * attributed to either end - a real two-point enquiry has been captured carrying "(2 Point
 * Delivery)" / "(2 Point Unloading)" in shipperRef - so it renders on `freeText` instead, in words
 * rather than an invented address. All three null when nothing signals an extra stop.
 */
function twoPointFacts(load) {
  const cell = (s) => {
    if (!s) return null;
    if (s.city && s.pincode) return `${s.city} ${s.pincode}`;
    return s.city || s.pincode || null;
  };
  // GC-3: a list past a WhatsApp-safe length (2,000 stops made a 28,000-character ask, against
  // WhatsApp's ~4,700-char limit) is shown as its first few plus a count, never spelled out in
  // full and never dropped silently.
  const MAX_STOPS_SHOWN = 3;
  const joinCapped = (list) => {
    if (!list.length) return null;
    if (list.length <= MAX_STOPS_SHOWN) return list.join(', ');
    return `${list.slice(0, MAX_STOPS_SHOWN).join(', ')}, +${list.length - MAX_STOPS_SHOWN} more`;
  };
  const pickups = (Array.isArray(load && load.otherOrigins) ? load.otherOrigins : []).map(cell).filter(Boolean);
  const drops = (Array.isArray(load && load.otherDestinations) ? load.otherDestinations : []).map(cell).filter(Boolean);
  if (pickups.length || drops.length) {
    return { pickup: joinCapped(pickups), drop: joinCapped(drops), freeText: null };
  }
  // A whole point-count, not a "2" caught mid-number: (?<!\d) keeps "12 Point" from reading as "2
  // Point", and any count of 2 or more is a real multi-point signal, not just the literal "2".
  const m = load && load.shipperRef && String(load.shipperRef).match(/(?<!\d)(\d+)\s*point/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 2) return { pickup: null, drop: null, freeText: n === 2 ? 'mentions 2 point' : `mentions ${n} point` };
  }
  return { pickup: null, drop: null, freeText: null };
}

module.exports = {
  withLaneDisplay, canonicalPlace, displayPoints, laneEndPins, clampLabel, titleCasePlace,
  stripTrailingState, INDIAN_STATE_CODES, MAX_LABEL, twoPointFacts,
};
