'use strict';
/**
 * Sender re-link accelerator - put the CURRENT WhatsApp QR into the hands of whoever receives the
 * "sender is DOWN" alert, so re-linking no longer means finding a desktop and logging into the
 * Maytapi console first.
 *
 * WHY: when the Maytapi sender logs out (twice in the week of 2026-07-24; 128023 down again from
 * 2026-07-25 ~13:46 IST) every send still answers success:true and delivers nothing. Recovery is a
 * PHYSICAL act - someone holding the sender phone opens WhatsApp > Linked Devices > Link a Device
 * and scans the QR Maytapi is showing for that slot. Until now that QR existed only in the web
 * console, so the person who got the alert on their phone had to go find a computer. This module
 * fetches the live QR and delivers it as an image next to the alert they already receive, which is
 * exactly the screen a colleague can hold up for the sender phone to scan.
 *
 * ENDPOINT (live-verified 2026-07-25 against the logged-out sender 128023):
 *   GET {base}/{productId}/{phoneId}/qrCode  ->  raw PNG bytes, Content-Type: image/png, ~6 KB.
 *   Maytapi's own Postman collection names it "Get qr-code image" (Session Information Getters).
 *
 *   AND AGAINST THE SAME SLOT WHILE ACTIVE (read-only probe later the same day, once 128023 had
 *   recovered onto 918882034647): the same call answers HTTP 200, application/json, 53 bytes,
 *   {"success":false,"message":"Could not find qr code."} - an error ENVELOPE, never an image. So
 *   /qrCode is genuinely QR-only in both directions, which is the property the /screen note below
 *   depends on. Two things follow. First, the 200-with-success:false asymmetry means res.ok is TRUE
 *   for that refusal, so only fetchQr()'s PNG magic-byte check rejects it. Second, the same probe
 *   recorded the live board shape: `status` came back as a bare JSON string on all 8 slots, with
 *   'active' and 'idle' the observed values - see qrEligibleStatus(), which is an allowlist over
 *   that vocabulary rather than a denylist that admits anything it does not recognise.
 *
 * DO NOT SUBSTITUTE THE SIBLING /screen ENDPOINT. The same collection calls it "Instance
 * Screenshot", and that is literally what it is: on 2026-07-25 the ACTIVE phone 136151 answered
 * GET /screen with HTTP 200, image/png, 128,024 bytes, 1001x726 - a screenshot of the live
 * WhatsApp-Web browser instance (chat list, contact names, message previews). The logged-out
 * 128023 answered the same shape at 76,004 bytes with identical dimensions, so NOTHING in the HTTP
 * response distinguishes "this is a QR" from "this is a picture of BRL's conversations". /qrCode is
 * the purpose-built, QR-only read and is the only endpoint this module will ever call.
 *
 * ROTATION: the QR refreshes roughly every 20 seconds, so a snapshot goes stale almost immediately.
 * Nothing here is cached - the QR is re-fetched on EVERY push. But a 20-second artifact pushed on a
 * cooldown measured in TENS OF MINUTES is not a working recovery path on its own, so delivery is
 * three layers and the image is deliberately NOT the primary one:
 *
 *   1. PRIMARY - the on-demand page. GET /api/wa/relink-qr on the app itself (src/web/server.js),
 *      behind the same operator session as every other /api route AND behind its own currentAdmin
 *      check, so the highest-value endpoint in the app fails closed even if that gate is reordered.
 *      It fetches a FRESH QR per request and the page re-pulls one every 10 seconds - bounded, and
 *      paused while the tab is hidden - so whoever opens it is always inside the rotation window
 *      without an abandoned tab polling Maytapi forever. The page has four states, not one: live,
 *      re-linked (the 409 the fail-closed gate returns once the slot flips active), session
 *      expired, and Maytapi-not-answering. They used to be one identical broken image, which is
 *      dangerous in the SUCCESS case - a broken icon after a scan that worked reads as "that
 *      failed", and the next move is to rescan or hand the phone to someone else. The alert text
 *      carries the URL. createRelinkQrHandler() below is the handler; it lives here rather than in
 *      src/ so the eligibility gate, the fetch and the wrong-handset warning have exactly ONE
 *      implementation shared with the monitor - see buildScanWarning().
 *   2. OPT-IN PUSH - the image in the DM (this module's original job), OFF unless SP_WA_QR_IN_ALERT
 *      says otherwise (see qrDeliveryEnabled). To make a ~20s artifact usable at all it is not
 *      pushed once and forgotten: the monitor's decideQrBurst() re-pushes a freshly-fetched code on
 *      a short, BOUNDED cadence for the first few minutes after each full down-alert, so an
 *      operator who reaches their phone a few minutes late still has a live code. The caption still
 *      says plainly that any given image may have expired, and points at layer 1 for a live one.
 *   3. DOCUMENTED FALLBACK - the Maytapi console, named in the alert body and written up in
 *      docs/NOTIFICATIONS.md. This is what covers the app being down at the same time as the
 *      sender, which is exactly when layer 1 is unreachable.
 *
 * SECURITY INVARIANT (structural, not advisory): a WhatsApp QR is a live PAIRING credential, and
 * the pairing direction is the opposite of the intuitive one. Maytapi's instance for the slot is
 * the COMPANION device: it displays the QR, and the PRIMARY phone scans it. So scanning does not
 * give the scanner BRL's number - it re-points BRL's production sender slot at the SCANNING PHONE's
 * WhatsApp account. A mis-scan therefore means BRL's bidder starts sending customer notifications
 * from a personal number and BRL's webhook starts ingesting that person's private WhatsApp traffic.
 * Two consequences, both enforced in code rather than by instruction:
 *   - the QR may only ever reach the monitor's INDIVIDUAL alert recipients - the named admin
 *     numbers - and must never reach a group. assertIndividualRecipient() enforces that by
 *     ALLOWLIST (a bare MSISDN and nothing else) and THROWS rather than coercing, because the
 *     silent-coercion failure is the dangerous one: the transport elsewhere in this codebase
 *     digit-strips its recipient, which would turn the group JID '120363@g.us' into the
 *     plausible-looking number '120363' and send successfully to the wrong place. A refusal is
 *     loud; a coercion is invisible.
 *   - every rendered instruction NAMES the handset that must do the scanning (the last-known-good
 *     MSISDN the monitor persists while the sender is healthy) and states what happens if any other
 *     phone scans it, and the monitor verifies the binding AFTERWARDS - classifyRebind() below, so
 *     a slot that comes back on a stranger's account is a loud alert instead of "is BACK".
 * The QR bytes are held in memory for the duration of one delivery and are never written to disk.
 *
 * FAILURE POSTURE: this whole module is an ENHANCEMENT on top of an alert that has already been
 * sent. deliverQrRelink() never throws and never rejects - every failure degrades to today's
 * text-only alert and is reported in the return value for the log line, and the outcome rides the
 * monitor's healthcheck ping so a silently dark QR tier is visible externally.
 */

// Group ids minted since 2021 are plain digits; older ones are '<creator>-<timestamp>'. This is a
// deliberate VERBATIM copy of the predicate in src/model/normalizePhone.js: monitor-wa-sender.js is
// standalone by design (it must keep running and alerting when the app itself is down, so it
// imports nothing from src/). The copy is pinned to the original by a parity test in
// scripts/test-sender-qr-relink.js that runs both implementations over a shared vector table, so
// drift between the two shows up as a test failure rather than as a silent hole in this guard.
const GROUP_JID_RE = /^\d+(-\d+)?@g\.us$/i;

// An individual WhatsApp recipient as Maytapi wants it: country code, no '+', digits only.
// Deliberately an ALLOWLIST - see the security invariant above.
const INDIVIDUAL_MSISDN_RE = /^\d{7,15}$/;

// PNG signature. The QR endpoint returns a real PNG; anything else means Maytapi answered with
// something that is not the QR image (an error envelope, an HTML page) and must not be forwarded.
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The live QR is ~6 KB. A generous ceiling that still refuses to base64 something enormous into a
// WhatsApp send if the endpoint ever starts returning a different payload.
const QR_MAX_BYTES = 512 * 1024;

const DEFAULT_ALERT_TO = '919356252711,919594937777';

// The path the on-demand QR page is mounted at (src/web/server.js). Named here so the monitor's
// alert text and the server's route registration cannot drift apart.
const RELINK_QR_PATH = '/api/wa/relink-qr';

// How often the on-demand page pulls a fresh QR. Comfortably inside the ~20s rotation, and slow
// enough that a page left open is not hammering Maytapi.
const QR_PAGE_REFRESH_MS = 10000;

// How long the page keeps refreshing before it gives up. Every poll costs a listPhones AND a
// /qrCode read against the same Maytapi account the monitor's health check and the bidder's
// customer notifications share, so an abandoned tab is not free: unbounded at 10s it is ~17k reads
// a day, indefinitely. A re-link is a minutes-long task someone is actively performing, so a bound
// generous enough to cover a real one is still two orders of magnitude cheaper than none.
const QR_PAGE_MAX_AGE_MS = 15 * 60000;

// Audit throttle for the ?img=1 serve. The page polls every QR_PAGE_REFRESH_MS, so logging every
// serve would write ~6 lines a minute into the stream operators read. One line on the first serve
// per session, then at most one a minute, each carrying how many polls it stands for - so the
// record still attests how many times the credential was actually handed out.
const QR_AUDIT_THROTTLE_MS = 60000;

// The deployed app directory - where the .env every script in this family reads lives. Overridable
// via MONITOR_APP_DIR for a non-standard box or a test.
const APP_DIR = process.env.MONITOR_APP_DIR || '/home/best-app/sp-bidder';

/**
 * Parse the app's .env into a plain object, with the REAL environment layered on top so a cron-line
 * or shell override always wins.
 *
 * Shared rather than copied. The scripts in this family are standalone by design - they import
 * nothing from src/ so they keep running when the app is down - but "standalone" has never meant
 * "duplicated among themselves", and this file exists precisely to give them one implementation of
 * the pieces they overlap on. A hand-authored second copy of an .env parser is the same drift shape
 * buildScanWarning() and parseAlertRecipients() were converged to close.
 *
 * Never throws: a missing or unreadable .env just means process.env is all there is, which is the
 * correct answer for a box where the environment is supplied some other way.
 */
function loadEnv(appDir = APP_DIR) {
  const out = {};
  try {
    for (const line of require('fs').readFileSync(appDir + '/.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (_) { /* fall back to process.env only */ }
  return Object.assign({}, out, process.env); // real env wins, so a cron override works
}

function isGroupJid(raw) { return GROUP_JID_RE.test(String(raw == null ? '' : raw).trim()); }

/**
 * Render an MSISDN for a human to READ OFF A PHONE and compare against the handset in their hand.
 * '919594963615' -> '+91 95949 63615'. Anything that is not a recognisable Indian mobile is shown
 * as '+<digits>' rather than mangled, and an unusable value returns null so callers can omit the
 * line entirely instead of printing 'undefined' next to a scan instruction.
 */
function displayMsisdn(raw) {
  const digits = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
}

/**
 * The absolute URL of the on-demand QR page, built from the app's own public base (SP_BASE_URL -
 * the same value config.baseUrl uses for the /price links). Returns null when it is not configured,
 * in which case the alert simply omits the line rather than printing a localhost URL to an operator
 * standing somewhere else.
 */
function relinkQrUrl(env) {
  const base = String((env || {}).SP_BASE_URL || '').trim().replace(/\/$/, '');
  if (!base || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(base)) return null;
  return `${base}${RELINK_QR_PATH}`;
}

/**
 * Same value as expectedSenderNumber(), for a caller that has the state FILE rather than the parsed
 * state - i.e. the web app, which does not run the monitor loop.
 *
 * The read lives here rather than in src/web/server.js for two reasons: the shape of the monitor's
 * state file belongs to the monitor, and src/ is held to a no-fs architectural gate (app state goes
 * through the store seam; this file is written by a standalone cron script that predates it and
 * deliberately does not use it). Never throws - a missing or corrupt state file just means the page
 * cannot name the handset, which it says out loud rather than guessing.
 */
function readLastKnownNumber(stateFile) {
  let state = null;
  try { state = JSON.parse(require('fs').readFileSync(stateFile, 'utf8')); } catch (_) { state = null; }
  return expectedSenderNumber(state);
}

/**
 * Where the monitor keeps its state. One expression shared by the monitor and the probe, so the two
 * cannot disagree about which file holds the observed sender number.
 */
function monitorStateFile(env) {
  return (env || {}).MONITOR_STATE_FILE || (APP_DIR + '/data/monitor-wa-state.json');
}

/**
 * The monitor's OBSERVATION: the MSISDN the slot actually answered on during its last healthy run.
 * Only ever written from a live board read.
 */
function observedSenderNumber(state) {
  return state && state.lastKnownNumber != null
    ? (String(state.lastKnownNumber).replace(/[^\d]/g, '') || null)
    : null;
}

/**
 * The staff allowlist the daily group tripwire already maintains. Overridable for tests.
 */
function staffRosterFile(env) {
  return (env || {}).SP_STAFF_ROSTER_FILE || (APP_DIR + '/data/staffRoster.json');
}

/**
 * Every MSISDN that belongs to BRL, as digit-strings. This is the set a reconnect is judged against.
 *
 * Two independent sources, unioned, because neither alone covers the fleet:
 *   - the OTHER slots on BRL's own Maytapi product. A number holding a slot on BRL's account is
 *     BRL's by construction. The subject slot is excluded DELIBERATELY: after a re-bind its number
 *     is whatever just captured it, so counting it would let any handset authorise itself.
 *   - data/staffRoster.json, the operator-editable allowlist the daily group tripwire already reads.
 *     It is edited on the box without a deploy, which is what puts this list in the hands of whoever
 *     actually knows which handsets BRL runs.
 *
 * An unreadable or absent roster yields the board half alone rather than throwing. Note which way
 * that fails: a number missing from the set is treated as a STRANGER and alarms, so a degraded set
 * makes the monitor noisier, never quieter.
 *
 * ACCEPTED RISK, DECIDED BY SID 2026-09-23 - do not "fix" this without asking him.
 * staffRoster.json answers "may this person sit in a BRL Bids group", not "is this a bidder
 * handset". It is 47 PERSONAL mobiles, so a staff member who scans the re-link QR on their own
 * phone lands in this set: the monitor reports a routine swap, adopts the number, and the
 * wrong-handset alarm is disarmed for exactly the case it was built to catch. The alternative on the
 * table was to silence only on Maytapi slot numbers plus an explicit bidder-handset list, and let a
 * roster match soften the alert's wording without silencing it. That was declined in favour of the
 * simpler list, with the exposure understood. Two things follow and must not be quietly dropped:
 * the roster is now a security boundary rather than a group-hygiene list, and the bidder's own
 * handset has to be ON it (the board half excludes the subject slot, so nothing else can put it
 * there) or every recovery is hedged and every swap back to it alarms.
 */
function knownBrlNumbers({ phones, senderId, rosterFile } = {}) {
  const out = new Set();
  const add = (n) => {
    const d = String(n == null ? '' : n).replace(/[^\d]/g, '');
    if (d) out.add(d);
  };
  for (const p of (Array.isArray(phones) ? phones : [])) {
    if (String(p && p.id) === String(senderId)) continue;
    add(p && p.number);
  }
  let roster = null;
  try { roster = JSON.parse(require('fs').readFileSync(rosterFile, 'utf8')); } catch (_) { roster = null; }
  const listed = roster && roster.allowlist && Array.isArray(roster.allowlist.numbers)
    ? roster.allowlist.numbers : [];
  for (const n of listed) add(n);
  return out;
}

/**
 * The MSISDN this slot was last seen on - what a reconnect is compared against to detect that it
 * MOVED. Null when no healthy run has recorded one yet; callers must read that as "cannot compare",
 * never as "matches".
 *
 * THERE IS NO OPERATOR PIN ANY MORE. SP_MAYTAPI_SENDER_NUMBER used to declare one owning handset and
 * outrank this observation. It is gone because it answered the wrong question. BRL runs a fleet of
 * handsets on one Maytapi product and moves the sender between them, so "is this THE number" fires
 * on every legitimate swap, and its only remedy is to go and re-type the declaration - which is how
 * a correct re-link on 2026-09-22 produced 35 hours of urgent alarms naming BRL's own handset as an
 * intruder. The question that actually separates a swap from a takeover is "is this ONE OF OURS":
 * see knownBrlNumbers(). This value now only says WHAT CHANGED, never whether the change was wrong.
 */
function expectedSenderNumber(state) {
  return observedSenderNumber(state);
}

/**
 * Did the slot come back on the number it went down with?
 *
 * This is the detection half of the pairing hazard in the header. A QR scanned by the WRONG handset
 * re-binds BRL's production sender to that phone's WhatsApp account, and the slot then reads as
 * perfectly healthy - status 'active', a non-null number - so a null check can never catch it. Only
 * a COMPARISON can.
 *
 *   'match'     - same number, this is a genuine recovery.
 *   'mismatch'  - the slot is live on a DIFFERENT account. Never announce recovery for this.
 *   'first-run' - nothing to compare against yet (fresh box / first healthy read). Record it and
 *                 say so, but never block: refusing to acknowledge a healthy sender because we have
 *                 no history would turn a cold start into a permanent alarm.
 */
function classifyRebind(actual, expected) {
  const a = String(actual == null ? '' : actual).replace(/[^\d]/g, '');
  const e = String(expected == null ? '' : expected).replace(/[^\d]/g, '');
  if (!a) return { verdict: 'first-run', actual: null, expected: e || null };
  if (!e) return { verdict: 'first-run', actual: a, expected: null };
  return { verdict: a === e ? 'match' : 'mismatch', actual: a, expected: e };
}

// The one word every surface uses for the wrong-bind state, so the monitor alert, the page and the
// push refusal cannot describe the same condition three different ways.
// Deliberately says only what EVERY caller can actually establish: the numbers differ. bindingGate()
// and the re-link handler decide on inequality alone - they never consult knownBrlNumbers - so a
// shared constant claiming the phone "is not BRL's" would put an assertion in their mouths that they
// did not test. Only the monitor's alarm branch has run the membership check, and it says so in its
// own body rather than smuggling the claim into the name of the state.
const REBOUND_STATE = 'is linked to a different phone than expected';

/**
 * The single line every tier says when there is NO baseline to verify against.
 *
 * `lastKnownNumber` is only written on a HEALTHY run, so a box deployed while the sender is already
 * down has nothing to compare a recovery against - and that is exactly the first re-link after this
 * build ships. In that window classifyRebind() can only ever answer 'first-run', which means the
 * wrong-handset alarm is structurally incapable of firing. That must be SAID, on every tier, not
 * left as a console.log nothing reads: an operator who knows verification is off checks the handset
 * themselves, which is the only control left.
 */
const NO_BASELINE_WARNING = 'NO NUMBER ON RECORD for this slot, so the wrong-phone check is OFF: '
  + 'nothing can tell you if this gets linked to the wrong phone until it has been up once. '
  + 'Check in the Maytapi console which phone it should be, before anyone scans.';

/**
 * The wrong-handset warning, in ONE place, for all three renderers (the DM caption, the on-demand
 * page, and the monitor's alert body).
 *
 * This is safety-critical copy - the module header calls a wrong-handset scan "the one mistake that
 * is expensive" - and it used to be hand-authored three times, with two sentences byte-identical
 * across two files and a third, divergent wording in the monitor. That drift is the bug: the surface
 * an operator happens to read decides how well they are warned. Formatting per channel (plain text
 * vs HTML) happens here; the SENTENCES have one source.
 *
 * Returns the three fragments in the order they must always be said: WHICH handset, what a wrong
 * scan DOES, and the steps to take on the right one.
 */
function buildScanWarning({ expectedNumber, format = 'text' } = {}) {
  const html = format === 'html';
  const pretty = displayMsisdn(expectedNumber);
  const number = pretty ? (html ? `<strong>${escapeHtml(pretty)}</strong>` : pretty) : null;
  return {
    handset: number
      ? `Scan this ONLY from the phone with WhatsApp number ${number}.`
      : 'Scan this ONLY from the phone that normally runs the bidder - its number could not be read, so check in the Maytapi console which one that is first.',
    consequence: "Scan it from any other phone and that phone becomes BRL's bidder: every customer message goes out from it, and its private WhatsApp comes into BRL's systems.",
    steps: html
      ? 'On that handset: WhatsApp &gt; Linked Devices &gt; Link a Device.'
      : 'On that handset: WhatsApp > Linked Devices > Link a Device.',
  };
}

/**
 * May we hand out a pairing QR for this slot at all, given what it is CURRENTLY bound to?
 *
 * The companion pairing direction (see the header) means a QR re-points the slot at whoever scans.
 * If the board already reports the slot live on a number that is not the expected one, the slot has
 * already been captured - and serving another pairing code in that state is worse than useless: it
 * is a second credential handed out while the first mis-bind is still live, and it would let a
 * second wrong handset take the slot before anyone has unlinked the first.
 *
 * Returns { allowed, verdict, actual, expected, reason }. Deliberately permissive when it cannot
 * tell: an unreadable/absent bound number (the normal DOWN state - the board reports number:null in
 * exactly the state this feature is used in) and an unknown expected number both resolve to
 * ALLOWED, because refusing there would disable re-linking on every fresh box and on every genuine
 * outage. Only a DEFINITIVE mismatch of two known numbers refuses.
 */
function bindingGate(boundNumber, expectedNumber) {
  const r = classifyRebind(boundNumber, expectedNumber);
  if (r.verdict === 'mismatch') {
    return {
      allowed: false, verdict: r.verdict, actual: r.actual, expected: r.expected,
      reason: `The bidder ${REBOUND_STATE}: live on ${displayMsisdn(r.actual)}, expected ${displayMsisdn(r.expected)}. No re-link code will be given out until it is unlinked.`,
    };
  }
  return { allowed: true, verdict: r.verdict, actual: r.actual, expected: r.expected, reason: null };
}

/**
 * The one gate every QR send passes through. Returns the clean MSISDN, or THROWS.
 *
 * The group-JID branch is checked explicitly even though the MSISDN allowlist below would reject it
 * anyway: it is the rule that actually matters, the error message names it, and a dedicated branch
 * is what makes it independently testable. The bare '@' branch generalises it to every other JID
 * form (@c.us, @broadcast, @newsletter, whatever WhatsApp adds next).
 */
function assertIndividualRecipient(to) {
  const raw = String(to == null ? '' : to).trim();
  if (!raw) throw new Error('qr-relink REFUSED: empty recipient');
  if (isGroupJid(raw)) {
    throw new Error(`qr-relink REFUSED: ${raw} is a WhatsApp GROUP - the QR is a live session credential and never goes to a group`);
  }
  if (raw.indexOf('@') !== -1) {
    throw new Error(`qr-relink REFUSED: ${raw} is a JID, not an individual number`);
  }
  if (!INDIVIDUAL_MSISDN_RE.test(raw)) {
    throw new Error(`qr-relink REFUSED: ${raw} is not a bare individual MSISDN`);
  }
  return raw;
}

/**
 * Normalize a listPhones `status` to a lowercase string, robust to the shapes Maytapi actually
 * returns.
 *
 * This is a deliberate copy of WhatsAppClient.statusOf (src/notify/whatsapp.js), which in turn
 * mirrors verify-whatsapp-setup.js's phoneStatus(). It is copied rather than imported for the same
 * reason GROUP_JID_RE above is: this module is shared with the standalone monitor, which imports
 * nothing from src/ so it keeps alerting when the app is down. Like GROUP_JID_RE, the copy is pinned
 * to the original by a parity test in scripts/test-sender-qr-relink.js that runs both implementations
 * over one shared vector table, so drift shows up as a test failure rather than a silent hole.
 *
 * The object form is not hypothetical: Maytapi has returned `status` as `{state:...}` /
 * `{loggedIn:...}`, which is why two normalizers already existed in this repo and why
 * scripts/test-wa-circuit-breaker.js pins `{state:'loading'} -> down`.
 *
 * ONE DELIBERATE DIVERGENCE FROM whatsapp.js, do not "fix" it: there, an unreadable shape resolving
 * to 'unknown' is treated fail-OPEN, because the worst case is a suppressed alert. Here 'unknown' is
 * fail-CLOSED (see qrEligibleStatus), because the worst case is handing out a pairing credential for
 * a slot whose state we cannot read. Same parse, opposite disposition, on purpose.
 */
function normalizeSlotStatus(status) {
  if (typeof status === 'string') return status.toLowerCase().trim();
  if (status && typeof status === 'object') {
    if (typeof status.state === 'string') return status.state.toLowerCase().trim();
    if (typeof status.status === 'string') return status.status.toLowerCase().trim();
    if (status.loggedIn === true || status.connected === true) return 'active';
  }
  return 'unknown';
}

/**
 * The slot states in which a pairing QR can exist. An ALLOWLIST - the enumerated non-active states
 * this product has been observed in ('active' is the fifth and is excluded by construction).
 * Anything else, including a state Maytapi invents later, is refused.
 */
const QR_ELIGIBLE_STATUSES = Object.freeze(['qr-screen', 'loading', 'idle', 'disabled']);

/**
 * Is this phone in a state where /qrCode means anything?
 *
 * AN ALLOWLIST, which is what the fail-closed posture this function claims actually requires. It was
 * a two-value DENYLIST ('' / 'unknown' / 'active' refused, everything else allowed) built on
 * `String(status)`, and that coerces silently: an object status `{state:'active'}` stringifies to
 * '[object Object]', which is non-empty, is not 'unknown' and is not 'active', so a perfectly healthy
 * sender classified as eligible and this gate - the layer the header calls the load-bearing half of
 * the /screen hazard - contributed nothing.
 *
 * WHAT AN ACTIVE SLOT ACTUALLY RETURNS, live-probed 2026-07-25 against slot 128023 while it was
 * `active` on 918882034647 (read-only, two GETs, recorded here the way the header records /screen):
 *   GET {base}/{productId}/128023/qrCode  ->  HTTP 200, application/json, 53 bytes,
 *   {"success":false,"message":"Could not find qr code."}
 * So /qrCode is genuinely QR-only: it answers an error ENVELOPE for a live session, never a
 * screen-family image, and the catastrophic reading of the coercion bug - a screenshot of BRL's live
 * conversations base64'd into two admin DMs - cannot happen on this endpoint. Note the same
 * 200-with-success:false asymmetry sendQrImage() documents; `res.ok` is true here, so the only thing
 * that refused the body was fetchQr()'s PNG magic-byte check. Defence in depth held, but it held one
 * layer lower than designed, after a wasted live read against BRL's production Maytapi account.
 *
 * The residual defects the allowlist closes are therefore about correctness, not leakage: an object
 * status used to reach the ?img=1 branch, fail the magic-byte check, and return 502 - which the page
 * renders as "Maytapi did not return a QR just now. Retrying in 10s." for the full 15-minute
 * deadline, ~90 pointless reads while telling the operator the exact opposite of the truth about a
 * healthy sender. It now takes the 409 "nothing to re-link" path it always should have.
 *
 * The same board probe recorded the observed status vocabulary: 'active' and 'idle' live, plus
 * 'qr-screen' / 'loading' / 'disabled' named by the existing code in this repo. Those four non-active
 * states are the allowlist; everything else - '', 'unknown', a number, an unreadable object, or a
 * state Maytapi adds next year - fails closed and is diagnosable as a loud 409 rather than a silent
 * pull.
 */
function qrEligibleStatus(status) {
  return QR_ELIGIBLE_STATUSES.indexOf(normalizeSlotStatus(status)) !== -1;
}

/**
 * SP_WA_QR_IN_ALERT - the image PUSH tier only (layer 2). DEFAULT OFF.
 *
 * The on-demand page (layer 1) is NOT behind this knob and stays available: it is a pull, it sits
 * behind the operator session, and it is the path the alert text actually points at.
 *
 * Off by default because of what has and has not been proven about the push leg. The GET side of
 * this module is live-verified end to end. The SEND side has had exactly one live exercise, with a
 * 121-byte 64x64 synthetic PNG - which proves Maytapi accepts the wire shape, and proves nothing
 * about the thing that only shows up end to end: whether a real ~6 KB QR survives WhatsApp's image
 * re-encoding and is still scannable off a phone screen. Until scripts/probe-sender-qr.js has been
 * run against a real logged-out slot and the outcome recorded, a routine deploy must not be able to
 * start pushing pairing credentials into two personal inboxes on its own. Flipping one env var
 * after a successful probe is cheap; discovering during an outage that the pushed image is an
 * unscannable smear is not.
 *
 * Only the explicit tokens 1/true/yes/on enable it. Unset, empty, or anything else -> OFF.
 */
function qrDeliveryEnabled(env) {
  const s = String((env || {}).SP_WA_QR_IN_ALERT == null ? '' : (env || {}).SP_WA_QR_IN_ALERT).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * The individual admin numbers the WA alert tier is aimed at. Since #77 landed this is the SINGLE
 * parser - monitor-wa-sender.js's alertWaSibling() calls it too, so the text tier and the QR tier
 * cannot drift into addressing different people (they each used to carry their own copy, with their
 * own hardcoded default list).
 */
function parseAlertRecipients(env) {
  return String((env || {}).MONITOR_ALERT_TO || DEFAULT_ALERT_TO)
    .split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The caption that rides the DM image, and the shape of every instruction this feature renders.
 *
 * Three things it must always say, in this order, because the expensive mistake is a scan from the
 * wrong handset (see the pairing direction in the header):
 *   1. WHICH handset - the last-known-good MSISDN, spelled out. The slot id ('128023') identifies
 *      nothing to a human, and in the down state the live board reports number:null, so the number
 *      HAS to come from persisted state. When it is genuinely unavailable the caption says so
 *      rather than falling back to a vague "the phone that owns that number".
 *   2. What a wrong scan DOES, in one line, in plain words.
 *   3. That this image may already be dead, and where the always-fresh one is.
 */
function buildQrCaption({ senderPhoneId, expectedNumber, qrUrl } = {}) {
  const warn = buildScanWarning({ expectedNumber, format: 'text' });
  const lines = [`Re-link the BRL bidder WhatsApp sender (Maytapi slot ${senderPhoneId == null ? 'unknown' : senderPhoneId}).`, ''];
  lines.push(warn.handset);
  lines.push(warn.consequence);
  if (!displayMsisdn(expectedNumber)) { lines.push(''); lines.push(NO_BASELINE_WARNING); }
  lines.push('');
  lines.push(warn.steps);
  lines.push('');
  // Freshness, stated as it actually is. The code was fetched at send time, so it is live for
  // roughly its first 20 seconds and dead after that - which is why a burst of these arrives rather
  // than one, and why the always-fresh page is named as the real answer. Promising more than that
  // is what made the earlier caption wrong.
  lines.push('Fetched just now. A QR rotates about every 20 seconds, so this one is only good for a');
  lines.push('few seconds after it lands - if it has already expired, use the link below, do not wait');
  lines.push('for the next image.');
  lines.push('');
  lines.push(qrUrl
    ? `Always-live code (refreshes itself, no expiry to race): ${qrUrl} - operator login required.`
    : 'Always-live code: the Maytapi console. This box has no SP_BASE_URL set, so the self-refreshing in-app page has no address to advertise.');
  return lines.join('\n');
}

/**
 * One word for the healthcheck ping, so the dead-man's-switch service can see the QR tier go dark.
 * Without this the only record of a failed delivery is cron stdout, which nothing reads.
 */
function qrOutcome(out) {
  if (!out) return 'none';
  if (!out.attempted) return 'skipped';
  return out.sent > 0 ? 'sent' : 'failed';
}

/**
 * Run one Maytapi round-trip under a hard wall-clock deadline.
 *
 * WHY THIS EXISTS AT ALL. Both reads below used to be issued bare. That was survivable while they
 * only ran on the monitor's cron path, where a stalled call delays nobody - but createRelinkQrHandler()
 * put them on a SYNCHRONOUS operator request, and Node's undici defaults its headers/body timeouts to
 * the order of minutes. A Maytapi endpoint that accepts the connection and then stalls therefore left
 * the handler awaiting with nothing written, which the page renders as "Loading a live code..."
 * forever: its entire error branching hangs off img.onerror, and an in-flight request never fires
 * onerror. Worse, the 10s refresh kept opening a fresh stalled upstream every tick. And the moment an
 * operator opens this page is exactly the moment a Maytapi slowdown is most likely - the stall
 * correlates with the outage the feature exists for.
 *
 * THE DEADLINE COVERS THE WHOLE OPERATION, not just the call. src/platform/{realAdapter,gocometAdapter}
 * race only the fetch() because they then read a small body off an API that has already answered.
 * Here the body IS the thing that can stall (a ~6 KB PNG dribbled a byte at a time keeps
 * arrayBuffer() pending indefinitely while fetch() itself has long since resolved on headers), so the
 * body read is inside the race too. Otherwise the bound would be decorative on the exact failure it
 * was added for.
 *
 * Shape is deliberately the house one: AbortController + an unref'd setTimeout raced against the
 * work, so it also settles against an injected transport that ignores the signal entirely - which is
 * what every test in this module uses, and what makes "a transport that never resolves" testable.
 */
const MAYTAPI_TIMEOUT_MS = 8000; // same default as the platform adapters' _request()

async function withDeadline(timeoutMs, work) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      if (ac) { try { ac.abort(); } catch (_e) { /* already aborted */ } }
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    // DELIBERATELY NOT unref'd, which is the one place this diverges from the adapters' shape. An
    // unref'd timer does not hold the event loop open, so if the stalled work is the ONLY thing
    // outstanding, Node reaches an empty loop and exits before the deadline can fire - the process
    // dies silently mid-request instead of timing out. A real stalled socket usually keeps the loop
    // alive and hides that, which is exactly why it is worth not relying on. The cost of holding the
    // loop is nil: the finally below clears the timer the instant either leg of the race settles, so
    // it can never outlive the request it bounds.
  });
  try {
    return await Promise.race([work(ac ? ac.signal : undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read the Maytapi phone board. The monitor already does this inline for its own health check; this
 * is the same read for callers that do not have a board in hand (the on-demand page handler).
 * Returns { ok:true, phones } or { ok:false, error } - never throws. Bounded by withDeadline().
 */
async function fetchPhones({ base, productId, token, transport, timeoutMs = MAYTAPI_TIMEOUT_MS } = {}) {
  if (!base || !productId || !token) return { ok: false, error: 'listPhones: missing maytapi creds' };
  const send = transport || (typeof fetch === 'function' ? fetch : null);
  if (!send) return { ok: false, error: 'listPhones: no transport available' };
  const url = `${String(base).replace(/\/$/, '')}/${productId}/listPhones`;
  try {
    return await withDeadline(timeoutMs, async (signal) => {
      const res = await send(url, { headers: { 'x-maytapi-key': token }, signal });
      if (!res || !res.ok) return { ok: false, error: `listPhones http ${res ? res.status : '?'}` };
      let data = null;
      try { data = await res.json(); } catch (_) { return { ok: false, error: 'listPhones: non-JSON body' }; }
      const list = (data && data.data) || data;
      if (!Array.isArray(list)) return { ok: false, error: 'listPhones: unexpected shape' };
      return { ok: true, phones: list };
    });
  } catch (e) {
    return { ok: false, error: `listPhones network: ${e && e.message}` };
  }
}

/**
 * GET the current QR PNG for a phone slot. Returns { ok:true, base64, bytes } or { ok:false, error }
 * - never throws, so a fetch problem can only ever degrade the alert to text-only.
 *
 * The response is validated before it is trusted: HTTP ok, non-empty, under the size cap, and
 * actually PNG-signed. Without the magic-byte check an error envelope or an HTML interstitial would
 * be base64'd and shipped to admins as if it were a QR.
 */
async function fetchQr({ base, productId, phoneId, token, transport, maxBytes = QR_MAX_BYTES, timeoutMs = MAYTAPI_TIMEOUT_MS } = {}) {
  if (!base || !productId || !phoneId || !token) return { ok: false, error: 'qr fetch: missing maytapi creds' };
  const send = transport || (typeof fetch === 'function' ? fetch : null);
  if (!send) return { ok: false, error: 'qr fetch: no transport available' };
  const url = `${String(base).replace(/\/$/, '')}/${productId}/${phoneId}/qrCode`;
  try {
    return await withDeadline(timeoutMs, async (signal) => {
      const res = await send(url, { headers: { 'x-maytapi-key': token }, signal });
      if (!res || !res.ok) return { ok: false, error: `qr fetch http ${res ? res.status : '?'}` };
      let buf;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        return { ok: false, error: `qr fetch body: ${e && e.message}` };
      }
      if (!buf.length) return { ok: false, error: 'qr fetch: empty body' };
      if (buf.length > maxBytes) return { ok: false, error: `qr fetch: ${buf.length} bytes exceeds the ${maxBytes} byte cap` };
      if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        return { ok: false, error: 'qr fetch: body is not a PNG (maytapi answered something other than the QR image)' };
      }
      return { ok: true, base64: buf.toString('base64'), bytes: buf.length };
    });
  } catch (e) {
    return { ok: false, error: `qr fetch network: ${e && e.message}` };
  }
}

/**
 * Send one QR image to ONE individual recipient, from a healthy sibling phone.
 *
 * Wire format is Maytapi's own documented shape for a base64 image, taken from their reference
 * implementation (maytapi-com/whatsapp-api-nodejs-example, the 'media64' case):
 *   { to_number, type: 'image', text: <caption>, message: 'data:image/png;base64,<payload>' }
 * `message` carries the image (URL or data URI), `text` is the caption - the two fields are NOT
 * interchangeable with the text-send shape, where `message` is the body copy.
 *
 * WHAT IS PROVEN, AND WHAT IS NOT. Verified live 2026-07-25 (this exact function, not a
 * re-implementation): one 121-byte 64x64 PNG sent from the healthy sibling 136151 to an admin DM
 * returned HTTP 200 with success:true and msgId 31f17990-880c-11f1-ac1a-cd267bb39ed9, and the image
 * rendered in WhatsApp. That is the same live stamp editText/replyText carry at
 * src/notify/whatsapp.js:214,226, and it settles the question a mocked transport never can: Maytapi
 * accepts this wire shape and delivers it.
 *
 * It does NOT settle the one that only shows up end to end - whether a REAL ~6 KB pairing QR
 * survives WhatsApp's image re-encoding and is still scannable off a phone screen. A 64x64 synthetic
 * PNG proves nothing about that. scripts/probe-sender-qr.js runs the real fetch-and-send chain
 * against a genuinely logged-out slot for exactly this, and until it has been run and its outcome
 * recorded here, the push tier stays off by default (see qrDeliveryEnabled).
 *
 * Throws only from assertIndividualRecipient, and that is intentional: refusing a group recipient
 * must be loud and must happen BEFORE any network call. The caller catches per-recipient so one bad
 * entry in MONITOR_ALERT_TO cannot stop delivery to the valid ones.
 */
async function sendQrImage({ base, productId, via, token, to, base64, caption, transport } = {}) {
  const toNumber = assertIndividualRecipient(to); // refuses groups/JIDs before anything is sent
  if (!base || !productId || !via || !token) return { ok: false, error: 'qr send: missing maytapi creds' };
  if (!base64) return { ok: false, error: 'qr send: no image' };
  const send = transport || (typeof fetch === 'function' ? fetch : null);
  if (!send) return { ok: false, error: 'qr send: no transport available' };
  const url = `${String(base).replace(/\/$/, '')}/${productId}/${via}/sendMessage`;
  let res;
  try {
    res = await send(url, {
      method: 'POST',
      headers: { 'x-maytapi-key': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to_number: toNumber,
        type: 'image',
        text: String(caption == null ? '' : caption),
        message: `data:image/png;base64,${base64}`,
      }),
    });
  } catch (e) {
    return { ok: false, error: `qr send network: ${e && e.message}` };
  }
  if (!res || !res.ok) return { ok: false, error: `qr send http ${res ? res.status : '?'}` };
  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON body */ }
  // Same asymmetry as the app's transport: Maytapi answers 200 with success:false for a
  // disabled/loading phone, so HTTP status alone would swallow the failure.
  if (!data || data.success !== true) {
    return { ok: false, error: (data && (data.message || data.error)) || 'qr send: maytapi success=false' };
  }
  return { ok: true, messageId: (data.data && (data.data.msgId || data.data.messageId)) || null };
}

/**
 * The whole accelerator, as one call the monitor can make on the alert path.
 *
 * NEVER THROWS and never rejects. Every gate that stops delivery records a `reason` and returns; the
 * caller logs it and the operator still has the text alert that was already sent. Ordering at the
 * call site matters as much as anything in here: this runs AFTER the alert tiers have fired, so the
 * QR fetch cannot add latency to the alert itself.
 *
 * Returns { attempted, fetched, sent, refused, failed, bytes, reason }.
 */
async function deliverQrRelink({
  base, productId, token, senderPhoneId, senderStatus, via, recipients,
  enabled = false, transport, caption, expectedNumber, boundNumber = null, qrUrl, log = () => {},
} = {}) {
  const out = { attempted: false, fetched: false, sent: 0, refused: 0, failed: 0, bytes: 0, reason: null };
  try {
    if (!enabled) { out.reason = 'push tier is off (SP_WA_QR_IN_ALERT)'; return out; }
    // The healthy-sender gate. A live session has no QR to show, and see the /screen hazard note.
    if (!qrEligibleStatus(senderStatus)) {
      out.reason = `sender status ${senderStatus == null ? 'unreadable' : senderStatus} is not QR-eligible`;
      return out;
    }
    // The binding gate. Never push a second pairing credential for a slot already captured by an
    // unexpected account - see bindingGate(). Ordered AFTER the status gate and BEFORE any fetch or
    // send, so a refusal costs zero Maytapi reads.
    const bind = bindingGate(boundNumber, expectedNumber);
    if (!bind.allowed) { out.reason = bind.reason; log(`[monitor] qr-relink REFUSED: ${bind.reason}`); return out; }
    if (!via) { out.reason = 'no active sibling phone to send the QR from'; return out; }
    const list = (Array.isArray(recipients) ? recipients : []).filter((r) => r != null && String(r).trim() !== '');
    if (!list.length) { out.reason = 'no alert recipients configured'; return out; }

    out.attempted = true;
    const qr = await fetchQr({ base, productId, phoneId: senderPhoneId, token, transport });
    if (!qr.ok) { out.reason = qr.error; return out; } // degrade to the text-only alert already sent
    out.fetched = true;
    out.bytes = qr.bytes;

    const text = caption == null
      ? buildQrCaption({ senderPhoneId, expectedNumber, qrUrl })
      : String(caption);

    for (const to of list) {
      try {
        const r = await sendQrImage({ base, productId, via, token, to, base64: qr.base64, caption: text, transport });
        if (r.ok) { out.sent += 1; } else { out.failed += 1; log(`[monitor] qr-relink send failed: ${r.error}`); }
      } catch (e) {
        // assertIndividualRecipient threw - a group JID or another non-individual recipient. Refuse
        // this one loudly and keep going for the valid recipients.
        out.refused += 1;
        log(`[monitor] ${e && e.message}`);
      }
    }
    return out;
  } catch (e) {
    out.reason = `qr-relink failed: ${e && e.message}`;
    return out;
  }
}

/**
 * A value safe to embed as a literal inside an inline <script> block.
 *
 * JSON.stringify alone is NOT enough here and the difference is a live XSS: it happily emits the
 * characters `</script>` inside the string, which the HTML parser sees before any JS parser does -
 * it closes the block and everything after it is markup again. So the three characters that can
 * start a tag or an entity are escaped to \u form (harmless inside a JS string, inert to the HTML
 * parser), plus U+2028/U+2029, which are literal line terminators in JS source.
 */
function jsLiteral(v) {
  return JSON.stringify(String(v == null ? '' : v))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    // U+2028/U+2029 are literal line terminators in JS source but not in JSON.
    .replace(new RegExp('[\\u2028\\u2029]', 'g'), (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The on-demand page (delivery layer 1). Deliberately tiny and self-contained - no build step, no
 * assets, no framework - because it is opened during an outage, possibly on a phone, possibly on a
 * bad connection.
 *
 * The image is NOT inlined. It points back at this same route with ?img=1 and a cache-buster, and a
 * timer re-points it every QR_PAGE_REFRESH_MS, so what is on screen is always a QR fetched seconds
 * ago rather than one fetched when the page loaded. That is the entire reason this layer exists: a
 * ~20s artifact cannot be delivered by a push on a cooldown measured in tens of minutes.
 *
 * Every interpolated value (status, slot id, MSISDN) comes off Maytapi or config and is escaped -
 * this renders raw HTML, so it is treated as untrusted regardless of how unlikely a hostile value is.
 */
function renderRelinkQrPage({
  senderPhoneId, senderStatus, expectedNumber,
  refreshMs = QR_PAGE_REFRESH_MS, maxAgeMs = QR_PAGE_MAX_AGE_MS, imgPath = RELINK_QR_PATH,
} = {}) {
  const warn = buildScanWarning({ expectedNumber, format: 'html' });
  const slot = escapeHtml(senderPhoneId == null ? 'unknown' : senderPhoneId);
  const src = `${escapeHtml(imgPath)}?img=1&amp;t=0`;
  const secs = Math.round(refreshMs / 1000);
  const mins = Math.max(1, Math.round(maxAgeMs / 60000));
  const noBaseline = displayMsisdn(expectedNumber)
    ? ''
    : `<p style="margin:8px 0 0"><strong>${escapeHtml(NO_BASELINE_WARNING)}</strong></p>`;
  // The client script. Written against the THREE outcomes an operator actually needs to tell apart,
  // because a bare <img> renders all of them as the same broken icon: the re-link SUCCEEDING (the
  // slot flips active, the fail-closed gate answers 409), the session expiring (401), and Maytapi
  // failing (502). The success case is the dangerous one to leave ambiguous - a broken icon after a
  // scan that WORKED reads as "that failed", and the natural next move is to rescan or hand the
  // phone to someone else, which is precisely how a scan lands on the wrong handset.
  //
  // A broken <img> carries no status code, so onerror re-fetches the SAME url with fetch() to read
  // the JSON the server actually sent, and branches on it. The loop is bounded on both axes the
  // review asked for: a wall-clock deadline (an abandoned tab was otherwise ~17k Maytapi reads/day,
  // against the same account the monitor and the bidder's customer sends share) and a
  // document.hidden pause, so a backgrounded tab costs nothing.
  // The client watchdog's patience. Twice the refresh interval: long enough that an ordinary slow
  // load is never mislabelled, short enough that the operator is told something inside one extra
  // tick. The server bounds its own Maytapi calls at MAYTAPI_TIMEOUT_MS and turns a stall into a
  // 502, so this only has to cover the leg the server cannot see - a request that never completes
  // between the phone and nginx.
  const watchMs = Number(refreshMs) * 2;
  const watchSecs = Math.round(watchMs / 1000);
  const script = `(function(){
var img=document.getElementById('qr'),st=document.getElementById('st'),lo=document.getElementById('lo'),tid=null;
var deadline=Date.now()+${Number(maxAgeMs)},P=${jsLiteral(imgPath)},SLOT=${jsLiteral(senderPhoneId == null ? 'unknown' : senderPhoneId)};
// pending/watch are the "hung upstream" fix. Every terminal and retry state below hangs off
// img.onerror, and an in-flight request NEVER fires onerror - so a Maytapi stall used to render as
// 'Loading a live code...' forever while this timer opened a fresh stalled request every tick, up to
// ~90 of them against the same account the monitor and the bidder's customer sends share. Two rules
// now: never point img.src at a second request while one is still outstanding, and never let an
// outstanding one go unanswered for longer than the watchdog.
var pending=false,watch=null;
function say(m){st.textContent=m;}
function clearWatch(){if(watch){clearTimeout(watch);watch=null;}}
function settled(){if(!pending)return false;pending=false;clearWatch();return true;}
function stop(m){if(tid){clearInterval(tid);tid=null;}clearWatch();pending=false;say(m);}
function url(){return P+'?img=1&t='+Date.now();}
img.style.display='none';
img.onload=function(){if(!settled())return;img.style.display='';say('Live code, refreshed just now. Scan it from the handset named above.');};
img.onerror=function(){
// A late callback from a load the watchdog already gave up on - settled() is false, so ignore it
// rather than firing a second probe against an endpoint we have already decided is not answering.
if(!settled())return;
fetch(url(),{headers:{accept:'application/json'},credentials:'same-origin'}).then(function(r){
return r.json().catch(function(){return {};}).then(function(b){return {s:r.status,b:b||{}};});
}).then(function(o){
if(o.s===409&&String(o.b.status||'').toLowerCase()==='active'){img.style.display='none';
stop('Re-linked. Slot '+SLOT+' is active on '+(o.b.number||'the sender number')+'. Nothing more to do - you can close this page.');return;}
if(o.s===401){img.style.display='none';lo.hidden=false;stop('Your operator session expired, so no QR can be served. Log in again, then reopen this page.');return;}
if(o.s===423){img.style.display='none';stop(o.b.error||'The slot is bound to an unexpected number, so no QR is served. Unlink it first.');return;}
if(o.s===502){say('Maytapi did not return a QR just now. Retrying in ${secs}s.');return;}
if(o.s===503){img.style.display='none';stop(o.b.error||'WhatsApp is not configured on this instance.');return;}
say('No QR right now (HTTP '+o.s+'). Retrying in ${secs}s.');
}).catch(function(){say('Could not reach the server. Retrying in ${secs}s.');});
};
function refresh(){if(document.hidden)return;
if(Date.now()>deadline){img.style.display='none';stop('Stopped refreshing after ${mins} minutes. Reload this page if you still need a code.');return;}
if(pending)return;
pending=true;
watch=setTimeout(function(){
if(!pending)return;
pending=false;watch=null;
// Abandon the stalled request rather than leaving it open. Dropping src cancels the browser's
// in-flight fetch, which is the whole point - otherwise the connections accumulate.
img.removeAttribute('src');img.style.display='none';
say('Maytapi is not answering - nothing came back in ${watchSecs}s. Still retrying; if this keeps up, use the Maytapi console.');
},${watchMs});
img.src=url();}
refresh();tid=setInterval(refresh,${Number(refreshMs)});
document.addEventListener('visibilitychange',function(){if(!document.hidden&&tid)refresh();});
}());`;
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Re-link WhatsApp sender ${slot}</title>`,
    '<style>',
    'body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;background:#111;color:#eee;text-align:center}',
    'h1{font-size:20px;margin:0 0 16px}',
    '.warn{background:#3a1d1d;border:1px solid #a33;border-radius:8px;padding:12px 14px;margin:0 auto 20px;max-width:520px;text-align:left}',
    // image-rendering:pixelated - a QR is a grid of hard-edged modules, and this box is
    // min(80vw,320px), i.e. ~288px on a 360px phone. Default smooth upscaling softens the module
    // edges, and a soft QR is the failure that looks like success: it photographs fine and simply
    // will not scan, which sends the operator down the rescan / hand-the-phone-to-someone-else path
    // the module header calls the one expensive mistake. Nearest-neighbour keeps the edges square.
    'img{width:min(80vw,320px);height:auto;background:#fff;padding:12px;border-radius:8px;image-rendering:pixelated}',
    'p{max-width:520px;margin:14px auto}',
    'code{background:#222;padding:2px 6px;border-radius:4px}',
    '.meta{color:#999;font-size:13px}',
    '#st{min-height:1.5em;font-weight:600}',
    // The dark theme was carried through every element EXCEPT the one interactive control. The single
    // anchor was inheriting the UA default #0000EE (#551A8B once visited) against #111 - 2.0:1 and
    // 1.7:1, against the 4.5:1 WCAG 2.2 SC 1.4.3 requires. It is revealed only in the 401 state, so
    // the one moment it is on screen is when an operator's session has died mid-outage and this is
    // their sole route back, one-handed, on a phone, possibly outdoors. #7cc4ff is ~10:1 on #111 and
    // #c8a2ff ~7:1. The underline stays, so the link is never identified by colour alone, and the
    // focus ring is restated because the UA default is tuned for light backgrounds.
    'a{color:#7cc4ff}',
    'a:visited{color:#c8a2ff}',
    'a:focus-visible{outline:2px solid #7cc4ff;outline-offset:2px}',
    '</style>',
    `<noscript><meta http-equiv="refresh" content="${secs}"></noscript>`,
    '</head><body>',
    '<h1>Re-link the BRL bidder WhatsApp sender</h1>',
    `<div class="warn"><p style="margin:0 0 8px">${warn.handset}</p>`,
    `<p style="margin:0">${warn.consequence}</p>${noBaseline}</div>`,
    `<img id="qr" alt="live WhatsApp pairing QR for slot ${slot}" src="${src}">`,
    // The one region that tells the operator which of the four outcomes they are looking at. Live
    // for screen readers too: this page is opened one-handed during an outage, often on a phone.
    '<p id="st" role="status" aria-live="polite">Loading a live code...</p>',
    '<p id="lo" hidden><a href="/">Log in to the console</a>, then reopen this page.</p>',
    `<p>${warn.steps}</p>`,
    `<p class="meta">Slot <code>${slot}</code>, status <code>${escapeHtml(senderStatus == null ? 'unreadable' : senderStatus)}</code>. A fresh QR is pulled every ${secs} seconds for up to ${mins} minutes; the line above says whether the code on screen is live.</p>`,
    '<script>',
    script,
    '</script>',
    '</body></html>',
  ].join('\n');
}

/**
 * GET /api/wa/relink-qr - delivery layer 1, the primary path.
 *
 * Returns an express-style handler. Mounted in src/web/server.js AFTER the operator-session gate
 * that every other /api route sits behind, so it inherits exactly the same auth with no second
 * implementation to keep in sync. It lives in this module rather than in src/ so the eligibility
 * gate, the /qrCode read and the wrong-handset warning have ONE implementation shared with the
 * monitor - a second copy of the "/screen is not /qrCode" reasoning is precisely the drift this
 * codebase has been bitten by before.
 *
 * Two responses off one route:
 *   ?img=1  -> the raw PNG, fetched fresh on this request.
 *   default -> the self-refreshing page whose <img> hits ?img=1.
 *
 * Both are Cache-Control: no-store. A pairing credential must not sit in a browser cache, a proxy,
 * or the back/forward cache after the operator closes the tab.
 *
 * THE ELIGIBILITY GATE APPLIES TO BOTH. A healthy sender gets 409 and no Maytapi read of any kind -
 * same fail-closed rule deliverQrRelink() enforces, for the same /screen reason: nothing in the HTTP
 * response distinguishes a QR from a screenshot of BRL's live conversations, so the only safe
 * discriminator is proving the slot is logged out BEFORE reading anything.
 */
function createRelinkQrHandler({
  creds, senderNumberProvider, currentAdmin, onQrServed, transport,
  refreshMs = QR_PAGE_REFRESH_MS, maxAgeMs = QR_PAGE_MAX_AGE_MS,
  timeoutMs = MAYTAPI_TIMEOUT_MS, now = Date.now, log = () => {},
} = {}) {
  // Per-actor audit throttle state, closed over one handler instance. See QR_AUDIT_THROTTLE_MS.
  const lastAudit = new Map();
  return async function relinkQrHandler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // SECOND, INDEPENDENT AUTH CHECK. The route is mounted below the app's /api session gate and
    // inherits it, but this endpoint hands out a live PAIRING credential - the one asset whose
    // leak is an identity takeover rather than a data read - so it does not delegate 100% of its
    // authentication to a middleware ordering it cannot see. If the gate is ever reordered, split,
    // or has a route block inserted above it, this still fails closed.
    //
    // FAIL-CLOSED ON MISCONFIGURATION TOO: a handler constructed with no currentAdmin resolver
    // refuses everything. An absent resolver means the caller forgot to wire auth, and the safe
    // reading of "I cannot tell who this is" is never "serve them the QR".
    let admin = null;
    try { admin = typeof currentAdmin === 'function' ? currentAdmin(req) : null; } catch (_) { admin = null; }
    if (!admin) {
      log('[relink-qr] refused: no operator session on the request');
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const c = creds || {};
    const base = c.endpoint || c.base;
    const phoneId = c.phoneId == null ? null : String(c.phoneId);
    if (!base || !c.productId || !phoneId || !c.token) {
      return res.status(503).json({ error: 'WhatsApp is not configured on this instance - no sender slot to re-link.' });
    }
    const board = await fetchPhones({ base, productId: c.productId, token: c.token, transport, timeoutMs });
    if (!board.ok) return res.status(502).json({ error: board.error });
    const me = board.phones.find((p) => String(p.id) === phoneId) || null;
    const status = me ? me.status : null;
    // The binding gate runs FIRST, ahead of the status gate, because a captured slot reads 'active'
    // and would otherwise fall out through the ordinary "nothing to re-link" 409 - a reassuring
    // message for the single most alarming state this system has. Distinct status (423 Locked) and
    // a distinct body, so an operator refreshing the page during an incident is told what actually
    // happened and what to do, instead of "the sender is fine".
    let expectedForGate = null;
    try { expectedForGate = senderNumberProvider ? await senderNumberProvider() : null; } catch (_) { expectedForGate = null; }
    const bind = bindingGate(me ? me.number : null, expectedForGate);
    if (!bind.allowed) {
      log(`[relink-qr] ${bind.reason}`);
      return res.status(423).json({
        phoneId, status: status == null ? null : String(status),
        state: REBOUND_STATE,
        boundTo: displayMsisdn(bind.actual), expected: displayMsisdn(bind.expected),
        error: `The bidder ${REBOUND_STATE}. It is live on ${displayMsisdn(bind.actual)}, not ${displayMsisdn(bind.expected)}. No re-link code is shown here, because another scan would hand the bidder to a second wrong phone. First, on ${displayMsisdn(bind.actual)}: WhatsApp > Linked Devices > remove the link. Then re-link from ${displayMsisdn(bind.expected)}.`,
      });
    }
    if (!qrEligibleStatus(status)) {
      // The healthy case is the common one and is NOT an error the operator caused - say what the
      // slot is actually doing rather than a bare 409.
      //
      // `number` is in the body on purpose: after a SUCCESSFUL re-link this exact 409 is what the
      // open page's next poll receives, and it is the only signal the page has that the operator
      // just succeeded. Without the number the page can say "re-linked" but cannot say WHICH
      // handset it re-linked to - which is the one fact worth confirming right after a scan.
      // Normalized, not String()-coerced: the raw value can be an object, and the naive compare here
      // had the same silent-coercion bug qrEligibleStatus() did - a healthy `{state:'active'}` slot
      // would have been described to the operator as "status could not be read as logged-out".
      const active = !!me && normalizeSlotStatus(status) === 'active';
      return res.status(409).json({
        phoneId,
        status: status == null ? null : String(status),
        number: me && me.number != null ? displayMsisdn(me.number) : null,
        error: active
          ? `Sender ${phoneId} is active - there is no QR to scan and nothing to re-link.`
          : `Sender ${phoneId} status could not be read as logged-out, so no QR is served (fail-closed).`,
      });
    }
    const expectedNumber = expectedForGate; // already read for the binding gate; do not read twice

    if (req && req.query && req.query.img) {
      const qr = await fetchQr({ base, productId: c.productId, phoneId, token: c.token, transport });
      if (!qr.ok) { log(`[relink-qr] ${qr.error}`); return res.status(502).json({ error: qr.error }); }
      // The audit record for the one action in this app whose abuse is an identity takeover. Every
      // less sensitive privileged action here already carries actor + ip; a served pairing
      // credential wrote nothing at all, so after a wrong-handset incident there was no on-box
      // evidence of when a QR went out, to whom, or how often. Throttled (see QR_AUDIT_THROTTLE_MS)
      // but never silent: the suppressed count keeps the record honest about the real serve rate.
      if (typeof onQrServed === 'function') {
        const actor = (admin && admin.user) || 'unknown';
        const t = now();
        const prev = lastAudit.get(actor);
        if (!prev || (t - prev.at) >= QR_AUDIT_THROTTLE_MS) {
          lastAudit.set(actor, { at: t, suppressed: 0 });
          try {
            onQrServed({ phoneId, actor, ip: (req && req.ip) || null, bytes: qr.bytes, suppressed: prev ? prev.suppressed : 0 });
          } catch (e) { log(`[relink-qr] audit hook failed: ${e && e.message}`); }
        } else {
          prev.suppressed += 1;
        }
      }
      res.setHeader('Content-Type', 'image/png');
      return res.send(Buffer.from(qr.base64, 'base64'));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderRelinkQrPage({ senderPhoneId: phoneId, senderStatus: status, expectedNumber, refreshMs, maxAgeMs }));
  };
}

module.exports = {
  isGroupJid, assertIndividualRecipient, qrEligibleStatus, normalizeSlotStatus, qrDeliveryEnabled,
  loadEnv, APP_DIR, MAYTAPI_TIMEOUT_MS, QR_ELIGIBLE_STATUSES,
  parseAlertRecipients, fetchQr, fetchPhones, sendQrImage, deliverQrRelink,
  displayMsisdn, relinkQrUrl, expectedSenderNumber, knownBrlNumbers,
  monitorStateFile, staffRosterFile,
  observedSenderNumber, readLastKnownNumber, classifyRebind, bindingGate,
  buildQrCaption, buildScanWarning, qrOutcome, renderRelinkQrPage, createRelinkQrHandler,
  GROUP_JID_RE, INDIVIDUAL_MSISDN_RE, QR_MAX_BYTES, DEFAULT_ALERT_TO,
  RELINK_QR_PATH, QR_PAGE_REFRESH_MS, QR_PAGE_MAX_AGE_MS, QR_AUDIT_THROTTLE_MS,
  REBOUND_STATE, NO_BASELINE_WARNING,
};
