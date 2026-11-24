'use strict';
/**
 * Edge-hardening regression for the two INPUT SEAMS the rank-driven-rungs feature added:
 *
 *   1) src/model/loadRules.js  deriveLoadRules().minDecrement  <- platform wire field loadBidDifference
 *   2) src/config.js           engine.rungCap / softClose.jumpPerRival / softClose.establishLeadMs
 *                              <- operator env vars (read ONCE at require time)
 *
 * This is where PLATFORM WIRE DATA and OPERATOR ENV enter the pricing math. SuperProcure has already
 * shipped junk (year-2100 close times, string numerics); an un-bound-checked value here poisons ladder
 * math downstream (NaN rungs, sub-decrement bids SP 400s, a 0-rung ladder). These tests pin exactly
 * what each seam does with the ugly inputs.
 *
 * deriveLoadRules is a pure function of its arg (reads no env) -> exercised in-process. The config
 * knobs are read at REQUIRE time, so each case is probed in a CHILD node process with a controlled
 * env: an in-process re-require + process.env mutation would lie (the require cache is warm). Values
 * are carried across the process boundary TAGGED (String + isNaN + isNull) because JSON.stringify(NaN)
 * === 'null' would erase the exact NaN-vs-null distinction these seams exist to guard.
 *
 * Offline, deterministic, no network. One assertion per named behavior; each carries the mutant it
 * catches. A known seam bug (junk loadBidDifference -> NaN escapes) is characterized here with a
 * fix-surviving invariant and pinned sharply in the quarantined companion:
 *   docs/tests/quarantine/test-loadrules-mindecrement-nan-escape.js
 *
 *   node scripts/test-loadrules-config-edges.js
 */
const assert = require('assert');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { deriveLoadRules } = require('../src/model/loadRules');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

// ---- config child-process probe (require-time env read) ----------------------------------------
const CONFIG_PATH = path.join(__dirname, '..', 'src', 'config.js');
// The child requires config.js under a controlled env and emits the three knobs TAGGED. tag() keeps
// String(x) so NaN ('NaN') is distinguishable from null ('null') and 0 ('0') after JSON round-trip,
// plus explicit nan/isNull booleans so no assertion has to rely on the lossy JSON encoding of NaN.
const PROBE = [
  'const c = require(' + JSON.stringify(CONFIG_PATH) + ');',
  'const tag = (x) => ({ s: String(x), t: typeof x, nan: (typeof x === "number" && Number.isNaN(x)), isNull: x === null });',
  'process.stdout.write(JSON.stringify({',
  '  rungCap: tag(c.engine.rungCap),',
  '  jumpPerRival: tag(c.softClose.jumpPerRival),',
  '  establishLeadMs: tag(c.softClose.establishLeadMs),',
  '}));',
].join('\n');

// Probe config.js in a fresh child with `overrides` layered onto a base env that has the three knobs
// STRIPPED, so an "env absent" case is truly absent even if the parent shell exported one. cwd is a
// scratch dir so no repo .env is picked up by config.js's optional dotenv.config().
function probeConfig(overrides) {
  const env = Object.assign({}, process.env);
  delete env.SP_RUNG_CAP;
  delete env.SP_SOFT_JUMP_PER_RIVAL;
  delete env.SP_SOFT_ESTABLISH_LEAD_MS;
  Object.assign(env, overrides || {});
  const r = spawnSync(process.execPath, ['-e', PROBE], { env, encoding: 'utf8', cwd: os.tmpdir(), timeout: 20000 });
  assert.strictEqual(r.status, 0, 'config probe child exited clean (status 0); stderr=' + (r.stderr || ''));
  return JSON.parse(String(r.stdout).trim());
}

try {
  // ================================================================================================
  // PART 1 - deriveLoadRules().minDecrement  <- SuperProcure wire field loadBidDifference (line 70)
  //   minDecrement: l.loadBidDifference != null ? Number(l.loadBidDifference) : null
  // ================================================================================================

  // B1 bid_diff_present: a real numeric wire value is carried through as a Number.
  {
    // Arrange
    const load = { id: 'L1', loadBidDifference: 100 };
    // Act
    const rules = deriveLoadRules(load);
    // Assert - expected 100 because spec: loadBidDifference present -> Number(loadBidDifference).
    // strict === 100 also fails a String(x) mutant (would be '100' !== 100).
    // catches: constant replaced (100->0), default swap (->null), Number->String coercion swap.
    ok(rules.minDecrement === 100, 'B1 loadBidDifference=100 -> minDecrement === 100 (Number)');
  }

  // B2 bid_diff_string: the wire sometimes sends numeric STRINGS - the seam must coerce to a number.
  {
    // Arrange
    const load = { id: 'L2', loadBidDifference: '250' };
    // Act
    const rules = deriveLoadRules(load);
    // Assert - expected 250 (Number('250')); strict === also pins the Number TYPE, since the string
    // passthrough '250' !== the number 250.
    // catches: dropped Number() coercion (F2 - string leaks through instead of becoming a number).
    ok(rules.minDecrement === 250, 'B2 loadBidDifference="250" -> 250 as a Number (string coerced)');
  }

  // B3 bid_diff_null: an explicit null wire value -> null (the "no per-load decrement" signal).
  {
    // Arrange
    const load = { id: 'L3', loadBidDifference: null };
    // Act
    const rules = deriveLoadRules(load);
    // Assert - expected null: `!= null` excludes null, so it is NOT run through Number(null)===0.
    // catches: `!= null` -> `!== undefined` mutant (would let null reach Number(null) and store 0);
    //          default swap (null -> 0). === null fails for both 0 and NaN.
    ok(rules.minDecrement === null, 'B3 loadBidDifference=null -> minDecrement === null (not 0)');
  }

  // B4 bid_diff_undefined: the field is absent -> null (engine falls back to caps.minDecrement).
  {
    // Arrange
    const load = { id: 'L4' }; // loadBidDifference absent
    // Act
    const rules = deriveLoadRules(load);
    // Assert - expected null: `undefined != null` is false. This is the documented fallback signal.
    // catches: default swap (null -> 0 or NaN); truthy/`!= null` guard dropped.
    ok(rules.minDecrement === null, 'B4 loadBidDifference absent -> minDecrement === null');
  }

  // B5 bid_diff_zero: 0 is a REAL platform value meaning "no gap rule" - it must be KEPT, not nulled.
  {
    // Arrange
    const load = { id: 'L5', loadBidDifference: 0 };
    // Act
    const rules = deriveLoadRules(load);
    // Assert - expected 0: `0 != null` is TRUE, so Number(0)===0 is stored. === 0 fails for null.
    // catches: truthy/falsy collapse - a `l.loadBidDifference ? Number(x) : null` mutant would turn
    //          the real value 0 into null. This is the single most discriminating minDecrement case.
    ok(rules.minDecrement === 0, 'B5 loadBidDifference=0 -> minDecrement === 0 (kept, NOT collapsed to null)');
  }

  // B6 bid_diff_junk: a non-numeric string. ACTUAL: Number('abc') === NaN escapes the seam (a real
  // bug; the sharp desired-behavior assertion lives in the quarantined companion and FAILS today).
  {
    // Arrange
    const load = { id: 'L6', loadBidDifference: 'abc' };
    // Act
    const rules = deriveLoadRules(load);
    // Assert - fix-surviving invariant: junk must NEVER become a usable POSITIVE gap. Holds for the
    // current NaN AND a future null/0 fix; still fails if the impl ever stored a wrong finite >0.
    // catches: a mutant that coerces junk into a positive decrement (e.g. `|| 100`). The NaN-escape
    //          itself is pinned in docs/tests/quarantine/test-loadrules-mindecrement-nan-escape.js.
    const v = rules.minDecrement;
    ok(!(Number.isFinite(v) && v > 0), 'B6 loadBidDifference="abc" never yields a usable positive gap (null|NaN|0 only)');
  }

  // B7 bid_diff_negative: a negative wire value. ACTUAL: the seam passes the sign through unchanged
  // (no abs, no clamp). Downstream owns sign handling; the seam does not silently flip it positive.
  {
    // Arrange
    const load = { id: 'L7', loadBidDifference: -50 };
    // Act
    const rules = deriveLoadRules(load);
    // Assert - expected -50; === -50 also fails a Math.abs mutant (abs(-50)=50 !== -50), documenting
    // the brief's "not silently used as a positive gap" at the seam.
    // catches: Math.abs/sign-flip mutant; default swap.
    ok(rules.minDecrement === -50, 'B7 loadBidDifference=-50 -> minDecrement === -50 (sign preserved, not abs-ed)');
  }

  // ================================================================================================
  // PART 2 - config.js env knobs (read at require time; probed per-case in a child process)
  //   engine.rungCap:            Number(process.env.SP_RUNG_CAP || 0)
  //   softClose.jumpPerRival:    Number(process.env.SP_SOFT_JUMP_PER_RIVAL || 1)
  //   softClose.establishLeadMs: Number(process.env.SP_SOFT_ESTABLISH_LEAD_MS || 40_000)
  // ================================================================================================

  // B8 / B11 / B13 - defaults when every knob env var is absent (one probe, three magic constants).
  {
    // Arrange + Act
    const cfg = probeConfig({});
    // Assert - each default pins a distinct magic constant.
    // catches: constant replaced in the `|| N` default (rungCap 0->1, jump 1->0, lead 40000->4000).
    ok(cfg.rungCap.s === '0' && cfg.rungCap.t === 'number', 'B8 SP_RUNG_CAP absent -> engine.rungCap === 0 (auto)');
    ok(cfg.jumpPerRival.s === '1' && cfg.jumpPerRival.t === 'number', 'B11 SP_SOFT_JUMP_PER_RIVAL absent -> softClose.jumpPerRival === 1');
    ok(cfg.establishLeadMs.s === '40000' && cfg.establishLeadMs.t === 'number', 'B13 SP_SOFT_ESTABLISH_LEAD_MS absent -> softClose.establishLeadMs === 40000');
  }

  // B9 rung_cap_valid: a good integer env is parsed to that number.
  {
    // Arrange + Act
    const cfg = probeConfig({ SP_RUNG_CAP: '8' });
    // Assert - expected 8 (Number('8')); pins that the env is honored, not ignored in favour of the default.
    // catches: env-ignored mutant (would stay '0'); dropped Number() (would be string '8').
    ok(cfg.rungCap.s === '8' && cfg.rungCap.t === 'number', 'B9 SP_RUNG_CAP=8 -> engine.rungCap === 8');
  }

  // B10 rung_cap_junk: Number('abc') === NaN lands raw in cfg. CHARACTERIZATION PIN (do not fix):
  // _deriveRungCount (bidEngine.js:395) guards with `Number.isFinite(this.cfg.rungCap) && >0` so a
  // NaN cap degrades to Infinity == auto, identical to 0. If the config seam is ever hardened to
  // sanitize this, update this pin deliberately.
  {
    // Arrange + Act
    const cfg = probeConfig({ SP_RUNG_CAP: 'abc' });
    // Assert - raw NaN escapes into cfg.engine.rungCap (documented, tolerated downstream).
    // catches: a mutant that silently rewrote junk to a real finite cap (e.g. `|| 0` swallow -> 0),
    //          which would change the parse from NaN and flip nan false.
    ok(cfg.rungCap.nan === true, 'B10 SP_RUNG_CAP=abc -> engine.rungCap is NaN (raw; _deriveRungCount tolerates via Number.isFinite)');
  }

  // B12a jump_per_rival zero: SP_SOFT_JUMP_PER_RIVAL=0. RAW parse is 0, NOT the default 1 - because
  // the string '0' is truthy so `'0' || 1` -> '0' -> Number('0') === 0. (selectRung sanitizes 0->1
  // downstream; here we pin the raw seam parse.)
  {
    // Arrange + Act
    const cfg = probeConfig({ SP_SOFT_JUMP_PER_RIVAL: '0' });
    // Assert - expected raw 0, NOT 1.
    // catches: boolean-operator/short-circuit confusion - a mutant reading the number BEFORE the
    //          `|| 1` (e.g. Number(env) with a numeric-0 default) would surface 1 instead of 0.
    ok(cfg.jumpPerRival.s === '0' && cfg.jumpPerRival.t === 'number', 'B12a SP_SOFT_JUMP_PER_RIVAL=0 -> raw parse 0 (not defaulted to 1)');
  }

  // B12b jump_per_rival junk: SP_SOFT_JUMP_PER_RIVAL=abc -> Number('abc') === NaN raw. selectRung
  // (pricing.js:184) sanitizes NaN->1 downstream; we pin the raw seam parse.
  {
    // Arrange + Act
    const cfg = probeConfig({ SP_SOFT_JUMP_PER_RIVAL: 'abc' });
    // Assert - raw NaN at the seam (documented; sanitized downstream).
    // catches: a mutant that pre-sanitized junk at the config seam (would flip nan false).
    ok(cfg.jumpPerRival.nan === true, 'B12b SP_SOFT_JUMP_PER_RIVAL=abc -> raw parse is NaN (selectRung coerces to 1 downstream)');
  }

  // B14 establish_lead junk: SP_SOFT_ESTABLISH_LEAD_MS=-1 -> Number('-1') === -1 raw. PINNED ACTUAL:
  // the seam does NOT floor a negative; bidEngine.js:1322 uses it inside a Math.max with no lower
  // bound, so a negative marginally shrinks the establish lead rather than being rejected.
  {
    // Arrange + Act
    const cfg = probeConfig({ SP_SOFT_ESTABLISH_LEAD_MS: '-1' });
    // Assert - expected raw -1 (finite, not NaN, not floored to 0/40000).
    // catches: an unexpected clamp/abs at the seam (would surface 1, 0, or 40000 instead of -1).
    ok(cfg.establishLeadMs.s === '-1' && cfg.establishLeadMs.t === 'number' && cfg.establishLeadMs.nan === false,
      'B14 SP_SOFT_ESTABLISH_LEAD_MS=-1 -> softClose.establishLeadMs === -1 (raw, unclamped)');
  }
} catch (e) {
  fail++;
  console.error('  FAIL - unexpected throw:', (e && e.stack) || e);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
