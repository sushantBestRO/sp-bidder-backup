'use strict';
/**
 * WhatsApp notifications (Maytapi), offline. Exercises the client payload shape,
 * the notifier's kind->recipient routing, restart-safe dedupe, the channel/enable
 * gates, and the engine-event -> notification mapping. No real key: a mock transport
 * captures every "send" so the whole path is asserted without touching Maytapi.
 *
 * The four enquiry templates reproduce BRL's Waaree/GoComet format (bold labels,
 * emoji anchors) so the content assertions match on BRL's labels/phrasing.
 */

const { WhatsAppClient } = require('../src/notify/whatsapp');
const { Notifier, scopeMatches, remindApproachingBanner } = require('../src/notify/notifier');
const { renderMessage, reminderClosingClause } = require('../src/notify/waTemplates');
const { toNotification, notifyEngineEvent, outcomeEnrichment } = require('../src/notify/engineAlerts');
const { MemoryStore } = require('../src/store');
const { PriceRequestStore, COLLECTION: REQ_COLLECTION } = require('../src/pricing/priceRequests');
const { COLLECTION: ACCOUNT_CONTACTS_COLLECTION } = require('../src/auth/accountContacts');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL -', m); } };

// A Maytapi-shaped mock: captures url/body/key, returns HTTP 200 + {success:true}.
function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), key: opts.headers['x-maytapi-key'] });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

const CREDS = { token: 't', productId: 'p', phoneId: '128023' };

const recipients = [
  { name: 'Pricing Desk', phone: '+91 90000 00001', alerts: ['price_needed', 'price_submitted', 'won', 'lost', 'bid_live', 'outbid', 'error'] },
  { name: 'Ops Head', phone: '+919000000002', alerts: ['won', 'lost'] },
  { name: 'Silent', phone: '+919000000003', alerts: [] },
];

(async () => {
  // ---- client: enable gate (all four of enabled+token+productId+phoneId required) ----
  ok(!new WhatsAppClient({ ...CREDS, enabled: false, transport: () => {} }).enabled(), 'client disabled when enabled=false');
  ok(!new WhatsAppClient({ enabled: true, token: null, productId: 'p', phoneId: '1', transport: () => {} }).enabled(), 'client disabled without token');
  ok(!new WhatsAppClient({ enabled: true, token: 't', productId: null, phoneId: '1', transport: () => {} }).enabled(), 'client disabled without productId');
  ok(!new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: null, transport: () => {} }).enabled(), 'client disabled without phoneId');
  ok(new WhatsAppClient({ ...CREDS, enabled: true, transport: () => {} }).enabled(), 'client enabled when all present');

  // ---- client: payload shape + endpoint + phone cleaning ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 'KEY123', productId: 'prod-1', phoneId: '128023', transport: tr, endpoint: 'https://api.maytapi.com/api' });
    const res = await wa.sendText('+91 90000 00001', 'Congratulations, we won.');
    ok(res.ok && res.messageId === 'mid-1', 'sendText returns ok + messageId (from data.msgId)');
    ok(tr.calls[0].key === 'KEY123', 'x-maytapi-key header carries the token');
    ok(tr.calls[0].url === 'https://api.maytapi.com/api/prod-1/128023/sendMessage', 'url carries productId + phoneId');
    const b = tr.calls[0].body;
    ok(b.to_number === '919000000001', 'recipient number is digits-only with country code, no +');
    ok(b.type === 'text', 'message type is text');
    ok(b.message === 'Congratulations, we won.', 'message body passed through verbatim');
  }

  // ---- client: a trailing slash on the endpoint does not double up ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '9', transport: tr, endpoint: 'https://api.maytapi.com/api/' });
    await wa.sendText('919000000001', 'hi');
    ok(tr.calls[0].url === 'https://api.maytapi.com/api/p/9/sendMessage', 'trailing slash on endpoint is normalized');
  }

  // ---- client: HTTP 200 with success:false is a FAILURE (Maytapi's disabled-phone case) ----
  {
    const tr = async () => ({ ok: true, status: 200, json: async () => ({ success: false, message: 'phone not active' }) });
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const res = await wa.sendText('919000000001', 'hi');
    ok(res.ok === false && /phone not active/.test(res.error), '200 + success:false is treated as a failed send');
  }

  // ---- client: a disabled client sends nothing (skipped) ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: false, transport: tr });
    const res = await wa.sendText('919000000001', 'hi');
    ok(res.ok === false && res.skipped === true && tr.calls.length === 0, 'disabled client skips the send entirely');
  }

  // ---- notifier: dashboard mode never sends (channel gate) ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'dashboard', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients });
    await n.requestPrice({ id: 'rq1', loadId: 'L1', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' } });
    await n.alert('won', { auctionId: 'au1' });
    ok(tr.calls.length === 0, 'dashboard mode sends nothing over WhatsApp');
  }

  // ---- notifier: whatsapp mode routes by kind subscription ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recipients });

    await n.requestPrice({ id: 'rq1', loadId: 'L1', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 1751000000000 } });
    ok(tr.calls.length === 1, 'price_needed -> only the 1 recipient subscribed to it');
    ok(/^📩 \*Acme\*/.test(tr.calls[0].body.message), 'minimal price_needed leads with the "CUSTOMER" header (the shipper/company name)');
    ok(/\n🆔 L1(\n|$)/.test(tr.calls[0].body.message), 'minimal price_needed carries the SuperProcure load id on its own load-number line');
    ok(/👉 http:\/\/h\/price\//.test(tr.calls[0].body.message), 'minimal price_needed carries the capture link');

    let before = tr.calls.length;
    await n.alert('won', { oaNo: 'au1', from: 'A', to: 'B', shipper: 'Acme', origin: 'A', finalRank: 1, auctionId: 'au1' }, { dedupeKey: 'au1_won' });
    ok(tr.calls.length - before === 2, "won -> both recipients subscribed to 'won'");
    ok(/^🎉 \*WON - Acme\*/.test(tr.calls[before].body.message) && /OA No\* - au1/.test(tr.calls[before].body.message), 'won leads with the loud "WON - <customer>" header and carries the OA No');

    before = tr.calls.length;
    await n.alert('won', { oaNo: 'au1', shipper: 'Acme', finalRank: 1, auctionId: 'au1' }, { dedupeKey: 'au1_won' });
    ok(tr.calls.length - before === 0, 'duplicate won (same dedupe key) is suppressed');

    before = tr.calls.length;
    await n.alert('error', { context: 'au1', detail: 'tick_error', auctionId: 'au1' }, { dedupeKey: 'au1_error_tick' });
    ok(tr.calls.length - before === 1, 'error -> only the recipient subscribed to error');

    before = tr.calls.length;
    await n.alert('bid_live', { lane: 'A -> B', shipper: 'Acme', price: 90000, auctionId: 'au2' }, { dedupeKey: 'au2_bid_live' });
    ok(tr.calls.length - before === 1, 'bid_live -> only the recipient subscribed to bid_live');

    // restart-safe dedupe: a fresh notifier over the SAME store still suppresses a sent key
    const n2 = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recipients });
    before = tr.calls.length;
    await n2.alert('won', { auctionId: 'au1' }, { dedupeKey: 'au1_won' });
    ok(tr.calls.length - before === 0, 'dedupe survives a restart (persisted in the store)');
  }

  // ---- notifier: a send failure never throws into the caller, and does not mark dedupe ----
  {
    const throwing = async () => { throw new Error('boom'); };
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: throwing });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recipients });
    let threw = false;
    try { await n.alert('won', { auctionId: 'au9' }, { dedupeKey: 'au9_won' }); } catch (_) { threw = true; }
    ok(!threw, 'a transport failure does not throw into the engine/discovery path');
    ok((await store.getDoc('notifSent', 'au9_won')) == null, 'a failed send is not marked sent (so it can be retried)');
  }

  // ---- engine event -> notification mapping ----
  ok(toNotification({ type: 'auction_result', auctionId: 'a', won: true, finalRank: 1, lane: { origin: 'A', destination: 'B' } }).kind === 'won', 'auction_result won -> won');
  ok(toNotification({ type: 'auction_result', auctionId: 'a', won: false, finalRank: 3 }).kind === 'lost', 'auction_result !won -> lost');
  ok(toNotification({ type: 'auction_result', auctionId: 'a', won: true, finalRank: 1, lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' }).data.oaNo === 'a', 'won data carries oaNo (the load id) for the OA No line');
  ok(toNotification({ type: 'auction_result', auctionId: 'a', won: false, finalRank: 3, lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' }).data.dest === 'B', 'lost data carries the short destination lane city for the loss header');
  ok(toNotification({ type: 'bid_placed', auctionId: 'a', price: 9 }).kind === 'bid_live', 'bid_placed -> bid_live');
  ok(toNotification({ type: 'alert', kind: 'outranked', auctionId: 'a', rank: 2 }).kind === 'outbid', 'alert outranked -> outbid');
  ok(toNotification({ type: 'alert', kind: 'killed', reason: 'manual' }).kind === 'error', 'alert killed -> error');
  ok(toNotification({ type: 'alert', kind: 'stood_down_at_floor', auctionId: 'a' }) === null, 'non-notifiable alert -> null');
  // never_bid_before_close (bidEngine.js _finalize's everBid split) must reach WhatsApp the same
  // way any other error-class engine alert does - pins the ERROR_KINDS wiring so a future
  // refactor of that set can't silently drop it back to dashboard-only, the way
  // lost_after_bidding has always been.
  ok(toNotification({ type: 'alert', kind: 'never_bid_before_close', auctionId: 'a', finalRank: 3, detail: undefined }).kind === 'error',
    'alert never_bid_before_close -> error (reaches WhatsApp)');

  // ---- recipient scope (per plant/origin + shipper), GoComet-style routing ----
  ok(scopeMatches(undefined, { origin: 'Chakan', shipper: 'Acme' }) === true, 'no scope -> matches every load');
  ok(scopeMatches({ origins: [], shippers: [] }, { origin: 'Chakan', shipper: 'Acme' }) === true, 'empty scope -> matches every load');
  ok(scopeMatches({ origins: ['chakan'], shippers: [] }, { origin: 'Chakan, MH', shipper: 'Acme' }) === true, 'origin scope matches (case-insensitive substring)');
  ok(scopeMatches({ origins: ['chakan'], shippers: [] }, { origin: 'Bhiwandi, MH', shipper: 'Acme' }) === false, 'origin scope excludes a non-matching origin');
  ok(scopeMatches({ origins: [], shippers: ['syngenta'] }, { origin: 'X', shipper: 'Syngenta India' }) === true, 'shipper scope matches');
  ok(scopeMatches({ origins: ['chakan'], shippers: ['syngenta'] }, { origin: 'Chakan', shipper: 'Renewsys' }) === false, 'both set -> must match both (AND)');

  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const scoped = [
      { name: 'Chikhli desk', phone: '+91900000010', alerts: ['price_needed'], scope: { origins: ['Chakan'], shippers: [] } },
      { name: 'Central ops', phone: '+91900000011', alerts: ['price_needed'], scope: { origins: [], shippers: [] } },
    ];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => scoped });
    await n.requestPrice({ id: 'rqA', loadId: 'LA', load: { lane: { origin: 'Chakan, MH', destination: 'Bawal' }, companyName: 'Acme' } });
    ok(tr.calls.length === 2, 'Chakan load -> both the Chakan-scoped desk AND the unscoped central recipient');
    const before = tr.calls.length;
    await n.requestPrice({ id: 'rqB', loadId: 'LB', load: { lane: { origin: 'Bhiwandi, MH', destination: 'Hosur' }, companyName: 'Acme' } });
    ok(tr.calls.length - before === 1, 'Bhiwandi load -> only the unscoped central recipient (Chikhli desk skipped)');
  }

  // ---- operator test-send ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    const n = new Notifier({ mode: 'dashboard', baseUrl: 'http://h', log: () => {}, wa, store });
    const res = await n.sendTest('+91 90000 00001', { note: 'hi' });
    ok(res.ok === true, 'sendTest sends even in dashboard mode (verifies the connection)');
    ok(/set up correctly/.test(tr.calls[0].body.message), 'sendTest renders the test message');
    ok(tr.calls[0].body.to_number === '919000000001', 'sendTest cleans the recipient number');
    const rec = (await store.readEvents('notifications', { from: Date.now() - 60000, to: Date.now() })).find((e) => e.kind === 'test');
    ok(rec && rec.ok === true, 'sendTest is recorded to the notifications stream');

    const off = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa: new WhatsAppClient({ enabled: false }), store });
    const r2 = await off.sendTest('+91900000001');
    ok(r2.ok === false && /not connected/i.test(r2.error), 'sendTest reports not-connected when WhatsApp is off');
  }

  // ---- message catalogue: BRL format renders, every slot filled ----
  {
    const won = renderMessage('won', { oaNo: 'OA1', shipperName: 'Havells', branch: 'Alwar', loadCode: 'HAV-0912', from: 'A', to: 'B', vehicleType: '1 x 40FT', marketRate: '1,38,000', marginPct: '3.19', attempts: 0, closeTime: '29-04-2026 01:52 PM', finalRank: 1 });
    ok(/^🎉 \*WON - Havells · Alwar\*/.test(won), 'renderMessage(won) opens with the loud "WON - CUSTOMER · BRANCH" header (middle-dot separator, glanceable in the chat-list preview)');
    ok(/OA No\* - OA1 \(HAV-0912\)/.test(won), 'won carries the load id with the SP friendly code appended (correlates back to the enquiry ask)');
    ok(/🏅 \*Our Final Ranking\* - 1/.test(won), 'won states the final ranking explicitly (rank 1 on a win)');
    ok(!/Won Rate/.test(won), 'won omits the Won Rate line entirely when our winning bid is absent');
    ok(!/Date of Inquiry/.test(won) && !/Last Bidding Time/.test(won), 'won drops the no-source Date of Inquiry + auto-extend lines');
    ok(/Margin low - only 3.19%. Squeeze the vendor/.test(won), 'won shows the low-margin warning (3.19% is under the 5% fallback floor)');
    ok(/Complete the allotment on SuperProcure/.test(won), 'won closes with the allotment reminder, merged into the ranking line');
    ok(!/\{\{\d+\}\}/.test(won), 'won leaves no unfilled placeholders');
    // header degrades cleanly: raw shipper alone when no branch, then a bare fallback with neither.
    ok(/^🎉 \*WON - Acme\*/.test(renderMessage('won', { oaNo: 'OA1', shipper: 'Acme', finalRank: 1 })), 'won header falls back to the raw shipper (customer only) when no branch is carried');
    ok(/^🎉 \*WE WON THIS ONE\*/.test(renderMessage('won', { oaNo: 'OA1', finalRank: 1 })), 'won header degrades to a bare celebratory line when neither customer nor branch is known');
  }
  {
    // margin-aware warning: healthy margin (above the band floor) says nothing; a floor breach nags.
    const healthy = renderMessage('won', { oaNo: 'OA1', from: 'A', to: 'B', vehicleType: '1 x 40FT', marketRate: '44,000', wonRate: '55,000', marginPct: '25.00', minMarginPct: 8, attempts: 2, closeTime: 'x', finalRank: 1 });
    ok(!/Margin low/.test(healthy), 'won: healthy margin (25% vs 8% floor) shows NO warning');
    const low = renderMessage('won', { oaNo: 'OA1', from: 'A', to: 'B', vehicleType: '1 x 40FT', marketRate: '44,000', wonRate: '46,000', marginPct: '4.50', minMarginPct: 8, attempts: 2, closeTime: 'x', finalRank: 1 });
    ok(/Margin low - only 4.50%/.test(low), 'won: margin below the band floor (4.5% vs 8%) shows the warning');
    // cost-absent (rate-model demo / missing record): money lines omitted, never a bare "₹-".
    const noCost = renderMessage('won', { oaNo: 'OA1', from: 'A', to: 'B', vehicleType: '1 x 40FT', attempts: 0, closeTime: 'x', finalRank: 1 });
    ok(!/₹/.test(noCost) && !/Your Rate/.test(noCost) && !/Won Rate/.test(noCost), 'won omits all money lines when there is no entered cost (no "₹-" garbage)');
  }
  {
    const m = renderMessage('price_needed', { shipper: 'Acme', laneFrom: 'A', laneTo: 'B', cargo: '1 x 32FT', link: 'http://x/price/1', closesText: '06-07-2026 02:02 PM' });
    ok(/^📩 \*Acme\*/.test(m), 'minimal price_needed leads with the header (falls back to the raw shipper when no shipperName)');
    ok(/👉 http:\/\/x\/price\/1/.test(m), 'minimal price_needed carries the capture link');
    ok(/📍 \*From\* - A\n🎯 \*To\* - B/.test(m), 'minimal price_needed carries the short lane as two LABELLED lines, not the full pincode addresses');
    ok(!/Previous Quotes on the Same Route/.test(m), 'minimal price_needed no longer carries the previous-quotes block (moved to the /price page)');
    ok(!/\{\{\d+\}\}/.test(m), 'no unfilled {{n}} placeholders remain');
  }
  ok(/set up correctly/.test(renderMessage('test', {})), 'renderMessage(test) renders the test line with the default note');
  ok(renderMessage('nope', {}) === null, 'unknown kind -> null message');

  // ---- voice: the customer/desk-facing lifecycle templates must NOT read as automated ----
  {
    const t0 = Date.now();
    const rendered = {
      bid_placed: renderMessage('bid_placed', { bids: [{ ts: t0, price: 48200, rank: 1 }], bidCount: 1, changeLink: 'http://h/price/x' }),
      bidding_live: renderMessage('bidding_live', { name: 'L1', changeLink: 'http://h/price/x' }),
      outbid: renderMessage('outbid', { lane: 'A -> B', shipper: 'Acme', rank: 3 }),
      won: renderMessage('won', { oaNo: 'L1', shipperName: 'Havells', branch: 'Alwar', finalRank: 1 }),
      lost: renderMessage('lost', { oaNo: 'L1', shipper: 'Havells', finalRank: 4 }),
      lost_short: renderMessage('lost_short', { shipper: 'Havells', finalRank: 4, marginRate: '49,350' }),
      price_needed: renderMessage('price_needed', { shipper: 'Acme', laneFrom: 'A', laneTo: 'B', cargo: '1 x 32FT', link: 'http://h/1', closesText: 'x' }),
      ask_reminder: renderMessage('ask_reminder', { name: 'L1' }),
      ask_resolved: renderMessage('ask_resolved', { name: 'L1', submittedRate: '₹47,000' }),
    };
    for (const [kind, msg] of Object.entries(rendered)) {
      ok(!/🤖/.test(msg), `${kind} carries no robot emoji`);
      ok(!/\bbot\b/i.test(msg) && !/automatically\b/.test(msg) && !/\bthe system\b/i.test(msg), `${kind} reads as the desk, not a machine (no "bot"/"automatically"/"the system")`);
    }
    ok(/^\*Bids placed \(live\):\*/.test(rendered.bid_placed), 'the bid log header dropped the robot emoji (bold "Bids placed (live):")');
    ok(/Revising our bid\./.test(rendered.outbid), 'outbid now reads first-person ("Revising our bid.") instead of "the bot is responding automatically"');
  }

  // ---- ask_reminder: minutes-remaining clause (Director ask, 2026-07-25: "can we also mention
  // in how many minutes it's closing") - targets d.deadlineAt (the enter-cost-by cutoff), whole
  // minutes, Director-readable phrasing, computed at call time so it reflects real elapsed time. ----
  {
    const T = Date.now();
    ok(reminderClosingClause(T + 12 * 60_000, T) === 'cutoff in 12 minutes', '12 minutes left renders as whole minutes');
    ok(reminderClosingClause(T + 65 * 60_000, T) === 'cutoff in about 1 hour 5 minutes', '~65 minutes left renders hour + minute phrasing');
    ok(reminderClosingClause(T + 60 * 60_000, T) === 'cutoff in about 1 hour', 'an exact hour renders without a dangling "0 minutes"');
    ok(reminderClosingClause(T + 1 * 60_000, T) === 'cutoff in 1 minute', 'exactly 1 minute left is singular ("minute", not "minutes")');
    ok(reminderClosingClause(T + 30_000, T) === 'cutoff in under a minute', 'sub-minute remaining renders the under-a-minute wording, not "0 minutes"');
    ok(reminderClosingClause(T - 5_000, T) === 'closing soon', 'a deadline already past falls back to the original wording, no minutes clause');
    ok(!/-\d/.test(reminderClosingClause(T - 5_000, T)), 'an already-past deadline never renders a negative minute count');
    ok(reminderClosingClause(T, T) === 'closing soon', 'a deadline exactly now (zero remaining) falls back, not "0 minutes"');
    ok(reminderClosingClause(null, T) === 'closing soon', 'no deadline at all falls back to the original wording');
    ok(reminderClosingClause(undefined, T) === 'closing soon', 'undefined deadline falls back to the original wording');

    // HONESTY: the number is the enter-cost-by CUTOFF, and the product treats that as advisory -
    // a cost after it still counts, best-effort, right to the real close (the /price page says so).
    // The clause must never claim the auction itself is ending, on any branch.
    for (const ms of [30_000, 60_000, 12 * 60_000, 65 * 60_000]) {
      ok(!/closing in/.test(reminderClosingClause(T + ms, T)),
        `the clause names the cutoff, never "closing in" - it must not promise a hard stop the system does not enforce (+${ms}ms)`);
    }

    // Full template wiring: the {{2}} slot lands in the rendered ask_reminder body, and the minutes
    // are computed inside renderMessage() at call time (default nowMs = Date.now()), not baked into
    // the payload beforehand - a 40s buffer absorbs any slow test execution without flaking.
    const nearDeadline = Date.now() + 12 * 60_000 + 40_000;
    const rem = renderMessage('ask_reminder', { name: 'L200', deadlineAt: nearDeadline });
    ok(/cutoff in 12 minutes/.test(rem), 'ask_reminder renders the live minutes-left clause through the {{2}} slot');
    ok(/🆔 L200/.test(rem), 'ask_reminder still carries the load number');
    ok(!/closing soon/.test(rem), 'a live deadline replaces "closing soon" outright, not alongside it');
    ok(!/\bbot\b/i.test(rem), 'the reminder never renders the word "bot"');
  }

  // ---- remindApproaching's DM-path banner: the SAME minutes clause, mirrored onto the
  // individual-recipient path (Director follow-up, 2026-07-25: a customer with no scoped group
  // must not read a less useful reminder than one with a group). Shares reminderRemainingPhrase
  // with the group template - direct pure-function cases first, mirroring the ask_reminder block
  // above, then a send-pipeline integration driven through the REAL dueForReminder gate. ----
  {
    const T = Date.now();
    ok(remindApproachingBanner({ deadlineAt: T + 12 * 60_000 }, T) === '⏰ *REMINDER - pricing cutoff in 12 minutes.*\n\n',
      '12 minutes left renders the clause inside the banner');
    ok(remindApproachingBanner({ deadlineAt: T + 65 * 60_000 }, T) === '⏰ *REMINDER - pricing cutoff in about 1 hour 5 minutes.*\n\n',
      '~65 minutes left renders hour + minute phrasing inside the banner');
    ok(remindApproachingBanner({ deadlineAt: T + 30_000 }, T) === '⏰ *REMINDER - pricing cutoff in under a minute.*\n\n',
      'sub-minute remaining renders the under-a-minute wording inside the banner');
    ok(remindApproachingBanner({ deadlineAt: T - 5_000 }, T) === '⏰ *REMINDER - pricing cutoff approaching!*\n\n',
      'a deadline already past falls back to the original bare banner - no clause, no negative');
    ok(remindApproachingBanner({}, T) === '⏰ *REMINDER - pricing cutoff approaching!*\n\n',
      'no deadline at all falls back to the original bare banner, unchanged');
    ok(!/—/.test(remindApproachingBanner({ deadlineAt: T + 12 * 60_000 }, T)), 'the banner is ASCII only - no em dash');
    ok(!/\bbot\b/i.test(remindApproachingBanner({ deadlineAt: T + 12 * 60_000 }, T)), 'the banner never renders the word "bot"');
    ok(!/closing in/.test(remindApproachingBanner({ deadlineAt: T + 12 * 60_000 }, T)),
      'the banner names the cutoff, never "closing in" - the auction outlives the cutoff and a late cost still counts');

    // ---- REACHABILITY, through the real gate. The whole feature turns on whether the minutes
    // branch can fire in PRODUCTION, and the only thing that decides that is config.reminderLeadMs:
    // dueForReminder releases a request solely inside (0, lead], so the clause can never print more
    // time than the lead allows. Drive an actual PriceRequestStore through dueForReminder at the
    // SHIPPED lead - no hand-picked deadline, no direct remindApproaching call - and assert the wire
    // body names whole MINUTES. At the old 60s lead this block is the one that goes red, and for the
    // right reason: the request still passes the gate, but the only clause reachable inside a 60s
    // window is "under a minute", so the minutes branch is dead code and the Director's ask is
    // undeliverable. That is the failure the original tests hid by hand-building their timestamps.
    const LIVE_LEAD = require('../src/config').reminderLeadMs;
    const store = new MemoryStore();
    const rq = new PriceRequestStore({ store, marginsPct: [12.6, 7.2, 6.3], minMarginPct: 6.3 });
    // A median-shaped load: asked ~8 min ago, cutoff just inside the lead so the gate is open NOW.
    // (measured production ask -> cutoff window: median 13.3 min, p25 13.1, p75 28.2)
    const deadlineAt = Date.now() + LIVE_LEAD - 10_000;
    const req = await rq.createForLoad(
      { id: 'RM100', lane: { origin: 'Mumbai', destination: 'Alwar' }, companyName: 'Acme', equipment: '32FT', units: 1, weight: 18, weightUnit: 'MT', closesAt: deadlineAt + 35_000, status: 'live' },
      { deadlineAt },
    );
    await rq.markNotified(req.id);
    const askedAt = Date.now() - 8 * 60_000;
    await store.patchDoc(REQ_COLLECTION, req.id, { createdAt: askedAt, notifiedAt: askedAt });

    const due = await rq.dueForReminder(Date.now(), LIVE_LEAD);
    ok(due.length === 1 && due[0].id === req.id, 'the REAL dueForReminder gate releases the request at the shipped reminderLeadMs');

    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({
      mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      recipientsProvider: async () => [{ name: 'Pricing Desk', phone: '+91 90000 00001', alerts: ['price_needed'] }],
    });
    await n.remindApproaching(due[0]);
    ok(tr.calls.length === 1, 'the DM reminder is one send');
    const dmMsg = tr.calls[0].body.message;

    const minutes = /pricing cutoff in (\d+) minutes?\./.exec(dmMsg);
    ok(minutes != null,
      `the reminder the real gate produced names a MINUTE COUNT - not "under a minute" - so the Director's ask is actually delivered in production. Got: ${JSON.stringify(dmMsg.split('\n')[0])}`);
    ok(minutes != null && Number(minutes[1]) >= 2,
      `that count is a usable, actionable number (>= 2 whole minutes) at the shipped lead of ${LIVE_LEAD}ms - a lead that can only ever print "under a minute" or "1 minute" makes the clause pointless. Got: ${minutes ? minutes[1] : 'none'}`);
    ok(!/under a minute/.test(dmMsg),
      'the shipped lead is nowhere near the under-a-minute floor - a reminder arriving that late cannot be acted on');
    ok(/enter cost by/.test(dmMsg), 'the existing absolute enter-cost-by time is still present - the relative clause ADDS to it, not replaces it');
    ok(!/—/.test(dmMsg) && !/\bbot\b/i.test(dmMsg), 'the full DM reminder stays ASCII-only with no "bot" wording');
  }

  // ---- price_needed: cargo (units x vehicle) + full pickup/drop from the load snapshot ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients });
    await n.requestPrice({ id: 'rq7', loadId: 'L7', load: {
      lane: { origin: 'Bhiwandi, MH', destination: 'Bawal, HR' }, companyName: 'Syngenta',
      equipment: '20ft container', units: 1, closesAt: 1751000000000,
      points: [
        { kind: 'pickup', address: 'Bhiwandi, Maharashtra 421302, India' },
        { kind: 'drop', address: 'Syngenta Depot, Bawal, Haryana 123501, India' },
      ],
    } });
    const msg = tr.calls[0].body.message;
    ok(/🚛 1 x 20ft container/.test(msg), 'minimal ask renders the vehicle as "<units> x <vehicle>"');
    // The two ends sit on their own labelled lines, and the SP state suffix the portal appends on
    // some branches ("Bhiwandi, MH") is stripped - the ask now writes a lane end through the same
    // rule the /price page and the console worklist use (src/web/laneDisplay.js), where the state
    // was already being dropped. The pin still rides the end it belongs to.
    ok(/📍 \*From\* - Bhiwandi 421302\n🎯 \*To\* - Bawal 123501/.test(msg), 'minimal ask labels each lane end on its own line, city + PIN, no state (Director, 2026-07-27 + 2026-08-12)');
    ok(!/Maharashtra/.test(msg) && !/Syngenta Depot/.test(msg) && !/Haryana/.test(msg), 'the FULL pickup/drop addresses are still NOT in the minimal ask (they live on the /price page) - only the pins were promoted');
    // point-less loads (sim/mock) still render the lane cities
    await n.requestPrice({ id: 'rq8', loadId: 'L8', load: { lane: { origin: 'Chakan, MH', destination: 'Hosur, TN' }, companyName: 'Acme', closesAt: 1751000000000 } });
    const msg2 = tr.calls[tr.calls.length - 1].body.message;
    ok(/📍 \*From\* - Chakan\n🎯 \*To\* - Hosur/.test(msg2), 'a point-less load renders the lane cities on the two labelled lines');
  }

  // ---- price_needed: weight/shipmentType/productName/portal-flags/loadCode reach the message.
  // These are captured on the load snapshot by priceRequests.createForLoad but used to die in
  // notifier.requestPrice before ever reaching the template - assert the full wire, not just
  // the template's own rendering, so this can't silently regress at the notifier layer again.
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients });
    await n.requestPrice({ id: 'rq9', loadId: 'L9', load: {
      lane: { origin: 'Akola', destination: 'Padmala, Vadodara, Gujarat 391350, IN' }, companyName: 'Syngenta India Pvt Ltd',
      equipment: '32 FT MXL', units: 1, closesAt: 1751000000000,
      loadCode: '23018254', weight: 18, shipmentType: 'FTL', productName: 'Agrochemicals',
      hasPortalComments: true, hasPortalAttachments: false,
    } });
    const msg = tr.calls[tr.calls.length - 1].body.message;
    ok(/🆔 L9 \(23018254\)/.test(msg), 'minimal ask appends the SP loadCode alongside the load number when present');
    ok(/🚛 1 x 32 FT MXL \. 18 MT/.test(msg), 'minimal ask renders "vehicle . weight" on one line, weight defaulting to MT when weightUnit is absent');
    ok(!/Shipment Type/.test(msg) && !/Product/.test(msg) && !/SP portal/.test(msg), 'minimal ask drops shipmentType / product / portal-note from the message (all rendered on the /price page)');
    ok(!/\{\{\d+\}\}/.test(msg), 'no unfilled placeholders once the fields are populated');

    // omission: a load snapshot with no vehicle/weight renders just the bare load-number line, no
    // dangling labels, no loadCode parens.
    await n.requestPrice({ id: 'rq10', loadId: 'L10', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 1751000000000 } });
    const bare = tr.calls[tr.calls.length - 1].body.message;
    ok(!/Weight/.test(bare) && !/Shipment Type/.test(bare) && !/Product/.test(bare) && !/Distance/.test(bare), 'minimal ask has no dangling weight/shipment/product/distance labels when the snapshot has none');
    ok(/🆔 L10(\n|$)/.test(bare), 'minimal ask leaves the load number bare (no loadCode suffix) when loadCode is absent');
  }

  // ---- price_needed: weight UNIT + distance. Regression for the real 2026-07-11 incident -
  // Ashirvad Pipes (and other KG-branch shippers) had their weight hardcoded as "MT" regardless
  // of SuperProcure's own brancheUnit, showing e.g. "2950.87 MT" (a nonsense weight - actually
  // 2950.87 KG) on an 8MT-capacity truck. Distance was never carried at all (Suyashh flagged it
  // missing, matching the gap the mockup already scoped: "Distance-km ... not carried").
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients });
    await n.requestPrice({ id: 'rq-kg', loadId: '22724361', load: {
      lane: { origin: 'Ahmedabad', destination: 'Surat' }, companyName: 'Ashirvad Pipes Pvt Ltd',
      equipment: '19FT-SA-8MT', units: 1, closesAt: 1751000000000,
      weight: 2950.87, weightUnit: 'KG', distanceKm: 235.58,
    } });
    const msg = tr.calls[tr.calls.length - 1].body.message;
    ok(/🚛 1 x 19FT-SA-8MT \. 2950\.87 KG/.test(msg), 'a KG-branch load renders its real unit in the "vehicle . weight" cell, never a hardcoded MT');
    ok(!/2950\.87 MT/.test(msg), 'never mislabels a KG weight as MT');
    ok(!/Distance/.test(msg) && !/235\.58/.test(msg), 'distance is NOT in the minimal ask (it renders on the /price page)');

    // an MT-branch load still shows MT explicitly in the cell
    await n.requestPrice({ id: 'rq-nodist', loadId: 'L11d', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 1751000000000, equipment: '32FT', units: 1, weight: 5, weightUnit: 'MT' } });
    const noDist = tr.calls[tr.calls.length - 1].body.message;
    ok(/🚛 1 x 32FT \. 5 MT/.test(noDist), 'an MT-branch load still renders MT explicitly when weightUnit says so');
  }

  // ---- multi-account: the "Account:" suffix identifies the account by its operator-set email,
  // never by the internal accountId/label (which read as meaningless jargon - "Account: Primary" -
  // to the pricing team). No email on file yet -> the line is omitted entirely, not a fallback.
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const store = new MemoryStore();
    await store.putDoc(ACCOUNT_CONTACTS_COLLECTION, 'acc2', { accountId: 'acc2', email: 'ahmedabad@bestroadways.com', updatedAt: 0 });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store, recipientsProvider: async () => recipients });

    await n.requestPrice({ id: 'rqAcc1', loadId: 'LAcc1', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' }, account: { accountId: 'acc2', label: 'Acme Branch' } });
    const withEmail = tr.calls[tr.calls.length - 1].body.message;
    ok(/Account: ahmedabad@bestroadways\.com/.test(withEmail), 'an account with an email on file gets an "Account: <email>" line');
    ok(!/Account: Acme Branch/.test(withEmail), 'the internal account label never appears in the message');

    await n.requestPrice({ id: 'rqAcc2', loadId: 'LAcc2', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' }, account: { accountId: 'acc3', label: 'No Email Branch' } });
    const noEmail = tr.calls[tr.calls.length - 1].body.message;
    ok(!/Account:/.test(noEmail), 'an account with no email on file gets no Account line at all (no fallback to the label)');

    await n.requestPrice({ id: 'rqAcc3', loadId: 'LAcc3', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' } });
    const singleAccount = tr.calls[tr.calls.length - 1].body.message;
    ok(!/Account:/.test(singleAccount), 'single-account mode (no request.account) never appends an Account line');
  }

  // ---- multi-pickup loads: parseLane (realAdapter.js) collapses lane.origin to just the FIRST
  // pickup point, so From/Route used to silently drop every pickup after it. dropAddress already
  // joined every drop point via L.points - pickupAddress mirrors that on the pickup side. ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients });
    const load = {
      lane: { origin: 'Akola', destination: 'Padmala, Vadodara' }, companyName: 'Syngenta',
      equipment: '32FT', units: 2, closesAt: 1751000000000,
      points: [
        { kind: 'pickup', address: 'Akola, Maharashtra 444001, India' },
        { kind: 'pickup', address: 'Washim, Maharashtra 444505, India' },
        { kind: 'drop', address: 'Padmala, Vadodara, Gujarat 391350, India' },
      ],
    };
    await n.requestPrice({ id: 'rq11', loadId: 'L11', load });
    const msg = tr.calls[tr.calls.length - 1].body.message;
    ok(/📍 \*From\* - Akola 444001\n🎯 \*To\* - Padmala, Vadodara 391350/.test(msg), 'minimal ask renders the lane CITIES for a multi-pickup load, pinned from the FIRST pickup (full pickup points live on the /price page + the confirmSubmitted route)');
    ok(!/444505/.test(msg), 'the SECOND pickup\'s pin is NOT in the minimal ask - the From line annotates the already-collapsed city pair, not the full route');
    ok(!/Maharashtra/.test(msg) && !/Gujarat/.test(msg), 'the multi-pickup full addresses are still NOT in the minimal ask');

    await n.confirmSubmitted({ id: 'rq11', loadId: 'L11', price: { cost: 47000 }, capturedAt: 1745900000000, load });
    const receipt = tr.calls[tr.calls.length - 1].body.message;
    ok(/Akola, Maharashtra 444001, India; Washim, Maharashtra 444505, India -> Padmala, Vadodara, Gujarat 391350, India/.test(receipt), 'confirmSubmitted Route STILL carries every pickup point (price_submitted receipt is unchanged)');

    // single-pickup loads (the common case) render the lane cities
    await n.requestPrice({ id: 'rq12', loadId: 'L12', load: { lane: { origin: 'Chakan, MH', destination: 'Hosur, TN' }, companyName: 'Acme', closesAt: 1751000000000 } });
    const single = tr.calls[tr.calls.length - 1].body.message;
    ok(/📍 \*From\* - Chakan\n🎯 \*To\* - Hosur/.test(single), 'a single-pickup load renders the lane cities on the two labelled lines');
  }

  // ---- price_submitted confirmation renders (BRL "Market Rate Submitted") ----
  {
    const fields = { oaNo: 'L9', closingTime: '06-07-2026 02:02 PM', route: 'A → B', cargoQty: '1 x 32ft', enteredTime: '12:11 pm', submittedRate: '₹47,000' };
    const m = renderMessage('price_submitted', fields);
    ok(/^✅ \*New Market Rate Submitted\*/.test(m), 'price_submitted opens with the BRL header');
    ok(/\*OA No\* - L9/.test(m) && /₹47,000/.test(m), 'price_submitted carries the OA No + entered rate');
    ok(/💰 \*Your Rate\* - ₹47,000/.test(m), 'price_submitted anchors on the unified "Your Rate" label, not "Market Rate"');
    ok(!/GID/.test(m), 'price_submitted drops the always-blank GID line (SP exposes none)');
    ok(!/\{\{\d+\}\}/.test(m), 'price_submitted leaves no unfilled placeholders');
    // change-a-mistaken-rate footer: present WITH a link, absent WITHOUT (BRL's re-price ack ask)
    ok(!/Wrong rate/.test(m), 'price_submitted omits the footer when no changeLink is present (no dangling line)');
    const withLink = renderMessage('price_submitted', { oaNo: 'L9', submittedRate: '₹47,000', changeLink: 'http://h/price/acme-x9' });
    ok(/\n\n_Wrong rate\? Tap to change it:_ http:\/\/h\/price\/acme-x9/.test(withLink), 'price_submitted appends the italic footer one blank line down, the link outside the italics');
    ok(!/\{\{\d+\}\}/.test(withLink), 'price_submitted with the footer still leaves no unfilled placeholders');

    // FALLBACK (missing-datum): no armed-band fields -> the bidding-contract line is omitted and
    // the receipt is byte-identical to the plain relabeled receipt (never a dangling "₹-"/"+ undefined%").
    ok(!/We'll bid from/.test(m), 'price_submitted omits the bidding-contract line when no ladder/band is present');
    const expectedFallback = '✅ *New Market Rate Submitted*\n\n🆔 *OA No* - L9\n⏰ *Bid Close Time* - 06-07-2026 02:02 PM\n🛣️ *Route* - A → B\n🚛 *Vehicle Type* - 1 x 32ft\n🕒 *Bid Entered Time* - 12:11 pm\n💰 *Your Rate* - ₹47,000';
    ok(m === expectedFallback, 'price_submitted with no armed-band data is byte-identical to the plain receipt (no trailing contract segment)');

    // NEW SHAPE: with the armed band (12/8/6 on a Rs 45,000 rate) the contract line renders each
    // derived bid as "your rate + margin%", opening high and never below the operating floor. The
    // percents come from the band, not the rounded prices.
    const withBand = renderMessage('price_submitted', { ...fields, submittedRate: '₹45,000', openingBid: 50400, openingPct: 12, floorBid: 47700, floorPct: 6 });
    ok(/💰 \*Your Rate\* - ₹45,000\n📈 \*We'll bid from\* - ₹50,400 \(\+12%\), never below ₹47,700 \(\+6%\)/.test(withBand),
      'price_submitted renders the bidding contract ("We\'ll bid from ... never below ...") when the armed band is known');
    ok(!/\{\{\d+\}\}/.test(withBand), 'price_submitted with the contract line leaves no unfilled placeholders');
    // a GoComet-style fractional margin trims cleanly (12.60 -> 12.6, never "12.60%")
    const frac = renderMessage('price_submitted', { ...fields, openingBid: 90080, openingPct: 12.6, floorBid: 85040, floorPct: 6.3 });
    ok(/We'll bid from\* - ₹90,080 \(\+12\.6%\), never below ₹85,040 \(\+6\.3%\)/.test(frac), 'the contract line trims a fractional margin for display (12.6%, not 12.60%)');
  }

  // ---- bid_live: frames the first bid against the operator's own rate when known ----
  {
    const withRate = renderMessage('bid_live', { lane: 'A -> B', shipper: 'Acme', price: 50400, cost: 45000, openingPct: 12 });
    ok(withRate === 'Bidding is live on A -> B (Acme). First bid ₹50,400 - your rate ₹45,000 + 12%.',
      'bid_live frames the first bid as "your rate + X%" when the cost + opening margin are known');
    // FALLBACK (missing-datum): no cost -> byte-identical to the original rate-agnostic copy.
    const noRate = renderMessage('bid_live', { lane: 'A -> B', shipper: 'Acme', price: 48692 });
    ok(noRate === 'Bidding is live on A -> B (Acme). First bid placed at ₹48,692.',
      'bid_live falls back byte-identically to "First bid placed at ₹X." when the entered rate is absent');
    // opening pct present but cost absent (or vice versa) must still take the fallback, never a partial line.
    const halfA = renderMessage('bid_live', { lane: 'A -> B', shipper: 'Acme', price: 48692, openingPct: 12 });
    ok(halfA === 'Bidding is live on A -> B (Acme). First bid placed at ₹48,692.', 'bid_live needs BOTH cost and opening pct - openingPct alone falls back');
  }

  // ---- toNotification carries the entered rate + opening margin onto bid_live ----
  {
    const full = toNotification({ type: 'bid_placed', auctionId: 'a', price: 50400, cost: 45000, openingPct: 12, lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' });
    ok(full.data.cost === 45000 && full.data.openingPct === 12, 'bid_placed -> bid_live data carries cost + openingPct through');
    const rateModel = toNotification({ type: 'bid_placed', auctionId: 'a', price: 9 });
    ok(rateModel.data.cost === null && rateModel.data.openingPct === null, 'a rate-model bid_placed (no band) leaves cost + openingPct null');
  }

  // ---- won/lost render BRL money detail (our-side; competitor Won Rate blank) ----
  {
    const won = renderMessage('won', { oaNo: 'OA1', from: 'A', to: 'B', vehicleType: '1 x 40FT', marketRate: '47,000', wonRate: '48,500', marginPct: '3.19', attempts: 3, closeTime: 'x', finalRank: 1 });
    ok(/\*Your Rate\* - ₹47,000/.test(won), 'won shows the entered rate under the unified "Your Rate" anchor label');
    ok(/\*Won Rate\* - ₹48,500/.test(won), 'won shows Won Rate = our winning bid (populated on a win)');
    ok(/\*Won Rate\* - ₹48,500 \(\+3\.19%\)/.test(won), 'the our-over-cost margin rides inline on the Won Rate line, signed');
    ok(!/your rate 47,000/.test(won), 'and no separate margin line restates the rate the Your Rate line carries (F-C)');
    // 2026-09-16 length trim: attempts dropped from the receipt - the outcome matters, not the retry count.
    ok(!/Bid attempts/.test(won), 'won no longer shows the bid-attempt count');

    // The GoComet case this trim exists for: the outcome payload carries the RAW full postal
    // addresses in from/to (761 chars observed), not the short laneFrom/laneTo cells. The receipt
    // must render the short route instead of ever touching from/to.
    const GC_FROM = 'Survey No 123/2, Village Chandrapada, Taluka Palghar, Near Ganesh Weighbridge, Palghar, Maharashtra 401404, India';
    const GC_TO = 'Plot B-14, Sector 8, Integrated Industrial Estate, SIDCUL, Ranipur, Haridwar, Uttarakhand 249403, India';
    const wonGC = renderMessage('won', { oaNo: 'GC1', shipper: 'Kingspan Jindal', origin: 'Palghar', dest: 'Haridwar',
      from: GC_FROM, to: GC_TO, vehicleType: '32 FT MXL 18MT', marketRate: '1,02,000', wonRate: '1,07,100',
      marginPct: '5.00', finalRank: 1, closeTime: 'x' });
    ok(wonGC.split('\n')[0] === '🎉 *WON - Kingspan Jindal*' && wonGC.split('\n')[1] === 'Palghar → Haridwar',
      'won carries the route on its own second line, same as lost/no_bid');
    ok(!wonGC.includes(GC_FROM) && !wonGC.includes(GC_TO), 'and the raw postal addresses never render at all');
    ok(!/📍|🎯/.test(wonGC), 'no From/To field lines remain on the won receipt');
    ok(wonGC.length < 400, `the trimmed won receipt stays well under the old ~760 chars, got ${wonGC.length}`);

    const lost = renderMessage('lost', { oaNo: 'OA2', shipper: 'Borosil', origin: 'Bharuch', dest: 'JNPT Mumbai', from: 'A', to: 'B', vehicleType: '1 x 40FT', marketRate: '75,000', marginRate: '77,700', marginPct: '3.60', attempts: 0, finalRank: 6, closeTime: 'x' });
    ok(!/📍|🎯/.test(lost), 'no From/To field lines remain on the lost receipt either');
    // The loss now SHOUTS from the top: a red header naming the customer + short route is the very
    // first line, so the WhatsApp chat-list preview (first line only) reads "LOST" at a glance
    // instead of the outcome being buried at the bottom (Director feedback, 2026-07).
    ok(lost.split('\n')[0] === '🔴 *LOST - Borosil*', 'lost leads with a loud loss HEADER as the literal first line (customer only), what the chat-list preview shows');
    ok(lost.split('\n')[1] === 'Bharuch → JNPT Mumbai', 'the route sits on its OWN second line, never bracketed onto the header - a bracketed lane wraps badly on a phone (Director, 2026-08-19)');
    // 2026-09-16 length trim: the "Dear Manager, / Please note for the given" preamble is gone.
    ok(/^🔴 \*LOST - Borosil\*\nBharuch → JNPT Mumbai\n\n🆔 \*OA No\* - OA2/.test(lost),
      'the loss header and its route line sit directly above the OA No line, with no preamble');
    ok(!/Dear Manager/.test(lost), 'and the preamble is gone entirely');
    ok(/\*Your Rate\* - ₹75,000/.test(lost) && /\*Our Bid\* - ₹77,700 \(\+3\.60%\)/.test(lost), 'lost shows the entered rate (Your Rate) + our bid carrying the margin inline, signed');
    ok(/\*Our Final Ranking\* - 6/.test(lost), 'lost shows the final ranking');
    // F-C / Image 11: "your rate" used to appear on three consecutive lines - Your Rate, Our Bid
    // (your rate +3.60%), Last Bid - Margin% (your rate 75,000: 3.60%). Two of the three said
    // nothing the first did not.
    ok(!/Last Bid - Margin/.test(lost) && !/your rate/.test(lost), 'and the separate margin line is gone with its repeated anchor');
    ok(/📉 _A sharper rate on this lane wins the next one\._/.test(lost) && !/We were outbid this time/.test(lost) && !/you gave a very high rate/.test(lost), 'the closing folds to just the forward nudge (the header already states the loss, so the old "We were outbid this time" restatement is dropped); still no unprovable "high rate" claim');
    ok(!/\{\{\d+\}\}/.test(lost), 'lost leaves no unfilled placeholders after the header shift');

    // header degradation: customer known but no route cities -> customer-only header (no empty parens)
    const lostCustOnly = renderMessage('lost', { oaNo: 'OA5', shipper: 'Syngenta', finalRank: 4, attempts: 1, closeTime: 'x' });
    ok(lostCustOnly.split('\n')[0] === '🔴 *LOST - Syngenta*', 'lost header degrades to customer-only when the route cities are absent (no dangling parens)');
    // neither customer nor route (rate-model / point-less load) -> bare shout, still loud
    const lostBare = renderMessage('lost', { oaNo: 'OA6', finalRank: 4, attempts: 1, closeTime: 'x' });
    ok(lostBare.split('\n')[0] === '🔴 *WE LOST THIS ONE*', 'lost header falls back to a bare "WE LOST THIS ONE" when neither customer nor route is known - still shouts the loss');
  }

  // ---- price_needed (minimal): moved-to-page content is GONE from the message; the transit-
  // required line is PRESERVED (do not lose it - SuperProcure 400s a bid with no transit days) ----
  {
    // EXTRA NOTE + previous quotes: even when the data is present, the minimal ask renders neither
    // (both are meant for the /price page - distance/product/note already there; quotes still to be
    // added, see the PR notes). No unfilled placeholders regardless.
    const withNoteAndQuotes = renderMessage('price_needed', {
      shipperName: 'Acme', laneFrom: 'A', laneTo: 'B', cargo: '1 x 32ft', link: 'http://x/price/7', closesText: 'x',
      extraNote: '40FT ODC * 2 VEHICLES',
      quotes: [{ amount: 16620, rate: 15000, bid: 16620, rank: 2, at: '17/04/2026 20:24' }],
    });
    ok(!/EXTRA NOTE/.test(withNoteAndQuotes) && !/40FT ODC/.test(withNoteAndQuotes), 'minimal ask does NOT render the shipper EXTRA NOTE (moved to the /price page)');
    ok(!/Previous Quotes on the Same Route/.test(withNoteAndQuotes) && !/16,620/.test(withNoteAndQuotes), 'minimal ask does NOT render previous quotes (still to be added to the /price page)');
    ok(!/\{\{\d+\}\}/.test(withNoteAndQuotes), 'minimal ask leaves no unfilled placeholders even with note/quotes data present');

    // transit-required load: the line MUST survive; a normal load never shows it.
    const transit = renderMessage('price_needed', { shipperName: 'SIKA', laneFrom: 'A', laneTo: 'B', cargo: '1 x 32ft', link: 'http://x/1', closesText: 'x', needsTransitTime: true });
    ok(/🚚 Enter transit days with the rate/.test(transit), 'minimal ask KEEPS the transit-required line when needsTransitTime is set (SuperProcure rejects a bid without it)');
    const noTransit = renderMessage('price_needed', { shipperName: 'Acme', laneFrom: 'A', laneTo: 'B', cargo: '1 x 32ft', link: 'http://x/1', closesText: 'x' });
    ok(!/transit/i.test(noTransit), 'minimal ask omits the transit line on a non-transit load');

    // header: "CUSTOMER · BRANCH" (middle-dot separator) when the load carries a branch; shipperName preferred over shipper.
    const branched = renderMessage('price_needed', { shipperName: 'Havells', shipper: 'HAV (Havells(Alwar))', branch: 'Alwar', laneFrom: 'Mumbai', laneTo: 'Alwar', cargo: '1 x 32FT . 18 MT', link: 'http://x/1', closesText: 'x' });
    ok(/^📩 \*Havells · Alwar\*/.test(branched), 'minimal ask header renders "CUSTOMER · BRANCH" (middle dot) and prefers the clean shipperName over the raw shipper');
    ok(/\n\n👉 http:\/\/x\/1$/.test(branched), 'the ask puts a blank line before the link line');
  }

  // ---- outcomeEnrichment: BRL fields from a closed-bids record ----
  {
    const e = outcomeEnrichment({ cost: 75000, lastBidPrice: 77700, closedAt: 1745900000000,
      equipment: '40FT', units: 1, lane: { origin: 'NANDIGRAM', destination: 'Nagpur' }, finalRank: 6,
      ourBids: [{ price: 77700 }, { price: 78000 }] });
    ok(e.marketRate === '75,000', 'outcomeEnrichment maps cost -> marketRate (formatted)');
    ok(e.marginRate === '77,700', 'outcomeEnrichment maps our bid -> margin-added rate');
    ok(e.attempts === 2, 'outcomeEnrichment counts all bids');
    ok(e.marginPct === '3.60', 'outcomeEnrichment computes 2dp margin over cost');
    ok(e.vehicleType === '1 x 40FT', 'outcomeEnrichment builds vehicleType = units x equipment');
    ok(e.from === 'NANDIGRAM' && e.finalRank === 6, 'outcomeEnrichment refines from + finalRank from the record');
    ok(e.dest === 'Nagpur', 'outcomeEnrichment refines the short destination lane city (for the lost header)');
    ok(e.wonRate === undefined, 'outcomeEnrichment omits wonRate on a loss (competitor amount masked)');
    const w = outcomeEnrichment({ cost: 75000, lastBidPrice: 77700, won: true });
    ok(w.wonRate === '77,700', 'outcomeEnrichment sets wonRate = our own winning bid on a WIN');
    ok(Object.keys(outcomeEnrichment(null)).length === 0, 'outcomeEnrichment(null) -> empty (lean fallback)');
    const partial = outcomeEnrichment({ lastBidPrice: 90000 }); // no cost -> no marketRate, no margin
    ok(partial.marginRate === '90,000' && partial.marketRate === undefined && partial.marginPct === undefined, 'outcomeEnrichment omits fields it cannot derive');

    // multi-pickup: the price_needed/confirmSubmitted fix (pickupAddress mirroring dropAddress)
    // must also apply to won/lost, or a load's own lifecycle messages disagree on its From.
    const multi = outcomeEnrichment({
      lane: { origin: 'Akola', destination: 'Padmala' },
      points: [
        { kind: 'pickup', address: 'Akola, Maharashtra 444001, India' },
        { kind: 'pickup', address: 'Washim, Maharashtra 444505, India' },
      ],
    });
    ok(multi.from === 'Akola, Maharashtra 444001, India; Washim, Maharashtra 444505, India', 'outcomeEnrichment carries every pickup point, not just lane.origin, for won/lost');
    ok(multi.origin === 'Akola', 'outcomeEnrichment keeps origin (the scope-routing key) as the single collapsed lane point, separate from the displayed from');
  }

  // ---- toNotification (auction_result): From mirrors the multi-pickup fix too --------------
  {
    const n = toNotification({
      type: 'auction_result', auctionId: 'a', won: true, finalRank: 1,
      lane: { origin: 'Akola', destination: 'Padmala' }, companyName: 'Acme',
      points: [
        { kind: 'pickup', address: 'Akola, Maharashtra 444001, India' },
        { kind: 'pickup', address: 'Washim, Maharashtra 444505, India' },
      ],
    });
    ok(n.data.from === 'Akola, Maharashtra 444001, India; Washim, Maharashtra 444505, India', 'toNotification carries every pickup point for won/lost, matching price_needed/confirmSubmitted');
    ok(n.data.origin === 'Akola', 'toNotification keeps origin as the single collapsed point for scope-matching');
  }

  // ---- notifyEngineEvent enriches won/lost from the record lookup (race-free by contract) ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => recipients });
    const getRecord = async () => ({ cost: 75000, lastBidPrice: 77700, closedAt: 1745900000000, equipment: '40FT', units: 1, lane: { origin: 'A', destination: 'B' }, finalRank: 6, ourBids: [{ price: 77700 }] });
    await notifyEngineEvent(n, { type: 'auction_result', auctionId: 'aX', won: false, finalRank: 6, lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' }, null, getRecord);
    const msg = tr.calls[tr.calls.length - 1].body.message;
    // end-to-end: the loss header (customer + lane cities) leads the enriched message, and the
    // enriched receipt (Your Rate) follows below it - the whole wire, event -> record -> template.
    ok(msg.split('\n')[0] === '🔴 *LOST - Acme*' && msg.split('\n')[1] === 'A → B', 'notifyEngineEvent leads the enriched lost alert with the loss header, route on its own second line');
    ok(!/Dear Manager/.test(msg) && /\*Your Rate\* - ₹75,000/.test(msg), 'notifyEngineEvent enriches the lost alert from the record, with the preamble gone (receipt body below the header)');
    // a throwing lookup must not block the alert (degrades to a still-valid won message)
    const boom = async () => { throw new Error('nope'); };
    const before = tr.calls.length;
    await notifyEngineEvent(n, { type: 'auction_result', auctionId: 'aY', won: true, finalRank: 1, lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' }, null, boom);
    ok(tr.calls.length - before === 2 && /^🎉 \*WON - Acme\*/.test(tr.calls[tr.calls.length - 1].body.message), 'a failing record lookup still sends the won alert (loud header from the event companyName)');
  }

  // ---- notifier: requestPrice still forwards the load equipment to the history provider (the
  // route-history data is fetched for the /price-page follow-up), but the shipper note and previous
  // quotes no longer render in the minimal ask itself ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    let seenOpts = null;
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
      recipientsProvider: async () => recipients,
      historyProvider: async (lane, opts) => { seenOpts = opts; return [{ amount: 16620, rank: 2, at: 1745900000000, equipment: '32ft', units: 1 }]; } });
    await n.requestPrice({ id: 'rqH', loadId: 'LH', load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', equipment: '32ft', units: 1, notes: 'HANDLE WITH CARE', closesAt: 0 } });
    const msg = tr.calls[0].body.message;
    ok(!/EXTRA NOTE/.test(msg) && !/HANDLE WITH CARE/.test(msg), 'the shipper note is NOT in the minimal ask (it renders on the /price page)');
    ok(!/Previous Quotes on the Same Route/.test(msg) && !/16,620/.test(msg), 'previous quotes are NOT in the minimal ask');
    // the notifier still forwards the load's equipment so routeHistory hard-matches on vehicle type
    // (the fetched history feeds the /price-page follow-up, not the message).
    ok(seenOpts && seenOpts.equipment === '32ft', 'requestPrice forwards the load equipment to the history provider (equipment-aware match)');
    ok(/🚛 1 x 32ft/.test(msg), 'minimal ask shows the vehicle on its own line');
  }

  // ---- notifier: confirmSubmitted routes a price_submitted receipt ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const subRecipients = [{ name: 'Desk', phone: '+919000000001', alerts: ['price_submitted'] }];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => subRecipients });
    await n.confirmSubmitted({ id: 'rqS', loadId: 'LS', price: { cost: 47000 }, capturedAt: 1745900000000,
      load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', equipment: '32ft', units: 1, closesAt: 0 } });
    ok(tr.calls.length === 1, 'confirmSubmitted -> the recipient subscribed to price_submitted');
    ok(/New Market Rate Submitted/.test(tr.calls[0].body.message) && /\*OA No\* - LS/.test(tr.calls[0].body.message) && /₹47,000/.test(tr.calls[0].body.message), 'confirmSubmitted renders the BRL receipt with the OA No + entered rate');
    // the first receipt now also carries the change-link footer (same public /price link)
    ok(/_Wrong rate\? Tap to change it:_ http:\/\/h\/price\/.*rqS/.test(tr.calls[0].body.message), 'the first-capture receipt carries the change-link footer');
    ok(!/We'll bid from/.test(tr.calls[0].body.message), 'confirmSubmitted with no ladder argument omits the bidding-contract line (fallback)');
    // idempotent: same request id, first-capture path -> deduped
    const before = tr.calls.length;
    await n.confirmSubmitted({ id: 'rqS', loadId: 'LS', price: { cost: 47000 }, capturedAt: 0, load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', closesAt: 0 } });
    ok(tr.calls.length - before === 0, 'a duplicate first-capture confirmSubmitted (same request) is suppressed');
    // a RE-PRICE is a deliberate repeat: it sends AGAIN (unique dedupe key), showing the corrected rate
    const beforeRp = tr.calls.length;
    await n.confirmSubmitted({ id: 'rqS', loadId: 'LS', price: { cost: 22000 },
      load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', equipment: '32ft', units: 1, closesAt: 0 } }, null, { reprice: true });
    ok(tr.calls.length - beforeRp === 1, 'a re-price confirmSubmitted sends again (not swallowed by the first receipt)');
    const rp = tr.calls[tr.calls.length - 1].body.message;
    ok(/₹22,000/.test(rp) && /_Wrong rate\? Tap to change it:_ http:\/\/h\/price\/.*rqS/.test(rp), 'the re-price receipt shows the corrected rate + the change-link footer');
  }

  // ---- notifier: confirmSubmitted redacts the capture token in the LOG, keeps it whole on WhatsApp ----
  // The changeLink footer IS the public /price capture link; its final segment is the raw capture
  // token - the sole unauthenticated auth for viewing/re-pricing a live-money load. It MUST go out
  // on WhatsApp in full (that footer is the feature), but MUST NEVER be written verbatim to the log
  // / dashboard event feed (CWE-532) - the same redact-before-log split requestPrice uses. Pin both
  // sides so neither can regress.
  {
    const logs = [];
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const subRecipients = [{ name: 'Desk', phone: '+919000000001', alerts: ['price_submitted'] }];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: (m) => logs.push(String(m)), wa, store: new MemoryStore(), recipientsProvider: async () => subRecipients });
    const TOKEN = 'rqSECRETtoken9876';   // stands in for the base62 capture token (publicSeg's final segment)
    await n.confirmSubmitted({ id: TOKEN, loadId: 'LS', price: { cost: 47000 }, capturedAt: 1745900000000,
      load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', equipment: '32ft', units: 1, closesAt: 0 } });
    const logStr = logs.join('\n');
    const sentMsg = tr.calls[tr.calls.length - 1].body.message;
    // (a) the log/alert projection was emitted, and it never carries the full capture token
    ok(/\[notify:whatsapp\] price_submitted /.test(logStr), 'the price_submitted alert line was logged (guards against a vacuous no-token pass)');
    ok(!logStr.includes(TOKEN), 'the logged alert payload does NOT contain the full capture token (CWE-532 redaction holds)');
    ok(logStr.includes('http://h/price/acme-r...'), 'the logged changeLink is redacted to the redactToken(publicSeg) prefix, mirroring requestPrice');
    // (b) the WhatsApp message still carries the full, working change-link (token intact) - the feature
    ok(sentMsg.includes(`http://h/price/acme-${TOKEN}`), 'the WhatsApp message payload DOES carry the full unredacted change-link (token intact)');
  }

  // ---- notifier: confirmSubmitted renders the bidding contract from the armed ladder + band ----
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const subRecipients = [{ name: 'Desk', phone: '+919000000001', alerts: ['price_submitted'] }];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(), recipientsProvider: async () => subRecipients });
    // the armed rung array (opening 50,400 -> floor 47,700) + the band the request carries. Prices
    // come from the ladder, percents from price.marginsPct/minMarginPct (top margin 12%, floor 6%).
    await n.confirmSubmitted(
      { id: 'rqB', loadId: 'LB', price: { cost: 45000, marginsPct: [12, 8, 6], minMarginPct: 6 }, capturedAt: 1745900000000,
        load: { lane: { origin: 'A', destination: 'B' }, companyName: 'Acme', equipment: '32ft', units: 1, closesAt: 0 } },
      [50400, 48600, 47700]);
    const msg = tr.calls[tr.calls.length - 1].body.message;
    ok(/💰 \*Your Rate\* - ₹45,000/.test(msg), 'confirmSubmitted anchors the receipt on Your Rate = the entered cost');
    ok(/📈 \*We'll bid from\* - ₹50,400 \(\+12%\), never below ₹47,700 \(\+6%\)/.test(msg),
      'confirmSubmitted renders the contract line: opening rung + top margin, floor rung + minMargin (percents from the band, not the prices)');
  }

  // ---- wasDelivered: the delivery evidence a caller running a retry depends on ----
  // Sending and MARKING are separate, independently-failing steps. A caller that retries an
  // undelivered page must not read a failed dedupe WRITE as proof the message never went out - that
  // re-sends something a human already received, once per retry tick.
  {
    const brokenStore = () => {
      const st = new MemoryStore();
      const put = st.putDoc.bind(st);
      st.putDoc = async (coll, k, d) => { if (coll === 'notifSent') throw new Error('ENOSPC'); return put(coll, k, d); };
      return st;
    };
    const build = (store) => {
      const tr = mockTransport();
      const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
      return { tr, n: new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store,
        recipientsProvider: async () => [{ name: 'Desk', phone: '+919000000001', alerts: ['error'] }] }) };
    };
    const pay = { context: 'sp-scope-X', detail: 'scope refresh for X has failed 3x in a row' };

    const a = build(new MemoryStore());
    await a.n.alert('error', pay, { dedupeKey: 'k1' });
    ok(a.tr.calls.length === 1 && (await a.n.wasDelivered('k1')) === true,
      'wasDelivered reports a delivered alert as delivered');
    ok((await a.n.wasDelivered('never-sent')) === false,
      'and reports an unknown key as NOT delivered when there is a store to say so');

    const b = build(brokenStore());
    await b.n.alert('error', pay, { dedupeKey: 'k2' });
    ok(b.tr.calls.length === 1 && (await b.n.wasDelivered('k2')) === true,
      'a message that went out but whose dedupe WRITE threw still reads as delivered');

    const c = build(null);
    ok((await c.n.wasDelivered('k3')) === null,
      'with no store and nothing sent the answer is null - "cannot answer", not "no"');
    await c.n.alert('error', pay, { dedupeKey: 'k4' });
    ok((await c.n.wasDelivered('k4')) === true,
      'but a send this process made is known regardless of any store');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
