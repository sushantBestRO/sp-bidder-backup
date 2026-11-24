'use strict';
/**
 * src/logging/logger.js: the module every other subsystem's log lines flow through, with
 * a documented "logging must never crash the process" invariant that was previously
 * comment-only. Covers: safeStringify resilience (circular ref / BigInt), the LOG_LEVEL
 * gate matrix (including the unrecognized-value fallback), Error serialization, stdout vs
 * stderr routing, the force() bypass used by the auth-off / allowlist-overlap advisories,
 * and the standalone logAt() DI-fallback shim shared by DiscoveryPoller/Notifier/WhatsAppClient.
 */
const { createLogger, logAt } = require('../src/logging/logger');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// Captures every console.log/console.error call made while `fn` runs, then restores both -
// run-tests.js spawns each test-*.js as its own subprocess, so clobbering the globals here
// never leaks into another test file.
function captureConsole(fn) {
  const outLines = [], errLines = [];
  const origLog = console.log, origError = console.error;
  console.log = (line) => outLines.push(line);
  console.error = (line) => errLines.push(line);
  try { fn(); } finally { console.log = origLog; console.error = origError; }
  return { outLines, errLines };
}

function withLogLevel(level, fn) {
  const prev = process.env.LOG_LEVEL;
  if (level == null) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = level;
  try { return fn(); } finally { if (prev == null) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev; }
}

// ---- safeStringify resilience: a bad `meta` must never crash the logging call ----
{
  const circular = {};
  circular.self = circular;
  const { outLines } = withLogLevel('info', () => captureConsole(() => {
    const log = createLogger('test');
    log.info('circular meta', { a: circular });
  }));
  ok(outLines.length === 1, 'circular-ref meta: exactly one line emitted, call does not throw');
  let parsed;
  try { parsed = JSON.parse(outLines[0]); } catch (_) { /* checked below */ }
  ok(!!parsed && parsed.level === 'info' && parsed.module === 'test' && parsed.msg === 'circular meta',
    'circular-ref meta: fallback line is valid JSON carrying level/module/msg');
  ok(!!parsed && parsed.note && /not JSON-serializable/.test(parsed.note), 'circular-ref meta: fallback line notes the omission');
}

{
  const { outLines } = withLogLevel('info', () => captureConsole(() => {
    const log = createLogger('test');
    log.info('bigint meta', { n: 10n });
  }));
  ok(outLines.length === 1, 'BigInt meta: exactly one line emitted, call does not throw');
  let parsed;
  try { parsed = JSON.parse(outLines[0]); } catch (_) { /* checked below */ }
  ok(!!parsed && parsed.msg === 'bigint meta', 'BigInt meta: fallback line still carries the message');
}

// ---- level-gate matrix ----
{
  const cases = [
    ['debug', { debug: true, info: true, warn: true, error: true }],
    ['info', { debug: false, info: true, warn: true, error: true }],
    ['warn', { debug: false, info: false, warn: true, error: true }],
    ['error', { debug: false, info: false, warn: false, error: true }],
    ['silent', { debug: false, info: false, warn: false, error: false }],
    // unrecognized value must fall back to 'info', not "log everything" or "log nothing"
    ['garbage', { debug: false, info: true, warn: true, error: true }],
  ];
  for (const [level, expect] of cases) {
    const { outLines, errLines } = withLogLevel(level, () => captureConsole(() => {
      const log = createLogger('test');
      log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    }));
    const fired = { debug: false, info: false, warn: false, error: false };
    for (const line of [...outLines, ...errLines]) {
      const p = JSON.parse(line);
      fired[p.level] = true;
    }
    for (const lvl of ['debug', 'info', 'warn', 'error']) {
      ok(fired[lvl] === expect[lvl], `LOG_LEVEL=${level}: ${lvl} call ${expect[lvl] ? 'reaches' : 'is suppressed from'} console (got ${fired[lvl]})`);
    }
  }
}

{
  // unset entirely (no env var at all) must behave the same as the documented default, 'info'
  const { outLines, errLines } = withLogLevel(null, () => captureConsole(() => {
    const log = createLogger('test');
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
  }));
  const levels = [...outLines, ...errLines].map((l) => JSON.parse(l).level).sort();
  ok(JSON.stringify(levels) === JSON.stringify(['error', 'info', 'warn'].sort()), 'unset LOG_LEVEL defaults to info (debug suppressed, info/warn/error fire)');
}

// ---- expandError: Error in meta.err must serialize to {message,stack,code}, not {} ----
{
  const err = new Error('boom');
  err.code = 'EBOOM';
  const { errLines } = withLogLevel('info', () => captureConsole(() => {
    const log = createLogger('test');
    log.error('op failed', { err });
  }));
  ok(errLines.length === 1, 'Error in meta.err: one line emitted');
  const parsed = JSON.parse(errLines[0]);
  ok(parsed.err && parsed.err.message === 'boom', 'expandError: message survives');
  ok(parsed.err && typeof parsed.err.stack === 'string' && parsed.err.stack.length > 0, 'expandError: stack survives');
  ok(parsed.err && parsed.err.code === 'EBOOM', 'expandError: code survives');
}

// ---- stream routing: debug/info -> console.log (stdout); warn/error -> console.error (stderr) ----
{
  const { outLines, errLines } = withLogLevel('debug', () => captureConsole(() => {
    const log = createLogger('test');
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
  }));
  ok(outLines.length === 2, 'debug/info route to console.log (stdout)');
  ok(errLines.length === 2, 'warn/error route to console.error (stderr)');
  ok(outLines.every((l) => ['debug', 'info'].includes(JSON.parse(l).level)), 'stdout lines are only debug/info');
  ok(errLines.every((l) => ['warn', 'error'].includes(JSON.parse(l).level)), 'stderr lines are only warn/error');
}

// ---- force(): bypasses LOG_LEVEL entirely, for the auth-off / allowlist-overlap advisories ----
{
  const { outLines, errLines } = withLogLevel('silent', () => captureConsole(() => {
    const log = createLogger('test');
    log.warn('should be suppressed');
    log.force('should always fire');
  }));
  ok(outLines.length === 0, 'force(): a normal .warn() is still suppressed at LOG_LEVEL=silent');
  ok(errLines.length === 1, 'force(): the forced line still reaches console.error even at LOG_LEVEL=silent');
  const parsed = JSON.parse(errLines[0]);
  ok(parsed.msg === 'should always fire' && parsed.level === 'warn', 'force(): forced line carries the message at warn severity');
}

// ---- bare log(msg) call (the ad hoc pre-migration callback shape) is treated as info ----
{
  const { outLines } = withLogLevel('info', () => captureConsole(() => {
    const log = createLogger('test');
    log('bare call');
  }));
  ok(outLines.length === 1 && JSON.parse(outLines[0]).level === 'info', 'bare log(msg) call (no level method) is treated as info');
}

// ---- logAt(): the shared DI-fallback shim (DiscoveryPoller/Notifier/WhatsAppClient all
// delegate their private _logAt/_emit methods to this exact function) ----
{
  // richer logger injected -> routes through the level method, meta preserved
  const { outLines } = withLogLevel('info', () => captureConsole(() => {
    const richLog = createLogger('consumer');
    logAt(richLog, 'info', 'via level method', { extra: 1 });
  }));
  ok(outLines.length === 1, 'logAt(): with a rich logger injected, the call reaches console');
  const parsed = JSON.parse(outLines[0]);
  ok(parsed.msg === 'via level method' && parsed.extra === 1, 'logAt(): routes through the level method, meta preserved');
}

{
  // plain ad hoc `(msg) => {}` callback injected (no .info/.warn/etc) -> falls back to a bare call
  const calls = [];
  const plainLog = (msg) => calls.push(msg);
  logAt(plainLog, 'warn', 'via bare fallback', { extra: 2 });
  ok(calls.length === 1 && calls[0] === 'via bare fallback', 'logAt(): with a plain (msg)=>{} callback, falls back to the bare call (meta dropped, message preserved)');
}

{
  // no logger injected at all (constructor default `log = () => {}` covers this in practice,
  // but logAt() itself must never throw if a caller ever passes a falsy log)
  let threw = false;
  try { logAt(null, 'info', 'no logger'); } catch (_) { threw = true; }
  ok(!threw, 'logAt(): a falsy log arg never throws');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
