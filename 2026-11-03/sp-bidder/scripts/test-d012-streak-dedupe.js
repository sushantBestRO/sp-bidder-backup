'use strict';
/**
 * D012: the "no bid landed" streak alert reaches the wire exactly once PER STREAK, through the real
 * WhatsApp-mode Notifier with a persistent store - not a stubbed notifier.alert, which is how the
 * regression below went unseen.
 *
 * Regression target (8369233): the dedupe key was one fixed string per account and platform, and the
 * engine's one-shot latch was spent on the offer. So a second streak on the same account was dropped
 * by the notifier's sent-key dedupe (in-process and persisted), and a streak whose single offer met a
 * down sender ('error' drops on a down sender) was never re-offered.
 *
 * @requires-summary-line
 *   node scripts/test-d012-streak-dedupe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore, MemoryStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');
const { DiscoveryPoller } = require('../src/discovery/discovery');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');

let pass = 0;
let total = 0;
let failed = 0;
const ok = (cond, msg) => {
  total += 1;
  if (cond) { pass += 1; console.log('  ok  ' + msg); } else { failed += 1; console.log('  FAIL ' + msg); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'd012-streak-'));
const fakeAdapter = { capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, closeModel: 'hard' }) };
const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };

function stack({ store, health }) {
  const eng = new BidEngine(fakeAdapter, new DurableScheduler(path.join(tmp, `sched-${Math.random()}.json`)));
  const wire = [];
  const transport = async (url, opts) => {
    wire.push(String(opts && opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '1' });
  const notifier = new Notifier({
    mode: 'whatsapp', baseUrl: 'http://t', log: () => {}, wa, store,
    recipientsProvider: async () => [{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }],
    healthProvider: async () => health.up,
  });
  const poller = new DiscoveryPoller({
    adapter: { listAuctions: async () => [] },
    requests: new PriceRequestStore({ store: createStore({ backend: 'memory' }), marginsPct: [10], minMarginPct: 5 }),
    notifier, config: { allowlist: { shippers: ['X'] } }, engine: eng, account: { accountId: 'brl-main' },
  });
  const close = async (id, landed) => {
    const m = eng.arm({ id, lane: { origin: 'A', destination: 'B' }, units: 1, closesAt: Date.now() + 60_000 },
      { marketRate: 70_000, costFloor: 40_000 });
    m.landedBids = landed;
    await eng._finalize(m, { myRank: landed ? 1 : null }).catch(() => {});
  };
  const ticks = async (n) => { for (let i = 0; i < n; i += 1) { await poller.tick(); await flush(); } };
  const sends = () => wire.filter((b) => b.includes('closes in a row')).length;
  return { close, ticks, sends };
}

(async () => {
  {
    const s = stack({ store: new MemoryStore(), health: { up: true } });
    await s.close('S1', 0); await s.close('S2', 0);
    await s.ticks(5);
    ok(s.sends() === 1, `first streak reaches the wire once (sends=${s.sends()})`);
    await s.close('L1', 1);
    await s.ticks(2);
    await s.close('S3', 0); await s.close('S4', 0);
    await s.ticks(5);
    ok(s.sends() === 2, `a second streak on the same account and platform, after a landed bid, reaches the wire (sends=${s.sends()}, want 2)`);
    await s.close('L2', 1);
    await s.close('S5', 0); await s.close('S6', 0);
    await s.ticks(5);
    ok(s.sends() === 3, `a third streak reaches the wire too (sends=${s.sends()}, want 3)`);
  }

  {
    const health = { up: false };
    const s = stack({ store: new MemoryStore(), health });
    await s.close('S1', 0); await s.close('S2', 0);
    await s.ticks(3);
    ok(s.sends() === 0, `nothing reaches the wire while the sender is down (sends=${s.sends()})`);
    health.up = true;
    await s.ticks(5);
    ok(s.sends() === 1, `the streak whose offer met a down sender goes out once the sender is healthy (sends=${s.sends()}, want 1)`);
  }

  {
    const s = stack({ store: new MemoryStore(), health: { up: true } });
    await s.close('S1', 0); await s.close('S2', 0);
    await s.ticks(10);
    await s.close('S3', 0); await s.close('S4', 0);
    await s.ticks(10);
    ok(s.sends() === 1, `one streak, still growing across many ticks, is sent once (sends=${s.sends()})`);
  }

  {
    const health = { up: false };
    const s = stack({ store: new MemoryStore(), health });
    await s.close('S1', 0); await s.close('S2', 0);
    await s.ticks(3);
    health.up = true;
    await s.ticks(10);
    await s.close('S3', 0);
    await s.ticks(10);
    ok(s.sends() === 1, `a streak re-offered after a down sender is still sent only once (sends=${s.sends()}, want 1)`);
  }

  {
    const store = new MemoryStore();
    const a = stack({ store, health: { up: true } });
    await a.close('S1', 0); await a.close('S2', 0);
    await a.ticks(3);
    ok(a.sends() === 1, `before the restart the streak is sent once (sends=${a.sends()})`);

    const b = stack({ store, health: { up: true } });
    // The same two closes reach the restarted process again, so it offers the same streak.
    await b.close('S1', 0); await b.close('S2', 0);
    await b.ticks(5);
    ok(b.sends() === 0, `after a restart mid-streak, the same streak is not sent again (sends=${b.sends()})`);

    await b.close('L1', 1);
    await b.close('S3', 0); await b.close('S4', 0);
    await b.ticks(5);
    ok(b.sends() === 1, `after a restart, a new streak on the same account and platform reaches the wire (sends=${b.sends()}, want 1)`);
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
