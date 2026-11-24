# First-bid (establish) logic

How and when the bot places its **first** bid on an auction, and the operator control that
randomizes its timing.

Code: `src/engine/bidEngine.js` (`_decide`, `_establishThreshold` for a hard close,
`_softEstablishThreshold` for a soft one, `_jitteredMark` shared by both). Settings UI: the
"Human-like behaviour" card on the Settings page - which governs the hard-close spread only.

---

## What the first bid is

The first bid is the **establish-presence bid** - the bot's opening move to get itself a rank
on the board. It is defined by two things: its price and its trigger time.

**Price** - always the top of the ladder (`ladder[0]`), i.e. the **highest margin** in the
band (`cost x (1 + maxMargin)`). The bot opens fat and only spends margin later, stepping down
the ladder, if it actually gets outranked. It never opens cheap, and the opening bid never
reveals anything about the cost floor.

**Trigger time** - depends on the auction's close model:

| Close model | When the first bid fires |
|---|---|
| **Hard close** (e.g. Syngenta) | when the live countdown drops to the establish mark (base `openAtMs` = 25s remaining in production config, optionally randomized earlier - see below). Before that the bot stays silent and keeps its margin hidden. |
| **Soft close / anti-snipe, shipper ON the soft-close allowlist** | ahead of the branch's own anti-snipe trigger window, at `max(establish mark, triggerWindowMs + establishLeadMs)` remaining, so the opening bid does not itself push the clock out. |
| **Soft close / anti-snipe, shipper NOT on the allowlist** (every GoComet load today) | when the countdown drops to `softOpenAtMs` = 150s remaining, randomized up to `softOpenJitterMs` = 15s earlier. If the portal publishes an anti-snipe trigger window, the mark is raised to clear it by a fixed 40s lead first and the randomization then applies on top, so the opening bid stays outside the window and still varies between loads. That 40s is a constant on this path, **not** `SP_SOFT_ESTABLISH_LEAD_MS` - that knob belongs to the allowlisted endgame above and does not reach a customer who opted into nothing. |

Until 2026-09-08 the non-allowlisted soft row read "immediately, on the first tick", and that is
what the bot did - which meant every GoComet load put its opening price on the board seconds after
the desk entered a rate, and 376 of 504 of them did so more than an hour before the close. It now
holds. The 150s is not a ladder budget: it is sized so that one legitimate GoComet read outage (a
60-120s cooldown after a rate-limit response, during which the bot cannot see the auction at all)
cannot span the whole window and leave a priced load with nothing on the board.

**One exception, and it is the re-price.** If a load already has a bid on the board and the desk
then corrects its cost, the corrected price goes on the wire on the next tick at whatever the
countdown reads - it is not held to the 150s mark. Holding it would leave the OLD, too-low bid
standing and winnable (on GoComet an extension can push the load back outside the mark, so the
stale price stood for about 2.4 minutes) while the desk has just been told the new price is live.
The hold exists to stop an unbid load revealing its opening price early; once a bid has landed,
there is nothing left to protect. Only that one corrected bid is released - the rest of the ladder
walk still waits for the closing window, so re-pricing does not start the step-down early. Raising
`SP_SOFT_OPEN_AT_MS` does not extend the hold to re-priced loads, because it never applied to them.

Everything after the first bid - holding L1 silently, stepping down the ladder when outranked,
and the final-seconds floor snipe - is separate and unchanged by this control.

---

## Randomized establish time (`openJitterMs`)

By default a hard-close first bid fires at exactly the same countdown mark every auction (15s).
`openJitterMs` spreads that mark so the bot doesn't establish its presence at an identical,
fingerprintable point each time.

**Behaviour:** the first bid fires somewhere in `[openAtMs, openAtMs + openJitterMs]` remaining -
that is, at the base mark or **up to `openJitterMs` earlier**, never later. The exact offset is a
random slice rolled **once per auction** (so the decision is stable across the many ticks inside
one auction), then held for that auction's lifetime.

- One-sided-earlier by construction: the establish can only move to a *higher* remaining time, so
  it can **never** drift toward the final-seconds floor snipe or the latency-lead guard. The
  money-safety timing is untouched.
- The **price** is unchanged - it is still the opening (highest-margin) rung. Only *when* the
  harmless opening bid lands moves.
- `openJitterMs = 0` reproduces the original fixed behaviour exactly (establish at `openAtMs`).
- Soft-close auctions do not use this control. They have their own mark and their own spread - see
  the next section.

**Where it's set:** Settings page -> "Human-like behaviour" -> "First-bid time spread" (ms). It
shares the master on/off toggle with the other human-like knobs: turning the card off forces this
(and the poll jitter) to a fixed rhythm. Changes take effect live, without a redeploy - a running
auction that hasn't established yet picks up the new spread (same random slice, new width).

**Bounds and defaults:**

| | Value |
|---|---|
| Product default | 4000 ms (establish randomly in the 15-19s window) |
| Allowed range | 0 - 15000 ms |
| Engine intrinsic default | 0 ms (deterministic; the product layer sets 4000) |
| Env override | `SP_OPEN_JITTER_MS` |

The 0-15s cap keeps the establish comfortably clear of the floor-snipe window no matter how it's
tuned - the hard limit is enforced in `configStore.js` (`AD_LIMITS`), the same place the poll
jitter, bids/min, and inter-fire caps are bounded.

---

## Soft-close establish spread (`softOpenJitterMs`)

**A different knob from `openJitterMs` above, with a different bound and a different enforcement
point.** It spreads the soft-close mark (`softOpenAtMs`, 150s), not the hard-close one, so nothing in
the section above applies to it.

**It is NOT on the Settings page and NOT under the "Human-like behaviour" master toggle.** Turning
that card off leaves this spread running. That is deliberate: on the soft path, varied first-bid
timing is a requirement in its own right rather than a cosmetic overlay, and collapsing it to a
fixed mark would put every GoComet load on the same countdown reading.

Because it skips the Settings layer it also skips `AD_LIMITS`, so the bound is applied in the engine
instead: the spread is capped at 20% of `softOpenAtMs` (30s at the default), however high the env
var is set. The large direction is the one that matters - it walks the first bid back out toward
rate-entry time and undoes the window.

**Bounds and defaults:**

| | Value |
|---|---|
| Default | 15000 ms (first bid randomly in the 150-165s window) |
| Effective cap | 20% of `softOpenAtMs` (enforced in `bidEngine.js`, not `AD_LIMITS`) |
| Env override | `SP_SOFT_OPEN_JITTER_MS` (the mark itself: `SP_SOFT_OPEN_AT_MS`) |

---

## What is deliberately NOT jittered

The final-seconds **floor snipe** and the hot-poll cadence (checks every 0.2s in the closing
window) are never randomized. That timing is correctness - it is what wins at the buzzer - not
stealth, so it is fixed and not exposed as a setting. `openJitterMs` only ever touches the opening
establish bid.

---

## Note on the standalone harness

`src/engine/snipeHarness.js` is a separate single-load dev/test harness with its own fixed
`openAtMs` (20s) and is not wired to the Settings UI. The establish-time randomization lives in the
production engine (`bidEngine.js`), which is the path the operator console drives. The harness
deliberately keeps a fixed establish mark for reproducible manual runs.

---

## Tests

- `scripts/test-anti-detection.js` case D - establish jitter fires earlier, is rolled once per
  auction (stable), and collapses back to `openAtMs` when the spread is 0 or the card is off.
- `scripts/test-config-store.js` - the `openJitterMs` default and its hard cap.
- `scripts/test-gocomet-establish-timing.js` - the soft-close mark end to end: that a
  non-allowlisted soft load holds rather than bidding on rate entry, that the mark clears both the
  read-cooldown gap and any published anti-snipe window, that the spread varies per load and is
  bounded, and that the hard-close and allowlisted-soft paths are unreachable from these knobs.
- `scripts/test-reversibility-spine.js` case 2 - the soft first-bid TIME is the one deliberate
  change to the non-allowlisted path; the rung logic after it is unchanged.
