'use strict';

// Load secrets/runtime config from an on-box .env (chmod 600, gitignored) when present.
// Optional by design: in dev, or when the process manager exports env directly, this
// is a harmless no-op. Wrapped so a missing dotenv never breaks `npm start`/`npm test`.
try { require('dotenv').config(); } catch (_) { /* env comes from the shell / PM2 */ }

const path = require('path');

// Seam 4: the data dir is env-overridable (tests, multi-instance dev); production
// keeps the in-tree default so existing deploys see identical paths.
const dataDir = process.env.SP_DATA_DIR
  ? path.resolve(process.env.SP_DATA_DIR)
  : path.join(__dirname, '..', 'data');

// Director-EOD recipients, parsed once so `enabled` can derive from a non-empty list (the
// fail-safe: empty => the feature stays dark). Raw numbers, comma-separated; on-box .env only.
const directorEodRecipients = (process.env.SP_DIRECTOR_EOD_RECIPIENTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Central config + the one place the platform is chosen.
 *
 * mode 'mock'  -> MockSuperProcureAdapter over the AuctionSim (the demo).
 * mode 'real'  -> RealSuperProcureAdapter (built from the captured HAR; not yet here).
 *
 * To go live later: implement src/platform/realAdapter.js against PlatformAdapter,
 * set PLATFORM=real, and nothing else in the system changes.
 */

// Parse a numeric env knob to a finite Number, degrading absent/blank/non-numeric to `def`. The
// neighbour knobs use `Number(process.env.X || def)`, which leaves a RAW NaN on a typo'd value for a
// downstream Number.isFinite guard to absorb (that pattern is pinned in test-loadrules-config-edges.js).
// The cost-floor knobs below instead gate LIVE BIDS, so they must fail SAFE at the seam itself. Trace
// what a NaN would actually do there: hardCostFloorFor's own `Number.isFinite(x) && x > 0` terms
// coerce it to 0, the effective floor collapses to 0, and the guard's `!(floor > 0)` short-circuit
// then reports "no violation" for every cost - the floor SILENTLY DISABLES itself (fail open). Note
// the hole is that short-circuit, NOT the comparison: the guard reads `c >= floor`, and `c >= NaN` is
// false, which fails CLOSED. A literal '0' is kept (a deliberate per-term disable); only genuine junk
// falls back to the default.
function numKnobOr(raw, def) {
  if (raw == null || String(raw).trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

// Hoisted so engine.neverListedProbeBoundMs below can derive from the SAME interval the top-level
// discoveryIntervalMs field publishes, rather than a second copy of the env read drifting from it.
const discoveryIntervalMs = Number(process.env.SP_DISCOVERY_INTERVAL_MS || 30_000);

module.exports = {
  mode: process.env.PLATFORM || 'mock',
  // Which bidding PORTAL this instance feeds. Distinct from `mode` (mock/real adapter):
  // it's the customer-margin-profile + display namespace. SuperProcure ('sp') is the only
  // live portal; GoComet etc. later pass their own key so per-portal margins are additive.
  platformKey: process.env.SP_PLATFORM_KEY || 'sp',
  port: Number(process.env.PORT || 4103),
  host: process.env.HOST || '127.0.0.1', // bind loopback by default; the reverse proxy is the only front door
  dataDir,
  intentsFile: path.join(dataDir, 'intents.json'),
  sessionFile: path.join(dataDir, 'session.json'),

  // Per-account persistence namespacing (Phase 2 two-account routing). The implicit/
  // legacy 'primary' account keeps today's exact unsuffixed paths, so live state
  // survives the upgrade; additional accounts get suffixed files. accountId is
  // slug-validated in src/auth/accounts.js, so it is filename-safe by construction.
  intentsFileFor(accountId) {
    if (!accountId || accountId === 'primary') return this.intentsFile;
    return path.join(this.dataDir, `intents.${accountId}.json`);
  },
  sessionFileFor(accountId) {
    if (!accountId || accountId === 'primary') return this.sessionFile;
    return path.join(this.dataDir, `session.${accountId}.json`);
  },
  // Its OWN file, never the intents file. Target-rate records are keyed by (load, round) while
  // intents are keyed by load alone, so sharing the store would let a target-rate obligation
  // overwrite the load's auction intent.
  targetPriceFileFor(accountId) {
    return path.join(this.dataDir, `target-price.${accountId || 'primary'}.json`);
  },

  storeBackend: process.env.STORE_BACKEND || 'file',        // Seam 1 store: 'file' | 'memory'
  capturedHeaders: process.env.SP_CAPTURED_HEADERS || null, // optional captured-headers JSON for the real adapter

  // ---- GoComet platform adapter (Module 2, Phase 1) - OFF by default, additive, zero SP impact ----
  // GoComet is a SECOND freight-auction portal behind the same PlatformAdapter seam. This whole
  // block is env-gated: with GC_TOKEN absent, `enabled` is false, the adapter is never instantiated,
  // and nothing about live SuperProcure bidding changes. WRITES are double-gated - placeBid requires
  // BOTH the adapter's writeEnabled backstop AND `bidEnabled` (GC_BID=1), which defaults OFF, so a
  // configured READ token can never place a bid. GoComet JWTs are ~monthly (far shorter than SP's
  // ~1yr), so token-expiry alerting is on by default via the tokenExpiry.js rail.
  gocomet: {
    // presence of a token is the master gate; env is fixed at boot so a plain boolean is enough.
    enabled: !!(process.env.GC_TOKEN && process.env.GC_TOKEN.trim()),
    token: (process.env.GC_TOKEN || '').replace(/^Bearer\s+/i, '').trim() || null,
    // The env var NAME, kept beside its only reader. The stack's account record carries this
    // rather than the token itself - accounts.js validateAccount refuses a record that holds
    // anything resembling a secret (Seam 2: secrets strictly by reference).
    tokenEnv: 'GC_TOKEN',
    userId: process.env.GC_USER_ID || null,
    baseUrl: process.env.GC_BASE_URL || 'https://enquiry.gocomet.com',
    // WRITE master switch (the SECOND gate). Default OFF - a read token alone never bids.
    bidEnabled: process.env.GC_BID === '1',
    // ---- GET budget (gocometAdapter's read budget) ----
    // GoComet's limiter is touchy (the existing bot logged 2629 429s) and its real rate is NOT
    // measured, so these are the knobs an operator retunes on the box during a live 429 storm -
    // config data, not code. numKnobOr rather than the neighbours' `Number(x || def)`: that form
    // leaves a raw NaN on a typo, and here a NaN would reach a rate limiter whose failure mode is
    // losing the account. The adapter then BOUNDS every value (rateKnob) so a 0, a negative or an
    // absurd setting resolves to the default rather than to an unbounded request rate.
    //
    // null when unset, deliberately - the DEFAULTS LIVE IN THE ADAPTER and are not restated here.
    // Two of these derive from minGetIntervalMs, so a number copied into this file would silently
    // stop deriving the moment someone set GC_MIN_GET_INTERVAL_MS.
    //
    // Spacing between reads OF ONE ENQUIRY (default 5000), and the cooldown after any 429/503
    // before the next GET is attempted (default 60000). Higher is safer for both.
    minGetIntervalMs: numKnobOr(process.env.GC_MIN_GET_INTERVAL_MS, 5000),
    rateLimitBackoffMs: numKnobOr(process.env.GC_RATE_LIMIT_BACKOFF_MS, 60_000),
    // THE CEILING - spacing between ANY two GETs, however many loads are armed (default 1000).
    // This is the one that bounds total request rate; lowering it is the only knob here that can
    // make the adapter hit the limiter harder. Refused below 250ms, the rate already proven bad.
    globalMinGetIntervalMs: numKnobOr(process.env.GC_GLOBAL_MIN_GET_INTERVAL_MS, null),
    // Spacing for the ROUTINE class - list paging and detail enrichment as a group (default: the
    // same as minGetIntervalMs). Higher is safer, and only slows discovery, never a poll.
    routineGetIntervalMs: numKnobOr(process.env.GC_ROUTINE_GET_INTERVAL_MS, null),
    // Ceiling on a server-supplied Retry-After (default 120000). INVERTED: lower means we stop
    // obeying the server sooner, so HIGHER is the safe direction here.
    maxRateLimitBackoffMs: numKnobOr(process.env.GC_MAX_RATE_LIMIT_BACKOFF_MS, null),
    // Adaptive throttle. Doublings of the ceiling a 429 storm may accumulate (default 3, minimum
    // 1 - adaptation cannot be switched off), and clean GETs required to walk one doubling back
    // (default 20). More steps and more reads are both the safe direction.
    rateLimitBackoffSteps: numKnobOr(process.env.GC_RATE_LIMIT_BACKOFF_STEPS, null),
    rateLimitRecoveryReads: numKnobOr(process.env.GC_RATE_LIMIT_RECOVERY_READS, null),

    // ---- OTP re-auth wire contract (src/auth/gcOtpAuth.js) ----
    // GoComet mints a ~30-day JWT and ships NO refresh endpoint, so re-auth is an OTP login.
    // BRL's own bot does this by driving a headless Chrome and scraping the token off the wire
    // over CDP, but what it captures is a plain JSON POST response - so an HTTP client is
    // sufficient and no browser is needed.
    //
    // ALL FOUR PATHS ARE READ OFF GOCOMET'S OWN SHIPPED CODE, not inferred. Sources:
    //   - the login page chunk `www.gocomet.com/_next/static/chunks/pages/login-ea2fcd48bd6b6382.js`
    //     (fetched 2026-08-10; note the `login.gocomet.com` host 404s for it, `www` serves it),
    //     which contains both the "Login with OTP" click handler and the code-submit handler;
    //   - the shared users-actions chunk recovered from the 2026-08-04 HAR capture, which owns
    //     the final login action;
    //   - the legacy bot's CDP interception of the last leg
    //     (reference/brl-gocomet/source/server.js:795-806).
    //
    // The flow is FOUR legs, not two. Verbatim from the login chunk:
    //   1. `let {user_present:t} = await y.v5(email)`      -> GET  login/is-user-present
    //      A precheck. It is the source of the portal's own "User with this email is not
    //      registered" message, and it sends nothing.
    //   2. `postRequest(Y, "engagement-app/send-email-otp", {email})` -> `.data.short_lived_token`
    //      THIS is the send-the-code leg. `Y` is `LOGIN_API + "v1/"`.
    //   3. `getRequest(L, "engagement-app/verify-email-otp", {otp, short_lived_token})`
    //      -> `.data.success`. A GET, with both values as QUERY params. Falsy success is the
    //      portal's "Incorrect OTP".
    //   4. `loginUser({email, otp, short_lived_token, recaptcha_token, redirect_url})`
    //      -> POST login/otp-login -> a top-level `token`. The shared action spreads those
    //      fields and then OVERRIDES recaptcha with the literal `recaptcha_token:"abcd"` /
    //      `recaptcha_token_type:"v3"`, so the page computes a real reCAPTCHA token and throws
    //      it away - which is what proves the server does not verify it.
    //
    // `short_lived_token` threads legs 2 -> 3 -> 4 and is REQUIRED by the final login call.
    //
    // These are separate knobs, not one base URL, so a GoComet redeploy that moves any single
    // leg is a one-line env override rather than a code change. `node scripts/probe-gocomet-otp.js`
    // confirms the live flow end to end.
    //
    // Do NOT "simplify" `/login/type` in here as an auth path. It reads like a sibling of
    // `login/otp-login` and it is not an API path at all: the route manifest maps it to
    // `static/chunks/pages/login/type-*.js`, i.e. a Next.js PAGE, reached with
    // `router.push("/login/type")` when a vendor account carries more than one schema. POSTing
    // to it answers 200 with an HTML document, which is why gcOtpAuth refuses a 200 whose body
    // is not a JSON object rather than trusting the status code.
    authBaseUrl: process.env.GC_AUTH_BASE_URL || 'https://login.gocomet.com',
    otpUserCheckPath: process.env.GC_OTP_USER_CHECK_PATH || '/api/v1/login/is-user-present',
    otpRequestPath: process.env.GC_OTP_REQUEST_PATH || '/api/v1/engagement-app/send-email-otp',
    otpVerifyPath: process.env.GC_OTP_VERIFY_PATH || '/api/v1/engagement-app/verify-email-otp',
    otpLoginPath: process.env.GC_OTP_LOGIN_PATH || '/api/v1/login/otp-login',

    // ---- THE STACK GATE (Module 2, Phase 2) ----
    // DELIBERATELY A DIFFERENT VARIABLE FROM GC_TOKEN, and that separation is the whole point.
    // `enabled` above answers "do we hold a GoComet credential"; this answers "may this process
    // poll a live third party with it". An earlier attempt collapsed the two and armed live
    // GoComet polling on the mere presence of a read token, outside the mode gate, with no way to
    // stop it short of editing .env and restarting. With this off, the adapter still registers on
    // the token-expiry rail and NOTHING else is constructed - no engine, no scheduler, no
    // discovery, no `stacks` entry - so boot is indistinguishable from today's.
    stackEnabled: process.env.GC_ENABLE === '1',
    // Console-toggleable discovery (configStore.gocometDiscovery seeds from this). Separate from
    // stackEnabled because an operator must be able to stop live polling from the console without
    // tearing the stack down or touching .env.
    discoveryEnabled: process.env.GC_DISCOVERY === '1',
    // ---- TARGET-RATE WATCH (the shipper reopens a closed load at a stated price) ----
    // A FOURTH independent gate, off by default. With it off, no watch is constructed, no
    // recently-closed load is re-read, and nothing new touches the read budget - boot is
    // indistinguishable from today's. It is separate from discoveryEnabled because this polls
    // loads AFTER their auction closed, which is a different read pattern against the same
    // budget, and an operator must be able to stop one without stopping the other.
    //
    // Detection of the event itself is NOT proven live. The design of record reads is_negotiating
    // off the discovery list row, and that flag is false in every capture on disk INCLUDING both
    // loads that demonstrably carried a target rate - so this watch re-reads the quote instead.
    // Leave it off until one live window has been observed (see the implementation note).
    targetPriceEnabled: process.env.GC_TARGET_PRICE === '1',
    // How long after its auction closes a load stays watched. Both observed targets landed within
    // 46 minutes of close, but n=2, so the default is deliberately several times the sample.
    targetPriceWatchMs: numKnobOr(process.env.GC_TARGET_PRICE_WATCH_MS, 4 * 60 * 60 * 1000),
    // Spacing between re-reads of one watched load. The shortest observed window is 13m45s, so a
    // slower cadence than this risks burning a material fraction of the window before noticing.
    targetPricePollMs: numKnobOr(process.env.GC_TARGET_PRICE_POLL_MS, 60_000),
    // Hard ceiling on reads per cycle. Target reads are ROUTINE, the same class as discovery's
    // listing, so they compete for the slot the scheduler reserves for that class (a due ROUTINE
    // waiter is served ahead of HOT/POLL); an unbounded watch set would crowd discovery out of it.
    // 5 per cycle at the 60s default is ~40% of the ROUTINE class; 13 watched loads would want 108%.
    targetPriceMaxPollsPerCycle: numKnobOr(process.env.GC_TARGET_PRICE_MAX_POLLS, 5),
    // The channel a TARGET-RATE ask goes out on, independent of notifyMode below. It defaults to
    // whatsapp even though GoComet's own default is 'dashboard', and that is deliberate: the
    // shortest observed window is 13m45s, and a console row nobody is watching is not an alert on
    // a 13-minute clock. The whole feature exists because BRL's older tool alerts them and this one
    // did not. Set GC_TARGET_PRICE_NOTIFY=dashboard to put it back behind the console.
    targetPriceNotifyMode: process.env.GC_TARGET_PRICE_NOTIFY || 'whatsapp',
    // Which channel a GoComet load's messages go out on, resolved per RECORD by
    // Notifier.notifyModeFor - the GoComet twin of the top-level `notifyMode`, and the reason that
    // one is no longer a global. DEFAULT 'dashboard': a GoComet load surfaces everywhere inside the
    // product (console board, worklist, /api/state, /api/price-requests, the public /price capture
    // page, exports) and sends no WhatsApp. SuperProcure keeps SP_NOTIFY_MODE with its current
    // meaning, so nothing on the box changes channel on deploy. Operator-editable live via
    // configStore.gocometNotifyMode; this is only the seed.
    notifyMode: process.env.GC_NOTIFY_MODE || 'dashboard',
    // Which PORTAL the stack's price requests are tagged with - the margin-profile + display
    // namespace, the GoComet twin of the top-level `platformKey` above.
    platformKey: process.env.GC_PLATFORM_KEY || 'gocomet',
    // The ACCOUNT the stack runs as. Not env-overridable: it names the durable intents file
    // (config.intentsFileFor) and is what stackForRequest matches a price request's owner against,
    // so a rename would orphan live intents and silently route every GoComet capture onto
    // stacks[0] - the SuperProcure engine. Slug-validated by accounts.js validateAccount.
    accountId: 'gocomet',
    accountLabel: 'GoComet',
    // The stack's OWN shipper scope, carried on its account record so discoveryConfigFor picks it
    // over the global SuperProcure allowlist. Non-empty by default because empty means "match
    // nothing" (discovery.matchesAllowlist fails closed) and BRL's GoComet board carries exactly
    // one shipper today - every captured enquiry's client_company_name is Waaree. Still an
    // explicit allowlist, not a match-all; override with GC_ALLOWLIST_SHIPPERS.
    //
    // 'Waaree' here is a DEFAULT, not a discovery. It is what the board carries today, so a box
    // with everything else configured correctly surfaces loads instead of silently surfacing none.
    // A second GoComet customer is an env edit, not a code change, and nothing downstream infers
    // "GoComet means Waaree" from this line.
    allowlistShippers: (process.env.GC_ALLOWLIST_SHIPPERS || 'Waaree').split(',').map((s) => s.trim()).filter(Boolean),
    allowlistLanes: (process.env.GC_ALLOWLIST_LANES || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // ---- operator login gate (console + /api) ----
  // Real mode REQUIRES both; mock/dev with no passHash runs auth-off (loud warning).
  // Hash via `node scripts/hash-password.js`; secret is any long random string.
  admin: {
    user: process.env.SP_ADMIN_USER || 'admin',
    passHash: process.env.SP_ADMIN_PASS_HASH || null,
    sessionSecret: process.env.SP_SESSION_SECRET || null,
    sessionTtlMs: Number(process.env.SP_SESSION_TTL_MS || 12 * 60 * 60 * 1000),
  },

  // ---- price-request loop (human-in-the-loop pricing intake) ----
  // The pricing team enters COST per load; the bot bids this margin band above it.
  // The lowest band rung is the operating floor (never below cost + minMarginPct).
  marginsPct: (process.env.SP_MARGINS_PCT || '12.6,7.2,6.3').split(',').map(Number),
  minMarginPct: numKnobOr(process.env.SP_MIN_MARGIN_PCT, 6.3),
  // Soft sanity floor on an ENTERED cost - a fat-finger catch, NOT the bid floor (that is
  // cost + minMarginPct, enforced in pricing.js). Freight rates are effectively never this low,
  // so a value under it is almost always a typo: a Rs 2 was entered for a ~Rs 22,000 load and
  // armed cleanly, because the floor invariant only stops the bot bidding BELOW the number typed
  // - it cannot tell an absurd cost from a real one (load 23189088, 2026-07-16). The /price form
  // asks for an explicit confirm before submitting a cost this low, and the POST handler enforces
  // the same confirm server-side (holds even if the page's JS dies). Soft by design: the pricing
  // team CAN confirm through it. Tune to real BRL rates via SP_MIN_PLAUSIBLE_COST.
  minPlausibleCost: Number(process.env.SP_MIN_PLAUSIBLE_COST || 500),
  // ---- desk clerical-error floor (HARD band) ----
  // The commitment from the 2026-07-25 training call: a desk member who types 1,500 for a load
  // they meant to price at 15,000 must be STOPPED, not asked to confirm. That is a different
  // failure from the Rs 2 fat-finger minPlausibleCost catches - a missing digit lands on a value
  // that still looks like a plausible number, so a confirm dialog would just get clicked through.
  //
  // Relationship to minPlausibleCost (the soft band above): both guards run at the same seam and
  // the HARD floor is checked FIRST. On a TRUCK-basis load, with the defaults here (hard 5000 >
  // soft 500), the soft band is unreachable - anything under 500 is already under 5000 and gets
  // hard-rejected. That is intended, not an oversight.
  //
  // On a PMT load the soft band is fully LIVE and is the ONLY guard, because the hard floor
  // returns before any comparison (the carve-out below) - a per-tonne rate under Rs 500 still
  // gets exactly the confirm-through it always had. So PMT is deliberately OUT of this
  // commitment: do not read the paragraph above as coverage for it. The soft path also survives
  // whole for operators who deliberately disable the hard floor (SP_MIN_COST_ABS=0 and
  // SP_MIN_COST_PER_KM=0), which restores the exact pre-existing behaviour byte for byte.
  //
  // The effective floor is max(minCostAbs, minCostPerKm x km), where the per-km term applies only
  // when the load carries a real SuperProcure distance (load.distanceKm, from loadDistance) -
  // never an estimate. TRUCK-basis only: on a PMT load the cost is a per-METRIC-TONNE rate where
  // Rs 800 is legitimate, so the hard floor would reject honest work; PMT keeps the soft confirm
  // alone. Either knob at 0 disables that term; both at 0 disables the hard band entirely.
  minCostAbs: numKnobOr(process.env.SP_MIN_COST_ABS, 5000),
  minCostPerKm: numKnobOr(process.env.SP_MIN_COST_PER_KM, 10),
  notifyMode: process.env.SP_NOTIFY_MODE || 'whatsapp',    // 'whatsapp' (default) | 'dashboard' (console worklist only)
  baseUrl: process.env.SP_BASE_URL || `http://localhost:${Number(process.env.PORT || 4103)}`,
  // D003: an external dead-man's-switch (healthchecks.io-style) URL, pinged after each good
  // discovery pass - proves the APP is up and discovery is actually progressing, distinct from
  // scripts/monitor-wa-sender.js's own HEALTHCHECK_URL, which only proves the box and cron are
  // alive from OUTSIDE the process. Off (null) when unset, which is the default until Sid creates
  // the check on healthchecks.io and sets this.
  appHealthcheckUrl: process.env.APP_HEALTHCHECK_URL || null,
  // The engine's own designed ladder-walk starts at engine.openAtMs (25s) + up to
  // antiDetection.openJitterMs (4s) earlier = ~29s before close - this only needs to clear
  // that with a small buffer, not the old 90-120s (which was pure unused conservatism; see
  // docs/diagnoses/... investigation, 2026-07-16). Lower this only alongside the bidEngine.js
  // never-bid-silently fix (see CLAUDE.local.md / _isLastChance) - the two ship together.
  priceDeadlineLeadMs: Number(process.env.SP_PRICE_DEADLINE_LEAD_MS || 35_000),
  // A follow-up WhatsApp nudge this long BEFORE the pricing deadline (not the close), for the
  // desk's well-documented "prices at the last minute" habit - reuses the price_needed template
  // with an urgency banner (see notifier.js remindApproaching). Clamped per-request when the whole
  // window is shorter than this lead, so a short-fuse load still gets exactly one spaced nudge
  // rather than none (see priceRequests.dueForReminder).
  //
  // 5 MINUTES, raised from 60s on 2026-07-25 alongside the reminder's new "cutoff in N minutes"
  // clause. Two constraints pin this number, measured over 504 real price requests on the prod box
  // (ask -> cutoff window: min 0.1 min, p10 12.9, p25 13.1, MEDIAN 13.3, p75 28.2, p90 57.9, max 2650):
  //   - FLOOR. Below ~2 min the nudge is unactionable - nobody sources and prices a load in 60s, so
  //     the old 60s lead was a post-mortem, not a warning, and it also made the minute count
  //     meaningless (every reminder could only ever read "under a minute", the whole reason the
  //     Director's ask could not be delivered at the old default).
  //   - CEILING. Above ~5 min the nudge collides with the original ask on a typical load: at a
  //     10-min lead the median 13.3-min window fires the reminder ~3 min after the ask, which reads
  //     as a duplicate ping - the message noise the Director has objected to before. Only 1.2% of
  //     windows are <= 10 min, but 66% are <= 15 min, so the median load is the case that governs.
  // At 5 min the median load reads: ask at T, reminder at T+8.3, cutoff at T+13.3 - clean spacing,
  // and the clause states a real number the desk can act on. Re-tune against fresh window data, not
  // by feel: raising it eats the gap after the ask, lowering it walks back toward "under a minute".
  reminderLeadMs: Number(process.env.SP_REMINDER_LEAD_MS || 300_000),
  discoveryIntervalMs,
  allowlist: { // which loads trigger a price request. Empty shippers = match NOTHING (fail closed).
    shippers: (process.env.SP_ALLOWLIST_SHIPPERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    lanes: (process.env.SP_ALLOWLIST_LANES || '').split(',').map((s) => s.trim()).filter(Boolean),
    // Module 1 is hard-close only - default the guard ON (fail safe). A fresh box, a lost env
    // var, or a corrupt-config fallback all land on the SAFE posture (hard-close only) instead
    // of silently sweeping in soft-close, out-of-scope loads. Set SP_HARD_CLOSE_ONLY=0 to also
    // target soft-close auctions (a future paid slice). Once the operator saves from the console
    // the persisted value wins, so this default only governs first boot / unconfigured deploys.
    hardCloseOnly: process.env.SP_HARD_CLOSE_ONLY !== '0',
  },

  // ---- session scope-refresh guard (src/auth/scopeRefresh.js) ----
  // SuperProcure resolves branch scope server-side at LOGIN; a long-running session goes
  // blind to branches mapped after it logged in (2026-07-16: 249 -> 276 overnight, a live
  // Tata auction invisible until a manual restart). The refresher re-runs login() on a
  // conservative cadence - hours, not minutes; two GETs per pass on the same anti-detection
  // header stack - and defers while any auction is armed. deferMs is also the retry cadence
  // after a failed pass, so the repeated-failure alert can escalate within a shift instead of
  // across days: it pages at failureAlertThreshold and then at each DOUBLING of it, and stays
  // silent only while an announced auth outage is open, the session is still unusable, AND the pass
  // failed on that refusal itself - that case belongs to raiseAuthDead. A revoked account whose
  // reads independently 500 still pages. Silenced passes do not consume rungs. Set
  // SP_SCOPE_REFRESH_FAIL_ALERTS=0 to disable the page (the streak still counts).
  scopeRefresh: {
    enabled: process.env.SP_SCOPE_REFRESH_ENABLED !== '0',
    intervalMs: Number(process.env.SP_SCOPE_REFRESH_INTERVAL_MS || 6 * 60 * 60 * 1000),
    deferMs: Number(process.env.SP_SCOPE_REFRESH_DEFER_MS || 5 * 60 * 1000),
    failureAlertThreshold: Number(process.env.SP_SCOPE_REFRESH_FAIL_ALERTS || 3),
  },

  // ---- WhatsApp notifications (Maytapi) ----
  // Maytapi is the provider BRL already runs for GoComet - unofficial WhatsApp API,
  // no Meta template approval. With notifyMode='whatsapp' the notifier renders each
  // alert to text and sends it to subscribed recipients. All of enabled + token +
  // productId + phoneId must be present or it stays dark (dashboard worklist only).
  // The phoneId selects which linked sender number the alerts go out from.
  whatsapp: {
    enabled: process.env.SP_WHATSAPP_ENABLED === '1',
    token: process.env.SP_MAYTAPI_TOKEN || null,
    productId: process.env.SP_MAYTAPI_PRODUCT_ID || null,
    phoneId: process.env.SP_MAYTAPI_PHONE_ID || null,
    endpoint: process.env.SP_MAYTAPI_ENDPOINT || 'https://api.maytapi.com/api',
    // ---- price-ask failover fleet (src/notify/senderFleet.js) ----
    // ORDERED, comma-separated Maytapi phoneIds tried AFTER `phoneId` when the primary sender's
    // session is down and a price ask would otherwise be skipped. A fourth controlled number is a
    // value in this list, never a code change - that is the whole reason it is a list and not a
    // `fallbackPhoneId` scalar.
    //
    // DEFAULT EMPTY, so an unset box behaves EXACTLY as it did before this feature existed: the fleet
    // has only the primary in it, no sibling can be picked, and price_needed degrades to the same
    // skip-and-retry it always did. Turning the failover on is a deliberate operator act.
    //
    // Membership is NOT taken from this list. A phoneId here is only ever a CANDIDATE; whether it may
    // post into a given customer group is decided per-group by a live getGroups read at send time.
    // Listing a number that is not in a group is therefore safe - it is simply never picked for it.
    // Measured 2026-08-06: 136151 is a participant of 16 of the 18 live "BRL Bids" groups (not Cords
    // Cable, not Shriji Polymers), so those two customers fall through to the desk-owner DM + email.
    fleetPhoneIds: (process.env.SP_MAYTAPI_FLEET_PHONE_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // How long a getGroups membership read is reused during an outage. Long enough that a burst of
    // asks costs one read per candidate, short enough that a number added to a group mid-outage is
    // picked up within the same incident.
    fleetMembershipTtlMs: Number(process.env.SP_MAYTAPI_FLEET_MEMBERSHIP_TTL_MS || 10 * 60 * 1000),
  },

  // ---- daily morning heartbeat (WhatsApp self-check DM) ----
  // One message every morning (default 08:00 IST) saying "the bot is alive, here is
  // yesterday, here is anything needing a human" - src/notify/heartbeat.js. Recipients
  // are a comma list of person ids (data/people.json) and/or raw phones/group JIDs;
  // with nothing set it defaults to EVERY person record whose NAME contains any of the
  // comma-separated fragments in defaultRecipientName ('Suyashh,Sushant,Siddharth' -
  // the director, BRL's IT owner, and the developer who fixes the bot; all three act
  // on an "attention needed" morning, so all three must get the brief - not just the
  // director). Enabled by default: the message's ABSENCE is the alarm this feature
  // exists to create, so it must not depend on anyone remembering an env var on a fresh
  // box (a box with WhatsApp unconfigured just logs the skip - nothing can send
  // anyway). Time is IST regardless of the box's own timezone (the reader lives in IST;
  // the VPS may not).
  heartbeat: {
    enabled: process.env.SP_HEARTBEAT_ENABLED !== '0',
    timeIST: process.env.SP_HEARTBEAT_TIME_IST || '08:00',
    recipients: (process.env.SP_HEARTBEAT_RECIPIENTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    defaultRecipientName: process.env.SP_HEARTBEAT_DEFAULT_NAME || 'Suyashh,Sushant,Siddharth',
  },

  // ---- per-customer end-of-day report (WhatsApp group message) ----
  // At 20:00 IST (the client's agreed day-end mark) every customer group gets its
  // OWN day summary - src/notify/eodReport.js. No recipient config: the group list
  // resolves dynamically from the model (people records with a group JID + their
  // customer assignments), so adding a customer group on the Team/Assignments pages
  // is the whole onboarding. Enabled by default for the same reason the heartbeat
  // is: a report whose absence is the signal must not hinge on a remembered env var.
  eodReport: {
    enabled: process.env.SP_EOD_REPORT_ENABLED !== '0',
    timeIST: process.env.SP_EOD_REPORT_TIME_IST || '20:00',
  },

  // ---- director-level cross-customer EOD participation DM (WhatsApp) ----
  // At 20:10 IST (just after the 20:00 group EODs) the directors get ONE cross-customer
  // participation summary by direct message - src/notify/directorEod.js. Unlike the
  // heartbeat and group EOD (both on by default because their absence is the alarm),
  // this goes to named humans by raw number, so it is OFF unless SP_DIRECTOR_EOD_RECIPIENTS
  // is set (comma-separated numbers). An unset var means silence - never a surprise DM to
  // a stale number. `enabled` derives from a non-empty recipient list, so the fail-safe
  // cannot be defeated by a stray flag. Time is IST regardless of the box's own timezone.
  directorEod: {
    enabled: directorEodRecipients.length > 0,
    timeIST: process.env.SP_DIRECTOR_EOD_TIME_IST || '20:10',
    recipients: directorEodRecipients,
  },

  // ---- out-of-band reroute channel (heartbeat when the WhatsApp sender is down) ----
  // When the Maytapi sender session is logged out, the morning heartbeat must NOT queue onto the
  // dead sender (it floods on re-link) but must still reach a human (its absence is the alarm). The
  // Notifier reroutes it through this Maytapi-INDEPENDENT channel instead - src/notify/alertChannel.js
  // (Brevo email as the real backstop + a healthy SIBLING Maytapi phone as the secondary). Env keys
  // mirror the standalone monitor (scripts/monitor-wa-sender.js) so one set of creds serves both. All
  // optional: with nothing set the channel is a silent no-op and a down-sender heartbeat simply drops
  // (still never queued onto the dead sender - the standalone monitor covers sender-down separately).
  // The Maytapi creds for the sibling tier come from the `whatsapp` block above (same product/token);
  // the sibling pick excludes that same phoneId (the down sender) by construction.
  fallbackAlert: {
    brevoApiKey: process.env.BREVO_API_KEY || null,
    brevoSender: process.env.BREVO_SENDER || 'alerts@bestroadways.com',
    emailTo: (process.env.MONITOR_EMAIL_TO || 'siddharth.rodrigues@bestroadways.com,sushant.govinde@bestroadways.com,sg@bestroadways.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // dorddis@gmail.com moved off the primary recipient list onto bcc while the BRL address settles
    // in as the primary - see MONITOR_EMAIL_BCC.
    emailBcc: (process.env.MONITOR_EMAIL_BCC || 'dorddis@gmail.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
  },

  engine: {
    // timing knobs — calibrate to the platform's real close behaviour once known.
    // openAtMs is generous here so the demo is watchable (the bot shows a live
    // rank/bid earlier); tighten it for production to reveal price later.
    openAtMs: 25_000,
    // Establish mark for a SOFT-close load that is not on the soft-close allowlist - i.e. every
    // GoComet load today, since GoComet declares closeModel 'soft' as a static capability and no
    // GoComet shipper has ever been allowlisted. Sized so that one legitimate GoComet read outage
    // (a 60-120s rate-limit cooldown, during which the engine cannot decide at all) cannot span the
    // window and leave an armed load with nothing on the board; the full derivation lives beside
    // softOpenAtMs in bidEngine.js DEFAULTS. It is a repo-tracked default on purpose: the behaviour
    // has to be right on a fresh box with no env and no on-box config edit.
    softOpenAtMs: numKnobOr(process.env.SP_SOFT_OPEN_AT_MS, 150_000),
    // Per-load spread on softOpenAtMs (one-sided EARLIER), so the first bid is not placed at a fixed
    // countdown mark on every load. Lives here rather than under antiDetection because varied timing
    // is a requirement of this path, not a decoration on it - which also means it never passes
    // through that validator, so bidEngine bounds it at the read site instead. See bidEngine.js
    // DEFAULTS and SOFT_OPEN_JITTER_MAX_FRACTION.
    softOpenJitterMs: numKnobOr(process.env.SP_SOFT_OPEN_JITTER_MS, 15_000),
    floorWindowMs: 2_500,
    rungs: 6,
    openingMarkupPct: 0.10,
    // Fine-ladder rung cap (Layer 3). 0 = auto: bounded by real constraints (platform bid count,
    // min-bid-difference headroom, runaway belt), not a fixed count. SP_RUNG_CAP > 0 is a
    // deliberate back-off lever, not a bid-rate control - bids are cadence-bounded, not grid-bounded.
    rungCap: Number(process.env.SP_RUNG_CAP || 0),
    // FTL multi-vehicle count fix - Layer B. DEFAULT ON, proven live 2026-07-23 on load 23423905
    // (Pathredi -> Bangalore, No Of Vehicles: 2): the engine planned vcq:2, all three ladder rungs
    // returned HTTP 201, and the read-back oracle logged ZERO `vehicle_count_mismatch` events - i.e.
    // SuperProcure recorded bidVehicleCount:2 from vcq:N alone. That is the supervised confirmation
    // the old gate waited for, so on a genuine, WELL-FORMED FTL multi-vehicle load the engine now
    // bids all N required trucks (vcq = N, amount already per-vehicle) instead of holding.
    // SP_MULTI_VEHICLE_BID is now an OFF-SWITCH: set it to 0 to force the old fail-closed
    // hold-and-alert on every multi-vehicle load. A genuinely malformed / unknown-basis count
    // (units > 1 with NO recorded quoteType - the stale pre-fix intent case) still FAILS CLOSED
    // regardless of this flag; only the proven, well-formed N>=2 case auto-bids (the count basis
    // there cannot be shown to be trucks rather than tonnes). See bidEngine `_multiVehiclePlan`.
    multiVehicleBid: process.env.SP_MULTI_VEHICLE_BID !== '0',
    // How stale a load's last SuperProcure listing must be before the engine tells the desk the load
    // looks delisted (bidEngine._checkDelisted). Three missed discovery polls at the 30s
    // discoveryIntervalMs above: the tightest real case measured was 2.0 minutes stale at arm, and
    // ordinary poll jitter runs one interval, so 90s separates them with headroom either way. It
    // gates a NOTICE only - nothing here can stop a bid.
    delistedStaleMs: Number(process.env.SP_DELISTED_STALE_MS || 90_000),
    // How long a load this adapter has never listed (the post-restart arm) waits for the discovery
    // poll to settle whether it is open before probing the portal itself (bidEngine._checkDelisted,
    // BC-15 Fix B, ruling 65). Two discoveryIntervalMs polls, floored at 60s so a restart arming many
    // such loads at once cannot open more than a handful of fallback reads even if discovery itself
    // is unhealthy. Gates the fallback probe only; a listing that lands sooner settles it for free.
    neverListedProbeBoundMs: Math.max(2 * discoveryIntervalMs, 60_000),
    // SIBLING SAFETY GATE - SP_PMT_BID (per-tonne bidding, default OFF, opt-in). It is NOT read here:
    // the fail-closed guard that consumes it (loadRules.assertRulesSupported) is a pure model-layer
    // function with no config handle, so the flag is read at rulesConstants.effectiveSupportedMechanics
    // (beside SUPPORTED_MECHANICS, where the three fail-closed layers all agree on it). Documented here
    // only so an operator scanning config.js for SP_* flags finds the pointer. See rulesConstants.js.
    //
    // NOT A KNOB, and pointed at here for the same reason. `authAlarmSuppressMaxMs` bounds how long a
    // dead SuperProcure session may hold back the zero-bid alarm; past it the alarm resumes even with
    // the latch still set, so a stuck latch degrades to noise rather than to silence. It has no env
    // var and no configStore entry ON PURPOSE - an operator who could raise it from the Settings page
    // could re-open the hole with no code review, the same posture pollHotMs takes. Its single value
    // lives in bidEngine's DEFAULTS (7_200_000 = 2h); see _authDeadWithinBound.
  },

  // ---- soft-close / auction-extension strategy (L3) - per-customer, DEFAULT OFF (fail closed) ----
  // A soft-close auction (branchAuctionExtendTime > 0) is anti-snipe: a late bid extends the clock, so
  // the deployed floor-snipe would just trigger an extension and reveal our floor early. The engine runs
  // the soft-close endgame (suppress the floor snipe until the capped extensions exhaust, then snipe the
  // genuinely-final window) ONLY for a shipper explicitly on `shippers` while `enabled` is on; every
  // other soft load stays out of scope via hardCloseOnly's fail-closed exclusion. `mode` decides whether
  // an enabled shipper is OBSERVED read-only ('shadow' - would-have-done decisions logged, ZERO wire
  // writes) or bid for real ('live' - the evidence-gated graduation, E1/E2). Default 'shadow'. A fresh
  // box, a lost env var, or a corrupt-config fallback all land on the SAFE posture (disabled).
  softClose: {
    enabled: process.env.SP_SOFT_CLOSE_ENABLED === '1',                        // master gate; default OFF
    shippers: (process.env.SP_SOFT_CLOSE_SHIPPERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    mode: process.env.SP_SOFT_CLOSE_MODE === 'live' ? 'live' : 'shadow',        // 'shadow' (default) | 'live'
    reserve: Number(process.env.SP_SOFT_REVISION_RESERVE || 1),                 // revisions held for the final snipe
    // Rank-driven step size: how many rungs to step down PER rival ahead of us (jump = (rank-1) x this).
    // The single tunable knob of the rank-driven endgame (system/customer level, never per-load).
    // Conservative default 1 (one rung per rival) - the least-aggressive, margin-protecting direction.
    jumpPerRival: Number(process.env.SP_SOFT_JUMP_PER_RIVAL || 1),
    // How far BEFORE the anti-snipe trigger window a soft load establishes its presence, so the
    // establishing bid does not itself land inside the window and self-trigger an extension. Establish
    // fires at remaining <= max(openAtMs mark, triggerWindowMs + this). Default 40s.
    establishLeadMs: Number(process.env.SP_SOFT_ESTABLISH_LEAD_MS || 40_000),
    // NOTE: no trigger-window KNOB here. The trigger window (branchAuctionRemainingTime) is PER-BRANCH
    // (100 on most, 200 on Shriji, 0 on Havells-hard - v4 capture finding 7) and is read per-load off
    // the live SP object, never a hardcoded/operator-set fallback. An operator knob would be dishonest:
    // the money-path endgame does not (and per D6 cannot) branch on it - the defend is reserve-gated the
    // same inside or outside the window, so a settable value would change no decision.
  },

  // ---- round-figure quoting ----
  // Snaps an opted-in shipper's ladder onto a rupee grid (pricing.js roundLadderToGrid). NOT free and
  // never a blanket default: the floor can only round UP, so the final snipe fires above the true
  // floor and forfeits auctions an un-snapped ladder would win. Worth paying only where the shipper
  // discards an odd bid outright. Same opt-in shape as softClose - master gate OFF, allowlist empty -
  // so a fresh box, a lost env var and a corrupt-config fallback all land on "round nothing".
  rounding: {
    enabled: process.env.SP_ROUNDING_ENABLED === '1',                            // master gate; default OFF
    shippers: (process.env.SP_ROUNDING_SHIPPERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    step: Number(process.env.SP_ROUNDING_STEP || 100),                           // grid in rupees; 100 = hundreds
  },

  // ---- anti-detection ("human-like" cadence) — capped at "plausible human" ----
  // Operator-editable from Settings; seeds the admin ConfigStore. The engine reads
  // the EFFECTIVE values live (server.js applies a save without a redeploy). When
  // enabled=false the jitter is zeroed (a fixed-interval metronome); the bids/min
  // and inter-fire caps are SAFETY guards and stay active regardless. The snipe
  // window (last 10s) is never jittered — that timing is correctness, not stealth.
  antiDetection: {
    enabled: process.env.SP_ANTIDETECT_ENABLED !== '0',
    cadenceJitterMs: Number(process.env.SP_CADENCE_JITTER_MS || 250),  // spread on the far/mid poll
    openJitterMs: Number(process.env.SP_OPEN_JITTER_MS || 4000),       // fires the establish bid up to this much earlier
    maxBidsPerMin: Number(process.env.SP_MAX_BIDS_PER_MIN || 20),      // per-auction runaway guard
    minInterFireMs: Number(process.env.SP_MIN_INTER_FIRE_MS || 150),   // floor on bid-to-bid spacing
  },

  // demo-only: how the simulator behaves
  sim: {
    autoStepMs: 250,
  },
};
