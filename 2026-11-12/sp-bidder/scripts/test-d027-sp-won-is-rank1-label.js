'use strict';
/**
 * D027: SuperProcure has no award signal, so a "won" SP row must be labelled "rank 1 at close" in
 * the console win rate and in exports - never presented as equivalent to a confirmed award.
 * GoComet keeps its settled-award meaning, because its own won flag comes off a platform-confirmed
 * result (bidEngine's readSettledOutcome branch), not an inferred rank.
 *
 * Regression target: D027. exportModel.js's resultLabel/resultWords rendered a bare "Won" for
 * every platform (exportModel.js at the time this was written); the console's History/Export
 * pages showed Won/Win rate with no caveat at all.
 *
 * @requires-summary-line
 *   node scripts/test-d027-sp-won-is-rank1-label.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { canonical, outcomesView, lastBidView } = require('../src/web/exportModel');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

(async () => {
  // --- outcomesView's Result column
  const spReq = { loadId: 'SP1', platformKey: 'sp', price: { cost: 10000 } };
  const spClosed = { auctionId: 'SP1', status: 'closed', platformKey: 'sp', won: true, cost: 10000, lastBidPrice: 11000, ourBids: [{ price: 11000 }] };
  const spRow = canonical(spReq, spClosed);
  const spResult = outcomesView([spRow]).rows[0][outcomesView([spRow]).headers.indexOf('Result')];
  ok(spResult === 'Won (rank 1 at close)', `an SP won row's Result must carry the caveat (got ${spResult})`);

  const gcReq = { loadId: 'GC1', platformKey: 'gocomet', price: { cost: 10000 } };
  const gcClosed = { auctionId: 'GC1', status: 'closed', platformKey: 'gocomet', won: true, cost: 10000, lastBidPrice: 11000, ourBids: [{ price: 11000 }] };
  const gcRow = canonical(gcReq, gcClosed);
  const gcResult = outcomesView([gcRow]).rows[0][outcomesView([gcRow]).headers.indexOf('Result')];
  ok(gcResult === 'Won', `a GoComet won row's Result keeps its plain settled-award meaning (got ${gcResult})`);

  // control: a loss on either platform is unaffected
  const lostClosed = { auctionId: 'SP2', status: 'closed', platformKey: 'sp', won: false, finalRank: 3, cost: 10000, lastBidPrice: 10500, ourBids: [{ price: 10500 }] };
  const lostRow = canonical({ loadId: 'SP2', platformKey: 'sp', price: { cost: 10000 } }, lostClosed);
  const lostResult = outcomesView([lostRow]).rows[0][outcomesView([lostRow]).headers.indexOf('Result')];
  ok(lostResult === 'Lost', `control: a loss is unaffected by the D027 label (got ${lostResult})`);

  // --- lastBidView's Result column (resultReason-keyed, not the funnel status)
  const spWonReason = { auctionId: 'SP3', status: 'closed', platformKey: 'sp', resultReason: 'won', lastBidPrice: 11000, ourBids: [{ price: 11000, ts: 1 }] };
  const spWonRow = canonical({ loadId: 'SP3', platformKey: 'sp', price: { cost: 10000 } }, spWonReason);
  const spLastBid = lastBidView([spWonRow]).rows[0][lastBidView([spWonRow]).headers.indexOf('Result')];
  ok(spLastBid === 'Won (rank 1 at close)', `the last-bid sheet's SP won row must carry the caveat too (got ${spLastBid})`);

  const gcWonReason = { auctionId: 'GC3', status: 'closed', platformKey: 'gocomet', resultReason: 'won', lastBidPrice: 11000, ourBids: [{ price: 11000, ts: 1 }] };
  const gcWonRow = canonical({ loadId: 'GC3', platformKey: 'gocomet', price: { cost: 10000 } }, gcWonReason);
  const gcLastBid = lastBidView([gcWonRow]).rows[0][lastBidView([gcWonRow]).headers.indexOf('Result')];
  ok(gcLastBid === 'Won', `the last-bid sheet's GoComet won row keeps the plain word (got ${gcLastBid})`);

  // --- console: the caveat must be visible on the Won/Win rate stat tiles (History + Export)
  const history = fs.readFileSync(path.join(__dirname, '..', 'dashboard/src/pages/History.tsx'), 'utf8');
  const exportPage = fs.readFileSync(path.join(__dirname, '..', 'dashboard/src/pages/Export.tsx'), 'utf8');
  ok(/rank 1 at close/i.test(history), 'History.tsx must state the rank-1-at-close caveat somewhere near Won/Win rate');
  ok(/rank 1 at close/i.test(exportPage), 'Export.tsx must state the rank-1-at-close caveat somewhere near Won/Win rate');

  // --- the GoComet check must key on the CONFIGURED platform key (config.gocomet.platformKey,
  // GC_PLATFORM_KEY-overridable), never the literal string 'gocomet' - a subprocess with a
  // reconfigured key proves the label logic actually reads the config, not a hardcoded string.
  {
    const script = "const { resultLabel } = require(process.argv[1]); process.stdout.write(resultLabel('won', 'custom-gc-key'));";
    const modulePath = path.join(__dirname, '..', 'src', 'web', 'exportModel.js');
    const out = execFileSync(process.execPath, ['-e', script, modulePath], {
      env: Object.assign({}, process.env, { GC_PLATFORM_KEY: 'custom-gc-key' }),
      encoding: 'utf8',
    });
    ok(out === 'Won', `with GC_PLATFORM_KEY reconfigured to 'custom-gc-key', a row tagged with that same key must read the plain "Won" (got ${JSON.stringify(out)})`);
  }

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
