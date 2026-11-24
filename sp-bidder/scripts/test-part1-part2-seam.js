'use strict';
/**
 * The GoComet Part 1 / Part 2 seam, made checkable.
 *
 * docs/GOCOMET_PART2_SEAM.md states in prose what the GoComet integration does today and what it
 * deliberately does NOT do: it discovers, surfaces, prices and bids a load, and then goes quiet
 * when the auction extends. Competing THROUGH extension rounds is a separate, unbuilt piece of
 * work. A document saying that rots the first time someone wires one of the hooks it lists as
 * inert, and nothing anywhere would fail.
 *
 * This file is what fails. Two halves:
 *
 *   A. THE BEHAVIOURAL CONTRACT, at the predicate level. The engine's own decision predicates are
 *      called against a monitor shaped exactly as a GoComet load arms one, and asserted to take the
 *      Module-1 hard-close answer. Each claim is paired with a CONTRAST case on a SuperProcure-shaped
 *      monitor that takes the other branch, so an assertion cannot pass by being trivially true.
 *
 *   B. THE INERT-HOOK GATE, in the grep-gate spirit of scripts/test-store.js. Every capability the
 *      adapter declares that nothing above the seam consumes is listed here with its allowed
 *      call sites. Wiring one is Part 2 work; doing it makes this file fail and forces the doc to
 *      be updated in the same commit.
 *
 * THE ADAPTER LAYER is src/platform/ plus src/sim/ - both hold PlatformAdapter implementations
 * (src/sim/gocometSim.js extends it), so a declaration living in either is a declaration, not a
 * consumer. Everything else in src/ is above the seam.
 *
 *   node scripts/test-part1-part2-seam.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { BidEngine, DEFAULTS } = require('../src/engine/bidEngine');
const { INERT_MECHANISMS } = require('../src/platform/gocometStack');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Every check below must run. A file that exits 0 having asserted nothing is a silent green run in
// this project's exit-code-graded runner, so the sentinel at the bottom pins the count.
const EXPECTED_CHECKS = 27;

const SRC_ROOT = path.join(__dirname, '..', 'src');
const ADAPTER_LAYER = ['platform', 'sim'];

/** Every .js file under src/, as paths relative to src/ with forward slashes. */
function srcFiles() {
  const out = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (ent.name.endsWith('.js')) out.push(path.relative(SRC_ROOT, p).split(path.sep).join('/'));
    }
  })(SRC_ROOT);
  return out;
}

/** Files mentioning `ident` as a whole word, excluding the adapter layer. */
function referencesAboveTheSeam(files, ident) {
  const re = new RegExp(`\\b${ident}\\b`);
  return files.filter((rel) => !ADAPTER_LAYER.includes(rel.split('/')[0]))
    .filter((rel) => re.test(fs.readFileSync(path.join(SRC_ROOT, rel), 'utf8')));
}

// ---- test doubles -----------------------------------------------------------------------------

const proto = BidEngine.prototype;

/**
 * A bare `this` carrying only the predicates under test plus the config they read. The predicates
 * are pure functions of (monitor, remaining) and the engine's own cfg, so exercising them this way
 * asserts the DEPLOYED code rather than a re-implementation of it - constructing a full BidEngine
 * would need an adapter, a scheduler and a store to assert a boolean.
 */
function predicates(cfg = {}) {
  return {
    cfg: Object.assign({ floorWindowMs: DEFAULTS.floorWindowMs, finalizeDebounceMs: DEFAULTS.finalizeDebounceMs }, cfg),
    emit: () => {},
    _effectivelyHard: proto._effectivelyHard,
    _softFinalShotBand: proto._softFinalShotBand,
    _decisiveBandFor: proto._decisiveBandFor,
    _isLastChance: proto._isLastChance,
    _softEndgameUnlocked: proto._softEndgameUnlocked,
    _decisiveShotDue: proto._decisiveShotDue,
    _observeExtension: proto._observeExtension,
    // _observeExtension carries its round record and confirmed close onto the durable intent, so the
    // double needs that collaborator too or it stops exercising the deployed code. Inert here: `get`
    // answering null is "no intent for this id", which is the method's own no-write path.
    // named re-pin: round tracker, ruling 56 - _persistBelievedClose became _persistRound, and
    // _effectivelyHard reads the round verdict through roundVerdict.
    _persistRound: proto._persistRound,
    roundVerdict: proto.roundVerdict,
    _clearSubmissionClosedOnForwardMove: proto._clearSubmissionClosedOnForwardMove,
    scheduler: { get: () => null, update: () => null },
    log: { warn: () => {} },
  };
}

/**
 * A monitor shaped as arm() builds one for a GoComet load, field for field:
 *   closeModel   'soft'  - seeded from caps.closeModel (gocometAdapter declares 'soft')
 *   softStrategy 'off'   - _resolveSoftStrategy: no GoComet shipper is on config.softClose.shippers,
 *                          and enrolling one there would also change SuperProcure endgame semantics
 *                          for any SP shipper whose name token-matches (gocometStack.js says so)
 *   extendCap    null    - getAuctionState publishes extendCount: null ("cap unknown")
 *   triggerWindowMs null - GoComet publishes no anti-snipe window; the adapter never emits the field
 */
function gocometMonitor(over = {}) {
  return Object.assign({
    auctionId: 'GC-1', closeModel: 'soft', softStrategy: 'off',
    extendCap: null, extendsObserved: 0, triggerWindowMs: null,
    believedCloseAt: null, finalized: false, _zeroSince: null, _zeroRunExtendAt: null,
    meta: { lane: { origin: 'Bhiwandi', destination: 'Hosur' }, companyName: 'Waaree Energies' },
  }, over);
}

(async () => {
  // =============================================================================================
  // A. THE PART 1 BEHAVIOURAL CONTRACT - "it bids, then goes quiet when the auction extends"
  // =============================================================================================

  // ---- A1. every GoComet load is treated as if its believed close were final ----
  {
    ok(predicates()._effectivelyHard(gocometMonitor()) === true,
      'A1: a GoComet load reads effectively-hard - the Module-1 snipe owns its endgame');

    // Not vacuous on softStrategy alone. Enrolling a GoComet shipper on the soft-close allowlist
    // does NOT buy extension play: the UNKNOWN cap is the second, independent fail-closed degrade.
    ok(predicates()._effectivelyHard(gocometMonitor({ softStrategy: 'live' })) === true,
      'A1: even a soft-enrolled GoComet load stays effectively-hard - an UNKNOWN cap fails closed (Part 2 item 1)');

    // CONTRAST - a SuperProcure soft branch publishing a real cap with rounds left takes the other
    // branch, which is what proves the two assertions above are reading extendCap and not passing
    // by construction.
    ok(predicates()._effectivelyHard(
      gocometMonitor({ softStrategy: 'live', extendCap: 3, extendsObserved: 1 })) === false,
    'A1 contrast: a KNOWN cap with rounds remaining is NOT effectively-hard - the reserve-gated defend owns it');
  }

  // ---- A2. there is no decisive band, so the decisive shot is the flat 2.5s floor window ----
  {
    ok(predicates()._decisiveBandFor(gocometMonitor()) === null,
      'A2: no decisive band on a GoComet load (softStrategy off)');
    ok(predicates()._decisiveBandFor(gocometMonitor({ softStrategy: 'live' })) === null,
      'A2: no decisive band even soft-enrolled - triggerWindowMs is never published, so no window is invented');

    const band = predicates()._decisiveBandFor(
      gocometMonitor({ softStrategy: 'live', extendCap: 2, extendsObserved: 2, triggerWindowMs: 100_000 }));
    ok(band === null,
      'A2 contrast: reversed 2026-09-24 - a SuperProcure soft load whose known cap is used up gets no band; after the '
      + 'extension cap final bids go in the last seconds like hard close');
    const unknownCapBand = predicates()._decisiveBandFor(
      gocometMonitor({ softStrategy: 'live', triggerWindowMs: 100_000 }));
    ok(unknownCapBand != null && unknownCapBand.closesAt === 100_000
      && unknownCapBand.opensAt === 100_000 + DEFAULTS.floorWindowMs,
    'A2 contrast: a SuperProcure soft load with an unknown cap that DOES publish a window gets the band above it');
  }

  // ---- A3. the decisive shot collapses to _isLastChance - 2.5s, flat ----
  {
    const p = predicates();
    ok(p._decisiveShotDue(gocometMonitor(), 2_400) === true,
      'A3: the GoComet decisive shot is due inside the flat 2.5s floor window');
    ok(p._decisiveShotDue(gocometMonitor(), 2_600) === false,
      'A3: and not before it - identical to the deployed hard-close predicate');
    ok(p._decisiveShotDue(gocometMonitor(), 2_400) === p._isLastChance(2_400)
      && p._decisiveShotDue(gocometMonitor(), 60_000) === p._isLastChance(60_000),
    'A3: _decisiveShotDue IS _isLastChance on a GoComet load - the trigger-window-aware unlock never runs');
  }

  // ---- A4. extension ROUNDS are not even counted ----
  {
    // A forward close-time jump of a full extend interval - the authoritative extension signal.
    // named re-pin: round tracker, ruling 56 - a close is read through the plausibility bound, so the
    // fixture's closes are real times rather than 1970 ones.
    const T0 = Date.now() + 60_000;
    const state = { closesAtMs: T0 + 300_000, closesInMs: 60_000, extendMs: 300_000, extendCount: null };
    const m = gocometMonitor({ believedCloseAt: T0 });
    ok(predicates()._observeExtension(m, state) === false,
      'A4: _observeExtension is a no-op on a GoComet load - softStrategy off returns before reading the jump');
    ok(m.extendsObserved === 0,
      'A4: extendsObserved stays 0 through a full extension - Part 1 has no model of the rounds at all');

    // CONTRAST - the identical state on a soft-enrolled monitor DOES count the round, so the gate
    // above is the softStrategy check and not an unreadable state shape.
    const live = gocometMonitor({ softStrategy: 'live', believedCloseAt: T0 });
    ok(predicates()._observeExtension(live, state) === true && live.extendsObserved === 1,
      'A4 contrast: the same forward jump IS counted once soft-close is engaged');
  }

  // =============================================================================================
  // B. THE INERT-HOOK GATE - a declared capability nobody reads
  // =============================================================================================

  const files = srcFiles();

  /**
   * Declared-but-unconsumed capabilities. Wiring any of these is Part 2 work and must land with a
   * doc update, so each is pinned to the call sites allowed to mention it. The adapter layer is
   * always allowed - that is where the declaration lives.
   */
  const INERT_CAPABILITIES = [
    ['snipeBudgetMs', ['engine/bidEngine.js'],
      'the write-side snipe runway. Owner ruling 2026-09-24 (GoComet bids go at the ~5 s buzzer): the engine reads it for provisional-close loads only (_writeRunwayMs); nothing else above the seam may'],
    ['livenessExpectedMs', ['notify/heartbeat.js'],
      'named reversal: C101/C073 (26 Sep) - the silent-failure detector MULTI_PLATFORM_ARCHITECTURE.md '
      + 'requires. heartbeat.js\'s collectGoComet is now the one allowed consumer, deriving the `live` '
      + 'flag off lastListSucceededAt; nothing else above the seam may read it'],
    ['reactiveClose', [],
      'never precompute a cutoff. The engine already polls, so nothing acts on the declaration'],
    ['allowsTieRate', [],
      'whether an equal rate is legal. No ladder or decrement path reads it on either platform'],
    ['transitField', [],
      'GoComet has no transit-time field. The SP transit refusal is keyed off load rules, not this'],
    ['priceWriteType', [],
      'number-vs-string on the wire. The adapter writes a number directly; nothing above the seam branches'],
    ['tokenLifetime', [],
      'the ~30-day JWT. Expiry alerting runs off the parsed exp claim, never off this string'],
    ['multiCargo', ['web/server.js'],
      'STATED, never acted on - server.js prints it in one boot log line. The behavioural fact is multiCargoBidSupported, which the desk page does consume'],
  ];

  for (const [key, allow, why] of INERT_CAPABILITIES) {
    const refs = referencesAboveTheSeam(files, key).filter((f) => !allow.includes(f));
    ok(refs.length === 0,
      `B: capability '${key}' has no consumer above the platform seam (${why}) - found: ${JSON.stringify(refs)}`);
  }

  // ---- B2. declared engine capabilities; the floor window is not derived from any ----
  {
    const engineSrc = fs.readFileSync(path.join(SRC_ROOT, 'engine', 'bidEngine.js'), 'utf8');
    const read = [...new Set((engineSrc.match(/this\.caps\.(\w+)/g) || []).map((s) => s.split('.').pop()))].sort();
    const ENGINE_CAPS = ['closeModel', 'durableSubmissionTracking', 'minDecrement', 'revisionLimit', 'settledOutcomeRequiresOwnPosition', 'settledOutcomeWhenRankUnknownOnly', 'snipeBudgetMs', 'standingPriceVisible'];
    // Reported rather than thrown, so a Part 2 change that trips several gates at once shows all of
    // them in one run instead of stopping at the first.
    ok(read.join(',') === ENGINE_CAPS.join(','),
      `B2: bidEngine reads exactly ${ENGINE_CAPS.join(' / ')} off capabilities() (SuperProcure verifies every participated close; older adapter rank policy remains supported) - found: ${JSON.stringify(read)}`);

    // The floor window stays a static config default for every load. snipeBudgetMs is read at ONE
    // site, the provisional-close write runway, so a second consumer cannot arrive quietly.
    ok(DEFAULTS.floorWindowMs === 2_500 && (engineSrc.match(/snipeBudget/g) || []).length === 1,
      'B2: the floor window is a static 2,500ms engine default, and snipeBudgetMs is read at exactly one site (owner ruling 2026-09-24: the GoComet buzzer and write runway, provisional-close loads only)');

    // State fields the GoComet adapter publishes that the engine does not read. No construction-time
    // check can see a per-tick field, so this is the only place their inertness is recorded. The
    // "no cap exists" declaration reaches the engine only as the capability predicate.
    ok(!/\bextensionCeiling\b/.test(engineSrc) && /closeIsProvisional\(this\.caps\)/.test(engineSrc),
      'B2: the engine never reads extensionCeiling itself - it selects provisional-close loads through closeIsProvisional(caps) (owner ruling 2026-09-24: GoComet final-round timing)');
    ok(!/\bbiddingClosed\b/.test(engineSrc),
      'B2: the engine never reads state.biddingClosed - close is derived from the countdown, deliberately');
  }

  // ---- B3. the one inert mechanism that is already declared stays declared ----
  {
    const fields = INERT_MECHANISMS.map((m) => m.field);
    ok(fields.includes('triggerWindowMs'),
      'B3: gocometStack still declares triggerWindowMs inert - the boot warning the doc points at is live');
    ok(INERT_MECHANISMS.every((m) => m.mechanism && m.effect),
      'B3: every inert-mechanism entry states the mechanism and what its absence degrades to');
  }

  // ---- completion sentinel ----
  // The runner grades by EXIT CODE, so an early return or a swallowed throw would otherwise exit 0
  // as a green zero-assertion run. Assert the full check count actually executed.
  assert.strictEqual(fail, 0, `${fail} Part 1 / Part 2 seam checks failed`);
  assert.strictEqual(pass, EXPECTED_CHECKS,
    `expected ${EXPECTED_CHECKS} checks to run, got ${pass} - the file exited early or a block was skipped`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
