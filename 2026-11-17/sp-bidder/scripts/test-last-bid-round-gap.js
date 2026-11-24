'use strict';
/**
 * @requires-summary-line
 * CW-267: the result's Last bid line times a bid to the close of the round it landed in when the close
 * moved after it. Live 260929X2UF (won): the bid landed 4.0 s before its round closed and extended the
 * auction; the receipt read "5 min 3 s before the final close", counting our own extension.
 *
 *   node scripts/test-last-bid-round-gap.js
 */
const assert = require('assert');
const { outcomeEnrichment } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const EXPECTED = 6;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// 260929X2UF as recorded: decided at 6,299 ms, accepted 2,257 ms later, round close 12:09:59.000 IST,
// final close 12:14:58 after our bid opened round 2.
const X2UF = {
  won: true, finalRank: 1, cost: 15_000, lastBidPrice: 16_350, landedBids: 1, attemptsAllowed: 3,
  postedCloseAt: 1790663700000, finalCloseAt: 1790664298000, finalCloseUnknown: false,
  extensionsAfterLastBid: 1, lastBidBeforeTriggerWindow: false, platformKey: 'gocomet',
  ourBids: [{ price: 16_350, ts: 1790663994952, decidedAt: 1790663992695, closesInMs: 6299, believedCloseAt: 1790663999000 }],
};

function lastBidLine(rec) {
  // The event's result facts, as toNotification carries them, then the record's money and timing detail.
  const facts = { shipperName: 'Waaree Energies Ltd.', finalRank: rec.finalRank, resultFacts: true, platformKey: rec.platformKey,
    attemptsAllowed: rec.attemptsAllowed, extensionsAfterLastBid: rec.extensionsAfterLastBid, postedCloseAt: rec.postedCloseAt,
    finalCloseUnknown: rec.finalCloseUnknown, lastBidBeforeTriggerWindow: rec.lastBidBeforeTriggerWindow,
    finalCloseAt: rec.finalCloseAt, landedBids: rec.landedBids };
  const d = Object.assign(facts, outcomeEnrichment(rec));
  const msg = renderMessage(templateFor(rec.won ? 'won' : 'lost', d), d);
  return (msg.split('\n').find((l) => l.includes('*Last bid*')) || '').trim();
}

(async () => {
  {
    const line = lastBidLine(X2UF);
    assert.ok(line.includes('4.0 s before the round close'), `X2UF: expected "4.0 s before the round close", got "${line}"`);
    assert.ok(!/min/.test(line), `X2UF: the extension minutes never appear as the bid's timing: "${line}"`);
    ok('X2UF: a bid that extended the auction reads 4.0 s before the round close');
  }
  {
    const d = outcomeEnrichment(X2UF);
    assert.strictEqual(d.lastBidRoundGapMs, 4042, `round gap carried exactly, got ${d.lastBidRoundGapMs}`);
    assert.strictEqual(d.lastBidGapMs, 303042, `final gap unchanged, got ${d.lastBidGapMs}`);
    ok('the enrichment carries the round gap (4,042 ms) beside the final gap');
  }
  {
    // Final round: nothing moved the close after our bid, so the round close is the final close.
    const rec = Object.assign({}, X2UF, { won: false, finalRank: 2, finalCloseAt: 1790663999000, extensionsAfterLastBid: 0 });
    const line = lastBidLine(rec);
    assert.ok(line.includes('4.0 s before the final close'), `unmoved close: expected "4.0 s before the final close", got "${line}"`);
    ok('a close that did not move after the bid keeps "before the final close"');
  }
  {
    // The stored close drifted 2 s after our bid with no extension counted: the Closed block says it
    // never extended, so the line must not claim a round close either.
    const rec = Object.assign({}, X2UF, { won: false, finalRank: 2, finalCloseAt: 1790664001000, extensionsAfterLastBid: 0 });
    const line = lastBidLine(rec);
    assert.ok(line.includes('6.0 s before the final close'), `a drift with no extension keeps the final close: "${line}"`);
    ok('a 2 s close drift with no extension keeps "before the final close"');
  }
  {
    // The engine could not count the extensions (null): the moved close still never reads as the bid's timing.
    const line = lastBidLine(Object.assign({}, X2UF, { extensionsAfterLastBid: null }));
    assert.ok(line.includes('4.0 s before the round close'), `an unknown extension count on a moved close: "${line}"`);
    ok('an unknown extension count on a moved close still reads the round-close gap');
  }
  {
    const line = lastBidLine(X2UF);
    assert.ok(!/~|about/i.test(line), `the gap is stated exactly, never approximated: "${line}"`);
    assert.ok(/\d+\.\d s/.test(line), `the gap carries one decimal: "${line}"`);
    ok('the gap is exact to 0.1 s, with no "~" or "about"');
  }
  console.log(`\n${pass}/${EXPECTED} checks passed`);
  if (pass !== EXPECTED) process.exitCode = 1;
})().catch((e) => { console.log('FAIL ' + (e && e.message)); process.exitCode = 1; });
