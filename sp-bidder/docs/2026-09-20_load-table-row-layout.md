# Load-table row layout - one rule for Price Requests, Live Bids and History

Date: 2026-09-20. Status: decided and built (this PR). Supersedes the column-width arithmetic in
PR #202 and closes the two defects the 17-Aug console audit left open.

## What was wrong

The 20-Sep screenshot of Price Requests at a 1600px viewport showed:

1. "Opens in 7h 43m" painting past its 104px column into the Status badge.
2. Vehicle wrapping to three lines with "km" alone on the last one.
3. Status stacking three pills - Needs a number, Scheduled, Customer - that mean three
   different things (request state, auction-window state, margin provenance).
4. A 100px Win prob column holding a blurred placeholder on every row.
5. Lane hoarding the width while Vehicle and Closes starved.
6. Every load ~190px tall because the pickup and drop addresses rendered as a second,
   full-width row.

PR #202 (12 Aug) had made the table `table-layout: fixed` and declared a pixel width for every
column except Lane. That stopped the table blowing past its container, but it froze Vehicle at
172px and Closes at 104px forever: on a wide screen all the slack went to the one undeclared
column. Items 1 and 5 above are that arithmetic. Item 1 and the Action column being 32px short
were named in STATUS.md on 17 Aug and never fixed.

Measured on the unmodified build with the fixture set in `scripts/ui-load-tables-screenshots.js`:

| Table | At 1340px container | Overflowing cells |
|---|---|---|
| Price Requests | fits | 2 - "Opens in 7h 43m" (124 > 104) and a GoComet load id (112 > 104) |
| Live Bids | fits | 0 |
| History | 2086px wide, scrolls | 0 |

## The rule

Every table stays `table-layout: fixed` over a `<colgroup>` - that guarantee was right. A column
is one of two kinds:

- **Atomic**: holds one thing that must not wrap (load id, countdown, rupee figure, badge, button
  row). Gets a pixel width measured off the widest real value plus the 32px cell padding.
- **Flex**: holds text that wraps (lane, customer, account, vehicle). Declares nothing. The browser
  splits whatever the atomic columns leave equally between the flex columns, so they grow with
  the screen. Each table sets a floor per flex column; below it the wrapper scrolls.

Shared values live in `dashboard/src/components/load-table.tsx` with the measurement each one
came from.

## The cells

The reference search (DAT One's column-per-attribute split at wide screens; Pencil & Paper's
"multi-line cells stick to the top so everything is visible at first glance"; Carbon and
PatternFly reserving expandable rows for data not every user needs) favoured multi-line cells
over a separate detail row for a worklist that is glanced at many times a day.

- **Lane**: "City → City", then each address as a muted line inside the same cell. The
  full-width address row is gone, so one load is one `<tr>` again. When a portal publishes no
  points the server synthesises a pickup/drop pair from the lane strings; on SuperProcure that
  only repeats the label, so `displayPoints` marks it `echoesLaneEnd` and the cell drops it. The
  call is the server's because the label has had a trailing state stripped ("Bawal, HR" ->
  "Bawal"), so comparing the two strings in the component misses every state-suffixed row - which
  is exactly what the first attempt at this did. A GoComet postal address is never flagged and
  keeps its line, and neither is any point the portal actually published.
- **Vehicle**: the truck and count on line one; weight and distance on line two; cargo on line
  three. One fact per line, so no separator decides where the break lands. Distance rounds to
  whole km on the table (the price page keeps its precision).
- **Closes**: a scheduled load leads with "Opens in" and a clock icon, "Closes in" beneath. This
  is the scheduled state on screen; the Scheduled badge is gone.
- **Status**: one badge.
- **Customer**: a hand-set margin band is a small "Margin override" line under the customer it
  was set against. The "Customer" provenance tag is dropped - a profile band is the normal path.
- **Win prob**: column removed from all three tables. The lock-icon footnote under each table
  already says it comes later.
- **Load**: the tooltip names the portal the id belongs to.

## Widths

| Column | Price Requests | Live Bids | History |
|---|---|---|---|
| Load | 120 | 120 | 120 |
| Account (multi-account only) | 136 | 136 | 136 |
| Closes / Closed | 160 | 128 | 144 |
| Status | 144 | 128 | flex |
| Action | 176 | 240 | - |
| Rank / Our bid | - | 120 / 128 | - |
| Bids / Our last bid / Final rank | - | - | 72 / 112 / 88 |
| Flex floor per column | 176 | 136 | 160 |

Live Bids has ten columns and a 240px button group, so its numeric columns are sized for their
usual value and the rare wide one wraps inside the cell instead of every row paying for it.

The console caps content at 1400px, so the table is 1140px wide at a 1440 viewport and 1340px
from 1680 up. Price Requests fits both without scrolling. Live Bids and History scroll a little
at 1140px, as they did before.

## Verification

`node scripts/ui-load-tables-screenshots.js --tag=after` builds nothing; it boots the server in
mock mode, seeds one row per shape that has broken these tables (scheduled SP load with every
Vehicle fact, long customer name with a long drop address, GoComet postal-address lane, override,
stopped, dismissed, expired, and a state-suffixed lane with no portal points), screenshots the
three tables at 1440 / 1680 / 1920 and counts every cell whose content is wider than its box.
After this change: zero overflowing cells in all nine shots, and the process exits non-zero if
that ever stops being true.

It then clicks Stop on a Live Bids row and Re-arm on a stopped worklist row and measures the
confirmation state, since those controls render beside the row's other buttons inside the pinned
Action cell, which wraps rather than widening. That pass runs LAST, after every width: both
controls are real mutations against the one seeded store, so running them mid-loop left the later
widths measuring a fixture set that no longer held the stopped row.

Not covered by the harness: the Account column, which appears only when more than one
SuperProcure account is configured (mock mode has one). Its width is declared, so it takes 136px
off the flex share rather than reflowing anything.
