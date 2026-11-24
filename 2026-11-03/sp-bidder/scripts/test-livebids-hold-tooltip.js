'use strict';
/**
 * BC-24: the console's "On hold" badge on the Live Bids table carried a fixed, figure-free
 * tooltip ("Saved. We have stopped bidding this load - the rate on record cannot beat our own
 * standing bid.") no matter what the hold actually was. The desk had to open the row's own cells
 * to see the two numbers the sentence was about.
 *
 * Fix: dashboard/src/pages/LiveBids.tsx's holdTitle() leads with the figures, the same two-numbers
 * rule server.js's holdCopy uses for the /price page panel and waTemplates.repriceUnreachableBody
 * uses for WhatsApp - the rate is only "above" the standing bid when it genuinely is one; when
 * margin is what cleared the board bid instead, the figure that explains the hold is the floor.
 *
 * Regression target: BC-24 (console surface).
 *
 * This EXECUTES the real function (extracted from source, TS param annotation stripped, `money`
 * stubbed) rather than re-typing its logic, so a future edit that changes the wording or the
 * branch order is caught here, not just a string grep.
 *
 * Offline and deterministic: reads source only.
 *
 *   node scripts/test-livebids-hold-tooltip.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PAGE = 'dashboard/src/pages/LiveBids.tsx';

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

function extractFunction(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  if (start < 0) return null;
  // Walk past the PARAMETER LIST first (balanced parens) - a TS param type annotation can itself
  // contain `{...}`, so the body's opening brace is the first `{` AFTER the params close, not the
  // first `{` after the function name.
  let parenDepth = 0;
  let parenEnd = -1;
  for (let i = start + marker.length - 1; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')') { parenDepth--; if (parenDepth === 0) { parenEnd = i; break; } }
  }
  if (parenEnd < 0) return null;
  const braceStart = src.indexOf('{', parenEnd);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

const src = stripComments(fs.readFileSync(path.join(ROOT, PAGE), 'utf8'));

const results = [];
const check = (n, desc, fn) => {
  try { fn(); results.push({ n, ok: true }); }
  catch (e) { results.push({ n, ok: false }); console.error(`  FAIL ${n}. ${desc}: ${e.message}`); }
};

let holdTitle = null;

check(1, 'holdTitle() exists in LiveBids.tsx', () => {
  const raw = extractFunction(src, 'holdTitle');
  assert.ok(raw, 'no function holdTitle(...) found');
  // Strip only this function's own TS param-type annotation (a plain object type, no nested
  // braces) - narrow on purpose so this test cannot silently "fix" an unrelated TS construct.
  const stripped = raw.replace(/\(hold\?: \{[^}]*\} \| null\)/, '(hold)');
  const sandbox = { money: (n) => `RS${n}`, module: { exports: null } };
  vm.createContext(sandbox);
  vm.runInContext(`${stripped}\nmodule.exports = holdTitle;`, sandbox);
  holdTitle = sandbox.module.exports;
  assert.strictEqual(typeof holdTitle, 'function', 'holdTitle did not evaluate to a function');
});

check(2, 'no hold data: a plain fallback, not a claim about figures it does not have', () => {
  assert.ok(holdTitle, 'holdTitle unavailable (see check 1)');
  const t = holdTitle(null);
  assert.ok(!/RS/.test(t), `fallback text invents a figure: "${t}"`);
});

check(3, 'margin-held: the real 260916V9D7 record (standing 54,500, corrected 53,500, lowest with margin 55,426)', () => {
  assert.ok(holdTitle, 'holdTitle unavailable (see check 1)');
  const t = holdTitle({ standingBidPrice: 54500, correctedCost: 53500, floor: 55426 });
  assert.strictEqual(t, 'RS55426 is the lowest we can bid with margin added, above our RS54500 bid already on the board. Bidding stopped on this load.');
  assert.ok(!/RS53500/.test(t), 'the raw corrected rate must not be printed as though it were the reason for the hold');
});

check(4, 'rate above the standing bid - figures first, says "above"', () => {
  assert.ok(holdTitle, 'holdTitle unavailable (see check 1)');
  const t = holdTitle({ standingBidPrice: 54500, correctedCost: 55426 });
  assert.strictEqual(t, 'RS55426 is above our RS54500 bid already on the board. Bidding stopped on this load.');
});

check(5, 'margin-held (rate below the standing bid, but the floor with margin is above it)', () => {
  assert.ok(holdTitle, 'holdTitle unavailable (see check 1)');
  const t = holdTitle({ standingBidPrice: 54500, correctedCost: 50000, floor: 54800 });
  assert.strictEqual(t, 'RS54800 is the lowest we can bid with margin added, above our RS54500 bid already on the board. Bidding stopped on this load.');
  assert.ok(!/RS50000/.test(t), 'the raw corrected rate must not be printed as though it were the reason for the hold');
});

check(6, 'fail-closed hold with no floor (rate below our bid): states the two figures plainly, never "does not beat"', () => {
  assert.ok(holdTitle, 'holdTitle unavailable (see check 1)');
  const t = holdTitle({ standingBidPrice: 54500, correctedCost: 53500 });
  assert.strictEqual(t, 'Our bid on the board is RS54500. Your corrected rate is RS53500. Bidding stopped on this load.');
  assert.ok(!/does not beat/.test(t), 'a reverse auction below our own bid DOES beat it - this must not be worded as though it fails to');
  assert.ok(!/is above/.test(t), 'the rate is below our bid, not above it');
});

check(7, 'the corrected > bid boundary: equal figures must never read "is above"', () => {
  assert.ok(holdTitle, 'holdTitle unavailable (see check 1)');
  const t = holdTitle({ standingBidPrice: 54500, correctedCost: 54500 });
  assert.ok(!/is above/.test(t), `equal figures read as "above": ${t}`);
  assert.strictEqual(t, 'Our bid on the board is RS54500. Your corrected rate is RS54500. Bidding stopped on this load.');
});

check(8, 'the badge renders the dynamic title, not a fixed string', () => {
  assert.ok(/title=\{holdTitle\(hold\)\}/.test(src), 'the "On hold" badge no longer wires title={holdTitle(hold)}');
  assert.ok(!/title="Saved\. We have stopped bidding this load - the rate on record cannot beat our own standing bid\."/.test(src),
    'the old fixed, figure-free tooltip string is still on the badge');
});

check(9, 'the row still joins the live auction to its price-request hold record', () => {
  assert.ok(/const hold = req\?\.hold;/.test(src), 'the `hold` binding used by holdTitle has moved or is gone');
});

const EXPECTED = 9;
const failed = results.filter((r) => !r.ok).map((r) => r.n);
assert.strictEqual(results.length, EXPECTED, `expected ${EXPECTED} checks, ran ${results.length}`);
if (failed.length) {
  console.error(`FAIL: ${failed.length} of ${EXPECTED} checks (${failed.join(', ')}) - the console's held-load tooltip is not figures-first`);
  process.exit(1);
}
console.log(`PASS: all ${EXPECTED} checks`);
