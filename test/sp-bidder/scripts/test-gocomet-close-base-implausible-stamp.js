'use strict';
/**
 * An implausible current_server_time (a year-2100 or epoch-0 sentinel) reaches closesAtMs
 * unbounded.
 *
 * Regression target: gocomet-adapter-fields review, Finding 4 (src/platform/gocometAdapter.js
 * getAuctionState, the srvT/srvBase/snap block).
 *
 * IMPORTANT - what this pin deliberately does NOT touch: PR-1's round-53 follow-up settled that a
 * server stamp the skew estimator REFUSES (>= 90s from the box clock) must still place the close on
 * GoComet's own clock (srvBase = srvT), never fall back to the box's - that behaviour is pinned by
 * scripts/test-gocomet-decision-countdown-skewed-clock.js and CHECK 3 below reproduces its exact
 * magnitude (a 100,000ms skew) as a control that must keep passing unmoved.
 *
 * The gap Finding 4 actually found is different in KIND, not degree: current_server_time is parsed
 * with Date.parse and used as an absolute base with NO plausibility bound at all - only
 * Number.isNaN(srvT) gates it. A genuinely absurd stamp (a different CALENDAR YEAR, or epoch 0)
 * still parses to a finite number, so it is NOT NaN, and it becomes srvBase (and, via the `snap`
 * branch, the base of liveCloseAtMs itself) exactly as if it were a normal clock reading - carrying
 * a decades-scale absolute time straight into the published closesAtMs, which bidEngine.js reads
 * unconditionally (Number.isFinite gate only) and republishes as meta.closesAt. This is the same
 * class of defect as SuperProcure's year-2100 placeholder close time, on the other platform's clock
 * field instead of its close field.
 *
 * The fix must treat "parses, but nowhere near plausible" the same as "did not parse" for both the
 * srvBase fallback AND the snap flag - so an absurd stamp degrades to exactly the already-safe
 * unparseable-stamp path (srvBase = serverNow(), no snap), never to a decades-off absolute close.
 *
 *   node scripts/test-gocomet-close-base-implausible-stamp.js
 */
const assert = require('assert');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const validToken = () => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' })}.sig`;
const noSleep = async () => {};
const fixedNow = (t) => () => t;
function resp(status, body) { return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) }; }

const BASE = 1_700_000_000_000; // an ordinary, arbitrary "now" - Nov 2023, deterministic

async function stateFor(key, currentServerTime, bidClosingIn) {
  const fetchImpl = async (url) => (String(url).includes('/bidding-data')
    ? resp(200, { data: {
      bid_closing_in: bidClosingIn, vendor_rank: 2, total_revisions: 0, revisions_left: 3,
      current_server_time: currentServerTime,
    } })
    : resp(404, {}));
  const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now: fixedNow(BASE), fetchImpl });
  await a.login();
  return a.getAuctionState(key);
}

(async () => {
  // 1. MECHANISM: a year-2100 sentinel must NOT become the close base. closesAtMs must land near
  //    BASE + 600s (a sane near-future close), not ~74 years away.
  {
    const s = await stateFor('K2100', '2100-01-01T00:00:00.000Z', 600);
    assert.ok(Number.isFinite(s.closesAtMs), 'closesAtMs must still be published (a bad stamp degrades, it does not disappear)');
    assert.ok(Math.abs(s.closesAtMs - (BASE + 600_000)) < 2000,
      `closesAtMs must be anchored on our own clock when the stamp is implausible (got ${s.closesAtMs}, expected near ${BASE + 600_000})`);
    assert.strictEqual(s.serverOffsetMs, null, 'the offset estimator still refuses the sentinel (unaffected by this fix)');
    ok('a year-2100 current_server_time does not become the close base - closesAtMs stays near our own clock');
  }

  // 2. MECHANISM, second sentinel: epoch-0 (decades in the PAST rather than the future).
  {
    const s = await stateFor('K0', '1970-01-01T00:00:00.000Z', 600);
    assert.ok(Math.abs(s.closesAtMs - (BASE + 600_000)) < 2000,
      `an epoch-0 stamp must not become the close base either (got ${s.closesAtMs}, expected near ${BASE + 600_000})`);
    ok('an epoch-0 current_server_time does not become the close base');
  }

  // 3. CONTROL: a MODERATE skew (100,000ms - the exact magnitude the pinned skewed-clock test
  //    exercises) is still USABLE as an absolute time and must still place the close on GoComet's
  //    OWN clock, unaffected by this fix - ruling 52's contract, not a bug.
  {
    const skewedStamp = new Date(BASE + 100_000).toISOString();
    const s = await stateFor('KSKEW', skewedStamp, 600);
    const expected = BASE + 100_000 + 600_000; // srvT + countedMs, snapped to the whole second
    assert.strictEqual(s.closesAtMs, expected,
      `a 100s-skewed but plausible stamp must still anchor closesAtMs on GoComet's own clock (got ${s.closesAtMs}, expected ${expected})`);
    assert.strictEqual(s.serverOffsetMs, null, 'the skew is still refused by the offset estimator (ruling 52 - unaffected)');
    ok('a moderate (100s) clock skew still anchors the close on GoComet\'s own clock - the pinned mechanism is untouched');
  }

  // 4. CONTROL: a sane, unskewed stamp behaves exactly as before.
  {
    const s = await stateFor('KSANE', new Date(BASE).toISOString(), 600);
    assert.strictEqual(s.closesAtMs, BASE + 600_000, 'a sane stamp produces the expected close');
    assert.ok(Number.isFinite(s.serverOffsetMs) && Math.abs(s.serverOffsetMs) < 1000, 'and the offset is accepted');
    ok('a sane, unskewed stamp is unaffected');
  }

  const EXPECTED = 4;
  assert.strictEqual(pass, EXPECTED, `expected ${EXPECTED} checks, ran ${pass} - the file did not run to completion`);
  console.log(`\n${pass}/${EXPECTED} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
