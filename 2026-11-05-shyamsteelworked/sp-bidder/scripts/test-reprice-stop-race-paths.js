'use strict';
/**
 * EVERY RE-PRICE PATH LOSES TO A STOP THAT LANDS WHILE IT IS IN FLIGHT - the rest of T1 D9.
 *
 * Regression target: T1 D9 (R2-6). test-reprice-stop-race.js pins the /price re-price whose write
 * races the Stop. The same record-then-re-arm shape has three more ways to leave a live monitor
 * under a record reading 'stopped':
 *
 *   1. the revert ("Revert to standard margins", clearBidOverride) held at its own write;
 *   2. the resume of a held load (resumeBidding) held at its own write;
 *   3. a Stop that runs start to finish AFTER the re-price's write has landed and BEFORE its re-arm;
 *   4. a Stop whose engine stop runs first and whose record write lands only after the re-price has
 *      re-armed and answered.
 *
 * Each ends with the Stop having returned 200. The record, the engine and the durable intent must
 * then agree that the load is stopped, and nothing may reach the wire after the Stop.
 *
 * The store here holds a write on a parked promise, the way a slower store would. The seam is async
 * by contract, so every await between a check and a write, and between a write and the re-arm, is a
 * window.
 *
 * Offline and deterministic: mock platform, file store under os.tmpdir(), and a fake platform read
 * that parks until this file resolves it by hand. The only timers are the engine's own zero-delay
 * ticks, drained without sleeping.
 *
 *   node scripts/test-reprice-stop-race-paths.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'file';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const os = require('os');
const fs = require('fs'); // allowed: test harness (temp data dir), not app state
const path = require('path');
const http = require('http');
const assert = require('assert');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reprice-stop-race-paths-'));
process.env.SP_DATA_DIR = DATA_DIR;

const { app, requests, store, stacks } = require('../src/web/server');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const cleanup = () => { try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {} };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function drain(turns = 12) {
  for (let i = 0; i < turns; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
  }
}

function send(base, method, p, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + p);
    const payload = body == null ? '' : Object.entries(body)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const headers = { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload), origin: base };
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
    });
    r.on('error', reject);
    r.end(payload);
  });
}

const engine = stacks[0].engine;
const adapter = engine.adapter;
const reads = [];
const bids = [];
adapter.getAuctionState = () => { const d = deferred(); reads.push(d); return d.promise; };
adapter.placeBid = async (auctionId, price) => {
  bids.push({ auctionId: String(auctionId), price });
  return { accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 5 };
};

const FAR_MS = 45 * 60_000;
const stateAt = (closesInMs) => ({
  ok: true, status: 'live', myRank: 2, totalBidders: 3, standingL1Price: null,
  closesInMs, closesAtMs: Date.now() + closesInMs, revisionLimit: 3, revisionsLeft: null,
  minDecrement: 100, closeModel: 'hard', extendMs: null, measuredRttMs: 40, triggerWindowMs: null,
});

async function answerReads(closesInMs) {
  for (let round = 0; round < 6; round++) {
    await drain();
    if (!reads.length) return;
    const batch = reads.splice(0);
    for (const d of batch) d.resolve(stateAt(closesInMs));
  }
  await drain();
}

const mkLoad = (id) => ({
  id, lane: { origin: 'Palghar', destination: 'Jaipur' }, equipment: 'SXL', units: 1,
  quoteType: 'FTL', companyName: 'Waaree', closesAt: Date.now() + FAR_MS, startsAt: Date.now() - 60_000,
  softClose: false, closeModel: 'hard', closeModelKnown: true, status: 'live',
});

const REPRICE = { m_0: '14', m_1: '10', m_2: '7', cost: '31000' };
const liveMonitor = (loadId) => { const m = engine.monitors.get(loadId); return (m && !m.finalized) ? m : null; };

async function armedLoad(base, loadId) {
  const pr = await requests.createForLoad(mkLoad(loadId), { deadlineAt: Date.now() + 30 * 60_000 });
  const cap = await send(base, 'POST', `/price/${pr.id}`, { cost: '30000' });
  await answerReads(FAR_MS);
  const doc = await requests.getByToken(pr.id);
  assert.strictEqual(cap.status, 200, `setup: capture of ${loadId} must succeed (HTTP ${cap.status})`);
  assert.strictEqual(doc.status, 'armed', `setup: ${loadId} must be armed after capture`);
  assert.ok(liveMonitor(loadId), `setup: ${loadId} must have a live monitor after capture`);
  return pr.id;
}

// Parks the first patchDoc on `token` that `match` accepts. `after` parks it once the write has
// landed instead of before it.
function holdWrite(token, match, { after = false } = {}) {
  const gate = deferred();
  const atGate = deferred();
  let held = false;
  const origPatch = store.patchDoc;
  store.patchDoc = async function (...args) {
    const [coll, key, patch] = args;
    if (!held && coll === 'priceRequests' && key === token && patch && match(patch)) {
      held = true;
      if (after) {
        const out = await origPatch.apply(this, args);
        atGate.resolve();
        await gate.promise;
        return out;
      }
      atGate.resolve();
      await gate.promise;
    }
    return origPatch.apply(this, args);
  };
  return { atGate: atGate.promise, release: () => { gate.resolve(); }, restore: () => { store.patchDoc = origPatch; } };
}

function assertStopStands(label, loadId, doc, bidsAfterStop) {
  const m = liveMonitor(loadId);
  const intent = engine.scheduler.get(loadId);
  assert.ok(!(doc.status === 'stopped' && m),
    `T1 D9 ${label}: the record reads 'stopped' while a LIVE monitor is armed on ladder ${m && JSON.stringify(m.ladder)}`);
  assert.strictEqual(doc.status, 'stopped', `T1 D9 ${label}: the stop returned 200, so the record must read stopped (got '${doc.status}')`);
  assert.strictEqual(m, null, `T1 D9 ${label}: no live monitor may survive the stop`);
  assert.strictEqual(intent && intent.status, 'stopped',
    `T1 D9 ${label}: the durable intent reads '${intent && intent.status}' - a restart would resurrect a stopped load`);
  const leaked = bidsAfterStop.filter((b) => b.auctionId === loadId);
  assert.deepStrictEqual(leaked, [], `T1 D9 ${label}: ${JSON.stringify(leaked)} reached the wire after the stop`);
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const finish = (code) => { try { engine.kill('done'); } catch (_) {} server.close(); cleanup(); process.exit(code); };
  const failures = [];
  const check = async (name, fn) => {
    try { await fn(); ok(name); }
    catch (e) { failures.push(e); console.error(`  FAIL ${name}: ${e && e.message ? e.message : e}`); }
  };

  try {
    // ---- 1. a revert whose write is held while the stop lands
    await check('revert: a stop inside the revert write stands', async () => {
      const loadId = 'RSP-REVERT';
      const token = await armedLoad(base, loadId);
      const h = holdWrite(token, (p) => Object.prototype.hasOwnProperty.call(p, 'marginOverride') && p.marginOverride === null);
      const pending = send(base, 'POST', `/price/${token}`, { revert_override: '1' });
      await h.atGate;
      const s = await send(base, 'POST', `/api/auctions/${loadId}/stop`);
      assert.strictEqual(s.status, 200, `setup: the stop answered 200 while the revert was held (HTTP ${s.status})`);
      const bidsAtStop = bids.length;
      h.release();
      const r = await pending;
      h.restore();
      await answerReads(10_000);
      assertStopStands('revert over stop', loadId, await requests.getByToken(token), bids.slice(bidsAtStop));
      assert.ok(!/Reverted to standard margins\./.test(r.text), 'T1 D9 revert: the page must not confirm a revert on a stopped load');
    });

    // ---- 2. a resume whose write is held while the stop lands
    await check('resume: a stop inside the resume write stands', async () => {
      const loadId = 'RSP-RESUME';
      const token = await armedLoad(base, loadId);
      const cur = await requests.getByToken(token);
      await requests.holdBidding(token, {
        kind: 'standing', standingBidPrice: 34000, correctedCost: 40000,
        resume: { cost: cur.price.cost, marginsPct: cur.marginsPct, minMarginPct: cur.minMarginPct, marginSource: cur.marginSource },
      });
      const h = holdWrite(token, (p) => Object.prototype.hasOwnProperty.call(p, 'hold') && p.hold === null);
      const pending = send(base, 'POST', `/price/${token}/resume`, {});
      await h.atGate;
      const s = await send(base, 'POST', `/api/auctions/${loadId}/stop`);
      assert.strictEqual(s.status, 200, `setup: the stop answered 200 while the resume was held (HTTP ${s.status})`);
      const bidsAtStop = bids.length;
      h.release();
      const r = await pending;
      h.restore();
      await answerReads(10_000);
      assertStopStands('resume over stop', loadId, await requests.getByToken(token), bids.slice(bidsAtStop));
      assert.ok(!/Bidding resumed\./.test(r.text), 'T1 D9 resume: the page must not say bidding resumed on a stopped load');
    });

    // ---- 3. the whole stop runs between the re-price's write and its re-arm
    await check('re-price: a stop between the write and the re-arm stands', async () => {
      const loadId = 'RSP-AFTER-WRITE';
      const token = await armedLoad(base, loadId);
      const h = holdWrite(token, (p) => !!p.marginOverride, { after: true });
      const pending = send(base, 'POST', `/price/${token}`, REPRICE);
      await h.atGate;
      const s = await send(base, 'POST', `/api/auctions/${loadId}/stop`);
      assert.strictEqual(s.status, 200, `setup: the stop answered 200 after the re-price wrote (HTTP ${s.status})`);
      assert.strictEqual((await requests.getByToken(token)).status, 'stopped', 'setup: the stop landed on the record');
      const bidsAtStop = bids.length;
      h.release();
      const r = await pending;
      h.restore();
      await answerReads(10_000);
      assertStopStands('re-arm after stop', loadId, await requests.getByToken(token), bids.slice(bidsAtStop));
      assert.ok(!/bidding off the new cost and margins now/.test(r.text),
        'T1 D9 re-arm after stop: the page must not say it is bidding on a load the operator stopped');
    });

    // ---- 4. the stop's engine half runs first, its record write lands after the re-price answered
    await check('re-price: a stop whose record write lands last still stands', async () => {
      const loadId = 'RSP-STOP-WRITE-LAST';
      const token = await armedLoad(base, loadId);
      const bidsAtStart = bids.length;
      const h = holdWrite(token, (p) => p.status === 'stopped');
      const stopping = send(base, 'POST', `/api/auctions/${loadId}/stop`);
      await h.atGate;
      const r = await send(base, 'POST', `/price/${token}`, REPRICE);
      assert.strictEqual(r.status, 200, `setup: the re-price answered 200 before the stop's record write (HTTP ${r.status})`);
      h.release();
      const s = await stopping;
      h.restore();
      assert.strictEqual(s.status, 200, `setup: the stop answered 200 (HTTP ${s.status})`);
      await answerReads(10_000);
      assertStopStands('stop written last', loadId, await requests.getByToken(token), bids.slice(bidsAtStart));
    });

    if (failures.length) {
      console.error(`\nFAILED (T1 D9 re-price paths vs stop): ${failures.length} of 4 checks failed`);
      finish(1);
    }
    console.log(`\nPASS - ${pass}/4 checks passed`);
    finish(0);
  } catch (e) {
    console.error('\nFAILED (T1 D9 re-price paths vs stop):', e && e.message ? e.message : e);
    finish(1);
  }
})().catch((e) => { console.error('harness error:', e); cleanup(); process.exit(1); });
