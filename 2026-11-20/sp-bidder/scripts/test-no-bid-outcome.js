'use strict';
/**
 * ZERO-LANDED-BID OUTCOME (load 23484018, 2026-07-25).
 *
 * A load the desk priced at Rs 15,000 had BOTH bid attempts REFUSED by SuperProcure (HTTP 400,
 * "Load not available for bidding"). Nothing landed, rank stayed null - and the WhatsApp group was
 * told "LOST ... Our Final Ranking - -". Two defects, one message:
 *
 *   1. engineAlerts.toNotification collapsed every !won close to the 'lost' template, so a load
 *      that never got a bid onto the board rendered as a fought-and-lost auction. The funnel layer
 *      (exportModel.deriveStatus) already called the same close 'no_bid' - two classifiers
 *      disagreeing about one auction.
 *   2. _finalize's everBid test counted a REJECTED attempt as a bid (via currentRungIndex, which
 *      the rejection handler advances deliberately to stop a refused rung re-firing). That
 *      suppressed the loud never_bid_before_close alarm and fired info-only lost_after_bidding.
 *
 * What this pins:
 *   A. an armed load with ZERO LANDED bids never renders the LOST template (no_bid variant instead,
 *      selected off the participation fact, WITHOUT minting a new subscription kind)
 *   B. the same load trips never_bid_before_close (landed-only derivation)
 *   C. the dedupe: a recipient subscribed to BOTH error and lost gets ONE message, not two -
 *      including on the LIVE routing shape (a shipper-scoped group plus an unscoped all-alerts DM),
 *      where inferring delivery from subscription used to leave that DM with ZERO messages
 *   D. reversibility - won and landed-but-lost are byte-identical to pre-fix
 *   E. the funnel's no_bid and the WhatsApp outcome now AGREE about the same close
 *   F. the participation fact SURVIVES A RESTART - land a bid, crash, rehydrate a fresh engine off
 *      the same intents file, close: still LOST, and no false zero-bid alarm. `pm2 restart
 *      bid-command` is this project's own deploy step, so a restart inside a live auction window is
 *      the normal case, and a per-process counter would re-create the very bug this file pins.
 *   G. a SHADOW would-have-placed decision is not a landed bid (shadow makes zero wire writes)
 *
 * Offline and deterministic: fake adapter, temp-file scheduler, mock WhatsApp transport.
 *
 *   node scripts/test-no-bid-outcome.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { BidEngine } = require('../src/engine/bidEngine');
const { DurableScheduler } = require('../src/scheduler/durableScheduler');
const { renderMessage, templateFor } = require('../src/notify/waTemplates');
const { toNotification, notifyEngineEvent, landedEvidence } = require('../src/notify/engineAlerts');
const { Notifier } = require('../src/notify/notifier');
const { WhatsAppClient } = require('../src/notify/whatsapp');
const { MemoryStore } = require('../src/store');
const { deriveStatus } = require('../src/web/exportModel');

let pass = 0, fail = 0;

// EXPECTED-COUNT SENTINEL, registered before any check runs and fired on process exit.
//
// run-tests.js grades by EXIT CODE ALONE, so a file that ends early - a `return` above the checks, a
// swallowed rejection, an unref'd timer letting the process drain - reaches exit 0 having asserted
// nothing, and reads as a pass. A count assertion placed at the BOTTOM of the file does not close
// that hole: it sits downstream of everything it guards, so any of those paths skips it too.
// Registering the handler HERE is what makes it fire on every path out of the process.
//
// The number is pinned because this file GREW with the rejection taxonomy (77 -> 90 checks): a later
// edit that silently drops checks now fails loudly instead of reporting a smaller green.
const EXPECTED_CHECKS = 90;
process.on('exit', () => {
  if (pass === EXPECTED_CHECKS) return;
  console.error(`\nCOMPLETION SENTINEL FAILED: ran ${pass} checks, expected ${EXPECTED_CHECKS}`
    + ' - the file exited early, or checks were removed without updating the count');
  process.exitCode = 1;
});
const check = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.error('  FAIL - ' + m); } };

let seq = 0;
const CLEAN = [];
const tmp = () => { const f = path.join(os.tmpdir(), `no-bid-${process.pid}-${seq++}.json`); CLEAN.push(f); return f; };
const cleanup = () => { for (const f of CLEAN) { try { fs.unlinkSync(f); } catch (_) {} } };

const alertKinds = (events) => events.filter((e) => e.type === 'alert').map((e) => e.kind);
const resultEvent = (events) => events.find((e) => e.type === 'auction_result');

// Every bid REFUSED, exactly as SuperProcure refused load 23484018: HTTP 400 with a plaintext
// body, and our rank never leaves null (nothing of ours is ever on the board).
function allRejectedAdapter(closesAt) {
  return {
    attempts: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: null, totalBidders: 4,
        standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: 3,
        closeModel: 'hard', measuredRttMs: 30 };
    },
    async placeBid(id, price) {
      this.attempts.push({ price, at: Date.now() });
      return { accepted: false, reason: 'rejected', status: 400, text: 'Load not available for bidding' };
    },
  };
}

// Every bid ACCEPTED, and we finish behind - the ordinary fought-and-lost auction.
function landedThenLostAdapter(closesAt, { rank = 3 } = {}) {
  let revs = 3;
  return {
    attempts: [],
    capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
    ensureSession: async () => ({}),
    async getAuctionState() {
      return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: rank, totalBidders: 4,
        standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: revs,
        closeModel: 'hard', measuredRttMs: 30 };
    },
    async placeBid(id, price) {
      this.attempts.push({ price, at: Date.now() });
      revs = Math.max(0, revs - 1);
      return { accepted: true, myRank: rank, revisionsLeft: revs, latencyMs: 30 };
    },
  };
}

const mockTransport = () => {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ success: true, data: { msgId: 'mid-' + calls.length } }) };
  };
  fn.calls = calls;
  return fn;
};
const CREDS = { token: 't', productId: 'p', phoneId: '128023' };

(async () => {
  // ==========================================================================================
  // A + B. THE REPRODUCER. Both attempts refused -> nothing landed.
  // ==========================================================================================
  {
    const closesAt = Date.now() + 3000;
    const adapter = allRejectedAdapter(closesAt);
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 2500, floorWindowMs: 500, minInterFireMs: 0 }, onEvent: (e) => events.push(e),
    });
    const monitor = engine.arm(
      { id: '23484018', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
        companyName: 'Havells', closesAt },
      { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 3600));

    check(adapter.attempts.length >= 1, 'reproducer: the engine DID attempt at least one bid (the wire was used)');
    check(monitor.lastBidPrice == null, 'reproducer: lastBidPrice stayed null - not one bid landed');
    // THE ANTI-SHORTCUT GUARD, RE-ARMED ON THE CAP PATH (see block B2 below).
    //
    // This check used to read `currentRungIndex >= 0` here, pinning the rejection handler's rung
    // bookkeeping so THIS fix could not be "solved" by reverting it. That guard was right, and it is
    // kept - but it can no longer be asserted on THIS load. The 2026-08-01 rejection taxonomy
    // established that the string this reproducer rejects with, "Load not available for bidding", is
    // a PER-LOAD STATE at SuperProcure (14 such loads, not one ever landed a bid), so the engine now
    // stands down on it and rolls the un-consumed ladder position back. currentRungIndex is -1 here
    // by design, and the never-bid derivation must not read it in EITHER direction.
    //
    // The guard therefore moves to the CAP-rejection path (B2), where rung bookkeeping IS still
    // advanced by a bid that never landed - which is exactly the shape this file was written to
    // prove the participation fact survives.
    check(monitor.landedBids === 0, 'reproducer: landedBids stayed 0 - the LANDED participation fact, not a ladder counter');
    check(monitor.everBid === true, 'reproducer: the ATTEMPT fact is NOT rolled back - SP may have counted the refused bid against its own cap');
    check(adapter.attempts.length === 1, 'reproducer: the engine STOOD DOWN after the load-not-biddable refusal - one write on a live shared account, not a retry storm');

    const res = resultEvent(events);
    check(!!res, 'auction_result was emitted');
    check(res && res.landedBids === 0, 'auction_result carries the participation fact landedBids = 0');
    check(res && res.won === false, 'auction_result says not won');

    const kinds = alertKinds(events);
    check(kinds.includes('never_bid_before_close'), 'B: never_bid_before_close FIRED (a rejected attempt is not a bid)');
    check(!kinds.includes('lost_after_bidding'), 'B: lost_after_bidding did NOT fire');

    // A: the notification keeps the 'lost' SUBSCRIPTION kind (so existing recipients still route)
    // but carries the participation fact that selects a different template.
    const n = toNotification(res);
    check(n && n.kind === 'lost', 'A: routing kind stays "lost" - no new subscription kind, no config migration');
    check(n && n.data.landedBids === 0, 'A: the notification data carries landedBids = 0');
    check(templateFor('lost', n.data) === 'no_bid', 'A: template selection resolves to the no_bid variant');
    check(templateFor('lost', n.data, { short: true }) === 'no_bid_short', 'A: the group reply resolves to no_bid_short');

    const msg = renderMessage(templateFor('lost', n.data), n.data);
    check(/^[^\n]*NO BID PLACED/.test(msg), 'A: first line reads "NO BID PLACED" in a chat-list preview');
    check(!/LOST/.test(msg), 'A: the word LOST never appears');
    check(!/Our Final Ranking/.test(msg), 'A: no "Our Final Ranking - -" line (the desk complaint)');
    // The receipt now states the RECORDED platform reason instead of the generic unknown-reason
    // line. That generic line ("A rate was entered but no bid could be placed before close. Please
    // check this load on SuperProcure.") is still the fallback for a close nobody recorded a reason
    // for - asserted verbatim in scripts/test-nobid-classification.js - but here it was misleading:
    // it reads as a rate that failed to go in and sends the desk hunting a pricing mistake that does
    // not exist, when the rate was fine and SuperProcure simply would not take a bid on the load.
    check(/No bid placed/i.test(msg), 'A: states plainly that no bid was placed');
    check(/SuperProcure would not accept any bid on this load/i.test(msg),
      'A: names the actual reason - SuperProcure took this load out of bidding');
    check(/rate was not the problem/i.test(msg),
      'A: says the rate is not the problem, so nobody goes looking for a pricing mistake that does not exist');
    check(!/A rate was entered but no bid could be placed before close/.test(msg),
      'A: the generic unknown-reason wording is gone from a close whose reason we DID record');
    check(!/\bbot\b/i.test(msg), 'A: desk-plain copy - no "bot" wording');
    check(/Havells/.test(msg) && /Alwar/.test(msg), 'A: names the customer and the lane');

    const short = renderMessage(templateFor('lost', n.data, { short: true }), n.data);
    check(/^[^\n]*NO BID PLACED/.test(short), 'A: the short group reply also leads with NO BID PLACED');
    check(!/Our Final Ranking/.test(short), 'A: the short reply carries no ranking line either');

    // E: the funnel and the WhatsApp outcome now agree about the same close. bidLogger appends
    // ourBids ONLY on an accepted bid (a rejection goes to rejectedBids), so an all-rejected load
    // is ourBids: [] -> 'no_bid'.
    check(deriveStatus({ status: 'closed' }, { ourBids: [], won: false }) === 'no_bid',
      'E: the funnel classifies the same close as no_bid');
    check(templateFor('lost', n.data) === 'no_bid' && deriveStatus({ status: 'closed' }, { ourBids: [], won: false }) === 'no_bid',
      'E: funnel and WhatsApp outcome AGREE (both no_bid) - the two classifiers no longer disagree');
  }

  // ==========================================================================================
  // B2. THE #95 ANTI-SHORTCUT GUARD, RE-ARMED. This file's fix was to derive "never bid" from
  //     LANDED evidence only, and the guard that stopped it being faked was an assertion that the
  //     rejection handler's rung bookkeeping still advances on a refused bid. The rejection
  //     taxonomy moved that shape off the load-not-biddable path (which now stands down and rolls
  //     the un-consumed rung back), so the guard is re-armed HERE, on the CAP rejection - the one
  //     class where rung bookkeeping is deliberately still advanced by a bid that never landed.
  //
  //     If the participation derivation ever regresses to reading currentRungIndex, this block is
  //     what catches it: currentRungIndex is >= 0 and landedBids is 0 on the same close, so the two
  //     answers disagree, and only the landed one may be believed.
  // ==========================================================================================
  {
    const closesAt = Date.now() + 3000;
    // Every bid refused for the SHARED-ACCOUNT BID CAP - terminal for the budget, and the class the
    // taxonomy leaves completely unchanged.
    const adapter = {
      attempts: [],
      capabilities: () => ({ standingPriceVisible: false, minDecrement: 100, revisionLimit: 3, closeModel: 'hard' }),
      ensureSession: async () => ({}),
      async getAuctionState() {
        return { ok: true, status: Date.now() >= closesAt ? 'closed' : 'live', myRank: null, totalBidders: 4,
          standingL1Price: null, closesInMs: Math.max(0, closesAt - Date.now()), revisionsLeft: 3,
          closeModel: 'hard', measuredRttMs: 30 };
      },
      async placeBid(id, price) {
        this.attempts.push({ price, at: Date.now() });
        return { accepted: false, reason: 'Bid limit exceeded', status: 400, text: 'Bid limit exceeded' };
      },
    };
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 2500, floorWindowMs: 500, minInterFireMs: 0 }, onEvent: (e) => events.push(e),
    });
    const monitor = engine.arm(
      { id: '23484099C', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
        companyName: 'Havells', closesAt },
      { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 3600));

    check(adapter.attempts.length >= 1, 'B2: the engine attempted a bid (the wire was used)');
    check(monitor.capExhausted === true, 'B2: the cap rejection latched capExhausted (terminal for the budget)');
    // The re-armed guard. A CAP rejection banks the rung and does NOT roll it back, so on this close
    // the ladder counter says "we bid" while nothing ever landed - the exact disagreement the
    // landed-only derivation exists to resolve.
    check(monitor.currentRungIndex >= 0, 'B2: currentRungIndex STILL advances on a cap rejection (bookkeeping untouched)');
    check(monitor.landedBids === 0, 'B2: ...and landedBids is still 0 - the two facts disagree, by design');
    check(alertKinds(events).includes('never_bid_before_close'),
      'B2: the never-bid notice FIRES anyway - the derivation reads landed evidence, never the ladder counter');
    check(!alertKinds(events).includes('lost_after_bidding'), 'B2: lost_after_bidding did NOT fire');
    const res2 = resultEvent(events);
    check(res2 && res2.landedBids === 0, 'B2: auction_result carries landedBids = 0');
    check(templateFor('lost', toNotification(res2).data) === 'no_bid',
      'B2: the close renders the no_bid template despite the advanced rung counter');
  }

  // ==========================================================================================
  // C. DEDUPE. never_bid_before_close and the no-participation outcome fire in the same
  //    _finalize. A recipient subscribed to BOTH must get ONE message, not two.
  // ==========================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const people = [
      { name: 'Ops+Desk', phone: '+919000000001', alerts: ['error', 'lost'] },
      { name: 'Ops only', phone: '+919000000002', alerts: ['error'] },
      { name: 'Desk only', phone: '+919000000003', alerts: ['lost'] },
    ];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      store: new MemoryStore(), recipientsProvider: async () => people });

    const alertEvt = { type: 'alert', level: 'error', kind: 'never_bid_before_close', auctionId: '23484018',
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, companyName: 'Havells', finalRank: null };
    const resultEvt = { type: 'auction_result', auctionId: '23484018', won: false, finalRank: null, landedBids: 0,
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', companyName: 'Havells' };

    await notifyEngineEvent(n, alertEvt);
    const afterAlarm = tr.calls.map((c) => c.body.to_number);
    check(afterAlarm.includes('919000000002'), 'C: the error-only ops recipient still gets the loud alarm');
    check(!afterAlarm.includes('919000000001'), 'C: the both-kinds recipient is skipped on the alarm (the outcome covers it)');
    check(!afterAlarm.includes('919000000003'), 'C: a lost-only recipient never gets the error alert');

    await notifyEngineEvent(n, resultEvt);
    const all = tr.calls.map((c) => c.body.to_number);
    check(all.filter((p) => p === '919000000001').length === 1, 'C: the both-kinds recipient got EXACTLY ONE message for this close');
    check(all.filter((p) => p === '919000000003').length === 1, 'C: the desk-only recipient got the outcome');
    check(all.filter((p) => p === '919000000002').length === 1, 'C: the ops-only recipient got only the alarm');
    const outcomeMsg = tr.calls.find((c) => c.body.to_number === '919000000003').body.message;
    check(/NO BID PLACED/.test(outcomeMsg) && !/LOST/.test(outcomeMsg), 'C: what the desk actually received says NO BID PLACED, not LOST');
  }

  // ==========================================================================================
  // C2. THE LIVE ROUTING SHAPE. Havells and KEI run through shipper-scoped "BRL Bids" groups, and
  //     a scoped group takes the OUTCOME and suppresses the individual DMs for that customer. The
  //     ERROR payload carries no shipper, so no scoped group ever matches the alarm. Suppressing
  //     the alarm by SUBSCRIPTION therefore left an unscoped all-alerts ops recipient with NOTHING:
  //     filtered out of the alarm because they take 'lost', suppressed out of the outcome because
  //     the group took it. Zero delivery must be impossible.
  // ==========================================================================================
  {
    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const GROUP = '120363042212345678@g.us';   // a "BRL Bids" customer group, scoped to Havells
    const OPS_DM = '+919000000004';            // unscoped, every load, every kind
    const people = [
      { name: 'BRL Bids - Havells', phone: GROUP, alerts: ['error', 'lost'], scope: { shippers: ['Havells'] } },
      { name: 'Ops (all loads)', phone: OPS_DM, alerts: ['error', 'lost'] },
    ];
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      store: new MemoryStore(), recipientsProvider: async () => people });

    const alertEvt = { type: 'alert', level: 'error', kind: 'never_bid_before_close', auctionId: '23484019',
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, companyName: 'Havells', finalRank: null };
    const resultEvt = { type: 'auction_result', auctionId: '23484019', won: false, finalRank: null, landedBids: 0,
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', companyName: 'Havells' };

    await notifyEngineEvent(n, alertEvt);
    await notifyEngineEvent(n, resultEvt);

    const to = tr.calls.map((c) => c.body.to_number);
    const groupCount = to.filter((p) => p === GROUP).length;
    const opsCount = to.filter((p) => p === '919000000004').length;
    check(groupCount === 1, 'C2: the shipper-scoped group got the close exactly once');
    check(opsCount === 1, 'C2: the unscoped all-alerts ops DM got EXACTLY ONE message - not zero');
    check(groupCount > 0 && opsCount > 0, 'C2: zero-delivery is impossible - every recipient got at least one of the two');
    const groupMsg = tr.calls.find((c) => c.body.to_number === GROUP).body.message;
    check(/NO BID PLACED/.test(groupMsg), 'C2: the group received the fuller OUTCOME (never the raw alarm)');
    const opsMsg = tr.calls.find((c) => c.body.to_number === '919000000004').body.message;
    check(/never_bid_before_close/.test(opsMsg), 'C2: the ops DM received the ALARM - the outcome never reaches it (group precedence)');
  }

  // ==========================================================================================
  // D. REVERSIBILITY. A landed-but-lost close and a won close must be byte-identical to pre-fix.
  // ==========================================================================================
  {
    const closesAt = Date.now() + 3000;
    const adapter = landedThenLostAdapter(closesAt);
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 2500, floorWindowMs: 500, minInterFireMs: 0 }, onEvent: (e) => events.push(e),
    });
    const monitor = engine.arm(
      { id: 'L1', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
        companyName: 'Havells', closesAt },
      { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 3600));

    check(monitor.lastBidPrice != null, 'D: a bid landed on the fought-and-lost load');
    const kinds = alertKinds(events);
    check(kinds.includes('lost_after_bidding'), 'D: lost_after_bidding still fires on a real loss');
    check(!kinds.includes('never_bid_before_close'), 'D: never_bid_before_close does NOT falsely fire');

    const res = resultEvent(events);
    check(res && res.landedBids > 0, 'D: auction_result reports the landed-bid count');
    const n = toNotification(res);
    check(n.kind === 'lost', 'D: still the lost kind');
    check(templateFor('lost', n.data) === 'lost', 'D: a landed loss still selects the LOST template');
    check(templateFor('lost', n.data, { short: true }) === 'lost_short', 'D: and lost_short for the group reply');
    const msg = renderMessage(templateFor('lost', n.data), n.data);
    check(msg === renderMessage('lost', n.data), 'D: the rendered loss message is byte-identical to renderMessage("lost")');
    check(/Our Final Ranking/.test(msg), 'D: the loss message keeps its ranking line');
  }
  {
    // WON is untouched: it never consults the participation fact.
    const wonEvt = { type: 'auction_result', auctionId: 'W1', won: true, finalRank: 1, landedBids: 2,
      lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', companyName: 'Havells' };
    const n = toNotification(wonEvt);
    check(n.kind === 'won', 'D: a win still maps to the won kind');
    check(templateFor('won', n.data) === 'won', 'D: a win always selects the won template');
    check(renderMessage(templateFor('won', n.data), n.data) === renderMessage('won', n.data),
      'D: the rendered win message is byte-identical to renderMessage("won")');
    // Defensive: a win with zero landed bids (a human bid from the shared account held rank 1)
    // must STILL render the celebratory win, never the no-bid variant.
    const oddWin = toNotification({ ...wonEvt, landedBids: 0 });
    check(templateFor('won', oddWin.data) === 'won', 'D: a win with zero landed bids still renders WON, never no_bid');
  }
  {
    // Back-compat: an event with NO participation fact at all (a pre-fix persisted event, a mock
    // adapter, a rate-model arm) must degrade to exactly the old behaviour.
    const legacy = toNotification({ type: 'auction_result', auctionId: 'X1', won: false, finalRank: 4,
      lane: { origin: 'A', destination: 'B' }, companyName: 'Acme' });
    check(legacy.data.landedBids == null, 'D: a legacy event carries no landedBids');
    check(templateFor('lost', legacy.data) === 'lost', 'D: with no participation fact, the LOST template is unchanged');
    check(templateFor('lost', legacy.data, { short: true }) === 'lost_short', 'D: and lost_short unchanged');
  }

  // ==========================================================================================
  // F. RESTART DURABILITY. The participation fact decides both the desk's template and the ops
  //    alarm, and both are read at CLOSE - long after `sh scripts/deploy.sh` may have run
  //    `pm2 restart bid-command` mid-auction. A per-process counter comes back 0 on a load with
  //    real money on the board; the old condition survived that by accident (currentRungIndex is
  //    rebuilt from the durable firedRungs), and dropping it - correctly - had to be paid for with
  //    real durability, not left as a hole.
  // ==========================================================================================
  {
    const intentsFile = tmp();
    const closesAt = Date.now() + 4200;
    const cfg = { openAtMs: 3600, floorWindowMs: 400, minInterFireMs: 0 };
    const armR1 = (engine) => engine.arm(
      { id: 'R1', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
        companyName: 'Havells', closesAt },
      { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] }
    );

    // --- before the restart: a real bid lands and is accepted ---
    const engine1 = new BidEngine(landedThenLostAdapter(closesAt), new DurableScheduler(intentsFile),
      { config: cfg, onEvent: () => {} });
    const m1 = armR1(engine1);
    await new Promise((r) => setTimeout(r, 900));
    check(m1.landedBids > 0, 'F: a bid landed before the restart');
    engine1.stop('R1'); // "crash": timers cleared, the durable intent stays on disk
    check(engine1.scheduler.get('R1').landedBids > 0,
      'F: the participation fact is on DISK, not only in the process');

    // --- the restart: a fresh engine off the SAME intents file, exactly what rehydrate() does on
    // boot. Every further attempt is REFUSED, so nothing new can land - the close has to report the
    // bid that landed before the restart or not at all.
    const events = [];
    const engine2 = new BidEngine(allRejectedAdapter(closesAt), new DurableScheduler(intentsFile),
      { config: cfg, onEvent: (e) => events.push(e) });
    await engine2.rehydrate();
    check(engine2.monitors.get('R1').landedBids > 0,
      'F: rehydrate restored the landed count into the re-armed monitor');
    await new Promise((r) => setTimeout(r, 4000));

    const res = resultEvent(events);
    check(!!res, 'F: the restarted engine finalized the auction');
    check(res && res.landedBids > 0, 'F: auction_result still carries the pre-restart landed bid');
    const kinds = alertKinds(events);
    check(!kinds.includes('never_bid_before_close'),
      'F: never_bid_before_close does NOT falsely fire after a restart on a load that bid');
    check(kinds.includes('lost_after_bidding'), 'F: the close is reported as a real fought loss');
    const n = toNotification(res);
    check(templateFor('lost', n.data) === 'lost', 'F: the desk gets the LOST receipt, not NO BID PLACED');
    check(!/NO BID PLACED/.test(renderMessage(templateFor('lost', n.data), n.data)),
      'F: the rendered message never says NO BID PLACED for a load that bid');
  }
  {
    // F2. The SECOND, independent guard: the notify layer folds in ourBids off the durable
    // closed-bids record - the same array exportModel.deriveStatus reads - so the WhatsApp template
    // and the funnel share one source rather than merely agreeing today. It runs after
    // bidLogger.handle (server.js chains it), so the record has settled by then.
    check(landedEvidence(0, { ourBids: [{ price: 90080 }] }) === 1,
      'F2: a durable bid outweighs a zero on the event (a pre-fix intent rehydrated mid-auction)');
    check(landedEvidence(1, { ourBids: [] }) === 1,
      'F2: an engine-counted bid outweighs an empty record (a transport throw that may have committed)');
    check(landedEvidence(null, { ourBids: [{ price: 1 }] }) === null,
      'F2: no participation fact on the event still degrades to the previous templates, never to no_bid');

    const tr = mockTransport();
    const wa = new WhatsAppClient({ ...CREDS, enabled: true, transport: tr });
    const n = new Notifier({ mode: 'whatsapp', baseUrl: 'http://h', log: () => {}, wa,
      store: new MemoryStore(), recipientsProvider: async () => [{ name: 'Desk', phone: '+919000000005', alerts: ['lost'] }] });
    // an event that lost the count (a pre-fix intent rehydrated mid-auction) against a record that
    // still holds the bid: the desk must be told LOST.
    await notifyEngineEvent(n,
      { type: 'auction_result', auctionId: 'R2', won: false, finalRank: 3, landedBids: 0,
        lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', companyName: 'Havells' },
      null,
      async () => ({ ourBids: [{ price: 90080 }], lastBidPrice: 90080, cost: 15_000, won: false }));
    const msg = tr.calls[0].body.message;
    check(/LOST/.test(msg) && !/NO BID PLACED/.test(msg),
      'F2: the durable record alone is enough to stop a false NO BID PLACED at the notify layer');
  }

  // ==========================================================================================
  // G. SHADOW IS NOT A LANDED BID. Soft-close shadow records a would-have-placed decision and
  //    performs ZERO wire writes by construction, so nothing is on the board. Counting it would
  //    render the full LOST receipt with a dangling "Our Final Ranking - -" (shadow never bids, so
  //    the socket never self-matches our carrier and rank stays null) - verbatim the complaint this
  //    file exists to remove - while the funnel, which only sees a bid_placed, says no_bid.
  //    config.js defaults an enabled shipper to mode 'shadow', so this is the opt-in posture.
  // ==========================================================================================
  {
    const closesAt = Date.now() + 3000;
    const adapter = landedThenLostAdapter(closesAt); // would ACCEPT - shadow must never call it
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 2500, floorWindowMs: 500, minInterFireMs: 0 },
      softClose: { enabled: true, shippers: ['Havells'], mode: 'shadow' },
      onEvent: (e) => events.push(e),
    });
    const monitor = engine.arm(
      { id: 'S1', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
        companyName: 'Havells', closesAt },
      { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 3600));

    check(monitor.softStrategy === 'shadow', 'G: the allowlisted shipper resolved to the shadow strategy');
    check(events.some((e) => e.type === 'shadow_decision'), 'G: a would-have-placed decision WAS recorded');
    check(adapter.attempts.length === 0, 'G: shadow put ZERO bids on the wire');
    check(monitor.landedBids === 0, 'G: a would-have-fired shadow decision is NOT counted as a landed bid');
    check(monitor.lastBidPrice != null, 'G: lastBidPrice still records the would-have-placed price (the shadow trace)');
    const res = resultEvent(events);
    check(res && res.landedBids === 0, 'G: auction_result reports zero landed bids for a shadow close');
    const n = toNotification(res);
    check(templateFor('lost', n.data) === 'no_bid', 'G: a shadow close renders NO BID PLACED, not a fought loss with a blank rank');
    check(deriveStatus({ status: 'closed' }, { ourBids: [], won: false }) === 'no_bid',
      'G: and the funnel classifies the same shadow close as no_bid - both classifiers agree');
    // The OPS ALARM is gated, the desk OUTCOME is not. never_bid_before_close exists to catch an
    // UNINTENDED zero-bid; shadow's zero is the strategy working, and alarming every shadow close
    // would train the desk to ignore the alarm that matters.
    check(!alertKinds(events).includes('never_bid_before_close'),
      'G: no ops alarm on a shadow close - a deliberate zero-bid is not an unintended one');
    check(/NO BID PLACED/.test(renderMessage(templateFor('lost', n.data), n.data)),
      'G: the desk still receives the NO BID PLACED outcome (only the ops alarm is gated)');
  }
  {
    // G2. The gate is SHADOW-only. A soft-close shipper graduated to mode 'live' whose every bid is
    // refused is an unintended zero-bid - the alarm must still fire, or the gate would silence the
    // exact failure the alarm was added for on the customers running soft-close.
    const closesAt = Date.now() + 3000;
    const adapter = allRejectedAdapter(closesAt);
    const events = [];
    const engine = new BidEngine(adapter, new DurableScheduler(tmp()), {
      config: { openAtMs: 2500, floorWindowMs: 500, minInterFireMs: 0 },
      softClose: { enabled: true, shippers: ['Havells'], mode: 'live' },
      onEvent: (e) => events.push(e),
    });
    const monitor = engine.arm(
      { id: 'S2', lane: { origin: 'Bhiwandi', destination: 'Alwar' }, equipment: '32ft', units: 1,
        companyName: 'Havells', closesAt },
      { cost: 15_000, marginsPct: [12.6, 7.2, 6.3] }
    );
    await new Promise((r) => setTimeout(r, 3600));

    check(monitor.softStrategy === 'live', 'G2: the graduated shipper resolved to the live strategy');
    check(adapter.attempts.length >= 1, 'G2: live mode DID use the wire (every attempt refused)');
    check(monitor.landedBids === 0, 'G2: nothing landed');
    check(alertKinds(events).includes('never_bid_before_close'),
      'G2: a LIVE-mode zero-bid close still raises the ops alarm - the gate is shadow-only');
  }

  cleanup();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { cleanup(); console.error('\nFAILED:', (e && e.stack) || e); process.exit(1); });
