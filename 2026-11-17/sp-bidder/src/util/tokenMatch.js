'use strict';

/**
 * Word-boundary token match, shared by the discovery allowlist and the margin
 * resolver so a shipper/customer name matches identically in both places.
 *
 * A match requires `token` to appear in `haystack` at a word boundary (start of
 * string, or preceded by a non-alphanumeric char) - so "Ren" matches "Renewsys"
 * (word prefix) and "Syngenta" matches "Syngenta India Ltd", but "Ren" does NOT
 * sweep in "Warren Steel". Case-insensitive; a blank token never matches.
 */
function tokenMatch(haystack, token) {
  const h = String(haystack).toLowerCase();
  const t = String(token).toLowerCase().trim();
  if (!t) return false;
  const i = h.indexOf(t);
  if (i < 0) return false;
  return i === 0 || !/[a-z0-9]/.test(h[i - 1]);
}

module.exports = { tokenMatch };
