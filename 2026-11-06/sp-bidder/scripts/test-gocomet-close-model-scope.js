'use strict';
/**
 * Close-model scope gate across BOTH platforms - the regression for a fail-closed default that
 * was failing OPEN on GoComet.
 *
 * THE DEFECT. gocometAdapter._mapEnquiry emitted `closeModel: 'soft'` and set NEITHER `softClose`
 * NOR `closeModelKnown`. discovery.isOutOfHardCloseScope read only those two booleans, so for a
 * GoComet load it evaluated `!!undefined || (undefined === false)` -> false -> NOT out of scope.
 * GoComet auctions auto-extend (roughly two in three extend at least once, +5 min each; one
 * observed auction extended 22 times and closed nearly two hours past its posted time), so a
 * permanently-extending auction was admitted as though it had a fixed deadline, on a deployment
 * configured hard-close-only. Every downstream property that assumes a real deadline - the
 * latency-compensated snipe fire, the ladder walk-down, finalize-on-zero - would then have been
 * reasoning against a close time that can move.
 *
 * The fact was never wrong, only stated in the vocabulary the gate does not speak: load-level the
 * close model is the softClose/closeModelKnown BOOLEAN PAIR, while `closeModel` is the
 * adapter/state STRING from capabilities() and getAuctionState().
 *
 * WHAT THIS PINS:
 *   A. _mapEnquiry sets both booleans, so the gate sees the fact it acts on.
 *   B. a GoComet extending load is OUT of scope for a hard-close-only deployment, end to end
 *      from listAuctions through discovery.matchesAllowlist.
 *   C. an UNKNOWN close model is OUT of scope (the fail-closed direction, unchanged).
 *   D. a genuine hard-close load is still IN scope (the fix does not over-exclude).
 *   E. the SuperProcure path is UNCHANGED - hard/soft/unknown classify exactly as before.
 *   F. the belt: a load declaring only closeModel:'soft', with neither boolean, is now held OUT.
 *      This is what stops the same mistake failing open again in the next adapter.
 *   G. the deliberate carve-out survives: a load carrying none of the three fields (a legacy
 *      persisted snapshot, a simulator load) stays IN scope.
 *
 *   node scripts/test-gocomet-close-model-scope.js
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { DiscoveryPoller, isOutOfHardCloseScope } = require('../src/discovery/discovery');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Every check below must run. A file that exits 0 having asserted nothing is a silent green run
// in this project's exit-code-graded runner, so the sentinel at the bottom pins the count.
const EXPECTED_CHECKS = 29;

// ---- test doubles (same shapes as scripts/test-gocomet-adapter.js) ---------------------------

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
/** A structurally-valid JWT (header.payload.sig); the signature is never checked offline. */
function makeToken(claims) {
  return `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
}
const validToken = () => makeToken({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' });

function resp(status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}
const noSleep = async () => {};

/** One raw GoComet spot enquiry, close time inside the adapter's plausibility bound. */
function rawEnquiry(over = {}) {
  return Object.assign({
    key: 'GC-1',
    bid_close_timestamp: new Date(Date.now() + 30 * 60_000).toISOString(),
    origin: 'Bhiwandi', destination: 'Hosur', mode: '32ft SXL',
    bidding_closed: false, name: 'Spot enquiry 1', client_company_name: 'Waaree Energies',
  }, over);
}

/**
 * A hard-close-only poller. `shippers` is an explicit list matching the load's companyName so the
 * shipper filter always passes and the ONLY variable under test is the close-model gate - the same
 * isolation scripts/test-hardclose-scope.js uses (an empty list now fails closed and can no longer
 * stand in for "no shipper filter").
 */
function hardCloseOnlyPoller() {
  return new DiscoveryPoller({
    adapter: {}, requests: {}, notifier: {},
    config: { allowlist: { shippers: ['Waaree', 'Syngenta'], lanes: [], hardCloseOnly: true } },
  });
}

(async () => {
  // ---- A. _mapEnquiry states the close model in the vocabulary the gate reads ----
  {
    const a = new GoCometAdapter({ token: validToken(), sleep: noSleep });
    const m = a._mapEnquiry(rawEnquiry());

    ok(m !== null, 'A: a plausible-close-time enquiry maps (not excluded by the time bound)');
    ok(m.softClose === true, 'A: _mapEnquiry sets softClose TRUE (was: absent -> gate read undefined)');
    ok(m.closeModelKnown === true, 'A: _mapEnquiry sets closeModelKnown TRUE (was: absent)');
    ok(m.closeModel === 'soft', 'A: the honest closeModel string is still carried alongside');
    // the exact expression that used to fail open, asserted on the real mapped object:
    ok(isOutOfHardCloseScope(m) === true, 'A: the mapped GoComet load is OUT of hard-close scope (was: false)');
  }

  // ---- B. end to end: listAuctions -> matchesAllowlist, hard-close-only deployment ----
  {
    const a = new GoCometAdapter({
      token: validToken(), sleep: noSleep,
      fetchImpl: async () => resp(200, { data: { enquiries: [rawEnquiry({ key: 'GC-E2E' })], total_page: 1 } }),
    });
    const loads = await a.listAuctions();
    ok(loads.length === 1 && loads[0].id === 'GC-E2E', 'B: listAuctions returns the mapped enquiry');
    ok(loads[0].softClose === true && loads[0].closeModelKnown === true,
      'B: the close-model booleans survive the real listAuctions path, not just _mapEnquiry');

    // Straight off listAuctions, with nothing patched in. This used to Object.assign a companyName
    // on, because the mapper emitted `shipper` and the allowlist reads `companyName` - so the check
    // could only ever prove the gate worked when handed a key the mapper did not produce. The mapper
    // emits `companyName` now, so the load goes in as mapped and this asserts the whole path.
    ok(loads[0].companyName === 'Waaree Energies',
      'B: the mapped load carries companyName - the key matchesAllowlist actually reads');
    ok(hardCloseOnlyPoller().matchesAllowlist(loads[0]) === false,
      'B: an extending GoComet load is EXCLUDED from a hard-close-only deployment (was: admitted)');
  }

  // ---- C. an UNKNOWN close model is out of scope (fail-closed direction preserved) ----
  {
    const base = { companyName: 'Syngenta', lane: { origin: 'A', destination: 'B' } };
    ok(isOutOfHardCloseScope({ softClose: false, closeModelKnown: false }) === true,
      'C: closeModelKnown false -> OUT of scope');
    ok(isOutOfHardCloseScope({ softClose: false, closeModelKnown: false, closeModel: 'hard' }) === true,
      'C: an unverified load claiming "hard" is STILL out - the booleans are not overridden by the string');
    ok(isOutOfHardCloseScope({ closeModel: 'unknown' }) === true,
      'C: a declared "unknown" close model is OUT of scope');
    ok(hardCloseOnlyPoller().matchesAllowlist(Object.assign({ softClose: false, closeModelKnown: false }, base)) === false,
      'C: matchesAllowlist excludes the unverified load');
  }

  // ---- D. a genuine hard-close load is still in scope (the fix does not over-exclude) ----
  {
    const base = { companyName: 'Syngenta', lane: { origin: 'A', destination: 'B' } };
    ok(isOutOfHardCloseScope({ softClose: false, closeModelKnown: true }) === false,
      'D: confirmed hard close is IN scope');
    ok(isOutOfHardCloseScope({ softClose: false, closeModelKnown: true, closeModel: 'hard' }) === false,
      'D: confirmed hard close carrying an explicit "hard" string is IN scope');
    ok(hardCloseOnlyPoller().matchesAllowlist(Object.assign({ softClose: false, closeModelKnown: true }, base)) === true,
      'D: matchesAllowlist admits the confirmed hard-close load');
  }

  // ---- E. the SuperProcure path is UNCHANGED ----
  // realAdapter._mapLoad already set both booleans off branchAuctionExtendTime; this pins that the
  // gate's new closeModel branch cannot disturb it (an SP load carries no top-level closeModel at
  // all, so it falls straight through to the boolean check).
  {
    const sp = new RealSuperProcureAdapter({ token: 'FAKE.TEST.TOKEN' });
    const future = new Date(Date.now() + 600_000).toISOString();
    const map = (ext) => sp._mapLoad({ id: 1, biddingCloseTime: future, branchAuctionExtendTime: ext });

    const hard = map('00:00:00');
    ok(hard.softClose === false && hard.closeModelKnown === true && hard.closeModel === undefined,
      'E: SP "00:00:00" -> confirmed hard, and carries no top-level closeModel string');
    ok(isOutOfHardCloseScope(hard) === false, 'E: SP confirmed-hard load stays IN scope');

    const soft = map('00:05:00');
    ok(soft.softClose === true && soft.closeModelKnown === true, 'E: SP "00:05:00" -> confirmed soft');
    ok(isOutOfHardCloseScope(soft) === true, 'E: SP confirmed-soft load stays OUT of scope');

    const unknown = map('n/a');
    ok(unknown.softClose === false && unknown.closeModelKnown === false, 'E: SP garbage extend time -> unknown');
    ok(isOutOfHardCloseScope(unknown) === true, 'E: SP unverified load stays OUT of scope');
  }

  // ---- F. the belt: the string alone is enough to be held out ----
  // This is the structural half of the fix. An adapter that declares a close model but forgets the
  // boolean pair - exactly the mistake GoComet's mapper made - can no longer fail open.
  {
    ok(isOutOfHardCloseScope({ closeModel: 'soft' }) === true,
      'F: closeModel "soft" with NEITHER boolean is OUT of scope (the original fail-open shape)');
    ok(isOutOfHardCloseScope({ closeModel: 'SOFT  ' }) === true, 'F: the string check is case/whitespace insensitive');
    ok(isOutOfHardCloseScope({ closeModel: 'reactive-countdown' }) === true,
      'F: an unrecognised close model fails CLOSED - only the literal "hard" is admitted');
    ok(hardCloseOnlyPoller().matchesAllowlist({ companyName: 'Syngenta', lane: { origin: 'A', destination: 'B' }, closeModel: 'soft' }) === false,
      'F: matchesAllowlist excludes a string-only soft declaration');
  }

  // ---- G. the deliberate carve-out survives ----
  // A legacy persisted snapshot and a simulator load carry NONE of the three fields. Holding those
  // out would silently stop legitimate bidding and dark the whole mock/demo path, so an absent
  // closeModel must keep falling through to prior behaviour.
  {
    ok(isOutOfHardCloseScope({ softClose: false }) === false,
      'G: legacy snapshot (no closeModelKnown, no closeModel) keeps prior behaviour');
    ok(isOutOfHardCloseScope({ id: 'SIM-1', lane: { origin: 'A', destination: 'B' } }) === false,
      'G: a simulator load carrying none of the three fields stays IN scope');
    ok(isOutOfHardCloseScope(null) === false, 'G: a null load is unchanged (no caller passes one)');
  }

  // ---- completion sentinel ----
  // The runner grades by EXIT CODE, so an early return or a swallowed throw would otherwise exit 0
  // as a green zero-assertion run. Assert the full check count actually executed, not just that
  // nothing failed.
  assert.strictEqual(fail, 0, `${fail} close-model scope checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
