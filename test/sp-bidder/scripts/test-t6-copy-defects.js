'use strict';
/**
 * Pins the T6 bug-hunt copy-visible defects (owner "final push", 26 Sep) plus the live-receipt
 * last-bid-gap defect reported the same day. Evidence: .build/cache/python-port/sanity-5.yaml
 * (search "T6 RECOVERY"), docs/bug-hunts/2026-09-16_bidcmd-T6-*.
 *
 *   1. lost_short omitted rateChangedLine (BH-CONTRACT-1/LOGIC-3) - waTemplates.js lost_short entry.
 *   2. signedPct printed "(+-0.00%)" at a fraction just below zero (BH-INV-3/LOGIC-5/BOUNDARY-3) -
 *      `n >= 0` is true for -0 in JS.
 *   3. A newline in a customer/branch label broke the WON bold header (BH-BOUNDARY-5/INV-10).
 *   4. A non-numeric lastBidPrice produced marginPct "NaN" ("Margin low - only NaN%")
 *      (BH-BOUNDARY-7) - Number(junk) is NaN, which `!= null` does not catch.
 *   5. lastBidLine claimed "at the final close" beside a landing time AFTER the shown close
 *      (live GoComet Waaree 260925NP9V, 26 Sep) - bidGapsMs clamps its gap to 0, which reads
 *      identically to "landed exactly on time".
 *
 * @requires-summary-line
 *   node scripts/test-t6-copy-defects.js
 */
const assert = require('assert');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // ---- 1. lost_short carries the rate-changed line, same as the long lost template ----
  {
    const d = {
      shipper: 'Havells', oaNo: 'OA1', finalRank: 2, marketRate: '50,000', marginRate: '48,000', marginPct: '4.00',
      rateChangedFrom: '45,000', rateChangedTo: '48,000',
    };
    const msg = renderMessage(templateFor('lost_short', d), d);
    assert.ok(msg.includes('ℹ️ *Rate changed* - ₹45,000 -> ₹48,000'), `T6 item 1: lost_short carries the rate-changed line: ${msg}`);
    ok('T6 item 1: lost_short no longer omits rateChangedLine');
  }

  // ---- 2. signedPct never double-signs a fraction-below-zero margin ----
  {
    const d = {
      shipper: 'Havells', oaNo: 'OA1', finalRank: 2, marketRate: '50,000', marginRate: '49,999', marginPct: '-0.00',
    };
    const msg = renderMessage(templateFor('lost_short', d), d);
    assert.ok(!/\+-/.test(msg), `T6 item 2: never prints a double sign like "+-0.00%": ${msg}`);
    assert.ok(msg.includes('(-0.00%)'), `T6 item 2: a genuinely negative (even if rounds to 0.00) margin keeps its real sign: ${msg}`);
    ok('T6 item 2: signedPct no longer prints "(+-0.00%)" at a fraction below zero');
  }

  // ---- 3. a newline in the customer/branch label does not break the WON bold header ----
  {
    const d = { shipperName: 'Havells\nIndia', branch: 'Chikhli\nPlant', finalRank: 1, resultFacts: true };
    const msg = renderMessage(templateFor('won', d), d);
    const firstLine = msg.split('\n')[0];
    assert.ok(firstLine.startsWith('🎉 *WON - Havells India · Chikhli Plant*') && firstLine.endsWith('*'),
      `T6 item 3: the bold header closes its asterisk on the FIRST line (no embedded newline survives): got "${firstLine}"`);
    ok('T6 item 3: an embedded newline in customer/branch no longer breaks the WON header');
  }

  // ---- 4. a non-numeric lastBidPrice never yields marginPct/marginRate "NaN" ----
  {
    const { outcomeEnrichment } = require('../src/notify/engineAlerts');
    const rec = { lastBidPrice: 'not-a-number', ourBids: [{ price: 1, ts: 1 }], won: false, finalRank: 3,
      costHistory: [{ cost: 40000, ourBidsBefore: 0 }] };
    const out = outcomeEnrichment(rec);
    assert.strictEqual(out.marginPct, undefined, `T6 item 4: marginPct is never set from an unreadable lastBidPrice (never "NaN"), got ${JSON.stringify(out.marginPct)}`);
    assert.strictEqual(out.marginRate, undefined, `T6 item 4: marginRate is never set from an unreadable lastBidPrice, got ${JSON.stringify(out.marginRate)}`);
    const d = Object.assign({ shipper: 'Havells', oaNo: 'OA1', finalRank: 3 }, out);
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(!/NaN/.test(msg), `T6 item 4: no receipt render ever contains the literal "NaN": ${msg}`);
    ok('T6 item 4: a non-numeric lastBidPrice no longer survives as NaN into marginPct/marginRate');
  }

  // ---- 5. a bid that landed AT OR AFTER the shown close states the send-time countdown ----
  {
    // The live shape: decided with 3,532ms on the clock, but the write took 4,578ms, so it landed
    // ~1,046ms after the close it was aimed at. closeAtMs and lastBidTs are both real wall-clock
    // instants; lastBidLeadMs is the raw decision-time countdown (already computed and threaded by
    // engineAlerts.outcomeEnrichment, gated on closeMatchesBid).
    const closeAtMs = Date.UTC(2026, 8, 26, 5, 49, 58); // 11:19:58 am IST
    const lastBidTs = Date.UTC(2026, 8, 26, 5, 50, 0, 40); // 11:20:00.04 am IST - AFTER the close
    const d = { closeAtMs, lastBidTs, lastBidLeadMs: 3532, resultFacts: true };
    const msg = renderMessage(templateFor('lost', Object.assign({ shipper: 'Waaree', oaNo: 'X', finalRank: 2 }, d)),
      Object.assign({ shipper: 'Waaree', oaNo: 'X', finalRank: 2 }, d));
    assert.ok(msg.includes('sent 3.5 s before the close (landed'), `T6 last-bid-gap: renders the send-time countdown, got: ${msg}`);
    assert.ok(!/at the final close/.test(msg), `T6 last-bid-gap: never claims "at the final close" beside a late landing: ${msg}`);
    ok('T6 last-bid-gap: a bid landing at/after the shown close states the send-time countdown, not "at the final close"');
  }

  // ---- control: a normal pre-close landing renders exactly as before ----
  {
    const closeAtMs = Date.UTC(2026, 8, 26, 5, 49, 58);
    const lastBidTs = Date.UTC(2026, 8, 26, 5, 49, 55); // 3s before the close
    const d = { closeAtMs, lastBidTs, lastBidGapMs: 3000, resultFacts: true, shipper: 'Waaree', oaNo: 'X', finalRank: 2 };
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(msg.includes('3.0 s before the final close'), `control: a normal pre-close landing is unchanged: ${msg}`);
    ok('control: a normal pre-close bid landing renders exactly as before this fix');
  }

  // ---- review correction (26 Sep): the "never at the final close beside a later time" rule is
  // ABSOLUTE - a landing at/after the shown close must never fall through to that wording just
  // because gapPhrase(lastBidLeadMs) returned nothing (a lead of 50ms or less rounds to a null
  // phrase there). A known-but-tiny lead still states the send-time countdown, honestly, as ~0.0s.
  {
    const closeAtMs = Date.UTC(2026, 8, 26, 5, 49, 58);
    const lastBidTs = Date.UTC(2026, 8, 26, 5, 50, 0); // after the close
    const d = { closeAtMs, lastBidTs, lastBidLeadMs: 30, resultFacts: true, shipper: 'Waaree', oaNo: 'X', finalRank: 2 };
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(!/at the final close/.test(msg), `a tiny known lead (30ms) must never fall through to "at the final close": ${msg}`);
    assert.ok(/sent 0\.0 s before the close \(landed/.test(msg), `a tiny known lead still states an honest ~0.0s send-time countdown: ${msg}`);
    ok('review correction: a lead of 50ms or less still renders the send-time form, never "at the final close"');
  }

  // ---- review correction: when the send lead itself is unknown (null), state only the landing time ----
  {
    const closeAtMs = Date.UTC(2026, 8, 26, 5, 49, 58);
    const lastBidTs = Date.UTC(2026, 8, 26, 5, 50, 0); // after the close
    const d = { closeAtMs, lastBidTs, lastBidLeadMs: null, resultFacts: true, shipper: 'Waaree', oaNo: 'X', finalRank: 2 };
    const msg = renderMessage(templateFor('lost', d), d);
    assert.ok(!/at the final close/.test(msg), `an unknown lead must never fall through to "at the final close" either: ${msg}`);
    assert.ok(!/sent .* before the close/.test(msg), `no lead figure exists to claim - the "sent...before the close" form must not appear: ${msg}`);
    assert.ok(new RegExp(`Last bid\\* - landed \\d`).test(msg), `states only the landing time when the send lead is unknown: ${msg}`);
    ok('review correction: an unknown send lead renders only the landing time, no "before the close" claim at all');
  }

  console.log(`\n${pass}/8 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
