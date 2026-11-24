'use strict';

/**
 * Rank-driven endgame - guided, DETERMINISTIC walkthrough.
 *
 * Runs the REAL bidding engine (BidEngine + MockSuperProcureAdapter + AuctionSim +
 * DurableScheduler, the same composition as scripts/demo.js) against a soft-close
 * (anti-snipe) auction, and NARRATES the new rank-driven endgame step by step so a
 * non-technical viewer can follow exactly what the bot does and WHY.
 *
 * Unlike demo.js, this does NOT use the simulator's random rival AI (auctionSim.step()
 * uses Math.random). Instead it drives the auction by hand: it holds the sim clock,
 * scripts explicit rival bids at chosen countdown positions, and pumps the engine one
 * decision at a time. The result is the SAME sequence, the SAME prices and the SAME
 * self-test outcome on every run - safe to run live in front of a room.
 *
 * Two scenarios, back to back:
 *   1. COARSE (a 3-bid shipper, e.g. KEI / Syngenta): establish -> hold rank 1 ->
 *      one defend -> dump the FLOOR at the buzzer (a 3-rung ladder has no better move).
 *   2. FINE  (a 30-bid shipper, e.g. Havells / Renewsys): establish -> hold -> small
 *      rank-driven defends -> snipe the HIGHEST rung that STILL WINS, not the floor.
 *      That is the money shot: the win lands well above the floor, keeping margin a
 *      floor-dump would have thrown away.
 *
 * Run: node scripts/walkthrough.js
 */

// Keep the director-facing narration clean: suppress the routine info/debug operational
// log lines (scheduler rehydrate, engine debug). Genuine warnings/errors still surface.
// Respects an explicit LOG_LEVEL=debug for anyone who wants to watch the engine internals.
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { AuctionSim } = require('../src/sim/auctionSim');
const { MockSuperProcureAdapter } = require('../src/platform/mockAdapter');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { BidEngine } = require('../src/engine/bidEngine');

const money = (n) => 'Rs' + Number(Math.round(n)).toLocaleString('en-IN');
const L = (s = '') => console.log(s);
const rule = () => L('------------------------------------------------------------');

// ---------------------------------------------------------------------------
// Shared, deterministic setup. Cost and margin band come straight from the live
// Havells-class desk band ([12.6, 7.2, 2.7] on cost) so the coarse ladder reproduces
// the plan's documented example exactly: 20268 / 19296 / 18486. Only the platform bid
// cap (revisionLimit) differs between the two runs, which is the single lever that
// turns the coarse 3-rung ladder into the fine 8-rung one.
// ---------------------------------------------------------------------------
const COST = 18_000;
const MARGINS = [12.6, 7.2, 2.7];
const MIN_DECREMENT = 100;

// Engine timing, chosen to make the arc quick and legible (a few seconds of real time):
//   openAtMs      - the bot establishes its first bid at ~this much time remaining.
//   floorWindowMs - the "final window": the ONLY place the floor rung may be spent.
// rungCap PINNED at 8: scripted rival prices below are choreographed for an 8-rung ladder.
// Production default is 0 = auto (bounded by real constraints, not this fixed demo count).
const ENGINE_CFG = { openAtMs: 25_000, floorWindowMs: 3_000, minInterFireMs: 0, rungCap: 8 };

// Soft-close (anti-snipe) config: ENABLED, LIVE, Havells on the opt-in allowlist -> this
// load is rank-driven. reserve/jumpPerRival are the tuning knobs; establishLeadMs keeps the
// establishing bid clear of the anti-snipe trigger window so it doesn't reset the clock itself.
const SOFT_CFG = { enabled: true, mode: 'live', shippers: ['Havells'], reserve: 1, jumpPerRival: 1, establishLeadMs: 3_000 };

// Simulator anti-snipe shape: a bid inside the last 10s pushes the close out by 10s, up to
// TWICE (extendCap). After the cap is spent, a late bid no longer moves the clock and the
// auction is genuinely final - which is when the bot fires its decisive shot.
const SIM_SHAPE = {
  closeModel: 'soft',
  softExtendWindowMs: 10_000, // trigger window: a bid inside this resets the clock
  softExtendByMs: 10_000,     // each reset pushes the close out this far
  extendCap: 2,               // max resets before the auction is final (branchExtendAuctionCount)
  minDecrement: MIN_DECREMENT,
  units: 1,
  lane: { origin: 'Bhiwandi, MH', destination: 'Hosur, TN', equipment: '32ft SXL', weight: 15, baseRate: 18_000 },
};

// ---------------------------------------------------------------------------
// Wiring: ONE engine / adapter / sim / scheduler, reused across both scenarios (like
// demo.js reuses one engine across its slate). The sim clock is a variable we control,
// so "time" only moves when we move it - the whole run is deterministic.
// ---------------------------------------------------------------------------
let simNow = Date.now();
const tmpFile = path.join(os.tmpdir(), `sp-walkthrough-${process.pid}.json`);
const sim = new AuctionSim({ clock: () => simNow, onEvent: () => {} });
const adapter = new MockSuperProcureAdapter(sim, { latency: { base: 2, spread: 0 }, transientFailRate: 0, sessionTtlMs: 3_600_000 });
const scheduler = new DurableScheduler(tmpFile);

// The "current scenario" the narrator prints against. Reset per run.
let cur = null;

const pct = (price) => ((price / COST - 1) * 100).toFixed(1);
const marginNote = (price) => `${money(price)} (${pct(price)}% margin)`;

const engine = new BidEngine(adapter, scheduler, {
  config: ENGINE_CFG,
  softClose: SOFT_CFG,
  onEvent: (e) => {
    if (!cur || e.auctionId !== cur.id) return;
    if (e.type === 'armed') {
      cur.ladder = e.ladder.slice();
      cur.floor = e.floor;
      cur.last = e.ladder.length - 1;
      L(`   ladder (${e.ladder.length} rung${e.ladder.length > 1 ? 's' : ''}):  ${e.ladder.map(money).join('  >  ')}`);
      L(`   floor (never bids below):  ${marginNote(e.floor)}`);
    } else if (e.type === 'extension_observed') {
      cur.extensions = e.extendsObserved;
      L(`      ~ anti-snipe RESET ${e.extendsObserved} of ${e.extendCap} seen -> the close was pushed out; the bot will NOT`);
      L(`        spend its floor while resets remain (a floor dump now would just hand a rival a fresh window).`);
    } else if (e.type === 'bid_placed') {
      cur.bids.push({ price: e.price, rungIndex: e.rungIndex, rank: e.rank, closesInMs: e.closesInMs });
      const first = cur.bids.length === 1;
      const snipe = e.closesInMs <= 3_500; // the final window (floorWindowMs 3000) vs the defend window (~8-9s)
      if (first) {
        L(`      BOT establishes at the TOP rung ${marginNote(e.price)} -> rank ${e.rank}`);
        L(`        (gets on the board at the fattest margin; it only gives margin up when forced).`);
      } else if (snipe) {
        if (e.rungIndex === cur.last) {
          L(`      BOT final snipe: dumps to the FLOOR ${marginNote(e.price)} to steal rank ${e.rank}.`);
          L(`        On a 3-rung coarse ladder the floor is the only decisive move it has.`);
        } else {
          const saved = cur.floor != null ? e.price - cur.floor : 0;
          L(`      BOT final snipe: fires the HIGHEST rung that STILL WINS -> ${marginNote(e.price)} -> rank ${e.rank}.`);
          L(`        It does NOT dump to the floor (${money(cur.floor)}). Won ${money(saved)}/truck MORE margin`);
          L(`        (${pct(e.price)}% vs the floor's ${pct(cur.floor)}%) than a floor dump would have.`);
        }
      } else {
        L(`      BOT defends: steps down ONE rung to ${marginNote(e.price)} -> retakes rank ${e.rank}`);
        L(`        (a small, rank-driven step; the floor stays in reserve for the final window).`);
      }
    }
  },
});

// --- deterministic driver primitives (bound to the current scenario) ---------
async function tick() {
  await engine._tick(cur.monitor);
  // We pump the engine by hand; cancel its self-rescheduled timer so nothing fires
  // between our controlled steps. (Timers are unref'd; clearing an absent one is a no-op.)
  if (cur.monitor.timer) clearTimeout(cur.monitor.timer);
}
function setRemaining(ms) { simNow = sim.get(cur.id).closesAt - ms; }
function rival(who, price) { return sim.submitBid(cur.id, who, price); }
function heldNote(text) { L(`      .. ${text} (currently rank ${cur.monitor.myRank ?? '?'})`); }

function armScenario(revisionLimit) {
  simNow = Date.now();
  const a = sim.spawn(Object.assign({}, SIM_SHAPE, { durationMs: 60_000, competitors: 2, revisionLimit }));
  cur = { id: a.id, cost: COST, floor: null, ladder: null, last: null, bids: [], extensions: 0, monitor: null };
  const meta = {
    id: a.id, lane: a.lane, equipment: a.equipment, units: a.units, closesAt: a.closesAt,
    companyName: 'Havells', // puts the load on the soft-close allowlist -> rank-driven
    rules: { revisionLimit, minDecrement: MIN_DECREMENT }, // Layer 3: fine ladder for a high cap
  };
  const monitor = engine.arm(meta, { cost: COST, marginsPct: MARGINS });
  if (monitor.timer) clearTimeout(monitor.timer);
  cur.monitor = monitor;
  return a;
}

function closeAndReport() {
  simNow = sim.get(cur.id).closesAt + 5_000; // step past the (final) close
  sim.step();                                 // closes the auction; winner = lowest standing bid
  const d = sim.detail(cur.id);
  const snipe = cur.bids[cur.bids.length - 1];
  L('');
  if (d.won) {
    L(`   => WON at ${marginNote(d.ourBid)}, rank 1.`);
  } else {
    L(`   => did not win (rank ${d.finalUsRank}).`);
  }
  const minBid = Math.min(...cur.bids.map((b) => b.price));
  L(`      bids placed: ${cur.bids.map((b) => money(b.price)).join(' -> ')}`);
  L(`      anti-snipe resets ridden: ${cur.extensions} of ${SIM_SHAPE.extendCap}   |   floor held at ${money(cur.floor)} (lowest bid ${money(minBid)})`);
  return { title: cur.title, won: d.won, ourBid: d.ourBid, floor: cur.floor, last: cur.last,
    snipe, minBid, extensions: cur.extensions, ladderLen: cur.ladder.length };
}

// ===========================================================================
// SCENARIO 1 - COARSE (a 3-bid shipper). One defend, then a floor dump.
// ===========================================================================
async function scenarioCoarse() {
  rule();
  L('  SCENARIO 1 of 2 - COARSE ladder  (a 3-bid shipper: KEI / Syngenta class)');
  rule();
  const a = armScenario(3);
  cur.title = 'COARSE (3-bid cap)';
  L(`   lane ${a.lane.origin} -> ${a.lane.destination}   |   cost ${money(COST)}   |   2 rivals   |   anti-snipe cap ${SIM_SHAPE.extendCap}`);
  // (armed event just printed the ladder + floor)
  L('');

  L('  [countdown ~30s]  bot is watching; it holds fire, establishing LATE so its own first');
  L('                    bid does not land inside the anti-snipe window and reset the clock.');
  setRemaining(30_000); await tick();

  L('  [countdown ~22s]  establish window:');
  setRemaining(22_000); await tick();

  L('  [countdown ~15s]  still out front:');
  setRemaining(15_000); await tick(); heldNote('nothing to beat, so it spends no margin - holds the top price');

  L('');
  L('  [countdown ~9s]   a RIVAL undercuts to Rs19,900 (inside the anti-snipe window, so their');
  L('                    late bid RESETS the clock to ~19s):');
  setRemaining(9_000); rival('RIVAL-1', 19_900); await tick();
  heldNote('now rank 2 - but the reset pushed the clock back out, so it waits for the truly final window');

  L('');
  L('  [countdown ~8s]   clock winds back down into the window; time to defend rank:');
  setRemaining(8_000); await tick();

  L('  [countdown resets] the defend was itself a late bid, so it spent the SECOND (last) reset:');
  setRemaining(9_000); await tick();
  heldNote('rank 1 again; resets are now used up - the next time the clock hits zero, it is final');

  L('');
  L('  [countdown ~2.5s] FINAL window, no resets left. A rival sits at Rs18,900:');
  setRemaining(2_500); rival('RIVAL-1', 18_900); await tick();

  return closeAndReport();
}

// ===========================================================================
// SCENARIO 2 - FINE (a 30-bid shipper). Small rank-driven defends, then the
// money shot: snipe the highest rung that still wins, NOT the floor.
// ===========================================================================
async function scenarioFine() {
  L('');
  rule();
  L('  SCENARIO 2 of 2 - FINE ladder  (a 30-bid shipper: Havells / Renewsys class)  << the money shot');
  rule();
  const a = armScenario(30);
  cur.title = 'FINE (30-bid cap)';
  L(`   lane ${a.lane.origin} -> ${a.lane.destination}   |   cost ${money(COST)}   |   2 rivals   |   anti-snipe cap ${SIM_SHAPE.extendCap}`);
  L('   same desk band, but this shipper allows 30 bids -> the 3 anchors expand into a FINE ladder');
  L('   the bot can step down in small increments instead of one big coarse jump.');
  L('');

  L('  [countdown ~30s]  watching, holding (establishes late):');
  setRemaining(30_000); await tick();

  L('  [countdown ~22s]  establish window:');
  setRemaining(22_000); await tick();

  L('  [countdown ~15s]  out front, holding:');
  setRemaining(15_000); await tick(); heldNote('rank 1 at the top price - no margin given up');

  L('');
  L('  [countdown ~13s]  a RIVAL bids Rs20,150 (just OUTSIDE the window - no reset yet):');
  setRemaining(13_000); rival('RIVAL-1', 20_150); await tick();
  heldNote('rank 2, but still outside the anti-snipe window - it holds, no need to react yet');

  L('  [countdown ~9s]   inside the window now - defend rank in a SMALL step:');
  setRemaining(9_000); await tick();

  L('  [countdown resets] that defend was a late bid -> it spent the FIRST reset:');
  setRemaining(9_000); await tick(); heldNote('rank 1 again');

  L('');
  L('  [countdown ~13s]  the rival cuts again to Rs19,900 (outside the window, no reset):');
  setRemaining(13_000); rival('RIVAL-1', 19_900); await tick();
  heldNote('rank 2, outside the window - holds');

  L('  [countdown ~8.5s] inside the window - defend one more small rung:');
  setRemaining(8_500); await tick();

  L('  [countdown resets] the second defend spent the SECOND (last) reset:');
  setRemaining(9_000); await tick(); heldNote('rank 1; resets exhausted - the auction is now genuinely final');

  L('');
  L('  [countdown ~2.5s] FINAL window, no resets left. A rival sits at Rs19,660:');
  L('                    (this is where a coarse bot would panic-dump the floor)');
  setRemaining(2_500); rival('RIVAL-1', 19_660); await tick();

  return closeAndReport();
}

// ===========================================================================
async function main() {
  await adapter.login();

  L('');
  L('============================================================');
  L('  SuperProcure auto-bidder - rank-driven endgame walkthrough');
  L('============================================================');
  L('');
  L('  A freight reverse auction: the LOWEST bid wins (rank 1). The bot bids DOWN a');
  L('  cost-plus margin ladder - it starts at a fat margin and gives margin up only');
  L('  when a rival actually gets ahead of it. It NEVER bids below your cost floor.');
  L('');
  L('  These are SOFT-CLOSE (anti-snipe) auctions: a bid in the final seconds RESETS');
  L('  the clock, up to a per-shipper cap. Once the resets are used up, the auction is');
  L('  final. The new logic is RANK-DRIVEN: the bot holds rank 1 for free, steps down');
  L('  one rung per rival ahead of it, and at the genuine buzzer fires the HIGHEST');
  L('  price that still wins - it does not blindly dump the floor.');
  L('');
  L('  Watch the difference between a 3-bid shipper and a 30-bid shipper.');
  L('');

  const results = [];
  results.push(await scenarioCoarse());
  results.push(await scenarioFine());

  // ---- self-test: the two invariants that matter, asserted on the real bids ----
  L('');
  rule();
  L('  SELF-TEST (the guarantees, checked on the actual bids placed):');
  const coarse = results[0];
  const fine = results[1];
  const checks = [];
  const check = (name, condition) => { checks.push({ name, ok: !!condition }); };

  // 1) hard floor invariant - neither run ever bid below the cost floor.
  check('coarse: no floor breach (every bid >= floor)', coarse.minBid >= coarse.floor);
  check('fine:   no floor breach (every bid >= floor)', fine.minBid >= fine.floor);
  // 2) coarse snipe IS the floor (a 3-rung ladder has no better decisive move).
  check('coarse: final snipe landed ON the floor', coarse.snipe.price === coarse.floor && coarse.snipe.rungIndex === coarse.last);
  // 3) the money shot - fine snipe landed ABOVE the floor, keeping margin.
  check('fine:   final snipe landed ABOVE the floor (margin preserved)', fine.snipe.price > fine.floor && fine.snipe.rungIndex !== fine.last);
  // 4) both actually won.
  check('coarse: won the auction', coarse.won === true);
  check('fine:   won the auction', fine.won === true);
  // 5) each rode exactly the shipper's anti-snipe cap of resets.
  check('coarse: rode exactly the anti-snipe cap of resets', coarse.extensions === SIM_SHAPE.extendCap);
  check('fine:   rode exactly the anti-snipe cap of resets', fine.extensions === SIM_SHAPE.extendCap);

  for (const c of checks) L(`   [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}`);
  L('');
  const marginKept = fine.snipe.price - fine.floor;
  L(`   money shot: fine run WON at ${money(fine.snipe.price)} (${pct(fine.snipe.price)}%), not the floor ${money(fine.floor)} (${pct(fine.floor)}%)`);
  L(`               -> ${money(marginKept)} more margin per truck than dumping the floor would have.`);
  L('');

  sim.stopAutoStep();
  try { fs.unlinkSync(tmpFile); } catch (_) {}
  const failed = checks.some((c) => !c.ok);
  L(failed ? '  SELF-TEST: FAIL\n' : '  SELF-TEST: PASS\n');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('walkthrough crashed:', e && e.stack || e); try { fs.unlinkSync(tmpFile); } catch (_) {} process.exit(1); });
