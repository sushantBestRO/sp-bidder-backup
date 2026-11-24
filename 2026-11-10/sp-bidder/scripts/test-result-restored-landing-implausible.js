'use strict';
/**
 * A last-landed record on the durable intent whose close is not a plausible time is no record at all.
 *
 * Regression target: N1 (the restore half of F1). The accept path persists the facts about our last
 * landed bid as `lastLanded` on the intent, and arm() restores them after a restart or re-price.
 *
 * THE DEFECT. The restore checked each field's TYPE but not its plausibility, unlike every other close
 * the engine reads back from disk (plausibleCloseAt: never 1970, never SuperProcure's year-2100
 * placeholder). So a corrupt or hand-edited record was restored as if it were facts:
 *   - on an allowlisted SuperProcure soft close, an object of junk restores as a last bid with no
 *     close, which reads as "the terminal round was not on our close" and states the close as known,
 *     where an intent with no record at all says the close may have run past;
 *   - on a GoComet soft-off load, a junk close becomes the baseline of the extension count, and the
 *     receipt reads "Extended 5985489 times after our last bid".
 *
 * WHAT MUST NOT MOVE (green before the fix too): the same restarts with the record as the engine wrote
 * it state the SuperProcure close as known and count the GoComet extension once.
 *
 * Offline and deterministic: fake adapters, temp-file DurableScheduler under os.tmpdir(), stubbed
 * Date.now, rand pinned, timers cleared after every tick, events fed through a real BidLogger on a
 * memory store, then the shared renderer.
 *
 *   node scripts/test-result-restored-landing-implausible.js
 */
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');

const { istAt, renderResult } = h;

const REAL_NOW = Date.now;
let vnow = REAL_NOW();
Date.now = () => vnow;

const CLEAN = [];
const ENGINES = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');

function harness(cond, msg) {
  if (!cond) throw new Error(`HARNESS: ${msg}`);
}

function baseRig(tag, { capabilities, allow, config, frameFor, finalRank = null }) {
  const file = path.join(os.tmpdir(), `result-restored-landing-implausible-${tag}-${process.pid}.json`);
  CLEAN.push(file);
  const ctrl = { frame: null, reads: 0, finalRank };
  const wire = [];
  const events = [];
  const adapter = {
    capabilities: () => capabilities,
    ensureSession: async () => ({}),
    async getAuctionState() {
      ctrl.reads += 1;
      if (!ctrl.frame) return { ok: false, error: 'no frame' };
      return ctrl.reads > 1 && ctrl.finalRank != null ? { ...ctrl.frame, myRank: ctrl.finalRank } : { ...ctrl.frame };
    },
    async placeBid(id, price) {
      wire.push({ countdown: ctrl.frame.closesInMs, price });
      vnow += 250;
      return { accepted: true, myRank: null, revisionsLeft: null, latencyMs: 250 };
    },
  };
  const boot = () => {
    const eng = new BidEngine(adapter, new DurableScheduler(file), {
      config: { floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0, softOpenJitterMs: 0, ...config },
      softClose: { enabled: true, shippers: [allow], mode: 'live', reserve: 1, establishLeadMs: 100_000 },
      onEvent: (e) => events.push(e), log: quiet, rand: () => 0,
    });
    ENGINES.push(eng);
    return eng;
  };
  const unTimer = (m) => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };
  const st = { eng: boot(), m: null, id: null };
  const tick = async (at, closeAt, extra = {}) => {
    vnow = at;
    ctrl.frame = { ...frameFor(closeAt), ...extra };
    ctrl.reads = 0;
    await st.eng._tick(st.m);
    unTimer(st.m);
  };
  // tamper(landed) returns the record to leave on disk, or undefined to leave the one the engine wrote.
  const restart = async (at, tamper) => {
    st.eng.kill('restart');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    harness(Array.isArray(raw.intents) && raw.intents.length === 1, `${tag}: the intents file does not hold the one intent`);
    harness(raw.intents[0].lastLanded && typeof raw.intents[0].lastLanded === 'object',
      `${tag}: the engine persisted no last-landed record to tamper with`);
    const next = tamper(raw.intents[0].lastLanded);
    if (next !== undefined) raw.intents[0].lastLanded = next;
    fs.writeFileSync(file, JSON.stringify(raw));
    st.eng = boot();
    vnow = at;
    const resumed = await st.eng.rehydrate();
    const old = st.m;
    st.m = st.eng.monitors.get(st.id);
    harness(resumed === 1 && st.m && st.m !== old, `${tag}: rehydrate resumed ${resumed}`);
    unTimer(st.m);
  };
  return { tag, ctrl, wire, events, st, boot, unTimer, tick, restart };
}

async function result(r, platformKey = null) {
  const store = createStore({ backend: 'memory' });
  const logger = new BidLogger({ store, log: () => {} });
  for (const e of r.events) await logger.handle(e);
  const resultEvent = r.events.find((e) => e.type === 'auction_result' && String(e.auctionId) === r.st.id);
  harness(resultEvent, `${r.tag}: the engine emitted no auction_result`);
  const record = await store.getDoc('closedBids', r.st.id);
  const full = await renderResult({ record, resultEvent, platformKey });
  const short = await renderResult({ record, resultEvent, platformKey, short: true });
  return { resultEvent, text: `${full.text}\n${short.text}` };
}

// Allowlisted SuperProcure soft close: the establish lands ~200 s out (100 s window), restart, the
// countdown then sits at zero and the sustained-zero path finalizes.
const C0 = istAt(2026, 9, 23, 12, 30, 0);
async function spSoft(tag, tamper) {
  const r = baseRig(tag, {
    capabilities: { standingPriceVisible: false, minDecrement: 100, allowsTieRate: false, revisionLimit: null,
      closeModel: 'unknown', biddingEnabled: true, platformLabel: 'SuperProcure' },
    allow: 'Dynamic Cables', config: { openAtMs: 25_000 }, finalRank: 8,
    frameFor: (closeAt) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: closeAt,
      closesInMs: Math.max(0, closeAt - Date.now()), extendMs: 120_000, extendCount: null, triggerWindowMs: 100_000,
      myRank: 1, totalBidders: 9, standingL1Price: null, revisionLimit: 3, revisionsLeft: null, minDecrement: 100, measuredRttMs: 20 }),
  });
  r.st.id = '25703191';
  vnow = C0 - 600_000;
  r.st.m = r.st.eng.arm({ id: r.st.id, lane: { origin: 'Jaipur', destination: 'Vadodara' }, units: 1,
    companyName: 'Dynamic Cables Limited', closesAt: C0 }, { cost: 31_000, marginsPct: [8, 5, 4] });
  r.unTimer(r.st.m);
  harness(r.st.m.softStrategy === 'live', `${tag}: softStrategy ${r.st.m.softStrategy}, not live`);
  for (const c of [300_000, 250_000, 200_000]) await r.tick(C0 - c, C0);
  harness(r.wire.length === 1 && r.wire[0].countdown - 250 > 100_000, `${tag}: the establish did not land outside the window`);
  await r.restart(C0 - 190_000, tamper);
  for (const c of [150_000, 120_000, 90_000, 60_000, 30_000, 10_000, 4_000, 2_000, 1_000]) await r.tick(C0 - c, C0);
  for (let t = 0; !r.st.m.finalized && t <= 130_000; t += 1_000) await r.tick(C0 + t, C0, t >= 120_000 ? { status: 'closed' } : {});
  harness(r.st.m.finalized, `${tag}: never finalized`);
  harness(r.wire.length === 1, `${tag}: ${r.wire.length} accepted writes, expected the one establish`);
  return result(r);
}

// GoComet soft-off: bids land against 21:30, restart, one published 299 s extension, finalize.
const P = istAt(2026, 9, 17, 21, 30, 0);
async function gocomet(tag, tamper) {
  const r = baseRig(tag, {
    capabilities: { standingPriceVisible: false, minDecrement: 500, allowsTieRate: false, revisionLimit: 3,
      closeModel: 'soft', reactiveClose: true, snipeBudgetMs: 3000 },
    allow: 'Allowlisted', config: { openAtMs: 15_000 },
    frameFor: (closeAt) => ({ ok: true, status: 'live', closeModel: 'soft', closesAtMs: closeAt,
      closesInMs: Math.max(0, closeAt - Date.now()), extendMs: 299_000, extendCount: null,
      myRank: r.wire.length ? 2 : null, totalBidders: r.wire.length ? 4 : null, standingL1Price: null, measuredRttMs: 20 }),
  });
  r.st.id = '2609173132';
  vnow = P - 600_000;
  r.st.m = r.st.eng.arm({ id: r.st.id, lane: { origin: 'Degam', destination: 'Akola' }, equipment: '32ft SXL', units: 1,
    quoteType: 'FTL', companyName: 'Waaree Energies Ltd.', closesAt: P, platformKey: 'gocomet',
    rules: { revisionLimit: 3, minDecrement: 500 } }, { cost: 48_000, marginsPct: [12.6, 7.2, 6.3] });
  r.unTimer(r.st.m);
  harness(r.st.m.softStrategy === 'off', `${tag}: softStrategy ${r.st.m.softStrategy}, not off`);
  for (let k = 595; k >= 4; k -= (k > 30 ? 5 : 1)) {
    const at = P - k * 1000 - 600;
    if (vnow <= at) await r.tick(at, P);
  }
  harness(r.wire.length >= 1, `${tag}: no bid landed`);
  await r.restart(vnow + 500, tamper);
  await r.tick(P, P + 299_000);
  vnow = P + 299_000;
  const closing = { ...r.ctrl.frame, status: 'closed', closesAtMs: P + 299_000, closesInMs: 0, myRank: 2, totalBidders: 4 };
  r.ctrl.frame = closing;
  await r.st.eng._finalize(r.st.m, closing);
  r.unTimer(r.st.m);
  return result(r, 'gocomet');
}

const failures = [];
let checkNo = 0;
function check(id, desc, ok) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${id}] ${desc}`);
}

const extendedCounts = (text) => (String(text).match(/Extended (\S+) time/g) || []).map((m) => m.split(' ')[1]);

async function main() {
  const junkRows = {
    strings: () => ({ closeAt: 'abc', landingMs: 'x', triggerWindowMs: 'y', incrementMs: 'z', countdownMs: 'w', heldRank1: 'yes' }),
    arrayOfObject: () => [{ closeAt: 1 }],
    negativeClose: (l) => ({ ...l, closeAt: -5 }),
  };

  const spControl = await spSoft('sp-control', () => undefined);
  harness(spControl.resultEvent.finalCloseUnknown === false, 'sp-control: the untampered restart did not state the close');
  check('N1 control', 'SuperProcure restart with the record as written states the close', spControl.resultEvent.finalCloseUnknown === false);
  for (const [name, junk] of Object.entries(junkRows)) {
    const out = await spSoft(`sp-${name}`, junk);
    check('N1 SuperProcure', `${name}: finalCloseUnknown is ${out.resultEvent.finalCloseUnknown}, expected true (an implausible record is no record)`,
      out.resultEvent.finalCloseUnknown === true);
  }

  const gcControl = await gocomet('gc-control', () => undefined);
  harness(gcControl.resultEvent.extensionsAfterLastBid === 1, `gc-control: extensionsAfterLastBid ${gcControl.resultEvent.extensionsAfterLastBid}, expected 1`);
  check('N1 control', 'GoComet restart with the record as written counts one extension', gcControl.resultEvent.extensionsAfterLastBid === 1);
  const gcJunk = await gocomet('gc-negative-close', junkRows.negativeClose);
  const n = gcJunk.resultEvent.extensionsAfterLastBid;
  check('N1 GoComet', `negative close: extensionsAfterLastBid is ${n}, expected null or 1`, n == null || n === 1);
  const counts = extendedCounts(gcJunk.text);
  check('N1 GoComet', `negative close: the receipt reads "Extended ${counts.join('/')} time(s)"`, counts.every((c) => c === '1'));

  if (failures.length) {
    for (const f of failures) console.log(ascii(f));
    console.log(`FAILED ${failures.length} of ${checkNo} checks - N1: a restored last-landed record with an implausible close is treated as facts`);
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
