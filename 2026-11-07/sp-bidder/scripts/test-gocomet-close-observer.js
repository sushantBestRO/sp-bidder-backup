'use strict';
/**
 * Unit suite for the READ-ONLY GoComet close observer (scripts/observe-gocomet-close.js).
 * No network, no real timers, no wall-clock waits - drives only the pure decision helpers plus
 * `pollLoop` (with an injected getFn/sleepFn) with mocked vendor-API payloads. Covers:
 *
 *   1. parseIstClose        - GoComet "dd/mm/yyyy HH:MM" IST -> epoch ms, and null-safety
 *   2. pickNextCloser       - nearest-future OPEN load, skips Closed/past/malformed, null when none
 *   3. toTick               - /bidding-data body -> compact tick (closed inference, masked bidCount)
 *   4. detectExtension      - close-slide > threshold => extension w/ increment; jitter ignored
 *   5. extension chain       - a scripted 5-min chain reconstructs N rounds (Nandigram golden)
 *   6. computeCadenceMs     - polite: >=5s steady, 3s only in the final window, 30s far out
 *   7. summarize             - rounds / increments / total / closed
 *   8. read-only guard       - assertReadOnly + buildRequestOptions REFUSE any non-GET
 *   9. splitBody             - non-JSON rejection bodies are captured as raw text, not discarded (F5)
 *  10. parseIstClose/toTick - plausibility bound rejects placeholder timestamps (F4)
 *  11. pollLoop              - a failed poll does not destroy the extension baseline (F2)
 *  12. pollLoop              - 429 and 503 share one backoff + circuit breaker (F3)
 *  13. pollLoop              - auth failures are LOUD and fatal after 2 consecutive (F3)
 *
 *   node scripts/test-gocomet-close-observer.js
 */
const assert = require('assert');
const obs = require('./observe-gocomet-close');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// THE pinned clock for this whole file. Every fixture below is anchored to 2026-07-25, and
// parseIstClose/toTick both apply a plausibility bound (Review F4) of -7d/+30d around `nowMs`,
// defaulting to the real wall clock when the caller omits it.
//
// So an unpinned call does not just risk flakiness - it EXPIRES. Blocks 1 and 3 omitted nowMs and
// went red on 2026-08-01, exactly 7.01 days after their own fixture crossed MAX_PLAUSIBLE_PAST_MS,
// taking CI red on every open PR with them. The observer was correct throughout; only the tests
// read the wall clock. Pass FIXED_NOW to anything that reaches that bound.
const FIXED_NOW = Date.parse('2026-07-25T12:00:00+05:30');

async function main() {
  // ---- 1. parseIstClose -----------------------------------------------------
  (() => {
    const ms = obs.parseIstClose('25/07/2026 13:00', FIXED_NOW);
    assert.strictEqual(ms, Date.parse('2026-07-25T13:00:00+05:30'), 'IST close parses to the right instant');
    assert.strictEqual(obs.parseIstClose(''), null, 'empty -> null');
    assert.strictEqual(obs.parseIstClose(null), null, 'null -> null');
    assert.strictEqual(obs.parseIstClose('2026-07-25T13:00'), null, 'ISO (wrong format) -> null, never guesses');
    assert.strictEqual(obs.parseIstClose('99/99/2026 13:00'), null, 'garbage day/month -> null');
    ok('parseIstClose: IST format parses; malformed/absent -> null');
  })();

  // ---- 2. pickNextCloser ----------------------------------------------------
  (() => {
    const now = Date.parse('2026-07-25T12:00:00+05:30');
    const list = [
      { key: 'FAR', status: 'Open', bid_close_time: '25/07/2026 14:30' },
      { key: 'SOON', status: 'Open', bid_close_time: '25/07/2026 12:20' },
      { key: 'CLOSED', status: 'Closed', bid_close_time: '25/07/2026 12:05' },
      { key: 'PAST', status: 'Open', bid_close_time: '25/07/2026 11:00' },
      { key: 'BAD', status: 'Open', bid_close_time: 'not-a-date' },
    ];
    const pick = obs.pickNextCloser(list, now);
    assert.strictEqual(pick.key, 'SOON', 'nearest future OPEN load wins');
    assert.strictEqual(pick.msToClose, 20 * 60000, 'msToClose computed from IST close');
    assert.strictEqual(obs.pickNextCloser([], now), null, 'empty list -> null');
    assert.strictEqual(
      obs.pickNextCloser([{ key: 'X', status: 'Open', bid_close_time: '25/07/2026 11:00' }], now),
      null,
      'only past loads -> null'
    );
    ok('pickNextCloser: picks nearest-future Open; skips closed/past/malformed; null when none');
  })();

  // ---- 3. toTick ------------------------------------------------------------
  (() => {
    const open = obs.toTick(
      {
        bid_close_time: '25/07/2026 13:00',
        bid_closing_in: 241,
        current_server_time: '2026-07-25T12:55:59+05:30',
        vendor_rank: null,
        total_revisions: 0,
        revisions_left: 3,
      },
      200,
      FIXED_NOW
    );
    assert.strictEqual(open.closingIn, 241, 'closingIn carried');
    assert.strictEqual(open.closeMs, Date.parse('2026-07-25T13:00:00+05:30'), 'closeMs from sliding field');
    assert.strictEqual(open.revisionsLeft, 3, 'revisionsLeft carried');
    assert.strictEqual(open.bidCount, null, 'competitor bidCount is masked -> recorded null');
    assert.strictEqual(open.closed, false, 'open load: not closed');

    const done = obs.toTick({ bid_close_time: '25/07/2026 13:00', bid_closing_in: null }, 200);
    assert.strictEqual(done.closed, true, 'closingIn null -> inferred closed');
    const flagged = obs.toTick({ bid_close_time: '25/07/2026 13:00', bid_closing_in: 5, bidding_closed: true }, 200);
    assert.strictEqual(flagged.closed, true, 'explicit bidding_closed:true -> closed');
    ok('toTick: normalises bidding-data; masks bidCount; infers closed from null countdown / flag');
  })();

  // ---- 4. detectExtension ---------------------------------------------------
  (() => {
    const base = { closeMs: Date.parse('2026-07-25T13:00:00+05:30') };
    const plus5 = { closeMs: Date.parse('2026-07-25T13:05:00+05:30') };
    const plus4 = { closeMs: Date.parse('2026-07-25T13:04:00+05:30') };
    const jitter = { closeMs: base.closeMs + 30000 }; // +30s clock re-sync noise

    assert.strictEqual(obs.detectExtension(null, base).extended, false, 'no prev -> not extended');
    assert.strictEqual(obs.detectExtension(base, base).extended, false, 'unchanged close -> not extended');

    const e5 = obs.detectExtension(base, plus5);
    assert.strictEqual(e5.extended, true, '+5min is an extension');
    assert.strictEqual(e5.incrementSec, 300, '+5min increment measured as 300s');

    const e4 = obs.detectExtension(base, plus4);
    assert.strictEqual(e4.extended, true, '+4min is an extension');
    assert.strictEqual(e4.incrementSec, 240, '+4min increment measured as 240s');

    assert.strictEqual(obs.detectExtension(base, jitter).extended, false, '+30s (< 60s threshold) is NOT an extension');
    assert.strictEqual(
      obs.detectExtension(base, jitter, { thresholdSec: 10 }).extended,
      true,
      'threshold is configurable: +30s counts when threshold is 10s'
    );
    ok('detectExtension: >threshold slide => extension w/ increment; sub-threshold jitter ignored; configurable');
  })();

  // ---- 5. extension chain (Nandigram golden: 22 rounds, +5min grid) ----------
  (() => {
    // Reconstructs the on-box enquiry_extensions chain for 2601131ZPN: each recorded step is a
    // clean +300s (5-min) advance on a 5-minute grid. Feeding the observer's own detector the
    // scripted close sequence must recover the same round count and a constant 300s increment.
    const start = Date.parse('2026-01-13T18:16:00+05:30'); // first extended close
    const rounds = 22;
    let prev = { closeMs: start, closingIn: 30 };
    const detected = [];
    for (let i = 1; i <= rounds; i++) {
      const cur = { closeMs: start + i * 300000, closingIn: 30 }; // clean +300s (5-min) grid step
      const ext = obs.detectExtension(prev, cur, { thresholdSec: 60 });
      if (ext.extended) detected.push(ext.incrementSec);
      prev = cur;
    }
    assert.strictEqual(detected.length, rounds, 'all 22 scripted rounds detected');
    assert.ok(detected.every((s) => s === 300), 'every recovered increment is exactly 300s (5-min grid)');
    const sum = obs.summarize([], detected.map((s) => ({ incrementSec: s })));
    assert.strictEqual(sum.totalExtendSec, rounds * 300, 'total added time = 22 * 5min');
    ok('extension chain: 22-round +5min golden chain reconstructs cleanly (matches on-box enquiry_extensions)');
  })();

  // ---- 6. computeCadenceMs --------------------------------------------------
  (() => {
    assert.strictEqual(obs.computeCadenceMs(600), 30000, 'far out (>120s) -> 30s idle');
    assert.strictEqual(obs.computeCadenceMs(90), 10000, 'mid (30-120s) -> 10s');
    assert.strictEqual(obs.computeCadenceMs(25), 10000, 'just outside final window -> 10s (>=5s)');
    assert.strictEqual(obs.computeCadenceMs(15), 3000, 'final window (<=20s) -> 3s');
    assert.ok(obs.computeCadenceMs(null) >= 5000, 'unknown countdown -> safe steady interval');
    // The load-bearing politeness invariant: never below 5s except inside the final window.
    for (let s = 21; s <= 600; s += 7) {
      assert.ok(obs.computeCadenceMs(s) >= 5000, 'steady-state cadence never below 5s at ' + s + 's');
    }
    assert.ok(obs.computeCadenceMs(3) === 3000, 'deep final window stays at the 3s floor, never lower');
    ok('computeCadenceMs: 30s far / 10s mid / 3s only in final window; >=5s steady-state invariant holds');
  })();

  // ---- 7. summarize ---------------------------------------------------------
  (() => {
    const ticks = [
      { closeMs: 1000, closingIn: 240, closed: false },
      { closeMs: 1000, closingIn: 120, closed: false },
      { closeMs: 300000, closingIn: 5, closed: false },
      { closeMs: 300000, closingIn: null, closed: true },
    ];
    const exts = [{ incrementSec: 299 }];
    const s = obs.summarize(ticks, exts);
    assert.strictEqual(s.ticks, 4, 'tick count');
    assert.strictEqual(s.extensionRounds, 1, 'one extension round');
    assert.deepStrictEqual(s.incrementsSec, [299], 'increments listed');
    assert.strictEqual(s.totalExtendSec, 299, 'total extend time');
    assert.strictEqual(s.minClosingIn, 5, 'min countdown observed');
    assert.strictEqual(s.closed, true, 'ended closed');
    ok('summarize: rounds / increments / total / min-countdown / closed');
  })();

  // ---- 8. read-only guard ---------------------------------------------------
  (() => {
    assert.strictEqual(obs.assertReadOnly('GET'), true, 'GET is allowed');
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'get', '']) {
      assert.throws(() => obs.assertReadOnly(m), /READ-ONLY/, m + ' must be refused');
    }
    // The request builder is the only door to the network; it must throw for any write verb.
    assert.throws(() => obs.buildRequestOptions('POST', '/x', 'tok', 'h'), /READ-ONLY/, 'builder refuses POST');
    const optsGet = obs.buildRequestOptions('GET', '/api/v1/vendor/enquiries/K/bidding-data', 'TOKENVALUE', 'enquiry.gocomet.com');
    assert.strictEqual(optsGet.method, 'GET', 'built request is a GET');
    assert.strictEqual(optsGet.headers.schema, 'app', 'schema header present (vendor contract)');
    assert.strictEqual(optsGet.headers['ops-client-schema'], 'app', 'ops-client-schema present');
    assert.strictEqual(optsGet.headers.authorization, 'TOKENVALUE', 'raw token in authorization, no Bearer prefix');
    assert.strictEqual(obs.redact('TOKENVALUE'), '<redacted>', 'redact() never returns the token');
    ok('read-only guard: assertReadOnly + buildRequestOptions refuse every non-GET; GET carries the vendor contract');
  })();

  // ---- 9. splitBody (F5: non-JSON rejection bodies captured, never discarded) -----------------
  (() => {
    const jsonBody = obs.splitBody('{"message":"ok"}');
    assert.deepStrictEqual(jsonBody.json, { message: 'ok' }, 'valid JSON parses');
    assert.strictEqual(jsonBody.text, '{"message":"ok"}', 'raw text preserved alongside parsed JSON');

    // Pre-fix, get() did `try { body = JSON.parse(d); } catch (_) { body = null; }` and threw
    // the source string `d` away entirely on any non-JSON response - the bug named in commit
    // 8e5c687 ("hid a months-long money bug") and re-applied to GoComet the same day this branch
    // was cut (gocometAdapter.js, commit 4fc8c9a). splitBody must keep the raw text even when it
    // is not JSON, so a vendor's plain-text rejection reason is never silently dropped.
    const plainTextReject = obs.splitBody('Enquiry is no longer biddable');
    assert.strictEqual(plainTextReject.json, null, 'non-JSON body: json is null');
    assert.strictEqual(plainTextReject.text, 'Enquiry is no longer biddable', 'non-JSON body: raw text CAPTURED, not discarded');

    assert.strictEqual(obs.splitBody('').text, null, 'empty body -> text null, not empty string');
    assert.strictEqual(obs.splitBody(null).text, null, 'null body -> text null');
    ok('splitBody: JSON parses; non-JSON raw text is captured, never discarded (F5 / commit 8e5c687 pattern)');
  })();

  // ---- 10. parseIstClose / toTick - plausibility bound (F4, year-2100 class) ------------------
  (() => {
    const fixedNow = FIXED_NOW;

    // Pre-fix, Date.parse('2100-01-01T...') is a perfectly valid finite ms value, so the old
    // `Number.isFinite(ms)`-only guard let it straight through - the exact year-2100 placeholder
    // class fixed for SuperProcure in 7cb2210 (cost zero bids on two live auctions) and
    // re-generalized to GoComet the same day this branch was cut (gocometAdapter.js
    // _boundedParseMs, commit 4fc8c9a).
    assert.strictEqual(obs.parseIstClose('01/01/2100 00:00', fixedNow), null, 'year-2100 placeholder REJECTED, not armed');
    assert.strictEqual(obs.parseIstClose('01/01/2020 00:00', fixedNow), null, 'implausibly-far-past timestamp REJECTED');

    // A genuine near-term close time (well inside the +30d/-7d window) must still parse - the
    // bound must not clip real observation data.
    assert.strictEqual(
      obs.parseIstClose('25/07/2026 12:30', fixedNow),
      Date.parse('2026-07-25T12:30:00+05:30'),
      'a real near-term close time still parses'
    );
    assert.strictEqual(obs.parseIstClose('01/09/2026 12:00', fixedNow), null, '38 days out (past MAX_PLAUSIBLE_DEADLINE_MS) rejected');
    assert.ok(obs.parseIstClose('10/08/2026 12:00', fixedNow) != null, '16 days out (inside the bound) still parses');

    // toTick must never arm a placeholder close time in a live tick, even though the vendor
    // payload is otherwise well-formed - this is the path pickNextCloser is NOT incidentally
    // protected on (pickNextCloser only wins by picking the minimum time-to-close; a directly
    // targeted --enquiry run has no such protection without the bound).
    const placeholderTick = obs.toTick(
      { bid_close_time: '01/01/2100 00:00', bid_closing_in: 999999999 },
      200,
      fixedNow
    );
    assert.strictEqual(placeholderTick.closeMs, null, 'toTick: placeholder close time never becomes a live closeMs');
    ok('parseIstClose/toTick: plausibility bound rejects placeholder timestamps, keeps real near-term ones (F4)');
  })();

  // ---- 11. pollLoop - a failed poll must NOT destroy the extension baseline (F2) ---------------
  await (async () => {
    const responses = [
      // tick 1: healthy, closeMs = 13:00
      { statusCode: 200, body: { bid_close_time: '25/07/2026 13:00', bid_closing_in: 600 }, text: '{}' },
      // tick 2: a failed poll (network error / timeout surfaced as statusCode 0 - the get()
      // failure shape from F1). Pre-fix, this became the new `prev` unconditionally.
      { statusCode: 0, body: null, text: null, error: 'gocomet request timed out after 8000ms' },
      // tick 3: healthy again, closeMs slid +5min from tick 1 (a genuine extension across the gap).
      { statusCode: 200, body: { bid_close_time: '25/07/2026 13:05', bid_closing_in: 570 }, text: '{}' },
    ];
    let i = 0;
    const getFn = async () => responses[i++];
    const logs = [];
    const logger = {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    };
    const result = await obs.pollLoop({
      getFn, nowMs: FIXED_NOW, biddingPath: '/x', sleepFn: async () => {}, logger, thresholdSec: 60, maxMin: 30,
      iterationLimit: responses.length,
    });

    assert.strictEqual(result.ticks.length, 3, 'all three polls recorded, including the failed one');
    assert.strictEqual(result.ticks[1].closeMs, null, 'the failed poll ticks null closeMs, as expected');
    // The load-bearing assertion: the extension across the gap (13:00 -> 13:05) IS detected,
    // which is only possible if `prev` still pointed at tick 1 (not the null-closeMs tick 2)
    // when tick 3 arrived. Pre-fix (`prev = tick` unconditional) this assertion FAILS - prev
    // would be tick 2 (closeMs null), detectExtension(prev, tick3) short-circuits on
    // `prev.closeMs == null` and reports { extended: false }, silently swallowing the slide -
    // verified red by temporarily reverting the F2 fix and re-running this suite.
    assert.strictEqual(result.extensions.length, 1, 'the extension across the failed-poll gap IS detected (prev survived the gap)');
    assert.strictEqual(result.extensions[0].incrementSec, 300, 'increment measured correctly across the gap: +300s');
    ok('pollLoop: a failed poll does not become the comparison baseline - extension survives the gap (F2)');
  })();

  // ---- 12. pollLoop - 429 and 503 share one backoff + circuit breaker (F3) ---------------------
  await (async () => {
    // Mixed 429 -> 503: both must count toward the SAME consecutive rate-limit counter (the
    // sibling adapter's pattern - GoComet's limiter is touchy and treats them identically). A
    // second CONSECUTIVE rate-limited response (of either code) stops the run.
    const responses = [
      { statusCode: 429, body: null, text: 'Too Many Requests' },
      { statusCode: 503, body: null, text: 'Service Unavailable' },
    ];
    let i = 0;
    const getFn = async () => responses[i++];
    const sleeps = [];
    const sleepFn = async (ms) => { sleeps.push(ms); };
    const logs = [];
    const logger = {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    };

    const result = await obs.pollLoop({
      getFn, nowMs: FIXED_NOW, biddingPath: '/x', sleepFn, logger, thresholdSec: 60, maxMin: 30, iterationLimit: 5,
    });

    assert.strictEqual(result.fatal, 'rate_limit', '429 then 503 (2 consecutive) trips the circuit breaker');
    assert.strictEqual(sleeps.length, 1, 'the FIRST rate-limit response backs off; the SECOND stops immediately (no further sleep)');
    assert.strictEqual(sleeps[0], obs.RATE_LIMIT_BACKOFF_MS, 'backoff duration is the documented 60s');
    assert.ok(logs.some((l) => l.includes('503') && l.includes('Service Unavailable')), '503 rejection text is surfaced, not discarded (F5)');
    assert.strictEqual(result.ticks.length, 0, 'no tick is recorded for a rate-limited response (consistent with existing 429 behaviour)');
    ok('pollLoop: 429 and 503 share one backoff + circuit breaker; rejection text surfaced (F3)');
  })();

  // ---- 13. pollLoop - auth failures are LOUD and fatal after 2 consecutive (F3) ----------------
  await (async () => {
    const responses = [
      { statusCode: 401, body: null, text: 'Unauthorized: token expired' },
      { statusCode: 401, body: null, text: 'Unauthorized: token expired' },
    ];
    let i = 0;
    const getFn = async () => responses[i++];
    const logs = [];
    const logger = {
      log: (...a) => logs.push(a.join(' ')),
      warn: (...a) => logs.push(a.join(' ')),
      error: (...a) => logs.push(a.join(' ')),
    };

    const result = await obs.pollLoop({
      getFn, nowMs: FIXED_NOW, biddingPath: '/x', sleepFn: async () => {}, logger, thresholdSec: 60, maxMin: 30, iterationLimit: 5,
    });

    assert.strictEqual(result.fatal, 'auth', 'a second consecutive 401 stops the run (fatal: auth)');
    assert.ok(
      logs.some((l) => l.includes('AUTH FAILURE') && l.includes('token expired')),
      'auth failure is logged LOUDLY with the vendor rejection text, not silently polled through'
    );
    assert.strictEqual(result.ticks.length, 0, 'no tick is recorded while auth is failing - an all-null tick never masquerades as a real observation');

    // A single (non-consecutive) auth blip must NOT be fatal - same "consecutive" semantics as
    // the rate-limit counter: it resets on the next healthy read.
    const recovered = [
      { statusCode: 401, body: null, text: 'Unauthorized' },
      { statusCode: 200, body: { bid_close_time: '25/07/2026 13:00', bid_closing_in: 5, bidding_closed: true }, text: '{}' },
      { statusCode: 200, body: { bid_close_time: '25/07/2026 13:00', bid_closing_in: null, bidding_closed: true }, text: '{}' },
    ];
    let j = 0;
    const getFn2 = async () => recovered[j++];
    const result2 = await obs.pollLoop({
      getFn: getFn2, nowMs: FIXED_NOW, biddingPath: '/x', sleepFn: async () => {},
      logger: { log() {}, warn() {}, error() {} },
      thresholdSec: 60, maxMin: 30, iterationLimit: 5,
    });
    assert.notStrictEqual(result2.fatal, 'auth', 'a single non-consecutive auth blip is not fatal - the counter resets on the next healthy read');

    ok('pollLoop: 401/403 logged loudly with rejection text; second CONSECUTIVE auth failure is fatal; a single blip recovers (F3)');
  })();

  console.log('\n' + pass + '/13 checks passed');
  process.exit(0);
}

main().catch((e) => {
  console.error('TEST FAILURE:', (e && e.stack) || e);
  process.exit(1);
});
