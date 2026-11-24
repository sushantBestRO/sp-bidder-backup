'use strict';
/**
 * observe-gocomet-close.js - standalone, READ-ONLY GoComet close-window observer.
 *
 * WHY THIS EXISTS
 * ---------------
 * GoComet's Waaree spot auctions are soft-close (anti-snipe): a late bid slides the
 * `bid_close_time` forward, and the auction only truly ends when no further late bid lands.
 * The vendor API does NOT expose the extend increment, the reactive window, or a round
 * counter (unlike SuperProcure, which hands us `branchAuctionExtendTime` +
 * `branchExtendAuctionCount`). So the only way to characterise a GoComet close is to WATCH
 * the clock through the close window and infer the mechanics from how it moves. Historical
 * mining of BRL's own on-box Postgres established the model (increment ~5 min, per-plant;
 * round-depth mean ~1.8, tail to 22). This tool makes every FUTURE live-close observation a
 * one-liner, so that model can be re-confirmed or refined on demand:
 *
 *     node scripts/observe-gocomet-close.js --enquiry 260725A2UQ
 *     node scripts/observe-gocomet-close.js            # auto-pick the next closer
 *
 * SAFETY / DISCIPLINE
 * -------------------
 * - READ-ONLY. This process issues GoComet GETs ONLY. `assertReadOnly()` HARD-REFUSES any
 *   non-GET method - there is no code path that can POST/PUT/PATCH/DELETE, and the request
 *   builder throws if asked to. It never places, revises, or cancels a bid; it never writes
 *   to the platform. The only local write is the per-tick observation jsonl.
 * - POLITE. Adaptive cadence, floor >= 5s steady-state, >= 3s only inside the final window
 *   (`computeCadenceMs`). On HTTP 429 or 503 it backs off 60s and halves cadence; a second
 *   CONSECUTIVE rate-limited response stops the run entirely. Small by construction.
 * - RELIABLE. Every GET is timeout-bounded and never throws - a failed/timed-out poll is
 *   recorded honestly and, critically, never becomes the comparison baseline that extension
 *   detection compares against (a lost poll must not look like a lost extension). Auth-class
 *   failures (401/403) are LOUD and fatal after a second consecutive occurrence, instead of
 *   polling a dead token silently for the whole window and reporting a clean-looking
 *   `extensionRounds: 0`. Parsed close times are bound-checked against the placeholder-
 *   timestamp class this repo has already paid for twice (see MAX_PLAUSIBLE_DEADLINE_MS).
 * - The vendor token is read from env / a token file / the on-box autopilot config and is
 *   NEVER printed (`redact()`), never written to the jsonl.
 *
 * The pure decision helpers (parse / pick / detect / cadence / summarise / method-guard) carry
 * no I/O and are unit-tested with mocked payloads in scripts/test-gocomet-close-observer.js.
 * `pollLoop` (the reliability-critical loop) is also unit-tested there via an injected getFn +
 * sleepFn, so the fixes below are proven at the loop level, not just in isolated helpers.
 * The network loop only runs when this file is executed directly (require.main === module).
 */

const https = require('https');

// ---------------------------------------------------------------------------
// Constants - the exact vendor-API contract (mirrors autopilot's getHeaders()).
// ---------------------------------------------------------------------------
const DEFAULT_HOST = 'enquiry.gocomet.com';
const SPOT_PATH =
  '/api/v1/vendor/enquiries/spot?page=1&size=30&reset_filter=false&filter%5Benquiry_type%5D=spot';
const ALLOWED_METHOD = 'GET';
const ONBOX_CONFIG = '/var/www/autopilot/web_config.json';
// The platform's own extension detector (best-spot-bidding-dev) treats a close-time advance of
// more than 60s as an extension; the true increment is 4-5 min, so 60s is a safe jitter floor.
const DEFAULT_EXTENSION_THRESHOLD_SEC = 60;

// Review F1: request timeout. A half-open socket (common on a mobile/NAT path, and the exact
// condition a vendor under close-window load produces) previously hung the `await` forever, so
// the poll loop's `while (Date.now() < deadline)` never got control back and the observer went
// silent mid-window with no error and no exit. Value mirrors the repo's other GoComet poller's
// default GET timeout (src/platform/gocometAdapter.js `_request`, `timeoutMs = 8000`; the
// SuperProcure realAdapter.js poll-path GETs use the same 8000ms default).
const GET_TIMEOUT_MS = 8000;

// Review F3: rate-limit backoff, applied identically to 429 AND 503 - the sibling adapter's
// pattern (gocometAdapter.js `_request` treats `status === 429 || status === 503` the same for
// its cooldown, with the comment "GoComet's limiter is touchy - the existing bot logged 2629
// 429s from a 200ms hot-poll"). A second CONSECUTIVE rate-limited response (of either code)
// stops the run rather than continuing to hammer a limiter that has already said no twice.
const RATE_LIMIT_BACKOFF_MS = 60000;
const MAX_CONSECUTIVE_RATE_LIMIT = 2;

// Review F3: auth-class failures (401/403) are LOUD and fatal after N consecutive occurrences,
// instead of falling straight through to toTick and polling a dead token at full cadence for
// the whole window - which previously produced a clean-looking `extensionRounds: 0` that is
// indistinguishable in the summary from a real auction that never extended.
const MAX_CONSECUTIVE_AUTH_FAILURES = 2;

// Review F4: plausibility bound on any parsed close time, PORTED FROM
// src/platform/gocometAdapter.js's `_boundedParseMs()` / `MAX_PLAUSIBLE_DEADLINE_MS` /
// `MAX_PLAUSIBLE_PAST_MS` (sibling branch feat/gocomet-adapter-phase1, commit 4fc8c9a - same
// merge-base, cut the same day as this branch). GoComet (like SuperProcure) can return a
// placeholder far-future timestamp instead of a real deadline, and a bad time that PARSES AS
// VALID arms a load with a decades-long fake runway - this is the exact year-2100 placeholder
// class fixed for SuperProcure in 7cb2210 (cost zero bids on two live auctions, OA 23075092 /
// OA 23088090). `pickNextCloser` is only incidentally protected (it picks the minimum
// time-to-close, so a placeholder loses); a directly-targeted `--enquiry` run is not, and this
// bound closes that gap for both call sites. If #86 (feat/gocomet-adapter-phase1) merges before
// this PR, drop this local copy and import `_boundedParseMs` from gocometAdapter.js instead of
// keeping a second, drift-prone implementation of the same lesson.
const MAX_PLAUSIBLE_DEADLINE_MS = 30 * 86400000; // +30 days
const MAX_PLAUSIBLE_PAST_MS = 7 * 86400000; // -7 days (a just-closed load can still list)

// ---------------------------------------------------------------------------
// PURE HELPERS (no I/O) - exported and unit-tested.
// ---------------------------------------------------------------------------

/**
 * Never let the vendor token reach a log line or the jsonl. Any accidental pass-through is
 * collapsed to a fixed marker.
 */
function redact(_token) {
  return '<redacted>';
}

/**
 * HARD read-only guard. The observer only ever performs GETs; every request goes through the
 * builder below, which calls this. Any non-GET throws before a socket is ever opened.
 */
function assertReadOnly(method) {
  if (method !== ALLOWED_METHOD) {
    throw new Error(
      'observe-gocomet-close is READ-ONLY: refusing ' + method + ' (only ' + ALLOWED_METHOD + ' permitted)'
    );
  }
  return true;
}

function buildHeaders(token) {
  return {
    accept: 'application/json',
    authorization: token || '',
    'ops-client-schema': 'app',
    origin: 'https://app.gocomet.com',
    referer: 'https://app.gocomet.com/',
    schema: 'app',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  };
}

/**
 * Build the https request options. Refuses any method other than GET (defence in depth: the
 * only caller passes 'GET', but a future edit that tries to reuse this for a write cannot).
 */
function buildRequestOptions(method, pathname, token, host) {
  assertReadOnly(method);
  return {
    method: ALLOWED_METHOD,
    host: host || DEFAULT_HOST,
    path: pathname,
    headers: buildHeaders(token),
  };
}

/**
 * Parse GoComet's "dd/mm/yyyy HH:MM" close-time (IST) into epoch ms. Returns null on anything
 * that doesn't match, so a malformed/absent field never fabricates a time - AND on anything
 * that parses but lands outside a plausible window around `nowMs` (Review F4: the year-2100
 * placeholder class parses as a perfectly valid finite ms value, so a NaN-only guard misses it).
 * `nowMs` defaults to the real wall clock; tests pass a fixed value for determinism.
 */
function parseIstClose(str, nowMs) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(str || ''));
  if (!m) return null;
  const iso = m[3] + '-' + m[2] + '-' + m[1] + 'T' + m[4] + ':' + m[5] + ':00+05:30';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const n = nowMs == null ? Date.now() : nowMs;
  if (ms < n - MAX_PLAUSIBLE_PAST_MS || ms > n + MAX_PLAUSIBLE_DEADLINE_MS) return null;
  return ms;
}

/**
 * From a spot-list `enquiries[]`, pick the OPEN load closing soonest in the future. Returns
 * null when nothing qualifies. Used for the auto-pick mode.
 */
function pickNextCloser(enquiries, nowMs) {
  let best = null;
  let bestMs = Infinity;
  for (const e of enquiries || []) {
    if (e && e.status && e.status !== 'Open') continue;
    const closeMs = parseIstClose(e && e.bid_close_time, nowMs);
    if (closeMs == null) continue;
    const ttc = closeMs - nowMs;
    if (ttc > 0 && ttc < bestMs) {
      bestMs = ttc;
      best = e;
    }
  }
  if (!best) return null;
  return {
    key: best.key,
    closeMs: parseIstClose(best.bid_close_time, nowMs),
    msToClose: bestMs,
    name: best.name || null,
    client: best.client_company_name || null,
  };
}

/**
 * Normalise a raw /bidding-data body into a compact tick. `closeMs` is derived from the sliding
 * `bid_close_time` (the field that moves on an extension). bidCount is intentionally null - the
 * vendor API masks competitor bid counts; `rank` is the one competitive signal it exposes.
 * `nowMs` is threaded through to parseIstClose's plausibility bound (Review F4); defaults to the
 * real wall clock, tests pass a fixed value for determinism.
 */
function toTick(body, statusCode, nowMs) {
  const b = body || {};
  const closeMs = parseIstClose(b.bid_close_time, nowMs);
  const serverMs = b.current_server_time != null ? Date.parse(b.current_server_time) : null;
  return {
    at: new Date().toISOString(),
    statusCode: statusCode != null ? statusCode : null,
    closeTime: b.bid_close_time != null ? b.bid_close_time : null,
    closeMs: closeMs,
    closingIn: b.bid_closing_in != null ? b.bid_closing_in : null,
    serverTime: b.current_server_time != null ? b.current_server_time : null,
    serverMs: Number.isFinite(serverMs) ? serverMs : null,
    rank: b.vendor_rank != null ? b.vendor_rank : null,
    totalRevisions: b.total_revisions != null ? b.total_revisions : null,
    revisionsLeft: b.revisions_left != null ? b.revisions_left : null,
    bidCount: null, // masked by the vendor API; recorded explicitly as unavailable
    closed: b.bidding_closed === true ? true : b.bid_closing_in === null ? true : false,
  };
}

/**
 * Detect an extension between two consecutive ticks: the close-time advanced by more than the
 * threshold. Returns the increment so a chain of these reconstructs the per-round step. Below
 * the threshold (clock jitter, re-sync noise) is deliberately NOT an extension.
 */
function detectExtension(prev, cur, opts) {
  const o = opts || {};
  const thresholdMs = (o.thresholdSec != null ? o.thresholdSec : DEFAULT_EXTENSION_THRESHOLD_SEC) * 1000;
  if (!prev || prev.closeMs == null || !cur || cur.closeMs == null) return { extended: false };
  const delta = cur.closeMs - prev.closeMs;
  if (delta > thresholdMs) {
    return {
      extended: true,
      incrementSec: Math.round(delta / 1000),
      prevCloseMs: prev.closeMs,
      newCloseMs: cur.closeMs,
    };
  }
  return { extended: false };
}

/**
 * Polite adaptive cadence in ms. Encodes the standing rule: >= 5s steady-state, and the tighter
 * >= 3s ONLY inside the final window. Far out we idle at 30s. `closingIn` null (endpoint not
 * returning a countdown, e.g. just after close) falls back to a safe steady interval.
 */
function computeCadenceMs(closingInSec, cfg) {
  const c = cfg || {};
  const farSec = c.farSec != null ? c.farSec : 120;
  const midSec = c.midSec != null ? c.midSec : 30;
  const hotWindowSec = c.hotWindowSec != null ? c.hotWindowSec : 20;
  const steadyMinMs = c.steadyMinMs != null ? c.steadyMinMs : 5000;
  const hotMs = c.hotMs != null ? c.hotMs : 3000;
  const midMs = c.midMs != null ? c.midMs : 10000;
  const farMs = c.farMs != null ? c.farMs : 30000;
  if (closingInSec == null) return Math.max(midMs, steadyMinMs);
  if (closingInSec <= hotWindowSec) return hotMs; // final window: 3s permitted
  if (closingInSec <= midSec) return Math.max(midMs, steadyMinMs);
  if (closingInSec <= farSec) return Math.max(midMs, steadyMinMs);
  return Math.max(farMs, steadyMinMs);
}

/**
 * Roll a run's ticks + detected extensions into a summary: how many rounds, the per-round
 * increments, total added time, min countdown seen, and whether it ended closed.
 */
function summarize(ticks, extensions) {
  const t = ticks || [];
  const x = extensions || [];
  const closingIns = t.map((k) => k.closingIn).filter((v) => v != null);
  const last = t.length ? t[t.length - 1] : null;
  return {
    ticks: t.length,
    extensionRounds: x.length,
    incrementsSec: x.map((e) => e.incrementSec),
    totalExtendSec: x.reduce((a, e) => a + e.incrementSec, 0),
    firstCloseMs: t.length ? t[0].closeMs : null,
    finalCloseMs: last ? last.closeMs : null,
    minClosingIn: closingIns.length ? Math.min.apply(null, closingIns) : null,
    closed: last ? last.closed === true || last.closingIn == null : false,
  };
}

/**
 * Split a raw HTTP response body into { json, text }. ALWAYS keeps the raw text alongside the
 * parsed JSON (or null when parsing fails) rather than discarding it. Review F3/F5: this is the
 * bug commit `8e5c687` fixed for SuperProcure - it "hid a months-long money bug" by throwing
 * away plain-text rejection bodies - and the sibling branch re-applied the same fix to GoComet
 * the same day this branch was cut (gocometAdapter.js `_request`, commit `4fc8c9a`: "GoComet
 * answers some rejections in plaintext, so text-first preserves the real 'why'"). Callers log
 * `text` on any non-200 tick instead of getting an opaque null.
 */
function splitBody(raw) {
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch (_) {
      json = null;
    }
  }
  return { json: json, text: raw || null };
}

// ---------------------------------------------------------------------------
// IMPURE runner - only executes when invoked directly.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { maxMin: 30, thresholdSec: DEFAULT_EXTENSION_THRESHOLD_SEC, host: DEFAULT_HOST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--enquiry') out.enquiry = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--token-file') out.tokenFile = argv[++i];
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--max-min') out.maxMin = Number(argv[++i]);
    else if (a === '--threshold-sec') out.thresholdSec = Number(argv[++i]);
    else if (a === '--dry') out.dry = true;
  }
  return out;
}

function resolveToken(args) {
  if (process.env.GOCOMET_TOKEN) return process.env.GOCOMET_TOKEN;
  const fs = require('fs');
  if (args.tokenFile) return fs.readFileSync(args.tokenFile, 'utf8').trim();
  if (fs.existsSync(ONBOX_CONFIG)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(ONBOX_CONFIG, 'utf8'));
      if (cfg && cfg.globalAuthToken) return cfg.globalAuthToken;
    } catch (_) {
      /* fall through to error */
    }
  }
  throw new Error(
    'No GoComet token: set GOCOMET_TOKEN, pass --token-file <path>, or run on the box with ' +
      ONBOX_CONFIG + ' present.'
  );
}

/**
 * One GET. NEVER rejects - every failure path (network error, response-stream error, or a
 * timeout) resolves with statusCode 0 so the caller only ever awaits, never try/catches, and a
 * bad poll can never crash the observer loop (Review F1).
 */
function get(pathname, token, host) {
  const opts = buildRequestOptions(ALLOWED_METHOD, pathname, token, host);
  return new Promise((resolve) => {
    const req = https.get(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        const split = splitBody(d);
        resolve({ statusCode: res.statusCode, body: split.json, text: split.text });
      });
      // Review F1: a response-stream error (e.g. connection reset mid-body) must resolve as a
      // failed poll, not hang the awaiting caller.
      res.on('error', (e) => resolve({ statusCode: 0, body: null, text: null, error: e.message }));
    });

    // Review F1: bound every GET. A half-open socket with no timeout hangs the `await` forever
    // and the poll loop's `while (Date.now() < deadline)` never gets control back - the single
    // most damaging failure mode for a one-shot close-window observation.
    req.setTimeout(GET_TIMEOUT_MS, () => {
      req.destroy(new Error('gocomet request timed out after ' + GET_TIMEOUT_MS + 'ms'));
    });
    req.on('error', (e) => resolve({ statusCode: 0, body: null, text: null, error: e.message }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Core poll loop, extracted from run() so the reliability fixes below (F2/F3) can be exercised
 * offline by the unit suite via an injected getFn + sleepFn, instead of only testing the pure
 * helpers in isolation - baseline advancement and status-code branching are loop-level
 * behaviours, and a loop-level test is what actually proves the fix rather than just the shape
 * of a single tick.
 *
 * @param {object} cfg
 *   getFn(pathname) -> Promise<{statusCode, body, text, error}>   REQUIRED
 *   biddingPath                                                    REQUIRED
 *   sleepFn(ms) -> Promise<void>            default: the real sleep()
 *   writeTick(tick) -> void                 default: no-op (run() wires the real fs append)
 *   logger {log, warn, error}                default: console
 *   thresholdSec                             default: DEFAULT_EXTENSION_THRESHOLD_SEC
 *   maxMin                                   default: 30
 *   iterationLimit                           default: Infinity - test-only escape hatch so a
 *                                             mocked response sequence can never spin forever.
 * @returns {Promise<{ticks, extensions, summary, fatal: null|'auth'|'rate_limit'}>}
 */
async function pollLoop(cfg) {
  const getFn = cfg.getFn;
  const sleepFn = cfg.sleepFn || sleep;
  const writeTick = cfg.writeTick || function () {};
  const logger = cfg.logger || console;
  const thresholdSec = cfg.thresholdSec;
  const maxMin = cfg.maxMin != null ? cfg.maxMin : 30;
  const iterationLimit = cfg.iterationLimit != null ? cfg.iterationLimit : Infinity;
  const deadline = Date.now() + maxMin * 60000;

  const ticks = [];
  const extensions = [];
  let prev = null;
  let consecutiveRateLimit = 0;
  let consecutiveAuth = 0;
  let cadenceMultiplier = 1;
  let closedStreak = 0;
  let fatal = null;
  let iterations = 0;

  while (Date.now() < deadline && iterations < iterationLimit) {
    iterations += 1;
    const res = await getFn(cfg.biddingPath);

    // Review F3: 429 and 503 get identical backoff treatment (the sibling adapter's pattern -
    // both are the vendor's rate-limit signal). A second CONSECUTIVE rate-limited response of
    // either code stops the run rather than continuing to hammer a limiter that has said no
    // twice.
    if (res.statusCode === 429 || res.statusCode === 503) {
      consecutiveRateLimit += 1;
      consecutiveAuth = 0;
      logger.warn(
        'HTTP ' + res.statusCode + ' - backing off ' + (RATE_LIMIT_BACKOFF_MS / 1000) + 's (rate-limit #' +
          consecutiveRateLimit + ')' + (res.text ? ' | body: ' + res.text : '')
      );
      if (consecutiveRateLimit >= MAX_CONSECUTIVE_RATE_LIMIT) {
        logger.error('Second consecutive rate-limit response (429/503) - stopping API work entirely per rate-limit discipline.');
        fatal = 'rate_limit';
        break;
      }
      cadenceMultiplier *= 2;
      await sleepFn(RATE_LIMIT_BACKOFF_MS);
      continue;
    }
    consecutiveRateLimit = 0;

    // Review F3: auth-class failures are LOUD and fatal. A dead token polling silently for the
    // rest of the window produces a clean-looking `extensionRounds: 0` in the summary -
    // indistinguishable from a real auction that never extended. Stop after a second
    // CONSECUTIVE 401/403 instead of running the full window against a rejected credential.
    if (res.statusCode === 401 || res.statusCode === 403) {
      consecutiveAuth += 1;
      logger.error(
        'AUTH FAILURE: HTTP ' + res.statusCode + ' (#' + consecutiveAuth + ' consecutive)' +
          (res.text ? ' | body: ' + res.text : '') + ' - the GoComet token is likely expired or invalid.'
      );
      if (consecutiveAuth >= MAX_CONSECUTIVE_AUTH_FAILURES) {
        logger.error(
          'Second consecutive auth failure - stopping. A dead token cannot observe anything; ' +
            'continuing would poll it for the rest of the window and report a false extensionRounds: 0. ' +
            'Reconnect the token (GOCOMET_TOKEN / --token-file) and re-run.'
        );
        fatal = 'auth';
        break;
      }
      await sleepFn(computeCadenceMs(null));
      continue;
    }
    consecutiveAuth = 0;

    // Review F3/F5: never discard a non-200 body silently - the vendor's plain-text rejection
    // reason is exactly what a failing run needs surfaced (the SP adapter learned this the hard
    // way, commit 8e5c687).
    if (res.statusCode !== 200 && res.text) {
      logger.warn('Non-200 response body (HTTP ' + res.statusCode + '): ' + res.text);
    }

    // cfg.nowMs is the same determinism seam toTick documents: undefined in real runs (wall clock),
    // pinned by tests so the plausibility bound does not measure fixtures against the current date.
    const tick = toTick(res.body, res.statusCode, cfg.nowMs);
    ticks.push(tick);
    writeTick(tick);

    const ext = detectExtension(prev, tick, { thresholdSec: thresholdSec });
    if (ext.extended) {
      extensions.push(ext);
      logger.log(
        'EXTENSION #' + extensions.length + ' +' + ext.incrementSec + 's | close ' +
          new Date(ext.prevCloseMs).toISOString() + ' -> ' + new Date(ext.newCloseMs).toISOString()
      );
    }
    logger.log(
      tick.at, 'HTTP', tick.statusCode, '| closingIn', tick.closingIn, '| closeTime',
      tick.closeTime, '| rank', tick.rank, '| revLeft', tick.revisionsLeft
    );

    // Review F2: only advance the comparison baseline on a tick that actually carries a usable
    // close time. A failed/errored poll (network error, timeout, non-200, or a payload without
    // bid_close_time) must NOT become the new `prev` - otherwise the next successful tick gets
    // compared against stale/null state and detectExtension silently swallows whatever
    // close-time slide happened across the gap. That slide is the entire signal this observer
    // exists to capture, so a transient failure must never be able to erase it.
    if (tick.closeMs != null) {
      prev = tick;
    }

    // Stop once the load has been closed for a couple of confirming ticks (countdown null and
    // no further slide) - avoids ending on a transient null while an extension is mid-flight.
    if (tick.closed) {
      closedStreak += 1;
      if (closedStreak >= 2) {
        logger.log('Load closed (2 confirming ticks) - ending observation.');
        break;
      }
    } else {
      closedStreak = 0;
    }

    await sleepFn(computeCadenceMs(tick.closingIn) * cadenceMultiplier);
  }

  return { ticks: ticks, extensions: extensions, summary: summarize(ticks, extensions), fatal: fatal };
}

async function run() {
  const fs = require('fs');
  const path = require('path');
  const args = parseArgs(process.argv.slice(2));
  const token = resolveToken(args);
  const host = args.host;

  // Resolve the target enquiry.
  let key = args.enquiry;
  if (!key) {
    const list = await get(SPOT_PATH, token, host);
    if (list.statusCode !== 200 || !list.body) {
      console.error('spot-list fetch failed: HTTP', list.statusCode, list.error || list.text || '');
      process.exit(1);
    }
    const next = pickNextCloser(list.body.enquiries, Date.now());
    if (!next) {
      console.log('No open load closing in the future right now - nothing to observe. Exiting.');
      process.exit(0);
    }
    key = next.key;
    console.log(
      'Auto-picked', key, '| closes', new Date(next.closeMs).toISOString(),
      '| ~' + Math.round(next.msToClose / 60000) + ' min | client', next.client
    );
  }

  if (args.dry) {
    console.log('--dry: target', key, '(token', redact(token) + ', host', host + ') - not polling.');
    process.exit(0);
  }

  // Prepare the jsonl sink (data/ is gitignored).
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const outPath = args.out || path.join('data', 'gocomet-close-observations', key + '-' + stamp + '.jsonl');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  console.log('Observing', key, '-> jsonl', outPath, '| threshold', args.thresholdSec + 's');

  const biddingPath = '/api/v1/vendor/enquiries/' + key + '/bidding-data';

  const result = await pollLoop({
    getFn: (pathname) => get(pathname, token, host),
    biddingPath: biddingPath,
    thresholdSec: args.thresholdSec,
    maxMin: args.maxMin,
    writeTick: (tick) => fs.appendFileSync(outPath, JSON.stringify(tick) + '\n'),
    logger: console,
  });

  console.log('\nSUMMARY', JSON.stringify(result.summary));
  console.log('jsonl:', outPath);

  // Review F3: a dead token cost the whole window silently before this fix. Surface it in the
  // exit code so an operator/cron wrapper can tell "nothing to observe" apart from "the token
  // was dead the entire time".
  if (result.fatal === 'auth') {
    process.exitCode = 1;
  }
}

module.exports = {
  redact,
  assertReadOnly,
  buildHeaders,
  buildRequestOptions,
  parseIstClose,
  pickNextCloser,
  toTick,
  detectExtension,
  computeCadenceMs,
  summarize,
  splitBody,
  pollLoop,
  ALLOWED_METHOD,
  DEFAULT_EXTENSION_THRESHOLD_SEC,
  GET_TIMEOUT_MS,
  RATE_LIMIT_BACKOFF_MS,
  MAX_CONSECUTIVE_RATE_LIMIT,
  MAX_CONSECUTIVE_AUTH_FAILURES,
  MAX_PLAUSIBLE_DEADLINE_MS,
  MAX_PLAUSIBLE_PAST_MS,
};

if (require.main === module) {
  run().catch((e) => {
    console.error('observer error:', (e && e.stack) || e);
    process.exit(1);
  });
}
