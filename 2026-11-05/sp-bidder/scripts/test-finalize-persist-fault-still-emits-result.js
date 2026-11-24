'use strict';
/**
 * A WON CLOSE ON A DISK THAT WILL NOT TAKE THE WRITE - the receipt still goes out, the failure is loud.
 *
 * Regression target: BidEngine._finalize's durable close write,
 * `this.scheduler.update(auctionId, { status: 'closed', finalRank, won })`, which runs BEFORE the
 * `auction_result` emit and was the one scheduler.update in the tick band left unwrapped.
 *
 * _finalize marks the monitor finalized and clears its timer first, takes its one authoritative final
 * read, then persists. DurableScheduler.update rolls memory back and rethrows whatever _persist()
 * throws, and _persist throws on exactly the runtime faults its own comment names: a full disk, a
 * permission, a missing or unwritable data dir. _tick reaches _finalize outside both of its try
 * blocks, and _tick itself runs from a fire-and-forget timer. So a disk fault at close meant: no
 * `auction_result` (the desk never learns it WON), no ledger record, and an unhandled rejection that
 * only the process log ever saw. Nothing on the desk's channel at all.
 *
 * Catching the rejection at the timer is not the fix: the receipt is still skipped. Swallowing the
 * write's error inside _finalize is not the fix either: past the price page nothing may fail
 * silently, so the persist failure has to reach the desk's error channel - with no filesystem path in
 * it, because that channel reaches the client's Director.
 *
 * A bare `{ auctionId, won, finalRank }` receipt is not the fix: routing and the receipt's wording
 * read lane, companyName, branchName, landedBids and the noBid* fields off the same event. Nor is a
 * bare error alert: without the load's id and a real detail the desk is told nothing it can act on.
 *
 * WHAT MUST NOT MOVE:
 *   - with a healthy disk, a hard close read as rank 1 emits exactly one WON auction_result and the
 *     durable intent reads 'closed' (check 1 - the in-file control, run first).
 *   - under either fault, the receipt carries every field of the control's receipt unchanged, apart
 *     from the clock-stamped fields (checks 2 and 5; named re-pin: T6, postedCloseAt is held to its own
 *     run's arm-time close), and the desk's error channel gains an alert naming this
 *     load, with a real detail and no filesystem path (checks 4 and 6).
 *
 * Offline and deterministic: parking fake adapter whose reads are released by hand, real BidEngine,
 * real DurableScheduler, real atomic file write on a temp dir. The fault is structural - a directory
 * where the atomic write's tmp file goes (EISDIR), or the data dir replaced by a regular file - and is
 * planted after arm and before the close. No sleeps: completion is driven by loop turns.
 *
 *   node scripts/test-finalize-persist-fault-still-emits-result.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files, fault planting), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

const ROOTS = [];
const cleanup = () => { for (const r of ROOTS) { try { fs.rmSync(r, { recursive: true, force: true }); } catch (_) {} } };
process.on('exit', cleanup);

// Node 22 would otherwise crash the process on the first one, and the count is itself a check.
const rejections = [];
process.on('unhandledRejection', (reason) => { rejections.push(reason); });

// Pass-through observer, so each fault run can prove its write was really attempted and really
// failed. atomicFile calls fs.writeFileSync through the shared module object, so this sees it.
const failedWrites = [];
const realWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function observedWriteFileSync(p, ...rest) {
  try { return realWriteFileSync.call(fs, p, ...rest); } catch (e) {
    failedWrites.push({ path: String(p), code: e && e.code });
    throw e;
  }
};

const AUCTION = 'FPF1';

async function drain(turns = 12) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

function parkingAdapter(reads) {
  return {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState() {
      let resolve;
      const p = new Promise((r) => { resolve = r; });
      reads.push(resolve);
      return p;
    },
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 5 }),
  };
}

const closedWon = () => ({
  ok: true, status: 'closed', myRank: 1, totalBidders: 3, standingL1Price: null,
  closesInMs: 0, closesAtMs: Date.now(), revisionLimit: 3, revisionsLeft: null, minDecrement: 100,
  closeModel: 'hard', extendMs: null, measuredRttMs: 40, triggerWindowMs: null,
});

async function releaseReads(reads) {
  for (const r of reads.splice(0, reads.length)) r(closedWon());
  await drain();
}

const FAULTS = {
  none: () => {},
  eisdir: ({ file }) => { fs.mkdirSync(file + '.tmp', { recursive: true }); },
  dataDirIsFile: ({ dataDir }) => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.writeFileSync(dataDir, 'the data dir is now a file');
  },
};

async function run(fault) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'finalize-persist-fault-'));
  ROOTS.push(root);
  const dataDir = path.join(root, 'data');
  const file = path.join(dataDir, 'intents.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const reads = [];
  const events = [];
  const scheduler = new DurableScheduler(file);
  const engine = new BidEngine(parkingAdapter(reads), scheduler, {
    config: {
      openAtMs: 60_000, openJitterMs: 0, softOpenAtMs: 60_000, softOpenJitterMs: 0,
      cadenceJitterMs: 0, floorWindowMs: 2_500, finalizeDebounceMs: 3_000,
      pollFarMs: 30_000, pollMidMs: 5_000, pollHotMs: 200,
      farThresholdMs: 120_000, hotThresholdMs: 20_000, minInterFireMs: 0, startGraceMs: 0,
    },
    rand: () => 0,
    onEvent: (e) => events.push(e),
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const armCloseAt = Date.now(); // named re-pin: T6, owner decision - the posted close is this run's arm-time close
  engine.arm({
    id: AUCTION, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
    companyName: 'Waaree Energies', closesAt: armCloseAt, startsAt: Date.now() - 1_000,
  }, { cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });
  await drain(4);
  assert.strictEqual(reads.length, 1, `setup (${fault}): arm's tick timer should have one read parked, got ${reads.length}`);
  assert.strictEqual(scheduler.get(AUCTION).status, 'armed', `setup (${fault}): the intent is armed before the close`);

  FAULTS[fault]({ file, dataDir });
  const rejectionsBefore = rejections.length;
  const failedBefore = failedWrites.length;

  await releaseReads(reads); // the tick's read: hard close, countdown zero -> _finalize
  await releaseReads(reads); // _finalize's own authoritative final read

  const seen = events.slice();
  const monitor = engine.monitors.get(AUCTION);
  const finalized = !!monitor && monitor.finalized === true;
  const escaped = rejections.slice(rejectionsBefore);
  const faultHits = failedWrites.slice(failedBefore).filter((w) => w.path.startsWith(dataDir));
  let diskStatus = null;
  if (fault === 'none') diskStatus = JSON.parse(fs.readFileSync(file, 'utf8')).intents.find((i) => i.auctionId === AUCTION).status;
  engine.kill('done');

  const errorChannel = seen.filter((e) => { const n = toNotification(e); return !!n && n.kind === 'error'; });
  return {
    root, file, dataDir, finalized, escaped, faultHits, diskStatus, errorChannel, armCloseAt,
    results: seen.filter((e) => e.type === 'auction_result'),
    kinds: seen.map((e) => (e.type === 'alert' ? `alert:${e.kind}` : e.type)),
  };
}

const trace = (r) => `\n    events: ${r.kinds.join(', ') || '(none)'}`
  + `\n    unhandled rejections: ${r.escaped.map((e) => (e && e.code) || String(e)).join(', ') || '(none)'}`;

function assertFaultHit(r, label) {
  assert.strictEqual(r.finalized, true, `setup (${label}): _finalize never ran - monitor not finalized` + trace(r));
  assert.ok(r.faultHits.length >= 1,
    `setup (${label}): no durable write failed under the planted fault - the fault never fired` + trace(r));
}

// emit() stamps `ts` off Date.now(), and finalCloseAt is the arm-time close on the local clock;
// every other field is fixed by the load and the final read, so it must match the control exactly.
// named re-pin: T6, owner decision - postedCloseAt is written onto the intent at first persistence from
// the arm-time close, so it is clock-derived here too; assertReceipt holds it to this run's own close.
const CLOCK_FIELDS = ['ts', 'finalCloseAt', 'postedCloseAt'];
const receiptShape = (e) => {
  const o = Object.assign({}, e);
  for (const k of CLOCK_FIELDS) delete o[k];
  return o;
};

function assertReceipt(r, control, label) {
  assert.strictEqual(r.results.length, 1,
    `auction_result emitted ${r.results.length} time(s) after the close write failed (${label}, expected 1): `
    + 'the durable close write in _finalize threw before the receipt, so the desk never learned it WON' + trace(r));
  // Subset, not equality: a fix may add a field of its own to the fault receipt.
  const got = r.results[0];
  const want = receiptShape(control);
  const wrong = Object.keys(want).filter((k) => {
    if (!Object.prototype.hasOwnProperty.call(got, k)) return true;
    try { assert.deepStrictEqual(got[k], want[k]); return false; } catch (_) { return true; }
  });
  assert.deepStrictEqual(wrong, [],
    `the receipt after a failed persist (${label}) differs from the healthy-disk receipt on: `
    + wrong.map((k) => `${k} (got ${JSON.stringify(got[k])}, expected ${JSON.stringify(want[k])})`).join(', '));
  assert.strictEqual(got.postedCloseAt, r.armCloseAt,
    `the receipt after a failed persist (${label}) does not carry this run's posted close, the arm-time close `
    + `${r.armCloseAt} (got ${JSON.stringify(got.postedCloseAt)}) - named re-pin: T6, owner decision`);
  const n = toNotification(r.results[0]);
  assert.strictEqual(n && n.kind, 'won', `the receipt after a failed persist (${label}) does not route as won`);
}

// The error-channel alerts this run raised beyond the control's, matched off by kind.
function extraErrors(r, control) {
  const pool = control.errorChannel.map((e) => e.kind);
  return r.errorChannel.filter((e) => {
    const i = pool.indexOf(e.kind);
    if (i === -1) return true;
    pool.splice(i, 1);
    return false;
  });
}

function assertDeskChannel(r, control, label) {
  const extra = extraErrors(r, control);
  assert.ok(extra.length >= 1,
    `the close-write failure never reached the desk error channel (${label}: ${r.errorChannel.length} `
    + `error-channel alert(s) vs ${control.errorChannel.length} on a healthy disk) - a silent failure past `
    + 'the price page' + trace(r));
  for (const e of extra) {
    assert.strictEqual(e.auctionId, AUCTION,
      `error-channel alert ${e.kind} (${label}) does not name this load: auctionId ${JSON.stringify(e.auctionId)}`);
    const detail = toNotification(e).data.detail;
    assert.ok(typeof detail === 'string' && detail.trim() !== '' && detail !== e.kind,
      `error-channel alert ${e.kind} (${label}) carries no detail of its own: ${JSON.stringify(detail)}`);
  }
  const leaks = [r.file, path.basename(r.file), r.dataDir, r.root, os.tmpdir()];
  for (const e of r.errorChannel) {
    const detail = String(toNotification(e).data.detail || '');
    for (const p of leaks) {
      assert.ok(!detail.includes(p), `error-channel detail carries a filesystem path (${label}): ${JSON.stringify(detail)}`);
    }
  }
}

(async () => {
  const c = await run('none');
  assert.strictEqual(c.finalized, true, 'control: the hard close should finalize the monitor' + trace(c));
  assert.strictEqual(c.results.length, 1, `control: ${c.results.length} auction_result events (expected 1)` + trace(c));
  const receipt = c.results[0];
  assert.strictEqual(receipt.won, true, 'control: a close read at rank 1 is a WIN');
  assert.strictEqual(receipt.finalRank, 1, 'control: finalRank should be 1');
  assert.strictEqual(receipt.companyName, 'Waaree Energies', 'control: the receipt names the shipper');
  assert.strictEqual(toNotification(receipt).kind, 'won', 'control: the receipt routes as won');
  assert.strictEqual(c.diskStatus, 'closed', `control: durable intent reads ${c.diskStatus} after the close (expected closed)`);
  assert.strictEqual(c.escaped.length, 0, 'control: an unhandled rejection escaped on a healthy disk' + trace(c));
  assert.strictEqual(c.faultHits.length, 0, 'control: a durable write failed on a healthy disk');
  ok(1, `control: healthy disk - one WON auction_result, intent closed on disk, ${c.errorChannel.length} error-channel alert(s)`);

  const f = await run('eisdir');
  assertFaultHit(f, 'EISDIR');
  assertReceipt(f, receipt, 'EISDIR');
  ok(2, 'EISDIR at the close write: the healthy-disk WON receipt is still emitted, once');

  assert.strictEqual(f.escaped.length, 0,
    'the close-write failure escaped as an unhandled rejection' + trace(f));
  ok(3, 'EISDIR at the close write: no rejection escapes the engine');

  assertDeskChannel(f, c, 'EISDIR');
  ok(4, 'EISDIR at the close write: an alert naming this load reaches the desk error channel, no path in it');

  const d = await run('dataDirIsFile');
  assertFaultHit(d, 'data dir replaced by a file');
  assertReceipt(d, receipt, 'data dir replaced by a file');
  assert.strictEqual(d.escaped.length, 0,
    'the close-write failure escaped as an unhandled rejection with the data dir gone' + trace(d));
  ok(5, 'data dir replaced by a file: the healthy-disk WON receipt is still emitted and nothing escapes');

  assertDeskChannel(d, c, 'data dir replaced by a file');
  ok(6, 'data dir replaced by a file: an alert naming this load reaches the desk error channel, no path in it');

  console.log(`\nPASS - ${pass} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nFAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
