# Architecture Seams Spec - cheap-now hedges for Module 1

**For the engineer implementing Module 1.** This is the "do-now" half of the migration/scaling analysis (2026-06-23). The other half - the migrations we deliberately DEFER - is in `docs/SCALING_AND_MIGRATION_ROADMAP.md` (project root docs). Read that for the why; this file is the build spec.

## The one idea

We will eventually run more bidders (GoComet + more SP accounts) and may move hosts (GCP) later. We do **not** migrate now and we do **not** build for GCP now. Instead we build a handful of seams that make a future move a config/additive change instead of a rewrite. Plan the seams, not the migration.

The codebase already validates this: `src/scheduler/durableScheduler.js` documents its own swap path ("replace the JSON file with BullMQ ... the engine doesn't care"), and `src/platform/adapter.js` already isolates the platform so a second bidder is a new adapter, not a new app. These five seams generalize that same discipline to the rest of the state.

**Hard constraint:** these are overlays on the existing 2-week paid Module 1 scope, not a separate project. They are days of work, not weeks. If any seam threatens the go-live timeline, ship Seam 1 (the store) and defer the rest - 1 is the only one that is brutal to retrofit; the others stay cheap later. Do **not** let any of this expand scope into Docker, Redis, a DB, a queue, GCP services, or a language change. None of those are in Module 1.

---

## Seam 1 - one persistence interface (`src/store/`) [HIGHEST VALUE]

**Goal.** Every durable read/write goes through one module, so the backing store can swap (flat files now -> Postgres/Firestore later) without touching the engine, web, scheduler, or auth layers.

**Current state.** The atomic write pattern (write `.tmp` -> `rename`, back up corrupt files) was duplicated in `src/auth/session.js` (deleted 2026-08-04 - it was never wireable, SuperProcure has no refresh API) and `src/scheduler/durableScheduler.js`, each doing its own `require('fs')`. `src/config.js` holds paths (`dataDir`, `intentsFile`, `sessionFile`). There is no shared store; new state (accounts, targets, recipients, floors, users, bid logs) would each invent its own file I/O. That divergence is the thing to prevent now.

**Target shape.**
- `src/store/index.js` exposes a small **async** interface (return Promises even though the file impl is synchronous underneath - so a network-backed impl later does not change a single call site). Two data shapes:
  - **Keyed documents** (config: accounts, biddingTargets, recipients, floors, users, session state): `getDoc(collection, id)`, `putDoc(collection, id, value)`, `patchDoc(collection, id, partial)`, `listDocs(collection)`, `removeDoc(collection, id)`.
  - **Append-only event streams** (the day-1 logging from build-plan Phase 5: bid events, full rank ladders, extension events): `appendEvent(stream, record)`, `readEvents(stream, {from, to})`. This is the future auto-floor training signal - it must go through the store from auction #1, because it cannot be backfilled.
- `src/store/fileStore.js` - the default and only shipping backend for Module 1. It owns the atomic-write + corrupt-file-backup logic (lift it out of `durableScheduler.js` so there is one copy). Documents = JSON files; event streams = append-daily-JSON (the GoComet `logger.js` pattern named in the build plan).
- Refactor `DurableScheduler` and the session store to consume the store (or at minimum the shared `fileStore` primitive) instead of calling `fs` directly. The engine and web layers call `store.*` only.

**Verify.**
- A contract test that an in-memory stub store and the file store both pass identically (proves the seam is real, not leaky).
- Grep gate: no `require('fs')` for application state outside `src/store/`. (Reading static public assets in the web layer is fine.)
- A restart test (shared with Seam 5) still passes after the scheduler is moved onto the store.

**Do NOT.** No real database, no ORM, no migration tooling. The file store is the product for Module 1. The point is the *interface*, so the DB is a later drop-in.

---

## Seam 2 - secrets strictly by reference

**Goal.** No secret value ever lives in committed code or in any stored document. Code resolves secrets through a reference + a resolver, so GCP Secret Manager (or any vault) becomes a drop-in resolver later with zero call-site changes.

**Current state (already on the right path).** The build plan stores creds outside any repo (`~/.secrets/suyashh/deploy.env` + a chmod-600 `.env` on the VPS) and the account abstraction already carries `tokenRef`, not the token. Hold that line everywhere; do not let a token get inlined "just for testing."

**Target shape.**
- `src/secrets/resolve.js`: maps a reference string to a value at use time. Support at least `env:NAME` and `file:/abs/path#jsonKey`. The bidder reads every token/key through this resolver only.
- Account and config records persist the **reference** (`tokenRef: "env:SP_TOKEN_ACME"`), never the secret. Same for the Maytapi/WhatsApp token.

**Verify.**
- A test asserting account/config docs contain only refs (regex for JWT/`AIza`/long base64 secrets = fail).
- Rotating a token = changing the referenced source, no code edit.

**Do NOT.** Do not integrate GCP Secret Manager now - the env/file resolver is enough on the VPS. Just keep secrets behind the resolver so SM is a later `gsm:` resolver case.

---

## Seam 3 - config as data, not code

**Goal.** Accounts, shippers/lanes, per-lane margins, floors, notification recipients, and dashboard users are **data** (store documents), not hardcoded constants - so adding a platform, an account, or a lane is an edit through the dashboard, not a code change + deploy.

**Current state.** `src/config.js` mixes pure engine tuning (`openAtMs`, `rungs`, `openingMarkupPct` - fine to keep as code) with paths. The Phase 2 account abstraction (`{accountId, label, carrierId, tokenRef, branchIds[], enabled}`) is the right model - extend it to all operational config.

**Target shape.**
- Keep pure engine/tuning knobs in `config.js`. Move all *operational* config into store documents with a schema documented in this repo's README.
- Every operational record carries a **`platform`** field (`'superprocure'` now, `'gocomet'` later). This is the unified-shell decision from the build plan made concrete - GoComet slots in additively, never as a fork. Live-tracking rows, accounts, and targets all key on `platform`.
- Dashboard CRUD edits these documents via the store (Seam 1).

**Verify.** Adding a second SP account or a new per-lane margin requires zero code change. Every operational record has a `platform` field. Schema is documented.

**Do NOT.** Do not write any GoComet bidding logic (out of Module 1 scope). Just do not model the data SP-only - leave the `platform` dimension in place.

---

## Seam 4 - environment-based config, no baked assumptions

**Goal.** Anything environment-specific (ports, API base URLs, data dir, log dir, store backend, secret source) comes from env vars with sane defaults. No hardcoded absolute paths.

**Current state.** `config.js` already reads `PLATFORM` and `PORT` from env - good pattern, extend it.

**Target shape.**
- One config surface that reads env with defaults (12-factor-lite). Configurable `dataDir` / `logDir`; no path assumption beyond those.
- A committed **`.env.example`** listing every variable with placeholder/empty values (never a real secret). It is the single source of "what this app needs to run on a new host."

**Verify.** The app runs from a different working directory, different ports, and different data/log dirs with only env changes. `.env.example` covers every var the code reads. No secret appears in `.env.example`.

**Do NOT.** No config framework - plain env + defaults.

---

## Seam 5 - die-and-resume discipline (stateless process over external state)

**Goal.** Any process can be killed at any instant and a fresh one resumes correctly from store state, losing no armed bid. This is the property that turns "run a second instance / move hosts / move to GCP" into an operations task instead of a rewrite.

**Current state.** `DurableScheduler` already does this for bid intents (boot-time re-arm from disk). Extend the *discipline* to the whole process: no state that matters across a restart lives only in memory.

**Target shape.**
- Audit every in-memory `Map`/variable that holds cross-restart-relevant state: armed auctions, account/session state, socket subscriptions to re-establish, anything feeding snipe-timing safety. Each must be reconstructable from the store at boot or re-derivable from the platform on reconnect.
- A documented boot-recovery routine: on start, re-arm every still-open intent from the store and re-subscribe its socket room.
- A "what survives `kill -9` mid-auction" checklist in the README.

**Verify.** A test that arms an auction (against the sim), hard-kills the process, restarts it, and confirms the intent re-arms and the bid still fires at the buzzer. This is the proof the discipline holds.

**Do NOT.** No clustering, no leader election, no multi-instance coordination now (Module 1 is a single VPS process). Build the *property* (a restart/second instance would not corrupt or drop state), not the deployment.

---

## Overall verification gates

1. Store contract test: file impl + in-memory stub pass the same suite.
2. Grep gates: no `fs` for state outside `src/store/`; no secret literals in committed files or stored docs.
3. Restart-during-armed-auction test (Seam 5) passes on the sim.
4. `.env.example` completeness: every env var the code reads is listed, no secrets present.
5. Adding a 2nd account / a new lane margin = a data edit, zero code change (Seams 1+3).

## Out of scope (named, so it is not "forgotten" - it is deferred on purpose)

Docker, Redis/BullMQ, any database, any message queue, any GCP service, multi-instance/HA, multi-tenant isolation, language change. Each belongs to a later trigger-gated paid slice - see `docs/SCALING_AND_MIGRATION_ROADMAP.md`. Pre-building any of them now is over-engineering against the 2-week paid scope.
