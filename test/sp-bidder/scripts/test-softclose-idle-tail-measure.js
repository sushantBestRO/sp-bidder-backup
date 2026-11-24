'use strict';
/**
 * Pins the soft-close idle-tail measurement (scripts/measure-softclose-idle-tail.js).
 *
 * This test exists because the FIRST version of this measurement was ad-hoc and its predicate
 * was never recorded, so its published outputs (64 loads / Rs 1,83,266) can no longer be
 * reproduced from the same data. The arithmetic is now pinned here. If someone "tidies" the
 * tail computation - most plausibly by dropping rejectedBids, which reads like a bug fix and is
 * not - the number silently moves and every comparison against the baseline becomes meaningless.
 *
 * Deterministic and offline: synthetic fixtures only, no clock, no file, no network.
 */

const {
  writeTimes, idleTailS, floorOffered, headroom, qualifies, median, summarize, IDLE_TAIL_GATE_S,
} = require('./measure-softclose-idle-tail');

const EXPECTED_CHECKS = 25;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const T = 1_700_000_000_000; // fixed epoch; nothing here reads the clock
const bid = (tsOffsetS, price) => ({ ts: T + tsOffsetS * 1000, price });

// A soft load that went silent: last LANDED bid 300s before close, floor never offered, lost.
const silentSoft = {
  auctionId: 'soft-silent', shipper: 'Havells India Ltd.', closeModel: 'soft',
  floor: 100000, lastBidPrice: 104000, won: false, closedAt: T + 600 * 1000,
  ourBids: [bid(100, 110000), bid(300, 104000)],
};

// Same load, but the engine kept TRYING and was refused at 580s. Tail is 20s, not 300s.
const refusedSoft = {
  ...silentSoft,
  auctionId: 'soft-refused',
  rejectedBids: [{ ts: T + 580 * 1000, price: 100000, reason: 'Amount is invalid' }],
};

// A hard load behaving correctly: bidding right up to the close.
const goodHard = {
  auctionId: 'hard-ok', shipper: 'KEI Industries Ltd', closeModel: 'hard',
  floor: 90000, lastBidPrice: 90000, won: false, closedAt: T + 600 * 1000,
  ourBids: [bid(560, 95000), bid(598, 90000)],
};

// A soft load that WON - silence after taking the lead is correct, not a defect.
const wonSoft = { ...silentSoft, auctionId: 'soft-won', won: true };

// A soft load where the floor DID reach the board - also not the defect.
const flooredSoft = {
  ...silentSoft, auctionId: 'soft-floored',
  ourBids: [bid(100, 110000), bid(300, 100000)], lastBidPrice: 100000,
};

// ---- 1. the tail measure counts REJECTED attempts. This is the whole ballgame. ----
ok(idleTailS(silentSoft) === 300, `silent soft tail should be 300s, got ${idleTailS(silentSoft)}`);
ok(idleTailS(refusedSoft) === 20,
  `a refused attempt at 580s must SHORTEN the tail to 20s (got ${idleTailS(refusedSoft)}) - `
  + 'dropping rejectedBids would report 300s and silently inflate every soft number');
ok(writeTimes(refusedSoft).length === 3, 'writeTimes unions ourBids and rejectedBids');
ok(writeTimes({}).length === 0, 'a doc with no bids has no write times');
ok(idleTailS({ closedAt: T }) === null, 'no writes -> null tail, not 0 (0 would read as perfect)');
ok(idleTailS({ ourBids: [bid(1, 1)] }) === null, 'no closedAt -> null tail');
ok(idleTailS({ ourBids: [{ ts: NaN, price: 1 }], closedAt: T }) === null, 'a NaN ts is not a write');

// ---- 2. hard and soft do not overlap - the discriminator the fix is judged on ----
ok(idleTailS(goodHard) === 2, `hard load tail should be 2s, got ${idleTailS(goodHard)}`);
ok(idleTailS(goodHard) < 30 && idleTailS(silentSoft) > 60,
  'the fixture reproduces the real separation: hard under 30s, soft over 60s');

// ---- 3. floorOffered ----
ok(floorOffered(silentSoft) === false, 'floor never offered when the best bid stays above it');
ok(floorOffered(flooredSoft) === true, 'floor offered when a landed bid reaches it');
ok(floorOffered({ ourBids: [], floor: 1 }) === null, 'no landed bids -> unanswerable, not false');
ok(floorOffered({ ourBids: [bid(1, 5)] }) === null, 'no floor recorded -> unanswerable, not false');

// ---- 4. Q predicate: the defect, and the three things that are NOT the defect ----
ok(qualifies(silentSoft) === true, 'the silent-soft shape qualifies');
ok(qualifies(wonSoft) === false, 'winning is not the defect');
ok(qualifies(flooredSoft) === false, 'offering the floor is not the defect');
ok(qualifies(goodHard) === false, 'a hard load bidding to the close is not the defect');
ok(qualifies(refusedSoft) === false,
  'a 20s tail is under the gate - the engine was trying, which is the opposite of silence');
ok(qualifies({ ...silentSoft, ourBids: [] }) === false, 'never landing a bid is a different population');
ok(IDLE_TAIL_GATE_S === 60, 'the gate is 60s - 2x the 29s ceiling hard-close loads never exceed');

// ---- 5. headroom + median ----
ok(headroom(silentSoft) === 4000, `headroom should be 4000, got ${headroom(silentSoft)}`);
ok(headroom({ lastBidPrice: null, floor: 1 }) === 0, 'missing lastBidPrice -> 0, never NaN');
ok(median([3, 1, 2]) === 2 && median([4, 1, 2, 3]) === 2.5, 'median handles odd and even lengths');

// ---- 6. summarize aggregates over a mixed corpus ----
{
  const s = summarize([silentSoft, refusedSoft, goodHard, wonSoft, flooredSoft]);
  ok(s.soft.n === 4 && s.hard.n === 1, `soft/hard split wrong: ${s.soft.n}/${s.hard.n}`);
  ok(s.q.n === 1 && s.q.money === 4000 && s.q.byShipper['Havells India Ltd.'] === 1,
    `Q should be the one silent Havells load worth 4000, got n=${s.q.n} money=${s.q.money}`);
}

if (pass + fail !== EXPECTED_CHECKS) {
  console.error(`\nINCOMPLETE RUN: ${pass + fail} checks ran, expected ${EXPECTED_CHECKS}`);
  process.exit(1);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
