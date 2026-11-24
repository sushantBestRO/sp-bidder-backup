'use strict';
/**
 * W1-8 F3: A SECOND SAME-KEY EVENT ARRIVING WHILE THE FIRST SEND IS IN FLIGHT MUST NOT BE LOST IF
 * THE FIRST SEND FAILS.
 *
 * Regression target: the Notifier's `_inFlight` reservation (see the class doc, "in-flight dedupe
 * reservation") is a plain Set. A SECOND call sharing a dedupeKey with an in-flight first call
 * returns `true` (treated as "the in-flight send will do the delivery") without checking whether that
 * first send actually lands. If the holder's send fails - every recipient's send errors, or the
 * sender-health check skips it after the reservation was taken - the persistent mark is never
 * written, and the waiter, having already returned, never tries again. The event that arrived second
 * is silently dropped.
 *
 * Fix under test: `_inFlight` is a Map of dedupeKey -> a promise that resolves to whether that
 * attempt actually delivered. A waiter awaits it and sends itself unless the holder delivered (or the
 * persistent mark landed by some other means in between).
 *
 *   node scripts/test-notifier-inflight-waiter.js
 */
const assert = require('assert');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');

let pass = 0;
const ok = (n, msg) => { console.log(`  ok  ${n}. ${msg}`); pass++; };

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const RECIPIENTS = [{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }];
const listPhonesOk = { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };

function mkNotifier(transport) {
  const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport });
  return new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
    recipientsProvider: async () => RECIPIENTS });
}

(async () => {
  console.log('\nA waiter behind a failed in-flight send must deliver itself\n');

  // 1. THE DEFECT'S OWN MECHANISM: the holder's send FAILS while a second same-key event waits on it.
  {
    let releaseSend, sendStarted;
    const gate = new Promise((res) => { releaseSend = res; });
    const started = new Promise((res) => { sendStarted = res; });
    let calls = 0;
    const tr = async (url) => {
      if (/listPhones/.test(url)) return listPhonesOk;
      calls++;
      if (calls === 1) { sendStarted(); await gate; return { ok: false, status: 500, json: async () => ({}) }; }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `m${calls}` } }) };
    };
    const n = mkNotifier(tr);
    const dedupeKey = 'FLOOD-1_error_x';
    const payload = { context: 'FLOOD-1', detail: 'boom', auctionId: 'FLOOD-1' };

    const p1 = n.alert('error', payload, { dedupeKey });
    await started;                       // p1 now holds the reservation and is hung inside its send
    const p2 = n.alert('error', payload, { dedupeKey }); // a second same-key event arrives in flight
    releaseSend();                        // let the holder's send fail
    await Promise.all([p1, p2]);

    assert.strictEqual(calls, 2,
      `the holder's send failed, so the waiter must attempt delivery itself; the wire was called ${calls} time(s), expected 2`);
    const delivered = await n.wasDelivered(dedupeKey);
    assert.strictEqual(delivered, true,
      'a first send that failed while a second same-key event was in flight must still leave the message delivered');
    ok(1, 'a waiter behind a failed holder sends itself and the message is not lost');
  }

  // 2. MUST STAY GREEN: when the holder SUCCEEDS, a waiter behind it must not also send (no
  //    regression on the collapsing behaviour the reservation exists for).
  {
    let releaseSend, sendStarted;
    const gate = new Promise((res) => { releaseSend = res; });
    const started = new Promise((res) => { sendStarted = res; });
    let calls = 0;
    const tr = async (url) => {
      if (/listPhones/.test(url)) return listPhonesOk;
      calls++;
      if (calls === 1) { sendStarted(); await gate; }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `m${calls}` } }) };
    };
    const n = mkNotifier(tr);
    const dedupeKey = 'FLOOD-2_error_x';
    const payload = { context: 'FLOOD-2', detail: 'boom', auctionId: 'FLOOD-2' };

    const p1 = n.alert('error', payload, { dedupeKey });
    await started;
    const p2 = n.alert('error', payload, { dedupeKey });
    releaseSend();
    await Promise.all([p1, p2]);

    assert.strictEqual(calls, 1, `the holder delivered it; the waiter must not also send - wire was called ${calls} time(s), expected 1`);
    ok(2, 'a waiter behind a SUCCESSFUL holder does not double-send');
  }

  // 3. CONTROL: distinct dedupeKeys overlapping in flight both send independently (unaffected by this
  //    fix - the reservation and its promise are per key).
  {
    let releaseFirst;
    const gate = new Promise((res) => { releaseFirst = res; });
    let calls = 0;
    const tr = async (url) => {
      if (/listPhones/.test(url)) return listPhonesOk;
      calls++;
      if (calls === 1) await gate;
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: `m${calls}` } }) };
    };
    const n = mkNotifier(tr);
    const p1 = n.alert('error', { context: 'A', detail: 'x', auctionId: 'A' }, { dedupeKey: 'A_error_x' });
    const p2 = n.alert('error', { context: 'B', detail: 'y', auctionId: 'B' }, { dedupeKey: 'B_error_x' });
    releaseFirst();
    await Promise.all([p1, p2]);
    assert.strictEqual(calls, 2, `two distinct dedupeKeys overlapping in flight must both reach the wire, got ${calls}`);
    ok(3, 'distinct dedupeKeys overlapping in flight are unaffected - both send');
  }

  console.log(`\nPASS - ${pass} checks`);
})().catch((e) => {
  console.error('\nFAIL -', (e && e.stack) || e);
  process.exit(1);
});
