'use strict';
/**
 * C071: a "previous quote on this route" reference must be scoped to one platform - it must
 * never surface a GoComet quote as "our previous quote" on an SP ask or vice versa. The desk
 * anchors its entered cost on this number, so an unlabelled cross-platform citation mis-anchors a
 * human on live money.
 *
 * Regression target: C071. bidLogger.routeHistory matched lane + equipment only, with no platform
 * filter (bidLogger.js:593-622 at the time this was written).
 *
 * @requires-summary-line
 *   node scripts/test-c071-route-history-platform-scope.js
 */
const assert = require('assert');
const { BidLogger } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass += 1; }

const LANE = { origin: 'Alwar', destination: 'Pune' };

(async () => {
  const store = new MemoryStore();
  const logger = new BidLogger({ store });

  // A GoComet row on the identical lane + equipment.
  await store.putDoc('closedBids', 'GC1', {
    auctionId: 'GC1', status: 'closed', lane: LANE, equipment: '32ft', platformKey: 'gocomet',
    cost: 40000, lastBidPrice: 42000, closedAt: Date.now() - 60000,
  });
  // An SP row on the same lane + equipment.
  await store.putDoc('closedBids', 'SP1', {
    auctionId: 'SP1', status: 'closed', lane: LANE, equipment: '32ft', platformKey: 'sp',
    cost: 50000, lastBidPrice: 53000, closedAt: Date.now() - 30000,
  });

  const spOnly = await logger.routeHistory(LANE, { equipment: '32ft', platformKey: 'sp' });
  ok(spOnly.length === 1 && spOnly[0].amount === 53000,
    `an SP ask must only see the SP row, never the GoComet one (got ${JSON.stringify(spOnly)})`);

  const gcOnly = await logger.routeHistory(LANE, { equipment: '32ft', platformKey: 'gocomet' });
  ok(gcOnly.length === 1 && gcOnly[0].amount === 42000,
    `a GoComet ask must only see the GoComet row, never the SP one (got ${JSON.stringify(gcOnly)})`);

  // Control: an untagged legacy row (no platformKey) resolves to SP, same as every other reader.
  await store.putDoc('closedBids', 'LEGACY1', {
    auctionId: 'LEGACY1', status: 'closed', lane: LANE, equipment: '32ft',
    cost: 45000, lastBidPrice: 46000, closedAt: Date.now() - 10000,
  });
  const spWithLegacy = await logger.routeHistory(LANE, { equipment: '32ft', platformKey: 'sp' });
  ok(spWithLegacy.some((r) => r.amount === 46000), 'an untagged legacy row resolves to SP, so an SP ask still sees it');
  const gcWithLegacy = await logger.routeHistory(LANE, { equipment: '32ft', platformKey: 'gocomet' });
  ok(!gcWithLegacy.some((r) => r.amount === 46000), 'the untagged legacy row must not surface on a GoComet ask');

  console.log(`${pass}/${pass} checks passed`);
})().catch((e) => {
  console.error('FAIL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
