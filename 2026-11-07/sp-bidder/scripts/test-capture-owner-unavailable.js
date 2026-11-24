'use strict';
/**
 * Regression: CW-268 - a priced request owned by
 * Rallis silently armed Primary after Rallis failed to boot. A bid from another
 * tenant cannot reach the load, while the request incorrectly reads "armed".
 *
 * `should_park_an_explicit_owner_request_when_that_owner_is_unavailable` pins the
 * capture seam: keep the desk's rate, park with `platform_stack_unavailable`, and
 * never arm a sibling account. The two controls prove a healthy exact owner and
 * the old untagged-primary request still arm normally. CW-268 D1 review repairs
 * also pin the re-price stop race, the audit trail for every saved-and-held
 * money or band write, and restart-time intent ownership.
 *
 * @requires-summary-line
 *
 *   node scripts/test-capture-owner-unavailable.js
 */
process.env.PLATFORM = 'mock';
process.env.STORE_BACKEND = 'memory';
process.env.SP_HARD_CLOSE_ONLY = '0';
process.env.SP_NOTIFY_MODE = 'dashboard';
process.env.SP_MIN_PLAUSIBLE_COST = '1';
process.env.SP_MIN_COST_ABS = '0';
process.env.SP_MIN_COST_PER_KM = '0';
process.env.SP_MARGINS_PCT = '9,5,1';
process.env.SP_MIN_MARGIN_PCT = '1';
process.env.LOG_LEVEL = 'silent';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'server.js'), 'utf8');

// Test data is kept under the repo's ignored, permanent data/ tree rather than a disposable
// system temp directory. Each process has its own intent file, so a prior run cannot affect it.
process.env.SP_DATA_DIR = path.join(__dirname, '..', 'data', 'logs', 'test-runs', `capture-owner-unavailable-${process.pid}`);
fs.mkdirSync(process.env.SP_DATA_DIR, { recursive: true });
delete process.env.SP_ADMIN_PASS_HASH;
delete process.env.SP_SESSION_SECRET;

const serverModule = require('../src/web/server');
const { app, requests, stacks, stackForRequest, portalFactsFor, loadWillNotBid, rehydrateOwnedStack } = serverModule;

let pass = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  pass += 1;
  console.log(`  ok  ${message}`);
}

function postJson(base, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(pathname, base);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        origin: base,
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    request.end(data);
  });
}

async function auditRowsFor(base, loadId, action) {
  const response = await fetch(`${base}/api/config/audit?from=0`);
  assert.strictEqual(response.status, 200, `setup: audit stream is readable (HTTP ${response.status})`);
  const payload = await response.json();
  return (payload.changes || []).filter((event) => event && event.action === action
    && Array.isArray(event.changed) && event.changed.some((change) => String(change).includes(loadId)));
}

async function rehydrateStackForTest(stack) {
  // The fallback is only for the controlled red run against bfbd616, which had no
  // ownership-aware entry point. Once the repair exports it, this test invokes the
  // production guard rather than recreating its selection logic in the test.
  if (typeof rehydrateOwnedStack === 'function') return rehydrateOwnedStack(stack);
  return stack.engine.rehydrate();
}

function activationUsesOwnerAwareRehydrate() {
  const start = serverSource.indexOf('async function activateRealStack(stack)');
  const end = serverSource.indexOf('// Old releases could save an intent under a sibling account.', start);
  assert.ok(start >= 0 && end > start, 'setup: locate the reconnect activation boundary');
  const activation = serverSource.slice(start, end);
  return /await rehydrateOwnedStack\(stack\)/.test(activation)
    && !/await stack\.engine\.rehydrate\(\)/.test(activation);
}

function load(id, account) {
  return {
    id,
    lane: { origin: 'Palghar', destination: 'Jaipur' },
    equipment: 'SXL',
    units: 1,
    quoteType: 'FTL',
    companyName: 'Waaree Energies',
    closesAt: Date.now() + 40 * 60_000,
    startsAt: Date.now() - 60_000,
    softClose: false,
    closeModelKnown: true,
    status: 'live',
    account,
  };
}

async function should_park_an_explicit_owner_request_when_that_owner_is_unavailable(base) {
  const primary = stacks[0];
  assert.ok(primary && primary.account && primary.account.accountId === 'primary', 'setup: mock server has the implicit Primary stack');

  // Arrange: Rallis owned the request, but only Primary booted. This is the production D1 shape.
  const rallis = { accountId: 'rallis', label: 'Rallis' };
  const unavailable = await requests.createForLoad(load('D1-RALLIS-OFFLINE', rallis));
  const notice = loadWillNotBid(unavailable, portalFactsFor(unavailable));
  ok(notice.willNotBid === 'platform_stack_unavailable' && notice.keepsCost
      && /account.*unavailable/i.test(notice.body),
    'the price page explains that its account is unavailable and the cost can be saved');
  const previewResponse = await fetch(`${base}/price/${unavailable.id}/preview?cost=29000`);
  const preview = await previewResponse.json();
  ok(previewResponse.status === 200 && preview.willNotBid === 'platform_stack_unavailable'
      && preview.ladder.length === 0 && /account.*unavailable/i.test(preview.notice),
    'an offline owner has no sibling-engine price preview and gets an actionable account notice');

  // Act: capture a valid desk rate through the production HTTP capture seam.
  const response = await postJson(base, `/price/${unavailable.id}`, { cost: 29_000 });
  const parked = await requests.getByToken(unavailable.id);

  // Assert: the price persists and the row is parked. Primary must receive no monitor or intent.
  ok(response.status === 409 && /cost was saved/i.test((response.json && response.json.error) || ''),
    `D1: the unavailable owner produces the saved-but-not-bidding response (HTTP ${response.status}: ${response.json && response.json.error})`);
  ok(parked && parked.status === 'stopped' && parked.heldReason === 'platform_stack_unavailable'
      && parked.price && parked.price.cost === 29_000,
  `D1: Rallis's rate is kept on a parked request (status=${parked && parked.status}, reason=${parked && parked.heldReason}, cost=${parked && parked.price && parked.price.cost})`);
  ok(!primary.engine.monitors.has('D1-RALLIS-OFFLINE') && !primary.engine.scheduler.get('D1-RALLIS-OFFLINE'),
    'D1: Primary never receives an armed monitor or durable intent for the Rallis load');

  // Positive control: when Rallis is healthy, the same explicit owner arms its own stack.
  primary.account = rallis;
  const healthy = await requests.createForLoad(load('D1-RALLIS-HEALTHY', rallis));
  const healthyResponse = await postJson(base, `/price/${healthy.id}`, { cost: 29_000 });
  ok(healthyResponse.status === 200 && primary.engine.monitors.has('D1-RALLIS-HEALTHY'),
    `control: a healthy exact owner still arms its own stack (HTTP ${healthyResponse.status})`);

  primary.engine.stop('D1-RALLIS-HEALTHY');
  primary.account = { accountId: 'primary', label: 'Primary', implicit: true };
  const repricedResponse = await postJson(base, `/price/${healthy.id}`,
    { cost: 30_000, m_0: 9, m_1: 5, m_2: 1 });
  const repriced = await requests.getByToken(healthy.id);
  ok(repricedResponse.status === 409 && repriced.price.cost === 30_000
      && repriced.status === 'stopped' && repriced.heldReason === 'platform_stack_unavailable',
    'a reprice keeps the corrected cost parked when its owner disappears');
  ok(!primary.engine.monitors.has('D1-RALLIS-HEALTHY'),
    'the reprice never installs a monitor on the surviving sibling');

  // Arrange: force the operator Stop exactly after the re-price write and before the
  // owner-unavailable hold. No timer is involved: this wrapper is the persistence seam.
  primary.account = rallis;
  const race = await requests.createForLoad(load('D1-RALLIS-STOP-RACE', rallis));
  const raceArmed = await postJson(base, `/price/${race.id}`, { cost: 29_000 });
  assert.strictEqual(raceArmed.status, 200, 'setup: the race fixture is armed while Rallis is live');
  primary.engine.stop('D1-RALLIS-STOP-RACE');
  primary.account = { accountId: 'primary', label: 'Primary', implicit: true };
  const originalHoldUnbiddable = requests.holdUnbiddable.bind(requests);
  let operatorStopped = false;
  requests.holdUnbiddable = async (id, reason, options) => {
    if (!operatorStopped && id === race.id && reason === 'platform_stack_unavailable') {
      operatorStopped = true;
      await requests.stop(id);
    }
    return originalHoldUnbiddable(id, reason, options);
  };
  let raceResponse;
  try {
    raceResponse = await postJson(base, `/price/${race.id}`, { cost: 30_000, m_0: 9, m_1: 5, m_2: 1 });
  } finally {
    requests.holdUnbiddable = originalHoldUnbiddable;
  }
  const stoppedByOperator = await requests.getByToken(race.id);
  ok(operatorStopped && raceResponse.status === 409,
    'CW-268 D1 review: the operator Stop interleaves after the saved reprice and before the unavailable-owner hold');
  ok(stoppedByOperator.status === 'stopped' && !stoppedByOperator.heldReason
      && !primary.engine.monitors.has('D1-RALLIS-STOP-RACE'),
    'CW-268 D1 review: an operator Stop retains its status and empty held reason, so parked-work rearm cannot install a monitor');

  const publicRepriceAudit = await auditRowsFor(base, 'D1-RALLIS-HEALTHY', 'margin_override_set');
  ok(publicRepriceAudit.length === 1
      && publicRepriceAudit[0].changes[0].before.cost === 29_000
      && publicRepriceAudit[0].changes[0].after.cost === 30_000
      && publicRepriceAudit[0].changes[0].after.marginsPct.join() === '9,5,1',
    'CW-268 D1 review: a saved-and-held public reprice records its exact cost and band once');

  // The console routes take their own early 409 returns. Each starts healthy so the
  // price request is actually armed, then loses its exact owner before the confirmed write.
  primary.account = rallis;
  const adminSet = await requests.createForLoad(load('D1-RALLIS-AUDIT-SET', rallis));
  assert.strictEqual((await postJson(base, `/price/${adminSet.id}`, { cost: 29_000 })).status, 200,
    'setup: the console-set fixture is armed while Rallis is live');
  primary.account = { accountId: 'primary', label: 'Primary', implicit: true };
  const adminSetResponse = await postJson(base, `/api/price-requests/${adminSet.id}/margin`, {
    marginsPct: [12, 8, 2], minMarginPct: 2, cost: 31_000, confirm: true,
  });
  const adminSetDoc = await requests.getByToken(adminSet.id);
  const adminSetAudit = await auditRowsFor(base, 'D1-RALLIS-AUDIT-SET', 'margin_override_set');
  ok(adminSetResponse.status === 409 && adminSetDoc.price.cost === 31_000
      && adminSetDoc.marginsPct.join() === '12,8,2' && adminSetAudit.length === 1
      && adminSetAudit[0].changes[0].after.cost === 31_000
      && adminSetAudit[0].changes[0].after.marginsPct.join() === '12,8,2',
    'CW-268 D1 review: a saved-and-held console margin set records its exact cost and band once');

  primary.account = rallis;
  const adminClear = await requests.createForLoad(load('D1-RALLIS-AUDIT-CLEAR', rallis));
  assert.strictEqual((await postJson(base, `/price/${adminClear.id}`, {
    cost: 29_000, m_0: 12, m_1: 8, m_2: 2,
  })).status, 200, 'setup: the console-clear fixture is armed on an override while Rallis is live');
  primary.account = { accountId: 'primary', label: 'Primary', implicit: true };
  const adminClearResponse = await postJson(base, `/api/price-requests/${adminClear.id}/margin/clear`, { confirm: true });
  const adminClearDoc = await requests.getByToken(adminClear.id);
  const adminClearAudit = await auditRowsFor(base, 'D1-RALLIS-AUDIT-CLEAR', 'margin_override_clear');
  ok(adminClearResponse.status === 409 && adminClearDoc.price.cost === 29_000
      && adminClearDoc.marginsPct.join() === '9,5,1' && adminClearAudit.length === 1
      && adminClearAudit[0].changes[0].after.cost === 29_000
      && adminClearAudit[0].changes[0].after.marginsPct.join() === '9,5,1',
    'CW-268 D1 review: a saved-and-held console margin clear records its restored band once');

  // A restart sees the durable intent before it sees the request's explicit account.
  // Removing the Rallis monitor simulates that restart while retaining the real, active intent.
  primary.account = rallis;
  const restartWrongOwner = await requests.createForLoad(load('D1-RALLIS-REHYDRATE-WRONG', rallis));
  assert.strictEqual((await postJson(base, `/price/${restartWrongOwner.id}`, { cost: 29_000 })).status, 200,
    'setup: the wrong-owner restart fixture is armed under Rallis');
  primary.engine.stop('D1-RALLIS-REHYDRATE-WRONG');
  assert.ok(primary.engine.scheduler.get('D1-RALLIS-REHYDRATE-WRONG'),
    'setup: restart keeps the active durable intent after its live monitor leaves memory');
  primary.account = { accountId: 'primary', label: 'Primary', implicit: true };
  await rehydrateStackForTest(primary);
  const wrongOwnerIntent = primary.engine.scheduler.get('D1-RALLIS-REHYDRATE-WRONG');
  const wrongOwnerRequest = await requests.getByToken(restartWrongOwner.id);
  ok(!primary.engine.monitors.has('D1-RALLIS-REHYDRATE-WRONG')
      && wrongOwnerIntent.status === 'stopped' && wrongOwnerRequest.status === 'stopped'
      && wrongOwnerRequest.heldReason === 'account_owner_mismatch'
      && wrongOwnerRequest.price.cost === 29_000,
    'CW-268 D1 review: a Rallis intent on a relabelled Primary stack is durably stopped and its saved cost is held for the desk');
  ok(activationUsesOwnerAwareRehydrate(),
    'CW-268 D1 review: reconnect activation awaits the ownership guard instead of direct engine rehydrate');

  // Positive control: the same persisted-intent route continues to restore work to its exact owner.
  primary.account = rallis;
  const restartExactOwner = await requests.createForLoad(load('D1-RALLIS-REHYDRATE-EXACT', rallis));
  assert.strictEqual((await postJson(base, `/price/${restartExactOwner.id}`, { cost: 29_000 })).status, 200,
    'setup: the exact-owner restart control is armed under Rallis');
  primary.engine.stop('D1-RALLIS-REHYDRATE-EXACT');
  await rehydrateStackForTest(primary);
  ok(primary.engine.monitors.has('D1-RALLIS-REHYDRATE-EXACT'),
    'control: an exact-owner intent still rehydrates after restart');

  primary.account = rallis;
  const soleLegacy = await requests.createForLoad(load('D1-LEGACY-SOLE', null));
  const soleResponse = await postJson(base, `/price/${soleLegacy.id}`, { cost: 29_000 });
  ok(soleResponse.status === 200 && primary.engine.monitors.has('D1-LEGACY-SOLE'),
    'an untagged legacy request still uses the only available account');
  stacks.push({ ...primary, account: { accountId: 'another-account' } });
  try {
    const ambiguous = await requests.createForLoad(load('D1-LEGACY-AMBIGUOUS', null));
    const ambiguousResponse = await postJson(base, `/price/${ambiguous.id}`, { cost: 29_000 });
    ok(ambiguousResponse.status === 409 && !primary.engine.monitors.has('D1-LEGACY-AMBIGUOUS'),
      'an untagged request cannot choose arbitrarily between two non-primary accounts');
  } finally { stacks.pop(); }

  // Legacy records had no account tag. Their established implicit-Primary routing must remain.
  primary.account = { accountId: 'primary', label: 'Primary', implicit: true };
  stacks.unshift({ ...primary, account: { accountId: 'first-sibling' } });
  const legacy = await requests.createForLoad(load('D1-LEGACY-PRIMARY', null));
  assert.strictEqual(stackForRequest(legacy), primary, 'legacy Primary must win over an earlier sibling');
  const legacyResponse = await postJson(base, `/price/${legacy.id}`, { cost: 29_000 });
  ok(legacyResponse.status === 200 && primary.engine.monitors.has('D1-LEGACY-PRIMARY'),
    `control: an untagged legacy request still arms implicit Primary (HTTP ${legacyResponse.status})`);
  stacks.shift();
}

(async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await should_park_an_explicit_owner_request_when_that_owner_is_unavailable(base);
    assert.strictEqual(pass, 19);
    console.log('\n19/19 checks passed');
  } finally {
    for (const id of ['D1-RALLIS-OFFLINE', 'D1-RALLIS-HEALTHY', 'D1-RALLIS-STOP-RACE', 'D1-RALLIS-AUDIT-SET', 'D1-RALLIS-AUDIT-CLEAR', 'D1-RALLIS-REHYDRATE-WRONG', 'D1-RALLIS-REHYDRATE-EXACT', 'D1-LEGACY-PRIMARY', 'D1-LEGACY-SOLE', 'D1-LEGACY-AMBIGUOUS']) {
      for (const stack of stacks) {
        try { stack.engine.stop(id); } catch (_) {}
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error('FAIL:', error && error.stack ? error.stack : error);
  process.exit(1);
});
