'use strict';
/**
 * GoComet close model - the three properties the published extension increment has to hold that
 * scripts/test-gocomet-close-model.js does not reach.
 *
 * WHAT THIS PINS:
 *   J. THE STABLE ACCESSOR. `adapter.extensionIncrementMs(key)` is the one way any other code asks
 *      for the increment. It answers before any learning, before any enquiry has been listed, and
 *      with no argument at all - the shape `capabilities()` needs, since that is bound once at
 *      engine construction.
 *   K. MONOTONICITY. The published value never decreases for the life of an enquiry, including
 *      across a running median that does decrease. A shrink sizes the engine's finalize debounce
 *      below one real step, and finalize is terminal.
 *   L. THE ESTIMATOR IS NOT RATCHETED. `learnedIncrementMs` keeps tracking the median, because it
 *      is the round divider and an operator-facing measurement, not the money-path value.
 *   M. THE SWEEP. Every per-enquiry map the close model added is emptied by _pruneDetailCaches.
 *
 *   node scripts/test-gocomet-close-model-monotonic.js
 */
const assert = require('assert');
const { GoCometCloseModel, GOCOMET_INCREMENT_DEFAULT_MS } = require('../src/platform/gocometCloseModel');
const { GoCometAdapter } = require('../src/platform/gocometAdapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// The runner grades by EXIT CODE only, so a file that returns early or never awaits its async work
// exits 0 having asserted nothing and reads as a silent green. The sentinel at the bottom pins the
// exact number of checks that ran.
const EXPECTED_CHECKS = 27;

// ---- adapter test doubles (same shapes as scripts/test-gocomet-close-model.js) -----------------
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
const makeToken = (claims) => `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(claims)}.sig`;
const validToken = () => makeToken({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, user_id: 'u1', client_id: 'c1' });
const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const noSleep = async () => {};

(async () => {
  // ---- J. the stable accessor -------------------------------------------------------------------
  // The cross-branch defect this exists to prevent: a caller reaching for a module-level constant
  // that the close model replaced. There is one published increment and this is how you ask for it.
  {
    const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now: () => Date.now() });

    ok(typeof a.extensionIncrementMs === 'function',
      'J: the adapter exposes extensionIncrementMs as a public method');
    ok(a.extensionIncrementMs() === GOCOMET_INCREMENT_DEFAULT_MS,
      'J: called with NO argument it answers the platform seed - the capabilities() shape');
    ok(a.extensionIncrementMs('NEVER-SEEN') === GOCOMET_INCREMENT_DEFAULT_MS,
      'J: an enquiry with no model and no listed plant answers the seed, not null and not a throw');
    ok(a._closeModels.size === 0,
      'J: ...and reading it allocated nothing - an accessor may not create per-enquiry state');
    ok(a.capabilities().extensionIncrementMs === GOCOMET_INCREMENT_DEFAULT_MS,
      'J: capabilities() declares the same number, resolved through the same accessor');

    // The plant seed reaches it before a single observation, which is the whole point of "safe to
    // call early": a caller at construction time must get the real seed, not a placeholder.
    const p = new GoCometAdapter({
      token: validToken(), sleep: noSleep, now: () => Date.now(),
      plantIncrementOverrides: [{ match: 'tumb', ms: 450_000 }],
    });
    p._originByKey.set('K-TUMB', { at: Date.now(), origin: 'Tumb (Umbergaon)' });
    ok(p.extensionIncrementMs('K-TUMB') === 450_000,
      'J: a listed plant seeds the accessor before any learning has happened');
    ok(p.extensionIncrementMs() === GOCOMET_INCREMENT_DEFAULT_MS,
      'J: the no-argument answer stays the platform seed and does not inherit a plant override');

    // Never throws. A caller wired in at construction time can reach it before any field it
    // touches exists, and the sibling-branch failure was exactly a ReferenceError out of
    // capabilities() being swallowed by a registration catch.
    const bare = Object.create(GoCometAdapter.prototype);
    let threw = false;
    let bareVal = null;
    try { bareVal = bare.extensionIncrementMs('K'); } catch (_) { threw = true; }
    ok(threw === false && bareVal === GOCOMET_INCREMENT_DEFAULT_MS,
      'J: it answers the seed rather than throwing even with no adapter state constructed yet');
  }

  // ---- K. the published value is monotone non-decreasing ----------------------------------------
  // median() takes the LOWER-middle element, so a second sample below the first drags the running
  // median down. 390s then 320s is that shape, and both are single-round clean-band jumps the
  // learner is entitled to use. Before the ratchet, publishedExtendMs() went 390,000 -> 320,000.
  {
    const T = 5_000_000;
    const m = new GoCometCloseModel({});
    const published = [];
    const step = (deltaMs, atMs) => {
      m.observe({ closeAtMs: m.impliedCloseAt + deltaMs, atMs });
      published.push(m.publishedExtendMs());
    };

    m.observe({ closeAtMs: T + 600_000, atMs: T });
    published.push(m.publishedExtendMs());
    ok(published[0] === 300_000, 'K: the first observation publishes the seed');

    step(300_000, T + 10_000);   // round 1 - never learned from (measured off the posted deadline)
    ok(m.roundsObserved === 1 && m.learnedIncrementMs === null,
      'K: the first extension is counted but not learned from');

    step(390_000, T + 20_000);   // clean jumps [390] -> median 390
    ok(m.publishedExtendMs() === 390_000, 'K: a plant stepping longer than the seed raises the published value');

    step(320_000, T + 30_000);   // clean jumps [390,320] -> lower-mid median 320
    step(310_000, T + 40_000);   // clean jumps [390,320,310] -> median 320
    step(305_000, T + 50_000);   // clean jumps [390,320,310,305] -> lower-mid median 310

    let monotone = true;
    for (let i = 1; i < published.length; i += 1) if (published[i] < published[i - 1]) monotone = false;
    ok(monotone === true,
      `K: the published extendMs never decreases across the sequence (saw ${published.join(' -> ')})`);
    ok(m.publishedExtendMs() === 390_000,
      'K: it holds at the high-water mark once a longer step has been published');
    ok(m.snapshot().publishedExtendMs === 390_000,
      'K: the snapshot reports the same high-water value the engine was given');

    // A plant that only ever steps SHORTER than the seed still publishes the seed - the pre-existing
    // floor, restated here because the ratchet is what now carries it.
    const lo = new GoCometCloseModel({});
    lo.observe({ closeAtMs: T + 600_000, atMs: T });
    lo.observe({ closeAtMs: T + 750_000, atMs: T + 10_000 });
    lo.observe({ closeAtMs: T + 900_000, atMs: T + 20_000 });
    ok(lo.publishedExtendMs() === 300_000, 'K: a shorter-stepping plant still publishes the seed floor');
  }

  // ---- L. the estimator keeps tracking the evidence ---------------------------------------------
  // The ratchet is scoped to the money-path value. learnedIncrementMs is the round divider and the
  // number an operator reads as "what we measured", so freezing it at a high-water mark would both
  // bias the divisor off one long jump and misreport the sample.
  {
    const T = 5_000_000;
    const m = new GoCometCloseModel({});
    m.observe({ closeAtMs: T + 600_000, atMs: T });
    m.observe({ closeAtMs: T + 900_000, atMs: T + 10_000 });
    m.observe({ closeAtMs: T + 1_290_000, atMs: T + 20_000 });   // +390s, learned 390
    ok(m.learnedIncrementMs === 390_000 && m.incrementMs === 390_000, 'L: the learner follows the first clean jump');
    m.observe({ closeAtMs: T + 1_610_000, atMs: T + 30_000 });   // +320s, median drops to 320
    ok(m.learnedIncrementMs === 320_000,
      'L: the learned increment FOLLOWS the median down - only the published value is ratcheted');
    ok(m.incrementMs === 320_000, 'L: the round divider reads the un-ratcheted estimate');
    ok(m.publishedExtendMs() === 390_000, 'L: ...while the published value stays at its high-water mark');
    ok(m.snapshot().incrementMs === 320_000 && m.snapshot().publishedExtendMs === 390_000,
      'L: the snapshot keeps the two numbers distinguishable');
  }

  // ---- M. the sweep reaches every per-enquiry map the close model added -------------------------
  // _pruneDetailCaches is the only thing bounding these. GoComet keys are never reused and discovery
  // runs for the life of the process, so a map left out of the sweep grows monotonically forever.
  {
    let t = Date.parse('2026-08-10T09:00:00Z');
    const now = () => t;
    let secs = 600;
    const fetchImpl = async (url) => {
      if (url.includes('/bidding-data')) {
        return resp(200, {
          data: {
            bid_closing_in: secs, vendor_rank: 2, total_revisions: 0, revisions_left: 3,
            current_server_time: new Date(t).toISOString(),
          },
        });
      }
      if (url.includes('/enquiries/spot')) {
        return resp(200, { data: { enquiries: [], total_page: 1 } });
      }
      return resp(404, {});
    };

    const a = new GoCometAdapter({ token: validToken(), sleep: noSleep, now, fetchImpl });
    await a.login();
    a._originByKey.set('K1', { at: t, origin: 'Tumb (Umbergaon)' });
    await a.getAuctionState('K1');
    // drive the countdown to nothing and hold it past terminalGraceMs so the terminal latch is set
    secs = null;
    t += 5_000; await a.getAuctionState('K1');
    t += 40_000; await a.getAuctionState('K1');

    ok(a._closeModels.size === 1, 'M: the enquiry has a close model');
    ok(a._originByKey.size === 1, 'M: ...and a recorded plant origin');
    ok(a._terminalLogged.size === 1, 'M: ...and a terminal-log latch');

    await a.listAuctions();
    ok(a._closeModels.size === 1 && a._originByKey.size === 1 && a._terminalLogged.size === 1,
      'M: a sweep inside the TTL keeps all three - a live enquiry is never swept out from under itself');

    t += a.detailTtlMs + 1;
    await a.listAuctions();
    ok(a._closeModels.size === 0, 'M: the sweep empties _closeModels past the TTL');
    ok(a._originByKey.size === 0, 'M: the sweep empties _originByKey past the TTL');
    ok(a._terminalLogged.size === 0, 'M: the sweep empties _terminalLogged past the TTL');
  }

  // ---- completion sentinel ----------------------------------------------------------------------
  assert.strictEqual(fail, 0, `${fail} GoComet increment-monotonicity checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e && e.stack || e); process.exit(1); });
