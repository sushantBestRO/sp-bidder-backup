'use strict';

/**
 * Guided demo. Runs the REAL bidding engine against the simulator, ONE auction at
 * a time, narrating what happens at each step so a non-technical viewer can follow
 * exactly what the bot is doing. No server, no live account - safe to run anywhere.
 *
 * Run: node scripts/demo.js
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { AuctionSim } = require('../src/sim/auctionSim');
const { MockSuperProcureAdapter } = require('../src/platform/mockAdapter');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidEngine } = require('../src/engine/bidEngine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (n) => 'Rs' + Number(n).toLocaleString('en-IN');
const L = (s = '') => console.log(s);
const rule = () => L('------------------------------------------------------------');

async function main() {
  const tmpFile = path.join(os.tmpdir(), `sp-demo-${process.pid}.json`);
  const events = [];
  const sim = new AuctionSim({ onEvent: () => {} });
  const adapter = new MockSuperProcureAdapter(sim, { latency: { base: 25, spread: 60 }, transientFailRate: 0.03, sessionTtlMs: 8_000 });
  const scheduler = new DurableScheduler(tmpFile);

  let firstBidSeen = false, everRank1 = false;
  const engine = new BidEngine(adapter, scheduler, {
    config: { openAtMs: 8_000, floorWindowMs: 2_000, rungs: 6 },
    live: true, // pure simulator demo -> bid for real against the sim
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'armed') {
        firstBidSeen = false; everRank1 = false;
        L(`   ARM   ladder ${e.ladder.map(money).join(' > ')}`);
        L(`         (it bids DOWN this ladder; the last rung is your cost floor - it never goes below)`);
      } else if (e.type === 'bid_placed') {
        let note;
        if (!firstBidSeen) { note = 'gets on the board at the top of the ladder (fattest margin)'; firstBidSeen = true; }
        else if (e.rank === 1 && everRank1) note = 'a rival undercut it -> drops one rung to RETAKE rank 1';
        else if (e.rank === 1) note = 'reaches RANK 1 - now winning';
        else note = 'still behind -> gives up one more rung of margin to climb';
        if (e.rank === 1) everRank1 = true;
        L(`   bid   ${money(e.price)}  ->  rank ${e.rank ?? '?'}   (${Math.round(e.closesInMs / 1000)}s left)   ${note}`);
      } else if (e.type === 'alert' && /stood_down|no_revisions/.test(e.kind || '')) {
        L(`   ..    ${e.kind.replace(/_/g, ' ')} (out of bids / can't win above floor - it stops)`);
      }
    },
  });

  await adapter.login();
  sim.startAutoStep(120);

  L('');
  L('============================================================');
  L('  SuperProcure auto-bidder - guided demo');
  L('============================================================');
  L('');
  L('  This runs the real bidding engine against a simulated auction,');
  L('  ONE auction at a time so it is easy to follow.');
  L('');
  L('  A freight reverse auction = the LOWEST bid wins (rank 1). The bot');
  L('  bids down a cost-plus margin ladder: it starts at a fat margin and');
  L('  only gives up margin when it has to - and it NEVER bids below your');
  L('  cost floor. Watch the rank climb to 1, then watch it hold.');
  L('');

  const slate = [
    { competitors: 1, closeModel: 'hard', durationMs: 14_000, rivalFloorFrac: [1.12, 1.20], title: 'easy lane - 1 competitor, hard close',
      watch: 'reaches rank 1 quickly and STOPS - it keeps the fat margin it does not need to spend.' },
    { competitors: 3, closeModel: 'hard', durationMs: 16_000, rivalFloorFrac: [0.96, 1.02], title: 'busier lane - 3 competitors, hard close',
      watch: 'has to step down further to win, but still stops well above your floor.' },
    { competitors: 3, closeModel: 'soft', durationMs: 16_000, rivalFloorFrac: [0.87, 0.93], title: 'soft close - 3 competitors (anti-snipe: a late bid RESETS the clock)',
      watch: 'gets on the board early and DEFENDS rank 1 down to a thin margin - it will not dump to the floor, because a late dump just restarts the timer.' },
    { competitors: 6, closeModel: 'hard', durationMs: 18_000, rivalFloorFrac: [0.80, 0.88], title: 'crowded lane - 6 competitors, hard close',
      watch: 'fights down toward the floor - it will take the floor if it must, but it NEVER bids below your cost (it would rather lose than lose money).' },
  ];

  const armed = [];
  let n = 0;
  for (const cfg of slate) {
    n += 1;
    const a = sim.spawn(cfg);
    const marketRate = Math.round(a.ceiling * 0.85);
    const costFloor = Math.round(a.ceiling * 0.70);
    rule();
    L(`  Auction ${n} of ${slate.length}  -  ${cfg.title}`);
    L(`  lane ${a.lane.origin} -> ${a.lane.destination}   |   your cost floor ${money(costFloor)}   |   ${cfg.competitors} rival${cfg.competitors > 1 ? 's' : ''}`);
    L(`  what to watch: ${cfg.watch}`);
    L('');
    engine.arm({ id: a.id, lane: a.lane, equipment: a.equipment, units: a.units, closesAt: a.closesAt }, { marketRate, costFloor });
    armed.push({ id: a.id, title: cfg.title, costFloor });

    const deadline = Date.now() + cfg.durationMs + 9_000;
    while (Date.now() < deadline) { await sleep(300); if (sim.detail(a.id).closed) break; }
    await sleep(500);

    // ---- plain-English takeaway ----
    const d = sim.detail(a.id);
    const ourBids = sim.get(a.id).bids.filter((b) => b.who === 'US');
    const minBid = ourBids.length ? Math.min(...ourBids.map((b) => b.price)) : null;
    const abovePct = minBid != null ? ((minBid / costFloor - 1) * 100).toFixed(1) : null;
    L('');
    if (d.won && minBid <= Math.round(costFloor * 1.01)) L(`  => WON right at your cost floor (${money(minBid)}) - it spent the margin to take this lane, but never bid below cost.`);
    else if (d.won) L(`  => WON at ${money(minBid)} - that is ${abovePct}% above your cost floor, kept as margin.`);
    else if (minBid == null) L('  => placed no bid (nothing worth bidding on above the floor).');
    else if (minBid <= Math.round(costFloor * 1.001)) L(`  => reached the floor (${money(minBid)}) and stopped - a rival went lower, so it walked away rather than lose money. Floor never breached.`);
    else L(`  => held at ${money(minBid)} (${abovePct}% above floor)${cfg.closeModel === 'soft' ? ' - defending rank 1 on the thin margin' : ''}.`);
    L('');
  }

  // ---- summary + the two invariants that matter ----
  rule();
  let floorBreaches = 0;
  let wins = 0;
  for (const ar of armed) {
    const d = sim.detail(ar.id);
    const ourBids = sim.get(ar.id).bids.filter((b) => b.who === 'US');
    const minBid = ourBids.length ? Math.min(...ourBids.map((b) => b.price)) : null;
    if (minBid != null && minBid < ar.costFloor) floorBreaches += 1;
    if (d.won) wins += 1;
  }
  const sessionRefreshes = adapter.loginCount - 1;
  L(`  result: won ${wins} of ${armed.length}   |   floor breaches: ${floorBreaches}`);
  L(`  the bot never bid below your cost in any auction, and it re-authenticated`);
  L(`  itself ${sessionRefreshes}x mid-run with no manual login.`);
  L('');

  sim.stopAutoStep();
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  const failed = floorBreaches > 0;
  L(failed ? '  SELF-TEST: FAIL\n' : '  SELF-TEST: PASS\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('demo crashed:', e); process.exit(1); });
