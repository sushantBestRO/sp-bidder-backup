'use strict';
/**
 * A BANKED BID IS VISIBLE TO EVERY READER OF closedBids - positive pin.
 *
 * Pins what a fix for the post-bid event-loop stall (BidLogger._onBid re-reading, parsing and
 * synchronously rewriting the whole closedBids collection through FileStore) must not take away.
 * This file PASSES on the code it was written against; it exists to go red if the repair trades one
 * of these properties for speed:
 *
 *   1. OTHER READERS SEE THE BID. eodReport and heartbeat read the collection straight off the store
 *      with store.listDocs('closedBids'), not through BidLogger, so a cache that lives only inside
 *      BidLogger would serve them a record without the bid. The exporters and HTTP routes read via
 *      bidLogger.listClosed() / getRecord().
 *   2. THE BID IS ON DISK WHEN handle() RESOLVES. A fresh FileStore on the same dataDir, sharing no
 *      memory with the first, sees it, and so does a plain parse of the file. A write-behind that
 *      defers the disk write widens the window in which a crash loses a bid record.
 *   3. AN OPERATOR EDIT TO data/closedBids.json IS LIVE ON THE NEXT READ, with no restart - including
 *      an edit that leaves the byte length unchanged - and the next bid written through BidLogger
 *      keeps that edit rather than overwriting it from a stale copy.
 *
 * Each scenario runs twice: on an empty store, and on one pre-seeded with 8,000 synthetic records in
 * the production record shape, pretty-printed (~12.8 MB, production scale), because a cache or
 * write-behind may only switch on (or only misbehave) once the collection is large.
 *
 * Asserts only what each reader observes, never how persistence happens. The one assumption about
 * the on-disk form is that closedBids.json stays a single JSON document an operator can edit.
 *
 * Offline and deterministic: real BidLogger + real FileStore on a temp dataDir under os.tmpdir(),
 * removed at the end. No network, no RNG, no sleeps.
 *
 *   node scripts/test-bid-record-visible-to-other-readers.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp dataDir, operator edits), not app state
const path = require('path');
const assert = require('assert');
const { FileStore } = require('../src/store/fileStore');
const { BidLogger } = require('../src/logging/bidLogger');

const COLLECTION = 'closedBids';
const SEED_COUNT = 8000;
const BASE_TS = 1788000000000;

let pass = 0;
let property = 'setup';
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const DIRS = [];

function syntheticRecord(i) {
  const cost = 40000 + (i % 97) * 500;
  const ladder = [Math.round(cost * 1.126), Math.round(cost * 1.072), Math.round(cost * 1.063)];
  const armedAt = BASE_TS + i * 600000;
  const closedAt = armedAt + 3600000;
  const origin = ['Khopoli', 'Mulug', 'Chakan', 'Bhiwandi', 'Sanand'][i % 5];
  const destination = ['Keeranur', 'Vellore', 'Giddarbaha', 'Guwahati', 'Indore', 'Nagpur'][i % 6];
  const ourBids = [];
  for (let k = 0; k < i % 4; k++) {
    ourBids.push({
      price: ladder[Math.min(k, 2)], rungIndex: Math.min(k, 2), rank: null, ts: armedAt + 60000 * (k + 1),
      socketRank: 1 + ((i + k) % 6), latencyMs: 180 + (i % 50), bidTimeCost: cost, bidTimeMinMarginPct: 6.3,
      closesInMs: 30000 - k * 5000, extendsObserved: k % 2, believedCloseAt: closedAt, closeModel: 'hard',
      engineRevisionsLeft: null,
    });
  }
  return {
    auctionId: String(23000000 + i),
    account: null,
    lane: { origin, destination },
    points: [
      { kind: 'pickup', address: `Plot ${i % 300}, MIDC Industrial Area, ${origin}, Maharashtra, India` },
      { kind: 'drop', address: `Warehouse ${i % 40}, Ring Road, ${destination}, India` },
    ],
    equipment: ["Trailer 40'", 'Open Body', '32 FT MXL'][i % 3],
    units: 1 + (i % 5),
    shipper: ['Renewsys India', 'Mahindra Agri Solutions', 'Syngenta', 'Havells'][i % 4],
    platformKey: i % 7 === 0 ? 'gocomet' : 'sp',
    cost,
    costFloor: cost,
    floor: ladder[2],
    ladder,
    laneFreight: null,
    marginsPct: [12.6, 7.2, 6.3],
    minMarginPct: 6.3,
    armedAt,
    ourBids,
    lastBidPrice: ourBids.length ? ourBids[ourBids.length - 1].price : null,
    finalRank: ourBids.length ? 1 + (i % 5) : null,
    won: ourBids.length ? i % 5 === 0 : false,
    closeModel: 'hard',
    closedAt,
    status: 'closed',
    finalCloseAt: closedAt - 2000,
    closedWhileDown: false,
  };
}

const armed = (id, cost, ts) => ({
  type: 'armed', auctionId: id, ts, lane: { origin: 'Chakan', destination: 'Indore' }, equipment: 'Open Body',
  units: 1, companyName: 'Syngenta', platformKey: 'sp', cost, costFloor: cost - 1111,
  marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3, ladder: [82781, 78813, 78151], floor: 78151,
});
const bid = (id, price, rungIndex, ts) => ({
  type: 'bid_placed', auctionId: id, ts, price, rungIndex, rank: null, socketRank: 2, latencyMs: 190, cost: 73519, minMarginPct: 6.3,
});
const bidPrices = (rec) => (rec && Array.isArray(rec.ourBids) ? rec.ourBids.map((b) => b.price) : null);

// An operator edit is a plain fs write, never the store. Stamped 2s past the file's previous mtime
// so it lands at a human timescale rather than inside the same filesystem timestamp tick as the
// store's own write.
function operatorWrite(file, text) {
  const before = fs.statSync(file).mtimeMs;
  fs.writeFileSync(file, text);
  const t = new Date(before + 2000);
  fs.utimesSync(file, t, t);
}

async function scenario(label, seedCount) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `bid-readers-${process.pid}-`));
  DIRS.push(dataDir);
  const file = path.join(dataDir, COLLECTION + '.json');
  if (seedCount) {
    const seed = {};
    for (let i = 0; i < seedCount; i++) { const r = syntheticRecord(i); seed[r.auctionId] = r; }
    fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  }
  const store = new FileStore({ dataDir, logDir: path.join(dataDir, 'logs') });
  const logger = new BidLogger({ store, log: () => {} });
  const A = '29990001';
  const B = '29990002';
  const ts = BASE_TS + 90 * 86400000;

  await logger.handle(armed(A, 73519, ts));
  await logger.handle(bid(A, 82781, 0, ts + 1000));

  property = 'other readers see the bid (store.listDocs, the eodReport/heartbeat path)';
  const listed = await store.listDocs(COLLECTION);
  assert.strictEqual(listed.length, seedCount + 1, `${label}: the collection must still hold every record plus the new one`);
  assert.deepStrictEqual(bidPrices(listed.find((r) => r && r.auctionId === A)), [82781], `${label}: store.listDocs must return the record carrying the bid`);
  ok(`${label}: store.listDocs on the same store returns the record with its bid`);

  property = 'the bid is durable on disk when handle() resolves';
  const fresh = new FileStore({ dataDir, logDir: path.join(dataDir, 'logs') });
  assert.deepStrictEqual(bidPrices(await fresh.getDoc(COLLECTION, A)), [82781], `${label}: a fresh FileStore on the same dataDir must see the bid`);
  assert.strictEqual((await fresh.listDocs(COLLECTION)).length, seedCount + 1, `${label}: a fresh FileStore must see every record`);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(bidPrices(onDisk[A]), [82781], `${label}: the file parsed straight off disk must hold the bid`);
  ok(`${label}: a fresh FileStore and a plain parse of the file both see the bid`);

  property = 'bidLogger.listClosed sees the closed record (the exporter/route path)';
  await logger.handle({ type: 'auction_result', auctionId: A, ts: ts + 5000, won: true, finalRank: 1, closeModel: 'hard' });
  const closed = await logger.listClosed();
  const closedA = closed.find((r) => r && r.auctionId === A);
  assert.ok(closedA, `${label}: listClosed must include the record once auction_result closed it`);
  assert.deepStrictEqual(bidPrices(closedA), [82781], `${label}: listClosed must return the record with its bid`);
  assert.strictEqual(closedA.won, true, `${label}: listClosed must return the result`);
  const freshClosed = await new FileStore({ dataDir }).getDoc(COLLECTION, A);
  assert.strictEqual(freshClosed && freshClosed.status, 'closed', `${label}: the close must be on disk when handle() resolves`);
  ok(`${label}: listClosed returns the closed record with its bid, and the close is on disk`);

  await logger.handle(armed(B, 73519, ts + 6000));
  await logger.handle(bid(B, 82781, 0, ts + 7000));

  property = 'an operator edit to closedBids.json is live on the next read (size-changing edit)';
  const edited = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(edited[B], `setup: ${label}: record B must be on disk before the operator edits it`);
  edited[B].shipper = 'Syngenta India Pvt Ltd (operator corrected)';
  operatorWrite(file, JSON.stringify(edited, null, 2));
  const SHIPPER = 'Syngenta India Pvt Ltd (operator corrected)';
  assert.strictEqual((await store.getDoc(COLLECTION, B)).shipper, SHIPPER, `${label}: store.getDoc must return the operator's edit`);
  assert.strictEqual((await store.listDocs(COLLECTION)).find((r) => r && r.auctionId === B).shipper, SHIPPER, `${label}: store.listDocs must return the operator's edit`);
  assert.strictEqual((await logger.getRecord(B)).shipper, SHIPPER, `${label}: bidLogger.getRecord must return the operator's edit`);
  ok(`${label}: an operator edit that changes the file size is live on the next read`);

  property = 'an operator edit to closedBids.json is live on the next read (same-size edit)';
  const raw = fs.readFileSync(file, 'utf8');
  const COST_RE = /("cost":\s*)73519\b/g;
  assert.strictEqual((raw.match(COST_RE) || []).length, 2, `setup: ${label}: records A and B must each carry cost 73519 exactly once`);
  const idxB = raw.search(new RegExp(`"${B}"\\s*:`));
  COST_RE.lastIndex = idxB;
  const m = COST_RE.exec(raw);
  assert.ok(m && idxB >= 0, `setup: ${label}: record B's cost must be locatable in the file`);
  const sameSize = raw.slice(0, m.index) + m[1] + '73518' + raw.slice(m.index + m[0].length);
  assert.strictEqual(Buffer.byteLength(sameSize), Buffer.byteLength(raw), `setup: ${label}: the edit must leave the byte length unchanged`);
  operatorWrite(file, sameSize);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[B].cost, 73518, `setup: ${label}: the same-size edit must have landed on record B`);
  assert.strictEqual((await store.getDoc(COLLECTION, B)).cost, 73518, `${label}: store.getDoc must return the same-size edit`);
  assert.strictEqual((await store.listDocs(COLLECTION)).find((r) => r && r.auctionId === B).cost, 73518, `${label}: store.listDocs must return the same-size edit`);
  assert.strictEqual((await logger.getRecord(B)).cost, 73518, `${label}: bidLogger.getRecord must return the same-size edit`);
  assert.strictEqual((await store.getDoc(COLLECTION, A)).cost, 73519, `${label}: the edit must not have touched record A`);
  ok(`${label}: an operator edit that leaves the byte length unchanged is live on the next read`);

  property = 'the next bid keeps the operator edit instead of overwriting it from a stale copy';
  await logger.handle(bid(B, 78813, 1, ts + 8000));
  for (const [who, rec] of [
    ['the original store', await store.getDoc(COLLECTION, B)],
    ['a fresh FileStore', await new FileStore({ dataDir }).getDoc(COLLECTION, B)],
    ['the file on disk', JSON.parse(fs.readFileSync(file, 'utf8'))[B]],
  ]) {
    assert.strictEqual(rec.shipper, SHIPPER, `${label}: ${who} lost the operator's shipper edit on the next bid`);
    assert.strictEqual(rec.cost, 73518, `${label}: ${who} lost the operator's same-size cost edit on the next bid`);
    assert.deepStrictEqual(bidPrices(rec), [82781, 78813], `${label}: ${who} must hold both bids`);
  }
  assert.strictEqual((await store.listDocs(COLLECTION)).length, seedCount + 2, `${label}: the collection must still hold every record`);
  ok(`${label}: the next bid through BidLogger keeps both operator edits and adds the bid`);
}

(async () => {
  try {
    await scenario('empty store', 0);
    await scenario(`${SEED_COUNT} seeded records`, SEED_COUNT);
    console.log(`\nPASS - ${pass} checks`);
  } catch (err) {
    console.error(`\nFAILED: ${property}\n\n${err && err.message}`);
    process.exitCode = 1;
  } finally {
    for (const d of DIRS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
  process.exit(process.exitCode || 0);
})();
