'use strict';
/**
 * ONE THREAD PER LOAD on the group channel, offline.
 *
 * The ask lifecycle (test-wa-lifecycle.js) already threads the messages it knows by name - the
 * reminder, the receipt, the bid log, won and lost. Everything ELSE about a load - an ops alarm
 * (error), a desk notice (a refusal, a session-logged-out instruction), an outbid - fell through to
 * a fresh unthreaded send, so a group reading a live load saw the alarm as a disconnected message
 * with no visible tie to the ask it belongs to.
 *
 * These pin the remaining kinds onto the same pristine ask anchor, and pin the three ways that must
 * still degrade to a plain send rather than drop a message: no anchor recorded, an anchor minted by
 * a different Maytapi phone, and a reply the wire refuses.
 *
 * A mock transport captures every wire body so the whole path is asserted without touching Maytapi.
 *
 * The last four sections pin what the anchor STORE is allowed to cost a live auction: an open load
 * keeps its anchor under cap pressure (losing it makes that group's bid_live skip silently while the
 * bot bids), an all-open collection grows rather than breaking a thread, an outcome is what marks a
 * thread finished, and no anchor write puts a synchronous whole-file write on the bidding process.
 */

const fs = require('fs');   // allowed here: a test, not app state (see test-store.js's grep gate)
const os = require('os');
const path = require('path');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { COLLECTION: ASK_COLLECTION, CAP, recordAsk } = require('../src/notify/askThread');
const { MemoryStore, FileStore } = require('../src/store');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const GROUP = '120363042212345678@g.us';
const DM = '919820011122';

// Maytapi-shaped mock: captures url/body, returns 200 + {success:true} + a fresh msgId. `failOn(body)`
// forces a per-call Maytapi-level failure (200 + success:false), the shape a refused reply takes.
function mockTransport(failOn) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    if (typeof failOn === 'function' && failOn(body)) {
      return { ok: true, status: 200, json: async () => ({ success: false, message: 'reply refused' }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

// UNSCOPED group - the ops/all-loads desk group. It is the one that receives BOTH the ask and the
// error class, which is exactly the pairing the live complaint came from (an error landing loose in
// a group that already held that load's ask).
const ALL_KINDS = ['price_needed', 'price_submitted', 'bid_live', 'outbid', 'won', 'lost', 'error', 'desk_notice'];
const deskGroup = (jid = GROUP) => ({ name: 'Desk group', phone: jid, alerts: ALL_KINDS, scope: { origins: [], shippers: [] } });

// A SCOPED customer group - the sole channel for its customer's loads, which is what suppresses the
// unscoped desk group in the two-group case below. Matches reqL100's companyName.
const GROUP2 = '120363042287654321@g.us';
const acmeGroup = (jid = GROUP) => ({ name: 'Acme group', phone: jid, alerts: ALL_KINDS, scope: { origins: [], shippers: ['acme'] } });

const reqL100 = {
  id: 'L100tok', loadId: 'L100',
  load: { lane: { origin: 'Hyderabad', destination: 'Udaipur' }, companyName: 'Acme', equipment: '32FT', units: 1, weight: 18, weightUnit: 'MT', closesAt: Date.now() + 3_600_000 },
};

// The live case verbatim: SuperProcure served an earlier close than the one captured at pricing time.
const closeMovedPayload = (loadId = 'L100') => ({
  context: 'Hyderabad -> Udaipur', auctionId: loadId,
  detail: "the platform moved this load's closing time earlier than the one captured when it was priced - the bot is now working to the new close",
});

const deskNoticePayload = (loadId = 'L100') => ({
  origin: 'Hyderabad', shipper: 'Acme', branch: 'HYD', dest: 'Udaipur', lane: 'Hyderabad -> Udaipur',
  auctionId: loadId, oaNo: loadId, reason: 'session_logged_out', detail: 'bid this load by hand',
});

const build = (tr, store, wa) => new Notifier({
  mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
  recipientsProvider: async () => [deskGroup()],
});

(async () => {
  // =====================================================================================
  // 1) The follow-up kinds thread under the pristine ask.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = build(tr, store, wa);

    await n.requestPrice(reqL100);
    const ask = tr.calls[0].body;
    ok(ask.type === 'text' && ask.reply_to === undefined, 'the ask is a fresh send (no reply_to)');
    const doc = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(doc && doc.groups[0].jid === GROUP && doc.groups[0].messageId === 'mid-1',
      'the ask anchor is persisted per (load, group) through the store seam');

    // THE LIVE CASE: the close-time alarm must quote the ask, not land loose.
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });
    ok(tr.calls.length === 2, 'the close-time alarm is one group message');
    const err = tr.calls[1].body;
    ok(err.type === 'text', 'the alarm is a normal message (a reply pings - the desk must see it)');
    ok(err.reply_to === 'mid-1', 'the close-time alarm REPLIES to the load ask anchor (mid-1)');
    ok(/moved this load's closing time earlier/.test(err.message), 'the alarm still carries its own body');

    // A desk notice (refusal / hand-bid instruction) threads the same way.
    await n.alert('desk_notice', deskNoticePayload(), { dedupeKey: 'L100_notice' });
    const notice = tr.calls[2].body;
    ok(notice.type === 'text' && notice.reply_to === 'mid-1', 'a desk notice REPLIES to the same ask anchor');

    // outbid reaches the UNSCOPED group (scoped groups drop it upstream) and threads too.
    await n.alert('outbid', { auctionId: 'L100', rank: 3, price: 41000 }, { dedupeKey: 'L100_outbid' });
    const outbid = tr.calls[3].body;
    ok(outbid.type === 'text' && outbid.reply_to === 'mid-1', 'an outbid REPLIES to the same ask anchor');

    // The anchor stays pristine: threading never edits the ask.
    ok(tr.calls.every((c) => c.body.type !== 'edit'), 'no follow-up EDITS anything - reply is the only primitive used');
    ok(tr.calls.slice(1).every((c) => c.body.reply_to === 'mid-1'),
      'every follow-up on the load quotes the ONE anchor, so the group reads as one thread per load');
  }

  // =====================================================================================
  // 2) Fail open to today's behaviour - three ways, none of which may drop a message.
  // =====================================================================================
  {
    // (a) NO ANCHOR: an alarm on a load this group never carried an ask for.
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = build(tr, new MemoryStore(), wa);
    await n.alert('error', closeMovedPayload('L999'), { dedupeKey: 'L999_close_moved' });
    ok(tr.calls.length === 1, 'with no anchor the alarm is still delivered - exactly one message');
    ok(tr.calls[0].body.reply_to === undefined, 'with no anchor it degrades to a plain unthreaded send');
    ok(/moved this load's closing time earlier/.test(tr.calls[0].body.message), 'the plain send carries the full body');
  }
  {
    // (b) REPLY REFUSED by the wire: must fall back to a plain send, never vanish.
    const tr = mockTransport((b) => b.reply_to === 'mid-1');
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = build(tr, store, wa);
    await n.requestPrice(reqL100);
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });
    ok(tr.calls.length === 3, 'a refused reply is retried ONCE as a plain send (ask + refused reply + plain)');
    const retry = (tr.calls[2] && tr.calls[2].body) || {};
    ok(retry.reply_to === undefined && retry.type === 'text', 'the retry is an unthreaded plain send');
    ok(/moved this load's closing time earlier/.test(retry.message), 'the refused reply is re-sent with its body intact - never dropped');
  }
  {
    // (c) CROSS-PHONE anchor: an id minted by a sibling sender is not known to be quotable here.
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    await store.putDoc(ASK_COLLECTION, 'L100', {
      loadId: 'L100', updatedAt: Date.now(),
      groups: [{ jid: GROUP, messageId: 'mid-from-sibling', sentAt: Date.now(), via: '999999' }],
    });
    const n = build(tr, store, wa);
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });
    ok(tr.calls.length === 1 && tr.calls[0].body.reply_to === undefined,
      'an anchor minted by a DIFFERENT Maytapi phone degrades to a plain send');
  }

  // =====================================================================================
  // 3) Restart safety - anchors rehydrate from the store, so threading survives a reboot.
  // =====================================================================================
  {
    const store = new MemoryStore();
    const tr1 = mockTransport();
    const wa1 = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr1 });
    await build(tr1, store, wa1).requestPrice(reqL100);
    ok(tr1.calls[0].body.reply_to === undefined, 'pre-restart: the ask is a fresh send');

    // A whole new process: new client, new notifier, SAME persisted store.
    const tr2 = mockTransport();
    const wa2 = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr2 });
    const n2 = build(tr2, store, wa2);
    await n2.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved_after_restart' });
    ok(tr2.calls.length === 1, 'post-restart: the alarm is delivered');
    ok(tr2.calls[0].body.reply_to === 'mid-1',
      'post-restart the alarm still quotes the anchor recorded before the restart');
  }

  // =====================================================================================
  // 4) Scope: DMs are untouched. The thread lifecycle is group-channel-only.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => [{ name: 'Ops DM', phone: DM, alerts: ALL_KINDS, scope: { origins: [], shippers: [] } }],
    });
    await n.requestPrice(reqL100);
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });
    ok(tr.calls.length === 2, 'the DM recipient gets both messages');
    ok(tr.calls.every((c) => c.body.reply_to === undefined && c.body.type === 'text'),
      'a DM-only recipient gets plain fresh sends - threading is group-channel-only');
  }

  // =====================================================================================
  // 5) The SCOPED customer group takes the same treatment on its own fall-through kinds.
  //    A desk notice carries the load's scope keys, so it DOES reach the customer's group - and
  //    used to land there unthreaded beside its own ask.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => [{ name: 'Acme group', phone: GROUP, alerts: ALL_KINDS, scope: { origins: [], shippers: ['acme'] } }],
    });
    await n.requestPrice(reqL100);
    ok(tr.calls.length === 1 && tr.calls[0].body.reply_to === undefined, 'scoped group: the ask is a fresh send');

    await n.alert('desk_notice', deskNoticePayload(), { dedupeKey: 'L100_notice' });
    ok(tr.calls.length === 2, 'scoped group: the desk notice is delivered');
    ok(tr.calls[1].body.type === 'text' && tr.calls[1].body.reply_to === 'mid-1',
      'scoped group: the desk notice REPLIES to the ask anchor instead of landing loose');
    ok(tr.calls.every((c) => c.body.type !== 'edit'), 'scoped group: the ask is never edited by a notice');
  }

  // =====================================================================================
  // 6) The lazy BUBBLE-CREATE reply is refused. The reminder must still reach the group as a plain
  //    send - this is the post-price-page path, where silence is the failure mode that matters. And
  //    that fallback must NOT be recorded as the status bubble: a plain send is not a quotable
  //    bubble parent, so a later edit aimed at it would no-op while answering success.
  // =====================================================================================
  {
    let refuse = false;
    const tr = mockTransport((b) => refuse && b.reply_to === 'mid-1');
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => [acmeGroup()],
    });
    await n.requestPrice(reqL100);
    ok(tr.calls.length === 1 && tr.calls[0].body.reply_to === undefined, 'scoped group: the ask is a fresh send (mid-1)');

    refuse = true;
    await n.remindApproaching(reqL100);
    ok(tr.calls.length === 3, 'a refused bubble-create is retried ONCE as a plain send (ask + refused reply + plain)');
    const plain = (tr.calls[2] && tr.calls[2].body) || {};
    ok(plain.type === 'text' && plain.reply_to === undefined, 'the reminder falls back to an unthreaded plain send - never dropped');
    ok(/Reminder/.test(plain.message) && /L100/.test(plain.message), 'the plain-send reminder carries its body');
    const t = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(t.groups[0].bubbleId == null, 'the plain-send fallback is NOT recorded as the status bubble');

    // The consequence of that gate: the NEXT status event still finds no bubble, so it lazily
    // creates one as a REPLY - it must never try to EDIT the unquotable plain send.
    refuse = false;
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() });
    ok(tr.calls.length === 4, 'the receipt is one more group message');
    const rec = (tr.calls[3] && tr.calls[3].body) || {};
    ok(rec.type === 'text' && rec.reply_to === 'mid-1', 'the receipt REPLIES to the ask to create the bubble, never EDITs the plain send');
    const t2 = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(t2.groups[0].bubbleId === 'mid-4', 'that reply (mid-4) becomes the status bubble');
  }

  // =====================================================================================
  // 7) TWO GROUPS - one scoped, one unscoped. Pins the LIMITATION of the anchored path rather than
  //    implying it away: a scoped group that takes the ask suppresses the unscoped desk group
  //    entirely, so the desk group never records an anchor for that load and its later shipper-less
  //    alarm lands as a plain send. Stated at _deliverGroupAnchored's header; changing it would be a
  //    routing decision, not a bug fix.
  // =====================================================================================
  {
    const logs = [];
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: (m) => logs.push(String(m)), wa, store,
      recipientsProvider: async () => [acmeGroup(), deskGroup(GROUP2)],
    });

    // (a) The ask carries the shipper, so the SCOPED group takes it - and becomes the anchor.
    await n.requestPrice(reqL100);
    ok(tr.calls.length === 1 && tr.calls[0].body.to_number === GROUP && tr.calls[0].body.reply_to === undefined,
      'two groups: the ask goes to the SCOPED group only, as a fresh send');
    const doc = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(doc.groups.length === 1 && doc.groups[0].jid === GROUP, 'only the scoped group has an anchor recorded');
    await n.alert('desk_notice', deskNoticePayload(), { dedupeKey: 'L100_notice' });
    ok(tr.calls.length === 2 && tr.calls[1].body.to_number === GROUP && tr.calls[1].body.reply_to === 'mid-1',
      'a scope-carrying notice REPLIES under the ask on the scoped group');

    // (b) The unscoped desk group gets NOTHING at ask time - the scoped group is its customer's sole
    // channel, so `others` is never delivered while a scoped send succeeds.
    ok(!tr.calls.some((c) => c.body.to_number === GROUP2), 'the unscoped desk group gets nothing at ask time');

    // (c) A shipper-less alarm matches no scoped group, so it DOES reach the desk group - and with no
    // anchor recorded there it falls through to a plain unthreaded send. Delivered, and not a failure.
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });
    ok(tr.calls.length === 3, 'the shipper-less alarm is one more message');
    const alarm = (tr.calls[2] && tr.calls[2].body) || {};
    ok(alarm.to_number === GROUP2 && alarm.reply_to === undefined,
      'the alarm falls through to the UNSCOPED desk group as a PLAIN send - it holds no anchor for this load');
    ok(/moved this load's closing time earlier/.test(alarm.message), 'the plain send carries the full alarm body');
    ok(!logs.some((l) => /failed:|reached NOBODY/.test(l)), 'the fall-through is a normal delivery - nothing failed, nothing reached nobody');
  }

  // =====================================================================================
  // 8) LOST with a REFUSED reply - the ONE site where the threaded body and the fallback body
  //    deliberately differ. The short loss is only safe because it quotes the ask that carries the
  //    lane/vehicle/close, so an unthreaded retry must carry the FULL body instead.
  // =====================================================================================
  {
    let refuse = false;
    const tr = mockTransport((b) => refuse && b.reply_to === 'mid-1');
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => [acmeGroup()],
    });
    await n.requestPrice(reqL100);

    refuse = true;
    await n.alert('lost', {
      oaNo: 'L100', auctionId: 'L100', shipper: 'Acme', origin: 'Hyderabad', dest: 'Udaipur',
      from: 'Hyderabad', to: 'Udaipur', vehicleType: '1 x 32FT', marketRate: '47,000',
      marginRate: '49,350', marginPct: '5.00', finalRank: 4, closeTime: 'x',
    }, { dedupeKey: 'L100_lost' });

    ok(tr.calls.length === 3, 'a refused lost reply is retried ONCE as a plain send (ask + refused short reply + plain)');
    const short = (tr.calls[1] && tr.calls[1].body) || {};
    ok(short.reply_to === 'mid-1' && !/\*From\*/.test(short.message || ''), 'the refused reply was the SHORT loss - it quoted the ask');
    const full = (tr.calls[2] && tr.calls[2].body) || {};
    ok(full.type === 'text' && full.reply_to === undefined, 'the retry is an unthreaded plain send');
    // Re-pinned on markers that still discriminate. feat/gc-bid-timestamps' skeleton cut dropped the
    // *From*/*To* field block from the full 'lost' template - the route moved onto lostHeader's own
    // second line - so those two no longer separate full from short. These three do: the short
    // variant carries none of them, because it leans on the ask quoted directly above it.
    ok(/\*OA No\*/.test(full.message || '') && /\*Vehicle Type\*/.test(full.message || '') && /Bid Close Time/.test(full.message || ''),
      'the unthreaded retry carries the FULL loss body - the short one assumed an ask above it that is no longer quoted');
    ok(/Our Final Ranking\* - 4/.test(full.message || ''), 'the full retry still states the outcome');
  }

  // =====================================================================================
  // 9) CAP PRESSURE MUST NEVER TAKE A LIVE LOAD'S ANCHOR. The anchor is the only route a load's
  //    later messages have into its thread: without it the group's bid_live skips with no message
  //    and no fallback while the bot is bidding. The load whose anchor has sat longest is precisely
  //    an auction that opened early and is still running, so an oldest-first bound evicts exactly
  //    the wrong document. Only FINISHED loads are evictable.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = build(tr, store, wa);

    // The live load's ask goes in FIRST, so it is the OLDEST anchor in the collection.
    await n.requestPrice(reqL100);
    const base = Date.now();
    // Pack the collection to the bound with anchors whose loads are over (an outcome was delivered).
    for (let i = 0; i < CAP; i++) {
      await store.putDoc(ASK_COLLECTION, 'C' + i, {
        loadId: 'C' + i, groups: [{ jid: GROUP, messageId: 'old-' + i, sentAt: base + i }],
        updatedAt: base + i, closedAt: base + i,
      });
    }
    // Push past the bound through the real write path - recording an ask is what triggers eviction.
    for (let i = 0; i < 60; i++) await recordAsk(store, 'N' + i, GROUP, 'new-' + i, base + CAP + i);

    const live = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(live && live.groups[0].messageId === 'mid-1',
      'the OPEN load keeps its anchor through cap pressure, even as the oldest document in the collection');
    const docs = await store.listDocs(ASK_COLLECTION);
    ok(docs.filter((d) => d.closedAt != null).length < CAP, 'eviction took CLOSED anchors instead');
    ok(docs.length <= CAP + 60, 'and the collection is still bounded');

    // End to end: the live load's next message still threads.
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });
    const after = tr.calls[tr.calls.length - 1].body;
    ok(after.reply_to === 'mid-1', 'the live load still quotes its anchor after the sweep');
  }

  // =====================================================================================
  // 10) EVERY anchor open and over the bound: grow, do not break a thread. An oversized JSON file
  //     is housekeeping; a broken thread on a live auction is a lost delivery.
  // =====================================================================================
  {
    const store = new MemoryStore();
    const now = Date.now();
    for (let i = 0; i < CAP + 55; i++) await recordAsk(store, 'O' + i, GROUP, 'm-' + i, now);
    const docs = await store.listDocs(ASK_COLLECTION);
    ok(docs.length === CAP + 55, 'with every load still open the collection grows past the cap rather than evicting one');
  }

  // =====================================================================================
  // 11) The outcome is what marks a thread finished - that mark is what the sweep evicts by.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => [acmeGroup()],
    });
    await n.requestPrice(reqL100);
    ok((await store.getDoc(ASK_COLLECTION, 'L100')).closedAt == null, 'an open load carries no close mark');

    await n.alert('lost', {
      oaNo: 'L100', auctionId: 'L100', shipper: 'Acme', origin: 'Hyderabad', dest: 'Udaipur',
      from: 'Hyderabad', to: 'Udaipur', vehicleType: '1 x 32FT', marketRate: '47,000',
      marginRate: '49,350', marginPct: '5.00', finalRank: 4, closeTime: 'x',
    }, { dedupeKey: 'L100_lost' });
    ok((await store.getDoc(ASK_COLLECTION, 'L100')).closedAt != null,
      'delivering the outcome closes the thread, so the anchor becomes evictable');
  }

  // =====================================================================================
  // 12) NO SYNCHRONOUS WHOLE-FILE WRITE for an anchor. This collection is written from the delivery
  //     path of a live auction, on the same process as the bid monitor and the SP socket, and a
  //     read-modify-write of a grown collection blocks the event loop for tens of ms.
  // =====================================================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askthread-'));
    const store = new FileStore({ dataDir: dir, logDir: path.join(dir, 'logs') });
    const syncWrites = [];
    const save = store._saveColl.bind(store);
    store._saveColl = (collection, map) => { syncWrites.push(collection); return save(collection, map); };

    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = build(tr, store, wa);
    await n.requestPrice(reqL100);
    await n.remindApproaching(reqL100);
    await n.alert('error', closeMovedPayload(), { dedupeKey: 'L100_close_moved' });

    ok(!syncWrites.includes(ASK_COLLECTION), 'the anchor path puts no synchronous whole-file write on the bidding process');
    const doc = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(doc && doc.groups[0].messageId === 'mid-1', 'and the anchor is persisted all the same');
    ok(tr.calls[tr.calls.length - 1].body.reply_to === 'mid-1', 'and the alarm still threads under it');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
