'use strict';

/**
 * Read the load's PHYSICAL SPEC out of the strings GoComet already sends us.
 *
 * The desk's complaint was that the price page showed "FTL x1" under Vehicle. FTL is the
 * enquiry's `mode` - a shipment mode, the same word on every FTL load - and it was reaching the
 * vehicle slot because _mapEnquiry built `equipment` as `e.mode || join(e.quantity)`, so the mode
 * short-circuited the one field that actually names a truck. The truck type was never absent from
 * the wire; it was outranked. Captured live enquiry 2608115VVB carries
 *   quantity:     ["1 x 32FTSXL (LxWXH  32'x8'x8'8\") 7 Ton Truck"]
 *   gross_weight: ["1 x 32FTSXL (LxWXH  32'x8'x8'8\") 7 Ton Truck 7000.0 KG"]
 * on the spot LIST and the enquiry DETAIL respectively - both responses this adapter already
 * makes. Nothing here needs a new call.
 *
 * Everything below fails to null rather than guessing. A wrong truck type or a wrong weight on a
 * pricing screen is worse than an omitted tile: the tile simply does not render, which is the
 * state the desk already lives with, whereas a confident wrong number gets priced against.
 */

/** Descriptors carry a non-breaking space inside the dimension block; collapse before matching. */
function tidy(s) {
  return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
}

/**
 * The dimension block out of an already-tidied descriptor, verbatim.
 *
 * Runs as a SEPARATE pass over `tidied`, before parseCargoDescriptor's own paren-strip, so it
 * can never influence vehicleType or ratedTonnes - those two must stay byte-identical to what
 * they were before dimensions existed (see parseCargoDescriptor's own comment for why the strip
 * has to run before the tonnage regex).
 *
 * A descriptor can carry more than one parenthesised group - a size and, separately, a weight
 * ("(Weight 18 MT)", "(12 Ton)") - and the two have to be told apart without a size marker being
 * mandatory ("(20*8*9.6)" has none). The rule: strip the LxWxH marker and any leading dash, take
 * only the text before a joined weight ("&Wt.18.5 MT"), then delete every digit, dot, foot/inch
 * mark and space. A real dimension block has nothing left but its own separator characters - the
 * unit letters live in the block's LxWxH marker or its trailing weight, not lodged inside the
 * numbers - so "40'x10'x10\"" reduces to two separators, while "Weight 23 MT" reduces to
 * "WeightMT" and "12 Ton" to "Ton": both keep letters and are refused. The first group to pass
 * wins, so a size that precedes a weight group is found before the weight is even considered.
 *
 * THE DASH STRIP ACCEPTS THE TYPOGRAPHIC DASHES, NOT JUST THE ASCII ONE. This feed is already
 * proven not to be ASCII-clean - the live fixture separates the marker from the numbers with a
 * U+00A0 - so an en- or em-dash in the same slot is a plausible shape rather than a hypothetical,
 * and it would otherwise refuse a perfectly good size and silently drop the tile.
 *
 * Shapes it still refuses, all in the safe direction (no tile, exactly as before this existed):
 * an "LBH"/"LxBxH" marker, units written inside the numbers ("20ft x 8ft"), a two-dimensional
 * size, and a weight written BEFORE the size in one &-joined group. None appears in the 100
 * distinct real descriptors on record; widen this only against a descriptor actually seen.
 */
function parseDimensions(tidied) {
  const groups = tidied.match(/\(([^)]*)\)/g) || [];
  for (const g of groups) {
    const value = g.slice(1, -1)
      .replace(/^\s*L\s*[x*×]\s*W\s*[x*×]\s*H\s*/i, '')
      .replace(/^\s*[-–—]\s*/, '')
      .split('&')[0]
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) continue;
    const skeleton = value.replace(/[0-9.'"’”\s]/g, '');
    if (skeleton.length >= 2 && /^[xX*×]+$/.test(skeleton)) return value;
  }
  return null;
}

/**
 * Strip the parts of a descriptor that are not the truck type, leaving the type alone.
 *
 * "1 x 32FTSXL (LxWXH 32'x8'x8'8\") 7 Ton Truck" -> "32FTSXL". The leading count, the
 * parenthesised dimensions, the tonnage and the trailing noun all come off; whatever survives is
 * the shipper's own name for the vehicle and is passed through verbatim rather than mapped to a
 * house vocabulary, because BRL's desk reads GoComet's words on GoComet's portal.
 *
 * Returns null when nothing recognisable survives, so the Vehicle tile is omitted rather than
 * printing a fragment.
 */
function parseCargoDescriptor(descriptor) {
  const s = tidy(descriptor);
  if (!s) return null;
  const dimensions = parseDimensions(s);
  const head = /^(\d+(?:\.\d+)?)\s*[xX]\s*(.+)$/.exec(s);
  const count = head ? Number(head[1]) : null;
  let rest = head ? head[2] : s;
  rest = rest.replace(/\([^)]*\)/g, ' ');
  // The tonnage is read BEFORE it is stripped, and only outside the dimension block - the
  // dimensions carry their own numbers ("32'x8'x8'8") and matching inside them would read a
  // height as a payload.
  const ton = /(\d+(?:\.\d+)?)\s*(?:TONS?|TONNES?|MT)\b/i.exec(rest);
  rest = rest.replace(/(\d+(?:\.\d+)?)\s*(?:TONS?|TONNES?|MT)\b/gi, ' ')
    .replace(/\b(?:TRUCKS?|VEHICLES?|CONTAINERS?)\b/gi, ' ')
    .replace(/[\s,\-]+/g, ' ')
    .trim();
  return {
    count: Number.isFinite(count) && count > 0 ? count : null,
    vehicleType: formatVehicleType(rest, ton ? Number(ton[1]) : null),
    ratedTonnes: ton ? Number(ton[1]) : null,
    dimensions,
  };
}

/**
 * The truck type as a pricer reads it: "32 ft SXL, 7 T", "20 ft ODC, 10 T", "19 ft".
 *
 * GoComet writes the type as one run-together token ("32FTSXL", "20FTODC"), which is legible but
 * not at a glance, and the register the desk already reads on this page is SuperProcure's spaced
 * "32 SXL 9T HQ". So the footage is split off and lower-cased to "ft" and whatever the shipper
 * appended - SXL, ODC, HQ - is preserved verbatim after it. ODC in particular is not decoration:
 * an over-dimensional consignment needs a different vehicle and a different price.
 *
 * The tonnage here is the vehicle's RATED capacity, part of its name, and it is deliberately shown
 * inside the vehicle string rather than promoted to the Weight tile - see readLoadSpec for why
 * those are two different facts.
 *
 * Returns null when nothing survives. A bare "TRUCK" descriptor is the most common shape in the
 * captured sample and it reduces to exactly that: no type was published, so the Vehicle tile is
 * omitted rather than printing an empty one, a dash, or the word "Truck" as though it were a spec.
 */
function formatVehicleType(raw, ratedTonnes) {
  const s = tidy(raw).replace(/^\d+(?:\.\d+)?\s*[xX]\s*/, '').replace(/^[\s,\-]+|[\s,\-]+$/g, '');
  // A type has to contain a letter. Digits and punctuation alone are what is left when a malformed
  // descriptor ("1 x ") loses its noun, and "1 x" under a Vehicle heading reads as a rendering
  // fault. A letter-bearing string we cannot decompose IS passed through verbatim rather than
  // suppressed - an unfamiliar shape like "Trailer Lowbed" is indistinguishable from a corrupt one
  // at this level, and hiding the portal's own words would cost the desk more than an odd label.
  if (!s || !/[A-Za-z]/.test(s)) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(?:FT|FEET)\s*(.*)$/i.exec(s);
  const body = m
    ? `${m[1]} ft${m[2].trim() ? ` ${m[2].trim().toUpperCase()}` : ''}`
    : s;
  return ratedTonnes != null ? `${body}, ${ratedTonnes} T` : body;
}

/**
 * The declared weight of ONE unit, in MT.
 *
 * `gross_weight` is the same descriptor with a number and a unit appended, and it is PER UNIT, not
 * a load total - proven in the field inventory against a 2-truck load whose entry read
 * "2 x ... 25000.0 KG" beside a total_gross_weight_mt of 50. Reading it as a total would halve
 * every multi-truck load's declared weight on the page.
 *
 * KG is normalised to MT because that is the unit BRL's desk quotes in and the unit the same tile
 * already shows for SuperProcure. The conversion is refused rather than rounded when it would not
 * land within 2dp, so an odd value stays in the unit GoComet actually sent it in.
 */
function parseGrossWeight(entry) {
  const s = tidy(entry);
  const m = /(\d+(?:\.\d+)?)\s*(KGS?|MT|TONS?|TONNES?)\s*$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toUpperCase();
  if (unit.startsWith('KG')) {
    const mt = n / 1000;
    return Number(mt.toFixed(2)) === mt ? { weight: mt, weightUnit: 'MT' } : { weight: n, weightUnit: 'KG' };
  }
  return { weight: n, weightUnit: 'MT' };
}

/** The custom column the shipper fills with the road distance, or null when it is not present. */
function readDistanceKm(customColumns) {
  if (!Array.isArray(customColumns)) return null;
  // Prefix-matched, not equality-matched: the key carries the shipper's whole question in it
  // ("distance_in_km_from_the_loading_location_pol_to_the_delivery_location_pod") and there is no
  // reason to believe every shipper phrases the tail identically. NOT `\b` after "km" - the next
  // character is an underscore, which is a word character, so a word boundary never matches there
  // and the column was silently never found.
  const col = customColumns.find((c) => c && typeof c.key === 'string' && /^distance_in_km(?:_|$)/.test(c.key));
  if (!col) return null;
  const n = Number(col.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Every truck type on the load, each with its own count: [{label: '40 ft, 25 T', count: 5}, ...].
 *
 * The desk needs this because a multi-type load is now bid off ONE per-truck rate applied to every
 * type. A pricer who cannot see that the load carries a 40 ft AND a 20 ft ODC will type a rate for
 * the shape they think they are looking at, and it goes on both.
 *
 * ALL-OR-NOTHING. One unparseable descriptor returns null for the whole load rather than a list
 * missing a type, because a list that silently omits one is worse than no list at all - it looks
 * complete. The surfaces then fall back to rendering the raw descriptors, which are long but whole.
 */
function cargoTypeList(descriptors) {
  if (!Array.isArray(descriptors) || !descriptors.length) return null;
  const out = [];
  const seen = new Set();
  for (const d of descriptors) {
    const p = parseCargoDescriptor(d);
    if (!p || !p.vehicleType || !Number.isInteger(p.count) || p.count <= 0) return null;
    const match = chargeMatchToken(d);
    // A blank or repeated token cannot identify a line, and a per-type rate keyed on it would be
    // guessing which truck it belongs to. Suppress the WHOLE list rather than emit a type that
    // cannot be joined - same all-or-nothing reason as the parse failure above.
    if (!match || seen.has(match)) return null;
    seen.add(match);
    out.push({ label: p.vehicleType, count: p.count, match,
      ...(p.dimensions ? { dimensions: p.dimensions } : {}) });
  }
  return out;
}

/**
 * The join key between a `quantity` descriptor the desk reads and the freight-charge KEY the bid
 * is written onto. They are the same string in two encodings, and that is what makes a per-truck-
 * type rate safe to route:
 *
 *   descriptor  "5 x 40FT (LXWXH - 40'X8'X8.8') 25 TONS Truck"
 *   charge key  "freight_charges_custom_charge_40ft_(lxwxh_-_40'x8'x8.8')_25_tons"
 *
 * GoComet builds the key from the descriptor by dropping the leading count and the trailing noun,
 * lower-casing, and swapping spaces for underscores. Verified against all four captured multi-line
 * quotes (Q9LG, SXV9, KQIF) plus their enquiries. Reducing both sides to their letters and digits
 * therefore matches on content rather than on POSITION - which matters because the descriptors and
 * the charge lines arrive on two independent fetches, and their own prior bot carried a
 * "if no cargoIndex match, use array index" fallback, i.e. its author had already hit the reorder
 * that silently swaps prices between truck types.
 *
 * Caller strips the `freight_charges_custom_charge_` prefix; everything else is handled here.
 */
function chargeMatchToken(s) {
  return String(s == null ? '' : s)
    .replace(/^\s*\d+(?:\.\d+)?\s*[xX]\s*/, '')
    // Separators collapse to real spaces BEFORE the noun strip, so \b - which never fires across
    // an underscore - sees the same word boundaries whichever encoding this string arrived in.
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .replace(/\b(?:TRUCKS?|VEHICLES?|CONTAINERS?)\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * The load's spec, assembled from the list item and (when we have it) the enquiry detail.
 *
 * THE TWO TONNAGES ARE NOT THE SAME FACT AND ARE NEVER SUBSTITUTED FOR EACH OTHER. The "7 Ton" in
 * "32FTSXL (...) 7 Ton Truck" is the VEHICLE'S RATED CAPACITY - part of the truck's name, the same
 * way SuperProcure's "32 SXL 9T HQ" carries a 9T - while gross_weight's trailing "7000.0 KG" is the
 * DECLARED WEIGHT OF THE GOODS. They coincide on every captured load, which is exactly what makes
 * this an easy and invisible error: a 22-ton trailer running 14 tonnes of cargo is an ordinary
 * load, and printing 22 MT in the Weight tile there would misstate the consignment.
 *
 * So the rated figure stays inside the vehicle string and the Weight tile is fed ONLY by
 * gross_weight. When the enquiry detail was skipped, throttled or failed there is no declared
 * weight, and the tile is omitted rather than back-filled from the truck's name.
 */
function readLoadSpec(listItem, detail) {
  const src = detail || listItem || {};
  const descriptors = [listItem, detail]
    .map((o) => (o && Array.isArray(o.quantity) ? o.quantity.filter(Boolean) : null))
    .find((a) => a && a.length) || [];
  // Only a SINGLE-cargo enquiry gets a one-vehicle spec. A multi-descriptor load is several truck
  // types at once and has no one vehicle/weight to print, so collapsing it into one tile would
  // name a type that is only one of the several on it. Since 2026-08-19 such a load IS bid - one
  // per-truck rate written to every type - which makes that collapse worse than it was, not
  // better: the desk would price a load believing it had one shape. `cargoTypes` below is what
  // the surfaces render instead.
  const parsed = descriptors.length === 1 ? parseCargoDescriptor(descriptors[0]) : null;
  const grossList = Array.isArray(src.gross_weight) ? src.gross_weight.filter(Boolean) : [];
  const gross = grossList.length === 1 ? parseGrossWeight(grossList[0]) : null;

  return {
    cargoTypes: cargoTypeList(descriptors),
    vehicleType: parsed ? parsed.vehicleType : null,
    // The enquiry's own mode word ("FTL"), which is a real fact about the shipment and belongs in
    // the Shipment tile - it is only wrong in the Vehicle tile.
    shipmentType: typeof src.mode === 'string' && src.mode.trim() ? src.mode.trim() : null,
    weight: gross ? gross.weight : null,
    weightUnit: gross ? gross.weightUnit : null,
    distanceKm: readDistanceKm(src.custom_columns),
    dimensions: parsed ? parsed.dimensions : null,
  };
}

module.exports = { parseCargoDescriptor, parseGrossWeight, readDistanceKm, readLoadSpec, parseDimensions, cargoTypeList, chargeMatchToken };
