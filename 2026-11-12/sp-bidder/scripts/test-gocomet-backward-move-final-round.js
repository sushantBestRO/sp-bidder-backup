'use strict';
/**
 * A GoComet round the tracker has made FINAL is decided as a final round even when fewer rounds than the
 * cap have run (round-tracker spec s1.6: FINAL routes _decideProvisional to its final branch).
 *
 *   1  the close moves 300 s earlier in round 0 of 3 (backward_move): outranked with two attempts left,
 *      the floor goes at the new close's buzzer.
 *   2  control: the same load with no backward move stays pre-final, one middle price and no floor.
 *
 *   node scripts/test-gocomet-backward-move-final-round.js
 */
const assert = require('assert');
const H = require('./lib/round-tracker-harness');

const P = Date.now() + 3_600_000;
const floorOf = (load) => load.ladder[load.ladder.length - 1];
let n = 0;

async function gcLoad() {
  const load = await H.openLoad({ portal: 'gc', id: `GC-BACK-${n++}`, posted: P, armAt: P - 900_000,
    seed: { fired: [0], revisionsLeft: 2 } });
  load.eng.adapter.closeProbe = async () => null;
  await H.read(load, { at: P - 600_000, close: P, rank: 1, attempts: 2 });
  return load;
}

async function approach(load, close) {
  const bids = [];
  for (const d of [12_000, 10_500, 5_000]) bids.push(...await H.read(load, { at: close - d, close, rank: 2, attempts: 2 }));
  return bids;
}

(async () => {
  const { check, done } = H.runner('GoComet backward move makes the round final', 2);

  await check('1 GoComet: the close moves 300 s earlier in round 0 of 3 -> FINAL backward_move, floor at the new buzzer', 'red', async () => {
    const load = await gcLoad();
    const back = P - 300_000;
    await H.read(load, { at: P - 500_000, close: back, rank: 1, attempts: 2 });
    const v = H.verdictOf(load);
    assert.ok(v.verdict === 'FINAL' && v.reason === 'backward_move',
      `fixture: expected FINAL backward_move after the close moved earlier, got ${v.verdict} (${v.reason})`);
    const bids = await approach(load, back);
    assert.ok(bids.some((b) => b.price === floorOf(load) && back - b.at <= 6_500),
      `the round is final at the new close, but outranked at its buzzer the floor did not go (sent ${H.fmtBids(load, bids)})`);
  });

  await check('2 control GoComet: no backward move -> pre-final, one middle price, no floor', 'positive', async () => {
    const load = await gcLoad();
    const bids = await approach(load, P);
    assert.ok(bids.length === 1 && bids[0].price !== floorOf(load),
      `a pre-final round takes one middle price and keeps the floor, sent ${H.fmtBids(load, bids)}`);
  });

  done();
})();
