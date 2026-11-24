'use strict';

/**
 * THE one reader for a load's origin/destination pin codes.
 *
 * Extracted from server.js's renderLoadCard so the /price page and the WhatsApp ask cannot drift.
 * They already had: #114 shipped its own address-only reader in waTemplates.js while the page had
 * note recovery, so on real load 23674031 the page rendered "Kanpur 209304" and the message
 * rendered "Kanpur" - two surfaces disagreeing about the same load, each with its own copy of the
 * rule. One function, two callers, no second definition.
 *
 * WHY IT IS NOT JUST A REGEX. Measured over 2,222 real lane ends on the box:
 *   48.0%  a clean six-digit pin in the point's own address        <- the structured source
 *    2.1%  a 7+ digit run and NO clean six (the 23674031 shape)
 *   50.0%  nothing numeric at all
 *    2.3%  of the gap is recoverable from the shipper's note       <- what this adds
 *
 * The 7-digit case is systematic, not a typo: every Havells Kanpur load carries `2209304`. It is
 * deliberately NOT rescued by trimming a digit - 2209304 could be 220930 or 209304, and only the
 * note disambiguates, so guessing would be a coin flip on which district a truck is sent to.
 */

// Exactly six digits, standalone. A 7+ digit run has no word boundary after the sixth character,
// so it is refused rather than truncated - refusing beats rendering a wrong pin.
const SIX = /\b\d{6}\b/g;

/** The LAST six-digit token in a string, or null. Last, because an address ends with its pin. */
function pinIn(s) {
  const m = String(s == null ? '' : s).match(SIX);
  return m ? m[m.length - 1] : null;
}

/**
 * Split a shipper note into its origin and destination halves.
 *
 * The note is ONE string covering both ends, so lifting any six digits out of it would happily
 * stamp the origin's pin onto the drop. It is split on an explicit "Destination Address" marker -
 * the shape SuperProcure's shippers actually use - and each half read separately.
 *
 * A note without that marker yields NOTHING, on purpose. A missing pin is a non-event the desk
 * already lives with; a confidently wrong one is a truck in the wrong district.
 */
function noteHalves(notes) {
  const s = String(notes == null ? '' : notes);
  const d = s.search(/destination\s*address/i);
  if (d < 0) return { origin: '', dest: '' };
  const o = s.search(/origin\s*address/i);
  return { origin: o >= 0 && o < d ? s.slice(o, d) : '', dest: s.slice(d) };
}

/**
 * The lane's two pins: `{ from, to }`, either of which may be null.
 *
 * Points are read first-pickup / last-drop, because these annotate the already-collapsed
 * `load.lane` city pair - not the full route, which several surfaces render separately.
 *
 * The point's own address WINS when it carries a clean six digits; it is the more structured
 * source. The note is a fallback, never an override.
 */
function lanePins(load) {
  const L = load || {};
  const pts = Array.isArray(L.points) ? L.points.filter((p) => p && p.address) : [];
  const halves = noteHalves(L.notes);
  const firstPickup = pts.find((p) => p.kind === 'pickup');
  const drops = pts.filter((p) => p.kind === 'drop');
  const lastDrop = drops.length ? drops[drops.length - 1] : null;
  return {
    from: (firstPickup ? pinIn(firstPickup.address) : null) || pinIn(halves.origin),
    to: (lastDrop ? pinIn(lastDrop.address) : null) || pinIn(halves.dest),
  };
}

module.exports = { lanePins, pinIn, noteHalves };
