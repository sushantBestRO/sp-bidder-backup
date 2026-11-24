'use strict';
/**
 * H1 - T6 LOGIC-2: notifyEngineEvent's outcome-enrichment lookup (src/notify/engineAlerts.js)
 * wraps `getRecord(evt.auctionId)` + outcomeEnrichment in a bare `catch (_) {}` - a throw there
 * (a bad closed-bids record, a future getRecord that can fail) leaves no trace anywhere: no log
 * line, no counter, no payload flag - while the alert still goes out with the lean, unenriched
 * data as if nothing happened. That silently violates the project's own price-page-adjacent gate
 * (the price-page gate: "a swallowed catch ... is a blocking defect on its own").
 *
 * Design: the catch logs the failure naming the alert KIND and AUCTION ID, and the alert still
 * goes out exactly as it does today - enrichment failing must never block or delay the alert.
 *
 * CONTROL: a healthy getRecord still enriches the payload and logs nothing.
 * MECHANISM: a throwing getRecord still sends exactly one alert (unchanged), AND logs exactly
 * one warn-level line naming the kind and the auction id.
 *
 *   node scripts/test-outcome-enrichment-throw-logged.js
 */
const assert = require('assert');
const { notifyEngineEvent } = require('../src/notify/engineAlerts');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function fakeNotifier() {
  const calls = [];
  return { calls, alert: async (kind, data, opts) => { calls.push({ kind, data, opts }); } };
}

// Captures console.error lines (log.warn routes there) while `fn` runs, then restores it -
// run-tests.js spawns each test-*.js as its own process, so this never leaks into another file.
async function captureConsoleError(fn) {
  const errLines = [];
  const orig = console.error;
  console.error = (line) => errLines.push(line);
  try { await fn(); } finally { console.error = orig; }
  return errLines;
}

(async () => {
  // ---- CONTROL: a healthy getRecord enriches the payload and logs nothing ----
  {
    const n = fakeNotifier();
    const evt = { type: 'auction_result', auctionId: 'A1', won: true, finalRank: 1, landedBids: 1,
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', companyName: 'Havells' };
    const rec = { cost: 100000, lastBidPrice: 106300, ourBids: [{ price: 106300 }], won: true };
    const errLines = await captureConsoleError(() => notifyEngineEvent(n, evt, null, async () => rec));

    assert.strictEqual(n.calls.length, 1, 'CONTROL: exactly one alert sent');
    assert.strictEqual(n.calls[0].data.marketRate, '1,00,000', 'CONTROL: a healthy getRecord fills marketRate from the record');
    assert.strictEqual(errLines.length, 0, 'CONTROL: no warning is logged when enrichment succeeds');
    ok('a healthy getRecord enriches the payload and logs nothing');
  }

  // ---- MECHANISM: a throwing getRecord must not go silent ----
  {
    const n = fakeNotifier();
    const evt = { type: 'auction_result', auctionId: 'A2', won: false, finalRank: 3, landedBids: 1,
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', companyName: 'Havells' };
    const errLines = await captureConsoleError(
      () => notifyEngineEvent(n, evt, null, async () => { throw new Error('simulated getRecord throw'); }));

    assert.strictEqual(n.calls.length, 1, 'MECHANISM: the alert still goes out when enrichment throws (unchanged today)');
    ok('a throwing getRecord does not block or delay the alert');

    assert.strictEqual(errLines.length, 1,
      'MECHANISM: exactly one warning line must be logged when getRecord throws - none was');
    let parsed = null;
    try { parsed = JSON.parse(errLines[0]); } catch (_) { /* checked below */ }
    assert.ok(parsed, 'MECHANISM: the logged line is valid JSON');
    assert.strictEqual(parsed.level, 'warn', 'MECHANISM: logged at warn level');
    assert.strictEqual(parsed.kind, 'lost', 'MECHANISM: the log line names the alert kind (lost, for a won:false close)');
    assert.strictEqual(parsed.auctionId, 'A2', 'MECHANISM: the log line names the auction id');
    ok('a throwing getRecord IS logged, naming the alert kind and the auction id');
  }

  console.log(`\n${pass} passed`);
  process.exit(0);
})().catch((e) => {
  console.error(`\nFAILED after ${pass} passed:`, (e && e.message) || e);
  process.exit(1);
});
