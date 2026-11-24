'use strict';

/**
 * GoComet lane addresses -> {city, state, pincode} + a short display label.
 *
 * WHY A PARSER AT ALL. GoComet's spot list carries `origin_zip_code` / `destination_zip_code` as
 * real fields, but there is NO city and NO state field anywhere on the enquiry (81 keys) or the
 * list row - and `consignee` / `shipper` are null on 30/30 live rows while the consignee's NAME is
 * concatenated into the front of the destination address. So the pincode is a field read and the
 * city/state are genuinely a string parse; there is nothing structured to map them from.
 *
 * THE PINCODE IS THE ANCHOR, and that is what makes this safe rather than a guess. We do not hunt
 * for a place name - we locate the known pincode inside the string and read the position around
 * it. Two positional forms occur on BRL's account (n=34 real strings, 2026-08-04 HARs + a
 * 2026-08-11 read-only probe of all 30 open enquiries):
 *
 *   "...Kasaba Hobali, Nelamangala Taluk,    Tumkur Road  Bangalore - 562123"   city BEFORE the pin
 *   "...NR. REGENCY 360005     Rajkot IN    India    Region  24   Gujarat"      city AFTER the pin
 *
 * The second is a distinct SAP-style export shape and is detected on its `<city> IN ... Region`
 * tail, never assumed. 4 of the 30 live rows carry it.
 *
 * THE STATE IS MATCHED, NEVER EXTRACTED. Only text AFTER the pincode is searched, and only against
 * the closed list of Indian states/UTs below. Both halves are load-bearing: an origin ends
 * "Kutch - 370150 GSTIN :24ABDCS3684B1ZJ PAN :ABDCS3684B", so "whatever follows the pin" would
 * print a tax number as a state; and a street can contain a state word ("...bathinda punjab Near
 * luck plant 151001..."), so searching the whole string would read a road as a state.
 *
 * FAILING IS NORMAL AND MUST BE CHEAP. Nothing here throws and nothing is ever invented: an
 * unparseable address returns city/state null and a label that is just the cleaned raw string. A
 * load with an ugly label still reaches the desk; a load that threw would not.
 */

// 28 states + 8 union territories, plus the renamed/legacy spellings still in shipper data.
const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Chattisgarh', 'Goa',
  'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
  'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Orissa', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Tamilnadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'Uttaranchal', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
  'Dadra and Nagar Haveli', 'Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh',
  'Lakshadweep', 'Puducherry', 'Pondicherry',
];

// Longest first, so "Tamil Nadu" cannot be shadowed by a shorter entry sharing a prefix.
const STATES_BY_LENGTH = [...INDIAN_STATES].sort((a, b) => b.length - a.length);

const PINCODE_RE = /\b\d{6}\b/g;

/**
 * Strip the source's punctuation noise: literal wrapping double quotes on some rows, and the " # "
 * GoComet uses where a colon belongs ("Village # Degam").
 *
 * DELIBERATELY PRESERVES INTERNAL SPACE RUNS. Where a comma is missing, GoComet leaves a run of
 * 2-6 spaces doing the separator's job ("...Tumkur Road  Bangalore - 562123"), so collapsing
 * whitespace here would destroy the only boundary marking where the city starts. `collapse` is
 * applied at the end, to the value being displayed.
 */
function cleanAddress(raw) {
  if (raw == null) return '';
  return String(raw)
    .replace(/^"+|"+$/g, '')
    .replace(/[\t\r\n]/g, ' ')
    .replace(/\s*#\s*/g, ' ')
    .trim();
}

function collapse(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** A candidate is a place name only if it reads like one. Rejecting beats guessing. */
function usableCity(s) {
  const v = collapse(s).replace(/^[\s,\-]+|[\s,\-]+$/g, '');
  if (!v || v.length > 40) return null;
  if (!/[A-Za-z]/.test(v)) return null;
  // A 4+ digit run is a pincode fragment or a phone number, and ':' marks a labelled field
  // ("MOB:8866950131", "State Code:"). Either means we grabbed an address line, not a city.
  if (/\d{4,}/.test(v) || v.includes(':')) return null;
  return v;
}

/** Whether a whole address segment IS a state name (not merely contains one). */
function isStateName(seg) {
  const v = String(seg == null ? '' : seg).trim().toLowerCase();
  return INDIAN_STATES.some((s) => s.toLowerCase() === v);
}

function matchState(text) {
  if (!text) return null;
  const hay = text.toLowerCase();
  let best = null;
  for (const s of STATES_BY_LENGTH) {
    const at = hay.lastIndexOf(s.toLowerCase());
    // Whole-word only, so "Goa" cannot match inside "Goalpara".
    if (at < 0) continue;
    const before = at === 0 ? ' ' : hay[at - 1];
    const after = at + s.length >= hay.length ? ' ' : hay[at + s.length];
    if (/[a-z]/.test(before) || /[a-z]/.test(after)) continue;
    if (!best || at > best.at) best = { name: s, at };
  }
  return best ? best.name : null;
}

/**
 * City in the SAP-style export tail: "<pin>   BATHINDA IN   India   Region  03   Punjab INDIA".
 * Gated on `Region` as well as the ` IN ` marker so an ordinary address that merely continues
 * past its pincode cannot be read this way.
 */
function cityFromRegionTail(afterPin) {
  if (!/\bregion\b/i.test(afterPin)) return null;
  const m = /^(.*?)\s+IN\b/.exec(afterPin);
  return m ? usableCity(m[1]) : null;
}

/**
 * City in the ordinary form: the last place-shaped run before the pincode. Commas separate address
 * lines, and where a comma is missing GoComet leaves a run of 2+ spaces doing the same job - so
 * both are honoured, in that order.
 */
function cityBeforePin(beforePin) {
  // Trailing "-", "," or ", - " all precede the pincode in real data; strip whichever occurred.
  const trimmed = beforePin.replace(/[\s,\-]+$/, '');
  const segments = trimmed.split(',').map((s) => s.trim()).filter((s) => /[A-Za-z]/.test(s));
  if (!segments.length) return null;
  // A SEGMENT THAT IS A STATE IS A STATE. Some shippers write the state where everyone else writes
  // the city ("..., DHARANGAON, MAHARASHTRA, 425105"), and taking the segment nearest the pincode
  // then prints a state under a city heading - a confidently wrong place name, which this module
  // ranks below an ugly one. Only an EXACT whole-segment match against the closed list steps back,
  // so a city that merely contains a state word is untouched, and the walk never passes the first
  // segment: an address that is nothing but a state still yields it rather than nothing.
  let i = segments.length - 1;
  while (i > 0 && isStateName(segments[i])) i -= 1;
  const last = segments[i];
  const runs = last.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
  return usableCity(runs.length ? runs[runs.length - 1] : last);
}

/**
 * Parse one end of a GoComet lane.
 *
 * @param {string} rawAddress the portal's free-text address, verbatim
 * @param {string} zipHint    origin_zip_code / destination_zip_code (may carry trailing spaces)
 * @returns {{city: string|null, state: string|null, pincode: string|null, label: string}}
 *          `label` is always renderable: "City, State" when parsed, else the cleaned raw address.
 */
function parseGoCometPlace(rawAddress, zipHint) {
  const clean = cleanAddress(rawAddress);
  const out = { city: null, state: null, pincode: null, label: collapse(clean) };
  if (!clean) return out;

  const hint = String(zipHint == null ? '' : zipHint).trim();
  const pincode = /^\d{6}$/.test(hint) ? hint : null;

  // Anchor on the LAST occurrence: an address can repeat its pincode ("Jodhpur-342024 342024
  // Jodhpur IN ..."), and the trailing one is the canonical position the tail hangs off.
  //
  // THE PORTAL'S ZIP FIELD AND THE ADDRESS DO NOT ALWAYS AGREE, and when they disagree the field
  // is not IN the string, so anchoring on it finds nothing and the whole parse used to give up on
  // an address that plainly carried a pincode of its own. The two questions are separate: the
  // field is the better answer to "what is this place's pincode", the occurrence in the string is
  // the only possible answer to "where does the tail begin". So the field is still reported, and
  // the anchor falls back to the pincode the address actually contains.
  if (pincode) out.pincode = pincode;
  let at = pincode ? clean.lastIndexOf(pincode) : -1;
  if (at < 0) {
    const found = clean.match(PINCODE_RE);
    if (found && found.length) {
      const anchor = found[found.length - 1];
      if (!pincode) out.pincode = anchor;
      at = clean.lastIndexOf(anchor);
    }
  }
  if (at < 0) return out;

  const beforePin = clean.slice(0, at);
  const afterPin = clean.slice(at + (out.pincode ? out.pincode.length : 6));

  out.city = cityFromRegionTail(afterPin) || cityBeforePin(beforePin);
  out.state = matchState(afterPin);

  if (out.city) out.label = out.state ? `${out.city}, ${out.state}` : out.city;
  return out;
}

/** Both ends of one enquiry, in the shape `_mapEnquiry` publishes as `laneParsed`. */
function parseGoCometLane(e) {
  return {
    origin: parseGoCometPlace(e && e.origin, e && e.origin_zip_code),
    destination: parseGoCometPlace(e && e.destination, e && e.destination_zip_code),
  };
}

/**
 * Fill in `laneParsed` at SERVE time on a stored record that predates the field.
 *
 * The parser landed with #186, and it only ever ran at discovery - so it populated records created
 * after the deploy and nothing before it. On the live box that is 5 of 103 GoComet price requests
 * carrying the field and 98 without, and every one of those 98 renders the shipper's full postal
 * address wherever a city belongs: the desk's worklist, and the capture page. The parser is not at
 * fault and neither is the fallback. The records simply do not hold the field.
 *
 * Derived on READ and never written back. A migration would have to rewrite
 * data/priceRequests.json, which is the live worklist the desk is working out of, and it would fix
 * only the rows that exist at the moment it runs. Deriving here costs one regex pass per row on a
 * list endpoint that already serialises the whole record, needs no write, and self-heals any future
 * record that misses the field for any reason.
 *
 * NOT persisted, NOT put on `meta`, NOT put on the durable intent - the same wall #186 drew.
 * `laneParsed` is display-only; `lane` stays the raw strings that the allowlist, the rehydrated
 * intent and the route-history lookup are all keyed on, and a derived value leaking into any of
 * those would silently re-scope them.
 *
 * Gated on the portal, not on whether parsing would succeed. SuperProcure publishes a lane that is
 * already a city name, has no laneParsed by design, and must keep rendering `lane` untouched.
 */
function hydrateLaneParsed(load, platformKey) {
  if (!load || platformKey !== 'gocomet' || load.laneParsed) return load;
  const lane = load.lane;
  if (!lane || (!lane.origin && !lane.destination)) return load;
  return { ...load, laneParsed: parseGoCometLane({ origin: lane.origin, destination: lane.destination }) };
}

// usableCity is exported so the display layer can ask "is this a place name?" with the SAME
// predicate the parser accepts a city with - two answers to that question is how a display rule
// starts drifting from the parse it is rendering.
module.exports = { parseGoCometPlace, parseGoCometLane, cleanAddress, hydrateLaneParsed, usableCity, INDIAN_STATES };
