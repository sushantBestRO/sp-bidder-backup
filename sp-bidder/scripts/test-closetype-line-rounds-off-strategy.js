'use strict';
/**
 * Pins the messages-half review's blocking finding (26 Sep): the close-type line printed
 * "Auto extension - extended 0x" on an SP soft load whose soft strategy is 'off' - which is MOST
 * of them - whatever the auction actually did.
 *
 * The mechanism: bidEngine.js's mirrorRound only copies the round tracker's real count
 * (monitor._round.rounds) onto the LIVE-decision mirror monitor.extendsObserved when
 * `provisionalClose || softStrategy !== 'off'` (ruling 56 (a) - the mirror is deliberately scoped
 * off so the bidding strategy never acts on rounds it isn't tracking FOR). roundVerdict() then
 * built the closed record off `Number(monitor.extendsObserved) || 0` - always 0 for an off-strategy
 * SP load - even though the round TRACKER ITSELF keeps counting real extensions the whole time
 * (ruling 56 (d): "softStrategy 'off' SuperProcure loads are tracked for the closed record only").
 * _roundRecord now reads monitor._round.rounds directly, never the extendsObserved mirror, so the
 * closed record and the live-decision mirror can no longer disagree about a fact only one of them
 * was ever kept for.
 *
 * @requires-summary-line
 *   node scripts/test-closetype-line-rounds-off-strategy.js
 */
const assert = require('assert');
const { BidEngine, DEFAULTS } = require('../src/engine/bidEngine');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const proto = BidEngine.prototype;

// Same double as test-part1-part2-seam.js's predicates(): exercises the DEPLOYED predicate code
// against a bare `this`, not a re-implementation of it.
function predicates(cfg = {}) {
  return {
    cfg: Object.assign({ floorWindowMs: DEFAULTS.floorWindowMs, finalizeDebounceMs: DEFAULTS.finalizeDebounceMs }, cfg),
    emit: () => {},
    _observeExtension: proto._observeExtension,
    _persistRound: proto._persistRound,
    roundVerdict: proto.roundVerdict,
    _roundRecord: proto._roundRecord,
    _provisionalCap: proto._provisionalCap,
    _finalAfterExtensions: proto._finalAfterExtensions,
    _clearSubmissionClosedOnForwardMove: proto._clearSubmissionClosedOnForwardMove,
    scheduler: { get: () => null, update: () => null },
    log: { warn: () => {}, info: () => {} },
  };
}

// An ordinary SP soft-close load, softStrategy 'off' - the shape MOST live SP soft loads carry
// (soft-close defend is opt-in per shipper; most are not enrolled).
function spSoftOffMonitor(over = {}) {
  return Object.assign({
    auctionId: 'SP-1', closeModel: 'soft', softStrategy: 'off', provisionalClose: false,
    extendCap: null, extendsObserved: 0, triggerWindowMs: null,
    believedCloseAt: null, finalized: false, _zeroSince: null, _zeroRunExtendAt: null,
    meta: { lane: { origin: 'Bhiwandi', destination: 'Hosur' }, companyName: 'Havells' },
  }, over);
}

(async () => {
  // ---- a soft-off load that genuinely extended 3 times: the closed record must say 3, never 0 ----
  {
    const p = predicates();
    const T0 = Date.now() + 600_000;
    const m = spSoftOffMonitor({ believedCloseAt: T0 });
    let closesAtMs = T0;
    for (let i = 0; i < 3; i++) {
      closesAtMs += 300_000;
      p._observeExtension(m, { closesAtMs, closesInMs: 60_000, extendMs: 300_000, extendCount: null });
    }
    ok(m.extendsObserved === 0,
      `fixture: extendsObserved (the LIVE-decision mirror) stays 0 for a soft-off SP load, unrelated to this fix - got ${m.extendsObserved}`);
    ok(!!m._round && m._round.rounds >= 3,
      `fixture: the round tracker itself counted the real extensions - got ${m._round && m._round.rounds}`);
    const record = p._roundRecord(m);
    ok(record.rounds === m._round.rounds,
      `FIX: the closed record's rounds count comes from the tracker (${m._round.rounds}), not the extendsObserved mirror - got ${record.rounds}`);
    ok(record.rounds !== 0,
      `the closed record must never claim zero extensions when the tracker counted real ones - got ${record.rounds}`);
  }

  // ---- control: a soft-off load that genuinely never extended still (correctly) reports 0 ----
  {
    const p = predicates();
    const m = spSoftOffMonitor({ believedCloseAt: Date.now() + 600_000 });
    // Touch the tracker once with no forward close move at all, so _round exists but never counted.
    p._observeExtension(m, { closesAtMs: m.believedCloseAt, closesInMs: 600_000, extendMs: 300_000, extendCount: null });
    const record = p._roundRecord(m);
    ok(record.rounds === 0, `control: a load that never extended still reports a real 0 (not unknown) - got ${record.rounds}`);
  }

  // ---- defensive: a monitor with no round tracker at all reports UNKNOWN (null), never a fabricated 0 ----
  {
    const p = predicates();
    const m = spSoftOffMonitor({ believedCloseAt: null });
    delete m._round;
    const record = p._roundRecord(m);
    ok(record.rounds === null,
      `defensive: no round tracker at all reports rounds:null (unknown), never a fabricated 0 - got ${record.rounds}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (!fail) console.log(`${pass}/${pass} checks passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
