'use strict';
/**
 * Extends the desk-voice gate to src/engine/, which test-desk-voice.js explicitly declines to
 * scan ("The engine is not scanned" - its own copySurfaces() comment). Engine `detail:` string
 * literals reach a human unmodified: engineAlerts.js's ERROR_KINDS branch falls through to
 * `detail: evt.detail`, and that value is rendered verbatim in the WhatsApp `error` template. A
 * banned word placed in one of those literals is therefore desk-visible but invisible to the
 * existing gate.
 *
 * The banned-word and robot-emoji rules are READ out of test-desk-voice.js's own source rather
 * than re-typed here, so this file cannot silently drift from the frozen gate's vocabulary.
 * test-desk-voice.js is never required (it is a self-executing IIFE that boots a server and
 * calls process.exit) and never edited.
 *
 * WHAT MUST NOT MOVE: a `detail:` value that never mentions the banned word must never be
 * flagged (the ok_kind / clean-ternary-branch / template-literal controls below), and a
 * commented-out `detail:` literal must never be flagged either (comments are how this codebase
 * explains itself, and are not user-visible copy).
 *
 *   node scripts/test-engine-desk-voice.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// =========================================================================================
// Read the frozen gate's own rules rather than re-typing them.
// =========================================================================================
const DESK_VOICE_SRC = fs.readFileSync(path.join(__dirname, 'test-desk-voice.js'), 'utf8');

function readRule(name) {
  const m = DESK_VOICE_SRC.match(new RegExp(`const ${name} = (\\/(?:\\\\.|[^/\\n])+\\/[a-z]*);`));
  assert.ok(m, `could not read ${name} out of test-desk-voice.js - the frozen gate's shape changed`);
  return eval(m[1]); // eslint-disable-line no-eval -- reconstructing a regex literal read from disk, not user input
}

const BANNED = readRule('BANNED');
const ROBOT_EMOJI = readRule('ROBOT_EMOJI');

// =========================================================================================
// A small JS-aware scanner: strip real comments (never a `//` or `/*` inside a string), then
// pull out the full value expression that follows each `detail:` key, spanning concatenation,
// ternaries and template-literal interpolation, up to the next top-level comma or closing brace.
// =========================================================================================
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i += 2;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function detailExpressions(cleanSrc) {
  const found = [];
  const re = /\bdetail\s*:/g;
  let m;
  while ((m = re.exec(cleanSrc))) {
    let i = re.lastIndex;
    const start = i;
    let depth = 0, inStr = null;
    while (i < cleanSrc.length) {
      const c = cleanSrc[i];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === inStr) inStr = null;
        i++; continue;
      }
      if (c === '\'' || c === '"' || c === '`') { inStr = c; i++; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
      if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; i++; continue; }
      if (c === ',' && depth === 0) break;
      i++;
    }
    found.push({ index: start, text: cleanSrc.slice(start, i) });
  }
  return found;
}

function scan(src) {
  return detailExpressions(stripComments(src));
}

// =========================================================================================
// PART 1 - the scanner's own mechanism, proved against a synthetic fixture (offline,
// deterministic, no disk I/O beyond reading this process's own module).
// =========================================================================================
console.log('\n1. the detail: scanner itself, against a synthetic fixture');

const FIXTURE = [
  "'use strict';",
  "// detail: 'the bot is testing something' -- a comment, must never be flagged",
  "class X {",
  "  foo() {",
  "    this.emit({ type: 'alert', kind: 'ok_kind',",
  "      detail: 'the platform closed this before we could arm it, so no bid was placed',",
  "      lane: x });",
  "    this.emit({ type: 'alert', kind: 'bad_kind',",
  "      detail: 'the auction had already closed by the time the bot woke to arm this load'",
  "        + ' - so no bid was placed', lane: x });",
  "    this.emit({ type: 'alert', kind: 'ternary_kind',",
  "      detail: cond",
  "        ? 'the bot hit an error arming this load'",
  "        : 'a clean alternate branch, no banned word here',",
  "      lane: x });",
  "    this.emit({ type: 'alert', kind: 'template_kind',",
  "      detail: `SuperProcure recorded ${res.bidVehicleCount} vehicle(s) against this bid`,",
  "      lane: x });",
  "  }",
  "}",
].join('\n');

const fixtureHits = scan(FIXTURE);
ok(fixtureHits.length === 4, `found exactly the 4 real detail: expressions, not the commented one (${fixtureHits.length})`);

const byKindOrder = ['ok_kind', 'bad_kind', 'ternary_kind', 'template_kind'];
const flagged = fixtureHits.map((h) => BANNED.test(h.text));
ok(flagged[0] === false, 'ok_kind: a clean detail is never flagged (control)');
ok(flagged[1] === true, 'bad_kind: banned word inside a string concatenated across lines is caught');
ok(flagged[2] === true, 'ternary_kind: banned word buried in a ternary branch is caught');
ok(flagged[3] === false, 'template_kind: a template literal with only numeric interpolation is never flagged (control)');

// =========================================================================================
// PART 2 - the real gate: every detail: literal in src/engine/*.js.
// =========================================================================================
console.log('\n2. every detail: literal in src/engine/*.js is clean');

const engineDir = path.join(__dirname, '../src/engine');
const files = fs.readdirSync(engineDir).filter((f) => f.endsWith('.js')).map((f) => path.join(engineDir, f));
ok(files.length >= 1, `engine files discovered (${files.length})`);

const root = path.join(__dirname, '..');
const offenders = [];
let detailCount = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const cleaned = stripComments(raw);
  for (const expr of detailExpressions(cleaned)) {
    detailCount++;
    if (!BANNED.test(expr.text) && !ROBOT_EMOJI.test(expr.text)) continue;
    const line = cleaned.slice(0, expr.index).split('\n').length;
    const rel = path.relative(root, file).replace(/\\/g, '/');
    offenders.push(`${rel}:${line} -> ${expr.text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  }
}
ok(detailCount > 0, `detail: literals discovered in src/engine (${detailCount})`);
ok(offenders.length === 0,
  offenders.length ? `banned word on an engine detail: literal:\n      ${offenders.join('\n      ')}` : 'no banned word on any engine detail: literal');

// =========================================================================================
console.log(`\nengine-desk-voice: ${pass} passed, ${fail} failed`);
assert.ok(pass > 0, 'the suite must assert something');
process.exit(fail ? 1 : 0);
