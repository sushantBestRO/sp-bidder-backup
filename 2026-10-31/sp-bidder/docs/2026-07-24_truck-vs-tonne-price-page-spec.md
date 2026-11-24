# Spec: truck-vs-tonne disambiguation on the price page (desk vehicle-count override)

Status: DRAFT for Sid's approval BEFORE build. Pairs with PR #73 (multi-vehicle bid-max-always).

## The problem this solves

SuperProcure gives us a `units` number on FTL loads. On a genuine multi-vehicle load that number
is the truck count and the bot correctly bids `vcq:N` (all N trucks). But the same field can carry
a **tonnage** on some loads (e.g. `units: 40` meaning 40 MT). With bid-max-always, "bid the full
count" would then bid **40 trucks** on a 40-tonne load - a catastrophic, unrecoverable over-commit.
The read-back oracle only catches the mismatch AFTER the bid is placed. So the fix needs a
human catch BEFORE the bid, and the desk needs a way to say "that number is tonnes, not trucks."

## The design

On a multi-vehicle load, the price page adds ONE disambiguation block above the cost input:

> SuperProcure lists this load as **N**.
> Is that **N trucks** or **N metric tonnes**?
>   [ N trucks ]   [ N metric tonnes ]

- **"N trucks"** (default, pre-selected - the common case): the bot bids for N vehicles. One tap,
  nothing else changes. A normal multi-vehicle load prices exactly as it does today.
- **"N metric tonnes"**: a second field appears - "How many vehicles will carry this?" - and the
  desk enters the real truck count. The bot then bids for **that** count. This is a correction of
  a misread, never sandbagging: the bot still bids for ALL the real vehicles (honours "never less").

The green "THE BOT WILL BID FOR X VEHICLES" banner updates live to reflect the choice, so the
number the bot commits to is always the last thing the pricer sees before submitting.

## Rules

- Single-vehicle loads: this block never shows. Unchanged, one-tap as today.
- Default is "trucks" so the common case is friction-free; the tonnage path is opt-in.
- The vehicle-count field (tonnes path) validates: positive integer, sensible upper bound
  (reject a fat-fingered 100). Blank/invalid blocks submit.
- The confirmed count flows through `armFromRequest` -> the intent meta -> `_multiVehiclePlan` ->
  `vcq`. The desk's choice (trucks vs tonnes, and the entered count) is written to the audit log.
- Re-price surface: same block, same rules; a load already priced shows the prior choice.

## What stays untouched (safety)

- Cost FLOOR (`assertAboveFloor`/`buildLadder`) - this changes the vehicle COUNT, never the price.
- `vcq` invariant (`assertValidVcq` rejects 0/NaN/fraction), kill-switch, and the read-back oracle
  (`vehicle_count_mismatch`) - all unchanged; the oracle stays the post-bid backstop.
- Server-side validation of the cost/margin path is untouched.

## Commercial note

This is the safety net that makes "bid max always" safe, so it rides with PR #73 (the multi-vehicle
graduation) rather than being priced separately - it's the guardrail on a feature, not a new feature.
