# Margin Overrides - Scope (customer-level + bid-level)

Scoping doc for two new margin controls Suyashh asked for:

1. **Customer-level margin override** - a per-customer (per-shipper) margin band + floor, e.g. Syngenta bids at a different band than the house default.
2. **Bid-level margin override** - a one-off band + floor for a single load/auction, overriding whatever the customer/default would give.

Designed so a second platform (GoComet is the named next portal) folds in additively, not as a rewrite.

---

## 1. How margins resolve today (the chain to hook into)

Margins are one global band. There is a single set of numbers applied to every load:

- `marginsPct[]` (e.g. `[12.6, 7.2, 6.3]`) + `minMarginPct` (e.g. `6.3`) live in `ConfigStore` (`src/admin/configStore.js`), edited on the Settings page (`dashboard/src/pages/Settings.tsx` -> `POST /api/config`), persisted through the store seam as `config/current`.

The value then flows, unchanged, down a fixed path:

| Step | File | What happens |
|------|------|--------------|
| Global config held live | `src/web/server.js:56` | `PriceRequestStore` is built with `{ marginsPct, minMarginPct }`; re-synced on every save by `applyConfigValues` (`server.js:1037`). |
| **Discovery snapshots per load** | `src/discovery/discovery.js` -> `PriceRequestStore.createForLoad` (`src/pricing/priceRequests.js:45`) | For each new in-scope load, `createForLoad` writes `marginsPct` + `minMarginPct` **into the request doc**. `load.companyName` is known here. |
| Cost capture | `POST /price/:token` -> `capture()` (`priceRequests.js:88`) | Pricing team submits **cost**; `capture` stamps `price: { cost, marginsPct, minMarginPct }` from the request's own snapshot and validates the ladder builds. |
| Arm | `armFromRequest` (`priceRequests.js:264`) -> `engine.arm(meta, { cost, marginsPct, minMarginPct })` | |
| Ladder build | `bidEngine._planFor` -> `buildBandLadder({ cost, marginsPct, minMarginPct })` (`src/engine/pricing.js:89`) | Opening = highest margin, floor = operating floor (`cost x (1 + minMarginPct)`, clamped to cost). |

### The key insight that makes this cheap

**Everything downstream of the request doc reads exactly two fields: `req.marginsPct` and `req.minMarginPct`.** Capture, arm, the engine, and the pricing math never look at where those numbers came from.

So the entire feature reduces to: **resolve the right band into `req.marginsPct` / `req.minMarginPct` before capture, and record where it came from.** Capture, `armFromRequest`, `bidEngine`, and `pricing.js` need **zero changes**. The floor invariant (`assertAboveFloor`, the two-floor clamp) is untouched and keeps protecting every bid regardless of which band won.

---

## 2. The model: 3-tier precedence

For any load, the effective band is resolved by walking, highest priority first:

```
1. Bid-level override      (this one load/request)          <- operator sets it
2. Customer-level override (this platform + this customer)  <- a saved profile
3. Default band            (platform default -> house default)
```

First hit wins; each tier is a full `{ marginsPct[], minMarginPct }` (not a delta), so there is no ambiguity about how a partial override composes. Every request records a `marginSource` string (`"bid"` | `"customer:syngenta"` | `"default"`) for display and audit.

Resolution happens at **discovery time** (`createForLoad`) for tiers 2-3, because that is where `companyName` is known and where the `/price` page snapshot is taken - the pricing person sees the band that will actually be used. The **bid-level** override (tier 1) rewrites the two fields on the request doc + sets `marginSource = "bid"`, and is set on two surfaces (decided):

- **Pricing person, on the `/price` capture page** - alongside cost, at capture time. This is the primary bid-override surface.
- **Operator, on the dashboard** - to re-price a load already armed/live (behind a confirm, since a live auction is real money).

Customer-level profiles (tier 2) are owned by the operator on the dashboard only.

> Consistency rule (matches how the allowlist already behaves): editing a customer profile or the default band affects **newly discovered** loads only. A load already armed keeps its snapshot - margins are a committed decision once the bot is live on a load. Re-pricing an in-flight load is the bid-level override's job.

---

## 3. Data model

### New collection: `marginProfiles` (customer overrides)

Through the existing store seam (`getDoc/putDoc/patchDoc/listDocs/removeDoc`), one doc per (platform, customer):

```js
// doc key: `${platformKey}:${customerKey}`   e.g. "sp:syngenta"
{
  platformKey: "sp",            // which portal this profile is for
  customerKey: "syngenta",      // normalized (lowercased, trimmed) match token
  customerLabel: "Syngenta",    // display as entered
  marginsPct: [14, 9, 7],       // full band override (highest -> lowest)
  minMarginPct: 7,              // operating-floor margin
  enabled: true,
  updatedAt, updatedBy,         // audit (updatedBy from the admin session)
}
```

`customerKey` matches a load's `companyName` with the **same word-boundary token match** discovery already uses (`discovery.js` `tokenMatch`), so a `"syngenta"` profile applies to `"Syngenta India Ltd"`. Match tie-break (spell out in code): exact case-insensitive match wins; else longest matching token; if still ambiguous, first by `customerKey` sort + log a warning.

### Bid-level override: on the request doc

No new collection. The resolved effective band already lives on the request as `marginsPct` / `minMarginPct`. Add one field for provenance + one for the raw override so it survives a re-resolve:

```js
// added to the price-request doc
marginSource: "default",        // "bid" | `customer:${key}` | "default"
marginOverride: null,           // when set: { marginsPct, minMarginPct, setBy, setAt }
```

Applying a bid override = validate it, write `marginsPct`/`minMarginPct` from it, set `marginSource="bid"`, keep `marginOverride` for the audit trail and so a later "revert to inherited" can recompute.

### Default band (unchanged, reframed)

The existing global `marginsPct`/`minMarginPct` in `ConfigStore` stays as the tier-3 fallback. Per-platform defaults are a trivial later extension (a `default:${platformKey}` row in the same `marginProfiles` collection); **not building that now** - the single global default is the fallback for every platform until a second portal is live.

---

## 4. Backend scope

All new/changed backend files:

1. **`src/pricing/marginResolver.js`** (new) - the one place precedence lives.
   - `resolveBand({ platformKey, companyName, profiles, defaults })` -> `{ marginsPct, minMarginPct, source }`. Pure function, no I/O (takes the profile list in), so it is unit-testable in isolation.
   - Reuse `tokenMatch` from discovery (extract it to a shared util both import, rather than duplicate).

2. **`src/pricing/marginProfiles.js`** (new) - store-backed CRUD for `marginProfiles`, mirroring the `PriceRequestStore` shape.
   - `list(platformKey?)`, `get(platformKey, customerKey)`, `upsert(profile)`, `remove(platformKey, customerKey)`.
   - `validateProfile()` - reuse the exact margin checks from `configStore.validate` (marginsPct non-empty, every entry a finite number >= 0, minMarginPct finite >= 0). Factor those checks into a shared `validateMargins()` so config, profiles, and bid-overrides all validate identically.

3. **`src/pricing/priceRequests.js`** (change)
   - `createForLoad`: replace the `marginsPct = this.marginsPct` default with a call to `resolveBand(...)` using the load's `companyName` + the poller's `platformKey`. Snapshot the resolved band + `marginSource` onto the doc. (Needs the profile store handle + platformKey passed into the constructor.)
   - New `setBidOverride(token, { marginsPct, minMarginPct })` and `clearBidOverride(token)` - validate, rewrite the two fields, set `marginSource`, persist `marginOverride`. Guard on status (`awaiting_price` for the pricing-page path; `armed` for the operator re-price path, which re-arms - see note).
   - `capture(token, { cost, marginOverride })`: extend to accept an **optional** override submitted together with cost (the `/price` page path). When present, validate + apply it before stamping `price`; when absent, behavior is exactly as today. It still re-validates the ladder builds before marking armed.

4. **`src/discovery/discovery.js`** (change) - carry a `platformKey` on the poller (default `"sp"`), pass it to `createForLoad`. Extract `tokenMatch` to the shared util.

5. **`src/web/server.js`** (change) - wiring + endpoints:
   - Build the `MarginProfileStore`, hand it to `PriceRequestStore` + each discovery poller.
   - `GET /api/margin-profiles?platform=sp` - list.
   - `POST /api/margin-profiles` - upsert (body: platformKey, customer, band). Audit via the existing `auditLog`.
   - `DELETE /api/margin-profiles/:platform/:customerKey` - remove.
   - `POST /api/price-requests/:id/margin` - operator sets a bid-level override (the re-price-armed path); `DELETE` same path - revert to inherited.
   - `POST /price/:token` - extend the capture handler to accept an optional override band in the body and pass it to `capture(token, { cost, marginOverride })`. The `priceForm` body parser must accept the band fields.
   - `applyConfigValues`: unchanged (default band still syncs); resolver reads profiles live from the store.
   - `renderPriceForm` (the `/price` page): already prints the band (`server.js:837`) - now it prints the *resolved* band + a "why" line (`Default` / `Customer: Syngenta`), and adds a **collapsed "Adjust margin for this load" expander** with the band + floor inputs, prefilled from the inherited band. This page is hand-rolled server-rendered HTML (not React), so the editor here is plain inputs + a small inline script - keep it mobile-first and collapsed so the default one-tap cost-only flow is unchanged.

6. **`src/admin/configStore.js`** (change) - export the extracted `validateMargins()`; no behavior change.

### Endpoints summary

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/margin-profiles?platform=` | list customer profiles for a portal |
| POST | `/api/margin-profiles` | create/update a customer profile |
| DELETE | `/api/margin-profiles/:platform/:customerKey` | delete a customer profile |
| POST | `/api/price-requests/:id/margin` | set bid-level override on one request |
| DELETE | `/api/price-requests/:id/margin` | revert one request to its inherited band |

---

## 5. Frontend scope

The console already has the multi-portal scaffolding to hang this on: `dashboard/src/lib/platforms.ts` (portal registry), `PortalScopeSelector` (sidebar portal picker), and the portal-scoped nav group. A margins page belongs **inside** that group, so it is portal-scoped by construction.

1. **New page: `dashboard/src/pages/Margins.tsx`** (customer profiles) - portal-scoped, sits in the Portal nav group next to Bidding targets / Price Requests.
   - Table: Customer | Band (opening -> lowest) | Floor margin | Updated | actions. One row per profile for the selected portal.
   - Add / edit row: a customer name (chip/typeahead - can seed from allowlist shippers + recently seen `companyName`s) + the same band editor already built on Settings (the `marginsPct` step inputs + floor-margin field - lift that block into a reusable `<MarginBandEditor>`).
   - Empty state explains the fallback: "Customers without a profile use the default band (Settings)."
   - Wire into `Sidebar.tsx` nav + `App.tsx` routing; add API calls to `dashboard/src/lib/api.ts`.

2. **Settings "Margin band" card (reframe, `Settings.tsx:210`)** - relabel to **"Default margin band"** with a one-line hint that per-customer overrides live on the Margins page. Same editor, extracted to `<MarginBandEditor>` and shared.

3. **`PriceRequests.tsx` - source visibility + operator re-price:**
   - Show the effective band + its source on every row (a small "Customer" / "Override" / "Default" tag near status), read-only, so it is obvious when a load is not on the house band. This is the operator's window into what the pricing page did.
   - A row action "Re-price margin" for `armed` rows (in the `RowActions` menu), behind a confirm - opens the `<MarginBandEditor>` prefilled with the current band, re-resolves + re-arms preserving fired rungs. This is the operator's bid-override path (decided: re-price armed behind confirm).
   - `awaiting_price` rows do **not** get an override control here - that override is set on the `/price` page by the pricing person.
   - API: `setRequestMargin(id, band)` / `clearRequestMargin(id)` in `api.ts`; extend the `PriceRequest` type with `marginSource` + `marginOverride`.

4. **`/price/:token` capture page (`renderPriceForm`) - the primary bid-override surface:**
   - Show the resolved band + a plain-English source line ("Default band" / "Customer: Syngenta").
   - Add a collapsed **"Adjust margin for this load"** expander below the cost field: the band steps + floor-margin inputs, prefilled from the inherited band. Submitted with the cost. This is hand-rolled HTML + a small script (the page is server-rendered, not the React SPA) - keep it phone-first; the default flow stays one-tap cost-only with the expander closed.

5. **Surfacing** - wherever a band/floor already renders (Live Bids ladder, History, the captured-cost confirmation), pass through `marginSource` so an overridden load is visually distinguishable from a default-band one. Read-only; no new controls.

No changes to the engine-facing types (`LiveAuction`, `ClosedBid`) beyond an optional `marginSource` passthrough for display.

---

## 6. Multi-platform forward-compat (the "other platforms later" ask)

Everything above is keyed by `platformKey` from day one, even though only `"sp"` exists:

- `marginProfiles` docs are keyed `${platformKey}:${customerKey}` - GoComet profiles are new rows, no schema change.
- `resolveBand` takes `platformKey` - a GoComet poller passes its own key; same resolver.
- The Margins page is portal-scoped via the existing `PortalScopeSelector` - selecting GoComet (once live) shows its profiles, nothing else moves.
- Per-platform **default** bands slot into the same collection as `default:${platformKey}` rows later, without touching the resolver's shape.
- The discovery poller gains a `platformKey` (default `"sp"`) - matches the existing guidance to "build the shell with a platform dimension so the merge is additive."

This keeps the same-customer-different-portal case (Syngenta on SP vs Syngenta on GoComet) representable without any rework when the second portal lands.

Note: `platformKey` (which portal) is a **different** dimension from the existing `account`/`accountId` (which SP login owns a load). Customer margin profiles are keyed by platform, not by account - two SP accounts share one platform's profiles. Keep the two dimensions distinct.

---

## 7. Invariants preserved

- **Cost floor** - untouched. `buildBandLadder` still clamps the operating floor to `>= cost`, and `assertAboveFloor` still throws before any sub-floor payload. **Corrected 2026-09-09:** this bullet used to end "an override can raise or lower the *band*, never defeat the floor". That was false. The operating floor is DERIVED from the band (`cost x (1 + minMarginPct/100)`, and `minMarginPct` defaults to the band's own lowest margin), so an override moves the floor with it - and at `minMarginPct` 0 the floor lands exactly ON cost, which is the T6 defect: 133 loads floored at cost, 13 won at no margin. What is guaranteed is only the weaker claim: no band can push the floor BELOW cost.
- **Validation parity** - customer profiles and bid overrides validate through the same `validateMargins()` as the global config; a NaN/negative/zero floor margin is rejected at the API, and `capture()` still re-proves the ladder builds before arming (so a bad band can never mark a load armed-but-unbiddable). A zero stored before that rule existed is substituted with the house default at `armFromRequest`, never armed.
- **Snapshot semantics** - resolved at discovery, carried on the request; a profile edit does not retro-mutate armed loads (same as the allowlist today).
- **Audit** - profile edits go through the existing `auditLog`; bid overrides record `setBy`/`setAt`.
- **Store seam** - all new state goes through `src/store/`; no new `fs` touch (keeps the DB/Redis migration path intact).

---

## 8. Decisions

- **A. Override shape - DECIDED: full band + floor.** Faithful to the ladder model; prefilled from the inherited values so the common case is a one-number tweak.
- **B. Who sets what - DECIDED: split by tier.** Customer-level profiles = operator, on the dashboard (Margins page). Bid-level override = pricing person, on the `/price` capture page (primary), plus the operator re-pricing an armed load from the dashboard.
- **C. Re-pricing an armed load - DECIDED: allowed, behind a confirm.** Re-resolve + re-arm preserving fired rungs; gated by a confirmation because a live auction is real money.
- **D. Customer identity - DECIDED (recommended default): free-text shipper token.** Matches how the allowlist works today, zero new concepts. A first-class customer registry is a bigger, separate piece for later. (Flag if you want it revisited.)

---

## 9. Rough sequencing

1. Extract shared `validateMargins()` + `tokenMatch`; add `marginResolver.js` + unit tests (pure, fast).
2. `MarginProfileStore` + endpoints + audit wiring.
3. Wire resolver into `createForLoad` (customer tier live end-to-end, default fallback intact).
4. Bid-override store methods + endpoints.
5. Frontend: `<MarginBandEditor>` extraction -> Margins page -> Settings reframe -> PriceRequests override control + source tags -> `/price` page source line.
6. Surfacing pass (Live Bids / History / capture confirmation show the source).

Test gate stays `npm test` (the offline money-path suite); add resolver + profile-store tests to it.
