# Multi-platform architecture - how a second (and fifth) bidding portal lands

**Status:** accepted, 2026-08-10. Supersedes nothing; **extends** `docs/ARCHITECTURE_SEAMS_SPEC.md`
(Seam 3 in particular) and the contract in `src/platform/adapter.js`.

**Audience:** whoever wires the next portal. Today that is GoComet. Fretron, transportEG and PRM360
are already on the table, so this is written for the fifth one, not the second.

---

## The decision, in one line

**Separate the layers, not the platforms.** Wire knowledge is isolated per platform; bidding
strategy is parameterised by close model and ammunition, not by platform name; the product surface
is shared and platform-tagged.

## Why this needed writing down

Two instincts in this repo pull against each other, and both are right:

- `ARCHITECTURE_SEAMS_SPEC.md` Seam 3: *"GoComet slots in additively, never as a fork."*
- The reaction to the first GoComet integration attempt: keep a half-working reverse-engineered
  portal's logic out of the engine.

They only conflict if "platform" is treated as one thing. It is three, and the two statements apply
to different ones. Additive at the data and product layers; isolated at the wire layer; parameterised
in between. The failures in `feat/gocomet-extension-engine` (#136), `feat/gocomet-m1-wiring` (#137)
and `feat/gocomet-m1-integration` (#138) are all explained by that distinction being absent - see
"How this dispositions the current branches" below.

---

## The three layers

### Layer 1 - Platform adapter. Per-platform, isolated. The anti-corruption layer.

Everything that is true of the portal and false of the domain: auth and session model, endpoint
shapes, payload construction, error vocabulary, rate limits, revision budgets, close semantics,
units and price basis.

`src/platform/adapter.js` is already this seam and already does the job. **Nothing outside
`src/platform/` may contain a portal-specific noun.** No `freight_charges_custom_charge`, no
`bid_closing_in`, no `quotes_sent`, no `enquiryKey` beyond the adapter boundary.

This is the [anti-corruption layer](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
in its normal form: a facade plus a translator, one per external system, whose entire purpose is that
the external model never reaches the domain model.

### Layer 2 - Strategy. Per close model, shared across platforms.

**Close model is not a platform property.** SuperProcure runs both hard and soft branches - read
`branchAuctionExtendTime` off the load, never the shipper name. GoComet is soft and extends without a
known ceiling. So a strategy keyed on the platform name is wrong on day one, inside a single platform.

Strategy selects on the facts, not the brand:

| Fact | Drives |
|---|---|
| close model (hard / extending / unknown) | snipe vs extension play vs refuse |
| ammunition (revisions left, revision limit) | how many rungs are affordable |
| price basis + whether we can bid below the operator input | ladder construction |
| standing price visible vs rank-only | whether rank is the only density signal |

This is the layer that makes the extension work and the existing soft-close work converge later
instead of being two engines. It is also why extension logic must **not** be `if`-branched inside
`bidEngine.js`.

### Layer 3 - Product surface. Fully shared, platform-tagged.

Dashboard, `/price/<token>` desk, WhatsApp asks and threading, people roster, alerts, history,
director EOD. One codebase, one store, records carrying `platform` exactly as Seam 3 already
requires.

**Tagging is only half of Seam 3, and the tagging half is already done.** `discovery.js` stamps
`platformKey` on every request it creates and `priceRequests.js` persists it. What is missing is the
*reading* half: a record that carries `platform` and a reader that calls `listAll()` with no platform
term is not an additive integration - it is a silent cross-platform corruption, and it is what the
draft `feat/gocomet-m1-wiring` would have put into the director EOD participation metric.

#### Scoped or labelled - decide by whether a human sees the row

Not every reader should filter, and "filter everything" is its own defect: one operator desk works
both portals, so a desk that priced a GoComet load and then cannot find it in History has been given
a worse product, not a safer one. The line:

| Reader | Treatment | Why |
|---|---|---|
| Client-facing METRICS - director EOD participation %, heartbeat funnel, per-customer EOD | **platform-scoped** | a mixed denominator is wrong and nobody can see that it is wrong |
| Operator VIEWS and bulk EXPORTS - `/api/state`, `/api/price-requests`, `/api/history`, `/api/closed-bids`, every CSV | **cross-platform, with an explicit `platform` column on every row** | one desk works both portals, and a labelled row cannot corrupt anything silently |

The principle underneath: **a scoped reader prevents silent corruption; an explicit `platform` column
makes corruption impossible to be silent.** Both are valid answers. Which applies depends on whether
a human reads the rows.

A reader that is neither scoped nor labelled is the only wrong answer, and it is the one that ships
by default.

---

## The mechanism: adapters declare capabilities, callers never name platforms

`src/platform/adapter.js` already has `capabilities()`. Extend that; do not invent a parallel
mechanism, and do not add `platform === 'x'` tests anywhere.

Current contract carries `standingPriceVisible`, `minDecrement`, `allowsTieRate`, `revisionLimit`,
`closeModel`. A portal that extends needs three more facts, and the domain needs a fourth:

```
extensionIncrementMs: number|null // observed per-round extension increment, in ms; null = extends,
                                  //   increment unknown. Milliseconds so it needs no conversion at
                                  //   any call site, and it is the SAME number the adapter answers
                                  //   from its own accessor - never a second copy of the fact.
extensionCeiling:   number|null   // max rounds if the platform enforces one; null = no known ceiling
priceInputFloor:    'none'|'operator_input'
                                  // 'operator_input' = the ladder cannot go below the number the
                                  //   desk typed (a market-rate portal); 'none' = free to bid down
livenessExpectedMs: number        // if no state observed within this window, the adapter is silent,
                                  //   not idle - see "Silent failure" below
platformLabel:      string        // what the OPERATOR calls this portal. The product surface holds
                                  //   no portal name of its own, so the badge on the pricing desk
                                  //   reads this rather than mapping a key to a display string.
biddingEnabled:     boolean       // is this portal in a state to accept a bid at all. ABSENT reads
                                  //   as true, so an adapter that predates the field still arms.
```

**Rule:** if a caller outside `src/platform/` needs to know which portal it is talking to in order to
behave correctly, that is a missing capability, not a missing conditional. Add the field.

**Two audiences, two lists.** The engine and the product surface read different capabilities and fail
differently when one is missing: the engine misprices, the page misstates. Keep the construction-time
assertions as SEPARATE lists (`ENGINE_CAPABILITY_READS`, `SURFACE_CAPABILITY_READS`) rather than one
merged set, so an alert says which layer is affected instead of making a web-layer omission read as an
engine fault. A capability both layers consume - `revisionLimit` is the current example, driving the
ladder and the desk's budget line - gets ONE entry with a comment naming both consumers.

**Assert on presence (`!== undefined`), never truthiness.** `extensionCeiling: null` and
`standingPriceVisible: false` are declarations, not omissions, and a truthiness check inverts exactly
the fact those fields exist to carry.

Grounding, and it is a near miss rather than a live defect. The draft branch `feat/gocomet-m1-wiring`
compares against a hardcoded `PLATFORM_SP` literal while the same fact is configurable via
`SP_PLATFORM_KEY` (`src/config.js`). Setting that env var to anything but `sp` would then refuse every
SuperProcure price capture - the live money path - because two mechanisms would exist for one fact.
**`PLATFORM_SP` does not exist on `main`** (`git grep PLATFORM_SP origin/main -- src` is empty); it was
caught in review and never shipped. It is cited here because it is the cleanest example of the failure
the rule prevents, not because the tree carries it.

---

## Invariants (checkable, and meant to be enforced in review)

1. No portal-specific identifier appears outside `src/platform/`.
2. No `platform === '<literal>'` comparison anywhere. Compare against `config.platformKey`, or
   better, read a capability.
3. One vocabulary per fact. The close model is the `softClose` + `closeModelKnown` boolean pair on a
   **load**; the `closeModel` string is adapter/state vocabulary. An adapter sets both booleans on
   every mapped load. This is already stated in `adapter.js` and is worth restating because failing
   to do it is what made a permanently-extending auction read as in-scope for a hard-close-only
   deployment.
4. Unknown shape fails closed. `closeModelKnown: false` holds a load out of scope; it never guesses.
5. Every reader of a shared store either filters by platform or labels every row with it. Neither is
   the only wrong answer. See "Scoped or labelled" above for which applies.
6. Strategy code does not import from `src/platform/<portal>/`.
7. A new portal is a new adapter plus config data. If it needs an engine change, the engine is
   missing a parameter.
8. **An adapter omission must not degrade the engine silently.** Where the engine reads a field an
   adapter does not publish, it falls back - and the fallback is invisible. This splits in two, and
   the distinction is load-bearing because only one half is checkable at construction:

   **Capabilities** are static, declared by `capabilities()`, and CAN be asserted when a stack is
   built. Assert on presence (`!== undefined`), never truthiness: `revisionLimit: null` and
   `standingPriceVisible: false` are legitimate declarations, not omissions. The opposite failure
   also counts - `snipeBudgetMs` is declared by the GoComet adapter and read by nobody.

   **State fields** are per-tick, returned by `getAuctionState()`, and no construction-time check can
   see them. `triggerWindowMs` is the live example: `realAdapter` sets it from
   `triggerWindowSeconds`, the engine reads `state.triggerWindowMs`, and the GoComet adapter simply
   never emits it - so `_softFinalShotBand` returns null, `_decisiveBandFor` returns null, and the
   whole "fire above the anti-snipe window" mechanism, built to fix a 4-of-4 self-extension incident,
   is **inert on GoComet**, silently replaced by a flat 2,500ms floor window.

   So: assert capabilities at stack construction, and for a mechanism a portal cannot drive, declare
   it inert **in one place, loudly at construction, with a test that fails if the adapter ever starts
   publishing the field**. A declaration with no such test rots into a lie the day the gap closes.

---

## Failure taxonomy - four layers, four detectors

Third-party integration failures separate by origin layer, and each needs a different detector and
recovery path ([multi-provider failure taxonomy](https://arxiv.org/html/2607.17525)). Mapped to this
system:

| Layer | Examples here | Detector | State |
|---|---|---|---|
| Identity / auth | 30-day JWT with no refresh; portal-side session revocation | fail closed, alert | shipped (#147, #155) |
| Transport | rate-limit 429s, timeouts, body-less 304 | classify, skip tick, back off | shipped (#154) |
| Upstream semantics | 422 on a quote that is not a reduction; revision budget exhausted | classify by reason, stand down | partial |
| **Execution / silent** | **an auction extends and the monitor never learns** | **liveness expectation** | **missing** |

The fourth row is the one that costs money and the one nothing currently detects.

### Silent failure is the class to design against

The reference implementation captures the close time once at arm time and never re-derives it. Worse,
the one place it does read the live countdown, it folds the difference into a clock-offset term - so
an extension is not merely unhandled, it is **misread as clock skew**. There is no error, no log, and
no alert. The auction simply goes unattended.

Loud failures are cheap: something throws and something retries. Silent failures need a positive
expectation to violate. Hence:

**Requirement.** Every adapter declares `livenessExpectedMs` and every armed auction emits a
heartbeat carrying the platform's own countdown. Absence of an expected observation raises an alert.
A monitor that stops observing must be indistinguishable, to the alerting layer, from a monitor that
crashed.

---

## Integrating a portal with no specification

For GoComet - and for every portal after it - there is no published spec, no versioning, and no
deprecation notice. The API was established from captured traffic. That changes what "testing the
integration" means: [contract drift against a captured baseline is the only available
coverage](https://www.apiscene.io/api-security-identity/api-drift-detection/), because there is no
spec to diff.

Practices that follow:

- **Fixtures are the contract.** Captured real responses are committed as fixtures and the adapter
  is tested against them. When the portal changes, a fixture test fails - that is the only early
  warning available.
- **Assert the shape, not just the parse.** The drift that breaks integrations is optional fields
  going null, enum values outside the known set, and precision changes
  ([when the spec lies](https://dev.to/copyleftdev/title-when-swagger-lies-fixing-api-drift-before-it-breaks-you-ijo)).
  None of these throw. Validate at the adapter boundary and reject rather than coerce - #154's
  refusal of a quote carrying more than one freight-charge group is the pattern to generalise.
- **Record every unrecognised field once.** An unknown key is the earliest signal that the portal
  changed. Log it at the boundary, do not silently drop it.
- **Census the endpoint before declaring a field on it.** A field read type-strictly from a response
  that never carries it resolves to "not reported" forever - safe, but it is a contract field that can
  never carry a value, and any future gate on it silently never fires. Worked example: `bidding_closed`
  was published from `getAuctionState` on the reasonable-looking grounds that it appears in an
  adjacent allowlist. Parsing all 44 captured `bidding-data` responses showed the endpoint returns
  exactly seven keys and that is not one of them: `bid_close_time`, `bid_closing_in`,
  `bid_opening_in`, `current_server_time`, `revisions_left`, `total_revisions`, `vendor_rank`.
  Cheap to check, and the alternative is a dead branch nobody notices.
- **Never let a captured credential into the repo.** Portal tokens are rendered into page HTML, so a
  capture is a live credential. They live behind the Seam 2 resolver, by reference, always.

---

## How this dispositions the current GoComet branches

Measured against `origin/main` on 2026-08-10:

| Branch | Insertions / files | Behind main | Where the work sits |
|---|---|---|---|
| #136 `feat/gocomet-extension-engine` | 1,918 / 6 | 23 | `gocometCloseModel.js` 367, `extensionWar.js` 294 standalone; **`bidEngine.js` +270** |
| #137 `feat/gocomet-m1-wiring` | 758 / 10 | **0** | 392 src spread across discovery, notify, pricing, web, config |
| #138 `feat/gocomet-m1-integration` | 3,237 / 18 | 23 | superset of both; **`bidEngine.js` +336**, engineAlerts +90, waTemplates +59 |

Read through the three layers:

- **`gocometCloseModel.js` is worth lifting** - it is the only artefact that makes "reconstruct the
  close model from one countdown" testable, and its research base is not worth re-deriving. But it is
  rehomed to `src/platform/` (it holds a table of portal plant names, so invariant 1 applies to it) and
  inverted from an engine-side state machine into an adapter-side translator whose output leaves as
  ordinary state fields the engine already understands.
- **`extensionWar.js` is not worth lifting.** Measured against current main rather than the base it was
  written on, the SP engine has independently grown roughly 70% of it - establish-not-gated-on-rank,
  the holding-L1 check, the blind-rank guard, once-per-round defend, budget-exhausted stand-down. Its
  one genuinely new and correct claim is that clamping every step-down to `last - 1` makes the floor
  permanently unspendable where there is no final window to reserve it for. That is a parameter, not a
  294-line module.
- The `bidEngine.js` deltas (+270 / +336) are layer-2 logic forked into an SP-shaped engine. Discard.
  Their content becomes strategy parameterised on close model and ammunition.
- #136 and #138 are 23 merged PRs behind; `git diff` against them shows `bidEngine.js` losing ~2,400
  lines, i.e. merging either would **revert** the soft-close, rank-driven and last-resort-floor work.
  **Never merge them - cherry-pick individual files by `git show`.**

Net: the branches are **most complete on the deferred half** (extension strategy) and **least sound
on the near-term half** (intake wiring).

---

## Verification gates

Additional to the five in `ARCHITECTURE_SEAMS_SPEC.md`:

6. Grep gate: no portal-specific identifier outside `src/platform/`.
7. Grep gate: no `platform === '<literal>'` comparison; `config.platformKey` or a capability instead.
8. Every mapped load carries `softClose` and `closeModelKnown`. A contract test asserts an adapter
   that omits them is rejected, not defaulted.
9. Adapter fixture suite runs against captured real responses; an unknown field is surfaced.
10. A liveness test: arm an auction on the simulator, stop the state feed, and confirm an alert
    fires within `livenessExpectedMs` rather than the auction going quietly unattended.
11. Every shared-store reader either filters by platform or carries a comment saying why it does not.

## What this does not change

No new runtime, no database, no queue, no service split. A portal is still a module in this process,
its config is still store data, and the file store is still the backend. The out-of-scope list in
`ARCHITECTURE_SEAMS_SPEC.md` stands unchanged.

## References

- [Anti-corruption layer, Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
- [Anti-corruption layer, microservices.io](https://microservices.io/patterns/refactoring/anti-corruption-layer.html)
- [API drift detection](https://www.apiscene.io/api-security-identity/api-drift-detection/)
- [When the spec lies - undocumented drift](https://dev.to/copyleftdev/title-when-swagger-lies-fixing-api-drift-before-it-breaks-you-ijo)
- [A taxonomy of failure modes in multi-provider infrastructure](https://arxiv.org/html/2607.17525)
