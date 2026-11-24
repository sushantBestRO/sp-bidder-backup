'use strict';

const { createLogger } = require('../logging/logger');

/**
 * Shared "run X once a day at HH:MM IST" rail - the scheduling half of the daily
 * heartbeat (src/notify/heartbeat.js), extracted verbatim when the per-customer
 * EOD report needed the identical shape. Both features keep their own collectors,
 * renderers and state docs; only the clockwork lives here, so the two can never
 * drift on the parts that were hard to get right (the IST math, the missed-fire
 * catch-up, the unref discipline).
 *
 * Scheduling is the house timer pattern (a self-rescheduling setTimeout, unref'd -
 * see the token-expiry interval in server.js; no cron library exists in this
 * codebase and none is added). IST is a fixed +05:30 offset (IST has no DST, so
 * the offset is exact) rather than the box's own timezone - the readers live in
 * IST; the VPS may not.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60000; // UTC+05:30, fixed - IST has no DST
const DAY_MS = 86400000;

// ASCII day/month names - never locale-dependent (a VPS with a non-English locale
// must not change what a reader sees, and code strings stay ASCII-only).
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Epoch ms of 00:00 IST on the IST calendar day containing `ms`. */
function istMidnight(ms) {
  const d = new Date(ms + IST_OFFSET_MS); // shift so getUTC* reads IST wall-clock parts
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS;
}

/** 'YYYY-MM-DD' of the IST calendar day containing `ms` - the sentDate dedupe key. */
function istDayStamp(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** 'Wed 16 Jul' - the human date used in message bodies. */
function istDisplayDate(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** 'YYYY-MM' of the IST calendar month containing `ms` - a month-bucketing key, same
 *  UTC+05:30 shift as istDayStamp so a load near midnight IST never lands in the wrong
 *  month just because its epoch ms is still the previous UTC day. */
function istMonthStamp(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}`;
}

/**
 * Parse 'HH:MM' (IST) -> {h, m}. Anything unparseable falls back to the caller's
 * default slot rather than throwing - a typo'd env var must degrade to "the task
 * at its default time", never to "no task" (same fail-safe direction as config.js).
 */
function parseTimeIST(s, fallback = { h: 8, m: 0 }) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return { h, m: mi };
}

/** Epoch ms of the next occurrence of HH:MM IST strictly after `now`. */
function nextRunAt(now, { h, m }) {
  let t = istMidnight(now) + (h * 60 + m) * 60000;
  if (t <= now) t += DAY_MS;
  return t;
}

/** Epoch ms of the most recent occurrence of HH:MM IST at-or-before `now` - the
 *  natural end of a rolling slot-to-slot day window (EOD reports). */
function lastRunAt(now, { h, m }) {
  let t = istMidnight(now) + (h * 60 + m) * 60000;
  if (t > now) t -= DAY_MS;
  return t;
}

// Boot catch-up window: a process that starts within this long AFTER the slot, on a
// day whose send never happened, fires immediately - a deploy or PM2 restart that
// swallowed the scheduled fire must not cost the day's message.
const CATCHUP_WINDOW_MS = 60 * 60000;

/**
 * Start a daily HH:MM-IST task. Returns { stop() }; null when disabled.
 *
 *   label            - logger module name ('heartbeat', 'eodReport') - log lines only.
 *   enabled          - config gate; false logs the skip and starts nothing.
 *   timeIST          - 'HH:MM' string (env-sourced); unparseable -> defaultTime.
 *   defaultTime      - {h, m} fallback slot (each feature has its own natural hour).
 *   alreadyDoneToday - async (now) => bool; the catch-up's dedupe (each feature reads
 *                      its own state doc's sentDate). A throw reads as "not done" -
 *                      an unreadable state doc must err on the side of sending.
 *   run              - async () => void; the task body. Its own layered fallbacks
 *                      are the feature's job; a throw here is caught and logged so
 *                      the schedule chain never dies.
 */
function startDailyISTTask({ label, enabled, timeIST, defaultTime, alreadyDoneToday, run }) {
  const log = createLogger(label);
  if (!enabled) {
    log.info(`daily ${label} disabled by config`);
    return null;
  }
  const time = parseTimeIST(timeIST, defaultTime);
  const handle = { stopped: false, timer: null, stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); } };

  const schedule = () => {
    if (handle.stopped) return;
    const now = Date.now();
    const at = nextRunAt(now, time);
    handle.timer = setTimeout(async () => {
      try { await run(); } catch (e) { log.error(`${label} run failed`, { err: e }); }
      schedule();
    }, at - now);
    if (handle.timer.unref) handle.timer.unref();
    log.info(`daily ${label} scheduled for ${new Date(at).toISOString()} (${String(time.h).padStart(2, '0')}:${String(time.m).padStart(2, '0')} IST)`);
  };
  schedule();

  // fire-and-forget: catch-up must never delay or fail boot.
  (async () => {
    try {
      const now = Date.now();
      const todaySlot = istMidnight(now) + (time.h * 60 + time.m) * 60000;
      if (now < todaySlot || now >= todaySlot + CATCHUP_WINDOW_MS) return;
      let done = false;
      try { done = !!(await alreadyDoneToday(now)); } catch (_) { /* unreadable state -> send */ }
      if (done) return;
      log.info(`${label} catch-up: the scheduled send was missed (restart/deploy at send time) - sending now`);
      await run();
    } catch (e) {
      log.error(`${label} catch-up failed`, { err: e });
    }
  })();

  return handle;
}

module.exports = {
  IST_OFFSET_MS, DAY_MS, CATCHUP_WINDOW_MS,
  istMidnight, istDayStamp, istDisplayDate, istMonthStamp, parseTimeIST, nextRunAt, lastRunAt,
  startDailyISTTask,
};
