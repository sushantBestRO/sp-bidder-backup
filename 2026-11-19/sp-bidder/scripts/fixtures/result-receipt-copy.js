'use strict';
/**
 * The proposed wording of the result-receipt timing and attempts lines, in one place.
 *
 * The copy is not yet signed off: the owner approves it on rendered examples. When it changes, it
 * changes here, and every test that asserts a fact on one of these lines follows. Each builder takes
 * the facts (already worked out by hand in the test) and returns { label, value }: the rendered
 * message must carry one line containing the label (when there is one) and the value.
 *
 * Not a test file - it does not match scripts/test-*.js and the runner never executes it directly.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

const gap = {
  tenths: (s) => `${Number(s).toFixed(1)} s`,
  secs: (s) => `${s} s`,
  minSec: (m, s) => `${m} min ${s} s`,
};

function clock(h24, m, s = null) {
  const ap = h24 < 12 ? 'am' : 'pm';
  const h = h24 % 12 || 12;
  return `${pad2(h)}:${pad2(m)}${s == null ? '' : `:${pad2(s)}`} ${ap}`;
}

const date = (d, month, y) => `${d} ${MONTHS[month - 1]} ${y}`;

const attempts = (used, allowed, refused = 0) => ({
  label: 'Attempts',
  value: `${used} of ${allowed} used${refused ? `, ${refused} refused by the portal` : ''}`,
});

const lastBid = (gapText, clockText) => ({ label: 'Last bid', value: `${gapText} before the final close (${clockText})` });
// CW-267 (owner, 29 Sep 2026): a bid the close moved past after it is timed to its own round close.
const lastBidRound = (gapText, clockText) => ({ label: 'Last bid', value: `${gapText} before the round close (${clockText})` });

const closed = (clockText, postedClock = null) => ({
  label: 'Closed',
  value: `${clockText}${postedClock ? ` (posted ${postedClock})` : ''}`,
});

const extensions = (n, byOthers = false) => ({
  label: null,
  value: `Extended ${n} time${n === 1 ? '' : 's'} ${byOthers ? 'by other bids after ours' : 'after our last bid'}`,
});

// RETIRED by the owner on 2026-09-24 (one gap per message, always to the final close): this sentence
// must not appear on any result. Kept so tests can assert its absence.
const extended = (n, gapText) => ({
  label: null,
  value: `Extended ${n} time${n === 1 ? '' : 's'} after our last bid. Our last bid was ${gapText} before the close at that time.`,
});

const unknownClose = (ranPastClock) => ({ label: 'Closed', value: `may have run past ${ranPastClock}` });

const handWin = (n, platformLabel, capText) => ({
  label: null,
  value: `Won on a bid placed by hand from this login. Bid Command's ${n} attempt${n === 1 ? ' was' : 's were'} `
    + `refused by ${platformLabel}: it allowed ₹${capText} or less.`,
});

// RETIRED by owner ruling 26 Sep 2026: superseded by outbidOnPrice, sourced straight off the
// existing loss-cause classifier (resultReasonOf) rather than this independently-derived "was our
// last bid at the lowest margin" guess. Kept so tests can assert its absence.
const lowestMargin = (pctText) => ({
  label: null,
  value: `Our last bid was at your lowest margin (${pctText}%). Another transporter bid lower.`,
});

// Owner ruling 26 Sep 2026 - the lost_on_price loss-cause line. rupeeText/pctText are the already-
// formatted marginRate/marginPct off the record (comma-grouped rupees, two-decimal signed percent).
const outbidOnPrice = (rupeeText, pctText) => ({
  label: null,
  value: `Outbid on price. Our lowest price, ₹${rupeeText} (${pctText}%), was on the board and another transporter bid lower. Winning this lane needs a lower margin.`,
});

const SHARPER_RATE = { label: null, value: 'A sharper rate on this lane wins the next one.' };

const EXPORT_HEADERS = { bidTime: 'Bid Time' };

// Dropped from the every-bid sheet by owner ruling 29 (24 Sep 2026) in favour of the per-load sheet.
const RETIRED_BID_COLUMNS = ['Close at Bid', 'Secs Before Close at Bid', 'Final Close', 'Secs Before Final Close'];

// The per-load sheet, owner-approved names verbatim.
const LAST_BID_HEADERS = ['OA', 'Our last bid', 'Last bid, secs before close', 'Bid in final seconds?', 'At lowest margin?',
  'Undercut after our bid?', 'Result'];

// named reversal: D027 - `won` is the SP-default wording (an untagged/legacy record resolves to
// SP, same as every other reader): SuperProcure has no award signal, so a plain "Won" overstated
// a confirmed allotment. GoComet's own won flag keeps the plain word (its own oracle, not used
// here since every consumer of this fixture is an SP or untagged fixture today).
const RESULT_WORDS = {
  won: 'Won (rank 1 at close)', lost_on_price: 'Lost on price', lost_on_timing: 'Lost on timing (our fault)',
  undercut_while_leading: 'Undercut while leading', no_bid_portal_closed_early: 'No bid: portal closed early',
};

const earlyClose = (endedClock, gapText, publishedClock) => ({
  label: null,
  value: `\u26a0 Portal closed this auction early at ${endedClock}, ${gapText} before its published close (${publishedClock})`,
});

module.exports = { gap, clock, date, attempts, lastBid, lastBidRound, closed, extensions, extended, unknownClose, handWin, lowestMargin, outbidOnPrice, SHARPER_RATE, EXPORT_HEADERS,
  RETIRED_BID_COLUMNS, LAST_BID_HEADERS, RESULT_WORDS, earlyClose };
