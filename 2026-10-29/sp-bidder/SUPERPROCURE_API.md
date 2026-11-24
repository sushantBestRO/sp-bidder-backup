# SuperProcure API — integration map (recon, 2026-06-18)

> **Build truth: `docs/MODULE_1_BUILD_PLAN.md`.** Module 1 = Syngenta **HARD-close** snipe (NOT soft-close — see the corrected close-model section below). The loop (auth / list / socket-rank / bid-write 201) is proven; live socket event shapes + sub-second clock were confirmed under real competition 2026-06-23.

Discovered read-only from the real BRL carrier account (cookie export) + public JS bundle mining.
No bids placed during this initial read-only recon (a real bid was later placed live 2026-06-19 — see the CONFIRMED LIVE section). No secrets in this file.

## Auth — CONFIRMED, and simpler than feared

- Single credential: a cookie named **`token`** on `.superprocure.com` — an **RS256 JWT** issued by `superprocure-sso`.
- Claims: `s_id` (session), `u_id` (user), `p_id` (partner/freighter id), **`type: "carrier"`** (transporter side — correct for BRL), `iat`, `exp`.
- **`exp` ≈ 1 year** out. So auth is "hold this token," not a constant OTP refresh. The session/refresh machinery we built is largely unnecessary here.
- The token authenticates the data API directly as **both** `Cookie: token=<jwt>` **and** `Authorization: Bearer <jwt>` (the bot does not need the SPA/localStorage — only the API).
- `p_id` from the token is very likely the `freighterId` several endpoints require.

## Hosts

- `api.superprocure.com` — the **data API**, base path **`/sp/...`** (the one the bot uses).
- `auth.superprocure.com` / `auth-api.superprocure.com` — SSO + auth/config.
- `connect.superprocure.com`, `connectv2.superprocure.com`, `connect-admin` — carrier-portal surfaces (confirm which the bidding UI actually uses via a HAR).
- `trip`, `supertrack`, `dashboard`, `metabase`, `analytics`, firebase — tracking/BI, not needed.

## Endpoints — CONFIRMED reachable with the token (read-only GET)

| Endpoint | Result | Note |
|---|---|---|
| `GET /sp/loads/getOpenLoadCount` | 200 | open-load count |
| `GET /loadBoard` | 200 | the load board |
| `GET /sp/loads/getLoadDetailsMasterData` | 200 | master data for load detail |
| `GET /sp/fleetManagement/getVehicleList` | 200 | array — BRL's vehicles |
| `GET /sp/vehicleTypes/getVehicleBodyTypes` | 200 | array of {value,label} |
| `GET /sp/loads/loadBoardDetails` | 400 `Invalid value loadId` | real; needs a `loadId` |
| `GET /sp/contract/loadingPatterns` | 400 `freighterId is required` | real; needs `freighterId` (= token `p_id`?) |

## Endpoints — KNOWN from JS bundles, shapes still to confirm

Load listing / board:
- `/loadBoard`, `/sp/loads/loadBoardDetails`, `/sp/loads/getOpenLoadCount`, `/sp/loads/openMarket`,
  `/sp/loads/getLoadDetails`, `/sp/loads/loadLivePrefilled`, `/sp/loads/loadPrefilled`

Auction / ranking:
- `/sp/contract/identifyLaneForAuction`, `/sp/contract/autoRankContractsBulk`,
  `/sp/contract/contractsForLane`, `/sp/contract/identifyLaneForNoRateLive`

Bid (carrier) — WRITE, do NOT call until live go:
- `/sp/bidVehicle`, `/sp/bidVehicle/createTrip_v2`, `/sp/bids`, `/sp/bids/updateNote`

(Full 263-path dump: `data/recon/endpoints-from-bundles.json`, gitignored.)

## The four adapter methods -> SuperProcure mapping (draft)

| Adapter method | Likely endpoint(s) | Still need |
|---|---|---|
| `login` / `ensureSession` | none — paste the `token` JWT (valid ~1yr) | nothing |
| `listAuctions` | `/loadBoard` or `/sp/loads/loadBoardDetails` | the request params + which loads are "live spot/auction" |
| `getAuctionState` (rank + countdown) | `/sp/contract/identifyLaneForAuction` / a bids/rank read | the live response shape (rank, time-left, revisions) — best seen during a live auction |
| `placeBid` | `/sp/bidVehicle` (+ `createTrip_v2`) or `/sp/bids` | the exact POST payload — **needs a HAR of one real bid** (read-only recon can't trigger it) |

## CONFIRMED via authenticated read-only capture (Jun 18)

Auth, fully resolved:
- The SPA reads the JWT from **localStorage** (`authToken`, `authHeader = "Bearer <jwt>"`) — that's why the cookie alone bounced to SSO. The bot sends `Authorization: Bearer <jwt>`.
- **Live channel auth:** connect `wss://api.superprocure.com/socket.io/?EIO=4&transport=websocket`, then emit `42["join_v2","Bearer <jwt>"]`. Auction updates flow on this socket after join.
- Server clock: `GET /sp/base/getAvailableViews?isWeb=1` returns `currentTime` (use for clock-sync instead of the local wall clock).

Marketplace = the bidding surface (route `/marketplace`):
- `POST /sp/loads/openMarket` -> array of market loads.
- `POST /sp/loads/v4` -> `{ loadDetails, bidDetails, totalLoadCountData, pageTotalLoads }` (the load list + bid state).
- `POST /sp/loads/getLoadCount?tab=OPEN_PENDING` -> `{ open, pending }`; `POST /sp/loads/getOpenLoadCount`.
- `GET /sp/base/getHeader?relationShipType=Carrier` -> branches, `isCarrier`, `procurementPermissions`.

Auction mechanic (confirmed from the live UI): a **scheduled live reverse auction** — each load shows "Auction starts at <time>", a **"Quote Per Vehicle"** action, and **"Bid Difference: <n>"** = the per-load **minimum decrement** (seen: 100, 1500). FTL loads, vehicles-required count per load.

## CONFIRMED LIVE 2026-06-19 (during a real auction) — the loop is closed

**Bid-write (placeBid) — captured from a real submit:**
- `POST https://api.superprocure.com/sp/bids/createV2?id=<loadId>&carrier=<carrierId>`
- Headers: `authorization: Bearer <jwt>`, `content-type: application/json`
- Body: `{ load, carrierBranchId, amount, bidNotes:null, type:"E-AUCTION", in:"FTL", vcq:-1, loadLotId:null, reportingTime:null, transitTime:null, requestTime:<ms>, vehicleTypes:[], bidDiscount:0, isOfferRate:false, isWeb:1 }`
- Returns **201 Created**. `amount` = per-vehicle bid. (Implemented in `realAdapter.placeBid`, gated behind `writeEnabled`.)

**Live channel (getAuctionState) — full socket.io protocol decoded:**
1. Connect `wss://api.superprocure.com/socket.io/?EIO=4&transport=websocket`.
2. Emit `join_v2` with `"Bearer <jwt>"`.
3. Per load, emit `auctionStart` `{loadId, isOpenAuction}` to subscribe to its room.
4. Receive `bidListenerV2` `{ bids:[...], fieldsToBeUpdated:{loadEndTime}, loadId, timestamp, ackString }`; reply `bidListenerV2_ACK` `{ackString, companyId, userId, latency}`.
5. Each bid object: `{ id, load, amount, amountPMT, isActive(1=current), bidQuantity, bidVehicleCount, carrierId, companyName, bidRate, rank }` — find our active bid (carrierId === ours, isActive===1) -> its **`rank`** is our live L-rank. `current` events `{time}` are the server-clock heartbeat.

**Close model = PER-SHIPPER (corrected). Module 1 = Syngenta = HARD close.** The blanket "SOFT" claim here was a Renewsys-type observation and is too strong.
- **Syngenta = HARD close** (`extendTime 00:00:00`, `bidsAllowed 3`, `bidDifference 100`) — classic last-bids-at-the-buzzer snipe. **Verified live + demoed 2026-06-23** (socket event shapes + sub-second clock confirmed under real competition). This is what Module 1 ships.
- **Renewsys = SOFT close** — a late bid triggers `ackString:"<loadId>_..._AuctionExtended"` + a new `loadEndTime`, so sniping there is wrong (hold L1 on the thinnest margin, concede a rung only when actually outranked). **Renewsys / soft-close is OUT of Module 1 scope** (the soft path exists and must not regress).

The engine MUST read each load's extend config and branch hard vs soft per load — never assume one global model.

## What's left — RESOLVED 2026-06-23

**Both items below are now CAPTURED:** the bid-write (item 2) live 2026-06-19 (`createV2` -> 201, see the CONFIRMED LIVE section), and the live socket event shapes + sub-second clock (item 1) during a real Syngenta auction 2026-06-23. The integration loop is fully proven; remaining work is the build itself (wire live-rank into the engine + the Syngenta hard-close snipe) per `docs/MODULE_1_BUILD_PLAN.md`. The original two open items are kept below for reference:

## (historical) What was left

1. **Live socket event shapes** — the exact `join_v2` auction messages (rank, time-left, new-bid). Capturable by running the authenticated recon while an auction is actually running (the captured ones were scheduled for the next morning, so only the handshake showed). 
2. **Quote-Per-Vehicle submit payload** — the write body (under `/sp/bidVehicle` / `createTrip_v2` / `/sp/bids`). Needs a HAR of one real quote on a live load (read-only recon deliberately never submits).

Everything else for `src/platform/realAdapter.js` (auth, list loads, load detail, server time, socket subscribe) is mapped. Read + live-subscribe can be built now; the write path lands once (2) is captured.
