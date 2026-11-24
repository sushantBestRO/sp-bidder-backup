'use strict';
/**
 * A GoComet load's believed close must follow the closes the portal publishes.
 *
 * Regression target: T7 E3 = BH-LOGIC-1 + BH-LOGIC-2 (bug hunt 2026-09-16), plus finding R6 of the
 * 2026-09-24 timing diagnosis. One defect, several symptoms.
 *
 * THE DEFECT. _observeExtension opens with
 *   if (monitor.softStrategy === 'off' || monitor.closeModel !== 'soft') return false;
 * and that guard sits above every believedCloseAt writer and above _persistBelievedClose. The
 * gocomet adapter reports closeModel 'soft' for every enquiry and only allowlisted shippers get a
 * soft strategy other than 'off', so for the whole GoComet population the believed close stays at
 * the arm-time close however many 299s rounds the portal publishes. Everything that reads it is
 * wrong on an extended load:
 *   - _unreadablePastBound measures age past that frozen close, so a load that has extended more
 *     than unreadableRetireMs (2h) past its posted close is retired as unknown - permanently - on
 *     ONE failed read while the auction is still running (checks 2, 3).
 *   - the /track "first bid by" mark (snapshot().firstBidByMs) stays at the posted close (check 5).
 *   - auction_result.finalCloseAt (check 6), the durable intent's closesAt (check 7, restart
 *     survival) and the closed_while_down closesAt that dates the ledger row (check 8) all carry the
 *     posted close instead of the last published one.
 *
 * REPAIR SHAPES. (a) let the belief track for 'off' loads; (b) keep a separate last-successfully-read
 * close for the bound and the /track mark. Checks 2, 3 and 5 assert only observable consequences and
 * hold for either shape (check 5's second half holds under (b) only if that last-read close is also
 * forward-only). Checks 6, 7 and 8 ASSUME SHAPE (a): under a literal (b) they stay red unless
 * (b) also routes those recorded closes through its last-read close, and their failure text says so.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too):
 *   1. the allowlisted control: the same career on a 'live' load survives one failed read. If this
 *      fails the harness is dead and no other result in this file means anything.
 *   4. a load whose LAST PUBLISHED close is itself 15 minutes past the bound is still retired on a
 *      failed read. With checks 2/3 placed ~105 minutes past the bound on the posted close, any
 *      slack large enough to turn 2/3 green without tracking the close turns this red.
 *   5 (second half). a lagging frame and a small backward wobble after the extensions leave the
 *      /track mark where it is: the belief is forward-only.
 *
 * FRAMES. Date.now is stubbed and walked through each extension career: every round's frame is
 * observed at the instant the previous close extended, so closesInMs = closesAtMs - now always,
 * exactly as the adapter derives it, and ~299s remain on the countdown - above every establish or
 * bid mark, which the placeBid counter confirms stays at 0. One frame per career spans TWO rounds (a
 * skipped poll), so a reconstruction from posted close + rounds counted x increment lands a round
 * short. Frames carry extendCount null, as GoComet publishes it. Frames reach the engine through
 * _tick via the fake adapter, the path production takes.
 *
 * Check 6 calls _finalize directly: a soft close only finalizes after a sustained zero countdown of
 * extendMs + debounce, and the first zero tick reaches the bid path, which this file forbids.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * clock, no network, no sleeps; the one per-monitor jitter cancels out of the check-5 difference.
 *
 *   node scripts/test-gocomet-frozen-close-belief.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine, DEFAULTS } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');

const EXPECTED_CHECKS = 8;
const EXTEND_MS = 299_000;
const BOUND = DEFAULTS.unreadableRetireMs;
const LIVE_CAUSE = "live-auction reads (retire bound, /track mark) measure against a believed close "
  + "frozen at the arm-time close for softStrategy 'off'";
const RECORD_CAUSE = "recorded closes (result finalCloseAt, durable closesAt, closedWhileDown closesAt) "
  + "do not follow the last published close for softStrategy 'off' (shape-(a) checks)";

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
let seq = 0;
const tmp = () => {
  const f = path.join(os.tmpdir(), `gc-frozen-close-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
let bidAttempts = 0;

function rig() {
  const ctrl = { dark: false, frame: null };
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
      revisionLimit: 3, closeModel: 'soft', reactiveClose: true, snipeBudgetMs: 3000 }),
    async getAuctionState() {
      if (ctrl.dark) return { ok: false, error: 'portal dark' };
      return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' };
    },
    async placeBid() { bidAttempts += 1; return { accepted: false, error: 'offline test adapter' }; },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Allowlisted'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: quiet,
  });
  const arm = (id, companyName, closesAt, strategy) => {
    vnow = closesAt - 600_000;
    const m = eng.arm({
      id, lane: { origin: 'Bhiwandi', destination: 'Hosur' }, equipment: '32ft SXL', units: 1,
      quoteType: 'FTL', companyName, closesAt, platformKey: 'gocomet',
      rules: { revisionLimit: 3, minDecrement: 500 },
    }, { cost: 70_000, marginsPct: [12.6, 7.2, 6.3] });
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    if (m.softStrategy !== strategy) {
      throw new Error(`HARNESS: '${companyName}' resolved softStrategy '${m.softStrategy}', expected '${strategy}'`);
    }
    return m;
  };
  const tick = async (m) => {
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const frame = (closesAtMs) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs,
    closesInMs: closesAtMs - Date.now(), extendMs: EXTEND_MS, extendCount: null,
    myRank: null, totalBidders: null, standingL1Price: null, measuredRttMs: 20 });
  // steps[i] = rounds the close advanced between two observed frames; a 2 is a skipped poll.
  const career = async (m, posted, steps) => {
    let close = posted;
    for (const s of steps) {
      vnow = close;
      close += s * EXTEND_MS;
      ctrl.frame = frame(close);
      await tick(m);
    }
    return close;
  };
  const retiredIds = () => events.filter((e) => e.kind === 'unreadable_past_close_retired').map((e) => e.auctionId);
  const done = () => { try { eng.kill(); } catch (_) {} };
  return { eng, ctrl, events, arm, tick, frame, career, retiredIds, done };
}

// 46 rounds, one poll skipped. With the failed read 250s before the live close, the POSTED close is
// 13,504,000 ms behind: past BOUND + 20 rounds, so only a tracked close keeps the load.
const LONG_CAREER = [...Array(20).fill(1), 2, ...Array(24).fill(1)];
const SHORT_CAREER = [1, 2];

const results = [];
async function check(n, name, kind, fn) {
  let failure = null;
  try {
    failure = await fn();
  } catch (e) {
    failure = `threw: ${e && e.stack ? e.stack : e}`;
  }
  results.push({ n, name, kind, failure });
  console.log(`  ${failure ? 'FAIL' : 'PASS'}  ${n}. ${name}${kind.startsWith('mechanism') ? '' : ` [${kind}]`}`
    + (kind.endsWith('(a)') ? ' [assumes shape (a)]' : ''));
  if (failure) console.log(`        ${failure}`);
}

async function main() {
  await check(1, 'control_allowlisted_survives', 'control', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW();
      const m = r.arm('GC-CTL', 'Allowlisted Shipper', posted, 'live');
      const live = await r.career(m, posted, LONG_CAREER);
      vnow = live - 250_000;
      r.ctrl.dark = true;
      await r.tick(m);
      if (m.finalized !== false) {
        return 'HARNESS DEAD: the allowlisted load, whose belief does track, was retired on one failed read '
          + `(live close ${live - Date.now()} ms ahead) - the frames are not reaching the engine as extensions`;
      }
      return null;
    } finally { r.done(); }
  });

  await check(2, 'live_extended_off_load_survives_one_failed_read', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW();
      const m = r.arm('GC-OFF-LIVE', 'Unlisted Shipper', posted, 'off');
      const live = await r.career(m, posted, LONG_CAREER);
      vnow = live - 250_000;
      r.ctrl.dark = true;
      await r.tick(m);
      const intent = r.eng.scheduler.get('GC-OFF-LIVE');
      const bad = [];
      if (m.finalized !== false) bad.push(`finalized=${m.finalized}`);
      if (r.retiredIds().includes('GC-OFF-LIVE')) bad.push('unreadable_past_close_retired emitted');
      if (!intent || intent.status === 'closed' || intent.closedWhileDown === true) {
        bad.push(`durable intent closed (status=${intent && intent.status}, closedWhileDown=${intent && intent.closedWhileDown})`);
      }
      if (!bad.length) return null;
      return `live load (46 published 299s rounds, live close ${live - Date.now()} ms in the FUTURE, posted close `
        + `${Date.now() - posted} ms past) retired as unknown on ONE failed read: ${bad.join('; ')} - ${LIVE_CAUSE}`;
    } finally { r.done(); }
  });

  await check(3, 'transient_blip_then_recovery_keeps_monitor', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW();
      const m = r.arm('GC-OFF-BLIP', 'Unlisted Shipper', posted, 'off');
      const live = await r.career(m, posted, LONG_CAREER);
      vnow = live - 250_000;
      r.ctrl.dark = true;
      await r.tick(m);
      vnow = live - 240_000;
      r.ctrl.dark = false;
      r.ctrl.frame = r.frame(live);
      await r.tick(m);
      const intent = r.eng.scheduler.get('GC-OFF-BLIP');
      const row = r.eng.snapshot().find((s) => s.auctionId === 'GC-OFF-BLIP');
      const bad = [];
      if (m.finalized !== false) bad.push(`finalized=${m.finalized}`);
      if (!intent || intent.status !== 'armed') bad.push(`intent status '${intent && intent.status}', expected 'armed'`);
      if (!row || row.finalized !== false) bad.push('not watched in snapshot()');
      if (r.retiredIds().includes('GC-OFF-BLIP')) bad.push('retire alert emitted to the desk');
      if (!bad.length) return null;
      return 'one transient failed read then the portal answering again with the live close '
        + `(${live - Date.now()} ms ahead) did not leave the load watched: ${bad.join('; ')} - ${LIVE_CAUSE}`;
    } finally { r.done(); }
  });

  const deadLoad = async (r, id) => {
    const posted = REAL_NOW();
    const m = r.arm(id, 'Unlisted Shipper', posted, 'off');
    const live = await r.career(m, posted, SHORT_CAREER);
    vnow = live + BOUND + 900_000;
    r.ctrl.dark = true;
    await r.tick(m);
    return { m, posted, live };
  };

  await check(4, 'genuinely_dead_load_still_retires', 'positive pin', async () => {
    const r = rig();
    try {
      const { m, live } = await deadLoad(r, 'GC-OFF-DEAD');
      const bad = [];
      if (m.finalized !== true) bad.push(`finalized=${m.finalized}`);
      if (!r.retiredIds().includes('GC-OFF-DEAD')) bad.push('no unreadable_past_close_retired');
      if (!bad.length) return null;
      return `a load whose LAST PUBLISHED close is ${Date.now() - live} ms past (bound ${BOUND}) must still `
        + `retire on a failed read: ${bad.join('; ')} - the bound has been made forgiving, not correct`;
    } finally { r.done(); }
  });

  await check(5, 'pending_first_bid_mark_tracks_live_close', 'mechanism', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('GC-OFF-TRACK', 'Unlisted Shipper', posted, 'off');
      const mark = () => {
        const row = r.eng.snapshot().find((s) => s.auctionId === 'GC-OFF-TRACK');
        if (!row) throw new Error('HARNESS: load missing from snapshot()');
        return row.firstBidByMs;
      };
      const atArm = mark();
      if (!Number.isFinite(atArm)) return `HARNESS: no first-bid mark right after arm (got ${atArm})`;
      const live = await r.career(m, posted, SHORT_CAREER);
      if (m.lastBidPrice != null) return 'HARNESS: a bid landed, the pre-first-bid mark does not apply';
      const afterExtensions = mark();
      vnow += 1_000;
      r.ctrl.frame = r.frame(live - EXTEND_MS);
      await r.tick(m);
      vnow += 1_000;
      r.ctrl.frame = r.frame(live - 30_000);
      await r.tick(m);
      const afterLag = mark();
      const bad = [];
      if (afterExtensions - atArm !== live - posted) {
        bad.push(`after 3 published rounds (one poll skipped) the mark moved ${afterExtensions - atArm} ms, `
          + `expected ${live - posted} (off by ${live - posted - (afterExtensions - atArm)} ms)`);
      }
      if (afterLag !== afterExtensions) {
        bad.push(`a lagging frame and a 30s backward wobble moved the mark by ${afterLag - afterExtensions} ms `
          + '(the close must be forward-only)');
      }
      if (!bad.length) return null;
      return `/track firstBidByMs: ${bad.join('; ')} - ${LIVE_CAUSE}`;
    } finally { r.done(); }
  });

  await check(6, 'closed_record_reports_live_close', 'mechanism, shape (a)', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW();
      const m = r.arm('GC-OFF-FINAL', 'Unlisted Shipper', posted, 'off');
      const live = await r.career(m, posted, [1, 2, 1]);
      vnow = live;
      const closing = { ...r.frame(live), status: 'closed', myRank: 2, totalBidders: 4 };
      r.ctrl.frame = closing;
      await r.eng._finalize(m, closing);
      const result = r.events.find((e) => e.type === 'auction_result' && e.auctionId === 'GC-OFF-FINAL');
      if (!result) return 'HARNESS: _finalize emitted no auction_result';
      if (result.finalCloseAt === live) return null;
      return `auction_result.finalCloseAt ${result.finalCloseAt} is not the last published close ${live} `
        + `(posted ${posted}; ${live - result.finalCloseAt} ms stale) - the result record's close does not `
        + 'follow the published close. Assumes shape (a): a last-read-close fix must also route finalCloseAt through it';
    } finally { r.done(); }
  });

  await check(7, 'extended_close_reaches_durable_intent', 'mechanism, shape (a)', async () => {
    const r = rig();
    try {
      const posted = REAL_NOW() + 600_000;
      const m = r.arm('GC-OFF-DURABLE', 'Unlisted Shipper', posted, 'off');
      const live = await r.career(m, posted, SHORT_CAREER);
      const intent = r.eng.scheduler.get('GC-OFF-DURABLE');
      if (!intent) return 'HARNESS: no durable intent';
      if (intent.closesAt === live) return null;
      return `durable intent closesAt ${intent.closesAt} is not the last published close ${live} `
        + `(${live - intent.closesAt} ms behind; a restart now retires a live auction) - the durable close does `
        + 'not follow the published close. Assumes shape (a): a last-read-close fix must also persist it';
    } finally { r.done(); }
  });

  await check(8, 'closed_while_down_row_reports_last_published_close', 'mechanism, shape (a)', async () => {
    const r = rig();
    try {
      const { m, posted, live } = await deadLoad(r, 'GC-OFF-CWD');
      if (m.finalized !== true) return 'HARNESS: the dead load was not retired, nothing to date';
      const cwd = r.events.find((e) => e.type === 'closed_while_down' && e.auctionId === 'GC-OFF-CWD');
      if (!cwd) return 'HARNESS: retirement emitted no closed_while_down';
      if (cwd.closesAt === live) return null;
      return `closed_while_down closesAt ${cwd.closesAt} is not the last published close ${live} `
        + `(posted ${posted}; ${live - cwd.closesAt} ms stale) - the ledger row's auction date does not follow `
        + 'the published close. Assumes shape (a): a last-read-close fix must also date the retirement by it';
    } finally { r.done(); }
  });
}

main().catch((e) => {
  results.push({ n: 0, name: 'harness', kind: 'control', failure: `threw: ${e && e.stack ? e.stack : e}` });
}).then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }

  const isHarness = (x) => x.failure
    && (!x.kind.startsWith('mechanism') || /^(HARNESS|threw:)/.test(x.failure));
  const harness = results.filter(isHarness);
  const mech = results.filter((x) => x.failure && !isHarness(x));
  if (harness.length || bidAttempts > 0 || results.length !== EXPECTED_CHECKS) {
    console.log(`\nFAIL - HARNESS/PIN: ${harness.map((x) => `${x.n}. ${x.name}`).join(', ') || 'no check'} failed, `
      + `${bidAttempts} bid attempt(s) reached the fake adapter, ${results.length} of ${EXPECTED_CHECKS} checks ran; `
      + 'the harness, the control or a pin is broken, so the mechanism results above are not trustworthy');
    process.exit(1);
  }
  if (mech.length) {
    const causes = [];
    if (mech.some((x) => !x.kind.endsWith('(a)'))) causes.push(LIVE_CAUSE);
    if (mech.some((x) => x.kind.endsWith('(a)'))) causes.push(RECORD_CAUSE);
    console.log(`\nFAIL - ${mech.length} of ${results.length} checks (${mech.map((x) => x.n).join(', ')}): ${causes.join('; ')}`);
    process.exit(1);
  }
  console.log(`\nPASS - ${results.length} checks: GoComet believed close follows the published close`);
});
