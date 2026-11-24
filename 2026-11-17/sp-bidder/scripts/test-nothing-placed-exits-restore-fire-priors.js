'use strict';
/**
 * EVERY EXIT WHERE NOTHING WAS PLACED GIVES BACK WHAT THE FIRE POINT ADVANCED, THE BUZZER LATCH INCLUDED.
 *
 * Regression target: PR-2 integration defect S1 (W1-8 x T4). The fire point advances the buzzer
 * latch (_shotRoundId since the round tracker, ruling 56) optimistically for a pre-cap buzzer shot. W1-8's placed:false arm (a throw raised
 * before the write left the box) restores the ladder and both endgame latches but not the buzzer
 * latch, so after a pre-wire refusal _softPreCapBuzzerShot reads "this round's buzzer shot went" and
 * holds: the next buzzer in the same round never fires.
 *
 * Check 1 walks every nothing-placed exit against _captureFirePriors' OWN key list, read at run time,
 * so a fact added to the capture later is required on every exit by default. The only facts an exit
 * may leave spent are the ones its site documents (the attempt and throttle facts on the non-auth
 * sites, the throttle facts on the grace band); every other captured fact must come back.
 * Check 2 is the money consequence. Check 3 is the fail-closed control: a write whose outcome is
 * uncertain keeps the latch and is not re-fired in the same round.
 *
 *   node scripts/test-nothing-placed-exits-restore-fire-priors.js
 */
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 3;
let ran = 0;
const failures = [];

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `np-exits-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };

const REAL_NOW = Date.now;
let CLOCK = 1_770_000_000_000;
Date.now = () => CLOCK;

process.on('exit', () => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (ran !== EXPECTED_CHECKS) {
    console.error(`\nCOMPLETION SENTINEL FAILED: ran ${ran} checks, expected ${EXPECTED_CHECKS}`);
    process.exitCode = 1;
  }
});

const LADDER = [60_000, 58_000, 56_000, 54_000];
const BUZZER_RUNG = 2;
const REVISIONS = 30;

const prewire = (code) => () => { const e = new Error(`bid stopped before the write: ${code}`); e.code = code; e.placed = false; throw e; };
const networkThrow = () => { const e = new Error('bid_network_error'); e.code = 'NETWORK'; throw e; };
const OUTCOMES = {
  accept: () => ({ accepted: true, myRank: 1, revisionsLeft: null, latencyMs: 20 }),
  auth401: () => ({ accepted: false, status: 401, myRank: null, revisionsLeft: null, bidVehicleCount: null,
    amountPMT: null, bidRate: null, bidQuantity: null, reason: 'session_logged_out', carrierSent: 2667,
    text: 'Token is invalid.', latencyMs: 12, raw: 'Token is invalid.' }),
  grace401: () => OUTCOMES.auth401(),
  throwAuth: () => { const e = new Error('token_expired'); e.code = 'AUTH'; throw e; },
  rate429: () => ({ accepted: false, status: 429, myRank: null, revisionsLeft: null, reason: 'rate_limited',
    retryAfterMs: 500, latencyMs: 5, raw: null, carrierSent: 2667, text: null }),
  prewireRateLimited: prewire('RATE_LIMITED'),
  prewireNetwork: prewire('NETWORK'),
  prewireStandDown: prewire('WRITE_DISABLED'),
  costTypeUnmatched: prewire('COST_TYPE_UNMATCHED'),
  networkDisproved: networkThrow,
  networkUncertain: networkThrow,
};

const ATTEMPT_FACTS = ['ownBidAttempts', 'everBid', 'lastFireAt'];
const EXITS = [
  { kind: 'auth401', mayStaySpent: [] },
  { kind: 'throwAuth', mayStaySpent: [] },
  { kind: 'grace401', mayStaySpent: ['lastFireAt', 'bidTimesLength'] },
  { kind: 'rate429', mayStaySpent: ATTEMPT_FACTS },
  { kind: 'prewireRateLimited', mayStaySpent: ATTEMPT_FACTS },
  { kind: 'prewireNetwork', mayStaySpent: [...ATTEMPT_FACTS, 'bidTimesLength'] },
  { kind: 'prewireStandDown', mayStaySpent: [...ATTEMPT_FACTS, 'bidTimesLength'] },
  { kind: 'costTypeUnmatched', mayStaySpent: [...ATTEMPT_FACTS, 'bidTimesLength'] },
  { kind: 'networkDisproved', mayStaySpent: [...ATTEMPT_FACTS, 'bidTimesLength'] },
];

function rig({ grace = false } = {}) {
  const wire = [];
  const adapter = {
    next: 'accept',
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false,
      revisionLimit: null, closeModel: 'unknown', biddingEnabled: true, platformLabel: 'Scripted',
      partialVehicleCountSupported: true }),
    ensureSession: async () => ({}),
    getAuctionState: async () => (adapter.next === 'networkDisproved'
      ? { ok: true, myRank: 2, revisionsLeft: REVISIONS }
      : { ok: false }),
    placeBid: async (_id, price) => {
      wire.push({ price, kind: adapter.next });
      return OUTCOMES[adapter.next]();
    },
  };
  if (grace) {
    Object.assign(adapter, { isAuthDead: () => false, authWriteHeld: () => false,
      authTokenGrace: () => adapter.next === 'grace401' });
  }
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, mode: 'live', shippers: ['Havells'] },
    onEvent: () => {},
  });
  const m = eng.arm({ id: `NP${seq}`, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
    equipment: '32ft', companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 },
  { cost: 50_000, marginsPct: [20, 16, 12, 8] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  // Outranked at the buzzer of a round before the cap, two middle prices on the board.
  m.ladder = LADDER.slice();
  m.floor = LADDER[LADDER.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 1;
  m.triggerWindowMs = 100_000;
  m.revisionsLeft = REVISIONS;
  for (const i of [0, 1]) m.firedRungs.add(i);
  m.currentRungIndex = 1;
  m.lastBidPrice = LADDER[1];
  m.landedBids = 2;
  m.ownBidAttempts = 2;
  m.everBid = true;
  m.snipeFired = false;
  m._lastDefendAtExtend = m.extendsObserved;
  const roundCloseAt = Date.now() + 1_200;
  return { eng, m, wire, adapter, roundCloseAt };
}

async function tick(r, kind) {
  r.adapter.next = kind;
  const before = r.wire.length;
  const remaining = r.roundCloseAt - Date.now();
  await r.eng._maybeBid(r.m, { closesInMs: remaining, closesAtMs: r.roundCloseAt, myRank: 2, minDecrement: 100,
    standingL1Price: null, measuredRttMs: 50, revisionsLeft: null, revisionLimit: null, closeModel: 'soft' });
  CLOCK += 300;
  return r.wire.slice(before);
}

async function check(n, name, fn) {
  try {
    await fn();
    console.log(`  ok  ${n}. ${name}`);
  } catch (e) {
    failures.push(n);
    console.error(`  FAIL ${n}. ${name}: ${e && e.message ? e.message : e}`);
  } finally {
    ran += 1;
  }
}

(async () => {
  await check(1, 'every nothing-placed exit restores every fact _captureFirePriors captures, bar the ones its site leaves spent', async () => {
    const leaks = [];
    for (const { kind, mayStaySpent } of EXITS) {
      const r = rig({ grace: kind === 'grace401' });
      const priors = r.eng._captureFirePriors(r.m);
      const sent = await tick(r, kind);
      assert.deepStrictEqual(sent.map((w) => w.price), [LADDER[BUZZER_RUNG]],
        `FIXTURE (${kind}): the pre-cap buzzer shot at the next middle price did not reach the wire`);
      const after = r.eng._captureFirePriors(r.m);
      for (const key of Object.keys(priors)) {
        if (mayStaySpent.includes(key)) continue;
        try { assert.deepStrictEqual(after[key], priors[key]); } catch (_) {
          leaks.push(`${kind}: ${key} ${JSON.stringify(priors[key])} -> ${JSON.stringify(after[key])}`);
        }
      }
    }
    assert.deepStrictEqual(leaks, [],
      `nothing-placed exits left fire-point facts advanced (${leaks.join('; ')}) - the placed:false arm`
      + ' does not give back _shotRoundId, so this round\'s buzzer shot reads as already sent');
  });

  await check(2, 'after a pre-wire refusal of the buzzer shot, the next tick in the same round still sends it', async () => {
    const r = rig();
    const refused = await tick(r, 'prewireRateLimited');
    assert.deepStrictEqual(refused.map((w) => w.price), [LADDER[BUZZER_RUNG]],
      'FIXTURE: the pre-cap buzzer shot did not reach the placeBid seam');
    const retried = await tick(r, 'accept');
    assert.deepStrictEqual(retried.map((w) => w.price), [LADDER[BUZZER_RUNG]],
      `wire sends on the next tick of the same round: [${retried.map((w) => w.price)}], expected`
      + ` [${LADDER[BUZZER_RUNG]}] - a bid refused before it left the box left _shotRoundId at`
      + ` ${r.m._shotRoundId} (round ${r.eng.roundVerdict(r.m).roundId}), so the buzzer shot was held as already sent`);
  });

  await check(3, 'CONTROL: an accepted or uncertain buzzer shot keeps the latch and is not re-sent in the same round', async () => {
    for (const kind of ['accept', 'networkUncertain']) {
      const r = rig();
      const first = await tick(r, kind);
      assert.deepStrictEqual(first.map((w) => w.price), [LADDER[BUZZER_RUNG]],
        `FIXTURE (${kind}): the pre-cap buzzer shot did not reach the wire`);
      // named re-pin: round tracker, ruling 56 - T4's close-time latch is now the round's roundId.
      assert.strictEqual(r.m._shotRoundId, r.eng.roundVerdict(r.m).roundId,
        `${kind}: the buzzer latch was not left on this round's roundId`);
      const next = await tick(r, 'accept');
      assert.deepStrictEqual(next, [], `${kind}: a second buzzer shot went in the same round: ${JSON.stringify(next)}`);
    }
  });

  if (failures.length) {
    console.error(`\n${failures.length} of ${EXPECTED_CHECKS} checks FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${EXPECTED_CHECKS} checks`);
  process.exit(0);
})().catch((e) => {
  console.error('\nUNEXPECTED ERROR: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
