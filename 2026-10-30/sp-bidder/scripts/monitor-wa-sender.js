'use strict';
/**
 * WhatsApp sender health monitor - the guard that turns a silent notification outage into a
 * heads-up in minutes. On 2026-07-15 the Maytapi sender (phoneId 128023) got logged out of
 * WhatsApp (status active -> qr-screen); Maytapi kept returning success:true on every send but
 * the dead session delivered nothing, and it was only noticed by absence hours later.
 *
 * Standalone by design: needs only Node 18 global fetch + fs, reads creds straight from the app
 * .env, keeps its own state file. It does NOT import the app, so it still runs and alerts even
 * when bid-command itself is down. Meant to run from cron every few minutes.
 *
 * DELIVERY TIERS (defense in depth - an alert must NOT depend on the thing that's failing). These
 * are how the MONITOR reaches a human; they are NOT group senders and there is no sender rotation:
 *   - EMAIL via Brevo   -> fully independent of Maytapi/WhatsApp; delivers even if all of WhatsApp
 *                          is down. This is the real backstop.
 *   - SIBLING WhatsApp  -> a DIFFERENT active Maytapi phone (never the down sender) sends a WA
 *                          ping; fast, but Maytapi-dependent, so it co-fails with the sender.
 *   - TELEGRAM          -> optional third, also Maytapi-independent.
 *   - HEALTHCHECK ping  -> the monitor pings a dead-man's-switch (healthchecks.io) every run. If
 *                          the BOX or cron itself dies, the pings STOP and that external service
 *                          alerts you - the one failure an on-box monitor can never self-report.
 *
 * ALERT CADENCE (three-way, so a non-emergency outage never spams). The FIRST heads-up on a
 * genuine outage always fires once past the grace window, day or night - you are told promptly.
 * Only the RE-fire while still-down is throttled, and how fast depends on whether the alert can
 * still reach anyone at all:
 *   - the sender is down AND NO delivery tier can reach a human (no active WA sibling, and no
 *     independent backstop configured) AND it is OFFICE HOURS (06:00-20:00 IST) -> URGENT: re-fire
 *     every MONITOR_COOLDOWN_MIN (default 30m). This is the real emergency: notifications are dark,
 *     nothing is getting through, and people are at their desks to act on it.
 *   - all tiers down but OUTSIDE office hours -> QUIET: re-fire only every MONITOR_QUIET_COOLDOWN_MIN
 *     (default 360m). Still dark, but a 2am flood helps no one; you get an occasional reminder.
 *   - a delivery tier STILL WORKS (an active WA sibling, or email/telegram configured) -> QUIET
 *     regardless of hour. The alert IS reaching someone, so this is NOT an emergency; a repeated
 *     urgent flag here is pure noise (the case that motivated this: primary 128023 out overnight
 *     while the sibling session + email kept delivering the heads-up).
 * A total Maytapi-API outage (listPhones unreachable) still counts email/telegram as up if
 * configured - those tiers do not depend on Maytapi. It is "all tiers down" only when even the
 * independent backstops are absent.
 *
 * Office hours use the SAME IST convention the daily heartbeat uses (src/notify/dailyTask.js): a
 * fixed +05:30 offset (IST has no DST, so the offset is exact), read off getUTCHours() of the
 * shifted instant. It is inlined here rather than required from the app on purpose - this monitor
 * must keep running even when bid-command is down, so it imports nothing from src/.
 *
 * QUEUE-BACKLOG WATCH: each run also reads the product-level Maytapi queue (GET /{product}/queues)
 * and alerts when ANY non-active phone has messages queued (the queue>0-on-idle signal). Maytapi
 * accept-and-queues every send to a logged-out/idle session and floods the whole backlog at its
 * recipients the instant that phone re-links - on 2026-07-24/25 the group sender sat idle with 17
 * queued customer-group summaries and nothing was watching, so it was invisible until re-link risk.
 * Told once on detection (day or night - an armed flush is worth knowing), then re-fired only at the
 * quiet cadence so a backlog that sits for hours never spams. See queueOffenders / decideQueueAlert;
 * the endpoint choice (product /queues, not the ambiguous per-phone stats.sending) is argued there.
 *
 * RE-LINK ACCELERATOR: the down-alert also carries the way to FIX the outage, because recovery is a
 * physical act (someone holding the sender handset scans a pairing QR) and the QR used to live only
 * behind the Maytapi web console. Three layers, in scripts/lib/sender-qr.js:
 *   1. PRIMARY  - an on-demand page on the app (GET /api/wa/relink-qr, behind the operator session)
 *                 that re-pulls a fresh QR every 10s. Its URL rides the alert TEXT, so it costs
 *                 nothing and cannot go stale. This is the layer that actually works.
 *   2. OPT-IN   - the QR pushed as an IMAGE to the individual admin numbers (SP_WA_QR_IN_ALERT=1,
 *                 default OFF - see qrDeliveryEnabled). Because a fetched QR rotates in ~20s while
 *                 the re-alert cadence is tens of minutes, a single push on the alert tick is
 *                 usually dead on arrival; decideQrBurst() below therefore re-sends it on a SHORT,
 *                 BOUNDED cadence for the first few minutes after each full down-alert.
 *   3. FALLBACK - the Maytapi console, written up in docs/NOTIFICATIONS.md, which is what covers the
 *                 app being down at the same time as the sender. The alert names it only when there
 *                 is no in-app page to point at (SP_BASE_URL unset), because otherwise it is a
 *                 second route offered to someone who has not yet tried the first.
 *
 * RE-BIND CHECK: 'active' is not the same as 'ours'. Maytapi's instance for a slot is the COMPANION
 * device - it displays the QR and the PRIMARY phone scans it - so a re-link QR scanned on the WRONG
 * handset re-points this slot at THAT phone's WhatsApp account. The slot then reads active with a
 * non-null number, i.e. indistinguishable from recovery to any null check; only a COMPARISON can
 * catch it. So the number observed while healthy is persisted (state.lastKnownNumber) and compared
 * on the way back up.
 *
 * A MOVE IS NOT AN INCIDENT. BRL runs several handsets on one Maytapi product and moves the sender
 * between them, so "the number changed" and "the slot was captured" are different events and used to
 * share one urgent alarm. They are split on membership now (knownBrlNumbers): a move to one of BRL's
 * own numbers is a one-line email notice and the new number is adopted, so it is said once; a move to
 * anything else keeps the full alarm on every tier at the urgent cadence, is never adopted, and the
 * QR tier refuses to serve or push a pairing code while it stands.
 *
 * env (SP_MAYTAPI_* the app already sets; the rest are opt-in - a channel with no config no-ops):
 *   MONITOR_EMAIL_TO         comma emails, primary/To (default siddharth.rodrigues@bestroadways.com,sushant.govinde@bestroadways.com,sg@bestroadways.com)
 *   MONITOR_EMAIL_BCC        comma emails, Bcc (default dorddis@gmail.com) - dorddis parked here while
 *                            the BRL address settles in as the primary recipient
 *   BREVO_API_KEY            Brevo (sendinblue) transactional key -> enables the email tier
 *   BREVO_SENDER             verified Brevo sender email (default alerts@ ... set to your verified one)
 *   MONITOR_ALERT_TO         comma phones for the WA sibling alert (default 919356252711,919594937777)
 *   MONITOR_ALERT_VIA_PHONE  sibling phoneId to send FROM (default: auto-pick first active sibling).
 *                            Verified active + dialable before use; a down/unknown pin falls back to auto-pick.
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   optional third tier
 *   HEALTHCHECK_URL          dead-man's-switch ping URL (healthchecks.io etc.)
 *   MONITOR_COOLDOWN_MIN     URGENT re-alert interval (all tiers down, office hours) (default 30)
 *   MONITOR_QUIET_COOLDOWN_MIN  QUIET re-alert interval (off-hours OR a tier still delivers) (default 360)
 *   MONITOR_GRACE_MIN        must stay non-active this long before alerting (default 6) - rides out transient loading/qr-screen
 *   MONITOR_STATE_FILE       state path (default <app>/data/monitor-wa-state.json)
 *   SP_WA_QR_IN_ALERT        push the live re-link QR as an IMAGE to the individual MONITOR_ALERT_TO
 *                            numbers. DEFAULT OFF - 1/true/yes/on enables. Never reaches a group;
 *                            that is enforced structurally in scripts/lib/sender-qr.js.
 *   MONITOR_QR_REFRESH_MIN   inside a burst, minimum minutes between QR pushes (default 2). The real
 *                            floor is the cron interval - this cannot make the monitor run faster.
 *   MONITOR_QR_BURST_MIN     how long a burst stays open after a full down-alert (default 20)
 *   MONITOR_QR_BURST_MAX     hard cap on QR pushes per burst (default 6) - the count bound, so a
 *                            stuck clock or a mangled timestamp can never turn this into a loop
 *   SP_BASE_URL              the app's public base (already set for the /price links). The alert
 *                            links the always-fresh on-demand QR page with it; unset -> the alert
 *                            names the Maytapi console instead.
 *   SP_STAFF_ROSTER_FILE     staff allowlist path (default <app>/data/staffRoster.json). Read for the
 *                            "is this number ours" test - see knownBrlNumbers(). The app already
 *                            maintains this file for the daily group tripwire; the monitor only
 *                            reads it, and a missing one just narrows the set (which alarms MORE,
 *                            never less).
 *
 * SP_MAYTAPI_SENDER_NUMBER IS GONE. It declared one owning MSISDN and outranked the observation. The
 * question it answered was the wrong one: BRL moves the sender between its own handsets, so "is this
 * THE number" alarms on every legitimate swap and its only remedy is to re-type the declaration. On
 * 2026-09-22 a correct re-link back to BRL's original handset produced 35 hours of urgent alarms on
 * three tiers naming that handset as an intruder, because the declaration still held the number of
 * the handset used during the previous week's outage. The membership test replaces it.
 */
const fs = require('fs');
// QR re-link accelerator. Its own module so this file's diff stays small and the logic is
// unit-testable without a network. Still honours the standalone promise above - scripts/-local,
// zero dependencies, imports nothing from src/, so the monitor keeps alerting when the app is down.
const {
  deliverQrRelink, qrDeliveryEnabled, parseAlertRecipients, buildScanWarning, loadEnv, APP_DIR,
  classifyRebind, expectedSenderNumber, knownBrlNumbers, monitorStateFile, staffRosterFile,
  displayMsisdn, relinkQrUrl, qrOutcome,
  REBOUND_STATE, NO_BASELINE_WARNING,
} = require('./lib/sender-qr');

// The app dir and the .env parser both come from the shared lib - see loadEnv() there. They used to
// be hand-copied here and again in probe-sender-qr.js, byte-identical, in the same change that
// created scripts/lib/ specifically to stop that.
const APP = APP_DIR;

const DEFAULT_EMAILS = 'siddharth.rodrigues@bestroadways.com,sushant.govinde@bestroadways.com,sg@bestroadways.com';
const DEFAULT_BCC_EMAILS = 'dorddis@gmail.com';

// ---- office-hours (IST) ------------------------------------------------------------------
// The SAME IST convention as src/notify/dailyTask.js: a fixed +05:30 offset (IST has no DST, so
// the offset is exact), read off getUTCHours() of the shifted instant. Inlined, not required from
// the app, so the standalone-monitor promise (imports nothing from src/) holds even when the app
// is down. Office window is [06:00, 20:00) IST: 6am counts as open, 8pm (20:00) counts as closed -
// the closing hour is the boundary at which desks are no longer watching.
const IST_OFFSET_MS = (5 * 60 + 30) * 60000; // UTC+05:30, fixed - IST has no DST
const OFFICE_START_HOUR = 6;   // 06:00 IST - office opens (inclusive)
const OFFICE_END_HOUR = 20;    // 20:00 IST - office closes (exclusive)

function istHour(ms) {
  return new Date(ms + IST_OFFSET_MS).getUTCHours();
}
function inOfficeHours(ms) {
  const h = istHour(ms);
  return h >= OFFICE_START_HOUR && h < OFFICE_END_HOUR;
}

// ---- human-readable time (alert copy only) -----------------------------------------------
// These exist because an alert is read on a phone, mid-outage, by someone who has to act. The
// down-alerts used to print the raw ISO instant off the state file ("since
// 2026-08-06T10:10:02.866Z") - a UTC timestamp, so it read 5.5 hours off the clock of the very
// person holding the sender handset, and it buried the one fact that matters (when did this
// start) in 24 characters of machine format. Same IST convention as the office-hours block above.
const IST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-08-06T10:10:02.866Z' -> '06 Aug, 15:40 IST'. Unparseable input falls back to the raw value. */
function istStamp(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const d = new Date(ms + IST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${IST_MONTHS[d.getUTCMonth()]}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} IST`;
}

/** 14 -> '14m'; 194 -> '3h 14m'. A multi-hour outage printed as '~194m' makes the reader do arithmetic. */
function humanDuration(min) {
  if (!Number.isFinite(min) || min < 1) return 'under a minute';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ---- down-alert copy (pure) --------------------------------------------------------------
/**
 * The re-link instruction, in the shortest form that is still complete FOR THE SURFACE IT POINTS AT.
 *
 * The link is the action, and on a configured box it is very nearly the whole message: the page it
 * opens renders the wrong-handset warning in a red block ABOVE the QR (renderRelinkQrPage), from the
 * same buildScanWarning() source, so restating it here only teaches the reader to skim the red block
 * as something already read. The numbered procedure and the console fallback are the runbook's -
 * docs/NOTIFICATIONS.md, "When the sender logs out". A procedure nobody finishes reading is not one.
 *
 * Four states, not two, and the two that are easy to miss are why this is a named function rather
 * than a ternary. The pointer must not promise a NAME the page cannot supply: with no baseline the
 * page says to confirm the handset in the console, which is a different instruction, and pointing at
 * "the handset the page names" sends the reader looking for something that is not there.
 *
 * And with no page configured there is NO downstream surface at all - the QR image push is off by
 * default (qrDeliveryEnabled), so the page and the caption are both absent. That branch therefore
 * says everything: which handset, what a wrong scan does, the menu path, and - when there is nothing
 * on record - that the wrong-handset alarm cannot fire at all. It is the one case where the long form
 * IS the short answer, and it is longer than the line budget on purpose.
 *
 * The two-credential-prompts clause survives the trim because of what it prevents. In production the
 * app binds loopback and nginx is the only front door (auth_basic on `location /`, only /price/
 * carved out), so this URL sits behind BOTH walls. A phone tapping it meets the browser's own
 * unstyled credential box first, which mid-outage reads as "this link is broken" - and the next move
 * is the console fallback the page exists to delete.
 */
function buildRelinkLine({ lead, relinkUrl, warn, hasBaseline }) {
  if (relinkUrl) {
    const pointer = hasBaseline
      ? 'Scan only from the handset the page names.'
      : 'The page cannot name the handset - it says how to confirm it before you scan.';
    return `🔗 ${lead}: ${relinkUrl}\n   ${pointer} It asks for the login twice, both prompts are expected.`;
  }
  const lines = [
    `🔗 ${lead} via the Maytapi console (console.maytapi.com) - no in-app QR page on this box.`,
    `   ${warn.handset} ${warn.consequence}`,
    `   ${warn.steps}`,
  ];
  if (!hasBaseline) lines.push(`   ${NO_BASELINE_WARNING}`);
  return lines.join('\n');
}

/**
 * The sender-down alert, both urgencies, as data in and text out.
 *
 * Pure and exported so BOTH branches are assertable. The emergency branch cannot be reached through
 * main() in a test at all: `allTiersDown` means no delivery tier is configured, and a test harness
 * that configures no tier captures nothing - so before this extraction the 🔴 body was rendered by
 * no test and could regress silently. (That is also a real property of the running system: when
 * every tier is down the emergency alert is composed and delivered nowhere. The dead-man's-switch
 * ping is what covers that case, and it predates this function.)
 *
 * The shape is the same at both urgencies - state, facts, action - because the difference between
 * them is one sentence about whether anything else is getting through, not a different document.
 * Leading with the SYSTEM's state rather than the alert's is load-bearing: "sender is DOWN" reads as
 * the BIDDER being down, which is the one thing that is not true, and getting that wrong costs
 * someone a panicked call about live money.
 */
function buildDownAlert({ senderId, statusStr, downMin, downSince, allTiersDown, relinkUrl, warn, hasBaseline }) {
  const facts = `📵 Maytapi slot ${senderId} - ${statusStr}, down ${humanDuration(downMin)} (since ${istStamp(downSince)})`;
  if (allTiersDown) {
    return {
      subject: '🔴 BRL bidder WhatsApp has stopped sending - and no backup is set up',
      body: `Bidding is still running normally. But WhatsApp messages are being accepted and then quietly dropped, and there is no other way left to reach you if this gets worse.\n\n${facts}\n\n${buildRelinkLine({ lead: 'Re-link now', relinkUrl, warn, hasBaseline })}`,
    };
  }
  return {
    subject: '🟡 BRL bidder WhatsApp has stopped sending',
    body: `Bidding is still running normally. The bidder's own WhatsApp number has stopped delivering messages.\n\n${facts}\n\n${buildRelinkLine({ lead: 'Re-link when convenient', relinkUrl, warn, hasBaseline })}`,
  };
}

// ---- delivery-tier availability (pure) ---------------------------------------------------
/**
 * Which of the monitor's ALERT-DELIVERY tiers can still reach a human right now. This is the real
 * structure behind Sid's "all numbers disconnected": not a group-sender rotation (there is none),
 * but the monitor's own tiers.
 *   siblingUp   - a DIFFERENT Maytapi phone is active + dialable (the WA sibling DM tier). This is
 *                 the only tier that co-fails with the primary sender, so it is read LIVE off the
 *                 listPhones board. False when the Maytapi API itself was unreachable.
 *   emailUp     - the Brevo email tier is configured. Maytapi-INDEPENDENT: if configured it delivers
 *                 even when all of WhatsApp is down, so "configured" is the working-path signal here.
 *   telegramUp  - the optional Telegram tier is configured. Also Maytapi-independent.
 *   any         - at least one tier can deliver. `!any` is the "genuinely nothing can deliver the
 *                 alert" condition that (with office hours) gates the urgent, frequent repeat.
 */
function deliveryTiersUp({ apiUp, phones, senderId, env = {} }) {
  // MUST ask the same question pickSiblingVia() answers, including the allowlist. A slot that is
  // active but not the bidder's is not a tier that can deliver - the picker will refuse it. When
  // these two disagreed, `siblingUp` read true while the picker returned null, so `allTiersDown`
  // was false and a box with nothing able to deliver got the 6-hour quiet cadence instead of the
  // urgent one. That is the precise state the urgent cadence exists for.
  const allowed = alertFromPhones(env);
  const siblingUp = !!apiUp && Array.isArray(phones) &&
    phones.some((p) => String(p.id) !== String(senderId) && p.status === 'active' && p.number != null
      && allowed.includes(String(p.id)));
  const emailUp = !!env.BREVO_API_KEY;
  const telegramUp = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  return { siblingUp, emailUp, telegramUp, any: siblingUp || emailUp || telegramUp };
}

// ---- decision core (pure) ----------------------------------------------------------------
/**
 * The whole alert-cadence policy as one data-in/data-out function - no network, no fs, no clock
 * of its own (nowMs is passed in). main() reads the board and wires transports; every "should we
 * alert, and how urgently" call lives here so it is unit-testable and has a single source of truth.
 *
 *   healthy            - is the PRIMARY sender live (active + dialable number)?
 *   anyDeliveryTierUp  - can ANY monitor tier still reach a human (deliveryTiersUp().any)? When this
 *                        is false, the alert is going nowhere - that, plus office hours, is the only
 *                        state urgent enough for the frequent repeat.
 *   statusStr          - human status blurb for the persisted state / the alert body.
 *   actualNumber       - the MSISDN the board reports for the slot RIGHT NOW (null while down).
 *   expectedNumber     - the MSISDN this slot was last observed on (expectedSenderNumber(state)), or
 *                        null before any healthy run has recorded one.
 *   knownNumbers       - Set of digit-strings that belong to BRL (knownBrlNumbers()). A slot that
 *                        moves WITHIN this set is a handset swap; one that moves outside it is a
 *                        takeover. An empty/absent set makes every move read as a takeover, which is
 *                        the safe direction to fail.
 *   nowMs / nowIso     - this run's clock (ms + ISO), passed in for testability.
 *   state              - the persisted prior state ({} on first run).
 *   cfg                - { graceMs, cooldownMs, quietCooldownMs } timing knobs.
 *
 * Returns { action, urgent, allTiersDown, office, rebind, known, state }:
 *   action        'none' | 'alert-recovered' | 'alert-down' | 'alert-still-down' | 'down-cooldown'
 *                 | 'pending-grace' | 'alert-wrong-number' | 'wrong-number-cooldown'
 *                 | 'notice-fleet-rebind'
 *   urgent        true for the frequent, repeated-interval states (nothing can deliver AND office
 *                 hours; or the slot is bound to an account that is not BRL's, which is always urgent)
 *   allTiersDown  no delivery tier can reach a human
 *   office        inside office hours (IST)
 *   rebind        classifyRebind() verdict for this run ('match' | 'mismatch' | 'first-run'), or
 *                 null while the sender is down (there is no live number to compare)
 *   known         on a mismatch only: was the new number one of BRL's? Decides notice vs alarm.
 *   state         the next state doc to persist
 */
function decide({ healthy, anyDeliveryTierUp, statusStr, actualNumber = null, expectedNumber = null, knownNumbers = null, nowMs, nowIso, state = {}, cfg }) {
  const { graceMs, cooldownMs, quietCooldownMs } = cfg;
  const office = inOfficeHours(nowMs);
  const lastAlertAt = state.lastAlertAt ? Date.parse(state.lastAlertAt) : 0;
  // What the monitor OBSERVED on the last healthy run. The only input to `expectedNumber`, and only
  // a live board read ever writes it.
  const observedNumber = state.lastKnownNumber != null
    ? (String(state.lastKnownNumber).replace(/[^\d]/g, '') || null) : null;

  if (healthy) {
    // 'active' is not 'ours' - see the RE-BIND CHECK note in the header. This comparison is the ONLY
    // thing that can distinguish a genuine recovery from the slot coming back on a stranger's
    // WhatsApp account, because both read active with a non-null number.
    const rebind = classifyRebind(actualNumber, expectedNumber);
    if (rebind.verdict === 'mismatch') {
      // THE SLOT MOVED. Two very different things look identical here, and which one this is decides
      // everything about how loudly to say it: BRL swapped handsets, or a stranger captured the slot.
      // `knownNumbers` is what separates them - see knownBrlNumbers() for what is in it and why the
      // subject slot's own number is excluded from it.
      if (knownNumbers && knownNumbers.has(rebind.actual)) {
        // A BRL handset. Nothing is wrong: the fleet runs several numbers on one Maytapi product and
        // the sender moves between them. Said ONCE, quietly, and then the observation is advanced so
        // the next run classifies 'match' and this stays said once rather than every cooldown.
        //
        // ADOPTING IS THE POINT, and it is safe only because of the membership test above. Adopting
        // an UNKNOWN number would silence the takeover alarm on the run after it first fired, which
        // is the one failure this whole check exists to prevent - so the branch below never does it.
        //
        // `alerted:false` with no recovery alert is deliberate: if the slot had been down, this
        // notice already tells the reader it is back, and on the number it came back on. Two
        // messages for one event is the noise this change exists to remove.
        return {
          action: 'notice-fleet-rebind',
          urgent: false, allTiersDown: false, office, rebind, known: true,
          state: {
            healthy: true, lastStatus: 'active', alerted: false,
            lastKnownNumber: rebind.actual, reboundTo: null,
          },
        };
      }
      // Not one of ours. Deliberately NOT routed through the quiet/urgent tier logic. That cadence
      // asks "can the alert still reach anyone" - here it can, and does, so every tier would read
      // "up" and this would fall to the 6-hour quiet cooldown. But the failure is not that alerts
      // are dark; it is that BRL's outbound WhatsApp identity is now someone's personal account,
      // sending customer messages and ingesting their private traffic. That is always urgent.
      const alreadyReported = state.reboundTo != null && String(state.reboundTo) === rebind.actual;
      const fire = !alreadyReported || (nowMs - lastAlertAt >= cooldownMs);
      return {
        action: fire ? 'alert-wrong-number' : 'wrong-number-cooldown',
        urgent: true, allTiersDown: !anyDeliveryTierUp, office, rebind, known: false,
        state: {
          healthy: false, lastStatus: `active/wrong-number:${rebind.actual}`, alerted: true,
          downSince: state.downSince || nowIso,
          lastAlertAt: fire ? nowIso : (state.lastAlertAt || null),
          // The OBSERVATION is carried unchanged - deliberately not advanced to the stranger's
          // number, because adopting it would silence this alert on the very next run.
          lastKnownNumber: observedNumber, reboundTo: rebind.actual,
        },
      };
    }
    // Recovery is announced ONLY if a down was actually alerted (never for a rode-out blip).
    //
    // 'first-run' means there was NOTHING to compare against, so this run ADOPTS whatever answered
    // as the baseline. That is the right behaviour - refusing to acknowledge a healthy sender for
    // want of history would turn a cold start into a permanent alarm - but it must never be reported
    // as a VERIFIED recovery, because on a box deployed while the slot was already down this first
    // read is exactly where a bad re-link would land.
    return {
      action: state.alerted ? 'alert-recovered' : 'none',
      urgent: false, allTiersDown: false, office, rebind,
      // Carried on this path too, for the 'first-run' copy: with no history to compare against, "is
      // it one of ours" is the only check left, and it is the difference between a recovery worth
      // announcing plainly and one that needs a human to go and look at the handset.
      known: !!(knownNumbers && rebind.actual && knownNumbers.has(rebind.actual)),
      // Record what the slot is bound to while we can SEE it. This write is the whole reason the
      // wrong-handset check works at all: the live board reports number:null in exactly the state
      // the number is needed in, so it has to have been captured earlier, on a healthy run.
      state: {
        healthy: true, lastStatus: 'active', alerted: false,
        lastKnownNumber: rebind.actual,
      },
    };
  }

  // Sender is down. "All tiers down" = no delivery tier can reach a human right now.
  const allTiersDown = !anyDeliveryTierUp;
  const urgent = allTiersDown && office;                     // the ONLY frequent, repeated state
  const repeatEveryMs = urgent ? cooldownMs : quietCooldownMs;

  const downSince = state.downSince || nowIso;
  const downMs = nowMs - Date.parse(downSince);
  const alerted = state.alerted === true;
  // FIRST alert fires once the outage persists past the grace window - always, day or night, so a
  // real logout is never sat on. Only the RE-fire is throttled by the cadence chosen above.
  const shouldFirst = !alerted && downMs >= graceMs;
  const shouldRepeat = alerted && (nowMs - lastAlertAt >= repeatEveryMs);
  // Carried forward on EVERY down branch. #77's decide() returns a fresh state doc rather than
  // merging, so anything not restated here is dropped from the file - and dropping this one would
  // erase the recorded number at exactly the point the outage makes it unreadable from the board,
  // leaving the re-link instructions unable to name the handset. `reboundTo` is deliberately NOT
  // carried: a slot that has gone down again has no current binding to complain about, and a fresh
  // mismatch after the next recovery should alert immediately rather than read as already-reported.
  const carry = { lastKnownNumber: observedNumber };

  if (shouldFirst || shouldRepeat) {
    return {
      action: shouldFirst ? 'alert-down' : 'alert-still-down',
      urgent, allTiersDown, office, rebind: null, known: null,
      state: Object.assign({ healthy: false, downSince, lastStatus: statusStr, alerted: true, lastAlertAt: nowIso }, carry),
    };
  }
  return {
    action: alerted ? 'down-cooldown' : 'pending-grace', // non-active but throttled / inside grace
    urgent, allTiersDown, office, rebind: null, known: null,
    state: Object.assign({ healthy: false, downSince, lastStatus: statusStr, alerted, lastAlertAt: state.lastAlertAt || null }, carry),
  };
}

// ---- queue-backlog detection (pure) ------------------------------------------------------
/**
 * Read a Maytapi phone's queue depth from a /queues row, robust to the shapes the API has actually
 * returned. WHICH ENDPOINT, AND WHY (the design decision this whole addition rests on):
 *
 *   The signal is the PRODUCT-LEVEL `GET /{product}/queues`, NOT the per-phone `GET /{phone}/queue`.
 *   Two independent live reads on 2026-07-25 (the 147227-flush incident and the breaker-coverage-gap
 *   diagnosis) confirm /queues returns a per-phone integer `queue` depth that correctly reflected the
 *   backlog - 128023 idle -> 17, every other slot -> 0 - in ONE call covering ALL phones, which is
 *   exactly the board this monitor already thinks in (it reads listPhones per product). The per-phone
 *   endpoint returns {"success":true,"stats":{"sending":N}}; on that same incident stats.sending DID
 *   read 17 for 128023 and 0 for the flushed 147227, but the field is named for "sending", not
 *   "queued", so its meaning is ambiguous by name and it is not trustworthy as the primary read.
 *   So: product /queues is primary; stats.sending is accepted only as a defensive fallback shape.
 *
 * queueDepthOf() therefore reads `queue` first (the live-verified product field, returned even when
 * 0), and only if `queue` is absent falls through queued/count/pending/stats.sending, so a minor
 * field-name variation can never blind the alarm. A missing/garbled entry reads 0 (fail-safe: a read
 * glitch must never manufacture a backlog).
 */
function queueDepthOf(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  const q = entry.queue;
  if (Array.isArray(q)) return q.length;                                  // some shapes return the messages array
  if (q != null && q !== '' && Number.isFinite(Number(q))) return Math.max(0, Number(q)); // the live product field
  // `queue` absent -> try the other shapes the API has shown, incl. the per-phone stats.sending
  for (const c of [entry.queued, entry.count, entry.pending, entry.stats && entry.stats.sending]) {
    if (Array.isArray(c)) return c.length;
    const n = Number(c);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return 0;
}

/**
 * From the product /queues payload + the listPhones board, return the phones that are a real
 * landmine: queue depth > 0 AND NOT active. A queue on an ACTIVE phone is normal in-flight traffic
 * that drains on its own; a queue on a NON-active phone (idle / qr-screen / loading / disabled) never
 * drains until re-link, so it is always a genuine armed flush - no grace window applies (unlike a
 * status blip, a queued message is not transient). Status is taken from the authoritative listPhones
 * board when available (already read this run), else from the /queues row itself. Fail-safe: a null /
 * garbled payload yields NO offenders - a monitoring read glitch must never raise a false backlog.
 */
function queueOffenders({ queues, phones, senderId }) {
  const rows = Array.isArray(queues) ? queues : [];
  const board = Array.isArray(phones) ? phones : [];
  const byId = new Map(board.map((p) => [String(p.id), p]));
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id != null ? row.id : (row.phone_id != null ? row.phone_id : row.phoneId));
    const depth = queueDepthOf(row);
    if (depth <= 0) continue;
    const boardEntry = byId.get(id);
    const status = (boardEntry ? boardEntry.status : row.status) || 'unknown';
    if (status !== 'active') out.push({ id, queue: depth, status, isSender: String(id) === String(senderId) });
  }
  return out;
}

/**
 * Cadence for the backlog alert, kept SEPARATE from the sender-health decide() so it can never
 * perturb that carefully-tuned state machine. Tell the operator ONCE the moment a backlog appears
 * (day or night - an armed flush is worth knowing), then re-fire only every quiet cooldown while it
 * persists, so a backlog that sits for hours does not email at every cron tick. State lives under
 * state.queue so it coexists with the sender-health state in the same file (main() composes both).
 */
function decideQueueAlert({ offenders, nowMs, nowIso, state = {}, cfg }) {
  const prev = (state && state.queue) || {};
  const depth = offenders.reduce((n, o) => n + o.queue, 0);
  if (offenders.length === 0) {
    return { action: prev.active ? 'queue-cleared' : 'none', state: { active: false } };
  }
  const alerted = prev.active === true;
  const lastAt = prev.lastAlertAt ? Date.parse(prev.lastAlertAt) : 0;
  const shouldFirst = !alerted;                                           // first detection -> tell once
  const shouldRepeat = alerted && (nowMs - lastAt >= cfg.quietCooldownMs); // then only occasionally
  if (shouldFirst || shouldRepeat) {
    return { action: shouldFirst ? 'queue-alert' : 'queue-alert-still',
      state: { active: true, lastAlertAt: nowIso, depth } };
  }
  return { action: 'queue-cooldown', state: { active: true, lastAlertAt: prev.lastAlertAt || null, depth } };
}

// ---- QR push cadence (pure) --------------------------------------------------------------
/**
 * When may the QR IMAGE go out? Kept separate from decide() for the same reason decideQueueAlert()
 * is: the sender-health cadence is tuned and must not be perturbed by a delivery enhancement.
 *
 * THE PROBLEM THIS SOLVES. A fetched pairing QR rotates in about 20 seconds. The re-alert cadence
 * is 30 minutes at its most urgent and 6 hours at its quietest - 90x to 1000x the artifact's life.
 * So a QR pushed on the alert tick alone is, in almost every realistic case, expired before anyone
 * has picked up their phone: the recipient sees "QR code expired" and goes to the console anyway,
 * having also been mailed a live session credential for nothing. Pushing it once and calling that a
 * feature is the contradiction; this function is the resolution.
 *
 * THE SHAPE. Every FULL down-alert opens a burst window. Inside that window the monitor re-pushes a
 * freshly-fetched QR on a short cadence, so an operator who reaches their phone two, five or ten
 * minutes after the alert still has a live code waiting rather than a dead one. The window then
 * closes on its own.
 *
 * BOUNDED ON BOTH AXES, on purpose. Time (cfg.qrBurstMs) stops a long outage from becoming an
 * all-day drip of credentials into two inboxes. Count (cfg.qrBurstMax) is the belt to that braces:
 * a mangled or future-dated timestamp in the state file could defeat a purely time-based bound, and
 * an unbounded loop pushing pairing credentials is the one failure mode this feature must not have.
 * Whichever bound trips first ends the burst.
 *
 * A NOTE ON THE FLOOR. cfg.qrRefreshMs cannot make the monitor run more often than cron does. With
 * the standard 5-minute cron a 2-minute setting simply means "every tick"; the knob exists to slow
 * the burst DOWN, not to speed the monitor up.
 *
 *   senderDown - is the primary sender currently not-healthy?
 *   action     - decide()'s action for this run.
 *   Returns { send, reason, state } where state replaces state.qr.
 */
function decideQrBurst({ senderDown, action, nowMs, nowIso, state = {}, cfg }) {
  const prev = (state && state.qr) || {};
  // Recovered (or never down): close the window. A stale burstFrom must not survive into the next
  // outage, or the next one would open with its budget already spent.
  if (!senderDown) return { send: false, reason: 'sender is not down', state: {} };
  // A full down-alert just went out - (re)open the window and push alongside it.
  if (action === 'alert-down' || action === 'alert-still-down') {
    return { send: true, reason: 'full down-alert', state: { burstFrom: nowIso, lastSentAt: nowIso, sends: 1 } };
  }
  // Between alerts: only the burst can push, and only if a burst is actually open.
  if (!prev.burstFrom) return { send: false, reason: 'no down-alert has fired yet', state: prev };
  const sends = Number(prev.sends) || 0;
  const openedMs = Date.parse(prev.burstFrom);
  const withinWindow = Number.isFinite(openedMs) && (nowMs - openedMs) < cfg.qrBurstMs;
  const underCap = sends < cfg.qrBurstMax;
  const lastMs = prev.lastSentAt ? Date.parse(prev.lastSentAt) : 0;
  const dueByRefresh = !Number.isFinite(lastMs) || lastMs === 0 || (nowMs - lastMs) >= cfg.qrRefreshMs;
  if (!withinWindow) return { send: false, reason: 'burst window closed', state: prev };
  if (!underCap) return { send: false, reason: `burst cap ${cfg.qrBurstMax} reached`, state: prev };
  if (!dueByRefresh) return { send: false, reason: 'inside the refresh interval', state: prev };
  return { send: true, reason: 'burst refresh', state: { burstFrom: prev.burstFrom, lastSentAt: nowIso, sends: sends + 1 } };
}

async function main() {
  const env = loadEnv();
  const BASE = (env.SP_MAYTAPI_ENDPOINT || 'https://api.maytapi.com/api').replace(/\/$/, '');
  const PRODUCT = env.SP_MAYTAPI_PRODUCT_ID;
  const SENDER = String(env.SP_MAYTAPI_PHONE_ID || '');
  const TOKEN = env.SP_MAYTAPI_TOKEN;
  const H = { 'x-maytapi-key': TOKEN };
  const cfg = {
    graceMs: (Number(env.MONITOR_GRACE_MIN) || 6) * 60000,
    cooldownMs: (Number(env.MONITOR_COOLDOWN_MIN) || 30) * 60000,        // urgent (all tiers down, office hours)
    quietCooldownMs: (Number(env.MONITOR_QUIET_COOLDOWN_MIN) || 360) * 60000, // off-hours OR a tier still delivers
    // QR push burst - see decideQrBurst(). Short cadence, bounded by BOTH a window and a hard count.
    qrRefreshMs: (Number(env.MONITOR_QR_REFRESH_MIN) || 2) * 60000,
    qrBurstMs: (Number(env.MONITOR_QR_BURST_MIN) || 20) * 60000,
    qrBurstMax: Number(env.MONITOR_QR_BURST_MAX) || 6,
  };
  const stateFile = monitorStateFile(env);
  const nowIso = new Date().toISOString();

  if (!PRODUCT || !SENDER || !TOKEN) { console.error(`[monitor] ${nowIso} missing SP_MAYTAPI_* creds - cannot run`); process.exit(2); }

  // --- read the board: which phones are up, is our sender healthy ---
  let phones = null, apiUp = true;
  try {
    const res = await fetch(`${BASE}/${PRODUCT}/listPhones`, { headers: H });
    const j = await res.json();
    phones = j.data || j;
    if (!Array.isArray(phones)) throw new Error('unexpected listPhones shape');
  } catch (e) {
    apiUp = false;
    console.error(`[monitor] ${nowIso} listPhones failed: ${e.message}`);
  }

  const me = apiUp ? phones.find((p) => String(p.id) === SENDER) : null;
  const healthy = apiUp && !!me && me.status === 'active' && me.number != null;
  const statusStr = !apiUp ? 'maytapi-api-unreachable' : (me ? `${me.status}${me.number == null ? '/number:null' : ''}` : 'not-found');
  // Which of the monitor's OWN delivery tiers can still reach a human. `any === false` is the
  // "genuinely nothing can deliver the alert" condition Sid's "all numbers disconnected" maps to.
  const tiers = deliveryTiersUp({ apiUp, phones, senderId: SENDER, env });

  // --- read the product-level queue depths: catches the queue>0-on-idle landmine (a backlog stacked
  //     on a logged-out phone that floods on re-link). Product /queues covers every slot in one call;
  //     guarded separately so a queues read glitch never breaks the sender-health path, and a null
  //     payload yields no offenders (fail-safe - no false backlog alarm). See queueOffenders().
  let queues = null;
  if (apiUp) {
    try {
      const res = await fetch(`${BASE}/${PRODUCT}/queues`, { headers: H });
      const j = await res.json();
      queues = j.data || j;
    } catch (e) {
      console.error(`[monitor] ${nowIso} queues read failed: ${e.message}`);
    }
  }

  // --- decide: the whole cadence policy lives in decide()/decideQueueAlert()/decideQrBurst(); this
  //     file only wires transports. Each decision reads the PRIOR state, then main() composes the
  //     next state doc. ---
  let state = {};
  // A genuinely absent file is the ordinary first run and says nothing. A file that EXISTS but does
  // not parse is different: the baseline this monitor's wrong-handset alarm depends on has just been
  // silently reset to {}, which re-opens the unverified-baseline window on a box that had closed it.
  // That has to be said out loud rather than swallowed by a bare catch.
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.error(`[monitor] ${nowIso} state file ${stateFile} unreadable (${e.message}) - starting from empty state, rebind verification is OFF until the next healthy run`);
    }
    state = {};
  }
  const nowMs = Date.parse(nowIso);
  // What this slot was last seen on. Everything the re-link instructions tell a human is anchored on
  // it - which handset scans, and what it costs if the wrong one does - and the live board cannot
  // supply it, because it reports number:null in exactly the down state where it is needed.
  const expectedNumber = expectedSenderNumber(state);
  // Which numbers are BRL's, so a move WITHIN the fleet can be told apart from a capture. Computed
  // from the live board plus the staff allowlist; see knownBrlNumbers().
  const knownNumbers = knownBrlNumbers({ phones, senderId: SENDER, rosterFile: staffRosterFile(env) });
  const d = decide({
    healthy, anyDeliveryTierUp: tiers.any, statusStr,
    actualNumber: me ? me.number : null, expectedNumber, knownNumbers,
    nowMs, nowIso, state, cfg,
  });
  const offenders = queueOffenders({ queues, phones, senderId: SENDER });
  const q = decideQueueAlert({ offenders, nowMs, nowIso, state, cfg });
  const qr = decideQrBurst({ senderDown: !healthy, action: d.action, nowMs, nowIso, state, cfg });
  const action = d.action;
  // Read BEFORE the reassignment below. decide()'s recovery branch deliberately does not carry
  // downSince into the new state (the outage is over, so nothing downstream of this run should see
  // it), which means the recovery alert cannot get "how long was it out" from the post-decide state.
  const priorDownSince = state.downSince;
  state = Object.assign({}, d.state, { queue: q.state, qr: qr.state }); // one file, three sub-states
  let qrState = 'none'; // rides the healthcheck ping so a dark QR tier is visible off-box

  // The always-fresh on-demand page (delivery layer 1). Computed once - the alert text carries it,
  // and the pushed image's caption points back at it.
  const relinkUrl = relinkQrUrl(env);
  // ONE source for the wrong-handset wording (buildScanWarning), shared with the DM caption and the
  // on-demand page. This block used to hand-author a third, divergent version of the same
  // safety-critical sentences; the numbering is the only thing that belongs to this channel.
  const warn = buildScanWarning({ expectedNumber, format: 'text' });
  // The blind-window state, as one token for the monitor's diagnostic surfaces. Which of the three
  // states the baseline is in - pinned, adopted blind, or absent - is a deploy-configuration fact
  // whose remedy is an .env edit, so it rides the healthcheck ping and the run log rather than a
  // paragraph in a message read on a phone mid-outage. It is NOT the whole of what the operator
  // needs: the human half of the adopted-blind case ("this number was never confirmed as ours")
  // rides the recovery alert, and the human half of the absent case rides the re-link surfaces.
  // See buildRelinkLine() and the alert-recovered branch. HEALTHCHECK_URL is a required deploy step
  // (.env.example, DEPLOY.md) precisely because this signal now depends on it.
  const baselineState = expectedNumber ? 'ok' : 'none';

  if (action === 'notice-fleet-rebind') {
    // The slot moved to another of BRL's OWN numbers. This is a handset swap, not an incident, so it
    // gets a notice rather than an alarm: two sentences, email only, said once. It deliberately does
    // NOT go to Telegram or the WhatsApp sibling - waking three channels for a routine swap is what
    // this branch exists to stop, and the email is already where the rest of the audit trail lands.
    const r = d.rebind;
    const subject = 'BRL bidder is sending from a different number';
    const body = `The bidder's WhatsApp moved to ${displayMsisdn(r.actual)}. It was on ${displayMsisdn(r.expected)}.\n\nBoth phones are BRL's, so nothing is wrong. No action needed if that change was intended.`;
    await sendEmail(env, subject, body);
  } else if (action === 'alert-wrong-number') {
    // NOT a recovery. The slot is live on an account that is not BRL's - see the RE-BIND CHECK note
    // in the header. Every tier hears about it, and the re-link instructions are inverted: the fix
    // is to UNLINK, not to scan another code.
    const r = d.rebind;
    // Subject built from the shared constant, so the monitor alert, the /api/wa/relink-qr refusal
    // and the push refusal all name this state with the same words - an operator searching their
    // inbox for what the page told them finds the alert.
    const subject = `🚨 BRL bidder ${REBOUND_STATE}`; // "BRL bidder is linked to a phone that is not BRL's"
    // The last line is not padding. The claim rests on the number being absent from BRL's Maytapi
    // board AND the staff list, and a newly issued BRL phone nobody has added to the list looks
    // exactly like a stranger from here - so the cheap remedy is offered before the expensive one.
    const body = `The bidder's WhatsApp moved to ${displayMsisdn(r.actual)}. It should be on ${displayMsisdn(r.expected)}, and that new number is not one of BRL's.\n\nCustomer messages are going out from that phone right now, and its private WhatsApp is coming into BRL's systems.\n\n⛔ On that phone: WhatsApp > Linked Devices > remove the link. Then re-link from ${displayMsisdn(r.expected)}.\n\nIf it is a new BRL phone, add it to the staff list instead of unlinking. (Maytapi slot ${SENDER}.)`;
    await sendEmail(env, subject, body);
    await telegram(env, subject + '\n\n' + body);
    if (apiUp) await alertWaSibling(BASE, PRODUCT, H, phones, SENDER, env, subject + '\n\n' + body);
  } else if (action === 'alert-recovered') {
    // Reached only when the binding did not MISMATCH - the branch above owns that case, so "is BACK"
    // can no longer be printed over a slot that came back on a stranger's account.
    //
    // But "did not mismatch" is two different states, and they used to share one sentence claiming
    // the slot "is active again on the expected number". On a 'first-run' there IS no expected
    // number - the code says so itself - so that sentence asserted as fact the one thing this run
    // could not know, over the number it was silently adopting as the permanent baseline. The whole
    // point of the re-bind check is that a wrong handset reads exactly like a right one; announcing
    // an unverifiable recovery as verified is the failure it was built to prevent, in words.
    let subject, body;
    if (d.rebind && d.rebind.verdict === 'first-run' && !d.known) {
      subject = '❓ BRL bidder is back, on a number we cannot check';
      body = `The bidder's WhatsApp is working again, on ${displayMsisdn(me.number)}.\n\nWe had no number on record for it, and this one is not on BRL's list, so nothing here can confirm the phone belongs to BRL.\n\nPlease check whose phone it is.\n✅ BRL's - add it to the staff list so this can be checked next time.\n🚨 Not BRL's - on that phone, WhatsApp > Linked Devices > remove the link, then re-link from the right one.`;
    } else {
      subject = '✅ BRL bidder WhatsApp is working again';
      // How long it was actually out - the one fact a recovery notice can add beyond "it is back",
      // and the reason priorDownSince is captured above. Omitted rather than guessed if absent.
      const downFor = priorDownSince ? ` after ${humanDuration(Math.round((nowMs - Date.parse(priorDownSince)) / 60000))}` : '';
      // THE HEDGE THAT MUST NOT BE TRIMMED. A recovery lands here whenever the slot came back on the
      // number it went down with - and that number is only as good as whatever first recorded it. If
      // it is not a number BRL is known to hold, "same as last time" is the ONLY thing this green
      // tick means, and saying so is the difference between a reader checking the handset and a
      // reader filing the mail. It costs one line on a message that is already rare.
      const unconfirmed = d.known
        ? ''
        : `\n\n⚠️ ${displayMsisdn(me.number)} is not on BRL's list, so all we can say is that it is the same number as before, not that the phone is BRL's.`;
      // displayMsisdn, not the raw digits: this was the one line in the file that printed a bare
      // 918882034647 at the reader while every other tier and branch formatted the same number.
      body = `The bidder's WhatsApp is sending again, on ${displayMsisdn(me.number)}${downFor}.${unconfirmed}`;
    }
    await sendEmail(env, subject, body);
    await telegram(env, subject + '\n\n' + body);
    if (apiUp) await alertWaSibling(BASE, PRODUCT, H, phones, SENDER, env, subject + '\n\n' + body);
  } else if (action === 'alert-down' || action === 'alert-still-down') {
    const downSince = state.downSince;
    // Nothing here describes the alerting cadence. The reader of the not-urgent variant is holding
    // proof the fallback works, and how often it will re-fire is the alerting system talking about
    // itself rather than anything they can act on.
    const { subject, body } = buildDownAlert({
      senderId: SENDER, statusStr, downSince, allTiersDown: d.allTiersDown,
      downMin: Math.round((nowMs - Date.parse(downSince)) / 60000),
      relinkUrl, warn, hasBaseline: !!expectedNumber,
    });
    await sendEmail(env, subject, body);
    await telegram(env, subject + '\n\n' + body);
    if (apiUp) await alertWaSibling(BASE, PRODUCT, H, phones, SENDER, env, subject + '\n\n' + body);
  }

  // --- QR image push (delivery layer 2, OPT-IN). Deliberately AFTER the alert tiers: a pure
  //     enhancement that must never add latency to the alert itself, and it never throws, so any
  //     failure just leaves the text alert that already went out - which already carries the
  //     on-demand page URL, the path that actually works. decideQrBurst() owns WHEN (a full
  //     down-alert, plus a bounded short-cadence burst after it); this block owns the wiring. The
  //     sibling to send FROM is #77's pickSiblingVia - the same hardened pick the text tier uses,
  //     which verifies a pinned MONITOR_ALERT_VIA_PHONE is genuinely active before trusting it. ---
  if (qr.send && apiUp) {
    const out = await deliverQrRelink({
      base: BASE, productId: PRODUCT, token: TOKEN,
      senderPhoneId: SENDER, senderStatus: me ? me.status : null,
      boundNumber: me ? me.number : null, expectedNumber,
      via: pickSiblingVia(phones, SENDER, env.MONITOR_ALERT_VIA_PHONE, env),
      recipients: parseAlertRecipients(env),
      enabled: qrDeliveryEnabled(env),
      qrUrl: relinkUrl,
      log: (m) => console.error(m),
    });
    qrState = qrOutcome(out);
    console.log(`[monitor] qr-relink (${qr.reason}) sent=${out.sent} refused=${out.refused} failed=${out.failed} bytes=${out.bytes}${out.reason ? ` (${out.reason})` : ''}`);
  } else if (!healthy) {
    qrState = 'skipped';
  }

  // --- queue-backlog alert: an armed flush on a non-active phone, independent of sender-health above.
  //     Routed through the SAME delivery tiers (email is the Maytapi-independent backstop). ---
  if (q.action === 'queue-alert' || q.action === 'queue-alert-still') {
    const totalQueued = offenders.reduce((n, o) => n + o.queue, 0);
    const subject = 'ALERT: BRL WhatsApp backlog queued on a non-active sender (queue>0)';
    const lines = offenders.map((o) => `  - phoneId ${o.id} (${o.status}${o.isSender ? ', the primary sender' : ''}): ${o.queue} message(s) queued, undelivered`);
    const body = `BRL WhatsApp: ${totalQueued} message(s) are QUEUED on a NON-ACTIVE Maytapi phone. Maytapi accepts-and-queues sends to a logged-out/idle session (success:true is NOT delivery), so these are sitting undelivered and will FLUSH to their recipients the instant that phone re-links.\n\n${lines.join('\n')}\n\nDo NOT re-link a listed phone before its queue is drained (operator action per the incident runbook). This is the queue>0-on-idle signal that a stale customer-group flood is armed.`;
    await sendEmail(env, subject, body);
    await telegram(env, subject + '\n' + body);
    if (apiUp) await alertWaSibling(BASE, PRODUCT, H, phones, SENDER, env, '⚠️ ' + subject + '\n' + body);
  }

  // Written atomically (temp file + rename) rather than straight over the live path. This file now
  // holds a SECURITY-CONTROL baseline - the number the wrong-handset alarm compares against - and it
  // is read by the app's QR page ~6 times a minute while that page is open. A plain writeFileSync
  // truncates before it writes, so a cron kill, a reboot or an OOM mid-write leaves a truncated file
  // that parses as nothing, silently resetting the baseline; a concurrent read in the same window
  // sees the same garbage. rename() is atomic on the same filesystem, so a reader gets either the
  // whole old file or the whole new one and never a half-written one.
  try {
    const tmpFile = `${stateFile}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
    fs.renameSync(tmpFile, stateFile);
  } catch (e) { console.error(`[monitor] ${nowIso} state write failed: ${e.message}`); }

  // Dead-man's-switch: prove THIS run happened. If the box/cron dies, these pings stop and the
  // external service raises the alarm the on-box monitor never could. `qr=` carries the QR-push
  // outcome (none/skipped/sent/failed) so a tier that has gone silently dark is visible OFF the box
  // - otherwise the only record of a failed push is cron stdout, which nothing reads. `baseline=`
  // rides it for the same reason: none/unverified means the wrong-handset alarm is off or running on
  // an assumption, and that is a deploy-config defect nobody would otherwise see until it misfired.
  if (env.HEALTHCHECK_URL) { try { await fetch(env.HEALTHCHECK_URL, { method: 'POST', body: `${statusStr} action=${action} queue=${offenders.length} qr=${qrState} baseline=${baselineState}` }); } catch (_) { /* best effort */ } }

  const mode = d.urgent ? 'urgent' : 'quiet';
  console.log(`[monitor] ${nowIso} sender ${SENDER} ${healthy ? 'OK' : 'DOWN'} (${statusStr}) tiers=${tiers.any ? 'up' : 'down'}(sib:${tiers.siblingUp} email:${tiers.emailUp} tg:${tiers.telegramUp}) office=${d.office} action=${action} mode=${mode} queue=${q.action}(${offenders.length}) qr=${qrState} baseline=${baselineState}`);
  return { action, statusStr, healthy, qr: qrState, state };
}

// Maytapi-independent email via Brevo. No key -> silent no-op (so the code can ship before setup).
async function sendEmail(env, subject, text) {
  const key = env.BREVO_API_KEY; if (!key) return;
  const to = (env.MONITOR_EMAIL_TO || DEFAULT_EMAILS).split(',').map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
  const bcc = (env.MONITOR_EMAIL_BCC || DEFAULT_BCC_EMAILS).split(',').map((s) => s.trim()).filter(Boolean).map((email) => ({ email }));
  const sender = { email: env.BREVO_SENDER || 'alerts@bestroadways.com', name: 'BRL Bidder Monitor' };
  try {
    const payload = { sender, to, subject, textContent: text };
    if (bcc.length) payload.bcc = bcc;
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const bccPart = bcc.length ? ` bcc ${bcc.map((t) => t.email).join(',')}` : '';
    console.log(`[monitor] email via brevo -> ${to.map((t) => t.email).join(',')}${bccPart}: http ${res.status}`);
  } catch (e) { console.error(`[monitor] brevo email failed: ${e.message}`); }
}

// ---- sibling-phone selection (pure) ------------------------------------------------------
/**
 * Choose the phone to send the WA-sibling alert FROM. NEVER the down sender, and ALWAYS a phone that
 * is itself active + dialable - including when MONITOR_ALERT_VIA_PHONE pins one. The override used to
 * be trusted blindly (`via = override || auto-pick`), so a pinned-but-logged-out sibling would
 * blind-QUEUE the alert onto a dead phone - the exact accept-and-queue hazard this monitor exists to
 * catch, and the alert would silently pile up undelivered. So the override is honoured only if that
 * phone is active + dialable and not the sender itself; otherwise we fall through to auto-picking any
 * active sibling. If nothing usable exists we return null and the caller skips the WA tier - email
 * (fired independently in main(), Maytapi-agnostic) remains the backstop.
 */
/**
 * Which slots may an alert be SENT FROM. Default 128023 (the bidder) and 136151 (its fallback).
 *
 * BRL's Maytapi product holds seven slots and most of them are the sales desk's working numbers. The
 * auto-pick below was `list.find(usable)` - the FIRST active sibling in board order - which is 135719,
 * a sales line. On 2026-09-23 the director asked why bidder alerts were arriving from a sales number;
 * Sushant's instruction is that only these two slots are the bidder's to send from.
 *
 * Narrowing this can leave NO usable sibling, and that is accepted deliberately: the WhatsApp tier
 * then goes dark and email carries the alert, which is the Maytapi-independent backstop and already
 * the primary tier. Sending from the wrong identity is worse than sending on one channel.
 */
const ALERT_FROM_PHONES_DEFAULT = '128023,136151';

function alertFromPhones(env) {
  return String((env || {}).MONITOR_ALERT_FROM_PHONES || ALERT_FROM_PHONES_DEFAULT)
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function pickSiblingVia(phones, senderId, override, env) {
  const list = Array.isArray(phones) ? phones : [];
  const allowed = alertFromPhones(env);
  const usable = (p) => !!p && String(p.id) !== String(senderId) && p.status === 'active' && p.number != null
    && allowed.includes(String(p.id));
  const ov = String(override || '');
  if (ov) {
    const pinned = list.find((p) => String(p.id) === ov);
    if (usable(pinned)) return pinned.id;
    // Two different failures, and the operator needs to know which: a slot that is down, versus one
    // that is not the bidder's to speak as. The second is a config mistake no retry will fix.
    const why = allowed.includes(ov) ? 'is not an active sibling' : `is not in MONITOR_ALERT_FROM_PHONES (${allowed.join(',')})`;
    console.error(`[monitor] MONITOR_ALERT_VIA_PHONE=${ov} ${why} - falling back to auto-pick`);
  }
  const auto = list.find(usable);
  return auto ? auto.id : null;
}

// Alert over a SIBLING active phone (never the down sender). Maytapi-dependent -> secondary.
async function alertWaSibling(BASE, PRODUCT, H, phones, sender, env, msg) {
  // ONE MONITOR_ALERT_TO parser for both tiers. This used to be an inline copy here and a second
  // implementation in scripts/lib/sender-qr.js, each with its own hardcoded default list - a
  // duplication that branch documented as deliberate-and-temporary pending #77. #77 has landed, so
  // it is converged: the text tier and the QR tier now provably address the same people.
  const alertTo = parseAlertRecipients(env);
  // pickSiblingVia re-verifies a pinned MONITOR_ALERT_VIA_PHONE is active before use (else auto-picks,
  // else null) so the override can never blind-queue the alert onto a logged-out phone.
  const via = pickSiblingVia(phones, sender, env.MONITOR_ALERT_VIA_PHONE, env);
  if (!via) { console.error('[monitor] no active sibling phone to alert from (WA tier skipped; email is the backstop)'); return; }
  for (const to of alertTo) {
    try {
      const res = await fetch(`${BASE}/${PRODUCT}/${via}/sendMessage`, {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H),
        body: JSON.stringify({ to_number: String(to).replace(/[^\d]/g, ''), type: 'text', message: msg }),
      });
      const j = await res.json();
      console.log(`[monitor] WA sibling ${via} -> ${to}: success=${j && j.success}`);
    } catch (e) { console.error(`[monitor] WA sibling ${via} -> ${to} failed: ${e.message}`); }
  }
}

// Fully Maytapi-independent Telegram channel (only if configured). Silent no-op otherwise.
async function telegram(env, text) {
  const tok = env.TELEGRAM_BOT_TOKEN, chat = env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    console.log('[monitor] telegram alert sent');
  } catch (e) { console.error(`[monitor] telegram failed: ${e.message}`); }
}

// Run only when invoked directly (cron); requiring this file (tests) exposes the pure cores without
// touching the network, the filesystem, or process.exit.
if (require.main === module) {
  main().catch((e) => { console.error(`[monitor] fatal: ${e && e.message}`); process.exit(1); });
}

module.exports = {
  // main() is exported so the wiring the pure cores cannot cover - which alert text actually goes
  // out per state, what lands in the state file, what rides the healthcheck ping - is assertable
  // from a test over a stubbed transport rather than only reachable by causing a real outage.
  main,
  decide, deliveryTiersUp, istHour, inOfficeHours, istStamp, humanDuration,
  buildRelinkLine, buildDownAlert,
  queueDepthOf, queueOffenders, decideQueueAlert, decideQrBurst, pickSiblingVia,
  IST_OFFSET_MS, OFFICE_START_HOUR, OFFICE_END_HOUR,
};
