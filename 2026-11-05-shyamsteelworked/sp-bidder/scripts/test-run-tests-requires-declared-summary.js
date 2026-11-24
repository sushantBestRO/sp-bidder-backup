'use strict';
/**
 * D064: a test-runner harness that grades a file by exit status alone will silently score a file
 * PASS if it exits early before running its checks (an un-ref'd timer, an unhandled early-
 * resolving promise). run-tests.js's existing FAIL-line check (test-run-tests-counts-fail-lines.js)
 * catches a file that prints its own failure and still exits 0 - it does NOT catch a file that
 * prints NOTHING and exits 0, which is exactly the zero-assertion early exit this item is about.
 *
 * Scope decision (INTERIM, pending the owner's call on the 139 files - not a decision made here):
 * 139 of the ~566 existing test files print no "passed" line in source, well past the "more than
 * 40, do not convert them all" threshold, so the stronger check is OPT-IN via an
 * `@requires-summary-line` marker in a file's source rather than forced on every file. A file that
 * does not carry the marker is graded exactly as before (see the control below) - existing files
 * are unaffected. A file that does carry it must print its own "N/N checks passed" line, with the
 * two numbers EQUAL, or the runner fails it on exit 0 - "3/5 checks passed" is not a pass; it is
 * the same zero-assertion-adjacent failure this item exists to catch (some declared checks never
 * ran), and a runner that only checked the LINE'S SHAPE (any \d+/\d+) rather than the two numbers'
 * VALUE would let that exact case through unnoticed - which is what the first cut of this file did.
 *
 * @requires-summary-line
 *   node scripts/test-run-tests-requires-declared-summary.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-summary-'));
const scripts = path.join(root, 'scripts');
fs.mkdirSync(scripts);
fs.copyFileSync(path.join(__dirname, 'run-tests.js'), path.join(scripts, 'run-tests.js'));

const MARKER = '// @requires-summary-line';
const fixtures = {
  // Declares the marker, exits 0, and prints the canonical summary - must pass.
  'test-a-declared-and-summarized.js': `${MARKER}\nconsole.log('2/2 checks passed');\n`,
  // Declares the marker, exits 0, prints NOTHING - the zero-assertion early exit this item exists
  // to catch. Must fail even though nothing looks wrong to the exit-code-only or FAIL-line checks.
  'test-b-declared-but-silent.js': `${MARKER}\n// (an un-ref'd timer let the process exit before any check ran)\n`,
  // No marker at all, exits 0, prints nothing - UNCHANGED behaviour: still counted as passed,
  // exactly as every one of the pre-existing 139 no-"passed" files is today.
  'test-c-undeclared-and-silent.js': 'console.log("ran, but no summary line - this is the pre-D064 status quo");\n',
  // No marker, exits 0, prints a DIFFERENT (non-canonical) completion line - also unaffected.
  'test-d-undeclared-custom-format.js': "console.log('PASS - 4/4 checks');\n",
  // Declares the marker, exits 0, prints a MISMATCHED "N/M checks passed" line (3 of 5 - two
  // declared checks never ran). Must fail: this is the exact false-negative the coordinator's
  // review caught in the first cut, which checked only the line's SHAPE, not that the two numbers
  // are equal.
  'test-e-declared-but-mismatched.js': `${MARKER}\nconsole.log('3/5 checks passed');\n`,
  'test-real.js': 'process.exit(1);\n',
  'test-template.js': `${MARKER}\n// must never be picked up by the runner at all\nprocess.exit(1);\n`,
};
for (const [name, body] of Object.entries(fixtures)) fs.writeFileSync(path.join(scripts, name), body);

let failures = 0;
function check(n, label, fn) {
  try { fn(); console.log(`  ok ${n} - ${label}`); } catch (e) { failures += 1; console.log(`  FAIL ${n} - ${label}: ${e.message}`); }
}

const r = spawnSync(process.execPath, [path.join(scripts, 'run-tests.js')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout}\n${r.stderr}`;
const summary = (out.match(/(\d+)\/(\d+) test files passed/) || [])[0];

check(1, 'the runner ran the five real fixtures, skipping test-real.js and test-template.js', () => {
  assert.ok(summary, `no summary line in runner output:\n${out}`);
  assert.strictEqual(summary.split(' ')[0].split('/')[1], '5');
});
check(2, 'a declared file with the canonical N/N summary line passes', () => {
  assert.ok(!/FAILED: test-a-declared-and-summarized\.js/.test(out), 'test-a was wrongly failed');
});
check(3, 'a declared file that exits 0 but prints no summary line is FAILED - the zero-assertion early exit', () => {
  assert.ok(/FAILED: test-b-declared-but-silent\.js/.test(out),
    `test-b declared the marker, exited 0, and printed nothing - the runner must catch this (got:\n${out}\n)`);
});
check(4, 'an UNDECLARED file that prints nothing is unaffected (pre-D064 status quo)', () => {
  assert.ok(!/FAILED: test-c-undeclared-and-silent\.js/.test(out),
    'test-c has no marker, so it must be graded exactly as it always was - counted as passed');
});
check(5, 'an UNDECLARED file with a non-canonical completion line is unaffected', () => {
  assert.ok(!/FAILED: test-d-undeclared-custom-format\.js/.test(out), 'test-d has no marker, so its own wording is not policed');
});
check(6, 'a declared file whose N/M numbers do NOT match is FAILED, not just shape-matched', () => {
  assert.ok(/FAILED: test-e-declared-but-mismatched\.js/.test(out),
    `test-e printed "3/5 checks passed" (mismatched) - a shape-only check would wrongly pass this (got:\n${out}\n)`);
});
check(7, 'totals: exactly two of the five graded fixtures failed', () => {
  assert.strictEqual(summary, '3/5 test files passed');
});
check(8, 'the runner exits non-zero when any graded file failed', () => {
  assert.notStrictEqual(r.status, 0);
});
check(9, 'test-template.js itself is never picked up by the runner, even though it carries the marker', () => {
  assert.ok(!out.includes('test-template.js'), `test-template.js must be excluded by name (got:\n${out}\n)`);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`\nFAILED: ${failures} of 9 checks - the runner does not require a declared, NUMERICALLY COMPLETE summary line`);
  process.exit(1);
}
console.log('\n9/9 checks passed');
