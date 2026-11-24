# SuperProcure Auto-Bidder

Transporter-side auto-bidding bot for freight reverse auctions. Built for Suyashh / Best Roadways.

A reverse auction = lowest price wins. Rank 1 (L1) = current lowest = winning. The bot's job: be L1 at close **without ever bidding below the operator's cost floor**.

> **This demo runs against a built-in SuperProcure _simulator_ — never a live account.** The platform is hidden behind one swappable adapter. When we have the captured API from a real SuperProcure login, we write the real adapter and the engine does not change. A live bid is real money; that step is deliberate and gated.

## Run it

```bash
npm install        # one dependency: express
npm start          # serves http://localhost:4103
```

Open **http://localhost:4103** and click **Run demo**. You'll watch the bot:

- pick up a slate of freight auctions (varying competition, hard + soft close),
- establish a bid, then descend a price ladder only as rivals force it,
- **snipe the floor rung in the final seconds** to steal L1,
- **hold L1 silently** once winning (it never gives away margin it doesn't have to),
- **stand down** on a lane it can't win above its cost floor (refuses to win unprofitably),
- and on soft-close auctions, sit on the thinnest margin instead of sniping (an anti-snipe extension would just reset the clock).

Headless proof (no browser):

```bash
node scripts/demo.js          # runs the real engine vs the sim, asserts the invariants
PORT=4311 npm start &         # then, in another shell:
PORT=4311 node scripts/smoke-server.js
```

## What's "good stuff" here (vs the GoComet reference we started from)

| Concern        | Reference (GoComet bot)                                         | This build                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fire timing    | server countdown, latency-aware (kept — it's the right idea)    | server countdown + half-RTT compensation, adaptive 30s/1s/200ms cadence                                                                                                                               |
| Price ladder   | fixed +9/+7/+5%, 3 coarse rungs, no floor                       | 6 fine rungs, **hard cost-floor invariant asserted at payload build**, decrement-aware undercut when the platform exposes prices                                                                      |
| Restart safety | all in-memory; a restart abandoned live auctions                | **durable intent store + boot supervisor re-arms every live auction**                                                                                                                                 |
| Auth           | one long-lived token, manual re-auth on 401 (once blind 70 min) | expiry parsed from the JWT + **proactive expiry alerts** (30/14/7/3/1 days out) and a mid-auction auth alert; SuperProcure's ~1yr static token has no refresh API, so recovery stays manual by design |
| Idempotency    | in-process mutex only                                           | mutex + per-rung once + revision cap + read-back on uncertain submit                                                                                                                                  |
| Close model    | hard-close timing only                                          | detects and adapts to **hard vs soft (anti-snipe) close**                                                                                                                                             |
| Observability  | passive file logs                                               | live event stream + alerts (auth-dead-mid-auction, stood-down, lost-after-bidding, restart-with-live-auctions)                                                                                        |

## Architecture (the seam)

```
dashboard (public/)            <- polls /api/state every 500ms
        |
   src/web/server.js           Express: state API, arm/stop, demo seed
        |
   src/engine/bidEngine.js     the snipe loop (timing, ladder, idempotency, alerts)
   src/engine/pricing.js       ladder + decrement undercut + floor invariant
   src/scheduler/durableScheduler.js   restart-safe intent store (BullMQ/Redis in prod)
        |
   src/platform/adapter.js     <-- THE SEAM (5 methods)
        |
   src/platform/mockAdapter.js + src/sim/auctionSim.js   <-- the demo backing
                                (swap for src/platform/realAdapter.js once we have the HAR)
```

## Going live (the path from demo to real)

1. Capture one real bid on the client's SuperProcure account as a HAR (Network tab -> Save all as HAR).
2. From the HAR, fill `capabilities()` and implement the 5 adapter methods in `src/platform/realAdapter.js`:
   `login` / `ensureSession` / `listAuctions` / `getAuctionState` / `placeBid`.
3. SuperProcure has no token-refresh API, so there is no `reauth()` to wire. Recovery from a revoked
   session is the console's OTP reconnect (server-side, the minted token never reaches the browser);
   detection is the adapter's own 401/403 latch, which holds every bid and alerts a human.
4. Set `PLATFORM=real`, calibrate the timing knobs in `src/config.js` to SuperProcure's real close behaviour and minimum decrement.
5. Test on one low-stakes auction with a conservative floor before trusting it.

Nothing above the adapter changes. The recon checklist for step 1-2 is in `../README.md`.

## Config knobs (`src/config.js` -> engine)

- `openAtMs` — when to place the first (presence) bid before close.
- `floorWindowMs` — the final window in which the floor rung may fire (the snipe).
- `rungs` / `openingMarkupPct` — ladder shape.

## Safety

- The cost floor is a hard invariant: `assertAboveFloor()` throws before any sub-floor bid can be built.
- The demo never touches a real account (mock adapter only).
- Secrets (`data/session.json`, `data/intents.json`, `.env`) are gitignored.
  </content>
