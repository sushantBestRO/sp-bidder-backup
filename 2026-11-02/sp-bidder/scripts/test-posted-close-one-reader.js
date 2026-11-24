'use strict';
/**
 * One posted close per load, one reader: the GoComet round count and the result receipt both read the
 * FIRST posted close, across an arm, a restart and a re-price.
 *
 * Regression target: the PR-T2a x PR-T6 merge. Both added `postedCloseAt` to the durable intent, T2a
 * for its derived round count (sourced from the price request's earlier snapshot close, provisional-
 * close loads only) and T6 for the receipt's "(posted hh:mm)" (every platform, read off the intent).
 * The merge keeps one field, written by postedCloseFor at the load's first persistence, and one
 * reader, monitor.postedCloseAt. If the two consumers ever read different sources again, the count
 * and the receipt disagree about when the load was posted and this file goes red.
 *
 * THE RUN, per platform. Posted close P = 17 Sep 2026 09:30:00 pm IST; the price request's snapshot
 * close is one increment earlier, S = 09:25:00 pm. Arm with closesAt P and postedCloseAt S, bid round
 * zero, observe one extension (close P + 5 min), restart (new BidEngine on the same intents file,
 * rehydrate), re-price (stop + arm with closesAt P + 5 min and a LATER snapshot, P, which must not
 * replace S), observe a second extension (close P + 10 min), finalize, render the receipt.
 *
 * CHECKS, GoComet (provisional close) and SuperProcure (soft, not provisional):
 *   1. the intent's postedCloseAt is S after the arm, the restart and the re-price
 *   2. the live monitor's postedCloseAt is S after the restart and after the re-price
 *   3. auction_result.postedCloseAt is S and equals the monitor's
 *   4. the receipt reads "Closed - 09:40:00 pm (posted 09:25 pm)"
 *   5. GoComet only: the round count after the second extension is round((P + 10 min - S) / 5 min) = 3,
 *      the count derived from S, not from the moved close or from P
 *
 * _finalize is called directly, as in test-receipt-engine-stamps.js: a soft close only finalizes after
 * a sustained zero, and the facts pinned here are all fixed before it.
 *
 * Offline and deterministic: fake adapters, temp-file DurableScheduler under os.tmpdir(), stubbed
 * Date.now, rand pinned to 0, no network, no sleeps.
 *
 *   node scripts/test-posted-close-one-reader.js
 */
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { clock, closed } = require('./fixtures/result-receipt-copy');

const { istAt, renderResult, hasLine } = h;

const P = istAt(2026, 9, 17, 21, 30, 0);
const EXTEND_MS = 300_000;
const S = P - EXTEND_MS;
const WRITE_MS = 1_000;
const CAP = 3;
const EXPECTED_CHECKS = 9;

const REAL_NOW = Date.now;
let vnow = P - 600_000;
Date.now = () => vnow;

const CLEAN = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function harness(cond, msg) {
  if (!cond) throw new Error(`HARNESS: ${msg}`);
}

const PLATFORMS = {
  gocomet: {
    id: '260917GCPOST',
    companyName: 'Waaree Energies Ltd.',
    caps: { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: CAP,
      closeModel: 'soft', reactiveClose: true, extensionCeiling: null, extensionIncrementMs: EXTEND_MS,
      snipeBudgetMs: 4500 },
    provisional: true,
  },
  superprocure: {
    id: '25799001',
    companyName: 'Durian Industries',
    caps: { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
      closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure' },
    provisional: false,
  },
};

async function career(platformKey) {
  const spec = PLATFORMS[platformKey];
  const file = path.join(os.tmpdir(), `posted-close-one-reader-${process.pid}-${platformKey}.json`);
  CLEAN.push(file, `${file}.tmp`);
  const store = createStore({ backend: 'memory' });
  const events = [];
  const stub = { frame: null, bids: 0 };
  let feed = Promise.resolve();

  const adapter = {
    capabilities: () => ({ ...spec.caps }),
    ensureSession: async () => ({}),
    async getAuctionState() { return stub.frame ? { ...stub.frame } : { ok: false, error: 'no frame' }; },
    async placeBid() {
      vnow += WRITE_MS;
      stub.bids += 1;
      return { accepted: true, myRank: 2, revisionsLeft: Math.max(0, CAP - stub.bids), latencyMs: WRITE_MS };
    },
  };
  const boot = () => {
    const logger = new BidLogger({ store, log: () => {} });
    return new BidEngine(adapter, new DurableScheduler(file), {
      config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0,
        softOpenJitterMs: 0 },
      softClose: { enabled: false, shippers: [], mode: 'live' },
      rand: () => 0,
      onEvent: (e) => { events.push(e); feed = feed.then(() => logger.handle(e)); },
      log: quiet,
    });
  };
  const frame = (closesAtMs, status = 'live') => ({ ok: true, status, closeModel: 'soft', closesAtMs,
    closesInMs: Math.max(0, closesAtMs - Date.now()), extendMs: EXTEND_MS, extendCount: null,
    myRank: stub.bids ? 2 : null, totalBidders: stub.bids ? 4 : null, standingL1Price: null,
    revisionLimit: CAP, revisionsLeft: null, minDecrement: spec.caps.minDecrement, measuredRttMs: 20 });
  const unTimer = (m) => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };
  const tick = async (eng, m, closesAtMs) => {
    stub.frame = frame(closesAtMs);
    await eng._tick(m);
    unTimer(m);
  };
  const meta = (closesAt, postedCloseAt) => ({
    id: spec.id, lane: { origin: 'Degam', destination: 'Akola' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName: spec.companyName, closesAt, postedCloseAt, platformKey,
    rules: { revisionLimit: CAP, minDecrement: spec.caps.minDecrement },
  });
  const inputs = { cost: 48_000, marginsPct: [12.6, 7.2, 6.3] };
  const intentPosted = (eng) => (eng.scheduler.get(spec.id) || {}).postedCloseAt;

  const seen = {};
  let eng = boot();
  vnow = P - 600_000;
  let m = eng.arm(meta(P, S), inputs);
  unTimer(m);
  harness(m.provisionalClose === spec.provisional,
    `${platformKey}: provisionalClose is ${m.provisionalClose}, expected ${spec.provisional}`);
  seen.intentAfterArm = intentPosted(eng);

  for (let k = 595; k >= 4; k -= (k > 30 ? 5 : 1)) {
    vnow = P - k * 1000 - 600;
    await tick(eng, m, P);
  }
  harness(stub.bids >= 1, `${platformKey}: no bid landed in round zero, so the receipt has nothing to report`);
  vnow = P;
  await tick(eng, m, P + EXTEND_MS);
  harness(m.believedCloseAt === P + EXTEND_MS,
    `${platformKey}: the first extension did not move the believed close (${m.believedCloseAt})`);

  eng.kill('restart');
  eng = boot();
  vnow = P + 10_000;
  await eng.rehydrate();
  m = eng.monitors.get(spec.id);
  harness(m, `${platformKey}: rehydrate did not re-arm the load`);
  unTimer(m);
  seen.intentAfterRestart = intentPosted(eng);
  seen.monitorAfterRestart = m.postedCloseAt;

  vnow = P + 20_000;
  eng.stop(spec.id);
  m = eng.arm(meta(P + EXTEND_MS, P), inputs);
  unTimer(m);
  seen.intentAfterReprice = intentPosted(eng);
  seen.monitorAfterReprice = m.postedCloseAt;

  vnow = P + EXTEND_MS;
  await tick(eng, m, P + 2 * EXTEND_MS);
  harness(m.believedCloseAt === P + 2 * EXTEND_MS,
    `${platformKey}: the second extension did not move the believed close (${m.believedCloseAt})`);
  seen.rounds = m.extendsObserved;

  vnow = P + 2 * EXTEND_MS;
  const closing = { ...frame(P + 2 * EXTEND_MS, 'closed'), myRank: 2, totalBidders: 4 };
  stub.frame = closing;
  await eng._finalize(m, closing);
  unTimer(m);
  seen.monitorAtClose = m.postedCloseAt;
  try { eng.kill('test done'); } catch (_) {}

  await feed;
  const resultEvent = events.find((e) => e.type === 'auction_result' && String(e.auctionId) === spec.id);
  harness(resultEvent, `${platformKey}: the engine emitted no auction_result`);
  const record = await store.getDoc('closedBids', spec.id);
  harness(record, `${platformKey}: no closedBids record`);
  const receipt = await renderResult({ record, resultEvent, platformKey });
  return { seen, resultEvent, receipt };
}

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); } else { failures.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
}

process.on('exit', () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } });

(async () => {
  console.log('one posted close per load, read by the round count and the receipt alike');
  const POSTED = closed(clock(21, 40, 0), clock(21, 25));
  for (const platformKey of ['gocomet', 'superprocure']) {
    const { seen, resultEvent, receipt } = await career(platformKey);
    check(`${platformKey} 1 intent keeps the first posted close through arm, restart and re-price`,
      seen.intentAfterArm === S && seen.intentAfterRestart === S && seen.intentAfterReprice === S,
      `intent.postedCloseAt arm ${seen.intentAfterArm}, restart ${seen.intentAfterRestart}, re-price ${seen.intentAfterReprice}; expected ${S}`);
    check(`${platformKey} 2 the monitor reads the same posted close after restart and re-price`,
      seen.monitorAfterRestart === S && seen.monitorAfterReprice === S,
      `monitor.postedCloseAt restart ${seen.monitorAfterRestart}, re-price ${seen.monitorAfterReprice}; expected ${S}`);
    check(`${platformKey} 3 auction_result.postedCloseAt is the monitor's posted close`,
      resultEvent.postedCloseAt === S && resultEvent.postedCloseAt === seen.monitorAtClose,
      `auction_result.postedCloseAt ${resultEvent.postedCloseAt}, monitor ${seen.monitorAtClose}; expected ${S}`);
    check(`${platformKey} 4 the receipt reads "Closed - ${POSTED.value}"`, hasLine(receipt.text, POSTED),
      `rendered: ${String(receipt.text).split('\n').filter((l) => /Closed|ran past/.test(l)).join(' | ') || '(no Closed line)'}`);
    if (platformKey === 'gocomet') {
      const derived = Math.round((P + 2 * EXTEND_MS - S) / EXTEND_MS);
      check('gocomet 5 the round count is derived from the same posted close', seen.rounds === derived,
        `extendsObserved ${seen.rounds}, expected ${derived} from the posted close ${S}`);
    }
  }
  if (failures.length || pass !== EXPECTED_CHECKS) {
    console.error(`\nFAILED ${failures.length} of ${EXPECTED_CHECKS} (${pass} passed): ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log(`\nPASS posted-close-one-reader: ${pass}/${EXPECTED_CHECKS} checks`);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
