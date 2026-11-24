'use strict';
/**
 * WhatsApp sender-health monitor cadence (offline). The failure this pins: on a primary-sender
 * logout with the monitor's OWN fallback tiers still delivering the heads-up (a sibling WhatsApp
 * session + email), the monitor used to re-fire its "sender is DOWN" alert every cooldown (30m)
 * regardless of the hour or whether anything was actually undelivered - a 2am flood for a
 * non-emergency. There is no group-sender rotation here; "all numbers disconnected" maps to the
 * monitor's delivery TIERS all being unable to reach a human.
 *
 * The fix is a three-way cadence, all of it in the pure cores of monitor-wa-sender.js
 * (deliveryTiersUp + decide), which this suite drives directly (no network, no fs, no cron):
 *   - the sender is down AND NO tier can deliver AND office hours (06:00-20:00 IST) -> URGENT: re-fire every cooldown.
 *   - all tiers down but OFF hours                                                  -> QUIET: re-fire only every quiet cooldown.
 *   - a tier still delivers (active WA sibling, or email/telegram configured), any hour -> QUIET: never the urgent repeat.
 * The FIRST heads-up past the grace window must still fire in every case (you are told once), and
 * recovery/grace behaviour must be unchanged.
 */
const assert = require('assert');
const {
  decide, deliveryTiersUp, istHour, inOfficeHours, istStamp, humanDuration,
  queueDepthOf, queueOffenders, decideQueueAlert, pickSiblingVia,
  IST_OFFSET_MS, OFFICE_START_HOUR, OFFICE_END_HOUR,
} = require('../scripts/monitor-wa-sender');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const MIN = 60000;
const CFG = { graceMs: 6 * MIN, cooldownMs: 30 * MIN, quietCooldownMs: 360 * MIN };

// An epoch ms whose IST wall-clock is h:m on a fixed date (2026-07-24). Built with the SAME fixed
// +05:30 offset the monitor uses, so the test constructs the exact instants the boundary turns on.
function istAt(h, m = 0) { return Date.UTC(2026, 6, 24, h, m, 0) - IST_OFFSET_MS; }
function iso(ms) { return new Date(ms).toISOString(); }

// A down-state that has ALREADY alerted, last alerted `agoMin` minutes before `nowMs`. downSince is
// pushed 5h back so downMs is always past grace (irrelevant once alerted, but keeps the fixture honest).
function alertedState(nowMs, agoMin) {
  return { healthy: false, downSince: iso(nowMs - 5 * 60 * MIN), lastStatus: 'qr-screen',
    alerted: true, lastAlertAt: iso(nowMs - agoMin * MIN) };
}
function run(nowMs, { healthy = false, anyDeliveryTierUp = false, state = {} }) {
  return decide({ healthy, anyDeliveryTierUp, statusStr: 'qr-screen', nowMs, nowIso: iso(nowMs), state, cfg: CFG });
}

// ---- office-hours boundary (IST), the 6am / 8pm edges ------------------------------------
ok(OFFICE_START_HOUR === 6 && OFFICE_END_HOUR === 20, 'office window is 06:00-20:00 IST');
ok(istHour(istAt(6, 0)) === 6, 'istHour reads the IST wall-clock hour (fixed +05:30, no DST)');
ok(inOfficeHours(istAt(6, 0)) === true, '06:00 IST is inside office hours (open edge, inclusive)');
ok(inOfficeHours(istAt(5, 59)) === false, '05:59 IST is before office hours');
ok(inOfficeHours(istAt(19, 59)) === true, '19:59 IST is inside office hours');
ok(inOfficeHours(istAt(20, 0)) === false, '20:00 IST (8pm) is the close edge - OUTSIDE office hours (exclusive)');
ok(inOfficeHours(istAt(20, 1)) === false, '20:01 IST is after office hours');
ok(inOfficeHours(istAt(0, 0)) === false && inOfficeHours(istAt(3, 0)) === false, 'the small hours are off-hours');
ok(inOfficeHours(istAt(12, 0)) === true, 'midday IST is office hours');

// ---- delivery-tier availability: the "all numbers disconnected" mapping ------------------
{
  const SENDER = '128023';
  const active = (id, number = '9199') => ({ id, status: 'active', number });
  const downSelf = active(SENDER); downSelf.status = 'qr-screen'; downSelf.number = null;

  // an active SIBLING keeps a tier up (WA sibling DM path), even with no email/telegram configured
  const sib = deliveryTiersUp({ apiUp: true, phones: [downSelf, active('136151')], senderId: SENDER, env: {} });
  ok(sib.siblingUp === true && sib.any === true, 'an active sibling phone -> a delivery tier is up (WA sibling path)');

  // primary down, NO active sibling, NO independent tier -> genuinely nothing can deliver
  const dark = deliveryTiersUp({ apiUp: true, phones: [downSelf], senderId: SENDER, env: {} });
  ok(dark.siblingUp === false && dark.emailUp === false && dark.telegramUp === false && dark.any === false,
    'primary down + no sibling + no email/telegram -> ALL tiers down (nothing can deliver)');

  // email configured is a Maytapi-INDEPENDENT tier -> still "a tier can deliver", even with no sibling
  const email = deliveryTiersUp({ apiUp: true, phones: [downSelf], senderId: SENDER, env: { BREVO_API_KEY: 'k' } });
  ok(email.emailUp === true && email.any === true, 'email configured -> an independent delivery tier is up (no sibling needed)');

  // telegram configured is likewise an independent tier
  const tg = deliveryTiersUp({ apiUp: true, phones: [downSelf], senderId: SENDER, env: { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'c' } });
  ok(tg.telegramUp === true && tg.any === true, 'telegram configured -> an independent delivery tier is up');

  // Maytapi API unreachable: no sibling readable, but a configured email still delivers (independent)
  const apiDownEmail = deliveryTiersUp({ apiUp: false, phones: null, senderId: SENDER, env: { BREVO_API_KEY: 'k' } });
  ok(apiDownEmail.siblingUp === false && apiDownEmail.any === true,
    'Maytapi API unreachable but email configured -> still deliverable (email does not depend on Maytapi)');

  // Maytapi API unreachable AND no independent backstop -> genuinely dark
  const apiDownDark = deliveryTiersUp({ apiUp: false, phones: null, senderId: SENDER, env: {} });
  ok(apiDownDark.any === false, 'Maytapi API unreachable + no email/telegram -> ALL tiers down (total dark)');

  // a sibling that is present but NOT active (loading / no number) is not a usable tier
  const loadingSib = deliveryTiersUp({ apiUp: true, phones: [downSelf, { id: '136151', status: 'loading', number: null }], senderId: SENDER, env: {} });
  ok(loadingSib.siblingUp === false && loadingSib.any === false, 'a non-active sibling is not a usable delivery tier');

  // THIS MUST TRACK pickSiblingVia's allowlist. An active slot the picker will refuse is not a tier
  // that can deliver. When the two disagreed, siblingUp read true while the picker returned null, so
  // allTiersDown was false and a box with nothing able to deliver got the 6-hour quiet cadence
  // instead of the urgent one - the exact state the urgent cadence exists for.
  const salesOnly = deliveryTiersUp({ apiUp: true, phones: [downSelf, active('135719'), active('127918')], senderId: SENDER, env: {} });
  ok(salesOnly.siblingUp === false && salesOnly.any === false,
    'active slots that are NOT the bidder\'s are not a delivery tier - siblingUp tracks the same allowlist the picker enforces');
  const widened = deliveryTiersUp({ apiUp: true, phones: [downSelf, active('127918')], senderId: SENDER, env: { MONITOR_ALERT_FROM_PHONES: '127918' } });
  ok(widened.siblingUp === true, 'and it widens with the allowlist, so the two can never drift apart');
}

// ---- 1) ALL tiers down + OFFICE HOURS = FREQUENT (urgent) --------------------------------
{
  const now = istAt(10, 0); // mid-office
  const past = run(now, { anyDeliveryTierUp: false, state: alertedState(now, 31) });   // 31m since last alert
  ok(past.action === 'alert-still-down' && past.urgent === true && past.allTiersDown === true,
    'all tiers down + office hours + 31m since last -> URGENT repeat fires (frequent, 30m cadence)');
  const within = run(now, { anyDeliveryTierUp: false, state: alertedState(now, 20) }); // 20m since last alert
  ok(within.action === 'down-cooldown' && within.urgent === true,
    'all tiers down + office hours + only 20m since last -> still urgent, but inside the 30m cooldown -> no repeat');
}

// ---- 2) ALL tiers down + OFF HOURS = INFREQUENT (quiet) ----------------------------------
{
  const now = istAt(2, 0); // 2am - off hours
  const at31 = run(now, { anyDeliveryTierUp: false, state: alertedState(now, 31) });
  ok(at31.action === 'down-cooldown' && at31.urgent === false && at31.allTiersDown === true,
    'all tiers down but OFF hours + 31m since last -> NOT urgent, 30m does not trigger a repeat (quiet cadence)');
  const at361 = run(now, { anyDeliveryTierUp: false, state: alertedState(now, 361) });
  ok(at361.action === 'alert-still-down' && at361.urgent === false,
    'all tiers down + off hours + past the 360m quiet cooldown -> a low-frequency reminder fires');
}

// ---- 3) A TIER STILL DELIVERS = INFREQUENT regardless of hour ----------------------------
{
  const office = istAt(11, 0);
  const at31Office = run(office, { anyDeliveryTierUp: true, state: alertedState(office, 31) });
  ok(at31Office.action === 'down-cooldown' && at31Office.urgent === false && at31Office.allTiersDown === false,
    'a delivery tier still up + office hours + 31m since last -> NOT urgent (30m does not repeat) - the noise fix');
  const at31Night = run(istAt(2, 0), { anyDeliveryTierUp: true, state: alertedState(istAt(2, 0), 31) });
  ok(at31Night.action === 'down-cooldown' && at31Night.urgent === false,
    'a delivery tier still up + off hours + 31m since last -> NOT urgent either');
  const at361Office = run(office, { anyDeliveryTierUp: true, state: alertedState(office, 361) });
  ok(at361Office.action === 'alert-still-down' && at361Office.urgent === false && at361Office.allTiersDown === false,
    'a delivery tier still up, even in office hours, only re-fires at the quiet (360m) cadence');
}

// ---- FIRST alert still fires past grace in EVERY case (you are told once) ----------------
{
  // fresh outage (no prior alert), persisted past the 6m grace
  const freshPastGrace = (nowMs, anyDeliveryTierUp) => decide({
    healthy: false, anyDeliveryTierUp, statusStr: 'qr-screen', nowMs, nowIso: iso(nowMs),
    state: { healthy: false, downSince: iso(nowMs - 7 * MIN), alerted: false }, cfg: CFG,
  });
  ok(freshPastGrace(istAt(10, 0), false).action === 'alert-down', 'first alert fires: all tiers down, office hours');
  ok(freshPastGrace(istAt(2, 0), false).action === 'alert-down', 'first alert fires even at 2am when all tiers down');
  ok(freshPastGrace(istAt(11, 0), true).action === 'alert-down', 'first alert fires even when a tier is up (you still hear once)');
}

// ---- grace window: a transient blip inside grace never alerts -----------------------------
{
  const now = istAt(10, 0);
  const insideGrace = decide({ healthy: false, anyDeliveryTierUp: false, statusStr: 'loading', nowMs: now, nowIso: iso(now),
    state: { healthy: false, downSince: iso(now - 3 * MIN), alerted: false }, cfg: CFG });
  ok(insideGrace.action === 'pending-grace', 'non-active for only 3m (< 6m grace) -> pending-grace, no alert (rides out a redeploy blip)');
  const firstRunDown = decide({ healthy: false, anyDeliveryTierUp: false, statusStr: 'qr-screen', nowMs: now, nowIso: iso(now),
    state: {}, cfg: CFG });
  ok(firstRunDown.action === 'pending-grace' && firstRunDown.state.downSince === iso(now),
    'first-ever run seeing DOWN -> pending-grace and stamps downSince now (grace clock starts)');
}

// ---- recovery: announced only if a down was actually alerted -----------------------------
{
  const now = istAt(10, 0);
  const recovered = run(now, { healthy: true, state: { healthy: false, alerted: true, downSince: iso(now - MIN), lastAlertAt: iso(now - MIN) } });
  ok(recovered.action === 'alert-recovered' && recovered.state.alerted === false && recovered.state.healthy === true,
    'healthy again after a real alert -> alert-recovered, state reset to healthy');
  const rodeOut = run(now, { healthy: true, state: { healthy: false, alerted: false, downSince: iso(now - 2 * MIN) } });
  ok(rodeOut.action === 'none', 'healthy again after a rode-out blip (never alerted) -> no recovery spam');
  const steady = run(now, { healthy: true, state: { healthy: true, alerted: false } });
  ok(steady.action === 'none', 'steady healthy -> nothing');
}

// ---- office-hours boundary drives the cadence at the exact edges --------------------------
{
  // all tiers down, already alerted 31m ago: urgent (repeat) at 06:00, quiet (no repeat) at 20:00
  const open = run(istAt(6, 0), { anyDeliveryTierUp: false, state: alertedState(istAt(6, 0), 31) });
  ok(open.action === 'alert-still-down' && open.urgent === true,
    'at the 06:00 open edge, all tiers down -> urgent repeat (office hours just began)');
  const close = run(istAt(20, 0), { anyDeliveryTierUp: false, state: alertedState(istAt(20, 0), 31) });
  ok(close.action === 'down-cooldown' && close.urgent === false,
    'at the 20:00 close edge, all tiers down -> quiet (office hours are over, 30m does not repeat)');
}

// ---- the persisted state carries the fields main() writes --------------------------------
{
  const now = istAt(10, 0);
  const fired = run(now, { anyDeliveryTierUp: false, state: alertedState(now, 31) });
  ok(fired.state.alerted === true && fired.state.lastAlertAt === iso(now) && fired.state.healthy === false,
    'a fired repeat stamps lastAlertAt=now and keeps alerted/down in the next state');
  assert.strictEqual(typeof fired.state.downSince, 'string', 'downSince persists across a repeat');
}

// ==========================================================================================
// ROUND 2, ADDITION 1 - QUEUE-BACKLOG DETECTION (the queue>0-on-idle landmine)
// Maytapi accept-and-queues sends to a logged-out session and floods them on re-link. Nothing was
// watching queue depth, so 128023 sat idle with 17 queued customer-group summaries on 2026-07-24/25
// invisibly. These pin the product-level /queues read + its cadence (all pure, no network).
// ==========================================================================================

// ---- queueDepthOf: read the product /queues depth, robust to the shapes the API has shown -------
ok(queueDepthOf({ queue: 17 }) === 17, 'queueDepthOf reads the product-level `queue` integer (128023 idle -> 17)');
ok(queueDepthOf({ queue: 0 }) === 0, 'queueDepthOf: queue 0 is a clean slot');
ok(queueDepthOf({ stats: { sending: 17 } }) === 17, 'queueDepthOf falls back to the per-phone stats.sending shape');
ok(queueDepthOf({ stats: { sending: 0 } }) === 0, 'queueDepthOf: the flushed-clean {stats:{sending:0}} reads 0');
ok(queueDepthOf({ queue: ['a', 'b', 'c'] }) === 3, 'queueDepthOf: an array queue is measured by length');
ok(queueDepthOf({ queued: 5 }) === 5, 'queueDepthOf: the `queued` alias is honoured');
ok(queueDepthOf({}) === 0 && queueDepthOf(null) === 0, 'queueDepthOf: empty/garbled -> 0 (no false backlog)');

// ---- queueOffenders: the exact live 2026-07-25 board (flush-incident section 4) -----------------
{
  // product /queues rows, mirrored from the live capture
  const queues = [
    { id: '147227', status: 'active', queue: 0 },
    { id: '128023', status: 'idle', queue: 17 },   // the group sender, logged out - the landmine
    { id: '136151', status: 'active', queue: 0 },
    { id: '126187', status: 'disabled', queue: 0 },
  ];
  const phones = [
    { id: '147227', status: 'active', number: '9199' },
    { id: '128023', status: 'idle', number: null },
    { id: '136151', status: 'active', number: '9199' },
    { id: '126187', status: 'disabled', number: null },
  ];
  const off = queueOffenders({ queues, phones, senderId: '128023' });
  ok(off.length === 1 && off[0].id === '128023' && off[0].queue === 17 && off[0].isSender === true,
    'queueOffenders flags exactly the idle sender 128023 with its 17-message backlog');
}
// queue>0 on an ACTIVE phone is normal in-flight traffic that drains on its own - not an offender
{
  const off = queueOffenders({ queues: [{ id: '136151', status: 'active', queue: 4 }],
    phones: [{ id: '136151', status: 'active', number: '9199' }], senderId: '128023' });
  ok(off.length === 0, 'queue>0 on an ACTIVE phone drains on its own -> not an offender');
}
// queue>0 on a disabled / non-active phone IS an offender (it flushes if ever re-enabled)
{
  const off = queueOffenders({ queues: [{ id: '126187', status: 'disabled', queue: 9 }],
    phones: [{ id: '126187', status: 'disabled', number: null }], senderId: '128023' });
  ok(off.length === 1 && off[0].id === '126187' && off[0].queue === 9, 'queue>0 on a disabled phone is a backlog offender');
}
// status is taken from the authoritative listPhones board when the /queues row omits it
{
  const off = queueOffenders({ queues: [{ id: '128023', queue: 3 }],
    phones: [{ id: '128023', status: 'qr-screen', number: null }], senderId: '128023' });
  ok(off.length === 1 && off[0].status === 'qr-screen', 'offender status is joined from the listPhones board when /queues omits it');
}
// fail-safe: a null / garbled /queues payload yields no offenders (a read glitch is not a backlog)
ok(queueOffenders({ queues: null, phones: [], senderId: '128023' }).length === 0,
  'a null /queues payload -> no offenders (read glitch never raises a false alarm)');

// ---- decideQueueAlert: tell once on detection, then only every quiet cooldown --------------------
{
  const now = istAt(10, 0);
  const offenders = [{ id: '128023', queue: 17, status: 'idle', isSender: true }];
  const first = decideQueueAlert({ offenders, nowMs: now, nowIso: iso(now), state: {}, cfg: CFG });
  ok(first.action === 'queue-alert' && first.state.active === true && first.state.depth === 17,
    'first time a backlog is seen -> queue-alert fires (told once, promptly)');
  const within = decideQueueAlert({ offenders, nowMs: now, nowIso: iso(now),
    state: { queue: { active: true, lastAlertAt: iso(now - 30 * MIN) } }, cfg: CFG });
  ok(within.action === 'queue-cooldown', 'a persisting backlog within the quiet cooldown -> no repeat (no cron-tick spam)');
  const past = decideQueueAlert({ offenders, nowMs: now, nowIso: iso(now),
    state: { queue: { active: true, lastAlertAt: iso(now - 361 * MIN) } }, cfg: CFG });
  ok(past.action === 'queue-alert-still', 'a backlog past the quiet cooldown -> a low-frequency reminder fires');
  const cleared = decideQueueAlert({ offenders: [], nowMs: now, nowIso: iso(now),
    state: { queue: { active: true, lastAlertAt: iso(now - 10 * MIN) } }, cfg: CFG });
  ok(cleared.action === 'queue-cleared' && cleared.state.active === false, 'backlog cleared -> state resets, no alert');
  const quiet = decideQueueAlert({ offenders: [], nowMs: now, nowIso: iso(now), state: {}, cfg: CFG });
  ok(quiet.action === 'none' && quiet.state.active === false, 'no backlog and none before -> nothing');
}

// ==========================================================================================
// ROUND 2, ADDITION 2 - MONITOR_ALERT_VIA_PHONE must be an ACTIVE sibling before we send through it
// Latent risk (breaker-coverage-gap diagnosis): the override was trusted blindly, so a pinned-but-
// logged-out sibling would blind-QUEUE the alert onto a dead phone - the very accept-and-queue hazard
// this monitor exists to catch. pickSiblingVia() now re-verifies the pinned phone is active, else
// falls back to auto-pick, else returns null (WA tier skipped; email is the independent backstop).
// ==========================================================================================
{
  const SENDER = '128023';
  const active = (id, number = '9199') => ({ id, status: 'active', number });
  const dead = (id) => ({ id, status: 'qr-screen', number: null });
  const down = dead(SENDER);

  // no override, an active sibling exists -> auto-pick it (unchanged behaviour)
  ok(pickSiblingVia([down, active('136151')], SENDER, '') === '136151',
    'no override -> auto-pick the active sibling');
  // override names an ACTIVE, ALLOWED sibling -> honour it
  ok(pickSiblingVia([down, active('136151'), active('127918')], SENDER, '136151') === '136151',
    'override naming an active allowed sibling -> use the override');
  // THE FIX: override names a DEAD sibling -> do NOT use it; fall back to an active sibling
  ok(pickSiblingVia([down, dead('127918'), active('136151')], SENDER, '127918') === '136151',
    'override naming a DEAD sibling -> fall back to auto-pick (never blind-queue onto a logged-out phone)');

  // ---- ALERTS ONLY EVER SPEAK AS THE BIDDER (Sushant, 2026-09-23) ----
  // BRL's product holds seven slots and most are sales lines. Auto-pick took the first ACTIVE one in
  // board order - 135719, a sales number - and the director asked why bidder alerts arrived from it.
  ok(pickSiblingVia([active('135719'), down, active('136151')], SENDER, '') === '136151',
    'auto-pick SKIPS an active sales slot that sits earlier on the board and takes the bidder fallback');
  ok(pickSiblingVia([down, active('127918'), active('135719')], SENDER, '') === null,
    'and when the only active siblings are sales lines it picks NONE - the WA tier goes dark and email carries it');
  ok(pickSiblingVia([down, active('127918')], SENDER, '127918') === null,
    'an override naming a non-bidder slot is refused too, so the knob cannot reintroduce the wrong identity');
  ok(pickSiblingVia([down, active('127918')], SENDER, '127918', { MONITOR_ALERT_FROM_PHONES: '127918' }) === '127918',
    'MONITOR_ALERT_FROM_PHONES is what widens it - the allowlist is config, not a hardcode');
  ok(pickSiblingVia([down, active('136151')], SENDER, '', { MONITOR_ALERT_FROM_PHONES: ' 136151 , 128023 ' }) === '136151',
    'and the allowlist tolerates spaces around its entries');
  // override names the DOWN sender itself -> reject, fall back to a real sibling
  ok(pickSiblingVia([down, active('136151')], SENDER, SENDER) === '136151',
    'override naming the down sender -> reject and auto-pick a real sibling');
  // override dead AND no other active sibling -> null (WA tier skipped; email backstops)
  ok(pickSiblingVia([down, dead('127918')], SENDER, '127918') === null,
    'override dead and no active sibling anywhere -> null (skip WA tier, email is the backstop)');
  // no override and no active sibling -> null
  ok(pickSiblingVia([down], SENDER, '') === null, 'no override and no active sibling -> null');
  // a non-array board never throws
  ok(pickSiblingVia(null, SENDER, '') === null, 'a null board -> null (no throw)');
}

// ---- alert-copy time formatting ------------------------------------------------------------
// The down-alerts used to print the raw ISO instant off the state file, which is UTC - so it read
// 5.5 hours off the clock of the person holding the sender handset. These two are pure and are the
// only new logic behind that copy, so they are pinned here rather than only through the end-to-end
// alert-text suite.
{
  // The exact instant from the 2026-08-06 outage: 10:10:02Z is 15:40 IST the same day.
  ok(istStamp('2026-08-06T10:10:02.866Z') === '06 Aug, 15:40 IST',
    'a UTC instant renders as IST wall time, not the raw Z string');
  // The +05:30 shift crosses midnight, which is where a naive UTC-date read prints yesterday.
  ok(istStamp('2026-08-06T19:30:00.000Z') === '07 Aug, 01:00 IST',
    'an evening-UTC instant rolls forward to the NEXT IST date (the boundary a UTC read gets wrong)');
  ok(istStamp('2026-01-09T04:00:00.000Z') === '09 Jan, 09:30 IST', 'single-digit day and month stay zero-padded and named');
  // An unparseable value must never become 'Invalid Date' or NaN in front of an operator.
  ok(istStamp('not-a-date') === 'not-a-date', 'an unparseable timestamp falls back to the raw value rather than printing Invalid Date');
  ok(istStamp(undefined) === 'undefined', 'a missing timestamp does not throw');

  ok(humanDuration(14) === '14m', 'sub-hour outages stay in minutes');
  ok(humanDuration(59) === '59m', '59 minutes is still minutes');
  ok(humanDuration(60) === '1h', 'exactly an hour drops the zero-minute tail');
  ok(humanDuration(194) === '3h 14m', 'a multi-hour outage is split so nobody divides 194 by 60 mid-outage');
  ok(humanDuration(120) === '2h', 'a whole number of hours reads as hours only');
  ok(humanDuration(0) === 'under a minute', 'a zero-minute outage is words, never "0m"');
  ok(humanDuration(NaN) === 'under a minute', 'a NaN duration degrades to words rather than printing NaN');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
