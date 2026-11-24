'use strict';
/**
 * "At the lowest margin" means the lowest price the plan could bid, and on a band with a step below
 * its minimum that price is the minimum's, not the step's.
 *
 * A stored band may carry a step below its minimum (a legacy save, tolerated unchanged: 12.6 / 7.2 / 0
 * with a 5% minimum). The ladder raises that step to the minimum-margin price, so the lowest bid the
 * plan can send is +5%. Judged against the raw step (0%), a loss whose last bid went out at +5% reads
 * as "not at the lowest margin": the loss advice stays neutral, the record flags attempts left as a
 * timing signal, and with no lead after our bid the result reads lost_on_timing - "our fault" on a load
 * bid all the way down.
 *
 * WHAT MUST NOT MOVE: a band whose minimum sits below its lowest step (Waaree 9 / 7.2 / 3.6, minimum 2)
 * is judged on the lowest step, as before; a last bid above the lowest bid price is not at the lowest
 * margin on either kind of band.
 *
 *   node scripts/test-lowest-margin-under-minimum-band.js
 */
const h = require('./lib/result-receipt-harness');
const assert = require('assert');
const { lastBidAtLowestMargin, resultReasonOf } = require('../src/util/reportedClose');

const { istAt, closeThroughLogger } = h;

let pass = 0;
const fails = [];
const check = (n, name, fn) => {
  try { fn(); console.log(`  ok  ${n}. ${name}`); pass++; } catch (e) { console.log(`  FAIL ${n}. ${name} - ${e.message}`); fails.push(n); }
};

const COST = 100000;
const CLAMPED = { cost: COST, marginsPct: [12.6, 7.2, 0], minMarginPct: 5 }; // ladder 112600 / 107200 / 105000
const PLAIN = { cost: COST, marginsPct: [9, 7.2, 3.6], minMarginPct: 2 };    // ladder 109000 / 107200 / 103600
const rec = (band, prices, extra = {}) => ({ ...band, ourBids: prices.map((price, i) => ({ price, ts: 1000 + i })), ...extra });

(async () => {
  check(1, 'clamped band: a last bid at the minimum-margin price is at the lowest margin', () => {
    const got = lastBidAtLowestMargin(rec(CLAMPED, [112600, 107200, 105000]));
    assert.strictEqual(got, true, `lastBidAtLowestMargin read ${got} for a last bid of 1,05,000 (+5%) on band 12.6 / 7.2 / 0 with a 5% minimum - the 0% step is bid at +5%, so +5% is the lowest bid`);
  });

  check(2, 'clamped band, lost at rank 3 with no lead after our bid: lost on price, not on timing', () => {
    const r = rec(CLAMPED, [112600, 107200, 105000], { won: false, finalRank: 3, leadAfterLastBid: false });
    const got = resultReasonOf(r, { landedBids: 3 });
    assert.strictEqual(got, 'lost_on_price', `resultReasonOf read '${got}' - a loss at the lowest bid the plan allowed is a price loss`);
  });

  check(3, 'clamped band, re-priced: the epoch that owned the last bid is judged the same way', () => {
    const r = rec({ cost: 90000, marginsPct: [10, 8, 6], minMarginPct: 6 }, [112600, 107200, 105000], {
      costHistory: [{ ...CLAMPED, ourBidsBefore: 3 }],
    });
    const got = lastBidAtLowestMargin(r);
    assert.strictEqual(got, true, `lastBidAtLowestMargin read ${got} for the last bid of a superseded clamped epoch`);
  });

  {
    const ARMED = { companyName: 'Adama India Private Limited', lane: { origin: 'Bhiwandi', destination: 'Bawal' },
      equipment: '32 ft MXL', units: 1, ...CLAMPED, ladder: [112600, 107200, 105000], floor: 105000 };
    const t0 = istAt(2026, 9, 20, 11, 0, 0);
    const events = [112600, 107200, 105000].map((price, i) => ({ type: 'bid_placed', price, rungIndex: i,
      ts: t0 + i * 20000, decidedAt: t0 + i * 20000 - 900, closesInMs: 60000 - i * 20000, cost: COST, minMarginPct: 5 }));
    const { record } = await closeThroughLogger({ auctionId: 'ADAMA-CLAMP', armed: ARMED, events, result: {
      won: false, finalRank: 3, landedBids: 3, attemptsAllowed: 5, finalCloseAt: t0 + 60000, leadAfterLastBid: false,
      extensionsAfterLastBid: 0, finalCloseUnknown: false, lastBidBeforeTriggerWindow: null, lastBidInFinalSeconds: false,
      postedCloseAt: t0 + 60000,
    } });
    try {
      assert.strictEqual(record.resultReason, 'lost_on_price', `closedBids.resultReason is '${record.resultReason}'`);
      assert.ok(record.lostWithAttemptsLeft !== true, 'closedBids.lostWithAttemptsLeft is set: a last bid at the lowest bid price is not a timing defect');
      console.log('  ok  4. clamped band through the real bid logger: the closed record says lost_on_price and flags no timing defect');
      pass++;
    } catch (e) { console.log(`  FAIL 4. clamped band through the real bid logger - ${e.message}`); fails.push(4); }
  }

  check(5, 'control: a band with its minimum below the lowest step is judged on the lowest step (unchanged)', () => {
    assert.strictEqual(lastBidAtLowestMargin(rec(PLAIN, [109000, 107200, 103600])), true, 'last bid at 3.6% is the lowest margin');
    assert.strictEqual(lastBidAtLowestMargin(rec(PLAIN, [109000, 107200])), false, 'last bid at 7.2% is not');
  });

  check(6, 'control: a last bid above the lowest bid price on the clamped band is not at the lowest margin', () => {
    assert.strictEqual(lastBidAtLowestMargin(rec(CLAMPED, [112600, 107200])), false, 'last bid at 7.2% on a band that bids down to +5%');
  });

  const total = pass + fails.length;
  if (fails.length) {
    console.log(`FAIL - ${fails.length} of ${total} checks (${fails.join(', ')}): on a band with a step below its minimum, "at the lowest margin" is judged against the raw step, not the minimum-margin price the ladder actually bids`);
    process.exit(1);
  }
  console.log(`PASS - ${total} checks: the lowest margin is the lowest price the plan can bid, on clamped and ordinary bands`);
})().catch((e) => { console.log(`FAIL - harness: ${e && e.stack}`); process.exit(1); });
