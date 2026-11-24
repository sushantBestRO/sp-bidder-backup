'use strict';
/**
 * A real engine run produces the stamps the result receipt needs, and the receipt it leads to states
 * attempts, the gap to the actual final close at landing, the dated close with its posted time, and
 * the extensions after our last bid.
 *
 * Regression target: BC-30 (attempts missing from results) and BC-31 (gap between last bid and close
 * wrong on extended auctions), the ENGINE half; timing diagnosis 2026-09-24 (timing-D) M1/M2/M3/M8,
 * plan PR-T6 plus B.0 items 2, 3 and 4.
 *
 * THE DEFECT. The receipt tests beside this one build their bid and result events by hand, so a
 * template-only fix turns them green while the engine never emits what the receipt reads:
 * bid_placed carries no decidedAt (the landing gap cannot be derived), auction_result carries no
 * attemptsAllowed, no extensionsAfterLastBid and no postedCloseAt. On top of that the durable
 * intent's closesAt is advanced by every observed extension (W1-6), so after a restart the posted
 * close is gone unless it was persisted separately at first arm (B.0 item 3).
 *
 * THE RUN. Real BidEngine, fake GoComet-like adapter, temp-file DurableScheduler, stubbed Date.now,
 * every engine event fed live and in order through a real BidLogger on a memory store, the record
 * and the engine's own auction_result rendered by the real notify path (lib/result-receipt-harness).
 * Posted close P = 17 Sep 2026 09:30:00 pm IST. Round-0 frames are served at countdowns of k.6 s
 * (every 5 s down to 30.6 s, then every 1 s down to 4.6 s); the fake placeBid advances the clock
 * 3,600 ms before accepting at rank 2, so every landing gap is a whole number of seconds and every
 * accept lands on a whole-second clock (no rounding enters any expected value). After our last bid:
 *   E1 - the close extends twice, one 300 s frame each (P+300 s, then P+600 s).
 *   E2 - one frame spans both extensions (a skipped poll: the close jumps 600 s). A count derived per
 *        observed move reads 1; the receipt must read 2 (B.0 item 2).
 *   E3 - E1 with a restart after the first extension: a new BidEngine on the SAME intents file,
 *        brought back by rehydrate() (the GoComet boot path, server.js rehydrateGoCometStack), then
 *        the second extension. The posted suffix must still read 09:30 pm (B.0 item 3).
 * No frame is served inside the last seconds of an extended round and _finalize is called directly
 * (a soft close only finalizes after a sustained zero), so no bid can follow the extensions under
 * any policy that bids only in a round's last seconds.
 *
 * EXPECTED FACTS come from the STUB's log (the frame each accepted bid was decided on and the instant
 * the accept returned), not from engine internals, so they hold whatever PR-T2a does to when GoComet
 * bids: n = accepted placeBid calls; landing gap = close in force at the decision - accept instant;
 * gap to final = final close - accept instant; extensions = (final close - close in force) / 300 s.
 * Gap wording rule (brief): one decimal under 10 s, whole seconds under 2 min, "X min Y s" above.
 *
 * WHAT MUST NOT MOVE (controls, green on the unfixed tree, HARNESS: on failure): the engine placed at
 * least one accepted bid and emitted a bid_placed for each; it emitted an auction_result at rank 2;
 * the believed close followed the extensions (auction_result.finalCloseAt = P+600 s, W1-6); the
 * rendered text is the lost receipt for this load with every accepted bid on the record.
 *
 * Wording comes from scripts/fixtures/result-receipt-copy.js; this file owns only the facts.
 * Offline and deterministic: no network, no sleeps, rand pinned to 0, temp files under os.tmpdir().
 *
 *   node scripts/test-receipt-engine-stamps.js
 */
const h = require('./lib/result-receipt-harness');
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { createStore } = require('../src/store');
const { BidLogger } = require('../src/logging/bidLogger');
const { gap, clock, attempts, lastBid, lastBidRound, closed, extensions } = require('./fixtures/result-receipt-copy');

const { istAt, renderResult, hasLine, IST_OFFSET_MS } = h;

const P = istAt(2026, 9, 17, 21, 30, 0);
const EXTEND_MS = 300_000;
const WRITE_MS = 3_600;
const CAP = 3;
const CUSTOMER = 'Waaree Energies Ltd.';

const REAL_NOW = Date.now;
let vnow = P - 600_000;
Date.now = () => vnow;

const CLEAN = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?');

class HarnessError extends Error {}
function harness(cond, msg) {
  if (!cond) throw new HarnessError(`HARNESS: ${msg}`);
}

function istClock(ms, withSeconds = true) {
  const d = new Date(ms + IST_OFFSET_MS);
  return clock(d.getUTCHours(), d.getUTCMinutes(), withSeconds ? d.getUTCSeconds() : null);
}

function gapText(ms) {
  const s = ms / 1000;
  if (s < 10) return gap.tenths(s);
  const whole = Math.round(s);
  if (whole < 120) return gap.secs(whole);
  return gap.minSec(Math.floor(whole / 60), whole % 60);
}

function rig(id) {
  const file = path.join(os.tmpdir(), `receipt-engine-stamps-${process.pid}-${id}.json`);
  CLEAN.push(file);
  const store = createStore({ backend: 'memory' });
  const events = [];
  const stub = { frame: null, served: null, bids: [] };
  let feed = Promise.resolve();

  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 500, allowsTieRate: false,
      revisionLimit: CAP, closeModel: 'soft', reactiveClose: true, snipeBudgetMs: 3000 }),
    async getAuctionState() {
      if (!stub.frame) return { ok: false, error: 'no frame' };
      stub.served = { ...stub.frame };
      return { ...stub.frame };
    },
    async placeBid(auctionId, price) {
      const decidedAt = Date.now();
      const served = stub.served;
      vnow += WRITE_MS;
      stub.bids.push({ price, decidedAt, closesInMs: served.closesInMs, closeInForce: served.closesAtMs, acceptedAt: vnow });
      return { accepted: true, myRank: 2, revisionsLeft: Math.max(0, CAP - stub.bids.length), latencyMs: WRITE_MS };
    },
  };

  const boot = () => {
    const logger = new BidLogger({ store, log: () => {} });
    return new BidEngine(adapter, new DurableScheduler(file), {
      config: { openAtMs: 15_000, floorWindowMs: 2_500, minInterFireMs: 0, cadenceJitterMs: 0, openJitterMs: 0,
        softOpenJitterMs: 0 },
      softClose: { enabled: true, shippers: ['Allowlisted'], mode: 'live', reserve: 1 },
      rand: () => 0,
      onEvent: (e) => { events.push(e); feed = feed.then(() => logger.handle(e)); },
      log: quiet,
    });
  };

  const frame = (closesAtMs) => {
    const bid = stub.bids.length > 0;
    return { ok: true, status: 'live', closeModel: 'soft', closesAtMs, closesInMs: closesAtMs - Date.now(),
      extendMs: EXTEND_MS, extendCount: null, myRank: bid ? 2 : null, totalBidders: bid ? 4 : null,
      standingL1Price: null, measuredRttMs: 20 };
  };
  const unTimer = (m) => { if (m && m.timer) { clearTimeout(m.timer); m.timer = null; } };
  const tick = async (eng, m, closesAtMs) => {
    stub.frame = frame(closesAtMs);
    await eng._tick(m);
    unTimer(m);
  };

  const arm = (eng) => {
    vnow = P - 600_000;
    const m = eng.arm({
      id, lane: { origin: 'Degam', destination: 'Akola' }, equipment: '32ft SXL', units: 1,
      quoteType: 'FTL', companyName: CUSTOMER, closesAt: P, platformKey: 'gocomet',
      rules: { revisionLimit: CAP, minDecrement: 500 },
    }, { cost: 48_000, marginsPct: [12.6, 7.2, 6.3] });
    unTimer(m);
    harness(m.softStrategy === 'off', `${id}: '${CUSTOMER}' resolved softStrategy '${m.softStrategy}', expected 'off'`);
    return m;
  };

  const roundZero = async (eng, m) => {
    const marks = [];
    for (let k = 595; k >= 30; k -= 5) marks.push(k);
    for (let k = 29; k >= 4; k -= 1) marks.push(k);
    for (const k of marks) {
      const at = P - k * 1000 - 600;
      if (vnow > at) continue;
      vnow = at;
      await tick(eng, m, P);
    }
  };

  const finalize = async (eng, m, finalClose) => {
    vnow = finalClose;
    const closing = { ...frame(finalClose), status: 'closed', myRank: 2, totalBidders: 4 };
    stub.frame = closing;
    await eng._finalize(m, closing);
    unTimer(m);
  };

  const settle = async () => {
    await feed;
    const resultEvent = events.find((e) => e.type === 'auction_result' && String(e.auctionId) === id) || null;
    const record = await store.getDoc('closedBids', id);
    return { resultEvent, record };
  };

  return { id, stub, events, boot, arm, tick, roundZero, finalize, settle, unTimer };
}

async function runE1() {
  const r = rig('260917E1RC');
  const eng = r.boot();
  const m = r.arm(eng);
  await r.roundZero(eng, m);
  vnow = P;
  await r.tick(eng, m, P + EXTEND_MS);
  vnow = P + EXTEND_MS;
  await r.tick(eng, m, P + 2 * EXTEND_MS);
  await r.finalize(eng, m, P + 2 * EXTEND_MS);
  try { eng.kill('test done'); } catch (_) {}
  return { r, ...(await r.settle()) };
}

async function runE2() {
  const r = rig('260917E2RC');
  const eng = r.boot();
  const m = r.arm(eng);
  await r.roundZero(eng, m);
  vnow = P + EXTEND_MS;
  await r.tick(eng, m, P + 2 * EXTEND_MS);
  await r.finalize(eng, m, P + 2 * EXTEND_MS);
  try { eng.kill('test done'); } catch (_) {}
  return { r, ...(await r.settle()) };
}

async function runE3() {
  const r = rig('260917E3RC');
  const eng1 = r.boot();
  const m1 = r.arm(eng1);
  await r.roundZero(eng1, m1);
  vnow = P;
  await r.tick(eng1, m1, P + EXTEND_MS);
  vnow = P + 10_000;
  eng1.kill('process restart');
  const eng2 = r.boot();
  const rearmed = await eng2.rehydrate();
  const m2 = eng2.monitors.get(r.id);
  r.unTimer(m2);
  harness(rearmed === 1 && m2 && m2.finalized === false,
    `E3: rehydrate() re-armed ${rearmed} load(s) and the monitor is ${m2 ? `finalized=${m2.finalized}` : 'missing'}`);
  vnow = P + EXTEND_MS;
  await r.tick(eng2, m2, P + 2 * EXTEND_MS);
  await r.finalize(eng2, m2, P + 2 * EXTEND_MS);
  try { eng2.kill('test done'); } catch (_) {}
  return { r, ...(await r.settle()) };
}

async function controls(name, run, finalClose) {
  const { r, resultEvent, record } = run;
  const bids = r.stub.bids;
  harness(bids.length >= 1, `${name}: the engine placed no accepted bid on the fake adapter`);
  const placed = r.events.filter((e) => e.type === 'bid_placed');
  harness(placed.length === bids.length
    && placed.every((e, i) => e.closesInMs === bids[i].closesInMs && e.ts === bids[i].acceptedAt),
  `${name}: ${bids.length} accepted placeBid call(s) but ${placed.length} matching bid_placed event(s)`);
  harness(!!resultEvent, `${name}: the engine emitted no auction_result`);
  harness(resultEvent.won === false && resultEvent.finalRank === 2,
    `${name}: auction_result won=${resultEvent.won} finalRank=${resultEvent.finalRank}, expected a loss at rank 2`);
  harness(resultEvent.finalCloseAt === finalClose,
    `${name}: auction_result.finalCloseAt ${resultEvent.finalCloseAt} is not the last published close ${finalClose} - the extension frames did not reach the believed close (W1-6)`);
  harness(record && Array.isArray(record.ourBids) && record.ourBids.length === bids.length,
    `${name}: the closed-bids record holds ${record && record.ourBids ? record.ourBids.length : 'no'} bid(s), the stub accepted ${bids.length}`);

  const last = bids[bids.length - 1];
  const landingMs = last.closeInForce - last.acceptedAt;
  const extTotal = finalClose - last.closeInForce;
  harness(landingMs > 0 && landingMs % 1000 === 0 && last.acceptedAt % 1000 === 0,
    `${name}: the last accept landed ${landingMs} ms before its close at ${last.acceptedAt} - not a positive whole-second gap, the tick grid is off`);
  harness(extTotal === 2 * EXTEND_MS,
    `${name}: the close in force at our last bid was ${last.closeInForce}, ${extTotal} ms short of the final close - expected two 300 s extensions after our last bid (did the engine bid after an extension frame?)`);

  const rendered = await renderResult({ record, resultEvent, platformKey: 'gocomet' });
  harness(rendered.kind === 'lost' && rendered.template === 'lost',
    `${name}: receipt routed as ${rendered.kind}/${rendered.template}, not lost/lost`);
  harness(rendered.text.includes(CUSTOMER), `${name}: the lost receipt does not name ${CUSTOMER}`);

  return { bids, last, landingMs, gapFinalMs: finalClose - last.acceptedAt, extCount: extTotal / EXTEND_MS,
    placed, resultEvent, text: rendered.text };
}

const failures = [];
let checkNo = 0;
function check(mechanism, desc, ok, detail) {
  checkNo += 1;
  if (!ok) failures.push(`FAIL ${checkNo} [${mechanism}] ${desc} -- ${ascii(detail)}`);
}
const timingLines = (text) => String(text || '').split('\n')
  .filter((l) => /close|last bid|extend|attempt/i.test(l)).map(ascii).join(' | ') || '(no timing lines)';

function lineChecks(name, c, finalClose) {
  const specs = [
    ['BC-30 attempts used of allowed', attempts(c.bids.length, CAP)],
    // CW-267: the close moved after our last bid, so the gap is to that bid's own round close.
    ['CW-267 gap to the round close the bid landed in', lastBidRound(gapText(c.landingMs), istClock(c.last.acceptedAt))],
    ['BC-31 close with seconds and posted close', closed(istClock(finalClose), clock(21, 30))],
    ['BC-31 extensions after our last bid stated', extensions(c.extCount)],
  ];
  for (const [mech, spec] of specs) {
    check(mech, `${name}: expected line "${spec.label ? `${spec.label} ... ` : ''}${spec.value}"`,
      hasLine(c.text, spec), `rendered: ${timingLines(c.text)}`);
  }
}

function stampChecks(name, c) {
  const lastPlaced = c.placed[c.placed.length - 1];
  check('engine stamp bid_placed.decidedAt', `${name}: the last bid_placed carries decidedAt = ${c.last.decidedAt} (the instant the write went out)`,
    lastPlaced.decidedAt === c.last.decidedAt, `got ${lastPlaced.decidedAt}`);
  check('engine stamp auction_result.attemptsAllowed', `${name}: auction_result.attemptsAllowed = ${CAP}`,
    c.resultEvent.attemptsAllowed === CAP, `got ${c.resultEvent.attemptsAllowed}`);
  check('engine stamp auction_result.extensionsAfterLastBid', `${name}: auction_result.extensionsAfterLastBid = ${c.extCount}`,
    c.resultEvent.extensionsAfterLastBid === c.extCount, `got ${c.resultEvent.extensionsAfterLastBid}`);
  check('engine stamp auction_result.postedCloseAt', `${name}: auction_result.postedCloseAt = ${P} (09:30:00 pm)`,
    c.resultEvent.postedCloseAt === P, `got ${c.resultEvent.postedCloseAt}`);
}

async function main() {
  const F = P + 2 * EXTEND_MS;
  const e1 = await controls('E1 two 300 s extensions', await runE1(), F);
  const e2 = await controls('E2 one frame spans both extensions', await runE2(), F);
  const e3 = await controls('E3 restart after the first extension', await runE3(), F);

  lineChecks('E1', e1, F);
  stampChecks('E1', e1);
  lineChecks('E2', e2, F);
  stampChecks('E2', e2);

  const posted = closed(istClock(F), clock(21, 30));
  check('B.0-3 posted close survives a restart', `E3: expected line "${posted.label} ... ${posted.value}"`,
    hasLine(e3.text, posted), `rendered: ${timingLines(e3.text)}`);
  check('B.0-3 posted close survives a restart', `E3: auction_result.postedCloseAt = ${P} (09:30:00 pm) after rehydrate`,
    e3.resultEvent.postedCloseAt === P, `got ${e3.resultEvent.postedCloseAt}`);

  const l = e1.last;
  console.log(`  run facts: ${e1.bids.length} accepted bid(s); last decided at countdown ${l.closesInMs} ms, `
    + `accepted ${istClock(l.acceptedAt)}; landing gap ${e1.landingMs} ms; to final close ${e1.gapFinalMs} ms`);
  return failures;
}

main().then(() => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  if (failures.length) {
    for (const f of failures) console.log(f);
    console.log(`FAILED ${failures.length} of ${checkNo} checks - BC-30/BC-31 engine half: a real GoComet run does not `
      + 'emit the decision stamp, attempt cap, extensions-after-last-bid or posted close, and the receipt it produces '
      + 'lacks the Attempts / Last bid / Closed / Extended lines');
    process.exit(1);
  }
  console.log(`PASS ${checkNo} checks`);
}, (e) => {
  Date.now = REAL_NOW;
  for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} }
  console.log(ascii(e instanceof HarnessError ? e.message : `HARNESS: threw ${e && e.stack ? e.stack : e}`));
  process.exit(1);
});
