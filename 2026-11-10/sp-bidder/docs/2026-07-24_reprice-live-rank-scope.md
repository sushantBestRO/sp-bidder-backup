# Reprice page — live rank scope (SCOPE ONLY, not built)

Design scope for showing the auction's live rank inside the tokenized reprice page
(`GET /price/:token` with the load already armed). The director wants to see the rank changing
on the link itself instead of waiting on WhatsApp outbid messages, and asked to see how it looks
before it is built. This doc is the visualization plus the honest data path; a build agent can
pick it up on approval. Nothing here is implemented.

Out of scope: the dashboard Live Bids row (it already shows rank via `AuctionRow` / the `Rank`
component). This doc is only the public `/price/:token` reprice surface.

## The one hard caveat, up front

SuperProcure masks rival bid amounts, and on rank-only loads `totalBidders` is only our own
visible row count, not the real field size (memory: SP socket masks external amounts). So the
only live competitive signal we legitimately hold is our own ordinal rank — "you are L2".

The mockup and the build must therefore show:

- our rank as an ordinal only (L1 / L2 / L3…),
- an "of N" denominator only when N is trustworthy (mirror the dashboard `Rank` component:
  render "of N" only when `total >= rank`, suppress it otherwise) — on rank-only loads there is
  no denominator,
- never a rival price, never a rival count, never "you are Rs X behind". We do not have those
  numbers and must not imply we do.

This is the same privacy/masking line the `/track` page and the dashboard already hold.

## The tension the placement has to respect

The reprice page is already the thing the director said is "a little longer than I would like"
(the fact grid was the first half of that complaint, fixed separately in this same PR). So live
rank must NOT arrive as a new panel that adds height. It has to land as a single compact,
already-live line — ideally sharing a row that already exists.

The natural host is the countdown. The page already renders a live countdown element (`#cd`,
"…2m 14s to close") that repaints every second. Rank is the same kind of thing — live, ephemeral,
glanceable — so it belongs on that same row, not in its own block. Net height added: zero rows.

## Placement (recommended)

Co-locate rank with the countdown on one line: rank on the left, countdown on the right. The row
already exists, so this costs no extra vertical space.

```
  Current rank  L2   · updated 3s ago                    2m 14s to close
  └──────────── new ────────────┘                        └── already there ──┘
```

Fallback placement (if the countdown row is too narrow on the smallest phones): a slim standalone
line directly under the lane header, above the fact grid — still one line, no panel. Recommended
only if the single-row layout crowds on a ~320px screen.

## Mockup — reprice page, before / after

Current reprice page (`/price/<token>`, load armed), desktop card:

```
┌────────────────────────────────────────────────────────┐
│  [#] Bid Command                              #23423905 │
│      Re-price a load already bidding                    │
│                                                         │
│  Re-price load #23423905                                │
│  ┌───────────────────────────────────────────────────┐ │
│  │  Bhiwandi                    ->            Madurai │ │
│  │  421302                                     625009 │ │
│  │  ┌────────────┬────────────┬────────────┐         │ │
│  │  │ Vehicle    │ Shipment   │ Weight     │         │ │
│  │  │ 32ft SXL   │ FTL        │ 9 MT       │         │ │
│  │  ├────────────┼────────────┼────────────┤         │ │
│  │  │ Material   │ Cost by    │ Closes     │         │ │
│  │  │ Solar Mod. │ 5:30 PM    │ 6:00 PM    │         │ │
│  │  ├────────────┴────────────┴────────────┤         │ │
│  │  │ Distance   1,432 km                   │         │ │
│  │  └───────────────────────────────────────┘         │ │
│  │  Load #23423905 · Renewsys India (REN-K) · soft   │ │
│  │                                    2m 14s to close │ │  <- #cd, live
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  Your cost (Rs)                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │ Rs  68,500                                        │ │
│  └───────────────────────────────────────────────────┘ │
│  [                 Re-price                           ] │
└────────────────────────────────────────────────────────┘
```

With live rank (the only change is the one marked row):

```
┌────────────────────────────────────────────────────────┐
│  [#] Bid Command                              #23423905 │
│      Re-price a load already bidding                    │
│                                                         │
│  Re-price load #23423905                                │
│  ┌───────────────────────────────────────────────────┐ │
│  │  Bhiwandi                    ->            Madurai │ │
│  │  421302                                     625009 │ │
│  │  ┌────────────┬────────────┬────────────┐         │ │
│  │  │ Vehicle    │ Shipment   │ Weight     │         │ │
│  │  │ 32ft SXL   │ FTL        │ 9 MT       │         │ │
│  │  ├────────────┼────────────┼────────────┤         │ │
│  │  │ Material   │ Cost by    │ Closes     │         │ │
│  │  │ Solar Mod. │ 5:30 PM    │ 6:00 PM    │         │ │
│  │  ├────────────┴────────────┴────────────┤         │ │
│  │  │ Distance   1,432 km                   │         │ │
│  │  └───────────────────────────────────────┘         │ │
│  │  Load #23423905 · Renewsys India (REN-K) · soft   │ │
│  │  ● L2   updated 3s ago             2m 14s to close │ │  <- rank + #cd, one row
│  └───────────────────────────────────────────────────┘ │
│                                                         │
│  Your cost (Rs)                                         │
│  ┌───────────────────────────────────────────────────┐ │
│  │ Rs  68,500                                        │ │
│  └───────────────────────────────────────────────────┘ │
│  [                 Re-price                           ] │
└────────────────────────────────────────────────────────┘
```

States the rank line must handle (all one line, no height change):

```
  ● L1  winning     updated 2s ago       2m 14s to close     (L1 -> green dot)
  ● L2              updated 3s ago       1m 41s to close     (behind -> neutral dot)
  ○ rank pending    updated 4s ago             58s to close  (armed, no tick yet)
  ○ not bidding yet                            waiting…      (armed pre-open / no engine monitor)
```

Note there is deliberately no "of N" in any state — see the caveat. If a future load type ever
gives a trustworthy field size, "L2 of 7" can appear then, gated on `total >= rank`, not before.

## Data path (honest)

The task framing assumed the public `/price/<token>` page is a static form with no live feed.
It is not — the page already runs a short-poll, so this is smaller than a from-scratch live
channel:

1. The reprice page already polls. `renderPriceForm`'s inline script fetches
   `GET /price/:token/state` every ~4s (drives the skew-corrected countdown and the
   auto-reload-on-status-change from `PRICE_PAGE_LIVE_STATE_SCOPE.md`). That is the live channel;
   it already exists on this exact page. No socket, no new endpoint required.

2. The rank already arrives in-app. The engine consumes the SuperProcure per-tick socket
   (`src/platform/spSocket.js`) and keeps `myRank` on each armed monitor;
   `engine.snapshot()` exposes it. The sibling read-only `/track/:token` page already renders it
   ("Our rank", from `trackState()` -> `engine.snapshot().find(...).myRank`). Same ordinal, same
   masking discipline.

3. The only gap. `GET /price/:token/state` today returns `{ status, closesAt, deadlineAt,
   serverTime }` — no rank. `GET /track/:token/state` already returns `engine.myRank`. So the
   feed for the token page already exists on the `/track` side; the price-state payload just
   doesn't carry the field yet.

So "give the public page a live rank feed scoped to one auction" is really "add one already-computed
field to a payload the page already fetches every 4s".

## Pieces (for the build agent — do not build yet)

Read-only throughout. Zero bid-path impact: it reads an in-memory snapshot the engine already
maintains; it touches no ladder, floor, cost, or placeBid path.

- Server (~5 lines): extend `GET /price/:token/state` to include the live rank, sourced exactly
  as `trackState()` does — `stackForRequest(r)` -> `engine.snapshot().find(x =>
  String(x.auctionId) === String(r.loadId))` -> `m.myRank` (null when there is no live monitor
  yet). Optionally include the engine status so the page can distinguish "armed, no tick yet"
  from "bidding". No new endpoint. Alternatively, point the price page's poll at the existing
  `/track/:token/state`, which already carries it — but extending the payload the page already
  fetches is the smaller, lower-surface change.
- Client (~10–12 lines inline + one element + a little CSS): add a compact rank element on the
  countdown row and update it inside the poll's existing success handler from `s.myRank`
  (ordinal only; "of N" gated on a trustworthy total, i.e. never here). Derive "updated Ns ago"
  from the `serverTime` the poll already returns. Green dot at L1, neutral otherwise (mirror the
  dashboard `useFlashOnChange` colour rule). Hide/soften when `myRank` is null.
- Reuse, don't reinvent: same poller, same skew offset, same terminal-stop and tab-hidden
  back-off already established in `PRICE_PAGE_LIVE_STATE_SCOPE.md`. Rank just rides the existing
  loop.

Effort: small (S). One field on the server projection, one line on the client, all on machinery
that already runs on this page.

## Edge cases to hold

- Armed but no tick yet — `myRank` is null until the first socket sample lands; show "rank
  pending", never "L0" or "L—" styled as a real rank.
- Clock skew — the "updated Ns ago" stamp is cosmetic; derive it off the poll's `serverTime`
  offset, same as the countdown, so a skewed phone clock can't show "updated -4s ago".
- First-capture page (not armed yet) — there is no engine monitor, so no rank. The live rank line
  belongs to the reprice (armed) view; on first capture it stays absent or reads "not bidding yet".
- Terminal — once the load closes, stop the rank line the same moment the poll stops (the loop
  already halts on terminal state); a stale "L2" must not linger after close.
- Forwarded-link privacy — unchanged from the existing rule: rank is ordinal and already visible
  to the shipper anyway; still never surface the cost/floor or rival numbers.

## Summary

The reprice page already polls its own state every 4s and the engine already tracks our ordinal
rank (the `/track` page already displays it). Showing live rank in the reprice window is one
already-computed field added to that poll, painted onto one compact line shared with the
countdown — no new panel, no added page height, ordinal only, no rival numbers. Awaiting the
director's go-ahead before any of it is built.
