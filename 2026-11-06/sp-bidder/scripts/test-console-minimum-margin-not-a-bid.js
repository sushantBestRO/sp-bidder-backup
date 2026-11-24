'use strict';
/**
 * THE CONSOLE LABELS THE MINIMUM MARGIN AS A FLOOR THAT READS LIKE A BID.
 *
 * Regression target: BC32-minimum-label.
 *
 * The band margins are the bids. The minimum margin is a guard: no bid ever goes below
 * cost x (1 + minimum), and the minimum itself is never bid. The console's shared margin editor
 * (dashboard/src/components/MarginBandEditor.tsx) says otherwise. It labels the last band step
 * "Lowest" and the minimum field "Floor margin", with the hint "operating floor = cost x (1 + this);
 * bids never go below it.". The three pages that use it (Settings, Customers, Assignments) pass
 * floor hints in the same words. The desk reads the "Floor margin" field as a fourth, lowest bid.
 *
 * This is a static scan of the source copy, with comments blanked, in the same way the desk-voice
 * test scans copy. It pins properties of the copy, never an exact sentence:
 *   - the minimum field's label and every hint shown beside it say it is not a bid, and never use
 *     the word "floor" (checks 5-9)
 *   - the band steps are labelled as bids, and the last step's label names a bid (checks 10-11)
 *   - no editor string or page hint contains "operating floor" (check 12)
 *
 * WHAT MUST NOT MOVE (checks 1-4): the editor still renders one input per margin step plus one
 * minimum input, a cleared field still becomes NaN rather than 0, all three pages still render the
 * editor, and the minimum field's label and hint can still be read from the source.
 *
 * Offline and deterministic: reads source files only.
 *
 *   node scripts/test-console-minimum-margin-not-a-bid.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const EDITOR = 'dashboard/src/components/MarginBandEditor.tsx';
const PAGES = ['dashboard/src/pages/Settings.tsx', 'dashboard/src/pages/Customers.tsx', 'dashboard/src/pages/Assignments.tsx'];

const NOT_A_BID = /not a bid|never (?:a )?bid/i;
const FLOOR = /\bfloor/i;

// Line comments first, then block comments, so a `/*` inside a line comment cannot open a block.
function stripComments(src) {
  const noLine = src
    .split('\n')
    .map((line) => {
      const i = line.search(/(^|[^:])\/\//);
      if (i < 0) return line;
      return line.slice(0, line.indexOf('//', i));
    })
    .join('\n');
  return noLine.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// The text of the opening JSX tag that starts at `start`, up to its closing `>` at depth 0.
function tagAt(src, start) {
  let depth = 0, quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// A JSX attribute as { literal } or { ident }; null when absent.
function attr(tag, name) {
  const re = new RegExp(`\\b${name}=(?:"([^"]*)"|\\{'([^']*)'\\}|\\{"([^"]*)"\\}|\\{\`([^\`$]*)\`\\}|\\{([A-Za-z_$][\\w$]*)\\})`);
  const m = tag.match(re);
  if (!m) return null;
  if (m[5] !== undefined) return { ident: m[5] };
  return { literal: m[1] ?? m[2] ?? m[3] ?? m[4] };
}

// The expression bound by `const <name> = ...;`, ending at the first `;` at bracket depth 0.
function constExpr(src, name) {
  const at = src.search(new RegExp(`const ${name} = `));
  if (at < 0) return null;
  const start = src.indexOf('=', at) + 1;
  let depth = 0, quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return src.slice(start, i).trim();
  }
  return null;
}

const stripTypes = (s) => s.replace(/:\s*(?:number|string)\b/g, '');

const results = [];
const check = (n, desc, fn) => {
  try { fn(); results.push({ n, ok: true }); }
  catch (e) { results.push({ n, ok: false }); console.error(`  FAIL ${n}. ${desc}: ${e.message}`); }
};

const editor = read(EDITOR);
const pages = PAGES.map((rel) => ({ rel, src: read(rel) }));

let minLabel = null;
let minHintIdent = null;
const minHints = [];
let labelFn = null;

check(1, 'the editor renders one input per margin step plus exactly one minimum input', () => {
  const mapAt = editor.indexOf('marginsPct.map(');
  assert.ok(mapAt >= 0, 'no marginsPct.map( in the editor');
  const stepInput = editor.indexOf('<Input', mapAt);
  assert.ok(stepInput > mapAt && /setRung\(i, num\(/.test(editor.slice(stepInput, editor.indexOf('/>', stepInput))),
    'the per-step input inside marginsPct.map no longer writes setRung(i, num(...))');
  assert.strictEqual((editor.match(/onChange\(marginsPct, num\(/g) || []).length, 1, 'expected exactly one minimum input');
  assert.strictEqual((editor.match(/<Input\b/g) || []).length, 2, 'expected two <Input> elements: the step template and the minimum');
});

check(2, 'a cleared field is NaN, not 0 (the num helper)', () => {
  const expr = constExpr(editor, 'num');
  assert.ok(expr, 'no num helper in the editor');
  const num = vm.runInNewContext(`(${stripTypes(expr)})`, {});
  assert.ok(Number.isNaN(num('')), "num('') must be NaN");
  assert.ok(Number.isNaN(num('abc')), "num('abc') must be NaN");
  assert.strictEqual(num('0'), 0, "num('0') must stay 0");
  assert.strictEqual(num('6.3'), 6.3);
});

check(3, 'all three pages still render the shared editor', () => {
  for (const { rel, src } of pages) {
    assert.ok(/import \{ MarginBandEditor \}/.test(src) && src.includes('<MarginBandEditor'), `${rel} no longer renders MarginBandEditor`);
  }
});

check(4, "the minimum field's label, its hint and the step labels can be read from the source", () => {
  const minAt = editor.indexOf('onChange(marginsPct, num(');
  const fieldAt = editor.lastIndexOf('<Field', minAt);
  assert.ok(fieldAt >= 0, 'the minimum input is not inside a <Field>');
  const tag = tagAt(editor, fieldAt);
  const label = attr(tag, 'label');
  assert.ok(label && label.literal !== undefined, `cannot read a literal label on ${tag}`);
  minLabel = label.literal;
  const hint = attr(tag, 'hint');
  assert.ok(hint, `the minimum field carries no hint: ${tag}`);
  if (hint.literal !== undefined) {
    minHints.push({ where: `${EDITOR} minimum field hint`, text: hint.literal });
  } else {
    minHintIdent = hint.ident;
    const def = editor.match(new RegExp(`\\b${minHintIdent} = (?:'([^']*)'|"([^"]*)")`));
    assert.ok(def, `no default string for the ${minHintIdent} prop`);
    minHints.push({ where: `${EDITOR} default ${minHintIdent}`, text: def[1] ?? def[2] });
    for (const { rel, src } of pages) {
      let at = src.indexOf('<MarginBandEditor');
      while (at >= 0) {
        const p = attr(tagAt(src, at), minHintIdent);
        if (p && p.literal !== undefined) minHints.push({ where: `${rel} ${minHintIdent} prop`, text: p.literal });
        at = src.indexOf('<MarginBandEditor', at + 1);
      }
    }
  }
  const expr = constExpr(editor, 'label');
  assert.ok(expr, 'no label(i) function for the band steps');
  labelFn = (marginsPct) => vm.runInNewContext(`(${stripTypes(expr)})`, { marginsPct });
  assert.strictEqual(typeof labelFn([12.6, 7.2, 6.3])(2), 'string');
});

check(5, 'the minimum field label does not say "floor" and says it is not a bid', () => {
  assert.ok(minLabel !== null, 'label unreadable (see check 4)');
  assert.ok(!FLOOR.test(minLabel) && NOT_A_BID.test(minLabel),
    `label "${minLabel}" calls the minimum a floor and never says it is not a bid, so it reads as a fourth, lowest bid`);
});

// A page that passes no hint of its own shows the editor's default, which check 6 covers.
const hintCheck = (n, pick, desc, required = false) => check(n, desc, () => {
  const hs = minHints.filter(pick);
  assert.ok(hs.length > 0 || !required, 'no hint found (see check 4)');
  for (const h of hs) {
    assert.ok(!FLOOR.test(h.text) && NOT_A_BID.test(h.text),
      `${h.where} "${h.text}" calls the minimum a floor and never says it is not a bid`);
  }
});
hintCheck(6, (h) => h.where.startsWith(EDITOR), "the editor's own minimum hint says it is not a bid and does not say \"floor\"", true);
hintCheck(7, (h) => h.where.startsWith(PAGES[0]), 'the Settings page hint says it is not a bid and does not say "floor"');
hintCheck(8, (h) => h.where.startsWith(PAGES[1]), 'the Customers page hint says it is not a bid and does not say "floor"');
hintCheck(9, (h) => h.where.startsWith(PAGES[2]), 'the Assignments page hint says it is not a bid and does not say "floor"');

check(10, "the last band step's label names a bid", () => {
  assert.ok(labelFn, 'step labels unreadable (see check 4)');
  for (const band of [[12.6, 7.2], [12.6, 7.2, 6.3], [15, 12.6, 7.2, 6.3]]) {
    const last = labelFn(band)(band.length - 1);
    assert.ok(/bid/i.test(last), `the last of ${band.length} steps is labelled "${last}", which reads as the minimum rather than a bid`);
  }
});

check(11, 'the band steps are labelled as bids', () => {
  assert.ok(labelFn, 'step labels unreadable (see check 4)');
  const band = [12.6, 7.2, 6.3];
  const labels = band.map((_, i) => labelFn(band)(i));
  const before = editor.slice(editor.indexOf('return ('), editor.indexOf('marginsPct.map('));
  const heading = ((before.match(/>([^<>{}]*\S[^<>{}]*)</) || [])[1] || '').trim();
  assert.ok(/bid/i.test(heading) || labels.every((l) => /bid/i.test(l)),
    `the steps section is headed "${heading}" and labelled ${JSON.stringify(labels)} - nothing calls them bids`);
});

check(12, 'no editor string or page hint says "operating floor"', () => {
  const found = [];
  if (/operating floor/i.test(editor)) found.push(EDITOR);
  for (const h of minHints) if (/operating floor/i.test(h.text)) found.push(h.where);
  assert.ok(found.length === 0, `"operating floor" is still shown in: ${found.join('; ')}`);
});

const EXPECTED = 12;
const failed = results.filter((r) => !r.ok).map((r) => r.n);
assert.strictEqual(results.length, EXPECTED, `expected ${EXPECTED} checks, ran ${results.length}`);
if (failed.length) {
  const why = failed.some((n) => n <= 4)
    ? 'the margin editor structure moved (a control failed)'
    : 'the console still labels the minimum margin as a floor that reads like a bid';
  console.error(`FAIL: ${failed.length} of ${EXPECTED} checks (${failed.join(', ')}) - ${why}`);
  process.exit(1);
}
console.log(`PASS: all ${EXPECTED} checks`);
