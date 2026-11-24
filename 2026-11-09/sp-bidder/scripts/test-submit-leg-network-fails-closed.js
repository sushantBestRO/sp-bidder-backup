'use strict';
/**
 * THE SUBMIT LEG - a failure after dispatch must never permit a blind duplicate.
 *
 * realAdapter.placeBid builds the createV2 payload, sends it, and only then reads the outcome.
 * _request folds every transport failure into status 0 and RETURNS, so `if (res.status === 0)`
 * raises `code: 'NETWORK'` about a request that WAS dispatched - SuperProcure may genuinely have
 * committed it. The engine cannot tell: SP's read-back hardcodes revisionsLeft null, so nothing can
 * disprove the write. bidEngine.js's placeBid catch (the uncertain-outcome handler below the AUTH
 * and COST_TYPE_UNMATCHED arms) therefore treats the bid as ON THE BOARD - it alerts the desk,
 * counts landedBids, sets lastBidPrice, spends the revision, banks the rung, and persists
 * landedBidPrice / landedBids / everBid onto the durable intent. That is not a defect. It is the
 * fail-closed side, stated in the code itself: "never shout 'no bid was placed' over money that may
 * be committed", and a revision left unspent "ends in a CAP rejection, which is terminal and
 * abandons the rest of the ladder".
 *
 * This file is the GUARD on the pre-wire fix. A throw raised BEFORE anything left the box (auth,
 * per-type-rates unmatched, and the GoComet pre-wire class being fixed alongside this) is provably
 * not landed and must give its state back. This input is the opposite.
 *
 * WHICH IS WHY THE ADAPTERS ARE REAL. BOTH adapters carry the same collision, and it is a site
 * distinction that the error code cannot express:
 *
 *   realAdapter.placeBid   `trial.release(); throw e` for a _request that never dispatched, about
 *                          twenty lines above the status-0 NETWORK throw this file protects.
 *   gocometAdapter.placeBid  _fetchQuoteForWrite throws NETWORK on a quote-GET failure BEFORE the
 *                          submit PUT; the post-PUT `if (res.status === 0)` throws NETWORK after it.
 *
 * Same code, same function, opposite required outcome. A fix that marked NETWORK pre-wire BY CODE
 * rather than BY SITE would turn the sibling red test green and silently un-book a write that may
 * be on the board - this defect pointed in the direction that double-bids. A hand-rolled thrower
 * standing in for an adapter cannot tell the two sites apart, so every scenario here drives the
 * REAL adapter over an injected transport and counts the dispatched writes OUTSIDE it (check 7) -
 * measured, not arranged. The engine consumes the adapter's OWN error object. Checks 1-8 are
 * SuperProcure; check 9 is GoComet, which is the platform actually transacting.
 *
 * Promoted from the T5 reproducers repro-F3-phantom-landed-standdown.js and
 * repro-F3b-phantom-standdown-belt.js, WITH THEIR ASSERTIONS INVERTED. They were hunting the
 * opposite claim (landedBids 0, floor shot reaches the wire) and fail today. The 2026-09-16
 * verifier ruling on BH-LOGIC-2 is that the genuinely uncertain submit-leg timeout fails closed
 * exactly as designed, and that a fix flipping repro-F3b would be the wrong fix.
 *
 * WHAT MUST NOT MOVE:
 *   - checks 1-6: a dispatched-then-failed write stays booked. A change that turns any of them red
 *     has OVER-FORGIVEN: it widened a pre-wire give-back onto an outcome nobody can disprove, and
 *     the engine would then re-fire at the same price over a bid that may already be committed.
 *   - check 7: the submit really was dispatched. Without it the rest is a tautology.
 *   - check 8: the existing falsifier still works. A read-back whose revisionsLeft matches the
 *     count we armed with PROVES no revision was taken, and that input must book nothing.
 *   - check 9: GoComet now preserves a durable unconfirmed submission without bot credit.
 *     Its shared quote cannot identify the writer, so the hold replaces assumed landing.
 *
 * Offline and deterministic: injected transport (an unrecognised URL is recorded and fails the
 * control), temp-file scheduler, virtual clock, no network, no RNG on the asserted path, no sleeps.
 *
 *   node scripts/test-submit-leg-network-fails-closed.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
let seq = 0;
const CLEAN = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `submit-leg-network-${process.pid}-${seq++}.json`);
  CLEAN.push(f);
  return f;
};
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

const LADDER = [41_420, 40_736, 39_600, 38_684, 38_000];
const FLOOR = LADDER[LADDER.length - 1];
const ARMED_REVISIONS = 30;
const SOFT_CLOSE = { enabled: true, shippers: ['Havells'], mode: 'live', reserve: 1 };
// The production SuperProcure read-back: ok, a rank, and revisionsLeft hardcoded null. Nothing in
// it can disprove the write, which is why the handler assumes the bid may be on the board.
const SP_READ_BACK = { ok: true, myRank: 4, revisionsLeft: null };

const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => body });

// The transport under the REAL adapter. A status-0 response is the dispatched failure: _request
// assigns it from r.status, folds nothing, and returns, and placeBid raises its own NETWORK error
// from there. The submit is recorded here - outside the adapter - before the status is returned.
function countingTransport(wire) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/sp/bids/createV2')) {
      const body = JSON.parse(String(init && init.body));
      wire.submits.push({ amount: body.amount, load: body.load });
      return resp(0, '');
    }
    wire.unexpected.push(u);
    return resp(500, '');
  };
}

// GoComet's own submit leg: the quote GET succeeds so the adapter gets past _fetchQuoteForWrite
// (the PRE-wire NETWORK site) and builds a real submit document, and the PUT that carries it comes
// back status 0 so the adapter raises its own NETWORK error from below the write.
function gocometTransport(wire) {
  // Shaped after scripts/test-gocomet-adapter.js's own fixture: one 11_freight_charges group with
  // one freight_charges_custom_charge* line, plus the total_charges block the basis check reads.
  const quote = {
    id: 'Q1',
    charges_list: { '11_freight_charges': {
      display_name: 'Freight',
      freight_charges_custom_charge_40ft: { units: 2, unit_name: 'TRUCK', price: 111.5, currency: 'INR' },
    } },
    total_charges: { total: { units: 2.0, quote_units: 2.0, unit_name: 'TRUCK', total: 223.0 } },
  };
  return async (url, init) => {
    const u = String(url);
    const method = init && init.method;
    if (method === 'PUT' && u.includes('/quotes/Q1/submit')) {
      const line = JSON.parse(String(init.body))
        .quote.charges_list['11_freight_charges'].freight_charges_custom_charge_40ft;
      wire.submits.push({ amount: line.price });
      return resp(0, '');
    }
    // Serves both the first read and the confirming re-read, so the write fingerprint matches and
    // placeBid reaches the PUT instead of refusing with QUOTE_CHANGED.
    if (method === 'GET' && u.includes('/quotes')) return resp(200, JSON.stringify([quote]));
    wire.unexpected.push(method + ' ' + u);
    return resp(404, '{}');
  };
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
// Structurally valid JWT; the signature is never checked and no credential is real.
const gcToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.`
  + `${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86_400, user_id: 'u1', client_id: 'c1', token_type: 'vendor' })}.sig`;

const CONTROL = [];

function armOn(adapter, wire, { prewalk = false, id }) {
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: SOFT_CLOSE,
    onEvent: (e) => events.push(e),
  });
  eng._events = events;

  const meta = { id, lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1, equipment: '32ft',
    companyName: 'Havells', branchName: 'Alwar Cable', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = LADDER.slice();
  m.floor = FLOOR;
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = ARMED_REVISIONS;
  m.triggerWindowMs = 100_000;
  if (prewalk) {
    for (const i of [0, 1, 2, 3]) m.firedRungs.add(i);
    m.currentRungIndex = 3;
  }
  return { eng, m, wire };
}

function scenario(label, { readBack, prewalk = false, id = '23718407' }) {
  const wire = { label, submits: [], unexpected: [] };
  CONTROL.push(wire);
  const adapter = new RealSuperProcureAdapter({
    token: 'submit-leg-pin-token', fetchImpl: countingTransport(wire),
    accountId: 'primary', accountLabel: 'Primary', authProbeEnabled: false,
  });
  // A live-enough session so placeBid clears ensureSession and buildBidPayload resolves a carrier
  // (same shape as scripts/lib/auth-harness.js). No login runs and no credential is real.
  adapter.account = { carrierId: 2667, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  adapter.writeEnabled = true;
  // The READ seam is injected because the read-back shape IS the input under test - tuple 1 is the
  // production shape, tuple 8 the one that disproves the write. The WRITE leg is untouched: the
  // engine calls the real placeBid, which reaches the transport above and throws its own error.
  adapter.getAuctionState = async () => readBack;
  return armOn(adapter, wire, { prewalk, id });
}

async function gocometScenario(label, { id = '23718410' } = {}) {
  const wire = { label, submits: [], unexpected: [] };
  CONTROL.push(wire);
  const adapter = new GoCometAdapter({ token: gcToken(), bidEnabled: true,
    fetchImpl: gocometTransport(wire), sleep: async () => {} });
  await adapter.login();
  // GoComet's oracle CAN carry a real revisionsLeft, unlike SuperProcure's. ok:false is what it
  // returns during a GET cooldown - a blip, the shape production actually produces alongside a
  // transport failure - and it leaves `landed` unfalsified exactly as SP's hardcoded null does.
  adapter.getAuctionState = async () => ({ ok: false });
  return armOn(adapter, wire, { id });
}

const state = (remaining, myRank, minDecrement = 100) => ({ closesInMs: remaining, myRank,
  minDecrement, standingL1Price: null, measuredRttMs: 50 });

// Halts at the FIRST submit: a full drive re-fires the next rung, which throws again and climbs
// landedBids past the 1 this pins.
async function driveToFirstSubmit(eng, m, wire, { from, to = 0, rank = null, maxTicks = 20_000 }) {
  const REAL_NOW = Date.now;
  let vnow = REAL_NOW();
  Date.now = () => vnow;
  try {
    let r = from;
    let ticks = 0;
    while (r >= to && ticks++ < maxTicks) {
      await eng._maybeBid(m, state(r, rank));
      if (wire.submits.length >= 1) return;
      const step = Math.max(1, eng._cadence(r, m));
      r -= step;
      vnow += step;
    }
  } finally { Date.now = REAL_NOW; }
}

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);
const durable = (eng, m) => eng.scheduler.get(m.auctionId) || {};

(async () => {
  // ------------------------------------------------- 1-5. the dispatched write is booked
  const s = scenario('submit-leg status 0, SP read-back', { readBack: SP_READ_BACK });
  await driveToFirstSubmit(s.eng, s.m, s.wire, { from: 126_739, rank: 4 });

  assert.strictEqual(s.wire.submits.length, 1, 'the scenario must reach the wire exactly once');
  // Read off the createV2 body the adapter actually sent, not off a captured argument.
  const price = s.wire.submits[0].amount;
  {
    assert.strictEqual(price, LADDER[0], 'the first rung is what went on the wire');
    assert.strictEqual(s.m.landedBids, 1,
      'the uncertain outcome must be BOOKED: a dispatched write that the read-back cannot disprove '
      + 'is treated as on the board (landedBids). A 0 here means a pre-wire give-back was widened '
      + 'onto an outcome nobody can disprove.');
    assert.strictEqual(s.m.lastBidPrice, price,
      'lastBidPrice must be the price that was on the wire - it is what every later improvement is '
      + 'measured against');
    ok('1. a dispatched submit that fails in transport books the uncertain outcome');
  }
  {
    const intent = durable(s.eng, s.m);
    assert.strictEqual(intent.landedBidPrice == null ? null : Number(intent.landedBidPrice), price,
      'the DURABLE intent must carry the standing bid price - a restart that re-armed believing '
      + 'nothing was placed would re-offer over a bid that may be committed');
    assert.strictEqual(Number(intent.landedBids || 0), 1, 'and the landed count');
    assert.strictEqual(intent.everBid === true, true,
      'and everBid, which is what holds never_bid_before_close closed on this load');
    ok('2. the booked bid is persisted onto the durable intent (landedBidPrice, landedBids, everBid)');
  }
  {
    assert.strictEqual(s.m.revisionsLeft, ARMED_REVISIONS - 1,
      'a write counted on the board spends its revision - the read-back gave no authoritative '
      + 'count, and believing in budget SP has already taken ends in a terminal CAP rejection');
    assert.strictEqual(Number(durable(s.eng, s.m).revisionsLeft), ARMED_REVISIONS - 1,
      'and the spend is durable, not in-memory only');
    ok('3. the revision is spent, in memory and on the intent');
  }
  {
    const rung = LADDER.indexOf(price);
    assert.strictEqual(s.m.firedRungs.has(rung), true,
      'the rung is BANKED, not given back - a same-price re-fire would double-commit money');
    assert.strictEqual(s.m.currentRungIndex, rung, 'and the ladder position advanced to it');
    assert.deepStrictEqual([...durable(s.eng, s.m).firedRungs || []], [rung], 'durably too');
    ok('4. the rung is banked into firedRungs and currentRungIndex advances');
  }
  {
    const alerts = alertsOfKind(s.eng, 'bid_submit_error');
    assert.strictEqual(alerts.length, 1,
      'exactly one desk alert per failed submit - this handler runs per tick per load, and a flood '
      + 'under this kind is the known failure mode the AUTH arm was hoisted above it to prevent');
    assert.strictEqual(alerts[0].level, 'warn', 'routed at warn, so it reaches the desk');
    ok('5. the desk is told exactly once: one bid_submit_error alert at warn');
  }

  // ------------------------------------------------- 6. the standing-bid belt engages
  {
    // repro-F3b's shape: the ladder is already walked down to the reserved floor shot, so the throw
    // lands on the only rung left.
    const f = scenario('floor shot, submit-leg status 0', {
      readBack: SP_READ_BACK, prewalk: true, id: '23718408' });
    await driveToFirstSubmit(f.eng, f.m, f.wire, { from: 30_000, rank: 4 });
    assert.strictEqual(f.wire.submits[0].amount, FLOOR,
      'the failure must land on the reserved floor shot - anything else is not F3b\'s shape');
    assert.strictEqual(f.m.landedBids, 1, 'the floor shot books the same uncertain outcome');
    // maxImprovementPrice(standing, 1) - the certain rule, one rupee below our own standing bid.
    assert.strictEqual(f.eng._mustImproveOn(f.m), FLOOR - 1,
      'the standing-bid belt must demand a strict improvement on the booked price - null here and '
      + 'the engine re-offers at or above a bid that may already be on the board');
    ok('6. the standing-bid belt engages on the booked bid (holds rather than re-offering)');
  }

  // ------------------------------------------------- 8. the falsifier still works
  {
    // revisionsLeft comes back EQUAL to what we armed with, so the platform's own counter proves no
    // revision was taken. This is the one read-back that disproves the write, and it must book
    // nothing - the fix must not break the falsifier while it teaches the handler about pre-wire.
    const d = scenario('submit-leg status 0, disproving read-back', {
      readBack: { ok: true, myRank: 4, revisionsLeft: ARMED_REVISIONS }, id: '23718409' });
    await driveToFirstSubmit(d.eng, d.m, d.wire, { from: 126_739, rank: 4 });
    assert.strictEqual(d.m.landedBids, 0,
      'a read-back that PROVES the revision was never taken must book nothing');
    assert.strictEqual(durable(d.eng, d.m).landedBidPrice == null ? null : 'present', null,
      'and must persist no standing bid price');
    ok('8. a read-back that disproves the write books nothing (the falsifier survives)');
  }

  // ------------------------------------------------- 9. GoComet's submit leg, explicit unconfirmed rule
  {
    const g = await gocometScenario('gocomet submit PUT status 0');
    await driveToFirstSubmit(g.eng, g.m, g.wire, { from: 126_739, rank: 4 });
    assert.ok(g.wire.submits.length >= 1,
      'the submit PUT must have been dispatched, measured on the transport outside the adapter. '
      + 'Zero here means the bid never got past _fetchQuoteForWrite, whose NETWORK throw is the '
      + 'PRE-wire twin - the sibling test\'s input, which must book nothing');
    const gcPrice = g.wire.submits[0].amount;
    assert.strictEqual(gcPrice, LADDER[0], 'the first rung is the per-unit price on the freight line');
    assert.strictEqual(g.m.landedBids, 0,
      'GoComet\'s post-PUT NETWORK throw remains unconfirmed: shared-account evidence cannot credit '
      + 'the write to Bid Command');
    assert.strictEqual(g.m.lastBidPrice, null, 'an unconfirmed account quote is not a confirmed bot standing price');
    const intent = durable(g.eng, g.m);
    assert.strictEqual(intent.landedBidPrice == null ? null : Number(intent.landedBidPrice), null,
      'the durable intent carries no confirmed bot standing price');
    assert.strictEqual(Number(intent.landedBids || 0), 0, 'and no confirmed landed count');
    assert.ok(intent.pendingGcSubmission && intent.pendingGcSubmission.outcome === 'unconfirmed',
      'the dispatched attempt is held durably as unconfirmed');
    assert.strictEqual((intent.gcUnconfirmedSubmissions || []).length, 1,
      'the ambiguous write leaves one audit record');
    await g.eng._maybeBid(g.m, state(120_000, 4));
    assert.strictEqual(g.wire.submits.length, 1,
      'the unresolved attempt is not submitted a second time');
    ok('9. GoComet: a dispatched submit PUT that fails in transport is unconfirmed, uncredited and not retried');
  }

  // ------------------------------------------------- 7. THE CONTROL
  {
    // Measured on the real adapters: every scenario's write - createV2 on SuperProcure, the submit
    // PUT on GoComet - was built, sent and counted by the transport BEFORE placeBid raised its
    // NETWORK error. This is the whole premise. A change that ever routes one of these inputs
    // through the pre-wire door (a never-dispatched _request throw, an auth refusal, a payload
    // assertion, a failed quote GET) sends zero writes and fails here, where a hand-rolled thrower
    // would have reported all-clear.
    assert.strictEqual(CONTROL.length, 4, 'every scenario must register its wire record');
    for (const w of CONTROL) {
      assert.ok(w.submits.length >= 1,
        `${w.label}: no write reached the transport, so this input never got past the pre-wire `
        + 'stage - the checks above would be asserting on a throw that placed nothing');
      assert.deepStrictEqual(w.unexpected, [],
        `${w.label}: the adapter made a request this pin does not model`);
    }
    ok('7. CONTROL: all four scenarios dispatched their write on the REAL adapter before the throw');
  }

  cleanup();
  const EXPECTED = 9;
  assert.strictEqual(pass, EXPECTED,
    `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\nPASS - ${pass}/${EXPECTED} checks passed - uncertain writes keep their platform-specific safety contract`);
})().catch((e) => {
  cleanup();
  console.error('\nFAIL - the submit-leg NETWORK throw no longer fails closed as designed\n'
    + (e && e.stack || e));
  process.exit(1);
});
