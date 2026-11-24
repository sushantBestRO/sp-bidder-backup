'use strict';
/**
 * Regression: rehydrate() names its failed retirements only inside an info-level log message
 * nobody reads.
 *
 * retirePastClose() already reports intents whose durable retirement write threw (`failed`), so
 * their closed-auction reporting stays wrong - but rehydrate() folds that fact only into the
 * `restart_with_live_auctions` INFO alert's free-text message (", N could not be retired"). That
 * kind routes nowhere a desk-visible channel reads, so the fact reaches no error surface at all.
 * The GoComet writes-off branch in server.js already has the correct twin for this exact
 * situation ("could NOT be retired ... closed-auction reporting stays wrong") on its own
 * error-class alert; the engine's own restart path had no equivalent.
 *
 * WHAT MUST NOT MOVE: a rehydrate with nothing failed must raise no such alert (check 2, the
 * control - proves the new alert is conditioned on a real failure, not fired unconditionally).
 *
 * Mock policy: the scheduler is a hand-built fake (the same shape
 * scripts/test-retire-sweep-resilience.js uses for retirePastClose) so the durable-write failure
 * is deterministic; the platform adapter is never called on this path.
 *
 *   node scripts/test-rehydrate-failed-retire-alert.js
 */
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');

let pass = 0;
const EXPECTED_CHECKS = 5;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const HOUR = 3_600_000;
const adapter = {
  capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'soft' }),
  ensureSession: async () => ({}),
  writeEnabled: false,
  async getAuctionState() { return { ok: false, error: 'unused' }; },
  async placeBid() { return { accepted: false }; },
};

const intent = (id, closesAt) => ({ auctionId: id, status: 'bidding', closesAt, won: null,
  lane: { origin: 'Bhiwandi', destination: 'Hosur' }, units: 1, cost: 50_000, marginsPct: [12.6, 7.2, 6.3] });

function mkScheduler(intents, failIds) {
  return {
    activeIntents: () => intents.slice(),
    get: (id) => intents.find((i) => i.auctionId === id) || null,
    update: (id, patch) => {
      if (failIds.includes(id)) throw new Error('ENOSPC: no space left on device');
      return Object.assign(intents.find((i) => i.auctionId === id), patch);
    },
  };
}

(async () => {
  // ============================================================================================
  // 1. MECHANISM: a rehydrate whose retirement sweep leaves failed intents raises its own
  //    error-level, desk-visible alert - not only the info-level restart message.
  // ============================================================================================
  {
    const intents = [
      intent('DEAD-OK', Date.now() - 2 * HOUR),
      intent('DEAD-FAIL', Date.now() - 2 * HOUR),
    ];
    const alerts = [];
    const eng = new BidEngine(adapter, mkScheduler(intents, ['DEAD-FAIL']), { onEvent: (e) => { if (e.type === 'alert') alerts.push(e); } });

    await eng.rehydrate();

    const failedAlerts = alerts.filter((e) => e.kind === 'rehydrate_retire_failed');
    assert.strictEqual(failedAlerts.length, 1,
      `a rehydrate with one failed retire must raise exactly one rehydrate_retire_failed alert (got ${failedAlerts.length})`);
    ok('a rehydrate with a failed retirement raises its own error-level alert');
  }

  // ============================================================================================
  // 2. At error level, and naming the count and the load - so it is loud (price-page gate: a
  //    runtime-only surprise gets a desk-visible error, never a log line alone) and actionable.
  // ============================================================================================
  {
    const intents = [
      intent('DEAD-OK', Date.now() - 2 * HOUR),
      intent('DEAD-FAIL', Date.now() - 2 * HOUR),
    ];
    const alerts = [];
    const eng = new BidEngine(adapter, mkScheduler(intents, ['DEAD-FAIL']), { onEvent: (e) => { if (e.type === 'alert') alerts.push(e); } });
    await eng.rehydrate();

    const a = alerts.find((e) => e.kind === 'rehydrate_retire_failed');
    assert.ok(a, 'precondition: the alert fired');
    assert.strictEqual(a.level, 'error', `the alert must be error-level, not info (got '${a.level}')`);
    assert.ok(typeof a.detail === 'string' && /\b1\b/.test(a.detail), 'the detail must state the count of failed retirements');
    assert.ok(/DEAD-FAIL/.test(String(a.auctionId)), 'the failed load is identifiable from the alert, not just a bare count');
    ok('the alert is error-level and names the failed count and load');
  }

  // ============================================================================================
  // 3. CONTROL: a rehydrate with no failed retires raises no such alert.
  // ============================================================================================
  {
    const intents = [intent('DEAD-OK', Date.now() - 2 * HOUR)];
    const alerts = [];
    const eng = new BidEngine(adapter, mkScheduler(intents, []), { onEvent: (e) => { if (e.type === 'alert') alerts.push(e); } });
    await eng.rehydrate();

    assert.strictEqual(alerts.filter((e) => e.kind === 'rehydrate_retire_failed').length, 0,
      'CONTROL: a clean rehydrate (nothing failed) must not raise rehydrate_retire_failed');
    ok('CONTROL: a rehydrate with no failed retires raises no alert');
  }

  // ============================================================================================
  // 4. The kind reaches the Director's error channel (ERROR_KINDS), not just the event ring - a
  //    kind that toNotification never maps is a alert nobody downstream ever sees.
  // ============================================================================================
  {
    const { ERROR_KINDS, toNotification } = require('../src/notify/engineAlerts');
    assert.ok(ERROR_KINDS.has('rehydrate_retire_failed'), 'rehydrate_retire_failed must be registered in ERROR_KINDS');
    const n = toNotification({ type: 'alert', level: 'error', kind: 'rehydrate_retire_failed',
      auctionId: 'DEAD-FAIL', detail: '1 auction(s) that ended while this process was down could not be marked closed' });
    assert.ok(n && n.kind === 'error', 'the kind maps to a real error notification');
    ok('rehydrate_retire_failed is wired to the error channel via ERROR_KINDS/toNotification');
  }

  // ============================================================================================
  // 5. Two DIFFERENT failed sets across two restarts must not collapse into one dedupe key -
  //    a persistent notifSent store must see them as distinct events.
  // ============================================================================================
  {
    const alerts1 = [];
    const e1 = new BidEngine(adapter, mkScheduler([intent('A', Date.now() - HOUR)], ['A']), { onEvent: (e) => { if (e.type === 'alert') alerts1.push(e); } });
    await e1.rehydrate();
    const alerts2 = [];
    const e2 = new BidEngine(adapter, mkScheduler([intent('B', Date.now() - HOUR)], ['B']), { onEvent: (e) => { if (e.type === 'alert') alerts2.push(e); } });
    await e2.rehydrate();

    const a1 = alerts1.find((e) => e.kind === 'rehydrate_retire_failed');
    const a2 = alerts2.find((e) => e.kind === 'rehydrate_retire_failed');
    assert.ok(a1 && a2, 'precondition: both restarts raised the alert');
    assert.notStrictEqual(a1.auctionId, a2.auctionId,
      'two restarts stranding DIFFERENT loads must not share the same auctionId (and therefore dedupe key)');
    ok('two different failed sets carry distinct identity - a later restart is never silently deduped against an earlier one');
  }

  if (pass !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} of ${EXPECTED_CHECKS} checks`);
    process.exit(1);
  }
  console.log(`\nPASS ${pass}/${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
