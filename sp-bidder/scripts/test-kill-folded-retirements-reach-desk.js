'use strict';
/**
 * The loads a kill names from the unreadable-retirement fold must reach a person, not only the
 * engine event.
 *
 * kill() drains the fold into the 'killed' alert's detail and empties it. 'killed' carries no
 * auctionId, so engineAlerts keys it 'global_error_killed', and the notifier's sent-mark is a
 * persistent document: once any kill has been delivered, every later kill alert is swallowed as a
 * repeat. The same key is shared by every engine a console kill stops in one tap, so only the first
 * engine's alert is sent. Either way the named loads, already removed from the fold, reach nobody.
 *
 * Must not move (controls): a kill with nothing folded is still delivered once, and the first kill
 * ever still goes out.
 *
 *   node scripts/test-kill-folded-retirements-reach-desk.js
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
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-folded-desk-'));
process.on('exit', () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

function rig() {
  const sent = [];
  const transport = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  const wa = new WhatsAppClient({ enabled: true, transport, token: 't', productId: 'p', phoneId: '128023' });
  const notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
    store: new MemoryStore(), recipientsProvider: async () => [{ name: 'Ops', phone: '+919000000009', alerts: ['error'] }] });
  const pending = [];
  const mkEngine = () => new BidEngine({
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }),
  }, new DurableScheduler(path.join(TMPDIR, `intent-${seq++}.json`)), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500 },
    onEvent: (e) => { if (e.type === 'alert') pending.push(notifyEngineEvent(notifier, e)); },
  });
  const texts = () => sent.map((b) => JSON.stringify(b));
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { mkEngine, texts, settle };
}

function fold(eng, ids) {
  eng._unreadableFolded = ids.length;
  eng._unreadableFoldedIds = ids.slice();
}

(async () => {
  {
    const r = rig();
    const eng = r.mkEngine();
    eng.kill('manual (console)');
    await r.settle();
    assert.strictEqual(r.texts().filter((t) => /manual \(console\)/.test(t)).length, 1,
      `CONTROL: the first kill ever is delivered once; sent=${JSON.stringify(r.texts())}`);
    ok('1. control: a first kill with nothing folded is delivered');

    eng.resume();
    fold(eng, ['LOAD-A', 'LOAD-B']);
    eng.kill('manual (console)');
    await r.settle();
    assert.ok(r.texts().some((t) => /LOAD-A/.test(t) && /LOAD-B/.test(t)),
      'a later kill that names folded loads must put them in front of a person; '
      + `no send named them. sent=${JSON.stringify(r.texts())}`);
    ok('2. a second kill naming folded loads is not swallowed as a repeat of the first');
  }

  {
    const r = rig();
    const sp = r.mkEngine();
    const gc = r.mkEngine();
    fold(gc, ['GC-ENQ-1']);
    for (const e of [sp, gc]) e.kill('manual (console)');
    await r.settle();
    assert.ok(r.texts().length >= 1, 'CONTROL: the tap is delivered at all');
    ok('3. control: one console kill across two engines is delivered');
    assert.ok(r.texts().some((t) => /GC-ENQ-1/.test(t)),
      'the second engine\'s folded load must reach a person when one tap stops both engines; '
      + `sent=${JSON.stringify(r.texts())}`);
    ok('4. a folded load on the second engine a console kill stops is not dropped');
  }

  if (pass !== EXPECTED_CHECKS) { console.error(`ran ${pass} of ${EXPECTED_CHECKS} checks`); process.exit(1); }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED: ' + (e && e.message)); process.exit(1); });
