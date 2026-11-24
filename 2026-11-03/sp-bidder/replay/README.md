# Replay harness

Deterministic replay/backtest substrate for the bidding engines. Reconstructs real auction
timelines from BRL's own bid history and runs a bidding engine against them, so engine changes can
be compared on evidence rather than argued about.

```
node replay/run-replay.js              # full behavioural report
node replay/run-replay.js --json       # machine-readable summary
node replay/run-replay.js --limit 40   # cap auctions per cohort
node scripts/test-replay-harness.js    # the suite (also runs under `npm test`)
```

---

## The honesty boundary — read this before reading any number

**SuperProcure masks external competitor bid amounts.** The socket only ever exposes BRL's own
account for non-self rows, and the 2026-07-13 capture confirms it directly: all 8 `bidDetails` rows
across 5 account payloads are `Best Roadways Limited`. The GoComet bid logs are BRL's own bot's
output and contain no rival prices either.

The harness therefore **cannot** compute, and **must never** report:

- a counterfactual win rate
- a clearing price
- "we would have won this"
- any rival's price, modelled, estimated or inferred

This is enforced structurally, not by convention: there is no competitor-price field anywhere in
the harness for such a number to live in, `observation.standingL1Price` is pinned to `null` so an
engine cannot accidentally receive one, and a test asserts no outcome-shaped key ever appears in a
metrics summary. Fabricated win-rate numbers have burned this project before.

**A second, subtler boundary: the replay is OPEN-LOOP.** Rank and close-time movement are replayed
from the record; the engine's replayed bids do not feed back into them, because computing the
market's response would need exactly the competitor prices that are masked. Rank in a replay is
**exogenous** — it is the rank BRL's recorded bot held at that instant, not a rank the replayed
engine earned. Rank metrics describe the *conditions the engine decided under*, never a result.

What the harness measures is **behavioural correctness**:

| Question | Where |
|---|---|
| Did the engine fire at all on a load it should have bid? | `fired` / `silent` |
| When did it fire, relative to close and to each extension boundary? | `timing.*` |
| How many revisions did it consume against the platform budget? | `revisions.*` |
| Did it survive the extension war, or exhaust itself early? | `war.*` |
| Did it respect floor and ceiling? | `constraints.*` |
| What rank did it hold over time? | `rank.*` (exogenous) |

**Legal wall.** Only BRL's own bids, own rank, own revision counters and public clock movement are
read. Competitor amounts are never read, stored, modelled or inferred, and nothing here could
coordinate with another bidder. Coordination is bid-rigging under Competition Act s.3(3)(d).

---

## The engine driver interface

An engine is replayed by supplying a **driver**. Five members, two required. You do not need to
read the harness internals to write one.

```js
const driver = {
  name: 'gocomet-engine@v1',              // REQUIRED - appears in the report

  init(ctx) { ... return engineState; },  // REQUIRED - once, before the first tick
                                          //   ctx = { auction, limits, clock, floor, ceiling }

  onTick(engineState, obs) { ... },       // REQUIRED - once per tick, in time order
                                          //   return null to hold
                                          //   return { price, ...meta } to bid

  onResult(engineState, result) { ... },  // OPTIONAL - { accepted, reason, price, obs }

  finalize(engineState, outcome) { ... }, // OPTIONAL - once after the close
};
```

Run it:

```js
const { ReplayHarness } = require('./replay/lib/harness');
const { summariseRun }  = require('./replay/lib/metrics');

const run = new ReplayHarness().run(auction, driver, {
  floor: 25000,                      // optional - breaches are RECORDED
  ceiling: 31000,                    // optional - breaches are recorded AND refused
  revisionLimit: 3,                  // platform budget
  revisionPolicy: 'no-reset',        // or 'reset-per-round'
});
const summary = summariseRun(run, auction);
```

### The observation (`obs`)

Deliberately shaped like the production adapter's `getAuctionState` return, so the SuperProcure
engine plugs in through a thin driver (`replay/drivers/spEngineDriver.js` is ~40 lines of real
logic and is a working example to copy).

| Field | Meaning |
|---|---|
| `nowMs` | virtual clock, epoch ms — **the only legitimate source of time** |
| `closesInMs` | time to the currently believed close, clamped at 0 |
| `closesAtMs` | absolute believed close; **jumps forward on an extension** |
| `myRank` | BRL's recorded rank (exogenous — see above) |
| `revisionsLeft` / `revisionLimit` | budget state |
| `closeModel` | `'soft'` \| `'hard'` \| `'unknown'` |
| `extendMs` / `extendCount` / `triggerWindowMs` | close-model params; `null` where the platform does not expose them |
| `minDecrement` | per-load bid-difference rule, `null` when unknown |
| `extensionsSeen` | clock-move boundaries observed so far |
| `standingL1Price` | **always `null`** — structural |
| `totalBidders` | always `null` — neither platform records it |

### Rules a driver must respect

1. **Never read the wall clock.** Use `obs.nowMs` / `ctx.clock`. This machine's clock drifts
   materially and the drift sign flips day to day; a driver that reads real time makes the whole
   report irreproducible. The suite asserts the tick loop performs zero clock reads.
2. **Be pure with respect to the tick.** Same state + same observation must give the same decision.
3. **Return `{ price }` with a finite number**, or `null`. Extra keys are carried into the report
   untouched, so `rungIndex`, `defend`, `snipe` etc. survive for analysis.
4. **Do not throw.** A throw is caught and recorded as a `driver_threw` violation, but the tick is
   lost.

---

## How auctions are reconstructed

### GoComet — `reconstructed-timeline` (real observed extensions)

GoComet exposes neither an extension counter nor the increment. But every bid record carries
`timeToClosingMs`, so each bid pins an implied absolute close:

```
impliedClose = timestamp + timeToClosingMs
```

For a static deadline that value is constant across an enquiry's bids to within jitter. When it
**slides forward**, the deadline moved. This is the same signal the production engine uses live
(`bidEngine._observeExtension` watches `closesAtMs` jump), so a rebuilt timeline drives the real
code path.

**A forward slide is NOT automatically an extension.** The naive "slide > 60s" detector inflates
counts ~3.5x by swallowing shipper **re-opens**, whose slides run 5 hours to 22 days. Slides are
classified by band (all configurable in `reconstruct.js` `DEFAULTS`, none buried):

| Band | Kind | Rounds counted |
|---|---|---|
| `<= 5s` | `none` (jitter: measured p50 0.15s, p99 ~3.9s) | 0 |
| `5-100s` | `sub_band` | 0 |
| **`100-400s`** | **`extension`** — brackets both documented increments (240s Sachin-Surat, 300s elsewhere) | **1** |
| `400s-1h` | `aliased_multi_round` — real rounds, count not recoverable | 0 (reported separately) |
| `> 1h` | `reopen` (when `bidsSubmitted` also resets) or `unclassified_gap` | 0, and the segment is **cut** |

Measured against the corpus, **100% of in-band slides land within 10s of the 300s grid**, which
reproduces the published close model from bid logs alone — independently of the frozen Postgres
this laptop cannot reach.

**Round counts are a LOWER BOUND**, always, for four separate reasons:

1. Extensions before our first bid or after our last are invisible. The bot only re-bids while it
   is still losing, so it stops observing exactly when it stops caring. *(dominant)*
2. An enquiry with fewer than two timed bids shows no slide at all.
3. Aliased slides hold 2+ rounds each and are deliberately not counted.
4. The bid logs carry **no plant/origin field**, so the per-plant 240s/300s split cannot be applied.

### SuperProcure — `declared-parameter-scenario` (scripted rounds)

**There is no per-tick SP timeline anywhere on this laptop.** The capture is a single snapshot. SP
loads are real, with their own declared `branchAuctionExtendTime` / `branchExtendAuction` /
`branchExtendAuctionCount` / `branchAuctionRemainingTime`, but extension **rounds are scripted, not
observed**. Read every SP result as *"given this real load's declared parameters and N rounds, the
engine did X"* — never as "this is what happened on 13 July".

SP cost basis is likewise a **harness assumption**: the capture contains no BRL cost. The ladder is
anchored so its top rung lands on the load's `ceilingPrice` (or SP's lane-average freight when no
ceiling is published). Any silence is reported with its cause, because an early version of this
anchoring put every rung above the ceiling on 14 Shriji loads and made the engine look silent when
it was simply being refused.

---

## What the local corpus can and cannot support

### Can

- GoComet extension **timelines** with real observed clock movement — 8,114 reconstructed auctions
  across two bots, 107 with at least one confirmed in-band extension.
- The **increment**, independently re-derived (100% on-grid at 300s).
- **Revision-budget behaviour** across extension boundaries — 84 boundaries with counters on both
  sides, the direct evidence on whether the 3-revision budget resets per round.
- SP **declared close models** per branch cell — 58 loads, 20 branch cells, 9 distinct close
  configurations.
- Engine **behavioural comparison** between versions and between assumptions.

### Cannot

- **Any counterfactual outcome.** Competitor amounts are masked. Permanent, not a data gap.
- **The richest extension corpus.** 1,507 explicit extension events sit in an `enquiry_extensions`
  table in a frozen Postgres on BRL's VPS. Not reachable, and deliberately not attempted.
- **Per-plant increments.** The bid logs have no plant/origin field.
- **True round-count distributions.** Everything is a lower bound (four reasons above).
- **Any real SP timeline.** SP scenarios are declared-parameter only.
- **Anything rank-driven on SuperProcure.** The SP capture is a *snapshot*, so it carries no rank
  trajectory: an SP scenario feeds `myRank: null` on every tick. The engine's rank-aware ladder
  (step-down when outranked, the defend/snipe arc, terminal-floor suppression) therefore cannot be
  exercised on SP with local data at all — under a null-rank feed the engine simply re-posts its
  establish rung until the revision budget runs out. Only the GoComet timelines carry real rank
  (from BRL's own recorded bids), which is why the rank-sensitive conclusions in this harness come
  from GoComet replays and never from SP scenarios.
- **SP timer-domain behaviour** — poll cadence, finalize debounce, the `_maybeBid` rate gate, wake
  scheduling, rehydrate. The harness drives the *decision* domain (`_decide`, `_observeExtension`)
  because `BidEngine` has no clock-injection seam and letting its timer chain run would reintroduce
  wall-clock dependence.
- **Anything about the 4 four-customer soft-close candidates under live conditions.** The capture is
  one snapshot from 13 July.

### Corpus provenance — the two GoComet bots are NOT the same bot

`dead/` and `live/` share 114 filenames and **zero are byte-identical**. Activity tells them apart:

| | peak period | collapse | last file |
|---|---|---|---|
| `dead/` | 2025-08 → 2026-03 (4,320 records in Feb) | 2026-04 (2 records) | 2026-06-15 |
| `live/` | thin until 2026-03, then 2026-04 → 07 (3,535 in April) | — | 2026-07-29 |

Handover is **April 2026**. Note this **contradicts the "auth-dead since ~Jan 14 2026" reading**
carried in `automated-bidding/CLAUDE.md` (which already flags the point as CONTESTED): the dead
bot's own logs show 4,320 records at 49.7% success in Feb 2026 and 2,508 at 64.1% in Mar 2026. Its
Postgres froze in January; the bot itself kept bidding successfully for two more months.

They share 591 enquiry keys, so **never pool the two corpora** without de-duplicating.

### Known corpus defects

- `live/bids_2026-01-09.json` is malformed (missing comma between two array elements — an
  interrupted append). ~2 records lost. It is **reported, never repaired**: repairing would mean
  inventing record boundaries.
- `bidPrice` is int (94%), string (5%), float, or absent (1.3%). `timeToClosingMs` is int, float, or
  null (24.9% — `PUBLIC_SUBMISSION` catalogue rows). `revisionsLeft` is present on only ~50% of
  rows. All normalised at the loader boundary; nothing is guessed.
- One SP load (`22590923`) carries the **year-2100 placeholder** `biddingStartTime`. It parses as
  valid, so NaN guards miss it — a known hazard that has previously caused forever-armed loads and
  silent zero-bid misses.

---

## Determinism

Same corpus in, byte-identical report out, every run. Enforced by:

- **Injected time only.** `VirtualClock` is the sole source of `now`; it refuses to move backwards.
- **`WallClockGuard`** counts global clock reads, and the suite asserts the tick loop performs
  **zero**. The engine's `_decide` / `_observeExtension` are already clock-free; they read time only
  from the state object.
- **`LOG_LEVEL=silent`** set before the engine loads — its logger emits wall-clock-stamped JSON to
  stdout, which would both pollute and de-stabilise the report.
- No `Math.random`, total sort keys on every collection, fixed float precision, no absolute paths
  and no "generated at" stamp in the output.

## Layout

```
replay/
  run-replay.js              CLI - the baseline report
  lib/clock.js               VirtualClock + WallClockGuard
  lib/corpus.js              loaders; corpus-optional, reports its own losses
  lib/reconstruct.js         GoComet timeline reconstruction + the band filter
  lib/spScenario.js          SP declared-parameter scenarios + close-model census
  lib/harness.js             the replay loop + the driver contract
  lib/metrics.js             behavioural metrics (no outcome fields exist)
  lib/report.js              deterministic rendering
  drivers/spEngineDriver.js  production SP engine driver (worked example)
scripts/test-replay-harness.js   the suite - picked up by `npm test`
```

Corpus root defaults to `../../automated-bidding` relative to the repo; override with
`REPLAY_CORPUS_ROOT`. The corpora are gitignored in the super-repo, so CI has none — the suite runs
its synthetic fixtures there and skips corpus checks loudly.
