'use strict';

/**
 * The one outcome a closed-auction record carries. The console roll-up, the export and status pages,
 * both EODs, the heartbeat and the participation report all classify through it. Before it existed
 * the roll-up derived lost by subtraction and counted won by the flag alone, so an auction nobody
 * watched finish was a loss on the console and unknown everywhere else (R3-2 / T6 D3).
 *
 * Order is load-bearing. Zero bids of ours is a no-bid first, so a won flag earned on a shared login
 * is never credited to us. A record the sweep closed (closedWhileDown) is not known only while it
 * carries no rank: rehydrate preserves a rank it had seen, and that is a settled outcome. On a record
 * the engine finalized, `won` null means the portal had not confirmed the result, whatever rank was
 * last read live. Only an explicit null counts; a record that omits the field reads as it always did.
 */

/** -> 'no_bid' | 'won' | 'closed_unknown' | 'lost' */
function outcomeOf({ bidCount, won, closedWhileDown, finalRank, unconfirmedCount = 0 }) {
  if (!(Number(bidCount) > 0)) return unconfirmedCount > 0 ? 'closed_unknown' : 'no_bid';
  if (won === true) return 'won';
  if (closedWhileDown === true) return finalRank == null ? 'closed_unknown' : 'lost';
  if (won === null) return 'closed_unknown';
  return 'lost';
}

/** outcomeOf for a closedBids record. */
function closedOutcome(rec) {
  const r = rec || {};
  return outcomeOf({ bidCount: Array.isArray(r.ourBids) ? r.ourBids.length : 0, won: r.won,
    unconfirmedCount: (r.gcUnconfirmedSubmissions || []).length,
    closedWhileDown: r.closedWhileDown, finalRank: r.finalRank });
}

module.exports = { closedOutcome, outcomeOf };
