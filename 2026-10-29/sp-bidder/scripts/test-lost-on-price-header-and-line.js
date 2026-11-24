'use strict';
/**
 * Pins the owner's loss-cause-headline request (26 Sep 2026, mid-PR-2, twice narrowed by
 * correction): the LOST receipt names its failure point off the EXISTING loss-cause classifier
 * (src/util/reportedClose.js resultReasonOf, carried through as d.resultReason) - never a second,
 * independently-derived guess.
 *
 * Final scope after both owner corrections:
 *   lost_on_price          -> header "🔴 LOST ON PRICE - {shipper}", and the advice line becomes
 *                              "❌ Outbid on price. Our lowest price, ₹{lowest} (+{margin}%), was
 *                              on the board and another transporter bid lower. Winning this lane
 *                              needs a lower margin." - ONLY when the actual figures are present;
 *                              with no figures it must NOT claim "lowest price on the board".
 *   undercut_while_leading -> renders EXACTLY as today (dropped by owner correction).
 *   lost_on_timing         -> renders EXACTLY as today (dropped by owner correction).
 *   hold_undercut          -> its own line under ruling 91, pinned in
 *                              test-ruling91-hold-undercut-lost-line.js.
 *   unknown / no reason    -> renders EXACTLY as today (control).
 *
 * @requires-summary-line
 *   node scripts/test-lost-on-price-header-and-line.js
 */
const assert = require('assert');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const base = {
  shipper: 'Havells', oaNo: 'OA1', finalRank: 2, resultFacts: true,
  closeAtMs: Date.UTC(2026, 8, 20, 10, 0, 0),
};

(async () => {
  // ---- lost_on_price, figures present: loud header + the new outbid-on-price line ----
  {
    const d = Object.assign({}, base, { resultReason: 'lost_on_price', marginRate: '40,000', marginPct: '6.30' });
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(msg.startsWith('🔴 *LOST ON PRICE - Havells*'), `header names LOST ON PRICE: got "${msg.split('\n')[0]}"`);
    assert.ok(msg.includes('❌ Outbid on price. Our lowest price, ₹40,000 (+6.30%), was on the board and another transporter bid lower. Winning this lane needs a lower margin.'),
      `the advice line is replaced with the loud outbid-on-price wording: ${msg}`);
    assert.ok(!msg.includes('📉'), 'the old neutral/margin-advice glyph is gone on a lost_on_price receipt');
    ok('lost_on_price with real figures gets the loud header and the new line');
  }

  // ---- lost_on_price, NO figures available: must NOT claim "lowest price on the board" ----
  {
    const d = Object.assign({}, base, { resultReason: 'lost_on_price', marginRate: null, marginPct: null });
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(!/Outbid on price/.test(msg), `no figures -> no fabricated outbid-on-price claim: ${msg}`);
    assert.ok(!/lowest price/i.test(msg), `must not claim "lowest price on the board" without real numbers: ${msg}`);
    ok('lost_on_price with missing figures never claims "lowest price on the board"');
  }

  // ---- undercut_while_leading: renders EXACTLY as before this ruling (owner correction) ----
  {
    const withReason = Object.assign({}, base, { resultReason: 'undercut_while_leading' });
    const without = Object.assign({}, base); // no resultReason at all - the pre-ruling shape
    delete without.resultReason;
    const msgWith = renderMessage(templateFor('lost', withReason), withReason);
    const msgWithout = renderMessage(templateFor('lost', without), without);
    assert.strictEqual(msgWith, msgWithout, `undercut_while_leading must render byte-identical to a payload carrying no resultReason at all:\nWITH: ${msgWith}\nWITHOUT: ${msgWithout}`);
    assert.ok(msgWith.startsWith('🔴 *LOST - Havells*'), 'header stays the plain LOST verdict');
    ok('undercut_while_leading renders exactly as today (owner correction: dropped from scope)');
  }

  // ---- lost_on_timing: renders EXACTLY as before this ruling (owner correction) ----
  {
    const withReason = Object.assign({}, base, { resultReason: 'lost_on_timing' });
    const without = Object.assign({}, base);
    delete without.resultReason;
    const msgWith = renderMessage(templateFor('lost', withReason), withReason);
    const msgWithout = renderMessage(templateFor('lost', without), without);
    assert.strictEqual(msgWith, msgWithout, `lost_on_timing must render byte-identical to a payload carrying no resultReason at all:\nWITH: ${msgWith}\nWITHOUT: ${msgWithout}`);
    assert.ok(msgWith.startsWith('🔴 *LOST - Havells*'), 'header stays the plain LOST verdict');
    ok('lost_on_timing renders exactly as today (owner correction: dropped from scope)');
  }

  // ---- unknown / no reason at all: unchanged control ----
  {
    const d = Object.assign({}, base, { resultReason: 'unknown' });
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(msg.startsWith('🔴 *LOST - Havells*'), 'an unknown reason keeps the plain LOST header');
    assert.ok(!/Outbid on price/.test(msg), 'an unknown reason never triggers the new line');
    ok('control: an unknown loss-cause reason is unaffected');
  }

  // ---- review correction (26 Sep): a negative margin near zero must never print "(+-0.00%)" ----
  {
    const d = Object.assign({}, base, { resultReason: 'lost_on_price', marginRate: '25,000', marginPct: '-0.00' });
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(!/\+-/.test(msg), `the hand-rebuilt sign must never double up with a pct that already carries its own "-": ${msg}`);
    assert.ok(msg.includes('₹25,000 (-0.00%)'), `signedPct's own sign wins outright: ${msg}`);
    ok('a fractional-negative margin renders "(-0.00%)", never "(+-0.00%)"');
  }

  console.log(`\n${pass}/6 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
