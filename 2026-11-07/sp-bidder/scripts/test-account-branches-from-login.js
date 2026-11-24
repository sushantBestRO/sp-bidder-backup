'use strict';
/**
 * A SuperProcure login keeps each branch's name and customer, and re-saving an unchanged branch count
 * raises no shrink warning.
 *
 * The console answers "which login sees Havells?" from the branches login() collects off getHeader.
 * The suite only ever fed getHeader bare branch ids, so the name, customer and permission fields, and
 * the skip of malformed entries, were unpinned. The shrink boundary was pinned only across a real
 * drop, so an unchanged count reading as "down from" itself went unnoticed (mutation critique, PR-1).
 *
 *   node scripts/test-account-branches-from-login.js
 */
const assert = require('assert');
const { RealSuperProcureAdapter } = require('../src/platform/realAdapter');
const { MemoryStore } = require('../src/store');
const cov = require('../src/auth/accountCoverage');

let pass = 0;
const ok = (n, m) => { console.log(`  ok  ${n}. ${m}`); pass++; };

(async () => {
  const header = { data: { isCarrier: true, carrierBranches: [2667], userInfo: { name: 'Desk', companyName: 'Best Roadways' },
    branchList: {
      956055: { branchId: 956055, branchName: ' Havells Neemrana ', freighterName: 'Havells India Ltd.',
        permissions: { procurement: { bid: 2 } } },
      956056: { branchId: 956056, branchName: '', label: 'Kingspan Pune', freighterName: 'Kingspan' },
      956057: { branchId: '956057', branchName: 'string id' },
      956058: null,
    } } };
  const fetchImpl = async (url) => ({ status: 200, headers: { get: () => null },
    text: async () => JSON.stringify(url.includes('getHeader') ? header : { data: {} }) });
  const a = new RealSuperProcureAdapter({ token: 'x', fetchImpl, sleep: async () => {}, rand: () => 0.5 });
  await a.login();
  assert.deepStrictEqual(a.account.branches, [
    { branchId: 956055, name: 'Havells Neemrana', customer: 'Havells India Ltd.', bidPermission: 2 },
    { branchId: 956056, name: 'Kingspan Pune', customer: 'Kingspan', bidPermission: null },
  ], `login collected ${JSON.stringify(a.account.branches)}`);
  ok(1, 'login keeps each branch name and customer, falls back to the label, and skips malformed entries');

  const s = new MemoryStore();
  const two = a.account.branches;
  await cov.saveBranches(s, 'master', two);
  await cov.saveBranches(s, 'master', two);
  assert.strictEqual((await s.getDoc(cov.BRANCHES_COLLECTION, 'master')).shrankFrom, null,
    'an unchanged branch count was recorded as a shrink');
  ok(2, 'an unchanged branch count is not a shrink');

  console.log(`\n${pass}/2 checks passed`);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
