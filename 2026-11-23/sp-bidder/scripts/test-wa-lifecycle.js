'use strict';
/**
 * WhatsApp ask-lifecycle noise reduction (Maytapi edit/reply), offline. Two layers:
 *   1) the client's editText / replyText wire shapes (type:'edit'/'text' + reply_to on the SAME
 *      sendMessage endpoint - the Maytapi contract verified live 2026-07-20/21), and
 *   2) the notifier group lifecycle: ONE pristine ask anchor (NEVER edited) + ONE mutating status
 *      bubble (created as a reply on the first status event, then edited in place through
 *      reminder -> rate received -> bid placed) + a pinging outcome (won rich / lost short, both
 *      replying to the pristine ask). Individual DMs are untouched.
 *
 * A mock transport captures every wire body so the whole path is asserted without touching Maytapi.
 */

const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier } = require('../src/notify/notifier');
const { renderMessage } = require('../src/notify/waTemplates');
const { COLLECTION: ASK_COLLECTION } = require('../src/notify/askThread');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore, COLLECTION: REQ_COLLECTION } = require('../src/pricing/priceRequests');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };
const GROUP = '120363042212345678@g.us';

// A Maytapi-shaped mock: captures url/body, returns 200 + {success:true} + a fresh msgId. An
// optional `failOn(body)` predicate lets a test force a per-call failure (e.g. a rejected edit).
function mockTransport(failOn) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    if (typeof failOn === 'function' && failOn(body)) {
      return { ok: true, status: 200, json: async () => ({ success: false, message: 'edit rejected' }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

const groupRecipient = (alerts) => ({ name: 'Havells group', phone: GROUP, alerts, scope: { origins: [], shippers: ['acme'] } });
const ALL_KINDS = ['price_needed', 'price_submitted', 'won', 'lost', 'bid_live', 'outbid', 'error'];

// A request for load 'L100' (companyName Acme -> matches the group's shipper scope). Shared by the
// ask/reminder/receipt calls so they all resolve the ONE ask thread keyed by loadId.
const reqL100 = {
  id: 'L100tok', loadId: 'L100',
  load: { lane: { origin: 'Mumbai', destination: 'Alwar' }, companyName: 'Acme', equipment: '32FT', units: 1, weight: 18, weightUnit: 'MT', closesAt: Date.now() + 3_600_000 },
};

(async () => {
  // =====================================================================================
  // 1) CLIENT: editText / replyText wire shapes
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 'KEY', productId: 'prod-1', phoneId: '128023', transport: tr, endpoint: 'https://api.maytapi.com/api' });

    const eRes = await wa.editText(GROUP, 'MID1', 'edited body', { kind: 'price_submitted' });
    ok(eRes.ok && eRes.messageId === 'mid-1', 'editText returns ok + messageId');
    const eb = tr.calls[0].body;
    ok(eb.type === 'edit', 'editText sends type:edit');
    ok(eb.reply_to === 'MID1', 'editText targets the original message via reply_to (NOT message_id)');
    ok(eb.to_number === GROUP && eb.message === 'edited body', 'editText carries to_number + the new body');
    ok(tr.calls[0].url === 'https://api.maytapi.com/api/prod-1/128023/sendMessage', 'editText hits the SAME sendMessage endpoint as a send');

    const rRes = await wa.replyText(GROUP, 'MID1', 'reply body', { kind: 'won' });
    ok(rRes.ok && rRes.messageId === 'mid-2', 'replyText returns ok + messageId');
    const rb = tr.calls[1].body;
    ok(rb.type === 'text', 'replyText sends type:text (a normal message, threaded)');
    ok(rb.reply_to === 'MID1', 'replyText threads under the parent via reply_to');
    ok(rb.message === 'reply body', 'replyText carries the body');

    // guards: a missing target id never hits the wire; a disabled client skips.
    const noId = await wa.editText(GROUP, '', 'x');
    ok(noId.ok === false && /no message id/.test(noId.error) && tr.calls.length === 2, 'editText with no message id errors and sends nothing');
    const noParent = await wa.replyText(GROUP, null, 'x');
    ok(noParent.ok === false && /no message id/.test(noParent.error), 'replyText with no parent id errors');
    const off = new WhatsAppClient({ ...CREDS, enabled: false, transport: tr });
    const offRes = await off.editText(GROUP, 'MID1', 'x');
    ok(offRes.ok === false && offRes.skipped === true, 'a disabled client skips an edit');

    // 200 + success:false is a FAILURE, not a silent ok (same asymmetry as sendText).
    const trFail = mockTransport(() => true);
    const waFail = new WhatsAppClient({ ...CREDS, enabled: true, transport: trFail });
    const failRes = await waFail.editText(GROUP, 'MID1', 'x', { kind: 'price_submitted' });
    ok(failRes.ok === false && /edit rejected/.test(failRes.error), '200 + success:false on an edit surfaces the error');
  }

  // =====================================================================================
  // 2) WIN lifecycle: pristine ask (never edited) + one mutating status bubble + a pinging outcome.
  //    ask -> reminder(reply, BECOMES the bubble) -> receipt(EDIT the bubble) ->
  //    bid_live(EDIT the bubble, +reprice link) -> won(REPLY the ask, rich).
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => [groupRecipient(ALL_KINDS)] });

    // ASK: a fresh send (type:text, no reply_to) that records the ask's message id per load.
    await n.requestPrice(reqL100);
    ok(tr.calls.length === 1, 'the ask is one group send');
    const ask = tr.calls[0].body;
    ok(ask.type === 'text' && ask.reply_to === undefined, 'the ask is a fresh send (no reply_to)');
    ok(/^📩 \*Acme\*/.test(ask.message) && /🆔 L100/.test(ask.message), 'the ask is the minimal template with the load number');
    const thread = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(thread && thread.groups && thread.groups[0].jid === GROUP && thread.groups[0].messageId === 'mid-1', 'the ask records the group message id keyed by loadId, through the store seam');
    ok(thread.groups[0].bubbleId == null, 'no status bubble exists yet (the ask is the sole anchor)');

    // REMINDER: a short REPLY threaded under the ask - and it BECOMES the mutable status bubble.
    await n.remindApproaching(reqL100);
    ok(tr.calls.length === 2, 'the reminder is one more group message');
    const rem = tr.calls[1].body;
    ok(rem.type === 'text' && rem.reply_to === 'mid-1', 'the reminder REPLIES threaded under the ask (pings - it is a nudge)');
    ok(/Reminder/.test(rem.message) && /🆔 L100/.test(rem.message) && rem.message.length < ask.message.length, 'the reminder is a short nudge carrying the load number, not the full ask');
    // reqL100 deliberately carries no deadlineAt, so this pins the DEGRADED half of the clause on the
    // real group path: the original wording, not a dangling "cutoff in " or a NaN count. Block 8
    // below covers the live-deadline half.
    ok(/closing soon/.test(rem.message) && !/cutoff in/.test(rem.message) && !/NaN|undefined/.test(rem.message),
      'a request with no deadlineAt degrades the group reminder to the original "closing soon" - no half-sentence, no NaN');
    const t2 = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(t2.groups[0].messageId === 'mid-1' && t2.groups[0].bubbleId === 'mid-2', 'the reminder becomes the status bubble (bubbleId=mid-2), the ask anchor (mid-1) is untouched');

    // RECEIPT: a silent EDIT of the BUBBLE (mid-2), NOT the ask (mid-1). This is the fixed mechanic.
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() });
    ok(tr.calls.length === 3, 'the receipt is one more group message');
    const rec = tr.calls[2].body;
    ok(rec.type === 'edit' && rec.reply_to === 'mid-2', 'the receipt EDITS the status bubble in place (reply_to the BUBBLE mid-2), never the ask');
    ok(rec.reply_to !== 'mid-1', 'the receipt does NOT edit the pristine ask (mid-1) - the ask + its /price link survive intact');
    // A TWO-SIDED gate, not a swap. BRL staff read the old "Rate submitted" as "the bid is on
    // SuperProcure" when it only ever meant the desk's price reached us, so the negative half - that
    // the word cannot come back - is as load-bearing as the positive half. Asserting only the new
    // string would let a revert reintroduce the misread wording alongside it.
    // 2026-09-16: the client asked for this line trimmed to "Rate added. Bids show here as they are
    // placed." verbatim, which drops the explicit "not a bid" negation - kept safe by still refusing
    // "submitted" and by "Rate added" (not "Rate placed"/"Rate bid") reading as the desk's own price.
    ok(/We have your rate/.test(rec.message) && /Rate added/.test(rec.message)
      && !/submitted/i.test(rec.message) && /47,000/.test(rec.message),
      'the edited bubble says the RATE landed and cannot be read as "the bid is on SuperProcure"');
    const t3 = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(/\/price\//.test(t3.groups[0].link || ''), 'the receipt remembers the reprice link on the thread for the eventual bid-placed edit');

    // BID PLACED: a silent EDIT of the SAME bubble (mid-2), a live bid LOG with the link pinned below.
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 90000, rungIndex: 0, rank: 4 }, { dedupeKey: 'L100_bid_live_0' });
    ok(tr.calls.length === 4, 'bid_live is one more group message (a silent bubble edit, not a new ping)');
    const bid = tr.calls[3].body;
    ok(bid.type === 'edit' && bid.reply_to === 'mid-2', 'bid_live EDITS the same status bubble (mid-2), never the ask');
    ok(/^\*Bids placed \(live\):\*/.test(bid.message) && /Rs 90,000 · rank 4/.test(bid.message) && !/🤖/.test(bid.message), 'the bubble is a live bid LOG ("Bids placed (live)", "Rs X · rank N" middle-dot) with NO robot emoji');
    ok(/\n\n👉 _Tap to see live rank and update your rate:_\n[^\n]*\/price\//.test(bid.message) && !/reprice/i.test(bid.message), 'the live link is pinned at the bottom on its OWN line with a plain-English CTA (no "reprice" jargon)');

    // WON: a REPLY under the PRISTINE ask (mid-1), full rich message - and it PINGS (type:text, not edit).
    await n.alert('won', { oaNo: 'L100', auctionId: 'L100', shipper: 'Acme', origin: 'Mumbai', from: 'Mumbai', to: 'Alwar', vehicleType: '1 x 32FT', finalRank: 1, closeTime: 'x' }, { dedupeKey: 'L100_won' });
    ok(tr.calls.length === 5, 'the win is one more group message');
    const won = tr.calls[4].body;
    ok(won.type === 'text' && won.reply_to === 'mid-1', 'the win REPLIES threaded under the PRISTINE ask (mid-1) - a NEW pinging message, never a silent edit');
    ok(/^🎉 \*WON - Acme\*/.test(won.message) && /Complete the allotment on SuperProcure/.test(won.message), 'the win reply carries the full rich won message (loud header + allotment CTA)');

    // The whole point: across the ENTIRE lifecycle, the ask (mid-1) was NEVER the target of an edit.
    ok(tr.calls.every((c) => !(c.body.type === 'edit' && c.body.reply_to === 'mid-1')), 'the ask (mid-1) is NEVER edited - every edit targeted the status bubble (mid-2)');
  }

  // =====================================================================================
  // 2B) BID LOG GROWS: each bid APPENDS a timestamped line to the SAME bubble (edited in place),
  //     the live link stays pinned at the bottom - one bubble that grows, never a message per bid.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => [groupRecipient(ALL_KINDS)] });
    await n.requestPrice(reqL100);                                                          // ask -> mid-1
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() }); // rate-received reply -> bubble mid-2
    const askEdits = () => tr.calls.filter((c) => c.body.type === 'edit' && c.body.reply_to === 'mid-1').length;

    // three ladder rungs place, each APPENDS a line to the same bubble (mid-2)
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 49350, rungIndex: 0, rank: 4 }, { dedupeKey: 'L100_bid_live_0' });
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 48900, rungIndex: 1, rank: 2 }, { dedupeKey: 'L100_bid_live_1' });
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 48200, rungIndex: 2, rank: 1 }, { dedupeKey: 'L100_bid_live_2' });

    const bidEdits = tr.calls.filter((c) => c.body.type === 'edit' && c.body.reply_to === 'mid-2');
    ok(bidEdits.length >= 3, 'each of the three bids EDITS the same bubble (mid-2) - one bubble, not a message per bid');
    ok(askEdits() === 0, 'the ask (mid-1) is still never edited while the bid log grows');
    const last = bidEdits[bidEdits.length - 1].body.message;
    ok(/Rs 49,350 · rank 4/.test(last) && /Rs 48,900 · rank 2/.test(last) && /Rs 48,200 · rank 1/.test(last), 'the final bubble shows ALL three bids appended, most-recent-last, "Rs X · rank N" (middle-dot fields)');
    ok(/\n\n👉 _Tap to see live rank and update your rate:_\n[^\n]*\/price\//.test(last), 'the live link stays pinned at the BOTTOM (on its own line) below the whole log');
    const doc = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(doc.groups[0].bubbleId === 'mid-2' && (doc.groups[0].bids || []).length === 3 && doc.groups[0].bidCount === 3, 'the running bid log (3) is stored on the ONE bubble handle (mid-2), for the next append to re-render');
  }

  // =====================================================================================
  // 3) Lazy-create + LOST-short: the desk prices fast (no reminder). rate-received is the FIRST
  //    status event, so it REPLIES to the ask (creates the bubble); a later loss REPLIES the ask
  //    SHORT.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => [groupRecipient(ALL_KINDS)] });
    await n.requestPrice(reqL100);                      // ask -> mid-1

    // RATE RECEIVED with NO prior reminder -> a REPLY to the ask that CREATES the bubble (pings once).
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() });
    const rec = tr.calls[tr.calls.length - 1].body;
    ok(rec.type === 'text' && rec.reply_to === 'mid-1', 'rate-received as the FIRST status event REPLIES to the ask (lazy-creates the bubble), not an edit of nothing');
    const t = await store.getDoc(ASK_COLLECTION, 'L100');
    ok(t.groups[0].bubbleId === 'mid-2', 'that rate-received reply becomes the status bubble (mid-2)');

    // LOST: a REPLY under the pristine ask, SHORT (header + rank + our bid + one line; no From/To/Vehicle).
    await n.alert('lost', { oaNo: 'L100', auctionId: 'L100', shipper: 'Acme', origin: 'Mumbai', dest: 'Alwar', from: 'Mumbai', to: 'Alwar', vehicleType: '1 x 32FT', marketRate: '47,000', marginRate: '49,350', marginPct: '5.00', finalRank: 4, closeTime: 'x' }, { dedupeKey: 'L100_lost' });
    const lost = tr.calls[tr.calls.length - 1].body;
    ok(lost.type === 'text' && lost.reply_to === 'mid-1', 'the loss REPLIES threaded under the pristine ask (pings)');
    ok(/^🔴 \*LOST - Acme/.test(lost.message) && /Our Final Ranking\* - 4/.test(lost.message) && /Our Bid\* - ₹49,350/.test(lost.message), 'the loss reply is the SHORT variant: loud header + final rank + our last bid');
    ok(!/\*From\*/.test(lost.message) && !/\*To\*/.test(lost.message) && !/Bid Close Time/.test(lost.message), 'the short loss drops From/To/Bid-Close (the ask above already carries them)');
    ok(lost.message.length < 260, 'the short loss reply stays lean');
  }

  // =====================================================================================
  // 4) bid_live is BEST-EFFORT and never re-anchors: an edit the transport rejects does NOT fall
  //    back to a fresh reply (that would be the per-bid ping the Director killed). The reprice link
  //    on the last good bubble carries live state instead.
  // =====================================================================================
  {
    const tr = mockTransport((b) => b.type === 'edit'); // every edit fails
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => [groupRecipient(ALL_KINDS)] });
    await n.requestPrice(reqL100);
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() }); // creates bubble via reply (mid-2)
    const before = tr.calls.length;
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 90000 }, { dedupeKey: 'L100_bid_live' });
    ok(tr.calls.length - before === 1, 'bid_live makes exactly ONE wire call (the edit attempt) - no reply fallback');
    ok(tr.calls[tr.calls.length - 1].body.type === 'edit', 'that one call is the bubble EDIT; a rejected edit is NOT re-anchored as a fresh reply');
  }

  // =====================================================================================
  // 5) bid_live folds into the group's status bubble as a SILENT edit; outbid stays killed.
  // =====================================================================================
  {
    // (a) With a live bubble, bid_live EDITS it silently (no new group message, no DM ping).
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const recips = [groupRecipient(ALL_KINDS), { name: 'Desk DM', phone: '+919000000009', alerts: ALL_KINDS, scope: { origins: [], shippers: [] } }];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recips });
    await n.requestPrice(reqL100);                       // ask -> group mid-1 (the grouped customer suppresses the DM)
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() }); // rate-received reply -> bubble mid-2
    const before = tr.calls.length;
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 90000 }, { dedupeKey: 'L100_bid_live' });
    ok(tr.calls.length - before === 1, 'bid_live with a live bubble is exactly one wire call');
    const b = tr.calls[tr.calls.length - 1].body;
    ok(b.type === 'edit' && b.reply_to === 'mid-2' && b.to_number === GROUP, 'bid_live EDITS the group bubble silently (the grouped customer suppresses the every-load DM)');

    // (b) outbid is still dropped on the group; it only reaches the DM.
    const before2 = tr.calls.length;
    await n.alert('outbid', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', rank: 3 }, { dedupeKey: 'L100_outbid' });
    ok(tr.calls.length - before2 === 1 && tr.calls[tr.calls.length - 1].body.to_number === '919000000009', 'outbid stays killed on the group, delivered only to the DM');
  }

  // =====================================================================================
  // 6) No bubble to edit: bid_live SKIPS the group (never mints a fresh ping) and the DM fallback
  //    still runs - so a group-only customer with no prior ask is silent, with no "reached NOBODY".
  // =====================================================================================
  {
    // group + an unscoped every-load DM, but NO prior ask thread for this load.
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const recips = [groupRecipient(ALL_KINDS), { name: 'Desk DM', phone: '+919000000009', alerts: ALL_KINDS, scope: { origins: [], shippers: [] } }];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recips });
    await n.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 90000 }, { dedupeKey: 'L100_bid_live' });
    ok(tr.calls.length === 1 && tr.calls[0].body.to_number === '919000000009', 'with no bubble, bid_live skips the group (no fresh ping) and the DM fallback still delivers');
    ok(tr.calls.every((c) => c.body.to_number !== GROUP), 'no bid_live message is ever freshly sent to the group JID');

    // group-ONLY customer, no thread: bid_live reaches nobody, with no "reached NOBODY" error.
    const errs = [];
    const nGroupOnly = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h',
      log: (m, meta) => { if (meta && meta.reachedNobody) errs.push(m); }, wa: new WhatsAppClient({ ...CREDS, enabled: true, transport: mockTransport() }), store: new MemoryStore(),
      recipientsProvider: async () => [groupRecipient(ALL_KINDS)] });
    await nGroupOnly.alert('bid_live', { lane: 'Mumbai -> Alwar', shipper: 'Acme', origin: 'Mumbai', auctionId: 'L100', price: 90000 }, { dedupeKey: 'L100_bid_live' });
    ok(errs.length === 0, 'the intended bid_live skip does not trip a "reached NOBODY" error');
  }

  // =====================================================================================
  // 7) DMs are untouched: an individual subscriber still gets plain fresh sends (no thread lifecycle).
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
      recipientsProvider: async () => [{ name: 'Solo desk', phone: '+919000000001', alerts: ALL_KINDS, scope: { origins: [], shippers: [] } }] });
    await n.requestPrice(reqL100);
    await n.confirmSubmitted({ ...reqL100, price: { cost: 47000 }, capturedAt: Date.now() });
    ok(tr.calls.every((c) => c.body.type === 'text' && c.body.reply_to === undefined), 'a DM-only customer gets plain fresh sends - the edit/reply lifecycle is group-channel-only');
    ok((await store.getDoc(ASK_COLLECTION, 'L100')) == null, 'no ask thread is recorded for a DM-only ask (nothing to edit later)');
  }

  // =====================================================================================
  // 8) GROUP-PATH minutes clause, through the REAL reminder gate. The group is the channel that
  //    matters here: for a grouped customer the DM is suppressed entirely (a group takes the
  //    message), so the "BRL Bids" thread is the ONLY place a desk member reads this. And it is a
  //    genuinely separate render - _deliverGroup DISCARDS the assembled DM body and calls
  //    renderMessage('ask_reminder', data) itself, so the DM integration test proves nothing about
  //    it. The bid_live branch right below that line already builds its own trimmed payload object
  //    instead of passing `data` through; if anyone applies that same shape to the reminder branch,
  //    every group reminder silently reverts to "closing soon" and, without this block, the whole
  //    suite stays green.
  // =====================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    // group + an unscoped every-load DM: proves the group takes the reminder AND that the clause is
    // the same on both renders, not just on whichever one happens to be asserted.
    const recips = [groupRecipient(ALL_KINDS), { name: 'Desk DM', phone: '+919000000009', alerts: ALL_KINDS, scope: { origins: [], shippers: [] } }];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recips });

    // Drive the REAL gate at the SHIPPED lead rather than hand-picking a deadline - same discipline
    // as the DM reachability block in test-whatsapp.js, so this also goes red if the lead is ever
    // dialled back to a window that can only print "under a minute".
    const LIVE_LEAD = require('../src/config').reminderLeadMs;
    const rq = new PriceRequestStore({ store: new MemoryStore(), marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    const deadlineAt = Date.now() + LIVE_LEAD - 10_000;
    const req = await rq.createForLoad(
      { id: 'L300', lane: { origin: 'Mumbai', destination: 'Alwar' }, companyName: 'Acme', equipment: '32FT', units: 1, weight: 18, weightUnit: 'MT', closesAt: deadlineAt + 35_000, status: 'live' },
      { deadlineAt },
    );
    await rq.markNotified(req.id);
    const askedAt = Date.now() - 8 * 60_000; // a median-shaped window: asked ~8 min before the cutoff
    await rq.store.patchDoc(REQ_COLLECTION, req.id, { createdAt: askedAt, notifiedAt: askedAt });

    await n.requestPrice(req);                        // ask -> group mid-1 (the grouped customer suppresses the DM)
    const due = await rq.dueForReminder(Date.now(), LIVE_LEAD);
    ok(due.length === 1 && due[0].id === req.id, 'the real dueForReminder gate releases the grouped request at the shipped reminderLeadMs');
    const beforeRem = tr.calls.length;
    await n.remindApproaching(due[0]);

    const groupRem = tr.calls.slice(beforeRem).filter((c) => c.body.to_number === GROUP);
    ok(groupRem.length === 1, 'the reminder reaches the group exactly once');
    const body = groupRem[0].body.message;
    ok(groupRem[0].body.reply_to === 'mid-1', 'the group reminder is still the threaded reply under the pristine ask');
    const minutes = /cutoff in (\d+) minutes?\./.exec(body);
    ok(minutes != null,
      `the GROUP reminder body carries the live minutes-left clause (this is the render at _deliverGroup, not the DM's). Got: ${JSON.stringify(body)}`);
    ok(minutes != null && Number(minutes[1]) >= 2,
      `the group clause names an actionable count (>= 2 whole minutes) at the shipped lead of ${LIVE_LEAD}ms. Got: ${minutes ? minutes[1] : 'none'}`);
    ok(!/closing soon/.test(body), 'a live deadline replaces "closing soon" on the GROUP path too - the fixture-shaped assertion that passed before this feature would not catch that');
    ok(!/closing in/.test(body), 'the group clause names the cutoff, never "closing in" - the group bubble carries no absolute time to qualify a hard-stop claim');
    ok(!/—/.test(body) && !/\bbot\b/i.test(body) && !/NaN|undefined/.test(body), 'the group reminder stays ASCII-only, no "bot", no leaked NaN/undefined');
    ok(/🆔 L300/.test(body), 'the group reminder still carries the load number');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
