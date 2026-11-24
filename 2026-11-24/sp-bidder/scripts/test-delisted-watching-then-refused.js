'use strict';
/**
 * A load the desk was told we are still watching must not be stood down without telling them.
 *
 * _checkDelisted's early notice now says "We are still watching it and will bid if it opens again.
 * No action needed". When SuperProcure then refuses the snipe with "Load not available for bidding",
 * the engine stands the load down for good. The live path suppresses its own notice behind
 * monitor._delistedNoticed, and both emits share one dedupe key, so the only message the desk ever
 * got about the load promises a bid that will not be sent.
 *
 * Must not move (controls): the early notice still goes out once and still reads "Still watching";
 * a load refused with no early notice still gets exactly one "Not bidding" notice.
 *
 *   node scripts/test-delisted-watching-then-refused.js
 */
process.env.LOG_LEVEL = 'silent';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0;
const EXPECTED_CHECKS = 4;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'delisted-refused-'));
process.on('exit', () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} });

const CFG = { openAtMs: 25000, floorWindowMs: 2500, minInterFireMs: 0, delistedStaleMs: 90_000 };
const BAND = { cost: 38000, marginsPct: [14, 11.5, 10.3], minMarginPct: 10.3 };
const st = (o) => Object.assign({ ok: true, status: 'live', myRank: null, totalBidders: 1,
  standingL1Price: null, closesInMs: 10000, revisionLimit: 3, revisionsLeft: 3,
  minDecrement: 100, closeModel: 'hard', measuredRttMs: 50 }, o);
const meta = (id) => ({ id, lane: { origin: 'Bhiwandi', destination: 'Surat' }, units: 1,
  companyName: 'Syngenta', branchName: 'Bhiwandi', closesAt: Date.now() + 30_000 });

function rig(trace) {
  const sent = [];
  const transport = async (url, opts) => {
    sent.push(JSON.parse(opts.body).message || '');
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => [{ name: 'Desk', phone: '+919000000009', alerts: ['desk_notice'] }] });
  const pending = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    writeEnabled: true,
    listingTrace: () => trace,
    async getAuctionState() { return st({}); },
    async placeBid() { return { accepted: false, status: 400, reason: 'Load not available for bidding', text: 'Load not available for bidding' }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(path.join(TMPDIR, `intent-${Math.random()}.json`)), {
    config: CFG, rand: () => 0,
    onEvent: (e) => { if (e.type === 'alert') pending.push(notifyEngineEvent(notifier, e)); },
  });
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { eng, sent, settle };
}

(async () => {
  {
    const stale = { lastSeenInListAt: Date.now() - 294_000, lastSeenInListAgoMs: 294_000, biddingOn: false };
    const r = rig(stale);
    const m = r.eng.arm(meta('WATCH-1'), BAND);
    await r.settle();
    assert.strictEqual(r.sent.length, 1, `CONTROL: the early notice goes out once; sent=${JSON.stringify(r.sent)}`);
    assert.ok(/Still watching/.test(r.sent[0]), `CONTROL: the early notice reads "Still watching": ${r.sent[0]}`);
    ok('1. control: the early notice is sent once and says we are still watching');

    await r.eng._maybeBid(m, st({ closesInMs: 2000 }));
    await r.settle();
    assert.strictEqual(m.loadNotBiddable, true, 'precondition: the platform refusal stood the load down');
    r.eng.kill();
    assert.ok(r.sent.slice(1).some((t) => /Not bidding/.test(t)),
      'after SuperProcure refuses the load the desk was told "still watching", a notice saying we are '
      + `not bidding must reach them; sent=${JSON.stringify(r.sent)}`);
    ok('2. a stand-down after the early notice is told to the desk');
  }

  {
    const r = rig(null);
    const m = r.eng.arm(meta('REFUSED-1'), BAND);
    await r.settle();
    assert.strictEqual(r.sent.length, 0, 'CONTROL: a fresh listing raises no early notice');
    ok('3. control: no early notice without a stale listing');
    await r.eng._maybeBid(m, st({ closesInMs: 2000 }));
    await r.settle();
    r.eng.kill();
    assert.strictEqual(r.sent.filter((t) => /Not bidding/.test(t)).length, 1,
      `CONTROL: a refusal with no early notice sends exactly one "Not bidding"; sent=${JSON.stringify(r.sent)}`);
    ok('4. control: a refusal with no early notice sends exactly one notice');
  }

  if (pass !== EXPECTED_CHECKS) { console.error(`ran ${pass} of ${EXPECTED_CHECKS} checks`); process.exit(1); }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED: ' + (e && e.message)); process.exit(1); });
