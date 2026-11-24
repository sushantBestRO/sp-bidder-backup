'use strict';
/**
 * Pins D024 (fix/ops-alerting-divergences).
 *
 * A group whose assignment(s) are all disabled resolves to zero customers in the EOD report's
 * resolveGroups(), and the only trace was a log.debug line - invisible under the default
 * LOG_LEVEL (info), so a group could generate real, unanswered pricing volume for weeks with
 * nothing in `pm2 logs` to show it. Bumped to log.warn, which the logger routes to
 * console.error and which clears the default 'info' threshold.
 *
 * @requires-summary-line
 *   node scripts/test-d024-disabled-recipient-logs-at-warn.js
 */
const assert = require('assert');
delete process.env.LOG_LEVEL; // default threshold ('info') - the exact condition the bug hid behind
const { resolveGroups } = require('../src/notify/eodReport');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

const PERSON = { personId: 'p1', name: 'Cords Cable Group', phone: '911111@g.us', enabled: true };
const fakePersonStore = { list: async () => [PERSON] };
const fakeCustomerStore = { list: async () => [{ customerId: 'c1', aliases: ['Cords'], enabled: true }] };
// The assignment exists but is DISABLED - the shape that collapses the group to zero customers.
const fakeAssignmentStore = { list: async () => [{ personId: 'p1', customerId: 'c1', enabled: false }] };

(async () => {
  const origLog = console.log, origError = console.error;
  const logged = [], errored = [];
  console.log = (line) => logged.push(line);
  console.error = (line) => errored.push(line);
  let groups;
  try {
    groups = await resolveGroups({ personStore: fakePersonStore, customerStore: fakeCustomerStore, assignmentStore: fakeAssignmentStore });
  } finally {
    console.log = origLog; console.error = origError;
  }

  assert.strictEqual(groups.length, 0, 'the group with a disabled assignment resolves to zero groups (unchanged behavior)');

  const allLines = [...logged, ...errored];
  const matchLine = allLines.find((l) => l.includes('has no enabled customer assignment'));
  assert.ok(matchLine, `D024: the disabled-recipient condition is logged at all under default LOG_LEVEL: lines seen = ${JSON.stringify(allLines)}`);

  const parsed = JSON.parse(matchLine);
  assert.strictEqual(parsed.level, 'warn', `D024: the log line is at warn level, not debug: got level="${parsed.level}"`);
  assert.ok(errored.some((l) => l.includes('has no enabled customer assignment')),
    'D024: warn routes to console.error (the pm2-err.log stream), same as every other warn/error line');
  ok('D024: a disabled-recipient (zero-customer) group logs at warn and is visible under the default LOG_LEVEL');

  console.log(`\n${pass}/1 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
