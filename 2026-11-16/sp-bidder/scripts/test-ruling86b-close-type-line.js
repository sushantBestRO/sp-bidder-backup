'use strict';
/**
 * Pins the owner's ruling-86-b request (26 Sep 2026, mid-PR-2): the WON and LOST result receipts
 * state the OBSERVED close type, one line directly under "⏰ Closed - ...", the way ruling 86
 * already does for the price-ask/rate receipt (closeRuleOf/closeRuleCell state the PUBLISHED
 * rule; this states what actually happened, from the round tracker).
 *
 *   hard              -> "🔒 No extension"
 *   soft, k and cap    -> "⏳ Auto extension · extended {k} of {cap}x"
 *   soft, k, no cap    -> "⏳ Auto extension · extended {k}x"
 *   soft, no k         -> "⏳ Auto extension"
 *   gocomet, k known   -> "⏳ Auto extension · {k} rounds"
 *   gocomet, k unknown -> ''
 *   close type unknown -> ''
 *
 * No bids count here (the result already has "🔁 Attempts - N of M used"); every line is well
 * under the 40-character phone-width budget.
 *
 * @requires-summary-line
 *   node scripts/test-ruling86b-close-type-line.js
 */
const assert = require('assert');
const { closeTypeLine, renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const PHONE_WIDTH = 40;
const noPrefix = (line) => line.replace(/^\n/, '');

(async () => {
  // ---- direct unit pins on closeTypeLine ----
  {
    assert.strictEqual(closeTypeLine({ closeModel: 'hard' }), '\n🔒 No extension', 'hard close: no extension');
    assert.strictEqual(closeTypeLine({ closeModel: 'soft', round: { rounds: 3, cap: 5 } }),
      '\n⏳ Auto extension · extended 3 of 5x', 'soft, k and cap known');
    assert.strictEqual(closeTypeLine({ closeModel: 'soft', round: { rounds: 3, cap: null } }),
      '\n⏳ Auto extension · extended 3x', 'soft, k known, cap unknown - " of {cap}" dropped');
    assert.strictEqual(closeTypeLine({ closeModel: 'soft', round: { rounds: null, cap: 5 } }),
      '\n⏳ Auto extension', 'soft, k unknown - "· extended ..." dropped even though cap is known');
    assert.strictEqual(closeTypeLine({ closeModel: 'soft', round: null }),
      '\n⏳ Auto extension', 'soft, no round data at all - bare "Auto extension"');
    assert.strictEqual(closeTypeLine({ platformKey: 'gocomet', round: { rounds: 2 } }),
      '\n⏳ Auto extension · 2 rounds', 'gocomet, k known');
    // Review correction (26 Sep): named reversal - the line below used to assert "1 rounds"
    // (the actual pre-fix bug) as correct. k=1 pluralises singular.
    assert.strictEqual(closeTypeLine({ platformKey: 'gocomet', round: { rounds: 1 } }),
      '\n⏳ Auto extension · 1 round', `named reversal: k=1 renders "1 round", never "1 rounds"`);
    assert.strictEqual(closeTypeLine({ platformKey: 'gocomet', round: { rounds: null } }), '',
      'gocomet, k unknown - no line at all');
    assert.strictEqual(closeTypeLine({ closeModel: 'unknown' }), '', 'close type unknown - no line');
    assert.strictEqual(closeTypeLine({ closeModel: null }), '', 'no close model at all - no line');
    assert.strictEqual(closeTypeLine(null), '', 'no data at all - no line, never throws');
    ok('all six documented shapes render exactly the specified string');
  }

  // ---- review correction (26 Sep): an SP soft load with a PUBLISHED CAP OF 0 is a hard window in
  // disguise - the round tracker's own verdict reason is 'hard_close' for exactly this shape
  // (roundTracker.verdict: hardCap === 0 -> reason 'hard_close'), so the receipt must say "No
  // extension" like a genuinely hard load, never "extended 0 of 0x" (which reads as a soft auction
  // that simply never got to extend, the wrong story for a load with no extension budget at all).
  {
    assert.strictEqual(closeTypeLine({ closeModel: 'soft', round: { rounds: 0, cap: 0, reason: 'hard_close' } }),
      '\n🔒 No extension', `a published cap of 0 (hard_close verdict) shows No extension, not "extended 0 of 0x"`);
    // Control: cap 0 WITHOUT the hard_close reason (should not happen from the real tracker, but the
    // gate must key off the reason, not off cap === 0 alone) still renders the ordinary soft form.
    assert.strictEqual(closeTypeLine({ closeModel: 'soft', round: { rounds: 0, cap: 0, reason: 'cap_reached' } }),
      '\n⏳ Auto extension · extended 0 of 0x', 'control: cap 0 alone (a different verdict reason) is not reinterpreted as hard');
    ok('review correction: a cap-0 hard_close verdict renders "No extension", never "extended 0 of 0x"');
  }

  // ---- phone-width: every non-empty rendering is <= 40 chars, even at double-digit counts ----
  {
    const cases = [
      closeTypeLine({ closeModel: 'hard' }),
      closeTypeLine({ closeModel: 'soft', round: { rounds: 12, cap: 15 } }),
      closeTypeLine({ closeModel: 'soft', round: { rounds: 12, cap: null } }),
      closeTypeLine({ platformKey: 'gocomet', round: { rounds: 12 } }),
    ];
    for (const c of cases) assert.ok(noPrefix(c).length <= PHONE_WIDTH, `line exceeds ${PHONE_WIDTH} chars: "${c}" (${noPrefix(c).length})`);
    ok('every rendered line stays within the 40-character phone-width budget');
  }

  // ---- integration: the line appears on BOTH the WON and LOST templates, directly under Closed ----
  const baseWon = {
    finalRank: 1, oaNo: 'OA1', resultFacts: true, closeAtMs: Date.UTC(2026, 8, 20, 10, 0, 0),
    closeModel: 'soft', round: { rounds: 2, cap: 3 },
  };
  const baseLost = Object.assign({}, baseWon, { finalRank: 2 });

  {
    const won = renderMessage(templateFor('won', baseWon), baseWon);
    const lost = renderMessage(templateFor('lost', baseLost), baseLost);
    for (const [label, body] of [['won', won], ['lost', lost]]) {
      const lines = body.split('\n');
      const closedIdx = lines.findIndex((l) => l.includes('⏰ *Closed*'));
      assert.ok(closedIdx >= 0, `${label}: a Closed line is present`);
      assert.strictEqual(lines[closedIdx + 1], '⏳ Auto extension · extended 2 of 3x',
        `${label}: the close-type line sits DIRECTLY under Closed, got: ${JSON.stringify(lines.slice(closedIdx, closedIdx + 3))}`);
    }
    ok('the close-type line renders directly under Closed on both WON and LOST');
  }

  // ---- integration: a hard-close WON/LOST shows "No extension" ----
  {
    const d = Object.assign({}, baseWon, { closeModel: 'hard', round: null });
    const won = renderMessage(templateFor('won', d), d);
    assert.ok(won.includes('⏰ *Closed*') && won.split('\n').includes('🔒 No extension'), `hard-close WON shows No extension: ${won}`);
    ok('a hard-close result shows "No extension" directly under Closed');
  }

  // ---- integration: a GoComet WON/LOST shows the observed rounds, not the SP soft wording ----
  {
    // Review correction (26 Sep): named reversal - this used to assert "1 rounds" (the pre-fix bug).
    const d = Object.assign({}, baseWon, { closeModel: 'soft', platformKey: 'gocomet', round: { rounds: 1, cap: 3 } });
    const lost = renderMessage(templateFor('lost', d), d);
    assert.ok(lost.split('\n').includes('⏳ Auto extension · 1 round'), `named reversal: GoComet LOST at k=1 shows "1 round", never "1 rounds": ${lost}`);
    ok('a GoComet result uses "rounds" wording, distinct from the SuperProcure soft-close wording, and pluralises correctly at k=1');
  }

  // ---- integration: an unknown close type renders no line at all (byte-identical to before this ruling) ----
  {
    const d = Object.assign({}, baseWon, { closeModel: undefined, round: undefined });
    const won = renderMessage(templateFor('won', d), d);
    assert.ok(!/Auto extension|No extension/.test(won), `unknown close type adds no line: ${won}`);
    ok('an unknown close type adds no line at all');
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
