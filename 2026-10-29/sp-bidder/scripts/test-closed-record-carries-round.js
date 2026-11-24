'use strict';
/**
 * The closed-bid record carries the round the tracker believed at the close (ruling 56 (f), ruling 57:
 * "verdict and reason ride the closed record").
 *
 * The engine's auction_result has carried `round` (rounds, cap, verdict, reason) since piece A, but
 * bidLogger copied only the result facts it names, so the durable record - what exports and the
 * history read - never held it.
 *
 *   1  SuperProcure: three on-grid rounds of a cap of 3, then the close -> the record holds
 *      { rounds 3, cap 3, verdict FINAL, reason cap_reached }.
 *
 * Real engine through _tick on the harness's virtual clock (lib/round-tracker-harness.js); its events,
 * in order, go through a real BidLogger over a MemoryStore.
 *
 *   node scripts/test-closed-record-carries-round.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');
const { BidLogger, COLLECTION } = require('../src/logging/bidLogger');
const { MemoryStore } = require('../src/store');

const INC = 120_000;
const P = Date.now() + 3_600_000;

(async () => {
  const { check, done } = H.runner('The closed record carries the round (ruling 56 (f))', 1);

  await check('1 SP: three rounds of 3, then the close -> the closed record holds the round', 'red', async () => {
    const load = await H.openLoad({ portal: 'sp', id: 'RTB-REC-1', posted: P, armAt: P - 900_000,
      frame: { extendMs: INC, cap: 3, window: 100_000 }, seed: { fired: [0], revisionsLeft: 8 } });
    await H.read(load, { at: P - 300_000, close: P, rank: 1 });
    for (let i = 1; i <= 3; i++) await H.read(load, { at: P + (i - 1) * INC - 30_000, close: P + i * INC, rank: 1 });
    const close = P + 3 * INC;
    for (const d of [-2_000, 500, 4_000, INC + 5_000]) await H.read(load, { at: close + d, close, rank: 1 });
    const result = load.events.find((e) => e.type === 'auction_result');
    if (!result) throw new Error('HARNESS: the load never finalized');
    const logger = new BidLogger({ store: new MemoryStore() });
    for (const e of load.events) await logger.handle(e);
    const rec = await logger.store.getDoc(COLLECTION, 'RTB-REC-1');
    assert.ok(rec && rec.status === 'closed', `HARNESS: no closed record (${rec && rec.status})`);
    assert.deepStrictEqual(rec.round, { rounds: 3, cap: 3, verdict: 'FINAL', reason: 'cap_reached' },
      `the closed record's round is ${JSON.stringify(rec.round)}; the engine's auction_result carried `
      + `${JSON.stringify(result.round)} and bidLogger dropped it`);
  });

  done();
})().catch((e) => { console.error(`\nFAIL - harness threw: ${(e && e.stack) || e}`); process.exitCode = 1; });
