'use strict';
/**
 * A request dropped by dropOutOfScope and later re-created for the same load keeps its OLD link
 * useful: resolveMovedToken(oldToken) points at the live request. Nothing else changes - the old
 * request is still deleted, and a never-seen token still resolves to null (plain 404).
 *   node scripts/test-dead-link-redirect.js
 */
const assert = require('assert');
const { createStore } = require('../src/store');
const { PriceRequestStore } = require('../src/pricing/priceRequests');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log('  ok  ' + m); pass++; };

(async () => {
  const store = createStore({ backend: 'memory' });
  const rq = new PriceRequestStore({ store, marginsPct: [5, 8], minMarginPct: 3, log: () => {} });
  const future = Date.now() + 3600_000;
  const load = { id: '26722970', companyName: 'Havells', lane: 'Alwar>Sakaldiha', closesAt: future, deadlineAt: future - 90_000, account: { accountId: 'alawar' } };

  const first = await rq.createForLoad(load);
  ok(!!first.id, 'first request created');

  const dropped = await rq.dropOutOfScope(() => false, { owner: { accountId: 'alawar' } });
  ok(dropped.length === 1, 'out-of-scope request dropped');
  ok((await rq.getByToken(first.id)) === null, 'old request is still deleted (behaviour unchanged)');

  let moved = await rq.resolveMovedToken(first.id);
  ok(moved && moved.live === null, 'dropped, no live request yet -> { live: null }');

  const second = await rq.createForLoad(load);
  ok(second.id !== first.id, 'load re-created with a NEW token (the reported case)');
  moved = await rq.resolveMovedToken(first.id);
  ok(moved && moved.live && moved.live.id === second.id, 'old token resolves to the live request');

  ok((await rq.resolveMovedToken('neverSeenToken')) === null, 'unknown token -> null (plain 404 kept)');

  // alias cleanup after retention
  await rq.pruneEnded(Date.now() + 8 * 86_400_000);
  ok((await rq.resolveMovedToken(first.id)) === null, 'alias removed after the retention window');

  console.log(`\n${pass} checks passed`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
