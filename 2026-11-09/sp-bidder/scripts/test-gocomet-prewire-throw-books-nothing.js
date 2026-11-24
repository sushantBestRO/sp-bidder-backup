'use strict';
/**
 * A PRE-WIRE THROW MUST BOOK NOTHING.
 *
 * Regression target: T5 F1 (BH-LOGIC-2 + BH-CONTRACT-2), bug-hunt wave 2026-09-20, branch
 * fix/gocomet-prewire-throw-books-nothing off eeff9fd. Promoted from the reproducer
 * docs/bug-hunts/reproducers/bidcmd-2026-09-16/T5/t5contract-2-gocomet-cooldown-books-phantom-landed-bid.js,
 * with the two further shapes the merge matrix proved were a separate partial (probeA/probeB).
 *
 * THE MECHANISM, in plain words. bidEngine.placeBid's catch discriminates exactly two error codes -
 * AUTH and COST_TYPE_UNMATCHED. Every other throw falls into the handler whose own first line reads
 * "uncertain outcome - the write may have COMMITTED before the transport failed". That handler sets
 * `landed = true` and can only falsify it from a read-back's revisionsLeft, which GoComet never
 * exposes and realAdapter.getAuctionState hardcodes to null. So it books the non-event as real:
 * landedBids incremented, lastBidPrice set, a revision spent, the rung banked into firedRungs, and
 * landedBidPrice / landedBids / everBid persisted onto the DURABLE intent - so a restart rehydrates
 * the fabrication, and _mustImproveOn then refuses every later price at or above a bid the platform
 * never saw. On a live soft-close load that is the whole remaining ladder, forfeited silently.
 *
 * Four throws reach that handler with provably nothing on the wire, and none is AUTH or
 * COST_TYPE_UNMATCHED. Three of the four are GoComet's _fetchQuoteForWrite, which runs strictly
 * ABOVE the submit PUT: RATE_LIMITED (a 429 synthesised from our OWN open cooldown, no request
 * issued at all), NETWORK (the quote GET never landed), NO_QUOTE (a parsed, empty quote list). The
 * fourth is RealSuperProcureAdapter.placeBid's writeEnabled backstop, which throws WRITE_DISABLED
 * before a payload is even built.
 *
 * The contract these are measured against is the codebase's own, never the implementation body:
 *   - realAdapter.js:205  - a refusal "must throw BEFORE the bid is sent, so it degrades to 'no bid'"
 *   - realAdapter.js:2223 - "a throw out of it means the request was never dispatched: nothing was
 *                           observed by SuperProcure"
 *   - bidEngine.js:6180   - the COST_TYPE_UNMATCHED arm, on the identical shape: "no byte of this
 *                           bid left the box", and booking it "would book a landed bid that does not
 *                           exist, spend the rung and persist everBid onto the intent". Its remedy -
 *                           restore firedRungs, currentRungIndex, snipeFired, _lastDefendAtExtend,
 *                           return - is the behaviour asserted here for the other four codes.
 *
 * WHAT MUST NOT MOVE: check 1. Zero PUT/POST submits reach the wire in any of the four shapes, and
 * each adapter throws its own documented code. That control holds on the CURRENT tree as well as
 * after the fix, which is what makes a later green attributable to the repair rather than to a
 * harness that stopped exercising anything.
 *
 * Offline and deterministic: the REAL GoComet and SuperProcure adapters over an injected counting
 * fetchImpl, the REAL engine over a temp-file DurableScheduler, injected clocks, no sleeps, no
 * network, no RNG on the asserted path.
 *
 *   node scripts/test-gocomet-prewire-throw-books-nothing.js
 */
const os = require('os');
const fs = require('fs'); // allowed: test harness (temp intent files), not app state
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `gc-prewire-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

const NOW = 1_700_000_000_000;
// Far enough out to be unexpired against BOTH the fixed adapter clock above and the real wall
// clock the other two GoComet shapes run on, so neither the token nor this file has a shelf life.
const TOKEN_EXP_SEC = 4_000_000_000;
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: TOKEN_EXP_SEC, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;
const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

const httpResponse = (status, body) => ({
  status,
  headers: { get: () => null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

// Shaped after the real observed GoComet payload (same fields scripts/test-gocomet-adapter.js
// builds): ONE 11_freight_charges group with ONE freight_charges_custom_charge* line carrying its
// own units/unit_name, plus the normalized total_charges block the basis check reads. Built inline
// so nothing outside this repo is required to run the file.
const quoteDoc = () => ({
  id: 'Q1',
  charges_list: {
    '11_freight_charges': {
      display_name: 'Freight',
      freight_charges_custom_charge_40ft: { units: 1, unit_name: 'TRUCK', price: 44_000 },
    },
  },
  total_charges: { total: { units: 1.0, quote_units: 1.0, unit_name: 'TRUCK', total: 44_000 } },
});

// A fetchImpl that counts by method, so "nothing left the box" is MEASURED outside the adapter
// rather than asserted about a mock the adapter never consulted.
function countingFetch(handler) {
  const wire = { get: 0, put: 0, post: 0, total: 0 };
  const fetchImpl = async (url, init) => {
    const m = String((init && init.method) || 'GET').toUpperCase();
    wire.total += 1;
    if (m === 'GET') wire.get += 1; else if (m === 'PUT') wire.put += 1; else if (m === 'POST') wire.post += 1;
    return handler(url, init);
  };
  return { fetchImpl, wire };
}

const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];
const ARMED_REVISIONS = 30;

function mkEngine(storePath, readBack) {
  const events = [];
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'unknown' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => readBack,
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  const eng = new BidEngine(adapter, new DurableScheduler(storePath), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
    log: silentLog,
  });
  eng._events = events;
  return eng;
}

function armFine(eng, id) {
  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = LADDER[LADDER.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = ARMED_REVISIONS;
  m.triggerWindowMs = 100_000;
  return m;
}

const state = (remaining, myRank) => ({ closesInMs: remaining, myRank, minDecrement: 100,
  standingL1Price: null, measuredRttMs: 50 });

async function driveMaybeBid(eng, m, { from, to, rank }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < 20_000) {
      await eng._maybeBid(m, state(r, rank));
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

/**
 * Arm one load, let the engine drive itself into a single bid attempt that throws above the wire,
 * and return what the engine recorded for that non-event. `build` does its own setup (opening a
 * cooldown, logging in) BEFORE the wire counter is snapshotted, so the counter measures the bid
 * attempt alone.
 */
async function bookedAfterPreWireThrow(id, readBack, build) {
  const storePath = tmp();
  const eng = mkEngine(storePath, readBack);
  const { placeBid, wire } = await build();
  const thrown = { code: null, localCooldown: null };
  eng.adapter.placeBid = async (auctionId, price, opts) => {
    try { return await placeBid(auctionId, price, opts); }
    catch (e) { thrown.code = e && e.code; thrown.localCooldown = e && e.localCooldown; throw e; }
  };
  const m = armFine(eng, id);
  // The pre-fire value the give-back arm has to restore. Captured rather than hardcoded so
  // "currentRungIndex restored" is asserted against what arming actually produced (-1 today).
  const armedRungIndex = m.currentRungIndex;
  const before = { get: wire.get, put: wire.put, post: wire.post, total: wire.total };
  await driveMaybeBid(eng, m, { from: 126_739, to: 120_000, rank: 4 });

  // Read the durable intent back through a FRESH scheduler over the same store file - that is what
  // a restart rehydrates from, and it is the only reader that can prove the fabrication is durable
  // rather than an artefact of the in-process object.
  const intent = new DurableScheduler(storePath).get(id) || {};
  return {
    id,
    armedRungIndex,
    thrownCode: thrown.code,
    thrownLocalCooldown: thrown.localCooldown,
    submitsDuringBid: (wire.put - before.put) + (wire.post - before.post),
    fetchesDuringBid: wire.total - before.total,
    landedBids: m.landedBids,
    lastBidPrice: m.lastBidPrice,
    firedRungs: [...m.firedRungs].sort((a, b) => a - b),
    currentRungIndex: m.currentRungIndex,
    revisionsLeft: m.revisionsLeft,
    // Normalised so a repair that writes an explicit 0/null/30 rather than leaving the key absent
    // passes on the CLAIM instead of tripping on the fixture's key shape.
    durableLandedBids: Number(intent.landedBids || 0),
    durableLandedBidPrice: intent.landedBidPrice == null ? null : intent.landedBidPrice,
    durableEverBid: !!intent.everBid,
    durableFiredRungs: Array.isArray(intent.firedRungs) ? [...intent.firedRungs].sort((a, b) => a - b) : [],
    durableRevisionsLeft: intent.revisionsLeft == null ? ARMED_REVISIONS : intent.revisionsLeft,
    mustImproveOn: eng._mustImproveOn(m),
  };
}

// currentRungIndex rides the matrix because restoring firedRungs without it still permanently
// closes _decide's establish branch, and durable firedRungs/revisionsLeft ride it because
// rehydrate() rebuilds currentRungIndex from the stored array on the next restart - which
// scripts/deploy.sh performs on every deploy.
const booksNothing = (s) => ({
  landedBids: 0, lastBidPrice: null, firedRungs: [], currentRungIndex: s.armedRungIndex,
  revisionsLeft: ARMED_REVISIONS, durableLandedBids: 0, durableLandedBidPrice: null,
  durableEverBid: false, durableFiredRungs: [], durableRevisionsLeft: ARMED_REVISIONS,
  mustImproveOn: null,
});
const booking = (s) => ({
  landedBids: s.landedBids, lastBidPrice: s.lastBidPrice, firedRungs: s.firedRungs,
  currentRungIndex: s.currentRungIndex, revisionsLeft: s.revisionsLeft,
  durableLandedBids: s.durableLandedBids, durableLandedBidPrice: s.durableLandedBidPrice,
  durableEverBid: s.durableEverBid, durableFiredRungs: s.durableFiredRungs,
  durableRevisionsLeft: s.durableRevisionsLeft, mustImproveOn: s.mustImproveOn,
});
const WHY = (code, how) =>
  `${code}: ${how}. Nothing left the box, so the engine may book NOTHING. The catch at `
  + 'bidEngine.js:6208 discriminates only AUTH and COST_TYPE_UNMATCHED, so this pre-wire refusal '
  + 'falls into the "the write may have COMMITTED" handler, whose `landed` starts true and cannot '
  + 'be falsified without a read-back revisionsLeft that neither platform supplies. A bid that was '
  + 'never sent is booked as LANDED: landedBids incremented, lastBidPrice set, the rung banked into '
  + 'firedRungs and currentRungIndex, a revision spent, and landedBids/landedBidPrice/everBid/'
  + 'firedRungs/revisionsLeft all persisted onto the DURABLE intent - so a restart rehydrates the '
  + 'phantom and _mustImproveOn refuses every later price at or above a bid the board does not hold.';

// The four shape checks are evaluated, reported and only THEN rethrown, so one run diagnoses a
// partial fix (quote path repaired, realAdapter not) instead of stopping at the first shape. The
// FIRST captured error is what propagates, so the failure line and its call site are unchanged.
const deferred = [];
function checkShape(n, s, why) {
  try {
    assert.deepStrictEqual(booking(s), booksNothing(s), why);
    ok(n);
  } catch (e) {
    if (e instanceof assert.AssertionError) { console.log('  BOOKED  ' + s.id + ' (' + s.thrownCode + ') - ' + n); deferred.push(e); }
    else throw e;
  }
}

(async () => {
  // GoComet's own cooldown is global adapter state opened by an UNRELATED read, exactly the case
  // gocometAdapter.js:2157-2160 describes. The 429 that opens it is the recorded shape: status 429,
  // empty body, no retry-after.
  const rateLimited = await bookedAfterPreWireThrow('GC-RL', { ok: false }, async () => {
    const { fetchImpl, wire } = countingFetch((url, init) => (
      (init && init.method) === 'GET' && String(url).includes('/quotes')
        ? httpResponse(200, [quoteDoc()])
        : httpResponse(200, { data: { quote_rank: 1 } })));
    const gc = new GoCometAdapter({ token: token(), bidEnabled: true, now: () => NOW,
      sleep: async () => {}, log: silentLog, fetchImpl: async () => { wire.total += 1; wire.get += 1; return httpResponse(429, ''); } });
    await gc.login();
    await gc.getAuctionState('SOME-OTHER-ENQUIRY'); // the background poll that trips the cooldown
    gc.fetchImpl = fetchImpl;                       // from here the wire is HEALTHY
    return { wire, placeBid: (id, price, opts) => gc.placeBid(id, price, opts) };
  });

  const network = await bookedAfterPreWireThrow('GC-NET', { ok: false }, async () => {
    const { fetchImpl, wire } = countingFetch(() => { throw new Error('ECONNRESET'); });
    const gc = new GoCometAdapter({ token: token(), bidEnabled: true, sleep: async () => {},
      log: silentLog, fetchImpl });
    await gc.login();
    return { wire, placeBid: (id, price, opts) => gc.placeBid(id, price, opts) };
  });

  const noQuote = await bookedAfterPreWireThrow('GC-NQ', { ok: false }, async () => {
    const { fetchImpl, wire } = countingFetch((url, init) => (
      (init && init.method) === 'GET' && String(url).includes('/quotes')
        ? httpResponse(200, [])
        : httpResponse(404, {})));
    const gc = new GoCometAdapter({ token: token(), bidEnabled: true, sleep: async () => {},
      log: silentLog, fetchImpl });
    await gc.login();
    return { wire, placeBid: (id, price, opts) => gc.placeBid(id, price, opts) };
  });

  // The SuperProcure half. ok:true with revisionsLeft null is what realAdapter.getAuctionState
  // really returns, and it is the read-back the handler tries and fails to falsify `landed` with.
  const writeDisabled = await bookedAfterPreWireThrow('SP-WD', { ok: true, myRank: 4, revisionsLeft: null }, async () => {
    const { fetchImpl, wire } = countingFetch(() => httpResponse(201, {}));
    const sp = new RealSuperProcureAdapter({ token: 'x', fetchImpl, sleep: async () => {},
      authProbeEnabled: false });
    sp.writeEnabled = false; // the kill-switch backstop
    return { wire, placeBid: (id, price, opts) => sp.placeBid(id, price, opts) };
  });

  const SHAPES = [
    [rateLimited, 'RATE_LIMITED'], [network, 'NETWORK'], [noQuote, 'NO_QUOTE'], [writeDisabled, 'WRITE_DISABLED'],
  ];

  // ----------------------------------------------- 1. CONTROL: nothing reached the wire
  {
    for (const [s, code] of SHAPES) {
      assert.strictEqual(s.thrownCode, code,
        `control ${s.id}: the real adapter must throw its own ${code} code (got ${s.thrownCode})`);
      assert.strictEqual(s.submitsDuringBid, 0,
        `control ${s.id}: a submit reached the wire (${s.submitsDuringBid}) - this shape is no longer pre-wire `
        + 'and the booking assertions below would be measuring the wrong thing');
    }
    assert.strictEqual(rateLimited.thrownLocalCooldown, true,
      'control GC-RL: localCooldown - _request synthesised the 429 without issuing anything');
    assert.strictEqual(rateLimited.fetchesDuringBid, 0,
      'control GC-RL: zero fetches of ANY method during the bid - our own cooldown, not the wire');
    assert.strictEqual(writeDisabled.fetchesDuringBid, 0,
      'control SP-WD: the writeEnabled backstop throws before a payload is built - zero fetches');
    ok('CONTROL: all four shapes throw their documented pre-wire code with ZERO submits on the wire');
  }

  // ----------------------------------------------- 2. GoComet RATE_LIMITED books nothing
  checkShape('a GoComet bid killed by our own local cooldown books nothing', rateLimited,
    WHY('RATE_LIMITED', 'our OWN local cooldown, opened by an unrelated background poll, '
      + 'synthesised a 429 without issuing a single request'));

  // ----------------------------------------------- 3. GoComet NETWORK on the quote GET books nothing
  checkShape('a GoComet quote-GET transport failure books nothing', network,
    WHY('NETWORK', 'the quotes GET that _fetchQuoteForWrite runs strictly ABOVE the submit PUT '
      + 'never landed, so no quote was ever built and no PUT was ever attempted'));

  // ----------------------------------------------- 4. GoComet NO_QUOTE books nothing
  checkShape('a GoComet enquiry with no submittable quote books nothing', noQuote,
    WHY('NO_QUOTE', 'the quotes GET returned a real, parsed, EMPTY quote list, so '
      + '_fetchQuoteForWrite refused above the submit PUT'));

  // ----------------------------------------------- 5. SuperProcure WRITE_DISABLED books nothing
  checkShape('a SuperProcure bid held by the kill-switch backstop books nothing', writeDisabled,
    WHY('WRITE_DISABLED', 'the writeEnabled kill-switch backstop refused at '
      + 'realAdapter.js:2114, before ensureSession, before the payload, before the request'));

  if (deferred.length) throw deferred[0];

  // ----------------------------------------------- 6. no revision is spent on a bid never sent
  {
    // A GoComet enquiry carries a hard revision budget. Spending one on nothing is a third of that
    // budget gone on a load the platform has no record of us bidding.
    for (const [s, code] of SHAPES) {
      assert.strictEqual(s.revisionsLeft, ARMED_REVISIONS,
        `${s.id} (${code}): armed with ${ARMED_REVISIONS} revisions and ${s.revisionsLeft} remain - a revision `
        + 'was spent on a bid that never left the box, and the engine now believes it holds less '
        + 'budget than the platform\'s own counter has taken');
    }
    ok('no revision is spent on a bid that never left the box');
  }

  // ----------------------------------------------- 7. the durable intent carries no fabrication
  {
    // All five keys the booking writes that a restart can act on. firedRungs and revisionsLeft are
    // not decoration: rehydrate() rebuilds currentRungIndex from the stored array, so a repair that
    // cleans the monitor and leaves the intent dirty reinstates the phantom on the next deploy.
    for (const [s, code] of SHAPES) {
      assert.deepStrictEqual(
        { landedBids: s.durableLandedBids, landedBidPrice: s.durableLandedBidPrice,
          everBid: s.durableEverBid, firedRungs: s.durableFiredRungs, revisionsLeft: s.durableRevisionsLeft },
        { landedBids: 0, landedBidPrice: null, everBid: false, firedRungs: [], revisionsLeft: ARMED_REVISIONS },
        `${s.id} (${code}): the DURABLE intent records a bid the platform never saw, so a restart `
        + 'rehydrates the phantom, everBid silences never_bid_before_close, and the fabrication '
        + 'outlives the process that invented it');
    }
    ok('the durable intent carries no record of a bid that was never sent');
  }

  // ----------------------------------------------- 8. the standing-bid belt is not poisoned
  {
    for (const [s, code] of SHAPES) {
      assert.strictEqual(s.mustImproveOn, null,
        `${s.id} (${code}): _mustImproveOn returned ${s.mustImproveOn} off a phantom landed bid - the `
        + 'engine will now refuse every later price at or above a bid the board does not hold, '
        + 'which forfeits the rest of the ladder on a live load');
    }
    ok('the standing-bid belt is not poisoned by a bid the board never received');
  }

  cleanup();
  // COMPLETION SENTINEL. run-tests.js grades a file by EXIT CODE alone, so a file that returns
  // early exits 0 and reads as a green zero-assertion run.
  const EXPECTED = 8;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - a pre-wire throw was booked as a landed bid\n' + ((e && e.stack) || e));
  process.exit(1);
});
