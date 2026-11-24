'use strict';
/**
 * The REAL engine flags a SuperProcure soft close whose final close was never published, and carries
 * the load's live attempt cap, so the lost receipt says so instead of stating the stale close.
 *
 * Regression target: BC-31 engine half (timing-D mechanism M7, the Dynamic Cables 25703191 row) and
 * BC-30 (attempts on every result, M9) for the live per-load cap. scripts/test-receipt-unknown-final-close.js
 * pins the receipt with a hand-built result; this file proves the engine produces that result.
 *
 * THE DEFECT. On an allowlisted soft load the countdown sits at zero past the last published close
 * while the auction is still live. _observeExtension infers a round (the _zeroRunExtendAt branch) but
 * never learns the new close, so auction_result.finalCloseAt stays at the stale close and nothing on
 * the result says it is stale: the receipt prints it as the close and our last bid's countdown as the
 * gap to it. The result also carries no attempt cap. SuperProcure's capabilities().revisionLimit is
 * null; the cap rides each frame (branchBidCountAllowed, _attemptBudget), so only the live read can
 * give "3 of 3 used".
 *
 * SCENARIOS. U: posted close 12:30:00 is the last close ever published; three bids land (the last at
 * a 2.45 s countdown, 250 ms on the wire); the countdown then sits at zero, one round is inferred, and
 * the sustained-zero path finalizes at rank 8. P (control): the same load, but a late frame publishes
 * 12:32:00 and the engine adopts it. P is finalized directly, 1 s after 12:32:00: the only soft
 * finalize path is the sustained zero, and it always infers another round 3 s into that zero, so a
 * close AT a published close cannot be reached through _tick.
 *
 * K (natural finalize, close known): the frames publish an extension cap of 1, and a published round
 * moves the close to 12:32:00 before our last bid lands. So when the countdown then sits at zero, no
 * unpublished extension is possible. The sustained-zero path still infers (latches) a terminal round,
 * as it does on every allowlisted SP soft close, and finalizes through _tick. That round is not an
 * unknown close and not an extension after our last bid: the receipt states 12:32:00 as the close.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too): U never claims a final close time on a Closed
 * line; P and K have no unknown-close line and no finalCloseUnknown; K's Closed line claims no
 * extension after our last bid, and the retired Extended sentence appears on none.
 *
 * named re-pin: round tracker, ruling 56. The sustained zero no longer infers a round: in U the frozen
 * close counts nothing and reads UNCERTAIN_AFTER_CLOSE (what _closeAfterLastBid now calls inferred), in
 * P the late frame is the one round, and in K the cap-reached round stays FINAL through the zero, so
 * nothing terminal is latched. The harness preconditions below say so; every receipt check is unchanged.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * Date.now, rand pinned, timers cleared after every tick, every engine event fed in order through a
 * real BidLogger on a memory store, then the shared renderer. Wording comes from
 * scripts/fixtures/result-receipt-copy.js.
 *
 *   node scripts/test-receipt-engine-close-unknown.js
 */
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { clock, attempts, lastBid, closed, extended, unknownClose } = require('./fixtures/result-receipt-copy');

const { istAt, renderResult, findLine, hasLine } = h;

const ID = '25703191';
const CUSTOMER = 'Dynamic Cables Limited';
const C0 = istAt(2026, 9, 23, 12, 30, 0);
const C1 = C0 + 120_000;
const EXTEND_MS = 120_000;
const CAP = 3;
const WIRE_MS = 250;
const DECISION_COUNTDOWNS = [60_000, 30_000, 20_000, 15_000, 10_000, 6_000, 4_000, 2_450, 1_200];

const MARK_A = '\u0001';
const MARK_B = '\u0002';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LAST_BID_FORM = lastBid(MARK_A, MARK_B).value.split(MARK_A)[1].split(MARK_B)[0];
const EXTENDED_PREFIXES = [1, 2, 3].map((n) => extended(n, MARK_B).value.split(MARK_B)[0]);
const UNKNOWN_RE = new RegExp(unknownClose(MARK_A).value.split(MARK_A).map(escapeRe).join('.*?'));
const OLD_LEAD = /\d+s before close|\d+ min before close/;

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');
const lines = (text) => String(text || '').split('\n');
const timingLines = (text) => lines(text).filter((l) => /close|last bid|extend|ran past|attempt/i.test(l)).map(ascii).join(' | ');

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
const ENGINES = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function harness(cond, msg) {
  if (!cond) throw new Error(`HARNESS: ${msg}`);
}

const clockOf = (ms) => { const d = new Date(ms); return clock(d.getHours(), d.getMinutes(), d.getSeconds()); };

function rig(tag, { extendCount = null } = {}) {
  const file = path.join(os.tmpdir(), `receipt-engine-close-unknown-${tag}-${process.pid}.json`);
  CLEAN.push(file);
  const ctrl = { frame: null };
  const wire = [];
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
      closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure' }),
    ensureSession: async () => ({}),
    async getAuctionState() { return ctrl.frame ? { ...ctrl.frame } : { ok: false, error: 'no frame' }; },
    async placeBid(id, price) {
      wire.push({ decidedAt: Date.now(), countdown: ctrl.frame.closesInMs, price });
      vnow += WIRE_MS;
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: WIRE_MS };
    },
  };
  const eng = new BidEngine(adapter, new DurableScheduler(file), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0 },
    softClose: { enabled: true, shippers: ['Dynamic Cables'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: quiet,
    rand: () => 0,
  });
  ENGINES.push(eng);
  vnow = C0 - 600_000;
  const m = eng.arm({ id: ID, lane: { origin: 'Jaipur', destination: 'Vadodara' }, units: 1, companyName: CUSTOMER,
    closesAt: C0 }, { cost: 31_000, marginsPct: [8, 5, 4] });
  if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  harness(m.softStrategy !== 'off', `${tag}: '${CUSTOMER}' resolved softStrategy '${m.softStrategy}', the inferred-round branch is unreachable`);

  const frame = (closeAt, rank, status = 'live') => ({ ok: true, status, closeModel: 'soft', closesAtMs: closeAt,
    closesInMs: Math.max(0, closeAt - Date.now()), extendMs: EXTEND_MS, extendCount, triggerWindowMs: null,
    myRank: rank, totalBidders: 9, standingL1Price: null, revisionLimit: CAP, revisionsLeft: null, minDecrement: 100,
    measuredRttMs: 20 });
  const tick = async (at, closeAt, rank, status) => {
    vnow = at;
    ctrl.frame = frame(closeAt, rank, status);
    await eng._tick(m);
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }
  };
  const bidThrough = async () => {
    for (const r of DECISION_COUNTDOWNS) await tick(C0 - r, C0, wire.length ? 3 : null);
    for (let t = 0; t <= 5_000; t += 1_000) await tick(C0 + t, C0, 3);
  };
  return { eng, m, ctrl, wire, events, frame, tick, bidThrough };
}

async function render(r) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  for (const e of r.events) await logger.handle(e);
  const record = await store.getDoc('closedBids', ID);
  const resultEvent = r.events.find((e) => e.type === 'auction_result' && e.auctionId === ID);
  harness(resultEvent, 'the engine emitted no auction_result');
  const full = await renderResult({ record, resultEvent });
  const short = await renderResult({ record, resultEvent, short: true });
  return { record, resultEvent, full, short };
}

function commonControls(name, r, out, lastClose = C0) {
  harness(r.wire.length > 0, `${name}: no placeBid reached the fake adapter`);
  harness(r.wire.every((w) => w.decidedAt < lastClose), `${name}: a bid went on the wire after the last published close`);
  const placed = r.events.filter((e) => e.type === 'bid_placed');
  harness(placed.length === r.wire.length, `${name}: ${r.wire.length} accepted writes but ${placed.length} bid_placed events`);
  harness(placed[placed.length - 1].closesInMs === r.wire[r.wire.length - 1].countdown,
    `${name}: the last bid_placed countdown is not the frame the engine decided on`);
  harness(out.resultEvent.won === false && out.resultEvent.finalRank === 8, `${name}: result is not a rank-8 loss`);
  harness(out.full.kind === 'lost' && out.full.template === 'lost', `${name}: routed ${out.full.kind}/${out.full.template}, not lost/lost`);
  harness(out.short.template === 'lost_short', `${name}: group reply rendered ${out.short.template}, not lost_short`);
  harness(out.full.text.includes(ID) && out.full.text.includes(CUSTOMER), `${name}: the receipt is not for load ${ID} (${CUSTOMER})`);
  harness(out.record && out.record.ourBids.length === r.wire.length, `${name}: the record did not keep our ${r.wire.length} bids`);
}

const failures = [];
let checkNo = 0;
function check(mechanism, desc, ok, text) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${mechanism}] ${desc}${text == null ? '' : ` -- rendered: ${timingLines(text) || '(no timing lines)'}`}`);
}

async function main() {
  // Scenario U: the countdown sits at zero past 12:30 and no later frame ever publishes a close.
  const u = rig('U');
  await u.bidThrough();
  harness(u.m.extendsObserved === 0 && u.eng.roundVerdict(u.m).verdict === 'UNCERTAIN_AFTER_CLOSE',
    `U: the frozen close did not read UNCERTAIN_AFTER_CLOSE with nothing counted (extendsObserved ${u.m.extendsObserved})`);
  for (let t = 6_000; !u.m.finalized && t <= EXTEND_MS + 10_000; t += 1_000) {
    await u.tick(C0 + t, C0, 8, t >= EXTEND_MS ? 'closed' : 'live');
  }
  harness(u.m.finalized === true, 'U: the sustained-zero path never finalized the load');
  const uOut = await render(u);
  commonControls('U', u, uOut);

  // Scenario P: identical, except a late frame publishes 12:32:00 and the engine adopts it.
  const p = rig('P');
  await p.bidThrough();
  harness(p.m.extendsObserved === 0, `P: the frozen close counted a round (extendsObserved ${p.m.extendsObserved})`);
  for (const t of [10_000, 60_000, 110_000, 120_000, 121_000]) await p.tick(C0 + t, C1, 8);
  harness(p.m.believedCloseAt === C1, `P: the published close was not adopted (believedCloseAt ${p.m.believedCloseAt})`);
  harness(p.m.extendsObserved === 1, `P: the round was counted ${p.m.extendsObserved} times`);
  vnow = C1 + 1_500;
  const closing = p.frame(C1, 8, 'closed');
  p.ctrl.frame = closing;
  await p.eng._finalize(p.m, closing);
  const pOut = await render(p);
  commonControls('P', p, pOut);
  harness(pOut.resultEvent.finalCloseAt === C1, `P: finalCloseAt ${pOut.resultEvent.finalCloseAt} is not the adopted close`);

  // Scenario K: cap 1 used by a published round before our last bid; natural finalize through _tick.
  const k = rig('K', { extendCount: 1 });
  for (const r of [60_000, 30_000, 20_000, 15_000, 10_000, 6_000]) await k.tick(C0 - r, C0, k.wire.length ? 3 : null);
  for (const r of [5_000, 4_000]) await k.tick(C0 - r, C1, 3);
  harness(k.m.extendCap === 1 && k.m.extendsObserved === 1 && k.m.believedCloseAt === C1,
    `K: the published round did not use the cap (cap ${k.m.extendCap}, extendsObserved ${k.m.extendsObserved})`);
  for (const r of [60_000, 30_000, 20_000, 10_000, 6_000, 4_000, 2_450, 1_200]) await k.tick(C1 - r, C1, 3);
  for (let t = 0; !k.m.finalized && t <= EXTEND_MS + 10_000; t += 1_000) {
    await k.tick(C1 + t, C1, 8, t >= EXTEND_MS ? 'closed' : 'live');
  }
  harness(k.m.finalized === true, 'K: the sustained-zero path never finalized the load');
  const kSeq = k.events.map((e) => (e.type === 'bid_placed' ? 'bid' : e.type === 'extension_observed' ? (e.inferred ? 'inferred' : 'published') : null)).filter(Boolean);
  harness(kSeq.lastIndexOf('bid') > kSeq.indexOf('published'), `K: our last bid did not land after the published round (${kSeq.join(',')})`);
  harness(!kSeq.includes('inferred') && k.m.extendsObserved === 1,
    `K: a terminal round was counted after our last bid (${kSeq.join(',')}, extendsObserved ${k.m.extendsObserved})`);
  const kLast = k.wire[k.wire.length - 1];
  const kClose = kLast.decidedAt + kLast.countdown;
  harness(kClose === C1, `K: the close in force at our last bid is ${kClose}, not the published ${C1}`);
  const kOut = await render(k);
  commonControls('K', k, kOut, C1);

  const variants = (out) => [['lost', out.full.text], ['lost_short', out.short.text]];
  const used = u.wire.length;
  const pLast = p.wire[p.wire.length - 1];

  // Mechanism checks (red on base).
  for (const [variant, text] of variants(uOut)) {
    const spec = unknownClose(clock(12, 30));
    check('M7 unpublished final close stated as unknown', `U ${variant}: expected line "${spec.value}"`, hasLine(text, spec), text);
  }
  for (const [variant, text] of variants(uOut)) {
    const gapLines = lines(text).filter((l) => l.includes(LAST_BID_FORM) || OLD_LEAD.test(l));
    check('M7 no gap to a close that was not the final close', `U ${variant}: no line states a gap "before close" of the stale 12:30 close`,
      gapLines.length === 0, text);
  }
  for (const [variant, text] of variants(uOut)) {
    const spec = attempts(used, CAP);
    check('M9 live per-load attempt cap', `U ${variant}: expected line "${spec.label} ... ${spec.value}" (cap from the frame, not capabilities())`,
      hasLine(text, spec), text);
  }
  for (const [variant, text] of variants(pOut)) {
    const spec = closed(clock(12, 32, 0), clock(12, 30));
    check('M5 published final close with seconds and posted close', `P ${variant}: expected line "${spec.label} ... ${spec.value}"`,
      hasLine(text, spec), text);
  }

  for (const [variant, text] of variants(kOut)) {
    const spec = closed(clockOf(kClose), clock(12, 30));
    check('M5/M7 last published close is the close when no unpublished extension was possible',
      `K ${variant}: expected line "${spec.label} ... ${spec.value}"`, hasLine(text, spec), text);
  }

  // Secondary checks on the contract fields (red on base).
  const ur = uOut.resultEvent;
  check('M7 engine flag', `U auction_result.finalCloseUnknown is ${ur.finalCloseUnknown}, expected true`, ur.finalCloseUnknown === true);
  check('M9 engine attempt cap', `U auction_result.attemptsAllowed is ${ur.attemptsAllowed}, expected ${CAP} (the frame's revisionLimit)`,
    ur.attemptsAllowed === CAP);
  check('M5 posted close', `U auction_result.postedCloseAt is ${ur.postedCloseAt}, expected ${C0}`, ur.postedCloseAt === C0);
  check('M3 extensions after last bid', `P auction_result.extensionsAfterLastBid is ${pOut.resultEvent.extensionsAfterLastBid}, expected 1`,
    pOut.resultEvent.extensionsAfterLastBid === 1);
  check('M3/M7 terminal inferred round is not an extension after our last bid',
    `K auction_result.extensionsAfterLastBid is ${kOut.resultEvent.extensionsAfterLastBid}, expected 0`,
    kOut.resultEvent.extensionsAfterLastBid === 0);
  const pPlaced = p.events.filter((e) => e.type === 'bid_placed').pop();
  check('M8 decision instant on the bid', `P last bid_placed.decidedAt is ${pPlaced.decidedAt}, expected ${pLast.decidedAt} `
    + `(ts ${pPlaced.ts} - decidedAt must be the ${WIRE_MS} ms on the wire)`, pPlaced.decidedAt === pLast.decidedAt);

  // Guards (green on base, must stay green).
  const closedLabel = closed('', '').label;
  const finalizedClock = clockOf(ur.ts);
  for (const [variant, text] of variants(uOut)) {
    const claims = [
      closed(clock(12, 30, 0)),
      { label: closedLabel, value: finalizedClock },
      { label: closedLabel, value: finalizedClock.replace(/:\d\d (am|pm)$/, ' $1') },
    ].map((spec) => findLine(text, spec)).filter(Boolean);
    check('M7 guard', `U ${variant}: no Closed line claims a final close time (stale 12:30 or finalize ${finalizedClock})`,
      claims.length === 0, text);
  }
  for (const [variant, text] of variants(pOut)) {
    check('M7 guard', `P ${variant}: no unknown-close line when the final close was published`, !lines(text).some((l) => UNKNOWN_RE.test(l)), text);
  }
  check('M7 guard', `P auction_result.finalCloseUnknown is ${pOut.resultEvent.finalCloseUnknown}, must not be true`,
    pOut.resultEvent.finalCloseUnknown !== true);
  for (const [variant, text] of variants(kOut)) {
    check('M7 guard', `K ${variant}: no unknown-close line when the cap was used before the terminal zero`,
      !lines(text).some((l) => UNKNOWN_RE.test(l)), text);
    check('M3 guard', `K ${variant}: the retired Extended sentence appears on no result`,
      !lines(text).some((l) => EXTENDED_PREFIXES.some((x) => l.includes(x))), text);
  }
  check('M7 guard', `K auction_result.finalCloseUnknown is ${kOut.resultEvent.finalCloseUnknown}, must not be true`,
    kOut.resultEvent.finalCloseUnknown !== true);

  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - BC-31/M7 + BC-30: the engine does not flag an unpublished `
      + 'final close or carry the live attempt cap, so the receipt states the stale close and no attempts');
    return 1;
  }
  console.log(`PASS ${checkNo} checks`);
  return 0;
}

main().catch((e) => {
  console.log(ascii(e && e.stack ? e.stack : e));
  return 1;
}).then((code) => {
  Date.now = REAL_NOW;
  for (const e of ENGINES) { try { e.kill(); } catch (_) {} }
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  process.exit(code);
});
