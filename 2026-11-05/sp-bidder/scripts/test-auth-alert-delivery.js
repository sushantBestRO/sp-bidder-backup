'use strict';
/**
 * THE DELIVERY-GATED SENT-MARK, which is the whole reason the 15-minute re-offer is safe.
 *
 * The account-down alert is the one message that replaces 56 symptom messages, and the two-hour
 * zero-bid suppression it authorises holds whether or not anybody ever received it. So the adapter
 * re-OFFERS it on a bounded cadence while the episode is open, and the entire argument that this is a
 * delivery retry rather than a second message rests on one property of the notifier:
 *
 *   _markSent writes its permanent dedupe document ONLY when a send actually reached somebody.
 *
 * If that were not true - if the mark were written on the attempt - the first offer would consume the
 * key while the sender was logged out, every later offer inside the episode would dedupe to nothing,
 * and the alert would be lost outright with the suppression still running. That is not hypothetical
 * here: the Maytapi sender on this deployment logs out under group-ops bursts (twice in one week,
 * documented), and 'error' rides HEALTH_POLICY 'drop' - skip and discard, no queue, no retry of its
 * own. The re-offer IS the retry.
 *
 * Until now that property was asserted only in prose, in four separate comments, and never executed.
 * This file executes it in both directions:
 *   1. sender DOWN  -> nothing sent, NO mark, and the next offer for the SAME episode still sends
 *   2. sender UP    -> sent, mark written, and the next offer for the same episode is swallowed
 *   3. a genuinely LATER episode is never swallowed by either
 *
 *   node scripts/test-auth-alert-delivery.js
 */
const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier, DEDUPE_COLLECTION } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');
const { raiseAuthDead } = require('../src/notify/authAlert');

let pass = 0;
const ok = (n) => { console.log('  ok  ' + n); pass++; };

// EXPECTED-COUNT SENTINEL. run-tests.js grades by EXIT CODE ALONE, so a file that ends early reaches
// exit 0 having asserted nothing and reads as a silent green.
const EXPECTED_CHECKS = 4;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };

/** A transport that records every send. Maytapi answers success even when it merely QUEUED. */
function sendCapture() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) };
  };
  fn.calls = calls;
  return fn;
}

// One unscoped operator recipient - which is exactly the audience this account-wide alert is for.
// A shipper-scoped group would be filtered out by scopeMatches, because the payload carries no
// shipper on purpose (it is an account fact, not a customer's load).
const RECIPIENTS = [{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }];

/**
 * The composition root's wiring, with the sender's health under the test's control. `down()` is the
 * documented recurring incident: the WhatsApp sender is logged out, so _healthAction refuses the send
 * and the notifier returns without marking anything.
 */
function deskRig() {
  const store = new MemoryStore();
  const tr = sendCapture();
  const rig = {
    store, tr,
    healthy: true,
    down() { rig.healthy = false; },
    up() { rig.healthy = true; },
    marks: async () => (await store.listDocs(DEDUPE_COLLECTION)) || [],
    sends: () => tr.calls.length,
  };
  const wa = new WhatsAppClient(Object.assign({ enabled: true, transport: tr }, CREDS));
  rig.notifier = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
    recipientsProvider: async () => RECIPIENTS, healthProvider: async () => rig.healthy });
  // raiseAuthDead is fire-and-forget by contract (it is called from the bid path and may never
  // block), so the promise it does not return is captured here instead - the test has to be able to
  // await the send it is asserting about.
  const inFlight = [];
  rig.raiser = { alert: (...args) => { const p = rig.notifier.alert(...args); inFlight.push(p); return p; } };
  rig.settle = async () => { await Promise.all(inFlight.splice(0)); };
  return rig;
}

const OUTAGE = { accountId: 'primary', accountLabel: 'Primary' };
/** One offer of the down-alert for `episode` - byte-identical to what the adapter's hook raises. */
async function offer(rig, episode) {
  raiseAuthDead(rig.raiser, Object.assign({ since: episode }, OUTAGE));
  await rig.settle();
}

(async () => {
  const EPISODE = 1_770_000_000_000;

  // ==============================================================================================
  // D1. THE SENDER IS DOWN WHEN THE OUTAGE OPENS. Nothing goes out, and - the load-bearing half -
  //     NOTHING IS MARKED. A mark here would be a permanent store document with no TTL: it would
  //     silence every later offer for this episode, and the desk would never learn the cause of a
  //     stoppage the engine is meanwhile suppressing every per-load alarm about.
  // ==============================================================================================
  {
    const rig = deskRig();
    rig.down();
    await offer(rig, EPISODE);

    assert.strictEqual(rig.sends(), 0,
      'a logged-out sender means zero WhatsApp sends - Maytapi would accept and QUEUE the message, '
      + 'then flood a stale backlog on reconnect');
    assert.deepStrictEqual(await rig.marks(), [],
      'THE PROPERTY: no sent-mark is written for a message nobody received. Writing it on the '
      + 'ATTEMPT is what would turn the 15-minute re-offer into a no-op and lose the alert outright');
    ok('an undeliverable down-alert sends nothing and, critically, marks nothing');
  }

  // ==============================================================================================
  // D2. ...AND THE RE-OFFER THEN ACTUALLY DELIVERS. The adapter re-raises with the IDENTICAL key
  //     (the key is the episode), so this is the same message getting a second chance rather than a
  //     second message. Whether it can take that chance is decided entirely by D1's non-mark.
  // ==============================================================================================
  {
    const rig = deskRig();
    rig.down();
    await offer(rig, EPISODE);
    assert.strictEqual(rig.sends(), 0, 'the first offer was dropped, as in D1');

    rig.up();                               // the operator re-links the sender's QR
    await offer(rig, EPISODE);              // same episode, same dedupe key, 15 minutes later

    assert.strictEqual(rig.sends(), 1,
      'THE RETRY IS REAL: the re-offer for the SAME episode reaches the desk, because the dropped '
      + 'first offer never consumed the key');
    const marks = await rig.marks();
    assert.strictEqual(marks.length, 1, 'and only now is the key consumed');
    assert.strictEqual(marks[0].key, `sp_auth_dead_primary_${EPISODE}`,
      'under the EPISODE key, which is what makes one outage one message');
    const body = String(rig.tr.calls[0].body.message || '');
    assert.ok(/logged out/i.test(body), 'and the message a human reads is the account-down copy');
    ok('the re-offer for the same episode delivers, because the dropped first offer left the key free');
  }

  // ==============================================================================================
  // D3. THE MIRROR, and the half that stops this from being solved by never marking at all. Once a
  //     message HAS reached somebody, every further offer inside that episode must be swallowed -
  //     the adapter re-raises on cadence for as long as the outage is open, and an outage lasting an
  //     afternoon would otherwise be the 56-message flood back under a new name.
  // ==============================================================================================
  {
    const rig = deskRig();
    await offer(rig, EPISODE);
    assert.strictEqual(rig.sends(), 1, 'a healthy sender delivers the first offer');
    assert.strictEqual((await rig.marks()).length, 1, 'and the delivery marks the key');

    for (let i = 0; i < 12; i++) await offer(rig, EPISODE);   // three hours of bounded re-offers
    assert.strictEqual(rig.sends(), 1,
      'THE FLOOD, GONE: twelve further offers across the same episode send NOTHING - a delivered '
      + 'message dedupes its own retries to zero');
    assert.strictEqual((await rig.marks()).length, 1, 'with exactly one mark to show for the outage');
    ok('a delivered down-alert swallows every later offer for the same episode');
  }

  // ==============================================================================================
  // D4. A GENUINELY LATER OUTAGE IS NEVER SWALLOWED BY EITHER OF THEM. The mark is permanent and has
  //     no TTL, so the key has to carry the episode instant as well as the account - a bare
  //     per-account key would fire once ever and every later revocation of that account would be
  //     silent, which is the exact failure class this work exists to close.
  // ==============================================================================================
  {
    const rig = deskRig();
    await offer(rig, EPISODE);
    assert.strictEqual(rig.sends(), 1, 'the first outage is delivered');
    await offer(rig, EPISODE);
    assert.strictEqual(rig.sends(), 1, 'and its own re-offer is swallowed');

    const LATER = EPISODE + 4 * 3_600_000;                    // a new outage the same afternoon
    await offer(rig, LATER);
    assert.strictEqual(rig.sends(), 2,
      'A NEW EPISODE IS A NEW MESSAGE: the second outage is not swallowed by the first outage\'s '
      + 'permanent mark, because the key carries the episode and not just the account');
    const keys = (await rig.marks()).map((d) => d.key).sort();
    assert.deepStrictEqual(keys, [`sp_auth_dead_primary_${EPISODE}`, `sp_auth_dead_primary_${LATER}`].sort(),
      'and each outage holds its own key');
    ok('a later outage on the same account gets its own message, never swallowed by an older mark');
  }

  console.log(`\n${pass}/${EXPECTED_CHECKS} checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
