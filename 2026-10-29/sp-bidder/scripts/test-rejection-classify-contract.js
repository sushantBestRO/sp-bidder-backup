'use strict';
/**
 * CONTRACT: the bidder <-> SuperProcure WRITE boundary, and the rejection-classification seam
 * that hangs off it.
 *
 * This file pins SHAPES AND RULES, not behaviour. It is deliberately NOT
 * scripts/test-rejection-taxonomy.js (which drives the engine's decisions after a refusal) and
 * NOT scripts/test-rejection-capture-e2e.js (which drives the persistence chain). Those two
 * assert what the engine DOES; this one asserts what the seam IS - the exact key set of
 * placeBid's rejected/accepted/throttled envelopes, the exact request triple that goes on the
 * wire, the exact key set listingProbe returns, and the rule that the three verbatim
 * SuperProcure refusal strings PARTITION into three classes with nothing falling into two.
 *
 * WHY A CONTRACT TEST AND NOT MORE BEHAVIOUR TESTS. Until PR #143 there was exactly one
 * classifier in the engine (BID_CAP_REJECTION_RE) and every other refusal fell into one
 * undifferentiated bucket. Three separately-shipped regressions trace to that bucket. A taxonomy
 * of three classes is only as good as the FIELDS the classifier reads, and one of those fields is
 * a phantom: rejectionSays scans `res.body`, and realAdapter.placeBid does not return a `body` at
 * all. It is retained deliberately as defensive handling for the mock / sim / GoComet adapters,
 * which may shape a rejection differently. Pinned here so that a future edit which starts RELYING
 * on `body` against the real adapter fails at test time rather than on live money.
 *
 * SAMPLE DATA IS REAL, NOT INVENTED. Every rejection string below is verbatim from BRL's own
 * production box:
 *   - the rejectedBids[] entries in the 2026-08-01 box snapshot of data/closedBids.json
 *     (loads 23341274, 23481821, 23191127, 23498813 - reproduced inline with their real
 *     httpStatus / carrierSent / rungIndex);
 *   - the 23700092 trace quoted in docs/diagnoses/2026-08-01_soft-close-retry-deadlock-and-pr-verdict.md;
 *   - the /sp/loads/v4 listing row is a real captured row (load 23090881, Havells, 2026-07-13
 *     open-loads capture), trimmed to the fields _mapLoad reads.
 * No string here is guessed at. A new SuperProcure wording must be captured before it is pinned.
 *
 * MOCK POLICY. The transport is stubbed at the HTTP seam INSIDE the adapter (fetchImpl) - never
 * placeBid itself, because placeBid's own parsing is the thing under contract. NO network call is
 * made, no real bid is ever placed, and the write gate is the real one. This is live-money code:
 * every request in this file is answered by an in-process stub.
 *
 *   node scripts/test-rejection-classify-contract.js
 */

// Silence the adapter's unconditional rejection warn + the engine's error lines: this file
// deliberately drives many refusals and the log noise would bury the check output. Set before the
// requires so no module caches a threshold above it.
process.env.LOG_LEVEL = 'silent';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { RealSuperProcureAdapter, MAX_PLAUSIBLE_DEADLINE_MS, PLACE_BID_ENVELOPE_KEYS } = require('../src/platform/realAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// ------------------------------------------------------------------------------------------------
// EXPECTED-COUNT SENTINEL - registered HERE, above every check, and fired on process exit.
//
// scripts/run-tests.js grades this file by EXIT CODE ALONE. An async file that ends early - a
// swallowed rejection, an unref'd timer letting the loop drain, a stray `return` - reaches exit 0
// having asserted nothing and reads as a silent green. A count assertion at the BOTTOM of the file
// does not close that hole: it sits downstream of everything it guards, so every one of those paths
// skips it too. Registering the handler before any case runs is what makes it fire on every path
// out of the process.
// ------------------------------------------------------------------------------------------------
const EXPECTED_CHECKS = 16;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `rej-contract-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

const keysOf = (o) => Object.keys(o).sort();

// ================================================================================================
// FIXTURES - verbatim production payloads. Provenance is named on every one.
// ================================================================================================

// The carrier registration BRL's master account bids as (carrierSent on every snapshot rejection).
const CARRIER = 2667;

// THE THREE CLASSES, verbatim. Sourced from rejectedBids[] in the 2026-08-01 box snapshot.
//   CAP            - load 23341274, price 19296, rungIndex 1, httpStatus 400.
//   NOT-BIDDABLE   - load 23481821, price 77251, rungIndex 0, httpStatus 400. 15 occurrences in
//                    the last 7 days; 13/13 refused loads had zero bidders ever, 0/624 loads with
//                    >= 1 bidder were refused.
//   PRICE/STATE    - load 23191127, price 10630, rungIndex 2, httpStatus 400. 120 occurrences -
//                    the engine discovering SuperProcure's own per-load cap by being rejected at it.
const CAP_TEXT = 'Bid limit exceeded';
const NOT_BIDDABLE_TEXT = 'Load not available for bidding';
const AMOUNT_INVALID_TEXT = 'Amount is invalid. Amount should be less than or equal to 10620';

// REAL NEIGHBOURS, also verbatim from the same snapshot / the logging-capture incident. These are
// the strings a widened classifier would wrongly swallow, so they are the non-match evidence.
const AUCTION_ENDED_TEXT = 'Auction has already ended for this load';           // load 23498813
const UNDER_APPROVAL_TEXT = 'Load is under approval for allotment. Bidding is not allowed.';

// A real /sp/loads/v4 row (load 23090881, Havells India Ltd., from the 2026-07-13 open-loads
// capture), trimmed to the fields _mapLoad reads. loadingPoints is the real JSON blob shape.
const REAL_POINTS = JSON.stringify([
  { pin: '572138', client: 'Tumkur Cable (1355)(1355)', longName: 'Karnataka,India', shortName: 'TUMKURU',
    companyName: 'Havells India Ltd.', isLoadingPoint: 1 },
  { pin: '606111', client: 'RBA POWER PVT LTD', longName: 'Tamil Nadu,India', shortName: 'CUDDALORE',
    isLoadingPoint: 0 },
]);
function listingRow(id, { biddingOn = 1, closeTime = null } = {}) {
  return {
    id, loadCode: 'BRL-' + id, companyName: 'Havells India Ltd.', branchName: 'Alwar Cable (1350)',
    biddingOn, loadingPoints: REAL_POINTS,
    biddingStartTime: new Date(Date.now() - 60_000).toISOString(),
    biddingCloseTime: closeTime || new Date(Date.now() + 600_000).toISOString(),
    branchAuctionExtendTime: '00:03:00', branchExtendAuctionCount: 3, branchBidCountAllowed: 30,
    loadShipmentType: 'FTL', branchQuoteType: 'FTL', vehicleCount: 1, isOpenAuction: 0,
    loadStatusKey: 'OPEN', loadNotificationStatus: 'START', oldLoadId: null,
  };
}

// SuperProcure's shared year-2100 placeholder pair, observed live 2026-07-11 across multiple
// unrelated shippers. It PARSES as a valid date, so every NaN guard misses it.
const YEAR_2100_CLOSE = '2100-05-24T19:53:25.000Z';

// ================================================================================================
// TRANSPORT STUB - the only mocked seam. Routes by URL so one adapter can answer both the bid
// write and the listing read. Any other path is a hard failure: nothing may reach the network.
// ================================================================================================
function transport({ bid, list } = {}) {
  const calls = { bid: [], list: [] };
  const defaultList = async () => ({ status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ data: { loadDetails: [] } }) });
  const impl = async (url, init) => {
    const u = String(url);
    if (u.includes('/sp/bids/createV2')) { calls.bid.push({ url: u, init }); return bid(u, init); }
    if (u.includes('/sp/loads/v4')) { calls.list.push({ url: u, init }); return (list || defaultList)(u, init); }
    throw new Error('CONTRACT TEST made an unexpected request: ' + u);
  };
  return { impl, calls };
}

// A SuperProcure rejection is HTTP 400 with a PLAINTEXT body (res.json is null for it). Model a
// text-only Response, which is the shape the real reject path must survive.
const plaintext = (status, body) => async () => ({ status, headers: { get: () => null }, text: async () => body });
const json201 = (payload) => async () => ({ status: 201, headers: { get: () => null }, text: async () => JSON.stringify(payload) });

function mkAdapter(fetchImpl) {
  const a = new RealSuperProcureAdapter({ token: 'contract-test-token', fetchImpl });
  // A live-enough session so placeBid clears ensureSession() and buildBidPayload resolves a carrier.
  // No login() is performed and no credential is real.
  a.account = { carrierId: CARRIER, tokenExp: Date.now() + 3_600_000, branchIds: [956055] };
  a.writeEnabled = true;
  return a;
}

// ================================================================================================
// ENGINE HARNESS - the REAL BidEngine over the REAL adapter over the stubbed transport, so a
// classification assertion exercises the whole seam (SP wire body -> adapter parse -> classifier).
// ================================================================================================
function mkStack(fetchImpl, { shipper = 'Borosil' } = {}) {
  const adapter = mkAdapter(fetchImpl);
  const events = [];
  const eng = new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
    softClose: { enabled: true, shippers: [shipper], mode: 'live', reserve: 1 },
    onEvent: (e) => events.push(e),
  });
  eng._events = events;
  return { eng, adapter };
}

// Arm one monitor on a controlled ladder with a REAL numeric load id, then disarm its timer so the
// check drives the lifecycle by hand. Numeric because the wire id rides straight into the createV2
// URL and body.
function armFine(eng, id, { companyName = 'Borosil', ladder = [10_000, 9_700, 9_400, 9_100, 8_000] } = {}) {
  const meta = { id: String(id), lane: { origin: 'Bhiwandi', destination: 'Alwar' }, units: 1,
    equipment: '32ft', companyName, branchName: 'Alwar Cable (1350)', closesAt: Date.now() + 600_000 };
  const m = eng.arm(meta, { cost: 100_000, marginsPct: [12, 7, 2] });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  m.ladder = ladder.slice();
  m.floor = ladder[ladder.length - 1];
  m.closeModel = 'soft';
  m.extendCap = 5;
  m.extendsObserved = 0;
  m.revisionsLeft = 30;
  m.triggerWindowMs = 100_000;
  return m;
}

// The designed soft establish mark (triggerWindowMs 100s + establishLeadMs 40s), the same one
// test-rejection-taxonomy fires at. Nothing here depends on TIMING - it is only how a single write
// is made to reach the wire so its response shape can be read.
const ESTABLISH_MS = 126_739;
const state = (remaining, myRank = null) => ({ closesInMs: remaining, myRank, minDecrement: 100,
  standingL1Price: null, measuredRttMs: 50 });

const alertsOfKind = (eng, kind) => eng._events.filter((e) => e.type === 'alert' && e.kind === kind);
const rejectionsOf = (eng) => eng._events.filter((e) => e.type === 'bid_rejected');

/**
 * WHICH CLASS did this refusal land in, read from the engine's own observable state. The three
 * classes are mutually exclusive BY CONTRACT, so this returns an array and the checks assert
 * length === 1 - an overlap shows up as a two-element result rather than being masked.
 */
function classesOf(eng, m) {
  const hit = [];
  if (m.capExhausted) hit.push('cap');
  if (m.loadNotBiddable) hit.push('load_not_biddable');
  if (m.priceRaiseRefused) hit.push('price_raise_refused');
  if (m.submissionClosed) hit.push('submission_window_closed');
  if (!hit.length && rejectionsOf(eng).length > 0) hit.push('price_state');
  return hit;
}

// Fire ONE write into a rejection body and hand back everything a check needs to read.
async function fireOnce(body, { id = 23481821, status = 400 } = {}) {
  const t = transport({ bid: plaintext(status, body) });
  const { eng, adapter } = mkStack(t.impl);
  const m = armFine(eng, id);
  await eng._maybeBid(m, state(ESTABLISH_MS));
  return { eng, adapter, m, t };
}

(async () => {
  // ==============================================================================================
  // PART A - THE RESPONSE CONTRACT of realAdapter.placeBid. Shape only: no check in this part
  // asserts an engine decision.
  // ==============================================================================================

  // ----------------------------------------------------------------------------------------------
  // A1. placeBid_rejection_shape_is_pinned
  //     The rejected envelope, key for key. `body` is THE PHANTOM: rejectionSays scans it, the real
  //     adapter never sets it. Mutant caught: renaming/dropping reason|text|raw, adding a field to
  //     the envelope, or starting to populate `body` on the real path.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange
    const t = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT) });
    const a = mkAdapter(t.impl);

    // Act
    const res = await a.placeBid(23481821, 77_251, { floor: 70_000 });

    // Assert - the envelope, with NO additional properties tolerated
    // `bidRate` joined on 2026-08-05: it is SuperProcure's SECOND echo of the per-MT rate we sent
    // (alongside amountPMT), and the pmt_amount_mismatch oracle checks both independently.
    assert.deepStrictEqual(keysOf(res), PLACE_BID_ENVELOPE_KEYS, 'placeBid rejection envelope key set is exactly this - a new/renamed field is a wire-contract change');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'body'), false,
      'THE PHANTOM: realAdapter.placeBid returns NO `body`. rejectionSays scans res.body defensively for the '
      + 'mock/sim/GoComet adapters; anything on the real path that relies on it is reading undefined');
    assert.strictEqual(res.body, undefined, 'and it reads undefined, not an empty string');

    // Types + values on the fields the classifier actually consumes
    assert.strictEqual(res.accepted, false, 'a 400 is not accepted');
    assert.strictEqual(res.status, 400, 'the platform status is surfaced as a number');
    assert.strictEqual(typeof res.reason, 'string', 'reason is a string');
    assert.strictEqual(res.reason, NOT_BIDDABLE_TEXT, "reason is SP's own plaintext, not 'http_400'");
    assert.strictEqual(res.text, NOT_BIDDABLE_TEXT, 'text is the raw platform body verbatim');
    assert.strictEqual(res.raw, NOT_BIDDABLE_TEXT, 'raw falls back to the text when the body did not parse as JSON');
    assert.strictEqual(res.carrierSent, CARRIER, 'carrierSent is the carrier registration actually sent');
    assert.strictEqual(typeof res.latencyMs, 'number', 'latencyMs is a number');

    // The read-back oracles are null on a rejection - never fabricated, never absent
    for (const f of ['myRank', 'revisionsLeft', 'bidVehicleCount', 'amountPMT', 'bidQuantity']) {
      assert.strictEqual(res[f], null, `${f} is explicitly null on a rejection (present-and-null, not missing)`);
    }
    ok('placeBid rejection envelope pinned: reason/text/raw carry the platform string, `body` is the phantom');
  }

  // ----------------------------------------------------------------------------------------------
  // A1b. auth_rejection_envelope_shares_the_one_key_set
  //     THE THIRD ENVELOPE. _authRejection (PR #147) is a SECOND construction site for the same
  //     contract, built by hand rather than shared with the wire path below it - so a field added
  //     to one site is silently absent from the other, and A1/A3 above cannot see it because
  //     neither drives a 401. That is not hypothetical: `bidRate` was added to the wire envelope
  //     by the per-MT fix and to _authRejection only when the two branches were rebased together;
  //     for the duration of that gap `res.bidRate` read undefined on every auth refusal while the
  //     accept and ordinary-reject paths returned null.
  //
  //     Pinned against the SAME literal key list as A1 and A3 deliberately. Three copies of one
  //     list is the point: a new envelope field must be added in three places and any miss fails
  //     here. Mutant caught: adding a read-back field to placeBid's wire path without adding it to
  //     _authRejection, which is exactly the divergence described above.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - SuperProcure's own 2026-08-04 revocation shape: a plaintext 401 on the write.
    const t = transport({ bid: plaintext(401, 'Token is invalid.') });
    const a = mkAdapter(t.impl);

    // Act
    const res = await a.placeBid(23481821, 77_251, { floor: 70_000 });

    // Assert - the SAME key set as the ordinary rejection and the accept
    assert.deepStrictEqual(keysOf(res), PLACE_BID_ENVELOPE_KEYS, 'the AUTH rejection shares the one envelope key set - a consumer never has to branch on shape');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'body'), false,
      'the auth envelope carries no `body` either - the phantom stays a phantom on every path');

    // The auth class itself, and the literal reason the engine's classifiers must not regex-match
    assert.strictEqual(res.accepted, false, 'a 401 is not accepted');
    assert.strictEqual(res.status, 401, 'the platform status is surfaced so isAuthRejection can read it');
    assert.strictEqual(res.reason, 'session_logged_out',
      "reason is the literal sentinel, never SuperProcure's own body text");

    // Every read-back oracle field is present-and-null - the property the pmt_amount_mismatch
    // oracle's `v != null` filter depends on. An ABSENT key reads undefined and would still be
    // skipped today, but only by accident; present-and-null is the contract A1 pins.
    for (const f of ['myRank', 'revisionsLeft', 'bidVehicleCount', 'amountPMT', 'bidRate', 'bidQuantity']) {
      assert.ok(Object.prototype.hasOwnProperty.call(res, f), `${f} is PRESENT on the auth envelope`);
      assert.strictEqual(res[f], null, `${f} is explicitly null on an auth rejection (present-and-null, not missing)`);
    }
    ok('the AUTH rejection envelope shares the one key set, bidRate included, every oracle field present-and-null');
  }

  // ----------------------------------------------------------------------------------------------
  // A2. classifier_reads_fields_that_actually_exist
  //     A grep gate across the seam: the field list rejectionSays scans, checked against the key set
  //     realAdapter.placeBid actually returns. Mutant caught: renaming `text` in the adapter, or
  //     dropping `res.reason` from the classifier's scan list - either one desynchronises the two
  //     sides and neither file's own tests would notice.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - read the classifier's scanned fields straight out of the engine source
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'bidEngine.js'), 'utf8');
    const mm = src.match(/for \(const field of \[([^\]]+)\]\)/);
    assert.ok(mm, 'rejectionSays still scans a literal field list (the single factored-out scan point)');
    const scanned = mm[1].split(',').map((s) => s.trim().replace(/^res\./, '')).filter(Boolean);

    const t = transport({ bid: plaintext(400, CAP_TEXT) });
    const a = mkAdapter(t.impl);

    // Act
    const res = await a.placeBid(23341274, 19_296, { floor: 15_000 });
    const real = new Set(Object.keys(res));

    // Assert
    assert.deepStrictEqual(scanned.slice().sort(), ['body', 'raw', 'reason', 'text'],
      'the classifier scans exactly these four fields');
    for (const f of ['reason', 'text', 'raw']) {
      assert.ok(real.has(f), `the classifier scans res.${f} and the real adapter populates it`);
      assert.strictEqual(res[f], CAP_TEXT, `res.${f} carries the platform string, so the scan can match on it`);
    }
    assert.ok(!real.has('body'),
      'res.body is scanned but NOT produced by the real adapter - it is defensive handling for the '
      + 'mock/sim/GoComet adapters and must stay documented as such, not treated as a real-path field');
    ok('classifier field list and the real placeBid key set agree: three live fields, one documented phantom');
  }

  // ----------------------------------------------------------------------------------------------
  // A3. placeBid_accepted_envelope_is_pinned
  //     The success half of the contract, tested separately from the error half. Mutant caught:
  //     changing the parse path for rank / bidVehicleCount / amountPMT, or letting reason be
  //     non-null on an accept.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - the createV2 accept shape captured live (the SIKA response: amount 95700,
    // bidQuantity 25, amountPMT 3828, and SP normalising the vcq:-1 sentinel to bidVehicleCount 1)
    const t = transport({ bid: json201({ data: { rank: 1, bidVehicleCount: 1, amountPMT: 3828, bidQuantity: 25 } }) });
    const a = mkAdapter(t.impl);

    // Act
    const res = await a.placeBid(22365292, 95_700, { floor: 90_000 });

    // Assert
    assert.deepStrictEqual(keysOf(res), PLACE_BID_ENVELOPE_KEYS, 'accept and reject share ONE envelope key set - a consumer never has to branch on shape');
    assert.strictEqual(res.accepted, true, '201 is accepted');
    assert.strictEqual(res.status, 201, 'the created status is surfaced');
    assert.strictEqual(res.reason, null, 'reason is null on an accept (never an empty string)');
    assert.strictEqual(res.myRank, 1, 'myRank parses from data.rank');
    assert.strictEqual(res.bidVehicleCount, 1, 'the vehicle-count read-back oracle field is surfaced as a number');
    assert.strictEqual(res.amountPMT, 3828, 'the per-tonne read-back oracle field is surfaced as a number');
    assert.strictEqual(res.bidQuantity, 25, 'the quantity SP charged on is surfaced as a number');
    assert.strictEqual(res.revisionsLeft, null, 'SuperProcure exposes no remaining count - null, never a guess');

    // 200 must be accepted as well as 201 - the status rule, not just the happy code
    const t200 = transport({ bid: async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { rank: 2 } }) }) });
    const a200 = mkAdapter(t200.impl);
    const r200 = await a200.placeBid(22365292, 95_700, { floor: 90_000 });
    assert.strictEqual(r200.accepted, true, '200 counts as accepted alongside 201');
    ok('placeBid accepted envelope pinned: same key set, reason null, both 200 and 201 accept');

    // AN INDEPENDENT WITNESS ON THE ACCEPT PATH - hand-written, deliberately NOT derived from
    // PLACE_BID_ENVELOPE_KEYS.
    //
    // Sharing one exported list fixed the ASYMMETRIC drift (one construction site changing while a
    // suite's private copy agreed with it). It cannot catch the SYMMETRIC case: delete a read-back
    // field from placeBid's returns and from the exported list in the same edit, and every key-set
    // assertion above still passes, because the code and its check have become one statement.
    //
    // That direction is the dangerous one. BOTH read-back oracles are gated on `!= null`
    // (bidEngine's vehicle-count and per-tonne blocks), so a field that stops being surfaced is
    // indistinguishable at runtime from one SuperProcure did not send: the belts go quiet and stay
    // quiet, and the first sign is an un-allottable bid or a wrong rate found at allotment.
    //
    // A1b already names these fields literally on the AUTH envelope, so the symmetric case was not
    // wholly unguarded - but it was unguarded HERE, and here is the path that matters: both oracles
    // sit inside the `res.accepted` branch, so the accepted envelope is the only one they ever read.
    // A check that only fires on a 401 cannot protect a belt that only runs on a 201.
    //
    // Kept hand-written on purpose - the redundancy IS the value. If a field is genuinely retired,
    // this is what forces that decision to be made out loud instead of being absorbed by a list that
    // moved along with it.
    for (const k of ['amountPMT', 'bidRate', 'bidQuantity', 'bidVehicleCount']) {
      assert.ok(Object.prototype.hasOwnProperty.call(res, k),
        `the accepted envelope still surfaces \`${k}\` - both read-back oracles are != null-gated, so dropping it disables a belt silently`);
    }
    assert.ok(PLACE_BID_ENVELOPE_KEYS.includes('bidRate') && PLACE_BID_ENVELOPE_KEYS.includes('amountPMT'),
      'and the shared key list still carries them, so the two statements of this invariant agree');
    ok('the read-back fields are pinned INDEPENDENTLY of the shared key list, so removing one from both still fails here');
  }

  // ----------------------------------------------------------------------------------------------
  // A4. placeBid_error_envelopes_are_distinct
  //     Throttle and transport failure are NOT rejections and must not be classified as ones.
  //     Mutant caught: folding the 429 return into the rejection envelope, or returning a value
  //     instead of throwing on a status-0 write (which would silently record a bid that may have
  //     committed as a clean refusal).
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - 429 with a Retry-After
    const t429 = transport({ bid: async () => ({ status: 429, headers: { get: (h) => (h === 'retry-after' ? '2' : null) }, text: async () => 'Too Many Requests' }) });
    const a429 = mkAdapter(t429.impl);

    // Act
    const res = await a429.placeBid(23481821, 9_000, { floor: 8_000 });

    // Assert - its OWN key set, and a reserved reason token rather than a platform string
    assert.deepStrictEqual(keysOf(res), [
      'accepted', 'carrierSent', 'latencyMs', 'myRank', 'raw', 'reason', 'retryAfterMs',
      'revisionsLeft', 'status', 'text',
    ], 'the throttled envelope is its own shape - it carries retryAfterMs and no read-back oracles');
    assert.strictEqual(res.reason, 'rate_limited', "the throttle reason is the reserved token 'rate_limited', not SP prose");
    assert.strictEqual(res.retryAfterMs, 2000, 'Retry-After delta-seconds parses to ms');
    assert.strictEqual(res.accepted, false, 'a throttle is not an accept');

    // Arrange - transport failure (status 0 inside _request)
    const tNet = transport({ bid: async () => { throw new Error('ECONNRESET'); } });
    const aNet = mkAdapter(tNet.impl);

    // Act
    let threw = null;
    try { await aNet.placeBid(23481821, 9_000, { floor: 8_000 }); } catch (e) { threw = e; }

    // Assert
    assert.ok(threw, 'a transport failure on the WRITE throws - the outcome is UNCERTAIN, not a refusal');
    assert.strictEqual(threw.code, 'NETWORK', "and it throws with code 'NETWORK' so the caller runs the read-back oracle");
    ok('error envelopes are distinct: 429 carries retryAfterMs + a reserved reason, a status-0 write throws NETWORK');
  }

  // ----------------------------------------------------------------------------------------------
  // A5. placeBid_request_contract_is_pinned
  //     The OTHER direction: what we send. Mutant caught: a wire field added/renamed/dropped on the
  //     createV2 body, the carrier leaving the query string, or the auth scheme changing.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange
    const t = transport({ bid: plaintext(400, AMOUNT_INVALID_TEXT) });
    const a = mkAdapter(t.impl);

    // Act
    await a.placeBid(23191127, 10_630.4, { floor: 9_000 });

    // Assert - one write, one URL, one body shape
    assert.strictEqual(t.calls.bid.length, 1, 'exactly one write reached the transport (retry:false on the money path)');
    const { url, init } = t.calls.bid[0];
    assert.strictEqual(init.method, 'POST', 'createV2 is a POST');
    assert.strictEqual(url, 'https://api.superprocure.com/sp/bids/createV2?id=23191127&carrier=2667',
      'the load id AND the carrier registration both ride the query string');
    assert.strictEqual(init.headers['content-type'], 'application/json', 'the body is sent as JSON');
    assert.ok(/^Bearer /.test(init.headers.authorization), 'auth is a Bearer JWT');

    const body = JSON.parse(init.body);
    assert.deepStrictEqual(keysOf(body), [
      'amount', 'bidDiscount', 'bidNotes', 'carrierBranchId', 'in', 'isOfferRate', 'isWeb', 'load',
      'loadLotId', 'reportingTime', 'requestTime', 'transitTime', 'type', 'vcq', 'vehicleTypes',
    ], 'the createV2 body key set is exactly this - an extra or missing wire field is a contract break');
    assert.strictEqual(body.load, 23191127, 'load is the NUMERIC wire id');
    assert.strictEqual(body.carrierBranchId, CARRIER, 'carrierBranchId equals the ?carrier= param - one carrier, two places');
    assert.strictEqual(body.amount, 10_630, 'amount is rounded to an integer rupee value');
    assert.strictEqual(body.type, 'E-AUCTION', 'the bid type');
    assert.strictEqual(body.in, 'FTL', 'the quote basis on a flat load');
    assert.strictEqual(body.vcq, -1, 'the proven single-vehicle sentinel');
    assert.strictEqual(body.isWeb, 1, 'isWeb rides as the number 1');
    assert.strictEqual(typeof body.requestTime, 'number', 'requestTime is an epoch-ms number');
    ok('placeBid request contract pinned: POST createV2, id+carrier in the query, 15-field body');
  }

  // ==============================================================================================
  // PART B - THE CLASSIFICATION RULE. Real engine over real adapter over the stubbed transport, so
  // each check runs the platform string all the way from an HTTP body to a class.
  // ==============================================================================================

  // ----------------------------------------------------------------------------------------------
  // B1. each_real_string_classifies_to_exactly_one_class
  //     The partition. Three verbatim strings, three classes, no string in two buckets and none in
  //     zero. Mutant caught: deleting either classifier branch, or widening one so it swallows a
  //     neighbouring class.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange + Act
    const seen = new Map();
    for (const [text, id] of [[CAP_TEXT, 23341274], [NOT_BIDDABLE_TEXT, 23481821], [AMOUNT_INVALID_TEXT, 23191127]]) {
      const { eng, m } = await fireOnce(text, { id });
      seen.set(text, { classes: classesOf(eng, m), eng, m });
    }

    // Assert - exactly one class each
    for (const [text, got] of seen) {
      assert.strictEqual(got.classes.length, 1,
        `"${text}" landed in ${got.classes.length} classes (${got.classes.join(' + ') || 'none'}) - the taxonomy `
        + 'must be a PARTITION: one refusal, one class, one response');
    }
    // ...and the three classes are DISTINCT (a partition of three strings onto one class is not one)
    assert.strictEqual(seen.get(CAP_TEXT).classes[0], 'cap', 'the cap string is the cap class');
    assert.strictEqual(seen.get(NOT_BIDDABLE_TEXT).classes[0], 'load_not_biddable', 'the not-biddable string is its own class');
    assert.strictEqual(seen.get(AMOUNT_INVALID_TEXT).classes[0], 'price_state', 'the ceiling refusal is the price/state class');
    assert.strictEqual(new Set([...seen.values()].map((v) => v.classes[0])).size, 3,
      'three distinct classes - the whole point of the taxonomy is that they are not one bucket');

    // Each class's own alert kind fires once and ONLY for its own class
    assert.strictEqual(alertsOfKind(seen.get(CAP_TEXT).eng, 'bid_cap_exhausted').length, 1, 'cap raises bid_cap_exhausted');
    assert.strictEqual(alertsOfKind(seen.get(CAP_TEXT).eng, 'load_not_biddable').length, 0, 'and NOT load_not_biddable');
    assert.strictEqual(alertsOfKind(seen.get(NOT_BIDDABLE_TEXT).eng, 'load_not_biddable').length, 1, 'not-biddable raises load_not_biddable');
    assert.strictEqual(alertsOfKind(seen.get(NOT_BIDDABLE_TEXT).eng, 'bid_cap_exhausted').length, 0, 'and NOT bid_cap_exhausted');
    assert.strictEqual(alertsOfKind(seen.get(AMOUNT_INVALID_TEXT).eng, 'bid_cap_exhausted').length, 0, 'price/state raises neither');
    assert.strictEqual(alertsOfKind(seen.get(AMOUNT_INVALID_TEXT).eng, 'load_not_biddable').length, 0, 'price/state raises neither');
    ok('the three verbatim strings PARTITION into three classes - one class each, no overlap, no gap');
  }

  // ----------------------------------------------------------------------------------------------
  // B2. bid_cap_regex_matches_only_the_cap_case
  //     BID_CAP_REJECTION_RE is deliberately narrow: a match is TERMINAL for the load's budget, so a
  //     false positive silently costs an auction. Mutant caught: loosening it to a "limit"/"exceeded"
  //     heuristic, or dropping the /i flag or the \s+ tolerance.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange + Act + Assert - the MATCH
    const hit = await fireOnce(CAP_TEXT, { id: 23341274 });
    assert.strictEqual(hit.m.capExhausted, true, 'the verbatim cap string latches the cap class');
    assert.strictEqual(hit.m.revisionsLeft, 0, 'and drives the per-load budget to zero (terminal)');

    // The two declared flexibilities, applied to the SAME captured string (not new SP wordings):
    // /i case-insensitivity and \s+ whitespace tolerance.
    const upper = await fireOnce(CAP_TEXT.toUpperCase(), { id: 23341274 });
    assert.strictEqual(upper.m.capExhausted, true, 'the /i flag holds - an upper-cased body still latches the cap');
    const spaced = await fireOnce(CAP_TEXT.replace(/ /g, '  \t'), { id: 23341274 });
    assert.strictEqual(spaced.m.capExhausted, true, 'the \\s+ tolerance holds - re-spaced whitespace still latches the cap');

    // ...and the NON-MATCHES, every one a real captured SuperProcure string
    for (const [text, id] of [[NOT_BIDDABLE_TEXT, 23481821], [AMOUNT_INVALID_TEXT, 23191127],
      [AUCTION_ENDED_TEXT, 23498813], [UNDER_APPROVAL_TEXT, 23191127]]) {
      const miss = await fireOnce(text, { id });
      assert.strictEqual(miss.m.capExhausted, false,
        `"${text}" must NOT read as a bid-cap refusal - a false cap latch stops spending on a load that still has budget`);
      assert.strictEqual(miss.m.revisionsLeft, 30, 'and the budget is left exactly as it was');
    }

    // The MIRROR IMAGE, and it is the sharper half. LOAD_NOT_BIDDABLE_RE is the only classifier whose
    // class is TERMINAL - `load_not_biddable` stands the engine down on that load for good - so a
    // widening here does not cost a retry, it costs the whole auction. The dangerous widening is
    // concrete, not hypothetical: adding `|bidding\s+is\s+not\s+allowed` reads as a reasonable
    // synonym and silently swallows UNDER_APPROVAL_TEXT, a load merely PENDING ALLOTMENT APPROVAL
    // that SuperProcure will let us bid once approved. Asserting only `capExhausted === false` above
    // leaves that mutant alive - it was found alive by a mutation pass on 2026-08-01.
    //
    // NOT_BIDDABLE_TEXT is deliberately absent from this list: it is the one string that MUST latch
    // the terminal class, and B1 asserts that positively.
    for (const [text, id] of [[AMOUNT_INVALID_TEXT, 23191127], [AUCTION_ENDED_TEXT, 23498813],
      [UNDER_APPROVAL_TEXT, 23191127]]) {
      const miss = await fireOnce(text, { id });
      assert.strictEqual(miss.m.loadNotBiddable, false,
        `"${text}" must NOT read as load-not-biddable - that class is TERMINAL, so a false latch ` +
        'abandons a load SuperProcure would still have accepted a bid on');
    }
    ok('BID_CAP_REJECTION_RE and LOAD_NOT_BIDDABLE_RE are both NARROW: real neighbours stay out of each');
  }

  // ----------------------------------------------------------------------------------------------
  // B3. unknown_rejection_string_is_handled_not_swallowed
  //     A refusal matching NEITHER classifier lands in an explicitly NAMED third class - PRICE/STATE
  //     - whose behaviour is defined, not accidental. The original defect was that this bucket had
  //     no name and no defined behaviour. Mutant caught: swallowing the platform string into a
  //     generic token, or latching one of the two terminal classes on an unrecognised string.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - a real SuperProcure string that matches no classifier. This used to be
    // AUCTION_ENDED_TEXT; that string now HAS a class of its own (see B5), and an unclassified-string
    // check has to be driven by a string that is genuinely unclassified or it stops testing anything.
    // "Load is under approval for allotment. Bidding is not allowed." is the right replacement on its
    // merits and not merely because it is spare: it is verbatim from the same box snapshot, it is
    // named in LOAD_NOT_BIDDABLE_RE's own comment as the neighbour that classifier must never
    // swallow, and it is genuinely retryable - the approval clears and the load bids.
    // Act
    const { eng, m } = await fireOnce(UNDER_APPROVAL_TEXT, { id: 23498813 });

    // Assert - the class is NAMED by exclusion and observable, not silent
    assert.deepStrictEqual(classesOf(eng, m), ['price_state'],
      'an unrecognised refusal has a NAMED home - the price/state class - and is not left unclassified');
    assert.strictEqual(m.capExhausted, false, 'it does not fall through into the terminal cap class');
    assert.strictEqual(m.loadNotBiddable, false, 'nor into the terminal load-not-biddable class');

    // The platform's own words survive onto the record - that is what makes the third class
    // diagnosable rather than an undifferentiated bucket
    const rej = rejectionsOf(eng);
    assert.strictEqual(rej.length, 1, 'exactly one bid_rejected record');
    assert.strictEqual(rej[0].reason, UNDER_APPROVAL_TEXT, "the record carries SP's own string verbatim, never 'http_400'");
    assert.strictEqual(rej[0].body, UNDER_APPROVAL_TEXT, 'and the raw platform body alongside it');
    assert.strictEqual(rej[0].status, 400, 'and the HTTP status');
    assert.strictEqual(rej[0].carrierSent, CARRIER, 'and the carrier registration actually sent');

    // The class's DOWNSTREAM BEHAVIOUR is defined: nothing was placed, so the ladder position is
    // restored and the load stays retryable. Defined, not accidental.
    assert.strictEqual(m.currentRungIndex, -1, 'the ladder position is rolled back - nothing was placed');
    assert.strictEqual(m.revisionsLeft, 30, 'the budget is untouched - this is not a cap refusal');
    assert.strictEqual(m.landedBids, 0, 'and nothing is recorded as landed');
    assert.ok(!m.noBid, 'no terminal refusal is recorded - the load may still be bid');
    ok('an unrecognised refusal lands in the NAMED price/state class with its platform string intact');
  }

  // ----------------------------------------------------------------------------------------------
  // B4. reason_falls_back_to_the_raw_body
  //     The classifier must read every field the platform string can arrive on, not just `reason`.
  //     A non-real adapter (mock / sim / GoComet) may put a token in `reason` and the real words
  //     elsewhere. Mutant caught: narrowing rejectionSays to a single field.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - hand-shaped NON-real adapter responses. This is exactly the population res.body
    // exists for, so all four scanned fields are exercised.
    const cases = [
      ['text only (reason null)', { accepted: false, status: 400, reason: null, text: NOT_BIDDABLE_TEXT }, 'load_not_biddable'],
      ['raw only (reason a bare status token)', { accepted: false, status: 400, reason: 'http_400', raw: CAP_TEXT }, 'cap'],
      ['body only (the mock/sim/GoComet-shaped field)', { accepted: false, status: 400, body: CAP_TEXT }, 'cap'],
    ];

    for (const [label, response, expected] of cases) {
      const t = transport({ bid: plaintext(400, 'unused - placeBid is overridden for this case') });
      const { eng, adapter } = mkStack(t.impl);
      // The ONE place this file overrides placeBid: modelling a non-real adapter's rejection shape
      // is the whole point of the check, and no real-adapter parsing is under test here.
      adapter.placeBid = async () => response;
      const m = armFine(eng, 23481821);

      // Act
      await eng._maybeBid(m, state(ESTABLISH_MS));

      // Assert
      assert.deepStrictEqual(classesOf(eng, m), [expected],
        `${label}: the platform string was carried on a field other than reason and the classifier still saw it`);
    }

    // ...and a response carrying the string on NO field at all must not be classified into a
    // terminal class by accident.
    {
      const t = transport({ bid: plaintext(400, 'unused') });
      const { eng, adapter } = mkStack(t.impl);
      adapter.placeBid = async () => ({ accepted: false, status: 400, reason: 'http_400' });
      const m = armFine(eng, 23481821);
      await eng._maybeBid(m, state(ESTABLISH_MS));
      assert.deepStrictEqual(classesOf(eng, m), ['price_state'],
        'a refusal with no recognisable string stays in the retryable price/state class - it is never assumed terminal');
    }
    ok('the classifier reads reason, text, raw AND the defensive body - the string is found wherever it rides');
  }

  // ==============================================================================================
  // PART C - THE listingProbe SEAM. A diagnostic re-listing, called on exactly one class.
  // ==============================================================================================

  // ----------------------------------------------------------------------------------------------
  // C1. listingProbe_runs_only_on_the_not_biddable_path
  //     One extra REST read against a live shared account. Mutant caught: hoisting the probe call
  //     out of the load-not-biddable branch (which would put an extra read on every refusal,
  //     including the price/state class that retries and has a clock to beat).
  // ----------------------------------------------------------------------------------------------
  {
    const seen = {};
    for (const [label, text, id] of [['cap', CAP_TEXT, 23341274], ['not_biddable', NOT_BIDDABLE_TEXT, 23481821],
      ['price_state', AMOUNT_INVALID_TEXT, 23191127], ['unknown', AUCTION_ENDED_TEXT, 23498813]]) {
      // Arrange
      const t = transport({ bid: plaintext(400, text),
        list: async () => ({ status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ data: { loadDetails: [listingRow(id)] } }) }) });
      const { eng, adapter } = mkStack(t.impl);
      // Count the calls WITHOUT replacing the implementation - the real listingProbe still runs.
      const real = adapter.listingProbe.bind(adapter);
      const probed = [];
      adapter.listingProbe = async (aid) => { probed.push(String(aid)); return real(aid); };
      const m = armFine(eng, id);

      // Act
      await eng._maybeBid(m, state(ESTABLISH_MS));
      seen[label] = { probed, listCalls: t.calls.list.length };
    }

    // Assert
    assert.strictEqual(seen.not_biddable.probed.length, 1, 'the not-biddable class probes exactly once');
    assert.strictEqual(seen.not_biddable.probed[0], '23481821', 'and probes the refused load id');
    assert.strictEqual(seen.not_biddable.listCalls, 1, 'which costs exactly ONE extra listing read');
    for (const label of ['cap', 'price_state', 'unknown']) {
      assert.strictEqual(seen[label].probed.length, 0,
        `the ${label} class must NOT probe - it is a diagnostic re-listing, and running it on every refusal `
        + 'adds load on a shared live account for nothing');
      assert.strictEqual(seen[label].listCalls, 0, `and the ${label} class issues no listing request at all`);
    }
    ok('listingProbe runs on the not-biddable path ONLY - one read there, zero on the other three classes');
  }

  // ----------------------------------------------------------------------------------------------
  // C2. listingProbe_throw_cannot_fabricate_a_landed_bid
  //     The probe call sits inside the try{} whose catch is the UNCERTAIN-OUTCOME handler. That
  //     handler runs the read-back oracle and, failing to disprove a commit, banks the rung and
  //     increments landedBids. An unwrapped throw there turns a REJECTION into a recorded landed
  //     bid - a false money record. Mutant caught: removing the try/catch around the probe call.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange
    const t = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT) });
    const { eng, adapter } = mkStack(t.impl);
    adapter.listingProbe = async () => { throw new Error('listing read blew up'); };
    const m = armFine(eng, 23481821);

    // Act
    await eng._maybeBid(m, state(ESTABLISH_MS));

    // Assert - the money record is untouched
    assert.strictEqual(m.landedBids, 0, 'a throwing probe does NOT fabricate a landed bid out of a refused one');
    assert.strictEqual(m.lastBidPrice, null, 'nor a last bid price');
    assert.strictEqual(m.currentRungIndex, -1, 'nor advance the ladder position as if a bid had landed');
    assert.strictEqual(alertsOfKind(eng, 'bid_submit_error').length, 0,
      'and the UNCERTAIN-OUTCOME handler was never entered - its alert is the tell, and it is absent');

    // ...and the refusal is still handled normally around the contained throw
    assert.strictEqual(m.loadNotBiddable, true, 'the class still latched');
    assert.strictEqual(rejectionsOf(eng).length, 1, 'the rejection is still recorded');
    assert.strictEqual(alertsOfKind(eng, 'load_not_biddable').length, 1, 'and the desk notice still fires');

    // The REAL listingProbe cannot throw at all - it returns an envelope either way. Pin BOTH of its
    // failure shapes, so the engine wrap above is belt and the adapter is suspenders.
    //
    // (a) a failure listAuctions PROPAGATES (an expired token -> ensureSession throws code AUTH)
    //     produces the explicit error envelope: four nulls plus an `error` string.
    const tAuth = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT) });
    const aAuth = mkAdapter(tAuth.impl);
    aAuth.account.tokenExp = Date.now(); // inside ensureSession's 60s expiry guard -> throws AUTH
    const failed = await aAuth.listingProbe(23481821);
    assert.strictEqual(typeof failed, 'object', 'the real listingProbe returns an object on a failed read, never throws');
    assert.deepStrictEqual(keysOf(failed), ['biddingCloseTime', 'biddingOn', 'error', 'listedCount', 'stillListed'],
      'the failure envelope is the success envelope plus an `error` string - a distinct, explicit shape');
    assert.strictEqual(failed.stillListed, null, 'a failed probe reports UNKNOWN, never a fabricated false');
    assert.strictEqual(failed.biddingOn, null, 'with a null biddingOn');
    assert.strictEqual(failed.listedCount, null, 'and a null listedCount - no count was ever read');
    assert.strictEqual(typeof failed.error, 'string', 'and names why');

    // (b) named re-pin, S2002: a TRANSPORT failure now reaches that same error envelope. It used to
    //     take the success envelope with stillListed:false, listedCount:0 - byte-identical to a
    //     genuine delist - because listAuctions returned [] for a listing it never read.
    const tNet = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT), list: async () => { throw new Error('ECONNRESET'); } });
    const aNet = mkAdapter(tNet.impl);
    aNet.sleep = async () => {}; // the listing read is retry:true; do not actually back off in a test
    const netProbe = await aNet.listingProbe(23481821);
    assert.deepStrictEqual(keysOf(netProbe), ['biddingCloseTime', 'biddingOn', 'error', 'listedCount', 'stillListed'],
      'a transport failure takes the failure envelope - an unread listing is not an empty one');
    assert.strictEqual(netProbe.stillListed, null, 'and reports UNKNOWN, never a delist it could not see');
    assert.strictEqual(netProbe.listedCount, null, 'with a null listedCount - no listing was read');
    ok('a throwing listingProbe is contained: no landed bid, no uncertain-outcome route, and both real failure shapes are pinned');
  }

  // ----------------------------------------------------------------------------------------------
  // C3. listingProbe_returns_the_diagnostic_fields
  //     The probe's own response contract. Mutant caught: renaming/dropping any of the four fields,
  //     or reporting a delisted load as stillListed.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - the load IS still listed
    const t = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT),
      list: async () => ({ status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ data: { loadDetails: [listingRow(23481821), listingRow(23090881)] } }) }) });
    const a = mkAdapter(t.impl);

    // Act
    const probe = await a.listingProbe(23481821);

    // Assert
    assert.deepStrictEqual(keysOf(probe), ['biddingCloseTime', 'biddingOn', 'listedCount', 'stillListed'],
      'the probe envelope is exactly these four fields - no additional properties');
    assert.strictEqual(probe.stillListed, true, 'stillListed is a boolean, true for a load in the fresh listing');
    assert.strictEqual(probe.biddingOn, true, 'biddingOn is the mapped boolean (SP sends 1), not the raw integer');
    assert.strictEqual(typeof probe.biddingCloseTime, 'string', "biddingCloseTime is SP's RAW time string");
    assert.strictEqual(probe.listedCount, 2, 'listedCount is how many loads the listing returned');

    // ...and the DELISTED case, which is the hypothesis the probe exists to separate
    const gone = await a.listingProbe(23718407);
    assert.deepStrictEqual(keysOf(gone), ['biddingCloseTime', 'biddingOn', 'listedCount', 'stillListed'],
      'the absent-load result keeps the same envelope');
    assert.strictEqual(gone.stillListed, false, 'a load absent from the listing reports stillListed false');
    assert.strictEqual(gone.biddingOn, null, 'with a null biddingOn - unknown, never fabricated');
    assert.strictEqual(gone.biddingCloseTime, null, 'and a null close time');
    assert.strictEqual(gone.listedCount, 2, 'listedCount still reports what the listing carried');

    // The cached-age telemetry that rides alongside it (listingTrace, the free half of the pair)
    const trace = a.listingTrace(23481821);
    assert.deepStrictEqual(keysOf(trace), ['biddingOn', 'lastSeenInListAgoMs', 'lastSeenInListAt'],
      'listingTrace has its own three-field envelope');
    assert.ok(trace.lastSeenInListAgoMs != null && trace.lastSeenInListAgoMs < 5_000,
      'the cached age is ~now for a load the probe just listed');
    assert.strictEqual(a.listingTrace(99999999).lastSeenInListAgoMs, null,
      'a never-listed load reports a null age, never a fabricated one');
    ok('listingProbe returns stillListed / biddingOn / biddingCloseTime / listedCount, with the cached-age pair');
  }

  // ----------------------------------------------------------------------------------------------
  // C4. listingProbe_close_time_is_raw_and_must_be_bound_checked
  //     biddingCloseTime comes off the probe as SuperProcure's RAW string, not a validated deadline.
  //     SP emits a shared year-2100 placeholder that PARSES as a valid date and defeats every NaN
  //     guard (observed live 2026-07-11 across unrelated shippers). Mutant caught: any consumer
  //     treating this field as a checked deadline, or the adapter silently swapping it for closesAt.
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - the placeholder pair, on a biddingOn:0 load, exactly as SP sends it
    const t = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT),
      list: async () => ({ status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ data: { loadDetails: [listingRow(23718407, { biddingOn: 0, closeTime: YEAR_2100_CLOSE })] } }) }) });
    const a = mkAdapter(t.impl);

    // Act
    const probe = await a.listingProbe(23718407);

    // Assert - the raw string is surfaced verbatim, and it is NOT a usable deadline
    assert.strictEqual(probe.stillListed, true, 'the placeholder load is still LISTED - the probe reports the listing, not the schedule');
    assert.strictEqual(probe.biddingCloseTime, YEAR_2100_CLOSE, "biddingCloseTime is SP's raw string, carried verbatim");
    const parsed = Date.parse(probe.biddingCloseTime);
    assert.ok(!Number.isNaN(parsed), 'the placeholder PARSES as a valid date - this is why a NaN guard misses it');
    assert.ok(parsed - Date.now() > MAX_PLAUSIBLE_DEADLINE_MS,
      'and it sits far outside the plausibility bound, so every consumer must bound-check this field rather than trust it');

    // The adapter's own bound-checked field disagrees with the raw one, which is the whole point
    const mapped = a.loadMeta.get('23718407');
    assert.strictEqual(mapped.closesAt, null, 'the adapter bound-checks its OWN closesAt to null for the placeholder');
    assert.strictEqual(mapped.biddingCloseTime, YEAR_2100_CLOSE, 'while carrying the raw string untouched beside it');
    ok('probe biddingCloseTime is RAW: the year-2100 placeholder parses valid, and only the bound check rejects it');
  }

  // ----------------------------------------------------------------------------------------------
  // C5. probe_fields_reach_the_desk_alert_with_the_cached_age
  //     The engine -> notify seam for this class. Mutant caught: dropping stillListed /
  //     listedBiddingOn / lastSeenInListAgoMs from the alert, or losing a scope key (without
  //     lane / companyName / branchName the notice cannot route to the customer's own group).
  // ----------------------------------------------------------------------------------------------
  {
    // Arrange - the load has been listed once already, so the cached age is real, not null
    const t = transport({ bid: plaintext(400, NOT_BIDDABLE_TEXT),
      list: async () => ({ status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ data: { loadDetails: [listingRow(23481821)] } }) }) });
    const { eng, adapter } = mkStack(t.impl);
    await adapter.listAuctions();               // primes loadLastSeenAt + loadMeta, as discovery does
    const m = armFine(eng, 23481821);

    // Act
    await eng._maybeBid(m, state(ESTABLISH_MS));

    // Assert - the alert payload contract
    const alerts = alertsOfKind(eng, 'load_not_biddable');
    assert.strictEqual(alerts.length, 1, 'exactly one desk notice for the load (latched, not one per poll)');
    assert.deepStrictEqual(keysOf(alerts[0]), [
      'auctionId', 'biddingOn', 'branchName', 'companyName', 'kind', 'lane', 'lastSeenInListAgoMs',
      'level', 'listedBiddingOn', 'stillListed', 'ts', 'type',
    ], 'the load_not_biddable alert payload is exactly this - the notify layer parses these keys');
    assert.strictEqual(typeof alerts[0].ts, 'number', 'the engine stamps every emitted event with an epoch-ms ts');
    assert.strictEqual(alerts[0].level, 'warn', 'it is a warn-level desk notice, not an ops error');
    assert.strictEqual(alerts[0].stillListed, true, 'the LIVE probe result rides the alert');
    assert.strictEqual(alerts[0].listedBiddingOn, true, 'including the biddingOn the fresh listing carried');
    assert.ok(alerts[0].lastSeenInListAgoMs != null && alerts[0].lastSeenInListAgoMs < 5_000,
      'alongside the CACHED age - the two together are what separate "SP delisted it" from "we have not polled"');
    assert.strictEqual(alerts[0].biddingOn, true, 'and the cached biddingOn');
    assert.strictEqual(alerts[0].companyName, 'Borosil', 'the shipper scope key is present (the group must be matchable)');
    assert.strictEqual(alerts[0].branchName, 'Alwar Cable (1350)', 'and the branch scope key');

    // The same two facts also ride the rejection RECORD, which is the durable half
    const rej = rejectionsOf(eng);
    assert.strictEqual(rej.length, 1, 'one bid_rejected record');
    assert.ok(rej[0].lastSeenInListAgoMs != null, 'the record carries the cached listing age');
    assert.strictEqual(rej[0].biddingOn, true, 'and the cached biddingOn');
    assert.strictEqual(rej[0].body, NOT_BIDDABLE_TEXT, 'and the raw platform body verbatim');
    ok('the not-biddable desk alert carries the live probe fields, the cached age and all three scope keys');
  }

  cleanup();
  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { cleanup(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
