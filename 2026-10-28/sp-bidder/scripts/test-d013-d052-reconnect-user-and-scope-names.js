'use strict';
/**
 * Pins D013 and D052 (fix/ops-alerting-divergences).
 *
 * D013: reconnect/verify refused a token only on a carrierId mismatch, never on user identity.
 * A reconnect by a DIFFERENT user on the SAME carrier (role change, shared login, someone else's
 * phone) must warn ops, never refuse a working reconnect. Pinned against the extracted
 * reconnectUserWarning() helper (accounts.js) - the HTTP route composes the same known/ident
 * values and calls it unchanged; a full HTTP drive would need a live-network OTP+login mock and
 * adds nothing this doesn't already prove.
 *
 * D052: a branch-scope-change alert named only a bare count ("36 removed"), so a routine
 * 1-branch drift and a customer-losing collapse produced byte-identical alerts. checkScopeChange
 * now names the customer(s) affected, off the login's own branch list (added) and the previous
 * fingerprint's persisted map (removed, since a removed branch is gone from the new list).
 *
 * @requires-summary-line
 *   node scripts/test-d013-d052-reconnect-user-and-scope-names.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { reconnectUserWarning } = require('../src/auth/accounts');
const { checkScopeChange } = require('../src/auth/scopeRefresh');
const { MemoryStore } = require('../src/store/memoryStore');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

(async () => {
  // ---- D013: reconnectUserWarning ----
  {
    assert.strictEqual(reconnectUserWarning({ label: 'Primary', knownUser: 'Ravi', identUser: 'Ravi' }), null,
      'same user: no warning');
    assert.strictEqual(reconnectUserWarning({ label: 'Primary', knownUser: null, identUser: 'Ravi' }), null,
      'no prior known user (nothing to compare against): no warning');
    assert.strictEqual(reconnectUserWarning({ label: 'Primary', knownUser: 'Ravi', identUser: null }), null,
      'login carried no user identity: no warning (never invent a mismatch)');
    const msg = reconnectUserWarning({ label: 'Primary', knownUser: 'Ravi', identUser: 'Sunita' });
    assert.ok(msg && /Primary/.test(msg) && /Ravi/.test(msg) && /Sunita/.test(msg),
      `a genuine user change names the account, the old user and the new user: got ${msg}`);
    ok('D013: reconnectUserWarning fires only on a genuine, known-vs-known user change, naming both');
  }

  // ---- D013: this is a WARNING shape (a string to log/alert), never a refusal object/throw ----
  {
    let threw = false;
    let result;
    try { result = reconnectUserWarning({ label: 'Primary', knownUser: 'Ravi', identUser: 'Sunita' }); }
    catch (_) { threw = true; }
    assert.ok(!threw, 'reconnectUserWarning never throws - it is advisory only');
    assert.strictEqual(typeof result, 'string', 'the result is alert copy, not an HTTP error/refusal shape');
    ok('D013: a different-user reconnect is advisory (a string to alert on), never a thrown refusal');
  }

  // ---- D013 (review correction, 26 Sep): compares the stable userId, not the mutable display
  // name - a coincidence or a rename on the DISPLAY name must never mask or manufacture a warning.
  {
    // Same display name, different userId (a shared/generic login label, or two staff sharing a
    // name) - a genuine identity change that the old display-only compare would have missed entirely.
    const missedBefore = reconnectUserWarning({
      label: 'Primary', knownUser: 'Field Ops', identUser: 'Field Ops', knownUserId: 'u_101', identUserId: 'u_202',
    });
    assert.ok(missedBefore && /u_101/.test(missedBefore) === false, // message stays human-readable, not raw ids
      `D013: same display name but a different userId still warns (identity change), got: ${missedBefore}`);
    assert.ok(/Field Ops/.test(missedBefore), 'the message still shows the (identical) display names for a human to read');

    // Different display name, same userId (an ordinary profile rename) - must NOT warn; the old
    // display-only compare would have false-positived on every rename.
    const falseAlarmBefore = reconnectUserWarning({
      label: 'Primary', knownUser: 'Ravi Kumar', identUser: 'Ravi K.', knownUserId: 'u_555', identUserId: 'u_555',
    });
    assert.strictEqual(falseAlarmBefore, null, 'D013: an unchanged userId never warns, even if the display name was edited');

    // Backward compatible: no userId supplied at all (a caller that has none) still compares on
    // the display name, exactly as before - this is what every case above this one in the file relies on.
    assert.strictEqual(
      reconnectUserWarning({ label: 'Primary', knownUser: 'Ravi', identUser: 'Ravi' }), null,
      'fixture: the no-userId path still behaves exactly as the original display-only compare');
    ok('D013: the comparison is keyed on userId when available - a rename never false-alarms, a same-name identity change never hides');
  }

  // ---- D013 (review correction): the /reconnect/verify call site actually PASSES userId, not
  // just the generic helper being ABLE to accept it. A static check on the real source line, cheap
  // and durable against a future edit reverting the call site back to display-name-only args
  // (a full OTP+adapter+HTTP drive of this route exists nowhere in this suite and would add scaffolding
  // this line-level check makes unnecessary for catching exactly the regression the review found).
  {
    const serverSrc = fs.readFileSync(path.join(__dirname, '../src/web/server.js'), 'utf8');
    const callSite = serverSrc.split('\n').find((l) => l.includes('reconnectUserWarning({'));
    assert.ok(callSite, 'fixture: found the reconnectUserWarning( call site in server.js');
    const block = serverSrc.slice(serverSrc.indexOf('const userWarning = reconnectUserWarning('), serverSrc.indexOf('const userWarning = reconnectUserWarning(') + 300);
    assert.ok(/knownUserId/.test(block) && /identUserId/.test(block),
      `D013: the /reconnect/verify call site passes knownUserId/identUserId, not just display names - got: ${block}`);
    ok('D013: the real reconnect/verify call site passes userId into reconnectUserWarning, not only display names');
  }

  // ---- D052: an added branch is named off the CURRENT login's own branch list ----
  {
    const store = new MemoryStore();
    const notifier = { calls: [], alert(kind, payload, opts) { this.calls.push({ kind, payload, opts }); return Promise.resolve(); } };
    await checkScopeChange({ store, notifier, accountId: 'primary', accountLabel: 'Primary', branchIds: [1, 2],
      branches: [{ branchId: 1, customer: 'Havells' }, { branchId: 2, customer: 'Syngenta' }] });
    notifier.calls.length = 0;
    await checkScopeChange({ store, notifier, accountId: 'primary', accountLabel: 'Primary', branchIds: [1, 2, 3],
      branches: [{ branchId: 1, customer: 'Havells' }, { branchId: 2, customer: 'Syngenta' }, { branchId: 3, customer: 'Tata Consumer' }] });
    assert.strictEqual(notifier.calls.length, 1, 'the scope change fired one alert');
    const detail = notifier.calls[0].payload.detail;
    assert.ok(/Tata Consumer/.test(detail), `D052: an added branch names its customer in the alert: got "${detail}"`);
    ok('D052: an added branch is named by customer, off the current login\'s branch list');
  }

  // ---- D052: a REMOVED branch is still named, off the PERSISTED previous map ----
  {
    const store = new MemoryStore();
    const notifier = { calls: [], alert(kind, payload, opts) { this.calls.push({ kind, payload, opts }); return Promise.resolve(); } };
    await checkScopeChange({ store, notifier, accountId: 'primary', accountLabel: 'Primary', branchIds: [1, 2, 3],
      branches: [{ branchId: 1, customer: 'Havells' }, { branchId: 2, customer: 'Syngenta' }, { branchId: 3, customer: 'Tata Consumer' }] });
    notifier.calls.length = 0;
    // Tata Consumer's branch (3) drops out - it does NOT appear in this login's own branch list.
    await checkScopeChange({ store, notifier, accountId: 'primary', accountLabel: 'Primary', branchIds: [1, 2],
      branches: [{ branchId: 1, customer: 'Havells' }, { branchId: 2, customer: 'Syngenta' }] });
    assert.strictEqual(notifier.calls.length, 1, 'the scope change fired one alert');
    const detail = notifier.calls[0].payload.detail;
    assert.ok(/Tata Consumer/.test(detail),
      `D052: a REMOVED branch still names its customer, from the persisted prior map: got "${detail}"`);
    ok('D052: a removed branch is still named by customer, off the persisted previous fingerprint');
  }

  // ---- control: a bare count-only change (no customer names known) still fires cleanly ----
  {
    const store = new MemoryStore();
    const notifier = { calls: [], alert(kind, payload, opts) { this.calls.push({ kind, payload, opts }); return Promise.resolve(); } };
    await checkScopeChange({ store, notifier, accountId: 'primary', accountLabel: 'Primary', branchIds: [1, 2] });
    notifier.calls.length = 0;
    await checkScopeChange({ store, notifier, accountId: 'primary', accountLabel: 'Primary', branchIds: [1, 2, 3] });
    assert.strictEqual(notifier.calls.length, 1, 'control: still fires with no branches/customer data at all');
    assert.ok(/1 added, 0 removed/.test(notifier.calls[0].payload.detail), 'control: the count-only shape is unchanged');
    ok('control: no customer data available still produces the original count-only alert (no crash, no fabricated name)');
  }

  console.log(`\n${pass}/7 checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
