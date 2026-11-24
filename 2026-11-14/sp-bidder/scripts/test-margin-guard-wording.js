'use strict';
/**
 * BC-32 (ruling 27): the minimum margin is a GUARD - but the engine's own floor-clamp
 * (src/engine/pricing.js buildBandLadder: price = Math.max(operatingFloor, ...)) can make it the
 * ACTUAL last bid price whenever a band's lowest configured margin sits below it, so the bare
 * "never bid" a prior fix (38c8234, M0-BC32) shipped overstates the guarantee. "never bid below"
 * is true in every case (assertAboveFloor: price >= floor, never <) and is what the console must
 * say instead.
 *
 * Static, offline scan of the two console copy sites; comments stripped first so a code comment
 * mentioning the old wording cannot pass a check meant for the rendered string.
 *
 *   node scripts/test-margin-guard-wording.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

function stripComments(src) {
  const noLine = src.split('\n').map((line) => {
    const i = line.search(/(^|[^:])\/\//);
    return i < 0 ? line : line.slice(0, line.indexOf('//', i));
  }).join('\n');
  return noLine.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}
const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const editor = read('dashboard/src/components/MarginBandEditor.tsx');
const settings = read('dashboard/src/pages/Settings.tsx');

ok(/never bid below/i.test(editor), 'MarginBandEditor.tsx minimum-margin label says "never bid below", not the bare "never bid"');
ok(!/\(never bid\)/i.test(editor), 'the old, imprecise "(never bid)" label is gone from MarginBandEditor.tsx');
ok(/never bid below/i.test(settings), 'Settings.tsx fallback-margins hint says "never bid below"');
ok(!/is never bid\./i.test(settings), 'the old, imprecise "is never bid." sentence is gone from Settings.tsx');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
