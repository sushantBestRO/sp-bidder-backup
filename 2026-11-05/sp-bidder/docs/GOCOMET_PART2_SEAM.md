# The GoComet Part 1 / Part 2 seam

**Status:** accepted, 2026-08-10. Internal engineering note. Extends
`docs/MULTI_PLATFORM_ARCHITECTURE.md`; does not supersede it.

**Line references are against `origin/main` at `14f3887`.** They drift. The gate that does not is
`scripts/test-part1-part2-seam.js`, which asserts every inert hook below is still inert.

---

## What Part 1 does, in one paragraph

**Superseded for bid timing by PR-T2a (2026-09-24):** a GoComet load now bids only at each round's
~5 s buzzer and keeps its floor for the final round - see the status rows under items 1 and 3. The
paragraph below describes the engine before that change.

A GoComet load is discovered, checked against the portal's own shipper allowlist, surfaced to the
pricing desk as a price request with a GoComet badge, priced by a human, armed, and bid. From the
moment it is armed the engine treats the deadline GoComet published as the real one: it establishes
a first bid ahead of that deadline, steps its ladder down when it is outranked, and commits its
best remaining price inside the last 2.5 seconds. **If the auction then extends, the engine does
not react.** It does not count the extension, it does not re-plan around the new deadline, and it
has no budget left to bid with - GoComet allows three revisions per vendor per enquiry and Part 1
spends all three inside the first close window. Roughly two auctions in three extend at least once,
and one observed load extended 22 times, so on those loads the bot's final price sits on the board,
visible to every rival, for the rest of the auction with nothing left to answer with. That is the
behaviour that was described and scoped. Competing through the extension rounds is Part 2.

A non-engineer can check the contract this way: **watch one extending GoComet auction. Part 1 is
working correctly if the bot bids, and then does nothing at all after the first extension.** Any
bid placed in round two or later is Part 2 behaviour that has leaked in.

Two configuration facts belong with that paragraph, because "it bids" is conditional on both:

| Gate | Env | Default | Effect when off |
|---|---|---|---|
| Stack built at all | `GC_ENABLE=1` | off | adapter registers on the token-expiry rail only; nothing polls |
| Writes | `GC_BID=1` | off | `capabilities().biddingEnabled` is false and `armFromRequest` refuses the arm outright (`src/pricing/priceRequests.js:926`), so the desk is told before it types a cost |

---

## Why the engine goes quiet - the three mechanisms, in the code

Nothing in the engine names GoComet. The quiet is produced by three separate fail-closed
degradations, each individually correct, which happen to compose into "run the SuperProcure
hard-close playbook".

**1. The soft-close endgame never engages.** `_resolveSoftStrategy` (`src/engine/bidEngine.js:429`)
returns `'off'` unless the shipper is on `config.softClose.shippers`, and no GoComet shipper is -
deliberately, because that list also drives SuperProcure endgame semantics for any SP shipper whose
name token-matches (`src/platform/gocometStack.js:129`). `'off'` short-circuits `_effectivelyHard`
(`:1870`), the soft-defend branch (`:2293`), `_decisiveBandFor` (`:1946`) and `_observeExtension`
(`:1761`) in one move.

**2. An unknown cap fails closed.** Even if a GoComet shipper were enrolled, `getAuctionState`
publishes `extendCount: null` (`src/platform/gocometAdapter.js:1434`) because GoComet publishes no
cap, so `monitor.extendCap` stays null and `_effectivelyHard` returns true at `:1871`. The comment
there is explicit that this is the D4 degrade: treat the believed close as final and run the proven
hard snipe rather than loop chasing phantom extensions.

**3. No anti-snipe window is published.** `triggerWindowMs` is never emitted by the GoComet adapter,
so `_softFinalShotBand` (`:1917`) returns null, `_decisiveBandFor` (`:1944`) returns null, and
`_decisiveShotDue` (`:1999`) collapses to `_isLastChance` - a flat 2,500ms window from
`DEFAULTS.floorWindowMs` (`:24`). This one is already declared inert at boot by
`INERT_MECHANISMS` in `src/platform/gocometStack.js:93`.

The three revisions are spent as: the establish rung at the `openAtMs` mark
(`_establishThreshold`, `:1258`, 15s remaining by default, reached through the establish branch at
`:2219-2270`); one or more clock-scheduled step-downs when outranked (`:2456-2476`, via
`_scheduledRungIndex` at `:1475`); and the floor snipe inside the last 2.5s (`:2391`). The
revision budget seeds from `caps.revisionLimit: 3` at `:791`.

---

## What Part 2 touches

Every item edits `src/engine/bidEngine.js`, the live-money file. That is the whole SuperProcure
regression surface of the programme, and it is why the split is drawn here rather than anywhere else.

### Item 1 - teach `_effectivelyHard` that "no cap" and "unknown cap" are different facts

| | |
|---|---|
| Site | `src/engine/bidEngine.js:1868` `_effectivelyHard`, and the monitor field it reads (`monitor.extendCap`, set at `:1766-1767`) |
| Today | `extendCap == null` returns true - the D4 fail-closed degrade |
| The gap | The adapter already distinguishes the two: `extendCount: null` means "cap unknown", `extensionCeiling: null` (`gocometAdapter.js:1442`) means "no cap exists, and we know that". The engine reads the first and never the second, so an auction that provably has no final round is handled as one that does |
| Change shape | `_observeExtension` carries `state.extensionCeiling` onto the monitor as a third state, and `_effectivelyHard` returns true only for a *known-exhausted* cap, false for a declared-uncapped auction |
| **SP regression risk** | **HIGH.** `_effectivelyHard` is the entry gate on the soft-defend branch AND on `_decisiveBandFor` AND on `_softEndgameUnlocked`. Every SuperProcure soft branch flows through it. The specific hazard: SuperProcure declares no `extensionCeiling` at all (`realAdapter.js:697`), so a truthiness test rather than a presence test would flip every SP soft load into the new path. Assert `hasOwnProperty` + `=== null`, per `MULTI_PLATFORM_ARCHITECTURE.md`'s "assert on presence, never truthiness" |
| Pinned by | `scripts/test-softclose-extend-sequences.js` (T1a is the cap-0 regression that a previous widening of this gate already broke once), `scripts/test-decisive-band-predicates.js`, and A1 in `scripts/test-part1-part2-seam.js` |
| **What PR-T2a did instead (2026-09-24)** | `_effectivelyHard` is **unchanged**. The "no cap exists" fact is read as a capability, not a state field: `arm()` sets `monitor.provisionalClose = closeIsProvisional(caps)` (`src/platform/adapter.js`, presence test on `extensionCeiling === null`), and `_decide` routes such a load to a new branch, `_decideProvisional`, before the establish, the rank-1 hold and branch 4. That branch counts rounds (`_countProvisionalRounds`: in-process moves and the rounds implied by the close past the posted close persisted at first arm), finds the final round from the load's own `roundPolicy` (per plant on the customer record, default 3, null = uncapped), and bids only at a round's buzzer, plus one middle-band shot in the final round. SuperProcure declares no `extensionCeiling`, so it never reaches the branch; `scripts/test-timing-sp-decisions-unchanged.js` pins that |

### Item 2 - make the floor reachable as a DEFEND when there is no final window to reserve it for

| | |
|---|---|
| Site | `src/engine/pricing.js:203` (`selectRung`, phase `'defend'`, `target = Math.min(target, last - 1)`), and its caller at `bidEngine.js:2365` |
| Today | Every mid-auction step-down is clamped to `last - 1`. The floor is reserved for a final window |
| The gap | On an auction with no final round, that reservation never matures. The floor is permanently unspendable and the reserve is a pure loss. This is the one genuinely new and correct claim in the abandoned `extensionWar.js` (`MULTI_PLATFORM_ARCHITECTURE.md`, "How this dispositions the current GoComet branches") - and it is a parameter, not a 294-line module |
| **Not reachable on GoComet today, and that is the ordering constraint** | The clamp only binds inside the soft-defend branch (`:2293`), which GoComet never enters - `_effectivelyHard` is true, so the load runs the deployed snipe and the floor fires normally at 2.5s. Item 2 becomes relevant only *after* item 1 opens that branch. Shipping it first changes SuperProcure and nothing else |
| Adjacent, and already built | `_lastResortFloor` (`:2087`, pinned by `scripts/test-softclose-floor-reachability.js`) already releases the reserved floor at the buzzer rather than forfeiting it. That is a *never-forfeit* guard on the last tick, not a defend, and it does not make the reserve spendable mid-auction. Do not read its existence as item 2 being done |
| Change shape | `selectRung` takes the clamp bound as a parameter (`floorReserved: boolean`) rather than hardcoding `last - 1`; the engine passes false only where the close model says there is no final window to reserve for |
| **SP regression risk** | **HIGH, and it is the cost-floor path.** The floor rung is the cost floor. Releasing it mid-auction on a SuperProcure soft branch is precisely the 4-of-4 Havells self-extension incident that `_softEndgameUnlocked` (`:1975`) was built to fix - the floor spent at 2.2-2.4s against a 100s trigger window, extending the auction with our best price exposed. `assertAboveFloor` still holds (no bid goes below cost) but the *strategic* protection does not. The parameter must default to the current behaviour, and the caller must be the only thing that changes |
| Pinned by | the ten `scripts/test-softclose-*.js` files, `scripts/test-engine-ladder-invariants.js`, `scripts/test-cost-floor-guard.js` |

### Item 3 - read the floor window from `caps.snipeBudgetMs`

| | |
|---|---|
| Site | `src/engine/bidEngine.js:24` (`DEFAULTS.floorWindowMs = 2_500`), consumed at `:1477`, `:1493`, `:1920` |
| Today | A single static 2,500ms window for every platform |
| The gap | 2,500ms is a SuperProcure number. GoComet's own measured write path is a quote GET (~0.4s) then a submit (645ms / 1,070ms / 2,482ms min/median/max, n=5) run serially - ~2.9s worst case, declared as `snipeBudgetMs: 3000` (`gocometAdapter.js:498`). A snipe released at 2.5s on GoComet can be *late by construction*, and latency compensation cannot help: 2,436ms of the slow submit was `x-envoy-upstream-service-time`, i.e. inside GoComet's own backend |
| Change shape | `floorWindowMs` resolves per stack from `caps.snipeBudgetMs` where declared, falling back to the config default. This is a capability read, not a platform conditional |
| **SP regression risk** | **MEDIUM.** SuperProcure declares no `snipeBudgetMs` (`realAdapter.js:697`), so an absent-means-default resolution leaves SP byte-identical. The hazard is the *shape* of the fallback: `caps.snipeBudgetMs \|\| DEFAULTS.floorWindowMs` would read a declared `0` as absent. Presence test, not truthiness. Widening the window also widens `_isLastChance`, which gates `_lastResortFloor` (`:2087`) - so a wider window makes the never-forfeit release eligible earlier, on every platform that declares one |
| Pinned by | `scripts/test-softclose-decisive-shot-timing.js`, `scripts/test-derive-rung-count.js`, and B2 in `scripts/test-part1-part2-seam.js` |
| **What PR-T2a did instead (2026-09-24)** | `floorWindowMs` stays the static 2,500ms for every load, so `_isLastChance` and `_lastResortFloor` do not move. The engine reads `caps.snipeBudgetMs` at one site, `_writeRunwayMs` (presence test, falls back to `floorWindowMs`), and only provisional-close loads use it: the buzzer is `snipeBudgetMs` + one 1,000ms read interval (5.5s on GoComet), a non-floor rung is held below `snipeBudgetMs` instead of the RTT lead, and `_cadence` aims a read inside the middle band and the buzzer. B2 now expects this read |

### Correction to the ADR

`MULTI_PLATFORM_ARCHITECTURE.md:170` says `snipeBudgetMs` "is declared by the GoComet adapter and
read by nobody". **That is no longer true and has not been since the per-load read budget landed.**
`_decisiveHorizonMs` (`gocometAdapter.js:756`) consumes it to decide when an enquiry's reads become
decisive and take priority in the GET budget.

The consumer is on the READ side and is entirely inside `src/platform/`. Until PR-T2a nothing above
the seam read it; since then the engine reserves write runway from it for provisional-close loads
only (item 3's status row). The adapter's own docblock (`:493-497`) already says this in as many
words: "the declared-and-unread state invariant 8 names is closed for reads and NOT for writes".
The ADR line is the stale artefact, not the code.

---

## Inert hooks - declared, published, or configured, and consumed by nothing

An inert hook nobody wrote down looks like a five-minute wiring job rather than the strategy work it
actually gates, which is why each one is listed here with what turning it on would cost. Every item below is enumerated by
`scripts/test-part1-part2-seam.js`, which fails if any acquires a consumer above the platform seam.

### Capabilities declared by `gocometAdapter.capabilities()`

| Field | Line | Why it is inert | Turning it on would |
|---|---|---|---|
| `snipeBudgetMs` | `:498` | **No longer inert (PR-T2a).** Read by the engine at `_writeRunwayMs` for provisional-close loads only; B in the seam test allows that one file | Item 3 (see its status row) |
| `livenessExpectedMs` | `:511` | **No longer inert (C101/C073).** Read by `notify/heartbeat.js`'s `collectGoComet` to derive the `live` staleness flag off `lastListSucceededAt`; B in the seam test allows that one file | Closed the fourth failure-taxonomy row - the silent one |
| `reactiveClose` | `:447` | The engine already polls rather than precomputing a cutoff, so nothing branches on it | Nothing today. It documents a constraint the engine happens to satisfy |
| `extensionCeiling` (capability) | `:472` | **Read by the desk page** (`server.js:3498`) for the close badge and the budget note. NOT inert, listed here so it is not confused with the state field of the same name | - |
| `allowsTieRate` | `:435` | No ladder or decrement path reads it, on either platform | Permit an equal-rate rung. Untested against GoComet's actual acceptance rules |
| `transitField` | `:473` | The SuperProcure transit refusal is keyed off load rules, not this | Nothing. A GoComet bid carries no transit field to omit |
| `priceWriteType` | `:474` | The adapter writes a number directly; nothing above the seam branches | Nothing. Flagged as a verification-bid checklist item, unproven on the wire |
| `tokenLifetime` | `:476` | Expiry alerting runs off the parsed `exp` claim | Nothing behavioural |
| `multiCargo` | `:449` | **Stated, never acted on** - one boot log line in `server.js:5028`. The behavioural fact is `multiCargoBidSupported`, which the desk page does consume | - |

### State fields published by `getAuctionState()`

No construction-time check can see a per-tick field, which is why they are recorded here and in the
test rather than asserted at stack build.

| Field | Line | Why it is inert | Turning it on would |
|---|---|---|---|
| `triggerWindowMs` | never emitted | **Already declared inert** at boot via `INERT_MECHANISMS` (`gocometStack.js:93`) and warned by `capabilityWarnings`. GoComet does not publish an anti-snipe window | Activate `_softFinalShotBand` / `_decisiveBandFor`, i.e. the fire-above-the-window mechanism built for the 4-of-4 self-extension incident. It cannot be turned on - the portal does not carry the fact |
| `extensionCeiling` | `:1442` | The engine reads `extendCount` and never this. It is the "no cap exists" declaration | Item 1 |
| `biddingClosed` | `:1450` | Deliberately does not feed `status` - a terminal finalize must not sit behind a field never observed on that endpoint | Nothing that should be built. The key is absent from every captured response of that endpoint |

### Engine mechanisms structurally unreachable on GoComet

Not fields, but whole code paths that exist and cannot execute on this portal today. They are the
reason Part 2 is a strategy change and not a wiring change.

| Mechanism | Site | Why unreachable |
|---|---|---|
| Extension counting | `_observeExtension` `:1760` | **Reachable since PR-T2a** for provisional-close loads, through `_countProvisionalRounds` in the `softStrategy === 'off'` branch. The soft-enrolled counting path below it stays unreachable |
| The reserve-gated soft defend | `:2293` | Entry gate is `!_effectivelyHard`, which is true only for a known unexhausted cap |
| The once-per-extension-round latch | `:2353` | Downstream of the branch above |
| The decisive band | `_decisiveBandFor` `:1944` | Returns null for want of `triggerWindowMs` |
| Frozen-countdown extension inference | `:1807` | Inside `_observeExtension`, after the `softStrategy` return |
| Scheduler rehydrate for GoComet intents | `server.js` `attachGoCometStack` | Deliberately not rehydrated - a restart drops an armed GoComet intent rather than resuming a monitor whose rungs the write gate would refuse. **Revisit when `GC_BID` goes on** |

### Configuration with no reader

None found. Every key in `config.gocomet` (`src/config.js:82-210`) resolves to a constructor
argument, a stack gate, or an OTP path that `src/auth/gcOtpAuth.js` reads. The OTP re-auth block
(`:126-172`) is the closest thing to dead weight and is not: `scripts/probe-gocomet-otp.js` exercises
it end to end, and it is what a lapsed monthly JWT is recovered with.

---

## Promotion procedure - Part 1 to Part 2 without a rewrite

In order. Each step is independently mergeable and independently revertible, and the SuperProcure
suite must be green at every one of them without editing a test.

1. **Do not merge `feat/gocomet-extension-engine` (#136) or `feat/gocomet-m1-integration` (#138).**
   Both are 23+ merged PRs behind; merging either reverts ~2,400 lines of soft-close, rank-driven and
   last-resort-floor work. Cherry-pick individual files with `git show <ref>:<path>` if anything is
   wanted from them. This is already ADR policy and is restated because it is the step that undoes
   the whole programme if skipped.

2. **Build the liveness detector first, before any strategy change.** DONE (C101/C073) - it was the
   only item here with no SuperProcure regression risk: `livenessExpectedMs` fed the heartbeat's
   `live` flag, adding a signal without changing any decision. It also gives every later step an
   observation channel: extension rounds you cannot see are extension rounds you cannot verify a
   strategy against.

3. **Carry `extensionCeiling` onto the monitor as state, without acting on it.** One field, set in
   `_observeExtension` beside `extendCap`, read by nothing. Presence-tested (`hasOwnProperty` +
   `=== null`), never truthiness. Merged alone this is provably inert; the test in this repo that
   asserts the engine does not read it comes out in this step and is replaced by one asserting it is
   carried and unread.

4. **Item 1 - split `_effectivelyHard` three ways.** Known-exhausted cap, unknown cap, declared
   uncapped. The first two keep today's answers exactly; only the third is new, and only a portal
   declaring `extensionCeiling: null` can reach it. Verify by mutation: revert the change and confirm
   the new GoComet assertions fail while every `test-softclose-*.js` assertion is unaffected in both
   directions.

5. **Item 3 - resolve `floorWindowMs` per stack.** Independent of item 1 and safer, so it can land
   before or after. Presence test on `caps.snipeBudgetMs`; SuperProcure declares none and must stay
   byte-identical. Check `_lastResortFloor` eligibility explicitly - a wider window moves it.

6. **Item 2 - parameterise the defend clamp.** Last, because it is the cost-floor path and because
   it is only useful once step 4 can tell it there is no final window. `selectRung` gains a
   `floorReserved` parameter defaulting to true; the engine passes false only on a declared-uncapped
   auction that is also `softStrategy !== 'off'`.

7. **Then, and only then, the extension strategy itself** - what to bid in round N, with what
   remains of three revisions. Nothing in steps 1-6 decides that. They make it expressible.

**The rule that keeps this additive:** every step above is a *parameter* the engine already wants,
not a branch on a platform name. If a step needs `platform === 'gocomet'` anywhere outside
`src/platform/`, it is the wrong shape - the engine is missing a capability
(`MULTI_PLATFORM_ARCHITECTURE.md` invariant 7).

**The rule that keeps the split honest:** Part 1 does not get "one small extension improvement" as a
courtesy. Items 1, 2 and 3 are each individually most of Part 2's value, and each is a pricing
decision rather than an engineering one.
