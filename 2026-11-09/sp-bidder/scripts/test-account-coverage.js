'use strict';
/**
 * Branch-capture bookkeeping (src/auth/accountCoverage.js). No network.
 *
 * Two of these pin defects a review caught before this code ever shipped, and both are the kind
 * that read as fine in a screenshot:
 *
 *   A. The shrink signal must SURVIVE an unchanged re-confirmation. The obvious source for it,
 *      accountScope.prevCount, does not: checkScopeChange re-persists on the unchanged branch so
 *      prevCount collapses to the current count, and "down from 259" erases itself at the next 6h
 *      confirmation, on any restart, or when the operator clicks Refresh scope. shrankFrom is
 *      carried forward instead, and this suite is what stops someone "simplifying" it back.
 *
 *   B. An EMPTY branch list must PERSIST. Skipping it left the previous list on screen under a
 *      "0 branches" header - the precise count-versus-list contradiction this module exists to
 *      remove.
 *
 *   node scripts/test-account-coverage.js
 */
const assert = require('assert');
const { MemoryStore } = require('../src/store');
const cov = require('../src/auth/accountCoverage');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };
const br = (n, customer = 'Havells India Ltd.') => Array.from({ length: n }, (_, i) => ({
  branchId: 1000 + i, name: `Branch ${i + 1}`, customer, bidPermission: 2,
}));
const doc = (store, id = 'master') => store.getDoc(cov.BRANCHES_COLLECTION, id);

(async () => {
  // ---- A. the shrink signal survives what erases prevCount -------------------------------
  {
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(259));
    assert.strictEqual((await doc(s)).shrankFrom, null, 'first capture has nothing to shrink from');

    await cov.saveBranches(s, 'master', br(13));
    assert.strictEqual((await doc(s)).shrankFrom, 259);
    assert.strictEqual((await doc(s)).count, 13);
    ok('a decrease records what the count fell from');

    // The regression: three unchanged re-confirmations, exactly what the 6h cadence, a pm2
    // restart and a Refresh scope click each produce.
    await cov.saveBranches(s, 'master', br(13));
    await cov.saveBranches(s, 'master', br(13));
    await cov.saveBranches(s, 'master', br(13));
    assert.strictEqual((await doc(s)).shrankFrom, 259, 'shrankFrom must survive unchanged writes');
    ok('the shrink warning survives repeated unchanged confirmations');

    const scope = cov.scopeFor(await doc(s));
    assert.deepStrictEqual(
      { count: scope.count, shrankFrom: scope.shrankFrom },
      { count: 13, shrankFrom: 259 },
    );
    ok('scopeFor reports the collapse the card renders');

    await cov.saveBranches(s, 'master', br(259));
    assert.strictEqual((await doc(s)).shrankFrom, null, 'recovery spends the warning');
    ok('a recovered scope clears the warning');
  }

  // ---- A2. a partial re-map must not read as recovered ------------------------------------
  {
    // 259 -> 13 -> 100: still far below the 259 baseline, so the warning must survive.
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(259));
    await cov.saveBranches(s, 'master', br(13));
    await cov.saveBranches(s, 'master', br(100));
    assert.strictEqual((await doc(s)).count, 100);
    assert.strictEqual((await doc(s)).shrankFrom, 259, 'a partial recovery must not clear the baseline');
    ok('a partial re-map keeps the baseline of what was actually lost');
  }
  {
    // 259 -> 100 -> 13: the second drop must not overwrite the baseline with the smaller 100.
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(259));
    await cov.saveBranches(s, 'master', br(100));
    await cov.saveBranches(s, 'master', br(13));
    assert.strictEqual((await doc(s)).count, 13);
    assert.strictEqual((await doc(s)).shrankFrom, 259, 'a second, deeper drop must keep the highest prior baseline');
    ok('a staged collapse keeps the highest baseline, not the most recent one');
  }
  {
    // 259 -> 13 -> 259: full recovery to the original baseline still clears the warning.
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(259));
    await cov.saveBranches(s, 'master', br(13));
    await cov.saveBranches(s, 'master', br(259));
    assert.strictEqual((await doc(s)).shrankFrom, null, 'reaching the baseline again must clear it');
    ok('recovering to the original baseline clears the warning');
  }

  // ---- B. an empty scope is a real state, not a skipped write ----------------------------
  {
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(259));
    await cov.saveBranches(s, 'master', []);
    const d = await doc(s);
    assert.deepStrictEqual(d.branches, [], 'the empty list must overwrite the old one');
    assert.strictEqual(d.count, 0);
    assert.strictEqual(d.shrankFrom, 259);
    assert.deepStrictEqual(await cov.loadBranches(s, 'master'), []);
    ok('a login that sees nothing persists nothing, not the previous list');
  }

  // ---- C. a non-array is a parse failure, and is refused ---------------------------------
  {
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(4));
    let warned = null;
    await cov.saveBranches(s, 'master', undefined, { warn: (m, meta) => { warned = { m, meta }; } });
    assert.strictEqual((await doc(s)).branches.length, 4, 'a non-array must not clear the list');
    assert.ok(warned && /no branch array/i.test(warned.m), 'and it must say so');
    ok('a missing branch array is refused and logged, unlike a real empty one');
  }

  // ---- D. reads degrade rather than throw ------------------------------------------------
  {
    const s = new MemoryStore();
    assert.deepStrictEqual(await cov.loadBranches(s, 'never-seen'), []);
    assert.strictEqual(cov.scopeFor(null), null);
    assert.strictEqual(cov.scopeFor({ accountId: 'x' }), null, 'a doc with no branches array is not a scope');
    ok('an uncaptured account reads as empty, never as an error');
  }

  // ---- E. the count and the list come from ONE document ----------------------------------
  {
    const s = new MemoryStore();
    await cov.saveBranches(s, 'master', br(7));
    const scope = cov.scopeFor(await doc(s));
    const list = await cov.loadBranches(s, 'master');
    assert.strictEqual(scope.count, list.length,
      'the header count and the panel rows must be derived from the same stored branches');
    ok('the header count cannot disagree with the rows beneath it');
  }

  console.log(`\n${pass}/${pass} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
