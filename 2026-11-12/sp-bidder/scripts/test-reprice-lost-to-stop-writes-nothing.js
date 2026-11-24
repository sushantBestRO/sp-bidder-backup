'use strict';
/**
 * A RE-PRICE THAT LOSES TO A STOP WRITES NOTHING ONTO THE STOPPED RECORD.
 *
 * Regression target: T1 D9 (R2-6), the record half. The re-price, the revert and the resume each
 * read the record, check it, and write later. When the operator Stop lands in that window the write
 * must be refused, not merged: a status-less patch put the losing change's cost and margins onto a
 * load the desk had stopped, so the kept numbers a later Re-arm bids from were ones nobody saved
 * against a stopped load, and the page told the desk it was saved.
 *
 * Each check holds the write on a parked promise until POST /api/auctions/:loadId/stop has returned
 * 200, then releases it, and compares the record with what it read before the race.
 *
 * WHAT MUST NOT MOVE: the stop itself (record 'stopped'). Whether a monitor survives is
 * pinned by test-reprice-stop-race.js and test-reprice-stop-race-paths.js, not here.
 *
 * Offline and deterministic: mock platform, file store under os.tmpdir(), and a fake platform read
 * that parks until this file resolves it by hand. No sleeps.
 *
 *   node scripts/test-reprice-lost-to-stop-writes-nothing.js
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reprice-lost-to-stop-'));
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

// Parks the first patchDoc on `token` that `match` accepts, before it writes.
function holdWrite(token, match) {
  const gate = deferred();
  const atGate = deferred();
  let held = false;
  const origPatch = store.patchDoc;
  store.patchDoc = async function (...args) {
    const [coll, key, patch] = args;
    if (!held && coll === 'priceRequests' && key === token && patch && match(patch)) {
      held = true;
      atGate.resolve();
      await gate.promise;
    }
    return origPatch.apply(this, args);
  };
  return { atGate: atGate.promise, release: () => { gate.resolve(); }, restore: () => { store.patchDoc = origPatch; } };
}

const kept = (d) => ({
  cost: d.price && d.price.cost, marginsPct: d.marginsPct, minMarginPct: d.minMarginPct,
  marginSource: d.marginSource, marginOverride: d.marginOverride || null, hold: d.hold || null,
});

async function raceStop(base, loadId, token, match, post) {
  const before = kept(await requests.getByToken(token));
  const h = holdWrite(token, match);
  const pending = post();
  await h.atGate;
  const s = await send(base, 'POST', `/api/auctions/${loadId}/stop`);
  assert.strictEqual(s.status, 200, `setup: the stop answered 200 while the write was held (HTTP ${s.status})`);
  h.release();
  await pending;
  h.restore();
  await answerReads(10_000);
  const doc = await requests.getByToken(token);
  assert.strictEqual(doc.status, 'stopped', `setup: ${loadId} reads stopped after the race`);
  return { before, after: kept(doc) };
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
    await check('re-price: the losing re-price leaves the stopped record as it was', async () => {
      const loadId = 'RLS-REPRICE';
      const token = await armedLoad(base, loadId);
      const { before, after } = await raceStop(base, loadId, token, (p) => !!p.marginOverride,
        () => send(base, 'POST', `/price/${token}`, REPRICE));
      assert.deepStrictEqual(after, before,
        `T1 D9 re-price lost to stop: the stopped record now carries ${JSON.stringify(after)} - the refused re-price wrote over ${JSON.stringify(before)}`);
    });

    await check('revert: the losing revert leaves the stopped record as it was', async () => {
      const loadId = 'RLS-REVERT';
      const token = await armedLoad(base, loadId);
      const r = await send(base, 'POST', `/price/${token}`, REPRICE);
      await answerReads(FAR_MS);
      assert.strictEqual(r.status, 200, 'setup: the override re-price saved');
      assert.ok((await requests.getByToken(token)).marginOverride, 'setup: the load carries an override to revert');
      const { before, after } = await raceStop(base, loadId, token,
        (p) => Object.prototype.hasOwnProperty.call(p, 'marginOverride') && p.marginOverride === null,
        () => send(base, 'POST', `/price/${token}`, { revert_override: '1' }));
      assert.deepStrictEqual(after, before,
        `T1 D9 revert lost to stop: the stopped record now carries ${JSON.stringify(after)} - the refused revert wrote over ${JSON.stringify(before)}`);
    });

    await check('resume: the losing resume leaves the stopped record as it was, and the stop, not the resume, ends the hold (R2-2)', async () => {
      const loadId = 'RLS-RESUME';
      const token = await armedLoad(base, loadId);
      const cur = await requests.getByToken(token);
      await requests.holdBidding(token, {
        kind: 'standing', standingBidPrice: 34000, correctedCost: 40000,
        resume: { cost: 28000, marginsPct: cur.marginsPct, minMarginPct: cur.minMarginPct, marginSource: cur.marginSource },
      });
      const { before, after } = await raceStop(base, loadId, token,
        (p) => Object.prototype.hasOwnProperty.call(p, 'hold') && p.hold === null,
        () => send(base, 'POST', `/price/${token}/resume`, {}));
      const { hold: holdBefore, ...restBefore } = before;
      const { hold: holdAfter, ...restAfter } = after;
      assert.deepStrictEqual(restAfter, restBefore,
        `T1 D9 resume lost to stop: the stopped record now carries cost ${after.cost} - the refused resume wrote over cost ${before.cost}`);
      const last = ((await requests.getByToken(token)).holdHistory || []).slice(-1)[0];
      assert.ok(holdBefore && holdAfter === null && last && last.resolvedReason === 'superseded_by_operator_stop',
        `the hold should be ended by the stop: before ${JSON.stringify(holdBefore && holdBefore.kind)}, after ${JSON.stringify(holdAfter && holdAfter.kind)}, retired by ${last && last.resolvedReason}`);
    });

    if (failures.length) {
      console.error(`\nFAILED (T1 D9 a re-price lost to a stop writes nothing): ${failures.length} of 3 checks failed`);
      finish(1);
    }
    console.log(`\nPASS - ${pass}/3 checks passed`);
    finish(0);
  } catch (e) {
    console.error('\nFAILED (T1 D9 a re-price lost to a stop writes nothing):', e && e.message ? e.message : e);
    finish(1);
  }
})().catch((e) => { console.error('harness error:', e); cleanup(); process.exit(1); });
