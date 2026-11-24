'use strict';
/**
 * A load whose auction ended while the bot was down must not read as a LOSS.
 *
 * THE DEFECT. exportModel.deriveStatus classified any closed-bids record carrying at least one
 * landed bid as won-or-lost, with nothing in between. A record retired by the restart sweep carries
 * exactly that shape - real bids on the board, no final rank, no won - so every orphaned auction was
 * charged to the loss column and the win rate was computed against auctions nobody saw the end of.
 * 52 GoComet records were in that state on the box.
 *
 * The honest third answer is UNKNOWN, and it has to be visible everywhere the other two are: the
 * console's History badge and both downloadable views.
 *
 *   A. deriveStatus red-green: closedWhileDown + landed bids + no rank -> closed_unknown, never lost.
 *   B. the neighbours it must NOT disturb - a real loss, a real win, a zero-bid close, a live load,
 *      and a closedWhileDown record whose rank WAS preserved (that one is a genuine known outcome).
 *   C. the label is plain English and identical in both exporters, and never an em dash (these
 *      strings reach a director).
 *   D. the win rate excludes it. Counting an unknown as a loss is the arithmetic this fix exists to
 *      stop, so the roll-up is asserted, not assumed.
 *   G. the console's two summary strips ADD UP. Both switch on status and neither branch existed, so
 *      the row was counted in the raw enquiry total and in no bucket - the tiles stopped summing
 *      with nothing on screen naming where it went. Includes the dashboard's own mirror, which the
 *      server fix does not reach.
 *
 *   node scripts/test-closed-unknown-surfacing.js
 */
const assert = require('assert');
const fs = require('fs'); // allowed: test harness (reads the dashboard's own source), not app state
const path = require('path');
const {
  deriveStatus, canonical, funnelView, outcomesView, summarize, summarizeHistory,
  FUNNEL_HEADERS, OUTCOMES_HEADERS,
} = require('../src/web/exportModel');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The exact wording that reaches the desk. Stated once here so a drift in either exporter or the
// console badge is a failure rather than a quiet divergence. First person plural because the
// desk-voice gate forbids naming this system as automation on any readable surface - see
// scripts/test-desk-voice.js, which is where that constraint is enforced and argued.
const UNKNOWN_LABEL = 'Unknown - we could not see how this auction ended';

const bid = (price, ts) => ({ price, rungIndex: 0, rank: null, ts });
// platformKey: 'gocomet' matches orphan()'s own tag below (this whole fixture is the GoComet
// restart-orphan shape, per the file's own header) - canonical() prefers the request side when
// resolving platform, so without this tag a D027 SP caveat would wrongly reach a GoComet row.
const req = (over = {}) => Object.assign({
  loadId: 'GC-1', status: 'closed', capturedAt: Date.now() - 7_200_000, platformKey: 'gocomet',
  load: { companyName: 'Waaree Energies', lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1 },
  price: { cost: 50_000 },
}, over);

// The shape the restart sweep leaves behind: bids landed, nothing settled.
const orphan = (over = {}) => Object.assign({
  auctionId: 'GC-1', shipper: 'Waaree Energies', platformKey: 'gocomet',
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
  cost: 50_000, ourBids: [bid(56_300, Date.now() - 7_100_000)], lastBidPrice: 56_300,
  finalRank: null, won: null, closedWhileDown: true, status: 'closed',
  closedAt: Date.now() - 7_000_000, armedAt: Date.now() - 7_200_000,
}, over);

// ---- A. the classification itself ---------------------------------------------------------------

ok(deriveStatus(req(), orphan()) === 'closed_unknown',
  `A: a closedWhileDown record with landed bids and no rank is closed_unknown (got '${deriveStatus(req(), orphan())}')`);
ok(deriveStatus(req(), orphan()) !== 'lost',
  'A: and is NEVER lost - that is the phantom loss this whole change exists to remove');
// won:false rather than null is the OTHER shape the sweep can leave (bidLogger coerces), and it must
// classify the same way. Reading closedWhileDown, not the won field, is what makes that true.
ok(deriveStatus(req(), orphan({ won: false })) === 'closed_unknown',
  'A: ...including when won was coerced to false rather than left null - the flag decides, not won');

// ---- B. every neighbouring case is undisturbed ---------------------------------------------------

ok(deriveStatus(req(), orphan({ closedWhileDown: false, won: false })) === 'lost',
  'B: an ordinary fought loss is still lost');
ok(deriveStatus(req(), orphan({ closedWhileDown: false, won: true, finalRank: 1 })) === 'won',
  'B: an ordinary win is still won');
ok(deriveStatus(req(), orphan({ ourBids: [] })) === 'no_bid',
  'B: a close that landed nothing is still no_bid, flag or not - "nothing landed" is knowable');
ok(deriveStatus(req({ status: 'armed' }), null) === 'armed',
  'B: a load with no outcome record still carries its funnel status');
// The one closedWhileDown case that is NOT unknown: rehydrate preserves a rank when it had one, and
// a preserved rank is a real result. Treating that as unknown would throw away a settled outcome.
ok(deriveStatus(req(), orphan({ finalRank: 4 })) === 'lost',
  'B: a closedWhileDown record whose final rank WAS preserved is a known outcome, not unknown');
ok(deriveStatus(req(), orphan({ finalRank: 1, won: true })) === 'won',
  'B: ...and a preserved WIN survives the sweep as a win');

// ---- C. the label, in both exporters -------------------------------------------------------------

const row = canonical(req(), orphan());
ok(row.status === 'closed_unknown', 'C: the canonical row carries the new status through to the views');

const outRow = outcomesView([row]).rows[0];
const resultCol = OUTCOMES_HEADERS.indexOf('Result');
ok(outRow[resultCol] === UNKNOWN_LABEL,
  `C: the outcomes export's Result column reads "${UNKNOWN_LABEL}" (got "${outRow[resultCol]}")`);

const funRow = funnelView([row]).rows[0];
const statusCol = FUNNEL_HEADERS.indexOf('Status');
ok(funRow[statusCol] === UNKNOWN_LABEL,
  `C: the funnel export's Status column reads the same plain label (got "${funRow[statusCol]}")`);

// No em dash anywhere in a string a director reads. Checked as a character, not by eye.
ok(!/[–—]/.test(UNKNOWN_LABEL), 'C: the label contains no en/em dash');
ok(!/[–—]/.test(String(outRow[resultCol])) && !/[–—]/.test(String(funRow[statusCol])),
  'C: ...and neither exporter introduces one');

// The existing labels are untouched - this added a third answer, it did not relabel the other two.
const wonRow = canonical(req(), orphan({ closedWhileDown: false, won: true, finalRank: 1 }));
const lostRow = canonical(req(), orphan({ closedWhileDown: false, won: false }));
ok(outcomesView([wonRow]).rows[0][resultCol] === 'Won', 'C: "Won" is unchanged');
ok(outcomesView([lostRow]).rows[0][resultCol] === 'Lost', 'C: "Lost" is unchanged');
ok(funnelView([lostRow]).rows[0][statusCol] === 'lost',
  'C: and the funnel Status column still prints every OTHER status as its raw key - saved files stay comparable');

// ---- D. the win rate excludes it ------------------------------------------------------------------

const summary = summarizeHistory([
  canonical(req({ loadId: 'W1' }), orphan({ auctionId: 'W1', closedWhileDown: false, won: true, finalRank: 1 })),
  canonical(req({ loadId: 'L1' }), orphan({ auctionId: 'L1', closedWhileDown: false, won: false })),
  row, // the unknown
]);
ok(summary.won === 1 && summary.lost === 1,
  `D: the unknown is counted as neither a win nor a loss (won ${summary.won}, lost ${summary.lost})`);
ok(summary.winPct === 50,
  `D: so the win rate is over DECIDED auctions only and reads 50%, not 33.3% (got ${summary.winPct}%)`);
ok(summary.enquiries === 3, 'D: while the row itself is still counted as an enquiry - it is hidden from nothing');

// ---- E. the sibling Won column must not contradict the Status column --------------------------

// Both are derived from the SAME record a few lines apart, so fixing only `status` made one exported
// row say "outcome unknown" and "Won: No" simultaneously. Before the unknown status existed the two
// were wrong together and at least agreed.
ok(row.won === null,
  `E: an unknown outcome carries won null, not a coerced false (got ${JSON.stringify(row.won)})`);
const wonCol = FUNNEL_HEADERS.indexOf('Won');
ok(funRow[wonCol] === '',
  `E: so the funnel export's Won column is blank, not "N", on the row whose Status says unknown (got "${funRow[wonCol]}")`);
ok(funnelView([lostRow]).rows[0][wonCol] === 'N', 'E: a real loss still prints "N"');
ok(funnelView([wonRow]).rows[0][wonCol] === 'Y', 'E: and a real win still prints "Y"');

// ---- F. an authoritative result clears the flag ------------------------------------------------

// The flag is sticky on the durable record, so a load retired as unknown and LATER settled for real
// must not keep reading as unknown. deriveStatus keys on flag + null rank, and _finalize writes a
// null rank whenever the last read fails - so without a clear, a fought loss reverts to unknown and
// drops out of the win-rate denominator. bidLogger._onResult owns the clear; this pins the shape it
// has to produce.
ok(deriveStatus(req(), orphan({ closedWhileDown: false, finalRank: null, won: false })) === 'lost',
  'F: once a real result lands and clears the flag, a null-rank close reads as the loss it is');

// ---- G. the console's two summary strips add up ------------------------------------------------

// Both switch on the same status and neither was extended, so the row was counted in the raw
// enquiry/inquiry total and in no bucket: the tiles on the Export page's Live funnel and the History
// strip stopped summing, with nothing on either screen naming where the row went. These are the
// desk's live consoles, and this is the same defect the diff fixed for the offline report.
{
  const rows = [
    canonical(req({ loadId: 'W1' }), orphan({ auctionId: 'W1', closedWhileDown: false, won: true, finalRank: 1 })),
    canonical(req({ loadId: 'L1' }), orphan({ auctionId: 'L1', closedWhileDown: false, won: false })),
    canonical(req({ loadId: 'N1' }), orphan({ auctionId: 'N1', ourBids: [] })),
    canonical(req({ loadId: 'S1', status: 'skipped_no_price', capturedAt: null }), null),
    canonical(req({ loadId: 'D1', status: 'dismissed', capturedAt: null }), null),
    canonical(req({ loadId: 'A1', status: 'armed' }), null),
    canonical(req({ loadId: 'U1' }), orphan({ auctionId: 'U1' })), // the unknown
  ];

  const s = summarize(rows);
  ok(s.closedUnknown === 1, `G: summarize counts the unknown in its own bucket (got ${s.closedUnknown})`);
  ok(s.lost === 1, 'G: and not in lost');
  // `inquiries` is a raw rows.length, so a row in no bucket is the strip failing to reconcile.
  ok(s.won + s.lost + s.noBid + s.skipped + s.dismissed + s.closedUnknown + 1 === s.inquiries,
    `G: the Live funnel buckets plus the one open row account for every inquiry (${s.inquiries})`);

  const h = summarizeHistory(rows);
  ok(h.closedUnknown === 1, `G: summarizeHistory counts it too (got ${h.closedUnknown})`);
  ok(h.won + h.lost + h.noBid + h.skipped + h.dismissed + h.open + h.closedUnknown === h.enquiries,
    `G: and the History tiles sum exactly to enquiries (${h.enquiries})`);
  ok(h.winPct === 50, `G: the win rate is still over decided auctions only (got ${h.winPct}%)`);
}

// The console renders its OWN mirror of summarizeHistory over the portal-filtered rows (the server
// summary is all-portal), so the server fix alone leaves the screen wrong. There is no JS test
// harness for the dashboard, and tsc cannot catch a missing branch in an if/else chain - so this
// reads the source. Crude, and it is the only thing standing between the two copies.
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'src', 'pages', 'History.tsx'), 'utf8');
  ok(/r\.status === 'closed_unknown'/.test(src),
    'G: History.tsx\'s local summarize() branches on closed_unknown - without it the mirror silently drops the row');
  ok(/closedUnknown/.test(src) && /label="Unknown"/.test(src),
    'G: ...and the count reaches a tile, so the screen names where the row went');
}

const EXPECTED_CHECKS = 33;
assert.strictEqual(fail, 0, `${fail} closed-unknown surfacing checks failed`);
assert.strictEqual(pass, EXPECTED_CHECKS,
  `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - a block was skipped`);
console.log(`\n${pass} passed, ${fail} failed`);
