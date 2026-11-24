# Soft-close (extension-type) bid logic

A soft-close auction does not end at the posted time. A bid placed inside the **trigger window**
(the last ~100s, per branch) pushes the close out (Havells: +3 min), up to a **cap** of resets
(per branch: 0, 1 or 3). Once the cap is spent, the next zero is final. Most such auctions never
extend at all.

## Inputs

| From | What |
|---|---|
| Desk (per load) | cost; price band = top / middle / lowest margin %; transit days if required |
| Platform (per load, automatic) | allowed bid count (3/10/15/30), min bid gap (Rs 100-1500), trigger window, extension cap, live close time, our rank |

## The price grid (rungs)

- Anchors = the desk's band prices, always kept exactly.
- Extra prices are inserted between anchors, spaced ≥ the platform's min gap.
- Count = min(platform's allowed bids, how many fit in the band at the min gap, 40).
- The lowest price is the **floor**. Nothing ever goes out below it.
- Example: cost 18,000, band 12.6/7.2/6.3, 30 bids allowed, Rs 100 gap
  → 12 prices from 20,268 down to 19,134.

## The run (one auction)

```
WATCH      until remaining <= trigger window + 40s. Bid nothing. Early bids
           only show our hand - the auction is decided at the end.

ESTABLISH  one bid at the TOP price. This also switches on our rank feed
           (the platform reports rank only after we have bid).

then, every poll:

  rank 1 (winning)   -> HOLD. Never improve a winning price.

  rank k > 1, resets remain, inside the trigger window
                     -> DEFEND once per reset: step down (k-1) rungs from
                        where we stand. Never the floor. Then hold until
                        the next reset.

  rank unknown       -> HOLD (blind is not losing).

FINAL      when resets are spent (or the load never had any) and the clock
           is inside the last ~2.5s:
           SNIPE once - fire the HIGHEST rung that still wins:
             target = current rung + (k-1), capped at the floor.
           Rank unknown at the buzzer -> fire the floor (the sure shot).
           If the chosen rung sits closer than the min gap to our own last
           bid, fire the floor instead - the decisive shot is never skipped.
```

## Guarantees

- The floor is only ever the FINAL bid, never a mid-auction move.
- One decisive shot: the snipe fires once; a reset after it just re-runs the same rules.
- One bid slot is always held in reserve so the final shot can never be starved.
- Every step respects the platform's min gap (no rejected revisions).
- Below the floor: never, under any rank, any clock, any config.

## Worked example (cost 18,000, band 12.6 → 2.7, 8 rungs, cap 2)

```
t-30s   watch                                  -
t-22s   ESTABLISH top                          20,268   rank 1
t-13s   rival 20,150 (outside window)          hold     rank 2
t-9s    DEFEND -1 rung (inside window)         20,025   rank 1   reset 1/2
t-13s   rival 19,900 (outside window)          hold     rank 2
t-8s    DEFEND -1 rung                         19,782   rank 1   reset 2/2 - now final
t-2.5s  rival 19,660 -> SNIPE +1 rung          19,539   rank 1   WON
                                               floor 18,486 untouched: +Rs 1,053/truck kept
```

Run it live: `node scripts/walkthrough.js` (deterministic, self-testing).
