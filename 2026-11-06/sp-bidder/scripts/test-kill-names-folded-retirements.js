'use strict';
/**
 * A kill must not swallow the loads the unreadable-retirement window folded.
 *
 * Loads retired because the portal could not be read after their close are announced one message
 * per window; the ones retired inside the window are folded into the next message, or into a one-shot
 * flush timer. kill() releases that timer (a killed engine must not speak hours later), and after a
 * resume nothing re-arms it, so with no live load left to read the folded loads were never announced
 * anywhere. The kill alert is the moment to name them.
 *
 * Must not move: a killed engine still never sends the separate folded message later (check 2), and a
 * kill with nothing folded renders exactly as before (check 3, the control).
 *
 * Run: node scripts/test-kill-names-folded-retirements.js
 */
process.env.LOG_LEVEL = 'silent';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification } = require('../src/notify/engineAlerts');
const { renderMessage } = require('../src/notify/waTemplates');

let pass = 0;
const EXPECTED_CHECKS = 3;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-names-folded-'));
process.on('exit', () => { try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch (_) {} });
let seq = 0;

function mkEngine(alerts) {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 1, revisionsLeft: 2, latencyMs: 20 }),
  };
  return new BidEngine(adapter, new DurableScheduler(path.join(TMPDIR, `intent-${seq++}.json`)), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500 },
    onEvent: (e) => { if (e.type === 'alert') alerts.push(e); },
  });
}

const rendered = (evt) => { const n = toNotification(evt); return n ? renderMessage(n.kind, n.data) : ''; };

(async () => {
  {
    const alerts = [];
    const eng = mkEngine(alerts);
    eng._unreadableFolded = 2;
    eng._unreadableFoldedIds = ['LOAD-A', 'LOAD-B'];
    eng._armUnreadableFlushTimer(50);
    eng.kill('manual');
    const killed = alerts.find((e) => e.kind === 'killed');
    const text = rendered(killed);
    assert.ok(/LOAD-A/.test(text) && /LOAD-B/.test(text) && /\b2\b/.test(text),
      `the kill alert must name the 2 folded loads so they are not lost; it read: ${JSON.stringify(text)}`);
    assert.ok(/manual/.test(text), `the kill alert must still carry the kill reason; it read: ${JSON.stringify(text)}`);
    ok('1. the kill alert names the folded retirements and keeps the kill reason');

    eng.resume();
    await sleep(200);
    assert.strictEqual(alerts.filter((e) => e.kind === 'unreadable_past_close_retired').length, 0,
      'the folded loads were named at the kill, so no separate message follows after it');
    assert.strictEqual(eng._unreadableFolded, 0, 'the named loads leave the fold, so no later message repeats them');
    ok('2. nothing speaks the same loads again after the kill or the resume');
  }

  {
    const alerts = [];
    const eng = mkEngine(alerts);
    eng.kill('manual');
    const text = rendered(alerts.find((e) => e.kind === 'killed'));
    assert.strictEqual(text, '⚠️ *Bid Command alert* on bidder\nmanual', `CONTROL: a kill with nothing folded reads as before; got ${JSON.stringify(text)}`);
    ok('3. control: a kill with nothing folded renders exactly as before');
  }

  if (pass !== EXPECTED_CHECKS) { console.error(`ran ${pass} of ${EXPECTED_CHECKS} checks`); process.exit(1); }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED: ' + (e && e.message)); process.exit(1); });
