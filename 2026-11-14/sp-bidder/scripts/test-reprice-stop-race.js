'use strict';
/**
 * A RE-PRICE THAT RACES THE STOP BUTTON - the server half of the bid-after-stop family.
 *
 * Regression target: T1 D9 (R2-6).
 *
 * The desk's re-price (POST /price/:token on an armed load) reads the record, checks it is 'armed',
 * then writes the new cost and band with a patch that carries no `status`. If the operator presses
 * Stop (POST /api/auctions/:loadId/stop) inside that read-to-write window, the stop's 'stopped'
 * survives the merge and the route then calls reArmWithNewBand on top of it. End state: the record
 * reads 'stopped', every console surface says bidding is off, and a fresh live monitor is bidding
 * the load anyway. The stop is the desk's kill control; it is pressed exactly when something is
 * already wrong, which is when somebody else is re-pricing.
 *
 * Check 4 holds the re-price inside its own store write (the persistence boundary, where the
 * compare-and-set belongs) until the stop has returned 200, then releases it. After both settle,
 * the record and the engine must agree, the durable intent must still read stopped, and nothing may
 * reach the wire. The page must not tell the desk it is bidding.
 *
 * WHAT MUST NOT MOVE:
 *   - an un-raced re-price on an armed load still re-arms a live monitor on the new ladder (check 1);
 *   - an un-raced stop still stops: record, monitor and intent (check 2);
 *   - a re-price posted after the stop has settled arms nothing (check 3).
 * Nothing here pins spent rungs or firedRungs.
 *
 * Offline and deterministic: mock platform, file store under os.tmpdir(), and a fake platform read
 * that parks until this file resolves it by hand. The only timers are the engine's own zero-delay
 * ticks, drained without sleeping.
 *
 *   node scripts/test-reprice-stop-race.js
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reprice-stop-race-'));
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

// Answers every parked read, repeatedly, until none are left.
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
  return { token: pr.id, ladder: liveMonitor(loadId).ladder.slice() };
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r, j) => { server.once('listening', r); server.once('error', j); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const finish = (code) => { try { engine.kill('done'); } catch (_) {} server.close(); cleanup(); process.exit(code); };

  try {
    // ---- 1. CONTROL: an un-raced re-price still re-arms on the new ladder
    {
      const { token, ladder } = await armedLoad(base, 'RSR-CTL-REPRICE');
      const r = await send(base, 'POST', `/price/${token}`, REPRICE);
      await answerReads(FAR_MS);
      const doc = await requests.getByToken(token);
      const m = liveMonitor('RSR-CTL-REPRICE');
      assert.strictEqual(r.status, 200, `control: an un-raced re-price must save (HTTP ${r.status})`);
      assert.strictEqual(doc.status, 'armed', 'control: the record stays armed');
      assert.strictEqual(doc.price.cost, 31000, 'control: the new cost is on the record');
      assert.ok(m, 'control: a live monitor is armed after the re-price');
      assert.notDeepStrictEqual(m.ladder, ladder, 'control: the live monitor carries the NEW ladder');
      ok('control: an un-raced re-price re-arms a live monitor on the new ladder');
    }

    // ---- 2. CONTROL: an un-raced stop still stops
    {
      const { token } = await armedLoad(base, 'RSR-CTL-STOP');
      const r = await send(base, 'POST', '/api/auctions/RSR-CTL-STOP/stop');
      const doc = await requests.getByToken(token);
      assert.strictEqual(r.status, 200, `control: the stop route must answer 200 (HTTP ${r.status})`);
      assert.strictEqual(doc.status, 'stopped', 'control: the record reads stopped');
      assert.strictEqual(liveMonitor('RSR-CTL-STOP'), null, 'control: no live monitor after stop');
      assert.strictEqual(engine.scheduler.get('RSR-CTL-STOP').status, 'stopped', 'control: the durable intent reads stopped');
      ok('control: an un-raced stop stops the record, the monitor and the intent');
    }

    // ---- 3. POSITIVE PIN: a re-price posted after the stop has settled arms nothing
    {
      const { token } = await armedLoad(base, 'RSR-SEQ');
      const s = await send(base, 'POST', '/api/auctions/RSR-SEQ/stop');
      assert.strictEqual(s.status, 200, 'setup: stop answered 200');
      const bidsAtStop = bids.length;
      await send(base, 'POST', `/price/${token}`, REPRICE);
      await answerReads(10_000);
      const doc = await requests.getByToken(token);
      assert.strictEqual(doc.status, 'stopped', 'sequential: the record still reads stopped');
      assert.strictEqual(liveMonitor('RSR-SEQ'), null, 'sequential: the late re-price armed no monitor');
      assert.deepStrictEqual(bids.slice(bidsAtStop), [], 'sequential: nothing reached the wire after the stop');
      ok('sequential: a re-price after a settled stop is refused and arms nothing');
    }

    // ---- 4. THE RACE: the stop lands inside the re-price's own store write
    {
      const loadId = 'RSR-RACE';
      const { token } = await armedLoad(base, loadId);

      const gate = deferred();
      const atGate = deferred();
      let held = false;
      const origPatch = store.patchDoc;
      store.patchDoc = async function (...args) {
        const [coll, key, patch] = args;
        if (!held && coll === 'priceRequests' && key === token && patch && patch.marginOverride) {
          held = true;
          atGate.resolve();
          await gate.promise;
        }
        return origPatch.apply(this, args);
      };

      const pending = send(base, 'POST', `/price/${token}`, REPRICE);
      await atGate.promise;

      const s = await send(base, 'POST', `/api/auctions/${loadId}/stop`);
      assert.strictEqual(s.status, 200, `setup: the stop route must answer 200 while the re-price is held (HTTP ${s.status})`);
      assert.strictEqual((await requests.getByToken(token)).status, 'stopped', 'setup: the stop landed on the record');
      assert.strictEqual(liveMonitor(loadId), null, 'setup: the stop removed the live monitor');
      const bidsAtStop = bids.length;

      gate.resolve();
      const r = await pending;
      store.patchDoc = origPatch;
      await answerReads(10_000);

      const doc = await requests.getByToken(token);
      const m = liveMonitor(loadId);
      const intent = engine.scheduler.get(loadId);
      const saidBidding = /bidding off the new cost and margins now/.test(r.text);

      assert.ok(!(doc.status === 'stopped' && m),
        `T1 D9 re-price over stop: the record reads '${doc.status}' (stoppedAt=${doc.stoppedAt}) while a LIVE `
        + `monitor is armed on ladder ${m && JSON.stringify(m.ladder)} - the re-price's status-less patch kept `
        + 'the stop that landed between its status check and its write, and reArmWithNewBand re-armed on top of it');
      assert.strictEqual(doc.status === 'armed', !!m,
        `T1 D9: record status '${doc.status}' and engine (live monitor ${!!m}) must agree after both requests settle`);
      assert.strictEqual(doc.status, 'stopped', 'T1 D9: the stop returned 200 first, so the stop must stand');
      assert.strictEqual(intent && intent.status, 'stopped',
        `T1 D9: the durable intent reads '${intent && intent.status}' - a restart would resurrect a stopped load`);
      assert.deepStrictEqual(bids.slice(bidsAtStop), [],
        `T1 D9: ${JSON.stringify(bids.slice(bidsAtStop))} reached the wire after the stop returned 200`);
      assert.ok(!saidBidding, 'T1 D9: the desk page must not say it is bidding on a load the operator stopped');
      ok('race: a stop inside the re-price write stands - record, engine, intent and wire agree');
    }

    console.log(`\nPASS - ${pass}/4 checks passed`);
    finish(0);
  } catch (e) {
    console.error('\nFAILED (T1 D9 re-price vs stop race):', e && e.message ? e.message : e);
    finish(1);
  }
})().catch((e) => { console.error('harness error:', e); cleanup(); process.exit(1); });
