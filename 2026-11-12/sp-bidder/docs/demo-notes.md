# my demo cheatsheet - superprocure auto-bidder

terminal only on purpose. don't show a polished UI - keep it looking like an engine/POC or the 3-week build stops making sense.

## setup (once)
```
cd C:\Users\sidro\all-code\clients\suyashh_best_roadways\automated-bidding\superprocure-bidder
npm install
```
token's wired from the cookies file in Downloads. nothing to type.

## demo (run in order)

# logs into BRL's real account + lists the live auction loads
node scripts/test-real.js

# the bidding brain on a simulator - step by step, climbs to L1, holds, never breaks the floor (always works, no live auction needed)
node scripts/demo.js

# interactive: pick a live load, enter cost, watch it bid 12/8/6 with live rank + countdown (dry-run by default)
node scripts/snipe.js

## what's left = the build (v1 "Auto-Bidder" on BRL)
- connects to his SuperProcure account - bot acts as BRL, securely
- works every day without manual intervention
- watches every live + upcoming auction - nobody glued to the screen

- cost sheet / rate card: load your cost per lane (the one input it needs to run)
- bids the 12/8/6 margin band off that cost; never below the floor
- reaches + holds Rank 1 - Syngenta (hard close): snipes the 3rd bid in the final seconds; Renewsys (soft close): holds L1
- walks away from loss-making loads - won't win below cost

- handles all his loads/day at once, 24/7 on a server - confirm volume with him (30-50/day?)
- live dashboard: rank, your bid, won/lost + a kill switch
- win/loss alerts on WhatsApp / email - ops knows instantly, then places the vehicle on a win

Not included (later / v2):
- lane-rate memory - learns from past auctions, suggests the floor so ops doesn't guess
- multi-vehicle + lot loads - covers the trickier load types fully
- analytics - win rate + margin captured, by lane / shipper / month
- auto-place vehicle on win - closes the loop after winning

