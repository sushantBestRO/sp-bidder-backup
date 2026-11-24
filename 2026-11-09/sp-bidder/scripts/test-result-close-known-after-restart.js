'use strict';
/**
 * A restart or a re-price must not turn a known SuperProcure soft close into an unknown one.
 *
 * Regression target: F1 (restart / re-price half of the unknown-final-close rule).
 *
 * THE DEFECT. The facts about our last landed bid (monitor._lastLanded: the close it was measured
 * against, its landing countdown, the trigger window, whether we then held rank 1) live on the
 * monitor only. arm() seeds them null and the accept path never writes them to the durable intent.
 * On an allowlisted SuperProcure soft load the terminal zero run infers a round on every natural
 * close, and _closeAfterLastBid reads a null last bid as "unpublished round possible". So after a
 * restart (new engine on the same intents file + rehydrate), or a re-price (stop + arm) whose
 * successor lands nothing, auction_result.finalCloseUnknown comes back true even when our last bid
 * landed far outside the trigger window of the close that stood, and the receipt prints
 * "Closed - may have run past 12:30 pm" where the same load without the restart prints its close.
 *
 * THE CONTRACT. Unknown only when the terminal inferred round sits on the very close our last bid
 * was measured against, that bid landed inside the close's trigger window (or the window is
 * unknown), and the cap was not used up (or is unknown). A restart or re-price does not change it.
 *
 * SCENARIOS. a: establish lands ~199.75 s out on a 100 s window, restart, natural close.
 * b: same landing, re-price whose successor is refused on every write. c: a published round moves
 * the close to 12:32:00 after our bid, then a restart. Checks 1-6 (a/b/c, full and short) and 7
 * (the engine flag on each) are the mechanism.
 *
 * WHAT MUST NOT MOVE (green on the unfixed tree too): d, the no-restart control, states its close;
 * e, a bid landed inside the window, stays unknown across a restart; f, an intent written before
 * the fix (no last-bid facts on disk) stays unknown; g, a restart after we lost rank 1 never claims
 * we did not lead (so never "lost on timing"); h, a restart never reports more extensions after our
 * last bid than the same run without one; i, a write that lands after its monitor was retired by a
 * re-price leaves the close unknown, because the successor's facts describe an older bid.
 *
 * Offline and deterministic: fake adapter, temp-file DurableScheduler under os.tmpdir(), stubbed
 * Date.now, rand pinned, timers cleared after every tick, a held write released by hand rather
 * than by a sleep, every engine event fed through a real BidLogger on a memory store, then the
 * shared renderer. Wording comes from scripts/fixtures/result-receipt-copy.js.
 *
 *   node scripts/test-result-close-known-after-restart.js
 */
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { lastBidAtLowestMargin } = require('../src/util/reportedClose');
const { clock, closed, unknownClose } = require('./fixtures/result-receipt-copy');

const { istAt, renderResult, hasLine } = h;

const ID = '25703191';
const CUSTOMER = 'Dynamic Cables Limited';
const C0 = istAt(2026, 9, 23, 12, 30, 0);
const C1 = C0 + 120_000;
const EXTEND_MS = 120_000;
const WINDOW_MS = 100_000;
const WIRE_MS = 250;
const COST = 31_000;
const BAND = [8, 5, 4];
const LATE = [150_000, 120_000, 90_000, 60_000, 30_000, 10_000, 4_000, 2_000, 1_000];

const MARK = '\u0001';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UNKNOWN_RE = new RegExp(unknownClose(MARK).value.split(MARK).map(escapeRe).join('.*?'));

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

function rig(tag, { establishLeadMs = 100_000 } = {}) {
  const file = path.join(os.tmpdir(), `result-close-known-after-restart-${tag}-${process.pid}.json`);
  CLEAN.push(file);
  const ctrl = { frame: null, accept: true, hold: null, reads: 0, finalRank: null };
  const wire = [];
  const events = [];
  let attempts = 0;
  const answer = (ok) => (ok ? { accepted: true, myRank: null, revisionsLeft: null, latencyMs: WIRE_MS }
    : { accepted: false, status: 400, reason: 'refused', body: 'refused' });
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
      closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure' }),
    ensureSession: async () => ({}),
    // _finalize's authoritative read is the second read of the finalizing tick. Only it sees the loss,
    // so no live frame is outranked into a floor shot.
    async getAuctionState() {
      ctrl.reads += 1;
      if (!ctrl.frame) return { ok: false, error: 'no frame' };
      return ctrl.reads > 1 && ctrl.finalRank != null ? { ...ctrl.frame, myRank: ctrl.finalRank } : { ...ctrl.frame };
    },
    placeBid(id, price) {
      attempts += 1;
      const w = { decidedAt: Date.now(), countdown: ctrl.frame.closesInMs, closeAt: ctrl.frame.closesAtMs, price };
      vnow += WIRE_MS;
      const held = ctrl.hold;
      if (held) {
        ctrl.hold = null;
        return new Promise((resolve) => {
          held.release = (ok) => {
            if (ok) wire.push(w);
            resolve(answer(ok));
          };
          held.reached(w);
        });
      }
      if (ctrl.accept) wire.push(w);
      return Promise.resolve(answer(ctrl.accept));
    },
  };
  const boot = () => {
    const eng = new BidEngine(adapter, new DurableScheduler(file), {
      config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0, softOpenJitterMs: 0 },
      softClose: { enabled: true, shippers: ['Dynamic Cables'], mode: 'live', reserve: 1, establishLeadMs },
      onEvent: (e) => events.push(e),
      log: quiet,
      rand: () => 0,
    });
    ENGINES.push(eng);
    return eng;
  };
  const unTimer = (m) => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };
  const meta = { id: ID, lane: { origin: 'Jaipur', destination: 'Vadodara' }, units: 1, companyName: CUSTOMER, closesAt: C0 };
  const frame = (closeAt, rank, status = 'live') => ({ ok: true, status, closeModel: 'soft', closesAtMs: closeAt,
    closesInMs: Math.max(0, closeAt - Date.now()), extendMs: EXTEND_MS, extendCount: null, triggerWindowMs: WINDOW_MS,
    myRank: rank, totalBidders: 9, standingL1Price: null, revisionLimit: 3, revisionsLeft: null, minDecrement: 100,
    measuredRttMs: 20 });
  const st = { eng: boot(), m: null };
  const arm = (marginsPct) => {
    st.m = st.eng.arm(meta, { cost: COST, marginsPct });
    unTimer(st.m);
    harness(st.m.softStrategy === 'live', `${tag}: '${CUSTOMER}' resolved softStrategy '${st.m.softStrategy}', not live`);
    return st.m;
  };
  const tick = async (at, closeAt, rank, status) => {
    vnow = at;
    ctrl.frame = frame(closeAt, rank, status);
    ctrl.reads = 0;
    await st.eng._tick(st.m);
    unTimer(st.m);
  };
  const ticks = async (close, countdowns, rank) => {
    for (const c of countdowns) await tick(close - c, close, typeof rank === 'function' ? rank() : rank);
  };
  const natural = async (close, rank, finalRank = null) => {
    ctrl.finalRank = finalRank;
    for (let t = 0; !st.m.finalized && t <= EXTEND_MS + 10_000; t += 1_000) {
      await tick(close + t, close, rank, t >= EXTEND_MS ? 'closed' : 'live');
    }
    ctrl.finalRank = null;
    harness(st.m.finalized === true, `${tag}: the sustained-zero path never finalized the load`);
  };
  const restart = async (at, beforeBoot = null) => {
    const old = st.m;
    st.eng.kill('restart');
    if (beforeBoot) beforeBoot(file);
    st.eng = boot();
    vnow = at;
    const resumed = await st.eng.rehydrate();
    st.m = st.eng.monitors.get(ID);
    harness(resumed === 1 && st.m && st.m !== old, `${tag}: rehydrate resumed ${resumed} and rebuilt ${st.m === old ? 'the same' : 'no'} monitor`);
    unTimer(st.m);
    return st.m;
  };
  const establish = async () => {
    await ticks(C0, [300_000, 250_000, 200_000], () => (wire.length ? 1 : null));
    harness(wire.length === 1, `${tag}: the establish did not land at the 200 s tick (${wire.length} accepted writes)`);
    const landing = wire[0].countdown - WIRE_MS;
    harness(landing > WINDOW_MS, `${tag}: the establish landed ${landing} ms out, inside the ${WINDOW_MS} ms window`);
  };
  return { tag, file, ctrl, wire, events, st, frame, arm, tick, ticks, natural, restart, establish, attempts: () => attempts };
}

async function render(r) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  for (const e of r.events) await logger.handle(e);
  const record = await store.getDoc('closedBids', ID);
  const resultEvent = r.events.find((e) => e.type === 'auction_result' && String(e.auctionId) === ID);
  harness(resultEvent, `${r.tag}: the engine emitted no auction_result`);
  harness(r.events.filter((e) => e.type === 'auction_result').length === 1, `${r.tag}: more than one auction_result`);
  // named re-pin: round tracker, ruling 56 - the terminal zero run no longer infers a round; it leaves
  // the round UNCERTAIN_AFTER_CLOSE, which is what the unknown-close branch now reads.
  harness(resultEvent.round && resultEvent.round.verdict === 'UNCERTAIN_AFTER_CLOSE',
    `${r.tag}: the load did not finalize from a frozen close (verdict ${resultEvent.round && resultEvent.round.verdict}), `
    + 'so the unknown-close branch is unreachable');
  const full = await renderResult({ record, resultEvent });
  const short = await renderResult({ record, resultEvent, short: true });
  return { record, resultEvent, full, short };
}

const variants = (out) => [[out.full.template, out.full.text], [out.short.template, out.short.text]];

const failures = [];
let checkNo = 0;
function check(id, desc, ok, text) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${id}] ${desc}${text == null ? '' : ` -- rendered: ${timingLines(text) || '(no timing lines)'}`}`);
}

function lostControls(r, out) {
  harness(out.resultEvent.won === false && out.resultEvent.finalRank === 8, `${r.tag}: result is not a rank-8 loss`);
  harness(out.full.template === 'lost' && out.short.template === 'lost_short',
    `${r.tag}: rendered ${out.full.template}/${out.short.template}, not lost/lost_short`);
  harness(out.resultEvent.landedBids === r.wire.length, `${r.tag}: landedBids ${out.resultEvent.landedBids}, ${r.wire.length} accepted writes`);
}

async function scenarioA() {
  const r = rig('a');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  await r.restart(C0 - 190_000);
  await r.ticks(C0, LATE, 1);
  await r.natural(C0, 1, 8);
  harness(r.wire.length === 1, `a: ${r.wire.length} accepted writes after the restart, expected the one establish`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function scenarioB() {
  const r = rig('b');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  const before = r.attempts();
  vnow = C0 - 190_000;
  r.st.eng.stop(ID);
  r.arm([9, 6, 5]);
  r.ctrl.accept = false;
  await r.ticks(C0, LATE, 1);
  await r.natural(C0, 1, 8);
  harness(r.attempts() > before, 'b: the re-priced successor never attempted a write, so "lands nothing" is not exercised');
  harness(r.wire.length === 1, `b: ${r.wire.length} accepted writes, expected the one establish`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function scenarioC(withRestart) {
  const r = rig(withRestart ? 'c' : 'c-control');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  await r.ticks(C0, [150_000, 120_000, 90_000, 60_000], 1);
  await r.tick(C1 - 160_000, C1, 1);
  harness(r.st.m.believedCloseAt === C1 && r.st.m.extendsObserved === 1,
    `${r.tag}: the published round did not move the close to 12:32 (believedCloseAt ${r.st.m.believedCloseAt}, extendsObserved ${r.st.m.extendsObserved})`);
  if (withRestart) {
    await r.restart(C1 - 150_000);
    await r.tick(C1 - 150_000, C1, 1);
    harness(r.st.m.believedCloseAt === C1, `c: the rebuilt monitor believes close ${r.st.m.believedCloseAt}, not 12:32`);
  }
  await r.ticks(C1, [120_000, 90_000, 60_000, 30_000, 10_000, 4_000, 2_000, 1_000], 1);
  await r.natural(C1, 1, 8);
  harness(r.wire.length === 1, `${r.tag}: ${r.wire.length} accepted writes, expected the one establish`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function scenarioD() {
  const r = rig('d');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  await r.ticks(C0, LATE, 1);
  await r.natural(C0, 1, 8);
  harness(r.wire.length === 1, `d: ${r.wire.length} accepted writes, expected the one establish`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function scenarioE() {
  const r = rig('e', { establishLeadMs: 1_000 });
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.ticks(C0, [200_000, 150_000, 120_000], null);
  harness(r.attempts() === 0, `e: a write went out before the window (${r.attempts()} attempts)`);
  await r.tick(C0 - 50_000, C0, null);
  harness(r.wire.length === 1 && r.wire[0].countdown - WIRE_MS <= WINDOW_MS,
    `e: the establish did not land inside the window (${r.wire.length} writes)`);
  await r.restart(C0 - 45_000);
  await r.ticks(C0, [30_000, 10_000, 4_000, 2_000, 1_000], 1);
  await r.natural(C0, 1, 8);
  harness(r.wire.length === 1, `e: ${r.wire.length} accepted writes, expected the one establish`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function scenarioF() {
  const r = rig('f');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  await r.restart(C0 - 190_000, (file) => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    harness(Array.isArray(raw.intents) && raw.intents.length === 1, 'f: the intents file does not hold the one intent');
    for (const it of raw.intents) delete it.lastLanded;
    fs.writeFileSync(file, JSON.stringify(raw));
  });
  await r.ticks(C0, LATE, 1);
  await r.natural(C0, 1, 8);
  harness(r.wire.length === 1, `f: ${r.wire.length} accepted writes, expected the one establish`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function scenarioG(withRestart) {
  const r = rig(withRestart ? 'g' : 'g-control');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  await r.ticks(C0, [150_000, 120_000], 1);
  r.ctrl.accept = false;
  if (withRestart) await r.restart(C0 - 100_000);
  await r.ticks(C0, [90_000, 60_000, 30_000, 10_000, 4_000, 2_000, 1_000], 3);
  await r.natural(C0, 3);
  harness(r.wire.length === 1, `${r.tag}: ${r.wire.length} accepted writes, expected the one establish`);
  const out = await render(r);
  harness(out.resultEvent.won === false && out.resultEvent.finalRank === 3, `${r.tag}: result is not a rank-3 loss`);
  harness(lastBidAtLowestMargin(out.record) === false, `${r.tag}: the last recorded bid is not above the lowest margin`);
  return out;
}

async function scenarioI() {
  const r = rig('i');
  vnow = C0 - 600_000;
  r.arm(BAND);
  await r.establish();
  await r.ticks(C0, [150_000, 120_000, 90_000], 1);
  vnow = C0 - 60_000;
  r.st.eng.stop(ID);
  const m1 = r.arm([9, 6, 5]);
  const held = { release: null, reached: null };
  const onWire = new Promise((resolve) => { held.reached = resolve; });
  r.ctrl.hold = held;
  vnow = C0 - 50_000;
  r.ctrl.frame = r.frame(C0, 1);
  r.ctrl.reads = 0;
  const inFlight = r.st.eng._tick(m1);
  const reached = await Promise.race([onWire, inFlight.then(() => null)]);
  harness(reached, 'i: the re-priced successor did not fire at the 50 s tick');
  r.st.eng.stop(ID);
  r.ctrl.accept = false;
  const m2 = r.arm([10, 7, 6]);
  harness(m1.finalized === true && r.st.eng.monitors.get(ID) === m2 && r.wire.length === 1,
    'i: the successor was not retired and replaced while its write was still on the wire');
  held.release(true);
  await inFlight;
  harness(r.wire.length === 2, `i: ${r.wire.length} accepted writes, expected the establish and the held write`);
  await r.ticks(C0, [30_000, 10_000, 4_000, 2_000, 1_000], 1);
  await r.natural(C0, 1, 8);
  harness(r.wire.length === 2, `i: the last re-arm landed a write (${r.wire.length} accepted), expected none`);
  const out = await render(r);
  lostControls(r, out);
  return out;
}

async function main() {
  const a = await scenarioA();
  const b = await scenarioB();
  const c = await scenarioC(true);
  const cControl = await scenarioC(false);
  const d = await scenarioD();
  const e = await scenarioE();
  const f = await scenarioF();
  const g = await scenarioG(true);
  const gControl = await scenarioG(false);
  const i = await scenarioI();

  harness(cControl.resultEvent.finalCloseUnknown === false && cControl.resultEvent.extensionsAfterLastBid === 1,
    `c-control: finalCloseUnknown ${cControl.resultEvent.finalCloseUnknown}, extensionsAfterLastBid ${cControl.resultEvent.extensionsAfterLastBid}, expected false and 1`);
  harness(gControl.resultEvent.leadAfterLastBid === true,
    `g-control: leadAfterLastBid ${gControl.resultEvent.leadAfterLastBid} without a restart, expected true`);

  const at1230 = closed(clock(12, 30, 0));
  const at1232 = closed(clock(12, 32, 0), clock(12, 30));

  // Mechanism (red on the unfixed tree).
  for (const [name, out, spec] of [['a restart', a, at1230], ['b re-price', b, at1230], ['c moved close, restart', c, at1232]]) {
    for (const [variant, text] of variants(out)) {
      check('F1 last-bid facts survive', `${name} ${variant}: expected line "${spec.label} ... ${spec.value}" and no unknown-close line`,
        hasLine(text, spec) && !lines(text).some((l) => UNKNOWN_RE.test(l)), text);
    }
  }
  for (const [name, out] of [['a restart', a], ['b re-price', b], ['c moved close, restart', c]]) {
    check('F1 engine flag', `${name}: auction_result.finalCloseUnknown is ${out.resultEvent.finalCloseUnknown}, expected false`,
      out.resultEvent.finalCloseUnknown === false);
  }

  // Guards (green on the unfixed tree, must stay green).
  for (const [variant, text] of variants(d)) {
    check('F1 guard d', `d no restart ${variant}: expected line "${at1230.label} ... ${at1230.value}" and no unknown-close line`,
      hasLine(text, at1230) && !lines(text).some((l) => UNKNOWN_RE.test(l)), text);
  }
  check('F1 guard d', `d no restart: finalCloseUnknown is ${d.resultEvent.finalCloseUnknown}, expected false`,
    d.resultEvent.finalCloseUnknown === false);
  const unknownSpec = unknownClose(clock(12, 30));
  for (const [name, out] of [['e landed inside the window', e], ['f intent without last-bid facts', f], ['i write landed after retire', i]]) {
    check(`F1 guard ${name[0]}`, `${name}: finalCloseUnknown is ${out.resultEvent.finalCloseUnknown}, expected true`,
      out.resultEvent.finalCloseUnknown === true);
    for (const [variant, text] of variants(out)) {
      check(`F1 guard ${name[0]}`, `${name} ${variant}: expected line "${unknownSpec.label} ... ${unknownSpec.value}"`,
        hasLine(text, unknownSpec), text);
    }
  }
  check('F1 guard g', `g restart after losing rank 1: leadAfterLastBid is ${g.resultEvent.leadAfterLastBid}, must not be false`,
    g.resultEvent.leadAfterLastBid !== false);
  check('F1 guard g', `g restart after losing rank 1: resultReason is ${g.record.resultReason}, must not be lost_on_timing`,
    g.record.resultReason !== 'lost_on_timing');
  const cExt = c.resultEvent.extensionsAfterLastBid;
  check('F1 guard h', `c moved close, restart: extensionsAfterLastBid is ${cExt}, expected null or the no-restart 1`,
    cExt == null || cExt === cControl.resultEvent.extensionsAfterLastBid);

  if (failures.length) {
    for (const x of failures) console.log(x);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - F1: our last landed bid's facts live in memory only, so a restart `
      + 'or re-price reads them as missing and a known soft close is reported as possibly run past');
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
  for (const f of CLEAN) {
    for (const x of [f, `${f}.tmp`, `${f}.bak`]) { try { fs.unlinkSync(x); } catch (_) {} }
  }
  process.exit(code);
});
