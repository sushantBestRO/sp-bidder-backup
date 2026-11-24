'use strict';

/**
 * Structured operational logger for `pm2 logs bid-command` on the VPS.
 *
 * Before this module existed, an ad hoc `log(msg)` callback was threaded through the
 * codebase via constructor injection (customerStore, personStore, assignmentStore,
 * discovery, snipeHarness, the price-request store, the bid logger, and others), but
 * only the copy built in src/web/server.js actually called console.log - most of the
 * other copies only pushed into the dashboard's in-memory event ring buffer, so almost
 * nothing the app did at runtime ever reached stdout/stderr. createLogger(moduleName)
 * is a drop-in replacement at every one of those call sites: a caller that only ever
 * does `log('some message')` keeps working unchanged (that call is treated as info),
 * while a caller that wants to be explicit about severity can call .debug/.info/.warn/
 * .error directly on the same function object.
 *
 * Output is one JSON line per call - time (ISO 8601), level, module, msg, plus whatever
 * extra fields the caller passes as `meta` - so `pm2 logs` stays greppable/parseable
 * instead of free-text. Routing follows the Node/PM2 convention: debug/info go to
 * console.log (captured to data/logs/pm2-out.log), warn/error go to console.error
 * (data/logs/pm2-err.log). That error-log file barely gets used today - only two call
 * sites in the whole codebase reach console.warn/console.error at all - so this is
 * effectively the first real use it sees.
 */

// Severity order, low to high. 'silent' sits above 'error' so nothing at any real level
// ever clears the gate once silent is selected - there is no message level literally
// named 'silent' to log at.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Reads process.env directly rather than going through src/config.js: config.js builds
// its whole exported object (including things like the operator password hash) from
// process.env at require time, so anything this module pulled in transitively would
// freeze that object's values the first time ANY file requires this logger - including
// test scripts that require a narrow helper (e.g. adminAuth's hashPassword) before they've
// finished setting up their own test env vars. A leaf logging utility has no business
// forcing that evaluation order on its callers, so it stays a self-contained env read.
// Checked fresh on every call (not cached) so a level set/changed mid-process takes effect
// immediately; an unrecognized value falls back to 'info' rather than logging everything
// or nothing.
function currentThreshold() {
  const configured = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[configured] != null ? LEVELS[configured] : LEVELS.info;
}

// `JSON.stringify(new Error('x'))` serializes to '{}' - message/stack/code are all
// non-enumerable on a native Error - which would silently swallow the one piece of a log
// line an operator most needs when diagnosing a crash. Expand it into plain, enumerable
// fields instead of passing the Error instance straight to JSON.stringify.
function expandError(err) {
  return { message: err.message, stack: err.stack, code: err.code };
}

// A logging call must never be the thing that crashes the process. `meta` is caller-
// supplied and can legitimately contain a circular reference or a value JSON.stringify
// rejects (a BigInt, for instance); when that happens, fall back to a minimal line that
// still carries the level/module/msg - the part that actually matters for diagnosis -
// instead of losing the log line (or the process) entirely.
function safeStringify(record) {
  try {
    return JSON.stringify(record);
  } catch (_) {
    return JSON.stringify({
      time: record.time, level: record.level, module: record.module, msg: record.msg,
      note: 'meta omitted (not JSON-serializable)',
    });
  }
}

function emit(moduleName, level, msg, meta, opts) {
  if (!(opts && opts.force) && LEVELS[level] < currentThreshold()) return;
  const record = { time: new Date().toISOString(), level, module: moduleName, msg };
  if (meta && typeof meta === 'object') {
    Object.assign(record, meta);
    if (meta.err instanceof Error) record.err = expandError(meta.err);
  }
  const line = safeStringify(record);
  if (level === 'warn' || level === 'error') console.error(line);
  else console.log(line);
}

/**
 * Builds a logger scoped to one module. The returned function is callable directly -
 * `log(msg)` or `log(msg, meta)`, treated as info, matching the ad hoc `log(msg)` shape
 * used throughout the codebase before this - and also exposes .debug/.info/.warn/.error
 * for a caller that wants a specific level. Every path is wrapped so a bad `meta` (or
 * any other unexpected failure) can never propagate out of a logging call.
 */
function createLogger(moduleName) {
  function safeEmit(level, msg, meta, opts) {
    try { emit(moduleName, level, msg, meta, opts); } catch (_) { /* logging must never throw */ }
  }
  const log = (msg, meta) => safeEmit('info', msg, meta);
  log.debug = (msg, meta) => safeEmit('debug', msg, meta);
  log.info = (msg, meta) => safeEmit('info', msg, meta);
  log.warn = (msg, meta) => safeEmit('warn', msg, meta);
  log.error = (msg, meta) => safeEmit('error', msg, meta);
  // Bypasses the LOG_LEVEL gate entirely - for the handful of advisories (auth-off,
  // multi-account allowlist overlap) that predate this module and were deliberately
  // unconditional console.warn() calls; a LOG_LEVEL=error deployment must not be able
  // to silence them the way a normal .warn() call now can be.
  log.force = (msg, meta) => safeEmit('warn', msg, meta, { force: true });
  return log;
}

// Shared DI-fallback shim: several constructor-injected `log` seams (DiscoveryPoller,
// Notifier, WhatsAppClient) accept either a full createLogger() instance (.debug/.info/
// .warn/.error alongside the bare call) or the legacy plain `(msg) => {}` callback with
// none of those methods. Route through the richer level method when it's actually there
// so severity shows up correctly in `pm2 logs`; otherwise fall back to the plain call so
// a caller that hasn't been migrated to the richer logger is never broken by this
// reaching for a method it doesn't have.
function logAt(log, level, msg, meta) {
  if (log && typeof log[level] === 'function') log[level](msg, meta);
  else if (log) log(msg);
}

module.exports = { createLogger, logAt };
