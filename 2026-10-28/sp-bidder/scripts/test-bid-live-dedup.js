'use strict';
/**
 * bid_live alert: exactly ONE loud "we've entered this auction" ping per auction, carrying the
 * ESTABLISHING (rung 0) bid's amount + opening margin - never a step-down rung's amount mislabeled as
 * "First bid ... + <band-top>%".
 *
 * The bug (deployed 95f1d39 / #50): the engine emits a bid_placed for every descending-ladder rung,
 * engineAlerts maps each to a bid_live alert sharing dedupeKey `<auctionId>_bid_live`, and the Notifier
 * only MARKED that key AFTER the whole Maytapi send loop (0.7-2.1s). Two rungs firing ~1s apart both
 * passed _alreadySent before the first marked -> both sent, and the second carried a step-down price
 * still labeled "First bid ... + 12.6%" (openingPct is the band's TOP margin, restamped every rung, not
 * the fired rung's own margin).
 *
 * Two-layer fix, tested here:
 *   1. GATE (primary) - notifyEngineEvent fires the loud bid_live only for the establishing rung
 *      (evt.rungIndex === 0). A step-down rung never reaches WhatsApp, so "First bid" + openingPct are
 *      correct by construction. Gated at the router, not toNotification, so the mapper stays pure.
 *   2. DEDUPE (defence in depth) - a synchronous in-flight reservation in Notifier closes the old
 *      check->mark race so even a restart/re-arm re-fire (also rungIndex 0) or any residual double-fire
 *      can only send once. The persistent notifSent mark is unchanged, so every retry-on-failure path
 *      (sender-health skip, all-recipients-failed) still re-fires.
 *
 *   node scripts/test-bid-live-dedup.js
 */
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { MemoryStore } = require('../src/store');
const { renderMessage } = require('../src/notify/waTemplates');
const { toNotification, notifyEngineEvent } = require('../src/notify/engineAlerts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const recipients = [{ name: 'Desk', phone: '+919000000001', alerts: ['bid_live', 'outbid'] }];

// The bid_live alert descriptor engineAlerts produces for a given rung's bid_placed event. Same cost +
// band-top openingPct on every rung (that is the point - openingPct is NOT the fired rung's margin);
// only price changes down the ladder.
function bidLiveDescriptor(auctionId, price, rungIndex) {
  return toNotification({
    type: 'bid_placed', auctionId, price, rungIndex,
    lane: { origin: 'Khopoli', destination: 'Sardarshahar' }, companyName: 'Renewsys',
    cost: 80000, openingPct: 12.6,
  });
}

// A transport that records each send body. `sendResult` (optional) overrides the per-send response so a
// test can force a Maytapi failure; the listPhones branch keeps any health probe happy.
function immediate(sendResult) {
  const calls = [];
  const fn = async (url, opts) => {
    if (/listPhones/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };
    calls.push(JSON.parse(opts.body));
    return sendResult ? sendResult() : { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // 0a. GATE via the real router: a 3-rung snipe through notifyEngineEvent fires the loud bid_live
  //     exactly once, on the establishing rung, correctly labeled.
  {
    const tr = immediate();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients });
    const evt = (price, rungIndex) => ({ type: 'bid_placed', auctionId: 'GATE1', price, rungIndex,
      lane: { origin: 'Khopoli', destination: 'Sardarshahar' }, companyName: 'Renewsys', cost: 80000, openingPct: 12.6 });
    await notifyEngineEvent(n, evt(90080, 0));   // establish
    await notifyEngineEvent(n, evt(85760, 1));   // +7.2% step-down
    await notifyEngineEvent(n, evt(82160, 2));   // floor
    ok(tr.calls.length === 1, 'gate: a 3-rung snipe through notifyEngineEvent fires the loud bid_live exactly once');
    ok(tr.calls[0] && /90,080/.test(tr.calls[0].message) && /12\.6%/.test(tr.calls[0].message)
      && !/85,760/.test(tr.calls[0].message), 'gate: the one alert is the ESTABLISH rung (90,080 + 12.6%), never a step-down');
  }

  // 0b. GATE isolation: a step-down rung with NO preceding establish fires NO loud alert. The dedupe
  //     cannot help here (there is no prior send to dedupe against), so this fails without the rungIndex
  //     gate - proving the gate itself, and that the "+12.6%" step-down mislabel can never reach WhatsApp.
  {
    const tr = immediate();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients });
    await notifyEngineEvent(n, { type: 'bid_placed', auctionId: 'GATE2', price: 85760, rungIndex: 1,
      lane: { origin: 'A', destination: 'B' }, companyName: 'X', cost: 80000, openingPct: 12.6 });
    ok(tr.calls.length === 0, 'gate: a lone non-establish rung (rungIndex 1) fires NO loud bid_live');
  }

  // 1. SEQUENTIAL multi-rung -> exactly ONE bid_live, carrying the ESTABLISH (rung 0) amount + margin.
  {
    const tr = immediate();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients });
    const r0 = bidLiveDescriptor('AUC1', 90080, 0);
    const r1 = bidLiveDescriptor('AUC1', 85760, 1);
    const r2 = bidLiveDescriptor('AUC1', 82160, 2);
    await n.alert(r0.kind, r0.data, { dedupeKey: r0.dedupeKey });
    await n.alert(r1.kind, r1.data, { dedupeKey: r1.dedupeKey });
    await n.alert(r2.kind, r2.data, { dedupeKey: r2.dedupeKey });

    const msg0 = renderMessage('bid_live', r0.data);
    const msg1 = renderMessage('bid_live', r1.data);
    ok(msg0 !== msg1, 'sanity: the establish-rung and step-down-rung messages actually differ');
    ok(tr.calls.length === 1, 'sequential 3-rung snipe -> exactly ONE bid_live send (not one per rung)');
    ok(tr.calls[0] && tr.calls[0].message === msg0, 'the one send is the ESTABLISH rung (90,080) message');
    ok(tr.calls[0] && tr.calls[0].message !== msg1, 'the send is NOT the +7.2% step-down (85,760)');
    ok(tr.calls[0] && /90,080/.test(tr.calls[0].message) && /12\.6%/.test(tr.calls[0].message)
      && !/85,760/.test(tr.calls[0].message), 'label = "First bid ...90,080...12.6%", never the mislabeled 85,760');
  }

  // 2. CONCURRENT race -> the in-flight reservation blocks the second fire WHILE the first send is in
  //    flight (the exact timing that double-fired live). Gate the transport so rung 0 parks mid-send.
  {
    let releaseSend, sendStartedRes, firstSend = true;
    const gate = new Promise((res) => { releaseSend = res; });
    const sendStarted = new Promise((res) => { sendStartedRes = res; });
    const calls = [];
    const tr = async (url, opts) => {
      if (/listPhones/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 128023, number: '9', status: 'active' }] }) };
      calls.push(JSON.parse(opts.body));
      // Only the FIRST send parks (simulates the 0.7-2.1s Maytapi round-trip while rung 0 holds the
      // reservation). A wrongly-admitted SECOND send resolves immediately, so the unfixed code fails
      // this test with a clean calls.length === 2 rather than deadlocking both sends on the gate.
      if (firstSend) { firstSend = false; sendStartedRes(); await gate; }
      return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' + calls.length } }) };
    };
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients });
    const r0 = bidLiveDescriptor('AUC2', 90080, 0);
    const r1 = bidLiveDescriptor('AUC2', 85760, 1);

    const p0 = n.alert(r0.kind, r0.data, { dedupeKey: r0.dedupeKey });   // hangs inside the send
    await sendStarted;                                                    // rung 0 now holds the reservation
    await n.alert(r1.kind, r1.data, { dedupeKey: r1.dedupeKey });         // second rung ~1s later
    ok(calls.length === 1, 'race: the second rung is blocked while the first send is in flight (1 send, not 2)');
    releaseSend();
    await p0;
    ok(calls.length === 1, 'race: still exactly ONE send after the first completes');
    ok(calls[0] && calls[0].message === renderMessage('bid_live', r0.data), 'race: the single send is the ESTABLISH rung, never the step-down');
  }

  // 3. RETRY preserved (sender-health skip): session DOWN -> not sent, NOT marked, reservation released
  //    -> a re-fire once healthy still goes out (the reservation must not permanently block a retry).
  {
    const tr = immediate();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    let healthy = false;
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => recipients, healthProvider: async () => healthy });
    const r0 = bidLiveDescriptor('AUC3', 90080, 0);

    const down = await n._whatsapp(r0.kind, r0.dedupeKey, r0.data);
    ok(down === false, 'health-skip returns false (retryable)');
    ok(tr.calls.length === 0, 'health-skip: nothing sent');
    ok(((await store.listDocs('notifSent')) || []).length === 0, 'health-skip: dedupe NOT marked');
    healthy = true;
    await n._whatsapp(r0.kind, r0.dedupeKey, r0.data);   // recovery re-fire
    ok(tr.calls.length === 1, 'recovery re-fire sends (reservation was released, key never marked)');
  }

  // 4. RETRY preserved (all recipients failed): a failed send (ok:false, sent === 0) does NOT mark the
  //    key and releases the reservation, so a genuine re-fire attempts again - the same implicit retry
  //    the old mark-after-send-if-sent>0 gave, unchanged by this fix.
  {
    let failNext = true;
    const tr = immediate(() => (failNext
      ? { ok: false, status: 500, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'm' } }) }));
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => recipients });
    const r0 = bidLiveDescriptor('AUC4', 90080, 0);

    await n.alert(r0.kind, r0.data, { dedupeKey: r0.dedupeKey });   // send FAILS
    ok(tr.calls.length === 1, 'first attempt hit the transport');
    ok(((await store.listDocs('notifSent')) || []).length === 0, 'a failed send does NOT mark the dedupe key');
    failNext = false;
    await n.alert(r0.kind, r0.data, { dedupeKey: r0.dedupeKey });   // re-fire succeeds
    ok(tr.calls.length === 2, 're-fire after a failed send is NOT blocked (reservation released, key unmarked)');
    ok(((await store.listDocs('notifSent')) || []).length === 1, 'the successful re-fire marks the key');
  }

  // 5. NOT over-deduped: different alert kinds on the same auction have different dedupeKeys, so both
  //    send - the reservation is per dedupeKey, so won/lost/outbid/error are unaffected by this fix.
  {
    const tr = immediate();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients });
    await n.alert('bid_live', { auctionId: 'AUC5', lane: 'A -> B', shipper: 'X', price: 90080, cost: 80000, openingPct: 12.6 }, { dedupeKey: 'AUC5_bid_live' });
    await n.alert('outbid', { auctionId: 'AUC5', lane: 'A -> B', shipper: 'X', rank: 3 }, { dedupeKey: 'AUC5_outbid' });
    ok(tr.calls.length === 2, 'bid_live and outbid on the same auction both send (distinct dedupeKeys, not over-deduped)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
