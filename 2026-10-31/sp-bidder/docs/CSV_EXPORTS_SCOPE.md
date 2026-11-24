# CSV Exports - Scope

Scoping doc for CSV export of the data the bidder logs, so an operator can pull it out
and analyse it elsewhere (a spreadsheet, or loaded into an analysis tool / LLM). The
request: exports "wherever applicable", shaped so the data is self-describing once it
leaves the app.

The design goal shapes every column choice below: **the consumer is an analyst or a
model, not the app.** That means human-readable timestamps, flattened columns (no nested
JSON to decode), and every row carrying enough context to stand alone.

---

## 1. Two delivery modes (one backend)

There are two distinct ways an operator wants this, and they need different UI - but the
same endpoints serve both:

1. **Grab-what-I'm-looking-at** - an "Export CSV" button on each table page that downloads
   the current view. Convenience; lives on the page you're already on.
2. **Pull-a-range** - a dedicated Export page with a date-range picker and one button per
   data stream, for pulling (say) a month of everything at once.

The backend is a single family of endpoints (`GET /api/export/:stream`). The per-page
buttons call the same endpoints with the page's current date range; the Export page calls
them with a chosen range. No duplicated export logic.

---

## 2. What we log, and what's worth exporting

Every stream below already has a live JSON endpoint or a store accessor - exports are a
formatting layer over data we already serve, not new data collection.

| # | Export | Source | Grain | Value |
|---|--------|--------|-------|-------|
| 1 | **Bid history** | `closedBids` store (`bidLogger.listClosed`) | 1 row / auction | Win/loss, final rank, our last bid, margin band - the outcome dataset |
| 2 | **Bid detail** | `closedBids.ourBids[]` (or `bids-*.jsonl`) | 1 row / individual bid | The ladder walk - price, rank, latency, dry-run flag per bid |
| 3 | **Price requests** | `priceRequests` store | 1 row / request | The pricing funnel - priced vs skipped, time-to-price |
| 4 | **Alert delivery** | `notifications-*.jsonl` (`store.readEvents`) | 1 row / alert | Which alerts were sent and whether they landed |
| 5 | **Config audit** | `configChanges-*.jsonl` (`store.readEvents`) | 1 row / changed field | Who changed which strategy value, and when |
| 6 | **Engine mode** | `engineMode-*.jsonl` (`store.readEvents`) | 1 row / action | LIVE vs DRY-RUN windows - context for reading the bid history |

Deliberately **not** exported (low analytical value / not record data): `notifSent`
(send-dedupe metadata), `config/current` (settings, not events), accounts / session
(operational), `intents.json` (restart-recovery mirror of the same data). A live-bids
snapshot export is possible but ephemeral - left out unless asked for.

Note on competitor data: these are largely rank-only auctions, so no competitor bid price
is exposed on the in-scope loads. Exports carry our own bids, our rank, and outcomes - not
a competitor price ladder, because that data does not exist in the logs.

---

## 3. Design principles (what makes the CSV analysis-ready)

1. **ISO 8601 timestamps.** Every `*At` / `ts` field is emitted as `2026-07-06T14:32:10Z`,
   not raw epoch milliseconds. A human or a model reasons over dates directly; nobody
   should have to convert `1783316040736`.
2. **Flatten one level.** `lane.origin` / `lane.destination` become `origin` / `destination`
   columns; `account.label` becomes `account`. No nested objects in a cell.
3. **Arrays become joined strings.** `marginsPct: [12.6, 7.2, 6.3]` -> `"12.6|7.2|6.3"`.
   Readable, and trivially re-split if needed. `ladder` similarly, where kept.
4. **The dry-run flag is load-bearing.** Every bid-level row carries `dryRun`. A shadow bid
   must never be read as a real outcome. Current sample data is entirely dry-run, so
   getting this wrong is easy and silent.
5. **A few derived columns.** `numBids`, `timeToPriceMins`, `anyRealBid` - cheap to compute
   at export time, saves the analyst a step.
6. **Every row stands alone.** Bid-detail rows repeat `auctionId` + shipper + lane so a
   single row is interpretable without a join back to the auction.
7. **Empty, not null.** Missing values are an empty cell, never the string `null` or
   `undefined`.

---

## 3a. Portal scope - all-portal, always labelled

Since the GoComet integration these exports cover **every bidding portal**, and each of the three
record streams carries an explicit `platform` column as its **second** column (`sp` / `gocomet`).
There is no query-time portal filter and there is no per-portal endpoint.

Why that direction, given that the client-facing participation and win percentages ARE scoped to
one portal: a scoped reader prevents silent corruption, and an explicit `platform` column makes
corruption impossible to be *silent*. Which one is right depends on whether a human sees the rows.
An aggregate percentage has no row to label, so it is scoped. These files are opened by a person,
and one operator desk works both portals - hiding the GoComet rows that same desk priced would
lose data rather than protect a number. Filter by `platform` downstream if a single-portal cut is
what you want; `GET /api/export/funnel?platform=sp` does it server-side on the xlsx views.

A record persisted before the portal field existed reads `sp`, which is correct by construction -
those records predate the existence of a second portal.

---

## 4. Column specs

Column order below is the CSV header order. "Source" is the field on the underlying record.

### Export 1 - Bid history (`bid-history`)

One row per closed auction. Source: `bidLogger.listClosed({ from, to })`.

| Column | Source | Notes |
|--------|--------|-------|
| `auctionId` | `auctionId` | |
| `platform` | `platformKey` | `sp` / `gocomet`; blank field on a legacy record reads `sp` (priceRequests.platformOf) |
| `account` | `account.label` | blank if single-account |
| `shipper` | `shipper` | |
| `origin` | `lane.origin` | |
| `destination` | `lane.destination` | |
| `equipment` | `equipment` | |
| `units` | `units` | |
| `cost` | `cost` | operator-captured cost |
| `costFloor` | `costFloor` | |
| `floor` | `floor` | operating floor actually enforced |
| `openingBid` | `ladder[0]` | |
| `floorBid` | `ladder[last]` | |
| `lastBidPrice` | `lastBidPrice` | |
| `numBids` | `ourBids.length` | derived |
| `marginBand` | `marginsPct` | joined `12.6\|7.2\|6.3` |
| `minMarginPct` | `minMarginPct` | |
| `finalRank` | `finalRank` | 1 = won |
| `won` | `won` | `true` / `false` / blank |
| `anyRealBid` | derived from `ourBids[].dryRun` | `true` if any bid was real |
| `closeModel` | `closeModel` | `hard` / `soft` / blank |
| `armedAt` | `armedAt` | ISO |
| `closedAt` | `closedAt` | ISO |
| `status` | `status` | `open` / `closed` |
| `pickupPoints` | `points` | every pickup-kind point's address, `; `-joined |
| `dropPoints` | `points` | every drop-kind point's address, `; `-joined |

### Export 2 - Bid detail (`bid-detail`)

One row per individual bid, with auction context repeated. Source: flatten
`closedBids[*].ourBids[]` (carries `dryRun` + `latencyMs`). Alternative source is
`store.readEvents('bids', { from, to })` - same fields minus the joined context.

| Column | Source | Notes |
|--------|--------|-------|
| `auctionId` | parent `auctionId` | |
| `platform` | parent `platformKey` | context, repeated - every row stands alone (principle 6) |
| `shipper` | parent `shipper` | context, repeated |
| `origin` | parent `lane.origin` | |
| `destination` | parent `lane.destination` | |
| `bidNumber` | array index + 1 | derived (1-based) |
| `bidTs` | `ourBids[].ts` | ISO |
| `rungIndex` | `ourBids[].rungIndex` | 0 = opening |
| `price` | `ourBids[].price` | |
| `rank` | `ourBids[].rank` | rank at submission, blank if unread |
| `latencyMs` | `ourBids[].latencyMs` | blank if not measured |
| `dryRun` | `ourBids[].dryRun` | `true` = shadow bid |
| `pickupPoints` | parent `points` | every pickup-kind point's address, `; `-joined |
| `dropPoints` | parent `points` | every drop-kind point's address, `; `-joined |

### Export 3 - Price requests (`price-requests`)

One row per price request. Source: `priceRequests` store (all docs in range by `createdAt`).

| Column | Source | Notes |
|--------|--------|-------|
| `loadId` | `loadId` | |
| `platform` | `platformKey` | `sp` / `gocomet`; blank field on a legacy record reads `sp` (priceRequests.platformOf) |
| `account` | `account.label` | blank if single-account |
| `shipper` | `load.companyName` | |
| `origin` | `load.lane.origin` | |
| `destination` | `load.lane.destination` | |
| `equipment` | `load.equipment` | |
| `units` | `load.units` | |
| `productName` | `load.productName` | |
| `status` | `status` | `awaiting_price` / `armed` / `dismissed` / `stopped` / `closed` / `skipped_no_price` |
| `marginSource` | `marginSource` | `default` / `customer:*` / `bid` |
| `marginBand` | `marginsPct` | joined |
| `minMarginPct` | `minMarginPct` | |
| `cost` | `price.cost` | blank until captured |
| `createdAt` | `createdAt` | ISO |
| `deadlineAt` | `deadlineAt` | ISO |
| `capturedAt` | `capturedAt` | ISO, blank if never priced |
| `timeToPriceMins` | `capturedAt - createdAt` | derived minutes, blank if never priced |
| `closesAt` | `load.closesAt` | ISO |
| `softClose` | `load.softClose` | |
| `pickupPoints` | `load.points` | every pickup-kind point's address, `; `-joined |
| `dropPoints` | `load.points` | every drop-kind point's address, `; `-joined |

Retention caveat: this store prunes ~7 days after an auction closes, so it holds the
*current* funnel, not deep history. See section 7 for the historical-funnel gap.

### Export 4 - Alert delivery (`notifications`)

One row per alert send attempt. Source: `store.readEvents('notifications', { from, to })`.

| Column | Source | Notes |
|--------|--------|-------|
| `ts` | `ts` | ISO |
| `kind` | `kind` | `price_needed` / `bid_live` / `outbid` / `won` / `lost` / `error` / `test` |
| `to` | `to` | recipient phone |
| `name` | `name` | recipient name |
| `ok` | `ok` | `true` = sent |
| `error` | `error` | blank on success |
| `messageId` | `messageId` | provider id, blank on failure |

### Export 5 - Config audit (`config-audit`)

One row per changed field (flatten the `changes[]` array - a single save that touched
three fields becomes three rows). Source: `store.readEvents('configChanges', { from, to })`.

| Column | Source | Notes |
|--------|--------|-------|
| `ts` | `ts` | ISO |
| `actor` | `actor` | operator username |
| `ip` | `ip` | client IP, blank if unknown |
| `field` | `changes[].field` | e.g. `marginsPct`, `allowlist`, `recipients` |
| `before` | `changes[].before` | JSON string of prior value |
| `after` | `changes[].after` | JSON string of new value |

`before` / `after` stay JSON strings (values can be arrays/objects). This is the one place
a cell holds JSON deliberately - a config diff has no fixed shape to flatten to.

### Export 6 - Engine mode (`engine-mode`)

One row per mode action. Source: `store.readEvents('engineMode', { from, to })`. Fields
vary by action, so the CSV is a superset with blanks where a field doesn't apply.

| Column | Source | Notes |
|--------|--------|-------|
| `ts` | `ts` | ISO |
| `action` | `action` | `kill` / `resume` / `go_live` / `stand_down` |
| `actor` | `actor` | |
| `ip` | `ip` | |
| `reason` | `reason` | `kill` only |
| `target` | `target` | `resume` only (`dryrun` / `live`) |
| `wasLive` | `wasLive` / `wasLiveAtKill` | whether engine was LIVE at the event |
| `armed` | `armed` | `go_live` only - armed monitor count |

---

## 5. Backend

**Endpoint family:** `GET /api/export/:stream?from=<ts>&to=<ts>`

- `:stream` in `{ bid-history, bid-detail, price-requests, notifications, config-audit, engine-mode }`.
- `from` / `to` optional epoch-ms (or ISO) query params. Defaults: bounded stores
  (bid-history, bid-detail, price-requests) default to all available; JSONL log streams
  default to a sane window (last 90 days) so a no-arg pull isn't unbounded.
- Response headers:
  - `Content-Type: text/csv; charset=utf-8`
  - `Content-Disposition: attachment; filename="<stream>-<fromDate>-<toDate>.csv"`

**Auth:** inherits the existing global `/api/*` gate (`server.js` ~L203) - any route under
`/api/` already requires an authenticated session and sets `req.admin`. No new auth layer;
`/api/export/*` is covered automatically.

**No new deps, no `fs`.** CSV is built as an in-memory string and `res.send()`-ed. A small
pure helper - `src/web/csv.js`, `toCsv(rows, columns)` - does the field escaping (wrap a
value in quotes when it contains a comma, quote, or newline; double any internal quote) and
ISO date formatting. Pure string work, so it doesn't touch `fs` and doesn't break the
store-seam grep gate. Reads go through the existing accessors (`bidLogger`, `store.readEvents`,
the price-request store) - the same seam every current endpoint uses.

**Shape sketch** (illustrative, not final code):

```
app.get('/api/export/:stream', async (req, res) => {
  const { from, to } = parseRange(req.query);
  const { columns, rows } = await buildExport(req.params.stream, { from, to });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${req.params.stream}-${stamp(from)}-${stamp(to)}.csv"`);
  res.send(toCsv(rows, columns));
});
```

---

## 6. UI

**Download helper** (`dashboard/src/lib/api.ts`): a `downloadCsv(stream, { from, to })` that
builds the URL and triggers a browser download. Because the endpoint is a cookie-authed GET,
this can be an anchor-click (`<a download>`) or `window.location` - the session cookie rides
along, no fetch/blob juggling needed.

**Per-page buttons** - `<Button size="sm" variant="outline">` + lucide `Download` icon, to
match existing table-header buttons:

| Page | Placement | Exports |
|------|-----------|---------|
| History (`/history`) | header, by the Won/Lost filter | `bid-history` (current range); a second item for `bid-detail` |
| Price Requests (`/requests`) | card header, top-right | `price-requests` |
| Notifications (`/notifications`) | "Recent alerts sent" card header | `notifications` |
| Settings (`/settings`) | "Recent changes" card header | `config-audit` |

The per-page button exports the page's current **date range** and, where trivial, the
won/lost filter (as a query param). The History free-text search is client-side and is
**not** reapplied server-side - the export carries the full range and the analyst filters
downstream. Document this so a narrowed on-screen search isn't mistaken for a narrowed file.

**Export page** (`/export`, new nav item) - the pull-a-range surface:

- A from/to date-range picker (default: last 30 days).
- One labelled download button per stream (all 6).
- An "Export all" that fires all six downloads for the chosen range.

---

## 7. The historical-funnel gap (optional enhancement, not in the 6)

`priceRequests` prunes ~7 days after close, and loads that were never armed
(`skipped_no_price`, `dismissed`) never reach `closedBids`. So the question "how many loads
did we lose because pricing was too slow, last quarter" is **not answerable from stored
data today** - the price-requests export (3) only ever shows the current window.

Closing it is small: emit a `priceRequests` event on each state transition
(`created -> priced -> armed / skipped_no_price / dismissed / closed`) via
`store.appendEvent('priceRequests', {...})` at the existing status-set points in
`src/pricing/priceRequests.js`. That backs a 7th export, `price-request-events`, giving the
full historical funnel with the same range semantics as the other log streams.

Flagged as an optional follow-on because it adds new logging (the other six are pure
read-out of existing data). Highest analytical value of anything here if the funnel is what
matters most.

---

## 8. Build order

- **Phase A - backend.** `src/web/csv.js` helper + the six `/api/export/:stream` routes.
  Testable headless with a script that asserts header row + a known row per stream.
- **Phase B - per-page buttons.** `downloadCsv` helper + buttons on History, Price Requests,
  Notifications, Settings.
- **Phase C - Export page.** New `/export` nav item with range picker + per-stream + all.
- **Phase D (optional).** Price-request transition log + `price-request-events` export (section 7).

---

## 9. Verification

- Backend: a headless script per stream - hit the endpoint, assert the header row matches
  the spec, assert one seeded record round-trips (values escaped, timestamps ISO, dry-run
  flag present on bid rows). Add to the `npm test` aggregate.
- UI: build the console (`npm run build` typechecks the dashboard), then click each button
  and confirm a well-formed CSV downloads and opens cleanly in a spreadsheet.
- Escaping edge cases explicitly tested: a shipper name with a comma, a config value with a
  newline, an empty result set (header row only, no crash).

---

## 10. Status — implemented

All six exports plus both delivery surfaces are built.

Backend:
- `src/web/csv.js` — pure RFC-4180 serialization + ISO/pipe/bool/json helpers (no `fs`).
- `src/web/exports.js` — `makeExporters({ store, bidLogger, requests })`, the six builders
  returning `{ headers, rows }`; injected deps, unit-testable with a memory store. Bid history,
  bid detail, and price requests append `pickupPoints`/`dropPoints` columns via
  `notify/waTemplates.js`'s shared `addressesByKind()`, covering every multi-pickup/multi-drop
  point instead of just the lane's collapsed first/last.
- `src/web/server.js` — `GET /api/export/:stream[.csv]?from=&to=`, session-gated by the
  existing global `/api` gate.
- `scripts/test-csv-export.js` — 56 assertions (helpers + every builder + escaping + empty
  set + config-diff flatten); part of the `npm test` gate. Suite: 35/35 green.

Frontend:
- `dashboard/src/lib/api.ts` — `downloadExportCsv(stream, range)` (fetches via `apiFetch`
  so a dropped session still bounces to login; saves the blob under the server filename).
- `dashboard/src/components/ExportButton.tsx` — the per-page button.
- `dashboard/src/pages/Export.tsx` — the range-picker hub (`export` nav item) with a
  per-stream download + "Export all"; quick ranges 7d / 30d / 90d / All.
- Per-page buttons: History (bid history), Price Requests, Notifications (alert log),
  Settings (config audit).
- `tsc --noEmit` clean; `vite build` green.

Not verified: a live in-browser click-through (no browser-automation tool available this
session). Endpoints are curl-verified end-to-end; the download path is standard, type-checked.
