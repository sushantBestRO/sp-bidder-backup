'use strict';

/**
 * Shared truncation for capability tokens (price-request tokens, capture-link path
 * segments) that must never reach a log line whole - the token IS the auth for the
 * public /price/<token> and /track/<token> pages, so a log leak lets anyone lift it
 * and act on a live auction with no session. Truncates to a short, non-reconstructable
 * prefix; used identically wherever a token (bare, or embedded in a URL/path) is about
 * to be logged, so this stays the ONE place that decides how much of a token is safe
 * to print - not three independently-drifting copies.
 */
function redactToken(t) {
  return `${String(t).slice(0, 6)}...`;
}

module.exports = { redactToken };
