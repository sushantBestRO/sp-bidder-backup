'use strict';
/**
 * A GoComet 'off' load's believed close follows forward moves smaller than half the increment.
 *
 * A reactive GoComet close resets the deadline to roughly now + increment, so a bid landing early in
 * the window extends it by far less than the 300s increment. The GoComet close model counts any
 * forward move of 30s or more as real (minJumpMs); the adapter publishes that floor as
 * minCloseJumpMs, and the engine's softStrategy 'off' branch - which counts no rounds - uses it in
 * place of the counted path's half-increment floor. SuperProcure publishes no floor and keeps the
 * half-increment rule.
 *
 *   A. the real GoCometAdapter publishes minCloseJumpMs 30000 on a live read.
 *   B. a +60s GoComet move is adopted and persisted, and no round is counted.
 *   C. a +20s GoComet move is not adopted.
 *   D. a published extendMs of 0 still means no advance, floor or not.
 *   E. a SuperProcure-shaped 'off' load (no floor published) ignores +60s and adopts +90s of a 180s
 *      increment.
 *
 * Offline and deterministic: fake fetch / fake adapter, stubbed clock, temp-file DurableScheduler,
 * no network, no sleeps. The fake engine adapter refuses every bid and the file fails if one is tried.
 *
 *   node scripts/test-gocomet-off-belief-min-jump.js
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const GC_EXTEND_MS = 300_000;
const GC_MIN_JUMP_MS = 30_000;
const SP_EXTEND_MS = 180_000;

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-off-min-jump-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let bidAttempts = 0;

function rig() {
  const ctrl = { frame: null };
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'soft', reactiveClose: true, snipeBudgetMs: 3000 }),
    async getAuctionState() { return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' }; },
    async placeBid() { bidAttempts += 1; return { accepted: false, error: 'offline test adapter' }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Allowlisted'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: quiet,
  });
  const arm = (id, closesAt, platformKey) => {
    vnow = closesAt - 600_000;
    const m = eng.arm({
      id, lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
      quoteType: 'FTL', companyName: 'Unlisted Shipper', closesAt, platformKey,
      rules: { revisionLimit: 3, minDecrement: 500 },
    }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    assert.strictEqual(m.softStrategy, 'off', `setup: ${id} resolved softStrategy '${m.softStrategy}'`);
    assert.strictEqual(m.believedCloseAt, closesAt, `setup: ${id} belief not seeded at the posted close`);
    return m;
  };
  const push = async (m, extra) => {
    ctrl.frame = { ok: true, status: 'live', closeModel: 'soft', extendCount: null,
      myRank: null, totalBidders: null, standingL1Price: null, measuredRttMs: 20, ...extra };
    ctrl.frame.closesInMs = ctrl.frame.closesAtMs - Date.now();
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const durable = (id) => {
    const it = eng.scheduler.get(id);
    assert.ok(it, `setup: no durable intent for ${id}`);
    return it.closesAt;
  };
  const done = () => { try { eng.kill(); } catch (_) {} };
  return { eng, events, arm, push, durable, done };
}

async function adapterPublishesFloor() {
  const base = REAL_NOW();
  const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(base / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;
  const fetchImpl = async (url) => {
    const body = url.includes('/bidding-data') ? { data: { bid_closing_in: 600, vendor_rank: 2 } } : { data: {} };
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const a = new GoCometAdapter({ token, fetchImpl, sleep: async () => {}, now: () => base });
  await a.login();
  const st = await a.getAuctionState('K1');
  ok(st.ok === true && st.status === 'live', `A. setup: live read, got ok=${st.ok} status=${st.status}`);
  ok(st.minCloseJumpMs === GC_MIN_JUMP_MS, `A. GoCometAdapter.getAuctionState minCloseJumpMs ${st.minCloseJumpMs}, expected ${GC_MIN_JUMP_MS}`);
}

async function main() {
  await adapterPublishesFloor();

  {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('GC-60', posted, 'gocomet');
      vnow = posted - 300_000;
      await r.push(m, { closesAtMs: posted + 60_000, extendMs: GC_EXTEND_MS, minCloseJumpMs: GC_MIN_JUMP_MS });
      ok(m.believedCloseAt === posted + 60_000, `B. +60s GoComet move: believedCloseAt ${m.believedCloseAt}, expected ${posted + 60_000}`);
      ok(r.durable('GC-60') === posted + 60_000, `B. +60s GoComet move: durable closesAt ${r.durable('GC-60')}, expected ${posted + 60_000}`);
      ok(m.extendsObserved === 0, `B. extendsObserved ${m.extendsObserved}, expected 0`);
      ok(!r.events.some((e) => e.type === 'extension_observed'), 'B. an extension_observed event was emitted on an off load');
    } finally { r.done(); }
  }

  {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('GC-20', posted, 'gocomet');
      vnow = posted - 300_000;
      await r.push(m, { closesAtMs: posted + 20_000, extendMs: GC_EXTEND_MS, minCloseJumpMs: GC_MIN_JUMP_MS });
      ok(m.believedCloseAt === posted, `C. +20s GoComet move: believedCloseAt ${m.believedCloseAt}, expected ${posted}`);
      ok(r.durable('GC-20') === posted, `C. +20s GoComet move: durable closesAt ${r.durable('GC-20')}, expected ${posted}`);
    } finally { r.done(); }
  }

  {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('GC-ZERO', posted, 'gocomet');
      vnow = posted - 300_000;
      await r.push(m, { closesAtMs: posted + 60_000, extendMs: 0, minCloseJumpMs: GC_MIN_JUMP_MS });
      ok(m.believedCloseAt === posted, `D. extendMs 0 with a floor published: believedCloseAt ${m.believedCloseAt}, expected ${posted}`);
    } finally { r.done(); }
  }

  {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('SP-OFF', posted, 'superprocure');
      vnow = posted - 300_000;
      await r.push(m, { closesAtMs: posted + 60_000, extendMs: SP_EXTEND_MS, extendCount: 5 });
      ok(m.believedCloseAt === posted, `E. +60s SuperProcure move (no floor published): believedCloseAt ${m.believedCloseAt}, expected ${posted}`);
      vnow += 1_000;
      await r.push(m, { closesAtMs: posted + 90_000, extendMs: SP_EXTEND_MS, extendCount: 5 });
      ok(m.believedCloseAt === posted + 90_000, `E. +90s SuperProcure move: believedCloseAt ${m.believedCloseAt}, expected ${posted + 90_000}`);
    } finally { r.done(); }
  }
}

main().catch((e) => { fail++; console.error('  FAIL - threw:', e && e.stack ? e.stack : e); }).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (bidAttempts) { fail++; console.error(`  FAIL - ${bidAttempts} bid attempt(s) reached the fake adapter`); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
