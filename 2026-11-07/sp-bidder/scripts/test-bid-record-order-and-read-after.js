'use strict';
/**
 * THE BID RECORD UNDER A BURST - order, completeness, and read-after-handle.
 *
 * Positive pin. Passes on the current code and exists to go red if a change to how BidLogger or
 * FileStore persist the closedBids collection breaks one of the properties below. The motivating
 * change is the ~1.1 s event-loop stall after every accepted bid: the whole collection is read,
 * modified and rewritten synchronously per event, through one serialising `_tail`. Every plausible
 * cure (async I/O, an in-memory cache, write-behind, deferring the write) moves a suspension point
 * into a read-modify-write that today has none.
 *
 * The engine's onEvent is fire-and-forget: it calls bidLogger.handle(evt) and does not wait before
 * the next event, then notifies from `.then(() => ... getRecord(id))`. So this test fires 20
 * events back to back, un-awaited, across three auctions, and requires:
 *
 *   - every placed bid lands in its record's ourBids, in fired order, none lost, none duplicated;
 *   - rejectedBids and skippedRungs are complete and ordered the same way;
 *   - the record read the moment each bid_placed / auction_result handle() resolves already holds
 *     that event (the notifier's enrichment reads exactly there);
 *   - the daily `bids` JSONL stream holds one line per stream event, in fired order;
 *   - auction_result closes the record with the right won/finalRank, and a bid_placed arriving
 *     after the close is dropped, not appended.
 *
 * Run twice: on an empty store, and on one pre-seeded with a few thousand synthetic closed records,
 * because a fix may only change behaviour once the collection is large. The seeded records must
 * come out untouched.
 *
 * Asserts only on observable record and stream contents - never on how or when the bytes hit disk.
 * Synthetic data only. Offline, deterministic, no sleeps.
 *
 *   node scripts/test-bid-record-order-and-read-after.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp store seed + stream read), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store/fileStore');
const { BidLogger } = require('../src/logging/bidLogger');

const SEED_COUNT = 3000;

let pass = 0;
function check(n, scenario, property, fn) {
  try {
    fn();
  } catch (e) {
    console.error(`  FAIL ${n} [${scenario}] ${property}\n${e && e.message}`);
    cleanup();
    process.exit(1);
  }
  console.log(`  ok  ${n} [${scenario}] ${property}`);
  pass++;
}

const CLEAN = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bidrec-order-${process.pid}-${tag}-`));
  CLEAN.push(d);
  return d;
}
function cleanup() { for (const d of CLEAN) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } }

function seedRecords(base) {
  const map = {};
  for (let i = 0; i < SEED_COUNT; i++) {
    const id = `SYN-${String(i).padStart(5, '0')}`;
    const cost = 30000 + (i % 97) * 500;
    const ladder = [Math.round(cost * 1.126), Math.round(cost * 1.072), Math.round(cost * 1.063)];
    const armedAt = base - 86_400_000 * (1 + (i % 60)) - i * 1000;
    const nBids = 1 + (i % 3);
    const ourBids = [];
    for (let b = 0; b < nBids; b++) {
      ourBids.push({
        price: ladder[b], rungIndex: b, rank: null, ts: armedAt + 60_000 + b * 5000,
        socketRank: 1 + ((i + b) % 6), latencyMs: 180 + (i % 50), bidTimeCost: cost, bidTimeMinMarginPct: 6.3,
        closesInMs: 30_000 - b * 5000, extendsObserved: 0, believedCloseAt: armedAt + 90_000,
        closeModel: i % 2 ? 'soft' : 'hard', engineRevisionsLeft: null,
      });
    }
    map[id] = {
      auctionId: id, account: null,
      lane: { origin: `Origin${i % 40}`, destination: `Dest${i % 53}` },
      points: [{ type: 'pickup', address: `Plot ${i}, Synthetic Industrial Area` }, { type: 'drop', address: `Warehouse ${i % 211}, Synthetic Park` }],
      equipment: ['32ft MXL', '20ft container', 'Trailer', 'Open'][i % 4], units: 1 + (i % 2),
      shipper: `Synthetic Shipper ${i % 17}`, platformKey: null,
      cost, costFloor: cost, floor: ladder[2], ladder, laneFreight: null,
      marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, armedAt,
      ourBids, lastBidPrice: ladder[nBids - 1],
      finalRank: 1 + (i % 5), won: i % 5 === 0, closeModel: i % 2 ? 'soft' : 'hard',
      closedAt: armedAt + 120_000, status: 'closed', finalCloseAt: armedAt + 90_000, closedWhileDown: false,
    };
  }
  return map;
}

// 20 events, three auctions interleaved. `drop:true` marks the bid_placed after A's close.
function scenarioEvents(base) {
  const A = 'SYN-ORD-A', B = 'SYN-ORD-B', C = 'SYN-ORD-C';
  const armed = (id, cost, ladder, t) => ({
    type: 'armed', auctionId: id, ts: t, lane: { origin: 'SynX', destination: 'SynY' }, equipment: '32ft MXL', units: 1,
    companyName: 'Synthetic Shipper', cost, costFloor: cost, floor: ladder[ladder.length - 1], ladder,
    marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3,
  });
  const bid = (id, price, rungIndex, t, extra = {}) => Object.assign({
    type: 'bid_placed', auctionId: id, ts: t, price, rungIndex, rank: null, socketRank: 2, latencyMs: 200 + rungIndex, cost: 80000, minMarginPct: 6.3, closesInMs: 20_000,
  }, extra);
  const rej = (id, price, rungIndex, t, status) => ({ type: 'bid_rejected', auctionId: id, ts: t, price, rungIndex, status, reason: 'refused', body: { message: 'synthetic refusal' } });
  const disc = (id, price, rungIndex, t) => ({ type: 'rung_discarded', auctionId: id, ts: t, price, rungIndex, lastBidPrice: price + 100, minDecrement: 500, gap: 100 });
  const result = (id, won, finalRank, t, closeModel) => ({ type: 'auction_result', auctionId: id, ts: t, won, finalRank, closeModel });
  let t = base;
  const n = () => (t += 7);
  return [
    armed(A, 80000, [90080, 85760, 85040, 84500], t),
    armed(B, 50000, [56300, 53600, 53150], n()),
    bid(A, 90080, 0, n()),
    armed(C, 40000, [45040, 43500, 43000, 42520], n()),
    bid(B, 56300, 0, n()),
    disc(C, 43500, 1, n()),
    rej(A, 88000, 1, n(), 400),
    bid(C, 45040, 0, n()),
    bid(A, 85760, 1, n()),
    rej(C, 43000, 2, n(), 400),
    bid(B, 53600, 1, n()),
    disc(A, 84900, 2, n()),
    bid(C, 42520, 3, n()),
    bid(A, 85040, 2, n()),
    bid(B, 53150, 2, n()),
    rej(B, 53000, 2, n(), 403),
    result(A, true, 1, n(), 'hard'),
    Object.assign(bid(A, 84500, 3, n()), { drop: true }),
    result(B, false, 3, n(), 'soft'),
    result(C, true, 1, n(), 'hard'),
  ];
}

function readStream(logDir) {
  if (!fs.existsSync(logDir)) return [];
  const files = fs.readdirSync(logDir).filter((f) => /^bids-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

async function runScenario(scenario, seeded) {
  const dataDir = tmpDir(scenario + '-data');
  const logDir = tmpDir(scenario + '-log');
  const base = Date.now();
  const seed = seeded ? seedRecords(base) : null;
  if (seed) fs.writeFileSync(path.join(dataDir, 'closedBids.json'), JSON.stringify(seed, null, 2));

  const store = new FileStore({ dataDir, logDir });
  const logger = new BidLogger({ store });
  const events = scenarioEvents(base);
  const k = (m) => `${scenario}:${m}`;

  const expectBids = {};
  const expectRejected = {};
  const expectSkipped = {};
  const closed = new Set();
  const expectStream = [];
  const readAfter = [];

  // Arrange + Act: fire every event back to back, the way the engine's onEvent does, and read the
  // record the way server.js's notifier does - in a .then on that event's own handle() promise.
  const done = [];
  for (const e of events) {
    const { drop, ...evt } = e;
    const id = evt.auctionId;
    let expectedAtRead = null;
    if (evt.type === 'bid_placed' && !closed.has(id)) {
      (expectBids[id] = expectBids[id] || []).push({ price: evt.price, rungIndex: evt.rungIndex, ts: evt.ts });
      expectedAtRead = { kind: 'bid', bids: expectBids[id].slice() };
      expectStream.push({ kind: 'bid_placed', auctionId: id, price: evt.price, rungIndex: evt.rungIndex });
    } else if (evt.type === 'bid_placed') {
      assert.ok(drop, 'scenario bug: an unmarked post-close bid');
    } else if (evt.type === 'bid_rejected') {
      if (!closed.has(id)) (expectRejected[id] = expectRejected[id] || []).push({ price: evt.price, rungIndex: evt.rungIndex, httpStatus: evt.status, ts: evt.ts });
      expectStream.push({ kind: 'bid_rejected', auctionId: id, price: evt.price, rungIndex: evt.rungIndex });
    } else if (evt.type === 'rung_discarded') {
      if (!closed.has(id)) (expectSkipped[id] = expectSkipped[id] || []).push({ price: evt.price, rungIndex: evt.rungIndex, ts: evt.ts });
      expectStream.push({ kind: 'rung_discarded', auctionId: id, price: evt.price, rungIndex: evt.rungIndex });
    } else if (evt.type === 'auction_result') {
      closed.add(id);
      expectedAtRead = { kind: 'result', won: evt.won, finalRank: evt.finalRank, bids: (expectBids[id] || []).slice() };
      expectStream.push({ kind: 'auction_result', auctionId: id, price: undefined, rungIndex: undefined });
    }
    const p = logger.handle(evt);
    done.push(p);
    if (expectedAtRead) {
      done.push(p.then(() => logger.getRecord(id)).then((rec) => { readAfter.push({ id, evt, expectedAtRead, rec }); }));
    }
  }
  await Promise.all(done);
  const streamAtResolve = readStream(logDir);
  // Check 7 alone owns read-after-handle timing. The rest assert what the records settle to, so a
  // record that lags one macrotask fails at 7 rather than being misreported as lost at 1.
  await new Promise((r) => setImmediate(r));

  // Assert
  const recs = {};
  for (const id of ['SYN-ORD-A', 'SYN-ORD-B', 'SYN-ORD-C']) recs[id] = await store.getDoc('closedBids', id);
  const pick = (arr, keys) => (arr || []).map((x) => { const o = {}; for (const kk of keys) o[kk] = x[kk]; return o; });

  check(1, scenario, 'every armed auction has a record', () => {
    for (const id of Object.keys(recs)) assert.ok(recs[id], `no closedBids record for ${id}`);
  });

  check(2, scenario, 'ourBids holds every placed bid in fired order, none lost, none duplicated', () => {
    for (const id of Object.keys(recs)) {
      assert.deepStrictEqual(pick(recs[id].ourBids, ['price', 'rungIndex', 'ts']), expectBids[id], k(`${id} ourBids`));
    }
  });

  check(3, scenario, 'rejectedBids complete and in fired order', () => {
    for (const id of Object.keys(recs)) {
      assert.deepStrictEqual(pick(recs[id].rejectedBids, ['price', 'rungIndex', 'httpStatus', 'ts']), expectRejected[id] || [], k(`${id} rejectedBids`));
    }
  });

  check(4, scenario, 'skippedRungs complete and in fired order', () => {
    for (const id of Object.keys(recs)) {
      assert.deepStrictEqual(pick(recs[id].skippedRungs, ['price', 'rungIndex', 'ts']), expectSkipped[id] || [], k(`${id} skippedRungs`));
    }
  });

  check(5, scenario, 'auction_result closes each record with the right won/finalRank', () => {
    assert.deepStrictEqual(pick([recs['SYN-ORD-A'], recs['SYN-ORD-B'], recs['SYN-ORD-C']], ['status', 'won', 'finalRank']), [
      { status: 'closed', won: true, finalRank: 1 },
      { status: 'closed', won: false, finalRank: 3 },
      { status: 'closed', won: true, finalRank: 1 },
    ]);
  });

  check(6, scenario, 'a bid_placed after close is dropped, not appended', () => {
    assert.ok(!recs['SYN-ORD-A'].ourBids.some((b) => b.price === 84500), 'post-close bid 84500 landed in ourBids');
    assert.strictEqual(recs['SYN-ORD-A'].lastBidPrice, 85040);
    assert.ok(!readStream(logDir).some((l) => l.kind === 'bid_placed' && l.price === 84500), 'post-close bid 84500 landed in the stream');
  });

  check(7, scenario, 'the record read when each bid_placed/auction_result handle() resolves already holds that event', () => {
    const expectedReads = events.filter((e) => (e.type === 'bid_placed' && !e.drop) || e.type === 'auction_result').length;
    assert.strictEqual(readAfter.length, expectedReads, 'not every read-after completed');
    for (const r of readAfter) {
      const where = k(`${r.evt.type} ${r.id} @${r.evt.price != null ? r.evt.price : r.evt.finalRank}`);
      assert.ok(r.rec, `${where}: getRecord returned nothing`);
      const got = pick(r.rec.ourBids, ['price', 'rungIndex', 'ts']);
      assert.deepStrictEqual(got.slice(0, r.expectedAtRead.bids.length), r.expectedAtRead.bids, `${where}: ourBids does not yet hold this bid and every earlier one`);
      if (r.expectedAtRead.kind === 'result') {
        assert.deepStrictEqual({ status: r.rec.status, won: r.rec.won, finalRank: r.rec.finalRank },
          { status: 'closed', won: r.expectedAtRead.won, finalRank: r.expectedAtRead.finalRank }, `${where}: result not yet on the record`);
      }
    }
  });

  check(8, scenario, 'the daily bids stream holds one line per event, in fired order', () => {
    const lines = streamAtResolve.map((l) => ({ kind: l.kind, auctionId: l.auctionId, price: l.kind === 'auction_result' ? undefined : l.price, rungIndex: l.kind === 'auction_result' ? undefined : l.rungIndex }));
    assert.deepStrictEqual(lines, expectStream);
  });

  if (seed) {
    const all = await store.listDocs('closedBids');
    check(9, scenario, `the ${SEED_COUNT} pre-existing records survive untouched`, () => {
      assert.strictEqual(all.length, SEED_COUNT + 3);
      const byId = new Map(all.map((r) => [r.auctionId, r]));
      for (const id of Object.keys(seed)) assert.deepStrictEqual(byId.get(id), seed[id], `seeded record ${id} changed`);
    });
  }
}

(async () => {
  await runScenario('empty', false);
  await runScenario('seeded', true);
  cleanup();
  console.log(`\nPASS ${pass} checks`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); cleanup(); process.exit(1); });
