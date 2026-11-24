'use strict';
/**
 * EXTENSIONS AFTER OUR LAST BID WHEN THE PUBLISHED INCREMENT IS ZERO.
 *
 * Regression target: F2 (timing-result-alerts review, found by execution).
 *
 * On a soft-off or non-soft load, _closeAfterLastBid counts extensions as how far the close moved
 * divided by extendIncrementMs(state). That helper returns a published increment untouched when it is
 * finite and >= 0, so a published extendMs of 0 becomes the divisor: an unmoved close gives 0/0 = NaN
 * on auction_result.extensionsAfterLastBid, and a moved close gives x/0 = Infinity, which the receipt
 * renders as "Extended Infinity times after our last bid". Real adapters never publish 0, but the
 * engine must not emit a non-number when something does.
 *
 * Contract: with a published increment of 0 there is no extension mechanic, so an unmoved close is 0
 * extensions after our last bid and a moved close is null (cannot be converted into a count).
 *
 * WHAT MUST NOT MOVE:
 *   - a published 300 s increment with one 300 s move after our last bid still counts 1 (check d).
 *   - an unpublished increment (null -> the engine's fallback) on an unmoved close still counts 0 (check e).
 *
 * Offline and deterministic: real BidEngine, fake GoComet-like adapter, temp-file DurableScheduler,
 * stubbed Date.now, no network, no sleeps.
 *
 *   node scripts/test-result-extensions-zero-increment.js
 */
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

const { istAt, renderResult } = h;

const P = istAt(2026, 9, 17, 21, 30, 0);
const MOVE_MS = 300_000;
const WRITE_MS = 3_600;
const CAP = 3;
const CUSTOMER = 'Waaree Energies Ltd.';

const REAL_NOW = Date.now;
let vnow = P - 600_000;
Date.now = () => vnow;

const CLEAN = [];
const ENGINES = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');

class HarnessError extends Error {}
function harness(cond, msg) {
  if (!cond) throw new HarnessError(`HARNESS: ${msg}`);
}

const unTimer = (m) => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };

async function run(tag, { closeModel = 'soft', tickExtendMs, finalExtendMs = tickExtendMs, move = 0 }) {
  const id = `F2${tag}`;
  const file = path.join(os.tmpdir(), `result-extensions-zero-increment-${process.pid}-${tag}.json`);
  CLEAN.push(file);
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  const events = [];
  let feed = Promise.resolve();
  const stub = { frame: null, served: null, bids: [] };

  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
      revisionLimit: CAP, closeModel, reactiveClose: true, snipeBudgetMs: 3000 }),
    async getAuctionState() {
      if (!stub.frame) return { ok: false, error: 'no frame' };
      stub.served = { ...stub.frame };
      return { ...stub.frame };
    },
    async placeBid(auctionId, price) {
      const served = stub.served;
      vnow += WRITE_MS;
      stub.bids.push({ price, closeInForce: served.closesAtMs });
      return { accepted: true, myRank: 2, revisionsLeft: Math.max(0, CAP - stub.bids.length), latencyMs: WRITE_MS };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0,
      softOpenJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Allowlisted'], mode: 'live', reserve: 1 },
    rand: () => 0,
    onEvent: (e) => { events.push(e); feed = feed.then(() => logger.handle(e)); },
    log: quiet,
  });
  ENGINES.push(eng);

  const frame = (closesAtMs, extendMs, status = 'live') => {
    const bid = stub.bids.length > 0;
    return { ok: true, status, closeModel, closesAtMs, closesInMs: Math.max(0, closesAtMs - Date.now()),
      extendMs, extendCount: null, myRank: bid ? 2 : null, totalBidders: bid ? 4 : null,
      standingL1Price: null, measuredRttMs: 20 };
  };
  const tick = async (m, closesAtMs) => {
    stub.frame = frame(closesAtMs, tickExtendMs);
    await eng._tick(m);
    unTimer(m);
  };

  vnow = P - 600_000;
  const m = eng.arm({
    id, lane: { origin: 'Degam', destination: 'Akola' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName: CUSTOMER, closesAt: P, platformKey: 'gocomet',
    rules: { revisionLimit: CAP, minDecrement: 500 },
  }, { cost: 48_000, marginsPct: [12.6, 7.2, 6.3] });
  unTimer(m);

  const marks = [];
  for (let k = 595; k >= 30; k -= 5) marks.push(k);
  for (let k = 29; k >= 4; k -= 1) marks.push(k);
  for (const k of marks) {
    const at = P - k * 1000 - 600;
    if (vnow > at) continue;
    vnow = at;
    await tick(m, P);
  }
  const finalClose = P + move;
  if (move) {
    vnow = P;
    await tick(m, finalClose);
  }
  vnow = finalClose;
  const closing = { ...frame(finalClose, finalExtendMs, 'closed'), myRank: 2, totalBidders: 4 };
  stub.frame = closing;
  await eng._finalize(m, closing);
  unTimer(m);
  try { eng.kill('test done'); } catch (_) {}
  await feed;

  const resultEvent = events.find((e) => e.type === 'auction_result' && String(e.auctionId) === id) || null;
  harness(stub.bids.length >= 1, `${tag}: the engine placed no accepted bid on the fake adapter`);
  harness(!!resultEvent, `${tag}: the engine emitted no auction_result`);
  harness(resultEvent.landedBids === stub.bids.length,
    `${tag}: auction_result.landedBids ${resultEvent.landedBids}, the stub accepted ${stub.bids.length}`);
  if (closeModel === 'soft') {
    harness(m.softStrategy === 'off', `${tag}: '${CUSTOMER}' resolved softStrategy '${m.softStrategy}', expected 'off'`);
  } else {
    harness(m.closeModel === closeModel, `${tag}: monitor closeModel '${m.closeModel}', expected '${closeModel}'`);
  }
  harness(resultEvent.finalCloseAt === finalClose,
    `${tag}: auction_result.finalCloseAt ${resultEvent.finalCloseAt}, expected ${finalClose} (close ${move ? 'moved' : 'unmoved'})`);
  harness(stub.bids[stub.bids.length - 1].closeInForce === P,
    `${tag}: our last bid was placed against close ${stub.bids[stub.bids.length - 1].closeInForce}, not the posted close ${P}`);

  const record = await store.getDoc('closedBids', id);
  const full = await renderResult({ record, resultEvent, platformKey: 'gocomet' });
  const short = await renderResult({ record, resultEvent, platformKey: 'gocomet', short: true });
  return { resultEvent, full: full.text, short: short.text };
}

const failures = [];
let checkNo = 0;
function check(id, desc, ok, detail) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} (${id}) ${desc} -- ${ascii(detail)}`);
}
const extLines = (text) => String(text).split('\n').filter((l) => /extend|closed/i.test(l)).map(ascii).join(' | ') || '(none)';

async function main() {
  const a = await run('a', { tickExtendMs: 0 });
  check('a', 'soft-off, published extendMs 0, close unmoved -> extensionsAfterLastBid === 0',
    a.resultEvent.extensionsAfterLastBid === 0, `got ${a.resultEvent.extensionsAfterLastBid}`);

  const b = await run('b', { closeModel: 'hard', tickExtendMs: 0 });
  check('b', 'hard close, published extendMs 0, close unmoved -> extensionsAfterLastBid === 0',
    b.resultEvent.extensionsAfterLastBid === 0, `got ${b.resultEvent.extensionsAfterLastBid}`);

  const c = await run('c', { tickExtendMs: MOVE_MS, finalExtendMs: 0, move: MOVE_MS });
  check('c', 'close moved 300 s, closing frame publishes extendMs 0 -> extensionsAfterLastBid === null',
    c.resultEvent.extensionsAfterLastBid === null, `got ${c.resultEvent.extensionsAfterLastBid}`);
  check('c', 'close moved 300 s, closing frame publishes extendMs 0 -> no Infinity/NaN in the full or short receipt',
    !/Infinity|NaN/.test(c.full) && !/Infinity|NaN/.test(c.short), `full: ${extLines(c.full)} || short: ${extLines(c.short)}`);

  const d = await run('d', { tickExtendMs: MOVE_MS, move: MOVE_MS });
  check('d', 'control: published extendMs 300000, one 300 s move after our last bid -> extensionsAfterLastBid === 1',
    d.resultEvent.extensionsAfterLastBid === 1, `got ${d.resultEvent.extensionsAfterLastBid}`);

  const e = await run('e', { tickExtendMs: null });
  check('e', 'control: unpublished extendMs (null), close unmoved -> extensionsAfterLastBid === 0',
    e.resultEvent.extensionsAfterLastBid === 0, `got ${e.resultEvent.extensionsAfterLastBid}`);
}

function cleanup() {
  Date.now = REAL_NOW;
  for (const eng of ENGINES) { try { eng.kill('test done'); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
}

main().then(() => {
  cleanup();
  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - F2: a published zero anti-snipe increment is the `
      + 'divisor in _closeAfterLastBid, so extensionsAfterLastBid comes out NaN (close unmoved) or Infinity (close moved)');
    process.exit(1);
  }
  console.log(`PASS ${checkNo} checks`);
  process.exit(0);
}, (err) => {
  cleanup();
  console.log(ascii(err instanceof HarnessError ? err.message : `HARNESS: threw ${err && err.stack ? err.stack : err}`));
  process.exit(1);
});
