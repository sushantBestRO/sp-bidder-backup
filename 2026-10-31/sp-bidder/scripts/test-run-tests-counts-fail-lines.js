'use strict';
/**
 * Regression target: scripts/run-tests.js graded each test file by its exit code alone, so a file
 * that printed its own FAIL line and still exited 0 was counted as passed.
 *
 * Mechanism pinned: the runner must count a file as failed when it exits non-zero OR when its own
 * output carries a failure line in the suite's convention (a line that starts with FAIL, FAILED or
 * TEST FAILURE after leading whitespace).
 *
 * What must NOT move: a clean file still passes, a non-zero exit still fails, and a log payload that
 * merely contains "FAILED:" mid-line (logging is on during the suite) is not a failure.
 *
 * Run: node scripts/test-run-tests-counts-fail-lines.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-fail-lines-'));
const scripts = path.join(root, 'scripts');
fs.mkdirSync(scripts);
fs.copyFileSync(path.join(__dirname, 'run-tests.js'), path.join(scripts, 'run-tests.js'));

const fixtures = {
  'test-a-clean.js': "console.log('PASS - 2/2 checks');\n",
  'test-b-fail-line-exit-0.js': "console.log('  FAIL - check 2: the refund did not happen');\nconsole.log('done');\n",
  'test-c-exit-1.js': "console.error('boom');\nprocess.exit(1);\n",
  'test-d-log-payload.js':
    "console.log('[engine] placeBid FAILED: http_502 (will retry)');\n" +
    "console.log(JSON.stringify({ level: 'warn', msg: 'FAILED: write', note: 'FAIL' }));\n" +
    "console.log('PASS - 1/1 checks');\n",
  'test-e-failed-on-stderr-exit-0.js': "console.error('\\nFAILED: 1 of 3 checks');\n",
  'test-real.js': "process.exit(1);\n",
};
for (const [name, body] of Object.entries(fixtures)) fs.writeFileSync(path.join(scripts, name), body);

let failures = 0;
function check(n, label, fn) {
  try { fn(); console.log(`  ok ${n} - ${label}`); } catch (e) { failures += 1; console.log(`  FAIL ${n} - ${label}: ${e.message}`); }
}

const r = spawnSync(process.execPath, [path.join(scripts, 'run-tests.js')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout}\n${r.stderr}`;
const summary = (out.match(/(\d+)\/(\d+) test files passed/) || [])[0];

check(1, 'the runner ran the five fixtures and skipped test-real.js', () => {
  assert.ok(summary, `no summary line in runner output:\n${out}`);
  assert.strictEqual(summary.split(' ')[0].split('/')[1], '5');
});
check(2, 'a file that prints its own FAIL line and exits 0 is counted as failed', () => {
  assert.ok(/FAILED: test-b-fail-line-exit-0\.js/.test(out), 'test-b printed "  FAIL - check 2" and exited 0, but the runner counted it as passed');
});
check(3, 'a FAILED line on stderr with exit 0 is counted as failed', () => {
  assert.ok(/FAILED: test-e-failed-on-stderr-exit-0\.js/.test(out), 'test-e printed "FAILED: 1 of 3 checks" and exited 0, but the runner counted it as passed');
});
check(4, 'the totals reflect three failed files out of five', () => {
  assert.strictEqual(summary, '2/5 test files passed');
});
check(5, 'the runner exits non-zero when any file failed', () => {
  assert.notStrictEqual(r.status, 0);
});
check(6, 'control: a non-zero exit still fails', () => {
  assert.ok(/FAILED: test-c-exit-1\.js/.test(out));
});
check(7, 'control: a clean file and a mid-line log payload are not failures', () => {
  assert.ok(!/FAILED: test-a-clean\.js/.test(out), 'clean file counted as failed');
  assert.ok(!/FAILED: test-d-log-payload\.js/.test(out), 'a log payload containing FAILED: mid-line was counted as a failure');
});
check(8, 'the child output is still shown', () => {
  assert.ok(out.includes('the refund did not happen'), 'test-b output was swallowed');
  assert.ok(out.includes('PASS - 2/2 checks'), 'test-a output was swallowed');
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) {
  console.error(`\nFAILED: ${failures} of 8 checks - the runner does not count a file's own FAIL lines`);
  process.exit(1);
}
console.log('\nPASS - 8/8 checks');
