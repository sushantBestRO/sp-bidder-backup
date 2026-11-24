'use strict';
/**
 * ZERO-BID CLOSES: what is a DECISION, what is a FAULT, and who hears about each.
 *
 * Regression target: SIKA 23534893, 2026-07-27. SuperProcure capped the load at Rs 26,000; the desk
 * had entered a Rs 27,000 cost, so the operating floor was Rs 27,540. Every legal bid would have
 * lost money, the L5 ceiling guard correctly declined, and the client's Director then received two
 * messages about it - an `error`-class alarm at 14:43, and at 15:30 a "NO BID PLACED ... no bid
 * could be placed before close" with no reason attached. He asked what it meant. Nothing had
 * broken; the reporting was wrong in three separate ways, and this file pins all three:
 *
 *   1. A deliberate refusal was raised as never_bid_before_close, an ops alarm, because the ONLY
 *      case treated as an intentional zero-bid was the shadow strategy. Every other knowing refusal
 *      fell through. Now it is derived from a RECORDED REASON - and the two cases that are genuine
 *      failures ("tried and never landed", "never fired at all") must still alarm. Those two are the
 *      line this change must not cross, so they get their own checks with the reason present.
 *   2. The outcome message dropped the reason it already knew. The refusal alert had been sent 47
 *      minutes earlier and nothing joined the two. Now the receipt states it, and degrades VERBATIM
 *      to the old wording when no reason was recorded (never invents one).
 *   3. ceiling_below_floor was in ERROR_KINDS, so a normal commercial outcome routed to whoever
 *      subscribes to faults - which, after the Director narrowed his own list to
 *      ["error","won","lost"], meant mostly him. It is now a non-paging desk_notice carrying the
 *      load's scope keys, so it reaches the customer's GROUP instead.
 *
 * Two traps this file exists to hold shut, both of which have already bitten this codebase:
 *   - the PAIRED_WITH_OUTCOME dedupe, which once produced ZERO messages for exactly the audience
 *     the alarm existed for. Proven in all three directions below (group gets it / nobody gets two /
 *     nobody gets neither), because fix 1 changes WHEN the paired error fires.
 *   - HEALTH_POLICY's unlisted-kind default of 'drop', which silently sinks a brand-new kind. There
 *     was no coverage test for it - the existing assertions name three kinds and then PIN the
 *     default, which an unclassified kind satisfies rather than trips. There is one now.
 *
 * Offline and deterministic: fake adapter, memory-backed scheduler and store, mock HTTP transport,
 * no timers, no network. The only mocked seams are the platform adapter and the WhatsApp transport.
 *
 *   node scripts/test-nobid-classification.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { toNotification, notifyEngineEvent, ERROR_KINDS, DESK_NOTICE_KINDS, PAIRED_WITH_OUTCOME } = require('../src/notify/engineAlerts');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { Notifier, HEALTH_POLICY } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { toRecipientRows } = require('../src/model/project');
const { ALERT_KINDS } = require('../src/admin/configStore');
const { MemoryStore } = require('../src/store');

let pass = 0, fail = 0;

// EXPECTED-COUNT SENTINEL, registered before any check runs and fired on process exit.
//
// run-tests.js grades by EXIT CODE ALONE, so a file that ends early - a `return` above the checks, a
// swallowed rejection, an unref'd timer letting the process drain - reaches exit 0 having asserted
// nothing, and reads as a pass. A count assertion placed at the BOTTOM of the file does not close
// that hole: it sits downstream of everything it guards, so any of those paths skips it too.
// Registering the handler HERE is what makes it fire on every path out of the process.
//
// The number is pinned because this file GREW with the rejection taxonomy (82 -> 89 checks): a later
// edit that silently drops checks now fails loudly instead of reporting a smaller green.
const EXPECTED_CHECKS = 89;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL -', m); } };

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `nobid-cls-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

// ---------------------------------------------------------------------------------------------
// Engine harness. Only the adapter is mocked; every engine internal is the real one.
// ---------------------------------------------------------------------------------------------
function mkEngine() {
  const adapter = {
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 30, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    getAuctionState: async () => ({ ok: false }),
    placeBid: async () => ({ accepted: true, myRank: 2, revisionsLeft: null, latencyMs: 20 }),
  };
  // The engine keeps its OWN event ring (bidEngine.emit pushes to this.events and then fans out to
  // onEvent). Read that ring directly - installing an onEvent collector as well double-counts every
  // event, which is how a "fired exactly once" assertion silently becomes "fired twice".
  return new BidEngine(adapter, new DurableScheduler(tmp()), {
    config: { openAtMs: 25_000, floorWindowMs: 2_500, minInterFireMs: 0 },
  });
}

// Arm a monitor and immediately disarm its timer, so a check drives the lifecycle by hand.
// `ceiling` on the rules is what produces the SIKA shape: cost 27,000 + a 2% minimum margin puts
// the operating floor at 27,540, and a 26,000 ceiling therefore sits below it.
function armLoad(eng, { id = 'L1', ceiling = null, companyName = 'SIKA India Private Limited', branchName = null } = {}) {
  const meta = {
    id, lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, units: 1, equipment: '32 Feet',
    companyName, branchName, closesAt: Date.now() + 600_000,
    rules: ceiling != null ? { ceilingPrice: ceiling, pricingMode: 'flat' } : null,
  };
  const m = eng.arm(meta, { cost: 27_000, marginsPct: [12, 7, 2], minMarginPct: 2 });
  if (m.timer) clearTimeout(m.timer);
  m.timer = null;
  return m;
}

const st = (remaining, myRank = null) => ({ closesInMs: remaining, myRank, minDecrement: 100, standingL1Price: null, measuredRttMs: 50 });

const kindsOf = (events, kind) => events.filter((e) => e.type === 'alert' && e.kind === kind);
const resultOf = (events) => events.find((e) => e.type === 'auction_result');

function mockTransport() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // =============================================================================================
  console.log('\n1. a DELIBERATE refusal no longer raises the zero-bid alarm');
  // =============================================================================================
  {
    const eng = mkEngine();
    const m = armLoad(eng, { ceiling: 26_000 });
    ok(m.ceilingBelowFloor === true && m.floor === 27_540 && m.ceiling === 26_000,
      'the SIKA shape reproduces: floor 27,540 against a 26,000 ceiling, refused at arm');

    // Drive the REAL refusal site, not a hand-set flag: _decide is where the engine declines.
    ok(eng._decide(m, st(300_000)) === null, '_decide declines the load outright');
    ok(m.noBid && m.noBid.reason === 'ceiling_below_floor' && m.noBid.ceiling === 26_000,
      'the refusal is RECORDED on the monitor at the site that took it, with the ceiling');
    ok(kindsOf(eng.events, 'ceiling_below_floor').length === 1, 'the refusal raised its own alert, once');

    await eng._finalize(m, st(0));
    ok(kindsOf(eng.events, 'never_bid_before_close').length === 0,
      'REGRESSION (SIKA 23534893): a recorded refusal does NOT also raise never_bid_before_close');

    const res = resultOf(eng.events);
    ok(res && res.landedBids === 0, 'the outcome still reports zero landed bids (the NO BID PLACED receipt is unchanged)');
    ok(res.noBidReason === 'ceiling_below_floor' && res.noBidCeiling === 26_000,
      'the outcome CARRIES the reason and the ceiling, so the receipt can state it without a second message');
  }

  // =============================================================================================
  console.log('\n2. THE LINE: genuine failures still alarm');
  // =============================================================================================
  {
    // (a) armed and never fired at all, with NO reason recorded anywhere.
    const eng = mkEngine();
    const m = armLoad(eng, { id: 'N1' });
    await eng._finalize(m, st(0));
    ok(kindsOf(eng.events, 'never_bid_before_close').length === 1,
      'armed, never fired, no reason recorded -> STILL a genuine failure, still alarms');
    ok(resultOf(eng.events).noBidReason === null, 'and the receipt carries no invented reason');
  }
  {
    // (b) a reason WAS recorded, but the load then used the wire and nothing landed. That is
    //     "tried and was refused every time" - a genuine failure that must not hide behind the
    //     earlier refusal. ownBidAttempts is the fact that separates the two.
    const eng = mkEngine();
    const m = armLoad(eng, { id: 'N2' });
    eng._recordRefusal(m, 'transit_time_missing_blocked');
    eng.adapter.placeBid = async () => ({ accepted: false, reason: 'Bid difference too small.', status: 400 });
    await eng._maybeBid(m, st(1_000));
    ok(m.ownBidAttempts > 0 && m.landedBids === 0, 'the load used the wire and nothing landed');
    await eng._finalize(m, st(0));
    ok(kindsOf(eng.events, 'never_bid_before_close').length === 1,
      'THE LINE: a recorded reason does NOT silence a load that tried and never landed');
  }
  {
    // (c) the control: bids landed -> no alarm and no reason on the receipt, whatever was recorded.
    const eng = mkEngine();
    const m = armLoad(eng, { id: 'N3' });
    eng._recordRefusal(m, 'transit_time_missing_blocked');
    await eng._maybeBid(m, st(1_000));
    ok(m.landedBids > 0, 'a bid landed');
    await eng._finalize(m, st(0));
    ok(kindsOf(eng.events, 'never_bid_before_close').length === 0, 'a load that landed a bid never raises the zero-bid alarm');
    ok(resultOf(eng.events).noBidReason === null,
      'a close that LANDED a bid never carries a stale refusal reason (it would contradict its own receipt)');
  }
  {
    // (d) shadow: unchanged behaviour, but now as one member of the deliberate set rather than
    //     its definition. This is the assertion that proves the widening did not drop the old case.
    const eng = mkEngine();
    const m = armLoad(eng, { id: 'N4' });
    m.softStrategy = 'shadow';
    await eng._finalize(m, st(0));
    ok(kindsOf(eng.events, 'never_bid_before_close').length === 0, 'a shadow close is still treated as a deliberate zero-bid');
  }

  // =============================================================================================
  console.log('\n3. the outcome message carries the reason it already knows');
  // =============================================================================================
  {
    const evt = {
      type: 'auction_result', auctionId: '23534893', won: false, finalRank: null,
      lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, companyName: 'SIKA India Private Limited',
      equipment: '32 Feet', landedBids: 0, noBidReason: 'ceiling_below_floor', noBidCeiling: 26_000,
    };
    const n = toNotification(evt);
    ok(n.kind === 'lost', 'the SUBSCRIPTION kind stays lost - no new kind to migrate recipients onto');
    ok(n.data.noBidReason === 'ceiling_below_floor' && n.data.noBidCeiling === 26_000, 'the reason rides onto the notification payload');

    const data = Object.assign({}, n.data, { marketRate: '27,000', from: 'Vejalpur', to: 'CBD BELAPUR', vehicleType: '32 Feet' });
    const body = renderMessage(templateFor('lost', data), data);
    ok(/NO BID PLACED/.test(body), 'it still renders the no-bid receipt, not a loss');
    ok(body.includes("the customer's price ceiling (₹26,000) was below our cost (₹27,000)"),
      'the receipt STATES the reason with both numbers, in one message');
    ok(!/no bid could be placed before close/.test(body), 'the unexplained line is gone when a reason is known');

    // the SHORT group-reply variant must carry it too, or the group thread loses the reason
    const short = renderMessage(templateFor('lost', data, { short: true }), data);
    ok(short.includes("price ceiling (₹26,000)"), 'the short group-reply variant carries the reason as well');
  }
  {
    // no reason -> the PREVIOUS wording, byte for byte. Never a guess.
    const data = { landedBids: 0, oaNo: 'X', marketRate: '27,000' };
    const body = renderMessage(templateFor('lost', data), data);
    ok(body.includes('A rate was entered but no bid could be placed before close. Please check this load on SuperProcure.'),
      'with no recorded reason the receipt degrades VERBATIM to the previous wording');
    const partial = renderMessage(templateFor('lost', { landedBids: 0, noBidReason: 'ceiling_below_floor' }), { landedBids: 0, noBidReason: 'ceiling_below_floor' });
    ok(partial.includes('A rate was entered but no bid could be placed'),
      'a reason WITHOUT the ceiling number degrades too - a half-sentence about a missing number is worse than the old line');
  }

  // =============================================================================================
  console.log('\n4. classification: a commercial refusal is not a fault');
  // =============================================================================================
  {
    ok(!ERROR_KINDS.has('ceiling_below_floor'), 'ceiling_below_floor is OUT of ERROR_KINDS');
    ok(DESK_NOTICE_KINDS.has('ceiling_below_floor'), 'ceiling_below_floor is a desk_notice');
    // load_not_biddable (2026-08-01). SuperProcure refusing a bid because the LOAD is not open to
    // bidding is not a fault on our side and there is nothing an operator can restart to fix it -
    // but it IS the desk's load and the one useful action ("check it on SuperProcure") is theirs.
    // Ops does not go blind: the load still closes with zero landed bids, so never_bid_before_close
    // (an ERROR kind, asserted just below) still fires on it.
    ok(!ERROR_KINDS.has('load_not_biddable'), 'load_not_biddable is OUT of ERROR_KINDS - no fault, nothing to restart');
    ok(DESK_NOTICE_KINDS.has('load_not_biddable'), 'load_not_biddable is a desk_notice - it reaches the customer group');
    // The keep-list. Each of these is a genuine fault and must never drift onto the notice channel.
    for (const k of ['tick_error', 'repeated_read_failures', 'killed', 'floor_breach_blocked']) {
      ok(ERROR_KINDS.has(k) && !DESK_NOTICE_KINDS.has(k), `${k} stays an ERROR (genuine fault)`);
    }
    // auth_error_mid_auction came OFF the keep-list on 2026-08-04, and this asserts it stays off.
    // It is emitted PER LOAD and its dedupe key is built from the auction id, so as a WhatsApp kind
    // it is one message per armed load. It was harmless only while dormant - realAdapter set
    // state.authError exclusively when ensureSession threw, and ensureSession checked nothing but the
    // JWT expiry, which a revoked-but-unexpired token passes. The read-path 401/403 branch added in
    // the same change wakes it, so leaving it here would have replaced the 56-message flood with a
    // per-load one wearing raw jargon. The account-wide fact has exactly one message now:
    // account_auth_dead, raised once per account per outage by the adapter.
    ok(!ERROR_KINDS.has('auth_error_mid_auction') && !DESK_NOTICE_KINDS.has('auth_error_mid_auction'),
      'auth_error_mid_auction is OUT of both routed sets - it is per-load, and the account-wide alarm replaces it');
    // never_bid_before_close is the sharp one: once fix 1 stops it firing for explained refusals,
    // what is left under that kind IS the genuine failure, so demoting it would be the blanket
    // silence this change is careful not to become.
    ok(ERROR_KINDS.has('never_bid_before_close') && !DESK_NOTICE_KINDS.has('never_bid_before_close'),
      'never_bid_before_close stays an ERROR - after fix 1 it means only a genuine failure');
    ok(PAIRED_WITH_OUTCOME.get('never_bid_before_close') === 'lost', 'its dedupe pairing is untouched');
    ok([...DESK_NOTICE_KINDS].every((k) => !ERROR_KINDS.has(k)), 'the two sets are disjoint - no kind can be both');
  }
  {
    const n = toNotification({
      type: 'alert', level: 'error', kind: 'ceiling_below_floor', auctionId: '23534893',
      ceiling: 26_000, floor: 27_540, detail: 'shipper ceiling 26000 is below the cost floor 27540',
      lane: { origin: 'Vejalpur', destination: 'CBD BELAPUR' }, companyName: 'SIKA India Private Limited',
      branchName: 'Vejalpur Plant (900)',
    });
    ok(n.kind === 'desk_notice', 'the refusal routes as desk_notice, not error');
    ok(n.data.shipper === 'SIKA India Private Limited' && n.data.origin === 'Vejalpur' && n.data.branch === 'Vejalpur Plant (900)',
      'it carries the SCOPE KEYS at the top of data - without a shipper no customer group can ever match it');
    ok(n.data.ceiling === 26_000 && n.data.floor === 27_540, 'and both money numbers, so the desk sees the gap');

    const body = renderMessage('desk_notice', n.data);
    ok(/Not bidding/.test(body) && /26,000/.test(body) && /27,540/.test(body), 'the notice names the load, the ceiling and our floor');
    ok(/re-price/i.test(body), 'and tells the desk what to do about it');
  }

  // =============================================================================================
  console.log('\n5. HEALTH_POLICY: no kind may take the silent default');
  // =============================================================================================
  {
    // The trap PR #78 left: an unlisted kind resolves to 'drop', so a new kind goes silent on
    // exactly the days the sender is down. This is the check that fails if one is ever left out.
    const unlisted = ALERT_KINDS.filter((k) => !Object.prototype.hasOwnProperty.call(HEALTH_POLICY, k));
    ok(unlisted.length === 0,
      unlisted.length ? `every ALERT_KINDS member is explicitly classified in HEALTH_POLICY (UNLISTED: ${unlisted.join(', ')})`
        : 'every ALERT_KINDS member is explicitly classified in HEALTH_POLICY');
    ok(HEALTH_POLICY.desk_notice === 'drop', "desk_notice is classified 'drop' deliberately, not by inheriting the default");
    ok(ALERT_KINDS.includes('desk_notice'), 'desk_notice is a real subscription kind');
  }

  // =============================================================================================
  console.log('\n6. the PAIRED_WITH_OUTCOME dedupe still holds, in all three directions');
  // =============================================================================================
  {
    // The recipient table that broke it before: a scoped customer GROUP, an unscoped every-load ops
    // recipient, and a human with an explicit kind list (the Director's actual shape).
    const HAVELLS_GROUP = '120363431523383103@g.us';
    const customers = [{ customerId: 'havells', label: 'Havells', aliases: ['Havells'] }];
    const people = [
      { personId: 'g120363431523383103', name: 'BRL Bids - Havells', phone: HAVELLS_GROUP, alertPrefs: 'all', alertAll: false, enabled: true },
      { personId: 'p919000000001', name: 'Ops (every load)', phone: '+919000000001', alertPrefs: 'all', alertAll: true, enabled: true },
      { personId: 'p919000000002', name: 'Director', phone: '+919000000002', alertPrefs: ['error', 'won', 'lost'], alertAll: true, enabled: true },
    ];
    const assignments = [{ assignmentId: 'a1', personId: 'g120363431523383103', customerId: 'havells', enabled: true }];

    const mkNotifier = () => {
      const tr = mockTransport();
      const wa = new WhatsAppClient({ enabled: true, token: 't', productId: 'p', phoneId: '128023', transport: tr });
      const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa, store: new MemoryStore(),
        recipientsProvider: async () => toRecipientRows(customers, people, assignments) });
      return { n, tr };
    };
    // Maytapi's wire form is bare digits - the stored '+91...' loses its plus on the way out - so
    // compare against the WIRE value, not the record value.
    const OPS = '919000000001', DIR = '919000000002';
    const to = (tr) => tr.calls.map((c) => c.body.to_number);

    // The load-bearing subscription fact, asserted rather than assumed: a customer GROUP is
    // registered alertPrefs:'all', which model/project expands against the LIVE ALERT_KINDS at read
    // time - so it picks up desk_notice with no record migration. A human carrying an explicit kind
    // list does not. That asymmetry IS the fix; if it ever stops holding, the notice reaches nobody
    // and the Director starts being paged again, so it is pinned here rather than left to the wiring.
    {
      const rows = toRecipientRows(customers, people, assignments);
      const group = rows.find((r) => r.phone === HAVELLS_GROUP);
      const director = rows.find((r) => r.phone === '+919000000002');
      ok(group.alerts.includes('desk_notice'), "a group registered alertPrefs:'all' subscribes to desk_notice automatically");
      ok(!director.alerts.includes('desk_notice'), 'a human with an explicit kind list does NOT - which is what stops the paging');
      ok(director.alerts.includes('error'), 'and that human still subscribes to genuine faults');
    }

    // ---- a GENUINE failure close: the paired error + the outcome, in the same _finalize ----
    {
      const { n, tr } = mkNotifier();
      const base = { auctionId: 'P1', lane: { origin: 'Alwar', destination: 'Pune' }, companyName: 'Havells India Limited' };
      await notifyEngineEvent(n, Object.assign({ type: 'auction_result', won: false, finalRank: null, landedBids: 0 }, base));
      await notifyEngineEvent(n, Object.assign({ type: 'alert', level: 'warn', kind: 'never_bid_before_close', attempts: 2 }, base));

      const sent = to(tr);
      // DIRECTION 1 - the outcome reaches its group.
      ok(sent.filter((p) => p === HAVELLS_GROUP).length === 1, 'DIRECTION 1: the outcome reaches the customer group, exactly once');
      // DIRECTION 2 - nobody gets two messages about one close.
      ok(new Set(sent).size === sent.length, 'DIRECTION 2: no recipient receives two messages about one close');
      // DIRECTION 3 - nobody gets neither. Every recipient that matched either message got one.
      ok(sent.includes(OPS) && sent.includes(DIR),
        'DIRECTION 3: the ops recipient and the Director each still get exactly one of the pair (the alarm), never zero');
      ok(sent.length === 3, 'three recipients, three messages - one each');
    }

    // ---- the DELIBERATE close: fix 1 means the paired error never fires at all ----
    {
      const { n, tr } = mkNotifier();
      const base = { auctionId: 'P2', lane: { origin: 'Alwar', destination: 'Pune' }, companyName: 'Havells India Limited' };
      // The engine no longer emits never_bid_before_close here - only the outcome, carrying the reason.
      await notifyEngineEvent(n, Object.assign({ type: 'auction_result', won: false, finalRank: null, landedBids: 0,
        noBidReason: 'ceiling_below_floor', noBidCeiling: 26_000 }, base));
      const sent = to(tr);
      ok(sent.length === 1 && sent[0] === HAVELLS_GROUP,
        'a deliberate refusal produces ONE message, to the customer group - and zero Director DMs');
      ok(/price ceiling/.test(tr.calls[0].body.message), 'and that one message explains itself');
    }

    // ---- the desk notice itself: the group hears it early; the Director does not hear it at all ----
    {
      const { n, tr } = mkNotifier();
      await notifyEngineEvent(n, {
        type: 'alert', level: 'error', kind: 'ceiling_below_floor', auctionId: 'P3',
        ceiling: 26_000, floor: 27_540, detail: 'ceiling below floor',
        lane: { origin: 'Alwar', destination: 'Pune' }, companyName: 'Havells India Limited',
      });
      const sent = to(tr);
      ok(sent.length === 1 && sent[0] === HAVELLS_GROUP,
        'the refusal notice reaches the customer GROUP - the desk that priced it, while the load is still open');
      ok(!sent.includes(DIR), 'REGRESSION (13 DMs on 27-Jul): it does NOT reach the Director');
      ok(/Not bidding/.test(tr.calls[0].body.message), 'and it says plainly that we are not bidding this one');
    }

    // ---- a genuine fault is unchanged: it still pages ----
    {
      const { n, tr } = mkNotifier();
      // tick_error, not auth_error_mid_auction: the latter was the exemplar here until 2026-08-04,
      // when it came out of ERROR_KINDS (it is per-load, and the account-wide account_auth_dead alarm
      // replaces it). The point of this check is that a GENUINE fault still pages both audiences, so
      // it needs an exemplar that is still routed.
      await notifyEngineEvent(n, { type: 'alert', level: 'error', kind: 'tick_error', auctionId: 'P4',
        detail: 'read failed', lane: { origin: 'Alwar', destination: 'Pune' }, companyName: 'Havells India Limited' });
      const sent = to(tr);
      ok(sent.includes(OPS) && sent.includes(DIR),
        'a real fault still pages both the ops recipient and the Director - the alarm channel is intact');
    }
  }

  // =============================================================================================
  console.log('\n7. Director-facing copy: no internal jargon, no banned vocabulary');
  // =============================================================================================
  {
    const err = renderMessage('error', { context: 'Alwar -> Pune', detail: 'session expired' });
    ok(!/console/i.test(err), 'REGRESSION: the error message no longer tells a Director to "check the console"');
    ok(/Alwar -> Pune/.test(err) && /session expired/.test(err), 'it still names the load and the detail');

    // The hard client requirement, applied to every string this change introduced or touched.
    const surfaces = [
      renderMessage('desk_notice', { shipper: 'SIKA', oaNo: '1', lane: 'A -> B', reason: 'ceiling_below_floor', ceiling: 26_000, floor: 27_540 }),
      renderMessage('desk_notice', {}),
      renderMessage('no_bid', { landedBids: 0, noBidReason: 'ceiling_below_floor', noBidCeiling: 26_000, marketRate: '27,000' }),
      renderMessage('no_bid', { landedBids: 0 }),
      renderMessage('no_bid_short', { landedBids: 0, noBidReason: 'stood_down_below_floor' }),
      renderMessage('no_bid_short', { landedBids: 0, noBidReason: 'transit_time_missing_blocked' }),
      renderMessage('no_bid_short', { landedBids: 0, noBidReason: 'unsupported_rule_blocked' }),
      // Both surfaces of the 2026-08-01 load-not-biddable pair: the desk notice sent the moment
      // SuperProcure refuses, and the close-time receipt that states the same reason.
      renderMessage('desk_notice', { shipper: 'Havells', oaNo: '23718407', lane: 'Bhiwandi -> Alwar', reason: 'load_not_biddable' }),
      renderMessage('no_bid_short', { landedBids: 0, noBidReason: 'load_not_biddable' }),
      err,
    ];
    for (const s of surfaces) {
      ok(!/\bbots?\b/i.test(String(s)), `no banned word "bot" in -> ${String(s).slice(0, 60).replace(/\s+/g, ' ')}...`);
      ok(!/\bengines?\b/i.test(String(s)), `no banned word "engine" in -> ${String(s).slice(0, 60).replace(/\s+/g, ' ')}...`);
    }
    // Every recognised reason must produce a REAL sentence, never the fallback - otherwise a branch
    // silently reverts to the unexplained wording the whole change exists to remove.
    for (const reason of ['ceiling_below_floor', 'stood_down_below_floor', 'transit_time_missing_blocked',
      'unsupported_rule_blocked', 'load_not_biddable']) {
      const d = { landedBids: 0, noBidReason: reason, noBidCeiling: reason === 'ceiling_below_floor' ? 26_000 : null };
      const body = renderMessage('no_bid', d);
      ok(!/A rate was entered but no bid could be placed/.test(body), `${reason} renders its own explanation, not the fallback`);
    }
  }

  // =============================================================================================
  console.log('\nTHE REASON NAMED MUST BE THE REASON THAT IS TRUE');
  // =============================================================================================
  // "below our cost" holds only when the ceiling is under the entered COST. When the ceiling sits
  // BETWEEN the cost and the operating floor, the cost fits and the MARGIN is the blocker - so that
  // sentence is false, and this is the message the client's Director reads. Both directions are
  // pinned: Case A must NOT contain it and Case B MUST, so neither can be satisfied by deleting the
  // sentence everywhere.
  {
    const base = { shipper: 'Havells India Ltd.', oaNo: '23534893', noBidReason: 'ceiling_below_floor' };
    // ceiling 15,500 vs cost 15,000 -> the ceiling is Rs 500 ABOVE cost. The 15,900 floor is the blocker.
    const caseA = renderMessage('no_bid_short',
      { ...base, noBidCeiling: 15_500, noBidFloor: 15_900, marketRate: '15,000' });
    ok(!/below our cost/i.test(caseA),
      'Case A does NOT claim the ceiling was below our cost - it was Rs 500 above it');
    ok(/15,500/.test(caseA) && /15,900/.test(caseA),
      'Case A names the ceiling AND our lowest price, so the real gap is visible');

    // ceiling 14,000 vs cost 15,000 -> genuinely below cost. The sentence is true and must stay.
    const caseB = renderMessage('no_bid_short',
      { ...base, noBidCeiling: 14_000, noBidFloor: 15_900, marketRate: '15,000' });
    ok(/below our cost/i.test(caseB),
      'Case B keeps the "below our cost" sentence, because there it is TRUE');

    // Every event persisted before noBidFloor existed carries no floor. It must degrade to the
    // previous wording rather than decide a case on a number it does not have.
    const legacy = renderMessage('no_bid_short',
      { ...base, noBidCeiling: 14_000, marketRate: '15,000' });
    ok(/below our cost/i.test(legacy),
      'a legacy event with no floor degrades to the previous wording, never to a guess');

    // The desk notice led with the same claim in its headline - the first line the Director reads.
    const notice = renderMessage('desk_notice',
      { ...base, reason: 'ceiling_below_floor', ceiling: 15_500, floor: 15_900 });
    ok(!/ceiling is below our cost/i.test(notice),
      'the desk-notice headline no longer asserts "below our cost" either');
    ok(/15,500/.test(notice) && /15,900/.test(notice),
      'it shows both numbers instead, and lets the gap speak for itself');
  }

  // ---------------------------------------------------------------------------------------------
  // Completion sentinel. scripts/run-tests.js grades by EXIT STATUS ONLY, so a file that ends early
  // - an unref'd timer, an early return, a swallowed rejection - is a silent green with zero
  // assertions. Printing the count and exiting explicitly is what makes this file's pass mean
  // something. The floor is a floor, not an exact count: adding a check must not fail the file.
  // ---------------------------------------------------------------------------------------------
  cleanup();
  console.log(`\nnobid-classification: ${pass} passed, ${fail} failed`);
  assert.ok(pass >= 45, `the suite must assert something substantial (saw ${pass} passing assertions)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  cleanup();
  console.error('nobid-classification: FATAL', e);
  process.exit(1);
});
