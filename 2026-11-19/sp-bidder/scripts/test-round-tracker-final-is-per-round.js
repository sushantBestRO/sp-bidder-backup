'use strict';
/**
 * A FINAL verdict belongs to the round it was reached in, not to the rounds after it.
 *
 * A close that moves earlier makes the round in progress final. If a rival then extends the auction,
 * the new round is judged on its own: below the cap it is NOT_FINAL. Carrying the earlier FINAL into
 * it would send the floor a round early. Nothing pinned the round match (PR-2 mutation critique).
 *
 *   node scripts/test-round-tracker-final-is-per-round.js
 */
const assert = require('assert');
const rt = require('../src/engine/roundTracker');

const INC = 180_000;
const W = 180_000;
let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

const now0 = 1_790_000_000_000;
const P = now0 + 60_000;
const t = rt.createTracker({ platform: 'sp', closeModel: 'soft', softStrategy: 'live', postedCloseAt: P, closeAt: P, nowMs: now0 });
const read = (closeAt, now) => rt.observe(t, { closeAt, closesInMs: closeAt - now, extendMs: INC, triggerWindowMs: W,
  extendCount: 3, closeModel: 'soft' }, now);

read(P, now0);
const earlier = P - INC;
read(earlier, now0 + 1_000);
const v1 = rt.verdict(t, now0 + 1_000);
assert.strictEqual(v1.verdict, 'FINAL', `setup: a close moved earlier should make the round final, got ${JSON.stringify(v1)}`);
ok(1, 'a close moved earlier makes the round in progress final');

const later = earlier + INC;
const r = read(later, now0 + 2_000);
assert.strictEqual(r.counted, 1, `setup: the forward move was not counted as a round: ${JSON.stringify(r)}`);
const v2 = rt.verdict(t, now0 + 2_000);
assert.notStrictEqual(v2.roundId, v1.roundId, 'setup: the new round kept the old round id');
assert.strictEqual(v2.verdict, 'NOT_FINAL', `the round after a final one, below the cap, read ${v2.verdict} (${v2.reason})`);
ok(2, 'the next round, below the cap, is judged on its own: NOT_FINAL');

console.log(`\n${pass}/2 checks passed`);
