# Data export + filters - scope

**Status: SCOPE FOR REVIEW. Not an implementation.** This document specifies a
filtered-export capability for the pricing desk and director. It touches no source; it
is the build brief a follow-on PR implements once the direction and the open questions
below are agreed.

**Date:** 2026-07-24
**Base:** `origin/main` = `8851d49` (`fix(heartbeat): repoint CORE_ADMINS 'Sid' ... (#69)`)
**Method:** read-only pass over the code on `origin/main` + a read-only SSH sample of the
live production stores (`data/closedBids.json`, `data/priceRequests.json`) on the VPS. No
source edited, no config changed, no write to the box.

---

## 0. The ask, in one line

The director "needs all sorts of filters for data exports." He lives in Excel; the report
he compares against is SuperProcure's own `.xlsx` participation export. He wants to slice
the bid/auction data every which way and pull it out.

The honest starting point: **a full CSV export system already ships** (six streams, a
date-range Export page, per-page download buttons - `src/web/exports.js`,
`dashboard/src/pages/Export.tsx`, `docs/CSV_EXPORTS_SCOPE.md` section 10). What is missing is
exactly the two things the director actually asked for and the one thing that makes them
usable:

1. **Filters other than date.** Today the only export filter is a date range. Customer,
   branch, outcome, rank, vehicle, lane, account - none of them narrow a file. The on-screen
   Won/Lost tabs and search on History are explicitly *not* reapplied to the export
   (`History.tsx:133-135`).
2. **A true `.xlsx`, not CSV.** There is no spreadsheet library anywhere in the repo (backend
   deps are `ajv, dotenv, express, puppeteer-core, socket.io-client`; the dashboard has no
   `xlsx`/`exceljs`). Excel *opens* the CSV, but it is not the filtered, frozen-header,
   number-formatted workbook the director works in.
3. **A durable history to filter over.** The funnel store is pruned 7 days after an auction
   closes (`priceRequests.js:124,688-701`) and hard-deletes out-of-allowlist loads
   (`priceRequests.js:612-625`). "Export last quarter's participation" is **impossible today** -
   there is no ledger that survives the prune. This is the prerequisite for real historical
   export and is scoped as foundational below.

---

## 1. Executive summary

1. **The single most important requirement is reconciliation with SuperProcure's own export.**
   Our records are keyed by **auction date**; SP's export is keyed by shipment **loading
   date**, and SP auctions run 1-2 days before the truck loads. So "7 KEI inquiries today" on
   our side and "10 KEI loads" on SP's export never tie out, even when nothing is wrong. A
   director-grade export must carry the **SP Load Id** (the join key we already have), **both**
   the auction date/time and the loading date, and the SP-comparable fields (branch, origin,
   destination, distance, our last quoted rate, our rank) so the two datasets can be joined in
   Excel. Without this the director cannot trust either number.

2. **The director's real question is participation, not just win rate.** Live right now:
   **156 of 383 loads priced = 41% participation** over the retained ~7-day window. Per
   shipper it swings wildly - **Havells 4/99 = 4%**, Syngenta 85%, Durian 61%, Ashirvad
   0/14. The win-rate tiles on History (`summarizeClosed`, `bidLogger.js:356`) compute
   `lost = total - won` over *only the loads someone armed*, so the 55-59% of loads that were
   never priced are invisible. The export must span the whole funnel with a per-load status so
   "priced vs skipped", participation ratio, and missed-cutoff are all filterable.

3. **The fastest way to deliver "all sorts of filters" is to make every dimension a column
   and ship a proper `.xlsx` with Excel AutoFilter on.** Then the director filters in his own
   tool with zero round-trips. Server-side pre-filtered exports (and saved views) are the
   second layer for the queries he runs repeatedly. Lead with the wide, self-describing
   workbook.

4. **Branch must be a first-class filter dimension.** The director explicitly wants Havells
   Alwar treated separately (his max-volume branch). `branchName` is on the load
   (`Alwar Cable (1350)` etc.) and is captured on newer price-requests (184 of 383 live) but is
   **not** on the `closedBids` outcome record at all, and the bot routes by *customer*, not
   branch. Branch is display/analytics-only today; making it a durable, always-present export
   column is part of the ledger work.

5. **Phase 1 (filter + `.xlsx` over the current rolling window) is largely Module-2-rollout
   polish and ships fast. The durable ledger + historical export is genuinely new priced
   work.** The commercial split is called out per dimension in section 9.

---

## 2. The director's mental model - filters as answers to questions

Filters should be designed as answers to the questions the director actually asks of this
data, not as a dropdown inventory. The questions, and the filter/column that answers each:

| The question he asks | What answers it |
|---|---|
| "How many of Havells' loads did we even bid on?" | participation ratio, filtered by customer + branch |
| "Show me everything for Havells Alwar, last 30 days" | branch filter + auction-date range |
| "Which of these did we lose, and by what rank?" | outcome = lost, plus final-rank column/filter |
| "What did we quote vs what SuperProcure shows?" | reconciliation columns (Load Id, loading date, our last bid, our rank) joined to SP's export |
| "Where are we bleeding loads - is it pricing speed or losing the auction?" | funnel status per load (skipped_no_price vs lost vs no_bid) |
| "What margin did we actually realize on the ones we won?" | realized-margin column on won rows |
| "Which loads closed without us because pricing was late?" | missed-cutoff = skipped_no_price with deadline passed |
| "How is my desk doing this week - throughput?" | priced count / time-to-price, grouped by day and by pricer |
| "Give me KEI on the 6-tyre lanes only" | customer + vehicle-type filter |
| "The soft-close ones - did we behave differently?" | close-model filter |

Everything below serves these. If a proposed filter answers none of these, it is noise.

---

## 3. What already exists (build on this, do not reinvent)

- **Export backend** - `src/web/exports.js` (`makeExporters`), six builders returning
  `{headers, rows}`, served at `GET /api/export/:stream[.csv]?from=&to=`
  (`server.js:1214-1227`), session-gated by the global `/api` gate. Streams: `bid-history`,
  `bid-detail`, `price-requests`, `notifications`, `config-audit`, `engine-mode`. Pure
  in-memory CSV via `src/web/csv.js`, no `fs`, no new deps. `scripts/test-csv-export.js`
  covers it.
- **Export UI** - `dashboard/src/pages/Export.tsx`: a from/to date picker, quick ranges
  7d/30d/90d/All, per-stream download + "Export all". `dashboard/src/components/ExportButton.tsx`
  is the per-page button (already on History, Price Requests, Notifications, Settings).
  `downloadExportCsv` in `dashboard/src/lib/api.ts` handles the authed blob download.
- **History screen** - `dashboard/src/pages/History.tsx`: **now the complete record.** It reads
  `/api/history` (the export module's `priceRequests` FULL JOIN `closedBids`), not
  `/api/closed-bids`, so skipped / dismissed / still-open enquiries have rows alongside
  won / lost / no-bid. Five stat tiles (Enquiries / Priced / Won / Lost / Win rate over decided),
  status tabs, client-side text search and pagination. Its export button uses the `history` view,
  so the file matches the screen. The on-screen tabs/filters are still **not** applied to that
  file. Section 10's "the funnel view gets its own tab or page" was superseded by this: the
  director's question is "where did that enquiry go", and splitting the answer across two screens
  is what made it unanswerable.
- **PR #22 `feat/table-sort-filter` (OPEN)** - migrates Price Requests + History to
  `@tanstack/react-table`: click-to-sort columns and **per-column dropdown filters for
  Customer, Vehicle, and Account**, preserving all markup. This is exactly the filter chrome
  this feature needs on-screen. **Land #22 first** or Phase 1 re-implements the filter state.
- **Daily WhatsApp heartbeat** already computes the funnel (`heartbeat.js` `collectFunnel`:
  discovered / priced / missedCutoff / declined). The participation numbers already leave the
  building every morning; they are just not on a screen or in a filtered export.

The gap this scope fills is: (a) filter parameters beyond date on the export endpoints,
(b) an `.xlsx` writer, (c) reconciliation columns, (d) the durable ledger, (e) surfacing the
funnel/participation view.

---

## 4. The two load-bearing constraints

### 4.1 The reconciliation problem (design around this first)

SuperProcure's export (`_research/data/2026-07-23_kei-superprocure-participation-export.xlsx`,
sheet "Loads") has these columns:

```
Load Id | Loading Date | Load Type | Load Status | Freighter Name | Branch Name |
Origin | Destination | Distance(KM) | Latest Quoted Rate | Vehicle Type |
Vehicle Number | Driver Number | Rank
```

Sample row: `23416702 | 23-Jul 2026 | E-Auction | HISTORY | Havells India Ltd. |
Alwar Cable (1350) | ALWAR | Kamrup | 1894.24 | 83000 | Tata Truck (6 Tyre) | | | 4`

Mapping to our data (verified against the live stores):

| SP column | Our field | Notes |
|---|---|---|
| `Load Id` | `closedBids.auctionId` / `priceRequests.loadId` (numeric `l.id`) | **the join key. We have it.** |
| `Loading Date` | **not captured** | our dates are the *auction* times (`biddingStartTime`/`biddingCloseTime`), 1-2 days before loading. See below. |
| `Freighter Name` | `shipper` / `load.companyName` (+ matched `customer.label`) | SP "Freighter" = the shipper/consignor posting the load. |
| `Branch Name` | `load.branchName` (e.g. `Alwar Cable (1350)`) | the shipper's dispatch branch. On price-requests (partial), **not on closedBids**. |
| `Origin` / `Destination` | `lane.origin` / `lane.destination` | present. |
| `Distance(KM)` | `load.distanceKm` (`l.loadDistance`) | present on requests; not on closedBids today. |
| `Latest Quoted Rate` | `lastBidPrice` (else `cost`) | our own last quoted rate. |
| `Vehicle Type` | `equipment` | present. |
| `Rank` | `finalRank` | our rank; SP masks rival amounts, this is the one competitive read. |
| `Load Status` (`HISTORY`) | derived (`status`=closed) | SP's lifecycle label; informational. |

**The core issue:** our records are keyed by auction date (`closedAt`, `armedAt`,
`load.closesAt`), SP's export is keyed by `Loading Date`, and the auction closes 1-2 days
before the truck loads. So a same-day count on our side and a same-day count on SP's export
are counting *different cohorts* and will never match, even with zero data loss. The director
comparing the two will read a normal offset as a bug.

**What we have and don't have for reconciliation:**
- We DO have the reliable join key: the SP **Load Id** (`l.id` -> our `loadId`/`auctionId`),
  plus SP's friendly enquiry code `loadCode` (also captured).
- We do NOT currently capture the shipment **loading date**. The only "loading" fields the
  adapter reads are `l.loadingPoints` / `l.loadLoadingUnloadingPoint`, which are pickup/drop
  *locations*, not a date. Whether SP's `/sp/loads/v4` bidding payload even exposes a
  loading/reporting date, or whether that date only exists on the post-award shipment record
  behind the export, is an **open question** (section 10) that needs one live raw-payload
  check to settle.

**Design requirement:** every export row carries the **SP Load Id** and **both** the auction
close date/time and (once captured) the loading date. Until the loading date is confirmed
capturable, the export is still reconcilable via Load Id - the director joins our row to SP's
row on Load Id and reads the loading date off SP's side. Capturing it ourselves upgrades the
export from "joinable" to "self-reconciling" (he can group our data by loading date to match
SP's grouping directly).

### 4.2 The 7-day prune is a hard blocker for historical export

`pruneEnded` (`priceRequests.js:688-701`, `PRUNE_RETENTION_MS = 7 days`) deletes any request
7 days after its auction closed. `dropOutOfScope` (`priceRequests.js:612-625`) hard-deletes
awaiting requests whose shipper leaves the allowlist. So:

- `closedBids` (the *won/lost outcome* store) is never pruned - it goes back to 2026-07-07,
  242 closed records live. A lifetime **win-rate** export is possible.
- `priceRequests` (the *funnel*, the only place `skipped_no_price` / participation lives) holds
  a rolling ~7-day window - 383 records, oldest close ~7 days old. A lifetime **participation**
  export is **not possible** and cannot be backfilled beyond the current window.

**Consequence:** Phase 1 filtered export of the funnel is limited to a rolling ~7 days. Real
historical participation requires the durable ledger (section 7). Say this to the director
plainly - it is a data-retention fact, not a feature we forgot.

---

## 5. The full filter dimension set

Each dimension, its source field, and whether it exists today. "Derivable" = computable from
fields we already store; "capture" = needs a new persisted field.

| # | Filter | Source field | Status today |
|---|---|---|---|
| 1 | **Customer** | `customer.customerId` / `shipper` / `load.companyName` | exists (both stores) |
| 2 | **Branch / dispatch location** | `load.branchName` | partial on requests (184/383); **absent on `closedBids`** - needs capture into the ledger + backfill-forward |
| 3 | **Account** (SP login) | `account.accountId` / `account.label` | exists and populated - 4 live accounts: Best Roadways (Master), Sameer Ambdaskar, Neemrana, Primary |
| 4 | **Auction date range** | `closedAt` / `armedAt` / `createdAt` / `load.closesAt` | exists |
| 5 | **Loading date range** | (SP loading date) | **not captured** - see 4.1; open question whether capturable |
| 6 | **Outcome** | see status model below | derivable, but needs the zero-bid fix (section 8) to be honest |
| 7 | **Participated vs not** | `capturedAt != null` (funnel) | exists (funnel store only; the mapping to `closed` is exact both ways) |
| 8 | **Rank achieved** | `finalRank` (outcomes), `socketRank` (per-bid) | exists; `finalRank` null on ~8 zero-bid records + rank-disabled branches |
| 9 | **Vehicle type** | `equipment` | exists |
| 10 | **Lane (origin / destination)** | `lane.origin` / `lane.destination` | exists |
| 11 | **Margin band (inherited)** | `marginsPct` / `minMarginPct` / `marginSource` | exists |
| 12 | **Realized margin** | `(lastBidPrice - cost) / cost` on won rows | derivable at export time |
| 13 | **Load value / freight band** | `lastBidPrice` / `cost` / `load.ceiling` | exists |
| 14 | **Close model** | `closeModel` (`hard`/`soft`) | exists (all `hard` in closed data so far; soft live on Havells, not yet in a closed record) |
| 15 | **Weight / unit** | `load.weight` + `load.weightUnit` | exists; **unit varies** (MT 362 / KG 21 live) - see section 8 |
| 16 | **SP lane-freight anchor** | `laneFreight.{ftl,pmt}` | field exists on newer `closedBids`; currently null on the production path (a separate known defect, see the 2026-07-24 change-request scoping) |

**The unified status model** (dimension 6). One canonical per-load status the whole export
keys off, derived from the two stores:

| status | meaning | derivation |
|---|---|---|
| `won` | we bid and won | `closedBids.won === true` |
| `lost` | we bid and lost | `closedBids.won === false` AND `ourBids.length > 0` |
| `no_bid` | armed but never placed a bid | `closedBids` with `ourBids.length === 0` (the 10 records; see 8) |
| `skipped_no_price` | discovered, never priced, auction closed | `priceRequests.status === 'skipped_no_price'` |
| `dismissed` | operator declined | `priceRequests.status === 'dismissed'` |
| `awaiting_price` / `armed` / `stopped` | still live / in-flight | `priceRequests.status` |
| `missed_cutoff` | priced too late to bid | derive: `skipped_no_price` with `deadlineAt` passed, OR `no_bid` armed after the fire window |

`missed_cutoff` is a derived rollup, not a stored status - document it as such so it is not
mistaken for a persisted field.

---

## 6. Export views and column sets

Do **not** try to force one wide sheet to answer every question - the funnel grain (one row
per discovered load, most never bid) and the per-bid grain (one row per bid placed) do not
share a shape. Offer **three named views**, each a workbook the director picks:

### View A - Participation / funnel (the headline view)
One row per **discovered load** (spans the whole funnel, includes never-priced loads). Source:
the durable ledger (Phase 2) or the live `priceRequests` store (Phase 1, ~7-day window).

```
SP Load Id | Platform | Load Code | Auction Date | Auction Time | Loading Date* |
Customer | Branch | Account | Origin | Destination | Distance(KM) | Vehicle |
Weight | Unit | Status | Participated (Y/N) | Priced At | Time-to-Price (min) |
Our Cost | Our Last Bid | Final Rank | Won | Close Model | Margin Source | SP Lane Avg*
```
`*` loading date and SP lane avg subject to capture (sections 4.1 / dimension 16).

This is the view that answers participation, missed-cutoff, per-branch, per-customer, and
desk-throughput - the director's top questions. It is also the one that reconciles to SP's
participation export column-for-column.

### View B - Won/Lost outcomes
One row per **closed auction we armed** (the outcome dataset). Source: `closedBids` (full
history, not pruned). This is the existing `bid-history` stream, extended with the
reconciliation + branch columns:

```
SP Load Id | Platform | Auction Date | Auction Time | Loading Date* | Customer | Branch* | Account |
Origin | Destination | Distance(KM)* | Vehicle | Units | Cost | Floor |
Opening Bid | Floor Bid | Our Last Bid | Num Bids | Any Bid (Y/N) |
Margin Band | Realized Margin %* | Final Rank | Result (Won/Lost/No-bid) |
Close Model | Armed At | Closed At | Pickup | Drop
```
Changes vs today's `bid-history`: add SP Load Id label clarity, Loading Date, Branch,
Distance, Realized Margin %, and the honest `Result` (Won/Lost/No-bid, not the current
binary Won/Lost that mislabels the 10 zero-bid rows). `*` = needs capture/backfill.

### View C - Per-bid detail
One row per **individual bid** (the ladder walk). Source: `closedBids.ourBids[]` - the
existing `bid-detail` stream, unchanged except for adding SP Load Id + branch context:

```
SP Load Id | Platform | Customer | Branch* | Origin | Destination | Bid # | Bid Time |
Rung Index | Price | Rank (socket) | Latency(ms) | Extends Observed | Revisions Left
```

**Reconciliation columns** (called out explicitly, present on A and B): `SP Load Id`,
`Auction Date`, `Loading Date`, `Branch`, `Origin`, `Destination`, `Distance(KM)`,
`Our Last Bid` (= SP "Latest Quoted Rate"), `Final Rank` (= SP "Rank"), `Vehicle` (= SP
"Vehicle Type"). With these, the director joins our workbook to SP's on Load Id and every
comparable field lines up.

---

## 7. The durable ledger foundation (Phase 2 prerequisite)

**Problem:** participation history is destroyed on a 7-day clock and on allowlist churn.
Nothing survives to filter over.

**Fix:** an append-only ledger that captures each load's full lifecycle, written at
terminal transitions, immune to the prune and to `dropOutOfScope`.

**What to persist (one immutable row per discovered load, at close):**

```yaml
loadId: "23416702"          # SP Load Id - join key
loadCode: "..."             # SP friendly enquiry code
account: { accountId, label }
customer: { customerId, label } | companyName
branchName: "Alwar Cable (1350)"   # captured here so it is ALWAYS present (unlike closedBids today)
lane: { origin, destination }
distanceKm: 1894.24
equipment: "Tata Truck (6 Tyre)"
weight: n ; weightUnit: "MT" | "KG"
auctionStartAt / auctionCloseAt     # our dates
loadingDate: null                   # captured if the payload exposes it (open question)
discoveredAt / notifiedAt / capturedAt   # funnel timestamps -> time-to-price, missed-cutoff
finalStatus: won|lost|no_bid|skipped_no_price|dismissed
participated: bool                  # capturedAt != null
cost / lastBid / finalRank / won / closeModel / marginSource
laneFreight: { ftl, pmt } | null
closedAt                            # ledger write time
```

**When to write it:** at each terminal transition - `finalizeClosed` (armed/awaiting ->
closed), `expireOverdue` (-> skipped_no_price), and `dismiss` (-> dismissed). Emit via
`store.appendEvent('loadLedger', {...})` (the append-only seam, same mechanism as the `bids`
JSONL) at the existing status-set points in `priceRequests.js` / on the `auction_result`
engine event in `bidLogger.js`. Append-only means the prune and the allowlist hard-delete
never touch it - they operate on the live `priceRequests` collection, not the event stream.
This is the exact shape flagged as the optional 7th export in `CSV_EXPORTS_SCOPE.md` section 7
(`price-request-events`), promoted here to foundational because the director's whole ask
depends on it.

**Migration / backfill (be honest about the limit):** we can backfill the ledger only from
what still exists today - the current `priceRequests` window (383 records, ~7 days) plus the
full `closedBids` history (242 records back to 2026-07-07). That gives a complete *outcome*
history from Jul 7 but a *participation* history only for the last ~7 days. Everything before
the current funnel window is gone. A one-time backfill script reads both stores, joins on
loadId, and writes ledger rows; from deploy day forward the ledger accrues the full funnel.
State plainly: **historical participation starts accruing the day the ledger ships; it cannot
be reconstructed for June or early July.**

---

## 8. Data-integrity handling

These are the honesty requirements. Get them wrong and the export lies quietly.

1. **Zero-bid rows (10 live).** 10 `closedBids` records have empty `ourBids[]` yet are scored
   won/lost with (mostly) null `finalRank` - live: 10 empty, 8 null rank, 1 scored *won* with
   no recorded bid (e.g. the Ashirvad Ahmedabad->Surat sample: `ourBids: []`, `floor: 10630`,
   `finalRank: null`, `won: false`). `summarizeClosed` used to fold these into "Lost"; it now
   counts them as `noBid` and computes the win rate over decided auctions only (fixed alongside
   the History full-record change). The
   export must represent them as a distinct `Result = No-bid` (with a reason where knowable:
   below-floor stand-down, ceiling-below-floor, transit hold, or armed too late), never as a
   clean loss. Root-causing each of the 10 needs the debug trace, not the record - out of
   scope here, but the export must not paper over them.
2. **Null final rank.** `finalRank` is null on the zero-bid rows and on any rank-disabled
   branch (`branchDisableRank`). Render null rank as an empty cell (not `0`, not `1`), and
   never let a null rank read as "won".
3. **Loading date vs auction date.** Always label the two dates distinctly ("Auction Date" vs
   "Loading Date"). Never merge them into one "Date" column - that is the root of the
   reconciliation confusion.
4. **Weight-unit variance.** Live: 362 loads in MT, 21 in KG (Ashirvad Pipes). The export must
   emit `weightUnit` as its own column beside `weight` and never assume MT. A branch quoting KG
   whose weight is read as MT is off by 1000x.
5. **Rate/number-format quirks.** SuperProcure ships some numbers as strings
   (`ceilingPrice: "90000.00"`) and rupee displays can carry non-breaking spaces / thousands
   separators. The export must emit clean numeric cells (parsed to Number, blank when unparseable)
   so Excel treats them as numbers, not text - critical since the director will sort and sum on
   them. This is also why a real `.xlsx` (typed number cells) beats CSV (everything is a string
   until Excel guesses).
6. **Participation denominator moves with the allowlist.** When a shipper is disabled
   (Ashirvad was, 2026-07-22), `dropOutOfScope` removes its un-priced requests, so a
   participation ratio computed off the live store shifts. Label any live-window participation
   figure as "current allowlist, rolling 7 days"; the ledger (which is append-only and never
   dropped) is the stable denominator once it exists.
7. **Empty, not null.** Keep the existing export convention: missing values are an empty cell,
   never the literal string `null`.
8. **Legal wall.** Our-side data only. SP masks rival amounts on these rank-only auctions;
   the export carries our bids, our rank, our cost - never a competitor price (none exists in
   the logs). Do not add a column that implies one.

---

## 9. Export formats and the `.xlsx` decision

The director works in Excel, so `.xlsx` is primary, CSV secondary (keep the existing CSV as
the analyst/pipeline format).

**The lever that delivers most of "all sorts of filters" cheaply:** ship the wide View-A/B
workbook as a real `.xlsx` with **Excel AutoFilter enabled on the header row + frozen header +
typed number columns**. The director then filters every column himself, in his own tool, with
no server round-trip. Server-side pre-filtered exports (section 5 params) are the second layer
for the queries he runs repeatedly and for pre-canned/scheduled pulls.

**Dependency decision (needs a call - flagged, not decided here):** there is no spreadsheet
library in the repo, and the CSV export was deliberately built with no new deps and no `fs`.
Options for `.xlsx`:

| Option | New dep? | Gives | Cost |
|---|---|---|---|
| A. Keep CSV only | none | Excel opens it; no AutoFilter, no typed cells, no formatting | doesn't meet the "lives in Excel" ask |
| B. `exceljs` | 1 (+ transitive) | AutoFilter, frozen panes, number formats, styling | a dep on a display-only surface; well-maintained, widely used |
| C. Minimal in-repo OOXML writer (Node `zlib` to zip the XML parts) | none | AutoFilter + typed cells + frozen header; hand-owned | ~a few hundred lines to write + test; we own the edge cases |
| D. SpreadsheetML 2003 (`.xml` Excel opens) | none | AutoFilter + basic formats, single XML file | legacy format; Excel warns "format differs from extension" |

**Lean recommendation:** Option C for a live-money box where dep minimization is a standing
principle - a small, vetted, in-repo `.xlsx` writer that emits exactly the parts we need
(worksheet + AutoFilter + shared strings + a rupee/number style), reusing the existing
`{headers, rows}` projection from `exports.js` unchanged. Option B (`exceljs`) is acceptable if
the team would rather not own OOXML plumbing; the surface is display-only so the dep-risk is
contained. Decide before Phase 1 build. Whichever wins, **the CSV path stays** - the same
builders feed both serializers.

---

## 10. UI

Build on PR #22's TanStack table, do not reinvent the filter state.

- **On-screen filters (History + Price Requests):** extend PR #22's per-column dropdowns
  (Customer, Vehicle, Account already there) with **Branch**, **Outcome/Status**, **Close
  model**, and range controls for **auction date** and **rank**. ~~The funnel/participation view
  (View A) gets its own tab or page since its grain differs from History's.~~ **SUPERSEDED:**
  History itself became the full outer join, with status tabs covering both grains. Two screens
  meant a director had to already know an enquiry was skipped to find out it was skipped. The
  participation *percentage* still lives only on Reports, so one metric keeps one denominator.
- **Export button honors the active filters.** Today the History export ignores the on-screen
  filter (`History.tsx:133-135`). The fix: the ExportButton passes the current filter state as
  query params to `/api/export/:stream` (section 11), and a short note on the button confirms
  "exports what you see" vs the old "exports everything". This alone is a large chunk of the
  ask - the director narrows on screen, clicks export, gets that slice as `.xlsx`.
- **A format toggle** (`.xlsx` / CSV) on the Export page and the per-page button.
- **Saved / quick filters** a director reuses. Seed a few he will actually want:
  - "Havells Alwar - last 30 days - lost only"
  - "All customers - this week - not participated"
  - "KEI - 6-tyre - last 30 days"
  - "Won this month - with realized margin"
  Persist saved filters per operator (a small `savedViews` doc in the store); each is just a
  named bundle of the section-11 query params. This is what turns "all sorts of filters" from a
  one-off into something he opens every Monday.
- **Participation summary strip** on the funnel view: Discovered / Priced / Not-priced /
  Participation %, plus the per-shipper breakdown table (Havells 4%, Syngenta 85%, ...), with
  the "current allowlist, rolling 7 days" caveat inline until the ledger lands.

---

## 11. API contract sketch (build-ready)

Extend the existing `GET /api/export/:stream` with filter params (all optional, all
AND-combined). Same session gate, same `{headers, rows}` -> serializer pipeline; add an
`.xlsx` serializer alongside `toCsv`.

```
GET /api/export/:view?<filters>&format=xlsx|csv

:view        funnel | outcomes | bids          # View A / B / C (funnel is new; outcomes=bid-history, bids=bid-detail)

# date (two independent ranges - the reconciliation requirement)
from, to                 auction close (epoch ms or ISO)      # existing
loadingFrom, loadingTo   loading date range                   # once captured (section 4.1)

# entity
customer     customerId or companyName (repeatable)
platform     sp|gocomet (repeatable)             # the views are all-portal + carry a Platform
                                                 # column; this narrows to one. Absent = every
                                                 # portal. /api/export/summary is the exception -
                                                 # its percentage is scoped server-side.
branch       branchName (repeatable)
account      accountId or label (repeatable)

# lane / vehicle
origin, destination      city (exact, normalized)
vehicle                  equipment key (repeatable)

# outcome / funnel
status       won|lost|no_bid|skipped_no_price|dismissed|awaiting_price|armed|stopped (repeatable)
participated true|false
rankMin, rankMax         integer final-rank bounds
closeModel   hard|soft

# value / margin
valueMin, valueMax       on lastBid (or cost)
marginMin, marginMax     realized margin % (outcomes view only)

format       xlsx (default for director surfaces) | csv
```

Filter application is a pure predicate layer over the existing builders'
row projection - no change to the store seams, no new data path. Response headers unchanged
except `Content-Type` for xlsx
(`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`) and the filename encodes
the active filter (`havells-alwar_lost_2026-06-24_2026-07-24.xlsx`) so a saved file
self-documents.

**Filter schema (shared client/server), illustrative:**

```js
// one object, serialized to the query string above; the same shape backs a saved view.
{
  view: 'funnel',
  date: { from: 1782..., to: 1783... },            // auction close
  loadingDate: { from: null, to: null },           // loading date (when available)
  customer: ['havells'], branch: ['Alwar Cable (1350)'], account: [],
  origin: null, destination: null, vehicle: [],
  status: ['lost'], participated: null, rank: { min: null, max: null },
  closeModel: null, value: { min: null, max: null }, margin: { min: null, max: null },
  format: 'xlsx',
}
```

Verification: extend `scripts/test-csv-export.js` with (a) each filter predicate narrows the
row set correctly, (b) the xlsx serializer round-trips a known row with typed number cells +
AutoFilter present, (c) the funnel view's status derivation matches the two-store truth table
in section 5, (d) a zero-bid row renders `Result = No-bid`. All headless, part of `npm test`.

---

## 12. Phasing and effort

| Phase | Scope | Ships | Effort (dev-days) |
|---|---|---|---|
| **1** | Filter params on the export endpoints + `.xlsx` serializer + reconciliation columns (Load Id, both dates where available, branch on the funnel view, distance, our-rate, rank) + the export honors on-screen filters + funnel/participation view over the **live ~7-day window** + zero-bid `No-bid` labeling + saved/quick filters. Builds on PR #22. | filtered `.xlsx` export the director can slice every-which-way, over the current window; reconcilable to SP by Load Id | **6-9** (of which the `.xlsx` writer is ~2-3 depending on option B vs C) |
| **2** | The durable append-only ledger (section 7) + one-time backfill + historical funnel/participation export unbounded by the 7-day prune + branch always-present + loading-date capture (if the open question resolves yes). | "export last quarter's participation, by branch" actually works | **5-8** |
| **3** | Scheduled / emailed exports - a saved view delivered to the director's inbox on a cron (weekly "Havells participation", monthly outcomes). Only if he wants it (open question). | push instead of pull | **3-5** |

Phase 1 is usable and shippable on its own. Phase 2 is the one that unlocks the director's
"last quarter" questions. Phase 3 is optional convenience.

---

## 13. Commercial classification

Per the engagement's established line: **a correctness bug in delivered functionality is free;
new customers / carriers / auction-types / platforms / modules are scope.**

- **Making the export honor on-screen filters, and labeling the zero-bid rows correctly** -
  **warranty/free.** The History export silently ignoring the active filter, and 10 loads
  scored as clean losses when we never bid, are correctness defects in delivered Module 1
  reporting. Same category as the participation-panel fix in the 2026-07-24 change-request
  scoping.
- **Basic filter-on-existing-data (customer/branch/account/outcome/date over the current
  window)** - **closest to Module-2-rollout polish.** It is a formatting/param layer over data
  we already serve, on surfaces already built. Reasonable to fold into the Module 2 rollout
  rather than price separately - and it is strong goodwill.
- **The `.xlsx` writer** - **small, but genuinely new capability** (a new output format, not a
  repair). If Option B (`exceljs`) it is trivial; if Option C it is a few days of owned code.
  Fold into the Phase 1 rollout slice, but note it is net-new, not warranty.
- **The durable ledger + historical export (Phase 2)** - **clearly new priced work.** It is
  new persistence (a new event stream), a backfill migration, and the infrastructure that all-
  customer rollout reporting (Module 2 A7) depends on. Price it as Module 2 scope, not warranty.
- **Loading-date capture** - **new**, small, gated on the open question.
- **Scheduled/emailed exports (Phase 3)** - **new priced work**, optional.

**Precedent flags:**
- The **durable ledger** is the one worth naming as a deliberate investment: it is small to
  build and it is the foundation every future reporting ask ("participation trend", "branch
  scorecard", "desk throughput over time") will lean on. Build it once, cleanly, as Module 2
  infrastructure rather than re-deriving a rolling window each time.
- Adding a **spreadsheet dependency** to a live-money box is a small but precedent-setting
  call - once `exceljs` is in, the next "just add a library for X" ask is easier to wave
  through. That is the reason Option C (zero-dep) is the lean recommendation despite being more
  code. Decide it consciously.

---

## 14. Open questions (only the director / SuperProcure can answer)

**For the director:**
1. **Retention horizon.** How far back does he actually need participation history - 30 days,
   a quarter, a year? This sizes the ledger and sets expectations, since anything before the
   ledger ships cannot be reconstructed.
2. **Which exact SP columns does he reconcile against?** The KEI export has 14 columns; does he
   join on Load Id, or eyeball loading date + lane + rank? This decides which reconciliation
   columns are load-bearing vs nice-to-have.
3. **Scheduled email exports (Phase 3)** - does he want a weekly/monthly export pushed to his
   inbox, or is pull-on-demand enough?
4. **Default grouping - per-branch or per-customer?** He insisted Havells Alwar be treated
   separately, which argues per-branch; but the bot routes per-customer. Which is the default
   the funnel view opens on?
5. **`.xlsx` vs CSV, and does he want the AutoFilter-enabled workbook or pre-filtered files?**
   The answer changes how much server-side filtering vs in-Excel filtering we build.

**For SuperProcure (via the director, who holds the relationship):**
6. **Does the `/sp/loads/v4` bidding payload expose a shipment loading/reporting date?** If yes,
   we capture it and the export self-reconciles. If it only lives on the post-award shipment
   record, the export stays Load-Id-joinable and the director reads loading date off SP's side.
7. **What is SP's "Latest Quoted Rate" in their export** - the transporter's (our) last quote,
   or the winning quote? The KEI sample (83000 with our rank 4) reads as our own last quote,
   but confirm before we label the reconciliation column.

---

## 15. What I could not verify

Stated plainly.

1. **Whether the loading date is capturable** from the live bidding payload (open question 6).
   I read the adapter's field map and the two live stores; I did **not** read a raw
   `/sp/loads/v4` response this session. The only "loading" fields the adapter references are
   pickup/drop *locations*, not a date.
2. **Root cause of each of the 10 zero-bid records.** Verified from the record: 10 exist, 8
   null rank, 1 scored won with no bid. Not root-caused individually - that needs the debug
   trace, which is out of scope for an export spec.
3. **The director's exact reconciliation workflow** (open question 2) - inferred from the KEI
   export shape, not observed.
4. **Live participation is a rolling-window figure.** 156/383 = 41% is the current ~7-day
   window on the box today; it is not a lifetime number and cannot be (section 4.2). The
   per-shipper splits (Havells 4/99, Syngenta 85%, ...) are same-window.
5. **Soft-close in the outcome data.** All 242 closed records are `closeModel: hard`. Soft-close
   is live on Havells but has not yet produced a closed record, so the close-model filter is
   correct in design but untested against real soft data.
